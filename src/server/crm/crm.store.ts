import "server-only";
import { prisma, TX_OPTIONS } from "../lib/db";
import type { CrmScope } from "./crm.config";
import { CRM_PAYLOAD_VERSION, type CrmEntityType, type CrmSubject } from "./crm.mapping";
import { enqueueCrmDelete, type CrmDeleteReason } from "./crm.outbox";
import type { CrmLinkPatch, CrmLinkRow, CrmOutboxRow, CrmPortalStateRow, CrmStore, LockLinkResult } from "./crm.worker";

/**
 * Postgres `CrmStore` (crm_outbox, crm_links, crm_portal_state; migration
 * 20261122120000). Every write is one statement, outside any long
 * transaction: no transaction is ever held open across a CRM call.
 *
 *  - Claim: `FOR UPDATE SKIP LOCKED`, due rows of this scope only, oldest
 *    first, payload versions this build understands only.
 *  - Link lock: a compare-and-set on `locked_by`/`locked_until`. It waits on
 *    the row lock of an uncommitted enqueue, so the returned
 *    `local_version` is committed (see crm.outbox.ts).
 *  - Every row update checks `locked_by = holder`: a worker that lost its
 *    lock changes nothing.
 */

interface LinkSqlRow {
  id: string;
  entity_type: CrmEntityType;
  entity_id: string;
  crm_id: bigint | null;
  originator_id: string;
  origin_id: string;
  state: CrmLinkRow["state"];
  creating_since: Date | null;
  local_version: bigint;
  pushed_version: bigint;
  pushed_hash: string | null;
  pushed_at: Date | null;
  twin_flagged_at: Date | null;
}

function linkOf(r: LinkSqlRow): CrmLinkRow {
  return {
    id: r.id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    crmId: r.crm_id === null ? null : BigInt(r.crm_id),
    originatorId: r.originator_id,
    originId: r.origin_id,
    state: r.state,
    creatingSince: r.creating_since,
    localVersion: BigInt(r.local_version),
    pushedVersion: BigInt(r.pushed_version),
    pushedHash: r.pushed_hash,
    pushedAt: r.pushed_at,
    twinFlaggedAt: r.twin_flagged_at,
  };
}

export const prismaCrmStore: CrmStore = {
  async ensurePortal(scope, identity) {
    await prisma.$executeRaw`
      INSERT INTO crm_portal_state (environment, portal, category_id, originator_id, updated_at)
      VALUES (${scope.environment}, ${scope.portal}, ${identity.categoryId}, ${identity.originatorId}, now())
      ON CONFLICT (environment, portal) DO NOTHING`;
    const row = await prisma.crmPortalState.findUniqueOrThrow({ where: { environment_portal: { environment: scope.environment, portal: scope.portal } } });
    return {
      createdAt: row.createdAt,
      categoryId: row.categoryId,
      originatorId: row.originatorId,
      pausedUntil: row.pausedUntil,
      pauseReason: row.pauseReason as CrmPortalStateRow["pauseReason"],
      consecutiveFailures: row.consecutiveFailures,
    };
  },

  async acquireLease(scope, holder, now, until) {
    const n = await prisma.$executeRaw`
      UPDATE crm_portal_state SET lease_holder = ${holder}, lease_until = ${until}, updated_at = now()
      WHERE environment = ${scope.environment} AND portal = ${scope.portal}
        AND (lease_until IS NULL OR lease_until < ${now} OR lease_holder = ${holder})`;
    return n === 1;
  },

  async releaseLease(scope, holder) {
    await prisma.crmPortalState.updateMany({ where: { environment: scope.environment, portal: scope.portal, leaseHolder: holder }, data: { leaseHolder: null, leaseUntil: null } });
  },

  async setPortalHealth(scope, patch) {
    await prisma.crmPortalState.updateMany({ where: { environment: scope.environment, portal: scope.portal }, data: patch });
  },

  async releaseStaleRows(scope, now) {
    return prisma.$executeRaw`
      UPDATE crm_outbox SET status = 'queued', locked_by = NULL, locked_until = NULL, updated_at = now()
      WHERE environment = ${scope.environment} AND portal = ${scope.portal} AND status = 'running' AND locked_until < ${now}`;
  },

  async claimNext(scope, holder, now, lockUntil) {
    const rows = await prisma.$queryRaw<
      { id: string; entity_type: CrmEntityType; entity_id: string; kind: "sync" | "delete"; version: bigint; attempts: number; max_attempts: number; reason: string | null }[]
    >`
      UPDATE crm_outbox SET status = 'running', locked_by = ${holder}, locked_until = ${lockUntil}, updated_at = now()
      WHERE id = (
        SELECT id FROM crm_outbox
        WHERE environment = ${scope.environment} AND portal = ${scope.portal} AND status = 'queued'
          AND next_attempt_at <= ${now} AND payload_version <= ${CRM_PAYLOAD_VERSION}
        ORDER BY created_at, id
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      RETURNING id, entity_type, entity_id, kind, version, attempts, max_attempts, reason`;
    const r = rows[0];
    if (!r) return null;
    return { id: r.id, entityType: r.entity_type, entityId: r.entity_id, kind: r.kind, version: BigInt(r.version), attempts: r.attempts, maxAttempts: r.max_attempts, reason: r.reason } satisfies CrmOutboxRow;
  },

  async completeRow(id, holder, outcome) {
    await prisma.crmOutbox.updateMany({ where: { id, lockedBy: holder, status: "running" }, data: { status: "done", outcome, lockedBy: null, lockedUntil: null } });
  },

  async retryRow(id, holder, r) {
    await prisma.crmOutbox.updateMany({
      where: { id, lockedBy: holder, status: "running" },
      data: { status: "queued", attempts: r.attempts, nextAttemptAt: r.nextAttemptAt, lastErrorCode: r.code, lockedBy: null, lockedUntil: null },
    });
  },

  async deadRow(id, holder, r) {
    await prisma.crmOutbox.updateMany({
      where: { id, lockedBy: holder, status: "running" },
      data: { status: "dead", attempts: r.attempts, lastErrorCode: r.code, outcome: "dead", lockedBy: null, lockedUntil: null },
    });
  },

  async deferRow(id, holder, r) {
    await prisma.crmOutbox.updateMany({
      where: { id, lockedBy: holder, status: "running" },
      data: { status: "queued", nextAttemptAt: r.nextAttemptAt, lastErrorCode: r.code, lockedBy: null, lockedUntil: null },
    });
  },

  async countForeignDue(scope, now) {
    return prisma.crmOutbox.count({
      where: { status: "queued", nextAttemptAt: { lte: now }, NOT: { environment: scope.environment, portal: scope.portal } },
    });
  },

  async lockLink(scope, subject, holder, now, until): Promise<LockLinkResult> {
    const rows = await prisma.$queryRaw<LinkSqlRow[]>`
      UPDATE crm_links SET locked_by = ${holder}, locked_until = ${until}, updated_at = now()
      WHERE environment = ${scope.environment} AND portal = ${scope.portal}
        AND entity_type = ${subject.type} AND entity_id = ${subject.id}::uuid
        AND (locked_until IS NULL OR locked_until < ${now} OR locked_by = ${holder})
      RETURNING id, entity_type, entity_id, crm_id, originator_id, origin_id, state, creating_since,
                local_version, pushed_version, pushed_hash, pushed_at, twin_flagged_at`;
    if (rows[0]) return { kind: "locked", link: linkOf(rows[0]) };
    const exists = await prisma.crmLink.count({ where: { environment: scope.environment, portal: scope.portal, entityType: subject.type, entityId: subject.id } });
    return exists ? { kind: "busy" } : { kind: "missing" };
  },

  async updateLink(linkId, holder, patch: CrmLinkPatch) {
    await prisma.crmLink.updateMany({ where: { id: linkId, lockedBy: holder }, data: patch });
  },

  async unlockLink(linkId, holder) {
    await prisma.crmLink.updateMany({ where: { id: linkId, lockedBy: holder }, data: { lockedBy: null, lockedUntil: null } });
  },
};

/* ---------------------------------------------------------------------------
 * Retention (owner decision 19: CRM copies are kept 2 years, then deleted;
 * doc 29 §6.5). Local rows hold no personal data; they are purged so the
 * tables stay small.
 * ------------------------------------------------------------------------ */

/** CRM copies are deleted this long after the subject's last pushed change. */
export const CRM_RETENTION_DAYS = 730;
/** Finished outbox rows are kept this long for diagnosis. */
export const CRM_OUTBOX_DONE_DAYS = 30;
export const CRM_OUTBOX_DEAD_DAYS = 90;
/** Tombstones stop a late change from re-creating a deleted deal; kept as long as the copies would have been. */
export const CRM_TOMBSTONE_DAYS = 730;

const DAY = 86_400_000;

export interface CrmRetentionResult {
  scheduled: number;
  purgedOutbox: number;
  purgedLinks: number;
}

/**
 * Enqueue a `delete` (reason `retention`) for every live link of the scope
 * whose last push is older than `CRM_RETENTION_DAYS`, then purge finished
 * outbox rows and old tombstones. Delivery of the deletes is the worker's,
 * under the same switch.
 */
export async function runCrmRetention(scope: CrmScope, now: Date, limit = 200): Promise<CrmRetentionResult> {
  const before = new Date(now.getTime() - CRM_RETENTION_DAYS * DAY);
  const due = await prisma.crmLink.findMany({
    where: {
      environment: scope.environment,
      portal: scope.portal,
      state: { in: ["active", "creating"] },
      pushedAt: { lt: before },
    },
    select: { entityType: true, entityId: true },
    orderBy: { pushedAt: "asc" },
    take: limit,
  });
  let scheduled = 0;
  for (const d of due) {
    const subject: CrmSubject = { type: d.entityType as CrmEntityType, id: d.entityId };
    const pending = await prisma.crmOutbox.count({
      where: { environment: scope.environment, portal: scope.portal, entityType: subject.type, entityId: subject.id, kind: "delete", status: { in: ["queued", "running"] } },
    });
    if (pending) continue;
    scheduled += await prisma.$transaction((tx) => enqueueCrmDelete(tx, [subject], "retention" satisfies CrmDeleteReason, scope), TX_OPTIONS);
  }
  const outboxDone = await prisma.crmOutbox.deleteMany({
    where: { environment: scope.environment, portal: scope.portal, status: "done", updatedAt: { lt: new Date(now.getTime() - CRM_OUTBOX_DONE_DAYS * DAY) } },
  });
  const outboxDead = await prisma.crmOutbox.deleteMany({
    where: { environment: scope.environment, portal: scope.portal, status: "dead", updatedAt: { lt: new Date(now.getTime() - CRM_OUTBOX_DEAD_DAYS * DAY) } },
  });
  const links = await prisma.crmLink.deleteMany({
    where: { environment: scope.environment, portal: scope.portal, state: "deleted", deletedAt: { lt: new Date(now.getTime() - CRM_TOMBSTONE_DAYS * DAY) } },
  });
  return { scheduled, purgedOutbox: outboxDone.count + outboxDead.count, purgedLinks: links.count };
}
