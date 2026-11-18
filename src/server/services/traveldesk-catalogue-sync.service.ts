import "server-only";
import type { SupplierEnvironment } from "@prisma/client";
import { addDays, dubaiToday } from "@/lib/utils";
import type { Actor } from "../lib/actor";
import { requirePermission } from "../lib/actor";
import { audit } from "../lib/audit";
import { prisma } from "../lib/db";
import { env } from "../lib/env";
import { Errors } from "../lib/errors";
import { log } from "../lib/logger";
import type { ReadLimits } from "../suppliers/read-budget";
import { TravelDeskReadClient } from "../suppliers/traveldesk/traveldesk.client";
import { traveldeskConfigFrom, type TravelDeskConfig } from "../suppliers/traveldesk/traveldesk.config";
import { verifyStepUp } from "./approval.service";
import { bookingAccountId, DEFAULT_BOOKING_ACCOUNT_ID } from "./supplier-booking.service";
import { supplierCatalogService, TRAVELDESK_SUPPLIER_CODE, type SyncResult } from "./supplier-catalog.service";

/**
 * Admin-triggered TravelDesk catalogue sync (pilot day, 17 Nov 2026).
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
 *   (longer than `maxDuration`) and can be taken over.
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

export async function runTravelDeskCatalogueSync(actor: Actor, totpCode: string | undefined, deps: CatalogueSyncDeps = {}): Promise<CatalogueSyncResult> {
  requirePermission(actor, "suppliers.manage");
  const now = deps.now ?? (() => Date.now());
  const config = deps.config !== undefined ? deps.config : traveldeskConfigFrom(env());
  if (!config) throw Errors.conflict("TravelDesk is not configured on this deployment (SUPPLIER_ADAPTER_TRAVELDESK=live, TRAVELDESK_ENV, TRAVELDESK_API_KEY)");
  if (!totpCode) throw Errors.validation({ totpCode: "Enter the 6-digit code from your authenticator app" });
  const failed = await (deps.stepUp ?? verifyStepUp)(actor, totpCode);
  if (failed) throw Errors.validation({ totpCode: STEP_UP_MESSAGE[failed] ?? "The code was not accepted; wait for a new one" });

  const started = now();
  const deadlineMs = started + RUN_DEADLINE_MS;
  const environment = config.environment;
  const code = deps.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
  const key = catalogueSyncLeaseKey(environment, code);
  const holder = `${actor.type}:${actor.id}:${started}`;
  if (!(await takeLease(key, holder, started))) {
    throw Errors.conflict("A catalogue sync is already running for this environment. Try again in a few minutes (at most 6).");
  }

  // The same account key as quotes and bookings, so all three share one read budget (SUP-6).
  const lane = { accountId: bookingAccountId(environment, config.agencyId) ?? DEFAULT_BOOKING_ACCOUNT_ID, readLimits: deps.readLimits, maxWaitMs: MAX_TOKEN_WAIT_MS, deadlineMs };
  const progress: Partial<CatalogueSyncResult> = { environment };
  try {
    const source = (deps.source ?? ((c) => new TravelDeskReadClient(c, { maxConcurrent: 1 })))(config);
    const balance = await source.getBalance();
    progress.agencyId = String(balance.agencyId);
    progress.pinnedAgencyId = config.agencyId ?? null;

    const sync = await supplierCatalogService.syncTravelDeskCatalogue(source, environment, { supplierCode: code, lane });
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

    const result = { ...progress, durationMs: now() - started } as CatalogueSyncResult;
    await audit(actor, "supplier.catalogue_synced", { type: "supplier", id: code }, { after: { ...result } });
    return result;
  } catch (error) {
    log.warn("supplier.catalogue_sync_failed", { environment, error });
    // Whatever was written before the failure stays; the audit says how far the run got.
    await audit(actor, "supplier.catalogue_sync_failed", { type: "supplier", id: code }, {
      after: { ...progress, durationMs: now() - started, error: error instanceof Error ? error.name : "error" },
    });
    throw error;
  } finally {
    await releaseLease(key, holder);
  }
}
