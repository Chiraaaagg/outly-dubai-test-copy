import type { NextRequest } from "next/server";
import { handle, json, requireCron } from "@/server/lib/http";
import { runPaymentsJob } from "@/server/jobs/payments-job";
import "@/server/wiring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * /api/jobs/payments-tick — processes the payment webhook inbox, then advances
 * every payment saga not at rest: capture-unknown reads, hold and payment
 * deadlines, releases and refunds (doc 22 §23 B3, F1, F3, F30), then the
 * customer cancellation step (B5, F15, F51). GET and POST, both with
 * CRON_SECRET. It never creates a supplier booking by itself: attempts start
 * only from a verified payment and the engine still applies its own controls.
 *
 * Production does not schedule this route on its own: Vercel Cron calls
 * `/api/jobs/booking-tick`, which runs this same step (`runPaymentsJob`) and
 * then the supplier worker, in that order (checkout redesign batch 4, CO-38;
 * vercel.json). This route stays for manual runs.
 */
async function run(req: NextRequest) {
  requireCron(req);
  return json({ ok: true, ...(await runPaymentsJob()), ranAt: new Date().toISOString() });
}

export const GET = handle(run);
export const POST = handle(run);
