import type { NextRequest } from "next/server";
import { getDocumentStore } from "@/server/documents/store";
import { env } from "@/server/lib/env";
import { handle, json, requireCron } from "@/server/lib/http";
import { scheduledBookingJobsOff } from "@/server/jobs/schedule-switch";
import { documentService } from "@/server/services/document.service";
import { issueDue, reconcileRefunds } from "@/server/services/fiscal-document.service";
import { drawPendingFiscal, generatePendingEntries } from "@/server/services/generated-document.service";
import { notificationService } from "@/server/services/notification.service";
import { keyRewrapService, REWRAP_BUDGET_PER_TICK } from "@/server/services/key-rewrap.service";
import { TRAVELDESK_SUPPLIER_CODE } from "@/server/services/supplier-booking.service";
import { TravelDeskDocumentSource } from "@/server/suppliers/traveldesk/traveldesk.documents";
import { traveldeskConfigFrom } from "@/server/suppliers/traveldesk/traveldesk.config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Rows claimed per run. */
const MAX_PER_RUN = 25;
/** Stored objects re-read per run (SEC-13 audit, random sample). Each is one GetObject of up to 10 MiB. */
const AUDIT_PER_RUN = 3;
/**
 * Time left after the budget for the row (or audited object) in hand: a
 * supplier read and a store call at their default 20 s timeouts, plus the
 * writes. A row that still overruns is killed with the run; its lock
 * (TICKET_TIMING.claimLockMs, longer than maxDuration) holds until then, and
 * an object put but not committed is still recorded on its row.
 */
const LAST_ROW_RESERVE_S = 60;
/** Group C: fiscal files drawn per run (tens of milliseconds each). */
const FISCAL_FILES_PER_RUN = 25;
/** Group C: branded entry files per run (locate, build and verify: about a second each). */
const ENTRY_FILES_PER_RUN = 3;

/**
 * /api/jobs/documents-tick — the supplier document step (doc 22 §23 B4; F12,
 * F13, F36, F47, F48). GET for Vercel Cron and POST for manual runs, both
 * with CRON_SECRET:
 *
 *  - confirmed order-item bookings with no ticket-codes row get a pending
 *    one (F47 detection);
 *  - a ticket still missing after 2 minutes raises attention, urgent at
 *    5 minutes or earlier near the activity start (F12);
 *  - due document reads (one per row per run, only where issuance is
 *    evidenced, SUP-4) and PDF downloads, validated and stored privately;
 *  - with time left, a few stored PDFs are re-read and compared with their
 *    checksums; a missing or changed one is quarantined and refetched
 *    (SEC-13, F36). A random sample each run: no cursor to keep;
 *  - last, a few stored ticket codes and kept capability tokens under an
 *    older ring key are re-wrapped under the active key (R-B4-10,
 *    `keyRewrapService`); counts only.
 *
 * Group C (doc 93), each step bounded, counts only, never throwing:
 *  - first, the payment confirmation email for captures of the last 30
 *    minutes that have none yet (C2, before the ticket email where possible);
 *  - after the document work: fiscal numbering and drawing (switch
 *    FISCAL_DOCUMENTS_ENABLED, off by default), the refund reconciliation
 *    (always; detection only), and the branded entry PDF (switch
 *    BRANDED_ENTRY_PDF_ENABLED, off by default).
 *
 * The TravelDesk document source exists only when TravelDesk is live and
 * configured; otherwise nothing is read and the run only sweeps and raises
 * attention. Without a document store PDFs stay pending. Vercel Cron calls
 * the GET every 2 minutes (vercel.json, pilot A10). A voucher due right
 * after a supplier confirm is usually fetched by the supplier worker already
 * (checkout redesign batch 4, CO-40, `documentService.runForBooking`); this
 * job is the net for everything else, under the same row claims.
 *
 * The scheduled GET answers `skipped` and touches no data while
 * `SCHEDULED_BOOKING_JOBS_ENABLED` is not "true" (review fix 4, pilot-day
 * A10). The manual POST is not gated.
 */
async function scheduled(req: NextRequest) {
  requireCron(req);
  const off = scheduledBookingJobsOff();
  if (off) return json(off);
  return run();
}

async function manual(req: NextRequest) {
  requireCron(req);
  return run();
}

async function run() {
  const config = traveldeskConfigFrom(env());
  const source = config ? TravelDeskDocumentSource.fromConfig(config) : null;
  const store = getDocumentStore();
  const now = new Date();
  const paymentReceived = await notificationService.sweepPaymentReceived(now);
  const result = await documentService.runDue(
    { source, store, now: () => new Date() },
    { budgetMs: (maxDuration - LAST_ROW_RESERVE_S) * 1000, max: MAX_PER_RUN, supplierCode: TRAVELDESK_SUPPLIER_CODE, auditMax: AUDIT_PER_RUN },
  );
  // After the document work, with a small fixed budget: never throws, counts only.
  const rewrap = await keyRewrapService.run(REWRAP_BUDGET_PER_TICK);
  const fiscal = await issueDue({ now: new Date() });
  const fiscalFiles = await drawPendingFiscal({ store, now: new Date(), max: FISCAL_FILES_PER_RUN });
  const refundReconciliation = await reconcileRefunds(new Date());
  const entryFiles = await generatePendingEntries({ store, now: new Date(), max: ENTRY_FILES_PER_RUN });
  return json({
    ok: true,
    source: source ? source.supplierCode : null,
    store: store ? store.kind : null,
    ...result,
    rewrap,
    paymentReceived,
    fiscal,
    fiscalFiles,
    refundReconciliation,
    entryFiles,
    ranAt: new Date().toISOString(),
  });
}

export const GET = handle(scheduled);
export const POST = handle(manual);
