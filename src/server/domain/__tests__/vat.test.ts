import { describe, expect, it } from "vitest";
import {
  creditForRefund,
  DEFAULT_VAT_CATEGORY,
  EXEMPT_TRANSPORT_SLUGS,
  formatMinor,
  isVatCategory,
  looksLikePointToPointTransport,
  PREVIOUS_VAT_RULES,
  resolveVatCategory,
  splitDiscount,
  splitInclusive,
  totalsOf,
  VAT_RULE,
  VAT_RULE_CONFIRMED,
  vatRateBasisPoints,
  vatRateLabel,
} from "../vat";

/**
 * Group C VAT helpers (doc 93 §1.7, §8B; owner answers A5, A6, A10 of 28 Nov
 * 2026, accountant sign-off pending): 5/105 of the VAT-inclusive price, per
 * line, half up to the fil; a discount is its own negative line; totals are
 * the sum of the lines; every product is standard unless set otherwise.
 */
describe("VAT helpers (owner-approved, accountant sign-off pending)", () => {
  it("is owner-approved but not yet signed off, and the rule name says so", () => {
    expect(VAT_RULE_CONFIRMED).toBe(false);
    expect(VAT_RULE).toMatch(/owner_approved/);
    expect(VAT_RULE).toMatch(/^[a-z0-9_]{1,64}$/);
    expect(PREVIOUS_VAT_RULES).not.toContain(VAT_RULE);
  });

  it("A5: a discount is its own negative line, split half up on its size; item + discount = what was paid", () => {
    expect(splitDiscount(4000n, "standard")).toEqual({ netMinor: -3810n, vatMinor: -190n, grossMinor: -4000n });
    expect(splitDiscount(0n, "standard")).toEqual({ netMinor: 0n, vatMinor: 0n, grossMinor: 0n });
    expect(splitDiscount(4000n, "exempt")).toEqual({ netMinor: -4000n, vatMinor: 0n, grossMinor: -4000n });
    expect(() => splitDiscount(-1n, "standard")).toThrow(RangeError);
    const item = splitInclusive(40000n, "standard");
    const disc = splitDiscount(4000n, "standard");
    const t = totalsOf([
      { ...item, category: "standard" },
      { ...disc, category: "standard" },
    ]);
    expect(t).toMatchObject({ grossMinor: 36000n, vatMinor: 1905n - 190n, netMinor: 38095n - 3810n });
    // A full refund of the item credits item + discount exactly.
    const paid = { netMinor: item.netMinor + disc.netMinor, vatMinor: item.vatMinor + disc.vatMinor, grossMinor: 36000n };
    expect(creditForRefund(paid, { netMinor: 0n, vatMinor: 0n, grossMinor: 0n }, 36000n, "standard")).toEqual(paid);
  });

  it("A6: standard by default, a stored category wins, the exempt list applies, transport-looking products are held for review", () => {
    expect(DEFAULT_VAT_CATEGORY).toBe("standard");
    expect(EXEMPT_TRANSPORT_SLUGS).toEqual([]);
    expect(resolveVatCategory({ vatCategory: null, slug: "evening-desert-safari", title: "Evening Desert Safari" })).toEqual({ kind: "ok", category: "standard", source: "default" });
    expect(resolveVatCategory({ vatCategory: "exempt", slug: "palm-monorail-ticket", title: "Palm Monorail ticket" })).toEqual({ kind: "ok", category: "exempt", source: "stored" });
    expect(resolveVatCategory({ vatCategory: "standard", slug: "palm-monorail-ticket", title: "Palm Monorail ticket" })).toEqual({ kind: "ok", category: "standard", source: "stored" });
    expect(resolveVatCategory({ vatCategory: null, slug: "palm-monorail-ticket", title: "Palm Monorail ticket" })).toEqual({ kind: "review" });
    expect(resolveVatCategory({ vatCategory: "vat5", slug: "x", title: "X" })).toEqual({ kind: "invalid" });
    for (const t of ["Palm Monorail single ride", "Dubai Metro day pass", "Creek abra", "Dubai Tram ticket", "Intercity bus ticket"]) expect(looksLikePointToPointTransport({ slug: "x", title: t }), t).toBe(true);
    // Pleasure and sightseeing trips stay at 5 % (dinner cruises, tours, hop-on hop-off buses).
    for (const t of ["Dhow Cruise Marina Dinner", "Old Dubai souk walking tour with abra crossing", "Hop-on hop-off bus tour", "Abra sunset cruise", "Atlantis Aquaventure"]) expect(looksLikePointToPointTransport({ slug: "x", title: t }), t).toBe(false);
  });

  it("splits a VAT-inclusive standard line as 5/105, half up", () => {
    expect(splitInclusive(40000n, "standard")).toEqual({ netMinor: 38095n, vatMinor: 1905n, grossMinor: 40000n });
    expect(splitInclusive(2000n, "standard")).toEqual({ netMinor: 1905n, vatMinor: 95n, grossMinor: 2000n });
    expect(splitInclusive(10500n, "standard")).toEqual({ netMinor: 10000n, vatMinor: 500n, grossMinor: 10500n });
    // 21 × 5 / 105 = 1.0 exactly; 31 × 5/105 = 1.476 → 1; 32 × 5/105 = 1.523 → 2 (half up).
    expect(splitInclusive(21n, "standard").vatMinor).toBe(1n);
    expect(splitInclusive(31n, "standard").vatMinor).toBe(1n);
    expect(splitInclusive(32n, "standard").vatMinor).toBe(2n);
    expect(splitInclusive(0n, "standard")).toEqual({ netMinor: 0n, vatMinor: 0n, grossMinor: 0n });
  });

  it("carries no VAT on zero-rated, exempt and out-of-scope lines", () => {
    for (const c of ["zero_rated", "exempt", "out_of_scope"] as const) expect(splitInclusive(12345n, c)).toEqual({ netMinor: 12345n, vatMinor: 0n, grossMinor: 12345n });
    expect(vatRateLabel("standard")).toBe("5%");
    expect(vatRateBasisPoints("standard")).toBe(500);
    expect(vatRateBasisPoints("exempt")).toBe(0);
  });

  it("net + VAT = gross for every amount up to AED 100,000 (sampled), never negative", () => {
    for (let g = 0n; g < 10_000_000n; g += 7919n) {
      const s = splitInclusive(g, "standard");
      expect(s.netMinor + s.vatMinor).toBe(g);
      expect(s.vatMinor >= 0n && s.netMinor >= 0n).toBe(true);
      // Within half a fil of the exact value.
      const exact = (Number(g) * 5) / 105;
      expect(Math.abs(Number(s.vatMinor) - exact)).toBeLessThanOrEqual(0.5);
    }
  });

  it("totals are the sum of per-line splits, grouped by rate (exempt lines carry no VAT, A6)", () => {
    const t = totalsOf([
      { grossMinor: 40000n, category: "standard" },
      { grossMinor: 2000n, category: "standard" },
      { grossMinor: 1500n, category: "exempt" },
    ]);
    expect(t).toMatchObject({ grossMinor: 43500n, vatMinor: 2000n, netMinor: 41500n });
    expect(t.byRate).toEqual([
      { label: "5%", basisPoints: 500, netMinor: 40000n, vatMinor: 2000n },
      { label: "Exempt", basisPoints: 0, netMinor: 1500n, vatMinor: 0n },
    ]);
  });

  it("refuses negative amounts", () => {
    expect(() => splitInclusive(-1n, "standard")).toThrow(RangeError);
  });

  it("credits a full refund exactly, and partial refunds net to zero with the invoice line", () => {
    const line = splitInclusive(40000n, "standard");
    const none = { netMinor: 0n, vatMinor: 0n, grossMinor: 0n };
    expect(creditForRefund(line, none, 40000n, "standard")).toEqual(line);

    // Three partial refunds whose rounding would drift if each were split on its own.
    const parts = [13333n, 13333n, 13334n];
    let credited = { ...none };
    for (const p of parts) {
      const c = creditForRefund(line, credited, p, "standard");
      expect(c.netMinor + c.vatMinor).toBe(p);
      credited = { netMinor: credited.netMinor + c.netMinor, vatMinor: credited.vatMinor + c.vatMinor, grossMinor: credited.grossMinor + c.grossMinor };
    }
    expect(credited).toEqual(line);
  });

  it("refuses a refund beyond what is left of the line, and a non-positive refund", () => {
    const line = splitInclusive(40000n, "standard");
    expect(() => creditForRefund(line, { netMinor: 0n, vatMinor: 0n, grossMinor: 0n }, 40001n, "standard")).toThrow(RangeError);
    expect(() => creditForRefund(line, { netMinor: 28571n, vatMinor: 1429n, grossMinor: 30000n }, 10001n, "standard")).toThrow(RangeError);
    expect(() => creditForRefund(line, { netMinor: 0n, vatMinor: 0n, grossMinor: 0n }, 0n, "standard")).toThrow(RangeError);
  });

  it("knows its categories and formats minor units without the locale", () => {
    expect(isVatCategory("standard")).toBe(true);
    expect(isVatCategory("vat5")).toBe(false);
    expect(isVatCategory(null)).toBe(false);
    expect(formatMinor(42000n)).toBe("420.00");
    expect(formatMinor(123456789n)).toBe("1,234,567.89");
    expect(formatMinor(5n)).toBe("0.05");
    expect(formatMinor(-1905n)).toBe("-19.05");
  });
});
