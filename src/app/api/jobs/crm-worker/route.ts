import type { NextRequest } from "next/server";
import { handle, json, requireCron, requireCrmProbeSecret } from "@/server/lib/http";
import { runCrmFingerprintJob, runCrmProbeJob, runCrmWorkerJob } from "@/server/jobs/crm-worker-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The run starts rows for 10 s; a row's few paced calls may finish after that. */
export const maxDuration = 60;

/**
 * /api/jobs/crm-worker — the Bitrix24 CRM outbox worker (doc 29 §6.4, CRM
 * batch C1): its own route, never a step of the booking tick.
 *
 * GET (Vercel Cron, every minute per vercel.json since C2a) and POST
 * (manual) both need CRON_SECRET. Both answer `skipped` without touching
 * data while CRM_SYNC_ENABLED is not "true" or the CRM configuration does
 * not validate, so the schedule is a no-op until the owner's switch-on.
 *
 * POST with `x-crm-probe: synthetic` (or `delete`) runs the synthetic probe
 * instead (doc 29d §5.2a): only while the sync is off, one made-up deal, its
 * 20 fields read back. A live portal write: the owner runs it as a WRITE step.
 * It needs CRM_PROBE_SECRET in `x-crm-probe-secret` besides CRON_SECRET
 * (SEC-8 b, re-review R-02), as the manual supplier run needs its job secret:
 * the cron secret alone never runs the probe.
 *
 * POST with `x-crm-fingerprint: store` (and the same two secrets) stores the
 * Bitrix24 portal fingerprint for the return path (CRM batch C3ab, doc 29e
 * §7): three reads, no portal write. It is the owner's explicit step after
 * the observe week, and the reset after a fingerprint mismatch.
 */
async function run(req: NextRequest) {
  requireCron(req);
  const probe = req.method === "POST" ? req.headers.get("x-crm-probe") : null;
  if (probe === "synthetic" || probe === "delete") {
    requireCrmProbeSecret(req);
    return json(await runCrmProbeJob(probe));
  }
  if (req.method === "POST" && req.headers.get("x-crm-fingerprint") === "store") {
    requireCrmProbeSecret(req);
    return json(await runCrmFingerprintJob());
  }
  return json(await runCrmWorkerJob());
}

export const GET = handle(run);
export const POST = handle(run);
