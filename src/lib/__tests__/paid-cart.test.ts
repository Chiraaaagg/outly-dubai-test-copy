import { describe, expect, it } from "vitest";
import { CART_PAID_STATES, cartFingerprint, PAYMENT_SETTLED_STATES, shouldClearPaidCart, type PaymentHandoff } from "../checkout-draft";

/**
 * CO-19: once the status page knows the payment arrived, the cart lines this
 * tab paid for leave the cart, only while the cart is still exactly those
 * lines. Synthetic values only.
 */

const REF = "OUT-123455";
const CART = [
  { id: "c1", date: "2026-11-18", time: "21:00", pax: { adult: 1 } },
  { id: "c2", date: "2026-11-19", time: "15:00", pax: { adult: 2 } },
];
const KEY = cartFingerprint(CART);
const HANDOFF: PaymentHandoff = {
  reference: REF,
  cartKey: KEY,
  quoteId: "01890000-0000-7000-8000-000000000001",
  verificationId: "01890000-0000-7000-8000-000000000002",
  method: "card",
  traveller: { fullName: "Test Traveller", phoneE164: "+971500000000", email: null },
};

describe("shouldClearPaidCart (CO-19)", () => {
  it("clears once the payment arrived, for the same order and the same cart", () => {
    for (const st of ["payment_processing", "booking_processing", "confirmed"]) expect(shouldClearPaidCart(HANDOFF, REF, st, KEY)).toBe(true);
    for (const st of CART_PAID_STATES) expect(shouldClearPaidCart(HANDOFF, REF, st, KEY)).toBe(true);
    for (const st of CART_PAID_STATES) expect(PAYMENT_SETTLED_STATES).toContain(st);
  });

  it("keeps the cart when nothing was booked: released, refunded, cancelled or with our team", () => {
    for (const st of ["payment_released", "refund_processing", "refunded", "cancellation_processing", "cancelled", "needs_attention"])
      expect(shouldClearPaidCart(HANDOFF, REF, st, KEY)).toBe(false);
  });

  it("never clears while the payment is open or after it failed", () => {
    expect(shouldClearPaidCart(HANDOFF, REF, "awaiting_payment", KEY)).toBe(false);
    expect(shouldClearPaidCart(HANDOFF, REF, "payment_failed", KEY)).toBe(false);
    expect(shouldClearPaidCart(HANDOFF, REF, "something_new", KEY)).toBe(false);
  });

  it("leaves a cart the customer changed since paying alone", () => {
    expect(shouldClearPaidCart(HANDOFF, REF, "confirmed", cartFingerprint([CART[0]]))).toBe(false);
    expect(shouldClearPaidCart(HANDOFF, REF, "confirmed", cartFingerprint([...CART, { id: "c3", date: "2026-11-20", time: "10:00", pax: { adult: 1 } }]))).toBe(false);
    expect(shouldClearPaidCart(HANDOFF, REF, "confirmed", cartFingerprint([{ ...CART[0], pax: { adult: 3 } }, CART[1]]))).toBe(false);
    expect(shouldClearPaidCart(HANDOFF, REF, "confirmed", "")).toBe(false);
  });

  it("does nothing without this tab's hand-off for this order", () => {
    expect(shouldClearPaidCart(null, REF, "confirmed", KEY)).toBe(false);
    expect(shouldClearPaidCart({ ...HANDOFF, reference: "OUT-999999" }, REF, "confirmed", KEY)).toBe(false);
  });
});
