import type { NextRequest } from "next/server";
import { handle, json, requireCron, requireJobSecret } from "@/server/lib/http";
import { runSupplierWorker } from "@/server/jobs/supplier-worker-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** A TravelDesk mutation may take up to TRAVELDESK_TIMEOUT_MS (150 s); the run keeps 30 s spare. */
export const maxDuration = 300;

/**
 * /api/jobs/supplier-worker — runs due supplier booking jobs (docs/backend/21
 * §15.3, doc 22 SEC-8).
 *
 *  - GET (Vercel Cron, CRON_SECRET): recovery, polling and the watchdog, plus
 *    the two mutations a customer's payment backs (B3, `paid_only`), for
 *    order-item attempts only: the reserve, sent only while the item's
 *    payment saga holds a provider-verified capture, or a verified card
 *    authorization inside RESERVE_REQUIRES (CR-B3-5), and the confirm, sent
 *    only on provider-verified capture (`dbPaymentEvidence`, re-read on the
 *    send transaction) inside the hold's deadline. Even those need an
 *    operator's explicit control row for this environment and account that
 *    is not an emergency stop, and reserves still pass the pause and
 *    admission checks. It also sends two cancels of order-item attempts:
 *    one an open supported customer cancellation request names (B5), and
 *    the payment saga's hold release of an attempt no confirm was ever sent
 *    for (doc 22 §32.22), so a failed multi-item order's earlier holds stop
 *    debiting the TravelDesk balance. A `new_sales` pause never holds a
 *    cancel (SUP-2); the mutation window, the lease and the lane still
 *    apply. The cron secret alone can never cause a drill reserve or
 *    confirm, a create or any other cancel to be sent; those stay
 *    manual-POST-only until the pilot.
 *  - POST (manual, CRON_SECRET and SUPPLIER_JOB_SECRET in `x-job-secret`):
 *    may also send every other mutation, under the same control-row rule. A
 *    `new_sales` pause still holds reserves and creates in the engine.
 *
 * Production does not schedule this route on its own: Vercel Cron calls
 * `/api/jobs/booking-tick`, which runs the payments step and then this same
 * scheduled run (`runSupplierWorker("scheduled")`), in that order (checkout
 * redesign batch 4, CO-38; vercel.json). It answers `skipped` while
 * TravelDesk is not live. Mutations need TRAVELDESK_BOOKINGS_ENABLED=true, and
 * in production TRAVELDESK_AGENCY_ID too (travelDeskMutationRefusal).
 *
 * This route does not fetch vouchers right after a confirm (that is the
 * booking tick's, CO-40); `documents-tick` does, as before batch 4.
 */
async function scheduled(req: NextRequest) {
  requireCron(req);
  return json(await runSupplierWorker("scheduled", { budgetMs: (maxDuration - 30) * 1000 }));
}

async function manual(req: NextRequest) {
  requireCron(req);
  requireJobSecret(req);
  return json(await runSupplierWorker("manual", { budgetMs: (maxDuration - 30) * 1000 }));
}

export const GET = handle(scheduled);
export const POST = handle(manual);
