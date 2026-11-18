import "server-only";
import { env } from "../lib/env";

/**
 * The release switch for the scheduled booking jobs (review fix 4,
 * `SCHEDULED_BOOKING_JOBS_ENABLED`). A cron GET checks it right after
 * `requireCron` and, while it is off, answers this without touching data.
 */
export function scheduledBookingJobsOff(): { ok: true; skipped: "scheduled booking jobs off"; ranAt: string } | null {
  return env().SCHEDULED_BOOKING_JOBS_ENABLED === true ? null : { ok: true, skipped: "scheduled booking jobs off", ranAt: new Date().toISOString() };
}
