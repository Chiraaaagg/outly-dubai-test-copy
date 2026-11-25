import { describe, expect, it } from "vitest";
import { applyCoupon, authoredCouponValue, cartRequiresInquiry, computeBreakdown, couponByCode, couponDiscountMinor, coupons, toCartItem, type Coupon, type PricedActivity } from "../pricing";
import { currencyForCountry, transactionCurrency } from "../currency";
import type { CartItem, PaxCount } from "../types";

/**
 * Preservation tests (doc 22 PRD-22). These pin what the pricing, cart and
 * currency helpers do TODAY, before B2 moves pricing to server quotes. They are
 * not a statement that every pinned behaviour is right: where a case is known
 * to be under review it says so, and the test changes with the fix, not
 * silently. All prices are synthetic.
 */

const pax = (over: Partial<PaxCount> = {}): PaxCount => ({ adult: 0, child: 0, infant: 0, senior: 0, ...over });

const activity: PricedActivity = {
  slug: "zz-synthetic-safari",
  title: "Synthetic desert safari",
  images: ["/img/synthetic.jpg"],
  price: {
    adult: { inr: 1000, aed: 40 },
    child: { inr: 700, aed: 28 },
    senior: { inr: 900, aed: 36 },
    compareAt: { inr: 1200, aed: 48 },
  },
  variants: [
    { id: "std", name: "Shared", blurb: "", delta: { inr: 0, aed: 0 }, highlights: [], isPrivate: false, recommended: true },
    { id: "private", name: "Private car", blurb: "", delta: { inr: 2000, aed: 80 }, highlights: [], isPrivate: true },
  ],
  addOns: [
    { id: "photo", name: "Photo pack", description: "", price: { inr: 500, aed: 20 }, perPerson: false, category: "photo" },
    { id: "meal", name: "Dinner upgrade", description: "", price: { inr: 300, aed: 12 }, perPerson: true, category: "meal" },
    { id: "water", name: "Water", description: "", price: { inr: 0, aed: 0 }, perPerson: true, category: "comfort" },
  ],
  quoteOnly: false,
  confirmation: "instant",
  fulfilmentMode: "inquiry",
  freeCancellationHours: 24,
  durationMinutes: 360,
} as PricedActivity;

function item(over: Partial<CartItem> = {}): CartItem {
  return {
    id: "x",
    kind: "activity",
    slug: "zz-synthetic-safari",
    title: "Synthetic",
    image: "/img/synthetic.jpg",
    date: "2026-12-01",
    time: "15:00",
    pax: pax({ adult: 1 }),
    addOnIds: [],
    unit: { inr: 1000, aed: 40 },
    total: { inr: 1000, aed: 40 },
    confirmation: "instant",
    fulfilmentMode: "instant",
    freeCancellationHours: 24,
    durationMinutes: 60,
    ...over,
  };
}

describe("cartRequiresInquiry (mixed-cart rule)", () => {
  it("an empty cart routes to inquiry", () => {
    expect(cartRequiresInquiry([])).toBe(true);
  });

  it("an all-instant cart does not", () => {
    expect(cartRequiresInquiry([item(), item({ id: "y" })])).toBe(false);
  });

  it("any inquiry item makes the whole cart an inquiry", () => {
    expect(cartRequiresInquiry([item(), item({ id: "y", fulfilmentMode: "inquiry" })])).toBe(true);
    expect(cartRequiresInquiry([item({ fulfilmentMode: "inquiry" })])).toBe(true);
  });

  it("reads only the item's own fulfilmentMode, not confirmation type", () => {
    // A manual-confirmation instant item still counts as instant here (PRD-1 moves the real check server-side).
    expect(cartRequiresInquiry([item({ confirmation: "manual" })])).toBe(false);
  });
});

describe("computeBreakdown", () => {
  it("prices each pax type from its band, with the recommended variant by default", () => {
    const b = computeBreakdown(activity, pax({ adult: 2, child: 1, senior: 1 }));
    expect(b.lines.map((l) => [l.label, l.amount.inr, l.kind])).toEqual([
      ["Adults × 2", 2000, "base"],
      ["Childs × 1", 700, "base"],
      ["Seniors × 1", 900, "base"],
    ]);
    expect(b.subtotal).toEqual({ inr: 3600, aed: 144 });
    expect(b.total).toEqual(b.subtotal);
    expect(b.discount).toEqual({ inr: 0, aed: 0 });
    expect(b.perPersonFrom).toEqual({ inr: 1000, aed: 40 });
    // compareAt − adult, times billable pax (adult + child + senior).
    expect(b.savings).toEqual({ inr: 800, aed: 32 });
  });

  it("falls back to the adult price when a child or senior band is missing", () => {
    const a = { ...activity, price: { adult: { inr: 1000, aed: 40 } } } as PricedActivity;
    const b = computeBreakdown(a, pax({ child: 1, senior: 1 }));
    expect(b.total).toEqual({ inr: 2000, aed: 80 });
    expect(b.savings).toBeUndefined();
  });

  it("infants with no infant band are free and add nothing", () => {
    const b = computeBreakdown(activity, pax({ adult: 1, infant: 2 }));
    expect(b.lines[1]).toEqual({ label: "Infants × 2", detail: "Free on this experience", amount: { inr: 0, aed: 0 }, kind: "base" });
    expect(b.total).toEqual({ inr: 1000, aed: 40 });
  });

  it("infants with an infant band are charged that band and never the variant delta (current behaviour; PRD-7 will revisit)", () => {
    const a = { ...activity, price: { ...activity.price, infant: { inr: 100, aed: 4 } } } as PricedActivity;
    const b = computeBreakdown(a, pax({ adult: 1, infant: 1 }), "private");
    expect(b.lines[1]).toMatchObject({ label: "Infants × 1", amount: { inr: 100, aed: 4 } });
    expect(b.total).toEqual({ inr: 3100, aed: 124 });
  });

  it("a private variant adds its delta per person, not per vehicle (current behaviour; PRD-7 will revisit)", () => {
    const b = computeBreakdown(activity, pax({ adult: 2, child: 1 }), "private");
    expect(b.lines.map((l) => l.amount.inr)).toEqual([6000, 2700]);
    expect(b.total).toEqual({ inr: 8700, aed: 348 });
    expect(b.perPersonFrom).toEqual({ inr: 3000, aed: 120 });
    // Savings ignore the variant: still (compareAt − adult) × billable.
    expect(b.savings).toEqual({ inr: 600, aed: 24 });
  });

  it("an unknown variant id prices the base band with no delta", () => {
    const b = computeBreakdown(activity, pax({ adult: 1 }), "no-such-variant");
    expect(b.total).toEqual({ inr: 1000, aed: 40 });
  });

  it("add-ons: per-booking once, per-person times billable pax (infants excluded)", () => {
    const b = computeBreakdown(activity, pax({ adult: 2, infant: 1 }), undefined, ["photo", "meal", "water"]);
    const addons = b.lines.filter((l) => l.kind === "addon");
    expect(addons.map((l) => [l.label, l.amount.inr, l.detail])).toEqual([
      ["Photo pack", 500, "Per booking"],
      ["Dinner upgrade", 600, "Per person"],
      ["Water", 0, "No extra charge"],
    ]);
    expect(b.total).toEqual({ inr: 3100, aed: 124 });
  });

  it("ignores add-on ids the activity does not offer", () => {
    expect(computeBreakdown(activity, pax({ adult: 1 }), undefined, ["nope"]).total).toEqual({ inr: 1000, aed: 40 });
  });
});

describe("toCartItem", () => {
  it("snapshots the breakdown, variant and the activity's modes into the cart line", () => {
    const c = toCartItem(activity, { date: "2026-12-01", time: "15:00", pax: pax({ adult: 2 }), variantId: "private", addOnIds: ["photo"] });
    expect(c).toEqual({
      id: "zz-synthetic-safari-2026-12-01-15:00-private",
      kind: "activity",
      slug: "zz-synthetic-safari",
      title: "Synthetic desert safari",
      image: "/img/synthetic.jpg",
      date: "2026-12-01",
      time: "15:00",
      variantId: "private",
      variantName: "Private car",
      pax: pax({ adult: 2 }),
      addOnIds: ["photo"],
      unit: { inr: 3000, aed: 120 },
      total: { inr: 6500, aed: 260 },
      confirmation: "instant",
      fulfilmentMode: "inquiry",
      freeCancellationHours: 24,
      durationMinutes: 360,
      // Doc 30 N4 (review 102 N4-01): the ages the guests were chosen against; the page's own here.
      ages: { childMax: 11, infantMax: 2 },
    });
  });

  it("carries the open-dated ticket fact onto the cart line only when set (review 86 B5-03)", () => {
    expect(toCartItem({ ...activity, openDatedTicket: true }, { date: "2026-12-01", time: "09:00", pax: pax({ adult: 1 }) }).openDatedTicket).toBe(true);
    expect(toCartItem(activity, { date: "2026-12-01", time: "09:00", pax: pax({ adult: 1 }) })).not.toHaveProperty("openDatedTicket");
  });

  it("uses the recommended variant when none is given", () => {
    const c = toCartItem(activity, { date: "2026-12-01", time: "09:00", pax: pax({ adult: 1 }) });
    expect(c.id).toBe("zz-synthetic-safari-2026-12-01-09:00-std");
    expect(c.variantId).toBe("std");
    expect(c.addOnIds).toEqual([]);
  });

  it("uses 'std' in the id when the activity has no variants", () => {
    const a = { ...activity, variants: [] } as PricedActivity;
    const c = toCartItem(a, { date: "2026-12-01", time: "09:00", pax: pax({ adult: 1 }) });
    expect(c.id).toBe("zz-synthetic-safari-2026-12-01-09:00-std");
    expect(c.variantId).toBeUndefined();
    expect(c.variantName).toBeUndefined();
  });
});

describe("applyCoupon", () => {
  it("rejects an unknown code", () => {
    const r = applyCoupon("NOPE", { inr: 10000, aed: 400 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/don't recognise/);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(applyCoupon("  firsttrip ", { inr: 5000, aed: 200 }).ok).toBe(true);
  });

  it("enforces the minimum order and says how far short", () => {
    const r = applyCoupon("DESERT500", { inr: 3500, aed: 140 });
    expect(r).toEqual({ ok: false, message: "DESERT500 needs a minimum order of ₹4,000. You're ₹500 short." });
  });

  it("percent coupons round and cap at ₹2,000; AED is INR ÷ 23.2 rounded", () => {
    const small = applyCoupon("FIRSTTRIP", { inr: 5005, aed: 200 });
    expect(small.ok && small.discount).toEqual({ inr: 501, aed: 22 });
    const capped = applyCoupon("FIRSTTRIP", { inr: 50000, aed: 2000 });
    expect(capped.ok && capped.discount).toEqual({ inr: 2000, aed: 86 });
  });

  it("fixed coupons take their face value", () => {
    const r = applyCoupon("FAMILY7", { inr: 25000, aed: 1000 });
    expect(r.ok && r.discount).toEqual({ inr: 1500, aed: 65 });
    expect(r.message).toBe("FAMILY7 applied — ₹1,500 off.");
  });
});

describe("couponDiscountMinor (paid quotes): authored values only", () => {
  it("INR: same answer as applyCoupon, in minor units", () => {
    const c = couponByCode("firsttrip")!;
    expect(couponDiscountMinor(c, 500_500n, "INR")).toEqual({ ok: true, discountMinor: 50_100n });
    expect(couponDiscountMinor(c, 5_000_000n, "INR")).toEqual({ ok: true, discountMinor: 200_000n });
    expect(couponDiscountMinor(couponByCode("DESERT500")!, 350_000n, "INR")).toEqual({ ok: false, reason: "below_minimum", shortMinor: 50_000n });
  });

  it("no authored AED value: not available in AED, never INR ÷ a rate", () => {
    for (const c of coupons) expect(couponDiscountMinor(c, 10_000_000n, "AED")).toEqual({ ok: false, reason: "not_available_in_currency" });
    expect(authoredCouponValue(couponByCode("FAMILY7")!, "AED")).toBeNull();
  });

  it("an authored AED value applies in AED only (synthetic figures)", () => {
    const fixed: Coupon = { ...couponByCode("DESERT500")!, authored: { AED: { minOrder: 100, off: 7 } } };
    expect(couponDiscountMinor(fixed, 10_000n, "AED")).toEqual({ ok: true, discountMinor: 700n });
    expect(couponDiscountMinor(fixed, 9_900n, "AED")).toEqual({ ok: false, reason: "below_minimum", shortMinor: 100n });
    const pct: Coupon = { ...couponByCode("FIRSTTRIP")!, authored: { AED: { minOrder: 100, off: 30 } } };
    expect(couponDiscountMinor(pct, 20_500n, "AED")).toEqual({ ok: true, discountMinor: 2_100n }); // 10% of 205 = 20.5 → 21
    expect(couponDiscountMinor(pct, 90_000n, "AED")).toEqual({ ok: true, discountMinor: 3_000n }); // capped
  });
});

describe("currency (pinned; full coverage in currency.test.ts)", () => {
  it("display mapping: AE → AED, IN → INR, other located → USD, unknown → AED", () => {
    expect(currencyForCountry("AE")).toBe("AED");
    expect(currencyForCountry("IN")).toBe("INR");
    expect(currencyForCountry("GB")).toBe("USD");
    expect(currencyForCountry(undefined)).toBe("AED");
  });

  it("transactionCurrency records INR or AED only; USD display records AED", () => {
    expect(transactionCurrency("INR")).toBe("INR");
    expect(transactionCurrency("AED")).toBe("AED");
    expect(transactionCurrency("USD")).toBe("AED");
  });
});
