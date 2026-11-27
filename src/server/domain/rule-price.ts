import { decimalToMinor } from "./decimal";
import { aedMinorToInrMinorConservative, evaluateMargin, type FixedCost, type PercentCost } from "./margin";

/**
 * The listing price rule of doc 30 §3.6 (owner decisions D7, D9), for the N0
 * dry run and, later, the N1 importer.
 *
 *  - AED: the lowest whole-dirham price at which the selling price keeps
 *    `RULE_TARGET_MARGIN_BPS` (17%) gross margin after the variable costs
 *    (payment fees), by the same evaluator the quote path uses
 *    (`evaluateMargin`). The net passed in is the readiness net: the highest
 *    over every pricing period still in force (D9, `offerReadinessFacts`).
 *  - INR: the AED price × the recorded conservative INR-per-AED rate, rounded
 *    up to a whole rupee. The floor is then re-checked in INR (`meetsFloor`).
 *  - The floor that readiness enforces stays the versioned margin policy
 *    (15%); 17% is the cushion above it, never the floor.
 *
 * Prices are whole major units, like activity content prices (readiness
 * charges `price.aed × 100` minor units). Nets are AED minor units.
 *
 * Pure: no env, db, clock or logger.
 */

/** D7: 15% floor plus a cushion, about 17% gross margin on the selling price. */
export const RULE_TARGET_MARGIN_BPS = 1700;

/** One variable cost, as recorded in `pricing.margin_cost_inputs` (margin.service.ts `costInputsSchema`). */
export type RuleCostLine = { name: string; kind: "percent_of_charge"; bps: number } | { name: string; kind: "fixed_aed"; aedMinor: string };

/** How far above the lower bound the search may step before giving up (a guard, never reached by sane inputs). */
const MAX_STEPS = 10_000;

function split(costs: readonly RuleCostLine[], toCharged: (aedMinor: bigint) => bigint): { percent: PercentCost[]; fixed: FixedCost[] } {
  const percent: PercentCost[] = [];
  const fixed: FixedCost[] = [];
  for (const c of costs) {
    if (c.kind === "percent_of_charge") percent.push({ label: c.name, bps: c.bps });
    else fixed.push({ label: c.name, amountMinor: toCharged(BigInt(c.aedMinor)) });
  }
  return { percent, fixed };
}

/**
 * The lowest whole-AED price whose margin reaches `targetBps`, or null when
 * no price can (percentage costs plus the target reach 100%). A zero net with
 * no fixed cost prices at 0 (a free unit, as readiness accepts).
 */
export function ruleAedPrice(netAedMinor: bigint, costs: readonly RuleCostLine[], targetBps: number = RULE_TARGET_MARGIN_BPS): bigint | null {
  if (netAedMinor < 0n) throw new Error("Net must not be negative");
  const { percent, fixed } = split(costs, (m) => m);
  const fixedMinor = fixed.reduce((s, c) => s + c.amountMinor, 0n);
  if (netAedMinor === 0n && fixedMinor === 0n) return 0n;
  const totalBps = BigInt(targetBps) + percent.reduce((s, c) => s + BigInt(c.bps), 0n);
  if (totalBps >= 10_000n) return null;
  // Lower bound without rounding: S × (1 − bps) ≥ net + fixed. Every rounding in the evaluator raises the cost, so the answer is at or above it.
  const lowerMinor = ((netAedMinor + fixedMinor) * 10_000n + (10_000n - totalBps) - 1n) / (10_000n - totalBps);
  let major = (lowerMinor + 99n) / 100n;
  if (major < 1n) major = 1n;
  for (let i = 0; i < MAX_STEPS; i += 1, major += 1n) {
    const r = evaluateMargin({ sellMinor: major * 100n, supplierNetMinor: netAedMinor, percentCosts: percent, fixedCosts: fixed }, { minGrossMarginBps: targetBps });
    if (r.meetsPolicy) return major;
  }
  return null;
}

/** AED price × the conservative rate, rounded up to a whole rupee. `inrPerAed` is a decimal string with at most two places. */
export function ruleInrPrice(aedMajor: bigint, inrPerAed: string): bigint {
  const { minor: rateHundredths, rounded } = decimalToMinor(inrPerAed);
  if (rounded || rateHundredths <= 0n) throw new Error("inrPerAed must be positive with at most two decimal places");
  if (aedMajor < 0n) throw new Error("Price must not be negative");
  return (aedMajor * rateHundredths + 99n) / 100n;
}

/**
 * Whether a whole-unit price in `currency` meets `floorBps` against the AED
 * net, as readiness checks it (`unitMeetsFloor`): a zero price passes only
 * with a zero net; INR converts the net and fixed costs at the conservative
 * rate.
 */
export function meetsFloor(input: {
  priceMajor: bigint;
  currency: "AED" | "INR";
  netAedMinor: bigint;
  costs: readonly RuleCostLine[];
  floorBps: number;
  inrPerAed: string | null;
}): boolean {
  if (input.priceMajor === 0n) return input.netAedMinor === 0n;
  let toCharged: (aedMinor: bigint) => bigint = (m) => m;
  if (input.currency === "INR") {
    const rate = input.inrPerAed;
    if (!rate) return false;
    toCharged = (m) => aedMinorToInrMinorConservative(m, rate);
  }
  const { percent, fixed } = split(input.costs, toCharged);
  return evaluateMargin(
    { sellMinor: input.priceMajor * 100n, supplierNetMinor: toCharged(input.netAedMinor), percentCosts: percent, fixedCosts: fixed },
    { minGrossMarginBps: input.floorBps },
  ).meetsPolicy;
}
