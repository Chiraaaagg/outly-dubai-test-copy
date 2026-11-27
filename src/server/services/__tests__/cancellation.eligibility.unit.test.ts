import { describe, expect, it, vi } from "vitest";
import type { CancellationFacts } from "../cancellation.service";

/**
 * Cancellation eligibility from the stored verified policy only (doc 22
 * §23 B5, F15, F51). Pure: the database module throws if touched. The
 * request flow runs against the disposable database in
 * src/server/__tests__/b5/customer-cancellation.test.ts.
 */

vi.mock("../../lib/db", () => ({
  prisma: new Proxy({}, { get: () => { throw new Error("no database in this suite"); } }),
  TX_OPTIONS: {},
}));

const { evaluateCancellation, serviceStartUtc } = await import("../cancellation.service");

const NOW = new Date("2030-01-10T08:00:00.000Z");

function facts(over: Partial<CancellationFacts> = {}): CancellationFacts {
  return {
    orderItemId: "01890000-0000-7000-8000-0000000000a1",
    rail: "self_serve",
    fulfilmentOrigin: "instant_checkout",
    serviceDate: "2030-01-15",
    startMinutes: 600,
    booking: { id: "01890000-0000-7000-8000-0000000000b1", state: "confirmed" },
    policy: { freeCancellationUntilUtc: "2030-01-14T06:00:00.000Z", nonRefundableAfterConfirm: false },
    issuesTicketsAtConfirm: "no",
    ticketsStored: false,
    currency: "INR",
    payableMinor: 250_000n,
    payment: { id: "01890000-0000-7000-8000-0000000000c1", captured: true, verified: true, refundableMinor: 250_000n, frozen: false },
    orderPaid: true,
    ...over,
  };
}

describe("evaluateCancellation", () => {
  it("eligible: the payable allocation, the currency and the stored deadline", () => {
    expect(evaluateCancellation(facts(), NOW)).toEqual({ kind: "eligible", refundMinor: "250000", currency: "INR", untilUtc: "2030-01-14T06:00:00.000Z" });
  });

  it("each refusal names its reason", () => {
    const cases: Array<[Partial<CancellationFacts>, string, boolean]> = [
      [{ fulfilmentOrigin: "assisted_conversion" }, "not_supported", true],
      [{ rail: "assisted" }, "not_supported", true],
      [{ policy: { freeCancellationUntilUtc: "2030-01-14T06:00:00.000Z", nonRefundableAfterConfirm: true } }, "non_refundable", true],
      [{ policy: { freeCancellationUntilUtc: null, nonRefundableAfterConfirm: false } }, "non_refundable", true],
      [{ policy: null }, "non_refundable", true],
      [{ policy: { freeCancellationUntilUtc: "2030-01-10T07:59:59.000Z", nonRefundableAfterConfirm: false } }, "past_deadline", true],
      [{ issuesTicketsAtConfirm: "unknown" }, "tickets_issued", true],
      [{ issuesTicketsAtConfirm: "yes" }, "tickets_issued", true],
      [{ payment: null }, "payment_not_refundable", true],
      [{ payment: { id: "x", captured: false, verified: true, refundableMinor: 0n, frozen: false } }, "payment_not_refundable", true],
      [{ payment: { id: "x", captured: true, verified: false, refundableMinor: 250_000n, frozen: false } }, "payment_not_refundable", true],
      [{ payment: { id: "x", captured: true, verified: true, refundableMinor: 249_999n, frozen: false } }, "payment_not_refundable", true],
      [{ payment: { id: "x", captured: true, verified: true, refundableMinor: 250_000n, frozen: true } }, "payment_not_refundable", false],
      [{ payableMinor: null }, "payment_not_refundable", true],
      [{ serviceDate: "2030-01-10", startMinutes: 9 * 60 }, "activity_started", false],
    ];
    for (const [over, reason, exceptionAllowed] of cases) {
      expect(evaluateCancellation(facts(over), NOW), JSON.stringify(over, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toEqual({ kind: "not_eligible", reason, exceptionAllowed });
    }
  });

  it("the activity start counts before the policy: a started activity offers no exception either", () => {
    expect(evaluateCancellation(facts({ serviceDate: "2030-01-09", issuesTicketsAtConfirm: "yes", policy: null }), NOW)).toEqual({ kind: "not_eligible", reason: "activity_started", exceptionAllowed: false });
  });

  it("nothing to offer before the operator confirms, or once the booking is gone", () => {
    for (const state of ["awaiting_payment", "confirming", "cancelling", "cancelled"]) {
      expect(evaluateCancellation(facts({ booking: { id: "b", state } }), NOW)).toEqual({ kind: "none" });
    }
    expect(evaluateCancellation(facts({ booking: null }), NOW)).toEqual({ kind: "none" });
    expect(evaluateCancellation(facts({ rail: "assisted", orderPaid: false }), NOW)).toEqual({ kind: "none" });
  });

  it("after the operator refused a cancellation (F51) the booking is live: no self-serve cancel, but our team may be asked", () => {
    expect(evaluateCancellation(facts({ booking: { id: "b", state: "cancel_refused" } }), NOW)).toEqual({ kind: "not_eligible", reason: "non_refundable", exceptionAllowed: true });
    expect(evaluateCancellation(facts({ booking: { id: "b", state: "cancel_refused" }, serviceDate: "2030-01-09" }), NOW)).toEqual({ kind: "not_eligible", reason: "activity_started", exceptionAllowed: false });
  });
});

describe("serviceStartUtc", () => {
  it("is the Dubai local start (UTC+4), or local midnight without a slot", () => {
    expect(serviceStartUtc("2030-01-15", 600).toISOString()).toBe("2030-01-15T06:00:00.000Z");
    expect(serviceStartUtc("2030-01-15", null).toISOString()).toBe("2030-01-14T20:00:00.000Z");
  });
});
