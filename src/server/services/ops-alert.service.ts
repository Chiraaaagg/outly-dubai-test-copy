import "server-only";
import { Prisma, type SupplierEnvironment } from "@prisma/client";
import { prisma, TX_OPTIONS } from "../lib/db";
import { env } from "../lib/env";
import { traveldeskConfigFrom } from "../suppliers/traveldesk/traveldesk.config";
import { CATALOGUE_STALE_AFTER_MS, TRAVELDESK_SUPPLIER_CODE } from "./supplier-catalog.service";
import { uuidv7 } from "../lib/ids";
import { emitEvent } from "../lib/structured-events";
import type { OpsAlertContext, OpsAlertDigestContext, TemplateContext } from "../notifications/templates";
import { notificationService, type DispatchResult } from "./notification.service";
import { urgentAt, visitDeadlineLevel } from "./document.service";
import { quoteBudgetIncidents } from "./quote-budget-alert";
import { AUTH_PAUSE_MS, BREAKER_THRESHOLD, breakerPauseMs } from "../crm/crm.worker";
import { crmReturnIncidents } from "../crm/crm.return.alerts";
import { ownerAlertIncidents } from "./owner-alert";
import { bulkDisarmIncidents } from "./bulk-guard";
import { duplicateScanIncidents } from "../payments/duplicate-scan";

/**
 * Ops alert emails for instant-path incidents (doc 22 §32.24: alerts by
 * email; §32.23 open point "no external alert channel yet").
 *
 * One email per incident to `env().opsAlertEmails`, through the notification
 * outbox (`notificationService.dispatch`): one `notifications` row per
 * incident and recipient, written before the send, the row id as the
 * provider's idempotency key, rendered from the stored context on every
 * attempt (so a resend is identical), retried by the outbox sweep.
 *
 * After commit by construction. The sweep reads incidents from the state the
 * engine, the saga, the refund driver and the document service already
 * committed (attention flags, states, failed rows, the breaker's pause), so
 * an alert can never break, delay or roll back the transition that raised
 * it, and an incident whose transaction rolled back is never reported. It
 * runs from the scheduled inquiry sweep (every 5 minutes) and never throws.
 *
 * Incidents (`collectOpsIncidents`), each raised within `OPS_ALERT_LOOKBACK_MS`:
 *  - `supplier_outage_paused`: the outage breaker paused new sales (control
 *    row paused with reason `supplier_outage_auto`);
 *  - `supplier_wallet_paused`: the wallet direction guard stopped all
 *    supplier writes (control row paused with reason `wallet_direction_auto`,
 *    doc 29 §4.5);
 *  - `saga_attention`: a payment saga flagged for a human;
 *  - `item_refund_problem`: a multi-item order's item refund refused or
 *    short (`item_*` failed remedy);
 *  - `refund_failed`: a refund that failed, or a cancellation whose refund
 *    failed (still open);
 *  - `booking_attention`: a supplier booking needing staff:
 *    `outcome_unknown` past its first recovery search (or
 *    `not_found_unresolved`), `manual_review`, `charged_amount_mismatch`,
 *    `reservation_slot_mismatch` (doc 29 Batch 7),
 *    `cancel_refused`, a late acceptance, a reserve held back because the
 *    wallet figures failed the funds check (`funds_unverified`);
 *  - `document_attention`: a ticket document flagged for staff past the
 *    existing F12 thresholds (urgent is its own reason);
 *  - `crm_delete_failed`: a CRM copy that could not be deleted (a
 *    dead-lettered `delete` row in `crm_outbox`, reason `erasure` or
 *    `retention`; doc 29 §6.5, review R13), or an erased subject's sync row
 *    that died because the linked deal was not visible (review C2A-08). Ids
 *    only. Read only when the CRM tables exist: a missing table yields no
 *    incident, never a failed sweep;
 *  - `crm_sync_dead` (doc 29d G11, C2b): a CRM sync row dead-lettered (eight
 *    failed attempts, or refused by the payload guard), so the deal no longer
 *    follows OUTLYY. One incident per subject and error kind, reason
 *    `crm_sync_dead_<kind>`; the order reference when the subject is an
 *    order. Ids and codes only;
 *  - `crm_sync_paused` (doc 29d G11, C2b): the CRM worker's circuit opened,
 *    after five consecutive outage answers (`crm_breaker_open`, raised again
 *    at each re-open while the portal stays down) or on a refused credential
 *    (`crm_auth_refused`). Entity `crm_subject:portal:<environment>`; read
 *    from crm_portal_state, so its opening time is exact;
 *  - `crm_return_path` (CRM batch C3ab, doc 29e): a Bitrix24 return path
 *    finding (crm.return.alerts.ts): a hand-made, orphan, foreign, twin,
 *    reappeared or no longer visible deal, repeated put-backs or a loop
 *    hold, an unknown stage, an owner change OUTLYY could not follow, a
 *    portal fingerprint refusal. Reason = the finding kind; ids only;
 *  - `catalogue_stale`: the TravelDesk catalogue of this deployment's
 *    environment has had no complete sync for `CATALOGUE_STALE_AFTER_MS`
 *    (48 h; doc 29 Batch 1b, review 81 R7). Raised at the moment it turned
 *    stale. If the scheduled sync stopped (no `CRON_SECRET`, or the schedule
 *    line removed as the rollback), stored instant verdicts no longer age
 *    while live quotes refuse them, so staff must sync or look;
 *  - `quote_budget_refused`: customer quotes were refused because the quote
 *    share of the supplier read budget was spent, so customers were sent to
 *    the inquiry (one incident per episode of refusals, raised at its first;
 *    thresholds in quote-budget-alert.ts). Codes only;
 *  - `duplicate_scan_full` (review 102c D5): the payments tick's scan of
 *    duplicate payments still holding money came back full (50 rows), so a
 *    newer duplicate may not be refunded automatically. Entity
 *    `payment_saga:duplicate_scan` (no new entity kind); raised again each
 *    UTC day while it stays full (payments/duplicate-scan.ts). No ids,
 *    codes only.
 *
 * Dedup and throttle (`ops_alerts`, one row per entity and reason, under one
 * row lock so concurrent sweeps decide one at a time):
 *  - an incident whose raise time the row already handled is skipped;
 *  - at most one email per (entity, reason) per `OPS_ALERT_DEDUP_MS` (6 h):
 *    a repeat inside that window waits, and is sent after it only if it is
 *    still within the lookback;
 *  - at most `OPS_ALERT_HOURLY_CAP` (20) incident emails per rolling hour;
 *    beyond that an incident is marked suppressed (not sent), and one
 *    "N more alerts suppressed" digest goes out at most once per hour.
 *
 * The email (templates.ts `OPS_INCIDENT_ALERT`): subject `[OUTLY ALERT]
 * <incident>`, the order reference, booking id, reason code and an admin
 * link. Never a customer name, phone or email, never a supplier net price
 * or any amount.
 *
 * No recipients configured: logged once (`alerts.no_recipients`), nothing
 * is claimed, and the sweep returns. The boot check already warns.
 */

export const OPS_ALERT_DEDUP_MS = 6 * 3600_000;
export const OPS_ALERT_HOURLY_CAP = 20;
export const OPS_ALERT_DIGEST_EVERY_MS = 3600_000;
/** Incidents raised longer ago than this are not emailed (first deploy, a long cron outage). */
export const OPS_ALERT_LOOKBACK_MS = 72 * 3600_000;
/** Per incident kind, per sweep. */
const COLLECT_LIMIT = 100;
/** Rows handed to the outbox per sweep. */
const DISPATCH_LIMIT = 60;

const DIGEST = { entityKind: "digest", entityId: "hourly", reason: "suppressed" } as const;
const EPOCH = new Date(0);

export type OpsIncidentKind =
  | "supplier_outage_paused"
  | "supplier_wallet_paused"
  | "saga_attention"
  | "item_refund_problem"
  | "refund_failed"
  | "booking_attention"
  | "document_attention"
  | "crm_delete_failed"
  | "crm_sync_dead"
  | "crm_sync_paused"
  | "crm_return_path"
  /** Doc 30 N3 (review 108 NR-01): the listing upkeep did not finish on consecutive daily runs (traveldesk-upkeep-job.ts). */
  | "upkeep_incomplete"
  | "catalogue_stale"
  | "quote_budget_refused"
  /** Doc 30 N2: the owner alert of a one-person approval failed, needs a human, was suppressed or is late (owner-alert.ts). */
  | "owner_alert_failed"
  /** Doc 30 N2 (review N2-04): a free-cancellation bulk item left a listing on inquiry after a failure (bulk-guard.ts). */
  | "bulk_item_disarmed"
  /** Review 102c D5: the payments tick's duplicate-payment scan came back full (payments/duplicate-scan.ts). */
  | "duplicate_scan_full";
/**
 * `crm_subject` needs migration 20261122140000 (ops_alerts_entity_kind_check). Its entity id is `inquiry:<id>`
 * or `order:<id>`, or `portal:<environment>` for the CRM worker's own pause (C2b, no new entity kind).
 */
export type OpsEntityKind = "supplier_account" | "payment_saga" | "order_item" | "supplier_booking" | "supplier_document" | "crm_subject" | "privileged_approval" | "bulk_operation_item";

export interface OpsIncident {
  kind: OpsIncidentKind;
  entityKind: OpsEntityKind;
  entityId: string;
  /** A short code; normalised by `reasonCode`. */
  reason: string;
  raisedAt: Date;
  orderId: string | null;
  orderReference: string | null;
  /** Our `supplier_bookings.id`. */
  bookingId: string | null;
  /** The supplier's own booking number. */
  supplierBookingRef: string | null;
  /** Path under the site, e.g. `/admin/bookings/OUT-…`. */
  adminPath: string;
}

export const OPS_INCIDENT_TITLES: Record<OpsIncidentKind, string> = {
  supplier_outage_paused: "Supplier outage: new instant sales paused",
  supplier_wallet_paused: "Supplier wallet check failed: all supplier bookings paused",
  saga_attention: "Payment needs attention",
  item_refund_problem: "Item refund failed or short",
  refund_failed: "Refund failed",
  booking_attention: "Booking needs staff",
  document_attention: "Tickets need staff",
  crm_delete_failed: "CRM copy could not be deleted",
  crm_sync_dead: "CRM deal no longer updated: sync gave up",
  crm_sync_paused: "CRM sync paused: portal not answering or credential refused",
  crm_return_path: "CRM return path: a Bitrix24 change needs a look",
  upkeep_incomplete: "TravelDesk listing upkeep did not finish on consecutive days",
  catalogue_stale: "Supplier catalogue not synced for 48 hours",
  quote_budget_refused: "Quote read budget spent: customers sent to inquiry",
  owner_alert_failed: "Owner alert of a one-person approval was not delivered",
  bulk_item_disarmed: "Bulk free-cancellation run left an armed listing on inquiry",
  duplicate_scan_full: "Duplicate payments waiting: automatic refunds may be held up",
};

/** The stored row payload: what the email says plus its idempotency scope. */
interface StoredPayload {
  event: "OPS_INCIDENT_ALERT" | "OPS_ALERT_DIGEST";
  once: string;
  orderId: string | null;
  context: OpsAlertContext | OpsAlertDigestContext;
}

export function reasonCode(s: string): string {
  const c = s
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .slice(0, 80);
  return c || "unknown";
}

const keyOf = (i: Pick<OpsIncident, "entityKind" | "entityId" | "reason">) => `${i.entityKind}|${i.entityId}|${i.reason}`;

/** One incident per (entity, reason): the latest raise wins (a later one is a new occurrence). */
export function latestPerKey(incidents: OpsIncident[]): OpsIncident[] {
  const by = new Map<string, OpsIncident>();
  for (const raw of incidents) {
    const i = { ...raw, reason: reasonCode(raw.reason) };
    const k = keyOf(i);
    const prior = by.get(k);
    if (!prior || i.raisedAt.getTime() > prior.raisedAt.getTime()) by.set(k, i);
  }
  return [...by.values()].sort((a, b) => a.raisedAt.getTime() - b.raisedAt.getTime() || (keyOf(a) < keyOf(b) ? -1 : 1));
}

function adminUrl(siteUrl: string, path: string): string {
  return `${siteUrl.replace(/\/+$/, "")}${path}`;
}

const bookingPath = (reference: string | null) => (reference ? `/admin/bookings/${encodeURIComponent(reference)}` : "/admin/bookings");

/** The email's context for an incident. Exported for tests (the no-PII check). */
export function incidentContext(i: OpsIncident, siteUrl: string): OpsAlertContext {
  return {
    incident: i.kind,
    title: OPS_INCIDENT_TITLES[i.kind],
    reasonCode: reasonCode(i.reason),
    orderReference: i.orderReference,
    bookingId: i.bookingId,
    supplierBookingRef: i.supplierBookingRef,
    entity: `${i.entityKind}:${i.entityId}`,
    raisedAt: i.raisedAt.toISOString(),
    adminUrl: adminUrl(siteUrl, i.adminPath),
  };
}

/* ---------------------------------------------------------------------------
 * Incidents, from committed state
 * ------------------------------------------------------------------------ */

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));

/** Which booking states and codes need staff (doc 22 §32.24 brief). Null: not an incident. */
export function bookingReason(b: { state: string; errorCode: string | null; attention: boolean; recoverySearches: number }): string | null {
  if ((b.errorCode === "late_acceptance" || b.errorCode === "late_acceptance_duplicate") && b.attention) return "late_acceptance";
  if (b.errorCode === "charged_amount_mismatch" && b.attention) return "charged_amount_mismatch";
  // Doc 29 Batch 7 (review 92 B7-12): the reservation names another slot than the one sent.
  if (b.errorCode === "reservation_slot_mismatch" && b.attention) return "reservation_slot_mismatch";
  if (b.errorCode === "funds_unverified" && b.attention) return "funds_unverified";
  // Doc 29 Batch 6 (external-confirmation.ts): an external booking handed to our team at its wait limit, one the
  // external supplier failed after the confirm (the saga refunds it), and an external hold too short to confirm.
  if (b.errorCode === "external_confirmation_handoff" && b.attention) return "external_confirmation_handoff";
  if (b.errorCode === "external_booking_failed" && b.attention) return "external_booking_failed";
  if (b.errorCode === "external_hold_unusable" && b.attention) return "external_hold_unusable";
  if (b.errorCode === "external_reservation_released" && b.attention) return "external_reservation_released";
  if (b.errorCode === "external_failed_after_confirm" && b.attention) return "external_failed_after_confirm";
  if (b.errorCode === "external_unconfirmed_at_start" && b.attention) return "external_unconfirmed_at_start";
  // Review 89 B6-06: any flag on an external-route booking still waiting on its supplier (a read dead-letter sets a
  // bare one). The query selects external-route rows only for this clause, so internal attempts alert as before.
  if (b.state === "awaiting_external" && b.attention) return "external_confirmation_attention";
  if (b.state === "manual_review") return "manual_review";
  if (b.state === "cancel_refused") return "cancel_refused";
  // Past its first recovery search: still unknown (or proven not found yet), a human must look.
  if ((b.state === "outcome_unknown" && b.recoverySearches >= 1) || b.state === "not_found_unresolved") return "outcome_unknown";
  return null;
}

/** Doc 29 Batch 6: a failed external charge still unrefunded this long after the rejection raises an alert (within the 24 h funds window). */
export const EXTERNAL_REFUND_ALERT_AFTER_MS = 3 * 3_600_000;

export async function collectOpsIncidents(since: Date, now: Date, limit = COLLECT_LIMIT): Promise<OpsIncident[]> {
  const out: OpsIncident[] = [];

  // The automatic pauses, on the control row they wrote (supplier-booking.service.ts): the outage breaker
  // (noteMutationHealth) and the wallet direction guard (pauseForWalletDirection).
  const outages = await prisma.$queryRaw<Row[]>`
    SELECT key, updated_at, value->>'reason' AS reason FROM settings
    WHERE key LIKE 'supplier_bookings.%' AND value->>'reason' IN ('supplier_outage_auto', 'wallet_direction_auto') AND value->>'paused' = 'true'
      AND updated_at >= ${since} AND updated_at <= ${now}
    ORDER BY updated_at DESC LIMIT ${limit}`;
  for (const r of outages) {
    const key = String(r.key);
    const code = key.split(".")[1] ?? "";
    const wallet = r.reason === "wallet_direction_auto";
    out.push({
      kind: wallet ? "supplier_wallet_paused" : "supplier_outage_paused",
      entityKind: "supplier_account",
      entityId: key,
      reason: wallet ? "supplier_wallet_paused" : "supplier_outage_paused",
      raisedAt: date(r.updated_at),
      orderId: null,
      orderReference: null,
      bookingId: null,
      supplierBookingRef: null,
      adminPath: /^[a-z0-9_-]+$/.test(code) ? `/admin/suppliers/${code}` : "/admin",
    });
  }

  const sagas = await prisma.$queryRaw<Row[]>`
    SELECT s.id, s.order_id, o.reference, s.attention_required_at,
      (SELECT b.id FROM supplier_bookings b WHERE b.order_item_id = s.order_item_id ORDER BY b.created_at DESC LIMIT 1) AS booking_id
    FROM payment_sagas s JOIN orders o ON o.id = s.order_id
    WHERE s.attention_required_at >= ${since} AND s.attention_required_at <= ${now}
    ORDER BY s.attention_required_at DESC LIMIT ${limit}`;
  for (const r of sagas) {
    out.push({
      kind: "saga_attention",
      entityKind: "payment_saga",
      entityId: String(r.id),
      reason: "saga_attention",
      raisedAt: date(r.attention_required_at),
      orderId: str(r.order_id),
      orderReference: str(r.reference),
      bookingId: str(r.booking_id),
      supplierBookingRef: null,
      adminPath: bookingPath(str(r.reference)),
    });
  }

  // A multi-item order's item refund refused or short (saga.ts recordItemProblem).
  const itemProblems = await prisma.$queryRaw<Row[]>`
    SELECT r.order_item_id, r.order_id, r.reason, r.created_at, r.supplier_booking_id, o.reference
    FROM customer_remedies r JOIN orders o ON o.id = r.order_id
    WHERE r.kind = 'refund' AND r.status = 'failed' AND r.refund_id IS NULL AND left(r.reason, 5) = 'item_'
      AND r.created_at >= ${since} AND r.created_at <= ${now}
    ORDER BY r.created_at DESC LIMIT ${limit}`;
  for (const r of itemProblems) {
    out.push({
      kind: "item_refund_problem",
      entityKind: "order_item",
      entityId: String(r.order_item_id),
      reason: String(r.reason),
      raisedAt: date(r.created_at),
      orderId: str(r.order_id),
      orderReference: str(r.reference),
      bookingId: str(r.supplier_booking_id),
      supplierBookingRef: null,
      adminPath: bookingPath(str(r.reference)),
    });
  }

  // A refund the provider failed (refunds.ts settle), or a cancellation left `refund_failed` and still open.
  const refunds = await prisma.$queryRaw<Row[]>`
    SELECT f.order_item_id, i.order_id, o.reference, f.updated_at AS raised_at
    FROM refunds f JOIN order_items i ON i.id = f.order_item_id JOIN orders o ON o.id = i.order_id
    WHERE f.status = 'failed' AND f.updated_at >= ${since} AND f.updated_at <= ${now}
    UNION ALL
    SELECT c.order_item_id, c.order_id, o.reference, c.attention_required_at AS raised_at
    FROM cancellation_requests c JOIN orders o ON o.id = c.order_id
    WHERE c.status = 'refund_failed' AND c.closed_at IS NULL
      AND c.attention_required_at >= ${since} AND c.attention_required_at <= ${now}
    ORDER BY raised_at DESC LIMIT ${limit}`;
  for (const r of refunds) {
    out.push({
      kind: "refund_failed",
      entityKind: "order_item",
      entityId: String(r.order_item_id),
      reason: "refund_failed",
      raisedAt: date(r.raised_at),
      orderId: str(r.order_id),
      orderReference: str(r.reference),
      bookingId: null,
      supplierBookingRef: null,
      adminPath: bookingPath(str(r.reference)),
    });
  }

  const bookings = await prisma.$queryRaw<Row[]>`
    SELECT b.id, b.state::text AS state, b.error_code, b.attention_required_at, b.recovery_searches, b.supplier_booking_id,
      b.order_id, o.reference, COALESCE(b.attention_required_at, b.updated_at) AS raised_at
    FROM supplier_bookings b LEFT JOIN orders o ON o.id = b.order_id
    WHERE (
        (b.error_code IN ('late_acceptance', 'late_acceptance_duplicate', 'charged_amount_mismatch', 'reservation_slot_mismatch', 'funds_unverified',
            'external_confirmation_handoff', 'external_booking_failed', 'external_hold_unusable', 'external_unconfirmed_at_start', 'external_reservation_released', 'external_failed_after_confirm') AND b.attention_required_at IS NOT NULL)
        OR (b.state = 'awaiting_external' AND b.attention_required_at IS NOT NULL AND b.external_route IS TRUE)
        OR b.state IN ('manual_review', 'cancel_refused', 'not_found_unresolved')
        OR (b.state = 'outcome_unknown' AND b.recovery_searches >= 1)
      )
      AND COALESCE(b.attention_required_at, b.updated_at) >= ${since} AND COALESCE(b.attention_required_at, b.updated_at) <= ${now}
    ORDER BY raised_at DESC LIMIT ${limit}`;
  for (const r of bookings) {
    const reason = bookingReason({ state: String(r.state), errorCode: str(r.error_code), attention: r.attention_required_at !== null, recoverySearches: Number(r.recovery_searches) });
    if (!reason) continue;
    out.push({
      kind: "booking_attention",
      entityKind: "supplier_booking",
      entityId: String(r.id),
      reason,
      raisedAt: date(r.raised_at),
      orderId: str(r.order_id),
      orderReference: str(r.reference),
      bookingId: String(r.id),
      supplierBookingRef: str(r.supplier_booking_id),
      adminPath: bookingPath(str(r.reference)),
    });
  }

  // Doc 29 Batch 6 (review 89 B6-14): a failed external booking whose recorded charge has no matching refund in the
  // wallet book `EXTERNAL_REFUND_ALERT_AFTER_MS` after it was rejected. Raised then, before the funds window closes.
  const unrefunded = await prisma.$queryRaw<Row[]>`
    SELECT b.id, b.supplier_booking_id, b.order_id, o.reference, b.closed_at + make_interval(secs => ${EXTERNAL_REFUND_ALERT_AFTER_MS / 1000}::double precision) AS raised_at
    FROM supplier_bookings b LEFT JOIN orders o ON o.id = b.order_id
    WHERE b.state = 'rejected' AND b.external_route IS TRUE AND b.closed_at IS NOT NULL
      AND b.closed_at + make_interval(secs => ${EXTERNAL_REFUND_ALERT_AFTER_MS / 1000}::double precision) BETWEEN ${since} AND ${now}
      AND EXISTS (SELECT 1 FROM ledger_entries l WHERE l.supplier_booking_id = b.id AND l.book = 'supplier_wallet' AND l.kind = 'charged')
      AND (SELECT COALESCE(sum(l.amount_minor), 0) FROM ledger_entries l WHERE l.supplier_booking_id = b.id AND l.book = 'supplier_wallet') < 0
    ORDER BY raised_at DESC LIMIT ${limit}`;
  for (const r of unrefunded) {
    out.push({
      kind: "booking_attention",
      entityKind: "supplier_booking",
      entityId: String(r.id),
      reason: "external_refund_not_seen",
      raisedAt: date(r.raised_at),
      orderId: str(r.order_id),
      orderReference: str(r.reference),
      bookingId: String(r.id),
      supplierBookingRef: str(r.supplier_booking_id),
      adminPath: bookingPath(str(r.reference)),
    });
  }

  // Tickets flagged for staff: the F12 thresholds and the staff-only reads already set `attention_required_at` (document.service.ts).
  const documents = await prisma.$queryRaw<Row[]>`
    SELECT d.id, d.status, d.supplier_booking_id, d.attention_required_at, b.confirmed_at, b.service_date, b.start_minutes, b.booking_kind,
      b.supplier_booking_id AS supplier_ref, b.order_id, o.reference
    FROM supplier_documents d JOIN supplier_bookings b ON b.id = d.supplier_booking_id LEFT JOIN orders o ON o.id = b.order_id
    WHERE (d.status IN ('pending', 'incomplete', 'failed', 'quarantined')
        -- A valid ticket set with attention: its tickets stop being valid before the visit (review 86 B5-02).
        OR (d.status = 'valid' AND d.kind = 'ticket_codes' AND d.invalidated_at IS NULL))
      AND d.attention_required_at >= ${since} AND d.attention_required_at <= ${now}
    ORDER BY d.attention_required_at DESC LIMIT ${limit}`;
  for (const r of documents) {
    const raisedAt = date(r.attention_required_at);
    const timing = { serviceDate: date(r.service_date), startMinutes: r.start_minutes === null ? null : Number(r.start_minutes) };
    const urgent = urgentAt({ confirmedAt: r.confirmed_at ? date(r.confirmed_at) : null, ...timing });
    // An open-dated ticket raised by the visit deadline (document.service.ts raiseVisitDeadline) says so, apart from F12.
    const visit = r.booking_kind === "ticket_only" ? visitDeadlineLevel(timing, raisedAt) : null;
    const reason =
      r.status === "valid"
        ? "ticket_validity_before_visit"
        : visit
          ? visit.level === "urgent"
            ? "tickets_missing_before_visit_urgent"
            : "tickets_missing_before_visit"
          : urgent && raisedAt.getTime() >= urgent.getTime()
            ? "tickets_missing_urgent"
            : "tickets_need_staff";
    out.push({
      kind: "document_attention",
      entityKind: "supplier_document",
      entityId: String(r.id),
      reason,
      raisedAt,
      orderId: str(r.order_id),
      orderReference: str(r.reference),
      bookingId: str(r.supplier_booking_id),
      supplierBookingRef: str(r.supplier_ref),
      adminPath: bookingPath(str(r.reference)),
    });
  }

  // Doc 30 N3 (NR-01): entity kind `supplier_account`, so no constraint change.
  const tdUpkeepEnvironment = traveldeskConfigFrom(env())?.environment;
  if (tdUpkeepEnvironment) out.push(...(await (await import("./traveldesk-upkeep-job")).upkeepIncompleteIncidents(tdUpkeepEnvironment, since, now)));
  out.push(...(await crmDeleteIncidents(since, now, limit)));
  out.push(...(await crmSyncDeadIncidents(since, now, limit)));
  out.push(...(await crmPortalIncidents(since, now)));
  out.push(...(await crmReturnIncidents(since, now, limit)));
  const tdEnvironment = traveldeskConfigFrom(env())?.environment;
  if (tdEnvironment) out.push(...(await catalogueStaleIncidents(tdEnvironment, since, now)));
  out.push(...(await quoteBudgetIncidents(since, now, limit)));
  // Doc 30 N2: needs migration 20261127140000 (entity kind `privileged_approval`).
  out.push(...(await ownerAlertIncidents(since, now, limit)));
  // Doc 30 N2 review N2-04: needs migration 20261127160000 (entity kind `bulk_operation_item`).
  out.push(...(await bulkDisarmIncidents(since, now, limit)));
  // Review 102c D5: entity kind `payment_saga`, so no constraint change.
  out.push(...(await duplicateScanIncidents(since, now)));
  return out;
}

/**
 * The stale-catalogue incident for one environment, from the finish of its
 * latest complete sync run: raised when that finish is more than
 * `CATALOGUE_STALE_AFTER_MS` old, at the moment it turned stale, and only
 * inside the sweep window. Pure, for tests. No complete run at all: nothing
 * (the per-offer rule in readiness already keeps those offers on inquiry).
 */
export function catalogueStaleIncident(environment: SupplierEnvironment, lastCompleteFinishedAt: Date | null, since: Date, now: Date): OpsIncident | null {
  if (!lastCompleteFinishedAt) return null;
  const staleAt = new Date(lastCompleteFinishedAt.getTime() + CATALOGUE_STALE_AFTER_MS);
  if (staleAt.getTime() > now.getTime() || staleAt.getTime() < since.getTime()) return null;
  return {
    kind: "catalogue_stale",
    entityKind: "supplier_account",
    entityId: `${TRAVELDESK_SUPPLIER_CODE}.catalogue.${environment}`,
    reason: "catalogue_stale",
    raisedAt: staleAt,
    orderId: null,
    orderReference: null,
    bookingId: null,
    supplierBookingRef: null,
    adminPath: `/admin/suppliers/${TRAVELDESK_SUPPLIER_CODE}`,
  };
}

/**
 * Reads the latest complete run as readiness counts it (`completeRunWhere` in
 * supplier-catalog.service.ts: complete, read at least one tour, not an empty
 * list). Guarded like the CRM read: before the Batch 1b migration the table
 * is absent and this yields nothing rather than failing the sweep.
 */
export async function catalogueStaleIncidents(environment: SupplierEnvironment, since: Date, now: Date, supplierCode: string = TRAVELDESK_SUPPLIER_CODE): Promise<OpsIncident[]> {
  const rows = await prisma
    .$queryRaw<Row[]>`
    SELECT finished_at FROM supplier_sync_runs
    WHERE supplier_code = ${supplierCode} AND environment = ${environment} AND status = 'complete' AND tours > 0
      AND (removals_skipped IS NULL OR removals_skipped <> 'empty_tour_list')
    ORDER BY finished_at DESC LIMIT 1`
    .catch((e: unknown) => {
      if (/42P01|supplier_sync_runs.*does not exist/.test(String((e as { message?: unknown })?.message ?? "")) || (e as { meta?: { code?: unknown } })?.meta?.code === "42P01") return [] as Row[];
      throw e;
    });
  const incident = catalogueStaleIncident(environment, rows[0]?.finished_at ? date(rows[0].finished_at) : null, since, now);
  return incident ? [incident] : [];
}

/**
 * Dead-lettered CRM deletes (erasure or retention, doc 29 §6.5): the CRM copy
 * may still exist, so a human must delete it in the portal. One incident per
 * subject and reason. The query is guarded: before the CRM migration the
 * table is absent and this yields nothing rather than failing the sweep.
 */
export async function crmDeleteIncidents(since: Date, now: Date, limit = COLLECT_LIMIT): Promise<OpsIncident[]> {
  const rows = await prisma
    .$queryRaw<Row[]>`
    SELECT entity_type, entity_id::text AS entity_id, reason, (last_error_code = 'refused:linked_deal_not_visible') AS unverified, max(updated_at) AS raised_at
    FROM crm_outbox
    WHERE (kind = 'delete' OR ${CRM_DELETE_CODES_SQL}) AND status = 'dead' AND updated_at >= ${since} AND updated_at <= ${now}
    GROUP BY entity_type, entity_id, reason, unverified
    ORDER BY raised_at DESC LIMIT ${limit}`
    .catch((e: unknown) => {
      // 42P01 undefined_table: the CRM migration is not applied yet.
      if (/42P01|crm_outbox.*does not exist/.test(String((e as { message?: unknown })?.message ?? "")) || (e as { meta?: { code?: unknown } })?.meta?.code === "42P01") return [] as Row[];
      throw e;
    });
  return rows.map((r) => ({
    kind: "crm_delete_failed" as const,
    entityKind: "crm_subject" as const,
    entityId: `${String(r.entity_type)}:${String(r.entity_id)}`,
    // Unverified (review C2A-08): the linked deal was not visible to the service account; an administrator must
    // look for it in the other funnels.
    reason: `crm_${r.reason === "retention" ? "retention" : "erasure"}_${r.unverified === true ? "deal_not_visible" : "delete_dead"}`,
    raisedAt: date(r.raised_at),
    orderId: null,
    orderReference: null,
    bookingId: null,
    supplierBookingRef: null,
    adminPath: "/admin",
  }));
}

/**
 * Codes a sync row can only die with while deleting an erased subject's deal (crm.worker.ts deleteCopies): such a
 * row is the delete incident, never "sync gave up", because customer data may still be on the portal (C2B-05).
 */
export const CRM_DELETE_ERROR_CODES = ["refused:linked_deal_not_visible", "rejected:delete_not_found_visible", "refused:delete_target"] as const;
export const CRM_DELETE_ERROR_PREFIX = "invalid_response:delete_result_";
const deleteCodesSql = (col: Prisma.Sql) =>
  Prisma.sql`(${col} IN (${Prisma.join([...CRM_DELETE_ERROR_CODES])}) OR ${col} LIKE ${`${CRM_DELETE_ERROR_PREFIX}%`})`;
const CRM_DELETE_CODES_SQL = deleteCodesSql(Prisma.raw("last_error_code"));
const CRM_DELETE_CODES_SQL_C = deleteCodesSql(Prisma.raw("c.last_error_code"));
/** Pure, for tests: whether a dead row's code is a delete code. */
export function isCrmDeleteCode(code: string | null): boolean {
  return code !== null && ((CRM_DELETE_ERROR_CODES as readonly string[]).includes(code) || code.startsWith(CRM_DELETE_ERROR_PREFIX));
}

const isMissingTable = (e: unknown, table: string) =>
  new RegExp(`42P01|${table}.*does not exist`).test(String((e as { message?: unknown })?.message ?? "")) || (e as { meta?: { code?: unknown } })?.meta?.code === "42P01";

/** The error kinds a dead CRM row's `last_error_code` starts with (bitrix.client.ts CrmErrorKind). */
const CRM_ERROR_KINDS = new Set(["throttled", "unavailable", "auth", "not_found", "rejected", "invalid_response", "refused"]);

/** `crm_sync_dead_<kind>` from a stored `kind:CODE`; an unknown or missing kind is `other`. Pure, for tests. */
export function crmSyncDeadReason(lastErrorCode: string | null): string {
  const kind = (lastErrorCode ?? "").split(":")[0];
  return `crm_sync_dead_${CRM_ERROR_KINDS.has(kind) ? kind : "other"}`;
}

/**
 * Dead-lettered CRM sync rows (doc 29d G11): the deal stopped following OUTLYY. A sync row that died because an
 * erased subject's deal was not visible is the delete incident above, not this one. Guarded like the delete read.
 */
export async function crmSyncDeadIncidents(since: Date, now: Date, limit = COLLECT_LIMIT): Promise<OpsIncident[]> {
  const rows = await prisma
    .$queryRaw<Row[]>`
    SELECT c.entity_type, c.entity_id::text AS entity_id, c.last_error_code, max(c.updated_at) AS raised_at, max(o.reference) AS reference
    FROM crm_outbox c LEFT JOIN orders o ON c.entity_type = 'order' AND o.id = c.entity_id
    WHERE c.kind = 'sync' AND c.status = 'dead' AND c.updated_at >= ${since} AND c.updated_at <= ${now}
      AND (c.last_error_code IS NULL OR NOT (${CRM_DELETE_CODES_SQL_C}))
    GROUP BY c.entity_type, c.entity_id, c.last_error_code
    ORDER BY raised_at DESC LIMIT ${limit}`
    .catch((e: unknown) => {
      if (isMissingTable(e, "crm_outbox")) return [] as Row[];
      throw e;
    });
  return rows.map((r) => {
    const reference = str(r.reference);
    const inquiry = r.entity_type === "inquiry";
    return {
      kind: "crm_sync_dead" as const,
      entityKind: "crm_subject" as const,
      entityId: `${String(r.entity_type)}:${String(r.entity_id)}`,
      reason: crmSyncDeadReason(str(r.last_error_code)),
      raisedAt: date(r.raised_at),
      // Only an order that exists (the join found its reference) is named.
      orderId: inquiry || !reference ? null : String(r.entity_id),
      orderReference: inquiry ? null : reference,
      bookingId: null,
      supplierBookingRef: null,
      adminPath: inquiry ? `/admin/inquiries/${encodeURIComponent(String(r.entity_id))}` : bookingPath(reference),
    };
  });
}

/** The CRM worker's pause as crm_portal_state stores it. */
export interface CrmPortalPause {
  environment: string;
  pauseReason: string | null;
  pausedUntil: Date | null;
  consecutiveFailures: number;
}

/**
 * The open-circuit incident of one CRM portal row (doc 29d G11), raised at the moment the circuit opened: the
 * worker sets `paused_until` to that moment plus `AUTH_PAUSE_MS` (auth) or `breakerPauseMs(failures)` (breaker),
 * so the opening time is exact and stays the same until the next re-open. A breaker row whose failures were reset
 * by a success, a throttle pause, or an opening outside the sweep window is no incident. Pure, for tests.
 */
export function crmPortalIncident(row: CrmPortalPause, since: Date, now: Date): OpsIncident | null {
  if (!row.pausedUntil) return null;
  let openedAt: number;
  let reason: string;
  if (row.pauseReason === "auth") {
    openedAt = row.pausedUntil.getTime() - AUTH_PAUSE_MS;
    reason = "crm_auth_refused";
  } else if (row.pauseReason === "breaker" && row.consecutiveFailures >= BREAKER_THRESHOLD) {
    openedAt = row.pausedUntil.getTime() - breakerPauseMs(row.consecutiveFailures);
    reason = "crm_breaker_open";
  } else return null;
  if (openedAt > now.getTime() || openedAt < since.getTime()) return null;
  return {
    kind: "crm_sync_paused",
    entityKind: "crm_subject",
    entityId: `portal:${row.environment}`,
    reason,
    raisedAt: new Date(openedAt),
    orderId: null,
    orderReference: null,
    bookingId: null,
    supplierBookingRef: null,
    adminPath: "/admin",
  };
}

export async function crmPortalIncidents(since: Date, now: Date): Promise<OpsIncident[]> {
  const rows = await prisma
    .$queryRaw<Row[]>`
    SELECT environment, pause_reason, paused_until, consecutive_failures FROM crm_portal_state
    WHERE pause_reason IN ('breaker', 'auth') AND paused_until IS NOT NULL`
    .catch((e: unknown) => {
      if (isMissingTable(e, "crm_portal_state")) return [] as Row[];
      throw e;
    });
  return rows
    .map((r) =>
      crmPortalIncident(
        { environment: String(r.environment), pauseReason: str(r.pause_reason), pausedUntil: r.paused_until ? date(r.paused_until) : null, consecutiveFailures: Number(r.consecutive_failures) },
        since,
        now,
      ),
    )
    .filter((i): i is OpsIncident => i !== null);
}

/* ---------------------------------------------------------------------------
 * Service
 * ------------------------------------------------------------------------ */

export interface OpsAlertDispatch {
  event: StoredPayload["event"];
  recipient: string;
  orderId: string | null;
  context: StoredPayload["context"];
  /** The incident occurrence: one notification row (and provider key) per recipient. */
  once: string;
}

export interface OpsAlertDeps {
  collect(since: Date, now: Date): Promise<OpsIncident[]>;
  recipients(): string[];
  siteUrl(): string;
  dispatch(input: OpsAlertDispatch): Promise<DispatchResult>;
  now(): Date;
}

export interface OpsAlertSweepSummary {
  skipped?: "no_recipients";
  incidents: number;
  claimed: number;
  deduped: number;
  suppressed: number;
  digests: number;
  dispatched: number;
  dispatchFailed: number;
}

export function createOpsAlertService(deps: OpsAlertDeps) {
  let warnedNoRecipients = false;

  /** Decide every incident under one lock: send, wait (dedup), or suppress (throttle); then the digest. */
  async function claim(incidents: OpsIncident[], now: Date, summary: OpsAlertSweepSummary): Promise<void> {
    const siteUrl = deps.siteUrl();
    await prisma.$transaction(async (tx) => {
      // The digest row doubles as the sweep's lock: concurrent sweeps decide one after the other.
      await tx.$executeRaw`INSERT INTO ops_alerts (id, entity_kind, entity_id, reason, incident_at, handled_at, updated_at)
        VALUES (${uuidv7()}::uuid, ${DIGEST.entityKind}, ${DIGEST.entityId}, ${DIGEST.reason}, ${EPOCH}, ${EPOCH}, ${now})
        ON CONFLICT (entity_kind, entity_id, reason) DO NOTHING`;
      const [digest] = await tx.$queryRaw<{ id: string; last_sent_at: Date | null }[]>`
        SELECT id, last_sent_at FROM ops_alerts WHERE entity_kind = ${DIGEST.entityKind} AND entity_id = ${DIGEST.entityId} AND reason = ${DIGEST.reason} FOR UPDATE`;

      const hourAgo = new Date(now.getTime() - 3600_000);
      let sentThisHour = await tx.opsAlert.count({ where: { entityKind: { not: DIGEST.entityKind }, lastSentAt: { gt: hourAgo, lte: now } } });

      for (const i of incidents) {
        const where = { entityKind_entityId_reason: { entityKind: i.entityKind, entityId: i.entityId, reason: i.reason } };
        const row = await tx.opsAlert.findUnique({ where });
        if (row && i.raisedAt.getTime() <= row.incidentAt.getTime()) continue; // this raise was already handled
        if (row && now.getTime() - row.handledAt.getTime() < OPS_ALERT_DEDUP_MS) {
          summary.deduped++;
          continue;
        }
        const id = row?.id ?? uuidv7();
        if (sentThisHour < OPS_ALERT_HOURLY_CAP) {
          const payload: StoredPayload = {
            event: "OPS_INCIDENT_ALERT",
            once: `ops:${i.entityKind}:${i.entityId}:${i.reason}:${i.raisedAt.toISOString()}`,
            orderId: i.orderId,
            context: incidentContext(i, siteUrl),
          };
          const data = { incidentAt: i.raisedAt, handledAt: now, lastSentAt: now, payload: payload as object, dispatchPending: true };
          await tx.opsAlert.upsert({ where, create: { id, entityKind: i.entityKind, entityId: i.entityId, reason: i.reason, sends: 1, ...data }, update: { ...data, sends: { increment: 1 } } });
          sentThisHour++;
          summary.claimed++;
          emitEvent("alerts.claimed", { alertId: id, entityKind: i.entityKind, reason: i.reason }, "warn");
        } else {
          const data = { incidentAt: i.raisedAt, handledAt: now, lastSuppressedAt: now };
          await tx.opsAlert.upsert({ where, create: { id, entityKind: i.entityKind, entityId: i.entityId, reason: i.reason, suppressed: 1, ...data }, update: { ...data, suppressed: { increment: 1 } } });
          summary.suppressed++;
          emitEvent("alerts.suppressed", { alertId: id, entityKind: i.entityKind, reason: i.reason }, "warn");
        }
      }

      // At most one digest per hour, for what the throttle held back since the last one.
      const lastDigest = digest.last_sent_at;
      if (lastDigest && now.getTime() - lastDigest.getTime() < OPS_ALERT_DIGEST_EVERY_MS) return;
      const since = lastDigest ?? EPOCH;
      const held = await tx.opsAlert.count({ where: { entityKind: { not: DIGEST.entityKind }, lastSuppressedAt: { gt: since, lte: now } } });
      if (held === 0) return;
      const payload: StoredPayload = {
        event: "OPS_ALERT_DIGEST",
        once: `ops:digest:${now.toISOString()}`,
        orderId: null,
        context: { suppressedCount: held, sinceIso: (lastDigest ?? hourAgo).toISOString(), untilIso: now.toISOString(), adminUrl: adminUrl(siteUrl, "/admin/bookings") },
      };
      await tx.opsAlert.update({ where: { id: digest.id }, data: { incidentAt: now, handledAt: now, lastSentAt: now, sends: { increment: 1 }, payload: payload as object, dispatchPending: true } });
      summary.digests++;
      emitEvent("alerts.digest", { alertId: digest.id, count: held }, "warn");
    }, TX_OPTIONS);
  }

  /**
   * After the commit: hand each claimed row to the notification outbox, one
   * dispatch per recipient. The outbox dedups on `once`, so a row left pending
   * by a crash or a failed dispatch is re-handed on the next sweep without a
   * second email. A provider failure is the outbox's to retry; it never
   * reaches the caller.
   */
  async function dispatchPending(recipients: string[], summary: OpsAlertSweepSummary): Promise<void> {
    const rows = await prisma.opsAlert.findMany({ where: { dispatchPending: true }, orderBy: { handledAt: "asc" }, take: DISPATCH_LIMIT });
    for (const row of rows) {
      const p = row.payload as unknown as StoredPayload;
      let handed = true;
      for (const recipient of recipients) {
        try {
          const r = await deps.dispatch({ event: p.event, recipient, orderId: p.orderId ?? null, context: p.context, once: p.once });
          if (r.outcome !== "sent" && r.outcome !== "suppressed") summary.dispatchFailed++;
        } catch {
          handed = false;
          summary.dispatchFailed++;
          emitEvent("alerts.dispatch_failed", { alertId: row.id, reason: "dispatch_threw" }, "error");
        }
      }
      if (!handed) continue;
      await prisma.opsAlert.updateMany({ where: { id: row.id, dispatchPending: true, handledAt: row.handledAt }, data: { dispatchPending: false } });
      summary.dispatched++;
    }
  }

  return {
    /** Never throws: the scheduled sweep that calls it must carry on. */
    async sweep(): Promise<OpsAlertSweepSummary> {
      const summary: OpsAlertSweepSummary = { incidents: 0, claimed: 0, deduped: 0, suppressed: 0, digests: 0, dispatched: 0, dispatchFailed: 0 };
      const now = deps.now();
      const recipients = deps.recipients();
      if (!recipients.length) {
        if (!warnedNoRecipients) {
          warnedNoRecipients = true;
          emitEvent("alerts.no_recipients", { pending: null }, "warn");
        }
        return { ...summary, skipped: "no_recipients" };
      }
      warnedNoRecipients = false;

      let incidents: OpsIncident[] = [];
      try {
        incidents = latestPerKey(await deps.collect(new Date(now.getTime() - OPS_ALERT_LOOKBACK_MS), now));
        summary.incidents = incidents.length;
      } catch {
        emitEvent("alerts.sweep_failed", { stage: "collect", reason: "query_failed" }, "error");
      }
      try {
        await claim(incidents, now, summary);
      } catch {
        emitEvent("alerts.sweep_failed", { stage: "claim", reason: "transaction_failed" }, "error");
      }
      try {
        await dispatchPending(recipients, summary);
      } catch {
        emitEvent("alerts.sweep_failed", { stage: "dispatch", reason: "query_failed" }, "error");
      }
      return summary;
    },
  };
}

export const opsAlertService = createOpsAlertService({
  collect: (since, now) => collectOpsIncidents(since, now),
  recipients: () => env().opsAlertEmails,
  siteUrl: () => env().NEXT_PUBLIC_SITE_URL,
  dispatch: (input) =>
    notificationService.dispatch({
      event: input.event,
      channel: "email",
      recipient: input.recipient,
      orderId: input.orderId ?? undefined,
      // Codes, ids and the order reference only (OpsAlertContext); rendered from this stored context on every attempt.
      context: input.context as unknown as TemplateContext,
      once: input.once,
    }),
  now: () => new Date(),
});
