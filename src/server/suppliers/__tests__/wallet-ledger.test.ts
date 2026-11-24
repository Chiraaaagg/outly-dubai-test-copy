import { describe, expect, it } from "vitest";
import { walletEntriesFor, walletPhaseOf } from "../wallet-ledger";

/**
 * Supplier wallet book rules (PAY-10): entries follow the supplier's own
 * figures, are written once, and are never inferred. Synthetic amounts.
 */

const charged = (n: bigint) => ({ kind: "charged", amountMinor: -n });

describe("supplier wallet entries (PAY-10)", () => {
  it("maps booking states to wallet phases; uncertain states record nothing", () => {
    expect(["reserved", "awaiting_payment"].map(walletPhaseOf)).toEqual(["holding", "holding"]);
    expect(["confirmed", "awaiting_external"].map(walletPhaseOf)).toEqual(["booked", "booked"]);
    expect(["cancelled", "expired"].map(walletPhaseOf)).toEqual(["released", "released"]);
    for (const s of ["queued", "reserving", "outcome_unknown", "not_found_unresolved", "cancel_unverified", "not_created", "rejected", "manual_review", "cancel_refused"]) {
      expect(walletPhaseOf(s)).toBeNull();
    }
  });

  it("records the first charged figure once, and a different later figure as the difference", () => {
    expect(walletEntriesFor({ phase: "holding", snapshot: { chargedNetMinor: 24_000n }, recorded: [] })).toEqual([{ kind: "charged", amountMinor: -24_000n }]);
    expect(walletEntriesFor({ phase: "booked", snapshot: { chargedNetMinor: 24_000n }, recorded: [charged(24_000n)] })).toEqual([]);
    expect(walletEntriesFor({ phase: "booked", snapshot: { chargedNetMinor: 24_500n }, recorded: [charged(24_000n)] })).toEqual([{ kind: "charge_adjusted", amountMinor: -500n }]);
    expect(walletEntriesFor({ phase: "booked", snapshot: { chargedNetMinor: 24_000n }, recorded: [charged(24_000n), { kind: "charge_adjusted", amountMinor: -500n }] })).toEqual([
      { kind: "charge_adjusted", amountMinor: 500n },
    ]);
  });

  it("writes nothing without a supplier figure", () => {
    expect(walletEntriesFor({ phase: "holding", snapshot: { chargedNetMinor: null }, recorded: [] })).toEqual([]);
    expect(walletEntriesFor({ phase: "holding", snapshot: { chargedNetMinor: 0n }, recorded: [] })).toEqual([]);
    expect(walletEntriesFor({ phase: "released", snapshot: { chargedNetMinor: 24_000n, refundedNetMinor: null }, recorded: [charged(24_000n)] })).toEqual([]);
    expect(walletEntriesFor({ phase: "released", snapshot: { chargedNetMinor: 24_000n }, recorded: [charged(24_000n)] })).toEqual([]);
  });

  it("records a supplier refund once on release, never adjusts the charge then, and never a refund without its charge", () => {
    const released = (refundedNetMinor: bigint, recorded = [charged(24_000n)]) => walletEntriesFor({ phase: "released", snapshot: { chargedNetMinor: 25_000n, refundedNetMinor }, recorded });
    expect(released(24_000n)).toEqual([{ kind: "refunded", amountMinor: 24_000n }]);
    expect(released(24_000n, [charged(24_000n), { kind: "refunded", amountMinor: 24_000n }])).toEqual([]);
    expect(released(24_000n, [charged(24_000n), { kind: "refunded", amountMinor: 20_000n }])).toEqual([{ kind: "refunded", amountMinor: 4_000n }]);
    expect(released(12_000n, [])).toEqual([
      { kind: "charged", amountMinor: -25_000n },
      { kind: "refunded", amountMinor: 12_000n },
    ]);
  });
});
