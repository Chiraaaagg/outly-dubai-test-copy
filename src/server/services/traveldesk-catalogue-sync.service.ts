import "server-only";
import type { SupplierEnvironment } from "@prisma/client";
import { addDays, dubaiToday } from "@/lib/utils";
import type { Actor } from "../lib/actor";
import { requirePermission, SYSTEM_ACTOR } from "../lib/actor";
import { audit } from "../lib/audit";
import { prisma } from "../lib/db";
import { env } from "../lib/env";
import { Errors, isAppError } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { log } from "../lib/logger";
import type { ReadLimits } from "../suppliers/read-budget";
import { TravelDeskReadClient } from "../suppliers/traveldesk/traveldesk.client";
import { traveldeskConfigFrom, type TravelDeskConfig } from "../suppliers/traveldesk/traveldesk.config";
import { TravelDeskApiError } from "../suppliers/traveldesk/traveldesk.http";
import { verifyStepUp } from "./approval.service";
import { readinessService } from "./readiness.service";
import { bookingAccountId, DEFAULT_BOOKING_ACCOUNT_ID } from "./supplier-booking.service";
import { supplierCatalogService, TRAVELDESK_SUPPLIER_CODE, type SyncResult, type SyncResume } from "./supplier-catalog.service";

/**
 * TravelDesk catalogue sync: the admin button (pilot day, 17 Nov 2026) and,
 * since doc 29 Batch 1b, a daily scheduled run (conflict C10, owner decision
 * 13: daily automatic read-only sync plus the button).
 *
 * The local sync script may only write to a local database, so a deployment
 * had no way to load its own environment's catalogue. This runs the same
 * service calls inside the deployment, with the key that is already in its
 * environment: the key never leaves Vercel.
 *
 * - Read only towards TravelDesk: `TravelDeskReadClient` has GET calls only.
 *   Bookings are never touched, whatever `TRAVELDESK_BOOKINGS_ENABLED` says.
 * - Writes only the catalogue tables (items, candidates, price snapshots),
 *   through `supplierCatalogService`.
 * - `suppliers.manage`, plus a fresh authenticator code (step-up), and an
 *   audit row for every run that got past the step-up, failed ones included.
 * - Every TravelDesk read waits for a quiet supplier and takes a token from
 *   the same per-account read budget as quotes and bookings (SUP-6).
 * - One absolute deadline (`RUN_DEADLINE_MS`) well inside the route's
 *   `maxDuration` (300 s): past it the pull stops before the next call and
 *   reports `incomplete` (removals skipped), so the platform limit never cuts
 *   a run mid-write. A second run continues; the sync is idempotent.
 * - One run at a time per environment: a lease row in `settings`, taken with a
 *   conditional write and released at the end. A lease older than
 *   `CATALOGUE_SYNC_LEASE_MS` belongs to a run that cannot still be alive
 *   (longer than `maxDuration`) and can be taken over. The button and the
 *   scheduled run share it.
 * - Every run that holds the lease writes a `supplier_sync_runs` row (Batch
 *   1b): running, then complete, incomplete or failed, with its counts. An
 *   incomplete run leaves a cursor (the last tour attempted, tours in id
 *   order) and the next run, of either trigger, continues the same pass after
 *   it, unless the pass started more than `RESUME_MAX_PASS_AGE_MS` ago.
 *   Removals are judged only when a pass completes, against everything seen
 *   since the pass started, and keep the 20% cap.
 * - The two entry points: `runTravelDeskCatalogueSync` for staff (permission
 *   and a fresh authenticator code; the system actor is refused there), and
 *   `runScheduledCatalogueSync` for the cron route, which acts as the system
 *   actor without a code. Nothing else differs: same lease, deadline, read
 *   budget and auth abort.
 */

/** Longer than the route's `maxDuration` (300 s), so a live run is never taken over. */
export const CATALOGUE_SYNC_LEASE_MS = 6 * 60_000;
/** When the run stops starting new TravelDesk calls, measured from its start. */
export const RUN_DEADLINE_MS = 240_000;
/** Price snapshots start only when at least this much time is left before the deadline. */
const SNAPSHOT_MIN_REMAINING_MS = 60_000;
/** Longest wait for one read token before the run gives up (the deadline usually ends it first). */
const MAX_TOKEN_WAIT_MS = 60_000;
/** Offers whose prices are snapshotted per run: approved mappings first, then suggestions. */
const SNAPSHOT_OFFER_LIMIT = 40;

/** An incomplete pass older than this is not continued: the next run starts a fresh pass. */
export const RESUME_MAX_PASS_AGE_MS = 72 * 3_600_000;

export type CatalogueSyncTrigger = "cron" | "admin";

export function catalogueSyncLeaseKey(environment: SupplierEnvironment, supplierCode: string = TRAVELDESK_SUPPLIER_CODE): string {
  return `${supplierCode}.catalogue_sync.${environment}`;
}

export interface CatalogueSyncSource {
  getBalance(): Promise<{ agencyId: number }>;
  listTours: TravelDeskReadClient["listTours"];
  getTour: TravelDeskReadClient["getTour"];
  getAvailability: TravelDeskReadClient["getAvailability"];
}

type CandidateCounts = Awaited<ReturnType<typeof supplierCatalogService.generateCandidates>>;

export interface CatalogueSyncResult {
  environment: SupplierEnvironment;
  /** The agency the key belongs to (from `/balance`); set `TRAVELDESK_AGENCY_ID` to it. */
  agencyId: string;
  /** `TRAVELDESK_AGENCY_ID` on this deployment, or null when unset. */
  pinnedAgencyId: string | null;
  sync: Pick<SyncResult, "tours" | "offers" | "added" | "changed" | "removed" | "revived" | "failedTours" | "removalsApplied" | "removalsSkipped" | "mappingsChanged" | "incomplete">;
  candidates: CandidateCounts | { skipped: "incomplete" };
  snapshots: { offers: number; rows: number; failed: number; incomplete: boolean } | { skipped: "time_budget" | "no_offers" | "incomplete" };
  /** The `supplier_sync_runs` row; `resumedFromRunId` is set when this run continued an incomplete pass. */
  run: { id: string; status: "complete" | "incomplete"; resumedFromRunId: string | null; resumeAfterTourId: number | null };
  durationMs: number;
}

export interface CatalogueSyncDeps {
  config?: TravelDeskConfig | null;
  source?: (config: TravelDeskConfig) => CatalogueSyncSource;
  stepUp?: (actor: Actor, code: string) => Promise<string | null>;
  /** Clock for the run's start and deadline (epoch ms). */
  now?: () => number;
  /** Test seam: integration tests sync under their own supplier row. */
  supplierCode?: string;
  /** Test seam: the supplier lane's read limits. */
  readLimits?: ReadLimits;
}

/** Takes the lease, or returns false when another run holds a fresh one. */
async function takeLease(key: string, holder: string, nowMs: number): Promise<boolean> {
  const value = JSON.stringify({ holder, startedAt: new Date(nowMs).toISOString() });
  const staleBefore = new Date(Date.now() - CATALOGUE_SYNC_LEASE_MS);
  // One statement: insert, or overwrite only a lease that is released or stale.
  const taken = await prisma.$executeRaw`
    INSERT INTO settings (key, value, updated_at) VALUES (${key}, ${value}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    WHERE settings.value->>'holder' IS NULL OR settings.updated_at < ${staleBefore}`;
  return taken === 1;
}

/** Never throws: a failed release must not hide the run's own result; the lease then goes stale. */
async function releaseLease(key: string, holder: string): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE settings SET value = jsonb_build_object('releasedAt', now()::text), updated_at = now()
      WHERE key = ${key} AND value->>'holder' = ${holder}`;
  } catch (error) {
    log.warn("supplier.catalogue_sync_release_failed", { key, error });
  }
}

/** Offers to snapshot: approved mappings' offers first, then suggestions, up to the limit. */
async function snapshotOffers(supplierId: string, environment: SupplierEnvironment): Promise<string[]> {
  const ids: string[] = [];
  for (const state of ["approved", "suggested"] as const) {
    const rows = await prisma.supplierMappingCandidate.findMany({
      where: { supplierId, environment, state },
      select: { offerExternalId: true },
      distinct: ["offerExternalId"],
      orderBy: { offerExternalId: "asc" },
      take: SNAPSHOT_OFFER_LIMIT,
    });
    for (const r of rows) if (!ids.includes(r.offerExternalId) && ids.length < SNAPSHOT_OFFER_LIMIT) ids.push(r.offerExternalId);
  }
  return ids;
}

const STEP_UP_MESSAGE: Record<string, string> = {
  not_enrolled: "Set up your authenticator app first",
};

/** A short code for the run row: never a message, URL or supplier text. */
function errorCodeOf(error: unknown): string {
  const raw = error instanceof TravelDeskApiError ? `traveldesk_${error.kind}` : isAppError(error) ? error.code : error instanceof Error ? error.name : "error";
  return raw.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64) || "error";
}

/**
 * Open this run's row. Called while holding the lease, so any row still
 * `running` belongs to a run the platform stopped: it is closed as failed
 * (`abandoned`). The latest earlier row then decides whether this run
 * continues an incomplete pass.
 */
async function openRun(code: string, environment: SupplierEnvironment, accountId: string, trigger: CatalogueSyncTrigger, startedAt: Date) {
  await prisma.supplierSyncRun.updateMany({
    where: { supplierCode: code, environment, status: "running" },
    data: { status: "failed", finishedAt: startedAt, errorCode: "abandoned", resumeAfterTourId: null },
  });
  // Insertion order (database clock), not the run's own start time.
  const previous = await prisma.supplierSyncRun.findFirst({ where: { supplierCode: code, environment }, orderBy: { createdAt: "desc" } });
  const resumable =
    previous &&
    previous.status === "incomplete" &&
    previous.resumeAfterTourId !== null &&
    previous.passStartedAt <= startedAt &&
    startedAt.getTime() - previous.passStartedAt.getTime() <= RESUME_MAX_PASS_AGE_MS;
  const resume: SyncResume | null = resumable ? { afterTourId: previous.resumeAfterTourId!, passStartedAt: previous.passStartedAt, failedTours: previous.failedTours } : null;
  const row = await prisma.supplierSyncRun.create({
    data: {
      id: uuidv7(),
      supplierCode: code,
      environment,
      accountId,
      triggeredBy: trigger,
      status: "running",
      startedAt,
      passStartedAt: resume?.passStartedAt ?? startedAt,
      resumedFromRunId: resumable ? previous.id : null,
    },
  });
  return { id: row.id, resume, resumedFromRunId: row.resumedFromRunId };
}

/** Never throws: a failed write must not hide the run's own result or error. */
async function closeRun(id: string, data: Parameters<typeof prisma.supplierSyncRun.update>[0]["data"]): Promise<void> {
  try {
    await prisma.supplierSyncRun.update({ where: { id }, data });
  } catch (error) {
    log.warn("supplier.catalogue_sync_run_close_failed", { runId: id, error });
  }
}

/** Staff entry point: the admin button. Needs `suppliers.manage` and a fresh authenticator code. */
export async function runTravelDeskCatalogueSync(actor: Actor, totpCode: string | undefined, deps: CatalogueSyncDeps = {}): Promise<CatalogueSyncResult> {
  requirePermission(actor, "suppliers.manage");
  // The system actor holds every permission but no authenticator: it has its own entry point, without a code.
  if (actor.type !== "admin" && actor.type !== "agent") throw Errors.forbidden("suppliers.manage");
  const config = deps.config !== undefined ? deps.config : traveldeskConfigFrom(env());
  if (!config) throw Errors.conflict("TravelDesk is not configured on this deployment (SUPPLIER_ADAPTER_TRAVELDESK=live, TRAVELDESK_ENV, TRAVELDESK_API_KEY)");
  if (!totpCode) throw Errors.validation({ totpCode: "Enter the 6-digit code from your authenticator app" });
  const failed = await (deps.stepUp ?? verifyStepUp)(actor, totpCode);
  if (failed) throw Errors.validation({ totpCode: STEP_UP_MESSAGE[failed] ?? "The code was not accepted; wait for a new one" });
  return runSync(actor, "admin", config, deps);
}

export type ScheduledCatalogueSyncOutcome =
  | { status: "complete" | "incomplete"; result: CatalogueSyncResult }
  | { status: "skipped"; reason: "not_configured" | "lease_held" }
  | { status: "failed"; errorCode: string };

/**
 * Scheduled entry point (`/api/jobs/catalogue-sync`, doc 29 Batch 1b): the
 * same GET-only run as the button, as the system actor and without a code.
 * The route's own auth (the cron secret) is the only gate. Never throws:
 * outcomes the route reports. When the run did not complete, readiness is
 * re-run for the instant candidates so an ageing catalogue reaches the
 * storefront (`catalogue_stale`) without waiting for the next sync.
 */
export async function runScheduledCatalogueSync(deps: Omit<CatalogueSyncDeps, "stepUp"> = {}): Promise<ScheduledCatalogueSyncOutcome> {
  const config = deps.config !== undefined ? deps.config : traveldeskConfigFrom(env());
  let outcome: ScheduledCatalogueSyncOutcome;
  if (!config) {
    outcome = { status: "skipped", reason: "not_configured" };
  } else {
    try {
      const result = await runSync(SYSTEM_ACTOR, "cron", config, deps);
      outcome = { status: result.run.status, result };
    } catch (error) {
      outcome = isAppError(error) && error.code === "CONFLICT" ? { status: "skipped", reason: "lease_held" } : { status: "failed", errorCode: errorCodeOf(error) };
    }
  }
  // A held lease means another run is syncing, and it re-runs readiness itself.
  if (outcome.status !== "complete" && !(outcome.status === "skipped" && outcome.reason === "lease_held")) {
    await readinessService.reevaluateInstantCandidates("catalogue_age");
  }
  return outcome;
}

async function runSync(actor: Actor, trigger: CatalogueSyncTrigger, config: TravelDeskConfig, deps: CatalogueSyncDeps): Promise<CatalogueSyncResult> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const deadlineMs = started + RUN_DEADLINE_MS;
  const environment = config.environment;
  const code = deps.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
  const key = catalogueSyncLeaseKey(environment, code);
  const holder = `${actor.type}:${actor.id ?? trigger}:${started}`;
  if (!(await takeLease(key, holder, started))) {
    throw Errors.conflict("A catalogue sync is already running for this environment. Try again in a few minutes (at most 6).");
  }

  // The same account key as quotes and bookings, so all three share one read budget (SUP-6).
  const accountId = bookingAccountId(environment, config.agencyId) ?? DEFAULT_BOOKING_ACCOUNT_ID;
  const lane = { accountId, readLimits: deps.readLimits, maxWaitMs: MAX_TOKEN_WAIT_MS, deadlineMs };
  const progress: Partial<CatalogueSyncResult> = { environment };
  let runId: string | null = null;
  try {
    const opened = await openRun(code, environment, accountId, trigger, new Date(started));
    runId = opened.id;
    const source = (deps.source ?? ((c) => new TravelDeskReadClient(c, { maxConcurrent: 1 })))(config);
    const balance = await source.getBalance();
    progress.agencyId = String(balance.agencyId);
    progress.pinnedAgencyId = config.agencyId ?? null;

    const sync = await supplierCatalogService.syncTravelDeskCatalogue(source, environment, { supplierCode: code, lane, resume: opened.resume });
    progress.sync = {
      tours: sync.tours,
      offers: sync.offers,
      added: sync.added,
      changed: sync.changed,
      removed: sync.removed,
      revived: sync.revived,
      failedTours: sync.failedTours,
      removalsApplied: sync.removalsApplied,
      removalsSkipped: sync.removalsSkipped,
      mappingsChanged: sync.mappingsChanged,
      incomplete: sync.incomplete,
    };
    const today = dubaiToday(new Date(started));
    // A partial pull would drop suggestions for tours it did not read: refresh them only after a complete one.
    progress.candidates = sync.incomplete ? { skipped: "incomplete" } : await supplierCatalogService.generateCandidates(environment, { onDate: addDays(today, 2), supplierCode: code });

    if (sync.incomplete) {
      progress.snapshots = { skipped: "incomplete" };
    } else if (deadlineMs - now() < SNAPSHOT_MIN_REMAINING_MS) {
      progress.snapshots = { skipped: "time_budget" };
    } else {
      const supplier = await prisma.supplier.findUniqueOrThrow({ where: { code } });
      const ids = await snapshotOffers(supplier.id, environment);
      const items = await prisma.supplierCatalogueItem.findMany({
        where: { supplierId: supplier.id, environment, kind: "offer", externalId: { in: ids }, removedAt: null },
        select: { externalId: true, isExternal: true, bookingKind: true },
      });
      const datable = items.filter((i) => i.bookingKind === "live_book" || i.bookingKind === "on_request");
      if (!datable.length) {
        progress.snapshots = { skipped: "no_offers" };
      } else {
        const r = await supplierCatalogService.snapshotAvailability(
          source,
          environment,
          datable.map((i) => ({ offerId: Number(i.externalId), isExternal: i.isExternal })),
          addDays(today, 2),
          addDays(today, 8),
          { supplierCode: code, lane },
        );
        progress.snapshots = { offers: datable.length, rows: r.rows, failed: r.failed.length, incomplete: r.incomplete };
      }
    }

    const status = sync.incomplete ? "incomplete" : "complete";
    // An incomplete run leaves its cursor; with no tour attempted at all there is nothing to continue after.
    const resumeAfterTourId = sync.incomplete ? sync.lastTourId : null;
    progress.run = { id: runId, status, resumedFromRunId: opened.resumedFromRunId, resumeAfterTourId };
    await closeRun(runId, {
      status,
      finishedAt: new Date(now()),
      resumeAfterTourId,
      tours: sync.tours,
      offers: sync.offers,
      added: sync.added,
      changed: sync.changed,
      removed: sync.removed,
      revived: sync.revived,
      mappingsChanged: sync.mappingsChanged,
      failedTours: sync.failedTours,
      removalsSkipped: sync.removalsSkipped ?? null,
      deadlineHit: Boolean(sync.incomplete) || ("incomplete" in progress.snapshots && progress.snapshots.incomplete),
    });
    const result = { ...progress, durationMs: now() - started } as CatalogueSyncResult;
    await audit(actor, "supplier.catalogue_synced", { type: "supplier", id: code }, { after: { ...result, trigger } });
    return result;
  } catch (error) {
    log.warn("supplier.catalogue_sync_failed", { environment, trigger, error });
    if (runId) await closeRun(runId, { status: "failed", finishedAt: new Date(now()), resumeAfterTourId: null, errorCode: errorCodeOf(error) });
    // Whatever was written before the failure stays; the audit says how far the run got.
    await audit(actor, "supplier.catalogue_sync_failed", { type: "supplier", id: code }, {
      after: { ...progress, trigger, durationMs: now() - started, error: error instanceof Error ? error.name : "error" },
    });
    throw error;
  } finally {
    await releaseLease(key, holder);
  }
}
