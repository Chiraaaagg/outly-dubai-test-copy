import type { PaxCount, Variant } from "./types";

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
 * usually free"). With own bands they follow the variant, and a child or
 * infant row the variant has no typed unit for reads "not available on this
 * option" and cannot be increased: the quote would refuse it (unknown unit).
 * Rows of a variant with the page's bands are never closed here, so a
 * listing without offer ages keeps every row it had.
 */
export function guestRowAges(variant: Pick<Variant, "units"> | undefined): Record<PaxAgeType, GuestRowAge> {
  const bands = variantPaxAges(variant) ?? PAGE_PAX_AGES;
  const own = hasOwnAges(bands);
  const units = variant?.units ?? [];
  const sells = (id: PaxAgeType) => !own || units.length === 0 || units.some((u) => u.unitId === id);
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
