import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db";
import type { PaymentEvidence, PaymentEvidencePort } from "../suppliers/booking-port";
import { MULTI_ITEM_CONFIRM_STATES } from "./contracts";

/**
 * Payment evidence for the supplier engine (doc 22 PAY-1, PAY-9; contract in
 * src/server/suppliers/booking-port.ts).
 *
 * `capturedFor(orderItemId)` answers one question: has a payment provider
 * verified a capture that covers this order item? It returns evidence only
 * when every rule below holds, and null otherwise; the engine never infers
 * payment, so null is always the safe answer.
 *
 *  - the item is `instant_checkout`: no other origin may ever reach a supplier
 *    confirm (PRD-3);
 *  - the payment is the one bound to this item by its payment saga
 *    (`payment_sagas.order_item_id` and `payment_id`, B3), so a payment on the
 *    same order that the saga did not bind (a duplicate, a manual row) never
 *    counts. The saga must be in a state that still intends to confirm
 *    (`EVIDENCE_SAGA_STATES`) and carry no attention flag: once it releases,
 *    refunds or waits for a human, evidence disappears, and the engine's
 *    re-read right before the confirm send refuses (PAY-2);
 *  - `source = 'gateway_verified'` and `status = 'captured'`, with a provider
 *    payment id and a capture time. Manual rows (`source = 'manual'`, written
 *    by `orderService.recordManualPayment`) never count, whatever their
 *    gateway, status or amount;
 *  - the currency is the item's charged currency (the order's for rows
 *    written before B2);
 *  - the payment's captured amount, less what the provider has refunded,
 *    covers the item's allocation (charged amount less its discount share
 *    plus its tax share; the order's charged total for a single-item order
 *    written before B2), and no refund on it is open or done (any refund row
 *    that has not failed). Partial payments are never summed.
 *  - an order with several items follows `multiItemEvidence` below instead of
 *    the last rule (multi-item, lead-approved 3 Nov 2026).
 */

/** Saga states in which a confirm may still follow (src/server/payments/saga.ts). */
export const EVIDENCE_SAGA_STATES = ["captured", "reserve_pending", "reserved", "confirm_pending", "fulfilled"] as const;

const sagaSelect = {
  id: true,
  orderId: true,
  orderItemId: true,
  state: true,
  attentionRequiredAt: true,
  payment: {
    select: {
      id: true,
      orderId: true,
      gateway: true,
      provider: true,
      gatewayPaymentId: true,
      source: true,
      status: true,
      currency: true,
      amountMinor: true,
      capturedMinor: true,
      refundedMinor: true,
      capturedAt: true,
      // The query narrows; `evidenceFrom` re-checks every rule on what it gets.
      refunds: { where: { status: { not: "failed" } }, select: { id: true, orderItemId: true, amountMinor: true, status: true } },
    },
  },
} satisfies Prisma.PaymentSagaSelect;

const allocationSelect = { id: true, fulfilmentOrigin: true, chargedCurrency: true, chargedAmountMinor: true, discountAllocMinor: true, taxAllocMinor: true } satisfies Prisma.OrderItemSelect;

const evidenceSelect = {
  ...allocationSelect,
  order: {
    select: {
      id: true,
      currency: true,
      totalInr: true,
      totalAed: true,
      items: { select: allocationSelect },
      // Multi-item, lead-approved 3 Nov 2026: the order's one saga covers every item, not only the one it names.
      paymentSaga: { select: sagaSelect },
    },
  },
  paymentSagas: { select: sagaSelect },
} satisfies Prisma.OrderItemSelect;

export type EvidenceItemRow = Prisma.OrderItemGetPayload<{ select: typeof evidenceSelect }>;
type AllocationRow = Prisma.OrderItemGetPayload<{ select: typeof allocationSelect }>;
type SagaRow = Prisma.PaymentSagaGetPayload<{ select: typeof sagaSelect }>;

/** An item's allocation from its own B2 columns, or null when it has none. */
function ownAllocation(item: AllocationRow): { currency: "INR" | "AED"; minor: bigint } | null {
  if (item.chargedAmountMinor === null || item.chargedCurrency === null) return null;
  return { currency: item.chargedCurrency, minor: item.chargedAmountMinor - (item.discountAllocMinor ?? 0n) + (item.taxAllocMinor ?? 0n) };
}

/** The item's allocation in its charged currency, or null when it cannot be stated exactly. */
function allocationOf(item: EvidenceItemRow): { currency: "INR" | "AED"; minor: bigint } | null {
  const order = item.order;
  const own = ownAllocation(item);
  if (own) return own;
  // Rows written before B2: the whole order total, so the item must be the whole order.
  if (order.items.length !== 1 || order.items[0].id !== item.id) return null;
  if (order.currency !== "INR" && order.currency !== "AED") return null;
  return { currency: order.currency, minor: order.currency === "AED" ? order.totalAed : order.totalInr };
}

/** The sagas that may back this item: the one naming it, and the order's saga when the order has several items. */
function sagasFor(item: EvidenceItemRow): SagaRow[] {
  const sagas = [...item.paymentSagas];
  const orderSaga = item.order.paymentSaga;
  if (orderSaga && !sagas.some((s) => s.id === orderSaga.id)) sagas.push(orderSaga);
  return sagas;
}

/**
 * Multi-item orders (lead design, 3 November 2026). On top of the rules for
 * one item, all of these hold:
 *  - every item of the order is `instant_checkout` with its own allocation in
 *    the payment's currency, and the payment's amount is exactly their sum;
 *  - the saga is in `MULTI_ITEM_CONFIRM_STATES`: every item was reserved and
 *    the whole amount captured first (all or nothing until the capture);
 *  - no refund row on this payment for THIS item has been opened or done
 *    (any that has not failed). Refunds of other items are allowed: the
 *    payment may then read `partially_refunded`;
 *  - what is left of the capture after every refund (the cap's own rule,
 *    GREATEST(provider-refunded, succeeded) + open) still covers the
 *    allocation of every item with no refund. A refund made outside Outly
 *    therefore withdraws the evidence (and flags the saga, CR-B3-16).
 */
function multiItemEvidence(item: EvidenceItemRow, allocation: { currency: "INR" | "AED"; minor: bigint }, saga: SagaRow): boolean {
  const p = saga.payment!;
  if (!(MULTI_ITEM_CONFIRM_STATES as readonly string[]).includes(saga.state)) return false;
  if (p.status !== "captured" && p.status !== "partially_refunded") return false;
  const allocations = new Map<string, bigint>();
  for (const i of item.order.items) {
    const a = ownAllocation(i);
    if (i.fulfilmentOrigin !== "instant_checkout" || !a || a.currency !== allocation.currency || a.minor <= 0n) return false;
    allocations.set(i.id, a.minor);
  }
  const total = [...allocations.values()].reduce((s, m) => s + m, 0n);
  if (p.amountMinor !== total || !allocations.has(item.id)) return false;
  if (p.refunds.some((r) => r.orderItemId === item.id)) return false;
  const succeeded = p.refunds.filter((r) => r.status === "succeeded").reduce((s, r) => s + r.amountMinor, 0n);
  const open = p.refunds.filter((r) => r.status !== "succeeded").reduce((s, r) => s + r.amountMinor, 0n);
  const committed = (p.refundedMinor > succeeded ? p.refundedMinor : succeeded) + open;
  const refundedItems = new Set(p.refunds.map((r) => r.orderItemId));
  const live = [...allocations.entries()].filter(([id]) => !refundedItems.has(id)).reduce((s, [, m]) => s + m, 0n);
  return p.capturedMinor - committed >= live;
}

/** The rules above, on rows already read. Exported for the unit tests. */
export function evidenceFrom(item: EvidenceItemRow): PaymentEvidence | null {
  if (item.fulfilmentOrigin !== "instant_checkout") return null;
  const allocation = allocationOf(item);
  if (!allocation || allocation.minor <= 0n) return null;
  const multi = item.order.items.length > 1;

  for (const saga of sagasFor(item)) {
    if (saga.orderId !== item.order.id || saga.attentionRequiredAt) continue;
    const p = saga.payment;
    if (!p || p.orderId !== item.order.id) continue;
    if (p.source !== "gateway_verified") continue;
    if (p.gateway === "manual" || !p.provider || !p.gatewayPaymentId || !p.capturedAt) continue;
    if (p.currency !== allocation.currency) continue;
    if (multi) {
      if (!multiItemEvidence(item, allocation, saga)) continue;
    } else {
      // One item: the saga names it, and the payment is untouched by any refund.
      if (saga.orderItemId !== item.id) continue;
      if (!(EVIDENCE_SAGA_STATES as readonly string[]).includes(saga.state)) continue;
      if (p.status !== "captured" || p.refunds.length > 0) continue;
      if (p.amountMinor < allocation.minor || p.capturedMinor - p.refundedMinor < allocation.minor) continue;
    }
    return {
      orderItemId: item.id,
      paymentId: p.id,
      provider: p.provider,
      providerPaymentId: p.gatewayPaymentId,
      currency: allocation.currency,
      // What this payment covers for the item: its allocation, never more.
      capturedMinor: allocation.minor,
      verifiedAt: p.capturedAt,
    };
  }
  return null;
}

type EvidenceDb = { orderItem: Pick<Prisma.TransactionClient["orderItem"], "findUnique"> };

/** A port over the given client; tests pass a transaction so their rows can be rolled back. */
export function paymentEvidenceFrom(db: EvidenceDb): PaymentEvidencePort {
  return {
    async capturedFor(orderItemId: string) {
      const item = await db.orderItem.findUnique({ where: { id: orderItemId }, select: evidenceSelect });
      return item ? evidenceFrom(item) : null;
    },
  };
}

/** The production port; the engine takes it as `EngineDeps.payments` (B3). */
export const dbPaymentEvidence: PaymentEvidencePort = paymentEvidenceFrom(prisma);
