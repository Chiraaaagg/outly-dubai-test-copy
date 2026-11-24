import "server-only";
import { prisma } from "../lib/db";
import type { CrmItemFacts, CrmOrderFacts, CrmSubject, CrmSubjectState } from "./crm.mapping";

/**
 * Current local state of one deal subject, read at push time (doc 29 §6.4:
 * the outbox stores no payload; the worker re-reads and pushes a full
 * snapshot). Reads only the columns the mapping needs. Contact columns are
 * read solely to detect an erased subject (the `[deleted-…]` marker the
 * erasure workflow writes) and never leave this function.
 *
 * Line names come from the catalogue (the product's title or the combo's
 * name), never from the item's `titleSnapshot`: on an assisted inquiry or
 * quote that snapshot can be agent-edited text, so a customer's name typed
 * into it would reach the deal (review R14). A line with no catalogue record
 * gets a generic name.
 *
 * Money: only provider-verified payments count (`source = gateway_verified`,
 * PAY-9), in the order's currency, less each payment's refunded total. A manual
 * payment recorded by staff is not revenue evidence here (see the C1 record:
 * assisted orders paid by link show 0 until C2 decides).
 */

const ERASED = "[deleted-";

/** The catalogue's own name for a line (staff-authored public copy), or null when it has no catalogue record. */
function catalogueTitle(i: { product: { title: string } | null; combo: { name: string } | null }): string | null {
  return i.product?.title ?? i.combo?.name ?? null;
}

function isoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

async function orderFacts(orderId: string): Promise<(CrmOrderFacts & { erased: boolean }) | null> {
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      reference: true,
      status: true,
      currency: true,
      leadPhone: true,
      leadName: true,
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
          documents: { where: { status: "valid", customerVisible: true }, select: { id: true }, take: 1 },
        },
      },
      payments: {
        where: { source: "gateway_verified" },
        select: { id: true, currency: true, capturedMinor: true, refundedMinor: true, authorizedAt: true },
      },
    },
  });
  if (!o) return null;
  const currency = o.currency;
  let captured = 0n;
  let refunded = 0n;
  let authorised = false;
  for (const p of o.payments) {
    if (p.authorizedAt || p.capturedMinor > 0n) authorised = true;
    if (p.currency !== currency) continue;
    captured += p.capturedMinor;
    // The payment's refunded total: our settled refunds max-merged with the provider's read (refunds.ts), so a
    // refund made outside OUTLYY also lowers revenue.
    refunded += p.refundedMinor > p.capturedMinor ? p.capturedMinor : p.refundedMinor;
  }
  const items: CrmItemFacts[] = [...o.items]
    .sort((a, b) => (a.quoteLineIndex ?? 0) - (b.quoteLineIndex ?? 0) || a.id.localeCompare(b.id))
    .map((i) => ({
      title: catalogueTitle(i),
      serviceDate: isoDate(i.serviceDate),
      totalMinor: i.chargedCurrency === currency && i.chargedAmountMinor !== null ? i.chargedAmountMinor : currency === "AED" ? i.totalAed : i.totalInr,
      status: i.status,
      needsDocument: i.fulfilmentOrigin === "instant_checkout",
      documentReady: i.documents.length > 0,
    }));
  return {
    reference: o.reference,
    status: o.status,
    currency,
    authorised,
    capturedMinor: captured,
    refundedMinor: refunded > captured ? captured : refunded,
    items,
    erased: o.leadPhone.startsWith(ERASED) || o.leadName.startsWith(ERASED),
  };
}

export async function loadSubjectState(subject: CrmSubject): Promise<CrmSubjectState> {
  if (subject.type === "order") {
    const o = await orderFacts(subject.id);
    if (!o) return { subject, exists: false, erased: false, inquiry: null, order: null };
    const { erased, ...order } = o;
    return { subject, exists: true, erased, inquiry: null, order };
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
      convertedOrderId: true,
      items: {
        select: { product: { select: { title: true } }, combo: { select: { name: true } }, serviceDate: true, sortOrder: true },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!q) return { subject, exists: false, erased: false, inquiry: null, order: null };
  const o = q.convertedOrderId ? await orderFacts(q.convertedOrderId) : null;
  const erased = q.leadPhone.startsWith(ERASED) || q.leadName.startsWith(ERASED) || Boolean(o?.erased);
  const order = o ? (({ erased: _e, ...rest }) => rest)(o) : null;
  return {
    subject,
    exists: true,
    erased,
    inquiry: {
      reference: q.reference,
      status: q.status,
      source: q.source,
      currency: q.currency,
      items: q.items.map((i) => ({ title: catalogueTitle(i), serviceDate: isoDate(i.serviceDate), totalMinor: null })),
    },
    order,
  };
}
