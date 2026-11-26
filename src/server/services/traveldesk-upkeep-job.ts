import "server-only";
import type { SupplierEnvironment } from "@prisma/client";
import { SYSTEM_ACTOR } from "../lib/actor";
import { audit } from "../lib/audit";
import { prisma } from "../lib/db";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { settingsRepo } from "../repositories/settings.repo";
import { traveldeskConfigFrom, type TravelDeskConfig } from "../suppliers/traveldesk/traveldesk.config";
import { TRAVELDESK_SUPPLIER_CODE } from "./supplier-catalog.service";
import { catalogueSyncLeaseKey, releaseLease, takeLease } from "./traveldesk-catalogue-sync.service";
import { traveldeskUpkeepService, type UpkeepOptions, type UpkeepResult } from "./traveldesk-upkeep.service";
import type { OpsIncident } from "./ops-alert.service";

/**
 * The daily upkeep job (doc 30 §3.10, N3; review 108 NR-01): its own route
 * (`/api/jobs/traveldesk-upkeep`) and cron entry, scheduled after the
 * catalogue sync, with its own time budget instead of what the sync left.
 *
 *  - Runs only when the environment's LATEST sync run is complete. A pass
 *    still running, incomplete or failed: skipped, the listings keep their
 *    state until a complete one (removals and terms are judged only then).
 *  - Once per sync run: when the upkeep of that run already finished
 *    (`complete`), it is skipped; an incomplete upkeep continues at the next
 *    call (listings run oldest `upkeep_at` first).
 *  - The catalogue sync's lease: a sync and an upkeep never overlap.
 *  - Never throws. Its state (`traveldesk.upkeep_state.<env>` in settings:
 *    the sync run it followed, whether it finished, consecutive incomplete
 *    runs) feeds an ops alert when `UPKEEP_ALERT_AFTER` runs in a row (one a
 *    day) did not finish.
 */

/** No listing (and no photo) starts after this, from the job's start: 50 s of the route's 300 s stay for readiness, digest, audit and the lease. */
export const UPKEEP_BUDGET_MS = 250_000;
/** Consecutive incomplete runs (one a day) before ops are alerted. */
export const UPKEEP_ALERT_AFTER = 2;

export const upkeepStateKey = (environment: SupplierEnvironment, code: string = TRAVELDESK_SUPPLIER_CODE) => `${code}.upkeep_state.${environment}`;

export interface UpkeepState {
  syncRunId: string;
  complete: boolean;
  consecutiveIncomplete: number;
  finishedAt: string;
  /** When the run that reached the alert threshold finished; null while under it. */
  alertAt: string | null;
}

export type ScheduledUpkeepOutcome =
  | { status: "complete" | "incomplete"; result: Omit<UpkeepResult, "touchedProductIds">; syncRunId: string }
  | { status: "skipped"; reason: "not_configured" | "no_sync" | "latest_sync_not_complete" | "already_done" | "lease_held" }
  | { status: "failed"; errorCode: string };

export interface UpkeepJobDeps {
  config?: TravelDeskConfig | null;
  supplierCode?: string;
  now?: () => number;
  upkeep?: Pick<UpkeepOptions, "photos" | "recipient">;
}

function parseState(v: unknown): UpkeepState | null {
  const s = v as Partial<UpkeepState> | null;
  return s && typeof s.syncRunId === "string" && typeof s.complete === "boolean" && typeof s.consecutiveIncomplete === "number" ? (s as UpkeepState) : null;
}

/** Pure, for tests: the next state after a run of the upkeep for `syncRunId`. */
export function nextUpkeepState(prev: UpkeepState | null, syncRunId: string, complete: boolean, at: Date): UpkeepState {
  const consecutiveIncomplete = complete ? 0 : (prev?.consecutiveIncomplete ?? 0) + 1;
  return { syncRunId, complete, consecutiveIncomplete, finishedAt: at.toISOString(), alertAt: consecutiveIncomplete >= UPKEEP_ALERT_AFTER ? (consecutiveIncomplete === UPKEEP_ALERT_AFTER ? at.toISOString() : (prev?.alertAt ?? at.toISOString())) : null };
}

export async function runScheduledUpkeep(deps: UpkeepJobDeps = {}): Promise<ScheduledUpkeepOutcome> {
  const config = deps.config !== undefined ? deps.config : traveldeskConfigFrom(env());
  if (!config) return { status: "skipped", reason: "not_configured" };
  const environment = config.environment;
  const code = deps.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
  const now = deps.now ?? (() => Date.now());
  const started = now();
  try {
    const latest = await prisma.supplierSyncRun.findFirst({ where: { supplierCode: code, environment }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, status: true } });
    if (!latest) return { status: "skipped", reason: "no_sync" };
    if (latest.status !== "complete") return { status: "skipped", reason: "latest_sync_not_complete" };
    const stateKey = upkeepStateKey(environment, code);
    const prev = parseState(await settingsRepo.get<unknown>(stateKey, null));
    if (prev && prev.syncRunId === latest.id && prev.complete) return { status: "skipped", reason: "already_done" };

    const leaseKey = catalogueSyncLeaseKey(environment, code);
    const holder = `upkeep:${started}`;
    if (!(await takeLease(leaseKey, holder, started))) return { status: "skipped", reason: "lease_held" };
    try {
      const { touchedProductIds: _t, ...result } = await traveldeskUpkeepService.run(environment, {
        supplierCode: code,
        runId: latest.id,
        now: () => new Date(now()),
        deadlineMs: started + UPKEEP_BUDGET_MS,
        ...(deps.upkeep ?? {}),
      });
      const state = nextUpkeepState(prev, latest.id, !result.incomplete, new Date(now()));
      await settingsRepo.set(stateKey, state);
      await audit(SYSTEM_ACTOR, "traveldesk_listing.upkeep_run", { type: "supplier", id: code }, { after: { ...result, syncRunId: latest.id, consecutiveIncomplete: state.consecutiveIncomplete, durationMs: now() - started } });
      return { status: result.incomplete ? "incomplete" : "complete", result, syncRunId: latest.id };
    } finally {
      await releaseLease(leaseKey, holder);
    }
  } catch (error) {
    log.warn("traveldesk_upkeep.job_failed", { environment, error: error instanceof Error ? error.name : "error" });
    return { status: "failed", errorCode: error instanceof Error ? error.name.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64) || "error" : "error" };
  }
}

/** Pure, for tests: the ops incident for a state at or past the threshold, raised at `alertAt`, inside the sweep window. */
export function upkeepIncompleteIncident(environment: SupplierEnvironment, state: UpkeepState | null, since: Date, now: Date, code: string = TRAVELDESK_SUPPLIER_CODE): OpsIncident | null {
  if (!state || state.complete || state.consecutiveIncomplete < UPKEEP_ALERT_AFTER || !state.alertAt) return null;
  const at = new Date(state.alertAt);
  if (Number.isNaN(at.getTime()) || at.getTime() < since.getTime() || at.getTime() > now.getTime()) return null;
  return {
    kind: "upkeep_incomplete",
    entityKind: "supplier_account",
    entityId: `${code}.upkeep.${environment}`,
    reason: "upkeep_incomplete",
    raisedAt: at,
    orderId: null,
    orderReference: null,
    bookingId: null,
    supplierBookingRef: null,
    adminPath: "/admin/suppliers/traveldesk/changes",
  };
}

/** For the ops sweep: the upkeep did not finish on `UPKEEP_ALERT_AFTER` runs in a row. */
export async function upkeepIncompleteIncidents(environment: SupplierEnvironment, since: Date, now: Date): Promise<OpsIncident[]> {
  const i = upkeepIncompleteIncident(environment, parseState(await settingsRepo.get<unknown>(upkeepStateKey(environment), null)), since, now);
  return i ? [i] : [];
}
