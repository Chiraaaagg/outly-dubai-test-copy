import type { NextRequest } from "next/server";
import { env } from "@/server/lib/env";
import { handle, json, requireCron, requireJobSecret } from "@/server/lib/http";
import { scheduledBookingJobsOff } from "@/server/jobs/schedule-switch";
import { bookingAccountId, supplierBookingService } from "@/server/services/supplier-booking.service";
import { TravelDeskBookingAdapter } from "@/server/suppliers/traveldesk/traveldesk.booking-adapter";
import { traveldeskConfigFrom } from "@/server/suppliers/traveldesk/traveldesk.config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * /api/jobs/supplier-reconcile — compares supplier_bookings with TravelDesk's
 * booking list and funds (docs/backend/21 §15.3, SUP-12). GET requests only to
 * TravelDesk. It changes no booking, except that a booking closed as never
 * created that TravelDesk shows live is re-blocked for recovery. It does not
 * run while a mutation lease is held. The summary is shown on
 * /admin/suppliers/traveldesk.
 *
 * GET: Vercel Cron (CRON_SECRET). POST: manual run, which also needs
 * SUPPLIER_JOB_SECRET in `x-job-secret` (SEC-8). Vercel Cron calls the GET
 * every 15 minutes (vercel.json, pilot A10); it answers `skipped` while the
 * adapter is `mock`. The scheduled GET answers `skipped` and touches no data
 * while `SCHEDULED_BOOKING_JOBS_ENABLED` is not "true" (review fix 4); the
 * manual POST is not gated.
 */
async function scheduled(req: NextRequest) {
  requireCron(req);
  const off = scheduledBookingJobsOff();
  if (off) return json(off);
  return run();
}

async function manual(req: NextRequest) {
  requireCron(req);
  requireJobSecret(req);
  return run();
}

async function run() {
  const config = traveldeskConfigFrom(env());
  if (!config) return json({ ok: true, skipped: "traveldesk not configured", ranAt: new Date().toISOString() });
  const summary = await supplierBookingService.reconcile({
    adapter: TravelDeskBookingAdapter.fromConfig(config),
    environment: config.environment,
    accountId: bookingAccountId(config.environment, config.agencyId),
  });
  return json({ ok: true, ...summary, issues: summary.issues.length });
}

export const GET = handle(scheduled);
export const POST = handle(manual);
