import type { NextRequest } from "next/server";
import { getDocumentStore } from "@/server/documents/store";
import { env } from "@/server/lib/env";
import { handle, json, requireCron } from "@/server/lib/http";
import { scheduledBookingJobsOff } from "@/server/jobs/schedule-switch";
import { documentService } from "@/server/services/document.service";
import { issueDue, reconcileRefunds } from "@/server/services/fiscal-document.service";
import { drawPendingFiscal, generatePendingEntries, sweepErasedObjects } from "@/server/services/generated-document.service";
import { runMonthlyExport } from "@/server/services/fiscal-export.service";
import { EMAIL_SEND_UNIT_MS, notificationService } from "@/server/services/notification.service";
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
/**
 * Group C (review 102 finding 10): every Group C step runs AFTER the
 * document work and shares one deadline, this many seconds before
 * maxDuration. Each step starts a unit (one email, one issue, one file) only
 * with that unit's worst-case time left, so a slow email provider or a slow
 * file can never push the run past maxDuration; what is left waits for the
 * next tick.
 */
const GROUP_C_END_BEFORE_MAX_S = 8;
/** Group C: payment emails per run (finding 10: at most this many, at most PAYMENT_EMAIL_BUDGET_S). */
const PAYMENT_EMAILS_PER_RUN = 5;
const PAYMENT_EMAIL_BUDGET_S = 10;
/** Group C: follow-up invoice emails per run (finding 14). */
const INVOICE_EMAILS_PER_RUN = 5;
/** Time the refund reconciliation needs to start (one query and its updates). */
const RECONCILE_UNIT_MS = 5_000;
/** Group C: fiscal files drawn per run (tens of milliseconds each). */
const FISCAL_FILES_PER_RUN = 25;
/** Group C: branded entry files per run (locate, build and verify: about a second each). */
const ENTRY_FILES_PER_RUN = 3;
/** Group C (review 109c N2): objects of erased files whose delete failed, retried per run. */
const ERASED_OBJECTS_PER_RUN = 10;

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
 * Group C (doc 93), after the document work, each step bounded by a shared
 * deadline (review 102 finding 10), counts only, never throwing:
 *  - fiscal numbering and drawing (switch FISCAL_DOCUMENTS_ENABLED, off by
 *    default), first, so a payment email written in this run can already
 *    carry its invoice (O8);
 *  - the payment confirmation email for captures of the last 30 minutes that
 *    have none yet (C2; kill switch PAYMENT_RECEIVED_EMAIL_ENABLED, off by
 *    default), at most 5 and 10 seconds;
 *  - the follow-up invoice email for an invoice no payment email carried
 *    (finding 14; fiscal switch);
 *  - the refund reconciliation (always; detection only), and the branded
 *    entry PDF (switch BRANDED_ENTRY_PDF_ENABLED, off by default).
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
  const startedAt = Date.now();
  const result = await documentService.runDue(
    { source, store, now: () => new Date() },
    { budgetMs: (maxDuration - LAST_ROW_RESERVE_S) * 1000, max: MAX_PER_RUN, supplierCode: TRAVELDESK_SUPPLIER_CODE, auditMax: AUDIT_PER_RUN },
  );
  // After the document work, with a small fixed budget: never throws, counts only.
  const rewrap = await keyRewrapService.run(REWRAP_BUDGET_PER_TICK);
  // Group C: one shared deadline for every step below (finding 10).
  const deadline = startedAt + (maxDuration - GROUP_C_END_BEFORE_MAX_S) * 1000;
  const fiscal = await issueDue({ now: new Date(), deadline });
  const fiscalFiles = await drawPendingFiscal({ store, now: new Date(), max: FISCAL_FILES_PER_RUN, deadline });
  // An email send starts only with its worst case left before the deadline, and only within the step's own budget.
  const emailStartBy = () => Math.min(deadline - EMAIL_SEND_UNIT_MS, Date.now() + PAYMENT_EMAIL_BUDGET_S * 1000);
  const paymentReceived = await notificationService.sweepPaymentReceived(new Date(), PAYMENT_EMAILS_PER_RUN, {}, { startBy: emailStartBy() });
  const invoiceEmails = await notificationService.sweepInvoiceIssued(new Date(), INVOICE_EMAILS_PER_RUN, {}, { startBy: emailStartBy() });
  const refundReconciliation = Date.now() + RECONCILE_UNIT_MS <= deadline ? await reconcileRefunds(new Date()) : { skipped: "no_time" as const };
  // C-P4: the monthly CSV for the accountant (once per month, from the 1st, Dubai), then N2's delete retries.
  const accountantExport = await runMonthlyExport(new Date(), { deadline }).catch(() => ({ skipped: "error" as const }));
  const erasedObjects = await sweepErasedObjects({ store, max: ERASED_OBJECTS_PER_RUN, deadline });
  const entryFiles = await generatePendingEntries({ store, now: new Date(), max: ENTRY_FILES_PER_RUN, deadline });
  return json({
    ok: true,
    source: source ? source.supplierCode : null,
    store: store ? store.kind : null,
    ...result,
    rewrap,
    paymentReceived,
    invoiceEmails,
    fiscal,
    fiscalFiles,
    refundReconciliation,
    accountantExport,
    erasedObjects,
    entryFiles,
    ranAt: new Date().toISOString(),
  });
}

export const GET = handle(scheduled);
export const POST = handle(manual);
