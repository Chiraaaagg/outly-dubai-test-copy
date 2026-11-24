import type { NextRequest } from "next/server";
import { handle, json, requireCron } from "@/server/lib/http";
import { runCrmWorkerJob } from "@/server/jobs/crm-worker-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The run starts rows for 10 s; a row's few paced calls may finish after that. */
export const maxDuration = 60;

/**
 * /api/jobs/crm-worker — the Bitrix24 CRM outbox worker (doc 29 §6.4, CRM
 * batch C1): its own route, never a step of the booking tick.
 *
 * GET (Vercel Cron) and POST (manual) both need CRON_SECRET. Both answer
 * `skipped` without touching data while CRM_SYNC_ENABLED is not "true" or
 * the CRM configuration does not validate. C1 adds no cron entry: nothing
 * calls this route until C2 schedules it after its own approval.
 */
async function run(req: NextRequest) {
  requireCron(req);
  return json(await runCrmWorkerJob());
}

export const GET = handle(run);
export const POST = handle(run);
