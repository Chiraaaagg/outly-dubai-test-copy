import { describe, expect, it } from "vitest";
import { activities } from "@/lib/data/activities";
import { parseStartTimes } from "@/lib/api/start-times";
import { toCartItem } from "@/lib/pricing";
import { dateOnlyStartView, retimeHrefFor, reviewTime } from "@/lib/start-time-retry";
import { EMPTY_PAX } from "@/lib/utils";
import type { Activity } from "@/lib/types";

/**
 * Doc 29 Batch 7, browser side: the `date_only` start-times answer (owner
 * decision c: a real start is shown before payment), the checkout review
 * time, and the way back from checkout for a date-only line (review 92
 * B7-06). Pure; synthetic data only.
 */

function activity(over: Partial<Activity> = {}): Activity {
  return { ...activities[0], ...over };
}

describe("start-times answer: date_only", () => {
  it("accepts a one-start answer with a real start or none, and nothing malformed", () => {
    const at = "2026-11-01T08:00:00.000Z";
    expect(parseStartTimes({ source: "date_only", checkedAt: at, stale: false, startsAt: "15:00", status: "available" })).toEqual({ source: "date_only", checkedAt: at, stale: false, startsAt: "15:00", status: "available" });
    expect(parseStartTimes({ source: "date_only", checkedAt: at, stale: true, startsAt: null, status: "sold_out" })).toEqual({ source: "date_only", checkedAt: at, stale: true, startsAt: null, status: "sold_out" });
    for (const bad of [
      { source: "date_only", checkedAt: at, startsAt: "3 pm", status: "available" },
      { source: "date_only", checkedAt: at, startsAt: 900, status: "available" },
      { source: "date_only", checkedAt: at, status: "available" },
      { source: "date_only", checkedAt: at, startsAt: "15:00" },
      { source: "date_only", checkedAt: at, startsAt: "15:00", status: "open" },
      { source: "date_only", checkedAt: "yesterday", startsAt: null, status: "available" },
    ]) {
      expect(parseStartTimes(bad)).toBeNull();
    }
  });
});

describe("checkout review time", () => {
  it("the cart line's own time wins; a line without one shows the quoted supplier start", () => {
    expect(reviewTime("13:00", "31@13:00")).toBe("13:00");
    expect(reviewTime("Flexible", "4@15:00")).toBe("15:00");
    expect(reviewTime("Flexible", null)).toBe("Flexible");
    expect(reviewTime("Flexible", "slot-0900")).toBe("Flexible");
  });
});

describe("the way back from checkout for a date-only line (B7-06)", () => {
  const dateOnly = activity({ slug: "synthetic-gala-dinner", timeSlots: [], fulfilmentMode: "instant" });
  const chosen = toCartItem(dateOnly, { date: "2026-12-31", time: "18:00", pax: { ...EMPTY_PAX, adult: 2 } });
  const flexible = toCartItem(dateOnly, { date: "2026-12-31", time: "Flexible", pax: { ...EMPTY_PAX, adult: 2 } });

  it("a line that carries a start offers another time; a line with only a date does not", () => {
    expect(retimeHrefFor([{ index: 0, reason: "invalid_slot" }], [chosen], [dateOnly])).toBe(`/activities/synthetic-gala-dinner?date=2026-12-31&retime=${encodeURIComponent(chosen.id)}#book`);
    expect(retimeHrefFor([{ index: 0, reason: "sold_out" }], [chosen], [dateOnly])).not.toBeNull();
    expect(retimeHrefFor([{ index: 0, reason: "sold_out" }], [flexible], [dateOnly])).toBeNull();
    expect(retimeHrefFor([{ index: 0, reason: "requires_inquiry" }], [chosen], [dateOnly])).toBeNull();
  });
});

describe("the one-start date-only view (review 92 B7-11, B7-13)", () => {
  const view = (over: Partial<Parameters<typeof dateOnlyStartView>[0]> = {}) =>
    dateOnlyStartView({ startsAt: "15:00", status: "available", pickup: false, date: "2026-12-31", retime: null, ...over });

  it("states the activity's start, never as a pickup time; a pickup offer points to the voucher", () => {
    expect(view()).toEqual({ line: "Starts 15:00", note: null, blocked: false });
    const pickup = view({ pickup: true });
    expect(pickup).toEqual({ line: "Starts 15:00", note: "Pickup time is on your voucher.", blocked: false });
    expect(JSON.stringify(pickup)).not.toMatch(/Pickup starts|pickup at|Pickup 15/i);
    // A 00:00 or whole-day row: no start, and the voucher note for pickup.
    expect(view({ startsAt: null })).toEqual({ line: null, note: null, blocked: false });
    expect(view({ startsAt: null, pickup: true })).toEqual({ line: null, note: "Pickup time is on your voucher.", blocked: false });
  });

  it("a date the quote would refuse shows no start and blocks", () => {
    for (const status of ["sold_out", "unavailable"] as const) {
      expect(view({ status })).toEqual({ line: "Not available on this date. Choose another date.", note: null, blocked: true });
      expect(view({ status, pickup: true }).note).toBeNull();
    }
    expect(view({ status: "limited" }).blocked).toBe(false);
  });

  it("a line sent back for this very start is never sent back to it: same date and start block, another date does not", () => {
    const retime = { date: "2026-12-31", time: "15:00" };
    expect(view({ retime })).toMatchObject({ blocked: true, line: expect.stringContaining("Choose another date") });
    expect(view({ retime, date: "2027-01-01" })).toEqual({ line: "Starts 15:00", note: null, blocked: false });
    expect(view({ retime, startsAt: "16:00" }).blocked).toBe(false);
  });
});
