import "server-only";
import { runPaymentsTick } from "../payments/inbox";
import { paymentSaga } from "../payments/saga";
import { createCancellationService } from "../services/cancellation.service";

/**
 * One payments job run, shared by `/api/jobs/payments-tick` and the ordered
 * `/api/jobs/booking-tick` (checkout redesign batch 4, CO-38): the webhook
 * inbox, then every payment saga not at rest (`runPaymentsTick`: capture
 * reads, hold and payment deadlines, releases, refunds; doc 22 §23 B3, F1,
 * F3, F30), then the customer cancellation step (B5, F15, F51): a verified
 * operator cancel opens the item's refund (driven at once with the saga's
 * refund driver), a refused cancel closes the request, and a refund's
 * outcome ends it. It never sends a supplier mutation itself; reserves and
 * cancels are the supplier worker's. Every claim, compare-and-set and
 * idempotency key is the inbox's and the saga's own, so two runs at once
 * repeat nothing.
 */
const cancellations = createCancellationService({ driveRefund: (id) => paymentSaga.refunds.drive(id) });

/**
 * The booking tick's hard cap on its payments step (review fix 1): no inbox
 * row, saga or cancellation is started after it. Work already in hand always
 * finishes (one provider call at its own timeout). 45 s (follow-up 4):
 * 45 s + the worker's 90 s mutation window + a 150 s mutation = 285 s, 15 s
 * inside the tick's 300 s `maxDuration`, and the sagas keep up to 45 s less
 * the inbox (the starvation alarm is scaled to it, `starvedAfter`).
 */
export const PAYMENTS_STEP_CAP_MS = 45_000;

/**
 * Without `capMs`: the payments-tick route, unchanged. With it: the same
 * steps, none started once `capMs` has passed since the call.
 */
export async function runPaymentsJob(opts: { capMs?: number; clock?: () => number } = {}) {
  if (opts.capMs === undefined) {
    const summary = await runPaymentsTick();
    const cancellationSummary = await cancellations.advanceOpen({ max: 50 });
    return { ...summary, cancellations: cancellationSummary };
  }
  const clock = opts.clock ?? (() => performance.now());
  const deadline = clock() + opts.capMs;
  const summary = await runPaymentsTick(undefined, undefined, { deadline, clock });
  const cancellationSummary = await cancellations.advanceOpen({ max: 50, stop: () => clock() >= deadline });
  return { ...summary, cancellations: cancellationSummary };
}
