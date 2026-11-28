import type { FulfilmentMode, PaxCount, Variant } from "./types";

/**
 * Age bands per pax type (doc 30 N4, owner decision D22, 25 Nov 2026).
 *
 * The page's own bands (`PAGE_PAX_AGES`) are the default. A variant whose
 * typed units carry narrower child or infant ages shows and sells those
 * instead: the guest picker's hints, the activity page's price lines,
 * readiness (`unitRestricted`) and the supplier age check
 * (`ageBandMismatches`) all read the same bands from this file, so what the
 * page tells the traveller is what the server checks.
 *
 * Own bands only ever narrow the page's: a unit whose ages reach wider than
 * the page's (or carry none) leaves the page bands exactly as before, so a
 * listing without offer ages behaves as it did. The bands tile the ages
 * with no gap: infants up to `infant.max`, children from `infant.max + 1`
 * to `child.max`, adults from `child.max + 1`. Seniors are unchanged.
 */

/** One pax type's age band: inclusive whole years on the service date, null for no limit. */
export interface PaxAgeBand {
  min: number | null;
  max: number | null;
}

export type PaxAgeType = "adult" | "child" | "infant" | "senior";
export type PaxAgeBands = Record<PaxAgeType, PaxAgeBand>;

/**
 * The ages the page itself gives each pax type (adults 12+, children 3–11,
 * infants under 3, seniors 60+). Readiness keeps a unit whose own age range
 * is narrower than its variant's bands out of instant sale (`unitRestricted`).
 */
export const PAGE_PAX_AGES: PaxAgeBands = {
  adult: { min: 12, max: null },
  child: { min: 3, max: 11 },
  infant: { min: null, max: 2 },
  senior: { min: 60, max: null },
};

const DEFAULT_CHILD_MAX = PAGE_PAX_AGES.child.max as number;
const DEFAULT_INFANT_MAX = PAGE_PAX_AGES.infant.max as number;

/** Bands from an infant and a child upper age, each already capped at the page's; null when they leave no child age. */
function bandsFrom(infantMax: number, childMax: number): PaxAgeBands | null {
  if (infantMax < 0 || childMax < infantMax + 1) return null;
  return {
    adult: { min: childMax + 1, max: null },
    child: { min: infantMax + 1, max: childMax },
    infant: { min: null, max: infantMax },
    senior: { ...PAGE_PAX_AGES.senior },
  };
}

/**
 * The bands a variant sells, from its typed per-person units: the child
 * unit's `ageMax` and the infant unit's `ageMax`, each capped at the page's.
 * No units, or units without those ages, give `PAGE_PAX_AGES`. Null when
 * the ages leave no room for a child (an infant band reaching the child's
 * top): readiness then refuses the variant, and the page shows its own.
 */
export function variantPaxAges(variant: Pick<Variant, "units"> | undefined): PaxAgeBands | null {
  const units = (variant?.units ?? []).filter((u) => u.per === "person");
  const childMax = units.find((u) => u.unitId === "child")?.ageMax ?? null;
  const infantMax = units.find((u) => u.unitId === "infant")?.ageMax ?? null;
  return bandsFrom(Math.min(DEFAULT_INFANT_MAX, infantMax ?? DEFAULT_INFANT_MAX), Math.min(DEFAULT_CHILD_MAX, childMax ?? DEFAULT_CHILD_MAX));
}

/** The four age facts a TravelDesk offer gives (`StoredOffer`): a child is priced under `childAge`, an infant under `infantAge`. */
export interface OfferAgeTerms {
  childrenAllowed: boolean;
  childAge: number;
  infantsAllowed: boolean;
  infantAge: number;
}

/**
 * The bands an offer can be sold under: children under `childAge`, infants
 * under `infantAge`, each capped at the page's band (a supplier band that
 * reaches higher only books the guest in a cheaper category than the one we
 * priced). A unit the offer does not accept keeps the page's band; its row
 * is then not sold at all. Null when an accepted unit's age is unknown (0 or
 * less) or the ages leave no child age: the offer then stays inquiry.
 *
 * Content written from these bands (`unitAgesFor`) reads back the same
 * bands through `variantPaxAges` and passes `ageBandMismatches`.
 */
export function offerPaxAges(offer: OfferAgeTerms): PaxAgeBands | null {
  if (offer.childrenAllowed && offer.childAge <= 0) return null;
  if (offer.infantsAllowed && offer.infantAge <= 0) return null;
  const infantMax = offer.infantsAllowed ? Math.min(DEFAULT_INFANT_MAX, offer.infantAge - 1) : DEFAULT_INFANT_MAX;
  const childMax = offer.childrenAllowed ? Math.min(DEFAULT_CHILD_MAX, offer.childAge - 1) : DEFAULT_CHILD_MAX;
  return bandsFrom(infantMax, childMax);
}

/** The `ageMin` / `ageMax` a typed unit carries for a band (the importer and editor write these). */
export function unitAgesFor(bands: PaxAgeBands, unitId: PaxAgeType): { ageMin: number | null; ageMax: number | null } {
  const b = bands[unitId];
  return { ageMin: b.min, ageMax: b.max };
}

export function sameBands(a: PaxAgeBands, b: PaxAgeBands): boolean {
  return (Object.keys(PAGE_PAX_AGES) as PaxAgeType[]).every((t) => a[t].min === b[t].min && a[t].max === b[t].max);
}

/** Whether these bands differ from the page's own. */
export function hasOwnAges(bands: PaxAgeBands): boolean {
  return !sameBands(bands, PAGE_PAX_AGES);
}

/**
 * The bands every variant of a listing shares, for page-level text (the
 * price lines under the headline price). Null when the variants disagree:
 * the hint then follows the selected option in the guest picker only.
 */
export function listingPaxAges(activity: { variants: Pick<Variant, "units">[] }): PaxAgeBands | null {
  const all = activity.variants.length ? activity.variants.map((v) => variantPaxAges(v) ?? PAGE_PAX_AGES) : [PAGE_PAX_AGES];
  return all.every((b) => sameBands(b, all[0])) ? all[0] : null;
}

/** One guest row's age wording: the visible hint, the same for screen readers in words, and whether the row can be booked. */
export interface GuestRowAge {
  hint: string;
  srHint: string;
  allowed: boolean;
}

const SENIOR: GuestRowAge = { hint: "Age 60+ · reduced rate on many activities", srHint: "Age 60 and over, reduced rate on many activities", allowed: true };

/**
 * The guest picker's age wording for a variant. With the page's own bands
 * the hints are exactly the page's ("Age 12+", "Age 3–11", "Under 3 ·
 * usually free"); with own bands they follow the variant.
 *
 * On an instant listing (`mode`, the page's effective fulfilment mode), a
 * variant with typed units books a child or infant row only when it has a
 * per-person unit of that id, whatever its bands: any other row reads "not
 * available on this option" and cannot be increased, as the quote would
 * refuse it (`unknown_unit`). Before this, a variant with the page's bands
 * kept every row open, so an adult-only option took children and infants
 * the quote then refused (guest picker fix, 28 Nov 2026). A variant without
 * typed units keeps every row, the way the Seniors row is decided
 * (`offersSeniorPrice`).
 *
 * An inquiry listing keeps its rows as before (owner decision D2): only a
 * variant with its own bands closes a row it has no unit for (doc 30 N4).
 * No server quote prices an inquiry, and the team books every guest.
 */
export function guestRowAges(variant: Pick<Variant, "units"> | undefined, mode: FulfilmentMode = "instant"): Record<PaxAgeType, GuestRowAge> {
  const bands = variantPaxAges(variant) ?? PAGE_PAX_AGES;
  const units = variant?.units ?? [];
  const unitsDecide = units.length > 0 && (mode === "instant" || hasOwnAges(bands));
  // The same units `variantPaxAges` reads: per person only (review 102 N4-07); a per-booking unit never opens a row.
  const sells = (id: PaxAgeType) => !unitsDecide || units.some((u) => u.per === "person" && u.unitId === id);
  const adultMin = bands.adult.min as number;
  const child = bands.child as { min: number; max: number };
  const infantUnder = (bands.infant.max as number) + 1;
  return {
    adult: { hint: `Age ${adultMin}+`, srHint: `Age ${adultMin} and over`, allowed: true },
    child: sells("child")
      ? { hint: `Age ${child.min}–${child.max}`, srHint: `Ages ${child.min} to ${child.max}`, allowed: true }
      : { hint: `Age ${child.min}–${child.max} · not available on this option`, srHint: `Ages ${child.min} to ${child.max}, not available on this option`, allowed: false },
    infant: sells("infant")
      ? { hint: `Under ${infantUnder} · usually free`, srHint: `Under ${infantUnder}, usually free`, allowed: true }
      : { hint: `Under ${infantUnder} · not available on this option`, srHint: `Under ${infantUnder}, not available on this option`, allowed: false },
    senior: SENIOR,
  };
}

/** The party with every row the variant cannot book set to 0 (the picker shows, prices and carts this); the same object when nothing changes. */
export function paxForAges(pax: PaxCount, ages: Record<PaxAgeType, GuestRowAge>): PaxCount {
  const closed = (Object.keys(ages) as PaxAgeType[]).filter((t) => !ages[t].allowed && pax[t] > 0);
  if (closed.length === 0) return pax;
  return { ...pax, ...Object.fromEntries(closed.map((t) => [t, 0])) };
}

/** Price-line age labels for the page ("Child (3–11)", "Infant (under 3)"); without shared bands, the age is left to the option. */
export function priceLineAges(bands: PaxAgeBands | null): { child: string; infant: string } {
  if (!bands) return { child: "Child (age by option)", infant: "Infant (age by option)" };
  return { child: `Child (${bands.child.min}–${bands.child.max})`, infant: `Infant (under ${(bands.infant.max as number) + 1})` };
}

/** The listing facts the page-level price lines read: its options and its effective fulfilment mode. */
type ListingGuests = { variants: Pick<Variant, "units">[]; fulfilmentMode: FulfilmentMode };

/**
 * Whether any option of the listing can book infants (review 102 N4-05):
 * false only when the picker closes the infant row on every option. The
 * page then shows no "Infant … Free" line.
 */
export function listingSellsInfants(activity: ListingGuests): boolean {
  return activity.variants.length === 0 || activity.variants.some((v) => guestRowAges(v, activity.fulfilmentMode).infant.allowed);
}

/**
 * The same for children (guest picker fix): false only when an instant
 * listing has no option with a child row; the page then shows no child
 * price line. An inquiry listing always keeps it (owner decision D2).
 */
export function listingSellsChildren(activity: ListingGuests): boolean {
  if (activity.fulfilmentMode !== "instant") return true;
  return activity.variants.length === 0 || activity.variants.some((v) => guestRowAges(v, activity.fulfilmentMode).child.allowed);
}

/**
 * The most guests of each type an instant option takes (guest picker fix,
 * D3): the `maxQty` of its per-person unit for that row, which the quote
 * enforces (`unit_rule_failed`). No entry for a row without one, and none
 * at all on an inquiry listing or an option without typed units.
 */
export function guestRowLimits(variant: Pick<Variant, "units"> | undefined, mode: FulfilmentMode = "instant"): Partial<Record<PaxAgeType, number>> {
  if (mode !== "instant") return {};
  const out: Partial<Record<PaxAgeType, number>> = {};
  for (const u of variant?.units ?? []) if (u.per === "person" && Object.hasOwn(ROW_WORDS, u.unitId)) out[u.unitId as PaxAgeType] = u.maxQty;
  return out;
}

/**
 * The fewest guests of each type an instant option takes (re-review 111b
 * N4): the `minQty` of its per-person unit for that row, when above 0. The
 * quote refuses fewer, even none (`unit_rule_failed`); the importer writes
 * 0, so this is rare. Same scope as `guestRowLimits`.
 */
export function guestRowMinimums(variant: Pick<Variant, "units"> | undefined, mode: FulfilmentMode = "instant"): Partial<Record<PaxAgeType, number>> {
  if (mode !== "instant") return {};
  const out: Partial<Record<PaxAgeType, number>> = {};
  for (const u of variant?.units ?? []) if (u.per === "person" && Object.hasOwn(ROW_WORDS, u.unitId) && u.minQty > 0) out[u.unitId as PaxAgeType] = u.minQty;
  return out;
}

const ROW_WORDS: Record<PaxAgeType, [string, string]> = { adult: ["adult", "adults"], child: ["child", "children"], infant: ["infant", "infants"], senior: ["senior", "seniors"] };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What the guest is told while a row holds more guests than the option
 * takes (`guestRowLimits`), or fewer than it needs (`guestRowMinimums`);
 * null when every row is within them.
 */
export function guestLimitNotice(
  pax: PaxCount,
  limits: Partial<Record<PaxAgeType, number>>,
  minimums: Partial<Record<PaxAgeType, number>> = {},
): string | null {
  const parts: string[] = [];
  let under = false;
  for (const t of Object.keys(ROW_WORDS) as PaxAgeType[]) {
    const max = limits[t];
    const min = minimums[t];
    if (max !== undefined && pax[t] > max) parts.push(`This option takes up to ${plural(max, ...ROW_WORDS[t])} online.`);
    else if (min !== undefined && pax[t] < min) {
      under = true;
      parts.push(`This option takes at least ${plural(min, ...ROW_WORDS[t])} online.`);
    }
  }
  if (parts.length === 0) return null;
  return `${parts.join(" ")} ${under ? "Change the number to continue." : "Lower the number to continue."}`;
}

/**
 * What the guest is told when they switch option and the ages behind a
 * count they already set change (review 102 N4-02, N4-06): a row the new
 * option cannot book, and its count dropped, or a band that now reads
 * differently. Null when nothing they set is affected. The booking widget
 * shows it above the guest rows in a polite live region.
 */
export function guestAgesNotice(
  before: Pick<Variant, "units"> | undefined,
  after: Pick<Variant, "units"> | undefined,
  pax: PaxCount,
  mode: FulfilmentMode = "instant",
): string | null {
  const was = variantPaxAges(before) ?? PAGE_PAX_AGES;
  const now = variantPaxAges(after) ?? PAGE_PAX_AGES;
  const rows = guestRowAges(after, mode);
  const parts: string[] = [];
  const dropped = (n: number, one: string, many: string) =>
    parts.push(`This option doesn't take ${many}, so ${plural(n, one, many)} ${n === 1 ? "was" : "were"} removed from your guests.`);
  if (pax.child > 0 && !rows.child.allowed) dropped(pax.child, "child", "children");
  if (pax.infant > 0 && !rows.infant.allowed) dropped(pax.infant, "infant", "infants");
  const counts: string[] = [];
  // Adults only when the band starts later: a guest counted as an adult may now be a child. Earlier never misplaces one.
  if (pax.adult > 0 && (now.adult.min as number) > (was.adult.min as number)) counts.push(`adults as age ${now.adult.min} and over`);
  if (pax.child > 0 && rows.child.allowed && (was.child.min !== now.child.min || was.child.max !== now.child.max)) counts.push(`children as ages ${now.child.min} to ${now.child.max}`);
  if (pax.infant > 0 && rows.infant.allowed && was.infant.max !== now.infant.max) counts.push(`infants as under ${(now.infant.max as number) + 1}`);
  if (counts.length) parts.push(`This option counts ${counts.join(", ")}. Check your guest numbers.`);
  return parts.length ? parts.join(" ") : null;
}

/** The two band edges a quote line carries (review 102 N4-01): the ages the guest chose their rows against. */
export interface QuoteLineAges {
  childMax: number;
  infantMax: number;
}

/** The band edges of a variant as the picker showed them (the page's own when its ages leave no child age). */
export function quoteLineAges(variant: Pick<Variant, "units"> | undefined): QuoteLineAges {
  const bands = variantPaxAges(variant) ?? PAGE_PAX_AGES;
  return { childMax: bands.child.max as number, infantMax: bands.infant.max as number };
}

/** Whether a line's shown ages are still the variant's bands; a null band (no child age left) never matches. */
export function quoteLineAgesMatch(shown: QuoteLineAges, bands: PaxAgeBands | null): boolean {
  return bands !== null && bands.child.max === shown.childMax && bands.infant.max === shown.infantMax;
}
