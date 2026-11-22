/**
 * Supplier wallet funds (doc 29 §4.5, defect D1). Pure: no database, env or
 * logger, so the rules are unit-tested on their own.
 *
 * TravelDesk reports three figures for the agency (`GET /balance`):
 * `balance`, `creditFacility` and `payableBalance`. TravelDesk's own
 * definition (doc 22 §32.30) is that `payableBalance` is the credit facility
 * minus the balance: what the agency can still book. A negative balance is
 * prepaid money in the agency's favour. So a prepaid wallet with no credit
 * (balance −244.06, credit 0, payable 244.06) can book 244.06, and a credit
 * account with nothing used (balance 0, credit 1 000, payable 1 000) can book
 * 1 000.
 *
 * Rules:
 *  1. Spendable = the lower of `payableBalance` and `creditFacility − balance`.
 *  2. Fail closed (no reserve is sent; the job waits and an alert is raised)
 *     when a figure is missing or not a whole number of minor units, when
 *     `payableBalance` is negative, or when the two figures differ by more
 *     than one cent and the difference is not explained by Outly's own open
 *     holds (only a payable figure lower than the derived one, by no more
 *     than the holds, is explained).
 *  3. Multi-item orders: each further item is checked against a running total
 *     (the order's first read minus the expected cost of each item reserved
 *     since), and against the current read, whichever is lower. Two reads
 *     never have to match exactly, so an open hold of item one cannot stall
 *     item two.
 *  4. Direction guard: right after an accepted reserve, a fresh read must show
 *     spendable funds lower by about the booking's cost. Only clear evidence
 *     pauses: the figure did not move, or it rose by about the booking's
 *     cost (what a wrong sign convention would show). A larger drop is
 *     explained by other bookings on the same agency (staff book through the
 *     TravelDesk portal too, owner decision 3, doc 29 §8.4) and is fine. A
 *     smaller drop, or a rise of another size, can be explained by another
 *     wallet movement (a portal cancellation, a top-up) and only alerts.
 *
 * Amounts are AED minor units (bigint).
 */

/** The raw wallet figures an adapter may add to its `funds()` answer (a local extension of the frozen port, like `SupplierRefundFigure`). */
export interface WalletFigures {
  balanceMinor: bigint;
  creditFacilityMinor: bigint;
  payableMinor: bigint;
}

/** `funds()` answer with the optional raw figures. Adapters that report one figure leave `wallet` out. */
export interface FundsWithWallet {
  spendableMinor: bigint;
  wallet?: WalletFigures;
}

/** Tolerance between `payableBalance` and `creditFacility − balance`: one cent. */
export const WALLET_IDENTITY_TOLERANCE_MINOR = 1n;

export type FundsRefusal = "funds_missing" | "funds_negative" | "funds_mismatch";

export type FundsVerdict = { ok: true; spendableMinor: bigint; derivedMinor: bigint; payableMinor: bigint } | { ok: false; reason: FundsRefusal };

const isMinor = (v: unknown): v is bigint => typeof v === "bigint";

/** The candidate spendable figure (rule 1) without the fail-closed checks, for display. Null when a figure is missing. */
export function candidateSpendable(w: Partial<Record<keyof WalletFigures, unknown>>): bigint | null {
  if (!isMinor(w.balanceMinor) || !isMinor(w.creditFacilityMinor) || !isMinor(w.payableMinor)) return null;
  const derived = w.creditFacilityMinor - w.balanceMinor;
  return w.payableMinor < derived ? w.payableMinor : derived;
}

/**
 * Rules 1 and 2. `openHoldsMinor` is the sum of Outly's own open holds on the
 * same account (reserved, not yet confirmed); it can only explain a payable
 * figure that is lower than the derived one.
 */
export function walletSpendable(w: Partial<Record<keyof WalletFigures, unknown>> | null | undefined, openHoldsMinor: bigint = 0n): FundsVerdict {
  if (!w || !isMinor(w.balanceMinor) || !isMinor(w.creditFacilityMinor) || !isMinor(w.payableMinor)) return { ok: false, reason: "funds_missing" };
  const payable = w.payableMinor;
  if (payable < 0n) return { ok: false, reason: "funds_negative" };
  const derived = w.creditFacilityMinor - w.balanceMinor;
  const gap = derived - payable;
  if (gap > WALLET_IDENTITY_TOLERANCE_MINOR || gap < -WALLET_IDENTITY_TOLERANCE_MINOR) {
    const holds = openHoldsMinor > 0n ? openHoldsMinor : 0n;
    const explained = gap > 0n && gap <= holds + WALLET_IDENTITY_TOLERANCE_MINOR;
    if (!explained) return { ok: false, reason: "funds_mismatch" };
  }
  return { ok: true, spendableMinor: payable < derived ? payable : derived, derivedMinor: derived, payableMinor: payable };
}

/**
 * Rule 3. The figure a further item of an order is checked against: the
 * current read, or the order's running total (first read minus the expected
 * cost of every item reserved since) when that is lower. `firstReadMinor` is
 * null for the order's first check.
 */
export function orderSpendable(currentMinor: bigint, firstReadMinor: bigint | null, reservedSinceMinor: bigint): { spendableMinor: bigint; runningMinor: bigint | null } {
  if (firstReadMinor === null) return { spendableMinor: currentMinor, runningMinor: null };
  const running = firstReadMinor - (reservedSinceMinor > 0n ? reservedSinceMinor : 0n);
  return { spendableMinor: running < currentMinor ? running : currentMinor, runningMinor: running };
}

/**
 * How far a read may be off the expected movement and still count as "about
 * the booking's cost": one dirham, because TravelDesk debits whole dirhams it
 * computes itself (doc 22 §32.27, §32.31).
 */
export const WALLET_DIRECTION_TOLERANCE_MINOR = 100n;

/**
 * - `consistent`: funds fell by at least about the cost (more is explained by other bookings);
 * - `partial`: funds fell, but by clearly less than the cost (another movement may explain it): alert only;
 * - `flat`: funds did not move: pause;
 * - `inverted`: funds rose by about the cost, what a wrong sign convention shows: pause;
 * - `rose_unexplained`: funds rose by another amount (a top-up or a portal cancellation may explain it): alert only;
 * - `too_small`: the cost is inside the tolerance, so the reads cannot tell: no verdict.
 */
export type DirectionVerdict = "consistent" | "partial" | "flat" | "inverted" | "rose_unexplained" | "too_small";

/** Verdicts that are clear evidence and pause all supplier writes. */
export const DIRECTION_PAUSES: readonly DirectionVerdict[] = ["flat", "inverted"];

/** Rule 4. `beforeMinor` is the read just before the send, `afterMinor` the read right after the accepted answer. */
export function walletDirection(input: { beforeMinor: bigint; afterMinor: bigint; costMinor: bigint }): DirectionVerdict {
  const tol = WALLET_DIRECTION_TOLERANCE_MINOR;
  const cost = input.costMinor;
  if (cost <= 2n * tol) return "too_small";
  const drop = input.beforeMinor - input.afterMinor;
  if (drop >= cost - tol) return "consistent";
  if (drop > tol) return "partial";
  if (drop >= -tol) return "flat";
  const rise = -drop;
  return rise >= cost - tol && rise <= cost + tol ? "inverted" : "rose_unexplained";
}
