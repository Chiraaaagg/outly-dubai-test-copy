import { meetsFloor, ruleAedPrice, ruleInrPrice, RULE_TARGET_MARGIN_BPS, type RuleCostLine } from "../../domain/rule-price";
import { minutesToHhmm } from "./traveldesk.codec";
import {
  DATE_ONLY_CLASS_KEYS,
  EXTERNAL_CLASS_KEYS,
  INQUIRY_CLASS,
  LISTED_START_CLASS_KEYS,
  neverEnabledReason,
  PICKUP_CLASS_KEYS,
  SEEDED_CLASS_KEYS,
  TICKET_CLASS_KEYS,
  UNKNOWN_CLASS,
  type CapabilityDimensions,
} from "./traveldesk.capability";

/**
 * The listing plan of doc 30 (§2.1, §3.3–§3.6), read-only: what the N1
 * importer would create from the stored TravelDesk catalogue, one offer type
 * (step) at a time. Used by the N0 dry-run report; it writes nothing.
 *
 *  - Steps S0–S5 are fixed sets of exact class keys (§2.1).
 *  - Instant listing: one tour and one exact class key (so one arrival, route
 *    and fulfilment), split further when its options' start-time sets differ
 *    (§3.3, RR-01). Split numbers count from 1 by earliest start.
 *  - Inquiry listing (D4): the never-instant offers of a tour that has at
 *    least one instant-capable offer, grouped by tour, arrival and
 *    fulfilment, imported with that tour's first instant step.
 *  - Tours with no instant-capable offer are not imported (D5).
 *  - Prices (§3.6): the rule price per unit from the readiness net (D7, D9);
 *    one adult-to-child gap per instant listing, the smallest across its
 *    options, in each currency after INR rounding (D10). The child-price
 *    effect is what that rule adds to each option's own rule child price.
 *  - An offer already actively linked to a listing is reported and would be
 *    skipped; a listing all of whose options link to one product is that
 *    product's adopt-in-place candidate (§3.9).
 *
 * Money in the output is decimal strings: AED and INR prices in whole major
 * units, nets in AED minor units. Nets are cost data: whoever shows this
 * output needs `suppliers.costs.view` (doc 30 §3.2).
 *
 * Pure: no env, db, clock or logger.
 */

export const PLAN_VERSION = 1;

export const PLAN_STEPS = Object.freeze([
  { id: "S0", label: "Fixed start, self arrival", classKeys: SEEDED_CLASS_KEYS },
  { id: "S1", label: "Hotel pickup", classKeys: PICKUP_CLASS_KEYS },
  { id: "S2", label: "External suppliers", classKeys: EXTERNAL_CLASS_KEYS },
  { id: "S3", label: "Listed start times", classKeys: LISTED_START_CLASS_KEYS },
  { id: "S4", label: "Tickets", classKeys: TICKET_CLASS_KEYS },
  { id: "S5", label: "Date only", classKeys: DATE_ONLY_CLASS_KEYS },
] as const);

export type PlanStepId = (typeof PLAN_STEPS)[number]["id"];

/** The step whose class keys hold `classKey`, or null when the offer is never instant under today's decisions. */
export function stepOfClassKey(classKey: string): PlanStepId | null {
  return PLAN_STEPS.find((s) => (s.classKeys as readonly string[]).includes(classKey))?.id ?? null;
}

/** Why an offer outside every step is never instant. */
export function neverInstantReason(classKey: string): string {
  if (classKey === INQUIRY_CLASS) return "on_request";
  if (classKey === UNKNOWN_CLASS) return "class_unknown";
  return neverEnabledReason(classKey) ?? "no_step";
}

export interface PlanSuggestion {
  productId: string;
  slug: string;
  title: string;
  score: number;
  state: string;
}

/** One stored offer, read for the plan. */
export interface PlanOffer {
  offerId: number;
  tourId: number;
  tourName: string | null;
  /** TravelDesk's own offer name; admin eyes only (option names are built from facts at import, §3.7). */
  offerName: string | null;
  classKey: string;
  dimensions: CapabilityDimensions;
  reviewReasons: string[];
  /** The capability gate today: instant, or why not. */
  gate: { instant: boolean; reason: string | null };
  isExternal: boolean;
  durationHours: number | null;
  daysOffered: number;
  /** Distinct stored slot starts, minutes after midnight, ascending; null when the offer is unreadable. */
  startMinutes: number[] | null;
  childrenAllowed: boolean;
  childAge: number;
  infantsAllowed: boolean;
  infantAge: number;
  /** `offerReadinessFacts`: the units the offer sells and the highest net per unit over the periods in force. */
  supplierUnits: string[];
  netAedMinorByUnit: Record<string, bigint> | null;
  /** Pricing periods still in force, and the lowest and highest adult net among them (seasonal offers, D9). */
  periodsInForce: number;
  adultNetRange: { min: bigint; max: bigint } | null;
  /** The tour's free-cancellation window in hours (0: none; null: unknown). */
  freeCancellationHours: number | null;
  /** Child and infant units whose age band the page cannot show today (`ageBandMismatches`); N4 removes these. */
  ageBandMismatches: string[];
  /** Live-book offer without slots that no date-only key covers (`slot_rules_unknown`). */
  slotRulesUnknown: boolean;
  catalogueStale: boolean;
  /** Products this offer is actively linked to now. */
  activeLinks: { productId: string; slug: string }[];
  /** Stored matcher suggestions: old pages that may be replaced. */
  suggestions: PlanSuggestion[];
}

export interface PlanTourContent {
  hasDescription: boolean;
  photos: number;
  faq: number;
  itinerary: number;
  warnings: number;
  schemaVersion: number;
}

export interface PlanRules {
  targetBps: number;
  /** The versioned floor (`pricing.margin_policy`); null when not configured. */
  floorBps: number | null;
  /** Recorded variable costs; null when not recorded (no price is then computed). */
  costs: RuleCostLine[] | null;
  /** Recorded conservative INR-per-AED rate; null when missing or expired. */
  inrPerAed: string | null;
}

export interface PlanMoney {
  aed: string;
  inr: string | null;
}

export interface PlannedOption {
  optionId: string;
  offerId: number;
  offerName: string | null;
  classKey: string;
  durationHours: number | null;
  startTimes: string[];
  daysOffered: number;
  ages: { childrenAllowed: boolean; childUnder: number; infantsAllowed: boolean; infantUnder: number };
  netAedMinor: Record<string, string> | null;
  seasonal: { periods: number; minAdultNetAedMinor: string; peakAdultNetAedMinor: string } | null;
  /** Rule prices before the listing's child gap. */
  rulePrice: { adult: PlanMoney | null; child: PlanMoney | null; trip: PlanMoney | null };
  /** The child price the page would charge under the listing's one gap (D10), and what that adds to the rule child price. */
  childUnderGap: PlanMoney | null;
  childEffect: PlanMoney | null;
  floorOk: boolean | null;
  blockers: string[];
  linkedTo: { productId: string; slug: string }[];
}

export interface PlannedListing {
  key: string;
  kind: "instant" | "inquiry";
  step: PlanStepId;
  tourId: number;
  tourName: string | null;
  /** Instant listings: the one exact class key. Inquiry listings: null (options may differ). */
  classKey: string | null;
  arrival: string;
  route: string | null;
  fulfilment: string;
  splitNumber: number;
  startTimes: string[];
  days: { masks: number[]; everyDay: boolean; differ: boolean };
  agesDiffer: boolean;
  freeCancellationHours: number | null;
  /** D6: every import is "Non-refundable"; true when the supplier allows free cancellation, so the page is weaker than the supplier. */
  freeCancellationDropped: boolean;
  options: PlannedOption[];
  /** D10, instant listings with a child price: the one adult-to-child gap in each currency. */
  childGap: PlanMoney | null;
  fromPrice: PlanMoney | null;
  seasonalOptions: number;
  externalProvider: { named: false; note: string } | null;
  adoptProduct: { productId: string; slug: string } | null;
  oldPages: PlanSuggestion[];
  content: PlanTourContent | null;
  blockers: string[];
}

export interface PlanStepSummary {
  id: PlanStepId;
  label: string;
  classKeys: string[];
  flagsOn: string[];
  offers: number;
  instantListingsByTourAndKey: number;
  instantListings: number;
  extraForStartTimes: number;
  inquiryListings: number;
  inquiryOffers: number;
  alreadyLinkedOffers: number;
}

export interface ListingPlan {
  version: number;
  rules: { targetBps: number; floorBps: number | null; costInputsRecorded: boolean; fxRecorded: boolean };
  steps: PlanStepSummary[];
  listings: PlannedListing[];
  totals: { offers: number; stepOffers: number; instantListings: number; inquiryListings: number; inquiryOffers: number; neverInstant: number };
  neverInstant: Record<string, number>;
  notImported: { tours: number; offers: number; tourIds: number[] };
  duplicates: {
    linkedOffers: { offerId: number; tourId: number; products: { productId: string; slug: string }[] }[];
    sharedOldPages: { productId: string; slug: string; listingKeys: string[] }[];
  };
}

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

const everyDay = (mask: number) => mask === 0 || (mask & 127) === 127;
const startKey = (starts: number[] | null) => (starts ?? []).join(",");

function priceOf(net: bigint | undefined, rules: PlanRules): { aed: bigint; inr: bigint | null } | null {
  if (net === undefined || !rules.costs) return null;
  const aed = ruleAedPrice(net, rules.costs, rules.targetBps);
  if (aed === null) return null;
  return { aed, inr: rules.inrPerAed ? ruleInrPrice(aed, rules.inrPerAed) : null };
}

const money = (p: { aed: bigint; inr: bigint | null } | null): PlanMoney | null => (p ? { aed: p.aed.toString(), inr: p.inr === null ? null : p.inr.toString() } : null);

function floorOk(prices: { price: { aed: bigint; inr: bigint | null }; net: bigint }[], rules: PlanRules): boolean | null {
  if (!rules.costs || rules.floorBps === null) return null;
  for (const { price, net } of prices) {
    if (!meetsFloor({ priceMajor: price.aed, currency: "AED", netAedMinor: net, costs: rules.costs, floorBps: rules.floorBps, inrPerAed: rules.inrPerAed })) return false;
    if (price.inr === null) return null;
    if (!meetsFloor({ priceMajor: price.inr, currency: "INR", netAedMinor: net, costs: rules.costs, floorBps: rules.floorBps, inrPerAed: rules.inrPerAed })) return false;
  }
  return true;
}

function mergeSuggestions(offers: PlanOffer[]): PlanSuggestion[] {
  const best = new Map<string, PlanSuggestion>();
  for (const o of offers) for (const s of o.suggestions) if (!best.has(s.productId) || best.get(s.productId)!.score < s.score) best.set(s.productId, s);
  return [...best.values()].sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
}

function optionBase(o: PlanOffer, rules: PlanRules, kind: "instant" | "inquiry") {
  const nets = o.netAedMinorByUnit;
  const has = (u: string) => o.supplierUnits.includes(u);
  const adult = has("adult") && nets ? priceOf(nets.adult, rules) : null;
  const child = has("child") && nets ? priceOf(nets.child, rules) : null;
  const trip = has("trip") && nets && nets.trip > 0n ? priceOf(nets.trip, rules) : null;
  const blockers: string[] = [];
  if (o.activeLinks.length) blockers.push("already_linked");
  if (kind === "instant") {
    if (!o.gate.instant) blockers.push(`capability:${o.gate.reason ?? "refused"}`);
    for (const r of o.reviewReasons) blockers.push(`review:${r}`);
    for (const u of o.ageBandMismatches) blockers.push(`age_band:${u}`);
    if (o.slotRulesUnknown) blockers.push("slot_rules_unknown");
    if (o.catalogueStale) blockers.push("catalogue_stale");
  }
  if (!nets) blockers.push("net_unknown");
  else if (!rules.costs) blockers.push("cost_inputs_missing");
  else if (!rules.inrPerAed) blockers.push("fx_input_missing");
  if (rules.floorBps === null) blockers.push("margin_policy_missing");
  const option: PlannedOption = {
    optionId: `td-${o.offerId}`,
    offerId: o.offerId,
    offerName: o.offerName,
    classKey: o.classKey,
    durationHours: o.durationHours,
    startTimes: (o.startMinutes ?? []).map(minutesToHhmm),
    daysOffered: o.daysOffered,
    ages: { childrenAllowed: o.childrenAllowed, childUnder: o.childAge, infantsAllowed: o.infantsAllowed, infantUnder: o.infantAge },
    netAedMinor: nets ? Object.fromEntries(Object.entries(nets).map(([k, v]) => [k, v.toString()])) : null,
    seasonal:
      o.periodsInForce > 1 && o.adultNetRange
        ? { periods: o.periodsInForce, minAdultNetAedMinor: o.adultNetRange.min.toString(), peakAdultNetAedMinor: o.adultNetRange.max.toString() }
        : null,
    rulePrice: { adult: money(adult), child: money(child), trip: money(trip) },
    childUnderGap: null,
    childEffect: null,
    floorOk: null,
    blockers,
    linkedTo: o.activeLinks,
  };
  return { option, adult, child, trip };
}

function finishFloor(
  entries: { option: PlannedOption; checks: { price: { aed: bigint; inr: bigint | null }; net: bigint }[] }[],
  rules: PlanRules,
) {
  for (const e of entries) {
    e.option.floorOk = e.checks.length ? floorOk(e.checks, rules) : null;
    if (e.option.floorOk === false) e.option.blockers.push("margin_below_floor");
  }
}

function listingCommon(offers: PlanOffer[], content: Map<number, PlanTourContent>) {
  const masks = [...new Set(offers.map((o) => o.daysOffered))].sort((a, b) => a - b);
  const ages = new Set(offers.map((o) => `${o.childrenAllowed}:${o.childAge}:${o.infantsAllowed}:${o.infantAge}`));
  const policy = offers[0]?.freeCancellationHours ?? null;
  const c = content.get(offers[0].tourId) ?? null;
  const blockers: string[] = [];
  if (!c) blockers.push("content_missing");
  else {
    if (!c.hasDescription) blockers.push("content_no_description");
    if (c.photos === 0) blockers.push("content_no_photos");
  }
  return {
    days: { masks, everyDay: masks.every(everyDay), differ: masks.length > 1 },
    agesDiffer: ages.size > 1,
    freeCancellationHours: policy,
    freeCancellationDropped: policy !== null && policy > 0,
    content: c,
    blockers,
  };
}

/* ---------------------------------------------------------------------------
 * Plan
 * ------------------------------------------------------------------------ */

/** The whole plan. `flagsOn` is the set of class keys switched on in the environment. */
export function buildListingPlan(offers: PlanOffer[], ctx: { rules: PlanRules; flagsOn: ReadonlySet<string>; content: Map<number, PlanTourContent> }): ListingPlan {
  const { rules } = ctx;
  const byTour = new Map<number, PlanOffer[]>();
  for (const o of [...offers].sort((a, b) => a.tourId - b.tourId || a.offerId - b.offerId)) byTour.set(o.tourId, [...(byTour.get(o.tourId) ?? []), o]);
  const stepOrder = PLAN_STEPS.map((s) => s.id) as PlanStepId[];

  const listings: PlannedListing[] = [];
  const neverInstant: Record<string, number> = {};
  const notImported = { tours: 0, offers: 0, tourIds: [] as number[] };

  for (const [tourId, tourOffers] of byTour) {
    const instant = tourOffers.filter((o) => stepOfClassKey(o.classKey));
    const never = tourOffers.filter((o) => !stepOfClassKey(o.classKey));
    for (const o of never) neverInstant[neverInstantReason(o.classKey)] = (neverInstant[neverInstantReason(o.classKey)] ?? 0) + 1;
    if (instant.length === 0) {
      notImported.tours += 1;
      notImported.offers += tourOffers.length;
      notImported.tourIds.push(tourId);
      continue;
    }
    const firstStep = stepOrder.find((s) => instant.some((o) => stepOfClassKey(o.classKey) === s))!;

    // Instant: tour + exact class key, then split by start-time set.
    const byKey = new Map<string, PlanOffer[]>();
    for (const o of instant) byKey.set(o.classKey, [...(byKey.get(o.classKey) ?? []), o]);
    for (const [classKey, keyOffers] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
      const bySet = new Map<string, PlanOffer[]>();
      for (const o of keyOffers) bySet.set(startKey(o.startMinutes), [...(bySet.get(startKey(o.startMinutes)) ?? []), o]);
      const sets = [...bySet].sort(([a], [b]) => {
        const fa = a ? Number(a.split(",")[0]) : -1;
        const fb = b ? Number(b.split(",")[0]) : -1;
        return fa - fb || a.localeCompare(b);
      });
      sets.forEach(([, group], i) => listings.push(instantListing(tourId, classKey, i + 1, group, rules, ctx.content)));
    }

    // Inquiry (D4): tour + arrival + fulfilment, with the tour's first instant step.
    const byInquiry = new Map<string, PlanOffer[]>();
    for (const o of never) {
      const k = `${o.dimensions.arrival}|${o.dimensions.fulfilment}`;
      byInquiry.set(k, [...(byInquiry.get(k) ?? []), o]);
    }
    for (const [k, group] of [...byInquiry].sort(([a], [b]) => a.localeCompare(b))) {
      const [arrival, fulfilment] = k.split("|");
      listings.push(inquiryListing(tourId, firstStep, arrival, fulfilment, group, rules, ctx.content));
    }
  }

  // Old pages suggested by more than one planned listing.
  const pageUse = new Map<string, { slug: string; keys: string[] }>();
  for (const l of listings) for (const p of l.oldPages) pageUse.set(p.productId, { slug: p.slug, keys: [...(pageUse.get(p.productId)?.keys ?? []), l.key] });
  const sharedOldPages = [...pageUse]
    .filter(([, v]) => v.keys.length > 1)
    .map(([productId, v]) => ({ productId, slug: v.slug, listingKeys: v.keys }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const linkedOffers = offers
    .filter((o) => o.activeLinks.length > 0)
    .map((o) => ({ offerId: o.offerId, tourId: o.tourId, products: o.activeLinks }))
    .sort((a, b) => a.offerId - b.offerId);

  const steps: PlanStepSummary[] = PLAN_STEPS.map((s) => {
    const inStep = listings.filter((l) => l.step === s.id);
    const inst = inStep.filter((l) => l.kind === "instant");
    const inq = inStep.filter((l) => l.kind === "inquiry");
    const base = new Set(inst.map((l) => `${l.tourId}|${l.classKey}`)).size;
    return {
      id: s.id,
      label: s.label,
      classKeys: [...s.classKeys],
      flagsOn: s.classKeys.filter((k) => ctx.flagsOn.has(k)),
      offers: inst.reduce((n, l) => n + l.options.length, 0),
      instantListingsByTourAndKey: base,
      instantListings: inst.length,
      extraForStartTimes: inst.length - base,
      inquiryListings: inq.length,
      inquiryOffers: inq.reduce((n, l) => n + l.options.length, 0),
      alreadyLinkedOffers: inst.reduce((n, l) => n + l.options.filter((o) => o.linkedTo.length > 0).length, 0),
    };
  });

  const stepOffers = steps.reduce((n, s) => n + s.offers, 0);
  return {
    version: PLAN_VERSION,
    rules: { targetBps: rules.targetBps, floorBps: rules.floorBps, costInputsRecorded: rules.costs !== null, fxRecorded: rules.inrPerAed !== null },
    steps,
    listings,
    totals: {
      offers: offers.length,
      stepOffers,
      instantListings: steps.reduce((n, s) => n + s.instantListings, 0),
      inquiryListings: steps.reduce((n, s) => n + s.inquiryListings, 0),
      inquiryOffers: steps.reduce((n, s) => n + s.inquiryOffers, 0),
      neverInstant: offers.length - stepOffers,
    },
    neverInstant,
    notImported,
    duplicates: { linkedOffers, sharedOldPages },
  };
}

function instantListing(tourId: number, classKey: string, splitNumber: number, group: PlanOffer[], rules: PlanRules, content: Map<number, PlanTourContent>): PlannedListing {
  const step = stepOfClassKey(classKey)!;
  const d = group[0].dimensions;
  const common = listingCommon(group, content);
  const built = group.map((o) => ({ o, ...optionBase(o, rules, "instant") }));

  // D10: one gap per listing, the smallest across options with a child price, per currency after INR rounding.
  const withChild = built.filter((b) => b.adult && b.child);
  let childGap: PlanMoney | null = null;
  const floorEntries: { option: PlannedOption; checks: { price: { aed: bigint; inr: bigint | null }; net: bigint }[] }[] = [];
  let gapAed: bigint | null = null;
  let gapInr: bigint | null = null;
  if (withChild.length) {
    gapAed = withChild.map((b) => b.adult!.aed - b.child!.aed).reduce((a, b) => (b < a ? b : a));
    const inrGaps = withChild.map((b) => (b.adult!.inr !== null && b.child!.inr !== null ? b.adult!.inr - b.child!.inr : null));
    gapInr = inrGaps.every((g) => g !== null) ? (inrGaps as bigint[]).reduce((a, b) => (b < a ? b : a)) : null;
    childGap = { aed: gapAed.toString(), inr: gapInr === null ? null : gapInr.toString() };
  }
  for (const b of built) {
    const checks: { price: { aed: bigint; inr: bigint | null }; net: bigint }[] = [];
    const nets = b.o.netAedMinorByUnit;
    if (b.adult && nets) checks.push({ price: b.adult, net: nets.adult });
    if (b.adult && b.child && nets && gapAed !== null) {
      const child = { aed: b.adult.aed - gapAed, inr: b.adult.inr !== null && gapInr !== null ? b.adult.inr - gapInr : null };
      b.option.childUnderGap = money(child);
      b.option.childEffect = money({ aed: child.aed - b.child.aed, inr: child.inr !== null && b.child.inr !== null ? child.inr - b.child.inr : null });
      checks.push({ price: child, net: nets.child });
    }
    floorEntries.push({ option: b.option, checks });
  }
  finishFloor(floorEntries, rules);

  const adults = built.flatMap((b) => (b.adult ? [b.adult] : []));
  const fromAed = adults.length ? adults.map((a) => a.aed).reduce((a, b) => (b < a ? b : a)) : null;
  const fromInr = adults.length && adults.every((a) => a.inr !== null) ? adults.map((a) => a.inr!).reduce((a, b) => (b < a ? b : a)) : null;
  const linked = new Set(group.flatMap((o) => o.activeLinks.map((l) => l.productId)));
  const allLinked = group.every((o) => o.activeLinks.length === 1) && linked.size === 1;
  const starts = [...new Set(group.flatMap((o) => o.startMinutes ?? []))].sort((a, b) => a - b);
  return {
    key: `${tourId}:${classKey}:${splitNumber}`,
    kind: "instant",
    step,
    tourId,
    tourName: group[0].tourName,
    classKey,
    arrival: d.arrival,
    route: d.route,
    fulfilment: d.fulfilment,
    splitNumber,
    startTimes: starts.map(minutesToHhmm),
    ...common,
    options: built.map((b) => b.option),
    childGap,
    fromPrice: fromAed === null ? null : { aed: fromAed.toString(), inr: fromInr === null ? null : fromInr.toString() },
    seasonalOptions: built.filter((b) => b.option.seasonal).length,
    externalProvider: d.route === "external" ? { named: false, note: "The stored payload does not name the external provider; ask TravelDesk (doc 30 §3.12 condition 3)." } : null,
    adoptProduct: allLinked ? group[0].activeLinks[0] : null,
    oldPages: mergeSuggestions(group),
  };
}

function inquiryListing(
  tourId: number,
  step: PlanStepId,
  arrival: string,
  fulfilment: string,
  group: PlanOffer[],
  rules: PlanRules,
  content: Map<number, PlanTourContent>,
): PlannedListing {
  const common = listingCommon(group, content);
  const built = group.map((o) => ({ o, ...optionBase(o, rules, "inquiry") }));
  finishFloor(
    built.map((b) => {
      const nets = b.o.netAedMinorByUnit;
      const checks: { price: { aed: bigint; inr: bigint | null }; net: bigint }[] = [];
      if (nets && b.adult) checks.push({ price: b.adult, net: nets.adult });
      if (nets && b.child) checks.push({ price: b.child, net: nets.child });
      if (nets && b.trip) checks.push({ price: b.trip, net: nets.trip });
      return { option: b.option, checks };
    }),
    rules,
  );
  const routes = [...new Set(group.map((o) => o.dimensions.route))];
  return {
    key: `${tourId}:inquiry:${arrival}:${fulfilment}`,
    kind: "inquiry",
    step,
    tourId,
    tourName: group[0].tourName,
    classKey: null,
    arrival,
    route: routes.length === 1 ? routes[0] : null,
    fulfilment,
    splitNumber: 1,
    startTimes: [],
    ...common,
    options: built.map((b) => b.option),
    childGap: null,
    fromPrice: null,
    seasonalOptions: built.filter((b) => b.option.seasonal).length,
    externalProvider: null,
    adoptProduct: null,
    oldPages: mergeSuggestions(group),
  };
}

export { RULE_TARGET_MARGIN_BPS };
