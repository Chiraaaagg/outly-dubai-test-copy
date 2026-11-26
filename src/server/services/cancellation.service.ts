import "server-only";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma, TX_OPTIONS, type Tx } from "../lib/db";
import { uuidv7 } from "../lib/ids";
import { emitEvent } from "../lib/structured-events";
import { openRefund, refundableMinor, refundedOutsideOutlyMinor, RefundRefused, refundsFrozen } from "../payments/refunds";
import { travelDeskExternalRefSchema } from "../suppliers/traveldesk/traveldesk.adapter";
import type { Tristate } from "../suppliers/booking-port";
import { capabilityService } from "./capability.service";
import { itemPayableMinor } from "./order.service";
import { supplierBookingService } from "./supplier-booking.service";
import type { CancellationIneligibleReason, CancellationRequestStatus, CancellationView } from "@/lib/customer-status";

/**
 * Customer cancellation and exception requests (doc 22 §23 B5, F15, F51;
 * migration 20261102120000).
 *
 * Eligibility comes from the stored verified policy only, per order item:
 *  - an `instant_checkout` item with a `confirmed` supplier booking (anything
 *    else is `not_supported`, or nothing to offer while not confirmed);
 *  - the activity has not started (`activity_started`);
 *  - the quote line offered a free cancellation and is not
 *    `nonRefundableAfterConfirm` (`non_refundable`), and now is before its
 *    `freeCancellationUntilUtc` (`past_deadline`);
 *  - the booking is not a TicketOnly booking (doc 29 §4.4, Batch 5: a
 *    confirmed ticket is never cancellable through the API; `tickets_issued`,
 *    with the exception request to our team still offered);
 *  - the offer does not issue tickets at confirmation: the mapping's ticket
 *    evidence says `no` (`yes` or unknown is `tickets_issued`; the operator
 *    cannot cancel issued tickets through the API), and the booking itself
 *    has no stored ticket codes and no valid ticket document (R-B5-8: the
 *    booking's own evidence beats the offer's);
 *  - the payment is captured, gateway-verified, refunds are not frozen by a
 *    dispute, and what is still refundable covers the item's payable
 *    allocation (`payment_not_refundable`).
 *
 * A supported request is a row (`kind=supported`) moved to `cancelling`
 * BEFORE the engine is asked (`supplierBookingService.requestCancel`), so a
 * scheduled `paid_only` worker run, which may send a cancel only for a
 * booking an open supported request in `cancelling` names, can send it at
 * once. `advanceOpen` (run from the payments tick) then follows the engine:
 * `cancelled` (status-4 verified) opens a refund of the item's payable
 * allocation through the refund driver (refunds.ts), `cancel_refused` ends
 * the request `refused` (F51: the customer may then ask our team), an
 * unverified or unknown cancel stays processing, and the refund's outcome
 * ends it `refunded` or `refund_failed` (attention). Nothing here writes
 * supplier attempt state or moves money directly.
 *
 * An exception request (`kind=exception`) only asks our team and promises
 * nothing. One open request per item (partial unique index): a repeat
 * returns the open one. The eligibility snapshot stored on a request holds
 * the policy facts the decision used, never money or supplier figures.
 */

type Db = Tx | typeof prisma;
type Currency = "INR" | "AED";

const OPEN_SUPPORTED: CancellationRequestStatus[] = ["requested", "cancelling", "cancel_unverified", "refund_pending"];
/** Request states in which the customer is waiting on the operator's cancellation. */
const WAITING_ON_OPERATOR: CancellationRequestStatus[] = ["requested", "cancelling", "cancel_unverified"];
/**
 * PROVISIONAL (R-B5-1, F15 "ops if unresolved"): a request still waiting on
 * the operator this long after it was made is flagged for staff.
 */
export const CANCEL_STUCK_AFTER_MS = 30 * 60_000;
/**
 * PROVISIONAL (R-B5-1): a request still waiting on the operator this close to
 * the free-cancellation deadline or the activity start is flagged for staff,
 * whatever its age, so a human can act before either passes.
 */
export const CANCEL_DEADLINE_MARGIN_MS = 2 * 3600_000;
/** Asia/Dubai is UTC+4 all year; service dates and slot minutes are local. */
const DUBAI_OFFSET_MS = 4 * 3600_000;

export interface CancellationFacts {
  orderItemId: string;
  rail: "self_serve" | "assisted";
  fulfilmentOrigin: string;
  /** YYYY-MM-DD (Dubai calendar day). */
  serviceDate: string;
  /** Local start minute of the slot when the booking knows it; null = the start of the day (the earliest it could start). */
  startMinutes: number | null;
  /** The item's latest supplier attempt; `bookingKind` absent on facts built before Batch 5 (read as live book). */
  booking: { id: string; state: string; bookingKind?: string } | null;
  /** The stored verified policy (quote line snapshot); null when none was stored. */
  policy: { freeCancellationUntilUtc: string | null; nonRefundableAfterConfirm: boolean } | null;
  issuesTicketsAtConfirm: Tristate;
  /** R-B5-8: the booking has stored ticket codes or a valid ticket document, whatever the offer's evidence says. */
  ticketsStored: boolean;
  currency: Currency;
  /** The item's payable allocation, minor units of `currency`; null on rows written before B2. */
  payableMinor: bigint | null;
  /** The saga's payment, when there is one. */
  payment: { id: string; captured: boolean; verified: boolean; refundableMinor: bigint; frozen: boolean } | null;
  /** Whether money was taken for this order at all (for an exception request). */
  orderPaid: boolean;
  /**
   * A multi-item instant order whose payment saga has not reached `fulfilled`:
   * the items are still being confirmed or refunded one by one, so no item may
   * be cancelled yet (lead decision, 3 November 2026). Absent or false for a
   * one-item order.
   */
  orderSettling?: boolean;
}

export type CancellationEvaluation = Exclude<CancellationView, { kind: "requested" }>;

/** When the activity starts: the service day's local start minute (or local midnight) in UTC. */
export function serviceStartUtc(serviceDate: string, startMinutes: number | null): Date {
  const [y, m, d] = serviceDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - DUBAI_OFFSET_MS + (startMinutes ?? 0) * 60_000);
}

function notEligible(reason: CancellationIneligibleReason, exceptionAllowed: boolean): CancellationEvaluation {
  return { kind: "not_eligible", reason, exceptionAllowed };
}

/** The cancellation offer for one item, from stored facts only. Pure. */
export function evaluateCancellation(f: CancellationFacts, now: Date): CancellationEvaluation {
  const started = serviceStartUtc(f.serviceDate, f.startMinutes).getTime() <= now.getTime();
  if (f.rail === "assisted" || f.fulfilmentOrigin !== "instant_checkout") {
    if (!f.orderPaid) return { kind: "none" };
    return started ? notEligible("activity_started", false) : notEligible("not_supported", true);
  }
  // Multi-item: nothing is offered until the whole order is settled (the saga's `fulfilled`); the view shows it processing.
  if (f.orderSettling) return { kind: "none" };
  // F51: the operator refused a cancellation under its policy; the booking stays live. Our team may still be asked.
  if (f.booking?.state === "cancel_refused") return started ? notEligible("activity_started", false) : notEligible("non_refundable", true);
  if (!f.booking || f.booking.state !== "confirmed") return { kind: "none" };
  if (started) return notEligible("activity_started", false);
  // Doc 29 Batch 5: tickets are issued at confirmation and cannot be cancelled; only a goodwill request to our team.
  if (f.booking.bookingKind === "ticket_only") return notEligible("tickets_issued", true);
  const until = f.policy?.freeCancellationUntilUtc ? Date.parse(f.policy.freeCancellationUntilUtc) : Number.NaN;
  if (!f.policy || f.policy.nonRefundableAfterConfirm || !Number.isFinite(until)) return notEligible("non_refundable", true);
  if (now.getTime() >= until) return notEligible("past_deadline", true);
  if (f.issuesTicketsAtConfirm !== "no" || f.ticketsStored) return notEligible("tickets_issued", true);
  const p = f.payment;
  if (!p || !p.verified || !p.captured || p.frozen || f.payableMinor === null || f.payableMinor <= 0n || p.refundableMinor < f.payableMinor) {
    return notEligible("payment_not_refundable", !p?.frozen);
  }
  return { kind: "eligible", refundMinor: f.payableMinor.toString(), currency: f.currency, untilUtc: new Date(until).toISOString() };
}

/* ---------------------------------------------------------------------------
 * Facts loader
 * ------------------------------------------------------------------------ */

const storedPolicySchema = z.object({
  mappingId: z.string().optional(),
  serviceDate: z.string().optional(),
  freeCancellationUntilUtc: z.string().nullable(),
  nonRefundableAfterConfirm: z.boolean(),
});

type StoredPolicy = z.infer<typeof storedPolicySchema>;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The quote line this item was made from: same mapping and day, or the only line. */
function policyFor(item: { mappingId: string | null; serviceDate: Date; cancellationPolicySnapshot: unknown }, lines: unknown): CancellationFacts["policy"] {
  const parsed = (Array.isArray(lines) ? lines : []).map((l) => storedPolicySchema.safeParse(l)).filter((r) => r.success).map((r) => r.data as StoredPolicy);
  const day = isoDay(item.serviceDate);
  const line = parsed.find((l) => l.mappingId === item.mappingId && l.serviceDate === day) ?? (parsed.length === 1 ? parsed[0] : undefined);
  if (line) return { freeCancellationUntilUtc: line.freeCancellationUntilUtc, nonRefundableAfterConfirm: line.nonRefundableAfterConfirm };
  // The order item keeps a copy of the same two fields (checkout.service.ts).
  const copy = storedPolicySchema.safeParse(item.cancellationPolicySnapshot);
  return copy.success ? { freeCancellationUntilUtc: copy.data.freeCancellationUntilUtc, nonRefundableAfterConfirm: copy.data.nonRefundableAfterConfirm } : null;
}

async function issuesTicketsAtConfirm(db: Db, mappingId: string | null): Promise<Tristate> {
  if (!mappingId) return "unknown";
  const m = await db.productSupplierMapping.findUnique({ where: { id: mappingId }, select: { externalRef: true } });
  const ref = travelDeskExternalRefSchema.safeParse(m?.externalRef);
  return ref.success ? (ref.data.ticketEvidence?.issuesTicketsAtConfirm ?? "unknown") : "unknown";
}

/** R-B5-8: whether this booking already holds tickets (any stored code, or a valid ticket document). */
async function ticketsStored(db: Db, supplierBookingId: string | null): Promise<boolean> {
  if (!supplierBookingId) return false;
  const [codes, docs] = await Promise.all([
    db.supplierTicketCode.count({ where: { supplierBookingId } }),
    db.supplierDocument.count({ where: { supplierBookingId, kind: { in: ["ticket_codes", "tickets_pdf"] }, status: "valid" } }),
  ]);
  return codes > 0 || docs > 0;
}

/** Cancellation facts for every item of an order, keyed by order item id. */
export async function loadCancellationFacts(orderId: string, db: Db = prisma): Promise<Map<string, CancellationFacts>> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      rail: true,
      currency: true,
      status: true,
      items: { select: { id: true, fulfilmentOrigin: true, serviceDate: true, mappingId: true, quoteId: true, cancellationPolicySnapshot: true, chargedCurrency: true, chargedAmountMinor: true, discountAllocMinor: true, taxAllocMinor: true } },
      supplierBookings: { select: { id: true, orderItemId: true, state: true, bookingKind: true, startMinutes: true, mappingId: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] },
      paymentSaga: { select: { orderItemId: true, paymentId: true, state: true } },
      payments: { select: { capturedMinor: true } },
    },
  });
  const out = new Map<string, CancellationFacts>();
  if (!order) return out;
  const quoteIds = [...new Set(order.items.map((i) => i.quoteId).filter((q): q is string => Boolean(q)))];
  const quotes = quoteIds.length ? await db.quote.findMany({ where: { id: { in: quoteIds } }, select: { id: true, lines: true } }) : [];
  const sagaPayment = order.paymentSaga?.paymentId
    ? await db.payment.findUnique({ where: { id: order.paymentSaga.paymentId }, select: { id: true, source: true, provider: true, gatewayPaymentId: true, capturedMinor: true } })
    : null;
  const payment = sagaPayment
    ? {
        id: sagaPayment.id,
        captured: sagaPayment.capturedMinor > 0n,
        verified: sagaPayment.source === "gateway_verified" && Boolean(sagaPayment.provider && sagaPayment.gatewayPaymentId),
        refundableMinor: await refundableMinor(db, sagaPayment.id),
        frozen: sagaPayment.provider ? await refundsFrozen(db, sagaPayment.provider, sagaPayment.gatewayPaymentId) : false,
      }
    : null;
  const orderPaid = order.payments.some((p) => p.capturedMinor > 0n) || ["paid", "supplier_pending", "confirmed", "partially_confirmed", "completed"].includes(order.status);
  const instantItems = order.items.filter((i) => i.fulfilmentOrigin === "instant_checkout").length;
  const orderSettling = Boolean(order.paymentSaga && instantItems > 1 && order.paymentSaga.state !== "fulfilled");

  for (const item of order.items) {
    const booking = order.supplierBookings.find((b) => b.orderItemId === item.id) ?? null;
    const lines = quotes.find((q) => q.id === item.quoteId)?.lines;
    out.set(item.id, {
      orderItemId: item.id,
      rail: order.rail,
      fulfilmentOrigin: item.fulfilmentOrigin,
      serviceDate: isoDay(item.serviceDate),
      startMinutes: booking?.startMinutes ?? null,
      booking: booking ? { id: booking.id, state: booking.state, bookingKind: booking.bookingKind } : null,
      policy: policyFor(item, lines),
      issuesTicketsAtConfirm: await issuesTicketsAtConfirm(db, booking?.mappingId ?? item.mappingId),
      ticketsStored: await ticketsStored(db, booking?.id ?? null),
      currency: (item.chargedCurrency ?? order.currency) as Currency,
      payableMinor: itemPayableMinor(item),
      // The order's saga covers every instant item of the order (multi-item, lead-approved 3 Nov 2026).
      payment: order.paymentSaga && (order.paymentSaga.orderItemId === item.id || item.fulfilmentOrigin === "instant_checkout") ? payment : null,
      orderPaid,
      ...(orderSettling && item.fulfilmentOrigin === "instant_checkout" ? { orderSettling: true } : {}),
    });
  }
  return out;
}

/**
 * The payment of the saga that covers this order item: the order's one saga,
 * which names the first item and covers every instant item of the order
 * (multi-item, lead-approved 3 Nov 2026). Null for an assisted item.
 */
async function sagaPaymentForItem(db: Db, orderItemId: string): Promise<{ paymentId: string | null } | null> {
  const item = await db.orderItem.findUnique({ where: { id: orderItemId }, select: { orderId: true, fulfilmentOrigin: true } });
  if (!item) return null;
  const saga = await db.paymentSaga.findUnique({ where: { orderId: item.orderId }, select: { orderItemId: true, paymentId: true } });
  if (!saga || (saga.orderItemId !== orderItemId && item.fulfilmentOrigin !== "instant_checkout")) return null;
  return { paymentId: saga.paymentId };
}

/* ---------------------------------------------------------------------------
 * Staff close of a failed refund (R-B5-2)
 * ------------------------------------------------------------------------ */

/**
 * Whether money for this request's item is verifiably back with the customer
 * by a way other than the request's own refund: the provider's refunded total
 * beyond every Outly refund (a dashboard refund, `refundedOutsideOutlyMinor`)
 * plus the succeeded Outly refunds of the counted items that no uncounted
 * cancellation request names, covers the payable allocation of this item and
 * of every item of the order already closed as refunded (multi-item: one
 * outside sum is never counted once per item). Only provider-synced figures
 * count; a refund nobody can see at the provider (bank transfer, credit) is
 * not evidence here. Used by the privileged `close_refund_failed` resolution,
 * which moves no money. Pure read; pass the caller's transaction.
 */
/**
 * Checkout redesign batch 3 review: once every item of an order is refunded
 * (a `refunded` cancellation request) or rejected, the order is over and its
 * checkout grant (the guest browser's 24-hour download access) is revoked
 * (`order_cancelled`). Emailed links and recovery grants are kept, so the
 * customer can still follow the refund on the status page; the documents of
 * a released booking are hidden by the documents route anyway. Idempotent;
 * returns the number of grants revoked now.
 */
export async function revokeCheckoutAccessIfOrderEnded(db: Db, orderId: string, now: Date = new Date()): Promise<number> {
  const [items, refunded] = await Promise.all([
    db.orderItem.findMany({ where: { orderId }, select: { id: true, status: true } }),
    db.cancellationRequest.findMany({ where: { orderId, status: "refunded" }, select: { orderItemId: true } }),
  ]);
  const done = new Set(refunded.map((r) => r.orderItemId));
  if (!items.length || !items.every((i) => i.status === "rejected" || done.has(i.id))) return 0;
  return capabilityService.revokeAllForOrders(db, [orderId], "order_cancelled", now, { issuedFor: ["checkout"] });
}

export async function refundSettledElsewhere(db: Db, requestId: string): Promise<boolean> {
  const req = await db.cancellationRequest.findUnique({ where: { id: requestId }, select: { id: true, orderId: true, orderItemId: true } });
  if (!req) return false;
  const saga = await sagaPaymentForItem(db, req.orderItemId);
  if (!saga?.paymentId) return false;
  const payment = await db.payment.findUnique({ where: { id: saga.paymentId }, select: { currency: true } });
  if (!payment) return false;
  // Multi-item (review P2-2): the money seen at the provider beyond Outly's refunds is one sum for the whole payment.
  // It may settle this item only together with every item already closed as refunded: owed is the sum of their
  // allocations, and what is back is that outside money plus the succeeded refunds of those same items. One-item
  // orders reduce to the earlier rule.
  const closed = await db.cancellationRequest.findMany({
    where: { orderId: req.orderId, kind: "supported", status: "refunded", id: { not: req.id } },
    select: { id: true, orderItemId: true },
  });
  // Owed once per request (this one and each closed one), so an item cancelled twice is owed twice.
  const owedRequests = [{ id: req.id, orderItemId: req.orderItemId }, ...closed];
  const owedItems = [...new Set(owedRequests.map((r) => r.orderItemId))];
  let owed = 0n;
  for (const { orderItemId: id } of owedRequests) {
    const item = await db.orderItem.findUnique({
      where: { id },
      select: { chargedCurrency: true, chargedAmountMinor: true, discountAllocMinor: true, taxAllocMinor: true, order: { select: { currency: true } } },
    });
    const payable = item ? itemPayableMinor(item) : null;
    if (!item || payable === null || payable <= 0n || payment.currency !== (item.chargedCurrency ?? item.order.currency)) return false;
    owed += payable;
  }
  const outside = await refundedOutsideOutlyMinor(db, saga.paymentId);
  const ours = await db.refund.aggregate({
    where: {
      paymentId: saga.paymentId,
      orderItemId: { in: owedItems },
      status: "succeeded",
      // A refund another, uncounted request names is that request's money, never this one's.
      OR: [{ cancellationRequest: null }, { cancellationRequest: { id: { in: owedRequests.map((r) => r.id) } } }],
    },
    _sum: { amountMinor: true },
  });
  return outside + (ours._sum.amountMinor ?? 0n) >= owed;
}

/* ---------------------------------------------------------------------------
 * Requests
 * ------------------------------------------------------------------------ */

export type CancellationRequestResult =
  | { ok: true; status: CancellationRequestStatus; requestId: string; created: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_eligible"; ineligible: CancellationIneligibleReason };

export interface CancellationDeps {
  /** The engine's cancel intake (enqueues a cancel job; the worker sends it). */
  requestCancel(supplierBookingId: string): Promise<void>;
  /** Moves one refund as far as the provider allows now (the saga's refund driver); omitted: the payments tick drives it. */
  driveRefund?: (refundId: string) => Promise<string>;
  now(): Date;
}

const defaultDeps: CancellationDeps = {
  requestCancel: (id) => supplierBookingService.requestCancel(id),
  now: () => new Date(),
};

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_.:-]{1,40}$/.test(code)) return code;
  return error instanceof Error ? error.name : "unknown";
}

function eligibilitySnapshot(f: CancellationFacts, evaluation: CancellationEvaluation, now: Date): Prisma.InputJsonObject {
  // Policy facts only: no amount, no supplier figure, no supplier id.
  return {
    evaluatedAt: now.toISOString(),
    outcome: evaluation.kind === "eligible" ? "eligible" : evaluation.kind === "not_eligible" ? evaluation.reason : "none",
    freeCancellationUntilUtc: f.policy?.freeCancellationUntilUtc ?? null,
    nonRefundableAfterConfirm: f.policy?.nonRefundableAfterConfirm ?? null,
    issuesTicketsAtConfirm: f.issuesTicketsAtConfirm,
    ticketsStored: f.ticketsStored,
    serviceStartUtc: serviceStartUtc(f.serviceDate, f.startMinutes).toISOString(),
    bookingState: f.booking?.state ?? null,
  };
}

async function openRequestFor(orderItemId: string, db: Db = prisma) {
  return db.cancellationRequest.findFirst({ where: { orderItemId, closedAt: null }, select: { id: true, status: true } });
}

export function createCancellationService(overrides: Partial<CancellationDeps> = {}) {
  const deps: CancellationDeps = { ...defaultDeps, ...overrides };

  /** Asks the engine to cancel; on a refusal the request goes back to `requested` with attention, and `advanceOpen` retries. */
  async function sendCancel(requestId: string, supplierBookingId: string): Promise<CancellationRequestStatus> {
    const moved = await prisma.cancellationRequest.updateMany({ where: { id: requestId, status: "requested" }, data: { status: "cancelling" } });
    if (moved.count !== 1) return ((await prisma.cancellationRequest.findUnique({ where: { id: requestId }, select: { status: true } }))?.status ?? "requested") as CancellationRequestStatus;
    try {
      await deps.requestCancel(supplierBookingId);
      emitEvent("cancellation.sent", { requestId });
      return "cancelling";
    } catch (error) {
      await prisma.cancellationRequest.updateMany({ where: { id: requestId, status: "cancelling" }, data: { status: "requested", attentionRequiredAt: deps.now(), reasonCode: "engine_refused" } });
      emitEvent("cancellation.engine_refused", { requestId, reason: errorCode(error) }, "warn");
      return "requested";
    }
  }

  async function request(input: { orderId: string; orderItemId: string; kind: "cancel" | "exception"; via: "customer" | "guest" }): Promise<CancellationRequestResult> {
    const now = deps.now();
    const item = await prisma.orderItem.findFirst({ where: { id: input.orderItemId, orderId: input.orderId }, select: { id: true } });
    if (!item) return { ok: false, reason: "not_found" };

    const open = await openRequestFor(item.id);
    if (open) return { ok: true, status: open.status as CancellationRequestStatus, requestId: open.id, created: false };

    const facts = (await loadCancellationFacts(input.orderId)).get(item.id);
    if (!facts) return { ok: false, reason: "not_found" };
    const evaluation = evaluateCancellation(facts, now);

    if (input.kind === "cancel") {
      if (evaluation.kind !== "eligible") return { ok: false, reason: "not_eligible", ineligible: evaluation.kind === "not_eligible" ? evaluation.reason : "not_supported" };
    } else if (!(evaluation.kind === "eligible" || (evaluation.kind === "not_eligible" && evaluation.exceptionAllowed))) {
      return { ok: false, reason: "not_eligible", ineligible: evaluation.kind === "not_eligible" ? evaluation.reason : "not_supported" };
    }

    const supported = input.kind === "cancel";
    const id = uuidv7();
    // ON CONFLICT DO NOTHING on the one-open-request-per-item index: a double click or a second tab makes one row.
    const inserted = await prisma.cancellationRequest.createMany({
      data: [
        {
          id,
          orderId: input.orderId,
          orderItemId: item.id,
          supplierBookingId: facts.booking?.id ?? null,
          kind: supported ? "supported" : "exception",
          status: supported ? "requested" : "exception_open",
          requestedVia: input.via,
          eligibility: eligibilitySnapshot(facts, evaluation, now),
          reasonCode: supported ? null : evaluation.kind === "not_eligible" ? evaluation.reason : "customer_request",
          createdAt: now,
          updatedAt: now,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count !== 1) {
      // The other request won; answer with it.
      const other = await openRequestFor(item.id);
      if (other) return { ok: true, status: other.status as CancellationRequestStatus, requestId: other.id, created: false };
      throw new Error("cancellation request was neither inserted nor found");
    }
    emitEvent("cancellation.requested", { requestId: id, kind: supported ? "supported" : "exception", via: input.via });
    if (!supported) return { ok: true, status: "exception_open", requestId: id, created: true };
    const status = await sendCancel(id, facts.booking!.id);
    return { ok: true, status, requestId: id, created: true };
  }

  type Row = {
    id: string;
    orderId: string;
    orderItemId: string;
    supplierBookingId: string | null;
    status: string;
    refundId: string | null;
    attentionRequiredAt: Date | null;
    reasonCode: string | null;
    createdAt: Date;
    eligibility: unknown;
  };

  /**
   * R-B5-17: whether staff already cleared this very reason. Every automatic
   * flag below writes its reason code together with `attentionRequiredAt`, and
   * nothing but a privileged staff clear (ops-queue.service.ts) sets the flag
   * back to null while keeping the code. So an unflagged open request whose
   * code equals the reason found now was cleared by staff for that reason, and
   * the tick does not raise it again. A different reason (for example the
   * deadline coming close after a `cancel_stuck` clear) flags it again.
   */
  function clearedByStaff(row: Row, reason: string): boolean {
    return row.attentionRequiredAt === null && row.reasonCode === reason;
  }

  /** Flags an open request for staff with a reason code, unless already flagged or staff cleared that reason (R-B5-17). */
  async function flag(row: Row, reason: string, now: Date, where: Prisma.CancellationRequestWhereInput = {}): Promise<boolean> {
    if (row.attentionRequiredAt || clearedByStaff(row, reason)) return false;
    const r = await prisma.cancellationRequest.updateMany({
      where: { id: row.id, closedAt: null, attentionRequiredAt: null, ...where },
      data: { attentionRequiredAt: now, reasonCode: reason },
    });
    return r.count === 1;
  }

  /**
   * Why a request still waiting on the operator needs a human now, or null
   * (R-B5-1): close to the free-cancellation deadline or the activity start,
   * older than `CANCEL_STUCK_AFTER_MS`, or (booking still `confirmed`) no
   * cancel job queued or running for its booking, so nothing will send it.
   */
  async function stuckReason(row: Row, bookingState: string, now: Date): Promise<string | null> {
    const snap = (row.eligibility && typeof row.eligibility === "object" ? row.eligibility : {}) as { freeCancellationUntilUtc?: unknown; serviceStartUtc?: unknown };
    const deadlines = [snap.freeCancellationUntilUtc, snap.serviceStartUtc].map((v) => (typeof v === "string" ? Date.parse(v) : Number.NaN)).filter(Number.isFinite);
    if (deadlines.some((t) => t - now.getTime() <= CANCEL_DEADLINE_MARGIN_MS)) return "cancel_near_deadline";
    if (now.getTime() - row.createdAt.getTime() >= CANCEL_STUCK_AFTER_MS) return "cancel_stuck";
    if (bookingState === "confirmed" && row.supplierBookingId) {
      const job = await prisma.supplierJob.findFirst({ where: { supplierBookingId: row.supplierBookingId, kind: "cancel", status: { in: ["queued", "running"] } }, select: { id: true } });
      if (!job) return "cancel_job_missing";
    }
    return null;
  }

  async function escalateIfStuck(row: Row, bookingState: string): Promise<void> {
    if (row.attentionRequiredAt) return;
    const now = deps.now();
    const reason = await stuckReason(row, bookingState, now);
    if (!reason) return;
    if (await flag(row, reason, now, { status: { in: WAITING_ON_OPERATOR } })) emitEvent("cancellation.stuck", { requestId: row.id, reason }, "warn");
  }

  /**
   * Closes a request `refunded` and, in the same transaction, ends the order's
   * checkout download grant when that was its last open item (batch 3
   * review). A failure rolls both back, so the next tick redoes both. True
   * when this call closed it.
   */
  async function closeRefunded(row: Row, from: "refund_pending" | "refund_failed", now: Date): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const r = await tx.cancellationRequest.updateMany({ where: { id: row.id, status: from }, data: { status: "refunded", closedAt: now, updatedAt: now } });
      if (r.count) await revokeCheckoutAccessIfOrderEnded(tx, row.orderId, now);
      return r.count === 1;
    }, TX_OPTIONS);
  }

  /**
   * R-B5-2 (partial): a `refund_failed` request whose refund later succeeded
   * (the provider settled it after all) is closed `refunded`; otherwise it
   * keeps its attention for staff. No new money path: a refund made another
   * way is closed by the staff resolution `close_refund_failed`
   * (ops-queue.service.ts), which checks the provider's refunded total.
   */
  async function recheckFailed(row: Row): Promise<CancellationRequestStatus> {
    const now = deps.now();
    const refund = row.refundId ? await prisma.refund.findUnique({ where: { id: row.refundId }, select: { status: true } }) : null;
    if (refund?.status === "succeeded") {
      if (await closeRefunded(row, "refund_failed", now)) emitEvent("cancellation.refunded", { requestId: row.id });
      return "refunded";
    }
    // Still not settled. The write moves `updatedAt` past the refund's, so this row is read again only after its
    // refund changes once more (R-B5-18). The flag is raised unless staff cleared it (R-B5-17): attention set at the
    // failure is cleared only by staff, who already know.
    await prisma.cancellationRequest.updateMany({
      where: { id: row.id, status: "refund_failed", closedAt: null },
      data: row.attentionRequiredAt || row.reasonCode ? { updatedAt: now } : { updatedAt: now, attentionRequiredAt: now, reasonCode: "refund_failed" },
    });
    return "refund_failed";
  }

  /** Ends a supported request whose operator cancellation is verified: opens the item's refund in one transaction with the row. */
  async function openItemRefund(row: Row): Promise<CancellationRequestStatus> {
    const now = deps.now();
    const outcome = await prisma.$transaction(async (tx): Promise<{ refundId: string } | { refusal: string } | null> => {
      const [locked] = await tx.$queryRaw<{ status: string }[]>`SELECT "status" FROM "cancellation_requests" WHERE "id" = ${row.id}::uuid FOR UPDATE`;
      if (!locked || !["requested", "cancelling", "cancel_unverified"].includes(locked.status)) return null;
      const saga = await sagaPaymentForItem(tx, row.orderItemId);
      const item = await tx.orderItem.findUniqueOrThrow({
        where: { id: row.orderItemId },
        select: { chargedCurrency: true, chargedAmountMinor: true, discountAllocMinor: true, taxAllocMinor: true, order: { select: { currency: true } } },
      });
      const amount = itemPayableMinor(item);
      let result: { refundId: string } | { refusal: string };
      if (!saga?.paymentId || amount === null || amount <= 0n) {
        result = { refusal: "refund_payment_not_refundable" };
      } else {
        try {
          const opened = await openRefund(tx, {
            paymentId: saga.paymentId,
            orderId: row.orderId,
            orderItemId: row.orderItemId,
            kind: "refund",
            reason: "customer_cancellation",
            amountMinor: amount,
            currency: item.chargedCurrency ?? item.order.currency,
            supplierBookingId: row.supplierBookingId,
            outlyFunded: false,
          });
          result = { refundId: opened.refundId };
        } catch (e) {
          if (!(e instanceof RefundRefused)) throw e;
          result = { refusal: `refund_${e.reason}` };
        }
      }
      if ("refundId" in result) {
        await tx.cancellationRequest.update({ where: { id: row.id }, data: { status: "refund_pending", refundId: result.refundId, updatedAt: now } });
      } else {
        await tx.cancellationRequest.update({ where: { id: row.id }, data: { status: "refund_failed", reasonCode: result.refusal, attentionRequiredAt: row.attentionRequiredAt ?? now, updatedAt: now } });
      }
      return result;
    }, TX_OPTIONS);
    if (!outcome) return ((await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: row.id }, select: { status: true } })).status as CancellationRequestStatus);
    if ("refusal" in outcome) {
      emitEvent("cancellation.refund_refused", { requestId: row.id, reason: outcome.refusal }, "error");
      return "refund_failed";
    }
    emitEvent("cancellation.refund_opened", { requestId: row.id, refundId: outcome.refundId });
    return followRefund({ ...row, status: "refund_pending", refundId: outcome.refundId });
  }

  async function followRefund(row: Row): Promise<CancellationRequestStatus> {
    if (!row.refundId) return row.status as CancellationRequestStatus;
    let status = (await prisma.refund.findUnique({ where: { id: row.refundId }, select: { status: true } }))?.status ?? "missing";
    if (deps.driveRefund && status !== "succeeded" && status !== "failed") status = await deps.driveRefund(row.refundId);
    const now = deps.now();
    if (status === "succeeded") {
      if (await closeRefunded(row, "refund_pending", now)) emitEvent("cancellation.refunded", { requestId: row.id });
      return "refunded";
    }
    if (status === "failed" || status === "missing") {
      const r = await prisma.cancellationRequest.updateMany({ where: { id: row.id, status: "refund_pending" }, data: { status: "refund_failed", reasonCode: "refund_failed", attentionRequiredAt: row.attentionRequiredAt ?? now, updatedAt: now } });
      if (r.count) emitEvent("cancellation.refund_failed", { requestId: row.id }, "error");
      return "refund_failed";
    }
    return "refund_pending";
  }

  /** Moves one open supported request as far as the engine and the refund allow now; flags it when it is stuck. */
  async function advance(row: Row): Promise<CancellationRequestStatus> {
    if (row.status === "refund_pending") return followRefund(row);
    if (row.status === "refund_failed") return recheckFailed(row);
    if (!row.supplierBookingId) return row.status as CancellationRequestStatus;
    const booking = await prisma.supplierBooking.findUnique({ where: { id: row.supplierBookingId }, select: { state: true } });
    const state = booking?.state ?? "missing";
    const to = await step(row, state);
    if (WAITING_ON_OPERATOR.includes(to)) await escalateIfStuck(row, state);
    return to;
  }

  async function step(row: Row, state: string): Promise<CancellationRequestStatus> {
    const now = deps.now();
    const set = async (to: CancellationRequestStatus, extra: Prisma.CancellationRequestUpdateManyMutationInput = {}) => {
      if (to === row.status && !Object.keys(extra).length) return to;
      await prisma.cancellationRequest.updateMany({ where: { id: row.id, status: row.status }, data: { status: to, updatedAt: now, ...extra } });
      return to;
    };

    if (state === "cancelled") return openItemRefund(row);
    if (state === "cancel_refused") {
      const to = await set("refused", { reasonCode: "cancel_refused", closedAt: now });
      emitEvent("cancellation.refused", { requestId: row.id });
      return to;
    }
    if (row.status === "requested") {
      // Not sent yet (the engine refused the first intake): try again while the booking can still be cancelled.
      if (state === "confirmed") return sendCancel(row.id, row.supplierBookingId!);
      if (state === "cancelling" || state === "cancel_unverified") return set(state);
      return row.status as CancellationRequestStatus;
    }
    if (state === "cancel_unverified") return set("cancel_unverified");
    if (state === "outcome_unknown" || state === "not_found_unresolved") {
      // The engine is recovering an unknown cancel; staff are told (unless they cleared it, R-B5-17), the customer sees processing.
      const to = await set("cancel_unverified");
      await flag({ ...row, status: to }, "cancel_outcome_unknown", now);
      return to;
    }
    if (state === "cancelling") return set("cancelling");
    // The cancel job has not run yet, or was not sent and is queued again.
    if (state === "confirmed") return row.status as CancellationRequestStatus;
    // Any other state (manual review, a vanished row) is for a human.
    await flag(row, "cancel_needs_review", now, { status: row.status });
    return row.status as CancellationRequestStatus;
  }

  /**
   * The progress step, run from the payments tick: the oldest open supported
   * requests first, then (in their own budget, so they never crowd out live
   * requests) the `refund_failed` ones that name a refund (R-B5-2) whose
   * refund changed since the request was last written (R-B5-18). A refund
   * that stays failed is not read again, so permanently failed rows never
   * use the budget or hide newer ones; a refund the provider later settles
   * (or any other change to it) brings its request back.
   */
  async function advanceOpen(opts: { max?: number; stop?: () => boolean } = {}): Promise<{ visited: number; refunded: number; refused: number; failed: number }> {
    const select = { id: true, orderId: true, orderItemId: true, supplierBookingId: true, status: true, refundId: true, attentionRequiredAt: true, reasonCode: true, createdAt: true, eligibility: true } as const;
    const take = opts.max ?? 50;
    const live = await prisma.cancellationRequest.findMany({ where: { kind: "supported", status: { in: OPEN_SUPPORTED } }, orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take, select });
    const changed = await prisma.$queryRaw<{ id: string }[]>`
      SELECT c."id" FROM "cancellation_requests" c JOIN "refunds" r ON r."id" = c."refund_id"
      WHERE c."kind" = 'supported' AND c."status" = 'refund_failed' AND c."closed_at" IS NULL AND r."updated_at" > c."updated_at"
      ORDER BY c."updated_at" ASC, c."id" ASC LIMIT ${take}`;
    const failed = changed.length
      ? await prisma.cancellationRequest.findMany({ where: { id: { in: changed.map((c) => c.id) }, status: "refund_failed" }, orderBy: [{ updatedAt: "asc" }, { id: "asc" }], select })
      : [];
    const rows = [...live, ...failed];
    // `visited` counts the requests actually started (a time cap can stop early).
    const summary = { visited: 0, refunded: 0, refused: 0, failed: 0 };
    for (const row of rows) {
      // A time cap (the booking tick, review fix 1): no new request is started once it says so.
      if (opts.stop?.()) break;
      summary.visited++;
      try {
        const to = await advance(row);
        if (to === "refunded") summary.refunded++;
        else if (to === "refused") summary.refused++;
        else if (to === "refund_failed") summary.failed++;
      } catch (error) {
        // A code only: a database error message can quote row values (PRV-6).
        emitEvent("cancellation.advance_failed", { requestId: row.id, reason: errorCode(error) }, "error");
      }
    }
    return summary;
  }

  return { request, advance, advanceOpen };
}

export type CancellationService = ReturnType<typeof createCancellationService>;

export const cancellationService: CancellationService = createCancellationService();
