import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuleCostLine } from "../../domain/rule-price";
import { renderTemplate, type TemplateContext } from "../../notifications/templates";
import type { ActivityInput } from "../../schemas/activity.schema";
import { parseClassKey, type CapabilityDimensions } from "../traveldesk/traveldesk.capability";
import { buildListingDraft, NON_REFUNDABLE_POLICY, personLocksBetween, QUOTE_ONLY_LOCK, variantNameLock, variantPriceLock, type BuildContent, type BuildContext } from "../traveldesk/traveldesk.listing-build";
import { instantListing, type PlanOffer, type PlanRules } from "../traveldesk/traveldesk.listing-plan";
import { offerTermsOf, type StoredOffer } from "../traveldesk/traveldesk.offer-terms";
import {
  applyPriceLocks,
  canHoldPrices,
  changedFields,
  classifyOptions,
  digestListings,
  mergeDocument,
  policyFor,
  PRICE_AUTO_LIMIT_BPS,
  priceMoveBps,
  termsDiff,
  UNAVAILABLE_HIDE_AFTER_MS,
  unavailabilityStep,
  type OptionState,
} from "../traveldesk/traveldesk.upkeep";

/**
 * Doc 30 N3: the pure rules of the daily upkeep (D17, D18, D19). Synthetic
 * offers with invented, deliberately odd nets; no supplier data.
 */

const KEY = "live.fixed_slot_single.self.internal.per_person";
const KEY_CHOICE = "live.fixed_slot_choice.self.internal.per_person";
const KEY_PICKUP = "live.fixed_slot_single.pickup_required.internal.per_person";
const LINK = { kind: "instant", classKey: KEY, startMinutes: [1200], arrival: "self", route: "internal", fulfilment: "live" };
const dims = (k: string): CapabilityDimensions => parseClassKey(k)!;

function opt(offerId: number, over: Partial<OptionState> = {}): OptionState {
  return { offerId, variantId: `td-${offerId}`, inDoc: true, soldOutInDoc: false, removed: false, classKey: KEY, dimensions: dims(KEY), startMinutes: [1200], ...over };
}

describe("classifyOptions (one page, one set of facts)", () => {
  it("keeps the options that still share the listing's start set and class; the diverging one is sold out and listed", () => {
    const r = classifyOptions(LINK, [opt(1), opt(2), opt(3, { startMinutes: [1230] })]);
    expect(r.kept).toEqual([1, 2]);
    expect(r.verdicts.find((v) => v.offerId === 3)).toMatchObject({ verdict: "diverged", reason: "start_times" });
    expect(r.signature).toEqual({ classKey: KEY, startMinutes: [1200] });
  });

  it("follows the supplier when every option moved together", () => {
    const r = classifyOptions(LINK, [opt(1, { startMinutes: [1230] }), opt(2, { startMinutes: [1230] })]);
    expect(r.kept).toEqual([1, 2]);
    expect(r.signature.startMinutes).toEqual([1230]);
  });

  it("when no option keeps the current set, the largest group wins, ties to the lowest offer id", () => {
    const r = classifyOptions(LINK, [opt(5, { startMinutes: [600] }), opt(2, { startMinutes: [660] }), opt(9, { startMinutes: [600] })]);
    expect(r.kept).toEqual([5, 9]);
    const tie = classifyOptions(LINK, [opt(5, { startMinutes: [600] }), opt(2, { startMinutes: [660] })]);
    expect(tie.kept).toEqual([2]);
  });

  it("a change to a never-instant shape cannot stay instant; a changed identity diverges; a class change diverges", () => {
    const r = classifyOptions(LINK, [
      opt(1),
      opt(2, { classKey: "inquiry_only", dimensions: null }),
      opt(3, { classKey: "live.fixed_slot_single.self.internal.per_unit", dimensions: dims("live.fixed_slot_single.self.internal.per_unit") }),
      opt(4, { classKey: KEY_PICKUP, dimensions: dims(KEY_PICKUP) }),
      opt(5, { classKey: KEY_CHOICE, dimensions: dims(KEY_CHOICE) }),
    ]);
    expect(Object.fromEntries(r.verdicts.map((v) => [v.offerId, v.verdict]))).toEqual({ 1: "kept", 2: "never_instant", 3: "never_instant", 4: "diverged", 5: "diverged" });
  });

  it("removed offers are marked removed; options a person sold out are left alone; inquiry listings keep every present option", () => {
    const r = classifyOptions(LINK, [opt(1), opt(2, { removed: true }), opt(3, { soldOutInDoc: true, startMinutes: [100] })]);
    expect(r.verdicts.map((v) => v.verdict)).toEqual(["kept", "removed", "inactive"]);
    const q = classifyOptions({ ...LINK, kind: "inquiry", classKey: null, startMinutes: [] }, [opt(1, { classKey: "inquiry_only" }), opt(2, { startMinutes: [9] })]);
    expect(q.kept).toEqual([1, 2]);
  });
});

/* ------------------------------------------------------------------ documents */

const FEES: RuleCostLine[] = [{ name: "gateway", kind: "percent_of_charge", bps: 250 }];
const RULES: PlanRules = { targetBps: 1700, floorBps: 1500, costs: FEES, inrPerAed: "24.10" };

function planOffer(offerId: number, over: Partial<PlanOffer> = {}): PlanOffer {
  const nets = { adult: 12_347n, child: 9_871n, infant: 0n, trip: 0n };
  return {
    offerId, tourId: 77, tourName: "Evening Dhow Cruise", offerName: null, classKey: KEY, dimensions: dims(KEY), reviewReasons: [], gate: { instant: true, reason: null },
    isExternal: false, durationHours: 2, daysOffered: 0, startMinutes: [1200], childrenAllowed: true, childAge: 12, infantsAllowed: true, infantAge: 3,
    supplierUnits: ["adult", "child", "infant"], netAedMinorByUnit: nets, periodsInForce: 1, adultNetRange: { min: nets.adult, max: nets.adult },
    freeCancellationHours: 24, ageBandMismatches: [], slotRulesUnknown: false, catalogueStale: false, activeLinks: [], suggestions: [], ...over,
  };
}

function stored(offerId: number, over: Partial<StoredOffer> = {}): StoredOffer {
  return {
    offerId, tourId: 77, bookingKind: "live_book", bookingTypeRaw: 1, daysOffered: 0, minPax: 1, maxPax: 20, paxLimits: { adults: [1, 20], children: [0, 10], infants: [0, 5] },
    privateType: "sharing", childrenAllowed: true, childAge: 12, infantsAllowed: true, infantAge: 3, isDirectReporting: true, isDirectCollection: false, isExternal: false,
    tripUnit: null, durationHours: 2, timeSlots: [], pricingPeriods: [], ...over,
  };
}

const CONTENT: BuildContent = {
  name: "Evening Dhow Cruise",
  salesDescription: "Sail the creek at sunset on a wooden dhow. Dinner is served on board.\n\nInclusions:\n• Buffet dinner",
  terms: "Bring photo ID.",
  videoUrl: null,
  faq: [],
  itinerary: [],
};
const CTX: BuildContext = { supplier: { name: "TravelDesk", reliability: 80, verifiedSince: "2026-10" }, categorySlug: "cruises-yachts", images: ["https://photos.example.test/test/aa.webp"], takenSlugs: new Set(), siblingCount: 1 };

function draftOf(offers: PlanOffer[], content: BuildContent = CONTENT, overStored: Partial<StoredOffer> = {}): ActivityInput {
  const l = instantListing(77, offers[0].classKey, 1, offers, RULES, new Map([[77, { hasDescription: true, photos: 1, faq: 0, itinerary: 0, warnings: 0, schemaVersion: 1 }]]));
  const b = buildListingDraft(l, new Map(offers.map((o) => [o.offerId, stored(o.offerId, overStored)])), content, CTX);
  if (!b.ok) throw new Error(b.reasons.join(","));
  return b.input;
}

const base = () => draftOf([planOffer(1), planOffer(2, { durationHours: 3 })]);
const ALL = new Set(["td-1", "td-2"]);

function merge(over: Partial<Parameters<typeof mergeDocument>[0]> & { current: ActivityInput }) {
  return mergeDocument({ baseline: over.current as unknown as Record<string, unknown>, draft: null, lockedFields: [], textChanged: false, kept: ALL, soldOut: new Set(), supplierPolicyHours: null, priceMode: "apply", images: null, ...over });
}

describe("mergeDocument (text where unlocked, facts always)", () => {
  it("an unchanged supplier gives an unchanged document (idempotent)", () => {
    const current = base();
    const r = merge({ current, draft: base(), textChanged: true });
    expect(r.next).toEqual(current);
    expect(r.locked).toEqual([]);
  });

  it("supplier text replaces unlocked fields; a field a person changed since the system wrote it is kept and reported", () => {
    const current = base();
    const baseline = structuredClone(current) as unknown as Record<string, unknown>;
    const edited = { ...current, subtitle: "Our own words about the cruise." };
    const draft = draftOf([planOffer(1), planOffer(2, { durationHours: 3 })], { ...CONTENT, salesDescription: "A brand new first sentence from the supplier here. More.\n\nInclusions:\n• Buffet dinner\n• Water" });
    const r = merge({ current: edited, baseline, draft, textChanged: true });
    expect(r.next.subtitle).toBe("Our own words about the cruise.");
    expect(r.locked).toContain("subtitle");
    expect(r.lockedTextChanged).toContain("subtitle");
    expect(r.next.inclusions).toEqual(["Buffet dinner", "Water"]);
  });

  it("facts follow the supplier even without a text change: start times, units, ages and quantities", () => {
    const current = base();
    const draft = draftOf([planOffer(1, { startMinutes: [1230] }), planOffer(2, { durationHours: 3, startMinutes: [1230] })], CONTENT, { paxLimits: { adults: [1, 8], children: [0, 4], infants: [0, 2] } });
    const r = merge({ current, draft });
    expect(r.next.timeSlots).toEqual(["20:30"]);
    expect(r.next.variants[0].units?.find((u) => u.unitId === "adult")?.maxQty).toBe(8);
    expect(r.next.subtitle).toBe(current.subtitle);
  });

  it("marks newly sold-out options and leaves them out of the facts; a person's option name is kept", () => {
    const current = base();
    const named = { ...current, variants: current.variants.map((v, i) => (i === 0 ? { ...v, name: "Sunset sailing" } : v)) };
    const r = merge({ current: named, baseline: current as unknown as Record<string, unknown>, draft: draftOf([planOffer(1)]), kept: new Set(["td-1"]), soldOut: new Set(["td-2"]) });
    expect(r.next.variants.map((v) => [v.id, v.name, v.soldOut ?? false])).toEqual([
      ["td-1", "Sunset sailing", false],
      ["td-2", current.variants[1].name, true],
    ]);
  });

  it("hold keeps the page's prices with the new facts; keep leaves every price-bearing fact", () => {
    const current = base();
    const dearer = draftOf([planOffer(1, { netAedMinorByUnit: { adult: 20_001n, child: 15_003n, infant: 0n, trip: 0n } }), planOffer(2, { durationHours: 3, startMinutes: [1200] })], CONTENT, { paxLimits: { adults: [1, 9], children: [0, 4], infants: [0, 2] } });
    const held = merge({ current, draft: dearer, priceMode: "hold" });
    expect(held.next.price).toEqual(current.price);
    expect(held.next.variants[0].units?.find((u) => u.unitId === "adult")).toMatchObject({ maxQty: 9, price: current.variants[0].units!.find((u) => u.unitId === "adult")!.price });
    const kept = merge({ current, draft: dearer, priceMode: "keep" });
    expect(kept.next).toEqual(current);
  });

  it("rewrites a free-cancellation text to the supplier's new hours; non-refundable stays as it is", () => {
    expect(policyFor("Free cancellation up to 24 hours before the start time", 24, 48)).toEqual({ text: "Free cancellation up to 48 hours before the start time", hours: 48 });
    expect(policyFor("Free cancellation up to 24 hours before the start time", 24, 0)).toEqual({ text: NON_REFUNDABLE_POLICY, hours: 0 });
    expect(policyFor("Cancel a day ahead for a refund", 24, 48)).toEqual({ text: NON_REFUNDABLE_POLICY, hours: 0 });
    expect(policyFor(NON_REFUNDABLE_POLICY, 0, 48)).toBeNull();
    expect(policyFor("Free cancellation up to 24 hours before", 24, 24)).toBeNull();
  });

  it("names changed fields by kind", () => {
    const current = base();
    const next = { ...current, subtitle: "x".repeat(30), timeSlots: ["21:00"], price: { ...current.price, adult: { aed: 1, inr: 24 } } };
    expect(changedFields(current, next)).toEqual([
      { field: "price", kind: "price" },
      { field: "subtitle", kind: "text" },
      { field: "timeSlots", kind: "fact" },
    ]);
  });
});

describe("price rule (D18)", () => {
  it("measures the largest unit move; up to 20% is automatic", () => {
    const current = base();
    expect(priceMoveBps(current, base(), ALL)).toBe(0);
    const up = draftOf([planOffer(1, { netAedMinorByUnit: { adult: 14_000n, child: 9_871n, infant: 0n, trip: 0n } }), planOffer(2, { durationHours: 3 })]);
    const move = priceMoveBps(current, up, ALL);
    expect(move).toBeGreaterThan(0);
    expect(move).toBeLessThanOrEqual(PRICE_AUTO_LIMIT_BPS);
    const jump = draftOf([planOffer(1, { netAedMinorByUnit: { adult: 20_001n, child: 9_871n, infant: 0n, trip: 0n } }), planOffer(2, { durationHours: 3 })]);
    expect(priceMoveBps(current, jump, ALL)).toBeGreaterThan(PRICE_AUTO_LIMIT_BPS);
  });

  it("cannot hold prices when a unit appears that has no price today", () => {
    const current = draftOf([planOffer(1, { supplierUnits: ["adult"], netAedMinorByUnit: { adult: 12_347n, child: 0n, infant: 0n, trip: 0n } })], CONTENT, { infantsAllowed: false, childrenAllowed: false });
    const withChild = draftOf([planOffer(1)]);
    expect(canHoldPrices(current, withChild, new Set(["td-1"]))).toBe(false);
    expect(canHoldPrices(withChild, withChild, new Set(["td-1"]))).toBe(true);
  });
});

describe("terms diff (D17: each changed term by name, old and new)", () => {
  const tour = { tourId: 77, cancellationPolicy: [{ moreThanHours: 24, refundPercent: 100 }] };
  const slot = { timeSlotId: 1, startMinutes: 1200, endMinutes: 1320, daysOffered: 0, isAnyTime: false, isOnRequest: false, minimumAdvancedBookingHours: 12, isExternal: false };
  it("names child age and slot changes; nothing else", () => {
    const a = offerTermsOf({ ...stored(1), timeSlots: [slot] }, tour);
    const b = offerTermsOf({ ...stored(1), childAge: 10, timeSlots: [{ ...slot, startMinutes: 1230, endMinutes: 1350 }] }, tour);
    const d = termsDiff(a, b);
    expect(d.map((x) => x.field)).toEqual(["pax.childAge", "slots"]);
    expect(d[0]).toEqual({ field: "pax.childAge", before: 12, after: 10 });
    expect(String((d[1].after as string[])[0])).toContain("20:30-22:30");
  });
  it("says so when no earlier record exists", () => {
    expect(termsDiff(null, offerTermsOf(stored(1), tour))).toEqual([{ field: "terms", before: "not recorded", after: "recorded now" }]);
  });
});

describe("removed tours (D19)", () => {
  const now = new Date("2026-12-20T00:00:00Z");
  it("marks, waits 14 days, hides; clears when the tour is back; a hidden listing stays hidden", () => {
    expect(unavailabilityStep({ unavailableSince: null, hiddenAt: null }, true, now)).toBe("mark");
    expect(unavailabilityStep({ unavailableSince: new Date(now.getTime() - UNAVAILABLE_HIDE_AFTER_MS + 1), hiddenAt: null }, true, now)).toBe("none");
    expect(unavailabilityStep({ unavailableSince: new Date(now.getTime() - UNAVAILABLE_HIDE_AFTER_MS), hiddenAt: null }, true, now)).toBe("hide");
    expect(unavailabilityStep({ unavailableSince: new Date(now.getTime() - 1000), hiddenAt: null }, false, now)).toBe("clear");
    expect(unavailabilityStep({ unavailableSince: new Date(0), hiddenAt: new Date(1) }, false, now)).toBe("none");
  });
});

describe("digest (D17)", () => {
  it("groups lines per listing, names kinds and fields, never values", () => {
    const g = digestListings([
      { slug: "b-cruise", title: "B cruise", kind: "price", field: "price", status: "applied", offerExternalId: null },
      { slug: "a-safari", title: "A safari", kind: "price_jump", field: "", status: "review", offerExternalId: null },
      { slug: "b-cruise", title: "B cruise", kind: "diverged", field: "td-9", status: "review", offerExternalId: "9" },
    ]);
    expect(g.listings.map((l) => l.slug)).toEqual(["a-safari", "b-cruise"]);
    expect(g.listings[1].lines).toEqual(["price updated (price)", "option no longer matches its listing: sold out, waits for a person (td-9)"]);
    const ctx = { environment: "test", day: "2026-11-25", changeCount: 3, reviewCount: 2, listings: g.listings, moreListings: 0, adminUrl: "https://outly.example.test/admin/suppliers/traveldesk/changes" } as unknown as TemplateContext;
    const r = renderTemplate("TRAVELDESK_UPKEEP_DIGEST", "email", ctx);
    expect(r.subject).toBe("[OUTLY OWNER] TravelDesk changes 2026-11-25: 3 (2 to review)");
    expect(r.text).toContain("B cruise (b-cruise)");
    expect(r.html).toContain("Open in admin");
  });
});

describe("the upkeep never writes orders, quotes or bookings (existing bookings keep their terms)", () => {
  it("names no order, quote or booking table", () => {
    const src = readFileSync(join(process.cwd(), "src/server/services/traveldesk-upkeep.service.ts"), "utf8");
    expect(src).not.toMatch(/\b(tx|prisma)\.(order|orderItem|quote|supplierBooking|payment)\b/);
    // Never the content table's `raw` column (review 103 N0-06).
    expect(src).not.toMatch(/raw:\s*true/);
  });
});

describe("review 108 fixes: stored person locks, quote only, price lock upward, INR, policy", () => {
  const asRec = (d: ActivityInput) => d as unknown as Record<string, unknown>;

  it("N3-01: an option name a person changed stays over any number of rebases", () => {
    const sys = base();
    const renamed = { ...sys, variants: sys.variants.map((v, i) => (i === 0 ? { ...v, name: "Sunset sailing" } : v)) };
    const locks = personLocksBetween(asRec(sys), asRec(renamed));
    expect(locks).toContain(variantNameLock("td-1"));
    // Run 1 keeps it and rebases (the new baseline holds the person's name).
    const r1 = merge({ current: renamed, baseline: asRec(sys), draft: base(), lockedFields: locks });
    expect(r1.next.variants[0].name).toBe("Sunset sailing");
    // Run 2: baseline equals current, so only the stored lock can keep the name.
    const r2 = merge({ current: r1.next, baseline: asRec(r1.next), draft: base(), lockedFields: r1.locked });
    expect(r2.next.variants[0].name).toBe("Sunset sailing");
    // Without the stored lock the fact-built name would come back: the lock is what holds it.
    expect(merge({ current: r1.next, baseline: asRec(r1.next), draft: base(), lockedFields: [] }).next.variants[0].name).not.toBe("Sunset sailing");
  });

  it("N3-02: holding prices keeps quote only, so an inquiry page never shows a price of 0", () => {
    const current = { ...base(), quoteOnly: true, price: { adult: { aed: 0, inr: 0 } } } as ActivityInput;
    const r = merge({ current, draft: base(), priceMode: "hold" });
    expect(r.next.quoteOnly).toBe(true);
    expect(r.next.price.adult).toEqual({ aed: 0, inr: 0 });
  });

  it("N3-03: a quote-only switch a person set is never removed", () => {
    const sys = base();
    const person = { ...sys, quoteOnly: true } as ActivityInput;
    expect(personLocksBetween(asRec(sys), asRec(person))).toContain(QUOTE_ONLY_LOCK);
    const r = merge({ current: person, baseline: asRec(person), draft: base(), lockedFields: [QUOTE_ONLY_LOCK] });
    expect(r.next.quoteOnly).toBe(true);
    // A system quote-only (no lock) follows the draft's applied prices.
    expect(merge({ current: person, baseline: asRec(person), draft: base(), lockedFields: [] }).next.quoteOnly).toBeUndefined();
  });

  it("N3-14: a price a person raised is never lowered; the rule may raise it", () => {
    const sys = base();
    const bump = 30;
    const raised = structuredClone(sys);
    raised.variants[0].delta = { aed: sys.variants[0].delta.aed + bump, inr: sys.variants[0].delta.inr + bump * 25 };
    raised.variants[0].units = raised.variants[0].units!.map((u) => (u.unitId === "infant" ? u : { ...u, price: { aed: u.price.aed + bump, inr: u.price.inr + bump * 25 } }));
    const lock = personLocksBetween(asRec(sys), asRec(raised));
    expect(lock).toContain(variantPriceLock("td-1"));
    const fitted = applyPriceLocks(raised, base(), new Set(lock), ALL)!;
    expect(fitted).not.toBeNull();
    const adult = (d: ActivityInput) => d.variants[0].units!.find((u) => u.unitId === "adult")!.price;
    expect(adult(fitted)).toEqual(adult(raised));
    // Unlocked option: the rule price.
    expect(fitted.variants[1].units).toEqual(base().variants[1].units);
    // A rule above the person's price wins.
    const dearer = draftOf([planOffer(1, { netAedMinorByUnit: { adult: 40_000n, child: 30_000n, infant: 0n, trip: 0n } }), planOffer(2, { durationHours: 3 })]);
    const up = applyPriceLocks(raised, dearer, new Set(lock), ALL);
    if (up) expect(adult(up).aed).toBeGreaterThanOrEqual(adult(dearer).aed);
    // Lowering a price locks nothing (locked upward only).
    const lowered = structuredClone(sys);
    lowered.variants[0].units = lowered.variants[0].units!.map((u) => ({ ...u, price: { aed: Math.max(0, u.price.aed - 5), inr: Math.max(0, u.price.inr - 100) } }));
    expect(personLocksBetween(asRec(sys), asRec(lowered))).not.toContain(variantPriceLock("td-1"));
  });

  it("N3-13: an INR-only move counts", () => {
    const current = base();
    const inr = structuredClone(current);
    inr.variants[0].units = inr.variants[0].units!.map((u) => ({ ...u, price: { ...u.price, inr: Math.round(u.price.inr * 1.5) } }));
    expect(priceMoveBps(current, inr, ALL)).toBeGreaterThan(PRICE_AUTO_LIMIT_BPS);
  });

  it("N3-11: every stated hour is rewritten, or the text becomes non-refundable", () => {
    expect(policyFor("Free cancellation up to 24 hours before; after 24 hours no refund", 24, 48)).toEqual({ text: "Free cancellation up to 48 hours before; after 48 hours no refund", hours: 48 });
    expect(policyFor("Free cancellation up to 24 hours before; 12 hours notice for changes", 24, 48)).toEqual({ text: NON_REFUNDABLE_POLICY, hours: 0 });
  });

  it("N3-10: a locked field is reported only when the supplier's own text moved", () => {
    const sys = base();
    const edited = { ...sys, subtitle: "Our own words about the cruise." };
    const first = merge({ current: edited, baseline: asRec(sys), draft: base(), textChanged: true, lockedFields: ["subtitle"] });
    // Supplier content moved but the subtitle's supplier value did not: no report.
    const again = merge({ current: first.next, baseline: asRec(first.next), draft: base(), textChanged: true, lockedFields: ["subtitle"], prevTextHashes: first.textHashes! });
    expect(again.lockedTextChanged).not.toContain("subtitle");
    const moved = draftOf([planOffer(1), planOffer(2, { durationHours: 3 })], { ...CONTENT, salesDescription: "A completely different opening line from TravelDesk now. More." });
    const third = merge({ current: first.next, baseline: asRec(first.next), draft: moved, textChanged: true, lockedFields: ["subtitle"], prevTextHashes: first.textHashes! });
    expect(third.lockedTextChanged).toContain("subtitle");
  });
});
