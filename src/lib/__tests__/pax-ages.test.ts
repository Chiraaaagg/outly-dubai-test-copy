import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  guestRowAges,
  hasOwnAges,
  listingPaxAges,
  offerPaxAges,
  PAGE_PAX_AGES,
  paxForAges,
  priceLineAges,
  sameBands,
  unitAgesFor,
  variantPaxAges,
  type OfferAgeTerms,
  type PaxAgeBands,
} from "../pax-ages";
import { PAGE_PAX_AGES as PRICING_PAGE_PAX_AGES } from "../pricing";
import type { UnitDefinition } from "@/server/quotes/contracts";
import { ageBandMismatches } from "@/server/suppliers/traveldesk/traveldesk.quote";

/**
 * Own ages (doc 30 N4, owner decision D22, 25 Nov 2026): the guest picker
 * and the supplier age check read each option's own child and infant ages.
 * Pure: synthetic units and offer terms; the ledger block reads the
 * committed doc 29 offer ledger when present.
 */

const unit = (unitId: string, ageMin: number | null, ageMax: number | null, over: Partial<UnitDefinition> = {}): UnitDefinition => ({
  unitId,
  label: unitId,
  per: "person",
  ageMin,
  ageMax,
  residency: "any",
  heightMinCm: null,
  heightMaxCm: null,
  seatConsuming: true,
  minQty: 0,
  maxQty: 10,
  price: { inr: 1000, aed: 40 },
  supplierUnit: unitId,
  ...over,
});

/** The typed units an importer writes for an offer: adult and child always, infant only when the offer accepts infants. */
function unitsFor(offer: OfferAgeTerms, bands: PaxAgeBands): UnitDefinition[] {
  const of = (id: "adult" | "child" | "infant") => {
    const a = unitAgesFor(bands, id);
    return unit(id, a.ageMin, a.ageMax);
  };
  return [of("adult"), ...(offer.childrenAllowed ? [of("child")] : []), ...(offer.infantsAllowed ? [of("infant")] : [])];
}

const terms = (childAge: number, infantsAllowed: boolean, infantAge: number, childrenAllowed = true): OfferAgeTerms => ({ childrenAllowed, childAge, infantsAllowed, infantAge });
const band = (infantMax: number, childMax: number): PaxAgeBands => ({
  adult: { min: childMax + 1, max: null },
  child: { min: infantMax + 1, max: childMax },
  infant: { min: null, max: infantMax },
  senior: { min: 60, max: null },
});

/**
 * Every age rule among the 36 instant-capable offers the page bands block
 * (doc 30 §3.1 item 5, review 98 P30-04), with its count in the ledger and
 * the bands the page then shows.
 */
const BLOCKED_PATTERNS: [string, OfferAgeTerms, number, PaxAgeBands][] = [
  ["child under 8, infants not allowed", terms(8, false, 3), 9, band(2, 7)],
  ["child under 8", terms(8, true, 3), 7, band(2, 7)],
  ["child under 10", terms(10, true, 3), 6, band(2, 9)],
  ["child under 10, infants not allowed", terms(10, false, 3), 5, band(2, 9)],
  ["infant under 2", terms(12, true, 2), 3, band(1, 11)],
  ["child under 11", terms(11, true, 3), 3, band(2, 10)],
  ["child under 7", terms(7, true, 3), 1, band(2, 6)],
  ["child under 8, infants (under 2) not allowed", terms(8, false, 2), 1, band(2, 7)],
  ["child under 10, infant under 4", terms(10, true, 4), 1, band(2, 9)],
];

describe("page bands (parity: listings without offer ages behave exactly as before)", () => {
  it("the page's own bands are unchanged and still exported from pricing", () => {
    expect(PAGE_PAX_AGES).toEqual({ adult: { min: 12, max: null }, child: { min: 3, max: 11 }, infant: { min: null, max: 2 }, senior: { min: 60, max: null } });
    expect(PRICING_PAGE_PAX_AGES).toBe(PAGE_PAX_AGES);
  });

  it.each<[string, { units?: UnitDefinition[] } | undefined]>([
    ["no variant", undefined],
    ["no typed units (inquiry pricing)", {}],
    ["empty units", { units: [] }],
    ["units without ages", { units: [unit("adult", null, null), unit("child", null, null), unit("infant", null, null)] }],
    ["units with the page's own ages", { units: [unit("adult", 12, null), unit("child", 3, 11), unit("infant", 0, 2)] }],
    ["units wider than the page", { units: [unit("adult", null, null), unit("child", 2, 13), unit("infant", null, 4)] }],
    ["adult only", { units: [unit("adult", null, null)] }],
    ["a per-booking unit named child", { units: [unit("adult", null, null), unit("child", null, 5, { per: "booking" })] }],
  ])("%s → the page's bands, hints and rows", (_n, variant) => {
    const bands = variantPaxAges(variant);
    expect(bands).toEqual(PAGE_PAX_AGES);
    expect(hasOwnAges(bands!)).toBe(false);
    expect(guestRowAges(variant)).toEqual({
      adult: { hint: "Age 12+", srHint: "Age 12 and over", allowed: true },
      child: { hint: "Age 3–11", srHint: "Ages 3 to 11", allowed: true },
      infant: { hint: "Under 3 · usually free", srHint: "Under 3, usually free", allowed: true },
      senior: { hint: "Age 60+ · reduced rate on many activities", srHint: "Age 60 and over, reduced rate on many activities", allowed: true },
    });
  });

  it("an offer with the page's ages or wider gives the page's bands", () => {
    for (const offer of [terms(12, true, 3), terms(12, false, 3), terms(14, true, 5), terms(18, false, 4), terms(0, false, 0, false), terms(12, false, 0)]) {
      expect(offerPaxAges(offer)).toEqual(PAGE_PAX_AGES);
    }
  });

  it("page price lines keep their wording", () => {
    expect(priceLineAges(PAGE_PAX_AGES)).toEqual({ child: "Child (3–11)", infant: "Infant (under 3)" });
    expect(listingPaxAges({ variants: [] })).toEqual(PAGE_PAX_AGES);
    expect(listingPaxAges({ variants: [{}, { units: [unit("adult", null, null)] }] })).toEqual(PAGE_PAX_AGES);
  });

  it("the party is untouched (same object) when every row is open", () => {
    const pax = { adult: 2, child: 1, infant: 1, senior: 1 };
    expect(paxForAges(pax, guestRowAges(undefined))).toBe(pax);
    expect(paxForAges(pax, guestRowAges({ units: [unit("adult", null, null)] }))).toBe(pax);
  });
});

describe("the offer's own bands (D22): each blocked pattern", () => {
  it("the patterns cover the 36 blocked offers", () => {
    expect(BLOCKED_PATTERNS.reduce((n, [, , count]) => n + count, 0)).toBe(36);
  });

  it.each(BLOCKED_PATTERNS)("%s", (_n, offer, _count, expected) => {
    // Today: the page's own bands block the offer.
    expect(ageBandMismatches(offer, PAGE_PAX_AGES)).not.toEqual([]);

    const bands = offerPaxAges(offer)!;
    expect(bands).toEqual(expected);
    // Written into content and read back, the same bands; the supplier check then passes.
    const units = unitsFor(offer, bands);
    expect(variantPaxAges({ units })).toEqual(bands);
    expect(ageBandMismatches(offer, bands)).toEqual([]);

    // The picker shows them; a row the offer does not accept is closed.
    const rows = guestRowAges({ units });
    expect(rows.adult.hint).toBe(`Age ${expected.adult.min}+`);
    expect(rows.child).toEqual({ hint: `Age ${expected.child.min}–${expected.child.max}`, srHint: `Ages ${expected.child.min} to ${expected.child.max}`, allowed: true });
    expect(rows.infant.allowed).toBe(offer.infantsAllowed);
    expect(rows.infant.hint).toBe(offer.infantsAllowed ? `Under ${expected.infant.max! + 1} · usually free` : `Under ${expected.infant.max! + 1} · not available on this option`);
  });

  it("a child older than the offer's band is refused (the page may not reach past the offer)", () => {
    for (const [, offer, , bands] of BLOCKED_PATTERNS) {
      const wider = variantPaxAges({ units: [unit("adult", null, null), unit("child", null, offer.childAge), unit("infant", null, bands.infant.max)] })!;
      if (offer.childAge <= 11) expect(ageBandMismatches(offer, wider)).toContain("child");
    }
    // An infant as old as the offer's infant limit is a TravelDesk child.
    const infantUnder2 = terms(12, true, 2);
    expect(ageBandMismatches(infantUnder2, variantPaxAges({ units: [unit("adult", null, null), unit("child", null, null), unit("infant", null, 2)] })!)).toEqual(["infant"]);
  });

  it("infants not allowed: no infant check, no infant unit, the infant row is closed and its count dropped", () => {
    const offer = terms(8, false, 3);
    const bands = offerPaxAges(offer)!;
    const units = unitsFor(offer, bands);
    expect(units.map((u) => u.unitId)).toEqual(["adult", "child"]);
    expect(ageBandMismatches(offer, bands)).toEqual([]);
    const rows = guestRowAges({ units });
    expect(rows.infant).toEqual({ hint: "Under 3 · not available on this option", srHint: "Under 3, not available on this option", allowed: false });
    expect(paxForAges({ adult: 2, child: 1, infant: 1, senior: 0 }, rows)).toEqual({ adult: 2, child: 1, infant: 0, senior: 0 });
  });

  it("children not allowed with an own infant age: the child row is closed", () => {
    const units = [unit("adult", 2, null), unit("infant", null, 1)];
    const rows = guestRowAges({ units });
    expect(rows.child.allowed).toBe(false);
    expect(rows.child.hint).toBe("Age 2–11 · not available on this option");
  });

  it("unknown ages or ages with no room for a child give no bands", () => {
    expect(offerPaxAges(terms(0, true, 3))).toBeNull();
    expect(offerPaxAges(terms(8, true, 0))).toBeNull();
    expect(offerPaxAges(terms(2, true, 3))).toBeNull();
    expect(variantPaxAges({ units: [unit("adult", null, null), unit("child", null, 2), unit("infant", null, 2)] })).toBeNull();
    // The picker then falls back to the page's wording; readiness refuses the variant (readiness.service.test.ts).
    expect(guestRowAges({ units: [unit("adult", null, null), unit("child", null, 2), unit("infant", null, 2)] }).child.hint).toBe("Age 3–11");
  });

  it("a listing whose options differ leaves the price-line ages to the option", () => {
    const v8 = { units: unitsFor(terms(8, true, 3), band(2, 7)) };
    const v10 = { units: unitsFor(terms(10, true, 3), band(2, 9)) };
    expect(listingPaxAges({ variants: [v8, v8] })).toEqual(band(2, 7));
    expect(priceLineAges(band(2, 7))).toEqual({ child: "Child (3–7)", infant: "Infant (under 3)" });
    expect(priceLineAges(band(1, 11))).toEqual({ child: "Child (2–11)", infant: "Infant (under 2)" });
    expect(listingPaxAges({ variants: [v8, v10] })).toBeNull();
    expect(priceLineAges(null)).toEqual({ child: "Child (age by option)", infant: "Infant (age by option)" });
    // The picker follows the selected option.
    expect(guestRowAges(v8).child.hint).toBe("Age 3–7");
    expect(guestRowAges(v10).child.hint).toBe("Age 3–9");
  });

  it("sameBands compares every edge", () => {
    expect(sameBands(band(2, 11), PAGE_PAX_AGES)).toBe(true);
    expect(sameBands(band(2, 10), PAGE_PAX_AGES)).toBe(false);
    expect(sameBands(band(1, 11), PAGE_PAX_AGES)).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 * The committed offer ledger (doc 29a): the counts doc 30 states
 * ------------------------------------------------------------------------ */

const LEDGER = path.join(process.cwd(), "docs/backend/29a-offer-coverage-ledger.csv");

/** RFC 4180 rows (quoted fields may hold commas). */
function csvRows(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) out.push([...row, cell]);
  return out;
}

describe.skipIf(!existsSync(LEDGER))("the doc 29a ledger: own ages open the 36 blocked offers and change no other page", () => {
  const [header, ...body] = csvRows(readFileSync(LEDGER, "utf8"));
  const rows = body.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  // Instant-capable: priced per person and planned in a batch (doc 30 §1.2: 196).
  const capable = rows.filter((r) => r.dimPricingUnit === "per_person" && r.planBatch !== "INQUIRY" && r.planBatch !== "REVIEW");
  const termsOf = (r: Record<string, string>): OfferAgeTerms => ({
    childrenAllowed: r.childrenAllowed === "true",
    childAge: Number(r.childUnderAge || 0),
    infantsAllowed: r.infantsAllowed === "true",
    infantAge: Number(r.infantUnderAge || 0),
  });

  it("196 instant-capable offers; 36 in 14 tours blocked by the page bands (3 pickup, 29 external, 4 tickets)", () => {
    expect(capable).toHaveLength(196);
    const blocked = capable.filter((r) => ageBandMismatches(termsOf(r), PAGE_PAX_AGES).length > 0);
    expect(blocked).toHaveLength(36);
    expect(new Set(blocked.map((r) => r.tourId)).size).toBe(14);
    const by = (b: string) => blocked.filter((r) => r.planBatch === b).length;
    expect([by("B3"), by("B6"), by("B5")]).toEqual([3, 29, 4]);
  });

  it("with the offer's own bands none is blocked, and every other offer keeps the page's bands", () => {
    for (const r of capable) {
      const offer = termsOf(r);
      const bands = offerPaxAges(offer);
      expect(bands, `offer ${r.offerId}`).not.toBeNull();
      expect(ageBandMismatches(offer, bands!), `offer ${r.offerId}`).toEqual([]);
      expect(variantPaxAges({ units: unitsFor(offer, bands!) }), `offer ${r.offerId}`).toEqual(bands);
      const wasBlocked = ageBandMismatches(offer, PAGE_PAX_AGES).length > 0;
      expect(hasOwnAges(bands!), `offer ${r.offerId}`).toBe(wasBlocked);
    }
  });

  it("15 instant groups hold offers with different age rules; 2 of them show different bands", () => {
    const raw = new Map<string, Set<string>>();
    const shown = new Map<string, Set<string>>();
    for (const r of capable) {
      const key = `${r.tourId}|${r.targetCapabilityClass}`;
      const t = termsOf(r);
      raw.set(key, (raw.get(key) ?? new Set()).add(JSON.stringify(t)));
      shown.set(key, (shown.get(key) ?? new Set()).add(JSON.stringify(offerPaxAges(t))));
    }
    expect([...raw.values()].filter((s) => s.size > 1)).toHaveLength(15);
    expect([...shown.values()].filter((s) => s.size > 1)).toHaveLength(2);
  });
});
