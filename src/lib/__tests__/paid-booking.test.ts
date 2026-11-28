import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_TIMEOUT_MS,
  clearPaidMarker,
  CONFIRMING_BODY,
  HAS_BOOKING_BODY,
  NOTICE_STATES,
  PAID_BOOKING_BODY,
  PAID_BOOKING_STATES,
  PAID_MARKER_KEY,
  PAID_MARKER_TTL_MS,
  PARTIAL_BODY,
  paidBookingNotice,
  readPaidMarker,
  RECENT_BODY,
  resolvePaidBooking,
  startPaidBookingCheck,
  writePaidMarker,
  type NoticeStatus,
  type PaidBookingNotice,
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

/** A status as the server sends it: the state, and the payment step's status. */
function st(state: string, payment: string = "done", reference: string = REF): NoticeStatus {
  return { reference, state, steps: { payment: { status: payment } } };
}

describe("paidBookingNotice: only what the server says (review 116 D1, D5, D10)", () => {
  it("confirmed by the operator, payment done: confirmed and paid", () => {
    for (const state of ["confirmed", "confirmed_ticket_pending", "paid_confirmed_by_team"]) {
      expect(paidBookingNotice(REF, st(state)), state).toEqual({ reference: REF, kind: "confirmed", title: `Your booking ${REF} is confirmed`, body: PAID_BOOKING_BODY, href: `/booking/${REF}` });
    }
    expect(PAID_BOOKING_BODY).toBe("You've already paid for this trip, so your cart is empty.");
  });

  it("says paid only when the server's payment step is done", () => {
    for (const payment of ["in_progress", "not_started", "failed", "not_applicable"]) {
      expect(paidBookingNotice(REF, st("confirmed", payment))?.body, payment).toBe(HAS_BOOKING_BODY);
      expect(paidBookingNotice(REF, st("payment_processing", payment))?.body, payment).toBe(CONFIRMING_BODY);
    }
    expect(paidBookingNotice(REF, { reference: REF, state: "booking_processing" })?.body).toBe(CONFIRMING_BODY);
    expect(paidBookingNotice(REF, { reference: REF, state: "booking_processing", steps: null })?.body).toBe(CONFIRMING_BODY);
    expect(CONFIRMING_BODY).toBe("We're still confirming your payment and booking.");
  });

  it("still being booked: we're confirming it", () => {
    for (const state of ["payment_processing", "booking_processing"]) {
      const n = paidBookingNotice(REF, st(state));
      expect(n?.kind, state).toBe("confirming");
      expect(n?.title, state).toBe(`We're confirming your booking ${REF}`);
      expect(n?.body, state).toBe(PAID_BOOKING_BODY);
    }
    // Capture outcome unknown: the payment step is not done, so no payment is claimed.
    expect(paidBookingNotice(REF, st("payment_processing", "in_progress"))?.body).toBe(CONFIRMING_BODY);
  });

  it("partly booked: its own words, and no claim that the trip was paid or is being confirmed", () => {
    const n = paidBookingNotice(REF, st("partially_fulfilled"));
    expect(n).toMatchObject({ kind: "partial", title: `Part of your booking ${REF} is confirmed`, body: PARTIAL_BODY });
    expect(n?.body).not.toMatch(/paid|confirming/i);
  });

  it("a past booking has taken place", () => {
    expect(paidBookingNotice(REF, st("completed"))).toMatchObject({ kind: "completed", title: `Your booking ${REF} has taken place`, body: PAID_BOOKING_BODY });
  });

  it("an order that moved on points to the booking and claims nothing about the payment", () => {
    for (const state of ["payment_released", "refund_processing", "refunded", "cancellation_processing", "cancelled", "needs_attention"]) {
      const n = paidBookingNotice(REF, st(state));
      expect(n, state).toMatchObject({ kind: "recent", title: `You have a recent booking, ${REF}`, body: RECENT_BODY, href: `/booking/${REF}` });
      expect(`${n?.title} ${n?.body}`, state).not.toMatch(/paid|confirmed|confirming/i);
    }
  });

  it("an unpaid or unknown state: the usual empty state", () => {
    for (const state of ["awaiting_payment", "payment_failed", "something_new", "toString", "__proto__"]) expect(paidBookingNotice(REF, st(state)), state).toBeNull();
    expect(paidBookingNotice(REF, null)).toBeNull();
  });

  it("may claim payment in every state in which the status page empties the cart", () => {
    for (const state of CART_PAID_STATES) expect(PAID_BOOKING_STATES).toContain(state);
    for (const state of PAID_BOOKING_STATES) expect(NOTICE_STATES).toContain(state);
    for (const state of ["payment_released", "refunded", "cancelled", "needs_attention"]) expect(PAID_BOOKING_STATES).not.toContain(state);
  });

  it("never shows another order than the one marked", () => {
    expect(paidBookingNotice(REF, st("confirmed", "done", OTHER))).toBeNull();
    expect(paidBookingNotice(REF, st("confirmed", "done", "<script>"))).toBeNull();
  });
});

describe("resolvePaidBooking: the empty-cart branch", () => {
  const marker = { reference: REF, paidAt: NOW };

  it("marker and a visible paid order: the booking", async () => {
    const s = memory();
    writePaidMarker(REF, NOW, s);
    const fetchStatus = vi.fn(async (ref: string) => st("confirmed", "done", ref));
    await expect(resolvePaidBooking(marker, fetchStatus, s)).resolves.toMatchObject({ reference: REF, kind: "confirmed", body: PAID_BOOKING_BODY });
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
    await expect(resolvePaidBooking(marker, async () => st("awaiting_payment", "in_progress"), memory())).resolves.toBeNull();
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
    const fetchStatus = vi.fn(async (ref: string) => st("confirmed", "done", ref));
    await expect(resolvePaidBooking(null, fetchStatus, memory())).resolves.toBeNull();
    expect(fetchStatus).not.toHaveBeenCalled();
  });
});

describe("startPaidBookingCheck: what the mounted page is told (review 116 D9, D11)", () => {
  const marker = { reference: REF, paidAt: NOW };
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets the answered request travel through the promise chain. */
  async function flush() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  /** A status request the test answers by hand. */
  function pending() {
    let answer!: (s: NoticeStatus | null) => void;
    let fail!: (e: Error) => void;
    const asked: string[] = [];
    const fetchStatus = vi.fn((ref: string) => {
      asked.push(ref);
      return new Promise<NoticeStatus | null>((resolve, reject) => {
        answer = resolve;
        fail = reject;
      });
    });
    return { fetchStatus, asked, answer: (s: NoticeStatus | null) => answer(s), fail: (e: Error) => fail(e) };
  }

  it("an answer in time: reported once, and the timer is spent", async () => {
    vi.useFakeTimers();
    const req = pending();
    const onResult = vi.fn<(r: { notice: PaidBookingNotice | null }) => void>();
    startPaidBookingCheck(marker, { fetchStatus: req.fetchStatus, onResult, storage: memory() });
    expect(req.asked).toEqual([REF]);
    req.answer(st("confirmed"));
    await flush();
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0].notice).toMatchObject({ kind: "confirmed" });
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS * 2);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it("no answer within 8 seconds: the usual empty state", async () => {
    vi.useFakeTimers();
    expect(CHECK_TIMEOUT_MS).toBe(8_000);
    const req = pending();
    const onResult = vi.fn<(r: { notice: PaidBookingNotice | null }) => void>();
    startPaidBookingCheck(marker, { fetchStatus: req.fetchStatus, onResult, storage: memory() });
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS - 1);
    expect(onResult).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenLastCalledWith({ notice: null });
  });

  it("a late good answer still replaces the empty state", async () => {
    vi.useFakeTimers();
    const req = pending();
    const onResult = vi.fn<(r: { notice: PaidBookingNotice | null }) => void>();
    startPaidBookingCheck(marker, { fetchStatus: req.fetchStatus, onResult, storage: memory() });
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS + 4_000);
    req.answer(st("booking_processing"));
    await flush();
    expect(onResult).toHaveBeenCalledTimes(2);
    expect(onResult.mock.calls[1][0].notice).toMatchObject({ kind: "confirming", title: `We're confirming your booking ${REF}` });
  });

  it("a late failure or a late 404 changes nothing", async () => {
    vi.useFakeTimers();
    for (const late of ["fail", "404", "unpaid"] as const) {
      const req = pending();
      const onResult = vi.fn<(r: { notice: PaidBookingNotice | null }) => void>();
      startPaidBookingCheck(marker, { fetchStatus: req.fetchStatus, onResult, storage: memory() });
      await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
      if (late === "fail") req.fail(new Error("offline"));
      else req.answer(late === "404" ? null : st("awaiting_payment", "in_progress"));
      await flush();
      expect(onResult, late).toHaveBeenCalledTimes(1);
      expect(onResult, late).toHaveBeenLastCalledWith({ notice: null });
    }
  });

  it("unmounted before the answer: nothing is reported, and no timer is left", async () => {
    vi.useFakeTimers();
    const req = pending();
    const onResult = vi.fn<(r: { notice: PaidBookingNotice | null }) => void>();
    const cancel = startPaidBookingCheck(marker, { fetchStatus: req.fetchStatus, onResult, storage: memory() });
    cancel();
    expect(vi.getTimerCount()).toBe(0);
    req.answer(st("confirmed"));
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS * 2);
    expect(onResult).not.toHaveBeenCalled();
  });
});
