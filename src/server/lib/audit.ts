import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma, type Tx } from "./db";
import type { Actor } from "./actor";
import { log } from "./logger";

/**
 * AC-ADM-01: every admin/agent mutation is audited with actor, timestamp,
 * before and after. Rows are immutable at the database level (trigger in the
 * init migration). Callers pass the transaction when the mutation is
 * transactional so the audit row commits with the change.
 */

const STRIP = new Set([
  "passwordHash",
  "password_hash",
  "password",
  "temporaryPassword",
  "totpSecretEncrypted",
  "totp_secret_encrypted",
  "totpSecret",
  "secret",
  "otpauthUri",
  "refreshHash",
  "token",
]);

function scrub(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(
    JSON.stringify(value, (k, v) => {
      if (STRIP.has(k)) return "[stripped]";
      if (typeof v === "bigint") return v.toString();
      return v;
    }),
  ) as Prisma.InputJsonValue;
}

export async function audit(
  actor: Actor,
  action: string,
  entity: { type: string; id: string },
  change: { before?: unknown; after?: unknown; reason?: string } = {},
  tx: Tx | typeof prisma = prisma,
): Promise<void> {
  try {
    await tx.auditLog.create({
      data: {
        actorType: actor.type,
        actorId: actor.id,
        action,
        entityType: entity.type,
        entityId: entity.id,
        before: scrub(change.before),
        after: scrub(change.after),
        reason: change.reason,
        ipHash: actor.ipHash,
        userAgent: actor.userAgent,
      },
    });
  } catch (error) {
    // An audit failure inside a transaction rolls the mutation back (correct);
    // outside one it must still be visible.
    log.error("audit.write_failed", { action, entity, error });
    throw error;
  }
}

/* ---------------------------------------------------------------------------
 * Field-name audit (PRV-2)
 *
 * `audit_logs` is append-only (trigger in the init migration), so a value
 * written there can never be erased. New money, ticket and identity events
 * therefore record WHICH fields changed, never what they changed from or to:
 *
 *  - `fields`: field names (identifier-shaped: a letter, then letters,
 *    digits, `_` or `.`, at most 64 characters);
 *  - `ids`: row ids or random tokens (UUIDs, `[A-Za-z0-9_.:-]`, at most 80
 *    characters; a bare run of seven or more digits is refused because it
 *    looks like a phone number);
 *  - `hashes`: keyed hashes, lowercase hex (16–128 characters), for example
 *    `hmacFor("lookup", …)`; never an unkeyed hash of a contact;
 *  - `counts`: non-negative integers;
 *  - `codes`: short status or reason codes (same shape as ids).
 *
 * Anything else is dropped before the row is written, whatever the caller
 * passes, and the drop is logged by key only. There is no free-text reason:
 * a reason belongs in `codes`. Field names must be the caller's constants,
 * never request data: a one-word value has the shape of a field name and
 * cannot be told apart from one. `audit`'s scrubber still runs afterwards,
 * so a key named `token` (or another `STRIP` name) is written as
 * `[stripped]`: name ids accordingly (`markerToken`).
 * ------------------------------------------------------------------------ */

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const ID_OR_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const PHONE_LIKE = /^\d{7,}$/;
const KEYED_HASH = /^[0-9a-f]{16,128}$/;
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface FieldChanges {
  fields: readonly string[];
  ids?: Record<string, string | readonly string[] | null | undefined>;
  hashes?: Record<string, string | readonly string[] | null | undefined>;
  counts?: Record<string, number | null | undefined>;
  codes?: Record<string, string | readonly string[] | null | undefined>;
}

export interface FieldChangeRecord {
  fields: string[];
  ids?: Record<string, string | string[]>;
  hashes?: Record<string, string | string[]>;
  counts?: Record<string, number>;
  codes?: Record<string, string | string[]>;
}

function isIdOrCode(v: string): boolean {
  return ID_OR_CODE.test(v) && !PHONE_LIKE.test(v);
}

function keepStrings(
  input: Record<string, string | readonly string[] | null | undefined> | undefined,
  ok: (v: string) => boolean,
  dropped: string[],
  group: string,
): Record<string, string | string[]> | undefined {
  if (!input) return undefined;
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === null || v === undefined) continue;
    if (!KEY.test(k)) {
      dropped.push(`${group}.?`);
      continue;
    }
    if (typeof v === "string") {
      if (ok(v)) out[k] = v;
      else dropped.push(`${group}.${k}`);
    } else if (Array.isArray(v)) {
      const kept = v.filter((x): x is string => typeof x === "string" && ok(x));
      if (kept.length !== v.length) dropped.push(`${group}.${k}`);
      out[k] = kept;
    } else dropped.push(`${group}.${k}`);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The record `auditFieldChanges` writes: only names, ids, keyed hashes,
 * counts and codes survive. Pure; exported for tests.
 */
export function fieldChangeRecord(change: FieldChanges): { record: FieldChangeRecord; dropped: string[] } {
  const dropped: string[] = [];
  const fields = [...new Set((Array.isArray(change.fields) ? change.fields : []).filter((f) => {
    const ok = typeof f === "string" && FIELD_NAME.test(f);
    if (!ok) dropped.push("fields");
    return ok;
  }))].sort();
  const record: FieldChangeRecord = { fields };
  const ids = keepStrings(change.ids, isIdOrCode, dropped, "ids");
  const hashes = keepStrings(change.hashes, (v) => KEYED_HASH.test(v), dropped, "hashes");
  const codes = keepStrings(change.codes, isIdOrCode, dropped, "codes");
  let counts: Record<string, number> | undefined;
  for (const [k, v] of Object.entries(change.counts ?? {})) {
    if (v === null || v === undefined) continue;
    if (KEY.test(k) && typeof v === "number" && Number.isSafeInteger(v) && v >= 0) (counts ??= {})[k] = v;
    else dropped.push(`counts.${KEY.test(k) ? k : "?"}`);
  }
  if (ids) record.ids = ids;
  if (hashes) record.hashes = hashes;
  if (counts) record.counts = counts;
  if (codes) record.codes = codes;
  return { record, dropped: [...new Set(dropped)] };
}

/** Names of the keys whose values differ between two flat snapshots (`undefined` and `null` count as equal). */
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)).sort();
}

/**
 * Audits a change by field names (PRV-2). `before` is never written; `after`
 * holds the `FieldChangeRecord`. The entity id must itself be an id, not a
 * contact: a phone, e-mail or name there is refused with an error.
 */
export async function auditFieldChanges(
  actor: Actor,
  action: string,
  entity: { type: string; id: string },
  change: FieldChanges,
  tx: Tx | typeof prisma = prisma,
): Promise<void> {
  if (!isIdOrCode(entity.id) || !FIELD_NAME.test(entity.type)) throw new Error("auditFieldChanges: entity type and id must be identifiers");
  const { record, dropped } = fieldChangeRecord(change);
  if (dropped.length) log.warn("audit.field_values_dropped", { action, keys: dropped });
  await audit(actor, action, entity, { after: record }, tx);
}
