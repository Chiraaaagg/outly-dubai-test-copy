import type { CrmScope } from "@/server/crm/crm.config";
import type { CrmEntityType } from "@/server/crm/crm.mapping";
import {
  TAMPER_WINDOW_MS,
  type CrmFindingInput,
  type CrmReturnLink,
  type CrmReturnLinkPatch,
  type CrmReturnLinkState,
  type CrmReturnPortalState,
  type CrmReturnStore,
  type CrmTwinCommentFinish,
  type CrmTwinFinding,
} from "@/server/crm/crm.reconcile";
import type { CrmLinkRow } from "@/server/crm/crm.worker";
import { MemoryCrmStore, type FakeClock } from "./_memory-store";

/**
 * In-memory `CrmReturnStore` (C3ab) on top of the in-memory worker store,
 * with the same rules as crm.return.store.ts: link writes fenced by the link
 * lock, `queuePush` writes the same outbox row an enqueue does, one finding
 * per (scope, kind, subject) with the same raise rules, twin comments
 * claimed at most once. The Postgres store is covered by the db suite
 * (crm.return.db.test.ts).
 */

export interface MemFinding {
  id: string;
  environment: string;
  portal: string;
  kind: string;
  subjectKey: string;
  crmId: number | null;
  linkId: string | null;
  detail: string | null;
  occurrences: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  raisedAt: Date;
  commentState: string | null;
  commentRefCrmId: number | null;
  commentPostingBy: string | null;
  commentPostingSince: number | null;
  commentPostedAt: Date | null;
  crmCommentId: number | null;
  commentErrorCode: string | null;
}

type LinkExtra = Partial<CrmReturnLinkState> & { sweepSeenAt?: Date | null; createdAt: number; environment: string; portal: string; lockedBy: string | null };

const EMPTY_PORTAL: CrmReturnPortalState = {
  reconcileCursor: null,
  reconcileCheckedAt: null,
  fingerprintHash: null,
  fingerprintState: null,
  fingerprintCheckedAt: null,
  fingerprintOkAt: null,
  sweepCursorId: null,
  sweepStartedAt: null,
  sweepCompletedAt: null,
  driftCursorLinkId: null,
};

let fid = 0;

export class MemoryReturnStore extends MemoryCrmStore implements CrmReturnStore {
  readonly findings: MemFinding[] = [];
  readonly returnPortals = new Map<string, CrmReturnPortalState>();
  /** Test hook: writes counted per method, to prove `observe` writes nothing else. */
  readonly writes: Record<string, number> = {};

  constructor(clock: FakeClock) {
    super(clock);
  }

  private count(name: string) {
    this.writes[name] = (this.writes[name] ?? 0) + 1;
  }

  private pkey(scope: CrmScope) {
    return `${scope.environment}/${scope.portal}`;
  }

  private inScope(scope: CrmScope) {
    return this.links.filter((l) => l.environment === scope.environment && l.portal === scope.portal);
  }

  private asReturn(l: CrmLinkRow & LinkExtra): CrmReturnLink {
    return {
      id: l.id,
      entityType: l.entityType,
      entityId: l.entityId,
      crmId: l.crmId,
      originatorId: l.originatorId,
      originId: l.originId,
      state: l.state,
      creatingSince: l.creatingSince,
      localVersion: l.localVersion,
      pushedVersion: l.pushedVersion,
      pushedHash: l.pushedHash,
      pushedAt: l.pushedAt,
      twinFlaggedAt: l.twinFlaggedAt,
      crmSeenUpdatedAt: l.crmSeenUpdatedAt ?? null,
      crmSeenStageId: l.crmSeenStageId ?? null,
      crmSeenOwnerId: l.crmSeenOwnerId ?? null,
      revertCount: l.revertCount ?? 0,
      lastRevertAt: l.lastRevertAt ?? null,
      prevRevertAt: l.prevRevertAt ?? null,
      lastRevertCommentAt: l.lastRevertCommentAt ?? null,
      lastFieldRestoreAt: l.lastFieldRestoreAt ?? null,
      holdUntil: l.holdUntil ?? null,
      missingSince: l.missingSince ?? null,
    };
  }

  /** The link with its return columns (test reads). */
  returnLinkOf(scope: CrmScope, s: { type: CrmEntityType; id: string }): (CrmReturnLink & { sweepSeenAt: Date | null }) | undefined {
    const l = this.link(scope, s) as (CrmLinkRow & LinkExtra) | undefined;
    return l ? { ...this.asReturn(l), sweepSeenAt: l.sweepSeenAt ?? null } : undefined;
  }

  async returnPortal(scope: CrmScope) {
    return { ...(this.returnPortals.get(this.pkey(scope)) ?? EMPTY_PORTAL) };
  }

  async setReturnPortal(scope: CrmScope, patch: Partial<CrmReturnPortalState>) {
    this.count("setReturnPortal");
    this.returnPortals.set(this.pkey(scope), { ...(this.returnPortals.get(this.pkey(scope)) ?? EMPTY_PORTAL), ...patch });
  }

  async returnLinkByCrmId(scope: CrmScope, crmId: number) {
    const l = this.inScope(scope).find((x) => x.crmId !== null && Number(x.crmId) === crmId) as (CrmLinkRow & LinkExtra) | undefined;
    return l ? this.asReturn(l) : null;
  }

  async returnLinksByOrigin(scope: CrmScope, originIds: string[]) {
    return this.inScope(scope)
      .filter((l) => originIds.includes(l.originId))
      .map((l) => this.asReturn(l as CrmLinkRow & LinkExtra));
  }

  async updateReturnLink(linkId: string, holder: string, patch: CrmReturnLinkPatch) {
    this.count("updateReturnLink");
    const l = this.links.find((x) => x.id === linkId);
    if (l && l.lockedBy === holder) Object.assign(l, patch);
  }

  async queuePush(scope: CrmScope, linkId: string, holder: string, opts: { clearHash: boolean }) {
    this.count("queuePush");
    const l = this.links.find((x) => x.id === linkId);
    if (!l || l.lockedBy !== holder || l.state === "deleted" || l.environment !== scope.environment || l.portal !== scope.portal) return false;
    if (opts.clearHash) l.pushedHash = null;
    return this.enqueue(scope, { type: l.entityType, id: l.entityId }) !== null;
  }

  async markSweepSeen(linkIds: string[], at: Date) {
    for (const l of this.links) if (linkIds.includes(l.id)) Object.assign(l, { sweepSeenAt: at, missingSince: null });
  }

  async finishSweep(scope: CrmScope, startedAt: Date, now: Date) {
    const out: CrmReturnLink[] = [];
    for (const l of this.inScope(scope) as (CrmLinkRow & LinkExtra)[]) {
      if (l.state !== "active" || l.crmId === null || l.createdAt >= startedAt.getTime()) continue;
      if (l.sweepSeenAt && l.sweepSeenAt.getTime() >= startedAt.getTime()) continue;
      if (!l.missingSince) l.missingSince = now;
      out.push(this.asReturn(l));
    }
    return out;
  }

  async driftCandidates(scope: CrmScope, afterLinkId: string | null, limit: number) {
    return this.inScope(scope)
      .filter((l) => l.state === "active" && l.crmId !== null && l.localVersion === l.pushedVersion && (afterLinkId === null || l.id > afterLinkId))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((l) => ({ ...this.asReturn(l as CrmLinkRow & LinkExtra) }) as CrmLinkRow);
  }

  async raiseFinding(scope: CrmScope, f: CrmFindingInput, now: Date) {
    const prior = this.findings.find((x) => x.environment === scope.environment && x.portal === scope.portal && x.kind === f.kind && x.subjectKey === f.subjectKey);
    if (!prior) {
      fid += 1;
      this.findings.push({
        id: `00000000-0000-7000-9000-${fid.toString(16).padStart(12, "0")}`,
        environment: scope.environment,
        portal: scope.portal,
        kind: f.kind,
        subjectKey: f.subjectKey,
        crmId: f.crmId ?? null,
        linkId: f.linkId ?? null,
        detail: f.detail ?? null,
        occurrences: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        raisedAt: f.alertOnRepeat ? new Date(0) : now,
        commentState: null,
        commentRefCrmId: null,
        commentPostingBy: null,
        commentPostingSince: null,
        commentPostedAt: null,
        crmCommentId: null,
        commentErrorCode: null,
      });
      return;
    }
    const stale = prior.lastSeenAt.getTime() < now.getTime() - TAMPER_WINDOW_MS;
    if (stale) prior.raisedAt = f.alertOnRepeat ? new Date(0) : now;
    else if (f.alertOnRepeat && prior.raisedAt.getTime() === 0) prior.raisedAt = now;
    prior.occurrences += 1;
    prior.lastSeenAt = now;
    prior.crmId = f.crmId ?? prior.crmId;
    prior.linkId = f.linkId ?? prior.linkId;
    prior.detail = f.detail ?? prior.detail;
  }

  async twinFindingsSince(scope: CrmScope, since: Date): Promise<CrmTwinFinding[]> {
    return this.findings
      .filter((f) => f.environment === scope.environment && f.portal === scope.portal && f.kind === "crm_twin" && f.crmId !== null && f.lastSeenAt.getTime() >= since.getTime())
      .sort((a, b) => (a.crmId ?? 0) - (b.crmId ?? 0))
      .map((f) => {
        const l = f.linkId ? this.links.find((x) => x.id === f.linkId) : undefined;
        return {
          id: f.id,
          crmId: f.crmId as number,
          linkId: f.linkId,
          commentState: f.commentState,
          link: l ? { id: l.id, entityType: l.entityType, entityId: l.entityId, crmId: l.crmId === null ? null : Number(l.crmId), state: l.state, twinFlaggedAt: l.twinFlaggedAt } : null,
        };
      });
  }

  async dropFinding(id: string) {
    const i = this.findings.findIndex((f) => f.id === id);
    if (i >= 0) this.findings.splice(i, 1);
  }

  async setTwinComment(id: string, refCrmId: number) {
    const f = this.findings.find((x) => x.id === id);
    if (f && f.kind === "crm_twin" && f.commentState === null && f.crmId !== null) Object.assign(f, { commentState: "pending", commentRefCrmId: refCrmId });
  }

  async claimTwinComments(scope: CrmScope, holder: string, now: Date, opts: { limit: number; staleBefore: Date }) {
    for (const f of this.findings) {
      if (f.environment === scope.environment && f.portal === scope.portal && f.commentState === "posting" && (f.commentPostingSince ?? 0) < opts.staleBefore.getTime()) {
        Object.assign(f, { commentState: "unknown", commentErrorCode: "posting_lapsed", commentPostingBy: null, commentPostingSince: null });
      }
    }
    const due = this.findings
      .filter((f) => f.environment === scope.environment && f.portal === scope.portal && f.commentState === "pending")
      .sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime())
      .slice(0, opts.limit);
    for (const f of due) Object.assign(f, { commentState: "posting", commentPostingBy: holder, commentPostingSince: now.getTime() });
    return due.map((f) => ({ id: f.id, crmId: f.crmId as number, refCrmId: f.commentRefCrmId as number }));
  }

  async finishTwinComment(id: string, holder: string, r: CrmTwinCommentFinish) {
    const f = this.findings.find((x) => x.id === id);
    if (!f || f.commentPostingBy !== holder || f.commentState !== "posting") return;
    Object.assign(f, { commentPostingBy: null, commentPostingSince: null });
    if (r.status === "posted") Object.assign(f, { commentState: "posted", commentPostedAt: r.at, crmCommentId: r.crmCommentId, commentErrorCode: null });
    else Object.assign(f, { commentState: r.status, commentErrorCode: r.code });
  }

  findingsOf(kind: string): MemFinding[] {
    return this.findings.filter((f) => f.kind === kind);
  }
}
