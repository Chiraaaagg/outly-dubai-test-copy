import type { NextRequest } from "next/server";
import { SYSTEM_ACTOR } from "@/server/lib/actor";
import { handle, json, requireCron } from "@/server/lib/http";
import { fxRefreshService } from "@/server/services/fx-refresh.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** One 10 s fetch, one locked write and, when the rate changed, a readiness pass. */
export const maxDuration = 60;

/**
 * /api/jobs/fx-refresh — refreshes `pricing.fx_inr_per_aed` from the ECB
 * USD/INR reference rate (doc 22 §32.16; src/server/services/fx-refresh.service.ts).
 * Vercel Cron calls GET twice a day, 04:30 and 16:30 UTC (vercel.json), with
 * `Authorization: Bearer $CRON_SECRET`; the 16:30 run follows the ECB's daily
 * publication (about 16:00 CET), so a fresh rate lands the same day. POST is
 * for manual runs with the same secret. Disabled (503)
 * when no secret is set. 200 when a new version was written, 409 when a guard
 * refused the rate (the old row stays), 502 when the source failed.
 */
async function run(req: NextRequest) {
  requireCron(req);
  const outcome = await fxRefreshService.refresh(SYSTEM_ACTOR, { trigger: "cron" });
  const status = outcome.status === "written" ? 200 : outcome.status === "refused" ? 409 : 502;
  return json({ ok: outcome.status === "written", ...outcome, ranAt: new Date().toISOString() }, { status });
}

export const GET = handle(run);
export const POST = handle(run);
