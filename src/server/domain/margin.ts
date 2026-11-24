import { decimalToMinor } from "./decimal";

/**
 * Margin protection — gross margin on the CUSTOMER SELLING PRICE.
 *
 *   gross profit = selling price − supplier net − variable costs
 *   gross margin = gross profit ÷ selling price
 *
 * The planning target is 15% gross margin on selling price (docs/backend/21
 * §3.3), which is NOT a 15% markup on cost: at a 15% margin the price is
 * cost ÷ 0.85, a ~17.6% markup. The final definition must be confirmed by the
 * business before any financial transaction uses it; until then this module
 * only evaluates and flags. It never changes a selling price.
 *
 * Variable costs are supplied by the caller, because which ones apply
 * (gateway fee, tax on that fee, commissions, any tax on the sale) is a
 * business and tax decision:
 *  - `percentCosts`: basis points of the selling price (gateway fee 200 = 2%).
 *    Rounded UP to the next minor unit — the conservative direction.
 *  - `fixedCosts`: per-booking amounts in the evaluation currency.
 *
 * Everything is integer minor units in ONE currency. The B2 quote path
 * (src/server/services/margin.service.ts) evaluates each line in its charged
 * currency and converts the AED supplier net with
 * `aedMinorToInrMinorConservative`; older callers convert INR prices with
 * `inrMinorToAedMinorConservative` first. Never mix currencies here.
 *
 * `PLANNING_MARGIN_POLICY` is a planning default for catalogue matching only.
 * Quotes take the versioned policy from settings and have no code fallback
 * (PAY-11).
 *
 * Pure: no I/O, no env, no clock.
 */

export interface MarginPolicy {
  /** 1500 = 15.00%. Named after the planning floor; the quote path passes the versioned `floorBps`. */
  minGrossMarginBps: number;
}

export const PLANNING_MARGIN_POLICY: MarginPolicy = { minGrossMarginBps: 1500 };

export interface PercentCost {
  label: string;
  bps: number;
}

export interface FixedCost {
  label: string;
  amountMinor: bigint;
}

export interface MarginInput {
  /** What the customer pays, in AED minor units. */
  sellMinor: bigint;
  /** What the supplier charges for the same pax mix and date, in AED minor units. */
  supplierNetMinor: bigint;
  percentCosts?: PercentCost[];
  fixedCosts?: FixedCost[];
}

export interface MarginResult {
  sellMinor: bigint;
  supplierNetMinor: bigint;
  variableCostsMinor: bigint;
  grossProfitMinor: bigint;
  /** Floored to whole basis points. Negative when the sale loses money. */
  grossMarginBps: number;
  meetsPolicy: boolean;
  /** Highest supplier net at which this sale still meets the policy. Negative ⇒ no net can. */
  maxSupplierNetMinor: bigint;
  /** How far the net exceeds `maxSupplierNetMinor` (0 when the policy is met). */
  shortfallMinor: bigint;
  costLines: { label: string; amountMinor: bigint }[];
}

function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("ceilDiv: divisor must be positive");
  if (a >= 0n) return (a + b - 1n) / b;
  return a / b; // BigInt division truncates toward zero, which is the ceiling for negatives
}

function floorDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("floorDiv: divisor must be positive");
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

function assertBps(bps: number, label: string): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error(`${label} must be an integer between 0 and 10000 basis points`);
}

export function evaluateMargin(input: MarginInput, policy: MarginPolicy = PLANNING_MARGIN_POLICY): MarginResult {
  assertBps(policy.minGrossMarginBps, "minGrossMarginBps");
  if (input.sellMinor < 0n || input.supplierNetMinor < 0n) throw new Error("Amounts must not be negative");

  const costLines: { label: string; amountMinor: bigint }[] = [];
  for (const c of input.percentCosts ?? []) {
    assertBps(c.bps, c.label);
    costLines.push({ label: c.label, amountMinor: ceilDiv(input.sellMinor * BigInt(c.bps), 10_000n) });
  }
  for (const c of input.fixedCosts ?? []) {
    if (c.amountMinor < 0n) throw new Error(`${c.label} must not be negative`);
    costLines.push({ label: c.label, amountMinor: c.amountMinor });
  }
  const variableCostsMinor = costLines.reduce((s, c) => s + c.amountMinor, 0n);
  const grossProfitMinor = input.sellMinor - input.supplierNetMinor - variableCostsMinor;

  if (input.sellMinor === 0n) {
    return {
      sellMinor: 0n,
      supplierNetMinor: input.supplierNetMinor,
      variableCostsMinor,
      grossProfitMinor,
      grossMarginBps: grossProfitMinor < 0n ? -10_000 : 0,
      meetsPolicy: false,
      maxSupplierNetMinor: -variableCostsMinor,
      shortfallMinor: input.supplierNetMinor + variableCostsMinor,
      costLines,
    };
  }

  const grossMarginBps = Number(floorDiv(grossProfitMinor * 10_000n, input.sellMinor));
  const requiredProfitMinor = ceilDiv(input.sellMinor * BigInt(policy.minGrossMarginBps), 10_000n);
  const maxSupplierNetMinor = input.sellMinor - variableCostsMinor - requiredProfitMinor;
  const meetsPolicy = input.supplierNetMinor <= maxSupplierNetMinor;
  return {
    sellMinor: input.sellMinor,
    supplierNetMinor: input.supplierNetMinor,
    variableCostsMinor,
    grossProfitMinor,
    grossMarginBps,
    meetsPolicy,
    maxSupplierNetMinor,
    shortfallMinor: meetsPolicy ? 0n : input.supplierNetMinor - maxSupplierNetMinor,
    costLines,
  };
}

/**
 * INR → AED for a margin CHECK only, never for display or charging (INR prices
 * are authored independently, src/lib/currency.ts). `inrPerAed` is a decimal
 * string such as "23.80"; pass a deliberately HIGH rate (more INR per AED), so
 * the AED value of an INR sale is under-stated and the check errs safe.
 * Result is floored.
 */
export function inrMinorToAedMinorConservative(inrMinor: bigint, inrPerAed: string): bigint {
  const { minor: rateHundredths, rounded } = decimalToMinor(inrPerAed);
  if (rounded) throw new Error("inrPerAed must have at most two decimal places");
  if (rateHundredths <= 0n) throw new Error("inrPerAed must be positive");
  if (inrMinor < 0n) throw new Error("Amount must not be negative");
  return (inrMinor * 100n) / rateHundredths;
}

/**
 * AED → INR for a margin check on an INR-charged line, never for display or
 * charging. `inrPerAed` is the recorded conservative composite rate (a HIGH
 * rate: more INR per AED overstates the INR cost of an AED supplier net, so
 * the check errs safe). Costs round UP.
 */
export function aedMinorToInrMinorConservative(aedMinor: bigint, inrPerAed: string): bigint {
  const { minor: rateHundredths, rounded } = decimalToMinor(inrPerAed);
  if (rounded) throw new Error("inrPerAed must have at most two decimal places");
  if (rateHundredths <= 0n) throw new Error("inrPerAed must be positive");
  if (aedMinor < 0n) throw new Error("Amount must not be negative");
  return ceilDiv(aedMinor * rateHundredths, 100n);
}

/* ---------------------------------------------------------------------------
 * Allocation (PAY-10)
 * ------------------------------------------------------------------------ */

/**
 * Split `amountMinor` across lines in proportion to `weightsMinor`, exactly.
 * Each line gets the floor of its share; the units left over go one each to
 * the lines with the largest remainders, ties to the earlier line. The result
 * always sums to `amountMinor`, and a zero-weight line never receives anything.
 *
 * When every weight is zero only a zero amount can be split.
 */
export function allocateLargestRemainder(weightsMinor: readonly bigint[], amountMinor: bigint): bigint[] {
  if (amountMinor < 0n) throw new Error("Allocated amount must not be negative");
  if (weightsMinor.some((w) => w < 0n)) throw new Error("Allocation weights must not be negative");
  const total = weightsMinor.reduce((s, w) => s + w, 0n);
  if (total === 0n) {
    if (amountMinor !== 0n) throw new Error("Cannot allocate a non-zero amount across zero-value lines");
    return weightsMinor.map(() => 0n);
  }

  const shares = weightsMinor.map((w, index) => {
    const product = amountMinor * w;
    return { index, base: product / total, remainder: product % total };
  });
  let left = amountMinor - shares.reduce((s, x) => s + x.base, 0n);
  const order = [...shares].sort((a, b) => (a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1));
  const out = shares.map((x) => x.base);
  for (const x of order) {
    if (left === 0n) break;
    out[x.index] += 1n;
    left -= 1n;
  }
  return out;
}

/**
 * Order-level discount and tax split across lines (PAY-10).
 *
 *  - The discount is split by the lines' charged amounts and may not exceed
 *    their sum, so no line is discounted below zero.
 *  - Tax is split by each line's amount after its discount (the taxable base).
 *
 * Both sums are preserved exactly.
 */
export function allocateDiscountAndTax(
  linesMinor: readonly bigint[],
  discountMinor: bigint,
  taxMinor: bigint,
): Array<{ discountAllocMinor: bigint; taxAllocMinor: bigint }> {
  const subtotal = linesMinor.reduce((s, l) => s + l, 0n);
  if (discountMinor > subtotal) throw new Error("Discount must not exceed the lines it applies to");
  const discounts = allocateLargestRemainder(linesMinor, discountMinor);
  const taxes = allocateLargestRemainder(
    linesMinor.map((l, i) => l - discounts[i]),
    taxMinor,
  );
  return linesMinor.map((_, i) => ({ discountAllocMinor: discounts[i], taxAllocMinor: taxes[i] }));
}
