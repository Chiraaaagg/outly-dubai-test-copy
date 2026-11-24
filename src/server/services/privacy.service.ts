import "server-only";
import { randomBytes } from "node:crypto";
import { prisma, TX_OPTIONS } from "../lib/db";
import { requirePermission, type Actor } from "../lib/actor";
import { auditFieldChanges } from "../lib/audit";
import { Errors } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { emitEvent } from "../lib/structured-events";
import { getDocumentStore } from "../documents/store";
import { enqueueCrmErasure } from "../crm/crm.outbox";
import { LATE_MONEY_WINDOW_MS } from "../payments/saga";
import {
  eraseSubjectRows,
  findSubjectRecords,
  forgetLegacySuppression,
  forgetStorageKey,
  normaliseEmail,
  normalisePhoneE164,
  orderObligations,
  suppressContact,
  type ErasureCounts,
  type ErasureObligation,
  type ErasureSubject,
} from "../repositories/privacy.repo";
import { dubaiToday } from "@/lib/utils";

/**
 * Personal-data erasure workflow (PRV-3; doc 22 §23 B4; review
 * money-tickets-privacy.md PRV-2, PRV-3, PRV-7).
 *
 * `requestErasure(actor, { phoneE164?, email? }, now)` needs
 * `privacy.anonymise`. In one transaction it:
 *
 *  1. finds the person's customers, orders and inquiries (by phone, e-mail or
 *     linked account);
 *  2. checks every order for an active obligation (below). Those orders keep
 *     what fulfilment and refunds need: the lead contact, the guest, the
 *     supplier guest name, tickets, grants and the messages bound to them.
 *     A customer account linked to a deferred order stays open too (R-B4-2):
 *     login, phone, sessions and the order link are kept so the customer can
 *     still sign in, see the order and download its tickets; only its dietary
 *     and hotel prefill is cleared. Everything else is erased now;
 *  3. erases or pseudonymises every other store (privacy.repo.ts lists them);
 *  4. adds the phone and e-mail to the hashed suppression list
 *     (`hmacFor("lookup", …)`), then removes the phone's legacy plaintext
 *     `suppressed_phones` row, if any (R-B4-6). A missing `lookup` ring fails
 *     the whole request: erasure never falls back to plaintext;
 *  5. writes one audit row with field names, ids and counts only (PRV-2).
 *
 * After commit, the erased documents' objects are deleted from private
 * storage, best effort: a failure is reported in the result and leaves the
 * row's storage key in place for a retry, it never rolls the erasure back.
 *
 * Result `status`:
 *  - `completed`: nothing is owed; everything was erased;
 *  - `partial`: some orders are deferred (see `obligations`), the rest was erased;
 *  - `deferred`: every record found belongs to a deferred order; only the
 *    suppression entry, click identifiers and a kept account's dietary and
 *    hotel prefill were written. Run the request again once the obligations
 *    end; the kept account is closed then.
 *
 * `counts.customersDeferred` is the number of accounts kept open; the
 * obligations of their deferred orders are the explanation for the requester.
 *
 * Obligations (codes the requester can be told, `ERASURE_EXPLANATIONS`):
 *  - `future_service`: an item whose service date is today or later in
 *    Dubai, not cancelled or rejected, on an order not cancelled, refunded or
 *    failed;
 *  - `refund_pending`: a refund not final (`requested`, `accepted`,
 *    `unknown`), or a remedy still being carried out; a `failed` refund or
 *    remedy counts too until it is resolved (R-B4-7: a later refund on the
 *    same item succeeded, or staff closed the remedy);
 *  - `dispute_window`: a payment captured within `DISPUTE_WINDOW_DAYS`;
 *  - `payment_open`: a payment saga not at rest, flagged for a human, or a
 *    closed one still in the late-money watch (`LATE_MONEY_WINDOW_MS`);
 *  - `supplier_booking_open`: a supplier attempt not settled, or flagged.
 *
 * Retention periods are not decided here (PRV-7): financial rows are never
 * deleted, and their personal fields are pseudonymised.
 */

/**
 * PROVISIONAL — how long after capture a payment can still be disputed, so
 * the order keeps the contact needed to answer the dispute. A placeholder
 * pending the owner's adviser and the providers' written answers (PRV-7;
 * doc 22 questions 11, 12 and 15). It is not a legal retention period.
 */
export const DISPUTE_WINDOW_DAYS = 120;

/** What staff can tell the requester for each obligation code. */
export const ERASURE_EXPLANATIONS: Record<ErasureObligation, string> = {
  future_service: "You have a booking that has not taken place yet. We keep the details needed to deliver it and erase them afterwards.",
  refund_pending: "A refund to you is still being processed. We keep the details needed to complete it.",
  dispute_window: "A recent payment can still be disputed with your bank. We keep the details needed to answer a dispute until that period ends.",
  payment_open: "A payment on your booking is still being settled. We keep the details needed to finish it.",
  supplier_booking_open: "A booking with our supplier is still being finalised. We keep the details needed to complete or cancel it.",
};

export interface ErasureInput {
  phoneE164?: string | null;
  email?: string | null;
}

export interface ErasureResult {
  /** Audit entity id (`privacy_request`) and event correlation id. */
  requestId: string;
  status: "completed" | "partial" | "deferred";
  /** Every obligation found, sorted; empty when completed. */
  obligations: ErasureObligation[];
  /** The deferred orders and why. */
  deferredOrders: { orderId: string; obligations: ErasureObligation[] }[];
  counts: ErasureCounts;
  suppressed: { phone: boolean; email: boolean };
  /** Private-storage objects of erased documents: deleted after commit, or left for a retry. */
  storage: { deleted: number; failed: number };
  /** The marker token (`[deleted-<token>]`); also in the audit row. */
  token: string;
}

function subjectOf(input: ErasureInput): ErasureSubject {
  const phoneE164 = input.phoneE164 ? normalisePhoneE164(input.phoneE164) : null;
  const email = input.email ? normaliseEmail(input.email) : null;
  if (input.phoneE164 && !phoneE164) throw Errors.validation({ phoneE164: "Use the full number in international format, for example +971501234567." });
  if (input.email && !email) throw Errors.validation({ email: "That doesn't look like an email address." });
  if (!phoneE164 && !email) throw Errors.validation({ contact: "Give the phone number or email address to erase." });
  return { phoneE164, email };
}

async function deleteStoredObjects(objects: { documentId: string; storageKey: string }[]): Promise<{ deleted: number; failed: number }> {
  if (!objects.length) return { deleted: 0, failed: 0 };
  const store = getDocumentStore();
  if (!store) {
    for (const o of objects) emitEvent("document.store_error", { documentId: o.documentId, operation: "delete", reason: "store_unconfigured" }, "error");
    return { deleted: 0, failed: objects.length };
  }
  let deleted = 0;
  let failed = 0;
  for (const o of objects) {
    try {
      await store.delete(o.storageKey);
      await forgetStorageKey(o.documentId, o.storageKey);
      deleted += 1;
    } catch {
      failed += 1;
      emitEvent("document.store_error", { documentId: o.documentId, operation: "delete", reason: "erasure_delete_failed" }, "error");
    }
  }
  return { deleted, failed };
}

export const privacyService = {
  /** Staff entry point: erase a person by phone and/or e-mail. Needs `privacy.anonymise`. */
  async requestErasure(actor: Actor, input: ErasureInput, now: Date = new Date()): Promise<ErasureResult> {
    requirePermission(actor, "privacy.anonymise");
    return privacyService.eraseContact(actor, input, now);
  },

  /**
   * The workflow without the permission check, for `requestErasure` and the
   * legacy `anonymiseByPhone`. Not for routes.
   */
  async eraseContact(actor: Actor, input: ErasureInput, now: Date = new Date()): Promise<ErasureResult> {
    const subject = subjectOf(input);
    const requestId = uuidv7();
    // Twelve hex characters: the `[deleted-<token>]` shape of the B0 anonymiser.
    const token = randomBytes(6).toString("hex");
    const marker = `[deleted-${token}]`;
    const rules = {
      todayDubai: dubaiToday(now),
      disputeWindowStart: new Date(now.getTime() - DISPUTE_WINDOW_DAYS * 86_400_000),
      lateMoneyStart: new Date(now.getTime() - LATE_MONEY_WINDOW_MS),
    };

    const written = await prisma.$transaction(async (tx) => {
      const records = await findSubjectRecords(tx, subject);
      const byOrder = await orderObligations(tx, records.orderIds, rules);
      const deferredOrders = [...byOrder].map(([orderId, obligations]) => ({ orderId, obligations })).sort((a, b) => a.orderId.localeCompare(b.orderId));
      const write = await eraseSubjectRows(tx, { subject, records, deferredOrderIds: deferredOrders.map((d) => d.orderId), marker, now });
      const suppressed = {
        phone: subject.phoneE164 ? await suppressContact(tx, "phone", subject.phoneE164, "deletion_request") : false,
        email: subject.email ? await suppressContact(tx, "email", subject.email, "deletion_request") : false,
      };
      // The hashed entry now covers the number: its plaintext copy in the legacy list goes (R-B4-6).
      const legacySuppressionRemoved = subject.phoneE164 ? await forgetLegacySuppression(tx, subject.phoneE164) : 0;
      // CRM copies (doc 29 §6.5): a delete for every linked deal of the erased inquiries and orders, deferred orders
      // included: the deal carries the customer's details since C2a and is only a convenience copy; the order keeps
      // its own record for the obligation (review C2A-07). Delivery is the CRM worker's, under CRM_SYNC_ENABLED;
      // nothing is enqueued while no CRM portal is configured.
      await enqueueCrmErasure(tx, { inquiryIds: records.inquiryIds, orderIds: records.orderIds });
      const obligations = [...new Set(deferredOrders.flatMap((d) => d.obligations))].sort();
      const c = write.counts;
      const erasedSomething =
        c.customers + c.otpChallenges + c.inquiries + c.orders + c.guests + c.verifications + c.supplierBookings + c.ticketCodes + c.documents + c.grants + c.notifications + c.webhookEvents + c.waConversations >
        0;
      const status: ErasureResult["status"] = !obligations.length ? "completed" : erasedSomething ? "partial" : "deferred";

      await auditFieldChanges(
        actor,
        "privacy.erasure",
        { type: "privacy_request", id: requestId },
        {
          fields: write.fields,
          // `markerToken`: the audit scrubber strips any key named `token`.
          ids: { markerToken: token, deferredOrderIds: deferredOrders.map((d) => d.orderId) },
          counts: {
            ...c,
            suppressedPhone: suppressed.phone ? 1 : 0,
            suppressedEmail: suppressed.email ? 1 : 0,
            legacySuppressionRemoved,
            storageObjects: write.storageObjects.length,
          },
          codes: { status, obligations, channels: [subject.phoneE164 ? "phone" : null, subject.email ? "email" : null].filter((x): x is string => x !== null) },
        },
        tx,
      );
      return { write, deferredOrders, obligations, status, suppressed };
    }, TX_OPTIONS);

    const storage = await deleteStoredObjects(written.write.storageObjects);
    const c = written.write.counts;
    if (written.deferredOrders.length) emitEvent("privacy.erasure_deferred", { requestId, obligations: written.obligations.join(":") }, "info");
    if (written.status !== "deferred") {
      emitEvent("privacy.erasure_completed", {
        requestId,
        inquiries: c.inquiries,
        orders: c.orders,
        guests: c.guests,
        customers: c.customers,
        notifications: c.notifications,
        supplierBookings: c.supplierBookings,
        webhookEvents: c.webhookEvents,
        codeRowsDeleted: c.ticketCodes,
        documents: c.documents,
        grants: c.grants,
        verifications: c.verifications,
        partial: written.status === "partial",
      });
    }

    return {
      requestId,
      status: written.status,
      obligations: written.obligations,
      deferredOrders: written.deferredOrders,
      counts: c,
      suppressed: written.suppressed,
      storage,
      token,
    };
  },
};
