import { describe, expect, it } from "vitest";
import {
  AED_PER_USD_PEG,
  DEFAULT_FX_BAND,
  FX_SAFETY_BUFFER,
  fxGuardRefusals,
  fxSourceText,
  hundredthsToRate,
  inrPerAedHundredths,
  moveBps,
  parseFrankfurterLatest,
  parseFxBand,
  plainDecimalOf,
  rateToHundredths,
  sourceAgeDays,
} from "../fx";

/**
 * Live INR-per-AED computation and guards (doc 22 §32.16). Pure; every rate
 * and date is synthetic or the documented example.
 */

const NOW = new Date("2026-11-03T06:15:00.000Z");
const BAND = DEFAULT_FX_BAND;

function quote(date = "2026-11-02", inrPerUsd = "94.75") {
  return { date, inrPerUsd };
}

describe("parseFrankfurterLatest", () => {
  it("accepts the documented answer, keeping the rate exactly as sent", () => {
    const body = JSON.parse('{"amount":1.0,"base":"USD","date":"2026-11-02","rates":{"INR":94.75}}');
    expect(parseFrankfurterLatest(body)).toEqual({ date: "2026-11-02", inrPerUsd: "94.75" });
    expect(parseFrankfurterLatest({ amount: 1, base: "USD", date: "2026-11-02", rates: { INR: 88.123 } })).toEqual({ date: "2026-11-02", inrPerUsd: "88.123" });
  });

  it("drops unknown top-level keys but nothing else", () => {
    expect(parseFrankfurterLatest({ amount: 1, base: "USD", date: "2026-11-02", rates: { INR: 94.75 }, note: "x" })).toEqual({ date: "2026-11-02", inrPerUsd: "94.75" });
  });

  it.each([
    ["another base", { amount: 1, base: "EUR", date: "2026-11-02", rates: { INR: 94.75 } }],
    ["another amount", { amount: 100, base: "USD", date: "2026-11-02", rates: { INR: 9475 } }],
    ["a missing INR", { amount: 1, base: "USD", date: "2026-11-02", rates: {} }],
    ["an extra symbol", { amount: 1, base: "USD", date: "2026-11-02", rates: { INR: 94.75, AED: 3.6725 } }],
    ["a zero rate", { amount: 1, base: "USD", date: "2026-11-02", rates: { INR: 0 } }],
    ["a negative rate", { amount: 1, base: "USD", date: "2026-11-02", rates: { INR: -94.75 } }],
    ["a string rate", { amount: 1, base: "USD", date: "2026-11-02", rates: { INR: "94.75" } }],
    ["an exponent-sized rate", { amount: 1, base: "USD", date: "2026-11-02", rates: { INR: 1e21 } }],
    ["a tiny rate", { amount: 1, base: "USD", date: "2026-11-02", rates: { INR: 1e-9 } }],
    ["an impossible date", { amount: 1, base: "USD", date: "2026-02-30", rates: { INR: 94.75 } }],
    ["a timestamp for a date", { amount: 1, base: "USD", date: "2026-11-02T00:00:00Z", rates: { INR: 94.75 } }],
    ["a missing date", { amount: 1, base: "USD", rates: { INR: 94.75 } }],
    ["an array", [1, 2]],
    ["null", null],
  ])("refuses %s", (_label, body) => {
    expect(parseFrankfurterLatest(body)).toBeNull();
  });

  it("plainDecimalOf refuses non-finite and exponent forms", () => {
    expect(plainDecimalOf(Number.NaN)).toBeNull();
    expect(plainDecimalOf(Number.POSITIVE_INFINITY)).toBeNull();
    expect(plainDecimalOf(1e-7)).toBeNull();
    expect(plainDecimalOf(94.75)).toBe("94.75");
  });
});

describe("inrPerAedHundredths", () => {
  it("is the documented example: 94.75 ÷ 3.6725 = 25.80 (25.7998…) × 1.02 = 26.32 (26.3158…)", () => {
    expect(AED_PER_USD_PEG).toBe("3.6725");
    expect(FX_SAFETY_BUFFER).toBe("1.02");
    expect(inrPerAedHundredths("94.75")).toBe(2632n);
    expect(hundredthsToRate(inrPerAedHundredths("94.75"))).toBe("26.32");
  });

  it("rounds up, never to nearest: more INR per AED is the safe side", () => {
    // 91.8125 / 3.6725 = 25 exactly; × 1.02 = 25.50 exactly: no rounding.
    expect(inrPerAedHundredths("91.8125")).toBe(2550n);
    // One ten-thousandth more pushes it just over 25.50, so it goes to 25.51.
    expect(inrPerAedHundredths("91.8126")).toBe(2551n);
    // 88 / 3.6725 × 1.02 = 24.4413… → 24.45 (nearest would be 24.44).
    expect(inrPerAedHundredths("88")).toBe(2445n);
  });

  it("is exact where floating point drifts", () => {
    for (const usd of ["83.1", "83.12", "83.123", "83.12345678", "100", "0.5"]) {
      const h = inrPerAedHundredths(usd);
      // h must be the least integer with h / 100 ≥ usd / 3.6725 × 1.02. Cross-multiplied, all in integers:
      // h × 10^k × 36725 × 100 ≥ units × 10000 × 102 × 100, where usd = units / 10^k.
      const [w, f = ""] = usd.split(".");
      const units = BigInt(w + f);
      const scale = 10n ** BigInt(f.length);
      const lhs = (x: bigint) => x * scale * 36725n * 100n;
      const rhs = units * 10_000n * 102n * 100n;
      expect(lhs(h) >= rhs, usd).toBe(true);
      expect(lhs(h - 1n) < rhs, usd).toBe(true);
    }
  });

  it("refuses anything that is not a plain positive decimal", () => {
    for (const bad of ["", "0", "-1", "1e2", "abc", "1.123456789"]) expect(() => inrPerAedHundredths(bad), bad).toThrow();
  });
});

describe("rates as strings", () => {
  it("round-trips the stored two-place form", () => {
    expect(rateToHundredths("26.32")).toBe(2632n);
    expect(rateToHundredths("26.3")).toBe(2630n);
    expect(rateToHundredths("26")).toBe(2600n);
    expect(rateToHundredths("26.321")).toBeNull();
    expect(rateToHundredths("about 26")).toBeNull();
    expect(hundredthsToRate(2600n)).toBe("26.00");
  });

  it("source text names the ECB date, the USD/INR rate, the peg and the buffer", () => {
    expect(fxSourceText(quote())).toBe("ECB via Frankfurter 2026-11-02, USD/INR 94.75 ÷ 3.6725 × 1.02");
  });
});

describe("parseFxBand", () => {
  it("defaults to 15–40 and accepts a valid override", () => {
    expect(parseFxBand(undefined, undefined)).toEqual({ minHundredths: 1500n, maxHundredths: 4000n });
    expect(parseFxBand("20", "30.50")).toEqual({ minHundredths: 2000n, maxHundredths: 3050n });
  });

  it("refuses a malformed or inverted band", () => {
    expect(parseFxBand("abc", undefined)).toBeNull();
    expect(parseFxBand("40", "15")).toBeNull();
    expect(parseFxBand("20", "20")).toBeNull();
    expect(parseFxBand("0", "40")).toBeNull();
    expect(parseFxBand("15.001", "40")).toBeNull();
  });
});

describe("fxGuardRefusals", () => {
  const ok = { quote: quote(), hundredths: 2632n, previousHundredths: 2600n, band: BAND, now: NOW };

  it("passes a fresh, plausible, small move", () => {
    expect(fxGuardRefusals(ok)).toEqual([]);
  });

  it("passes a first write (no stored rate) inside the band", () => {
    expect(fxGuardRefusals({ ...ok, previousHundredths: null })).toEqual([]);
  });

  it("refuses outside the band, inclusive bounds pass", () => {
    expect(fxGuardRefusals({ ...ok, previousHundredths: null, hundredths: 1499n })).toEqual(["out_of_band"]);
    expect(fxGuardRefusals({ ...ok, previousHundredths: null, hundredths: 4001n })).toEqual(["out_of_band"]);
    expect(fxGuardRefusals({ ...ok, previousHundredths: null, hundredths: 1500n })).toEqual([]);
    expect(fxGuardRefusals({ ...ok, previousHundredths: null, hundredths: 4000n })).toEqual([]);
    expect(fxGuardRefusals({ ...ok, previousHundredths: null, hundredths: 2632n, band: { minHundredths: 2700n, maxHundredths: 3000n } })).toEqual(["out_of_band"]);
  });

  it("refuses a move above 5% either way; exactly 5% passes", () => {
    expect(fxGuardRefusals({ ...ok, previousHundredths: 2000n, hundredths: 2100n })).toEqual([]);
    expect(fxGuardRefusals({ ...ok, previousHundredths: 2000n, hundredths: 1900n })).toEqual([]);
    expect(fxGuardRefusals({ ...ok, previousHundredths: 2000n, hundredths: 2101n })).toEqual(["jump_too_large"]);
    expect(fxGuardRefusals({ ...ok, previousHundredths: 2000n, hundredths: 1899n })).toEqual(["jump_too_large"]);
    expect(moveBps(2000n, 2101n)).toBe(505n);
    expect(moveBps(2000n, 2000n)).toBe(0n);
  });

  it("allows an ECB date up to 4 days old (weekend plus holiday), refuses older and future dates", () => {
    expect(sourceAgeDays("2026-11-03", NOW)).toBe(0);
    expect(sourceAgeDays("2026-10-30", NOW)).toBe(4);
    expect(fxGuardRefusals({ ...ok, quote: quote("2026-10-30") })).toEqual([]);
    expect(fxGuardRefusals({ ...ok, quote: quote("2026-10-29") })).toEqual(["source_stale"]);
    expect(fxGuardRefusals({ ...ok, quote: quote("2026-11-04") })).toEqual(["source_date_in_future"]);
    // Late on the 3rd (UTC) the 30 October rate is still 4 days old.
    expect(fxGuardRefusals({ ...ok, quote: quote("2026-10-30"), now: new Date("2026-11-03T23:59:59.999Z") })).toEqual([]);
  });

  it("lists every failing guard in a fixed order", () => {
    expect(fxGuardRefusals({ ...ok, quote: quote("2026-10-01"), hundredths: 5000n, previousHundredths: 2600n })).toEqual(["source_stale", "out_of_band", "jump_too_large"]);
  });
});
