import "server-only";
import { isAppError } from "../lib/errors";
import { log } from "../lib/logger";

/**
 * The ordered booking tick (checkout redesign batch 4, CO-38, CO-39): the
 * payments step, then the supplier worker, in one run, so a reserve job the
 * payments step queues for a verified payment is picked up by the worker of
 * the same run instead of waiting for the next one (about 25 s on the local
 * 20 s loop, up to a minute with per-minute crons).
 *
 * Isolation: each step is the same function its own route runs, with every
 * one of its guards (claims, compare-and-set, idempotency keys, the control
 * row, payment evidence, lease, admission). Nothing passes from the first
 * step to the second. A step that throws is logged like the old routes did
 * (`log.error`, redacted, with the error) and the other step runs
 * regardless; the run answers `ok: false` so the cron log shows it.
 *
 * Time (review fix 1, follow-up 4). The payments step is capped
 * (`paymentsCapMs`: nothing new is started after it; work in hand
 * finishes). The supplier step gets:
 *  - `budgetMs`: what is left of `budgetMs` (no job claimed after it), as
 *    before;
 *  - `mutationBudgetMs`: the window its mutations are measured against, from
 *    its own start: `mutationWindowMs`, but never more than
 *    `killMs - paymentsElapsed - mutationEndBeforeKillMs + mutationStartMarginMs`.
 *    The engine starts a mutation only with its timeout plus
 *    `mutationStartMarginMs` (30 s) of that budget left,
 *    so every mutation ends at least `mutationEndBeforeKillMs` before
 *    `killMs`. With the payments step inside its cap the worker keeps the
 *    window a standalone worker run has; a step that overran shortens it.
 */
export interface SupplierStepBudget {
  budgetMs: number;
  mutationBudgetMs: number;
}

export interface BookingTickSteps<P, S> {
  payments: (capMs: number) => Promise<P>;
  supplier: (budget: SupplierStepBudget) => Promise<S>;
}

export interface BookingTickOptions {
  /** No supplier job is claimed after this, counted from the tick's start (maxDuration less 30 s spare). */
  budgetMs: number;
  /** The function's hard limit (maxDuration). */
  killMs: number;
  /** The supplier worker's own mutation window, as a standalone run has it (maxDuration less 30 s spare). */
  mutationWindowMs: number;
  /** The payments step's cap. */
  paymentsCapMs: number;
  /** How long before `killMs` the latest possible mutation must have ended. */
  mutationEndBeforeKillMs: number;
  /** The engine's rule: a mutation starts only with its timeout plus this much of `mutationBudgetMs` left (`MUTATION_START_MARGIN_MS`). */
  mutationStartMarginMs: number;
  clock?: () => number;
}

export type StepResult<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface BookingTickResult<P, S> {
  ok: boolean;
  payments: StepResult<P>;
  supplier: StepResult<S>;
  supplierBudget: SupplierStepBudget;
  ranAt: string;
}

async function step<T>(name: "payments" | "supplier", run: () => Promise<T>): Promise<StepResult<T>> {
  try {
    const out = await run();
    return { ...(out as T), ok: true } as StepResult<T>;
  } catch (e) {
    const code = isAppError(e) ? e.code : "internal";
    // As errorResponse (http.ts) logged a 5xx for the old routes: the code, the AppError's message, or the error itself
    // when it is not an AppError; the logger redacts both.
    log.error("jobs.tick_step_failed", { step: name, errorCode: code, message: isAppError(e) ? e.message : undefined, error: isAppError(e) ? undefined : e });
    return { ok: false, error: code };
  }
}

export async function runBookingTick<P extends object, S extends object>(steps: BookingTickSteps<P, S>, opts: BookingTickOptions): Promise<BookingTickResult<P, S>> {
  const clock = opts.clock ?? Date.now;
  const started = clock();
  const payments = await step("payments", () => steps.payments(opts.paymentsCapMs));
  const paymentsElapsed = Math.max(0, clock() - started);
  const supplierBudget: SupplierStepBudget = {
    budgetMs: Math.max(0, opts.budgetMs - paymentsElapsed),
    mutationBudgetMs: Math.max(0, Math.min(opts.mutationWindowMs, opts.killMs - paymentsElapsed - opts.mutationEndBeforeKillMs + opts.mutationStartMarginMs)),
  };
  const supplier = await step("supplier", () => steps.supplier(supplierBudget));
  return { ok: payments.ok && supplier.ok, payments, supplier, supplierBudget, ranAt: new Date().toISOString() };
}
