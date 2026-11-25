import { describe, expect, it, vi } from "vitest";

/**
 * The engine's payment gates as pure rules (B3): the confirm deadline it
 * shares with the payment saga (`confirmSendByOnDbClock`,
 * `pastConfirmSendBy`, CR-B3 P2) and what backs a reserve on the scheduled
 * run (`reserveBackedBy`, CR-B3-5). The database module is replaced, so
 * nothing opens a connection; the same rules on Postgres are in
 * supplier-booking.service.test.ts. Synthetic ids and amounts only.
 */

vi.mock("../../lib/db", () => ({ prisma: {}, TX_OPTIONS: {} }));

const { confirmSendByOnDbClock, pastConfirmSendBy, reserveBackedBy } = await import("../supplier-booking.service");
type Row = Parameters<typeof reserveBackedBy>[1][number];

const ORDER = "0190a000-0000-7000-8000-000000000001";
const ITEM = "0190a000-0000-7000-8000-000000000002";
const T = Date.parse("2030-01-06T08:00:00Z");
const at = new Date(T);

describe("confirm send-by (CR-B3 P2)", () => {
  const b = { reservationDeadline: new Date(T + 15 * 60_000) };

  it("is the deadline less the confirm budget, moved onto the database clock by the reserving worker's skew", () => {
    // Budget: max(5 min, mutation timeout + 60 s).
    expect(confirmSendByOnDbClock(b, { mutationTimeoutMs: 1_000 }, null)).toEqual({ at: new Date(T + 10 * 60_000), dbClock: false });
    expect(confirmSendByOnDbClock(b, { mutationTimeoutMs: 600_000 }, null)).toEqual({ at: new Date(T + 4 * 60_000), dbClock: false });
    // A worker 90 s ahead of the database stamped a deadline 90 s late in database terms.
    expect(confirmSendByOnDbClock(b, { mutationTimeoutMs: 1_000 }, 90_000)).toEqual({ at: new Date(T + 10 * 60_000 - 90_000), dbClock: true });
    expect(confirmSendByOnDbClock({ reservationDeadline: null }, { mutationTimeoutMs: 1_000 }, 0)).toBeNull();
  });

  it("refuses an unknown deadline, a late worker clock, and a late database clock once the skew is known", () => {
    const deps = { mutationTimeoutMs: 1_000 };
    const sendBy = T + 10 * 60_000;
    expect(pastConfirmSendBy({ reservationDeadline: null }, deps, 0, at, at)).toBe(true);
    expect(pastConfirmSendBy(b, deps, null, new Date(sendBy), new Date(sendBy + 3_600_000))).toBe(false);
    expect(pastConfirmSendBy(b, deps, null, new Date(sendBy + 1), at)).toBe(true);
    expect(pastConfirmSendBy(b, deps, 0, new Date(sendBy), new Date(sendBy))).toBe(false);
    expect(pastConfirmSendBy(b, deps, 0, at, new Date(sendBy + 1))).toBe(true);
    // A slow worker (its clock behind) is caught by the database clock.
    expect(pastConfirmSendBy(b, deps, 120_000, new Date(sendBy - 120_000), new Date(sendBy - 119_000))).toBe(true);
  });
});

describe("what backs a reserve on the scheduled run (CR-B3-5)", () => {
  const target = { orderId: ORDER, orderItemId: ITEM };

  function captured(over: Partial<NonNullable<Row["payment"]>> = {}): NonNullable<Row["payment"]> {
    return {
      orderId: ORDER,
      gateway: "fake-inr-pacb",
      provider: "fake-inr-pacb",
      gatewayPaymentId: "fp_1",
      source: "gateway_verified",
      status: "captured",
      amountMinor: 1000n,
      capturedMinor: 1000n,
      refundedMinor: 0n,
      capturedAt: at,
      authorizedAt: at,
      authorizationExpiresAt: null,
      threeDs: "not_applicable",
      risk: "normal",
      refunds: [],
      ...over,
    };
  }

  function hold(over: Partial<NonNullable<Row["payment"]>> = {}) {
    return captured({ status: "authorized", capturedMinor: 0n, capturedAt: null, threeDs: "passed", authorizationExpiresAt: new Date(T + 7 * 86_400_000), ...over });
  }

  function saga(payment: Row["payment"], over: Partial<Row> = {}): Row {
    return { orderId: ORDER, orderItemId: ITEM, state: "reserve_pending", attentionRequiredAt: null, order: { items: [{ id: ITEM, fulfilmentOrigin: "instant_checkout" }] }, payment, ...over };
  }

  it("multi-item: a later instant item of the saga's order is backed by the saga that names the first item", () => {
    const items = [
      { id: "first", fulfilmentOrigin: "instant_checkout" },
      { id: ITEM, fulfilmentOrigin: "instant_checkout" },
    ];
    expect(reserveBackedBy(target, [saga(hold(), { orderItemId: "first", order: { items } })], at)).toBe(true);
    // Not an instant item, or not on the saga's order at all: nothing backs it.
    expect(reserveBackedBy(target, [saga(hold(), { orderItemId: "first", order: { items: [items[0], { id: ITEM, fulfilmentOrigin: "assisted_conversion" }] } })], at)).toBe(false);
    expect(reserveBackedBy(target, [saga(hold(), { orderItemId: "first", order: { items: [items[0]] } })], at)).toBe(false);
  });

  it("a provider-verified capture, or a card hold inside RESERVE_REQUIRES that has not expired", () => {
    expect(reserveBackedBy(target, [saga(captured())], at)).toBe(true);
    expect(reserveBackedBy(target, [saga(hold())], at)).toBe(true);
    // One backing saga is enough.
    expect(reserveBackedBy(target, [saga(null), saga(hold())], at)).toBe(true);
  });

  it("nothing else", () => {
    const cases: [string, Row[]][] = [
      ["no saga", []],
      ["no payment bound", [saga(null)]],
      ["saga not about to reserve", [saga(captured(), { state: "captured" })]],
      ["saga already confirming", [saga(captured(), { state: "confirm_pending" })]],
      ["saga flagged for a human", [saga(captured(), { attentionRequiredAt: at })]],
      ["saga of another order", [saga(captured(), { orderId: "other" })]],
      ["saga of another item", [saga(captured(), { orderItemId: "other", order: { items: [{ id: "other", fulfilmentOrigin: "instant_checkout" }] } })]],
      ["payment of another order", [saga(captured({ orderId: "other" }))]],
      ["manual row", [saga(captured({ source: "manual" }))]],
      ["manual gateway", [saga(captured({ gateway: "manual" }))]],
      ["no provider", [saga(captured({ provider: null }))]],
      ["no provider payment id", [saga(captured({ gatewayPaymentId: null }))]],
      ["refund opened", [saga(captured({ refunds: [{ id: "r1" }] }))]],
      ["partially refunded", [saga(captured({ refundedMinor: 1n }))]],
      ["partial capture", [saga(captured({ capturedMinor: 999n }))]],
      ["capture without a time", [saga(captured({ capturedAt: null }))]],
      ["zero amount", [saga(captured({ amountMinor: 0n, capturedMinor: 0n }))]],
      ["3DS failed", [saga(hold({ threeDs: "failed" }))]],
      ["3DS unknown", [saga(hold({ threeDs: "unknown" }))]],
      ["3DS not recorded", [saga(hold({ threeDs: null }))]],
      ["risk elevated", [saga(hold({ risk: "elevated" }))]],
      ["risk not recorded", [saga(captured({ risk: null }))]],
      ["hold expired", [saga(hold({ authorizationExpiresAt: at }))]],
      ["hold expiry unknown", [saga(hold({ authorizationExpiresAt: null }))]],
      ["hold without an authorization time", [saga(hold({ authorizedAt: null }))]],
      ["requires action", [saga(captured({ status: "requires_action" }))]],
      ["capture unknown", [saga(captured({ status: "capture_unknown" }))]],
      ["voided", [saga(hold({ status: "voided" }))]],
    ];
    for (const [name, rows] of cases) expect(reserveBackedBy(target, rows, at), name).toBe(false);
  });
});
