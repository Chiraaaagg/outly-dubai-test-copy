import { describe, expect, it } from "vitest";
import {
  aedMinorToInrMinorConservative,
  allocateDiscountAndTax,
  allocateLargestRemainder,
  evaluateMargin,
  inrMinorToAedMinorConservative,
  PLANNING_MARGIN_POLICY,
} from "../margin";

const GATEWAY = { label: "gateway", bps: 200 };

describe("evaluateMargin — 15% gross margin on the selling price", () => {
  it("planning policy is 1500 bps", () => {
    expect(PLANNING_MARGIN_POLICY).toEqual({ minGrossMarginBps: 1500 });
  });

  it("sell 100.00 AED, net 85.00 is exactly 1500 bps and meets the policy", () => {
    const r = evaluateMargin({ sellMinor: 10000n, supplierNetMinor: 8500n });
    expect(r).toMatchObject({
      grossProfitMinor: 1500n,
      grossMarginBps: 1500,
      meetsPolicy: true,
      maxSupplierNetMinor: 8500n,
      shortfallMinor: 0n,
      variableCostsMinor: 0n,
      costLines: [],
    });
  });

  it("net 85.01 misses by one fils", () => {
    const r = evaluateMargin({ sellMinor: 10000n, supplierNetMinor: 8501n });
    expect(r).toMatchObject({ grossProfitMinor: 1499n, grossMarginBps: 1499, meetsPolicy: false, maxSupplierNetMinor: 8500n, shortfallMinor: 1n });
  });

  it("a 15% MARKUP on cost is not a 15% margin", () => {
    // net 85.00 × 1.15 = 97.75 → margin 12.75/97.75 = 13.04%
    const r = evaluateMargin({ sellMinor: 9775n, supplierNetMinor: 8500n });
    expect(r.grossMarginBps).toBe(1304);
    expect(r.meetsPolicy).toBe(false);
  });

  it("the break-even markup is 1/0.85 − 1 ≈ 17.647%: 17.64% misses, and 17.65% misses once a 2% gateway fee applies", () => {
    // 85.00 × 1.1764 = 99.994 → 99.99 AED
    expect(evaluateMargin({ sellMinor: 9999n, supplierNetMinor: 8500n }).meetsPolicy).toBe(false);
    // 85.00 × 1.1765 = 100.0025 → 100.01 AED (rounded up): meets with no other costs …
    expect(evaluateMargin({ sellMinor: 10001n, supplierNetMinor: 8500n }).meetsPolicy).toBe(true);
    // … but not once the gateway takes 2% of the selling price.
    const withFee = evaluateMargin({ sellMinor: 10001n, supplierNetMinor: 8500n, percentCosts: [GATEWAY] });
    expect(withFee.meetsPolicy).toBe(false);
    expect(withFee.grossMarginBps).toBeLessThan(1500);
  });

  it("percent costs are a share of the selling price, rounded UP", () => {
    // 2% of 99.99 = 1.9998 → 2.00
    const r = evaluateMargin({ sellMinor: 9999n, supplierNetMinor: 5000n, percentCosts: [GATEWAY] });
    expect(r.costLines).toEqual([{ label: "gateway", amountMinor: 200n }]);
    expect(r.variableCostsMinor).toBe(200n);
    expect(r.grossProfitMinor).toBe(9999n - 5000n - 200n);
    // 0.01 bps of anything positive still costs at least one fils
    expect(evaluateMargin({ sellMinor: 1n, supplierNetMinor: 0n, percentCosts: [{ label: "tiny", bps: 1 }] }).costLines[0].amountMinor).toBe(1n);
    // 0 bps costs nothing
    expect(evaluateMargin({ sellMinor: 9999n, supplierNetMinor: 0n, percentCosts: [{ label: "free", bps: 0 }] }).costLines[0].amountMinor).toBe(0n);
  });

  it("fixed costs are added as-is, after percent costs", () => {
    const r = evaluateMargin({
      sellMinor: 10000n,
      supplierNetMinor: 7000n,
      percentCosts: [GATEWAY],
      fixedCosts: [{ label: "commission", amountMinor: 500n }],
    });
    expect(r.costLines).toEqual([
      { label: "gateway", amountMinor: 200n },
      { label: "commission", amountMinor: 500n },
    ]);
    expect(r.variableCostsMinor).toBe(700n);
    expect(r.grossProfitMinor).toBe(2300n);
    expect(r.grossMarginBps).toBe(2300);
  });

  it("maxSupplierNetMinor and shortfall account for costs and the required profit", () => {
    // sell 100.00, gateway 2.00, required profit 15.00 → max net 83.00
    const ok = evaluateMargin({ sellMinor: 10000n, supplierNetMinor: 8300n, percentCosts: [GATEWAY] });
    expect(ok).toMatchObject({ maxSupplierNetMinor: 8300n, meetsPolicy: true, shortfallMinor: 0n, grossMarginBps: 1500 });
    const short = evaluateMargin({ sellMinor: 10000n, supplierNetMinor: 8400n, percentCosts: [GATEWAY] });
    expect(short).toMatchObject({ maxSupplierNetMinor: 8300n, meetsPolicy: false, shortfallMinor: 100n });
    // required profit is rounded up: 15% of 99.99 = 14.9985 → 15.00
    expect(evaluateMargin({ sellMinor: 9999n, supplierNetMinor: 0n }).maxSupplierNetMinor).toBe(9999n - 1500n);
  });

  it("floors margin bps, including for a loss", () => {
    expect(evaluateMargin({ sellMinor: 3n, supplierNetMinor: 2n }).grossMarginBps).toBe(3333);
    const loss = evaluateMargin({ sellMinor: 3n, supplierNetMinor: 4n });
    expect(loss.grossProfitMinor).toBe(-1n);
    expect(loss.grossMarginBps).toBe(-3334);
    expect(loss.meetsPolicy).toBe(false);
  });

  it("a zero selling price never meets the policy", () => {
    expect(evaluateMargin({ sellMinor: 0n, supplierNetMinor: 0n })).toMatchObject({
      grossMarginBps: 0,
      meetsPolicy: false,
      maxSupplierNetMinor: 0n,
      shortfallMinor: 0n,
    });
    expect(evaluateMargin({ sellMinor: 0n, supplierNetMinor: 100n, fixedCosts: [{ label: "fee", amountMinor: 50n }] })).toMatchObject({
      grossProfitMinor: -150n,
      grossMarginBps: -10000,
      meetsPolicy: false,
      maxSupplierNetMinor: -50n,
      shortfallMinor: 150n,
    });
  });

  it("a 0 bps policy is met by break-even", () => {
    expect(evaluateMargin({ sellMinor: 10000n, supplierNetMinor: 10000n }, { minGrossMarginBps: 0 }).meetsPolicy).toBe(true);
    expect(evaluateMargin({ sellMinor: 10000n, supplierNetMinor: 10001n }, { minGrossMarginBps: 0 }).meetsPolicy).toBe(false);
  });

  it("negative amounts throw", () => {
    expect(() => evaluateMargin({ sellMinor: -1n, supplierNetMinor: 0n })).toThrow(/negative/);
    expect(() => evaluateMargin({ sellMinor: 100n, supplierNetMinor: -1n })).toThrow(/negative/);
    expect(() => evaluateMargin({ sellMinor: 100n, supplierNetMinor: 0n, fixedCosts: [{ label: "refund", amountMinor: -1n }] })).toThrow(/refund must not be negative/);
  });

  it("validates basis points on the policy and on every percent cost", () => {
    for (const bps of [-1, 10_001, 1.5, Number.NaN]) {
      expect(() => evaluateMargin({ sellMinor: 100n, supplierNetMinor: 0n }, { minGrossMarginBps: bps }), String(bps)).toThrow(/minGrossMarginBps/);
      expect(() => evaluateMargin({ sellMinor: 100n, supplierNetMinor: 0n, percentCosts: [{ label: "fee", bps }] }), String(bps)).toThrow(/fee must be an integer/);
    }
    expect(() => evaluateMargin({ sellMinor: 100n, supplierNetMinor: 0n }, { minGrossMarginBps: 10_000 })).not.toThrow();
  });
});

describe("inrMinorToAedMinorConservative", () => {
  it("divides by the INR-per-AED rate and floors", () => {
    expect(inrMinorToAedMinorConservative(238000n, "23.80")).toBe(10000n); // ₹2,380.00 → AED 100.00
    expect(inrMinorToAedMinorConservative(238099n, "23.80")).toBe(10004n); // 10004.159… floored
    expect(inrMinorToAedMinorConservative(100n, "23.80")).toBe(4n); // 4.2 → 4
    expect(inrMinorToAedMinorConservative(0n, "23.80")).toBe(0n);
    expect(inrMinorToAedMinorConservative(238000n, "23.800")).toBe(10000n); // trailing zero is not extra precision
    expect(inrMinorToAedMinorConservative(240000n, "24")).toBe(10000n);
  });

  it("a higher rate gives a lower (safer) AED value", () => {
    expect(inrMinorToAedMinorConservative(500000n, "24.00")).toBeLessThan(inrMinorToAedMinorConservative(500000n, "23.80"));
  });

  it("rejects rates with more than two decimals, zero or negative rates, and negative amounts", () => {
    expect(() => inrMinorToAedMinorConservative(100n, "23.805")).toThrow(/two decimal places/);
    expect(() => inrMinorToAedMinorConservative(100n, "0")).toThrow(/positive/);
    expect(() => inrMinorToAedMinorConservative(100n, "0.00")).toThrow(/positive/);
    expect(() => inrMinorToAedMinorConservative(100n, "-23.80")).toThrow(/positive/);
    expect(() => inrMinorToAedMinorConservative(-1n, "23.80")).toThrow(/negative/);
    expect(() => inrMinorToAedMinorConservative(100n, "abc")).toThrow();
  });
});

describe("aedMinorToInrMinorConservative", () => {
  it("multiplies by the INR-per-AED rate and rounds the cost up", () => {
    expect(aedMinorToInrMinorConservative(10000n, "23.80")).toBe(238000n); // AED 100.00 → ₹2,380.00
    expect(aedMinorToInrMinorConservative(1n, "23.81")).toBe(24n); // 23.81 → 24
    expect(aedMinorToInrMinorConservative(1n, "23.00")).toBe(23n); // exact stays exact
    expect(aedMinorToInrMinorConservative(0n, "23.80")).toBe(0n);
  });

  it("a higher rate gives a higher (safer) INR cost", () => {
    expect(aedMinorToInrMinorConservative(5000n, "24.00")).toBeGreaterThan(aedMinorToInrMinorConservative(5000n, "23.80"));
  });

  it("rejects rates with more than two decimals, zero or negative rates, and negative amounts", () => {
    expect(() => aedMinorToInrMinorConservative(100n, "23.805")).toThrow(/two decimal places/);
    expect(() => aedMinorToInrMinorConservative(100n, "0.00")).toThrow(/positive/);
    expect(() => aedMinorToInrMinorConservative(100n, "-1")).toThrow(/positive/);
    expect(() => aedMinorToInrMinorConservative(-1n, "23.80")).toThrow(/negative/);
  });
});

/** Deterministic PRNG so the property runs are reproducible (mulberry32). */
function prng(seed: number) {
  let a = seed >>> 0;
  return (max: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
  };
}

const sum = (xs: readonly bigint[]) => xs.reduce((s, x) => s + x, 0n);

describe("allocateLargestRemainder (PAY-10)", () => {
  it("splits proportionally, remainders to the largest fractions, ties to the earlier line", () => {
    expect(allocateLargestRemainder([100n, 100n, 100n], 100n)).toEqual([34n, 33n, 33n]);
    expect(allocateLargestRemainder([1n, 2n], 2n)).toEqual([1n, 1n]); // 0.67 / 1.33: fraction .67 beats .33
    expect(allocateLargestRemainder([3000n, 1000n], 1000n)).toEqual([750n, 250n]);
    expect(allocateLargestRemainder([5n], 3n)).toEqual([3n]);
    expect(allocateLargestRemainder([], 0n)).toEqual([]);
  });

  it("never gives anything to a zero-weight line", () => {
    expect(allocateLargestRemainder([0n, 1n, 0n, 1n], 1n)).toEqual([0n, 1n, 0n, 0n]);
    expect(allocateLargestRemainder([0n, 0n], 0n)).toEqual([0n, 0n]);
  });

  it("refuses negative inputs and a non-zero amount over zero-value lines", () => {
    expect(() => allocateLargestRemainder([1n], -1n)).toThrow(/negative/);
    expect(() => allocateLargestRemainder([-1n, 2n], 1n)).toThrow(/negative/);
    expect(() => allocateLargestRemainder([0n, 0n], 1n)).toThrow(/zero-value/);
    expect(() => allocateLargestRemainder([], 1n)).toThrow(/zero-value/);
  });

  it("property: the sum is preserved, every share is within one unit of exact, zero weights get zero", () => {
    const rand = prng(20261101);
    for (let run = 0; run < 2_000; run++) {
      const n = 1 + rand(8);
      const weights = Array.from({ length: n }, () => (rand(5) === 0 ? 0n : BigInt(rand(5_000_000))));
      const total = sum(weights);
      const amount = total === 0n ? 0n : BigInt(rand(3_000_000));
      const out = allocateLargestRemainder(weights, amount);
      expect(sum(out)).toBe(amount);
      out.forEach((x, i) => {
        expect(x >= 0n).toBe(true);
        if (weights[i] === 0n) expect(x).toBe(0n);
        if (total > 0n) {
          const floor = (amount * weights[i]) / total;
          expect(x === floor || x === floor + 1n).toBe(true);
        }
      });
    }
  });
});

describe("allocateDiscountAndTax (PAY-10)", () => {
  it("splits the discount by line amount and the tax by the discounted amount", () => {
    expect(allocateDiscountAndTax([6000n, 4000n], 1000n, 450n)).toEqual([
      { discountAllocMinor: 600n, taxAllocMinor: 270n },
      { discountAllocMinor: 400n, taxAllocMinor: 180n },
    ]);
    expect(allocateDiscountAndTax([1000n, 1000n], 0n, 0n)).toEqual([
      { discountAllocMinor: 0n, taxAllocMinor: 0n },
      { discountAllocMinor: 0n, taxAllocMinor: 0n },
    ]);
  });

  it("refuses a discount above the lines, and tax on fully discounted lines", () => {
    expect(() => allocateDiscountAndTax([100n, 100n], 201n, 0n)).toThrow(/exceed/);
    expect(() => allocateDiscountAndTax([100n, 100n], 200n, 1n)).toThrow(/zero-value/);
    expect(allocateDiscountAndTax([100n, 100n], 200n, 0n).map((a) => a.discountAllocMinor)).toEqual([100n, 100n]);
  });

  it("property: both sums are preserved and no line is discounted below zero", () => {
    const rand = prng(42);
    for (let run = 0; run < 2_000; run++) {
      const lines = Array.from({ length: 1 + rand(6) }, () => BigInt(rand(2_000_000)));
      const subtotal = sum(lines);
      const discount = subtotal === 0n ? 0n : BigInt(rand(Number(subtotal) + 1));
      const tax = subtotal - discount === 0n ? 0n : BigInt(rand(500_000));
      const out = allocateDiscountAndTax(lines, discount, tax);
      expect(sum(out.map((o) => o.discountAllocMinor))).toBe(discount);
      expect(sum(out.map((o) => o.taxAllocMinor))).toBe(tax);
      out.forEach((o, i) => {
        expect(o.discountAllocMinor >= 0n && o.discountAllocMinor <= lines[i]).toBe(true);
        expect(o.taxAllocMinor >= 0n).toBe(true);
      });
    }
  });
});
