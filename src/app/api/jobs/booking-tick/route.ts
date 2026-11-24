import type { NextRequest } from "next/server";
import { handle, json, requireCron } from "@/server/lib/http";
import { runBookingTick } from "@/server/jobs/booking-tick";
import { PAYMENTS_STEP_CAP_MS, runPaymentsJob } from "@/server/jobs/payments-job";
import { scheduledBookingJobsOff } from "@/server/jobs/schedule-switch";
import { runSupplierWorker } from "@/server/jobs/supplier-worker-job";
import { MUTATION_START_MARGIN_MS } from "@/server/services/supplier-booking.service";
import "@/server/wiring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * As the supplier worker: a TravelDesk mutation may take up to 150 s. 300 s is
 * the Pro ceiling without Fluid compute (assumed: the project's setting cannot
 * be read here); see `runBookingTick` for how the time is shared.
 */
export const maxDuration = 300;
/** Follow-up 4: 45 s payments cap + 90 s window + 150 s mutation = 285 s, so the latest mutation ends 15 s before the kill. */
const MUTATION_END_BEFORE_KILL_MS = 15_000;

/**
 * /api/jobs/booking-tick — the payments step, then the supplier worker's
 * scheduled run, in that order and in one invocation (checkout redesign
 * batch 4, CO-38, CO-39; `runBookingTick`). Vercel Cron calls it every
 * minute (vercel.json) with `Authorization: Bearer $CRON_SECRET`; it is the
 * production schedule of both `/api/jobs/payments-tick` and the GET of
 * `/api/jobs/supplier-worker`, which stay for manual runs.
 *
 * While `SCHEDULED_BOOKING_JOBS_ENABLED` is not "true" it answers `skipped`
 * and touches no data (review fix 4; turned on at pilot-day A10, after the
 * migrations).
 *
 * GET only, with the cron secret: the supplier step is always the scheduled
 * (`paid_only`) run. Manual runs that may send other mutations stay on the
 * supplier worker's POST with SUPPLIER_JOB_SECRET. Each step keeps every one
 * of its own guards, and one step failing never skips the other (the answer
 * is then 500 with `ok: false` and the failed step's error code). The
 * payments step is capped at `PAYMENTS_STEP_CAP_MS` so the worker keeps its
 * mutation window.
 */
async function run(req: NextRequest) {
  requireCron(req);
  const off = scheduledBookingJobsOff();
  if (off) return json(off);
  const result = await runBookingTick(
    {
      payments: (capMs) => runPaymentsJob({ capMs }),
      supplier: (budget) => runSupplierWorker("scheduled", { ...budget, documentsAfterConfirm: true }),
    },
    {
      budgetMs: (maxDuration - 30) * 1000,
      mutationWindowMs: (maxDuration - 30) * 1000,
      killMs: maxDuration * 1000,
      paymentsCapMs: PAYMENTS_STEP_CAP_MS,
      mutationEndBeforeKillMs: MUTATION_END_BEFORE_KILL_MS,
      mutationStartMarginMs: MUTATION_START_MARGIN_MS,
    },
  );
  return json(result, { status: result.ok ? 200 : 500 });
}

export const GET = handle(run);
