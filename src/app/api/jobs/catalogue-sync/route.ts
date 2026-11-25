import type { NextRequest } from "next/server";
import { handle, json, requireCron, requireJobSecret } from "@/server/lib/http";
import { runScheduledCatalogueSync, type ScheduledCatalogueSyncOutcome } from "@/server/services/traveldesk-catalogue-sync.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The run stops starting TravelDesk calls 240 s after its start (`RUN_DEADLINE_MS`), well inside this. */
export const maxDuration = 300;

/**
 * /api/jobs/catalogue-sync — the daily read-only TravelDesk catalogue sync
 * (doc 29 §6.3, Batch 1b; conflict C10, owner decision 13). It runs the same
 * GET-only service as the admin "Sync catalogue" button, as the system actor
 * and without an authenticator code: same lease (one run per environment,
 * shared with the button), 240 s deadline, shared read budget and abort on a
 * rejected key. An incomplete run leaves a cursor and the next run of either
 * kind continues after it. The button keeps its own permission and code.
 *
 * GET: Vercel Cron (CRON_SECRET), once a day at 23:00 UTC, 03:00 in Dubai
 * (vercel.json). POST: manual run, which also needs SUPPLIER_JOB_SECRET in
 * `x-job-secret` (SEC-8), like the other supplier job routes. Answers
 * `skipped` while TravelDesk is not configured on the deployment; 409 while
 * another run holds the lease; 502 when the run failed. Rollback: remove the
 * vercel.json line; the button still works.
 */
async function scheduled(req: NextRequest) {
  requireCron(req);
  return report(await runScheduledCatalogueSync());
}

async function manual(req: NextRequest) {
  requireCron(req);
  requireJobSecret(req);
  return report(await runScheduledCatalogueSync());
}

function report(outcome: ScheduledCatalogueSyncOutcome) {
  const ranAt = new Date().toISOString();
  if (outcome.status === "skipped") return json({ ok: outcome.reason === "not_configured", skipped: outcome.reason, ranAt }, { status: outcome.reason === "lease_held" ? 409 : 200 });
  if (outcome.status === "failed") return json({ ok: false, status: "failed", errorCode: outcome.errorCode, ranAt }, { status: 502 });
  const r = outcome.result;
  // Counts and ids only: no prices, balance or agency details in a job response.
  return json({
    ok: true,
    status: outcome.status,
    environment: r.environment,
    runId: r.run.id,
    resumedFromRunId: r.run.resumedFromRunId,
    tours: r.sync.tours,
    offers: r.sync.offers,
    added: r.sync.added,
    changed: r.sync.changed,
    removed: r.sync.removed,
    failedTours: r.sync.failedTours.length,
    removalsSkipped: r.sync.removalsSkipped ?? null,
    durationMs: r.durationMs,
    ranAt,
  });
}

export const GET = handle(scheduled);
export const POST = handle(manual);
