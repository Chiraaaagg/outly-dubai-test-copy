import { describe, expect, it } from "vitest";
import { activities } from "@/lib/data/activities";
import { parseStartTimes, startTimesPath } from "@/lib/api/start-times";
import { cartGoesToInquiry, cartRequiresInquiry, guestRowsFor, offersSeniorPrice, toCartItem } from "@/lib/pricing";
import { parseRetimeId, retimeHrefFor } from "@/lib/start-time-retry";
import { createAbortableReader } from "@/lib/use-abortable-read";
import { availableTimesLine, DUBAI_TIME_LABEL, nextUsableIndex, type TimeSlotPickerSlot } from "@/components/commerce/time-slot-picker";
import { EMPTY_PAX } from "@/lib/utils";
import type { Activity } from "@/lib/types";
import type { UnitDefinition } from "@/server/quotes/contracts";

/**
 * Doc 29 Batch 2, browser side: the start-times answer check, the one
 * abortable read, the Time Slot Picker's keyboard rule (pure: the unit
 * project has no DOM), the Seniors row (owner decision 5), the stale-time
 * way back from checkout and the mixed-cart rule. Synthetic data only.
 */

const unit = (unitId: string): UnitDefinition => ({
  unitId,
  label: unitId,
  per: "person",
  ageMin: null,
  ageMax: null,
  residency: "any",
  heightMinCm: null,
  heightMaxCm: null,
  seatConsuming: true,
  minQty: 0,
  maxQty: 10,
  price: { inr: 1000, aed: 40 },
  supplierUnit: unitId === "senior" ? "adult" : unitId,
});

function activity(over: Partial<Activity> = {}): Activity {
  return { ...activities[0], ...over };
}

describe("start-times answer (GET /api/catalog/start-times)", () => {
  it("accepts the two shapes the route sends and nothing else", () => {
    expect(parseStartTimes({ source: "stored", reason: "busy" })).toEqual({ source: "stored", reason: "busy" });
    expect(parseStartTimes({ source: "supplier", checkedAt: "2026-11-01T08:00:00.000Z", stale: false, times: [{ time: "10:00", status: "limited" }] })).toEqual({
      source: "supplier",
      checkedAt: "2026-11-01T08:00:00.000Z",
      stale: false,
      times: [{ time: "10:00", status: "limited" }],
    });
    for (const bad of [
      null,
      "x",
      { source: "stored", reason: "nope" },
      { source: "supplier", checkedAt: "later", times: [] },
      { source: "supplier", checkedAt: "2026-11-01T08:00:00Z", times: [{ time: "25:00", status: "available" }] },
      { source: "supplier", checkedAt: "2026-11-01T08:00:00Z", times: [{ time: "10:00", status: "free" }] },
      { source: "supplier", checkedAt: "2026-11-01T08:00:00Z", times: "10:00" },
    ]) {
      expect(parseStartTimes(bad)).toBeNull();
    }
  });

  it("the URL carries only the product id, the variant id and the date", () => {
    const path = startTimesPath({ productId: "0190a000-0000-7000-8000-000000000001", variantId: "shared", date: "2026-11-05" });
    expect(path).toBe("/api/catalog/start-times?productId=0190a000-0000-7000-8000-000000000001&variantId=shared&date=2026-11-05");
  });
});

describe("createAbortableReader (the one abortable-read hook's core)", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("aborts the read in flight when the key changes, and never reports the late answer", async () => {
    const r = createAbortableReader<string>();
    const a = deferred<string>();
    const b = deferred<string>();
    const signals: AbortSignal[] = [];
    const done: unknown[] = [];
    r.read("d1", (s) => (signals.push(s), a.promise), (x) => done.push(["d1", x]));
    r.read("d2", (s) => (signals.push(s), b.promise), (x) => done.push(["d2", x]));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    a.resolve("late");
    b.resolve("fresh");
    await flush();
    expect(done).toEqual([["d2", { ok: true, value: "fresh" }]]);
  });

  it("keeps answers per key for the TTL, so returning to a date costs no request", async () => {
    let t = 0;
    const r = createAbortableReader<string>({ ttlMs: 60_000, now: () => t });
    let calls = 0;
    const fetcher = async () => `v${++calls}`;
    const seen: unknown[] = [];
    r.read("d1", fetcher, (x) => seen.push(x));
    await flush();
    r.read("d1", fetcher, (x) => seen.push(x));
    expect(calls).toBe(1);
    expect(r.peek("d1")).toBe("v1");
    t = 60_000;
    expect(r.peek("d1")).toBeUndefined();
    r.read("d1", fetcher, (x) => seen.push(x));
    await flush();
    expect(calls).toBe(2);
    expect(seen).toEqual([{ ok: true, value: "v1" }, { ok: true, value: "v1" }, { ok: true, value: "v2" }]);
  });

  it("a failed read is reported once and is not remembered", async () => {
    const r = createAbortableReader<string>();
    const seen: unknown[] = [];
    r.read("d1", async () => {
      throw new Error("offline");
    }, (x) => seen.push(x));
    await flush();
    expect(seen).toEqual([{ ok: false }]);
    expect(r.peek("d1")).toBeUndefined();
  });

  it("cancel aborts and silences the read in flight", async () => {
    const r = createAbortableReader<string>();
    const a = deferred<string>();
    let signal: AbortSignal | null = null;
    const seen: unknown[] = [];
    r.read("d1", (s) => ((signal = s), a.promise), (x) => seen.push(x));
    r.cancel();
    expect(signal!.aborted).toBe(true);
    a.reject(new DOMException("aborted", "AbortError"));
    await flush();
    expect(seen).toEqual([]);
  });
});

describe("Time Slot Picker keyboard rule (radio group with roving focus)", () => {
  const slots: TimeSlotPickerSlot[] = [
    { time: "10:00" },
    { time: "11:00", status: "sold_out" },
    { time: "12:00", status: "limited" },
    { time: "13:00", status: "unavailable" },
    { time: "14:00" },
  ];

  it("arrows move to the next usable time, skipping sold-out and unavailable ones, and wrap", () => {
    expect(nextUsableIndex("ArrowRight", 0, slots, 3)).toBe(2);
    expect(nextUsableIndex("ArrowRight", 2, slots, 3)).toBe(4);
    expect(nextUsableIndex("ArrowRight", 4, slots, 3)).toBe(0);
    expect(nextUsableIndex("ArrowLeft", 0, slots, 3)).toBe(4);
    // Down from 0 by rows of 3: 3 is unavailable, 6 wraps to 1 (sold out), 9 wraps to 4.
    expect(nextUsableIndex("ArrowDown", 0, slots, 3)).toBe(4);
    expect(nextUsableIndex("ArrowUp", 4, slots, 3)).toBe(0);
  });

  it("Home and End go to the first and last usable time; other keys do nothing", () => {
    expect(nextUsableIndex("Home", 4, slots, 3)).toBe(0);
    expect(nextUsableIndex("End", 0, slots, 3)).toBe(4);
    expect(nextUsableIndex("Enter", 0, slots, 3)).toBeNull();
    expect(nextUsableIndex("a", 0, slots, 3)).toBeNull();
    expect(nextUsableIndex("ArrowRight", 0, [{ time: "10:00", status: "sold_out" }], 3)).toBeNull();
    expect(nextUsableIndex("Home", 0, [], 3)).toBeNull();
  });

  it("announces how many times are open, and names the activity's zone, not the browser's", () => {
    expect(availableTimesLine(slots)).toBe("3 start times available");
    expect(availableTimesLine([{ time: "10:00" }])).toBe("1 start time available");
    expect(availableTimesLine([{ time: "10:00", status: "sold_out" }])).toBe("No start times can be booked on this date");
    expect(DUBAI_TIME_LABEL).toMatch(/Asia\/Dubai/);
  });
});

describe("Seniors row follows the offer (owner decision 5)", () => {
  it("is hidden when the offer has no senior price, shown when it has one", () => {
    const noSenior = activity({ price: { adult: { inr: 1000, aed: 40 } } });
    expect(guestRowsFor(noSenior)).toEqual(["adult", "child", "infant"]);
    const withSenior = activity({ price: { adult: { inr: 1000, aed: 40 }, senior: { inr: 800, aed: 32 } } });
    expect(guestRowsFor(withSenior)).toEqual(["adult", "child", "infant", "senior"]);
  });

  it("a variant with typed units decides by its units, whatever the price band says", () => {
    const base = activity({ price: { adult: { inr: 1000, aed: 40 }, senior: { inr: 800, aed: 32 } } });
    const typed = { ...base, variants: [{ ...base.variants[0], id: "shared", units: [unit("adult"), unit("child")] }] };
    expect(offersSeniorPrice(typed, typed.variants[0])).toBe(false);
    expect(guestRowsFor(typed, "shared")).not.toContain("senior");
    const withSeniorUnit = { ...base, variants: [{ ...base.variants[0], id: "shared", units: [unit("adult"), unit("senior")] }] };
    expect(guestRowsFor(withSeniorUnit, "shared")).toContain("senior");
  });
});

describe("stale start time: the way back from checkout", () => {
  const listed = activity({ slug: "synthetic-speed-boat", timeSlots: ["10:00", "13:00", "16:00"], fulfilmentMode: "instant" });
  const single = activity({ slug: "synthetic-yacht", timeSlots: ["17:00"], fulfilmentMode: "instant" });
  const item = toCartItem(listed, { date: "2026-11-05", time: "13:00", pax: { ...EMPTY_PAX, adult: 2 } });
  const singleItem = toCartItem(single, { date: "2026-11-05", time: "17:00", pax: { ...EMPTY_PAX, adult: 2 } });

  it("offers another time when only that line's start was refused, and the activity has other times", () => {
    const href = retimeHrefFor([{ index: 0, reason: "sold_out" }], [item], [listed]);
    expect(href).toBe(`/activities/synthetic-speed-boat?date=2026-11-05&retime=${encodeURIComponent(item.id)}#book`);
    expect(retimeHrefFor([{ index: 0, reason: "invalid_slot" }], [item], [listed])).not.toBeNull();
    expect(parseRetimeId(item.id)).toBe(item.id);
  });

  it("does not when another reason is involved, two lines are refused, or there is no other time", () => {
    expect(retimeHrefFor([{ index: 0, reason: "pickup_unavailable" }], [item], [listed])).toBeNull();
    expect(retimeHrefFor([{ index: 0, reason: "sold_out" }, { index: 1, reason: "requires_inquiry" }], [item, singleItem], [listed, single])).toBeNull();
    expect(retimeHrefFor([{ index: 0, reason: "sold_out" }, { index: 1, reason: "sold_out" }], [item, item], [listed])).toBeNull();
    expect(retimeHrefFor([{ index: 0, reason: "sold_out" }], [singleItem], [single])).toBeNull();
    expect(retimeHrefFor([], [item], [listed])).toBeNull();
  });

  it("the id in the URL is a cart line id only: anything else is dropped", () => {
    for (const bad of [null, "", "x", "a b", "<script>", "../../etc", "synthetic-2026-11-05"]) expect(parseRetimeId(bad)).toBeNull();
  });
});

describe("mixed cart (doc 29 §7.4): an instant listed-start item plus an inquiry item stays a wholly unpaid inquiry", () => {
  it("routes the whole cart to the inquiry form", () => {
    const listed = activity({ slug: "synthetic-speed-boat", timeSlots: ["10:00", "13:00"], fulfilmentMode: "instant" });
    const other = activity({ slug: "synthetic-dinner", fulfilmentMode: "inquiry" });
    const cart = [toCartItem(listed, { date: "2026-11-05", time: "13:00", pax: { ...EMPTY_PAX, adult: 2 } }), toCartItem(other, { date: "2026-11-05", time: "19:00", pax: { ...EMPTY_PAX, adult: 2 } })];
    expect(cartRequiresInquiry(cart)).toBe(true);
    expect(cartGoesToInquiry(cart)).toBe(true);
    expect(cartGoesToInquiry(cart.slice(0, 1))).toBe(false);
  });
});
