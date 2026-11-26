import "server-only";
import type { SupplierBooking } from "@prisma/client";
import { getDocumentStore } from "../documents/store";
import { env } from "../lib/env";
import { dbPaymentEvidence, paymentEvidenceFrom } from "../payments/evidence";
import { documentService } from "../services/document.service";
import { bookingAccountId, readControl, supplierBookingService, TRAVELDESK_SUPPLIER_CODE } from "../services/supplier-booking.service";
import { TravelDeskBookingAdapter } from "../suppliers/traveldesk/traveldesk.booking-adapter";
import { traveldeskConfigFrom } from "../suppliers/traveldesk/traveldesk.config";
import { TravelDeskDocumentSource } from "../suppliers/traveldesk/traveldesk.documents";
import { sagaNotifier } from "../wiring";

/**
 * The document step right after a supplier confirm (checkout redesign
 * batch 4, CO-40): at most `max` PDF rows of that booking, none started after
 * `budgetMs`. Each row is the documents tick's own claim, download,
 * validation and back-off (`documentService.runForBooking`); this only saves
 * the wait for the next tick.
 */
export const DOCUMENTS_AFTER_CONFIRM = Object.freeze({ budgetMs: 20_000, max: 2 });

/**
 * One supplier worker run (docs/backend/21 §15.3, doc 22 SEC-8), shared by
 * `/api/jobs/supplier-worker` and the ordered `/api/jobs/booking-tick`.
 *
 *  - `scheduled` (the cron secret alone): recovery, polling and the watchdog,
 *    plus the payment-backed mutations of order-item attempts (`paid_only`,
 *    B3, B5, doc 22 §32.22), and only with an operator's explicit control row
 *    for this environment and account that is not an emergency stop.
 *  - `manual` (the route's POST, which also checked SUPPLIER_JOB_SECRET):
 *    every mutation, under the same control-row rule.
 *
 * The control row, the payment evidence (re-read on the send transaction),
 * the pause and admission checks, the account lease and the job claims are
 * all read here and in the engine on every run, whoever calls it. Answers
 * `skipped` when TravelDesk is not configured (SUPPLIER_ADAPTER_TRAVELDESK
 * not live).
 *
 * With `documentsAfterConfirm` (the booking tick only; the supplier-worker
 * routes leave it off), each order-item booking the run confirmed with its
 * own confirm call is handed to `DOCUMENTS_AFTER_CONFIRM` once the job loop
 * is over (outside
 * every transaction, no lease held, never delaying a job); a failure there
 * is the documents tick's to pick up.
 */
export async function runSupplierWorker(kind: "scheduled" | "manual", opts: { budgetMs: number; mutationBudgetMs?: number; documentsAfterConfirm?: boolean; externalPollWaits?: number }) {
  const config = traveldeskConfigFrom(env());
  if (!config) return { ok: true as const, skipped: "traveldesk not configured", ranAt: new Date().toISOString() };
  const accountId = bookingAccountId(config.environment, config.agencyId);
  let mutations: boolean | "paid_only" = false;
  if (accountId) {
    const { control, explicit } = await readControl(TRAVELDESK_SUPPLIER_CODE, config.environment, accountId);
    if (explicit && !(control.paused && control.scope === "all_writes")) mutations = kind === "manual" ? true : "paid_only";
  }
  // Only the booking tick asks for it (follow-up 2): the supplier-worker routes behave as before batch 4.
  const store = opts.documentsAfterConfirm === true ? getDocumentStore() : null;
  const documents = store ? { source: TravelDeskDocumentSource.fromConfig(config), store, now: () => new Date() } : null;
  const result = await supplierBookingService.runDueJobs(
    {
      adapter: TravelDeskBookingAdapter.fromConfig(config),
      environment: config.environment,
      mutationTimeoutMs: config.mutationTimeoutMs,
      accountId,
      mutations,
      payments: dbPaymentEvidence,
      paymentsInTx: paymentEvidenceFrom,
      saga: sagaNotifier,
      afterConfirmed: documents ? (b: SupplierBooking) => documentService.runForBooking(documents, b.id, DOCUMENTS_AFTER_CONFIRM) : undefined,
    },
    {
      budgetMs: Math.max(0, opts.budgetMs),
      ...(opts.mutationBudgetMs === undefined ? {} : { mutationBudgetMs: Math.max(0, opts.mutationBudgetMs) }),
      // Doc 29 Batch 6: only the booking tick asks for in-run waits for external polls.
      ...(opts.externalPollWaits ? { externalPollWaits: opts.externalPollWaits } : {}),
    },
  );
  return { ok: true as const, environment: config.environment, mutations, ...result, ranAt: new Date().toISOString() };
}
