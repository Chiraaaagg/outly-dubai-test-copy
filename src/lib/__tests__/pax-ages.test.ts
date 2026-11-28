import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  guestAgesNotice,
  guestRowAges,
  hasOwnAges,
  listingPaxAges,
  listingSellsChildren,
  listingSellsInfants,
  offerPaxAges,
  PAGE_PAX_AGES,
  paxForAges,
  priceLineAges,
  quoteLineAges,
  quoteLineAgesMatch,
  sameBands,
  unitAgesFor,
  variantPaxAges,
  type OfferAgeTerms,
  type PaxAgeBands,
} from "../pax-ages";
import { computeBreakdown, guestOptionSwitch, PAGE_PAX_AGES as PRICING_PAGE_PAX_AGES, toCartItem } from "../pricing";
import { quoteLinesFor } from "../api";
import { inquiryHref, inquiryReasonForQuote, inquiryReasonText, parseInquiryReason } from "../inquiry-handoff";
import type { Activity, Variant } from "../types";
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
    // Guest picker fix: typed units open a row only with a unit of its own, so this option carries all three.
    expect(paxForAges(pax, guestRowAges({ units: [unit("adult", null, null), unit("child", null, null), unit("infant", null, null)] }))).toBe(pax);
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
  // describe.skipIf still runs this body while collecting, so read only when the ledger exists.
  const [header, ...body] = existsSync(LEDGER) ? csvRows(readFileSync(LEDGER, "utf8")) : [[] as string[]];
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

/* ---------------------------------------------------------------------------
 * Review 102 fix round: shown ages on the cart and quote line (N4-01),
 * option switching (N4-02, N4-06, N4-10), infants on the price lines (N4-05)
 * ------------------------------------------------------------------------ */

describe("the ages the guests were chosen against travel with the line (N4-01)", () => {
  const own = { id: "kids-under-8", name: "Kids under 8", delta: { inr: 0, aed: 0 }, units: unitsFor(terms(8, true, 3), band(2, 7)) } as unknown as Variant;
  const plain = { id: "std", name: "Standard", delta: { inr: 0, aed: 0 }, units: [unit("adult", null, null), unit("child", null, null)] } as unknown as Variant;
  const activity = {
    slug: "zz-synthetic",
    title: "Synthetic",
    images: ["/img/x.jpg"],
    productId: "0190a000-0000-7000-8000-000000000001",
    price: { adult: { inr: 1000, aed: 40 }, child: { inr: 800, aed: 32 } },
    variants: [own, plain],
    addOns: [],
    quoteOnly: false,
    confirmation: "instant",
    fulfilmentMode: "instant",
    freeCancellationHours: 0,
    durationMinutes: 60,
    pickupIncluded: false,
    timeSlots: ["09:00"],
  } as unknown as Activity;
  const pax = { adult: 2, child: 1, infant: 0, senior: 0 };

  it("the cart line records the option's band edges, the page's own for a page-band option", () => {
    expect(quoteLineAges(own)).toEqual({ childMax: 7, infantMax: 2 });
    expect(quoteLineAges(plain)).toEqual({ childMax: 11, infantMax: 2 });
    expect(quoteLineAges(undefined)).toEqual({ childMax: 11, infantMax: 2 });
    expect(toCartItem(activity, { date: "2026-12-01", time: "09:00", pax, variantId: own.id }).ages).toEqual({ childMax: 7, infantMax: 2 });
  });

  it("the quote line carries the cart line's ages; a cart from before N4 sends none", () => {
    const line = toCartItem(activity, { date: "2026-12-01", time: "09:00", pax, variantId: own.id });
    const { ages: _drop, ...old } = line;
    void _drop;
    const lines = quoteLinesFor([line, { ...old, id: "old", date: "2026-12-02" }], [activity])!;
    expect(lines[0].ages).toEqual({ childMax: 7, infantMax: 2 });
    expect(lines[1]).not.toHaveProperty("ages");
  });

  it("matching is exact on both edges; bands with no child age never match", () => {
    expect(quoteLineAgesMatch({ childMax: 7, infantMax: 2 }, band(2, 7))).toBe(true);
    expect(quoteLineAgesMatch({ childMax: 7, infantMax: 2 }, band(2, 5))).toBe(false);
    expect(quoteLineAgesMatch({ childMax: 7, infantMax: 2 }, band(1, 7))).toBe(false);
    expect(quoteLineAgesMatch({ childMax: 11, infantMax: 2 }, null)).toBe(false);
  });

  it("a refused line says the ages changed", () => {
    expect(inquiryReasonForQuote(["ages_changed"])).toBe("ages");
    expect(inquiryReasonText("ages")).toMatch(/changed since you chose your guests/);
    expect(parseInquiryReason(new URL(inquiryHref("ages"), "https://outlyy.test").searchParams.get("reason"))).toBe("ages");
  });
});

describe("switching option tells the guest when a count they set is affected (N4-02, N4-06)", () => {
  const p = (adult: number, child: number, infant: number) => ({ adult, child, infant, senior: 0 });
  const page = { units: [unit("adult", null, null), unit("child", null, null), unit("infant", null, null)] };
  const under8 = { units: unitsFor(terms(8, true, 3), band(2, 7)) };
  const under8NoInfants = { units: unitsFor(terms(8, false, 3), band(2, 7)) };
  const infantUnder2 = { units: unitsFor(terms(12, true, 2), band(1, 11)) };

  it("nothing to say: same bands, or the changed rows have no guests", () => {
    expect(guestAgesNotice(page, page, p(2, 1, 1))).toBeNull();
    // An option with an adult and a child unit, and no infants set: nothing it cannot book (guest picker fix: adult only would drop the child).
    expect(guestAgesNotice(undefined, { units: [unit("adult", null, null), unit("child", null, null)] }, p(2, 1, 0))).toBeNull();
    // Adults from 12 to 8: nobody counted as an adult can now be a child.
    expect(guestAgesNotice(page, under8, p(2, 0, 0))).toBeNull();
  });

  it("a child band that changes while children are set", () => {
    expect(guestAgesNotice(page, under8, p(2, 1, 0))).toBe("This option counts children as ages 3 to 7. Check your guest numbers.");
  });

  it("adults whose band now starts later, as a guest counted as an adult may now be a child", () => {
    expect(guestAgesNotice(under8, page, p(2, 0, 0))).toBe("This option counts adults as age 12 and over. Check your guest numbers.");
    expect(guestAgesNotice(under8, page, p(2, 1, 0))).toBe("This option counts adults as age 12 and over, children as ages 3 to 11. Check your guest numbers.");
  });

  it("an infant band that changes while infants are set", () => {
    expect(guestAgesNotice(page, infantUnder2, p(1, 0, 1))).toBe("This option counts infants as under 2. Check your guest numbers.");
  });

  it("a row the option cannot book: its count is dropped and said in words", () => {
    expect(guestAgesNotice(under8, under8NoInfants, p(2, 0, 1))).toBe("This option doesn't take infants, so 1 infant was removed from your guests.");
    expect(guestAgesNotice(page, under8NoInfants, p(2, 2, 2))).toBe(
      "This option doesn't take infants, so 2 infants were removed from your guests. This option counts children as ages 3 to 7. Check your guest numbers.",
    );
    expect(paxForAges(p(2, 2, 2), guestRowAges(under8NoInfants))).toEqual(p(2, 2, 0));
  });

  it("closed rows read the same units as the bands: a per-booking unit never opens a row (N4-07)", () => {
    const units = [...under8NoInfants.units, unit("infant", null, null, { per: "booking" })];
    expect(guestRowAges({ units }).infant.allowed).toBe(false);
  });
});

describe("the page's infant price line (N4-05)", () => {
  const under8 = { units: unitsFor(terms(8, true, 3), band(2, 7)) };
  const under8NoInfants = { units: unitsFor(terms(8, false, 3), band(2, 7)) };
  it("is shown unless no option can book infants", () => {
    expect(listingSellsInfants({ variants: [] })).toBe(true);
    expect(listingSellsInfants({ variants: [{}, { units: [unit("adult", null, null)] }] })).toBe(true);
    expect(listingSellsInfants({ variants: [under8NoInfants, under8] })).toBe(true);
    expect(listingSellsInfants({ variants: [under8NoInfants, under8NoInfants] })).toBe(false);
  });
});

describe("the option-switch step of the guest picker (re-review R1)", () => {
  const p = (adult: number, child: number, infant: number) => ({ adult, child, infant, senior: 0 });
  const plain = { id: "std", name: "Standard", delta: { inr: 0, aed: 0 }, units: [unit("adult", null, null), unit("child", null, null), unit("infant", null, null)] } as unknown as Variant;
  const own = { id: "kids-under-8", name: "Kids under 8", delta: { inr: 0, aed: 0 }, units: unitsFor(terms(8, false, 3), band(2, 7)) } as unknown as Variant;
  const activity = { variants: [plain, own] };

  it("a real switch gives the notice and drops the closed row's count", () => {
    expect(guestOptionSwitch(activity, "std", "kids-under-8", p(2, 1, 1))).toEqual({
      notice: "This option doesn't take infants, so 1 infant was removed from your guests. This option counts children as ages 3 to 7. Check your guest numbers.",
      pax: p(2, 1, 0),
    });
  });

  it("a restored cart line sets the ages' option with the option, so nothing is announced or dropped", () => {
    // The widget starts on the recommended option ("std"); the restore sets variantId and agesVariant to the line's option together.
    const restored = toCartItem({ ...activity, slug: "x", title: "x", images: [""], price: { adult: { inr: 1, aed: 1 } }, addOns: [] } as unknown as Activity, { date: "2026-12-01", time: "09:00", pax: p(2, 1, 0), variantId: "kids-under-8" });
    expect(guestOptionSwitch(activity, restored.variantId, restored.variantId, restored.pax)).toBeNull();
    // Had only variantId been set, the widget would announce a switch the guest never made.
    expect(guestOptionSwitch(activity, "std", restored.variantId, restored.pax)?.notice).toMatch(/counts children as ages 3 to 7/);
  });

  it("no switch, no step", () => {
    expect(guestOptionSwitch(activity, "std", "std", p(2, 1, 1))).toBeNull();
    expect(guestOptionSwitch(activity, undefined, undefined, p(2, 1, 1))).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * Guest picker fix (28 Nov 2026): typed units decide the child and infant
 * rows whatever the bands. Production case: `global-village`, one option
 * whose only unit is an adult at AED 29; the picker took 1 child and 2
 * infants, priced AED 145, and the quote refused them (`unknown_unit`).
 * ------------------------------------------------------------------------ */

describe("typed units decide the child and infant rows, whatever the bands (guest picker fix)", () => {
  const p = (adult: number, child: number, infant: number) => ({ adult, child, infant, senior: 0 });
  const CHILD_OPEN = { hint: "Age 3–11", srHint: "Ages 3 to 11", allowed: true };
  const CHILD_CLOSED = { hint: "Age 3–11 · not available on this option", srHint: "Ages 3 to 11, not available on this option", allowed: false };
  const INFANT_OPEN = { hint: "Under 3 · usually free", srHint: "Under 3, usually free", allowed: true };
  const INFANT_CLOSED = { hint: "Under 3 · not available on this option", srHint: "Under 3, not available on this option", allowed: false };

  const adultOnly = { units: [unit("adult", 12, null, { price: { inr: 700, aed: 29 } })] };
  const adultChild = { units: [unit("adult", null, null), unit("child", null, null)] };
  const ownBands = { units: unitsFor(terms(8, true, 3), band(2, 7)) };
  const ownBandsNoInfants = { units: unitsFor(terms(8, false, 3), band(2, 7)) };

  it("an option with only an adult unit: the page's bands, child and infant rows closed", () => {
    expect(variantPaxAges(adultOnly)).toEqual(PAGE_PAX_AGES);
    const rows = guestRowAges(adultOnly);
    expect(rows.adult).toEqual({ hint: "Age 12+", srHint: "Age 12 and over", allowed: true });
    expect(rows.child).toEqual(CHILD_CLOSED);
    expect(rows.infant).toEqual(INFANT_CLOSED);
    expect(rows.senior.allowed).toBe(true);
    expect(paxForAges(p(4, 1, 2), rows)).toEqual(p(4, 0, 0));
  });

  it("an option with an adult and a child unit and no infant unit: the infant row closed", () => {
    const rows = guestRowAges(adultChild);
    expect(rows.child).toEqual(CHILD_OPEN);
    expect(rows.infant).toEqual(INFANT_CLOSED);
    expect(paxForAges(p(2, 1, 1), rows)).toEqual(p(2, 1, 0));
  });

  it("an option with no typed units (inquiry pricing): every row stays open", () => {
    for (const variant of [undefined, {}, { units: [] }]) {
      const rows = guestRowAges(variant);
      expect(rows.child).toEqual(CHILD_OPEN);
      expect(rows.infant).toEqual(INFANT_OPEN);
      const pax = p(2, 1, 1);
      expect(paxForAges(pax, rows)).toBe(pax);
    }
  });

  it("an option with its own bands: unchanged", () => {
    expect(guestRowAges(ownBands)).toEqual({
      adult: { hint: "Age 8+", srHint: "Age 8 and over", allowed: true },
      child: { hint: "Age 3–7", srHint: "Ages 3 to 7", allowed: true },
      infant: INFANT_OPEN,
      senior: { hint: "Age 60+ · reduced rate on many activities", srHint: "Age 60 and over, reduced rate on many activities", allowed: true },
    });
    expect(guestRowAges(ownBandsNoInfants).infant).toEqual(INFANT_CLOSED);
    expect(guestRowAges(ownBandsNoInfants).child.allowed).toBe(true);
  });

  it("a per-booking unit never opens a row, now with the page's bands too (N4-07)", () => {
    const rows = guestRowAges({ units: [unit("adult", null, null), unit("child", null, 5, { per: "booking" })] });
    expect(rows.child.allowed).toBe(false);
    expect(rows.infant.allowed).toBe(false);
  });

  it("a switch onto an adult-only option drops the children and infants and says so", () => {
    const page = { units: [unit("adult", null, null), unit("child", null, null), unit("infant", null, null)] };
    expect(guestAgesNotice(page, adultOnly, p(4, 1, 2))).toBe(
      "This option doesn't take children, so 1 child was removed from your guests. This option doesn't take infants, so 2 infants were removed from your guests.",
    );
    // A cart line restored on its own adult-only option (before = after) is told the same, with no band wording.
    expect(guestAgesNotice(adultOnly, adultOnly, p(4, 1, 2))).toBe(
      "This option doesn't take children, so 1 child was removed from your guests. This option doesn't take infants, so 2 infants were removed from your guests.",
    );
    expect(guestAgesNotice(adultOnly, adultOnly, p(4, 0, 0))).toBeNull();
  });

  it("the page's child and infant price lines follow the rows", () => {
    expect(listingSellsChildren({ variants: [] })).toBe(true);
    expect(listingSellsChildren({ variants: [adultOnly] })).toBe(false);
    expect(listingSellsInfants({ variants: [adultOnly] })).toBe(false);
    expect(listingSellsChildren({ variants: [adultOnly, adultChild] })).toBe(true);
    expect(listingSellsInfants({ variants: [adultOnly, adultChild] })).toBe(false);
    expect(listingSellsChildren({ variants: [{}] })).toBe(true);
    expect(listingSellsInfants({ variants: [{}] })).toBe(true);
    expect(listingSellsChildren({ variants: [ownBandsNoInfants] })).toBe(true);
  });

  describe("pricing and the cart follow the closed rows", () => {
    const variant = (id: string, v: { units?: UnitDefinition[] }) => ({ id, name: id, delta: { inr: 0, aed: 0 }, ...v }) as unknown as Variant;
    const activity = (v: Variant) =>
      ({
        slug: "zz-synthetic-adult-only",
        title: "Synthetic",
        images: ["/img/x.jpg"],
        productId: "0190a000-0000-7000-8000-000000000002",
        price: { adult: { inr: 700, aed: 29 } },
        variants: [v],
        addOns: [],
        quoteOnly: false,
        confirmation: "instant",
        fulfilmentMode: "instant",
        freeCancellationHours: 0,
        durationMinutes: 60,
        pickupIncluded: false,
        timeSlots: ["16:00"],
      }) as unknown as Activity;
    const opts = (variantId: string) => ({ date: "2026-12-01", time: "16:00", pax: p(4, 1, 2), variantId });

    it("adult only: the cart line holds the adults alone, at 4 × AED 29, and the quote is sent adults only", () => {
      const a = activity(variant("td-synthetic", adultOnly));
      const line = toCartItem(a, opts("td-synthetic"));
      expect(line.pax).toEqual(p(4, 0, 0));
      expect(line.total).toEqual({ inr: 2800, aed: 116 });
      expect(quoteLinesFor([line], [a])![0].units).toEqual({ adult: 4 });
      // The widget prices what it shows (`paxForAges` first); unfiltered counts would price the child as an adult.
      expect(computeBreakdown(a, paxForAges(p(4, 1, 2), guestRowAges(adultOnly)), "td-synthetic").total).toEqual({ inr: 2800, aed: 116 });
    });

    it("adult and child, no infant: the infants are dropped, the child kept", () => {
      const a = activity(variant("ac", adultChild));
      expect(toCartItem(a, opts("ac")).pax).toEqual(p(4, 1, 0));
    });

    it("no typed units: every guest is kept", () => {
      const a = activity(variant("plain", {}));
      expect(toCartItem(a, opts("plain")).pax).toEqual(p(4, 1, 2));
    });

    it("own bands: unchanged, every row it has units for kept", () => {
      const a = activity(variant("own", ownBands));
      expect(toCartItem(a, opts("own")).pax).toEqual(p(4, 1, 2));
      expect(toCartItem(activity(variant("own-ni", ownBandsNoInfants)), opts("own-ni")).pax).toEqual(p(4, 1, 0));
    });
  });

  it("a line the quote still refuses for an unknown guest type gets its own reason, not the generic one", () => {
    expect(inquiryReasonForQuote(["unknown_unit"])).toBe("guest_types");
    expect(inquiryReasonText("guest_types")).toBe(
      "This option takes only some guest types online, such as adults. Change your guests on the activity page, or our team books everyone with you before you pay.",
    );
    expect(parseInquiryReason(new URL(inquiryHref("guest_types"), "https://outlyy.test").searchParams.get("reason"))).toBe("guest_types");
    // The more specific reasons of other lines still lead.
    expect(inquiryReasonForQuote(["unknown_unit", "pickup_unavailable"])).toBe("pickup");
    expect(inquiryReasonForQuote(["unknown_unit", "sold_out"])).toBe("guest_types");
  });
});
