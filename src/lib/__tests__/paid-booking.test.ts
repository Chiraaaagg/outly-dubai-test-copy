import { describe, expect, it, vi } from "vitest";
import {
  clearPaidMarker,
  CONFIRMED_BOOKING_STATES,
  PAID_BOOKING_BODY,
  PAID_BOOKING_STATES,
  PAID_MARKER_KEY,
  PAID_MARKER_TTL_MS,
  paidBookingNotice,
  readPaidMarker,
  resolvePaidBooking,
  writePaidMarker,
} from "../paid-booking";
import { CART_PAID_STATES } from "../checkout-draft";

/**
 * The "recently paid" marker (production fix, 28 Nov 2026): the status page
 * keeps the order reference and a time, and nothing else (PRV-4), for 24
 * hours in this tab; an empty cart page shows the booking only when the
 * server says the payment arrived. Synthetic references; a Map stands in for
 * sessionStorage.
 */

const REF = "OUT-123455";
const OTHER = "OUT-12345674";
const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);

function memory() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

function broken() {
  const fail = () => {
    throw new Error("storage blocked");
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

describe("paid marker: write and read", () => {
  it("keeps the normalised reference and the time only, under one key", () => {
    const s = memory();
    writePaidMarker(" out-123455 ", NOW, s);
    expect([...s.m.keys()]).toEqual([PAID_MARKER_KEY]);
    expect(JSON.parse(s.m.get(PAID_MARKER_KEY)!)).toEqual({ reference: REF, paidAt: NOW });
    expect(readPaidMarker(NOW + 1000, s)).toEqual({ reference: REF, paidAt: NOW });
  });

  it("never stores a name, contact or amount", () => {
    const s = memory();
    writePaidMarker(REF, NOW, s);
    const raw = s.m.get(PAID_MARKER_KEY)!;
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["paidAt", "reference"]);
    expect(raw).not.toMatch(/@|\+971|name|phone|email|amount|total/i);
  });

  it("refuses a malformed or wrong-check-digit reference", () => {
    const s = memory();
    writePaidMarker("OUT-123456", NOW, s);
    writePaidMarker("<script>", NOW, s);
    writePaidMarker("INQ-123455", NOW, s);
    expect(s.m.size).toBe(0);
  });

  it("drops an unreadable record", () => {
    for (const raw of ["not json", "null", "[]", JSON.stringify({ reference: "<script>", paidAt: NOW }), JSON.stringify({ reference: REF }), JSON.stringify({ reference: REF, paidAt: "yesterday" })]) {
      const s = memory();
      s.m.set(PAID_MARKER_KEY, raw);
      expect(readPaidMarker(NOW, s), raw).toBeNull();
      expect(s.m.has(PAID_MARKER_KEY), raw).toBe(false);
    }
  });

  it("clears on request", () => {
    const s = memory();
    writePaidMarker(REF, NOW, s);
    clearPaidMarker(s);
    expect(s.m.size).toBe(0);
    expect(readPaidMarker(NOW, s)).toBeNull();
  });

  it("ignores missing or blocked storage", () => {
    expect(() => writePaidMarker(REF, NOW, null)).not.toThrow();
    expect(readPaidMarker(NOW, null)).toBeNull();
    expect(() => writePaidMarker(REF, NOW, broken())).not.toThrow();
    expect(readPaidMarker(NOW, broken())).toBeNull();
    expect(() => clearPaidMarker(broken())).not.toThrow();
  });
});

describe("paid marker: expiry", () => {
  it("lasts 24 hours, then is removed", () => {
    expect(PAID_MARKER_TTL_MS).toBe(24 * 60 * 60 * 1000);
    const s = memory();
    writePaidMarker(REF, NOW, s);
    expect(readPaidMarker(NOW + PAID_MARKER_TTL_MS - 1, s)).toEqual({ reference: REF, paidAt: NOW });
    expect(readPaidMarker(NOW + PAID_MARKER_TTL_MS, s)).toBeNull();
    expect(s.m.has(PAID_MARKER_KEY)).toBe(false);
  });

  it("does not believe a time far in the future", () => {
    const s = memory();
    writePaidMarker(REF, NOW + 60 * 60 * 1000, s);
    expect(readPaidMarker(NOW, s)).toBeNull();
    expect(s.m.size).toBe(0);
  });
});

describe("paidBookingNotice: only what the server says", () => {
  it("is confirmed when the operator confirmed the booking", () => {
    for (const state of ["confirmed", "confirmed_ticket_pending"]) {
      const n = paidBookingNotice(REF, { reference: REF, state });
      expect(n).toEqual({ reference: REF, confirmed: true, title: `Your booking ${REF} is confirmed`, body: PAID_BOOKING_BODY, href: `/booking/${REF}` });
    }
    expect(PAID_BOOKING_BODY).toBe("You've already paid for this trip, so your cart is empty.");
  });

  it("is still being confirmed while the booking is on its way", () => {
    for (const state of ["payment_processing", "booking_processing", "partially_fulfilled"]) {
      const n = paidBookingNotice(REF, { reference: REF, state });
      expect(n?.confirmed, state).toBe(false);
      expect(n?.title, state).toBe(`We're confirming your booking ${REF}`);
    }
  });

  it("covers every state in which the status page empties the cart", () => {
    for (const state of CART_PAID_STATES) expect(PAID_BOOKING_STATES).toContain(state);
    for (const state of CONFIRMED_BOOKING_STATES) expect(PAID_BOOKING_STATES).toContain(state);
  });

  it("claims no payment the server did not confirm", () => {
    for (const state of ["awaiting_payment", "payment_failed", "payment_released", "refund_processing", "refunded", "cancellation_processing", "cancelled", "needs_attention", "something_new"])
      expect(paidBookingNotice(REF, { reference: REF, state }), state).toBeNull();
    expect(paidBookingNotice(REF, null)).toBeNull();
  });

  it("never shows another order than the one marked", () => {
    expect(paidBookingNotice(REF, { reference: OTHER, state: "confirmed" })).toBeNull();
    expect(paidBookingNotice(REF, { reference: "<script>", state: "confirmed" })).toBeNull();
  });
});

describe("resolvePaidBooking: the empty-cart branch", () => {
  const marker = { reference: REF, paidAt: NOW };

  it("marker and a visible paid order: the booking", async () => {
    const s = memory();
    writePaidMarker(REF, NOW, s);
    const fetchStatus = vi.fn(async (ref: string) => ({ reference: ref, state: "confirmed" }));
    await expect(resolvePaidBooking(marker, fetchStatus, s)).resolves.toMatchObject({ reference: REF, confirmed: true });
    expect(fetchStatus).toHaveBeenCalledWith(REF);
    expect(s.m.has(PAID_MARKER_KEY)).toBe(true);
  });

  it("marker and an order this browser may not see: the usual state, and the marker goes", async () => {
    const s = memory();
    writePaidMarker(REF, NOW, s);
    await expect(resolvePaidBooking(marker, async () => null, s)).resolves.toBeNull();
    expect(s.m.has(PAID_MARKER_KEY)).toBe(false);
  });

  it("marker and an unpaid order: the usual state", async () => {
    await expect(resolvePaidBooking(marker, async () => ({ reference: REF, state: "refunded" }), memory())).resolves.toBeNull();
  });

  it("a failed request: the usual state, and the marker stays for a later visit", async () => {
    const s = memory();
    writePaidMarker(REF, NOW, s);
    await expect(
      resolvePaidBooking(marker, async () => {
        throw new Error("offline");
      }, s),
    ).resolves.toBeNull();
    expect(s.m.has(PAID_MARKER_KEY)).toBe(true);
  });

  it("no marker: the usual state, and no request", async () => {
    const fetchStatus = vi.fn(async (ref: string) => ({ reference: ref, state: "confirmed" }));
    await expect(resolvePaidBooking(null, fetchStatus, memory())).resolves.toBeNull();
    expect(fetchStatus).not.toHaveBeenCalled();
  });
});
