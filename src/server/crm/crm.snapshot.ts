import "server-only";
import { prisma } from "../lib/db";
import { HANDOFF_ERROR_CODES, HANDOFF_STATES } from "./crm.timeline";
import {
  bitrixInstant,
  lineTotalMinor,
  marginAedMinor,
  revenueFromPayments,
  type CrmConsentFacts,
  type CrmConsentFlag,
  type CrmContactFacts,
  type CrmItemFacts,
  type CrmOrderFacts,
  type CrmSubject,
  type CrmSubjectState,
} from "./crm.mapping";

/**
 * Current local state of one deal subject, read at push time (doc 29 §6.4:
 * the outbox stores no payload; the worker re-reads and pushes a full
 * snapshot). Reads only the columns the mapping needs.
 *
 * Customer details (C2a, decision C2-4): the lead's name, phone and email
 * as given on the inquiry, or on the order's traveller snapshot once the
 * sale exists. They go to the deal's own fields only. An erased subject is
 * detected by the `[deleted-…]` marker the erasure workflow writes and its
 * details are never returned. Nothing else personal is read: no hotel,
 * pickup, dietary or special-request text, no participant data, no IP hash,
 * no spam signals, no attribution.
 *
 * Consent (Q6): the latest row of the append-only `consents` record for
 * marketing by email (the lead's email) and marketing by WhatsApp (the
 * lead's phone), each with its time.
 *
 * Line names come from the catalogue (the product's title or the combo's
 * name), never from the item's `titleSnapshot`: on an assisted inquiry or
 * quote that snapshot can be agent-edited text, so a customer's name typed
 * into it would reach the deal (review R14). A line with no catalogue record
 * gets a generic name.
 *
 * Money (owner answer Q4): provider-verified payments (`gateway_verified`,
 * PAY-9) count with their captured amount; a payment a staff member recorded
 * in OUTLYY admin (`source = manual`, status captured or refunded) counts
 * with its amount, the same as a Stripe capture. Each payment counts in the
 * order's currency only, less its verified refunds (the payment's refunded
 * total, max-merged with the provider's read for gateway payments; settled
 * refund rows for staff-recorded ones), never below zero. Provider and link
 * identifiers are never read.
 *
 * Margin (decision C2-9, Q8, review C2A-10): one AED amount, the gross
 * profit of `domain/margin.ts` over the live lines (customer price − net
 * cost − the variable costs in the line's MarginSnapshot), only for an order
 * charged in AED whose every live line has a known (positive) net cost;
 * otherwise null (an empty field). The net cost and the snapshot never leave
 * this function.
 */

const ERASED = "[deleted-";

/** The catalogue's own name for a line (staff-authored public copy), or null when it has no catalogue record. */
function catalogueTitle(i: { product: { title: string } | null; combo: { name: string } | null }): string | null {
  return i.product?.title ?? i.combo?.name ?? null;
}

function isoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

async function orderFacts(orderId: string): Promise<(CrmOrderFacts & { erased: boolean; contact: CrmContactFacts | null; placedAt: Date }) | null> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      reference: true,
      status: true,
      currency: true,
      leadPhone: true,
      leadName: true,
      leadEmail: true,
      totalAed: true,
      totalInr: true,
      placedAt: true,
      items: {
        select: {
          id: true,
          product: { select: { title: true } },
          combo: { select: { name: true } },
          serviceDate: true,
          status: true,
          fulfilmentOrigin: true,
          totalInr: true,
          totalAed: true,
          chargedCurrency: true,
          chargedAmountMinor: true,
          quoteLineIndex: true,
          netCostAed: true,
          marginSnapshot: true,
          documents: { where: { status: "valid", customerVisible: true }, select: { id: true }, take: 1 },
        },
      },
      // Supplier-confirmation hand-offs only (C2B-03, R-01; crm.timeline.ts lists): whether one exists, never a code,
      // message or note leaves this read.
      supplierBookings: {
        where: { OR: [{ attentionRequiredAt: { not: null }, errorCode: { in: [...HANDOFF_ERROR_CODES] } }, { state: { in: [...HANDOFF_STATES] } }] },
        select: { id: true },
        take: 1,
      },
      payments: {
        where: { source: { in: ["gateway_verified", "manual"] } },
        select: {
          id: true,
          source: true,
          status: true,
          currency: true,
          amountMinor: true,
          capturedMinor: true,
          refundedMinor: true,
          authorizedAt: true,
          refunds: { select: { status: true, amountMinor: true } },
        },
      },
    },
  });
  if (!o) return null;
  const currency = o.currency;
  const { capturedMinor, refundedMinor, authorised, refundPending, otherCurrencyPaid } = revenueFromPayments(o.payments, currency);
  const items: CrmItemFacts[] = [...o.items]
    .sort((a, b) => (a.quoteLineIndex ?? 0) - (b.quoteLineIndex ?? 0) || a.id.localeCompare(b.id))
    .map((i) => ({
      title: catalogueTitle(i),
      serviceDate: isoDate(i.serviceDate),
      totalMinor: lineTotalMinor(i, currency),
      status: i.status,
      needsDocument: i.fulfilmentOrigin === "instant_checkout",
      documentReady: i.documents.length > 0,
    }));
  const erased = o.leadPhone.startsWith(ERASED) || o.leadName.startsWith(ERASED) || Boolean(o.leadEmail?.startsWith(ERASED));
  return {
    reference: o.reference,
    status: o.status,
    currency,
    authorised,
    capturedMinor,
    refundedMinor,
    items,
    totalMinor: currency === "AED" ? o.totalAed : o.totalInr,
    refundPending,
    otherCurrencyPaid,
    handedToTeam: o.supplierBookings.length > 0,
    marginAedMinor: currency === "AED" ? marginAedMinor(o.items) : null,
    erased,
    contact: erased ? null : { name: o.leadName, phone: o.leadPhone, email: o.leadEmail },
    placedAt: o.placedAt,
  };
}

async function consentFor(contact: CrmContactFacts | null): Promise<CrmConsentFacts> {
  const flag = (r: { granted: boolean; createdAt: Date } | null): CrmConsentFlag | null => (r ? { granted: r.granted, at: bitrixInstant(r.createdAt) } : null);
  if (!contact) return { marketingEmail: null, marketingWhatsapp: null };
  const select = { granted: true, createdAt: true } as const;
  const [email, whatsapp] = await Promise.all([
    contact.email
      ? prisma.consent.findFirst({ where: { channel: "email", purpose: "marketing", email: contact.email.toLowerCase() }, orderBy: { createdAt: "desc" }, select })
      : Promise.resolve(null),
    prisma.consent.findFirst({ where: { channel: "whatsapp", purpose: "marketing", phoneE164: contact.phone }, orderBy: { createdAt: "desc" }, select }),
  ]);
  return { marketingEmail: flag(email), marketingWhatsapp: flag(whatsapp) };
}

export async function loadSubjectState(subject: CrmSubject): Promise<CrmSubjectState> {
  if (subject.type === "order") {
    const o = await orderFacts(subject.id);
    if (!o) return { subject, exists: false, erased: false, inquiry: null, order: null };
    const { erased, contact, placedAt, ...order } = o;
    return { subject, exists: true, erased, inquiry: null, order, createdAt: placedAt, contact, consent: await consentFor(contact) };
  }
  const q = await prisma.inquiry.findUnique({
    where: { id: subject.id },
    select: {
      reference: true,
      status: true,
      source: true,
      currency: true,
      leadPhone: true,
      leadName: true,
      leadEmail: true,
      indicativeTotalAed: true,
      indicativeTotalInr: true,
      convertedOrderId: true,
      createdAt: true,
      items: {
        select: { product: { select: { title: true } }, combo: { select: { name: true } }, serviceDate: true, sortOrder: true },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!q) return { subject, exists: false, erased: false, inquiry: null, order: null };
  const o = q.convertedOrderId ? await orderFacts(q.convertedOrderId) : null;
  const erased = q.leadPhone.startsWith(ERASED) || q.leadName.startsWith(ERASED) || Boolean(q.leadEmail?.startsWith(ERASED)) || Boolean(o?.erased);
  const order = o ? (({ erased: _e, contact: _c, placedAt: _p, ...rest }) => rest)(o) : null;
  // Abandoned carts never carry contact data (they are never visible either).
  const contact: CrmContactFacts | null = erased || q.source === "abandoned_cart" ? null : (o?.contact ?? { name: q.leadName, phone: q.leadPhone, email: q.leadEmail });
  return {
    subject,
    exists: true,
    erased,
    inquiry: {
      reference: q.reference,
      status: q.status,
      source: q.source,
      currency: q.currency,
      indicativeMinor: q.currency === "AED" ? q.indicativeTotalAed : q.indicativeTotalInr,
      items: q.items.map((i) => ({ title: catalogueTitle(i), serviceDate: isoDate(i.serviceDate), totalMinor: null })),
    },
    order,
    createdAt: q.createdAt,
    contact,
    consent: await consentFor(contact),
  };
}
