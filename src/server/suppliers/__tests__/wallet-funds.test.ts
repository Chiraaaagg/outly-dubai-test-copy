import { describe, expect, it } from "vitest";
import { candidateSpendable, orderSpendable, walletDirection, walletSpendable, DIRECTION_PAUSES } from "../wallet-funds";

/**
 * Doc 29 §4.5 (defect D1): the wallet funds formula, its fail-closed
 * cross-check, the running total of a multi-item order and the direction
 * guard. Amounts are synthetic AED minor units.
 */

const w = (balanceMinor: bigint, creditFacilityMinor: bigint, payableMinor: bigint) => ({ balanceMinor, creditFacilityMinor, payableMinor });

describe("spendable funds (rules 1 and 2)", () => {
  it("prepaid wallet with a negative balance: the production shape books what was paid in", () => {
    // balance −244.06, no credit, payable 244.06 (doc 29 §4.5): 244.06 can be booked, not −244.06.
    expect(walletSpendable(w(-24_406n, 0n, 24_406n))).toMatchObject({ ok: true, spendableMinor: 24_406n });
    expect(candidateSpendable(w(-24_406n, 0n, 24_406n))).toBe(24_406n);
  });

  it("credit account with nothing used, and partly used", () => {
    expect(walletSpendable(w(0n, 100_000n, 100_000n))).toMatchObject({ ok: true, spendableMinor: 100_000n });
    expect(walletSpendable(w(30_000n, 100_000n, 70_000n))).toMatchObject({ ok: true, spendableMinor: 70_000n });
  });

  it("an empty prepaid wallet has nothing to spend", () => {
    expect(walletSpendable(w(0n, 0n, 0n))).toMatchObject({ ok: true, spendableMinor: 0n });
  });

  it("the opposite sign reading never passes: a positive balance with no credit and a positive payable figure is a mismatch", () => {
    // If someone read "balance 244.06 = money we have", payable would have to be −244.06 under TravelDesk's definition.
    expect(walletSpendable(w(24_406n, 0n, 24_406n))).toEqual({ ok: false, reason: "funds_mismatch" });
  });

  it("a negative payable figure is refused", () => {
    expect(walletSpendable(w(24_406n, 0n, -24_406n))).toEqual({ ok: false, reason: "funds_negative" });
  });

  it("a missing or non-numeric figure is refused", () => {
    expect(walletSpendable(null)).toEqual({ ok: false, reason: "funds_missing" });
    expect(walletSpendable({ balanceMinor: 0n, creditFacilityMinor: 0n })).toEqual({ ok: false, reason: "funds_missing" });
    expect(walletSpendable({ balanceMinor: 0n, creditFacilityMinor: 0n, payableMinor: 100 as unknown as bigint })).toEqual({ ok: false, reason: "funds_missing" });
    expect(walletSpendable({ balanceMinor: Number.NaN as unknown as bigint, creditFacilityMinor: 0n, payableMinor: 0n })).toEqual({ ok: false, reason: "funds_missing" });
    expect(candidateSpendable({ balanceMinor: 0n, payableMinor: 0n })).toBeNull();
  });

  it("a one-cent difference is tolerated and the lower figure is used", () => {
    expect(walletSpendable(w(-24_406n, 0n, 24_405n))).toMatchObject({ ok: true, spendableMinor: 24_405n });
    expect(walletSpendable(w(-24_405n, 0n, 24_406n))).toMatchObject({ ok: true, spendableMinor: 24_405n });
  });

  it("a mismatch is refused unless Outly's own open holds explain a lower payable figure", () => {
    // payable 200.00, derived 244.06: a gap of 44.06.
    expect(walletSpendable(w(-24_406n, 0n, 20_000n))).toEqual({ ok: false, reason: "funds_mismatch" });
    expect(walletSpendable(w(-24_406n, 0n, 20_000n), 4_000n)).toEqual({ ok: false, reason: "funds_mismatch" });
    expect(walletSpendable(w(-24_406n, 0n, 20_000n), 4_406n)).toMatchObject({ ok: true, spendableMinor: 20_000n });
    // Holds can never explain a payable figure above the derived one.
    expect(walletSpendable(w(-20_000n, 0n, 24_406n), 10_000n)).toEqual({ ok: false, reason: "funds_mismatch" });
  });
});

describe("running total of a multi-item order (rule 3)", () => {
  it("the first check uses the current read", () => {
    expect(orderSpendable(24_406n, null, 0n)).toEqual({ spendableMinor: 24_406n, runningMinor: null });
  });

  it("a further item is checked against the first read minus what the order already reserved, while the hold is not yet visible", () => {
    // Item one (150.00) is reserved, but the wallet read still shows the first figure: the running total wins.
    expect(orderSpendable(24_406n, 24_406n, 15_000n)).toEqual({ spendableMinor: 9_406n, runningMinor: 9_406n });
  });

  it("the reads need not match: a lower current read (a portal booking meanwhile) wins, a higher one never raises the total", () => {
    expect(orderSpendable(5_000n, 24_406n, 15_000n)).toEqual({ spendableMinor: 5_000n, runningMinor: 9_406n });
    expect(orderSpendable(50_000n, 24_406n, 15_000n)).toEqual({ spendableMinor: 9_406n, runningMinor: 9_406n });
  });

  it("two items cannot both spend one wallet", () => {
    const first = orderSpendable(24_406n, null, 0n).spendableMinor;
    expect(first - 15_000n >= 0n).toBe(true);
    const second = orderSpendable(24_406n, 24_406n, 15_000n).spendableMinor;
    expect(second - 15_000n >= 0n).toBe(false);
  });
});

describe("direction guard (rule 4)", () => {
  const cost = 15_000n;

  it("funds lower by about the cost, or by more (other bookings on the agency), are consistent", () => {
    expect(walletDirection({ beforeMinor: 24_406n, afterMinor: 9_406n, costMinor: cost })).toBe("consistent");
    expect(walletDirection({ beforeMinor: 24_406n, afterMinor: 9_450n, costMinor: cost })).toBe("consistent");
    expect(walletDirection({ beforeMinor: 24_406n, afterMinor: 1_000n, costMinor: cost })).toBe("consistent");
  });

  it("funds that did not move pause", () => {
    expect(walletDirection({ beforeMinor: 24_406n, afterMinor: 24_406n, costMinor: cost })).toBe("flat");
    expect(walletDirection({ beforeMinor: 24_406n, afterMinor: 24_450n, costMinor: cost })).toBe("flat");
  });

  it("funds that rose by about the cost (the wrong sign convention) pause", () => {
    expect(walletDirection({ beforeMinor: 24_406n, afterMinor: 39_406n, costMinor: cost })).toBe("inverted");
    expect(DIRECTION_PAUSES).toEqual(["flat", "inverted"]);
  });

  it("movements another booking or a top-up can explain only alert", () => {
    expect(walletDirection({ beforeMinor: 24_406n, afterMinor: 20_000n, costMinor: cost })).toBe("partial");
    expect(walletDirection({ beforeMinor: 24_406n, afterMinor: 100_000n, costMinor: cost })).toBe("rose_unexplained");
    expect(DIRECTION_PAUSES).not.toContain("partial");
    expect(DIRECTION_PAUSES).not.toContain("rose_unexplained");
  });

  it("a cost inside the tolerance gives no verdict", () => {
    expect(walletDirection({ beforeMinor: 24_406n, afterMinor: 24_406n, costMinor: 150n })).toBe("too_small");
  });
});
