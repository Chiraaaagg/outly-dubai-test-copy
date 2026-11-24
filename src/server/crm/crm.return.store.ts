import "server-only";
import { prisma, TX_OPTIONS } from "../lib/db";
import { uuidv7 } from "../lib/ids";
import type { CrmScope } from "./crm.config";
import { CRM_PAYLOAD_VERSION, type CrmEntityType } from "./crm.mapping";
import { dedupeKeyFor } from "./crm.outbox";
import type { CrmFingerprintState, CrmReturnLink, CrmReturnPortalState, CrmReturnStore, CrmTwinFinding } from "./crm.reconcile";
import { TAMPER_WINDOW_MS } from "./crm.reconcile";
import { prismaCrmStore } from "./crm.store";
import type { CrmLinkRow } from "./crm.worker";

/**
 * Postgres `CrmReturnStore` (CRM batch C3ab; migration 20261126120000): the
 * return path's columns on crm_portal_state and crm_links, and
 * crm_return_findings. Every link write is fenced by the link lock
 * (`locked_by = holder`), like crm.store.ts. One statement each, outside any
 * long transaction, except `queuePush` (the link bump and its outbox row in
 * one short transaction, exactly the rows crm.outbox.ts writes).
 */

const LINK_SELECT = {
  id: true,
  entityType: true,
  entityId: true,
  crmId: true,
  originatorId: true,
  originId: true,
  state: true,
  creatingSince: true,
  localVersion: true,
  pushedVersion: true,
  pushedHash: true,
  pushedAt: true,
  twinFlaggedAt: true,
  crmSeenUpdatedAt: true,
  crmSeenStageId: true,
  crmSeenOwnerId: true,
  revertCount: true,
  lastRevertAt: true,
  prevRevertAt: true,
  lastRevertCommentAt: true,
  lastFieldRestoreAt: true,
  holdUntil: true,
  missingSince: true,
} as const;

type LinkRecord = {
  id: string;
  entityType: string;
  entityId: string;
  crmId: bigint | null;
  originatorId: string;
  originId: string;
  state: string;
  creatingSince: Date | null;
  localVersion: bigint;
  pushedVersion: bigint;
  pushedHash: string | null;
  pushedAt: Date | null;
  twinFlaggedAt: Date | null;
  crmSeenUpdatedAt: Date | null;
  crmSeenStageId: string | null;
  crmSeenOwnerId: bigint | null;
  revertCount: number | null;
  lastRevertAt: Date | null;
  prevRevertAt: Date | null;
  lastRevertCommentAt: Date | null;
  lastFieldRestoreAt: Date | null;
  holdUntil: Date | null;
  missingSince: Date | null;
};

function returnLinkOf(r: LinkRecord): CrmReturnLink {
  return {
    id: r.id,
    entityType: r.entityType as CrmEntityType,
    entityId: r.entityId,
    crmId: r.crmId === null ? null : BigInt(r.crmId),
    originatorId: r.originatorId,
    originId: r.originId,
    state: r.state as CrmLinkRow["state"],
    creatingSince: r.creatingSince,
    localVersion: BigInt(r.localVersion),
    pushedVersion: BigInt(r.pushedVersion),
    pushedHash: r.pushedHash,
    pushedAt: r.pushedAt,
    twinFlaggedAt: r.twinFlaggedAt,
    crmSeenUpdatedAt: r.crmSeenUpdatedAt,
    crmSeenStageId: r.crmSeenStageId,
    crmSeenOwnerId: r.crmSeenOwnerId === null ? null : Number(r.crmSeenOwnerId),
    revertCount: r.revertCount ?? 0,
    lastRevertAt: r.lastRevertAt,
    prevRevertAt: r.prevRevertAt,
    lastRevertCommentAt: r.lastRevertCommentAt,
    lastFieldRestoreAt: r.lastFieldRestoreAt,
    holdUntil: r.holdUntil,
    missingSince: r.missingSince,
  };
}

const where = (scope: CrmScope) => ({ environment: scope.environment, portal: scope.portal });

export const prismaCrmReturnStore: CrmReturnStore = {
  async returnPortal(scope) {
    const r = await prisma.crmPortalState.findUnique({
      where: { environment_portal: where(scope) },
      select: {
        reconcileCursor: true,
        reconcileCheckedAt: true,
        fingerprintHash: true,
        fingerprintState: true,
        fingerprintCheckedAt: true,
        fingerprintOkAt: true,
        sweepCursorId: true,
        sweepStartedAt: true,
        sweepCompletedAt: true,
        driftCursorLinkId: true,
      },
    });
    return {
      reconcileCursor: r?.reconcileCursor ?? null,
      reconcileCheckedAt: r?.reconcileCheckedAt ?? null,
      fingerprintHash: r?.fingerprintHash ?? null,
      fingerprintState: (r?.fingerprintState ?? null) as CrmFingerprintState | null,
      fingerprintCheckedAt: r?.fingerprintCheckedAt ?? null,
      fingerprintOkAt: r?.fingerprintOkAt ?? null,
      sweepCursorId: r?.sweepCursorId === null || r?.sweepCursorId === undefined ? null : Number(r.sweepCursorId),
      sweepStartedAt: r?.sweepStartedAt ?? null,
      sweepCompletedAt: r?.sweepCompletedAt ?? null,
      driftCursorLinkId: r?.driftCursorLinkId ?? null,
    } satisfies CrmReturnPortalState;
  },

  async setReturnPortal(scope, patch) {
    const { sweepCursorId, ...rest } = patch;
    await prisma.crmPortalState.updateMany({
      where: where(scope),
      data: { ...rest, ...(sweepCursorId === undefined ? {} : { sweepCursorId: sweepCursorId === null ? null : BigInt(sweepCursorId) }) },
    });
  },

  async returnLinkByCrmId(scope, crmId) {
    const r = await prisma.crmLink.findFirst({ where: { ...where(scope), crmId: BigInt(crmId) }, select: LINK_SELECT, orderBy: { createdAt: "asc" } });
    return r ? returnLinkOf(r) : null;
  },

  async returnLinksByOrigin(scope, originIds) {
    if (!originIds.length) return [];
    const rows = await prisma.crmLink.findMany({ where: { ...where(scope), originId: { in: originIds } }, select: LINK_SELECT });
    return rows.map(returnLinkOf);
  },

  async updateReturnLink(linkId, holder, patch) {
    const { crmSeenOwnerId, ...rest } = patch;
    await prisma.crmLink.updateMany({
      where: { id: linkId, lockedBy: holder },
      data: { ...rest, ...(crmSeenOwnerId === undefined ? {} : { crmSeenOwnerId: crmSeenOwnerId === null ? null : BigInt(crmSeenOwnerId) }) },
    });
  },

  async queuePush(scope, linkId, holder, opts) {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ entity_type: CrmEntityType; entity_id: string; local_version: bigint }[]>`
        UPDATE crm_links SET local_version = local_version + 1,
          pushed_hash = CASE WHEN ${opts.clearHash} THEN NULL ELSE pushed_hash END, updated_at = now()
        WHERE id = ${linkId}::uuid AND locked_by = ${holder} AND environment = ${scope.environment} AND portal = ${scope.portal} AND state <> 'deleted'
        RETURNING entity_type, entity_id::text AS entity_id, local_version`;
      const link = rows[0];
      if (!link) return false;
      const version = BigInt(link.local_version);
      const subject = { type: link.entity_type, id: link.entity_id };
      await tx.$executeRaw`
        INSERT INTO crm_outbox (id, environment, portal, entity_type, entity_id, kind, version, payload_version, dedupe_key, reason, updated_at)
        VALUES (${uuidv7()}::uuid, ${scope.environment}, ${scope.portal}, ${subject.type}, ${subject.id}::uuid, 'sync', ${version},
                ${CRM_PAYLOAD_VERSION}, ${dedupeKeyFor("sync", subject, version, scope)}, NULL, now())
        ON CONFLICT (dedupe_key) DO NOTHING`;
      return true;
    }, TX_OPTIONS);
  },

  async markSweepSeen(linkIds, at) {
    if (!linkIds.length) return;
    await prisma.crmLink.updateMany({ where: { id: { in: linkIds } }, data: { sweepSeenAt: at, missingSince: null } });
  },

  async finishSweep(scope, startedAt, now) {
    const stale = { ...where(scope), state: "active", crmId: { not: null }, OR: [{ sweepSeenAt: null }, { sweepSeenAt: { lt: startedAt } }] };
    // Only links that existed when the sweep started: a deal created during the sweep was not listed yet.
    await prisma.crmLink.updateMany({ where: { ...stale, missingSince: null, createdAt: { lt: startedAt } }, data: { missingSince: now } });
    const rows = await prisma.crmLink.findMany({ where: { ...stale, createdAt: { lt: startedAt } }, select: LINK_SELECT, take: 500, orderBy: { id: "asc" } });
    return rows.map(returnLinkOf);
  },

  async driftCandidates(scope, afterLinkId, limit) {
    const rows = await prisma.$queryRaw<LinkRecordSql[]>`
      SELECT id::text AS id, entity_type, entity_id::text AS entity_id, crm_id, originator_id, origin_id, state, creating_since,
             local_version, pushed_version, pushed_hash, pushed_at, twin_flagged_at
      FROM crm_links
      WHERE environment = ${scope.environment} AND portal = ${scope.portal} AND state = 'active' AND crm_id IS NOT NULL
        AND local_version = pushed_version AND (${afterLinkId}::uuid IS NULL OR id > ${afterLinkId}::uuid)
      ORDER BY id LIMIT ${limit}`;
    return rows.map((r) => ({
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
    }));
  },

  async raiseFinding(scope, f, now) {
    const repeatBefore = new Date(now.getTime() - TAMPER_WINDOW_MS);
    // A first occurrence that alerts only on a repeat is stored with a raise time outside every lookback.
    const firstRaise = f.alertOnRepeat ? new Date(0) : now;
    await prisma.$executeRaw`
      INSERT INTO crm_return_findings (id, environment, portal, kind, subject_key, crm_id, link_id, detail, occurrences, first_seen_at, last_seen_at, raised_at, updated_at)
      VALUES (${uuidv7()}::uuid, ${scope.environment}, ${scope.portal}, ${f.kind}, ${f.subjectKey}, ${f.crmId ?? null}::bigint, ${f.linkId ?? null}::uuid,
              ${f.detail ?? null}, 1, ${now}, ${now}, ${firstRaise}, now())
      ON CONFLICT (environment, portal, kind, subject_key) DO UPDATE SET
        occurrences = crm_return_findings.occurrences + 1,
        crm_id = COALESCE(EXCLUDED.crm_id, crm_return_findings.crm_id),
        link_id = COALESCE(EXCLUDED.link_id, crm_return_findings.link_id),
        detail = COALESCE(EXCLUDED.detail, crm_return_findings.detail),
        raised_at = CASE
          WHEN crm_return_findings.last_seen_at < ${repeatBefore} THEN ${f.alertOnRepeat ? new Date(0) : now}::timestamptz
          WHEN ${Boolean(f.alertOnRepeat)} AND crm_return_findings.raised_at = 'epoch'::timestamptz THEN ${now}::timestamptz
          ELSE crm_return_findings.raised_at END,
        last_seen_at = ${now},
        updated_at = now()`;
  },

  async twinFindingsSince(scope, since) {
    const rows = await prisma.$queryRaw<
      { id: string; crm_id: bigint; link_id: string | null; comment_state: string | null; l_id: string | null; l_type: CrmEntityType | null; l_entity: string | null; l_crm: bigint | null; l_state: string | null; l_twin: Date | null }[]
    >`
      SELECT f.id::text AS id, f.crm_id, f.link_id::text AS link_id, f.comment_state,
             l.id::text AS l_id, l.entity_type AS l_type, l.entity_id::text AS l_entity, l.crm_id AS l_crm, l.state AS l_state, l.twin_flagged_at AS l_twin
      FROM crm_return_findings f LEFT JOIN crm_links l ON l.id = f.link_id
      WHERE f.environment = ${scope.environment} AND f.portal = ${scope.portal} AND f.kind = 'crm_twin' AND f.crm_id IS NOT NULL AND f.last_seen_at >= ${since}
      ORDER BY f.crm_id LIMIT 500`;
    return rows.map(
      (r): CrmTwinFinding => ({
        id: r.id,
        crmId: Number(r.crm_id),
        linkId: r.link_id,
        commentState: r.comment_state,
        link: r.l_id
          ? { id: r.l_id, entityType: r.l_type as CrmEntityType, entityId: r.l_entity as string, crmId: r.l_crm === null ? null : Number(r.l_crm), state: r.l_state as string, twinFlaggedAt: r.l_twin }
          : null,
      }),
    );
  },

  async dropFinding(id) {
    await prisma.crmReturnFinding.deleteMany({ where: { id } });
  },

  async setTwinComment(id, refCrmId) {
    await prisma.crmReturnFinding.updateMany({ where: { id, kind: "crm_twin", commentState: null, crmId: { not: null } }, data: { commentState: "pending", commentRefCrmId: BigInt(refCrmId) } });
  },

  async claimTwinComments(scope, holder, now, opts) {
    // Never posted twice: a claim whose holder vanished may have reached the portal.
    await prisma.crmReturnFinding.updateMany({
      where: { ...where(scope), commentState: "posting", commentPostingSince: { lt: opts.staleBefore } },
      data: { commentState: "unknown", commentErrorCode: "posting_lapsed", commentPostingBy: null, commentPostingSince: null },
    });
    const rows = await prisma.$queryRaw<{ id: string; crm_id: bigint; comment_ref_crm_id: bigint }[]>`
      UPDATE crm_return_findings SET comment_state = 'posting', comment_posting_by = ${holder}, comment_posting_since = ${now}, updated_at = now()
      WHERE id IN (
        SELECT id FROM crm_return_findings
        WHERE environment = ${scope.environment} AND portal = ${scope.portal} AND comment_state = 'pending'
        ORDER BY first_seen_at, id
        FOR UPDATE SKIP LOCKED LIMIT ${opts.limit}
      )
      RETURNING id::text AS id, crm_id, comment_ref_crm_id`;
    return rows.map((r) => ({ id: r.id, crmId: Number(r.crm_id), refCrmId: Number(r.comment_ref_crm_id) }));
  },

  async finishTwinComment(id, holder, r) {
    const w = { id, commentPostingBy: holder, commentState: "posting" };
    const release = { commentPostingBy: null, commentPostingSince: null };
    if (r.status === "posted") {
      await prisma.crmReturnFinding.updateMany({ where: w, data: { ...release, commentState: "posted", commentPostedAt: r.at, crmCommentId: BigInt(r.crmCommentId), commentErrorCode: null } });
    } else {
      await prisma.crmReturnFinding.updateMany({ where: w, data: { ...release, commentState: r.status, commentErrorCode: r.code } });
    }
  },
};

interface LinkRecordSql {
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

/** The worker's store and the return path's, as the reconciler takes them. */
export const prismaCrmStoreWithReturn = { ...prismaCrmStore, ...prismaCrmReturnStore };
