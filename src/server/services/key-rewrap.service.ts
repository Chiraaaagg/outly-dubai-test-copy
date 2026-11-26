import "server-only";
import { prisma } from "../lib/db";
import { activeKeyId, ciphertextKeyId, KeyUnavailableError, rewrapFor, ringKeyIds, type EncryptionPurpose } from "../lib/crypto";
import { emitEvent, type StructuredEventName } from "../lib/structured-events";

/**
 * Re-wrap of stored ciphertexts after a key rotation (doc 22 §32.9 R-B4-10,
 * PRV-5).
 *
 * The rotation path for an encryption ring is: put the new key first in
 * `OUTLY_KEYS_<PURPOSE>` (it encrypts from then on; the old key still
 * decrypts), let this step re-encrypt every stored value under the new key,
 * then drop the old key. This step covers every v2 ciphertext column B4
 * added:
 *
 *  - `supplier_ticket_codes.code_ciphertext` (`ticket_codes` ring) with its
 *    `code_key_id`. The table's trigger allows an update only when nothing
 *    but these two columns changes, which is exactly a re-wrap;
 *  - `guest_capability_grants.token_ciphertext` (`capability_tokens` ring),
 *    the kept token of a message whose outcome is not known yet. Cleared
 *    values (null) need nothing.
 *
 * Rules:
 *  - Bounded: at most `budget` ticket-code rows and at most
 *    max(what is left, a quarter of `budget`) token rows per run. Only rows
 *    under a key that is still in the ring and is not the active key are
 *    selected, so a row under a key already removed never blocks the others.
 *  - Progress past failures (review R-B5-11): rows are read in id order
 *    after a cursor, one per column, kept in `settings`
 *    (`keys.rewrap_cursor.<purpose>`, value `{ afterId }`: a row id, nothing
 *    else). A full page moves the cursor to its last id; a short page means
 *    the end was reached and the next run starts again from the first id.
 *    So rows that fail to open (corrupt, or under the same key id with other
 *    material) are counted once per pass and passed over, never re-read in
 *    every run ahead of the rest. A stored cursor rather than an in-process
 *    one, because each cron run may be a fresh serverless instance. A lost
 *    cursor write only means the next run re-reads one page.
 *  - Idempotent and race-safe: each write is conditional on the row still
 *    holding the ciphertext that was read, so a concurrent re-wrap, a
 *    cleared token or a deletion wins and the row is skipped. A second run
 *    finds nothing to do.
 *  - Nothing but counts is reported (structured event `keys.rewrapped`): no
 *    ids, no ciphertext, no plaintext.
 *  - Never throws to the caller: a missing ring (production without the
 *    variable) is a count of zero with `keys.unavailable`.
 *
 * Keyed hashes (`code_hash`, `token_hash`, contact lookups) are one-way and
 * cannot be re-wrapped; readers match them with `hmacCandidates` during a
 * rotation instead.
 */

export interface RewrapCounts {
  /** Rows read that were under an older key. */
  scanned: number;
  /** Rows now under the active key. */
  rewrapped: number;
  /** Rows another writer changed first (skipped, nothing lost). */
  raced: number;
  /** Rows that could not be opened (corrupt, or under a key no longer in the ring). */
  failed: number;
}

export interface RewrapResult {
  ticketCodes: RewrapCounts;
  capabilityTokens: RewrapCounts;
}

/** Rows per documents tick: small, so the re-wrap never crowds out the document reads. */
export const REWRAP_BUDGET_PER_TICK = 20;

const zero = (): RewrapCounts => ({ scanned: 0, rewrapped: 0, raced: 0, failed: 0 });

/** The `settings` key holding a column's cursor. Exported for tests. */
export const cursorKey = (purpose: EncryptionPurpose) => `keys.rewrap_cursor.${purpose}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readCursor(purpose: EncryptionPurpose): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: cursorKey(purpose) } });
  const afterId = (row?.value as { afterId?: unknown } | null)?.afterId;
  return typeof afterId === "string" && UUID.test(afterId) ? afterId : null;
}

/** Full page: continue after its last id. Short page: the end was reached, start again next run. */
async function writeCursor(purpose: EncryptionPurpose, ids: readonly string[], limit: number): Promise<void> {
  const afterId = ids.length >= limit ? ids[ids.length - 1] : null;
  try {
    await prisma.setting.upsert({ where: { key: cursorKey(purpose) }, create: { key: cursorKey(purpose), value: { afterId } }, update: { value: { afterId } } });
  } catch {
    // The page was still re-wrapped; the next run re-reads it (already re-wrapped rows no longer match).
  }
}

/** Key ids of the purpose's ring other than the active one, or null when the ring is unavailable. */
function olderKeyIds(purpose: EncryptionPurpose): { active: string; older: string[] } | null {
  try {
    const ids = ringKeyIds(purpose);
    return { active: activeKeyId(purpose), older: ids.slice(1) };
  } catch (e) {
    if (!(e instanceof KeyUnavailableError)) throw e;
    emitEvent("keys.unavailable", { purpose, path: "key_rewrap" }, "error");
    return null;
  }
}

/** Re-wraps one value; null when it cannot be opened. */
function rewrapOne(purpose: EncryptionPurpose, stored: string): string | null {
  try {
    return rewrapFor(purpose, stored);
  } catch {
    return null;
  }
}

async function rewrapTicketCodes(limit: number): Promise<RewrapCounts> {
  const out = zero();
  if (limit <= 0) return out;
  const ring = olderKeyIds("ticket_codes");
  if (!ring || !ring.older.length) return out;
  const afterId = await readCursor("ticket_codes");
  const rows = await prisma.supplierTicketCode.findMany({
    where: { codeKeyId: { in: ring.older }, ...(afterId ? { id: { gt: afterId } } : {}) },
    select: { id: true, codeCiphertext: true, codeKeyId: true },
    orderBy: { id: "asc" },
    take: limit,
  });
  for (const row of rows) {
    out.scanned++;
    const next = rewrapOne("ticket_codes", row.codeCiphertext);
    if (!next) {
      out.failed++;
      continue;
    }
    // Only the ciphertext and its key id change: the table's re-wrap-only trigger accepts exactly that.
    const r = await prisma.supplierTicketCode.updateMany({
      where: { id: row.id, codeCiphertext: row.codeCiphertext, codeKeyId: row.codeKeyId },
      data: { codeCiphertext: next, codeKeyId: ciphertextKeyId(next) },
    });
    if (r.count === 1) out.rewrapped++;
    else out.raced++;
  }
  await writeCursor("ticket_codes", rows.map((r) => r.id), limit);
  return out;
}

async function rewrapCapabilityTokens(limit: number): Promise<RewrapCounts> {
  const out = zero();
  if (limit <= 0) return out;
  const ring = olderKeyIds("capability_tokens");
  if (!ring || !ring.older.length) return out;
  const afterId = await readCursor("capability_tokens");
  const rows = await prisma.guestCapabilityGrant.findMany({
    where: { OR: ring.older.map((id) => ({ tokenCiphertext: { startsWith: `v2.capability_tokens.${id}.` } })), ...(afterId ? { id: { gt: afterId } } : {}) },
    select: { id: true, tokenCiphertext: true },
    orderBy: { id: "asc" },
    take: limit,
  });
  for (const row of rows) {
    if (!row.tokenCiphertext) continue;
    out.scanned++;
    const next = rewrapOne("capability_tokens", row.tokenCiphertext);
    if (!next) {
      out.failed++;
      continue;
    }
    // Conditional on the same ciphertext: a token cleared meanwhile (outcome known) stays cleared.
    const r = await prisma.guestCapabilityGrant.updateMany({ where: { id: row.id, tokenCiphertext: row.tokenCiphertext }, data: { tokenCiphertext: next } });
    if (r.count === 1) out.rewrapped++;
    else out.raced++;
  }
  await writeCursor("capability_tokens", rows.map((r) => r.id), limit);
  return out;
}

/**
 * `keys.rewrapped`: counts only. To be listed in STRUCTURED_EVENTS with
 * `purpose, scanned, rewrapped, raced, failed, reason` (lead, B5 carry-over);
 * until then the logger writes it as `event.unlisted`.
 */
const REWRAPPED: StructuredEventName = "keys.rewrapped";

async function pass(purpose: EncryptionPurpose, limit: number, fn: (limit: number) => Promise<RewrapCounts>): Promise<RewrapCounts> {
  let c: RewrapCounts;
  try {
    c = await fn(limit);
  } catch {
    // A database error: nothing is half-written (each row is one conditional update). The next run retries.
    emitEvent(REWRAPPED, { purpose, reason: "pass_failed" }, "error");
    return zero();
  }
  if (c.scanned) emitEvent(REWRAPPED, { purpose, ...c }, c.failed ? "error" : "info");
  return c;
}

export const keyRewrapService = {
  /**
   * One bounded re-wrap pass: ticket codes first, then kept capability
   * tokens with what is left of `budget`, but never less than a quarter of
   * it, so many code rows cannot starve the tokens. Never throws.
   */
  async run(budget: number = REWRAP_BUDGET_PER_TICK): Promise<RewrapResult> {
    const ticketCodes = await pass("ticket_codes", budget, rewrapTicketCodes);
    const capabilityTokens = await pass("capability_tokens", Math.max(budget - ticketCodes.scanned, Math.ceil(budget / 4)), rewrapCapabilityTokens);
    return { ticketCodes, capabilityTokens };
  },
};
