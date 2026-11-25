import { slugify } from "../../imports/parsers";
import { activityInputSchema, type ActivityInput } from "../../schemas/activity.schema";
import type { UnitDefinition } from "@/server/quotes/contracts";
import { PAGE_PAX_AGES } from "@/lib/pricing";
import type { PlannedListing, PlannedOption } from "./traveldesk.listing-plan";
import type { StoredOffer } from "./traveldesk.offer-terms";
import type { TourContentFaq, TourContentItineraryStep } from "./traveldesk.content";
import { cleanText, cleanTitle, daysLine, describe, optionNames, type OptionFacts } from "./traveldesk.text-rules";

/**
 * One planned listing (doc 30 §3.3, from `buildListingPlan`) → the draft
 * activity document the N1 importer writes (§3.4), with the supplier offer
 * behind each option. Pure: the service reads the rows and writes the result.
 *
 *  - Mode inquiry, status draft, "Non-refundable" (D6, D8). Instant listings
 *    say `confirmation: instant` so they can be armed later; inquiry listings
 *    (D4) say manual and carry no typed units, so they can never be armed.
 *  - Prices: the plan's rule prices, whole AED and INR (D7, D9). The page
 *    prices an option as band + the option's delta (`pageUnitPrice`), so the
 *    band's adult is the cheapest option's adult price, each delta is that
 *    option's adult price minus it, and the band's child is the adult minus
 *    the listing's one child gap (D10): every typed unit then equals what the
 *    page shows, in both currencies (readiness `unitPriceShown`).
 *  - Units: adult, child and infant where the offer sells them, at the page's
 *    own age bands (until N4 lets the picker show the offer's own ages);
 *    infants free; no seniors (decision 5).
 *  - Text: TravelDesk's text (D3) through the rule file (D13); option names
 *    from facts. Fields TravelDesk does not supply (location, meeting point,
 *    tier, category; photos when none could be copied) get a placeholder and
 *    are listed in `pendingFields`; a listing cannot be marked reviewed, so
 *    cannot be published, until a person has filled them.
 *  - The supplier net never enters the document: only prices derived from it.
 */

export const LISTING_BUILD_VERSION = 1;

/** Placeholder text for fields TravelDesk does not supply. Review refuses a listing that still shows it. */
export const PENDING_TEXT = "To be confirmed";
export const PLACEHOLDER_TIER = "C" as const;
export const NON_REFUNDABLE_POLICY = "Non-refundable once booked.";

export const PENDING_FIELDS = ["location", "meetingPoint", "tier", "categorySlug"] as const;
export type PendingField = (typeof PENDING_FIELDS)[number] | "images";

export interface BuildContent {
  name: string;
  salesDescription: string;
  terms: string;
  videoUrl: string | null;
  faq: TourContentFaq[];
  itinerary: TourContentItineraryStep[];
}

export interface BuildContext {
  /** Supplier block of the document: `name` must slugify to the supplier's code (the editor's supplier graph keys on it). */
  supplier: { name: string; reliability: number; verifiedSince: string };
  categorySlug: string;
  /** Copied photo URLs in our own storage (at most 12), or empty: a placeholder image ref is used and `images` is pending. */
  images: string[];
  /** Slugs already taken (any product, deleted included). */
  takenSlugs: ReadonlySet<string>;
  /** How many listings this tour gets in all; above one, titles name what sets this one apart. */
  siblingCount: number;
  /** Sibling listings' slugs ("Other ways to do this"). */
  relatedSlugs?: string[];
}

export interface BuiltOption {
  variantId: string;
  offerId: number;
}

export type BuildResult =
  | { ok: true; input: ActivityInput; options: BuiltOption[]; pendingFields: PendingField[]; warnings: string[] }
  | { ok: false; reasons: string[] };

/** Blockers that stop a listing from being imported at all (the rest are readiness's to judge after arming). */
export const IMPORT_BLOCKING = new Set(["net_unknown", "cost_inputs_missing", "fx_input_missing", "margin_policy_missing", "margin_below_floor", "price_unreachable"]);

const num = (s: string) => Number(s);
const capStr = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

function maxQty(pair: readonly [number | null, number | null] | undefined, fallback: number): number {
  const hi = pair?.[1];
  const v = typeof hi === "number" && hi > 0 ? hi : fallback > 0 ? fallback : 20;
  return Math.max(1, Math.min(100, v));
}

function unit(id: "adult" | "child" | "infant", price: { inr: number; aed: number }, qty: number): UnitDefinition {
  const label = id === "adult" ? "Adult (12+)" : id === "child" ? "Child (3–11)" : "Infant (under 3)";
  return {
    unitId: id,
    label,
    per: "person",
    ageMin: PAGE_PAX_AGES[id].min,
    ageMax: PAGE_PAX_AGES[id].max,
    residency: "any",
    heightMinCm: null,
    heightMaxCm: null,
    seatConsuming: id !== "infant",
    minQty: 0,
    maxQty: qty,
    price,
    supplierUnit: id,
  };
}

function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  const root = (slugify(base) || "traveldesk-tour").slice(0, 72).replace(/-+$/, "");
  if (root.length >= 3 && !taken.has(root)) return root;
  for (let n = 2; n < 100; n++) {
    const s = `${root}-${n}`;
    if (!taken.has(s)) return s;
  }
  throw new Error("No free slug");
}

function titleFor(l: PlannedListing, base: string, siblingCount: number): string {
  if (siblingCount <= 1) return base;
  if (l.kind === "inquiry") return `${base} (private and group options)`;
  const parts: string[] = [];
  if (l.arrival === "pickup_required") parts.push("with hotel pickup");
  if (l.splitNumber > 1 && l.startTimes[0]) parts.push(`${l.startTimes[0]} start`);
  return parts.length ? `${base} ${parts.join(", ")}` : base;
}

function keywords(title: string): string[] {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3);
  return [...new Set(["dubai", ...words])].slice(0, 8);
}

/** Option facts for names: private, hours, pickup, ticket, languages from the offer name's tags. */
function factsOf(o: PlannedOption, stored: StoredOffer | undefined, l: PlannedListing): OptionFacts {
  return {
    isPrivate: stored?.privateType === "private",
    durationHours: o.durationHours,
    pickup: l.arrival === "pickup_required",
    ticket: l.fulfilment === "ticket",
    languages: cleanTitle(o.offerName).languages,
    startTimes: o.startTimes,
  };
}

/** The draft document for one planned listing. `skipOfferIds`: offers already linked elsewhere (reported, never linked twice). */
export function buildListingDraft(
  l: PlannedListing,
  offers: ReadonlyMap<number, StoredOffer>,
  content: BuildContent | null,
  ctx: BuildContext,
  skipOfferIds: ReadonlySet<number> = new Set(),
): BuildResult {
  const reasons: string[] = [];
  const options = l.options.filter((o) => !skipOfferIds.has(o.offerId) && o.linkedTo.length === 0);
  if (options.length === 0) return { ok: false, reasons: ["no_options_left"] };
  if (options.length > 12) return { ok: false, reasons: ["too_many_options"] };
  if (l.kind === "instant") {
    for (const o of options) for (const b of o.blockers) if (IMPORT_BLOCKING.has(b)) reasons.push(`td-${o.offerId}:${b}`);
    for (const o of options) if (!o.rulePrice.adult || o.rulePrice.adult.inr === null) reasons.push(`td-${o.offerId}:price_unknown`);
    if (options.some((o) => o.rulePrice.child && !o.childUnderGap)) reasons.push("child_gap_unknown");
    if (l.childGap && l.childGap.inr === null) reasons.push("child_gap_unknown");
  }
  if (reasons.length) return { ok: false, reasons: [...new Set(reasons)] };

  const warnings: string[] = [];
  const pendingFields: PendingField[] = [...PENDING_FIELDS];
  const cleaned = cleanTitle(content?.name || l.tourName || `Tour ${l.tourId}`);
  const title = capStr(titleFor(l, cleaned.title || `Tour ${l.tourId}`, ctx.siblingCount), 120);
  const slug = uniqueSlug(title, ctx.takenSlugs);
  const text = describe(content?.salesDescription ?? "", content?.terms ?? "");
  if (!text.subtitle) warnings.push("no_description");
  const subtitle = text.subtitle || capStr(title, 200);
  const days = daysLine(options.map((o) => o.daysOffered));
  const importantInfo = [...(days ? [days] : []), ...text.importantInfo].slice(0, 30);
  if (cleaned.languages.length) importantInfo.unshift(`Guided in ${cleaned.languages.join(" and ")}.`);

  const images = ctx.images.slice(0, 12);
  if (images.length === 0) {
    pendingFields.push("images");
    warnings.push("no_photos");
  }

  const names = optionNames(options.map((o) => factsOf(o, offers.get(o.offerId), l)));
  const durations = options.map((o) => o.durationHours ?? 0).filter((h) => h > 0);

  let price: ActivityInput["price"];
  let variants: ActivityInput["variants"];
  let quoteOnly: boolean | undefined;

  if (l.kind === "instant") {
    const adults = options.map((o) => ({ aed: num(o.rulePrice.adult!.aed), inr: num(o.rulePrice.adult!.inr!) }));
    const band = { aed: Math.min(...adults.map((a) => a.aed)), inr: Math.min(...adults.map((a) => a.inr)) };
    const gap = l.childGap ? { aed: num(l.childGap.aed), inr: num(l.childGap.inr!) } : null;
    // A unit is sold only where the supplier sells it (`offerReadinessFacts` units), or readiness finds it unmapped.
    const sellsChild = (o: PlannedOption) => o.rulePrice.child !== null;
    const sellsInfant = (o: PlannedOption) => {
      const st = offers.get(o.offerId);
      return Boolean(st?.infantsAllowed && st.paxLimits.infants[1] !== 0);
    };
    const anyChild = options.some(sellsChild);
    const anyInfant = options.some(sellsInfant);
    price = {
      adult: band,
      ...(anyChild && gap ? { child: { aed: band.aed - gap.aed, inr: band.inr - gap.inr } } : {}),
      ...(anyInfant ? { infant: { aed: 0, inr: 0 } } : {}),
    };
    if (price.child && (price.child.aed < 0 || price.child.inr < 0)) return { ok: false, reasons: ["child_price_negative"] };
    variants = options.map((o, i) => {
      const stored = offers.get(o.offerId);
      const adult = adults[i];
      const delta = { aed: adult.aed - band.aed, inr: adult.inr - band.inr };
      const units: UnitDefinition[] = [];
      const fallbackQty = stored?.maxPax ?? 20;
      units.push(unit("adult", adult, maxQty(stored?.paxLimits.adults, fallbackQty)));
      if (sellsChild(o) && price.child) units.push(unit("child", { aed: price.child.aed + delta.aed, inr: price.child.inr + delta.inr }, maxQty(stored?.paxLimits.children, fallbackQty)));
      if (sellsInfant(o)) units.push(unit("infant", { aed: 0, inr: 0 }, maxQty(stored?.paxLimits.infants, fallbackQty)));
      return {
        id: `td-${o.offerId}`,
        name: names[i],
        blurb: "",
        delta,
        highlights: o.startTimes.length ? [capStr(`Starts at ${o.startTimes.join(", ")}`, 120)] : [],
        isPrivate: stored?.privateType === "private",
        units,
      };
    });
  } else {
    // Inquiry (D4): an indicative "from" price; options may differ and carry no typed units.
    const own = options.map((o) => o.rulePrice.adult ?? o.rulePrice.trip);
    const priced = own.filter((p): p is NonNullable<typeof p> => Boolean(p && p.inr !== null));
    if (priced.length === 0) {
      price = { adult: { aed: 0, inr: 0 } };
      quoteOnly = true;
      warnings.push("no_indicative_price");
    } else {
      price = { adult: { aed: Math.min(...priced.map((p) => num(p.aed))), inr: Math.min(...priced.map((p) => num(p.inr!))) } };
    }
    variants = options.map((o, i) => {
      const p = own[i];
      const delta = p && p.inr !== null && !quoteOnly ? { aed: num(p.aed) - price.adult.aed, inr: num(p.inr) - price.adult.inr } : { aed: 0, inr: 0 };
      return { id: `td-${o.offerId}`, name: names[i], blurb: "", delta, highlights: [], isPrivate: offers.get(o.offerId)?.privateType === "private" };
    });
  }

  const raw = {
    slug,
    title,
    subtitle,
    tier: PLACEHOLDER_TIER,
    categorySlug: ctx.categorySlug,
    secondaryCategorySlugs: [],
    collectionSlugs: [],
    images: images.length ? images : [`img:activity:${slug}:0`],
    imageAlt: capStr(title, 200),
    ...(content?.videoUrl ? { video: content.videoUrl } : {}),
    durationMinutes: durations.length ? Math.min(...durations) * 60 : 0,
    isPrivate: variants.every((v) => v.isPrivate),
    pickupIncluded: l.arrival === "pickup_required",
    pickupZones: [],
    confirmation: l.kind === "instant" ? "instant" : "manual",
    fulfilmentMode: "inquiry",
    freeCancellationHours: 0,
    mobileVoucher: true,
    dietary: [],
    suitability: [],
    location: PENDING_TEXT,
    meetingPoint: PENDING_TEXT,
    timeSlots: l.kind === "instant" ? l.startTimes : [],
    price,
    ...(quoteOnly ? { quoteOnly } : {}),
    inclusions: text.inclusions,
    exclusions: text.exclusions,
    itinerary: (content?.itinerary ?? [])
      .filter((s) => s.title.trim())
      .slice(0, 30)
      .map((s) => ({ time: `Step ${s.position}`.slice(0, 20), title: capStr(cleanText(s.title), 100), detail: capStr(cleanText(s.description), 400) })),
    importantInfo: importantInfo.slice(0, 30).map((s) => capStr(s, 600)),
    cancellationPolicy: NON_REFUNDABLE_POLICY,
    variants,
    addOns: [],
    faqs: (content?.faq ?? [])
      .map((f) => ({ q: capStr(cleanText(f.question), 200), a: capStr(cleanText(f.answer), 1500) }))
      .filter((f) => f.q && f.a)
      .slice(0, 30),
    relatedSlugs: (ctx.relatedSlugs ?? []).filter((s) => s !== slug).slice(0, 12),
    comboSlugs: [],
    supplier: { id: slugify(ctx.supplier.name) || "traveldesk", name: ctx.supplier.name, source: "portal", reliability: ctx.supplier.reliability, verifiedSince: ctx.supplier.verifiedSince },
    badges: {},
    seo: { title: capStr(title, 120), description: capStr(subtitle, 320), keywords: keywords(cleaned.title) },
  };
  const parsed = activityInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reasons: parsed.error.issues.slice(0, 8).map((i) => `invalid:${i.path.join(".")}:${i.message}`) };
  return { ok: true, input: parsed.data, options: options.map((o) => ({ variantId: `td-${o.offerId}`, offerId: o.offerId })), pendingFields, warnings };
}

/**
 * Editorial fields a person changed since the import (doc 30 §3.7 locks): the
 * sync never overwrites them (N3). Facts (times, ages, pickup, policy, units,
 * prices) are never locked here.
 */
export const EDITORIAL_FIELDS = ["title", "subtitle", "images", "imageAlt", "inclusions", "exclusions", "itinerary", "importantInfo", "faqs", "seo", "video"] as const;

export function lockedFieldsBetween(imported: Record<string, unknown>, current: Record<string, unknown>): string[] {
  return EDITORIAL_FIELDS.filter((f) => JSON.stringify(imported[f] ?? null) !== JSON.stringify(current[f] ?? null));
}
