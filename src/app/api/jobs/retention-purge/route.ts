import type { NextRequest } from "next/server";
import { handle, json, requireCron } from "@/server/lib/http";
import { runRetentionPurge } from "@/server/jobs/retention-purge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The purge stops starting batches after 40 s (PURGE_BUDGET_MS); each batch is one bounded statement. */
export const maxDuration = 60;

/**
 * /api/jobs/retention-purge — deletes expired one-time-code rows, sessions,
 * capability grants, unused quotes and their unbound verifications, and
 * orphaned guest sessions (doc 26 §2; src/server/jobs/retention-purge.ts).
 * Vercel Cron calls GET once a day (vercel.json) with `Authorization: Bearer
 * $CRON_SECRET`; POST is for manual runs with the same secret. Disabled (503)
 * when no secret is set. 200 with per-table counts; 500 when a table failed
 * (the others still ran, and the next run retries).
 */
async function run(req: NextRequest) {
  requireCron(req);
  const result = await runRetentionPurge();
  return json(result, { status: result.ok ? 200 : 500 });
}

export const GET = handle(run);
export const POST = handle(run);
