import type { SupplierSnapshot } from "./booking-port";

/**
 * Supplier wallet book (PAY-10, doc 22 §23 B3): what the supplier's own
 * figures say left or came back to Outly's prepaid supplier wallet, one
 * append-only `ledger_entries` row per movement in book `supplier_wallet`.
 *
 * Rules:
 *  - Figures come from the supplier's answer only (`chargedNetMinor`, and the
 *    refund figure an adapter may add), never from what Outly expected or
 *    quoted. An answer without a figure writes nothing: reconciliation then
 *    shows the gap, and nothing is inferred.
 *  - Reserve is treated as debiting the wallet until TravelDesk answers
 *    question 10 (doc 22 §28.1): the first answer that shows a hold, a
 *    confirmed booking or a pending one, with a charged figure, writes
 *    `charged`. A later answer with another figure for a live booking writes
 *    the difference as `charge_adjusted`; nothing is ever rewritten.
 *  - A cancelled or expired booking whose answer carries a refund figure
 *    writes `refunded` for what the book has not yet recorded. A release
 *    whose charge was never recorded records it first, so the book never
 *    shows a refund without its charge.
 *  - Positive is money into the wallet: `charged` is negative, `refunded`
 *    positive. Amounts are AED minor units.
 *
 * Pure: the engine (supplier-booking.service.ts) reads the entries already
 * recorded for the booking and writes these in the transition's transaction.
 */

export const SUPPLIER_WALLET_BOOK = "supplier_wallet" as const;

/**
 * A refund figure an adapter may add to its snapshot (a local extension of
 * the frozen `SupplierSnapshot`). TravelDesk: the booking's `refund` field.
 * Absent or null means the supplier did not say.
 */
export interface SupplierRefundFigure {
  refundedNetMinor?: bigint | null;
}

export type WalletEntryKind = "charged" | "charge_adjusted" | "refunded";

/** What a booking state means for the wallet: live (`holding`, `booked`) or given back (`released`). */
export type WalletPhase = "holding" | "booked" | "released";

/** The phase of a supplier booking state, or null for a state that records nothing. */
export function walletPhaseOf(state: string): WalletPhase | null {
  switch (state) {
    case "reserved":
    case "awaiting_payment":
      return "holding";
    case "confirmed":
    case "awaiting_external":
      return "booked";
    case "cancelled":
    case "expired":
      return "released";
    default:
      return null;
  }
}

export interface WalletPlanInput {
  phase: WalletPhase;
  snapshot: Pick<SupplierSnapshot, "chargedNetMinor"> & SupplierRefundFigure;
  /** Entries the book already holds for this booking. */
  recorded: { kind: string; amountMinor: bigint }[];
}

/** The entries to append for one supplier answer; empty when the book already agrees with it. */
export function walletEntriesFor(input: WalletPlanInput): { kind: WalletEntryKind; amountMinor: bigint }[] {
  const out: { kind: WalletEntryKind; amountMinor: bigint }[] = [];
  const sum = (kinds: string[]) => input.recorded.filter((e) => kinds.includes(e.kind)).reduce((a, e) => a + e.amountMinor, 0n);
  const hasCharge = input.recorded.some((e) => e.kind === "charged");
  const charged = -sum(["charged", "charge_adjusted"]);
  const refunded = sum(["refunded"]);
  const figure = input.snapshot.chargedNetMinor;

  if (figure !== null && figure > 0n) {
    if (!hasCharge) {
      out.push({ kind: "charged", amountMinor: -figure });
    } else if (input.phase !== "released" && figure !== charged) {
      out.push({ kind: "charge_adjusted", amountMinor: -(figure - charged) });
    }
  }
  if (input.phase === "released") {
    const r = input.snapshot.refundedNetMinor ?? null;
    if (r !== null && r > refunded) out.push({ kind: "refunded", amountMinor: r - refunded });
  }
  return out;
}
