import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Production crons (checkout redesign batch 4, CO-37; pilot-day checklist
 * A10, doc 28 §5; doc 22 §32.23). Parses vercel.json:
 *
 *  - the payment, supplier and document jobs are scheduled at the cadence
 *    A10 asks for: payments-tick and supplier-worker every minute (as the one
 *    ordered booking-tick, CO-38), documents-tick every 2 minutes,
 *    supplier-reconcile every 15 minutes; the three older crons unchanged;
 *    the catalogue sync once a day at 03:00 Dubai time (doc 29 Batch 1b);
 *    the retention purge once a day at 02:45 UTC (doc 26 §2, Batch 1c);
 *  - payments-tick and supplier-worker are not also scheduled on their own
 *    (they would fire beside the booking tick, undoing its order);
 *  - every cron path is a job route that exists, exports GET and checks
 *    CRON_SECRET with `requireCron` (Vercel Cron sends it as
 *    `Authorization: Bearer`), with no query string (no secret in a URL);
 *
 * That the booking tick runs the payments step and then the worker's
 * scheduled run, with each step's guards, and that the new crons are gated
 * by SCHEDULED_BOOKING_JOBS_ENABLED, is tested by calling the routes
 * (src/app/api/jobs/__tests__/booking-tick.route.test.ts), not by reading
 * their source.
 */

const ROOT = process.cwd();
const vercel = JSON.parse(readFileSync(path.join(ROOT, "vercel.json"), "utf8")) as { crons?: Array<{ path: string; schedule: string }> };
const crons = vercel.crons ?? [];
const routeFile = (p: string) => path.join(ROOT, "src/app", p, "route.ts");
const src = (p: string) => readFileSync(routeFile(p), "utf8");

const REQUIRED: Record<string, string> = {
  "/api/jobs/booking-tick": "* * * * *",
  "/api/jobs/documents-tick": "*/2 * * * *",
  "/api/jobs/supplier-reconcile": "*/15 * * * *",
  "/api/jobs/inquiry-sweep": "*/5 * * * *",
  "/api/jobs/offline-conversions": "30 3 * * *",
  "/api/jobs/fx-refresh": "30 4,16 * * *",
  // Doc 29 Batch 1b: the daily read-only catalogue sync, 23:00 UTC = 03:00 in Dubai.
  "/api/jobs/catalogue-sync": "0 23 * * *",
  "/api/jobs/retention-purge": "45 2 * * *",
};

describe("vercel.json crons", () => {
  it("schedules exactly the required jobs at the required cadence, each once", () => {
    expect(Object.fromEntries(crons.map((c) => [c.path, c.schedule]))).toEqual(REQUIRED);
    expect(crons).toHaveLength(Object.keys(REQUIRED).length);
  });

  it("does not schedule payments-tick or supplier-worker beside the ordered booking tick", () => {
    const paths = crons.map((c) => c.path);
    expect(paths).not.toContain("/api/jobs/payments-tick");
    expect(paths).not.toContain("/api/jobs/supplier-worker");
  });

  it("every cron is a five-field schedule on an existing job route that requires the cron secret on GET", () => {
    for (const c of crons) {
      expect(c.schedule.split(" "), c.path).toHaveLength(5);
      expect(c.path, c.path).toMatch(/^\/api\/jobs\/[a-z-]+$/);
      expect(existsSync(routeFile(c.path)), c.path).toBe(true);
      const s = src(c.path);
      expect(s, c.path).toMatch(/export const GET = handle(?:<[^>]*>)?\(/);
      expect(s, c.path).toMatch(/import\s*\{[^}]*\brequireCron\b[^}]*\}\s*from\s*"@\/server\/lib\/http"/);
      const max = /export const maxDuration = (\d+);/.exec(s);
      expect(max, c.path).not.toBeNull();
      // Vercel Pro's ceiling for a function, and above it the locks would outlive no run.
      expect(Number(max![1]), c.path).toBeLessThanOrEqual(300);
    }
  });
});
