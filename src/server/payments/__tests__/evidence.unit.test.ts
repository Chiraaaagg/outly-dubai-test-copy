import { describe, expect, it, vi } from "vitest";
import { EVIDENCE_SAGA_STATES, evidenceFrom, paymentEvidenceFrom } from "../evidence";

/**
 * Pure rules of src/server/payments/evidence.ts. The database module is
 * replaced, so nothing here opens a connection; the same rules run against
 * Postgres in evidence.test.ts (db project).
 */

vi.mock("../../lib/db", () => ({ prisma: { orderItem: { findUnique: vi.fn(async () => null) } } }));

type Row = Parameters<typeof evidenceFrom>[0];
type SagaRow = Row["paymentSagas"][number];
type PaymentRow = NonNullable<SagaRow["payment"]>;

const CAPTURED_AT = new Date("2030-01-10T08:00:00Z");

/** Synthetic amounts only. */
function payment(over: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: "pay-1",
    orderId: "order-1",
    gateway: "fake-aed-card",
    provider: "fake-aed-card",
    gatewayPaymentId: "fp_1",
    source: "gateway_verified",
    status: "captured",
    currency: "AED",
    amountMinor: 10_000n,
    capturedMinor: 10_000n,
    refundedMinor: 0n,
    capturedAt: CAPTURED_AT,
    refunds: [],
    ...over,
  };
}

function saga(over: Partial<SagaRow> = {}, pay: Partial<PaymentRow> = {}): SagaRow {
  return { id: "saga-1", orderId: "order-1", orderItemId: "item-1", state: "confirm_pending", attentionRequiredAt: null, payment: payment(pay), ...over };
}

type ItemAlloc = Row["order"]["items"][number];

function alloc(id: string, over: Partial<ItemAlloc> = {}): ItemAlloc {
  return { id, fulfilmentOrigin: "instant_checkout", chargedCurrency: "AED", chargedAmountMinor: 11_000n, discountAllocMinor: 1_500n, taxAllocMinor: 500n, ...over };
}

function row(over: { item?: Partial<Omit<Row, "order" | "paymentSagas">>; order?: Partial<Row["order"]>; sagas?: SagaRow[] } = {}): Row {
  const item = { ...alloc("item-1"), ...over.item };
  return {
    ...item,
    order: { id: "order-1", currency: "AED", totalInr: 0n, totalAed: 10_000n, items: [item], paymentSaga: null, ...over.order },
    paymentSagas: over.sagas ?? [saga()],
  };
}

describe("evidenceFrom", () => {
  it("returns evidence for the saga's verified capture covering the item allocation", () => {
    expect(evidenceFrom(row())).toEqual({
      orderItemId: "item-1",
      paymentId: "pay-1",
      provider: "fake-aed-card",
      providerPaymentId: "fp_1",
      currency: "AED",
      // 11_000 charged − 1_500 discount + 500 tax.
      capturedMinor: 10_000n,
      verifiedAt: CAPTURED_AT,
    });
  });

  it("uses the order's charged total for a single-item row written before allocations", () => {
    const ev = evidenceFrom(
      row({ item: { chargedCurrency: null, chargedAmountMinor: null, discountAllocMinor: null, taxAllocMinor: null }, order: { currency: "INR", totalInr: 230_000n }, sagas: [saga({}, { currency: "INR", amountMinor: 230_000n, capturedMinor: 230_000n })] }),
    );
    expect(ev).toMatchObject({ currency: "INR", capturedMinor: 230_000n });
  });

  it("caps the evidence at the allocation when more was captured", () => {
    expect(evidenceFrom(row({ sagas: [saga({}, { amountMinor: 12_000n, capturedMinor: 12_000n })] }))?.capturedMinor).toBe(10_000n);
  });

  it.each(EVIDENCE_SAGA_STATES)("counts while the saga is %s", (state) => {
    expect(evidenceFrom(row({ sagas: [saga({ state })] }))).not.toBeNull();
  });

  it.each(["session_created", "authorized", "capture_unknown", "release_pending", "released", "refund_pending", "refunded", "failed", "attention"])("never counts while the saga is %s", (state) => {
    expect(evidenceFrom(row({ sagas: [saga({ state })] }))).toBeNull();
  });

  it("never counts a saga flagged for a human (dispute, deadline)", () => {
    expect(evidenceFrom(row({ sagas: [saga({ attentionRequiredAt: new Date() })] }))).toBeNull();
  });

  it("needs the payment bound by the saga: no saga, no evidence", () => {
    expect(evidenceFrom(row({ sagas: [] }))).toBeNull();
    expect(evidenceFrom(row({ sagas: [{ ...saga(), payment: null }] }))).toBeNull();
    expect(evidenceFrom(row({ sagas: [saga({ orderId: "order-2" })] }))).toBeNull();
    expect(evidenceFrom(row({ sagas: [saga({}, { orderId: "order-2" })] }))).toBeNull();
  });

  it("never counts a manual payment, whatever it claims", () => {
    expect(evidenceFrom(row({ sagas: [saga({}, { source: "manual" })] }))).toBeNull();
    expect(evidenceFrom(row({ sagas: [saga({}, { gateway: "manual" })] }))).toBeNull();
  });

  it.each(["created", "authorized", "capture_unknown", "failed", "refunded", "partially_refunded", "voided", "expired"] as const)("ignores a %s payment", (status) => {
    expect(evidenceFrom(row({ sagas: [saga({}, { status })] }))).toBeNull();
  });

  it("needs a provider, a provider payment id and a capture time", () => {
    expect(evidenceFrom(row({ sagas: [saga({}, { gatewayPaymentId: null })] }))).toBeNull();
    expect(evidenceFrom(row({ sagas: [saga({}, { provider: null })] }))).toBeNull();
    expect(evidenceFrom(row({ sagas: [saga({}, { capturedAt: null })] }))).toBeNull();
  });

  it("refuses another currency, even at a larger amount", () => {
    expect(evidenceFrom(row({ sagas: [saga({}, { currency: "INR", amountMinor: 999_999n, capturedMinor: 999_999n })] }))).toBeNull();
  });

  it("refuses a capture below the allocation, a provider refund, or any refund row that has not failed", () => {
    expect(evidenceFrom(row({ sagas: [saga({}, { capturedMinor: 9_999n })] }))).toBeNull();
    expect(evidenceFrom(row({ sagas: [saga({}, { refundedMinor: 1n })] }))).toBeNull();
    expect(evidenceFrom(row({ sagas: [saga({}, { refunds: [{ id: "r1", orderItemId: "item-1", amountMinor: 1n, status: "requested" }] })] }))).toBeNull();
    expect(evidenceFrom(row({ sagas: [saga({}, { amountMinor: 9_999n, capturedMinor: 9_999n })] }))).toBeNull();
  });

  it("refuses an assisted item and a zero allocation", () => {
    expect(evidenceFrom(row({ item: { fulfilmentOrigin: "assisted_conversion" } }))).toBeNull();
    expect(evidenceFrom(row({ item: { chargedAmountMinor: 1_000n, discountAllocMinor: 1_000n, taxAllocMinor: 0n } }))).toBeNull();
  });

  it("refuses a multi-item order without per-item allocations", () => {
    expect(evidenceFrom(row({ item: { chargedCurrency: null, chargedAmountMinor: null }, order: { items: [alloc("item-1", { chargedCurrency: null, chargedAmountMinor: null }), alloc("item-2")] } }))).toBeNull();
  });

  it("never counts a saga that names another item of a one-item view", () => {
    expect(evidenceFrom(row({ sagas: [saga({ orderItemId: "item-9" })] }))).toBeNull();
  });
});

describe("evidenceFrom, multi-item orders (lead design, 3 November 2026)", () => {
  // Three items of 10_000 each; one payment of 30_000 bound by the order's saga, which names item-1.
  const items = [alloc("item-1"), alloc("item-2"), alloc("item-3")];
  type Refund = PaymentRow["refunds"][number];
  function multi(id: string, sagaOver: Partial<SagaRow> = {}, pay: Partial<PaymentRow> = {}, orderItems: ItemAlloc[] = items): Row {
    const s = saga(sagaOver, { amountMinor: 30_000n, capturedMinor: 30_000n, ...pay });
    const item = orderItems.find((i) => i.id === id) ?? alloc(id);
    return { ...item, order: { id: "order-1", currency: "AED", totalInr: 0n, totalAed: 30_000n, items: orderItems, paymentSaga: s }, paymentSagas: id === s.orderItemId ? [s] : [] };
  }
  const refund = (orderItemId: string, status = "succeeded", amountMinor = 10_000n): Refund => ({ id: `r-${orderItemId}`, orderItemId, amountMinor, status });

  it("every item is backed by the order's saga, each for its own allocation", () => {
    for (const id of ["item-1", "item-2", "item-3"]) expect(evidenceFrom(multi(id))).toMatchObject({ orderItemId: id, paymentId: "pay-1", capturedMinor: 10_000n });
  });

  it.each(["captured", "reserve_pending", "reserved"])("never before every item is reserved and captured: not while the saga is %s", (state) => {
    for (const id of ["item-1", "item-2"]) expect(evidenceFrom(multi(id, { state }))).toBeNull();
  });

  it("counts in fulfilled too, and never with a human flag", () => {
    expect(evidenceFrom(multi("item-2", { state: "fulfilled" }))).not.toBeNull();
    expect(evidenceFrom(multi("item-2", { attentionRequiredAt: new Date() }))).toBeNull();
  });

  it("another item's refund leaves this item's evidence; its own refund removes it", () => {
    const refunds = [refund("item-2")];
    const pay = { status: "partially_refunded" as const, refundedMinor: 10_000n, refunds };
    expect(evidenceFrom(multi("item-1", {}, pay))).not.toBeNull();
    expect(evidenceFrom(multi("item-3", {}, pay))).not.toBeNull();
    expect(evidenceFrom(multi("item-2", {}, pay))).toBeNull();
    // An open refund of another item counts against the capture as well.
    expect(evidenceFrom(multi("item-1", {}, { refunds: [refund("item-2", "requested")] }))).not.toBeNull();
  });

  it("a refund outside Outly that eats into the live items' money removes the evidence", () => {
    expect(evidenceFrom(multi("item-1", {}, { status: "partially_refunded", refundedMinor: 1n }))).toBeNull();
    expect(evidenceFrom(multi("item-1", {}, { status: "partially_refunded", refundedMinor: 10_001n, refunds: [refund("item-2")] }))).toBeNull();
  });

  it("refuses a payment that is not exactly the sum of the allocations, a partial capture, or a foreign item", () => {
    expect(evidenceFrom(multi("item-1", {}, { amountMinor: 30_001n, capturedMinor: 30_001n }))).toBeNull();
    expect(evidenceFrom(multi("item-1", {}, { capturedMinor: 29_999n }))).toBeNull();
    expect(evidenceFrom(multi("item-1", {}, {}, [alloc("item-1"), alloc("item-2", { fulfilmentOrigin: "assisted_conversion" }), alloc("item-3")]))).toBeNull();
    expect(evidenceFrom(multi("item-1", {}, {}, [alloc("item-1"), alloc("item-2", { chargedCurrency: "INR" }), alloc("item-3")]))).toBeNull();
  });
});

describe("paymentEvidenceFrom", () => {
  it("returns null for an unknown order item", async () => {
    const port = paymentEvidenceFrom({ orderItem: { findUnique: vi.fn(async () => null) } as never });
    expect(await port.capturedFor("missing")).toBeNull();
  });

  it("reads the item through the given client and applies the rules", async () => {
    const findUnique = vi.fn(async () => row());
    const port = paymentEvidenceFrom({ orderItem: { findUnique } as never });
    expect(await port.capturedFor("item-1")).toMatchObject({ paymentId: "pay-1" });
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "item-1" } }));
  });
});
