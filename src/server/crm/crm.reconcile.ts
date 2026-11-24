import { createHash } from "node:crypto";
import { CrmCallError, type CrmPort, type CrmReturnPort, type CrmStageKind, type DealSnapshot } from "./bitrix.client";
import { CRM_FIELD_KEYS, CRM_STAGE_KEYS, type CrmConfig, type CrmFieldKey, type CrmScope, type CrmStageKey } from "./crm.config";
import type { CrmReturnConfig } from "./crm.return.config";
import { mapDeal, type CrmEntityType, type CrmSubject, type CrmSubjectState } from "./crm.mapping";
import { sameValue } from "./crm.probe";
import type { CrmReturnNoteKind } from "./crm.timeline";
import { ROW_LOCK_MS, THROTTLE_PAUSE_MS, type CrmLimiter, type CrmLinkRow, type CrmRunContext, type CrmRunHooks, type CrmStore } from "./crm.worker";

/**
 * The Bitrix24 return path (doc 29e; CRM batch C3ab; owner answers of 25
 * November 2026; gaps G10, G13, G15). Runs inside the CRM worker's run and
 * lease (`CrmRunHooks`), never as its own route or cron entry.
 *
 * Before the outbox (`beforeRows`):
 *  1. Portal fingerprint (G13, §7), every 6 hours: `profile` (the webhook's
 *     own user id; refused at once if it is a portal administrator),
 *     `crm.category.get` (the OUTLYY funnel), `crm.status.list` (its stages
 *     with their kind). The hash of host, user, funnel id and name, and the
 *     stage list is compared with the one stored by the explicit owner step
 *     (`storeCrmFingerprint`). A mismatch refuses every run (outbox
 *     included) until a person stores it again; an administrator refuses at
 *     once; a check that cannot be read keeps the last good result valid for
 *     24 hours, then refuses. Before a fingerprint is stored, `observe` runs
 *     and `enforce` does nothing on the return path (the push runs as before).
 *  2. Poll (G10, §3.2): one `crm.item.list` of the funnel changed since the
 *     cursor minus 120 s, a second page only if the first was full, at most
 *     2 calls and 20 deals a run. The cursor is a time the portal returned;
 *     it never moves past a deal that was not handled. Each deal goes
 *     through `handleDeal` (§3.4).
 *
 * After the outbox (`afterRows`, healthy runs only), in the night window and
 * only when the queue is empty: one slice of the resumable sweep (G15, §8):
 * the funnel listed by id (at most 6 calls), twins, orphans, hand-made and
 * foreign deals, links whose deal is not visible, then drift without any
 * CRM call (a lost enqueue: the rebuilt hash differs from the pushed one,
 * no push pending). Then up to 2 fixed comments on extra twin deals.
 *
 * Writes. The reconciler never writes a deal itself. A put-back clears the
 * link's pushed hash and queues a normal push (`queuePush`), so the worker
 * stays the only writer. A note on the deal goes through the C2b comment
 * queue (`recordTimelineMoments`, fixed texts in crm.timeline.ts). An
 * accepted staff move or owner change goes through `CrmReturnCommands`, the
 * inquiry service's own `transition` and `assign`, as the mapped staff
 * member's OUTLYY actor, with "via Bitrix24" in the event and audit row.
 * Nothing else in OUTLYY can be reached from here (crm.return.boundary test).
 *
 * Modes: `observe` classifies, logs and alerts (finding rows), and changes
 * nothing else but the poll cursor, the "seen" columns of the links and the
 * sweep cursor. `enforce` puts back, and with `CRM_RETURN_ACCEPT` accepts.
 *
 * Privacy (§12): deal values (customer fields, title) are compared in memory
 * and dropped. Events and findings carry deal ids, OUTLYY ids, stage keys,
 * field keys, Bitrix24 user ids and counts only.
 */

/* ---------------------------------------------------------------- constants */

export const POLL_OVERLAP_MS = 120_000;
/** First poll after switch-on: look back this far (the cursor is then always a portal time). */
export const POLL_FIRST_LOOKBACK_MS = 3_600_000;
export const POLL_MAX_CALLS = 2;
export const POLL_MAX_DEALS = 20;
export const FINGERPRINT_EVERY_MS = 6 * 3_600_000;
/** While the service account is an administrator, look again this often. */
export const FINGERPRINT_ADMIN_RECHECK_MS = 10 * 60_000;
export const FINGERPRINT_GRACE_MS = 24 * 3_600_000;
export const FINGERPRINT_CALLS = 3;
export const TAMPER_WINDOW_MS = 24 * 3_600_000;
export const LOOP_WINDOW_MS = 3_600_000;
export const HOLD_MS = 6 * 3_600_000;
export const COMMENT_EVERY_MS = 24 * 3_600_000;
export const SWEEP_MAX_CALLS = 6;
export const SWEEP_EVERY_MS = 20 * 3_600_000;
export const DRIFT_PER_RUN = 50;
export const TWIN_COMMENTS_PER_RUN = 2;
/** Night window in UTC (early morning in Dubai). */
export const NIGHT_START_UTC = 22;
export const NIGHT_END_UTC = 2;
/** The drift cursor's "done for this sweep" marker. */
export const DRIFT_DONE = "ffffffff-ffff-ffff-ffff-ffffffffffff";

/** Stages staff may move a deal to (doc 29 §5.4 "staff may propose"; owner answer 2): up to Payment pending, and Lost. */
const SALES_TARGET: Partial<Record<CrmStageKey, string>> = {
  contacted: "contacted",
  quoted: "quoted",
  payment_pending: "payment_pending",
  lost: "lost",
};
/** Stages that follow verified facts only (payment, supplier, tickets, refund). */
const INTEGRATION_ONLY: ReadonlySet<CrmStageKey> = new Set(["paid_awaiting_supplier", "confirmed_tickets_pending", "fulfilled", "cancelled", "refunded"]);
const EXPECTED_KIND: Record<CrmStageKey, CrmStageKind> = {
  new_inquiry: "process",
  assigned: "process",
  contacted: "process",
  quoted: "process",
  payment_pending: "process",
  paid_awaiting_supplier: "process",
  confirmed_tickets_pending: "process",
  fulfilled: "success",
  lost: "failure",
  spam: "failure",
  cancelled: "failure",
  refunded: "failure",
};
const CLOSED_INQUIRY = new Set(["won", "lost", "spam"]);

/* ---------------------------------------------------------------- store */

export const CRM_FINDING_KINDS = [
  "crm_unlinked_deal",
  "crm_orphan_deal",
  "crm_foreign_environment_deal",
  "crm_deleted_deal_reappeared",
  "crm_deal_not_visible",
  "crm_twin",
  "crm_stage_tamper",
  "crm_field_tamper",
  "crm_putback_loop",
  "crm_unknown_stage",
  "crm_owner_unmapped",
  "crm_owner_change_refused",
  "crm_portal_fingerprint_mismatch",
  "crm_service_account_is_admin",
  "crm_fingerprint_unverified",
  "crm_staff_map_invalid",
  "crm_return_config_invalid",
  "crm_poll_stuck",
] as const;
export type CrmFindingKind = (typeof CRM_FINDING_KINDS)[number];

export interface CrmFindingInput {
  kind: CrmFindingKind;
  /** `deal:<id>`, `inquiry:<id>`, `order:<id>` or `portal`. */
  subjectKey: string;
  crmId?: number | null;
  linkId?: string | null;
  /** Codes only. */
  detail?: string | null;
  /** Raise the alert only from the second occurrence (within `TAMPER_WINDOW_MS`). */
  alertOnRepeat?: boolean;
}

export type CrmFingerprintState = "ok" | "mismatch" | "admin" | "unreadable";

export interface CrmReturnPortalState {
  reconcileCursor: Date | null;
  reconcileCheckedAt: Date | null;
  fingerprintHash: string | null;
  fingerprintState: CrmFingerprintState | null;
  fingerprintCheckedAt: Date | null;
  fingerprintOkAt: Date | null;
  sweepCursorId: number | null;
  sweepStartedAt: Date | null;
  sweepCompletedAt: Date | null;
  driftCursorLinkId: string | null;
}

export interface CrmReturnLinkState {
  crmSeenUpdatedAt: Date | null;
  crmSeenStageId: string | null;
  crmSeenOwnerId: number | null;
  revertCount: number;
  lastRevertAt: Date | null;
  prevRevertAt: Date | null;
  lastRevertCommentAt: Date | null;
  lastFieldRestoreAt: Date | null;
  holdUntil: Date | null;
  missingSince: Date | null;
}

export type CrmReturnLink = CrmLinkRow & CrmReturnLinkState;
export type CrmReturnLinkPatch = Partial<CrmReturnLinkState> & { crmId?: bigint; twinFlaggedAt?: Date };

export interface CrmTwinFinding {
  id: string;
  /** The extra deal. */
  crmId: number;
  linkId: string | null;
  commentState: string | null;
  /** The link the twin carries the origin id of, as it is now. */
  link: { id: string; entityType: CrmEntityType; entityId: string; crmId: number | null; state: string; twinFlaggedAt: Date | null } | null;
}

export type CrmTwinCommentFinish = { status: "posted"; crmCommentId: number; at: Date } | { status: "pending" | "unknown" | "failed" | "dropped"; code: string };

export interface CrmReturnStore {
  returnPortal(scope: CrmScope): Promise<CrmReturnPortalState>;
  setReturnPortal(scope: CrmScope, patch: Partial<CrmReturnPortalState>): Promise<void>;
  /** The link of this deal id in this scope, any state, with the return columns. No lock. */
  returnLinkByCrmId(scope: CrmScope, crmId: number): Promise<CrmReturnLink | null>;
  /** Links of these origin ids in this scope, with the return columns. No lock. */
  returnLinksByOrigin(scope: CrmScope, originIds: string[]): Promise<CrmReturnLink[]>;
  /** Fenced by the link lock (`lockLink`) like `updateLink`. */
  updateReturnLink(linkId: string, holder: string, patch: CrmReturnLinkPatch): Promise<void>;
  /**
   * Queue a normal push of the locked link: `local_version` + 1 and a sync row at that version (the same row
   * crm.outbox.ts writes), and with `clearHash` the pushed hash cleared so the push is not skipped as
   * unchanged. Fenced by the link lock. False when nothing was queued (lock lost, tombstone).
   */
  queuePush(scope: CrmScope, linkId: string, holder: string, opts: { clearHash: boolean }): Promise<boolean>;
  /** The sweep saw these links' deals: `sweep_seen_at` = at, `missing_since` cleared. */
  markSweepSeen(linkIds: string[], at: Date): Promise<void>;
  /** Active links with a deal id the sweep did not see since `startedAt`; `missing_since` set where empty. */
  finishSweep(scope: CrmScope, startedAt: Date, now: Date): Promise<CrmReturnLink[]>;
  /** Active links with a deal id and no push pending, by link id after `afterLinkId`. */
  driftCandidates(scope: CrmScope, afterLinkId: string | null, limit: number): Promise<CrmLinkRow[]>;
  /**
   * Upsert one finding per (scope, kind, subject). A new one is raised now (or, with `alertOnRepeat`, at its
   * second occurrence within 24 hours); a known one is raised again only when last seen more than 24 hours ago.
   */
  raiseFinding(scope: CrmScope, f: CrmFindingInput, now: Date): Promise<void>;
  /** Twin findings seen since `since`. */
  twinFindingsSince(scope: CrmScope, since: Date): Promise<CrmTwinFinding[]>;
  dropFinding(id: string): Promise<void>;
  /** Mark a twin finding's comment due ("Duplicate of deal `refCrmId`"), only when it has none yet. */
  setTwinComment(id: string, refCrmId: number): Promise<void>;
  /** Claim (as `posting`) up to `limit` due twin comments; `posting` older than `staleBefore` become `unknown`. */
  claimTwinComments(scope: CrmScope, holder: string, now: Date, opts: { limit: number; staleBefore: Date }): Promise<{ id: string; crmId: number; refCrmId: number }[]>;
  finishTwinComment(id: string, holder: string, r: CrmTwinCommentFinish): Promise<void>;
}

/* ---------------------------------------------------------------- commands */

/** "Via Bitrix24" on the inquiry event and the audit row. */
export interface CrmVia {
  channel: "bitrix24";
  bitrixUserId: number | null;
  dealId: number;
}

export type CrmCommandResult = { ok: true } | { ok: false; code: string };

export interface CrmReturnInquiry {
  status: string;
  assignedAgentId: string | null;
  hasOrder: boolean;
}

/** An OUTLYY staff actor, opaque here (built by crm.return.commands.ts from the staff record). */
export type CrmStaffActor = { readonly staffId: string; readonly __actor: unknown };

/**
 * The only ways the return path changes OUTLYY state (doc 29e §3.7). Implemented by crm.return.commands.ts with
 * the inquiry service's `transition` and `assign` and the audit helper; nothing else.
 */
export interface CrmReturnCommands {
  inquiry(id: string): Promise<CrmReturnInquiry | null>;
  /** The staff member as their own OUTLYY actor; null when missing, inactive or without two-factor. */
  staff(staffId: string): Promise<CrmStaffActor | null>;
  /** Which of these ids are staff records at all (any status). */
  existingStaff(ids: string[]): Promise<Set<string>>;
  transition(actor: CrmStaffActor, inquiryId: string, to: string, via: CrmVia, opts: { reason?: string }): Promise<CrmCommandResult>;
  /** `system`: OUTLYY's own default-owner rule (owner answer 8). */
  assign(actor: CrmStaffActor | "system", inquiryId: string, agentId: string, via: CrmVia, note: string): Promise<CrmCommandResult>;
  /** Audit row `crm.stage_reverted` / `crm.fields_restored` (system actor) and, for an inquiry, a `system` event. */
  recordPutBack(subject: CrmSubject, info: { what: "stage" | "fields"; dealId: number; bitrixUserId: number | null; from?: string | null; to?: string | null; fields?: string[] }): Promise<void>;
}

/* ---------------------------------------------------------------- deps */

export type CrmReturnEvent =
  | "crm.return_poll"
  | "crm.return_deal"
  | "crm.return_skipped"
  | "crm.return_failed"
  | "crm.fingerprint"
  | "crm.sweep_done"
  | "crm.twin_comment";

export interface CrmReturnDeps {
  config: CrmConfig;
  ret: CrmReturnConfig;
  store: CrmStore & CrmReturnStore;
  port: CrmPort & CrmReturnPort;
  commands: CrmReturnCommands;
  loadState: (subject: CrmSubject) => Promise<CrmSubjectState>;
  /** The run's own limiter (shared with the outbox). */
  limiter: CrmLimiter;
  now: () => Date;
  emit?: (name: CrmReturnEvent, fields: Record<string, unknown>, level?: "info" | "warn" | "error") => void;
}

class ReturnBudget extends Error {}

/** At most `max` calls from the run's limiter. */
function capped(limiter: CrmLimiter, max: number): () => Promise<void> {
  let used = 0;
  return async () => {
    if (used >= max || !(await limiter.take())) throw new ReturnBudget();
    used += 1;
  };
}

const bump = (c: Record<string, number>, k: string, n = 1) => {
  c[k] = (c[k] ?? 0) + n;
};

/** The deal's portal time, or null when it is not a time. */
export function portalTime(raw: string | null): Date | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t) : null;
}

export function isNight(now: Date): boolean {
  const h = now.getUTCHours();
  return NIGHT_START_UTC > NIGHT_END_UTC ? h >= NIGHT_START_UTC || h < NIGHT_END_UTC : h >= NIGHT_START_UTC && h < NIGHT_END_UTC;
}

function dayNumber(d: Date): number {
  return Math.floor(d.getTime() / 86_400_000);
}

function stageKeyOf(config: CrmConfig, stageId: string | null): CrmStageKey | null {
  if (!stageId) return null;
  return CRM_STAGE_KEYS.find((k) => config.stageIds[k] === stageId) ?? null;
}

function subjectKey(s: CrmSubject): string {
  return `${s.type}:${s.id}`;
}

/* ---------------------------------------------------------------- comparison */

/**
 * What differs between the deal as read and what OUTLYY would push now (doc 29e §3.6), by key only: the stage,
 * and the OUTLYY-owned fields (title, amount, currency, originator, origin id, the OUTLYY custom fields but the
 * "as of" time). A custom field the portal did not return is not compared. Values never leave this function.
 */
export function dealDiff(deal: DealSnapshot, mapped: Extract<ReturnType<typeof mapDeal>, { visible: true }>, config: CrmConfig): { stage: boolean; fields: string[] } {
  const f = mapped.fields;
  const fields: string[] = [];
  if (deal.title !== f.title) fields.push("title");
  if (!sameValue(f.opportunity, deal.opportunity)) fields.push("opportunity");
  if (deal.currencyId !== f.currencyId) fields.push("currency");
  if (deal.originatorId !== f.originatorId) fields.push("originator");
  if (deal.originId !== f.originId) fields.push("origin");
  for (const k of CRM_FIELD_KEYS) {
    if (k === "as_of") continue;
    const code = config.fieldCodes[k];
    if (!(code in deal.uf)) continue;
    if (!sameValue(f[code as `UF_CRM_${string}`], deal.uf[code])) fields.push(k satisfies CrmFieldKey);
  }
  return { stage: deal.stageId !== f.stageId, fields };
}

/* ---------------------------------------------------------------- fingerprint */

export interface CrmFingerprintRead {
  hash: string;
  admin: boolean;
  /** Structural refusals: the configured identity is not what the portal shows. */
  problems: string[];
}

/** The three fingerprint reads (doc 29e §7) and their hash. The funnel name is hashed, never logged. */
export async function readCrmFingerprint(port: CrmReturnPort, config: CrmConfig, take: () => Promise<void> = async () => {}): Promise<CrmFingerprintRead> {
  await take();
  const profile = await port.readProfile();
  await take();
  const category = await port.readCategory();
  await take();
  const stages = await port.listStages();
  const problems: string[] = [];
  if (String(profile.userId) !== config.webhookUserId) problems.push("service_account_mismatch");
  if (!category || category.id !== config.categoryId) problems.push("funnel_missing");
  else if (category.entityTypeId !== 2) problems.push("funnel_not_deals");
  const byId = new Map(stages.map((s) => [s.statusId, s.kind]));
  for (const k of CRM_STAGE_KEYS) {
    const kind = byId.get(config.stageIds[k]);
    if (kind === undefined) problems.push(`stage_missing:${k}`);
    else if (kind !== "unknown" && kind !== EXPECTED_KIND[k]) problems.push(`stage_kind:${k}`);
  }
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        v: 1,
        host: config.portal,
        user: profile.userId,
        funnel: config.categoryId,
        name: category?.name ?? null,
        stages: stages.map((s) => `${s.statusId}:${s.kind}`).sort(),
      }),
    )
    .digest("hex");
  return { hash, admin: profile.admin, problems: problems.slice(0, 20) };
}

/**
 * The explicit owner step (doc 29e §15 step 6, and the reset after a mismatch): read the fingerprint now and
 * store it. Refused for an administrator or a structural problem; nothing is stored then.
 */
export async function storeCrmFingerprint(deps: { config: CrmConfig; store: CrmReturnStore; port: CrmReturnPort; now: () => Date }): Promise<{ stored: boolean; reason?: string; hashPrefix: string }> {
  const scope: CrmScope = { environment: deps.config.environment, portal: deps.config.portal };
  const fp = await readCrmFingerprint(deps.port, deps.config);
  if (fp.admin) return { stored: false, reason: "service_account_is_admin", hashPrefix: fp.hash.slice(0, 12) };
  if (fp.problems.length) return { stored: false, reason: fp.problems.join(","), hashPrefix: fp.hash.slice(0, 12) };
  const now = deps.now();
  await deps.store.setReturnPortal(scope, { fingerprintHash: fp.hash, fingerprintState: "ok", fingerprintCheckedAt: now, fingerprintOkAt: now });
  return { stored: true, hashPrefix: fp.hash.slice(0, 12) };
}

/* ---------------------------------------------------------------- hooks */

export function crmReturnHooks(deps: CrmReturnDeps): CrmRunHooks {
  const { config, ret } = deps;
  const scope: CrmScope = { environment: config.environment, portal: config.portal };
  const emit = deps.emit ?? (() => {});
  /** Set by `beforeRows`: whether the return path may act this run. */
  let active = false;
  let accept = ret.accept;
  let counts: Record<string, number> = {};

  return {
    async beforeRows(ctx) {
      counts = {};
      ctx.summary.returnPath = counts;
      active = false;
      accept = ret.accept && ret.mode === "enforce";
      if (ret.mode === "off") return;
      const now = deps.now();

      // G13: the portal fingerprint.
      const fp = await fingerprintStep(deps, scope, now, counts);
      if (fp.refuse) return { refuse: fp.refuse };
      if (!fp.verified && ret.mode === "enforce") {
        emit("crm.return_skipped", { reason: fp.reason ?? "fingerprint_not_stored" }, "warn");
        return;
      }

      // The staff map must name existing staff only (fail closed: no acceptance this run).
      if (accept) {
        const ids = [...ret.staffMap.values()];
        const known = await deps.commands.existingStaff(ids);
        if (ids.some((id) => !known.has(id))) {
          accept = false;
          bump(counts, "staff_map_invalid");
          await deps.store.raiseFinding(scope, { kind: "crm_staff_map_invalid", subjectKey: "portal" }, now);
          emit("crm.return_skipped", { reason: "staff_map_unknown_staff", accept: false }, "error");
        }
      }
      active = true;
      try {
        return await pollStep(deps, scope, ctx, accept, counts);
      } catch (e) {
        bump(counts, "poll_failed");
        emit("crm.return_failed", { step: "poll", reason: e instanceof CrmCallError ? e.code : "internal" }, "warn");
      }
    },

    async afterRows(ctx) {
      if (!active || ret.mode === "off") return;
      if (isNight(deps.now()) && ctx.drained) await sweepStep(deps, scope, ctx, counts);
      if (ret.mode === "enforce") await twinCommentStep(deps, scope, ctx, counts);
    },
  };
}

/* ---------------------------------------------------------------- fingerprint step */

async function fingerprintStep(
  deps: CrmReturnDeps,
  scope: CrmScope,
  now: Date,
  counts: Record<string, number>,
): Promise<{ refuse?: string; verified: boolean; reason?: string }> {
  const { store } = deps;
  const emit = deps.emit ?? (() => {});
  const p = await store.returnPortal(scope);
  if (p.fingerprintState === "mismatch") {
    // Nothing clears it but the owner's explicit store step.
    return { refuse: "portal_fingerprint_mismatch", verified: false };
  }
  const every = p.fingerprintState === "admin" ? FINGERPRINT_ADMIN_RECHECK_MS : FINGERPRINT_EVERY_MS;
  const due = !p.fingerprintCheckedAt || now.getTime() - p.fingerprintCheckedAt.getTime() >= every;
  let state = p.fingerprintState;
  let okAt = p.fingerprintOkAt;
  if (due) {
    try {
      const fp = await readCrmFingerprint(deps.port, deps.config, capped(deps.limiter, FINGERPRINT_CALLS));
      bump(counts, "fingerprint_checks");
      if (fp.admin) {
        await store.setReturnPortal(scope, { fingerprintState: "admin", fingerprintCheckedAt: now });
        await store.raiseFinding(scope, { kind: "crm_service_account_is_admin", subjectKey: "portal" }, now);
        emit("crm.fingerprint", { outcome: "admin" }, "error");
        return { refuse: "service_account_is_admin", verified: false };
      }
      const mismatch = fp.problems.length > 0 || (p.fingerprintHash !== null && p.fingerprintHash !== fp.hash);
      if (mismatch) {
        await store.setReturnPortal(scope, { fingerprintState: "mismatch", fingerprintCheckedAt: now });
        await store.raiseFinding(scope, { kind: "crm_portal_fingerprint_mismatch", subjectKey: "portal", detail: fp.problems.length ? safeDetail(fp.problems.join(",")) : "hash" }, now);
        emit("crm.fingerprint", { outcome: "mismatch", problems: fp.problems.join(".").slice(0, 80) || "hash" }, "error");
        return { refuse: "portal_fingerprint_mismatch", verified: false };
      }
      state = p.fingerprintHash ? "ok" : null;
      okAt = now;
      await store.setReturnPortal(scope, { fingerprintState: state, fingerprintCheckedAt: now, fingerprintOkAt: now });
      // The prefix lets the owner compare with the store step's answer; the inputs are never logged.
      emit("crm.fingerprint", { outcome: p.fingerprintHash ? "ok" : "not_stored", hashPrefix: fp.hash.slice(0, 12) });
    } catch (e) {
      if (e instanceof ReturnBudget) {
        bump(counts, "fingerprint_deferred");
      } else {
        bump(counts, "fingerprint_unreadable");
        state = p.fingerprintState === "admin" ? "admin" : "unreadable";
        await store.setReturnPortal(scope, { fingerprintState: state, fingerprintCheckedAt: now });
        emit("crm.fingerprint", { outcome: "unreadable", reason: e instanceof CrmCallError ? e.code : "internal" }, "warn");
      }
    }
  }
  if (state === "admin") return { refuse: "service_account_is_admin", verified: false };
  if (!p.fingerprintHash) return { verified: false, reason: "fingerprint_not_stored" };
  const fresh = okAt !== null && now.getTime() - okAt.getTime() <= FINGERPRINT_GRACE_MS;
  if (!fresh) {
    await store.raiseFinding(scope, { kind: "crm_fingerprint_unverified", subjectKey: "portal" }, now);
    return { refuse: "fingerprint_unverified", verified: false };
  }
  return { verified: true };
}

/** Event keys are camelCase (structured-events.ts); the counters are snake_case. */
function camel(c: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k.replace(/_([a-z])/g, (_m, x: string) => x.toUpperCase()), v]));
}

function safeDetail(s: string): string {
  return s.replace(/[^A-Za-z0-9_.:,>=-]/g, "_").slice(0, 200) || "none";
}

/* ---------------------------------------------------------------- poll step */

async function pollStep(deps: CrmReturnDeps, scope: CrmScope, ctx: CrmRunContext, accept: boolean, counts: Record<string, number>): Promise<{ paused?: "throttled" } | void> {
  const { store } = deps;
  const emit = deps.emit ?? (() => {});
  const now = deps.now();
  const p = await store.returnPortal(scope);
  const base = p.reconcileCursor ?? new Date(now.getTime() - POLL_FIRST_LOOKBACK_MS);
  const since = new Date(base.getTime() - POLL_OVERLAP_MS);
  const take = capped(deps.limiter, POLL_MAX_CALLS);
  let cursor = p.reconcileCursor;
  let handled = 0;
  let blocked = false;
  let start = 0;
  let stuckPage = false;
  try {
    for (let page = 0; page < POLL_MAX_CALLS && !blocked; page++) {
      await take();
      const res = await deps.port.listChangedDeals({ since, start });
      bump(counts, "polled", res.items.length);
      const items = [...res.items].sort((a, b) => (portalTime(a.updatedTime)?.getTime() ?? 0) - (portalTime(b.updatedTime)?.getTime() ?? 0) || a.id - b.id);
      let moved = false;
      for (const deal of items) {
        if (handled >= POLL_MAX_DEALS || deps.now().getTime() - ctx.started >= ctx.budgetMs) {
          blocked = true;
          break;
        }
        const t = portalTime(deal.updatedTime);
        if (!t) {
          // Not a time: the answer is not what the design reads. Never acted on.
          bump(counts, "no_time");
          continue;
        }
        let r: DealOutcome;
        try {
          r = await handleDeal(deps, scope, ctx.holder, deal, t, accept, counts);
        } catch (e) {
          if (e instanceof ReturnBudget) throw e;
          bump(counts, "deal_failed");
          emit("crm.return_failed", { step: "deal", deal: deal.id, reason: e instanceof CrmCallError ? e.code : "internal" }, "warn");
          r = "done";
        }
        if (r === "retry") {
          blocked = true;
          break;
        }
        // Deals already handled at this time (the overlap) do not count against the per-run cap.
        if (r === "done") handled += 1;
        if (!cursor || t.getTime() > cursor.getTime()) {
          cursor = t;
          moved = true;
        }
      }
      if (!res.more) break;
      if (!moved && !blocked) stuckPage = true;
      start += res.items.length;
    }
  } catch (e) {
    if (e instanceof CrmCallError && e.kind === "throttled") {
      const at = deps.now().getTime();
      await store.setPortalHealth(scope, { pausedUntil: new Date(at + THROTTLE_PAUSE_MS), pauseReason: "throttled" });
      await store.setReturnPortal(scope, { reconcileCursor: cursor, reconcileCheckedAt: now });
      return { paused: "throttled" };
    }
    if (e instanceof CrmCallError && e.kind === "auth") {
      // The outbox meets the same answer and opens the circuit for an hour; nothing more here.
      bump(counts, "poll_auth");
    } else if (!(e instanceof ReturnBudget)) {
      bump(counts, "poll_failed");
      emit("crm.return_failed", { step: "poll", reason: e instanceof CrmCallError ? e.code : "internal" }, "warn");
    }
  }
  if (stuckPage) {
    // A full page with nothing new: the time filter may be ignored by the portal (doc 29e §11).
    await store.raiseFinding(scope, { kind: "crm_poll_stuck", subjectKey: "portal", alertOnRepeat: true }, now);
    emit("crm.return_poll", { warning: "full_page_nothing_new" }, "warn");
  }
  await store.setReturnPortal(scope, { reconcileCursor: cursor, reconcileCheckedAt: now });
  emit("crm.return_poll", { mode: deps.ret.mode, handled, blocked, ...camel(counts) });
}

type DealOutcome = "done" | "seen" | "retry";

/** One changed deal (doc 29e §3.4). The first rule that matches decides. */
async function handleDeal(deps: CrmReturnDeps, scope: CrmScope, holder: string, deal: DealSnapshot, t: Date, accept: boolean, counts: Record<string, number>): Promise<DealOutcome> {
  const { store, config, ret } = deps;
  const emit = deps.emit ?? (() => {});
  const now = deps.now();
  if (deal.categoryId !== config.categoryId) return "done";
  const link = await store.returnLinkByCrmId(scope, deal.id);
  if (!link) {
    await unlinkedDeal(deps, scope, deal, counts);
    return "done";
  }
  if (link.crmSeenUpdatedAt && t.getTime() <= link.crmSeenUpdatedAt.getTime()) {
    bump(counts, "seen");
    return "seen";
  }
  const subject: CrmSubject = { type: link.entityType, id: link.entityId };
  if (link.state === "deleted") {
    // Erased, expired or deleted on the portal, and visible again: alert only (owner answer 12).
    await store.raiseFinding(scope, { kind: "crm_deleted_deal_reappeared", subjectKey: `deal:${deal.id}`, crmId: deal.id, linkId: link.id }, now);
    bump(counts, "reappeared");
    return "done";
  }
  if (link.state !== "active") return "done";
  const lock = await store.lockLink(scope, subject, holder, now, new Date(now.getTime() + ROW_LOCK_MS));
  if (lock.kind === "busy") {
    bump(counts, "busy");
    return "retry";
  }
  if (lock.kind === "missing") return "done";
  const l: CrmReturnLink = { ...link, ...lock.link };
  try {
    if (l.localVersion > l.pushedVersion) {
      // A push is about to write OUTLYY's state: it wins (doc 29e §3.4 rule 4).
      bump(counts, "push_pending");
      return "done";
    }
    let state = await deps.loadState(subject);
    let mapped = mapDeal(state, config, { now });
    if (!mapped.visible) {
      bump(counts, "not_visible_locally");
      return "done";
    }
    const seen: CrmReturnLinkPatch = { crmSeenUpdatedAt: t, crmSeenStageId: deal.stageId && /^[A-Za-z0-9_:-]{1,60}$/.test(deal.stageId) ? deal.stageId : null, crmSeenOwnerId: deal.assignedById && deal.assignedById > 0 ? deal.assignedById : null };
    const ownerBase = l.crmSeenOwnerId ?? config.defaultOwnerId;
    const ownerChanged = deal.assignedById !== null && deal.assignedById > 0 && deal.assignedById !== ownerBase;
    let diff = dealDiff(deal, mapped, config);
    const service = deal.updatedBy !== null && String(deal.updatedBy) === config.webhookUserId;
    if (!diff.stage && !diff.fields.length && !ownerChanged) {
      // Own echo, or staff changed something they own (a note, a follow-up date).
      bump(counts, service ? "echo" : "staff_owned");
      await store.updateReturnLink(l.id, holder, seen);
      return "done";
    }
    const log = (action: string, extra: Record<string, unknown> = {}) =>
      emit("crm.return_deal", { mode: ret.mode, deal: deal.id, entityType: subject.type, entityId: subject.id, action, bitrixUser: deal.updatedBy, ...extra });
    const via = (user: number | null): CrmVia => ({ channel: "bitrix24", bitrixUserId: user, dealId: deal.id });

    // Owner change (Bitrix24 → OUTLYY only, owner answer 7). OUTLYY never writes the deal owner after create.
    if (ownerChanged) {
      const changed = await ownerRule(deps, scope, l, subject, deal, accept, counts, log, via);
      if (changed) {
        state = await deps.loadState(subject);
        mapped = mapDeal(state, config, { now });
        if (!mapped.visible) {
          await store.updateReturnLink(l.id, holder, seen);
          return "done";
        }
        diff = dealDiff(deal, mapped, config);
      }
    }

    let putBack: { what: "stage" | "fields"; note: CrmReturnNoteKind | null; from: string | null; to: string | null } | null = null;
    if (diff.stage) {
      const P = stageKeyOf(config, deal.stageId);
      const E = mapped.stage;
      if (P === null) {
        await store.raiseFinding(scope, { kind: "crm_unknown_stage", subjectKey: `deal:${deal.id}`, crmId: deal.id, linkId: l.id, detail: deal.stageId ? safeDetail(deal.stageId) : null }, now);
        putBack = { what: "stage", note: "stage_reverted", from: E, to: "unknown" };
      } else {
        const accepted = await stageRule(deps, subject, state, deal, P, accept, counts, log, via);
        if (!accepted) putBack = { what: "stage", note: INTEGRATION_ONLY.has(P) ? "stage_reverted" : "move_refused", from: E, to: P };
        else {
          // The service queued its own push; the fields follow with it.
          diff = { stage: false, fields: [] };
        }
      }
    }
    if (!putBack && diff.fields.length) putBack = { what: "fields", note: null, from: null, to: null };

    if (putBack) {
      if (ret.mode !== "enforce") {
        bump(counts, putBack.what === "stage" ? "would_put_back_stage" : "would_restore_fields");
        log(putBack.what === "stage" ? "would_put_back_stage" : "would_restore_fields", { from: putBack.from, to: putBack.to, fields: diff.fields.join(":").slice(0, 80) || null });
      } else {
        await doPutBack(deps, scope, holder, l, subject, deal, putBack, diff.fields, seen, counts, log);
      }
    }
    await store.updateReturnLink(l.id, holder, seen);
    return "done";
  } finally {
    await store.unlockLink(l.id, holder);
  }
}

async function unlinkedDeal(deps: CrmReturnDeps, scope: CrmScope, deal: DealSnapshot, counts: Record<string, number>): Promise<void> {
  const { store, config } = deps;
  const now = deps.now();
  const key = `deal:${deal.id}`;
  if (deal.originatorId === config.originatorId) {
    const [link] = deal.originId ? await store.returnLinksByOrigin(scope, [deal.originId]) : [];
    if (link && link.crmId !== null && Number(link.crmId) !== deal.id) {
      await store.raiseFinding(scope, { kind: "crm_twin", subjectKey: key, crmId: deal.id, linkId: link.id, detail: `keep=${link.crmId}` }, now);
      bump(counts, "twin");
    } else if (link && link.crmId === null) {
      // A create whose answer was lost: the worker's search before its next create adopts it.
      bump(counts, "create_in_flight");
    } else if (!link) {
      await store.raiseFinding(scope, { kind: "crm_orphan_deal", subjectKey: key, crmId: deal.id }, now);
      bump(counts, "orphan");
    }
    return;
  }
  if (deal.originatorId && /^outlyy-(development|staging|production)$/.test(deal.originatorId)) {
    await store.raiseFinding(scope, { kind: "crm_foreign_environment_deal", subjectKey: key, crmId: deal.id, detail: deal.originatorId }, now);
    bump(counts, "foreign");
    return;
  }
  await store.raiseFinding(scope, { kind: "crm_unlinked_deal", subjectKey: key, crmId: deal.id }, now);
  bump(counts, "unlinked");
}

type Log = (action: string, extra?: Record<string, unknown>) => void;

/** A sales move by a mapped staff member, through the inquiry service as that person (doc 29e §3.5). */
async function stageRule(
  deps: CrmReturnDeps,
  subject: CrmSubject,
  state: CrmSubjectState,
  deal: DealSnapshot,
  P: CrmStageKey,
  accept: boolean,
  counts: Record<string, number>,
  log: Log,
  via: (u: number | null) => CrmVia,
): Promise<boolean> {
  const { ret, commands, config } = deps;
  const sales = P === "assigned" || SALES_TARGET[P] !== undefined;
  if (!sales || subject.type !== "inquiry" || !state.inquiry || state.order) return false;
  // Who moved it: `movedBy` when the portal returns it, else the last editor (doc 29e §14 fact 2).
  const mover = deal.movedBy ?? deal.updatedBy;
  if (ret.mode !== "enforce") {
    bump(counts, "would_accept_check");
    log("would_check_move", { to: P, mover });
    return false;
  }
  if (!accept) return false;
  if (mover === null || String(mover) === config.webhookUserId) return refused("mover_unknown");
  const staffId = ret.staffMap.get(mover);
  if (!staffId) return refused("mover_unmapped");
  const actor = await commands.staff(staffId);
  if (!actor) return refused("mover_inactive");
  let r: CrmCommandResult;
  if (P === "assigned") {
    // "Assigned" is an assignment, not a status: only for a new inquiry whose deal owner is a mapped agent.
    const ownerStaff = deal.assignedById ? ret.staffMap.get(deal.assignedById) : undefined;
    if (state.inquiry.status !== "new" || !ownerStaff || !(await commands.staff(ownerStaff))) return refused("assigned_without_owner");
    r = await commands.assign(actor, subject.id, ownerStaff, via(mover), "Assigned in Bitrix24");
  } else {
    const to = SALES_TARGET[P]!;
    // Owner answer 5: a deal dragged to Lost has no reason code on the portal; it is accepted as "other".
    r = await commands.transition(actor, subject.id, to, via(mover), { reason: to === "lost" ? "other" : undefined });
  }
  if (!r.ok) return refused(r.code);
  bump(counts, "accepted");
  log("accepted_move", { to: P, mover });
  return true;

  function refused(code: string): false {
    bump(counts, "move_refused");
    log("move_refused", { to: P, mover, refusal: code });
    return false;
  }
}

/**
 * A Bitrix24 owner change (owner answers 7 and 8): a mapped active staff member becomes the inquiry's agent,
 * on the authority of the staff member who changed it; an owner who is not mapped gives the inquiry to OUTLYY's
 * default owner (the Dubai sales lead) with a fixed deal note. The deal owner is never written back.
 * Returns whether OUTLYY state changed.
 */
async function ownerRule(
  deps: CrmReturnDeps,
  scope: CrmScope,
  l: CrmReturnLink,
  subject: CrmSubject,
  deal: DealSnapshot,
  accept: boolean,
  counts: Record<string, number>,
  log: Log,
  via: (u: number | null) => CrmVia,
): Promise<boolean> {
  const { ret, commands, config, store } = deps;
  const now = deps.now();
  const owner = deal.assignedById as number;
  if (ret.mode !== "enforce" || !accept) {
    bump(counts, ret.mode === "enforce" ? "owner_recorded" : "would_assign");
    log(ret.mode === "enforce" ? "owner_recorded" : "would_assign", { owner });
    return false;
  }
  // A direct-checkout order has no agent: the owner is only recorded.
  if (subject.type !== "inquiry") {
    bump(counts, "owner_recorded");
    return false;
  }
  const inquiry = await commands.inquiry(subject.id);
  if (!inquiry || CLOSED_INQUIRY.has(inquiry.status)) {
    bump(counts, "owner_recorded");
    return false;
  }
  const mapped = ret.staffMap.get(owner);
  const target = mapped ? await commands.staff(mapped) : null;
  if (mapped && target) {
    if (inquiry.assignedAgentId === mapped) {
      bump(counts, "owner_recorded");
      return false;
    }
    const editor = deal.updatedBy;
    const editorStaff = editor !== null && String(editor) !== config.webhookUserId ? ret.staffMap.get(editor) : undefined;
    const actor = editorStaff ? await commands.staff(editorStaff) : null;
    if (!actor) {
      await store.raiseFinding(scope, { kind: "crm_owner_change_refused", subjectKey: subjectKey(subject), crmId: deal.id, linkId: l.id, detail: editorStaff ? "editor_inactive" : "editor_unmapped" }, now);
      bump(counts, "owner_refused");
      log("owner_refused", { owner, refusal: editorStaff ? "editor_inactive" : "editor_unmapped" });
      return false;
    }
    const r = await commands.assign(actor, subject.id, mapped, via(editor), "Reassigned in Bitrix24");
    if (!r.ok) {
      await store.raiseFinding(scope, { kind: "crm_owner_change_refused", subjectKey: subjectKey(subject), crmId: deal.id, linkId: l.id, detail: safeDetail(r.code) }, now);
      bump(counts, "owner_refused");
      log("owner_refused", { owner, refusal: r.code });
      return false;
    }
    bump(counts, "assigned");
    log("assigned", { owner });
    return true;
  }
  // Not mapped, or mapped but inactive / without two-factor (counts as unknown): OUTLYY's default owner.
  const fallback = ret.staffMap.get(config.defaultOwnerId);
  const fallbackActor = fallback ? await commands.staff(fallback) : null;
  await store.raiseFinding(scope, { kind: "crm_owner_unmapped", subjectKey: subjectKey(subject), crmId: deal.id, linkId: l.id, detail: `user=${owner}`, alertOnRepeat: true }, now);
  if (!fallback || !fallbackActor) {
    bump(counts, "owner_refused");
    log("owner_unmapped_no_default", { owner });
    return false;
  }
  let changed = false;
  if (inquiry.assignedAgentId !== fallback) {
    const r = await commands.assign("system", subject.id, fallback, via(deal.updatedBy), "The Bitrix24 owner is not an OUTLYY staff member: assigned to the default owner");
    changed = r.ok;
    if (!r.ok) log("owner_default_refused", { owner, refusal: r.code });
  }
  await store.recordTimelineMoments(l.id, [{ key: `owner_unmapped:${dayNumber(now)}`, kind: "owner_unmapped", amountAedMinor: null }], now);
  bump(counts, "owner_unmapped");
  log("owner_unmapped", { owner, assigned: changed });
  return changed;
}

/** Put OUTLYY's stage and fields back (doc 29e §3.5, §3.6): a normal push, counted, with loop protection. */
async function doPutBack(
  deps: CrmReturnDeps,
  scope: CrmScope,
  holder: string,
  l: CrmReturnLink,
  subject: CrmSubject,
  deal: DealSnapshot,
  p: { what: "stage" | "fields"; note: CrmReturnNoteKind | null; from: string | null; to: string | null },
  fields: string[],
  seen: CrmReturnLinkPatch,
  counts: Record<string, number>,
  log: Log,
): Promise<void> {
  const { store } = deps;
  const now = deps.now();
  const at = now.getTime();
  if (l.holdUntil && l.holdUntil.getTime() > at) {
    // A put-back loop: no more forced pushes until the hold ends. Ordinary pushes still run.
    bump(counts, "held");
    log("held", { what: p.what });
    return;
  }
  if (!(await store.queuePush(scope, l.id, holder, { clearHash: true }))) {
    bump(counts, "put_back_lost");
    return;
  }
  const mover = deal.movedBy ?? deal.updatedBy;
  const second = l.lastRevertAt !== null && at - l.lastRevertAt.getTime() <= TAMPER_WINDOW_MS;
  const third = second && l.prevRevertAt !== null && at - l.prevRevertAt.getTime() <= LOOP_WINDOW_MS;
  Object.assign(seen, { revertCount: (l.revertCount ?? 0) + 1, prevRevertAt: l.lastRevertAt, lastRevertAt: now } satisfies CrmReturnLinkPatch);
  const entity = { subjectKey: subjectKey(subject), crmId: deal.id, linkId: l.id };
  if (third) {
    seen.holdUntil = new Date(at + HOLD_MS);
    await store.raiseFinding(scope, { kind: "crm_putback_loop", ...entity }, now);
    bump(counts, "loop_hold");
  } else if (second && p.what === "stage") {
    await store.raiseFinding(scope, { kind: "crm_stage_tamper", ...entity, detail: p.from && p.to ? `${p.from}>${p.to}` : null }, now);
  }
  if (fields.length && l.lastFieldRestoreAt !== null && at - l.lastFieldRestoreAt.getTime() <= TAMPER_WINDOW_MS && !third) {
    await store.raiseFinding(scope, { kind: "crm_field_tamper", ...entity, detail: safeDetail(fields.join(",")) }, now);
  }
  if (fields.length) seen.lastFieldRestoreAt = now;
  if (p.what === "stage" && p.note && (l.lastRevertCommentAt === null || at - l.lastRevertCommentAt.getTime() > COMMENT_EVERY_MS)) {
    // One fixed note a day per deal, through the C2b comment queue (posted after its quiet period).
    await store.recordTimelineMoments(l.id, [{ key: `${p.note}:${dayNumber(now)}`, kind: p.note, amountAedMinor: null }], now);
    seen.lastRevertCommentAt = now;
  }
  await deps.commands.recordPutBack(subject, { what: p.what, dealId: deal.id, bitrixUserId: mover, from: p.from, to: p.to, fields });
  bump(counts, p.what === "stage" ? "put_back_stage" : "restored_fields");
  log(p.what === "stage" ? "put_back_stage" : "restored_fields", { from: p.from, to: p.to, fields: fields.join(":").slice(0, 80) || null, hold: Boolean(third) });
}

/* ---------------------------------------------------------------- sweep (G15) */

async function sweepStep(deps: CrmReturnDeps, scope: CrmScope, ctx: CrmRunContext, counts: Record<string, number>): Promise<void> {
  const { store, config, ret } = deps;
  const emit = deps.emit ?? (() => {});
  const now = deps.now();
  let p = await store.returnPortal(scope);
  const idle = !p.sweepStartedAt || (p.sweepCompletedAt !== null && p.sweepCompletedAt.getTime() >= p.sweepStartedAt.getTime());
  if (idle && (!p.sweepStartedAt || now.getTime() - p.sweepStartedAt.getTime() >= SWEEP_EVERY_MS)) {
    await store.setReturnPortal(scope, { sweepStartedAt: now, sweepCursorId: 0, sweepCompletedAt: null, driftCursorLinkId: null });
    p = { ...p, sweepStartedAt: now, sweepCursorId: 0, sweepCompletedAt: null, driftCursorLinkId: null };
  }
  const startedAt = p.sweepStartedAt;
  if (!startedAt) return;
  const listing = p.sweepCompletedAt === null || p.sweepCompletedAt.getTime() < startedAt.getTime();
  const left = () => deps.now().getTime() - ctx.started < ctx.budgetMs;

  if (listing) {
    const take = capped(deps.limiter, SWEEP_MAX_CALLS);
    let cursor = p.sweepCursorId ?? 0;
    let complete = false;
    try {
      while (left()) {
        await take();
        const page = await deps.port.listFunnelDeals(cursor);
        bump(counts, "sweep_listed", page.items.length);
        const ours = page.items.filter((d) => d.originatorId === config.originatorId && d.originId);
        const links = ours.length ? await store.returnLinksByOrigin(scope, [...new Set(ours.map((d) => d.originId as string))]) : [];
        const byOrigin = new Map(links.map((x) => [x.originId, x]));
        const seen: string[] = [];
        for (const d of page.items) {
          const key = `deal:${d.id}`;
          if (d.originatorId === config.originatorId) {
            const link = d.originId ? byOrigin.get(d.originId) : undefined;
            if (!link) await store.raiseFinding(scope, { kind: "crm_orphan_deal", subjectKey: key, crmId: d.id }, now);
            else if (link.state === "deleted") await store.raiseFinding(scope, { kind: "crm_deleted_deal_reappeared", subjectKey: key, crmId: d.id, linkId: link.id }, now);
            else if (link.crmId !== null && Number(link.crmId) === d.id) seen.push(link.id);
            else if (link.crmId !== null) {
              await store.raiseFinding(scope, { kind: "crm_twin", subjectKey: key, crmId: d.id, linkId: link.id, detail: `keep=${link.crmId}` }, now);
              bump(counts, "twin");
            }
          } else if (d.originatorId && /^outlyy-(development|staging|production)$/.test(d.originatorId)) {
            await store.raiseFinding(scope, { kind: "crm_foreign_environment_deal", subjectKey: key, crmId: d.id, detail: d.originatorId }, now);
          } else {
            await store.raiseFinding(scope, { kind: "crm_unlinked_deal", subjectKey: key, crmId: d.id }, now);
          }
          cursor = Math.max(cursor, d.id);
        }
        if (seen.length) await store.markSweepSeen(seen, now);
        await store.setReturnPortal(scope, { sweepCursorId: cursor });
        if (!page.more) {
          complete = true;
          break;
        }
      }
    } catch (e) {
      if (!(e instanceof ReturnBudget)) {
        bump(counts, "sweep_failed");
        emit("crm.return_failed", { step: "sweep", reason: e instanceof CrmCallError ? e.code : "internal" }, "warn");
      }
    }
    if (!complete) return;
    await completeSweep(deps, scope, ctx.holder, startedAt, counts);
    await store.setReturnPortal(scope, { sweepCompletedAt: deps.now() });
    emit("crm.sweep_done", { mode: ret.mode, listed: counts.sweep_listed ?? 0, twins: counts.twin ?? 0, notVisible: counts.not_visible ?? 0 });
    return;
  }

  // Step 2: drift without any CRM call (a lost enqueue, doc 29e §3.6).
  if (p.driftCursorLinkId === DRIFT_DONE || !left()) return;
  const candidates = await store.driftCandidates(scope, p.driftCursorLinkId, DRIFT_PER_RUN);
  let last = p.driftCursorLinkId;
  for (const link of candidates) {
    if (!left()) break;
    last = link.id;
    const state = await deps.loadState({ type: link.entityType, id: link.entityId });
    const mapped = mapDeal(state, config, { now });
    if (!mapped.visible || mapped.hash === link.pushedHash) continue;
    bump(counts, "drift");
    if (ret.mode !== "enforce") {
      emit("crm.return_deal", { mode: ret.mode, entityType: link.entityType, entityId: link.entityId, action: "would_push_drift" });
      continue;
    }
    const subject: CrmSubject = { type: link.entityType, id: link.entityId };
    const lock = await store.lockLink(scope, subject, ctx.holder, now, new Date(now.getTime() + ROW_LOCK_MS));
    if (lock.kind !== "locked") continue;
    try {
      if (lock.link.localVersion === lock.link.pushedVersion) await store.queuePush(scope, lock.link.id, ctx.holder, { clearHash: false });
    } finally {
      await store.unlockLink(lock.link.id, ctx.holder);
    }
    emit("crm.return_deal", { mode: ret.mode, entityType: link.entityType, entityId: link.entityId, action: "push_drift" });
  }
  const done = candidates.length < DRIFT_PER_RUN && last === (candidates.at(-1)?.id ?? last);
  await store.setReturnPortal(scope, { driftCursorLinkId: done ? DRIFT_DONE : last });
}

/**
 * End of a listing: links whose deal was not seen are "not visible" (moved to another funnel or deleted on the
 * portal), alerted now; a missing link with twins found keeps the oldest twin and is linked to it (enforce);
 * every other twin gets its one fixed comment queued, naming the deal OUTLYY keeps.
 */
async function completeSweep(deps: CrmReturnDeps, scope: CrmScope, holder: string, startedAt: Date, counts: Record<string, number>): Promise<void> {
  const { store, ret } = deps;
  const now = deps.now();
  const missing = await store.finishSweep(scope, startedAt, now);
  const twins = await store.twinFindingsSince(scope, startedAt);
  const keep = new Map<string, number>();
  for (const link of missing) {
    const own = twins.filter((t) => t.linkId === link.id && t.crmId !== Number(link.crmId)).sort((a, b) => a.crmId - b.crmId);
    if (own.length && ret.mode === "enforce") {
      // The link points at none of the copies: keep the oldest and link it (doc 29e §8).
      const kept = own[0];
      const lock = await store.lockLink(scope, { type: link.entityType, id: link.entityId }, holder, now, new Date(now.getTime() + ROW_LOCK_MS));
      if (lock.kind === "locked") {
        try {
          await store.updateReturnLink(link.id, holder, { crmId: BigInt(kept.crmId), missingSince: null, twinFlaggedAt: link.twinFlaggedAt ?? now });
          await store.queuePush(scope, link.id, holder, { clearHash: true });
        } finally {
          await store.unlockLink(link.id, holder);
        }
        await store.dropFinding(kept.id);
        keep.set(link.id, kept.crmId);
        bump(counts, "relinked");
        continue;
      }
    }
    await store.raiseFinding(scope, { kind: "crm_deal_not_visible", subjectKey: `${link.entityType}:${link.entityId}`, crmId: link.crmId === null ? null : Number(link.crmId), linkId: link.id }, now);
    bump(counts, "not_visible");
  }
  if (ret.mode !== "enforce") return;
  const flagged = new Set<string>();
  for (const t of twins) {
    if (!t.link || keep.get(t.link.id) === t.crmId) continue;
    const ref = keep.get(t.link.id) ?? t.link.crmId;
    if (ref === null || ref === t.crmId || t.link.state === "deleted") continue;
    await store.setTwinComment(t.id, ref);
    if (!t.link.twinFlaggedAt && !flagged.has(t.link.id)) {
      // Flag the link so admin and the C2 worker see the twin (crm_links.twin_flagged_at).
      flagged.add(t.link.id);
      const lock = await store.lockLink(scope, { type: t.link.entityType, id: t.link.entityId }, holder, now, new Date(now.getTime() + ROW_LOCK_MS));
      if (lock.kind === "locked") {
        try {
          await store.updateReturnLink(t.link.id, holder, { twinFlaggedAt: now });
        } finally {
          await store.unlockLink(t.link.id, holder);
        }
      }
    }
  }
}

/* ---------------------------------------------------------------- twin comments */

export function twinCommentText(keptDealId: number): string {
  return `OUTLYY: Duplicate of deal ${keptDealId} — safe to delete. Move any notes to deal ${keptDealId} first.`;
}

const TWIN_TEXT = /^OUTLYY: Duplicate of deal (\d{1,12}) — safe to delete\. Move any notes to deal \1 first\.$/;

/** The last check before the twin comment: exactly the fixed sentence with one deal id. */
export function assertSafeTwinText(text: string): void {
  if (!TWIN_TEXT.test(text)) throw new CrmCallError("refused", "crm.timeline.comment.add", { code: "twin_text" });
}

async function twinCommentStep(deps: CrmReturnDeps, scope: CrmScope, ctx: CrmRunContext, counts: Record<string, number>): Promise<void> {
  const { store } = deps;
  const emit = deps.emit ?? (() => {});
  const now = deps.now();
  if (now.getTime() - ctx.started >= ctx.budgetMs) return;
  const due = await store.claimTwinComments(scope, ctx.holder, now, { limit: TWIN_COMMENTS_PER_RUN, staleBefore: new Date(now.getTime() - ROW_LOCK_MS) });
  const take = capped(deps.limiter, TWIN_COMMENTS_PER_RUN);
  let stop: string | null = null;
  for (const c of due) {
    if (stop) {
      await store.finishTwinComment(c.id, ctx.holder, { status: "pending", code: stop });
      continue;
    }
    const text = twinCommentText(c.refCrmId);
    try {
      assertSafeTwinText(text);
      await take();
      const { id } = await deps.port.addTimelineComment(c.crmId, text);
      await store.finishTwinComment(c.id, ctx.holder, { status: "posted", crmCommentId: id, at: deps.now() });
      bump(counts, "twin_comments");
      emit("crm.twin_comment", { deal: c.crmId, keep: c.refCrmId, outcome: "posted" });
    } catch (e) {
      if (e instanceof ReturnBudget) {
        stop = "budget";
        await store.finishTwinComment(c.id, ctx.holder, { status: "pending", code: "budget" });
        continue;
      }
      const err = e instanceof CrmCallError ? e : new CrmCallError("rejected", "worker", { code: "internal" });
      if (err.kind === "throttled" || err.kind === "auth") {
        stop = err.code;
        await store.finishTwinComment(c.id, ctx.holder, { status: "pending", code: err.code });
      } else if (err.kind === "not_found") {
        await store.finishTwinComment(c.id, ctx.holder, { status: "dropped", code: err.code });
      } else if (err.writeMayHaveHappened) {
        // Never posted twice (no idempotency key on the portal).
        await store.finishTwinComment(c.id, ctx.holder, { status: "unknown", code: err.code });
      } else {
        await store.finishTwinComment(c.id, ctx.holder, { status: "failed", code: err.code });
      }
      emit("crm.twin_comment", { deal: c.crmId, outcome: err.code }, "warn");
    }
  }
}

export type { CrmEntityType };
