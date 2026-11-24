import { CrmCallError, type CrmPort, type DealFields, type DealRef } from "./bitrix.client";
import type { CrmConfig, CrmScope } from "./crm.config";
import { assertSafeCrmPayload, mapDeal, type CrmEntityType, type CrmSubject, type CrmSubjectState } from "./crm.mapping";

/**
 * CRM outbox worker (doc 29 §6.4; CRM batch C1): drains `crm_outbox` for
 * one (environment, portal) into Bitrix24 deals. Storage, the CRM port, the
 * state loader, the rate limiter and the clock are parameters, so the same
 * engine runs against Postgres in production and against an in-memory store
 * and the fake portal in unit tests.
 *
 * One run:
 *  1. Stored portal identity: the funnel and originator the links were
 *     written with must equal the configuration, else the run is refused
 *     (`portal_identity_mismatch`): moving to another funnel needs a human.
 *  2. Circuit breaker / throttle pause on the portal row: a paused portal is
 *     skipped without a call.
 *  3. Single-flight run lease per portal; stale `running` rows go back.
 *  4. Rows due for this scope only, oldest first (catch-up in order). Rows of
 *     another environment or portal are never claimed (`foreignDue`).
 *  5. Per row, the subject's link lock (the create lock): a row at or below
 *     the pushed version is a no-op (`stale`); otherwise the current state is
 *     read, mapped (a subject created before switch-on, the portal row's
 *     first run less `SWITCH_ON_SLACK_MS`, never gets a new deal: no
 *     backfill, C2-12), checked by the payload guard, compared with the last
 *     pushed hash (`unchanged`), and pushed. Before every create the portal is
 *     searched by originId: one match is adopted, several are a twin (the
 *     oldest is kept and the link flagged; nothing is deleted automatically),
 *     none after a lost create answer waits `CREATE_SETTLE_MS` before
 *     creating, so a lost answer never makes a twin.
 *  6. Budget: `budgetMs` (10 s) for starting rows; every call is paced by the
 *     limiter (1 request a second per portal, half the documented 2/s).
 *
 * Failures:
 *  - throttled (QUERY_LIMIT_EXCEEDED, OPERATION_TIME_LIMIT): the run stops,
 *    the row waits with jitter (no attempt counted) and the portal pauses;
 *  - auth (revoked credential, missing scope): the circuit opens for an
 *    hour, the row waits, no attempt is burned;
 *  - unavailable / invalid answer / rejected: attempt + 1, exponential
 *    backoff with jitter (30 s → 1 h); after `maxAttempts` (8) the row is
 *    dead-lettered (`crm.dead_letter`, error level). Five consecutive
 *    unavailable answers open the breaker (5 min, doubling, cap 1 h). While
 *    it is open no row is attempted; after a pause one row probes, and a
 *    failed probe counts no attempt (the portal, not the row, is at fault),
 *    so an outage of any length dead-letters nothing and catches up in
 *    order once the portal answers;
 *  - refused (payload guard, delete guard): dead at once, never retried.
 *
 * Deletes (erasure, 2-year retention; owner answer Q1: the service account
 * may delete in the OUTLYY funnel only): `deleteCopies` deletes only a deal
 * that the portal shows in the configured funnel AND that is this
 * environment's link (its `crmId`) or carries this link's originator and
 * originId. A deal OUTLYY did not create, or one in another funnel, is
 * never a delete target (`assertDeleteTarget`).
 */

export const CRM_RUN_BUDGET_MS = 10_000;
export const CRM_MAX_ATTEMPTS = 8;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 3_600_000;
export const BREAKER_THRESHOLD = 5;
export const BREAKER_BASE_PAUSE_MS = 5 * 60_000;
export const BREAKER_CAP_MS = 3_600_000;
export const AUTH_PAUSE_MS = 3_600_000;
export const THROTTLE_PAUSE_MS = 60_000;
export const CREATE_SETTLE_MS = 60_000;
export const ROW_LOCK_MS = 120_000;
export const LINK_BUSY_RETRY_MS = 5_000;
/**
 * No backfill (decision C2-12): a subject created before the sync was first
 * switched on never gets a new deal. Switch-on is taken as the first worker
 * run for the portal (the portal row's `createdAt`), less this slack, which
 * covers the minute between the switch-on deploy and the first cron call.
 */
export const SWITCH_ON_SLACK_MS = 10 * 60_000;

export type CrmOp = "sync" | "delete";
export type CrmLinkState = "pending" | "creating" | "active" | "deleted";

export interface CrmOutboxRow {
  id: string;
  entityType: CrmEntityType;
  entityId: string;
  kind: CrmOp;
  version: bigint;
  attempts: number;
  maxAttempts: number;
  reason: string | null;
}

export interface CrmLinkRow {
  id: string;
  entityType: CrmEntityType;
  entityId: string;
  crmId: bigint | null;
  originatorId: string;
  originId: string;
  state: CrmLinkState;
  creatingSince: Date | null;
  localVersion: bigint;
  pushedVersion: bigint;
  pushedHash: string | null;
  pushedAt: Date | null;
  twinFlaggedAt: Date | null;
}

export type CrmLinkPatch = Partial<Pick<CrmLinkRow, "crmId" | "state" | "creatingSince" | "pushedVersion" | "pushedHash" | "pushedAt" | "twinFlaggedAt">> & {
  deletedAt?: Date | null;
  deleteReason?: "erasure" | "retention" | "crm_deleted" | null;
};

export interface CrmPortalStateRow {
  /** First worker run for this portal: when the sync was switched on (no backfill before it). */
  createdAt: Date;
  categoryId: number;
  originatorId: string;
  pausedUntil: Date | null;
  pauseReason: "throttled" | "breaker" | "auth" | null;
  consecutiveFailures: number;
}

export type LockLinkResult = { kind: "locked"; link: CrmLinkRow } | { kind: "busy" } | { kind: "missing" };

export interface CrmStore {
  /** The portal row, inserted with this identity when absent. */
  ensurePortal(scope: CrmScope, identity: { categoryId: number; originatorId: string }): Promise<CrmPortalStateRow>;
  acquireLease(scope: CrmScope, holder: string, now: Date, until: Date): Promise<boolean>;
  releaseLease(scope: CrmScope, holder: string): Promise<void>;
  setPortalHealth(scope: CrmScope, patch: Partial<Pick<CrmPortalStateRow, "pausedUntil" | "pauseReason" | "consecutiveFailures">>): Promise<void>;
  /** `running` rows of this scope whose lock lapsed go back to `queued`. */
  releaseStaleRows(scope: CrmScope, now: Date): Promise<number>;
  claimNext(scope: CrmScope, holder: string, now: Date, lockUntil: Date): Promise<CrmOutboxRow | null>;
  completeRow(id: string, holder: string, outcome: string): Promise<void>;
  retryRow(id: string, holder: string, r: { attempts: number; nextAttemptAt: Date; code: string }): Promise<void>;
  deadRow(id: string, holder: string, r: { attempts: number; code: string }): Promise<void>;
  /** Back to the queue without counting an attempt (throttle, auth, busy link, settle wait, budget). */
  deferRow(id: string, holder: string, r: { nextAttemptAt: Date; code: string }): Promise<void>;
  /** Due rows written for another environment or portal (never claimed here). */
  countForeignDue(scope: CrmScope, now: Date): Promise<number>;
  lockLink(scope: CrmScope, subject: CrmSubject, holder: string, now: Date, until: Date): Promise<LockLinkResult>;
  /** Re-read of a locked link (after the lock, so versions written meanwhile are seen). */
  updateLink(linkId: string, holder: string, patch: CrmLinkPatch): Promise<void>;
  unlockLink(linkId: string, holder: string): Promise<void>;
}

/** Paces CRM calls. `take` resolves false when this run (or the portal's shared window) has no budget left. */
export interface CrmLimiter {
  take(): Promise<boolean>;
}

export interface CrmWorkerDeps {
  config: CrmConfig;
  store: CrmStore;
  port: CrmPort;
  loadState: (subject: CrmSubject) => Promise<CrmSubjectState>;
  limiter: CrmLimiter;
  now: () => Date;
  random?: () => number;
  holder?: string;
  /** Structured event sink (emitEvent in production). */
  emit?: (name: CrmWorkerEvent, fields: Record<string, unknown>, level?: "info" | "warn" | "error") => void;
}

export type CrmWorkerEvent =
  | "crm.row_done"
  | "crm.row_failed"
  | "crm.dead_letter"
  | "crm.twin_detected"
  | "crm.circuit_open"
  | "crm.refused"
  | "crm.currency_mismatch"
  | "crm.erasure_unverified";

export interface CrmRunSummary {
  ok: true;
  outcome: "ran" | "paused" | "busy" | "refused";
  reason?: string;
  processed: number;
  pushed: number;
  noop: number;
  deleted: number;
  deferred: number;
  failed: number;
  dead: number;
  throttled: boolean;
  breakerOpen: boolean;
  foreignDue: number;
  outcomes: Record<string, number>;
  durationMs: number;
}

class BudgetExhausted extends Error {}

/** Exponential backoff with "equal jitter": half fixed, half random. */
export function backoffMs(attempts: number, random: () => number = Math.random, base = BACKOFF_BASE_MS, cap = BACKOFF_CAP_MS): number {
  const exp = Math.min(cap, base * 2 ** Math.max(0, Math.min(attempts - 1, 20)));
  return Math.round(exp / 2 + (exp / 2) * random());
}

export function breakerPauseMs(consecutiveFailures: number): number {
  return Math.min(BREAKER_CAP_MS, BREAKER_BASE_PAUSE_MS * 2 ** Math.max(0, consecutiveFailures - BREAKER_THRESHOLD));
}

type RowResult =
  | { type: "done"; outcome: string; pushed?: boolean; deleted?: boolean }
  | { type: "defer"; delayMs: number; code: string }
  | { type: "error"; error: CrmCallError };

function gate(port: CrmPort, limiter: CrmLimiter): CrmPort {
  const take = async () => {
    if (!(await limiter.take())) throw new BudgetExhausted();
  };
  return {
    findDealsByOrigin: async (a, b) => (await take(), port.findDealsByOrigin(a, b)),
    findDealById: async (id) => (await take(), port.findDealById(id)),
    addDeal: async (f) => (await take(), port.addDeal(f)),
    updateDeal: async (id, f) => (await take(), port.updateDeal(id, f)),
    setProductRows: async (id, r) => (await take(), port.setProductRows(id, r)),
    deleteDeal: async (id) => (await take(), port.deleteDeal(id)),
  };
}

export async function runCrmWorker(deps: CrmWorkerDeps, opts: { budgetMs?: number } = {}): Promise<CrmRunSummary> {
  const { config, store } = deps;
  const scope: CrmScope = { environment: config.environment, portal: config.portal };
  const random = deps.random ?? Math.random;
  const holder = deps.holder ?? `crm-${random().toString(36).slice(2, 10)}`;
  const emit = deps.emit ?? (() => {});
  const budgetMs = Math.max(0, opts.budgetMs ?? CRM_RUN_BUDGET_MS);
  const started = deps.now().getTime();
  const port = gate(deps.port, deps.limiter);
  const summary: CrmRunSummary = {
    ok: true,
    outcome: "ran",
    processed: 0,
    pushed: 0,
    noop: 0,
    deleted: 0,
    deferred: 0,
    failed: 0,
    dead: 0,
    throttled: false,
    breakerOpen: false,
    foreignDue: 0,
    outcomes: {},
    durationMs: 0,
  };
  const finish = () => ({ ...summary, durationMs: deps.now().getTime() - started });

  summary.foreignDue = await store.countForeignDue(scope, deps.now());
  const portal = await store.ensurePortal(scope, { categoryId: config.categoryId, originatorId: config.originatorId });
  if (portal.categoryId !== config.categoryId || portal.originatorId !== config.originatorId) {
    emit("crm.refused", { reason: "portal_identity_mismatch" }, "error");
    return { ...finish(), outcome: "refused", reason: "portal_identity_mismatch" };
  }
  if (portal.pausedUntil && portal.pausedUntil.getTime() > deps.now().getTime()) {
    return { ...finish(), outcome: "paused", reason: portal.pauseReason ?? "paused", breakerOpen: portal.pauseReason !== "throttled" };
  }
  const leaseUntil = new Date(deps.now().getTime() + budgetMs + ROW_LOCK_MS);
  if (!(await store.acquireLease(scope, holder, deps.now(), leaseUntil))) return { ...finish(), outcome: "busy" };

  let failures = portal.consecutiveFailures;
  const notBefore = new Date(portal.createdAt.getTime() - SWITCH_ON_SLACK_MS);
  try {
    await store.releaseStaleRows(scope, deps.now());
    while (deps.now().getTime() - started < budgetMs) {
      const now = deps.now();
      const row = await store.claimNext(scope, holder, now, new Date(now.getTime() + ROW_LOCK_MS));
      if (!row) break;
      summary.processed += 1;
      const result = await processRow(deps, port, scope, holder, row, notBefore);
      const at = deps.now().getTime();

      if (result.type === "done") {
        await store.completeRow(row.id, holder, result.outcome);
        summary.outcomes[result.outcome] = (summary.outcomes[result.outcome] ?? 0) + 1;
        if (result.pushed) summary.pushed += 1;
        else if (result.deleted) summary.deleted += 1;
        else summary.noop += 1;
        emit("crm.row_done", { outboxId: row.id, entityType: row.entityType, entityId: row.entityId, op: row.kind, outcome: result.outcome });
        if (failures > 0 && (result.pushed || result.deleted)) {
          failures = 0;
          await store.setPortalHealth(scope, { consecutiveFailures: 0 });
        }
        continue;
      }
      if (result.type === "defer") {
        summary.deferred += 1;
        await store.deferRow(row.id, holder, { nextAttemptAt: new Date(at + result.delayMs), code: result.code });
        if (result.code === "budget") break;
        continue;
      }

      const err = result.error;
      if (err.kind === "throttled") {
        const pause = backoffMs(1, random, THROTTLE_PAUSE_MS, THROTTLE_PAUSE_MS * 2);
        summary.throttled = true;
        summary.deferred += 1;
        await store.deferRow(row.id, holder, { nextAttemptAt: new Date(at + pause), code: err.code });
        await store.setPortalHealth(scope, { pausedUntil: new Date(at + pause), pauseReason: "throttled" });
        break;
      }
      if (err.kind === "auth") {
        summary.breakerOpen = true;
        summary.deferred += 1;
        await store.deferRow(row.id, holder, { nextAttemptAt: new Date(at + AUTH_PAUSE_MS), code: err.code });
        await store.setPortalHealth(scope, { pausedUntil: new Date(at + AUTH_PAUSE_MS), pauseReason: "auth" });
        emit("crm.circuit_open", { reason: "auth", pausedUntil: new Date(at + AUTH_PAUSE_MS), failures }, "error");
        break;
      }
      if (err.kind === "refused") {
        summary.dead += 1;
        await store.deadRow(row.id, holder, { attempts: row.attempts, code: err.code });
        emit("crm.dead_letter", { outboxId: row.id, entityType: row.entityType, entityId: row.entityId, op: row.kind, reason: err.code, attempts: row.attempts }, "error");
        continue;
      }

      const outage = err.kind === "unavailable" || err.kind === "invalid_response";
      if (outage && failures >= BREAKER_THRESHOLD) {
        // Half-open probe after a breaker pause failed: the portal is still down. The row waits without an
        // attempt counted, so an outage of any length never dead-letters rows; the breaker re-opens, longer.
        failures += 1;
        const pausedUntil = new Date(at + breakerPauseMs(failures));
        summary.breakerOpen = true;
        summary.deferred += 1;
        await store.deferRow(row.id, holder, { nextAttemptAt: new Date(at + backoffMs(Math.max(1, row.attempts), random)), code: err.code });
        await store.setPortalHealth(scope, { consecutiveFailures: failures, pausedUntil, pauseReason: "breaker" });
        emit("crm.circuit_open", { reason: "breaker", pausedUntil, failures }, "error");
        break;
      }
      const attempts = row.attempts + 1;
      if (attempts >= row.maxAttempts) {
        summary.dead += 1;
        await store.deadRow(row.id, holder, { attempts, code: err.code });
        emit("crm.dead_letter", { outboxId: row.id, entityType: row.entityType, entityId: row.entityId, op: row.kind, reason: err.code, attempts }, "error");
      } else {
        summary.failed += 1;
        await store.retryRow(row.id, holder, { attempts, nextAttemptAt: new Date(at + backoffMs(attempts, random)), code: err.code });
        emit("crm.row_failed", { outboxId: row.id, entityType: row.entityType, entityId: row.entityId, op: row.kind, reason: err.code, attempts }, "warn");
      }
      if (outage) {
        failures += 1;
        if (failures >= BREAKER_THRESHOLD) {
          const pausedUntil = new Date(at + breakerPauseMs(failures));
          summary.breakerOpen = true;
          await store.setPortalHealth(scope, { consecutiveFailures: failures, pausedUntil, pauseReason: "breaker" });
          emit("crm.circuit_open", { reason: "breaker", pausedUntil, failures }, "error");
          break;
        }
        await store.setPortalHealth(scope, { consecutiveFailures: failures });
      }
    }
  } finally {
    await store.releaseLease(scope, holder);
  }
  return finish();
}

async function processRow(deps: CrmWorkerDeps, port: CrmPort, scope: CrmScope, holder: string, row: CrmOutboxRow, notBefore: Date): Promise<RowResult> {
  const subject: CrmSubject = { type: row.entityType, id: row.entityId };
  const now = deps.now();
  const lock = await deps.store.lockLink(scope, subject, holder, now, new Date(now.getTime() + ROW_LOCK_MS));
  if (lock.kind === "missing") return { type: "done", outcome: "no_link" };
  if (lock.kind === "busy") return { type: "defer", delayMs: LINK_BUSY_RETRY_MS, code: "link_busy" };
  const link = lock.link;
  try {
    if (row.kind === "delete") return await deleteCopies(deps, port, holder, link, row.reason === "retention" ? "retention" : "erasure");
    return await sync(deps, port, holder, link, row, notBefore);
  } catch (e) {
    if (e instanceof BudgetExhausted) return { type: "defer", delayMs: 0, code: "budget" };
    if (e instanceof CrmCallError) return { type: "error", error: e };
    return { type: "error", error: new CrmCallError("rejected", "worker", { code: "internal" }) };
  } finally {
    await deps.store.unlockLink(link.id, holder);
  }
}

async function sync(deps: CrmWorkerDeps, port: CrmPort, holder: string, link: CrmLinkRow, row: CrmOutboxRow, notBefore: Date): Promise<RowResult> {
  const { store, config } = deps;
  if (link.state === "deleted") return { type: "done", outcome: "tombstoned" };
  if (row.version <= link.pushedVersion) return { type: "done", outcome: "stale" };
  // Everything up to this version is committed: the link lock was taken after it.
  const target = link.localVersion;
  const state = await deps.loadState({ type: link.entityType, id: link.entityId });
  const mapped = mapDeal(state, config, { now: deps.now() });
  if (mapped.visible && state.order?.otherCurrencyPaid) {
    // Staff recorded a payment in another currency than the order's: revenue shows 0 (review C2A-05).
    deps.emit?.("crm.currency_mismatch", { entityType: link.entityType, entityId: link.entityId }, "warn");
  }

  if (!mapped.visible) {
    if (mapped.reason === "erased" && (link.crmId !== null || link.state === "creating")) return deleteCopies(deps, port, holder, link, "erasure");
    await store.updateLink(link.id, holder, { pushedVersion: target });
    return { type: "done", outcome: mapped.reason === "erased" ? "erased" : "not_visible" };
  }
  if (link.crmId === null && link.state !== "creating" && !mapped.createAllowed) {
    await store.updateLink(link.id, holder, { pushedVersion: target });
    return { type: "done", outcome: "not_created" };
  }
  if (link.crmId === null && link.state !== "creating" && state.createdAt && state.createdAt.getTime() < notBefore.getTime()) {
    // Created before switch-on: never a new deal (no backfill, C2-12). A deal that already exists keeps updating.
    await store.updateLink(link.id, holder, { pushedVersion: target });
    return { type: "done", outcome: "before_switch_on" };
  }
  if (link.crmId !== null && mapped.hash === link.pushedHash) {
    await store.updateLink(link.id, holder, { pushedVersion: target });
    return { type: "done", outcome: "unchanged" };
  }
  assertSafeCrmPayload(mapped.fields, mapped.rows, config);

  let crmId = link.crmId === null ? null : Number(link.crmId);
  if (crmId === null) {
    assertSafeCrmPayload(mapped.createFields, mapped.rows, config, { create: true });
    const created = await ensureCreated(deps, port, holder, link, mapped.createFields, mapped.createAllowed);
    if (created.type === "wait") return { type: "defer", delayMs: created.delayMs, code: "create_settle" };
    if (created.type === "none") {
      // A lost create answer, then the subject turned spam, and nothing landed: never create (review C2A-09).
      await store.updateLink(link.id, holder, { state: "pending", creatingSince: null, pushedVersion: target });
      return { type: "done", outcome: "not_created" };
    }
    crmId = created.id;
    if (created.adopted) {
      // The adopted record may hold an older snapshot: write the current one (never the owner: it was set on create).
      await port.updateDeal(crmId, mapped.fields);
    }
  } else {
    try {
      await port.updateDeal(crmId, mapped.fields);
    } catch (e) {
      if (e instanceof CrmCallError && e.kind === "not_found") {
        // Deleted in the CRM: never re-created without a human decision.
        await store.updateLink(link.id, holder, { state: "deleted", deletedAt: deps.now(), deleteReason: "crm_deleted", pushedVersion: target });
        return { type: "done", outcome: "crm_deleted" };
      }
      throw e;
    }
  }
  await port.setProductRows(crmId, mapped.rows);
  await store.updateLink(link.id, holder, { state: "active", crmId: BigInt(crmId), pushedVersion: target, pushedHash: mapped.hash, pushedAt: deps.now() });
  return { type: "done", outcome: "pushed", pushed: true };
}

/**
 * Search by originId before every create (Bitrix24 has no idempotency key).
 * The link is written `creating` before the add call, so a lost answer is
 * recognised on the next attempt.
 */
async function ensureCreated(
  deps: CrmWorkerDeps,
  port: CrmPort,
  holder: string,
  link: CrmLinkRow,
  fields: DealFields,
  createAllowed: boolean,
): Promise<{ type: "id"; id: number; adopted: boolean } | { type: "wait"; delayMs: number } | { type: "none" }> {
  const found = await port.findDealsByOrigin(link.originatorId, link.originId);
  if (found.length > 0) {
    const keep = found[0];
    const patch: CrmLinkPatch = { crmId: BigInt(keep.id), state: "active" };
    if (found.length > 1) {
      patch.twinFlaggedAt = link.twinFlaggedAt ?? deps.now();
      deps.emit?.("crm.twin_detected", { entityType: link.entityType, entityId: link.entityId, count: found.length }, "error");
    }
    await deps.store.updateLink(link.id, holder, patch);
    return { type: "id", id: keep.id, adopted: true };
  }
  if (link.state === "creating" && link.creatingSince) {
    const waited = deps.now().getTime() - link.creatingSince.getTime();
    if (waited < CREATE_SETTLE_MS) return { type: "wait", delayMs: CREATE_SETTLE_MS - waited };
  }
  // Only a found deal is adopted (to move it to Spam); spam never creates one.
  if (!createAllowed) return { type: "none" };
  await deps.store.updateLink(link.id, holder, { state: "creating", creatingSince: deps.now() });
  const { id } = await port.addDeal(fields);
  await deps.store.updateLink(link.id, holder, { crmId: BigInt(id), state: "active" });
  return { type: "id", id, adopted: false };
}

/**
 * The delete guard (G9): a deal may be deleted only when the portal shows it
 * in the configured OUTLYY funnel, the link belongs to this environment's
 * originator, and the deal is the link's own record or carries the link's
 * originator and originId. Anything else is refused before the call.
 */
export function assertDeleteTarget(deal: DealRef, link: Pick<CrmLinkRow, "crmId" | "originatorId" | "originId">, config: Pick<CrmConfig, "categoryId" | "originatorId">): void {
  const refuse = () => {
    throw new CrmCallError("refused", "crm.item.delete", { code: "delete_target" });
  };
  if (link.originatorId !== config.originatorId) refuse();
  if (deal.categoryId !== config.categoryId) refuse();
  const own = link.crmId !== null && BigInt(deal.id) === link.crmId;
  const tagged = deal.originatorId === link.originatorId && deal.originId === link.originId;
  if (!own && !tagged) refuse();
}

/**
 * Delete every CRM copy of the subject: the linked record and any other
 * record carrying its originId (a twin, or a create whose answer was lost),
 * each only after `assertDeleteTarget`. The link becomes a tombstone so no
 * later change re-creates the deal.
 */
async function deleteCopies(deps: CrmWorkerDeps, port: CrmPort, holder: string, link: CrmLinkRow, reason: "erasure" | "retention"): Promise<RowResult> {
  if (link.state === "deleted") return { type: "done", outcome: "already_deleted" };
  const targets = new Map<number, DealRef>();
  if (link.crmId !== null || link.state === "creating") {
    for (const d of await port.findDealsByOrigin(link.originatorId, link.originId)) targets.set(d.id, d);
  }
  if (link.crmId !== null && !targets.has(Number(link.crmId))) {
    // The linked record no longer carries our originId (or is gone): delete it only if it is still in the OUTLYY funnel.
    const own = await port.findDealById(Number(link.crmId));
    if (own) targets.set(own.id, own);
  }
  const ids = [...targets.keys()].sort((a, b) => a - b);
  if (link.crmId !== null && ids.length === 0) {
    // The linked deal holds the customer's details but the service account cannot see it any more: moved to another
    // funnel by staff, or deleted on the portal. Tombstone (never re-create), then dead-letter the row so the ops
    // alert names it and an administrator checks the other funnels for this deal id (review C2A-08; doc 29d §5.4).
    await deps.store.updateLink(link.id, holder, { state: "deleted", deletedAt: deps.now(), deleteReason: reason, pushedVersion: link.localVersion });
    deps.emit?.("crm.erasure_unverified", { entityType: link.entityType, entityId: link.entityId, reason }, "error");
    return { type: "error", error: new CrmCallError("refused", "crm.item.delete", { code: "linked_deal_not_visible" }) };
  }
  for (const id of ids) assertDeleteTarget(targets.get(id)!, link, deps.config);
  for (const id of ids) await port.deleteDeal(id);
  await deps.store.updateLink(link.id, holder, { state: "deleted", deletedAt: deps.now(), deleteReason: reason, pushedVersion: link.localVersion });
  return ids.length ? { type: "done", outcome: "deleted", deleted: true } : { type: "done", outcome: "nothing_to_delete" };
}

/**
 * In-run pacing: at most one call per `minIntervalMs`, at most `maxPerRun`
 * calls, and an optional shared check (the portal's per-minute window in
 * Postgres) so two runs on two instances cannot double the rate.
 */
export function pacedLimiter(opts: {
  minIntervalMs: number;
  maxPerRun: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  deadline?: number;
  shared?: () => Promise<boolean>;
}): CrmLimiter {
  let last = Number.NEGATIVE_INFINITY;
  let used = 0;
  return {
    async take() {
      if (used >= opts.maxPerRun) return false;
      const wait = last + opts.minIntervalMs - opts.now();
      if (wait > 0) {
        if (opts.deadline !== undefined && opts.now() + wait > opts.deadline) return false;
        await opts.sleep(wait);
      }
      if (opts.shared && !(await opts.shared())) return false;
      last = opts.now();
      used += 1;
      return true;
    },
  };
}
