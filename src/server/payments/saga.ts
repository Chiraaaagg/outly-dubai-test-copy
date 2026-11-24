import "server-only";
import { Prisma, type Payment, type PaymentSaga, type PaymentStatus } from "@prisma/client";
import { prisma, TX_OPTIONS, type Tx } from "../lib/db";
import { isAppError } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { log } from "../lib/logger";
import { emitEvent } from "../lib/structured-events";
import { itemPayableMinor, orderService } from "../services/order.service";
import { analyticsService, type VerifiedEventName } from "../services/analytics.service";
import { capabilityService } from "../services/capability.service";
import {
  RESERVE_REQUIRES,
  sagaFor,
  type EngineSagaApi,
  type GatewayAccount,
  type GatewayPaymentSnapshot,
  type MethodCapabilities,
  type PaymentGateway,
  type PaymentRail,
  type PaymentSagaState,
  type SagaNotifier,
  type VerifiedGatewayEvent,
} from "./contracts";
import { appendOnce, lockPayment } from "./ledger";
import { closeRelease, closeWaitingRemedies, createRefundDriver, isDisputeType, openPendingRefund, openRefund, openRelease, refundableMinor, refundedOutsideOutlyMinor, RefundRefused, type RefundDriver } from "./refunds";
import { paymentGateways, type GatewayRegistry } from "./registry";
import { enqueueCrmSyncForOrders } from "../crm/crm.outbox";

/**
 * Payment saga (doc 22 §22.1 item 6, §23 B3; PAY-1 to PAY-6, PAY-13; F1–F5,
 * F9, F10, F29, F42–F46, F56). One saga per instant order, one item.
 *
 * The saga is a reconciler. Every `advance` reads the provider's
 * authenticated view of the payment (`getPayment`; a webhook only says
 * "look"), the engine's view of the supplier attempt (`BookingStateReader`)
 * and the saga row, then takes at most one step, compare-and-set on
 * `version`. Running it twice, late, or after a crash repeats nothing:
 * gateway mutations use stable idempotency keys (`capture:<payment>`,
 * `void:<payment>`, the refund row's key), and the engine is asked through
 * `EngineSagaApi` only (nothing here writes `supplier_bookings`).
 *
 * Order of operations follows the method (`sagaFor`):
 *  - hold (card): authorized, with 3DS and risk inside `RESERVE_REQUIRES` →
 *    `startAttempt` (reserve) → on `awaiting_payment` capture the full
 *    amount, but only before the engine's confirm send-by minus
 *    `CAPTURE_BUDGET_MS` (an unknown send-by never captures) →
 *    `confirmIfPaid`. A capture with no answer is `capture_unknown`: the same
 *    payment is re-read and the capture re-sent with the same key, never
 *    voided or charged again first (F3). Still unresolved at the send-by, the
 *    saga never confirms: it asks the engine to release the hold and keeps
 *    reading; a capture that appears later is refunded automatically (F9,
 *    PAY-2).
 *  - capture first (UPI, debit at authorization): captured (capturing a
 *    debited authorization first) → `startAttempt` → `confirmIfPaid`.
 *
 * Only an attempt that moved money is bound to the order: a declined or
 * unfinished attempt binds nothing and fails nothing while the session lives,
 * and the customer's next successful attempt on the same provider order is
 * the payment. Any later successful attempt is a duplicate, refunded or
 * voided once and recorded (F45). Open sessions, and closed sagas inside the
 * late-money window, are reconciled by provider order on the job, so a lost
 * webhook loses no money (F1). Without the provider's read an inbox event is
 * retried, never processed.
 *
 * Money goes back only after the supplier hold is gone. Every remedy first
 * asks the engine to release the hold (`releaseHold` records
 * `release_requested`, after which no confirm is sent) and waits in
 * `release_pending` until the attempt shows it released; if the engine
 * refuses because a confirm was already sent, the saga waits in
 * `confirm_pending` for the supplier: confirmed keeps the capture, a failure
 * refunds. A definite supplier failure (rejected, not created, expired,
 * cancelled) releases an uncaptured hold (void, or the provider's automatic
 * release) or refunds the captured allocation in full (F4, F5, F43, F44). A
 * reserve with no answer by its deadline (the quote expiry plus
 * `RESERVE_BUDGET_MS`, the service date, the authorization's life) is
 * remedied the same way and flagged (F6, F21). Payment after the quote
 * expired, or learnt of later than `STALE_QUOTE_GRACE_MS` after it, is
 * refunded or released, never booked (F46, `LATE_PAYMENT_POLICY`). A
 * mismatch between the provider's read and the payment row (account,
 * provider, currency, amount, provider order) stops the saga in `attention`
 * and moves no money (F2). A dispute or chargeback is recorded, freezes
 * refunds and flags the saga; nothing else is automated (F56). Confirm with
 * no answer is left to the engine, never re-confirmed; past the deadline the
 * saga is flagged for a human (F42).
 *
 * Multi-item orders (owner decision of 3 November 2026, doc 22 §32.16; lead
 * design, multi-item, lead-approved 3 Nov 2026). One saga and one payment per
 * order; every `instant_checkout` item of the order is the saga's, in
 * `order_items.quote_line_index` order (`itemsOf`). All or nothing until the
 * capture:
 *  - the items are reserved one at a time (`startAttempt` for the next item
 *    only once every earlier one is `awaiting_payment`), so the supplier lane
 *    sees them in position order and a crash between items resumes from the
 *    attempts already made;
 *  - any definite reservation failure releases every hold already taken and
 *    voids the payment (capture first: refunds it in full, item by item);
 *  - an unknown reservation outcome flags the saga and starts no further
 *    item; it never captures, and nothing is voided while that hold might
 *    exist (the release waits for the engine, as for one item);
 *  - the whole amount is captured once, only when every item is reserved and
 *    before the earliest item's confirm send-by less `CAPTURE_BUDGET_MS`; a
 *    next item is reserved only while `ITEM_RESERVE_BUDGET_MS` more fits
 *    before that point. Out of time: release everything and void.
 * After the capture each item stands alone (`confirmPendingMulti`): each is
 * confirmed through `confirmIfPaid`; a definite failure, an expiry or
 * `too_late` refunds exactly that item's allocation (its supplier hold
 * released first), marks the item `rejected`, and leaves the other items
 * confirmed. The saga ends `fulfilled` (order `partially_confirmed` when an
 * item was refunded) once every item is confirmed or refunded, or
 * `refunded` when none was confirmed. A failed item refund waits for the
 * other items, then stops the saga in `attention` (F16).
 */

/** How long before an authorization expires the saga stops trying to capture. */
export const PAYMENT_DEADLINE_BUFFER_MS = 5 * 60_000;
/** A hold is captured only this long before the engine's confirm send-by (`EngineSagaApi.confirmSendBy`), never later. */
export const CAPTURE_BUDGET_MS = 2 * 60_000;
/** A session with no payment after its deadline (quote or session expiry, the earlier), plus this, is closed as failed. */
export const SESSION_GRACE_MS = 30 * 60_000;
/** An open session this old is reconciled against the provider's list of payments for its order (F1). */
export const RECONCILE_AFTER_MS = 2 * 60_000;
/** The supplier must have answered the reserve by the quote expiry plus this (F6, F21). */
export const RESERVE_BUDGET_MS = 30 * 60_000;
/** A payment the saga learns of after the quote expiry plus this is refunded or released, never reserved on that quote (§22.2). */
export const STALE_QUOTE_GRACE_MS = 15 * 60_000;
/**
 * How long a `released` or `failed` saga is still read for late money (F46):
 * longer than the longest authorization lifetime (seven days, AED hold) plus a
 * day for a provider's late capture.
 */
export const LATE_MONEY_WINDOW_MS = 8 * 86_400_000;
/** How long a closed saga with no payment bound is reconciled by provider order (a late UPI success). */
export const LATE_SESSION_WINDOW_MS = 86_400_000;
/** A hold the provider releases by itself (no void) still reported authorized this long after its expiry is told to a human (F4). */
export const AUTO_RELEASE_GRACE_MS = 60 * 60_000;
/**
 * Multi-item: the least time left before the earliest held item must be
 * captured (`confirmSendBy` less `CAPTURE_BUDGET_MS`) for the saga to reserve
 * one more item. With less, the order is released instead: one more serial
 * supplier round trip would not fit. Multi-item, lead-approved 3 Nov 2026.
 */
export const ITEM_RESERVE_BUDGET_MS = 2 * 60_000;
/** Sagas not at rest one job run visits at most (CR-B3-14). */
export const TICK_LIVE_LIMIT = 400;
/** Closed sagas in the late-money watch one job run visits at most, on top of the live ones. */
export const TICK_WATCH_LIMIT = 100;
/**
 * A job run starts no saga after this long, so the run fits its route
 * (120 s) with the inbox before it and the duplicates and refunds after it
 * (at most 50 each).
 */
export const TICK_BUDGET_MS = 60_000;
/**
 * A live saga whose deadline falls between this long ago and
 * `URGENT_AHEAD_MS` from now is visited first, earliest deadline first: a
 * late run costs it money (a session closing, a reserve deadline, a capture
 * send-by). A deadline long past is no longer urgent; the saga is flagged or
 * waiting and takes its turn with the rest.
 */
export const URGENT_BEHIND_MS = 60 * 60_000;
export const URGENT_AHEAD_MS = 15 * 60_000;
/** Of the live budget, at most this share goes to urgent sagas, so the rest always get a turn. */
const URGENT_SHARE = 0.5;
/**
 * Of the time budget, this share is kept for the late-money watch whenever
 * the watch has sagas to read (B3 recheck N1): the live passes start no saga
 * after `TICK_BUDGET_MS * (1 - TICK_WATCH_MIN_SHARE)`, so sustained live load
 * cannot starve late money. With nothing to watch the live passes keep the
 * whole budget.
 */
export const TICK_WATCH_MIN_SHARE = 0.2;
/**
 * Consecutive runs that ran out of time with work left before the job raises
 * `payments.tick_starved` at error level (N1). The count is kept in the
 * `job_executions` row (`payments.tick`, `health`) and resets on a run that
 * finishes its work.
 */
export const TICK_STARVED_AFTER = 3;
/**
 * The streak that raises `payments.tick_starved` for a run with a smaller
 * time budget (the booking tick's capped payments step, checkout redesign
 * batch 4 review follow-up 4), so the alarm still means what it meant: about
 * `TICK_STARVED_AFTER` full budgets (3 × 60 s) of saga time in a row that
 * did not finish the work. A 60 s budget keeps 3; 45 s needs 4, 40 s 5. A
 * budget under 30 s counts as 30 s (at most 6 runs), so a run squeezed to
 * nothing cannot postpone the alarm further. `payments.tick_out_of_time`
 * still goes out on every short run, unchanged.
 */
export function starvedAfter(budgetMs: number): number {
  return Math.ceil((TICK_STARVED_AFTER * TICK_BUDGET_MS) / Math.max(Math.min(budgetMs, TICK_BUDGET_MS), TICK_BUDGET_MS / 2));
}
const TICK_PAGE = 50;

const TERMINAL: PaymentSagaState[] = ["fulfilled", "refunded", "released", "failed", "attention"];
/** The passes of one `advanceOpen` run, as reported in `payments.tick_*` events. */
type TickPass = "urgent" | "live" | "watch";
/** `job_executions` row that carries the tick's consecutive out-of-time count (N1). */
const TICK_HEALTH_JOB = "payments.tick";
const TICK_HEALTH_KEY = "health";
/** Closed sagas that still watch for late money, within `LATE_MONEY_WINDOW_MS`. */
const LATE_WATCH: PaymentSagaState[] = ["released", "failed"];
/** Supplier states that end the attempt without a booking (the frozen guard-releasing set). */
const BOOKING_FAILED = ["rejected", "not_created", "expired", "cancelled"];
/** A release the engine accepted earlier and is still carrying out. */
const RELEASE_IN_FLIGHT = ["cancelling", "cancel_unverified"];
/** A confirm is on its way or done. */
const CONFIRM_SENT = ["confirming", "confirmed", "awaiting_external"];
/** Supplier states where only a human can say whether the hold is gone. */
const RELEASE_NEEDS_HUMAN = ["cancel_refused", "manual_review"];
/** Supplier states whose reservation outcome is not known (multi-item: no further item is reserved, nothing is captured). */
const RESERVE_UNRESOLVED = ["outcome_unknown", "not_found_unresolved", "manual_review"];
/** Refund rows still moving. */
const REFUND_OPEN = ["requested", "accepted", "unknown"];

export interface BookingView {
  id: string;
  state: string;
  reservationDeadline: Date | null;
  /** Doc 29 Batch 6: the attempt is on the external-supplier route; absent reads as internal. */
  externalRoute?: boolean | null;
}

/** The engine's attempt for an order item, read only. */
export interface BookingStateReader {
  current(orderItemId: string): Promise<BookingView | null>;
}

export const dbBookingStateReader: BookingStateReader = {
  async current(orderItemId) {
    const b = await prisma.supplierBooking.findFirst({
      where: { orderItemId },
      orderBy: [{ attempt: "desc" }, { createdAt: "desc" }],
      select: { id: true, state: true, reservationDeadline: true, externalRoute: true },
    });
    return b ? { id: b.id, state: b.state, reservationDeadline: b.reservationDeadline, externalRoute: b.externalRoute } : null;
  },
};

export interface SagaDeps {
  gateways: GatewayRegistry;
  engine: EngineSagaApi;
  bookings: BookingStateReader;
  now: () => Date;
  refunds?: RefundDriver;
  /** Monotonic milliseconds for the job's time budget; `performance.now` unless a test drives it. */
  elapsedMs?: () => number;
}

/** Budgets for one `advanceOpen` run (CR-B3-14). */
export interface AdvanceOpenOptions {
  liveLimit?: number;
  watchLimit?: number;
  budgetMs?: number;
  /**
   * A caller's hard cap (the booking tick, checkout redesign batch 4 review
   * follow-up 1): asked before each duplicate settle and each refund drive
   * of the tail is started; once it says so the rest wait, unchanged, for the
   * next run. Work in hand always finishes. Without it the tail is unchanged.
   */
  stop?: () => boolean;
}

type SagaHead = Pick<PaymentSaga, "id" | "orderId" | "orderItemId" | "state" | "version" | "attentionRequiredAt">;

/**
 * One item of the saga's order, in position order (multi-item, lead-approved
 * 3 Nov 2026). `allocationMinor` is its payable share of the payment (null
 * on rows written before B2); `booking` is the engine's latest attempt.
 */
interface SagaItem {
  id: string;
  serviceDate: Date;
  status: string;
  allocationMinor: bigint | null;
  booking: BookingView | null;
}
type SagaRow = PaymentSaga & { payment: (Payment & { quote: { expiresAt: Date } | null }) | null; orderItem: { serviceDate: Date } };

/** One `advance`: whether to reconcile by provider order, and whether the last step lacked the provider's read. */
interface StepCtx {
  reconcile: boolean;
  readFailed: boolean;
}

/** What asking the engine to release the supplier hold showed. */
type SupplierRelease = "released" | "waiting" | "confirm_underway";

class LostRace extends Error {}

/** A retryable inbox failure with a short code (`payment_events.last_error_code`). */
export class InboxRetry extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "InboxRetry";
  }
}

function minusBuffer(d: Date | null | undefined): Date | null {
  return d ? new Date(d.getTime() - PAYMENT_DEADLINE_BUFFER_MS) : null;
}

function riskOk(s: GatewayPaymentSnapshot): boolean {
  return (RESERVE_REQUIRES.threeDs as readonly string[]).includes(s.threeDs) && (RESERVE_REQUIRES.risk as readonly string[]).includes(s.risk);
}

function fullyCaptured(p: Pick<Payment, "amountMinor">, s: GatewayPaymentSnapshot): boolean {
  return s.status === "captured" && s.capturedMinor >= p.amountMinor;
}

/** An attempt that moved money (authorized, or captured at any point). Only such a payment is ever bound or counted as a duplicate. */
export function successfulAttempt(s: Pick<GatewayPaymentSnapshot, "status" | "capturedMinor">): boolean {
  return s.status === "authorized" || s.capturedMinor > 0n;
}

/**
 * What the provider says against what Outly bound the payment to; null when
 * everything agrees. The environment is compared too: some providers use the
 * same account id in test and live mode (CR-B3-12).
 */
export function bindingMismatch(p: Pick<Payment, "provider" | "providerAccountId" | "environment" | "currency" | "amountMinor" | "providerOrderId" | "gatewayOrderId">, s: GatewayPaymentSnapshot, a: GatewayAccount): string | null {
  if (p.provider !== a.provider) return "provider_mismatch";
  if (p.environment !== a.environment) return "environment_mismatch";
  if (s.accountId !== a.accountId || p.providerAccountId !== a.accountId) return "account_mismatch";
  if (s.currency !== p.currency) return "currency_mismatch";
  if (s.amountMinor !== p.amountMinor) return "amount_mismatch";
  const boundOrder = p.providerOrderId ?? p.gatewayOrderId;
  if (!boundOrder || s.providerOrderId !== boundOrder) return "order_mismatch";
  if (s.capturedMinor > s.amountMinor || s.refundedMinor > s.capturedMinor) return "amounts_inconsistent";
  return null;
}

export function createPaymentSaga(deps: SagaDeps) {
  const db = prisma;
  const refunds = deps.refunds ?? createRefundDriver({ gateways: deps.gateways, now: deps.now });

  async function load(id: string): Promise<SagaRow | null> {
    return db.paymentSaga.findUnique({ where: { id }, include: { payment: { include: { quote: { select: { expiresAt: true } } } }, orderItem: { select: { serviceDate: true } } } });
  }

  /** Compare-and-set the saga row, with `effect` in the same transaction. */
  async function move(saga: SagaHead, to: PaymentSagaState, opts: { deadlineAt?: Date | null; attention?: boolean } = {}, effect?: (tx: Tx) => Promise<void>): Promise<void> {
    const now = deps.now();
    await db.$transaction(async (tx) => {
      const r = await tx.paymentSaga.updateMany({
        where: { id: saga.id, version: saga.version },
        data: {
          state: to,
          version: { increment: 1 },
          ...(opts.deadlineAt !== undefined ? { deadlineAt: opts.deadlineAt } : {}),
          ...(opts.attention ? { attentionRequiredAt: saga.attentionRequiredAt ?? now } : {}),
        },
      });
      if (r.count !== 1) throw new LostRace();
      if (effect) await effect(tx);
      if (to === "fulfilled") {
        // Multi-item: an item refunded on its own was marked `rejected`; the order is then partly confirmed.
        const rejected = await tx.orderItem.count({ where: { orderId: saga.orderId, status: "rejected" } });
        await orderService.applyPaymentOutcome(tx, saga.orderId, rejected > 0 ? "partially_confirmed" : "confirmed", now);
      }
      if (to === "refunded") {
        await orderService.applyPaymentOutcome(tx, saga.orderId, "refunded", now);
        // Batch 3 review: a fully refunded order ends its checkout download grant (emailed links and recovery stay).
        await capabilityService.revokeAllForOrders(tx, [saga.orderId], "order_cancelled", now, { issuedFor: ["checkout"] });
      }
      if (to === "released" || to === "failed") await orderService.applyPaymentOutcome(tx, saga.orderId, "payment_failed", now);
      // CRM outbox (doc 29 §6.2), last in the move: authorisation, capture, fulfilment, release and refund.
      await enqueueCrmSyncForOrders(tx, [saga.orderId]);
    }, TX_OPTIONS);
    log.info("payments.saga_moved", { sagaId: saga.id, from: saga.state, to });
    await recordVerifiedEvents(saga, to);
  }

  /**
   * Server analytics for a committed move (PRD-16, CR-B3-12). After the
   * commit, so a lost race or a rolled-back move records nothing, and an
   * analytics failure can never fail or undo the move (`emitVerified` never
   * throws and never forwards). A crash between the commit and this call
   * loses the event (at most once); the money state is unaffected.
   *  - leaving `session_created` for `authorized`, `captured` or
   *    `capture_unknown`: the provider's read showed an accepted payment;
   *  - `captured` and `confirm_pending`: every path into them has the
   *    provider's read of a full capture;
   *  - `fulfilled`: the engine reported the item's booking `confirmed`.
   */
  async function recordVerifiedEvents(saga: SagaHead, to: PaymentSagaState): Promise<void> {
    const names: VerifiedEventName[] = [];
    if (saga.state === "session_created" && (to === "authorized" || to === "captured" || to === "capture_unknown")) names.push("payment_authorized");
    if (to === "captured" || to === "confirm_pending") names.push("payment_captured");
    if (to === "fulfilled") names.push("supplier_confirmed");
    if (!names.length) return;
    try {
      for (const name of names) {
        if (name !== "supplier_confirmed") {
          await analyticsService.emitVerified({ name, orderId: saga.orderId, orderItemId: null, occurredAt: deps.now() });
          continue;
        }
        // One per confirmed item (multi-item: an item refunded on its own is not confirmed).
        const confirmed = await db.orderItem.findMany({ where: { orderId: saga.orderId, status: "confirmed" }, select: { id: true } });
        const ids = confirmed.length ? confirmed.map((i) => i.id) : [saga.orderItemId];
        for (const id of ids) await analyticsService.emitVerified({ name, orderId: saga.orderId, orderItemId: id, occurredAt: deps.now() });
      }
      if (to === "fulfilled") await analyticsService.emitIfPartiallyFulfilled(saga.orderId);
    } catch {
      // Analytics never stops the saga.
    }
  }

  async function flagAttention(saga: Pick<PaymentSaga, "id" | "state">, code: string) {
    await db.paymentSaga.updateMany({ where: { id: saga.id, attentionRequiredAt: null }, data: { attentionRequiredAt: deps.now() } });
    log.error("payments.saga_attention", { sagaId: saga.id, state: saga.state, code });
  }

  /** Write the provider's read onto the payment row; books a capture once (customer-money ledger). */
  async function syncPayment(payment: Payment, s: GatewayPaymentSnapshot, primary: boolean): Promise<void> {
    const at = deps.now();
    await db.$transaction(async (tx) => {
      await lockPayment(tx, payment.id);
      const cur = await tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
      const captured = s.capturedMinor > cur.capturedMinor ? s.capturedMinor : cur.capturedMinor;
      let refunded = s.refundedMinor > cur.refundedMinor ? s.refundedMinor : cur.refundedMinor;
      if (refunded > captured) refunded = captured;
      // Our own settled refunds can be ahead of the provider's read; never step back from them.
      const status: PaymentStatus = (cur.status === "refunded" || cur.status === "partially_refunded") && s.status === "captured" ? cur.status : s.status;
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status,
          capturedMinor: captured,
          refundedMinor: refunded,
          threeDs: s.threeDs,
          risk: s.risk,
          method: s.method ?? cur.method,
          authorizedAt: s.authorizedAt ? new Date(s.authorizedAt) : cur.authorizedAt,
          authorizationExpiresAt: s.authorizationExpiresAt ? new Date(s.authorizationExpiresAt) : cur.authorizationExpiresAt,
          capturedAt: captured > 0n ? (cur.capturedAt ?? at) : cur.capturedAt,
          voidedAt: s.status === "voided" ? (cur.voidedAt ?? at) : cur.voidedAt,
        },
      });
      if (captured > cur.capturedMinor) {
        await appendOnce(tx, {
          book: "customer_money",
          orderId: cur.orderId,
          supplierBookingId: null,
          paymentId: cur.id,
          currency: cur.currency,
          amountMinor: captured - cur.capturedMinor,
          kind: "capture",
          // No environment column on ledger_entries: the evidence ref carries it.
          evidenceRef: `capture:${cur.environment ?? "unknown"}:${cur.provider ?? cur.gateway}:${s.providerPaymentId}:${captured}`,
          occurredAt: at.toISOString(),
        });
        if (primary) await orderService.applyPaymentOutcome(tx, cur.orderId, "paid", at);
      }
      // CRM outbox: the verified captured or refunded amount changed (opportunity), or an authorisation was first seen.
      if (captured > cur.capturedMinor || refunded > cur.refundedMinor || (s.authorizedAt && !cur.authorizedAt)) await enqueueCrmSyncForOrders(tx, [cur.orderId]);
    }, TX_OPTIONS);
  }

  /**
   * The saga's items in position order: the item it names, then every other
   * `instant_checkout` item of its order (multi-item, lead-approved 3 Nov
   * 2026), by `quote_line_index` (rows without one: the named item first),
   * each with the engine's latest attempt. A one-item order gives one item.
   */
  async function itemsOf(saga: Pick<PaymentSaga, "orderId" | "orderItemId">): Promise<SagaItem[]> {
    const rows = await db.orderItem.findMany({
      where: { orderId: saga.orderId, OR: [{ id: saga.orderItemId }, { fulfilmentOrigin: "instant_checkout" }] },
      select: { id: true, serviceDate: true, status: true, quoteLineIndex: true, chargedCurrency: true, chargedAmountMinor: true, discountAllocMinor: true, taxAllocMinor: true },
    });
    const rank = (r: (typeof rows)[number]) => r.quoteLineIndex ?? (r.id === saga.orderItemId ? -1 : Number.MAX_SAFE_INTEGER);
    rows.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
    const items: SagaItem[] = [];
    for (const r of rows) {
      items.push({ id: r.id, serviceDate: r.serviceDate, status: r.status, allocationMinor: itemPayableMinor(r), booking: await deps.bookings.current(r.id) });
    }
    return items;
  }

  /** The remedy an item is waiting to carry out: a release, or a refund not sent yet. */
  async function waitingRemedy(orderItemId: string) {
    return db.customerRemedy.findFirst({
      where: { orderItemId, refundId: null, kind: { in: ["release_authorization", "refund"] }, status: { in: ["pending", "in_progress"] } },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Every refund row of this payment that has not failed, for one item: what the item has had back or has coming. */
  async function itemRefundedMinor(paymentId: string, orderItemId: string): Promise<{ total: bigint; failed: number; open: number }> {
    const rows = await db.refund.findMany({ where: { paymentId, orderItemId }, select: { status: true, amountMinor: true } });
    return {
      total: rows.filter((r) => r.status !== "failed").reduce((sum, r) => sum + r.amountMinor, 0n),
      failed: rows.filter((r) => r.status === "failed").length,
      open: rows.filter((r) => REFUND_OPEN.includes(r.status)).length,
    };
  }

  /**
   * Refund everything still refundable on the saga's payment, as a remedy.
   * Called only once the supplier hold is released (or there never was one):
   * a refund remedy recorded while waiting for that release gets the refund.
   * Several items: one refund per item, each at most its own allocation (less
   * what it already had back), in position order, until the refundable amount
   * is used up.
   */
  async function startRefund(saga: SagaHead, payment: Payment, reason: string, items: SagaItem[], opts: { attention?: boolean } = {}): Promise<boolean> {
    const amount = await refundableMinor(db, payment.id);
    if (amount <= 0n) {
      if (saga.state !== "refund_pending") {
        await move(saga, "refund_pending", { attention: opts.attention }, async (tx) => {
          for (const item of items) await closeWaitingRemedies(tx, item.id, "cancelled");
        });
      }
      return true;
    }
    const plan: { item: SagaItem; amount: bigint; waiting: Awaited<ReturnType<typeof waitingRemedy>> }[] = [];
    if (items.length === 1) {
      plan.push({ item: items[0], amount, waiting: await waitingRemedy(items[0].id) });
    } else {
      let left = amount;
      for (const item of items) {
        const waiting = await waitingRemedy(item.id);
        const had = (await itemRefundedMinor(payment.id, item.id)).total;
        const room = item.allocationMinor === null ? 0n : item.allocationMinor - had;
        const share = room <= 0n ? 0n : room < left ? room : left;
        plan.push({ item, amount: share, waiting });
        left -= share;
      }
    }
    const refundIds: string[] = [];
    try {
      await move(saga, "refund_pending", { attention: opts.attention }, async (tx) => {
        for (const { item, amount: share, waiting } of plan) {
          if (waiting?.kind === "release_authorization") await closeRelease(tx, item.id, "cancelled");
          if (share <= 0n) {
            await closeWaitingRemedies(tx, item.id, "cancelled");
            continue;
          }
          const opened = await openRefund(
            tx,
            {
              paymentId: payment.id,
              orderId: saga.orderId,
              orderItemId: item.id,
              kind: "refund",
              reason,
              amountMinor: share,
              currency: payment.currency,
              supplierBookingId: item.booking?.id ?? waiting?.supplierBookingId ?? null,
              outlyFunded: false,
            },
            { remedyId: waiting?.kind === "refund" ? waiting.id : undefined },
          );
          refundIds.push(opened.refundId);
        }
      });
    } catch (e) {
      if (e instanceof RefundRefused) {
        await move(saga, "attention", { attention: true });
        log.error("payments.refund_refused", { sagaId: saga.id, reason: e.reason });
        return false;
      }
      throw e;
    }
    for (const id of refundIds) await refunds.drive(id);
    return true;
  }

  /**
   * Wait in `release_pending` for the supplier holds to be released, then
   * release the authorization (void, or the provider's own release) or, when
   * money was captured, refund it. The remedy is recorded now, one per item:
   * a release, or a refund with no refund row until the hold is gone. One
   * item: for the payment's amount; several: each for its own allocation.
   */
  async function startRelease(saga: SagaHead, payment: Payment, reason: string, items: SagaItem[], opts: { attention?: boolean; captured?: boolean } = {}): Promise<boolean> {
    await move(saga, "release_pending", { attention: opts.attention }, async (tx) => {
      for (const item of items) {
        const request = {
          orderId: saga.orderId,
          orderItemId: item.id,
          reason,
          amountMinor: items.length === 1 ? payment.amountMinor : (item.allocationMinor ?? 0n),
          currency: payment.currency,
          supplierBookingId: item.booking?.id ?? null,
          outlyFunded: false,
        };
        if (opts.captured) await openPendingRefund(tx, { ...request, kind: "refund" });
        else await openRelease(tx, { ...request, kind: "release_authorization" });
      }
    });
    return true;
  }

  /**
   * Ask the engine to release one item's supplier hold, and read back what it
   * did. Money moves only on `released`: no attempt, or the attempt shows a
   * state that ends it (a closed never-sent attempt, a verified cancel, a
   * rejection, an expiry). `not_applicable` with the attempt still open means
   * a confirm was sent: the outcome decides (CR-B3-1). `asked`: the engine
   * already accepted this saga's release for this attempt, so it is only
   * watched (a repeat would queue its cancel again).
   */
  async function releaseSupplier(saga: SagaHead, item: Pick<SagaItem, "id" | "booking">, reason: string, asked = false, onHuman?: (code: string) => void): Promise<SupplierRelease> {
    const booking = item.booking;
    if (!booking || BOOKING_FAILED.includes(booking.state)) return "released";
    const r = asked ? "queued" : await deps.engine.releaseHold(booking.id, reason);
    const after = asked ? booking : await deps.bookings.current(item.id);
    if (!after || BOOKING_FAILED.includes(after.state)) return "released";
    if (RELEASE_NEEDS_HUMAN.includes(after.state)) {
      // One item of a multi-item order after the capture: told later, so the other items keep their evidence.
      if (onHuman) onHuman(`supplier_${after.state}`);
      else await flagAttention(saga, `supplier_${after.state}`);
      return "waiting";
    }
    if (asked) return CONFIRM_SENT.includes(after.state) ? "confirm_underway" : "waiting";
    if (r === "queued" || RELEASE_IN_FLIGHT.includes(after.state)) return "waiting";
    return "confirm_underway";
  }

  /** Every item's hold, in position order: released only when all are; a confirm already sent anywhere decides first. */
  async function releaseAll(saga: SagaHead, items: SagaItem[], reason: string, asked: (item: SagaItem) => boolean = () => false): Promise<SupplierRelease> {
    const gates: SupplierRelease[] = [];
    for (const item of items) gates.push(await releaseSupplier(saga, item, reason, asked(item)));
    if (gates.includes("confirm_underway")) return "confirm_underway";
    return gates.includes("waiting") ? "waiting" : "released";
  }

  /** A confirm went out after all: keep the capture and wait for the supplier's answer in `confirm_pending` (F42). */
  async function confirmUnderway(saga: SagaHead, payment: Payment, items: SagaItem[]): Promise<boolean> {
    log.warn("payments.confirm_underway", { sagaId: saga.id, state: saga.state });
    if (!(payment.status === "captured" && payment.capturedMinor >= payment.amountMinor)) {
      // The engine confirms only on captured evidence; anything else is for a human.
      await flagAttention(saga, "confirm_sent_without_capture");
      return false;
    }
    if (saga.state === "confirm_pending") return false;
    if (items.length > 1 && items.some((i) => !i.booking)) {
      // Multi-item: confirm_pending works item by item and needs an attempt for each; one is missing, so a human decides.
      await flagAttention(saga, "confirm_underway_item_unreserved");
      return false;
    }
    await move(saga, "confirm_pending", {}, async (tx) => {
      for (const item of items) await closeWaitingRemedies(tx, item.id, "cancelled");
    });
    return true;
  }

  /**
   * Money back for the whole order: refund what was captured, release what
   * was only authorized. Every supplier hold is released first and the money
   * moves only after the engine shows them all released. If the engine
   * refuses because a confirm was sent, nothing is refunded: the saga waits
   * for the supplier (F42), keeps the capture on a confirmation and refunds on
   * a failure (CR-B3-1; several items: item by item, `confirmPendingMulti`).
   */
  async function remedy(saga: SagaHead, payment: Payment, snap: GatewayPaymentSnapshot | null, reason: string, items: SagaItem[], opts: { attention?: boolean } = {}): Promise<boolean> {
    const gate = await releaseAll(saga, items, reason);
    if (gate === "confirm_underway") return confirmUnderway(saga, payment, items);
    const captured = (await refundableMinor(db, payment.id)) > 0n || Boolean(snap && snap.capturedMinor > snap.refundedMinor);
    if (gate === "released" && captured) return startRefund(saga, payment, reason, items, opts);
    await startRelease(saga, payment, reason, items, { ...opts, captured });
    // Released: void next. Waiting: nothing more until the engine reports every hold gone.
    return gate === "released";
  }

  /** The latest instant the reserve must have answered by (F6, F21): the earliest item's service date bounds it. */
  function reserveDeadline(saga: SagaRow, payment: Payment, hold: boolean, items: SagaItem[]): Date {
    const at: number[] = [saga.orderItem.serviceDate.getTime(), ...items.map((i) => i.serviceDate.getTime())];
    const quoteExpiry = saga.payment?.quote?.expiresAt;
    if (quoteExpiry) at.push(quoteExpiry.getTime() + RESERVE_BUDGET_MS);
    if (hold && payment.authorizationExpiresAt) at.push(payment.authorizationExpiresAt.getTime() - PAYMENT_DEADLINE_BUFFER_MS);
    return new Date(Math.min(...at));
  }

  /**
   * `startAttempt` for the next item without an attempt (the first, for one
   * item), in the saga's own transaction. A definite engine refusal is
   * answered with the money remedy for the whole order.
   */
  async function reserve(saga: SagaRow, payment: Payment, snap: GatewayPaymentSnapshot, hold: boolean, items: SagaItem[], captureBy: number | null = null): Promise<boolean> {
    const next = items.find((i) => !i.booking) ?? items[0];
    // Multi-item: once an item is held, its capture point is the nearer deadline (the job visits the earliest first).
    const reserveBy = reserveDeadline(saga, payment, hold, items);
    const deadlineAt = captureBy !== null && captureBy < reserveBy.getTime() ? new Date(captureBy) : reserveBy;
    try {
      await move(saga, "reserve_pending", { deadlineAt }, async (tx) => {
        await deps.engine.startAttempt(tx, { orderId: saga.orderId, orderItemId: next.id, quoteId: payment.quoteId ?? "" });
      });
      return true;
    } catch (e) {
      if (e instanceof LostRace) throw e;
      if (isAppError(e) && e.status < 500) {
        log.warn("payments.attempt_refused", { sagaId: saga.id, code: e.code });
        return remedy(saga, payment, snap, "attempt_refused", items);
      }
      throw e;
    }
  }

  /**
   * The earliest confirm send-by over the items' reservations: "unknown" when
   * any reserved item has none (then nothing is captured, SUP-2), null when no
   * item is reserved.
   */
  async function earliestSendBy(items: SagaItem[]): Promise<string | "unknown" | null> {
    let earliest: string | null = null;
    for (const item of items) {
      if (item.booking?.state !== "awaiting_payment") continue;
      const at = await deps.engine.confirmSendBy(item.booking.id);
      if (!at) return "unknown";
      if (earliest === null || Date.parse(at) < Date.parse(earliest)) earliest = at;
    }
    return earliest;
  }

  /**
   * Whether a hold with reservations may be captured now, as `reserved` and
   * `capture_unknown` both decide it (P1-1, P3-10): every item reserved, none
   * failed, a known send-by for each, before the earliest less
   * `CAPTURE_BUDGET_MS`, and no human looking at a multi-item order. The
   * send-by and deadline checks run before any "not yet": an item stuck
   * unreserved still releases everything in time. A remedy is carried out
   * here; `wait` takes no step.
   */
  async function captureGate(saga: SagaRow, payment: Payment, snap: GatewayPaymentSnapshot | null, items: SagaItem[], now: Date): Promise<{ go: string } | { done: boolean }> {
    const failedItem = items.find((i) => i.booking && BOOKING_FAILED.includes(i.booking.state));
    if (failedItem) return { done: await remedy(saga, payment, snap, `reserve_${failedItem.booking!.state}`, items) };
    const allReserved = items.every((i) => i.booking?.state === "awaiting_payment");
    const sendBy = await earliestSendBy(items);
    if (sendBy === "unknown" || (!sendBy && allReserved)) return { done: await remedy(saga, payment, snap, "send_by_unknown", items) };
    if (sendBy && now.getTime() >= Date.parse(sendBy) - CAPTURE_BUDGET_MS) return { done: await remedy(saga, payment, snap, "hold_deadline", items) };
    if (!allReserved || !sendBy) return { done: false };
    if (items.length > 1 && saga.attentionRequiredAt) return { done: false };
    return { go: sendBy };
  }

  /** Capture the full amount with the payment's stable key. `sendBy` is the engine's (earliest) confirm send-by, when a reservation exists. */
  async function capture(gw: PaymentGateway, saga: SagaRow, payment: Payment, items: SagaItem[], onCaptured: PaymentSagaState, sendBy: string | null): Promise<boolean> {
    const o = await gw.capture(payment.gatewayPaymentId!, payment.amountMinor, `capture:${payment.id}`);
    if (o.kind === "ok" && fullyCaptured(payment, o.payment)) {
      await syncPayment(payment, o.payment, true);
      await move(saga, onCaptured);
      return true;
    }
    if (o.kind === "unknown") {
      // Resolved after the engine's send-by, a capture is refunded; with no reservation, the authorization's life bounds it.
      const reserved = items.some((i) => i.booking);
      const deadline = reserved ? (sendBy ? new Date(sendBy) : deps.now()) : minusBuffer(payment.authorizationExpiresAt);
      await move(saga, "capture_unknown", { deadlineAt: deadline ?? saga.deadlineAt }, async (tx) => {
        await tx.payment.updateMany({ where: { id: payment.id, status: "authorized" }, data: { status: "capture_unknown" } });
      });
      return true;
    }
    // A definite refusal: re-read before deciding (an earlier capture under this key may have landed).
    const reread = await gw.getPayment(payment.gatewayPaymentId!);
    if (reread.kind === "ok" && fullyCaptured(payment, reread.payment)) {
      await syncPayment(payment, reread.payment, true);
      await move(saga, onCaptured);
      return true;
    }
    if (reread.kind !== "ok") return false;
    return remedy(saga, payment, reread.payment, o.kind === "failed" ? `capture_failed:${o.code}`.slice(0, 64) : "capture_failed", items);
  }

  /**
   * Multi-item `reserve_pending` (all or nothing until the capture). In order:
   * a definite failure of any item releases everything; a reserved item
   * without a known send-by, or the earliest send-by less `CAPTURE_BUDGET_MS`
   * reached, releases everything (no time to capture); an item still being
   * reserved is waited for (an unknown outcome also flags the saga), up to the
   * reserve deadline; once every started item is reserved, the next item is
   * started if `ITEM_RESERVE_BUDGET_MS` still fits and no human was told,
   * and when every item is reserved the saga moves to `reserved`.
   */
  async function reservePendingMulti(saga: SagaRow, payment: Payment, snap: GatewayPaymentSnapshot | null, hold: boolean, items: SagaItem[], now: Date): Promise<boolean> {
    const failedItem = items.find((i) => i.booking && BOOKING_FAILED.includes(i.booking.state));
    if (failedItem) return remedy(saga, payment, snap, `reserve_${failedItem.booking!.state}`, items);
    const sendBy = await earliestSendBy(items);
    if (sendBy === "unknown") return remedy(saga, payment, snap, "send_by_unknown", items);
    const captureBy = sendBy ? Date.parse(sendBy) - CAPTURE_BUDGET_MS : null;
    if (captureBy !== null && now.getTime() >= captureBy) return remedy(saga, payment, snap, "hold_deadline", items);
    const pending = items.filter((i) => i.booking && i.booking.state !== "awaiting_payment");
    if (pending.length) {
      if (!saga.attentionRequiredAt && pending.some((i) => RESERVE_UNRESOLVED.includes(i.booking!.state))) await flagAttention(saga, "reserve_outcome_unknown");
      const deadline = saga.deadlineAt ?? reserveDeadline(saga, payment, hold, items);
      if (now.getTime() >= deadline.getTime()) {
        log.error("payments.reserve_deadline", { sagaId: saga.id, bookingState: pending[0].booking!.state });
        return remedy(saga, payment, snap, "reserve_deadline", items, { attention: true });
      }
      return false;
    }
    if (items.every((i) => i.booking)) {
      await move(saga, "reserved", { deadlineAt: sendBy ? new Date(sendBy) : null });
      return true;
    }
    // A human was told (an unknown outcome, a refund outside Outly): no further item is reserved; the deadline releases.
    if (saga.attentionRequiredAt) {
      const deadline = saga.deadlineAt ?? reserveDeadline(saga, payment, hold, items);
      if (now.getTime() >= deadline.getTime()) return remedy(saga, payment, snap, "reserve_deadline", items, { attention: true });
      return false;
    }
    if (captureBy !== null && now.getTime() >= captureBy - ITEM_RESERVE_BUDGET_MS) return remedy(saga, payment, snap, "hold_deadline", items);
    if (!snap) return false;
    // The money must still be there for one more reserve: held (card) or captured in full (capture first).
    if (hold ? snap.status !== "authorized" : !fullyCaptured(payment, snap)) return remedy(saga, payment, snap, `payment_${snap.status}`, items);
    return reserve(saga, payment, snap, hold, items, captureBy);
  }

  /**
   * An item-scoped problem of a multi-item order after the capture (a refund
   * refused or short): a `refund` remedy for that item, `failed`, with no
   * refund row and the problem as its reason. It is durable and visible per
   * item, and it never sets the saga's attention flag, which would withdraw
   * the other items' payment evidence (PAY-1). The saga moves to `attention`
   * once every item is settled. Recorded once per item and code.
   */
  async function recordItemProblem(tx: Tx, saga: SagaHead, payment: Payment, item: SagaItem, code: string, amountMinor: bigint): Promise<void> {
    const reason = code.slice(0, 64);
    const known = await tx.customerRemedy.findFirst({ where: { orderItemId: item.id, kind: "refund", status: "failed", refundId: null, reason }, select: { id: true } });
    if (known) return;
    await tx.customerRemedy.create({
      data: { id: uuidv7(), orderId: saga.orderId, orderItemId: item.id, supplierBookingId: item.booking?.id ?? null, kind: "refund", reason, amountMinor, currency: payment.currency, outlyFunded: false, status: "failed" },
    });
    log.error("payments.item_problem", { sagaId: saga.id, code: reason });
  }

  /** Whether an item-scoped problem is recorded on this item (`recordItemProblem`). */
  async function itemProblem(orderItemId: string): Promise<boolean> {
    return (await db.customerRemedy.count({ where: { orderItemId, kind: "refund", status: "failed", refundId: null, reason: { startsWith: "item_" } } })) > 0;
  }

  /**
   * Refund one item of a multi-item order after the capture: exactly its
   * allocation (less anything it already had back), through the refund path,
   * with its own remedy, and the item marked `rejected`. The other items are
   * untouched. Called only once that item's supplier hold is gone.
   */
  async function refundItem(saga: SagaHead, payment: Payment, item: SagaItem, reason: string): Promise<boolean> {
    const had = await itemRefundedMinor(payment.id, item.id);
    const room = item.allocationMinor === null ? 0n : item.allocationMinor - had.total;
    const left = await refundableMinor(db, payment.id);
    const amount = room < left ? room : left;
    const waiting = await waitingRemedy(item.id);
    const short = room > 0n && amount < room ? room - (amount > 0n ? amount : 0n) : 0n;
    if (amount <= 0n) {
      // Nothing left to send for this item (already refunded, or money gone outside Outly): close, and record the shortfall on the item.
      await move(saga, saga.state as PaymentSagaState, {}, async (tx) => {
        await closeWaitingRemedies(tx, item.id, "cancelled");
        await orderService.markItemRejected(tx, item.id);
        if (short > 0n) await recordItemProblem(tx, saga, payment, item, "item_refund_short", short);
      });
      return true;
    }
    let refundId: string | null = null;
    try {
      await move(saga, saga.state as PaymentSagaState, {}, async (tx) => {
        // Less than the item's room can be sent (money gone outside Outly): the shortfall is recorded on the item (P3-6).
        if (short > 0n) await recordItemProblem(tx, saga, payment, item, "item_refund_short", short);
        if (waiting?.kind === "release_authorization") await closeRelease(tx, item.id, "cancelled");
        ({ refundId } = await openRefund(
          tx,
          {
            paymentId: payment.id,
            orderId: saga.orderId,
            orderItemId: item.id,
            kind: "refund",
            reason,
            amountMinor: amount,
            currency: payment.currency,
            supplierBookingId: item.booking?.id ?? waiting?.supplierBookingId ?? null,
            outlyFunded: false,
          },
          { remedyId: waiting?.kind === "refund" ? waiting.id : undefined },
        ));
        await orderService.markItemRejected(tx, item.id);
      });
    } catch (e) {
      if (e instanceof RefundRefused) {
        // Item-scoped: recorded on the item, not the saga, so the other items keep their evidence; the saga stops in
        // attention once every item is settled. A saga-wide money problem (a dispute) has already flagged the saga itself.
        await db.$transaction((tx) => recordItemProblem(tx, saga, payment, item, `item_refund_refused_${e.reason}`, room > 0n ? room : 0n), TX_OPTIONS);
        return true;
      }
      throw e;
    }
    log.warn("payments.item_refund_opened", { sagaId: saga.id, reason });
    if (refundId) await refunds.drive(refundId);
    return true;
  }

  /**
   * Multi-item `confirm_pending`: the whole amount is captured; each item is
   * confirmed or refunded on its own, one action per step, in position order.
   *  - confirmed: kept (a refund recorded while waiting for its release is
   *    closed: the confirm won the race, CR-B3-1);
   *  - a definite failure (rejected, not created, expired, cancelled):
   *    `refundItem`;
   *  - reserved: `confirmIfPaid`; `too_late` asks the engine to release the
   *    hold and refunds the item once it is gone (a confirm already sent
   *    keeps it waiting for the supplier's answer);
   *  - anything else: waited for; once every such item's own send-by has
   *    passed, a human is told (F42).
   * When every item is confirmed or refunded: open refunds are driven; then
   * `fulfilled` (some confirmed), `refund_pending` (none confirmed: the
   * refund_pending step finishes it), or `attention` when an item refund
   * failed (F16).
   */
  async function confirmPendingMulti(saga: SagaRow, payment: Payment, snap: GatewayPaymentSnapshot | null, items: SagaItem[], now: Date): Promise<boolean> {
    let unresolved = 0;
    let awaitingConfirm = 0;
    const late: SagaItem[] = [];
    // Item-scoped human problems: told once no other item still needs its payment evidence.
    const deferred: string[] = [];
    for (const item of items) {
      const b = item.booking;
      const had = await itemRefundedMinor(payment.id, item.id);
      if (item.status === "rejected" || had.total > 0n || had.failed > 0 || (await itemProblem(item.id))) continue;
      const waiting = await waitingRemedy(item.id);
      if (!b) {
        unresolved += 1;
        continue;
      }
      if (b.state === "cancelled" && (await db.cancellationRequest.count({ where: { orderItemId: item.id, closedAt: null } })) > 0) {
        // The customer's own cancellation (B5) refunds this item; the saga never refunds it twice.
        continue;
      }
      if (b.state === "confirmed") {
        if (waiting) {
          await move(saga, "confirm_pending", {}, (tx) => closeWaitingRemedies(tx, item.id, "cancelled"));
          return true;
        }
        continue;
      }
      if (BOOKING_FAILED.includes(b.state)) return refundItem(saga, payment, item, waiting?.reason ?? `confirm_${b.state}`);
      if (waiting) {
        // A release was asked for this item; its refund waits until the hold is gone (or the confirm wins).
        if (RELEASE_NEEDS_HUMAN.includes(b.state)) deferred.push(`supplier_${b.state}`);
        unresolved += 1;
        continue;
      }
      if (b.state === "awaiting_payment") {
        const r = await deps.engine.confirmIfPaid(b.id);
        if (r === "too_late") {
          const gate = await releaseSupplier(saga, item, "confirm_too_late", false, (code) => deferred.push(code));
          if (gate === "released") return refundItem(saga, payment, { ...item, booking: await deps.bookings.current(item.id) }, "confirm_too_late");
          if (gate === "waiting") {
            await move(saga, "confirm_pending", {}, async (tx) => {
              await openPendingRefund(tx, { orderId: saga.orderId, orderItemId: item.id, kind: "refund", reason: "confirm_too_late", amountMinor: item.allocationMinor ?? 0n, currency: payment.currency, supplierBookingId: b.id, outlyFunded: false });
            });
            return true;
          }
        } else {
          awaitingConfirm += 1;
        }
        unresolved += 1;
        continue;
      }
      // Confirm sent with no answer yet, or the engine is recovering (F42): never re-confirmed. Doc 29 Batch 6 (review
      // 89 B6-01): an item waiting on its external supplier is not late at the send-by; the engine owns that wait and
      // hands it to our team at its own limit. Flagging the saga would withdraw the evidence its late answer needs.
      if (!(b.state === "awaiting_external" && b.externalRoute === true)) late.push(item);
      unresolved += 1;
    }
    if (deferred.length && awaitingConfirm === 0 && !saga.attentionRequiredAt) await flagAttention(saga, deferred[0]);
    if (unresolved > 0) {
      if (late.length && !saga.attentionRequiredAt && saga.deadlineAt && now.getTime() > saga.deadlineAt.getTime()) {
        // Told only once every waiting item's own send-by has passed: a flag withdraws the other items' evidence.
        let allPast = true;
        for (const item of late) {
          const at = item.booking ? await deps.engine.confirmSendBy(item.booking.id) : null;
          if (at && now.getTime() <= Date.parse(at)) allPast = false;
        }
        if (allPast && late.length === unresolved) await flagAttention(saga, "confirm_unresolved_at_deadline");
      }
      return false;
    }
    // Every item is confirmed or refunded.
    const open = await db.refund.findMany({ where: { paymentId: payment.id, status: { in: REFUND_OPEN } }, select: { id: true } });
    for (const r of open) await refunds.drive(r.id);
    if ((await db.refund.count({ where: { paymentId: payment.id, status: { in: REFUND_OPEN } } })) > 0) return false;
    for (const item of items) {
      const had = await itemRefundedMinor(payment.id, item.id);
      if ((had.failed > 0 && had.total === 0n) || (await itemProblem(item.id))) {
        await move(saga, "attention", { attention: true });
        log.error("payments.refund_incomplete", { sagaId: saga.id });
        return false;
      }
    }
    const confirmed = items.filter((i) => i.booking?.state === "confirmed").length;
    if (confirmed === 0) {
      await move(saga, "refund_pending");
      return true;
    }
    await move(saga, "fulfilled");
    return true;
  }

  /**
   * Admit one provider payment of the order's provider order (a webhook or
   * reconciliation found it). Only a successful attempt counts (F45,
   * CR-B3-4): a declined or unfinished one binds nothing and fails nothing.
   * The first successful one is the order's payment; any later successful
   * one is a duplicate, refunded or voided and recorded, and never touches
   * the order's own saga. A mismatched one is the order's problem only while
   * nothing is bound (attention); after that it is quarantined for finance.
   */
  async function admit(gw: PaymentGateway, primaryId: string, s: GatewayPaymentSnapshot): Promise<"known" | "ignored" | "mismatch" | "bound" | "duplicate"> {
    const provider = gw.account().provider;
    if (await db.payment.findFirst({ where: { provider, gatewayPaymentId: s.providerPaymentId }, select: { id: true } })) return "known";
    if (!successfulAttempt(s)) {
      log.info("payments.attempt_not_successful", { paymentId: primaryId, status: s.status });
      return "ignored";
    }
    const primary = await db.payment.findUniqueOrThrow({ where: { id: primaryId }, include: { saga: true } });
    const mismatch = bindingMismatch(primary, s, gw.account());
    if (!primary.gatewayPaymentId) {
      if (mismatch) {
        if (primary.saga) await flagAttention(primary.saga, mismatch);
        log.error("payments.binding_mismatch", { paymentId: primary.id, mismatch });
        return "mismatch";
      }
      const bound = await db.payment.updateMany({ where: { id: primary.id, gatewayPaymentId: null }, data: { gatewayPaymentId: s.providerPaymentId } });
      if (bound.count === 1) return "bound";
    }
    // The order's payment is already bound to another provider payment: this one is a duplicate.
    let dupId: string;
    try {
      const dup = await db.payment.create({
        data: {
          id: uuidv7(),
          orderId: primary.orderId,
          gateway: provider,
          gatewayOrderId: s.providerOrderId,
          gatewayPaymentId: s.providerPaymentId,
          source: "gateway_verified",
          rail: primary.rail,
          provider,
          providerAccountId: primary.providerAccountId,
          environment: primary.environment,
          method: s.method,
          amountMinor: s.amountMinor,
          currency: s.currency,
          status: "created",
          quoteId: primary.quoteId,
          // Quarantined: no automatic money movement; finance decides (F2).
          failureCode: mismatch ? `quarantined_${mismatch}` : null,
        },
      });
      dupId = dup.id;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return "known";
      throw e;
    }
    if (mismatch) {
      log.error("payments.duplicate_quarantined", { orderId: primary.orderId, paymentId: dupId, mismatch });
      return "duplicate";
    }
    log.warn("payments.duplicate_payment", { orderId: primary.orderId, paymentId: dupId });
    await settleDuplicate(gw, dupId);
    return "duplicate";
  }

  /** Read every payment the provider holds for the order (F1: lost webhooks) and admit them, money first. */
  async function reconcile(gw: PaymentGateway, primaryId: string, providerOrderId: string): Promise<"bound" | "none" | "unavailable"> {
    const r = await gw.listPaymentsForOrder(providerOrderId);
    if (!r.ok) {
      log.warn("payments.reconcile_unavailable", { paymentId: primaryId, reason: r.reason });
      return "unavailable";
    }
    const rank = (s: GatewayPaymentSnapshot) => (s.capturedMinor > 0n ? 0 : s.status === "authorized" ? 1 : 2);
    const found = r.payments
      .filter((s) => s.providerOrderId === providerOrderId)
      .sort((a, b) => rank(a) - rank(b) || (a.authorizedAt ?? "").localeCompare(b.authorizedAt ?? ""));
    let bound = false;
    for (const s of found) if ((await admit(gw, primaryId, s)) === "bound") bound = true;
    return bound ? "bound" : "none";
  }

  async function step(sagaId: string, ctx: StepCtx): Promise<boolean> {
    ctx.readFailed = false;
    const saga = await load(sagaId);
    if (!saga?.payment) return false;
    let payment: Payment = saga.payment;
    const now = deps.now();
    let gw: PaymentGateway;
    let caps: MethodCapabilities;
    try {
      gw = deps.gateways.forRail(saga.rail as PaymentRail);
      caps = gw.capabilities(payment.method ?? "");
    } catch (e) {
      if (!isAppError(e) && saga.state !== "attention") await move(saga, "attention", { attention: true });
      return false;
    }
    const hold = sagaFor(caps) === "authorize_reserve_capture_confirm";
    const quoteExpiry = saga.payment.quote?.expiresAt ?? null;

    // The provider's authenticated read is the only source of truth (PAY-13).
    let snap: GatewayPaymentSnapshot | null = null;
    if (payment.gatewayPaymentId) {
      const o = await gw.getPayment(payment.gatewayPaymentId);
      if (o.kind === "ok") snap = o.payment;
      else ctx.readFailed = true;
    }
    if (snap && saga.state === "session_created" && !successfulAttempt(snap)) {
      // A declined or abandoned attempt is not the order's payment while the session lives (CR-B3-4).
      await db.payment.updateMany({ where: { id: payment.id, gatewayPaymentId: snap.providerPaymentId }, data: { gatewayPaymentId: null } });
      log.info("payments.attempt_unbound", { sagaId: saga.id, status: snap.status });
      payment = { ...payment, gatewayPaymentId: null };
      snap = null;
    }
    if (snap) {
      const mismatch = bindingMismatch(payment, snap, gw.account());
      if (mismatch) {
        if (saga.state !== "attention") await move(saga, "attention", { attention: true });
        log.error("payments.binding_mismatch", { sagaId: saga.id, mismatch });
        return false;
      }
      await syncPayment(payment, snap, true);
      payment = await db.payment.findUniqueOrThrow({ where: { id: payment.id } });
      // A refund made outside Outly (the provider's dashboard) while the saga is live: a human is told, no money moves,
      // and the flag withdraws the confirm evidence (CR-B3-16).
      if (!TERMINAL.includes(saga.state as PaymentSagaState) && !saga.attentionRequiredAt && (await refundedOutsideOutlyMinor(db, payment.id)) > 0n) {
        await flagAttention(saga, "refunded_outside_outly");
      }
    }
    const items = await itemsOf(saga);
    const multi = items.length > 1;
    const booking = items[0]?.booking ?? null;
    // Paid after the quote expired (F46), or known only long after it (a stale quote, §22.2).
    const late = (s: GatewayPaymentSnapshot) => {
      const by = quoteExpiry ?? saga.deadlineAt;
      return Boolean(by && (s.authorizedAt ? Date.parse(s.authorizedAt) : now.getTime()) > by.getTime());
    };
    const stale = Boolean(quoteExpiry && now.getTime() > quoteExpiry.getTime() + STALE_QUOTE_GRACE_MS);
    const failed = items.some((i) => i.booking && BOOKING_FAILED.includes(i.booking.state));
    const failedState = items.find((i) => i.booking && BOOKING_FAILED.includes(i.booking.state))?.booking?.state ?? null;

    switch (saga.state as PaymentSagaState) {
      case "session_created": {
        if (!snap) {
          if (payment.gatewayPaymentId) return false;
          const over = Boolean(saga.deadlineAt && now.getTime() > saga.deadlineAt.getTime() + SESSION_GRACE_MS);
          // A provider session may outlive the quote (Stripe Checkout lives at least 30 minutes): close it once the
          // quote lapses. Unknown is retried next run and never closes the saga; money that still arrives is late (F46).
          let completed = false;
          if (gw.expireSession && payment.providerOrderId && quoteExpiry && now.getTime() > quoteExpiry.getTime()) {
            const x = await gw.expireSession(payment.providerOrderId, `expire:${payment.id}`);
            if (x.kind === "unknown") {
              ctx.readFailed = true;
              if (over && !saga.attentionRequiredAt) await flagAttention(saga, "session_expire_unknown_at_deadline");
              return false;
            }
            if (x.kind === "failed") log.warn("payments.session_expire_refused", { sagaId: saga.id, code: x.code });
            completed = x.kind === "ok" && x.state === "completed";
          }
          const due = completed || over || (ctx.reconcile && now.getTime() - saga.createdAt.getTime() >= RECONCILE_AFTER_MS);
          if (due && payment.providerOrderId) {
            const r = await reconcile(gw, payment.id, payment.providerOrderId);
            if (r === "bound") return true;
            if (r === "unavailable") {
              ctx.readFailed = true;
              // Never close a session without the provider's word that nothing was paid (F1).
              if (over && !saga.attentionRequiredAt) await flagAttention(saga, "reconcile_unavailable_at_deadline");
              return false;
            }
          }
          if (over) {
            await move(saga, "failed");
            return true;
          }
          return false;
        }
        if (snap.status === "refunded" || snap.status === "partially_refunded") {
          await move(saga, "attention", { attention: true });
          return false;
        }
        if (snap.status === "captured") {
          if (!fullyCaptured(payment, snap)) {
            // Less than the order was captured: nothing to book on, and not a remedy the saga can size. A human decides (CR-B3-12).
            await move(saga, "attention", { attention: true });
            log.error("payments.partial_capture_at_entry", { sagaId: saga.id });
            return false;
          }
          if (late(snap) || stale) return startRefund(saga, payment, "late_payment", items);
          if (!riskOk(snap)) return startRefund(saga, payment, "risk_refused", items);
          await move(saga, "captured");
          return true;
        }
        if (snap.status !== "authorized") return false;
        if (late(snap) || stale) return remedy(saga, payment, snap, "late_payment", items);
        if (!riskOk(snap)) return remedy(saga, payment, snap, "risk_refused", items);
        if (hold) {
          await move(saga, "authorized");
          return true;
        }
        // Debited at authorization: capture first, then reserve.
        return capture(gw, saga, payment, items, "captured", null);
      }

      case "authorized":
        if (!snap || snap.status !== "authorized") return false;
        if (late(snap) || stale) return remedy(saga, payment, snap, "late_payment", items);
        return reserve(saga, payment, snap, hold, items);

      case "captured":
        if (!snap) return false;
        // A capture that became known after the quote's life is refunded, never reserved on that quote (§22.2).
        if (late(snap) || stale) return remedy(saga, payment, snap, "late_payment", items);
        return reserve(saga, payment, snap, hold, items);

      case "reserve_pending": {
        if (multi) return reservePendingMulti(saga, payment, snap, hold, items, now);
        if (booking && failed) return remedy(saga, payment, snap, `reserve_${booking.state}`, items);
        if (booking?.state === "awaiting_payment") {
          const sendBy = await deps.engine.confirmSendBy(booking.id);
          await move(saga, "reserved", { deadlineAt: sendBy ? new Date(sendBy) : null });
          return true;
        }
        // No reservation in time (held by a pause, never sent, unresolved): money back and a human told (F6, F21).
        const deadline = saga.deadlineAt ?? reserveDeadline(saga, payment, hold, items);
        if (now.getTime() >= deadline.getTime()) {
          log.error("payments.reserve_deadline", { sagaId: saga.id, bookingState: booking?.state ?? null });
          return remedy(saga, payment, snap, "reserve_deadline", items, { attention: true });
        }
        return false;
      }

      case "reserved": {
        if (!booking) return false;
        if (failed) return remedy(saga, payment, snap, `reserve_${failedState}`, items);
        const allReserved = items.every((i) => i.booking?.state === "awaiting_payment");
        if (allReserved && snap && (!hold || fullyCaptured(payment, snap))) {
          await move(saga, "confirm_pending");
          return true;
        }
        if (allReserved && snap && snap.status !== "authorized") return remedy(saga, payment, snap, `payment_${snap.status}`, items);
        if (!hold) return false;
        // Capture only while the engine would still send every item's confirm; an unknown send-by never captures (SUP-2).
        // Multi-item: the deadline is checked even while an item is not (or no longer) reserved (P3-10).
        if (!multi && (!allReserved || !snap)) return false;
        const gate = await captureGate(saga, payment, snap, items, now);
        if ("done" in gate) return gate.done;
        if (!snap) return false;
        return capture(gw, saga, payment, items, "confirm_pending", gate.go);
      }

      case "capture_unknown": {
        const pastDeadline = Boolean(saga.deadlineAt && now.getTime() >= saga.deadlineAt.getTime());
        if (!snap) {
          // Unknown and out of time: never confirm. Release the hold and keep reading (F9, PAY-2).
          if (pastDeadline) return remedy(saga, payment, null, "capture_unknown_at_deadline", items);
          return false;
        }
        const allReserved = items.every((i) => i.booking?.state === "awaiting_payment");
        if (fullyCaptured(payment, snap)) {
          if (!hold) {
            await move(saga, "captured");
            return true;
          }
          if (!pastDeadline && allReserved) {
            await move(saga, "confirm_pending");
            return true;
          }
          return remedy(saga, payment, snap, "capture_after_deadline", items);
        }
        if (snap.status === "authorized") {
          if (pastDeadline) return remedy(saga, payment, snap, "capture_unknown_at_deadline", items);
          if (!hold || !items.some((i) => i.booking)) return capture(gw, saga, payment, items, hold ? "confirm_pending" : "captured", null);
          // Re-check every item before capturing again, exactly as `reserved` does (P1-1).
          const gate = await captureGate(saga, payment, snap, items, now);
          if ("done" in gate) return gate.done;
          return capture(gw, saga, payment, items, "confirm_pending", gate.go);
        }
        return remedy(saga, payment, snap, `payment_${snap.status}`, items);
      }

      case "confirm_pending": {
        if (multi) return confirmPendingMulti(saga, payment, snap, items, now);
        if (!booking) return false;
        if (booking.state === "confirmed") {
          await move(saga, "fulfilled");
          return true;
        }
        if (failed) return remedy(saga, payment, snap, `confirm_${booking.state}`, items);
        if (booking.state === "awaiting_payment") {
          const r = await deps.engine.confirmIfPaid(booking.id);
          // The deadline gate refused the send (F44). A confirm may still have gone out in between: the release decides.
          if (r === "too_late") return remedy(saga, payment, snap, "confirm_too_late", items);
          return false;
        }
        // Confirm sent with no answer yet, or the engine is recovering (F42): never re-confirm; tell a human past the deadline.
        // Doc 29 Batch 6 (review 89 B6-01): not while the booking waits on its external supplier; the engine's hand-off
        // (`external_confirmation_handoff`) tells our team, and a saga flag would withdraw the payment evidence.
        if (!(booking.state === "awaiting_external" && booking.externalRoute === true) && saga.deadlineAt && now.getTime() > saga.deadlineAt.getTime() && !saga.attentionRequiredAt) {
          await flagAttention(saga, "confirm_unresolved_at_deadline");
        }
        return false;
      }

      case "release_pending": {
        const waitingByItem = new Map<string, Awaited<ReturnType<typeof waitingRemedy>>>();
        for (const item of items) waitingByItem.set(item.id, await waitingRemedy(item.id));
        const waiting = items.map((i) => waitingByItem.get(i.id)).find(Boolean) ?? null;
        const reason = waiting?.reason ?? "payment_released";
        const gate = await releaseAll(saga, items, reason, (item) => Boolean(item.booking && waitingByItem.get(item.id)?.supplierBookingId === item.booking.id));
        if (gate === "confirm_underway") return confirmUnderway(saga, payment, items);
        // No money moves until the engine shows every hold released (CR-B3-1).
        if (gate === "waiting") return false;
        const closeAll = async (tx: Tx) => {
          for (const item of items) await closeRelease(tx, item.id, "completed");
        };
        if (!payment.gatewayPaymentId) {
          await move(saga, "released", {}, closeAll);
          return true;
        }
        if (!snap) return false;
        if (snap.capturedMinor > snap.refundedMinor) {
          // Captured: a refund recorded while waiting, or a capture that landed after the release (late capture).
          if ((await refundableMinor(db, payment.id)) > 0n) return startRefund(saga, payment, waiting?.kind === "refund" ? reason : "captured_after_release", items);
          await move(saga, "refund_pending");
          return true;
        }
        if (snap.status === "authorized") {
          // Still held when the provider should have let it go (or a void keeps failing near the expiry): tell a human (F4, CR-B3-12).
          const expiry = payment.authorizationExpiresAt;
          const alertAt = expiry ? expiry.getTime() + (caps.release === "void" ? -PAYMENT_DEADLINE_BUFFER_MS : AUTO_RELEASE_GRACE_MS) : null;
          if (alertAt !== null && now.getTime() >= alertAt && !saga.attentionRequiredAt) await flagAttention(saga, caps.release === "void" ? "void_unresolved_near_expiry" : "authorization_not_released");
          if (caps.release !== "void") return false;
          const o = await gw.void(payment.gatewayPaymentId, `void:${payment.id}`);
          if (o.kind === "ok" && o.payment.status === "voided") {
            await syncPayment(payment, o.payment, true);
            await move(saga, "released", {}, closeAll);
            return true;
          }
          return false;
        }
        await move(saga, "released", {}, closeAll);
        return true;
      }

      case "refund_pending": {
        const open = await db.refund.findMany({ where: { paymentId: payment.id, status: { in: ["requested", "accepted", "unknown"] } }, select: { id: true } });
        for (const r of open) await refunds.drive(r.id);
        const still = await db.refund.count({ where: { paymentId: payment.id, status: { in: ["requested", "accepted", "unknown"] } } });
        if (still > 0) return false;
        const left = await refundableMinor(db, payment.id);
        if (left > 0n) {
          // A refund failed: finance queue (F16).
          await move(saga, "attention", { attention: true });
          log.error("payments.refund_incomplete", { sagaId: saga.id });
          return false;
        }
        await move(saga, "refunded");
        return true;
      }

      case "released":
      case "failed": {
        // Money that arrives after the saga closed is never kept (F46, late webhook after release), webhook or not (F1).
        if (ctx.reconcile && payment.providerOrderId) {
          const window = payment.gatewayPaymentId ? LATE_MONEY_WINDOW_MS : LATE_SESSION_WINDOW_MS;
          if (now.getTime() - saga.createdAt.getTime() <= window) {
            const r = await reconcile(gw, payment.id, payment.providerOrderId);
            if (r === "bound") return true;
            if (r === "unavailable") ctx.readFailed = true;
          }
        }
        if (!snap) return false;
        if (snap.capturedMinor > snap.refundedMinor && (await refundableMinor(db, payment.id)) > 0n) return remedy(saga, payment, snap, "late_payment", items);
        if (snap.status === "authorized") return remedy(saga, payment, snap, "late_payment", items);
        return false;
      }

      default:
        return false;
    }
  }

  /** Run steps until the saga rests; reports whether the last step lacked the provider's read. */
  async function run(sagaId: string, opts: { reconcile?: boolean; maxSteps?: number } = {}): Promise<{ state: string | null; readFailed: boolean }> {
    const ctx: StepCtx = { reconcile: opts.reconcile ?? false, readFailed: false };
    for (let i = 0; i < (opts.maxSteps ?? 10); i++) {
      let moved: boolean;
      try {
        moved = await step(sagaId, ctx);
      } catch (e) {
        if (e instanceof LostRace) continue;
        throw e;
      }
      if (!moved) break;
    }
    const state = (await db.paymentSaga.findUnique({ where: { id: sagaId }, select: { state: true } }))?.state ?? null;
    return { state, readFailed: ctx.readFailed };
  }

  /** Run steps until the saga rests. Safe to call any time, from any trigger. */
  async function advance(sagaId: string, maxSteps = 10): Promise<string | null> {
    return (await run(sagaId, { maxSteps })).state;
  }

  /** Advance for an inbox event: without the provider's read the event stays retryable, never processed (PAY-13). */
  async function advanceForEvent(sagaId: string): Promise<void> {
    if ((await run(sagaId)).readFailed) throw new InboxRetry("provider_read_unknown");
  }

  /**
   * A second payment on the same provider order (F45): refund it, or void a
   * hold. Never fulfils anything. One automatic refund only: a failed one is
   * left for finance, never re-sent (F16).
   */
  async function settleDuplicate(gw: PaymentGateway, paymentId: string): Promise<void> {
    const p = await db.payment.findUnique({ where: { id: paymentId } });
    if (!p?.gatewayPaymentId || p.failureCode) return;
    const o = await gw.getPayment(p.gatewayPaymentId);
    if (o.kind !== "ok") throw new InboxRetry("provider_read_unknown");
    if (bindingMismatch(p, o.payment, gw.account())) {
      log.error("payments.duplicate_binding_mismatch", { paymentId });
      return;
    }
    await syncPayment(p, o.payment, false);
    const saga = await db.paymentSaga.findUnique({ where: { orderId: p.orderId } });
    if (!saga) return;
    const prior = await db.refund.findMany({ where: { paymentId: p.id }, select: { status: true } });
    if (prior.some((r) => r.status === "failed")) {
      await db.payment.updateMany({ where: { id: p.id, failureCode: null }, data: { failureCode: "duplicate_refund_failed" } });
      log.error("payments.duplicate_refund_failed", { paymentId: p.id });
      return;
    }
    const amount = await refundableMinor(db, p.id);
    if (amount > 0n) {
      if (prior.length > 0) return;
      const { refundId } = await db.$transaction(
        (tx) =>
          openRefund(tx, {
            paymentId: p.id,
            orderId: p.orderId,
            orderItemId: saga.orderItemId,
            kind: "refund",
            reason: "duplicate_payment",
            amountMinor: amount,
            currency: p.currency,
            supplierBookingId: null,
            outlyFunded: false,
          }),
        TX_OPTIONS,
      );
      await refunds.drive(refundId);
      return;
    }
    if (o.payment.status === "authorized" && gw.capabilities(p.method ?? "").release === "void") {
      const v = await gw.void(p.gatewayPaymentId, `void:${p.id}`);
      if (v.kind === "ok") await syncPayment(p, v.payment, false);
    }
  }

  /** Record a dispute or chargeback: refunds on the payment freeze (refunds.ts) and the saga is flagged. */
  async function recordDispute(provider: string, providerPaymentId: string | null) {
    if (!providerPaymentId) return;
    const p = await db.payment.findFirst({ where: { provider, gatewayPaymentId: providerPaymentId }, select: { id: true, saga: true } });
    if (p?.saga) await db.paymentSaga.updateMany({ where: { id: p.saga.id, attentionRequiredAt: null }, data: { attentionRequiredAt: deps.now() } });
    log.error("payments.dispute_recorded", { provider, paymentId: p?.id ?? null });
  }

  /**
   * Act on one verified inbox event. Only the event id, type and provider
   * payment id are used; what happened is read from the provider.
   * Throws `InboxRetry` when the event cannot be matched yet, or when the
   * provider's read was unavailable while acting on it (CR-B3-2).
   */
  async function handleEvent(gw: PaymentGateway, event: Pick<VerifiedGatewayEvent, "type" | "providerPaymentId">): Promise<void> {
    const provider = gw.account().provider;
    if (isDisputeType(event.type)) return recordDispute(provider, event.providerPaymentId);
    if (!event.providerPaymentId) return;

    const known = await db.payment.findFirst({ where: { provider, gatewayPaymentId: event.providerPaymentId }, select: { id: true, saga: { select: { id: true } } } });
    if (known) {
      if (known.saga) await advanceForEvent(known.saga.id);
      else await settleDuplicate(gw, known.id);
      return;
    }
    const o = await gw.getPayment(event.providerPaymentId);
    if (o.kind !== "ok") throw new InboxRetry(o.kind === "unknown" ? "provider_read_unknown" : "provider_read_failed");
    const s = o.payment;
    const primary = s.providerOrderId ? await db.payment.findFirst({ where: { provider, providerOrderId: s.providerOrderId }, select: { id: true, saga: { select: { id: true } } } }) : null;
    if (!primary?.saga) throw new InboxRetry("unmatched_payment");
    if ((await admit(gw, primary.id, s)) === "bound") await advanceForEvent(primary.saga.id);
  }

  /**
   * One run of the payments job over the sagas (CR-B3-14). These runs also
   * reconcile open sessions by provider order (F1). In order, each with its
   * own budget, and none started after `budgetMs`:
   *  1. live sagas whose deadline is close or just past (`URGENT_BEHIND_MS`,
   *     `URGENT_AHEAD_MS`) and not flagged, earliest deadline first, using at
   *     most `URGENT_SHARE` of the live budget;
   *  2. every other saga not at rest, least recently checked first;
   *  3. the late-money watch: `released`/`failed` sagas with a payment bound
   *     inside `LATE_MONEY_WINDOW_MS`, and without one inside
   *     `LATE_SESSION_WINDOW_MS`, least recently checked first.
   * `checked_at` is written just before a saga runs, so the next run starts
   * with the sagas this one did not reach, and a saga that keeps failing goes
   * to the back instead of blocking the rest. No saga runs twice in one run.
   *
   * When the watch has sagas to read, passes 1 and 2 stop starting sagas once
   * `1 - TICK_WATCH_MIN_SHARE` of the budget is spent, so pass 3 always gets
   * its share (N1). A run that stops a pass with work left emits
   * `payments.tick_out_of_time`; `TICK_STARVED_AFTER` such runs in a row emit
   * `payments.tick_starved` at error level. The budget is checked only
   * before each saga starts: one slow provider call can still overrun it
   * (adapters need their own per-call timeouts).
   */
  async function advanceOpen(opts: AdvanceOpenOptions = {}): Promise<number> {
    const liveLimit = opts.liveLimit ?? TICK_LIVE_LIMIT;
    const watchLimit = opts.watchLimit ?? TICK_WATCH_LIMIT;
    const budgetMs = opts.budgetMs ?? TICK_BUDGET_MS;
    const elapsed = deps.elapsedMs ?? (() => performance.now());
    const started = elapsed();
    const outOfTime = (limitMs: number) => elapsed() - started >= limitMs;
    const now = deps.now();
    const visited = new Set<string>();
    const leastRecentlyChecked: Prisma.PaymentSagaOrderByWithRelationInput[] = [{ checkedAt: { sort: "asc", nulls: "first" } }, { id: "asc" }];
    /** Passes stopped by time with work left, and how much each left. */
    const cut: { pass: TickPass; skipped: number }[] = [];

    async function visit(pass: TickPass, where: Prisma.PaymentSagaWhereInput, orderBy: Prisma.PaymentSagaOrderByWithRelationInput[], limit: number, untilMs: number): Promise<number> {
      let n = 0;
      const notVisited = (): Prisma.PaymentSagaWhereInput => (visited.size ? { AND: [where, { id: { notIn: [...visited] } }] } : where);
      while (n < limit && !outOfTime(untilMs)) {
        const page = await db.paymentSaga.findMany({
          where: notVisited(),
          orderBy,
          take: Math.min(TICK_PAGE, limit - n),
          select: { id: true },
        });
        if (!page.length) break;
        for (const { id } of page) {
          if (outOfTime(untilMs)) break;
          visited.add(id);
          n += 1;
          try {
            await db.$executeRaw`UPDATE "payment_sagas" SET "checked_at" = ${now} WHERE "id" = ${id}::uuid`;
            await run(id, { reconcile: true });
          } catch (error) {
            log.error("payments.saga_advance_failed", { sagaId: id, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      if (n < limit && outOfTime(untilMs)) {
        const left = Math.min(limit - n, await db.paymentSaga.count({ where: notVisited() }));
        if (left > 0) cut.push({ pass, skipped: left });
      }
      return n;
    }

    const live: Prisma.PaymentSagaWhereInput = { state: { notIn: TERMINAL } };
    const watch: Prisma.PaymentSagaWhereInput = {
      state: { in: LATE_WATCH },
      OR: [
        { createdAt: { gte: new Date(now.getTime() - LATE_SESSION_WINDOW_MS) } },
        { createdAt: { gte: new Date(now.getTime() - LATE_MONEY_WINDOW_MS) }, payment: { is: { gatewayPaymentId: { not: null } } } },
      ],
    };
    // N1: keep the watch's share of the time only when it has something to read.
    const watchWaiting = watchLimit > 0 && (await db.paymentSaga.findFirst({ where: watch, select: { id: true } })) !== null;
    const liveUntilMs = watchWaiting ? budgetMs * (1 - TICK_WATCH_MIN_SHARE) : budgetMs;
    const urgent = await visit(
      "urgent",
      { ...live, attentionRequiredAt: null, deadlineAt: { gte: new Date(now.getTime() - URGENT_BEHIND_MS), lte: new Date(now.getTime() + URGENT_AHEAD_MS) } },
      [{ deadlineAt: "asc" }, { id: "asc" }],
      Math.min(liveLimit, Math.ceil(liveLimit * URGENT_SHARE)),
      liveUntilMs,
    );
    const rest = await visit("live", live, leastRecentlyChecked, liveLimit - urgent, liveUntilMs);
    const watched = await visit("watch", watch, leastRecentlyChecked, watchLimit, budgetMs);
    await recordTickHealth(cut, visited.size, now, budgetMs);
    const seen = urgent + rest + watched;
    // Duplicates still holding money: refund or void them (quarantined and failed ones wait for finance).
    const dups = await db.payment.findMany({ where: { source: "gateway_verified", saga: null, failureCode: null, status: { in: ["authorized", "captured"] }, provider: { not: null } }, take: 50, select: { id: true, provider: true } });
    for (const d of dups) {
      if (opts.stop?.()) break;
      const gw = deps.gateways.forProvider(d.provider!);
      if (!gw) continue;
      try {
        await settleDuplicate(gw, d.id);
      } catch (error) {
        log.error("payments.duplicate_settle_failed", { paymentId: d.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (!opts.stop?.()) await refunds.driveOpen(50, { stop: opts.stop });
    return seen;
  }

  /**
   * N1: one row in `job_executions` (`payments.tick`, `health`) counts the
   * runs in a row that stopped a pass with work left. Reports through the
   * allowlisted events only. A failure to record never fails the run.
   */
  async function recordTickHealth(cut: { pass: TickPass; skipped: number }[], visited: number, now: Date, budgetMs: number = TICK_BUDGET_MS): Promise<void> {
    const short = cut.length > 0;
    const skipped = cut.reduce((n, c) => n + c.skipped, 0);
    // The pass that lost out: the watch when it was cut, otherwise the first one cut.
    const pass: TickPass | null = cut.find((c) => c.pass === "watch")?.pass ?? cut[0]?.pass ?? null;
    let consecutive: number | null = null;
    try {
      const rows = await db.$queryRaw<{ consecutive: number }[]>`
        INSERT INTO "job_executions" ("id", "job_type", "dedupe_key", "status", "payload", "started_at", "finished_at")
        VALUES (${uuidv7()}::uuid, ${TICK_HEALTH_JOB}, ${TICK_HEALTH_KEY}, ${short ? "failed" : "succeeded"}::"job_status",
                jsonb_build_object('consecutiveOutOfTime', ${short ? 1 : 0}::int, 'lastPass', ${pass}::text, 'lastSkipped', ${skipped}::int), ${now}, ${now})
        ON CONFLICT ("job_type", "dedupe_key") DO UPDATE SET
          "status" = EXCLUDED."status",
          "payload" = jsonb_build_object(
            'consecutiveOutOfTime', CASE WHEN ${short} THEN COALESCE(("job_executions"."payload"->>'consecutiveOutOfTime')::int, 0) + 1 ELSE 0 END,
            'lastPass', ${pass}::text, 'lastSkipped', ${skipped}::int),
          "started_at" = EXCLUDED."started_at",
          "finished_at" = EXCLUDED."finished_at"
        RETURNING ("payload"->>'consecutiveOutOfTime')::int AS "consecutive"`;
      consecutive = rows[0]?.consecutive ?? null;
    } catch (error) {
      log.error("payments.tick_health_failed", { error: error instanceof Error ? error.message : String(error) });
    }
    if (!short) return;
    emitEvent("payments.tick_out_of_time", { pass, visited, skipped, consecutive }, "warn");
    if (consecutive !== null && consecutive >= starvedAfter(budgetMs)) emitEvent("payments.tick_starved", { pass, consecutive }, "error");
  }

  /** SagaNotifier: the engine calls this after any state change of an order-item attempt. */
  const notifier: SagaNotifier = {
    async bookingChanged(orderItemId: string, supplierState: string) {
      try {
        // The order's saga covers every item of the order (multi-item, lead-approved 3 Nov 2026).
        const item = await db.orderItem.findUnique({ where: { id: orderItemId }, select: { orderId: true } });
        const saga = item ? await db.paymentSaga.findUnique({ where: { orderId: item.orderId }, select: { id: true } }) : null;
        if (saga) await advance(saga.id);
      } catch (error) {
        // The engine's own transition already committed; the job retries from durable state.
        log.error("payments.booking_changed_failed", { orderItemId, supplierState, error: error instanceof Error ? error.message : String(error) });
      }
    },
  };

  return { advance, advanceOpen, handleEvent, notifier, refunds };
}

export type PaymentSagaService = ReturnType<typeof createPaymentSaga>;

/* ---------------------------------------------------------------------------
 * Production wiring. The engine side (Halyard, supplier-booking.service.ts)
 * registers its EngineSagaApi; until it does, every engine call refuses and
 * the saga stays where it is.
 * ------------------------------------------------------------------------ */

let engineApi: EngineSagaApi | null = null;

/** Called once by the engine module (or the composition root) with its EngineSagaApi. */
export function registerEngineSagaApi(api: EngineSagaApi): void {
  engineApi = api;
}

function unwired(): never {
  throw new Error("EngineSagaApi is not registered");
}

const lazyEngine: EngineSagaApi = {
  startAttempt: (tx, input) => (engineApi ? engineApi.startAttempt(tx, input) : unwired()),
  confirmIfPaid: (id) => (engineApi ? engineApi.confirmIfPaid(id) : unwired()),
  releaseHold: (id, reason) => (engineApi ? engineApi.releaseHold(id, reason) : unwired()),
  confirmSendBy: (id) => (engineApi ? engineApi.confirmSendBy(id) : unwired()),
};

export const paymentSaga: PaymentSagaService = createPaymentSaga({
  gateways: paymentGateways,
  engine: lazyEngine,
  bookings: dbBookingStateReader,
  now: () => new Date(),
});

/** What the engine calls after an order-item attempt changes state. */
export const sagaNotifier: SagaNotifier = paymentSaga.notifier;
