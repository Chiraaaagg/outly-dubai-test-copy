import { describe, expect, it } from "vitest";
import { pageUnitPrice } from "@/lib/pricing";
import type { Activity } from "@/lib/types";
import { meetsFloor, type RuleCostLine } from "../../domain/rule-price";
import { activityInputSchema, buildActivityContent } from "../../schemas/activity.schema";
import { assessReadiness, policyTextAgrees, pickupAgrees, unitRestricted } from "../../services/readiness.service";
import { parseClassKey, type CapabilityDimensions } from "../traveldesk/traveldesk.capability";
import { buildListingDraft, lockedFieldsBetween, NON_REFUNDABLE_POLICY, PENDING_TEXT, type BuildContent, type BuildContext } from "../traveldesk/traveldesk.listing-build";
import { buildListingPlan, type PlannedListing, type PlanOffer, type PlanRules } from "../traveldesk/traveldesk.listing-plan";
import type { StoredOffer } from "../traveldesk/traveldesk.offer-terms";
import { categoryFor, cleanText, cleanTitle, daysLine, describe as describeText, optionNames } from "../traveldesk/traveldesk.text-rules";

/**
 * Doc 30 N1: the text rule file (D13) and the draft builder (§3.4, §3.6).
 * Synthetic offers with invented, deliberately odd nets (so a leak would be
 * recognisable); no supplier data.
 */

const KEY_S0 = "live.fixed_slot_single.self.internal.per_person";
const KEY_PICKUP = "live.fixed_slot_single.pickup_required.internal.per_person";
const KEY_ON_REQUEST = "inquiry_only";

function dims(classKey: string): CapabilityDimensions {
  return parseClassKey(classKey) ?? { fulfilment: "on_request", timeShape: "unknown", arrival: "self", route: "internal", pricingUnit: "per_person" };
}

/** Distinctive nets: AED 123.47 adult, AED 98.71 child. */
const NETS = { adult: 12_347n, child: 9_871n, infant: 0n, trip: 0n };

function planOffer(over: Partial<PlanOffer> & { offerId: number }): PlanOffer {
  const classKey = over.classKey ?? KEY_S0;
  return {
    tourId: 77,
    tourName: "Evening Dhow Cruise (Russian-Speaking Guide) TD-4411",
    offerName: "Dhow cruise (Russian-Speaking Guide)",
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
    netAedMinorByUnit: NETS,
    periodsInForce: 1,
    adultNetRange: { min: NETS.adult, max: NETS.adult },
    freeCancellationHours: 24,
    ageBandMismatches: [],
    slotRulesUnknown: false,
    catalogueStale: false,
    activeLinks: [],
    suggestions: [],
    ...over,
  };
}

function stored(offerId: number, over: Partial<StoredOffer> = {}): StoredOffer {
  return {
    offerId,
    tourId: 77,
    bookingKind: "live_book",
    bookingTypeRaw: 1,
    daysOffered: 0,
    minPax: 1,
    maxPax: 20,
    paxLimits: { adults: [1, 20], children: [0, 10], infants: [0, 5] },
    privateType: "sharing",
    childrenAllowed: true,
    childAge: 12,
    infantsAllowed: true,
    infantAge: 3,
    isDirectReporting: true,
    isDirectCollection: false,
    isExternal: false,
    tripUnit: null,
    durationHours: 2,
    timeSlots: [],
    pricingPeriods: [],
    ...over,
  };
}

const FEES: RuleCostLine[] = [{ name: "gateway", kind: "percent_of_charge", bps: 250 }];
const RULES: PlanRules = { targetBps: 1700, floorBps: 1500, costs: FEES, inrPerAed: "24.10" };

function plan(offers: PlanOffer[], rules: PlanRules = RULES) {
  return buildListingPlan(offers, { rules, flagsOn: new Set([KEY_S0, KEY_PICKUP]), content: new Map([[77, { hasDescription: true, photos: 2, faq: 1, itinerary: 1, warnings: 0, schemaVersion: 1 }]]) });
}

const CONTENT: BuildContent = {
  name: "Evening Dhow Cruise (Russian-Speaking Guide) TD-4411",
  salesDescription: "Sail the creek at sunset on a wooden dhow. Dinner is served on board.\n\nInclusions:\n• Buffet dinner\n• Soft drinks\n\nNot included:\n• Hotel transfers",
  terms: "Bring photo ID.\nDress code: smart casual.",
  videoUrl: null,
  faq: [{ question: "Is dinner vegetarian?", answer: "Vegetarian dishes are served." }],
  itinerary: [{ position: 1, title: "Boarding", description: "Board at the marina." }],
};

const CTX: BuildContext = {
  supplier: { name: "TravelDesk", reliability: 80, verifiedSince: "2026-10" },
  categorySlug: "cruises-yachts",
  images: ["https://photos.example.test/test/aa.webp"],
  takenSlugs: new Set(),
  siblingCount: 1,
};

const offersMap = (ids: number[], over: Partial<StoredOffer> = {}) => new Map(ids.map((id) => [id, stored(id, over)]));

function asActivity(input: ReturnType<typeof activityInputSchema.parse>): Activity {
  return buildActivityContent(input, { id: "x", rating: 0, reviewCount: 0, bookedThisMonth: 0 }) as Activity;
}

describe("text rules (doc 30 §3.7, D13)", () => {
  it("moves language tags out of the title, drops internal codes and fixes listed typos", () => {
    expect(cleanTitle("Evening Dhow Cruise (Russian-Speaking Guide) TD-4411")).toEqual({ title: "Evening Dhow Cruise", languages: ["Russian"] });
    expect(cleanTitle("Hot Air Ballon Ride [Arabic] (Code: SIC-12)")).toEqual({ title: "Hot Air Balloon Ride", languages: ["Arabic"] });
    expect(cleanTitle("Desert Safari - English Speaking Guide #123").title).toBe("Desert Safari");
    // An unknown word in brackets stays for the editor.
    expect(cleanTitle("Yacht (Premium)").title).toBe("Yacht (Premium)");
    expect(cleanText("Visit Abudhabi\n\n\n\nRef TD-99 done")).toBe("Visit Abu Dhabi\n\nRef done");
  });

  it("builds option names from facts and keeps them distinct", () => {
    const f = { isPrivate: false, durationHours: 4, pickup: true, ticket: false, languages: [], startTimes: ["09:00"] };
    expect(optionNames([f])).toEqual(["Shared · 4 hours · hotel pickup"]);
    expect(optionNames([f, { ...f, startTimes: ["15:00"] }])).toEqual(["Shared · 4 hours · hotel pickup · from 09:00", "Shared · 4 hours · hotel pickup · from 15:00"]);
    expect(optionNames([f, f])).toEqual(["Shared · 4 hours · hotel pickup · from 09:00", "Shared · 4 hours · hotel pickup · from 09:00 · option 2"]);
    expect(optionNames([{ ...f, isPrivate: true, durationHours: 1, pickup: false, languages: ["Russian"] }])).toEqual(["Private · 1 hour · meet at the venue · Russian-speaking guide"]);
  });

  it("splits description and terms into subtitle, inclusions, exclusions and info", () => {
    const d = describeText(CONTENT.salesDescription, CONTENT.terms);
    expect(d.subtitle).toBe("Sail the creek at sunset on a wooden dhow.");
    expect(d.inclusions).toEqual(["Buffet dinner", "Soft drinks"]);
    expect(d.exclusions).toEqual(["Hotel transfers"]);
    expect(d.importantInfo).toEqual(["Sail the creek at sunset on a wooden dhow. Dinner is served on board.", "Bring photo ID. Dress code: smart casual."]);
  });

  it("pre-fills a category from the reviewed table and names day rules", () => {
    const known = new Set(["desert-safari", "cruises-yachts", "dubai-attractions"]);
    expect(categoryFor("Evening Dhow Cruise", [], known)).toBe("cruises-yachts");
    expect(categoryFor("Something", ["Desert Safari"], known)).toBe("desert-safari");
    expect(categoryFor("Something", [], known)).toBe("dubai-attractions");
    expect(daysLine([0])).toBeNull();
    // Monday 1 … Sunday 64.
    expect(daysLine([1 | 16])).toBe("Runs on Monday, Friday only.");
  });
});

describe("listing identity (RR-01; review 106 N1-02)", () => {
  const CHOICE = "live.fixed_slot_choice.self.internal.per_person";
  const LISTED = "live.listed_start_single.self.internal.per_person";
  const identity = (l: PlannedListing) => `${l.tourId}|${l.kind}|${l.arrival}|${l.route}|${l.fulfilment}|${l.splitNumber}`;

  it("numbers splits across every class key of a tour's arrival, route and fulfilment, so identities never collide", () => {
    const p = buildListingPlan(
      [
        planOffer({ offerId: 1, classKey: KEY_S0, startMinutes: [1200] }),
        planOffer({ offerId: 2, classKey: KEY_S0, startMinutes: [540] }),
        planOffer({ offerId: 3, classKey: CHOICE, startMinutes: [600, 900] }),
        planOffer({ offerId: 4, classKey: LISTED, startMinutes: [480] }),
        planOffer({ offerId: 5, classKey: KEY_PICKUP, startMinutes: [480] }),
      ],
      { rules: RULES, flagsOn: new Set([KEY_S0, CHOICE, LISTED, KEY_PICKUP]), content: new Map() },
    );
    const inst = p.listings.filter((l) => l.kind === "instant");
    expect(inst.map((l) => [l.step, l.classKey, l.splitNumber, l.startTimes[0]])).toEqual([
      ["S0", CHOICE, 1, "10:00"],
      ["S1", KEY_PICKUP, 1, "08:00"],
      ["S0", KEY_S0, 2, "09:00"],
      ["S0", KEY_S0, 3, "20:00"],
      ["S3", LISTED, 4, "08:00"],
    ]);
    expect(new Set(p.listings.map(identity)).size).toBe(p.listings.length);
    expect(new Set(p.listings.map((l) => l.key)).size).toBe(p.listings.length);
  });
});

describe("draft builder (doc 30 §3.4, §3.6)", () => {
  const one = () => plan([planOffer({ offerId: 501 })]).listings[0];

  it("writes a valid draft: inquiry mode, instant confirmation, non-refundable, pending fields, fact-built names", () => {
    const r = buildListingDraft(one(), offersMap([501]), CONTENT, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(activityInputSchema.safeParse(r.input).success).toBe(true);
    expect(r.input).toMatchObject({
      slug: "evening-dhow-cruise",
      title: "Evening Dhow Cruise",
      fulfilmentMode: "inquiry",
      confirmation: "instant",
      freeCancellationHours: 0,
      cancellationPolicy: NON_REFUNDABLE_POLICY,
      location: PENDING_TEXT,
      meetingPoint: PENDING_TEXT,
      timeSlots: ["20:00"],
      addOns: [],
      pickupIncluded: false,
    });
    expect(policyTextAgrees(r.input.cancellationPolicy, 0)).toBe(true);
    expect(pickupAgrees(r.input.pickupIncluded, false)).toBe(true);
    expect(r.input.variants.map((v) => [v.id, v.name])).toEqual([["td-501", "Shared · 2 hours · meet at the venue · Russian-speaking guide"]]);
    expect(r.input.importantInfo[0]).toBe("Guided in Russian.");
    expect(r.pendingFields).toEqual(["location", "meetingPoint", "tier", "categorySlug"]);
    expect(r.options).toEqual([{ variantId: "td-501", offerId: 501 }]);
    for (const u of r.input.variants[0].units!) expect(unitRestricted(u)).toBe(false);
  });

  it("prices every unit at the page's price, in whole AED at 17% and above the floor in INR, at the peak net", () => {
    const offers = [planOffer({ offerId: 601 }), planOffer({ offerId: 602, netAedMinorByUnit: { adult: 15_013n, child: 9_001n, infant: 0n, trip: 0n }, periodsInForce: 2, adultNetRange: { min: 11_000n, max: 15_013n } })];
    const l = plan(offers).listings[0];
    const r = buildListingDraft(l, offersMap([601, 602]), CONTENT, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = asActivity(r.input);
    const nets = new Map<number, { adult: bigint; child: bigint }>([[601, NETS], [602, { adult: 15_013n, child: 9_001n }]]);
    for (const v of a.variants) {
      const net = nets.get(Number(v.id.slice(3)))!;
      for (const u of v.units!) {
        expect(pageUnitPrice(a, v, u.unitId as "adult")).toEqual(u.price);
        expect(Number.isInteger(u.price.aed) && Number.isInteger(u.price.inr)).toBe(true);
        if (u.unitId === "infant") {
          expect(u.price).toEqual({ aed: 0, inr: 0 });
          continue;
        }
        const n = u.unitId === "adult" ? net.adult : net.child;
        expect(meetsFloor({ priceMajor: BigInt(u.price.inr), currency: "INR", netAedMinor: n, costs: FEES, floorBps: 1500, inrPerAed: "24.10" })).toBe(true);
        expect(meetsFloor({ priceMajor: BigInt(u.price.aed), currency: "AED", netAedMinor: n, costs: FEES, floorBps: 1500, inrPerAed: null })).toBe(true);
        if (u.unitId === "adult") {
          expect(meetsFloor({ priceMajor: BigInt(u.price.aed), currency: "AED", netAedMinor: n, costs: FEES, floorBps: 1700, inrPerAed: null })).toBe(true);
          expect(meetsFloor({ priceMajor: BigInt(u.price.aed - 1), currency: "AED", netAedMinor: n, costs: FEES, floorBps: 1700, inrPerAed: null })).toBe(false);
        }
      }
    }
    // One child gap per listing (D10): adult − child is the same on every option.
    const gaps = new Set(a.variants.map((v) => v.units!.find((u) => u.unitId === "adult")!.price.aed - v.units!.find((u) => u.unitId === "child")!.price.aed));
    expect(gaps.size).toBe(1);
  });

  it("never writes the net into the document", () => {
    const r = buildListingDraft(one(), offersMap([501]), CONTENT, CTX);
    const json = JSON.stringify(r);
    for (const needle of ["12347", "123.47", "9871", "98.71"]) expect(json).not.toContain(needle);
  });

  it("refuses an instant listing without a price, and skips already-linked offers", () => {
    const noFx = plan([planOffer({ offerId: 701 })], { ...RULES, inrPerAed: null }).listings[0];
    expect(buildListingDraft(noFx, offersMap([701]), CONTENT, CTX)).toMatchObject({ ok: false });
    const linked = plan([planOffer({ offerId: 702, activeLinks: [{ productId: "p", slug: "old" }] })]).listings[0];
    expect(buildListingDraft(linked, offersMap([702]), CONTENT, CTX)).toEqual({ ok: false, reasons: ["no_options_left"] });
  });

  it("builds an inquiry listing (D4) that can never be armed: manual confirmation, no units, indicative price", () => {
    const p = plan([planOffer({ offerId: 801 }), planOffer({ offerId: 802, classKey: KEY_ON_REQUEST, startMinutes: [600] })]);
    const inq = p.listings.find((l) => l.kind === "inquiry") as PlannedListing;
    const r = buildListingDraft(inq, offersMap([801, 802]), CONTENT, { ...CTX, siblingCount: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.confirmation).toBe("manual");
    expect(r.input.title).toBe("Evening Dhow Cruise (private and group options)");
    expect(r.input.variants.every((v) => !v.units)).toBe(true);
    expect(r.input.timeSlots).toEqual([]);
    // instant + manual confirmation is refused by the schema itself.
    expect(activityInputSchema.safeParse({ ...r.input, fulfilmentMode: "instant" }).success).toBe(false);
  });

  it("shows no indicative price on an inquiry listing with a per-vehicle option (review 106 N1-15)", () => {
    const PER_UNIT = "live.fixed_slot_single.self.internal.per_unit";
    const p = plan([
      planOffer({ offerId: 811 }),
      planOffer({ offerId: 812, classKey: KEY_ON_REQUEST }),
      planOffer({ offerId: 813, classKey: PER_UNIT, supplierUnits: ["adult", "trip"], netAedMinorByUnit: { adult: 0n, child: 0n, infant: 0n, trip: 40_000n } }),
    ]);
    const inq = p.listings.find((l) => l.kind === "inquiry") as PlannedListing;
    const r = buildListingDraft(inq, offersMap([811, 812, 813]), CONTENT, { ...CTX, siblingCount: 2 });
    expect(r.ok && r.input.quoteOnly).toBe(true);
    expect(r.ok && r.input.variants.every((v) => v.delta.aed === 0 && v.delta.inr === 0)).toBe(true);
  });

  it("readiness keeps an imported inquiry listing out of instant even when armed and edited to look instant (N1-06)", async () => {
    const r = buildListingDraft(one(), offersMap([501]), CONTENT, CTX);
    if (!r.ok) throw new Error("build failed");
    const content = { ...asActivity(r.input), fulfilmentMode: "instant" };
    const a = await assessReadiness({ product: { id: "p", status: "published", deletedAt: null, fulfilmentMode: "instant", content, listingKind: "inquiry" }, mappings: [], releaseEnabled: true, margin: null });
    expect(a.effective).toBe("inquiry");
    expect(a.reasons).toContain("inquiry_listing");
  });

  it("names a pickup sibling, picks a free slug and marks missing photos pending", () => {
    const l = plan([planOffer({ offerId: 901, classKey: KEY_PICKUP })]).listings[0];
    const r = buildListingDraft(l, offersMap([901], { isDirectReporting: false }), CONTENT, { ...CTX, images: [], siblingCount: 2, takenSlugs: new Set(["evening-dhow-cruise-with-hotel-pickup"]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.slug).toBe("evening-dhow-cruise-with-hotel-pickup-2");
    expect(r.input.pickupIncluded).toBe(true);
    expect(r.input.images).toEqual(["img:activity:evening-dhow-cruise-with-hotel-pickup-2:0"]);
    expect(r.pendingFields).toContain("images");
  });

  it("locks the editorial fields a person changed, never facts", () => {
    expect(lockedFieldsBetween({ title: "A", subtitle: "B", timeSlots: ["09:00"] }, { title: "A2", subtitle: "B", timeSlots: ["10:00"] })).toEqual(["title"]);
  });

describe("own ages (doc 30 N4, review 109 INT-01)", () => {
  it("writes the offer's child and infant bands on the units; a default offer keeps the page's bands", async () => {
    const { variantPaxAges, PAGE_PAX_AGES } = await import("@/lib/pax-ages");
    const { ageBandMismatches } = await import("../traveldesk/traveldesk.quote");
    const own = stored(1, { childAge: 8, infantsAllowed: false });
    const l = plan([planOffer({ offerId: 1, childAge: 8, infantsAllowed: false, supplierUnits: ["adult", "child"] }), planOffer({ offerId: 2 })]).listings[0];
    const b = buildListingDraft(l, new Map([[1, own], [2, stored(2)]]), CONTENT, CTX);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const [v1, v2] = b.input.variants;
    expect(v1.units?.map((u) => [u.unitId, u.ageMin, u.ageMax, u.label])).toEqual([
      ["adult", 8, null, "Adult (8+)"],
      ["child", 3, 7, "Child (3–7)"],
    ]);
    expect(ageBandMismatches(own, variantPaxAges(v1)!)).toEqual([]);
    expect(variantPaxAges(v2)).toEqual(PAGE_PAX_AGES);
    expect(v2.units?.map((u) => u.label)).toEqual(["Adult (12+)", "Child (3–11)", "Infant (under 3)"]);
  });
});
});
