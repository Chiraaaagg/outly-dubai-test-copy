import { describe, expect, it } from "vitest";
import { candidateSpendable, debitsWallet, fundsRecheckDelayMs, FUNDS_RECHECK_MAX_MS, FUNDS_RECHECK_MIN_MS, orderSpendable, runningAnchor, walletDirection, walletSpendable, DIRECTION_PAUSES, WALLET_DEBITING_OUTCOMES } from "../wallet-funds";

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

describe("running total anchor (rule 3, review R2)", () => {
  const read = (bookingId: string, minute: number, id: string) => ({ bookingId, at: new Date(Date.UTC(2030, 0, 6, 8, minute)), id });

  it("no live attempt with a read: the check is the order's first", () => {
    expect(runningAnchor([])).toBeNull();
  });

  it("each live attempt counts with its last read (the one right before its send); the earliest of those anchors", () => {
    // Attempt A read at 08:00, was held by the kill switch, read again at 08:30 and sent. Attempt B read at 08:10 and sent.
    const anchor = runningAnchor([read("a", 0, "e1"), read("b", 10, "e2"), read("a", 30, "e3")]);
    expect(anchor).toMatchObject({ bookingId: "b", id: "e2" });
  });

  it("reads at the same instant break ties by event id", () => {
    expect(runningAnchor([read("a", 5, "e9"), read("b", 5, "e2")])).toMatchObject({ bookingId: "b" });
    expect(runningAnchor([read("a", 5, "e1"), read("a", 5, "e4")])).toMatchObject({ id: "e4" });
  });
});

describe("direction guard applies only to a debiting outcome (rule 4, review R1)", () => {
  it.each(["reserved", "awaiting_payment", "confirmed", "awaiting_external"])("%s debits the wallet: checked", (o) => {
    expect(debitsWallet(o)).toBe(true);
  });

  it.each(["cancelled", "expired", "rejected", "not_created", "outcome_unknown", "unknown_status", "manual_review", "unconfirmed", "final_without_payment", "lost_race", "apply_failed", "", null, undefined])(
    "%s moved no money the guard can reason about: never checked",
    (o) => {
      expect(debitsWallet(o as string | null | undefined)).toBe(false);
    },
  );

  it("the debiting list is the holding and booked states only", () => {
    expect([...WALLET_DEBITING_OUTCOMES].sort()).toEqual(["awaiting_external", "awaiting_payment", "confirmed", "reserved"]);
  });
});

describe("re-check backoff after a funds refusal (rule 2, review R6)", () => {
  const t0 = new Date(Date.UTC(2030, 0, 6, 8, 0));
  const at = (ms: number) => new Date(t0.getTime() + ms);

  it("one minute until a human was alerted, and right after the alert", () => {
    expect(fundsRecheckDelayMs(null, t0)).toBe(FUNDS_RECHECK_MIN_MS);
    expect(fundsRecheckDelayMs(t0, at(10_000))).toBe(FUNDS_RECHECK_MIN_MS);
  });

  it("then as long as the refusal has lasted, so the wait about doubles, capped at 15 minutes", () => {
    expect(fundsRecheckDelayMs(t0, at(120_000))).toBe(120_000);
    expect(fundsRecheckDelayMs(t0, at(240_000))).toBe(240_000);
    expect(fundsRecheckDelayMs(t0, at(3_600_000))).toBe(FUNDS_RECHECK_MAX_MS);
  });
});
