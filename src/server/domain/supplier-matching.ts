import { evaluateMargin, PLANNING_MARGIN_POLICY, type MarginPolicy } from "./margin";

/**
 * Supplier matching — suggests which supplier offer could fulfil an OUTLY
 * product variant, with the evidence and conflicts a reviewer needs
 * (docs/backend/21 §3.3).
 *
 * Rules that shape this file:
 *  - It only SUGGESTS. Approval is a human action in the admin review; nothing
 *    here writes a mapping.
 *  - Name similarity is a weak signal and is never enough on its own: every
 *    structural difference (private vs sharing, pickup, duration, slot times,
 *    price basis, booking kind, margin) is listed as a conflict, and a
 *    candidate with conflicts is shown as such, not as a match.
 *  - Margin is gross margin on the OUTLY selling price BEFORE fees and taxes
 *    (§6.2): a screen, not an approval.
 *
 * Pure: no I/O, no env, no clock.
 */

export interface MatchVariant {
  /** OUTLY variant id; "" = the product as a whole. */
  code: string;
  name: string;
  sellAdultMinor: bigint;
  sellChildMinor: bigint | null;
  isPrivate: boolean;
}

export interface MatchProduct {
  productId: string;
  slug: string;
  title: string;
  durationMinutes: number | null;
  isPrivate: boolean;
  pickupIncluded: boolean;
  /** Free-text slot labels as authored ("09:30", "Approx 9.00 pm to 10:30 pm"). */
  timeSlots: string[];
  variants: MatchVariant[];
}

export interface MatchOffer {
  tourId: string;
  tourName: string;
  offerId: string;
  offerName: string;
  bookingKind: "on_request" | "live_book" | "ticket_only" | "unknown";
  isExternal: boolean;
  durationHours: number;
  privateType: "sharing" | "private" | "unknown";
  isDirectReporting: boolean;
  childAge: number;
  startMinutes: number[];
  netAdultMinor: bigint;
  netChildMinor: bigint;
  netTripMinor: bigint;
}

export interface CandidateSuggestion {
  variantCode: string;
  tourId: string;
  offerId: string;
  /** 0–100. */
  score: number;
  evidence: string[];
  conflicts: string[];
  sellAdultMinor: bigint;
  /** Adult net, or the per-trip net when the offer is priced per trip. */
  netAdultMinor: bigint;
  pricedPerTrip: boolean;
  marginBps: number | null;
}

export interface SuggestOptions {
  maxPerVariant?: number;
  /** Below this score a pair is not suggested at all. */
  minScore?: number;
  policy?: MarginPolicy;
}

/** Words that carry no identity in this catalogue ("Dubai", "tickets", "tour"). */
const STOPWORDS = new Set(
  "a al an and at by de del for from in into of on or over the to with dubai uae tour tours ticket tickets entry experience experiences admission general open dated non day days pass basis sharing shared private standard package packages option options regular any minute minutes min mins hour hours level levels floor floors".split(" "),
);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/**
 * Token weights: words that appear in many supplier tour names ("abu",
 * "dhabi", "desert", "safari", "burj") identify little; rare ones
 * ("helicopter", "aquaventure", "ferrari") identify a lot. Inverse document
 * frequency over the supplier's tour names; unknown words get the top weight.
 */
export type TokenWeights = (token: string) => number;

export function idfWeights(tourNames: string[]): TokenWeights {
  const docs = tourNames.map((n) => new Set(tokens(n)));
  const n = docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);
  return (t) => Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1;
}

const UNIT: TokenWeights = () => 1;

function overlap(a: string[], b: string[], w: TokenWeights = UNIT): { shared: string[]; score: number } {
  const A = new Set(a);
  const B = new Set(b);
  const shared = [...A].filter((t) => B.has(t));
  const union = new Set([...A, ...B]);
  const total = [...union].reduce((s, t) => s + w(t), 0);
  return { shared, score: total === 0 ? 0 : shared.reduce((s, t) => s + w(t), 0) / total };
}

/** "09:30", "9.30 pm", "Approx 9 pm to 10:30 pm", "Start time 09.00 am" → minutes after midnight. */
export function parseSlotTimes(labels: string[]): number[] {
  const out = new Set<number>();
  // The meridiem must end the word ("9 amazing" is not 9 am).
  const re = /\b(\d{1,2})(?:[:.](\d{2}))?(?:\s*(am|pm|a\.m\.|p\.m\.)(?![a-z]))?/gi;
  for (const label of labels) {
    for (const m of label.matchAll(re)) {
      const after = label.slice((m.index ?? 0) + m[0].length).trimStart().toLowerCase();
      // "12 min", "24 hours", "60 minutes" are durations, not times. "15:00 hrs" is a time.
      if (!m[2] && /^(min|mins|minute|minutes|hour|hours|hrs|hr|h\b|days?)/.test(after)) continue;
      let h = Number(m[1]);
      const min = m[2] ? Number(m[2]) : 0;
      const mer = (m[3] ?? "").replace(/\./g, "").toLowerCase();
      if (!m[2] && !mer) continue; // a bare number is not a time
      if (h > 23 || min > 59) continue;
      if (mer === "pm" && h < 12) h += 12;
      if (mer === "am" && h === 12) h = 0;
      out.add(h * 60 + min);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Activity types. When both sides name a type and they share none, the pair is
 * almost certainly a different product that happens to share a place name
 * ("Helicopter over Burj Al Arab" vs "Jet Ski Burj Al Arab").
 */
const ACTIVITY_TYPES: [string, RegExp][] = [
  ["helicopter", /\b(helicopter|heli|gyrocopter)\b/],
  ["jet ski", /\bjet ?skis?\b/],
  ["yacht / boat", /\b(yacht|boat|catamaran|speed ?boat)\b/],
  // "cruise" alone is too generic (dhow cruise, yacht cruise, canal cruise).
  ["dhow", /\bdhow\b/],
  ["balloon", /\bballoon\b/],
  ["buggy / quad", /\b(buggy|buggies|quad|atv|dune buggy)\b/],
  ["desert safari", /\b(desert|safari)\b/],
  ["aquarium", /\b(aquarium|underwater zoo)\b/],
  ["museum", /\bmuseum\b/],
  ["water park", /\b(water ?park|waterpark|aquaventure|water ?world)\b/],
  ["theme park", /\btheme ?park\b/],
  ["dolphin", /\b(dolphin|dolphinarium|sea lion)\b/],
  ["flyboard", /\bfly ?board(ing)?\b/],
  ["donut ride", /\bdonut\b/],
  ["show", /\b(show|perle)\b/],
  ["city tour", /\bcity (tour|sightseeing)\b/],
  ["skydive", /\bsky ?dive\b/],
];

function activityTypes(text: string): Set<string> {
  const t = text.toLowerCase();
  return new Set(ACTIVITY_TYPES.filter(([, re]) => re.test(t)).map(([name]) => name));
}

function pct(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

function aed(minor: bigint): string {
  const whole = minor / 100n;
  const frac = minor % 100n;
  return frac === 0n ? `${whole}` : `${whole}.${String(frac).padStart(2, "0")}`;
}

/** Evaluate one OUTLY variant against one supplier offer. */
export function evaluatePair(
  product: MatchProduct,
  variant: MatchVariant,
  offer: MatchOffer,
  policy: MarginPolicy = PLANNING_MARGIN_POLICY,
  weights: TokenWeights = UNIT,
): CandidateSuggestion {
  const evidence: string[] = [];
  const conflicts: string[] = [];

  const title = overlap(tokens(product.title), tokens(offer.tourName), weights);
  const detail = overlap(tokens(`${product.title} ${variant.name}`), tokens(`${offer.tourName} ${offer.offerName}`), weights);
  if (title.shared.length) evidence.push(`Name overlap: ${title.shared.join(", ")}`);

  const outlyTypes = activityTypes(`${product.title} ${variant.name}`);
  const offerTypes = activityTypes(`${offer.tourName} ${offer.offerName}`);
  const typeMismatch = outlyTypes.size > 0 && offerTypes.size > 0 && ![...outlyTypes].some((t) => offerTypes.has(t));
  if (typeMismatch) conflicts.push(`Different activity: OUTLY ${[...outlyTypes].join("/")} vs TravelDesk ${[...offerTypes].join("/")}`);
  else if (outlyTypes.size > 0 && [...outlyTypes].some((t) => offerTypes.has(t))) evidence.push(`Same activity type: ${[...outlyTypes].filter((t) => offerTypes.has(t)).join("/")}`);

  let structure = 0;
  const offerPrivate = offer.privateType === "private";
  const variantPrivate = variant.isPrivate || product.isPrivate;
  if (offer.privateType !== "unknown" && offerPrivate === variantPrivate) {
    structure += 1;
    evidence.push(offerPrivate ? "Both private" : "Both shared");
  } else if (offer.privateType !== "unknown") {
    conflicts.push(offerPrivate ? "TravelDesk offer is private; OUTLY variant is shared" : "TravelDesk offer is shared; OUTLY variant is private");
  }

  if (product.pickupIncluded && offer.isDirectReporting) conflicts.push("OUTLY includes hotel pickup; offer is direct reporting");
  else if (!product.pickupIncluded && !offer.isDirectReporting) conflicts.push("Offer includes hotel pickup; OUTLY listing does not");
  else {
    structure += 1;
    evidence.push(product.pickupIncluded ? "Both include pickup" : "Both direct reporting");
  }

  if (product.durationMinutes && product.durationMinutes > 0 && offer.durationHours > 0) {
    const ratio = product.durationMinutes / (offer.durationHours * 60);
    if (ratio > 1.5 || ratio < 0.67) conflicts.push(`Duration differs: OUTLY ${product.durationMinutes} min vs TravelDesk ${offer.durationHours} h`);
    else {
      structure += 1;
      evidence.push("Similar duration");
    }
  }

  const outlyTimes = parseSlotTimes(product.timeSlots);
  if (outlyTimes.length && offer.startMinutes.length) {
    const near = outlyTimes.some((t) => offer.startMinutes.some((s) => Math.abs(s - t) <= 45));
    if (near) {
      structure += 1;
      evidence.push("Slot times align (±45 min)");
    } else conflicts.push("Slot times differ by more than 45 minutes");
  }

  if (offer.bookingKind === "on_request") conflicts.push("On-request offer: inquiry only, never instant");
  else if (offer.bookingKind === "unknown") conflicts.push("Unknown booking type");
  else evidence.push(offer.bookingKind === "live_book" ? "Live booking" : "Ticket only (later stage)");
  if (offer.isExternal) conflicts.push("External operator confirms (not first wave)");
  if (/russian/i.test(`${offer.tourName} ${offer.offerName}`)) conflicts.push("Russian-speaking guide");

  const pricedPerTrip = offer.netAdultMinor === 0n && offer.netTripMinor > 0n;
  const net = pricedPerTrip ? offer.netTripMinor : offer.netAdultMinor;
  if (pricedPerTrip && !variantPrivate) conflicts.push("TravelDesk prices per trip/vehicle; OUTLY prices per person");

  let marginBps: number | null = null;
  if (variant.sellAdultMinor > 0n && net > 0n) {
    const m = evaluateMargin({ sellMinor: variant.sellAdultMinor, supplierNetMinor: net }, policy);
    marginBps = m.grossMarginBps;
    if (m.meetsPolicy) evidence.push(`Margin ${pct(marginBps)} before fees (sell ${aed(variant.sellAdultMinor)} vs net ${aed(net)} AED)`);
    else conflicts.push(`Margin ${pct(marginBps)} before fees is below ${pct(policy.minGrossMarginBps)} (sell ${aed(variant.sellAdultMinor)} vs net ${aed(net)} AED)`);
  } else if (net === 0n) conflicts.push("No supplier net price in the catalogue");

  if (variant.sellChildMinor !== null && variant.sellChildMinor > 0n && offer.netChildMinor > 0n && variant.sellChildMinor <= offer.netChildMinor) {
    conflicts.push(`Child price ${aed(variant.sellChildMinor)} does not cover child net ${aed(offer.netChildMinor)} AED`);
  }
  if (variant.sellChildMinor !== null && variant.sellChildMinor > 0n && offer.childAge > 0 && offer.childAge <= 3) {
    conflicts.push(`TravelDesk child rate only under ${offer.childAge}; older children pay the adult net`);
  }

  // Name carries most of the weight, structure the rest. Conflicts do not lower
  // the score: they are shown beside it, so a strong name match with conflicts
  // reads as "same thing, different terms", which is what a reviewer needs.
  const raw = 65 * title.score + 20 * detail.score + 15 * (structure / 4);
  const score = Math.max(0, Math.min(100, Math.round(typeMismatch ? raw / 2 : raw)));

  return {
    variantCode: variant.code,
    tourId: offer.tourId,
    offerId: offer.offerId,
    score,
    evidence,
    conflicts,
    sellAdultMinor: variant.sellAdultMinor,
    netAdultMinor: net,
    pricedPerTrip,
    marginBps,
  };
}

/**
 * Top suggestions per variant. A pair needs at least one shared identity word
 * between the OUTLY title and the supplier tour name; structure alone never
 * makes a candidate.
 */
export function suggestCandidates(product: MatchProduct, offers: MatchOffer[], opts: SuggestOptions = {}): CandidateSuggestion[] {
  const max = opts.maxPerVariant ?? 3;
  const minScore = opts.minScore ?? 25;
  const titleTokens = tokens(product.title);
  const weights = idfWeights([...new Set(offers.map((o) => o.tourName))]);
  const variants = product.variants.length ? product.variants : [];
  const out: CandidateSuggestion[] = [];
  for (const v of variants) {
    const scored = offers
      .filter((o) => overlap(titleTokens, tokens(o.tourName)).shared.length > 0)
      .map((o) => evaluatePair(product, v, o, opts.policy, weights))
      .filter((c) => c.score >= minScore)
      .sort((a, b) => b.score - a.score || a.conflicts.length - b.conflicts.length || Number(a.offerId) - Number(b.offerId));
    out.push(...scored.slice(0, max));
  }
  return out;
}
