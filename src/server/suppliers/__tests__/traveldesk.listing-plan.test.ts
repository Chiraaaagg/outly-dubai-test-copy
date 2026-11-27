import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { offerPaxAges, PAGE_PAX_AGES, unitAgesFor, variantPaxAges } from "@/lib/pax-ages";
import { ageBandMismatches, ownAgeMismatches } from "../traveldesk/traveldesk.quote";
import { meetsFloor, ruleAedPrice, ruleInrPrice, type RuleCostLine } from "../../domain/rule-price";
import { parseClassKey, type CapabilityDimensions } from "../traveldesk/traveldesk.capability";
import { buildListingPlan, neverInstantReason, stepOfClassKey, type PlanOffer, type PlanRules, type PlanTourContent } from "../traveldesk/traveldesk.listing-plan";

/**
 * Doc 30 N0 dry run: the listing plan. Synthetic offers and invented round
 * nets only; the ledger test reads the committed coverage ledger (which holds
 * no prices) and checks the plan's counts against doc 30 §1.4 and §2.1.
 */

const KEY_S0 = "live.fixed_slot_single.self.internal.per_person";
const KEY_S0_CHOICE = "live.fixed_slot_choice.self.internal.per_person";
const KEY_PICKUP = "live.fixed_slot_single.pickup_required.internal.per_person";
const KEY_PER_UNIT = "live.fixed_slot_single.pickup_required.internal.per_unit";

function dims(classKey: string): CapabilityDimensions {
  return parseClassKey(classKey) ?? { fulfilment: classKey === "inquiry_only" ? "on_request" : "unknown", timeShape: "unknown", arrival: "self", route: "internal", pricingUnit: "unknown" };
}

function offer(over: Partial<PlanOffer> & { offerId: number }): PlanOffer {
  const classKey = over.classKey ?? KEY_S0;
  return {
    tourId: 1,
    tourName: "Synthetic tour",
    offerName: `Synthetic offer ${over.offerId}`,
    classKey,
    dimensions: dims(classKey),
    reviewReasons: [],
    gate: { instant: true, reason: null },
    isExternal: false,
    durationHours: 2,
    daysOffered: 0,
    startMinutes: [1200],
    childrenAllowed: true,
    childAge: 12,
    infantsAllowed: true,
    infantAge: 3,
    supplierUnits: ["adult", "child", "infant"],
    netAedMinorByUnit: { adult: 10_000n, child: 8_000n, infant: 0n, trip: 0n },
    periodsInForce: 1,
    adultNetRange: { min: 10_000n, max: 10_000n },
    freeCancellationHours: 24,
    ageBandMismatches: [],
    slotRulesUnknown: false,
    catalogueStale: false,
    activeLinks: [],
    suggestions: [],
    ...over,
  };
}

const NO_COSTS: RuleCostLine[] = [];
const RULES: PlanRules = { targetBps: 1700, floorBps: 1500, costs: NO_COSTS, inrPerAed: "24.10" };
const CONTENT: Map<number, PlanTourContent> = new Map([[1, { hasDescription: true, photos: 3, faq: 0, itinerary: 0, warnings: 0, schemaVersion: 1 }]]);
const plan = (offers: PlanOffer[], rules: PlanRules = RULES) => buildListingPlan(offers, { rules, flagsOn: new Set([KEY_S0]), content: CONTENT });

describe("rule price (doc 30 §3.6, D7)", () => {
  const fee: RuleCostLine[] = [{ name: "gateway", kind: "percent_of_charge", bps: 250 }];

  it("is the lowest whole AED keeping 17% after fees", () => {
    expect(ruleAedPrice(10_000n, fee)).toBe(125n);
    // One dirham less misses the target.
    expect(meetsFloor({ priceMajor: 124n, currency: "AED", netAedMinor: 10_000n, costs: fee, floorBps: 1700, inrPerAed: null })).toBe(false);
    expect(meetsFloor({ priceMajor: 125n, currency: "AED", netAedMinor: 10_000n, costs: fee, floorBps: 1700, inrPerAed: null })).toBe(true);
  });

  it("prices a free unit at 0 and refuses when fees plus target reach 100%", () => {
    expect(ruleAedPrice(0n, NO_COSTS)).toBe(0n);
    expect(ruleAedPrice(10_000n, [{ name: "x", kind: "percent_of_charge", bps: 8_300 }])).toBeNull();
  });

  it("includes fixed costs", () => {
    const withFixed: RuleCostLine[] = [{ name: "per booking", kind: "fixed_aed", aedMinor: "500" }];
    const p = ruleAedPrice(10_000n, withFixed)!;
    expect(meetsFloor({ priceMajor: p, currency: "AED", netAedMinor: 10_000n, costs: withFixed, floorBps: 1700, inrPerAed: null })).toBe(true);
    expect(meetsFloor({ priceMajor: p - 1n, currency: "AED", netAedMinor: 10_000n, costs: withFixed, floorBps: 1700, inrPerAed: null })).toBe(false);
  });

  it("rounds INR up to a whole rupee and passes the 15% floor in INR", () => {
    expect(ruleInrPrice(125n, "24.10")).toBe(3013n);
    expect(meetsFloor({ priceMajor: 3013n, currency: "INR", netAedMinor: 10_000n, costs: fee, floorBps: 1500, inrPerAed: "24.10" })).toBe(true);
  });
});

describe("listing plan (doc 30 §3.3)", () => {
  it("assigns steps by exact class key and names never-instant reasons", () => {
    expect(stepOfClassKey(KEY_S0)).toBe("S0");
    expect(stepOfClassKey(KEY_PICKUP)).toBe("S1");
    expect(stepOfClassKey("ticket.open_dated.self.internal.per_person")).toBe("S4");
    expect(stepOfClassKey(KEY_PER_UNIT)).toBeNull();
    expect(neverInstantReason(KEY_PER_UNIT)).toBe("private_units_inquiry");
    expect(neverInstantReason("inquiry_only")).toBe("on_request");
    expect(neverInstantReason("unknown")).toBe("class_unknown");
  });

  it("splits a tour's options of one class key by start-time set, numbered by earliest start", () => {
    const p = plan([
      offer({ offerId: 1, classKey: KEY_S0_CHOICE, startMinutes: [1200, 1260] }),
      offer({ offerId: 2, classKey: KEY_S0_CHOICE, startMinutes: [540, 600] }),
      offer({ offerId: 3, classKey: KEY_S0_CHOICE, startMinutes: [1200, 1260] }),
    ]);
    const listings = p.listings.filter((l) => l.kind === "instant");
    expect(listings.map((l) => [l.splitNumber, l.startTimes, l.options.map((o) => o.optionId)])).toEqual([
      [1, ["09:00", "10:00"], ["td-2"]],
      [2, ["20:00", "21:00"], ["td-1", "td-3"]],
    ]);
    expect(p.steps[0]).toMatchObject({ instantListingsByTourAndKey: 1, instantListings: 2, extraForStartTimes: 1, offers: 3, flagsOn: [KEY_S0] });
  });

  it("puts a mixed tour's never-instant offers on one inquiry listing per arrival and fulfilment, in the tour's first step", () => {
    const p = plan([
      offer({ offerId: 1, classKey: KEY_PICKUP }),
      offer({ offerId: 2, classKey: KEY_PER_UNIT }),
      offer({ offerId: 3, classKey: "inquiry_only", dimensions: { ...dims("inquiry_only"), arrival: "pickup_required" } }),
      offer({ offerId: 4, tourId: 2, classKey: KEY_PER_UNIT }),
    ]);
    const inquiry = p.listings.filter((l) => l.kind === "inquiry");
    expect(inquiry.map((l) => [l.key, l.step, l.options.map((o) => o.offerId)])).toEqual([
      ["1:inquiry:pickup_required:live", "S1", [2]],
      ["1:inquiry:pickup_required:on_request", "S1", [3]],
    ]);
    expect(p.notImported).toEqual({ tours: 1, offers: 1, tourIds: [2] });
    expect(p.neverInstant).toEqual({ private_units_inquiry: 2, on_request: 1 });
  });

  it("uses one adult-to-child gap per listing, the smallest, and reports what it adds to each child price (D10)", () => {
    const p = plan([
      offer({ offerId: 1, classKey: KEY_S0_CHOICE, startMinutes: [1200, 1260], netAedMinorByUnit: { adult: 10_000n, child: 8_000n, infant: 0n, trip: 0n } }),
      offer({ offerId: 2, classKey: KEY_S0_CHOICE, startMinutes: [1200, 1260], netAedMinorByUnit: { adult: 20_000n, child: 12_000n, infant: 0n, trip: 0n } }),
    ]);
    const [l] = p.listings;
    const a = { adult: ruleAedPrice(10_000n, NO_COSTS)!, child: ruleAedPrice(8_000n, NO_COSTS)! };
    const b = { adult: ruleAedPrice(20_000n, NO_COSTS)!, child: ruleAedPrice(12_000n, NO_COSTS)! };
    const gap = a.adult - a.child < b.adult - b.child ? a.adult - a.child : b.adult - b.child;
    expect(l.childGap?.aed).toBe(gap.toString());
    expect(l.options[0].childEffect?.aed).toBe("0");
    expect(l.options[1].childUnderGap?.aed).toBe((b.adult - gap).toString());
    expect(l.options[1].childEffect?.aed).toBe((b.adult - gap - b.child).toString());
    // INR gap after rounding, and every price passes the floor in both currencies.
    expect(Number(l.childGap?.inr)).toBe(Math.min(...[a, b].map((x) => Number(ruleInrPrice(x.adult, "24.10") - ruleInrPrice(x.child, "24.10")))));
    expect(l.options.every((o) => o.floorOk === true)).toBe(true);
    expect(l.fromPrice).toEqual({ aed: a.adult.toString(), inr: ruleInrPrice(a.adult, "24.10").toString() });
  });

  it("lists blockers: capability, review, age band, stale, linked, missing price inputs and content", () => {
    const p = plan(
      [
        offer({
          offerId: 1,
          tourId: 9,
          gate: { instant: false, reason: "flag_off" },
          reviewReasons: ["slot_units_unexplained"],
          ageBandMismatches: ["child"],
          catalogueStale: true,
          activeLinks: [{ productId: "p1", slug: "old-dhow" }],
        }),
      ],
      { ...RULES, costs: null, floorBps: null },
    );
    const [l] = p.listings;
    expect(l.options[0].blockers).toEqual([
      "already_linked",
      "capability:flag_off",
      "review:slot_units_unexplained",
      "age_band:child",
      "catalogue_stale",
      "cost_inputs_missing",
      "margin_policy_missing",
    ]);
    expect(l.options[0].rulePrice.adult).toBeNull();
    expect(l.blockers).toEqual(["content_missing"]);
    expect(l.adoptProduct).toEqual({ productId: "p1", slug: "old-dhow" });
    expect(p.duplicates.linkedOffers).toEqual([{ offerId: 1, tourId: 9, products: [{ productId: "p1", slug: "old-dhow" }] }]);
    expect(p.steps[0].alreadyLinkedOffers).toBe(1);
  });

  it("reports seasonal offers at their peak net, dropped free cancellation, differing days and ages, and shared old pages", () => {
    const old = { productId: "p9", slug: "old-page", title: "Old page", score: 70, state: "suggested" };
    const p = plan([
      offer({ offerId: 1, periodsInForce: 2, adultNetRange: { min: 9_000n, max: 10_000n }, suggestions: [old], daysOffered: 1 + 4 }),
      offer({ offerId: 2, classKey: KEY_PICKUP, suggestions: [{ ...old, score: 80 }], childAge: 10 }),
    ]);
    const s0 = p.listings.find((l) => l.classKey === KEY_S0)!;
    expect(s0.options[0].seasonal).toEqual({ periods: 2, minAdultNetAedMinor: "9000", peakAdultNetAedMinor: "10000" });
    expect(s0.seasonalOptions).toBe(1);
    expect(s0.freeCancellationDropped).toBe(true);
    expect(s0.days).toEqual({ masks: [5], everyDay: false, differ: false });
    expect(p.duplicates.sharedOldPages).toEqual([{ productId: "p9", slug: "old-page", listingKeys: [`1:${KEY_PICKUP}:1`, `1:${KEY_S0}:1`] }]);
    expect(s0.agesDiffer).toBe(false);
    const mixedAges = plan([offer({ offerId: 1 }), offer({ offerId: 2, childAge: 10 })]);
    expect(mixedAges.listings[0].agesDiffer).toBe(true);
  });

  it("checks every AED price against the floor even without an INR rate (review 103 N0-07)", () => {
    // Floor above the 17% target: adult and child AED prices both miss it; no rate, so INR is unknown.
    const p = plan([offer({ offerId: 1 })], { ...RULES, floorBps: 1_800, inrPerAed: null });
    expect(p.listings[0].options[0].floorOk).toBe(false);
    expect(p.listings[0].options[0].blockers).toContain("margin_below_floor");
    expect(p.listings[0].options[0].blockers).toContain("fx_input_missing");
    expect(plan([offer({ offerId: 1 })], { ...RULES, inrPerAed: null }).listings[0].options[0].floorOk).toBeNull();
  });

  it("says when no price can keep the margin (review 103 N0-08)", () => {
    const p = plan([offer({ offerId: 1 })], { ...RULES, costs: [{ name: "fee", kind: "percent_of_charge", bps: 8_300 }] });
    expect(p.listings[0].options[0].rulePrice.adult).toBeNull();
    expect(p.listings[0].options[0].blockers).toContain("price_unreachable");
  });

  it("flags external listings: the payload does not name the provider", () => {
    const p = plan([offer({ offerId: 1, classKey: "live.fixed_slot_single.self.external.per_person", isExternal: true })]);
    expect(p.listings[0].step).toBe("S2");
    expect(p.listings[0].externalProvider?.named).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * Ledger check: the plan's counts equal doc 30 §1.4 / §2.1
 * ------------------------------------------------------------------------ */

const LEDGER = path.join(process.cwd(), "docs/backend/29a-offer-coverage-ledger.csv");

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  const [header, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

describe.skipIf(!existsSync(LEDGER))("listing plan against the coverage ledger of 22 November (doc 30 §1.4, §2.1)", () => {
  it("creates the listings the plan's tables count, per step and in total", () => {
    const rows = parseCsv(readFileSync(LEDGER, "utf8"));
    const offers = rows.map((r) =>
      offer({
        offerId: Number(r.offerId),
        tourId: Number(r.tourId),
        classKey: r.targetCapabilityClass,
        dimensions: {
          fulfilment: r.dimFulfilment as CapabilityDimensions["fulfilment"],
          timeShape: r.dimTimeShape as CapabilityDimensions["timeShape"],
          arrival: r.dimArrival as CapabilityDimensions["arrival"],
          route: r.dimRoute as CapabilityDimensions["route"],
          pricingUnit: r.dimPricingUnit as CapabilityDimensions["pricingUnit"],
        },
        // The ledger has no start times or prices: no start-time splits are counted here (N0 counts them from the stored catalogue).
        startMinutes: null,
      }),
    );
    const p = buildListingPlan(offers, { rules: RULES, flagsOn: new Set(), content: new Map() });
    const table = Object.fromEntries(p.steps.map((s) => [s.id, [s.offers, s.instantListings, s.inquiryListings, s.inquiryOffers]]));
    expect(table).toEqual({
      S0: [16, 8, 2, 4],
      S1: [43, 25, 12, 22],
      S2: [57, 20, 9, 28],
      S3: [2, 2, 0, 0],
      S4: [54, 36, 3, 6],
      S5: [24, 4, 1, 2],
    });
    expect(p.totals).toMatchObject({ offers: 317, stepOffers: 196, instantListings: 95, inquiryListings: 27, inquiryOffers: 62, neverInstant: 121 });
    expect(p.notImported).toMatchObject({ tours: 25, offers: 59 });
  });

  it("N4 (review 109 INT-01): the 36 offers the page bands blocked carry no age blocker under their own bands", () => {
    const rows = parseCsv(readFileSync(LEDGER, "utf8"));
    const ages = (r: Record<string, string>) => ({ childrenAllowed: r.childrenAllowed === "true", childAge: Number(r.childUnderAge) || 0, infantsAllowed: r.infantsAllowed === "true", infantAge: Number(r.infantUnderAge) || 0 });
    const inStep = rows.filter((r) => stepOfClassKey(r.targetCapabilityClass));
    const pageBlocked = inStep.filter((r) => ageBandMismatches(ages(r), PAGE_PAX_AGES).length > 0);
    expect(pageBlocked).toHaveLength(36);
    expect(pageBlocked.filter((r) => ownAgeMismatches(ages(r)).length > 0)).toEqual([]);
    // And what the importer writes reads back as the same bands, which the supplier check accepts.
    for (const r of pageBlocked) {
      const bands = offerPaxAges(ages(r))!;
      const variant = { units: (["adult", "child", "infant"] as const).map((u) => ({ unitId: u, per: "person" as const, ...unitAgesFor(bands, u) })) };
      expect(ageBandMismatches(ages(r), variantPaxAges(variant as never)!)).toEqual([]);
    }
  });
});
