import "server-only";
import { prisma } from "../lib/db";
import { emitEvent } from "../lib/structured-events";

/**
 * Daily retention purge (doc 26 §2 gaps 1, 2 and 5; doc 29 §6.5 "Existing
 * gap", Batch 1c). Deletes rows whose own expiry has passed by a window, and
 * nothing else:
 *
 *  - `otp_challenges` (sign-in, `ocv:` and `rcv:` subjects; rows 8, 9, 11):
 *    past `expires_at` plus a short abuse-investigation window. The verify
 *    rate limits live in `rate_limit_buckets`, not in these rows (doc 26 §2).
 *  - `customer_sessions`, `admin_sessions` (rows 5, 7): past `expires_at`.
 *  - `guest_capability_grants` (row 18): past `expires_at`, or revoked, plus
 *    an audit window. A checkout grant (`issued_for = 'checkout'`) is
 *    deleted on expiry only: the partial unique index that stops a second
 *    checkout grant for an order is freed by the delete, so the row must
 *    outlive the verification window it was minted under (at most 24 h after
 *    the verification, `checkoutGrantMs`); the audit window is far longer.
 *  - unbound `order_contact_verifications` (`order_id` NULL) of a quote that
 *    is itself purge-due: a verified contact hash for a quote that never
 *    became an order. They are the only thing that would keep such a quote.
 *  - `quotes` (row 23): expired by the window, never used by an order, and
 *    named by no order item, payment or contact verification.
 *  - `guest_sessions` (row 6): past `expires_at` and named by no quote, so a
 *    session behind a live order's quote stays as long as that quote does.
 *
 * Each class runs in batches of `PURGE_BATCH_SIZE` rows (`DELETE … WHERE id IN
 * (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)`), at most `PURGE_MAX_BATCHES`
 * batches per class per run, inside one run budget. A run that stops early
 * leaves the rest for the next run: the predicates only ever match rows
 * already past their window, so a repeat run is a no-op and a live row is
 * never matched. One class failing does not stop the others.
 *
 * Each per-table predicate is served by an index on `expires_at` (and
 * `revoked_at` for grants), migration 20261123130000.
 *
 * Logs counts, durations and reason codes only (`retention.purged`,
 * `retention.purge_failed`): never an id, a hash or a subject.
 *
 * The windows are provisional (doc 26: periods are the owner's on the
 * adviser's advice); they are deliberately short because each row is either
 * useless once expired or a linkable contact hash. Change them here only.
 */

const DAY_MS = 24 * 3600_000;

export const RETENTION_WINDOWS = Object.freeze({
  /** `otp_challenges`: kept this long after `expires_at` for abuse investigation. */
  otpAbuseWindowMs: 7 * DAY_MS,
  /** Customer, admin and guest sessions: this long after `expires_at` (clock-skew margin only). */
  sessionGraceMs: 1 * DAY_MS,
  /** Capability grants: this long after expiry or revocation (audit of who used which link). */
  grantAuditWindowMs: 30 * DAY_MS,
  /** Unused quotes and their unbound verifications: this long after `expires_at`. */
  quoteWindowMs: 7 * DAY_MS,
});

export const PURGE_BATCH_SIZE = 500;
export const PURGE_MAX_BATCHES = 20;
/** Whole-run budget; the route's `maxDuration` is 60 s. */
export const PURGE_BUDGET_MS = 40_000;

/** Order matters: verifications before quotes, quotes before guest sessions (foreign keys, RESTRICT). */
export const PURGE_CLASSES = [
  "otp_challenges",
  "customer_sessions",
  "admin_sessions",
  "guest_capability_grants",
  "unbound_contact_verifications",
  "quotes",
  "guest_sessions",
] as const;

export type PurgeClass = (typeof PURGE_CLASSES)[number];

/** The newest `expires_at` (or revocation) a row of `cls` may have and still be deleted. */
export function purgeCutoff(cls: PurgeClass, now: Date): Date {
  const w = RETENTION_WINDOWS;
  const ms =
    cls === "otp_challenges"
      ? w.otpAbuseWindowMs
      : cls === "guest_capability_grants"
        ? w.grantAuditWindowMs
        : cls === "quotes" || cls === "unbound_contact_verifications"
          ? w.quoteWindowMs
          : w.sessionGraceMs;
  return new Date(now.getTime() - ms);
}

export interface PurgeStore {
  /** Deletes at most `limit` purge-due rows of `cls` older than `cutoff`; returns how many. */
  purgeBatch(cls: PurgeClass, cutoff: Date, limit: number): Promise<number>;
}

/** The Postgres store: one bounded statement per batch. */
export const prismaPurgeStore: PurgeStore = {
  async purgeBatch(cls, cutoff, limit) {
    switch (cls) {
      case "otp_challenges":
        return prisma.$executeRaw`
          DELETE FROM "otp_challenges" WHERE "id" IN (
            SELECT "id" FROM "otp_challenges" WHERE "expires_at" < ${cutoff}
            LIMIT ${limit} FOR UPDATE SKIP LOCKED)`;
      case "customer_sessions":
        return prisma.$executeRaw`
          DELETE FROM "customer_sessions" WHERE "id" IN (
            SELECT "id" FROM "customer_sessions" WHERE "expires_at" < ${cutoff}
            LIMIT ${limit} FOR UPDATE SKIP LOCKED)`;
      case "admin_sessions":
        return prisma.$executeRaw`
          DELETE FROM "admin_sessions" WHERE "id" IN (
            SELECT "id" FROM "admin_sessions" WHERE "expires_at" < ${cutoff}
            LIMIT ${limit} FOR UPDATE SKIP LOCKED)`;
      case "guest_capability_grants":
        return prisma.$executeRaw`
          DELETE FROM "guest_capability_grants" WHERE "id" IN (
            SELECT "id" FROM "guest_capability_grants"
            WHERE "expires_at" < ${cutoff}
               OR ("revoked_at" < ${cutoff} AND "issued_for" <> 'checkout')
            LIMIT ${limit} FOR UPDATE SKIP LOCKED)`;
      case "unbound_contact_verifications":
        return prisma.$executeRaw`
          DELETE FROM "order_contact_verifications" WHERE "id" IN (
            SELECT v."id" FROM "order_contact_verifications" v
            JOIN "quotes" q ON q."id" = v."quote_id"
            WHERE v."order_id" IS NULL
              AND q."expires_at" < ${cutoff}
              AND q."used_by_order_id" IS NULL
              AND NOT EXISTS (SELECT 1 FROM "order_items" oi WHERE oi."quote_id" = q."id")
              AND NOT EXISTS (SELECT 1 FROM "payments" p WHERE p."quote_id" = q."id")
            LIMIT ${limit} FOR UPDATE OF v SKIP LOCKED)`;
      case "quotes":
        return prisma.$executeRaw`
          DELETE FROM "quotes" WHERE "id" IN (
            SELECT q."id" FROM "quotes" q
            WHERE q."expires_at" < ${cutoff}
              AND q."used_by_order_id" IS NULL
              AND NOT EXISTS (SELECT 1 FROM "order_items" oi WHERE oi."quote_id" = q."id")
              AND NOT EXISTS (SELECT 1 FROM "payments" p WHERE p."quote_id" = q."id")
              AND NOT EXISTS (SELECT 1 FROM "order_contact_verifications" v WHERE v."quote_id" = q."id")
            LIMIT ${limit} FOR UPDATE OF q SKIP LOCKED)`;
      case "guest_sessions":
        return prisma.$executeRaw`
          DELETE FROM "guest_sessions" WHERE "id" IN (
            SELECT gs."id" FROM "guest_sessions" gs
            WHERE gs."expires_at" < ${cutoff}
              AND NOT EXISTS (SELECT 1 FROM "quotes" q WHERE q."guest_session_id" = gs."id")
            LIMIT ${limit} FOR UPDATE OF gs SKIP LOCKED)`;
    }
  },
};

export interface PurgeClassResult {
  deleted: number;
  batches: number;
  /** True when the last batch was short: nothing purge-due is left for this class. */
  complete: boolean;
  /** A reason code when a batch failed; the class stopped there. */
  failed: string | null;
}

export interface RetentionPurgeResult {
  ok: boolean;
  ranAt: string;
  durationMs: number;
  outOfTime: boolean;
  classes: Record<PurgeClass, PurgeClassResult>;
}

export interface RetentionPurgeOptions {
  store?: PurgeStore;
  now?: () => Date;
  batchSize?: number;
  maxBatches?: number;
  budgetMs?: number;
}

/** A short code for a failure: a Prisma or Postgres error code, never the message. */
function reasonCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,20}$/.test(code) ? code : "error";
}

export async function runRetentionPurge(opts: RetentionPurgeOptions = {}): Promise<RetentionPurgeResult> {
  const store = opts.store ?? prismaPurgeStore;
  const now = opts.now ?? (() => new Date());
  const batchSize = opts.batchSize ?? PURGE_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? PURGE_MAX_BATCHES;
  const budgetMs = opts.budgetMs ?? PURGE_BUDGET_MS;
  const start = now();
  const deadline = start.getTime() + budgetMs;
  let outOfTime = false;

  const classes = {} as Record<PurgeClass, PurgeClassResult>;
  for (const cls of PURGE_CLASSES) {
    // Every cutoff is fixed from the run's start, so a long run never moves its own boundary.
    const cutoff = purgeCutoff(cls, start);
    const r: PurgeClassResult = { deleted: 0, batches: 0, complete: false, failed: null };
    classes[cls] = r;
    while (r.batches < maxBatches) {
      if (now().getTime() >= deadline) {
        outOfTime = true;
        break;
      }
      let n: number;
      try {
        n = await store.purgeBatch(cls, cutoff, batchSize);
      } catch (e) {
        r.failed = reasonCode(e);
        emitEvent("retention.purge_failed", { table: cls, reason: r.failed, batches: r.batches }, "error");
        break;
      }
      r.batches += 1;
      r.deleted += n;
      if (n < batchSize) {
        r.complete = true;
        break;
      }
    }
  }

  const durationMs = now().getTime() - start.getTime();
  const c = classes;
  emitEvent("retention.purged", {
    otpChallenges: c.otp_challenges.deleted,
    customerSessions: c.customer_sessions.deleted,
    adminSessions: c.admin_sessions.deleted,
    grants: c.guest_capability_grants.deleted,
    contactVerifications: c.unbound_contact_verifications.deleted,
    quotes: c.quotes.deleted,
    guestSessions: c.guest_sessions.deleted,
    failed: PURGE_CLASSES.filter((k) => c[k].failed).length,
    incomplete: PURGE_CLASSES.filter((k) => !c[k].complete).length,
    outOfTime,
    durationMs,
  });
  const ok = PURGE_CLASSES.every((k) => !c[k].failed);
  return { ok, ranAt: start.toISOString(), durationMs, outOfTime, classes };
}
