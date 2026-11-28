import type { NextRequest } from "next/server";
import { handle, json, requireCron, requireJobSecret } from "@/server/lib/http";
import { runScheduledUpkeep, type ScheduledUpkeepOutcome } from "@/server/services/traveldesk-upkeep-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The upkeep starts no listing 250 s after its start (`UPKEEP_BUDGET_MS`), well inside this. */
export const maxDuration = 300;

/**
 * /api/jobs/traveldesk-upkeep — the daily upkeep of imported TravelDesk
 * listings (doc 30 §3.10, build N3; review 108 NR-01), on its own route and
 * time budget after the catalogue sync. Runs only when the latest sync run
 * is complete, once per sync run (an unfinished upkeep continues at the next
 * call), under the catalogue sync's lease. Reads only the stored catalogue:
 * no TravelDesk call.
 *
 * GET: Vercel Cron (CRON_SECRET), daily at 23:20 UTC, 20 minutes after the
 * catalogue sync (vercel.json). POST: manual run, which also needs
 * SUPPLIER_JOB_SECRET in `x-job-secret` (SEC-8). 409 while the lease is held;
 * 502 when the run failed. Rollback: remove the vercel.json line; links of
 * imported listings then read `changed` and sell as inquiry, as today.
 */
async function scheduled(req: NextRequest) {
  requireCron(req);
  return report(await runScheduledUpkeep());
}

async function manual(req: NextRequest) {
  requireCron(req);
  requireJobSecret(req);
  return report(await runScheduledUpkeep());
}

function report(outcome: ScheduledUpkeepOutcome) {
  const ranAt = new Date().toISOString();
  if (outcome.status === "skipped") return json({ ok: true, skipped: outcome.reason, ranAt }, { status: outcome.reason === "lease_held" ? 409 : 200 });
  if (outcome.status === "failed") return json({ ok: false, status: "failed", errorCode: outcome.errorCode, ranAt }, { status: 502 });
  const r = outcome.result;
  // Counts and codes only: no prices, no listing text.
  return json({
    ok: true,
    status: outcome.status,
    environment: r.environment,
    syncRunId: outcome.syncRunId,
    links: r.links,
    processed: r.processed,
    changed: r.changed,
    reapproved: r.reapproved,
    reviews: r.reviews,
    unavailable: r.unavailable,
    hidden: r.hidden,
    skipped: r.skipped.length,
    digest: r.digest,
    ranAt,
  });
}

export const GET = handle(scheduled);
export const POST = handle(manual);
