import "server-only";
import type { Tx } from "../lib/db";
import { uuidv7 } from "../lib/ids";
import type { LedgerEntry } from "./contracts";

/**
 * Ledger writes (PAY-10, PAY-14). `ledger_entries` is append-only (trigger
 * `ledger_entries_immutable`): a correction is a new entry, never an edit.
 * Three books, reconciled and never auto-corrected; B3 writes only
 * `customer_money`, from provider evidence:
 *  - `capture`: + the captured amount, evidence
 *    `capture:<environment>:<provider>:<provider payment id>:<captured total>`;
 *  - `refund`: − the refunded amount, evidence
 *    `refund:<environment>:<provider>:<provider refund id>`.
 * The table has no environment column, so the evidence ref carries it.
 * A void moves no money (the hold was never captured), so it has no entry.
 *
 * `appendOnce` is idempotent on (book, payment, kind, evidence): a re-read of
 * the same provider fact never books it twice. Callers hold the payment row
 * lock (`lockPayment`) so two writers cannot both pass the check.
 */

export async function lockPayment(tx: Tx, paymentId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
}

export async function appendOnce(tx: Tx, entry: LedgerEntry): Promise<boolean> {
  const existing = await tx.ledgerEntry.findFirst({
    where: { book: entry.book, paymentId: entry.paymentId, kind: entry.kind, evidenceRef: entry.evidenceRef },
    select: { id: true },
  });
  if (existing) return false;
  await tx.ledgerEntry.create({
    data: {
      id: uuidv7(),
      book: entry.book,
      orderId: entry.orderId,
      supplierBookingId: entry.supplierBookingId,
      paymentId: entry.paymentId,
      currency: entry.currency,
      amountMinor: entry.amountMinor,
      kind: entry.kind,
      evidenceRef: entry.evidenceRef,
      occurredAt: new Date(entry.occurredAt),
    },
  });
  return true;
}
