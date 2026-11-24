import "server-only";
import { Prisma, type SupplierBooking, type SupplierBookingState, type SupplierEnvironment } from "@prisma/client";
import { z } from "zod";
import { type Actor, hasPermission, requirePermission, SYSTEM_ACTOR } from "../lib/actor";
import { audit } from "../lib/audit";
import { sha256Hex } from "../lib/crypto";
import { prisma, TX_OPTIONS, type Tx } from "../lib/db";
import { Errors } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import {
  ANSWERED_UNVERIFIED_REASON,
  type AttemptRequest,
  bookingControlKeyFor,
  type CallObserver,
  type ConfirmationFailure,
  type ControlScope,
  type ExpectedBooking,
  GUARD_RELEASING_STATES,
  type IntentProvenance,
  type MutationOutcome,
  noPaymentEvidence,
  type PaymentEvidence,
  type PaymentEvidencePort,
  type PrivilegedOperation,
  type SupplierBookingAdapter,
  type SupplierRef,
  type SupplierSnapshot,
  type SupplierStatus,
  ticketCancelRefused,
  type WindowLister,
} from "../suppliers/booking-port";
import { RESERVE_REQUIRES, type SagaNotifier } from "../payments/contracts";
import type { TicketEvidence } from "../documents/contracts";
import { emitEvent } from "../lib/structured-events";
import { documentService, reportPersisted, type PersistResult } from "./document.service";
import { buildBookingRequest } from "../suppliers/traveldesk/traveldesk.booking";
import { type BrowseRoute, READ_BUDGET, type ReadClass, type ReadLimits } from "../suppliers/read-budget";
import { mutationHealth, READ_BUDGET_REASON, type ReadGate } from "../suppliers/traveldesk/traveldesk.booking-adapter";
import { isConfirmedSnapshot, withinChargeTolerance } from "../suppliers/traveldesk/traveldesk.confirmation";
import { SUPPLIER_WALLET_BOOK, type SupplierRefundFigure, walletEntriesFor, walletPhaseOf } from "../suppliers/wallet-ledger";
import { bookingAccountId, DEFAULT_BOOKING_ACCOUNT_ID } from "../suppliers/control-account";
import { checkOfferCapability } from "../suppliers/capability-gate";
import { bookingKindSellable, parseClassKey } from "../suppliers/traveldesk/traveldesk.capability";
import {
  EXTERNAL_FAILED_CODE,
  EXTERNAL_HANDOFF_CODE,
  EXTERNAL_HOLD_UNUSABLE_CODE,
  externalHandoffAt,
  externalHoldUsable,
  externalPollDelayMs,
  EXTERNAL_POLL_INTERVAL_MS,
} from "../suppliers/external-confirmation";
import {
  candidateSpendable,
  debitsWallet,
  DIRECTION_PAUSES,
  fundsRecheckDelayMs,
  type DirectionVerdict,
  type FundsRefusal,
  type FundsWithWallet,
  orderSpendable,
  runningAnchor,
  walletDirection,
  walletSpendable,
  type WalletFigures,
} from "../suppliers/wallet-funds";
import { APPROVAL_TTL_MS, canonicalPayload, OPERATION_PERMISSION, privilegedPayloadHash } from "./approval.service";

/**
 * Supplier booking engine (docs/backend/21 §5.3, §11, §15.3; doc 22 §23 B1).
 *
 * The engine talks to a `SupplierBookingAdapter` (booking-port.ts, SUP-19):
 * normalised mutation outcomes and snapshots. TravelDesk's numeric statuses
 * stay inside its adapter, except `snapshot.rawStatus`, which only the
 * confirmation predicate reads.
 *
 * Invariants:
 *  1. A booking row and its `request_sent` event are written, in the same
 *     transaction as the state change, BEFORE any supplier mutation, so a
 *     crash never loses a booking that may exist at the supplier.
 *  2. A mutation whose outcome we did not see becomes `outcome_unknown` and is
 *     NEVER resent automatically. Recovery looks it up: by id when we have
 *     one, else by service date + offer + client reference. Only a human may
 *     make a new attempt.
 *  3. One mutation at a time per supplier account and environment: a row
 *     lease timed by the database clock, fenced by `generation` and re-checked
 *     in the same transaction that records the send (SUP-11).
 *  4. "Confirmed" only when `isConfirmedSnapshot` passes (SUP-1).
 *  5. State changes are conditional on the expected state and written with
 *     their event and next job in one transaction (`transitionWithEvent`,
 *     SUP-8), so two workers never both act and a crash never strands a row.
 *  6. Only `GUARD_RELEASING_STATES` free the order item for another attempt,
 *     and each is entered only on its evidence (SUP-3). Every uncertain
 *     outcome keeps a blocking state and keeps looking, with
 *     `attention_required_at` telling a human (SUP-5). `manual_review` is left
 *     for the cases no re-read can settle (two bookings under one reference,
 *     an answer about someone else's booking).
 *  7. No remedy or refund path writes attempt state (SUP-20): only this file
 *     changes `supplier_bookings.state`.
 *
 * Payments are not taken here. A customer booking waits in `awaiting_payment`
 * after its reservation and is confirmed only when
 * `PaymentEvidencePort.capturedFor` returns provider-verified capture, re-read
 * right before the confirm is sent (PAY-1). The payment saga drives a
 * customer attempt only through `engineSagaApi` (engine-saga.service.ts) and
 * learns of every state change through the `SagaNotifier` (B3).
 *
 * Supplier wallet (PAY-10): each state change the supplier evidences
 * (reserve, confirm, cancel, expiry) appends `supplier_wallet` ledger entries
 * from the supplier's own figures, in the same transaction
 * (suppliers/wallet-ledger.ts).
 */

export const TRAVELDESK_SUPPLIER_CODE = "traveldesk";

/**
 * Operator controls, one `settings` row per supplier, environment and account
 * (`bookingControlKeyFor`, SUP-2, SUP-10), read fresh on every check:
 *  - `paused` with `scope`:
 *     - `new_sales` (the default): no new intents, and no reserve or create is
 *       sent. Confirms of existing reservations still go out inside their
 *       deadline, so a pause never strands a held reservation.
 *     - `all_writes`: emergency stop, confirm is held too. Reservations then
 *       lapse and the watchdog records them as expired.
 *    Cancel (it returns money), recovery, polling and the watchdog always run.
 *  - `maxBookingNetMinor`: per-booking cap on the expected net (AED minor).
 *  - `minFundsAfterMinor`: floor on the adapter's spendable funds after the booking.
 * A row that does not parse counts as an emergency stop (`all_writes`). A
 * missing row counts as paused in production and as the defaults in test.
 *
 * Account: the key's account segment is the pinned supplier account
 * (TravelDesk agencyId, TRAVELDESK_AGENCY_ID). `default` is used in test only,
 * while nothing is pinned; production without a pin sends no mutation.
 *
 * Changes (`setControl`): tightening (pause, a stricter scope, a lower cap, a
 * higher floor) needs `suppliers.pause` and nothing else. Loosening (resume,
 * clearing `all_writes`, a higher cap, a lower floor) needs an applied
 * privileged approval (approval.service.ts; production: a second person).
 */
export const bookingControlSchema = z.object({
  paused: z.boolean().default(false),
  scope: z.enum(["new_sales", "all_writes"]).default("new_sales"),
  reason: z.string().max(300).optional(),
  maxBookingNetMinor: z.number().int().positive().default(500_000),
  minFundsAfterMinor: z.number().int().min(0).default(0),
});
export type BookingControl = z.infer<typeof bookingControlSchema>;

// The account helpers live in a pure module so the admin page and action share them (doc 29 D2); re-exported for existing callers.
export { bookingAccountId, DEFAULT_BOOKING_ACCOUNT_ID, pinnedControlAccount } from "../suppliers/control-account";

export function bookingControlKey(supplierCode: string, environment: SupplierEnvironment, accountId: string = DEFAULT_BOOKING_ACCOUNT_ID) {
  return bookingControlKeyFor(supplierCode, environment, accountId);
}

/** The pre-B1a key, read in test only while the new row is missing. */
export function legacyBookingControlKey(supplierCode: string) {
  return `supplier_bookings.${supplierCode}`;
}

/** What a row that does not parse means: an emergency stop, never anything weaker (fail closed). */
function invalidControl(reason: string): BookingControl {
  return { ...bookingControlSchema.parse({}), paused: true, scope: "all_writes", reason };
}

/** What a missing row means: paused in production, the defaults in test. */
function missingControl(environment: SupplierEnvironment): BookingControl {
  const d = bookingControlSchema.parse({});
  return environment === "production" ? { ...d, paused: true, reason: "No control row for production; paused until an operator resumes" } : d;
}

export async function bookingControl(supplierCode: string, environment: SupplierEnvironment, accountId: string = DEFAULT_BOOKING_ACCOUNT_ID): Promise<BookingControl> {
  return (await readControl(supplierCode, environment, accountId)).control;
}

/** The control and whether an operator row exists for it (the manual worker run needs one, SEC-8). */
export async function readControl(supplierCode: string, environment: SupplierEnvironment, accountId: string) {
  let row = await prisma.setting.findUnique({ where: { key: bookingControlKey(supplierCode, environment, accountId) } });
  const explicit = row !== null;
  if (!row && environment === "test") row = await prisma.setting.findUnique({ where: { key: legacyBookingControlKey(supplierCode) } });
  if (!row) return { control: missingControl(environment), explicit };
  const r = bookingControlSchema.safeParse(row.value);
  return { control: r.success ? r.data : invalidControl("The control setting is invalid"), explicit };
}

/** Job kinds a control holds back. Cancel, recover, poll and watchdog are never held. */
export function heldKinds(c: BookingControl): string[] {
  if (!c.paused) return [];
  return c.scope === "all_writes" ? ["reserve", "create", "confirm"] : ["reserve", "create"];
}

/** Frozen in booking-port.ts (B2); re-exported for callers that imported them from here. */
export type { CallObserver, WindowLister };

export interface EngineDeps {
  adapter: SupplierBookingAdapter & CallObserver;
  /** The adapter's environment. A worker only ever claims jobs of bookings in this environment. */
  environment: SupplierEnvironment;
  now?: () => Date;
  /** Identifies this worker in leases and job locks. */
  holder?: string;
  /** Tests isolate on their own supplier row. */
  supplierCode?: string;
  /** Upper bound for one mutation call (TRAVELDESK_TIMEOUT_MS). */
  mutationTimeoutMs?: number;
  /** Supplier account this worker acts for (`bookingAccountId`). Undefined: `default` in test, none in production. */
  accountId?: string | null;
  /** Provider-verified capture for customer bookings (PAY-1). Default `noPaymentEvidence`; the worker routes pass `dbPaymentEvidence`. */
  payments?: PaymentEvidencePort;
  /**
   * The same evidence read on the confirm's send transaction (CR-B3-1), so the
   * last re-read sees what the locks it holds protect and never needs a second
   * connection. The worker route passes `paymentEvidenceFrom`. Without it the
   * re-read goes through `payments` (test fakes that do not touch the database).
   */
  paymentsInTx?: (tx: Tx) => PaymentEvidencePort;
  /** Told after every committed state change of an order-item attempt (B3). Default: nobody. */
  saga?: SagaNotifier;
  /**
   * Whether this run may send mutations (reserve, confirm, create, cancel).
   * False runs recovery and read jobs only. `paid_only` (the scheduled cron
   * run, B3) adds the two mutations a customer's payment backs, for
   * order-item attempts only: the reserve, sent only while the item's payment
   * saga holds a provider-verified payment that backs it (`reserveBackedBy`,
   * CR-B3-5), and the confirm, which the confirm job sends only on
   * provider-verified capture. B5 adds one cancel: an order-item attempt's
   * cancel, sent only while an open supported customer cancellation request
   * names that attempt (`cancelRequested`). Doc 22 §32.22 (owner, 4 Nov
   * 2026) adds the payment saga's hold release: an order-item attempt's
   * cancel after `releaseHold` recorded `release_requested` and while no
   * confirm was ever sent for it (`releaseCancelDue`), so a failed order's
   * earlier holds stop debiting the supplier balance without a manual run.
   * Drill reserves, creates and cancels, and every other cancel (an
   * operator's), stay manual (SEC-8, doc 22 §26 F38).
   */
  mutations?: boolean | "paid_only";
  /**
   * Test seam only: the read budget this engine counts against (SUP-6).
   * Production never sets it, so every taker uses `READ_BUDGET` (N5).
   */
  readLimits?: ReadLimits;
  /** Expected p95 of one mutation call, for reserve admission (SUP-7). */
  mutationP95Ms?: number;
  /** How often a held mutation lease is extended while its job runs (CR-B1-7). Default 30 s. */
  leaseHeartbeatMs?: number;
  /**
   * Told once about each order-item booking this run confirmed with its own
   * confirm call (not a poll, recovery or watchdog read: TravelDesk's 10 s
   * rule), after the job loop has finished: outside every transaction, with
   * no mutation lease held, never while another worker's mutation is in
   * flight on the account, and only with `AFTER_CONFIRM_MIN_REMAINING_MS`
   * of the run's budget left (checkout redesign batch 4, CO-40: the worker
   * route fetches the voucher in the same run). It never delays a job. Best
   * effort: a failure is reported and swallowed; the documents tick does the
   * same work later. Default: nobody.
   */
  afterConfirmed?: (booking: SupplierBooking) => Promise<unknown>;
}

type Deps = EngineDeps & { now: () => Date; holder: string; mutationTimeoutMs: number; confirmedInRun?: SupplierBooking[] };
interface Lease {
  holder: string;
  generation: bigint;
}

/** Closed states. The guard-releasing ones come from the frozen contract; the rest keep the order item locked. */
const TERMINAL: SupplierBookingState[] = [...GUARD_RELEASING_STATES, "confirmed", "cancel_refused", "manual_review"];
/** States recovery works on: nothing is resent from any of them. */
const RECOVERING: SupplierBookingState[] = ["outcome_unknown", "not_found_unresolved", "cancel_unverified"];
/**
 * States whose attention flag holds an automatic money step, so staff may not
 * clear it (`clearAttention`; B5 moves no money from the console):
 *  - holding and sending states: a confirm is never sent automatically for a
 *    booking a human was told about (CR-B3-5);
 *  - the recovering states: there the flag can be the late-acceptance hold
 *    (CR-B1-10), and once a read shows the reservation it would land in
 *    `reserved` without a flag and queue a confirm (R-B5-6).
 * A booking with a late-acceptance alert is refused in every state, except
 * the dedicated `late_acceptance_resolved` clear once it is settled (R-B5-16,
 * `lateAcceptanceSettled`: a supplier read shows it ended, or it is confirmed
 * and the item's only live attempt).
 */
export const ATTENTION_HOLDS_STATES: readonly SupplierBookingState[] = Object.freeze([
  "queued",
  "reserving",
  "reserved",
  "awaiting_payment",
  "confirming",
  "awaiting_external",
  ...RECOVERING,
]);
/** Alert reasons `reblockLateAcceptance` records; `wasLateAccepted` reads them. */
const LATE_ACCEPTANCE_REASONS = ["late_acceptance", "late_acceptance_duplicate"];
/** R-B5-16 (a): the end states a supplier read can show for a late-accepted booking, with the status that shows it. */
const SUPPLIER_ENDED_STATUS: Partial<Record<string, string>> = { cancelled: "CANCELLED", expired: "EXPIRED", rejected: "REJECTED" };
/** A reservation that may still be held at the supplier. */
const HOLDING: SupplierBookingState[] = ["reserved", "awaiting_payment"];
/** A mutation is in flight from these. */
const SENDING: SupplierBookingState[] = ["reserving", "confirming", "cancelling"];
const CANCELLABLE: SupplierBookingState[] = ["reserved", "awaiting_payment", "confirmed", "awaiting_external"];

/** States in which the scheduled run sends a saga's hold-release cancel: a hold, or a lookup the cancel waits for (doc 22 §32.22, review P3-6). */
const RELEASE_CANCEL_STATES: readonly SupplierBookingState[] = [...HOLDING, ...RECOVERING];
/** A released hold the supplier refused to cancel, left to lapse at its deadline (review 86 B5-01). */
const RELEASE_LAPSES_CODE = "release_cancel_refused_hold_lapses";

/**
 * External-confirmation polling, wait limit and hold length (SUP-17, doc 29
 * Batch 6): `src/server/suppliers/external-confirmation.ts`. The first poll
 * follows the answer that left the booking in `awaiting_external` by this.
 */
const POLL_INTERVAL_MS = EXTERNAL_POLL_INTERVAL_MS;
const RECOVERY_DELAY_MS = 30_000;
const RECOVERY_MIN_SEARCHES = 2;
/** A lost reserve is reported unresolved only after the 15-minute hold plus a margin (Q-B5). */
const RESERVE_SETTLED_MS = 17 * 60_000;
/** Longest wait between re-reads of an unresolved booking. */
const REREAD_MAX_BACKOFF_MS = 30 * 60_000;
/**
 * Least time that must be left before a reservation's deadline for a confirm
 * to be sent (SUP-2): the longest allowed confirm call (240 s) plus queue wait
 * and the unknown timezone of the deadline (Q-A2). Never less than this
 * worker's own mutation timeout plus a minute. Checked on the worker's clock
 * before the send, and last on the database clock in `startSend`, corrected
 * by the reserving worker's recorded skew (CR-B1-6).
 */
const CONFIRM_BUDGET_MS = 5 * 60_000;
/** The watchdog reads a reservation this long after its deadline. */
const WATCHDOG_MARGIN_MS = 60_000;
/** Read-job errors before a dead-letter alert. Reads go on after it with capped backoff (SUP-5). */
const READ_JOB_ALERT_ERRORS = 5;
const READ_RETRY_MAX_MS = 30 * 60_000;
const DEFAULT_MUTATION_P95_MS = 30_000;
/** A held mutation lease is extended this often while its job runs (CR-B1-7). */
const LEASE_HEARTBEAT_MS = 30_000;
/** A mutation starts only with its timeout plus this much of the run's (mutation) budget left. */
export const MUTATION_START_MARGIN_MS = 30_000;
/** `afterConfirmed` runs only with this much of the run's budget left (CO-40): a voucher download and a store put at their timeouts. */
export const AFTER_CONFIRM_MIN_REMAINING_MS = 60_000;
/**
 * Closed rows reconciliation still compares in full (SUP-12). An older closed
 * row the supplier lists under our reference is loaded too: it is re-blocked
 * when it released the guard and the supplier shows it live, and otherwise
 * counted as `skippedClosed`, never dropped silently (CR-B1-2).
 */
export const RECONCILE_RECENT_CLOSED_MS = 14 * 86_400_000;
const RECONCILE_MAX_ISSUES = 100;

const MUTATION_KINDS = ["reserve", "confirm", "create", "cancel"];
/** Mutations the scheduled (`paid_only`) run may claim, each for order-item attempts only and each with its own gate. */
const PAID_ONLY_KINDS = ["reserve", "confirm", "cancel"];
/** Cancellation request statuses whose engine cancel the scheduled run sends (B5; the SQL claim lists the same three). */
const PAID_ONLY_CANCEL_STATUSES = ["requested", "cancelling", "cancel_unverified"] as const;
/** Claim order (migration 20261101110000): releases, then confirms, then recovery, then new sales. */
const JOB_PRIORITY: Record<string, number> = { cancel: 30, confirm: 20, recover: 10, poll: 10, watchdog: 10, reserve: 0, create: 0 };
const OPERATION = { reserve: "bookings.reserve", create: "bookings.create", confirm: "bookings.confirm", cancel: "bookings.cancel" } as const;

/**
 * `after_reserve` for a customer booking (PAY-1): it waits for captured
 * payment. Rows written by B1a before the check allowed it say `hold`; their
 * order link is what routes them (`needsPayment`).
 */
const CUSTOMER_AFTER_RESERVE = "await_payment";

export interface BookingIntentInput {
  environment: SupplierEnvironment;
  idempotencyKey: string;
  orderId?: string | null;
  orderItemId?: string | null;
  mappingId?: string | null;
  bookingKind: "live_book" | "ticket_only";
  mode?: "two_step" | "one_step";
  /**
   * What follows the reservation. Drills choose `confirm`, `cancel` or `hold`.
   * An intent with an order item always waits for payment (`await_payment`).
   */
  afterReserve?: "confirm" | "cancel" | "hold" | "await_payment";
  tourId: number;
  offerId: number;
  serviceDate: string;
  slot?: { timeSlotId: number; startMinutes: number; endMinutes: number } | null;
  adults: number;
  children?: number;
  infants?: number;
  hotelId?: number | null;
  guestName: string;
  expectedNetMinor: bigint;
  expectedNetUsdMinor: bigint;
  requestedBy?: string | null;
  remarks?: string | null;
  /**
   * Doc 29 Batch 6: a sandbox drill on an external-route offer. A customer
   * intent never sets it: its route comes from the capability verdict.
   */
  externalRoute?: boolean;
}

/**
 * `createIntent` input (doc 22 §24.2). A customer intent names its order item
 * and carries its provenance; only `instant_checkout` may create a supplier
 * attempt (PRD-3). An intent without an order item must say `drill: true`
 * (SUP-20). The client reference is always engine-derived (SUP-9).
 */
export type CreateIntentInput = BookingIntentInput & (({ drill?: false } & IntentProvenance) | { drill: true; fulfilmentOrigin?: undefined; quoteId?: undefined });

/* ---------------------------------------------------------------------------
 * Small helpers
 * ------------------------------------------------------------------------ */

async function supplierFor(code: string) {
  const s = await prisma.supplier.findUnique({ where: { code } });
  if (!s) throw Errors.notConfigured(`supplier ${code}`);
  return s;
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function engineAccount(deps: Pick<EngineDeps, "accountId" | "environment">): string | null {
  return deps.accountId === undefined ? bookingAccountId(deps.environment, null) : deps.accountId;
}

/** Event detail keys an event may carry (SEC-11): codes, counts and ids only, never supplier free text or PII. */
const DETAIL_KEYS = new Set([
  "via",
  "reason",
  "supplierStatus",
  "rawStatus",
  "failures",
  "search",
  "listed",
  "matches",
  "complete",
  "msLeft",
  "error",
  "sent",
  "paymentId",
  "provider",
  "skewMs",
  "dbSkewMs",
  "mode",
  "afterReserve",
  "pollCount",
  "errors",
  "jobKind",
  "code",
  "account",
  "approvalId",
  // Wallet funds (doc 29 §4.5): AED minor units of the agency wallet, never a per-booking supplier price beyond the expected net already stored on the row.
  "fundsMinor",
  "runningMinor",
  "expectedMinor",
  "deltaMinor",
  "verdict",
  // The state the engine kept after an accepted answer (a short code), for the direction guard's not_applicable record.
  "outcome",
]);
const DETAIL_CODE = /^[A-Za-z0-9_.:-]{1,80}$/;

function detailValue(v: unknown): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") return DETAIL_CODE.test(v) ? v : undefined;
  if (Array.isArray(v)) return v.slice(0, 20).map(detailValue).filter((x) => x !== undefined);
  return undefined;
}

/** The allowlisted part of an event detail (SEC-11). Unknown keys and free-text values are dropped. */
export function safeEventDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail ?? {})) {
    if (!DETAIL_KEYS.has(k)) continue;
    const x = detailValue(v);
    if (x !== undefined) out[k] = x;
  }
  return out;
}

type Db = Tx | typeof prisma;

async function writeEvent(
  db: Db,
  bookingId: string,
  kind: string,
  data: { operation?: string; httpStatus?: number | null; durationMs?: number; fromState?: string; toState?: string; detail?: Record<string, unknown>; actor?: string } = {},
) {
  await db.supplierBookingEvent.create({
    data: {
      id: uuidv7(),
      supplierBookingId: bookingId,
      kind,
      operation: data.operation,
      httpStatus: data.httpStatus ?? undefined,
      durationMs: data.durationMs,
      fromState: data.fromState,
      toState: data.toState,
      actor: data.actor ?? "system",
      detail: safeEventDetail(data.detail) as Prisma.InputJsonValue,
    },
  });
}

/** Whether the payment saga asked for this attempt's hold to be released (`releaseHold`). Once asked, no confirm is sent. */
async function releaseRequested(db: Db, bookingId: string) {
  return (await db.supplierBookingEvent.count({ where: { supplierBookingId: bookingId, kind: "release_requested" } })) > 0;
}

/**
 * Queue (or re-queue) the single job of `kind` for a booking, with its claim
 * priority. A job another worker is running is left alone; a handler
 * re-queuing its own job (`holder`) flips it back to queued. Re-queuing is
 * progress, so the error count starts again (SUP-5). A re-queue without a
 * deadline keeps the one the job has (CR-B1-5), so a lease-busy or held
 * confirm still sorts and counts by its send deadline (SUP-7).
 */
async function enqueue(db: Db, kind: string, bookingId: string, runAfter: Date, holder?: string, deadlineAt: Date | null = null) {
  const priority = JOB_PRIORITY[kind] ?? 0;
  // One statement, so two concurrent callers cannot collide on dedupe_key.
  await db.$executeRaw`
    INSERT INTO supplier_jobs (id, kind, supplier_booking_id, dedupe_key, run_after, status, deadline_at, priority, updated_at)
    VALUES (${uuidv7()}::uuid, ${kind}, ${bookingId}::uuid, ${`${kind}:${bookingId}`}, ${runAfter}, 'queued', ${deadlineAt}::timestamptz, ${priority}, now())
    ON CONFLICT (dedupe_key) DO UPDATE
      SET status = 'queued', run_after = EXCLUDED.run_after, deadline_at = COALESCE(EXCLUDED.deadline_at, supplier_jobs.deadline_at), priority = EXCLUDED.priority,
          attempts = 0, locked_by = NULL, locked_until = NULL, last_error = NULL, updated_at = now()
      WHERE supplier_jobs.status <> 'running' OR supplier_jobs.locked_by = ${holder ?? null}`;
}

interface NextJob {
  kind: string;
  runAfter: Date;
  deadlineAt?: Date | null;
}

/** Supplier evidence a transition records in the supplier wallet book. */
interface WalletEvidence {
  snapshot: SupplierSnapshot & SupplierRefundFigure;
  supplierCode: string;
  at: Date;
}

/**
 * Append the supplier wallet entries a supplier answer evidences (PAY-10),
 * inside the transition's transaction: the booking row is locked by the
 * conditional update, so two transitions of one booking never both write.
 * Amounts come from the supplier's figures only, in AED minor units.
 */
async function recordWallet(tx: Tx, b: SupplierBooking, w: WalletEvidence) {
  const phase = walletPhaseOf(b.state);
  if (!phase) return;
  const recorded = await tx.ledgerEntry.findMany({ where: { book: SUPPLIER_WALLET_BOOK, supplierBookingId: b.id }, select: { kind: true, amountMinor: true } });
  const entries = walletEntriesFor({ phase, snapshot: w.snapshot, recorded });
  // The environment and account are in the reference: the book has no column for them, and sandbox money is not real.
  const evidenceRef = `${w.supplierCode}.${b.environment}.${b.accountId}:booking:${w.snapshot.ref}:status:${w.snapshot.rawStatus}`;
  for (const e of entries) {
    await tx.ledgerEntry.create({
      data: { id: uuidv7(), book: SUPPLIER_WALLET_BOOK, orderId: b.orderId, supplierBookingId: b.id, currency: "AED", amountMinor: e.amountMinor, kind: e.kind, evidenceRef, occurredAt: w.at },
    });
  }
}

/** No-op notifier: what an engine without a payment saga uses. */
export const noSagaNotifier: SagaNotifier = {
  async bookingChanged() {},
};

/**
 * Tell the payment saga about a committed state change of an order-item
 * attempt (B3). Best effort: a failure is swallowed, because the saga's own
 * tick re-reads every attempt it waits on.
 */
async function notifySaga(saga: SagaNotifier | undefined, b: Pick<SupplierBooking, "orderItemId" | "state">) {
  if (!saga || !b.orderItemId) return;
  try {
    await saga.bookingChanged(b.orderItemId, b.state);
  } catch {
    // The saga tick covers a missed notification.
  }
}

/**
 * `transitionWithEvent(tx, …)` (SUP-8): the conditional state change, its
 * event and the next jobs in one transaction. Returns the row when this caller
 * won, null when another worker moved it first. Pass `tx` to join a caller's
 * transaction. With `wallet`, the supplier wallet entries that answer
 * evidences are written in the same transaction. With `saga`, an order-item
 * attempt's new state is reported after the commit; inside a caller's `tx`
 * the caller owns the commit, so nothing is reported. `afterWrite` runs last
 * inside the same transaction (B4: ticket codes persist with `confirmed`);
 * when it throws, the whole transition rolls back.
 */
export async function transitionWithEvent(
  b: Pick<SupplierBooking, "id" | "state">,
  to: SupplierBookingState,
  data: Prisma.SupplierBookingUpdateManyMutationInput = {},
  opts: {
    detail?: Record<string, unknown>;
    next?: NextJob[];
    holder?: string;
    tx?: Tx;
    saga?: SagaNotifier;
    wallet?: WalletEvidence;
    afterWrite?: (tx: Tx, row: SupplierBooking) => Promise<unknown>;
  } = {},
): Promise<SupplierBooking | null> {
  const run = async (tx: Tx) => {
    const closedAt = TERMINAL.includes(to) ? new Date() : null;
    const res = await tx.supplierBooking.updateMany({ where: { id: b.id, state: b.state }, data: { ...data, closedAt, state: to } });
    if (res.count === 0) return null;
    await writeEvent(tx, b.id, b.state === to ? "update" : "state_change", { fromState: b.state, toState: to, detail: opts.detail });
    for (const j of opts.next ?? []) await enqueue(tx, j.kind, b.id, j.runAfter, opts.holder, j.deadlineAt ?? null);
    const row = await tx.supplierBooking.findUniqueOrThrow({ where: { id: b.id } });
    if (opts.wallet) await recordWallet(tx, row, opts.wallet);
    if (opts.afterWrite) await opts.afterWrite(tx, row);
    return row;
  };
  if (opts.tx) return run(opts.tx);
  const row = await prisma.$transaction(run, TX_OPTIONS);
  if (row && row.state !== b.state) await notifySaga(opts.saga, row);
  return row;
}

/** The least time a confirm needs before the reservation deadline (SUP-2). */
function confirmBudgetMs(deps: Pick<EngineDeps, "mutationTimeoutMs">) {
  return Math.max(CONFIRM_BUDGET_MS, (deps.mutationTimeoutMs ?? 150_000) + 60_000);
}

/** The fields `confirmSendBy` reads. The external route and the hold's start are optional: absent reads as internal. */
type SendByFields = Pick<SupplierBooking, "reservationDeadline"> & Partial<Pick<SupplierBooking, "externalRoute" | "reservedAt">>;

/**
 * Last instant a confirm may be sent for this reservation; null when the
 * deadline is unknown (then none may be). Doc 29 Batch 6: an external hold
 * that is too short to confirm safely (`externalHoldUsable`: less than
 * `EXTERNAL_MIN_HOLD_MS` from the reserve answer to the deadline, or of
 * unknown length) has no send-by either, so no confirm is ever queued or sent
 * for it and the payment saga releases it at once (an unknown send-by never
 * captures).
 */
export function confirmSendBy(b: SendByFields, deps: Pick<EngineDeps, "mutationTimeoutMs">) {
  if (!b.reservationDeadline) return null;
  if (b.externalRoute === true && !externalHoldUsable(b.reservedAt ?? null, b.reservationDeadline)) return null;
  return new Date(b.reservationDeadline.getTime() - confirmBudgetMs(deps));
}

/**
 * `confirmSendBy` on the database clock (CR-B1-6): the reservation deadline
 * was derived from `requestSentAt`, which the reserving worker stamped on its
 * own clock, so the instant is moved by that worker's recorded skew. `dbClock`
 * is false for rows sent before the skew was recorded; the instant is then on
 * the reserving worker's clock. Null when the deadline is unknown.
 */
export function confirmSendByOnDbClock(b: SendByFields, deps: Pick<EngineDeps, "mutationTimeoutMs">, skewMs: number | null): { at: Date; dbClock: boolean } | null {
  const sendBy = confirmSendBy(b, deps);
  if (!sendBy) return null;
  return skewMs === null ? { at: sendBy, dbClock: false } : { at: new Date(sendBy.getTime() - skewMs), dbClock: true };
}

/**
 * The confirm deadline gate (SUP-2), one rule for the engine and the payment
 * saga (`EngineSagaApi.confirmSendBy`): true when a confirm may no longer be
 * sent, because the deadline is unknown, or `t` (this worker's clock) is past
 * the send-by, or `dbNow` is past it on the database clock once the skew is
 * known.
 */
export function pastConfirmSendBy(b: SendByFields, deps: Pick<EngineDeps, "mutationTimeoutMs">, skewMs: number | null, t: Date, dbNow: Date): boolean {
  const sendBy = confirmSendBy(b, deps);
  if (!sendBy || t.getTime() > sendBy.getTime()) return true;
  const onDb = confirmSendByOnDbClock(b, deps, skewMs);
  return Boolean(onDb?.dbClock && dbNow.getTime() > onDb.at.getTime());
}

/** The clock skew the reserving worker recorded on its `request_sent` (`dbSkewMs`), or null. */
async function reserveSkewMs(db: Db, bookingId: string): Promise<number | null> {
  const reserved = await db.supplierBookingEvent.findFirst({
    where: { supplierBookingId: bookingId, kind: "request_sent", operation: { in: [OPERATION.reserve, OPERATION.create] } },
    orderBy: { at: "desc" },
    select: { detail: true },
  });
  const skew = (reserved?.detail as { dbSkewMs?: unknown } | null)?.dbSkewMs;
  return typeof skew === "number" && Number.isFinite(skew) ? skew : null;
}

/** The payment saga state in which the attempt's reserve is the next step (`startAttempt` moves it there; payments/saga.ts). */
const RESERVE_SAGA_STATES: readonly string[] = ["reserve_pending"];

const reserveBackingSelect = {
  orderId: true,
  orderItemId: true,
  state: true,
  attentionRequiredAt: true,
  // Multi-item, lead-approved 3 Nov 2026: every instant item of the saga's order belongs to the saga.
  order: { select: { items: { select: { id: true, fulfilmentOrigin: true } } } },
  payment: {
    select: {
      orderId: true,
      gateway: true,
      provider: true,
      gatewayPaymentId: true,
      source: true,
      status: true,
      amountMinor: true,
      capturedMinor: true,
      refundedMinor: true,
      capturedAt: true,
      authorizedAt: true,
      authorizationExpiresAt: true,
      threeDs: true,
      risk: true,
      refunds: { where: { status: { not: "failed" } }, select: { id: true } },
    },
  },
} satisfies Prisma.PaymentSagaSelect;

export type ReserveBackingRow = Prisma.PaymentSagaGetPayload<{ select: typeof reserveBackingSelect }>;

/**
 * Whether a payment backs the reserve of this order-item attempt (CR-B3-5),
 * on rows already read from `payment_sagas` and `payments`. The scheduled
 * worker sends a customer reserve only when this holds; the confirm still
 * needs `PaymentEvidencePort` evidence of capture. Every rule must hold:
 *  - the item's payment saga, for this order, in `reserve_pending`, with no
 *    attention flag, bound to a payment of this order. The saga names the
 *    order's first item; another item is the saga's when it is an
 *    `instant_checkout` item of the same order (multi-item, lead-approved
 *    3 Nov 2026);
 *  - the payment is provider-verified (`gateway_verified`, a provider and its
 *    payment id; never a manual row), and no refund on it has been opened;
 *  - 3DS and risk inside `RESERVE_REQUIRES` (PAY-6);
 *  - capture first: `captured`, with the whole amount captured and nothing
 *    refunded; or a card hold: `authorized`, with an authorization time and
 *    an expiry after `at`.
 */
export function reserveBackedBy(b: { orderId: string; orderItemId: string }, sagas: ReserveBackingRow[], at: Date): boolean {
  return sagas.some((saga) => {
    if (saga.orderId !== b.orderId || saga.attentionRequiredAt) return false;
    const member = saga.orderItemId === b.orderItemId || saga.order.items.some((i) => i.id === b.orderItemId && i.fulfilmentOrigin === "instant_checkout");
    if (!member) return false;
    if (!RESERVE_SAGA_STATES.includes(saga.state)) return false;
    const p = saga.payment;
    if (!p || p.orderId !== b.orderId || p.amountMinor <= 0n) return false;
    if (p.source !== "gateway_verified" || p.gateway === "manual" || !p.provider || !p.gatewayPaymentId || p.refunds.length > 0) return false;
    if (!(RESERVE_REQUIRES.threeDs as readonly (string | null)[]).includes(p.threeDs) || !(RESERVE_REQUIRES.risk as readonly (string | null)[]).includes(p.risk)) return false;
    if (p.status === "captured") return Boolean(p.capturedAt) && p.refundedMinor === 0n && p.capturedMinor >= p.amountMinor;
    if (p.status === "authorized") return Boolean(p.authorizedAt) && p.authorizationExpiresAt !== null && p.authorizationExpiresAt.getTime() > at.getTime();
    return false;
  });
}

function confirmJob(b: SendByFields, runAfter: Date, deps: Pick<EngineDeps, "mutationTimeoutMs">): NextJob {
  return { kind: "confirm", runAfter, deadlineAt: confirmSendBy(b, deps) };
}

function watchdogJob(b: Pick<SupplierBooking, "reservationDeadline">, t: Date): NextJob {
  const deadline = b.reservationDeadline?.getTime() ?? t.getTime() + 15 * 60_000;
  return { kind: "watchdog", runAfter: new Date(Math.max(deadline + WATCHDOG_MARGIN_MS, t.getTime() + 60_000)) };
}

/** Wait between re-reads of an unresolved booking: a quarter of its age, within [floor, 30 min]. */
function rereadBackoffMs(b: SupplierBooking, now: Date, floorMs: number) {
  const age = now.getTime() - (b.requestSentAt ?? b.createdAt).getTime();
  return Math.min(REREAD_MAX_BACKOFF_MS, Math.max(floorMs, Math.floor(age / 4)));
}

/** What Outly asked for, for the confirmation predicate. */
function expectedFrom(b: SupplierBooking): ExpectedBooking {
  return {
    clientRef: b.clientRef,
    offerExternalId: b.offerExternalId,
    tourExternalId: b.tourExternalId,
    serviceDate: isoDate(b.serviceDate),
    timeSlotId: b.timeSlotId,
    startMinutes: b.startMinutes,
    adults: b.adults,
    children: b.children,
    infants: b.infants,
    expectedNetMinor: b.expectedNetMinor,
  };
}

function refOf(b: SupplierBooking): SupplierRef {
  return { supplierBookingId: b.supplierBookingId!, serviceDate: isoDate(b.serviceDate), offerExternalId: b.offerExternalId };
}

/**
 * A customer booking: confirm needs provider-verified capture (PAY-1). Any link
 * to an order decides, whatever after_reserve says.
 */
function isCustomerIntent(b: { orderId?: string | null; orderItemId?: string | null }) {
  return (b.orderId ?? null) !== null || (b.orderItemId ?? null) !== null;
}

function needsPayment(b: SupplierBooking) {
  return isCustomerIntent(b) || b.afterReserve === "await_payment";
}

/** Whether a supplier answer is about our booking, before it may release the order item (SUP-3). */
function isSameBooking(b: SupplierBooking, s: SupplierSnapshot) {
  if (b.supplierBookingId !== null && s.ref !== b.supplierBookingId) return false;
  return s.bookingReference === null || s.bookingReference === b.clientRef;
}

/** The job that moves a booking on from a waiting state. Handlers check state first, so an extra job is harmless. */
function nextJobKind(b: SupplierBooking): string | null {
  switch (b.state) {
    case "queued":
      return b.mode === "one_step" ? "create" : "reserve";
    case "reserved":
      // A reservation a human was told about is never confirmed automatically; the watchdog records its end.
      if (b.attentionRequiredAt) return "watchdog";
      return b.afterReserve === "confirm" ? "confirm" : b.afterReserve === "cancel" ? "cancel" : "watchdog";
    case "awaiting_payment":
      // Confirm is queued only on payment evidence (confirmIfPaid), never by the sweep.
      return "watchdog";
    case "outcome_unknown":
    case "not_found_unresolved":
    case "cancel_unverified":
      return "recover";
    case "awaiting_external":
      return "poll";
    default:
      return null;
  }
}

/** What a snapshot status moves a booking to; null for a status the engine does not act on. */
function stateFor(status: SupplierStatus): SupplierBookingState | null {
  switch (status) {
    case "ON_HOLD":
      return "reserved";
    case "EXPIRED":
      return "expired";
    case "CANCELLED":
      return "cancelled";
    case "CONFIRMED":
      return "confirmed";
    case "PENDING":
      return "awaiting_external";
    case "REJECTED":
      // Doc 29 Batch 6: TravelDesk documents `isExternalBookingFailed` after the external confirmation finished as a
      // rejection (the booking is created, 201, and failed). Its adapter reports REJECTED for that case only.
      return "rejected";
    default:
      return null; // UNKNOWN is unknown
  }
}

function snapshotJson(s: SupplierSnapshot): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/** Columns a supplier answer fills. An absent field leaves the column as it was. */
function responseData(s: SupplierSnapshot): Prisma.SupplierBookingUpdateManyMutationInput {
  return {
    supplierBookingId: s.ref,
    supplierStatusCode: s.rawStatus,
    externalInProgress: s.externalInProgress ?? undefined,
    externalFailed: s.externalFailed ?? undefined,
    hasTickets: s.ticketsIssued === true ? true : undefined,
    chargedNetMinor: s.chargedNetMinor ?? undefined,
    // Kept when a later answer omits them (doc 29 §8.7; review 86 B5-07): the list re-read carries neither.
    pickupTimeMinutes: typeof s.pickupMinutes === "number" ? s.pickupMinutes : undefined,
    ticketsValidUntil: s.ticketsValidUntil && /^\d{4}-\d{2}-\d{2}$/.test(s.ticketsValidUntil) ? new Date(`${s.ticketsValidUntil}T00:00:00Z`) : undefined,
    lastResponse: snapshotJson(s),
  };
}

/** Request identity for idempotency (SUP-9): the immutable selection; the guest name only as a hash. */
function requestHashOf(input: CreateIntentInput, mode: string, afterReserve: string) {
  const canonical = {
    environment: input.environment,
    orderItemId: input.orderItemId ?? null,
    mappingId: input.mappingId ?? null,
    bookingKind: input.bookingKind,
    mode,
    afterReserve,
    tourId: input.tourId,
    offerId: input.offerId,
    serviceDate: input.serviceDate,
    slot: input.slot ? [input.slot.timeSlotId, input.slot.startMinutes, input.slot.endMinutes] : null,
    pax: [input.adults, input.children ?? 0, input.infants ?? 0],
    hotelId: input.hotelId ?? null,
    expectedNetMinor: input.expectedNetMinor.toString(),
    expectedNetUsdMinor: input.expectedNetUsdMinor.toString(),
    fulfilmentOrigin: input.fulfilmentOrigin ?? null,
    quoteId: input.quoteId ?? null,
    guest: sha256Hex(input.guestName.trim()),
    remarks: input.remarks ? sha256Hex(input.remarks) : null,
  };
  return sha256Hex(JSON.stringify(canonical));
}

/** Engine-derived client reference: prefix plus the random tail of the booking id (SUP-9). 26 characters. */
function clientRefFor(bookingId: string) {
  return `${ENGINE_REFERENCE_PREFIX}${bookingId.replace(/-/g, "").slice(12).toUpperCase()}`;
}

/* ---------------------------------------------------------------------------
 * Lease, lane and read budget (SUP-6, SUP-11): database clock only
 * ------------------------------------------------------------------------ */

async function acquireLease(b: Pick<SupplierBooking, "supplierId" | "environment" | "accountId">, holder: string, ttlMs: number): Promise<Lease | null> {
  await prisma.$executeRaw`
    INSERT INTO supplier_account_leases (supplier_id, environment, account_id, lease_until)
    VALUES (${b.supplierId}::uuid, ${b.environment}::supplier_environment, ${b.accountId}, 'epoch')
    ON CONFLICT DO NOTHING`;
  const rows = await prisma.$queryRaw<{ generation: bigint }[]>`
    UPDATE supplier_account_leases
    SET holder = ${holder}, lease_until = now() + make_interval(secs => ${ttlMs / 1000}::double precision), heartbeat_at = now(), generation = generation + 1
    WHERE supplier_id = ${b.supplierId}::uuid AND environment = ${b.environment}::supplier_environment AND account_id = ${b.accountId}
      AND (lease_until < now() OR holder = ${holder})
    RETURNING generation`;
  return rows[0] ? { holder, generation: rows[0].generation } : null;
}

/**
 * Extend a lease this worker still holds (CR-B1-7), on the database clock.
 * A lease that lapsed or was taken over is left alone: its generation moved.
 */
async function heartbeatLease(b: Pick<SupplierBooking, "supplierId" | "environment" | "accountId">, lease: Lease, ttlMs: number) {
  await prisma.$executeRaw`
    UPDATE supplier_account_leases SET lease_until = now() + make_interval(secs => ${ttlMs / 1000}::double precision), heartbeat_at = now()
    WHERE supplier_id = ${b.supplierId}::uuid AND environment = ${b.environment}::supplier_environment AND account_id = ${b.accountId}
      AND holder = ${lease.holder} AND generation = ${lease.generation} AND lease_until > now()`;
}

/**
 * Keep the lease alive while `fn` runs (CR-B1-7): a cancel is followed by a
 * re-read that may page through the list, and the lane must stay serial
 * until both are done (SUP-6, SUP-11). The beat stops with the process, so a
 * crashed worker's lease still lapses.
 */
async function withLeaseHeartbeat<T>(b: Pick<SupplierBooking, "supplierId" | "environment" | "accountId">, lease: Lease, ttlMs: number, everyMs: number, fn: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => void heartbeatLease(b, lease, ttlMs).catch(() => undefined), everyMs);
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

async function releaseLease(b: Pick<SupplierBooking, "supplierId" | "environment" | "accountId">, lease: Lease) {
  await prisma.$executeRaw`
    UPDATE supplier_account_leases SET holder = NULL, lease_until = now()
    WHERE supplier_id = ${b.supplierId}::uuid AND environment = ${b.environment}::supplier_environment AND account_id = ${b.accountId}
      AND holder = ${lease.holder} AND generation = ${lease.generation}`;
}

/** True while some holder other than `except` has a live mutation lease on the supplier (and account, when given). */
export async function mutationInFlight(supplierId: string, environment: SupplierEnvironment, opts: { accountId?: string; except?: string } = {}) {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM supplier_account_leases
    WHERE supplier_id = ${supplierId}::uuid AND environment = ${environment}::supplier_environment
      AND (${opts.accountId ?? null}::text IS NULL OR account_id = ${opts.accountId ?? null})
      AND holder IS NOT NULL AND holder <> ${opts.except ?? ""} AND lease_until > now()`;
  return (rows[0]?.n ?? 0) > 0;
}

export function requestBudgetKey(supplierCode: string, environment: SupplierEnvironment, accountId: string) {
  return `supplier_budget.${supplierCode}.${environment}.${accountId}`;
}

/**
 * Take one engine read from the per-account budget (SUP-6): a fixed
 * one-minute window in `settings`, counted on the database clock, shared by
 * every worker, reconciliation and the catalogue sync. False when spent.
 * Quote reads share the window but never its engine reserve
 * (`takeQuoteReadToken`, CR-B2-3).
 */
export async function takeReadToken(supplierCode: string, environment: SupplierEnvironment, accountId: string, limits: ReadLimits = READ_BUDGET) {
  return takeClassReadToken(supplierCode, environment, accountId, "engine", limits);
}

/**
 * Take one customer quote read (availability, ticket stock, pickup hotels)
 * from the same per-account window (CR-B2-3). Quotes may use at most
 * its `quoteCap`, so recovery, polls, the watchdog and reconciliation keep
 * their reserve however many customers ask for quotes. False when the quote
 * share or the whole window is spent. `opts.limits` is for tests; the
 * default is the same `READ_BUDGET` the engine uses (N5).
 */
export async function takeQuoteReadToken(supplierCode: string, environment: SupplierEnvironment, accountId: string, opts: { limits?: ReadLimits } = {}) {
  return takeClassReadToken(supplierCode, environment, accountId, "quote", opts.limits ?? READ_BUDGET);
}

/**
 * Take one browse read (doc 29 §6.3, Batches 2 and 3): the one token for
 * unauthenticated page reads, an offer's start times on a date
 * (start-times route via supplier-quote.service.ts) and its pickup hotel list
 * (pickup-hotels.service.ts). Browse has its own small share
 * of the same per-account window (`browseCap`), carved out of the customer
 * share beside `quoteCap` and never out of the engine reserve, and never takes a read the
 * quote share could still need, so a browse flood cannot delay or refuse a
 * quote, and the engine keeps its reserve (`admitRead`,
 * suppliers/read-budget.ts). False when refused: the page then shows the
 * stored times, or offers the inquiry for the hotel. `opts.route` names the
 * page: start times may use only `startTimesCap` of the browse share, so hotel
 * lists keep the rest; absent counts as start times. `opts.limits` is for tests; the default is `READ_BUDGET` (N5).
 */
export async function takeBrowseReadToken(supplierCode: string, environment: SupplierEnvironment, accountId: string, opts: { limits?: ReadLimits; route?: BrowseRoute } = {}) {
  return takeClassReadToken(supplierCode, environment, accountId, "browse", opts.limits ?? READ_BUDGET, opts.route ?? "start_times");
}

/**
 * `admitRead` (suppliers/read-budget.ts) as one update, so concurrent takers
 * re-check the row they wait on. Rows written before the quote or browse
 * class count no reads of that class.
 */
async function takeClassReadToken(supplierCode: string, environment: SupplierEnvironment, accountId: string, cls: ReadClass, limits: ReadLimits, route?: BrowseRoute) {
  const key = requestBudgetKey(supplierCode, environment, accountId);
  const q = cls === "quote" ? 1 : 0;
  const b = cls === "browse" ? 1 : 0;
  const t = cls === "browse" && route === "start_times" ? 1 : 0;
  const browseCap = limits.browseCap ?? 0;
  const startTimesCap = limits.startTimesCap ?? browseCap;
  await prisma.$executeRaw`
    INSERT INTO settings (key, value, updated_at) VALUES (${key}, jsonb_build_object('windowStart', now(), 'used', 0, 'quoteUsed', 0, 'browseUsed', 0, 'startTimesUsed', 0), now())
    ON CONFLICT (key) DO NOTHING`;
  const n = await prisma.$executeRaw`
    UPDATE settings SET
      value = CASE WHEN (value->>'windowStart')::timestamptz <= now() - interval '1 minute'
                   THEN jsonb_build_object('windowStart', now(), 'used', 1, 'quoteUsed', ${q}::int, 'browseUsed', ${b}::int, 'startTimesUsed', ${t}::int)
                   ELSE jsonb_set(jsonb_set(jsonb_set(jsonb_set(value, '{used}', to_jsonb((value->>'used')::int + 1)),
                                  '{quoteUsed}', to_jsonb(COALESCE((value->>'quoteUsed')::int, 0) + ${q}::int)),
                                  '{browseUsed}', to_jsonb(COALESCE((value->>'browseUsed')::int, 0) + ${b}::int)),
                                  '{startTimesUsed}', to_jsonb(COALESCE((value->>'startTimesUsed')::int, 0) + ${t}::int)) END,
      updated_at = now()
    WHERE key = ${key} AND CASE WHEN (value->>'windowStart')::timestamptz <= now() - interval '1 minute'
                                THEN 0 < ${limits.perMinute}::int AND (${q}::int = 0 OR 0 < ${limits.quoteCap}::int)
                                     AND (${b}::int = 0 OR (0 < ${browseCap}::int AND 1 + ${limits.quoteCap}::int <= ${limits.perMinute}::int))
                                     AND (${t}::int = 0 OR 0 < ${startTimesCap}::int)
                                ELSE (value->>'used')::int < ${limits.perMinute}::int
                                     AND (${q}::int = 0 OR COALESCE((value->>'quoteUsed')::int, 0) < ${limits.quoteCap}::int)
                                     AND (${b}::int = 0 OR (COALESCE((value->>'browseUsed')::int, 0) < ${browseCap}::int
                                          AND (value->>'used')::int + 1 + GREATEST(0, ${limits.quoteCap}::int - COALESCE((value->>'quoteUsed')::int, 0)) <= ${limits.perMinute}::int))
                                     AND (${t}::int = 0 OR COALESCE((value->>'startTimesUsed')::int, 0) < ${startTimesCap}::int) END`;
  return n === 1;
}

/**
 * The supplier's own clock against ours, from the `Date` header of the last
 * call (SUP-21). Recorded on mutation responses; no deadline relies on it yet.
 */
function skewMs(adapter: CallObserver, now: Date): number | null {
  const d = adapter.lastCall?.()?.serverDate;
  const t = d ? Date.parse(d) : Number.NaN;
  return Number.isNaN(t) ? null : t - now.getTime();
}

/** A worker's view of an account mismatch: `default` in test is unpinned and never checked. */
function accountMismatch(b: Pick<SupplierBooking, "accountId" | "environment">, observed: string) {
  if (b.environment === "test" && b.accountId === DEFAULT_BOOKING_ACCOUNT_ID) return false;
  return observed !== b.accountId;
}

/** An adapter that takes a per-job read gate (CR-B1-9); `TravelDeskBookingAdapter` does. Others run ungated. */
interface ReadGateable {
  withReadGate?(gate: ReadGate): this;
}

/**
 * CR-B1-9: the read budget counts supplier requests, not jobs. A read job's
 * first request is covered by the token its caller already took (`prepaid`);
 * each further request waits for no other holder's mutation on the account
 * and takes its own token, and a refusal ends a listing incomplete, which is
 * never taken as "not found". Inside a mutation job (`count`) the reads are
 * counted but never refused: the job holds the lane, and a confirm or cancel
 * must not be held back by the read budget.
 */
function readGateFor(
  scope: { supplierId: string; environment: SupplierEnvironment; accountId: string; laneAccountId?: string },
  deps: Pick<EngineDeps, "supplierCode" | "readLimits" | "holder">,
  mode: "enforce" | "count",
  prepaid: number,
): ReadGate {
  let free = prepaid;
  const code = deps.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
  return {
    async take(operation) {
      if (free > 0) {
        free -= 1;
        return true;
      }
      if (mode === "count") {
        await takeReadToken(code, scope.environment, scope.accountId, deps.readLimits);
        return true;
      }
      if (operation !== "balance" && (await mutationInFlight(scope.supplierId, scope.environment, { accountId: scope.laneAccountId, except: deps.holder }))) return false;
      return takeReadToken(code, scope.environment, scope.accountId, deps.readLimits);
    },
  };
}

function gated<A extends object>(adapter: A, gate: ReadGate): A {
  const g = adapter as A & ReadGateable;
  return typeof g.withReadGate === "function" ? g.withReadGate(gate) : adapter;
}

/* ---------------------------------------------------------------------------
 * Reconciliation types
 * ------------------------------------------------------------------------ */

export function reconcileKey(supplierCode: string, environment: SupplierEnvironment) {
  return `supplier_reconcile.${supplierCode}.${environment}`;
}

/**
 * Start of every client reference the engine derives. Kept apart from the
 * customer-facing OUT-… order reference, which agents may quote on bookings
 * they make in the TravelDesk portal themselves.
 */
export const ENGINE_REFERENCE_PREFIX = "OUTTD-";

export type ReconcileIssueKind =
  | "missing_at_supplier" // we hold a supplier id the supplier does not list
  | "status_mismatch" // our state and the supplier's status disagree
  | "amount_mismatch" // charged amount differs from what we recorded
  | "found_by_reference" // a booking we closed in a guard-releasing state is live at the supplier (re-blocked)
  | "uncertain_state" // a row we are unsure about, or that waits for a human, is found at the supplier
  | "unknown_to_outly"; // a supplier booking carries our reference prefix but no row of ours

export interface ReconcileIssue {
  kind: ReconcileIssueKind;
  bookingId: string | null;
  supplierBookingId: string | null;
  reference: string | null;
  ours: string | null;
  /** Normalised supplier status. */
  theirs: string | null;
}

export interface ReconcileSummary {
  ranAt: string;
  environment: SupplierEnvironment;
  window: { from: string; to: string };
  supplierListed: number;
  ours: number;
  /** Supplier bookings without our reference prefix, e.g. made by an agent in the portal. */
  otherBookings: number;
  issues: ReconcileIssue[];
  /** Every issue found; `issues` holds at most 100 of them. */
  issuesTotal: number;
  truncated: boolean;
  /** False when the supplier's list could not be read consistently; absences are then not reported. */
  listComplete: boolean;
  /** Rows re-blocked because the supplier showed a booking we had closed (late acceptance). */
  reblocked: number;
  /**
   * Rows closed before the recent-closed window that the supplier lists under
   * our reference and that needed no re-block: matched, but not compared.
   */
  skippedClosed: number;
  /** Set when the run did not read the supplier at all. */
  skipped: "mutation_in_flight" | "read_budget" | null;
  fundsMinor: string | null;
}

/** Which normalised statuses each of our states may show. States not listed expect nothing: any match is reported. */
const EXPECTED_STATUS: Partial<Record<SupplierBookingState, SupplierStatus[]>> = {
  reserved: ["ON_HOLD"],
  awaiting_payment: ["ON_HOLD"],
  confirmed: ["CONFIRMED"],
  awaiting_external: ["PENDING", "CONFIRMED"],
  cancelled: ["CANCELLED"],
  expired: ["EXPIRED", "CANCELLED"],
  cancel_refused: ["CONFIRMED", "ON_HOLD", "PENDING"],
};
/** States whose rows are reported whenever the supplier shows them, so a human or recovery settles them. */
const UNCERTAIN: SupplierBookingState[] = [...RECOVERING, "manual_review", "reserving", "confirming", "cancelling"];

/**
 * Late acceptance (SUP-12, CR-B1-2): a row in any guard-releasing state that
 * the supplier shows live (anything but cancelled or expired). Its order item
 * may already be free for a second attempt, so it is re-blocked.
 */
function lateAcceptance(b: Pick<SupplierBooking, "state">, t: Pick<SupplierSnapshot, "status">) {
  // A booking the external supplier failed (REJECTED, doc 29 Batch 6) is as ended as a cancelled or expired one.
  return (GUARD_RELEASING_STATES as readonly SupplierBookingState[]).includes(b.state) && t.status !== "CANCELLED" && t.status !== "EXPIRED" && t.status !== "REJECTED";
}

/* ---------------------------------------------------------------------------
 * Privileged control changes (SEC-10, PRD-12)
 * ------------------------------------------------------------------------ */

export type ControlChange = { paused: boolean; scope?: ControlScope; reason?: string } | { maxBookingNetMinor: number; minFundsAfterMinor: number };

/** The privileged operations a control change may need. Any other approval is not a control approval (CR-B1-11). */
const CONTROL_OPERATIONS: readonly PrivilegedOperation[] = ["supplier.resume", "supplier.limits.raise"];

/**
 * The control a change was asked against (CR-B1-1): the fields that decide
 * what it loosens, plus the row's `updated_at` as a version (null while no
 * row exists). An approval is bound to it, so a change made in between (an
 * emergency stop, a lower cap) makes the approval stale instead of being
 * undone by it.
 */
export interface ControlBefore {
  paused: boolean;
  scope: ControlScope;
  maxBookingNetMinor: number;
  minFundsAfterMinor: number;
  version: string | null;
}

function controlBeforeOf(c: BookingControl, updatedAt: Date | null): ControlBefore {
  return { paused: c.paused, scope: c.scope, maxBookingNetMinor: c.maxBookingNetMinor, minFundsAfterMinor: c.minFundsAfterMinor, version: updatedAt ? updatedAt.toISOString() : null };
}

function sameBefore(a: ControlBefore, b: ControlBefore) {
  return a.paused === b.paused && a.scope === b.scope && a.maxBookingNetMinor === b.maxBookingNetMinor && a.minFundsAfterMinor === b.minFundsAfterMinor && a.version === b.version;
}

const controlBeforeSchema = z.object({
  paused: z.boolean(),
  scope: z.enum(["new_sales", "all_writes"]),
  maxBookingNetMinor: z.number(),
  minFundsAfterMinor: z.number(),
  version: z.string().nullable(),
});

/** The approval payload of a control change, bound to the control it was asked against. The audit note is not part of it. */
export function controlApprovalPayload(supplierCode: string, environment: SupplierEnvironment, accountId: string, change: ControlChange, before: ControlBefore) {
  return { supplierCode, environment, accountId, change: { ...change }, before: { ...before } };
}

/** What a stored approval says it changes. Null when it is not a well-formed control approval. */
function controlApprovalOf(row: { operation: string; permission: string; payload: unknown }) {
  if (!CONTROL_OPERATIONS.includes(row.operation as PrivilegedOperation)) return null;
  if (row.permission !== OPERATION_PERMISSION[row.operation as PrivilegedOperation]) return null;
  const p = row.payload as { supplierCode?: unknown; environment?: unknown; accountId?: unknown; change?: unknown; before?: unknown } | null;
  if (!p || typeof p.supplierCode !== "string" || (p.environment !== "test" && p.environment !== "production") || typeof p.accountId !== "string" || !p.change || typeof p.change !== "object") return null;
  const before = controlBeforeSchema.safeParse(p.before);
  return {
    operation: row.operation as PrivilegedOperation,
    supplierCode: p.supplierCode,
    environment: p.environment as SupplierEnvironment,
    accountId: p.accountId,
    change: p.change as ControlChange,
    before: before.success ? (before.data as ControlBefore) : null,
  };
}

/** The current control row as an approval's `before`, read without a lock (the request side). */
async function currentControlBefore(code: string, environment: SupplierEnvironment, accountId: string): Promise<{ control: BookingControl; before: ControlBefore }> {
  const row = await prisma.setting.findUnique({ where: { key: bookingControlKey(code, environment, accountId) }, select: { updatedAt: true } });
  const control = await bookingControl(code, environment, accountId);
  return { control, before: controlBeforeOf(control, row?.updatedAt ?? null) };
}

/**
 * Withdraw an approval whose control changed since it was asked (CR-B1-1):
 * expired, its use key burned, and audited, so it can never be applied later.
 */
async function withdrawStaleApproval(db: Db, actor: Actor, approvalId: string, now: Date) {
  await db.privilegedApproval.updateMany({ where: { id: approvalId, status: { in: ["pending", "applied"] } }, data: { status: "expired", appliedAt: null } });
  await db.idempotencyKey.createMany({
    skipDuplicates: true,
    data: [{ key: `privileged_use:${approvalId}`, scope: "privileged_use", requestHash: "withdrawn", completedAt: now, expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS + 86_400_000) }],
  });
  await audit(actor, "privileged.withdrawn", { type: "privileged_approval", id: approvalId }, { after: { reason: "control_changed" } }, db);
}

function staleApprovalError(approvalId: string) {
  return Errors.conflict("The booking controls changed after this approval was asked for, so it was withdrawn. Ask again against the current controls.", { approvalId, reason: "control_changed" });
}

function nextControl(before: BookingControl, change: ControlChange): BookingControl {
  return "paused" in change
    ? bookingControlSchema.parse({ ...before, paused: change.paused, scope: change.paused ? (change.scope ?? "new_sales") : "new_sales", reason: change.paused ? change.reason : undefined })
    : bookingControlSchema.parse({ ...before, maxBookingNetMinor: change.maxBookingNetMinor, minFundsAfterMinor: change.minFundsAfterMinor });
}

/** Null when the change only tightens; otherwise the privileged operation it needs. */
export function loosening(before: BookingControl, next: BookingControl): PrivilegedOperation | null {
  const stopRank = (c: BookingControl) => (!c.paused ? 0 : c.scope === "new_sales" ? 1 : 2);
  if (stopRank(next) < stopRank(before)) return "supplier.resume";
  if (next.maxBookingNetMinor > before.maxBookingNetMinor || next.minFundsAfterMinor < before.minFundsAfterMinor) return "supplier.limits.raise";
  return null;
}

/* ---------------------------------------------------------------------------
 * Outage circuit breaker (doc 22 §32.22 finding 1; owner approval 4 Nov 2026)
 * ------------------------------------------------------------------------ */

/** Supplier-side mutation failures inside `OUTAGE_WINDOW_MS` that pause new sales. */
export const OUTAGE_TRIP_COUNT = 3;
/** Sliding window: the last `OUTAGE_TRIP_COUNT` failures must all be newer than this (database clock). */
export const OUTAGE_WINDOW_MS = 10 * 60_000;
/** The control's `reason` when the breaker paused it. */
export const OUTAGE_PAUSE_REASON = "supplier_outage_auto";

/** Settings key of the breaker's failure record for one supplier account in one environment. */
export function outageCounterKey(supplierCode: string, environment: SupplierEnvironment, accountId: string) {
  return `supplier_outage.${supplierCode}.${environment}.${accountId}`;
}

export type OutageNote = "ignored" | "counted" | "tripped";

/** The stored failure instants (ISO, database clock), oldest first. A row in any other shape counts as none. */
function storedFailures(value: unknown): string[] {
  const fails = (value as { fails?: unknown } | null)?.fails;
  return Array.isArray(fails) ? fails.filter((x): x is string => typeof x === "string" && Number.isFinite(Date.parse(x))) : [];
}

/**
 * The outage circuit breaker. During a supplier outage every reserve becomes
 * `outcome_unknown` and needs staff (doc 22 §32.22). Each mutation answer is
 * noted per supplier account and environment, in a `settings` row that every
 * instance shares (`outageCounterKey`), on the database clock:
 *  - an outage answer (`mutationHealth`: a 5xx, a wrapped web-server 5xx
 *    page, a timeout or connection failure after the send) records its
 *    instant; the last `OUTAGE_TRIP_COUNT` are kept;
 *  - every other answer changes nothing: a success does not reset it (review
 *    P2-2, lead decision), so a partial outage (reserves failing while
 *    release cancels succeed) still trips; neither do 401/403, a 422 such as
 *    `HotelId`, a plain 400, a 2xx whose body was lost, or a request that
 *    never left Outly.
 * Reads are not noted: on 3 Nov 2026 GETs kept working while every POST failed.
 *
 * Sliding window (review P2-1): when `OUTAGE_TRIP_COUNT` failures are kept
 * and the oldest is newer than now minus `OUTAGE_WINDOW_MS`, an operator's
 * control row that is not paused is set to a `new_sales` pause with reason
 * `supplier_outage_auto` (and `updated_by` cleared: no operator set it), with
 * an audit row, an `alert` event on the booking whose answer tripped it, and
 * an error `supplier.outage_paused` structured event. The control row is
 * locked first (the order `setControl` locks in), so concurrent failures on
 * several instances pause once. `new_sales` only stops reserves, creates and
 * intake: confirms of existing holds keep their deadline rules, and cancel,
 * lookup, polling, the watchdog and recovery are never held (SUP-2). Nothing
 * resumes automatically: resume is the privileged `setControl` path, which
 * also clears the failure record.
 *
 * Never loosens: a row already paused (either scope), an invalid row (an
 * emergency stop) and a missing row are left as they are. A missing row
 * already means paused in production; in test it is not written, because an
 * explicit row is what lets a worker run send mutations (SEC-8).
 */
export async function noteMutationHealth(
  scope: { supplierCode: string; supplierId: string; environment: SupplierEnvironment; accountId: string },
  o: MutationOutcome,
  bookingId: string | null,
): Promise<OutageNote> {
  if (mutationHealth(o) !== "outage") return "ignored";
  const key = outageCounterKey(scope.supplierCode, scope.environment, scope.accountId);
  const reason = o.kind === "unknown" ? o.reason : "unknown";
  const controlKey = bookingControlKey(scope.supplierCode, scope.environment, scope.accountId);
  const result = await prisma.$transaction(async (tx) => {
    // The control row first, then the failure record: the lock order setControl uses.
    const [control] = await tx.$queryRaw<{ value: unknown }[]>`SELECT value FROM settings WHERE key = ${controlKey} FOR UPDATE`;
    await tx.$executeRaw`INSERT INTO settings (key, value, updated_at) VALUES (${key}, jsonb_build_object('fails', jsonb_build_array()), now()) ON CONFLICT (key) DO NOTHING`;
    const [row] = await tx.$queryRaw<{ value: unknown; db_now: Date }[]>`SELECT value, now() AS db_now FROM settings WHERE key = ${key} FOR UPDATE`;
    const fails = [...storedFailures(row?.value), row.db_now.toISOString()].slice(-OUTAGE_TRIP_COUNT);
    await tx.setting.update({ where: { key }, data: { value: { fails, lastReason: reason } } });
    const inWindow = fails.length >= OUTAGE_TRIP_COUNT && Date.parse(fails[0]) > row.db_now.getTime() - OUTAGE_WINDOW_MS;
    if (!inWindow || !control) return { tripped: false as const };
    const parsed = bookingControlSchema.safeParse(control.value);
    if (!parsed.success || parsed.data.paused) return { tripped: false as const };
    const next = bookingControlSchema.parse({ ...parsed.data, paused: true, scope: "new_sales", reason: OUTAGE_PAUSE_REASON });
    // No operator made this change: the row must not keep the last one's name (review P3-5).
    await tx.setting.update({ where: { key: controlKey }, data: { value: next, updatedBy: null } });
    await audit(
      SYSTEM_ACTOR,
      "supplier_bookings.pause",
      { type: "supplier", id: scope.supplierId },
      { before: { key: controlKey, ...parsed.data }, after: { key: controlKey, ...next, trigger: { failures: fails.length, since: fails[0], lastReason: reason } }, reason: OUTAGE_PAUSE_REASON },
      tx,
    );
    if (bookingId) await writeEvent(tx, bookingId, "alert", { detail: { reason: OUTAGE_PAUSE_REASON, code: reason, errors: fails.length } });
    return { tripped: true as const, failures: fails.length };
  }, TX_OPTIONS);
  if (!result.tripped) return "counted";
  emitEvent(
    "supplier.outage_paused",
    { supplierCode: scope.supplierCode, environment: scope.environment, account: scope.accountId, failures: result.failures, reason: OUTAGE_PAUSE_REASON, lastReason: reason },
    "error",
  );
  return "tripped";
}

/** Clear the breaker's failure record inside a caller's transaction (a resume, `setControl`). */
async function resetOutageCounter(tx: Tx, supplierCode: string, environment: SupplierEnvironment, accountId: string) {
  await tx.$executeRaw`UPDATE settings SET value = jsonb_build_object('fails', jsonb_build_array()), updated_at = now() WHERE key = ${outageCounterKey(supplierCode, environment, accountId)}`;
}

/* ---------------------------------------------------------------------------
 * Wallet funds (doc 29 §4.5, defect D1)
 * ------------------------------------------------------------------------ */

/** The control's `reason` when the wallet direction guard stopped all writes. */
export const WALLET_DIRECTION_PAUSE_REASON = "wallet_direction_auto";

/** States in which Outly's own reservation holds wallet money not yet confirmed (the explanation allowed for a payable figure below the derived one). */
const OPEN_HOLD_STATES: SupplierBookingState[] = ["reserving", "reserved", "awaiting_payment", "confirming"];

/** Outly's own open holds on the booking's supplier account, other than the booking itself. */
async function openHoldsMinor(b: Pick<SupplierBooking, "id" | "supplierId" | "environment" | "accountId">): Promise<bigint> {
  const rows = await prisma.supplierBooking.findMany({
    where: { supplierId: b.supplierId, environment: b.environment, accountId: b.accountId, state: { in: OPEN_HOLD_STATES }, id: { not: b.id } },
    select: { expectedNetMinor: true, chargedNetMinor: true },
  });
  return rows.reduce((sum, x) => sum + (x.chargedNetMinor !== null && x.chargedNetMinor > x.expectedNetMinor ? x.chargedNetMinor : x.expectedNetMinor), 0n);
}

/**
 * The direction guard's stop (doc 29 §4.5 rule 4): the control row is set to
 * an emergency stop (`all_writes`, reason `wallet_direction_auto`, no
 * operator name), with an audit row, an `alert` event on the booking and an
 * error event; the ops sweep emails it (`supplier_wallet_paused`). Never
 * loosens: a row already at `all_writes`, an invalid row (already an
 * emergency stop) and a missing row (already paused in production) are left
 * as they are. A `new_sales` pause is tightened to `all_writes`. Nothing
 * resumes automatically: resume is the privileged `setControl` path.
 */
export async function pauseForWalletDirection(
  scope: { supplierCode: string; supplierId: string; environment: SupplierEnvironment; accountId: string },
  bookingId: string,
  verdict: DirectionVerdict,
): Promise<boolean> {
  const controlKey = bookingControlKey(scope.supplierCode, scope.environment, scope.accountId);
  const paused = await prisma.$transaction(async (tx) => {
    const [control] = await tx.$queryRaw<{ value: unknown }[]>`SELECT value FROM settings WHERE key = ${controlKey} FOR UPDATE`;
    await writeEvent(tx, bookingId, "alert", { detail: { reason: WALLET_DIRECTION_PAUSE_REASON, verdict } });
    if (!control) return false;
    const parsed = bookingControlSchema.safeParse(control.value);
    if (!parsed.success || (parsed.data.paused && parsed.data.scope === "all_writes")) return false;
    const next = bookingControlSchema.parse({ ...parsed.data, paused: true, scope: "all_writes", reason: WALLET_DIRECTION_PAUSE_REASON });
    await tx.setting.update({ where: { key: controlKey }, data: { value: next, updatedBy: null } });
    await audit(
      SYSTEM_ACTOR,
      "supplier_bookings.pause",
      { type: "supplier", id: scope.supplierId },
      { before: { key: controlKey, ...parsed.data }, after: { key: controlKey, ...next, trigger: { verdict, bookingId } }, reason: WALLET_DIRECTION_PAUSE_REASON },
      tx,
    );
    return true;
  }, TX_OPTIONS);
  emitEvent("supplier.wallet_paused", { supplierCode: scope.supplierCode, environment: scope.environment, account: scope.accountId, reason: WALLET_DIRECTION_PAUSE_REASON, verdict }, "error");
  return paused;
}

/* ===========================================================================
 * Service
 * ======================================================================== */

export const supplierBookingService = {
  /**
   * Compare our bookings with the supplier's list and record the differences
   * (SUP-12). It sends nothing and changes no state, with one exception: a
   * booking we closed in any guard-releasing state (`not_created`,
   * `rejected`, `expired`, `cancelled`) that the supplier shows live is
   * re-blocked at once (`outcome_unknown`, attention, an alert, recovery) — a
   * late acceptance (CR-B1-2). When the order item already has another live
   * attempt, the row only gets attention and a liability alert.
   *
   * The window covers our open rows, rows closed in the last
   * `recentClosedMs` (default 14 days) and rows flagged for attention, plus 7
   * days back and 90 ahead. Older closed rows the supplier lists under our
   * reference are loaded and checked for late acceptance; the rest of them
   * are counted in `skippedClosed`. It never runs while a mutation lease is
   * held on the supplier (SUP-6).
   */
  async reconcile(
    deps: { adapter: SupplierBookingAdapter & WindowLister; environment: SupplierEnvironment; supplierCode?: string; now?: () => Date; accountId?: string | null; readLimits?: ReadLimits; saga?: SagaNotifier },
    opts: { referencePrefix?: string; recentClosedMs?: number } = {},
  ): Promise<ReconcileSummary> {
    const now = (deps.now ?? (() => new Date()))();
    const code = deps.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
    const supplier = await supplierFor(code);
    const prefix = opts.referencePrefix ?? ENGINE_REFERENCE_PREFIX;
    const account = engineAccount(deps) ?? DEFAULT_BOOKING_ACCOUNT_ID;
    const base = { ranAt: now.toISOString(), environment: deps.environment, supplierListed: 0, otherBookings: 0, issues: [], issuesTotal: 0, truncated: false, listComplete: false, reblocked: 0, skippedClosed: 0 };

    const ours = await prisma.supplierBooking.findMany({
      where: {
        supplierId: supplier.id,
        environment: deps.environment,
        // closed_at is stamped from the wall clock, so it is compared with the wall clock.
        OR: [{ closedAt: null }, { closedAt: { gte: new Date(Date.now() - (opts.recentClosedMs ?? RECONCILE_RECENT_CLOSED_MS)) } }, { attentionRequiredAt: { not: null } }],
      },
    });
    let lo = isoDate(new Date(now.getTime() - 7 * 86_400_000));
    let hi = isoDate(new Date(now.getTime() + 90 * 86_400_000));
    for (const b of ours) {
      const d = isoDate(b.serviceDate);
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    const window = { from: lo, to: hi };
    const store = async (s: ReconcileSummary) => {
      await prisma.setting.upsert({
        where: { key: reconcileKey(code, deps.environment) },
        create: { key: reconcileKey(code, deps.environment), value: s as unknown as Prisma.InputJsonValue },
        update: { value: s as unknown as Prisma.InputJsonValue },
      });
      return s;
    };
    if (await mutationInFlight(supplier.id, deps.environment)) return store({ ...base, window, ours: ours.length, skipped: "mutation_in_flight", fundsMinor: null });
    if (!(await takeReadToken(code, deps.environment, account, deps.readLimits))) {
      return store({ ...base, window, ours: ours.length, skipped: "read_budget", fundsMinor: null });
    }

    // Our rows first, the supplier second: a booking made in between then shows up only on their side,
    // and rows that changed while we read are dropped from the report below.
    const readAt = new Date();
    // Every page after the first takes its own token and re-checks the lane (CR-B1-9).
    const adapter = gated(deps.adapter, readGateFor({ supplierId: supplier.id, environment: deps.environment, accountId: account }, deps, "enforce", 1));
    const listing = await adapter.listWindow(window);
    const theirs = listing.snapshots;
    const byId = new Map(theirs.map((t) => [t.ref, t]));
    const byRef = new Map(theirs.filter((t) => t.bookingReference).map((t) => [t.bookingReference!, t]));
    const issues: ReconcileIssue[] = [];
    const lateAccepted: { b: SupplierBooking; t: SupplierSnapshot }[] = [];
    const matched = new Set<string>();
    const issue = (kind: ReconcileIssueKind, b: SupplierBooking | null, t: SupplierSnapshot | null) =>
      issues.push({ kind, bookingId: b?.id ?? null, supplierBookingId: t?.ref ?? b?.supplierBookingId ?? null, reference: t?.bookingReference ?? b?.clientRef ?? null, ours: b?.state ?? null, theirs: t?.status ?? null });

    for (const b of ours) {
      const t = (b.supplierBookingId ? byId.get(b.supplierBookingId) : undefined) ?? byRef.get(b.clientRef);
      if (t) matched.add(t.ref);
      if (!t) {
        // An absence is evidence only when the list was read completely.
        if (listing.complete && b.supplierBookingId && !["not_created", "rejected", "queued"].includes(b.state)) issue("missing_at_supplier", b, null);
        continue;
      }
      if (lateAcceptance(b, t)) {
        issue("found_by_reference", b, t);
        lateAccepted.push({ b, t });
        continue;
      }
      if (b.state === "not_created" || b.state === "rejected") continue;
      if (UNCERTAIN.includes(b.state)) {
        issue("uncertain_state", b, t);
        continue;
      }
      const expected = EXPECTED_STATUS[b.state];
      if (expected && !expected.includes(t.status)) issue("status_mismatch", b, t);
      // Same amount rule and tolerance as confirmation (SUP-1).
      if ((b.state === "confirmed" || HOLDING.includes(b.state)) && b.chargedNetMinor !== null && (t.chargedNetMinor === null || !withinChargeTolerance(t.chargedNetMinor, b.chargedNetMinor))) {
        issue("amount_mismatch", b, t);
      }
    }
    let other = 0;
    let skippedClosed = 0;
    const ourRefs = new Set(ours.map((b) => b.clientRef));
    for (const t of theirs) {
      if (matched.has(t.ref)) continue;
      if (t.bookingReference?.startsWith(prefix)) {
        // Created after our read, or a row closed before the window: load it rather than skip it (CR-B1-2).
        const known = ourRefs.has(t.bookingReference)
          ? null
          : await prisma.supplierBooking.findFirst({ where: { supplierId: supplier.id, environment: deps.environment, clientRef: t.bookingReference } });
        if (!known) {
          issue("unknown_to_outly", null, t);
          continue;
        }
        if (lateAcceptance(known, t)) {
          issue("found_by_reference", known, t);
          lateAccepted.push({ b: known, t });
        } else if (known.closedAt !== null) skippedClosed++;
      } else other++;
    }
    // Drop findings on rows that moved while we were reading.
    const flagged = issues.map((i) => i.bookingId).filter((id): id is string => id !== null);
    const moved = new Set((await prisma.supplierBooking.findMany({ where: { id: { in: flagged }, updatedAt: { gt: readAt } }, select: { id: true } })).map((b) => b.id));
    const settled = issues.filter((i) => !i.bookingId || !moved.has(i.bookingId));

    let reblocked = 0;
    for (const { b, t } of lateAccepted) {
      if (moved.has(b.id)) continue;
      if (await this.reblockLateAcceptance(b, t, now, deps.saga)) reblocked++;
    }
    // Uncertain rows the supplier shows: recovery reads them now instead of waiting for its backoff.
    for (const i of settled) {
      const b = i.kind === "uncertain_state" ? ours.find((x) => x.id === i.bookingId) : undefined;
      if (b && RECOVERING.includes(b.state)) await enqueue(prisma, "recover", b.id, now);
    }

    const funds = await adapter.funds().catch(() => null);
    return store({
      ranAt: now.toISOString(),
      environment: deps.environment,
      window,
      supplierListed: theirs.length,
      ours: ours.length,
      otherBookings: other,
      issues: settled.slice(0, RECONCILE_MAX_ISSUES),
      issuesTotal: settled.length,
      truncated: settled.length > RECONCILE_MAX_ISSUES,
      listComplete: listing.complete,
      reblocked,
      skippedClosed,
      skipped: null,
      fundsMinor: funds ? String(funds.spendableMinor) : null,
    });
  },

  /**
   * Late acceptance (SUP-12, CR-B1-2): a booking we closed in a
   * guard-releasing state is live at the supplier. Re-block it in one
   * transaction (`outcome_unknown`, attention, recovery now) and raise an
   * alert. The attention flag stays until a human clears it (CR-B1-10). The partial unique index
   * refuses that when the order item has a live attempt since; then the row
   * only gets attention and a liability alert, and nothing else changes
   * (SUP-20: never a second ticket, never a released guard).
   */
  async reblockLateAcceptance(b: SupplierBooking, t: SupplierSnapshot, now: Date, saga?: SagaNotifier): Promise<boolean> {
    try {
      const moved = await transitionWithEvent(
        b,
        "outcome_unknown",
        { supplierBookingId: t.ref, attentionRequiredAt: now, errorCode: "late_acceptance", errorMessage: "Found at the supplier after it was closed", nextActionAt: now },
        { detail: { via: "reconcile", reason: "found_by_reference", supplierStatus: t.status }, next: [{ kind: "recover", runAfter: now }], saga },
      );
      if (moved) await writeEvent(prisma, b.id, "alert", { detail: { reason: "late_acceptance", supplierStatus: t.status } });
      return moved !== null;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
      await prisma.supplierBooking.updateMany({ where: { id: b.id, state: b.state }, data: { attentionRequiredAt: b.attentionRequiredAt ?? now, errorCode: "late_acceptance_duplicate" } });
      await writeEvent(prisma, b.id, "alert", { detail: { reason: "late_acceptance_duplicate", supplierStatus: t.status } });
      return false;
    }
  },

  /**
   * Controls of both environments plus booking counts per environment and
   * state, for the admin page. `control` is the one of `opts.environment`
   * (default test). `accounts` names the account per environment, as the
   * write action resolves it (`pinnedControlAccount`, doc 29 D2): the page
   * then shows the row a change would write. An environment whose account is
   * null (production with no pin on this deployment) shows as paused, which
   * is what the engine does with it. `accountId` alone applies to both.
   */
  async overview(actor: Actor, opts: { supplierCode?: string; environment?: SupplierEnvironment; accountId?: string; accounts?: Record<SupplierEnvironment, string | null> } = {}) {
    requirePermission(actor, "suppliers.manage");
    const code = opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
    const supplier = await prisma.supplier.findUnique({ where: { code } });
    const controlOf = async (environment: SupplierEnvironment): Promise<BookingControl> => {
      const account = opts.accounts ? opts.accounts[environment] : (opts.accountId ?? DEFAULT_BOOKING_ACCOUNT_ID);
      if (account === null) return { ...bookingControlSchema.parse({}), paused: true, reason: "No TravelDesk account is pinned for this environment on this deployment (TRAVELDESK_AGENCY_ID)" };
      return bookingControl(code, environment, account);
    };
    const controls: Record<SupplierEnvironment, BookingControl> = {
      test: await controlOf("test"),
      production: await controlOf("production"),
    };
    const control = controls[opts.environment ?? "test"];
    const none = { test: null, production: null } as Record<SupplierEnvironment, ReconcileSummary | null>;
    if (!supplier) return { control, controls, counts: [], attention: 0, lastReconcile: none };
    const counts = await prisma.supplierBooking.groupBy({ by: ["environment", "state"], where: { supplierId: supplier.id }, _count: { _all: true } });
    const attention = await prisma.supplierBooking.count({ where: { supplierId: supplier.id, attentionRequiredAt: { not: null } } });
    const rows = await prisma.setting.findMany({ where: { key: { in: [reconcileKey(code, "test"), reconcileKey(code, "production")] } } });
    const lastReconcile = { ...none };
    for (const r of rows) {
      const v = r.value as unknown as ReconcileSummary;
      if (v?.environment === "test" || v?.environment === "production") lastReconcile[v.environment] = v;
    }
    return { control, controls, counts: counts.map((c) => ({ environment: c.environment, state: c.state, count: c._count._all })), attention, lastReconcile };
  },

  /** Whether a control change only tightens (null) or needs a privileged approval, as of the stored row. */
  async controlChangeNeeds(change: ControlChange, opts: { supplierCode?: string; environment: SupplierEnvironment; accountId?: string }): Promise<PrivilegedOperation | null> {
    return (await this.controlRequest(change, opts)).needs;
  },

  /**
   * What a control change needs, and the control it is asked against, from one
   * read: the `before` goes into the approval payload (CR-B1-1).
   */
  async controlRequest(change: ControlChange, opts: { supplierCode?: string; environment: SupplierEnvironment; accountId?: string }): Promise<{ needs: PrivilegedOperation | null; before: ControlBefore }> {
    const code = opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
    const accountId = opts.accountId ?? DEFAULT_BOOKING_ACCOUNT_ID;
    const { control, before } = await currentControlBefore(code, opts.environment, accountId);
    return { needs: loosening(control, nextControl(control, change)), before };
  },

  /**
   * Pause / resume, or change limits, for one environment and account — never
   * both in one call, so a limits save from a stale page cannot undo a pause.
   *
   * Tightening needs `suppliers.pause`. Loosening needs `approvalId`: an
   * applied approval (approval.service.ts) for exactly this change, requested
   * or approved by this actor, applied within the approval TTL and not used
   * before. The row is locked for the read-modify-write, and the audit row and
   * the approval's use are written in the same transaction.
   *
   * The approval is bound to the control it was asked against (CR-B1-1): when
   * the locked row differs from the approval's `before` (fields or version),
   * the approval is withdrawn and the change refused with a conflict. A stale
   * approval therefore never clears an emergency stop or raises a cap that
   * was set after it was asked for.
   */
  async setControl(actor: Actor, change: ControlChange, note: string, opts: { supplierCode?: string; environment: SupplierEnvironment; accountId?: string; approvalId?: string; now?: Date }) {
    requirePermission(actor, "suppliers.pause");
    if (note.trim().length < 8) throw Errors.validation({ note: "Give a reason of at least 8 characters — it goes in the audit log" });
    const code = opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
    const accountId = opts.accountId ?? DEFAULT_BOOKING_ACCOUNT_ID;
    const now = opts.now ?? new Date();
    const supplier = await supplierFor(code);
    const key = bookingControlKey(code, opts.environment, accountId);
    const seed = await bookingControl(code, opts.environment, accountId);
    const result = await prisma.$transaction(async (tx): Promise<{ stale: true } | { stale: false; next: BookingControl }> => {
      const inserted = await tx.$executeRaw`INSERT INTO settings (key, value, updated_at) VALUES (${key}, ${JSON.stringify(seed)}::jsonb, now()) ON CONFLICT (key) DO NOTHING`;
      const [row] = await tx.$queryRaw<{ value: unknown; updated_at: Date }[]>`SELECT value, updated_at FROM settings WHERE key = ${key} FOR UPDATE`;
      const parsed = bookingControlSchema.safeParse(row?.value);
      const before = parsed.success ? parsed.data : invalidControl("The control setting was invalid");
      // A row this call just seeded had no version when the change was asked for.
      const current = controlBeforeOf(before, inserted === 1 ? null : (row?.updated_at ?? null));
      const next = nextControl(before, change);
      const needs = loosening(before, next);
      let approvalId: string | null = null;
      if (needs) {
        if (!opts.approvalId) throw Errors.forbidden(OPERATION_PERMISSION[needs]);
        const stored = await tx.privilegedApproval.findUnique({ where: { id: opts.approvalId } });
        const asked = stored ? controlApprovalOf(stored) : null;
        // The same change for this control, asked against another state: withdrawn, never applied (CR-B1-1).
        if (
          asked?.before &&
          asked.supplierCode === code &&
          asked.environment === opts.environment &&
          asked.accountId === accountId &&
          JSON.stringify(canonicalPayload(asked.change)) === JSON.stringify(canonicalPayload(change)) &&
          !sameBefore(asked.before, current)
        ) {
          await withdrawStaleApproval(tx, actor, opts.approvalId, now);
          return { stale: true };
        }
        await useApproval(tx, actor, opts.approvalId, needs, controlApprovalPayload(code, opts.environment, accountId, change, current), opts.environment, now);
        approvalId = opts.approvalId;
      }
      await tx.setting.update({ where: { key }, data: { value: next } });
      // A resume starts the outage breaker's count again: one more failure must not pause at once.
      if ("paused" in change && !change.paused) await resetOutageCounter(tx, code, opts.environment, accountId);
      const action = "paused" in change ? (change.paused ? "supplier_bookings.pause" : "supplier_bookings.resume") : "supplier_bookings.limits";
      await audit(actor, action, { type: "supplier", id: supplier.id }, { before: { key, ...before }, after: { key, ...next, approvalId }, reason: note.trim() }, tx);
      return { stale: false, next };
    }, TX_OPTIONS);
    if (result.stale) throw staleApprovalError(opts.approvalId!);
    return result.next;
  },

  /**
   * Checks before a second person approves a control change (CR-B1-11,
   * CR-B1-1): the approval must be a supplier control approval (resume or
   * limits raise, with its own permission), the approver must hold
   * `suppliers.pause` (which applying it needs), and the control must still
   * be the one it was asked against; a stale one is withdrawn here.
   */
  async checkControlApproval(actor: Actor, approvalId: string, opts: { now?: Date } = {}) {
    requirePermission(actor, "suppliers.pause");
    const row = await prisma.privilegedApproval.findUnique({ where: { id: approvalId } });
    if (!row) throw Errors.notFound("Approval request");
    const asked = controlApprovalOf(row);
    if (!asked || !asked.before) throw Errors.conflict("This approval is not a supplier control change", { approvalId });
    requirePermission(actor, OPERATION_PERMISSION[asked.operation]);
    if (!sameBefore(asked.before, (await currentControlBefore(asked.supplierCode, asked.environment, asked.accountId)).before)) {
      await prisma.$transaction((tx) => withdrawStaleApproval(tx, actor, approvalId, opts.now ?? new Date()), TX_OPTIONS);
      throw staleApprovalError(approvalId);
    }
    return asked;
  },

  /** Perform an approved control change from its stored payload (production: after the second approval). */
  async applyApprovedControl(actor: Actor, approvalId: string, note: string) {
    const row = await prisma.privilegedApproval.findUnique({ where: { id: approvalId } });
    if (!row) throw Errors.notFound("Approval request");
    const p = controlApprovalOf(row);
    if (!p) throw Errors.conflict("This approval is not a supplier control change", { approvalId });
    return this.setControl(actor, p.change, note, { supplierCode: p.supplierCode, environment: p.environment, accountId: p.accountId, approvalId });
  },

  /**
   * Record a booking intent and queue its first job, in `tx` when given
   * (SUP-8; the B3 saga writes it with the order's paid state). Idempotent on
   * `idempotencyKey` when the request is the same; the same key with a
   * different request is a conflict (SUP-9). The client reference is derived
   * here, never taken from the caller.
   */
  async createIntent(tx: Tx | null, input: CreateIntentInput, opts: { supplierCode?: string; now?: () => Date; accountId?: string | null } = {}) {
    const now = (opts.now ?? (() => new Date()))();
    const code = opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
    if ("clientRef" in (input as object)) throw Errors.validation({ clientRef: "The client reference is derived by the engine" });
    const customer = isCustomerIntent(input);
    const mode = input.mode ?? "two_step";

    // Who may ask for what (PRD-3, SUP-16, SUP-20, PAY-1).
    if (input.orderId && !input.orderItemId) throw Errors.validation({ orderItemId: "A booking for an order names its order item" });
    if (!customer && input.drill !== true) throw Errors.validation({ orderItemId: "Only a sandbox drill may book without an order item" });
    if (customer) {
      if (input.drill === true) throw Errors.validation({ drill: "A drill has no order item" });
      if (input.fulfilmentOrigin !== "instant_checkout") throw Errors.validation({ fulfilmentOrigin: "Only an instant checkout may create a supplier booking" });
      if (input.quoteId === undefined) throw Errors.validation({ quoteId: "A customer intent carries its quote id (null until quotes exist)" });
      if (input.afterReserve !== undefined && input.afterReserve !== "await_payment") throw Errors.validation({ afterReserve: "A booking for an order item waits for captured payment before it is confirmed" });
      if (mode !== "two_step") throw Errors.validation({ mode: "A booking for an order item reserves first and confirms on captured payment" });
      if (input.bookingKind !== "live_book" && input.bookingKind !== "ticket_only") throw Errors.validation({ bookingKind: "Only live and ticket bookings may be sold" });
      // Doc 29 Batch 5: a ticket sold to a customer is open dated, self arrival. Whether its class is switched on is checked below.
      if (input.bookingKind === "ticket_only" && (input.slot || input.hotelId)) throw Errors.validation({ bookingKind: "A ticket booking for an order item names no slot and no hotel" });
    } else if (input.afterReserve === "await_payment") {
      throw Errors.validation({ afterReserve: "Only a booking for an order item waits for payment" });
    }
    const afterReserve = customer ? CUSTOMER_AFTER_RESERVE : (input.afterReserve ?? "confirm");
    const accountId = opts.accountId === undefined ? bookingAccountId(input.environment, null) : opts.accountId;
    if (!accountId) throw Errors.conflict("No supplier account is pinned for this environment");
    const requestHash = requestHashOf(input, mode, afterReserve);

    const supplier = await supplierFor(code);
    const id = uuidv7();
    const clientRef = clientRefFor(id);
    const body = buildBookingRequest({
      serviceDate: input.serviceDate,
      offerId: input.offerId,
      adults: input.adults,
      children: input.children ?? 0,
      infants: input.infants ?? 0,
      guestName: input.guestName,
      clientRef,
      totalCostMinor: input.expectedNetMinor,
      totalCostUsdMinor: input.expectedNetUsdMinor,
      hotelId: input.hotelId,
      slot: input.bookingKind === "live_book" ? input.slot : null,
      remarks: input.remarks,
    });

    const run = async (db: Tx) => {
      const existing = await db.supplierBooking.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing) return this.replayIntent(db, existing, requestHash, now);
      let externalRoute = !customer && input.externalRoute === true;

      if (customer) {
        const item = await db.orderItem.findUnique({ where: { id: input.orderItemId! }, select: { orderId: true, fulfilmentOrigin: true } });
        if (!item) throw Errors.notFound("Order item");
        if (input.orderId && item.orderId !== input.orderId) throw Errors.validation({ orderItemId: "The order item belongs to another order" });
        // PRD-3: an assisted conversion never creates a supplier attempt, whatever the caller says.
        if (item.fulfilmentOrigin !== "instant_checkout") throw Errors.conflict("This order item was not sold through instant checkout", { orderItemId: input.orderItemId });
        // The same capability lookup readiness and the saga use (doc 29 §3.3): no stored offer, or a class not switched on, refuses.
        const offerRow = await db.supplierCatalogueItem.findUnique({
          where: { supplierId_environment_kind_externalId: { supplierId: supplier.id, environment: input.environment, kind: "offer", externalId: String(input.offerId) } },
          select: { payload: true, removedAt: true },
        });
        const mapping = input.mappingId ? await db.productSupplierMapping.findUnique({ where: { id: input.mappingId }, select: { approvedOfferHash: true } }) : null;
        const capability = await checkOfferCapability(db, {
          adapter: supplier.adapter,
          supplierId: supplier.id,
          environment: input.environment,
          offerExternalId: String(input.offerId),
          payload: offerRow && !offerRow.removedAt ? offerRow.payload : null,
          termsHash: mapping?.approvedOfferHash ?? null,
        });
        if (!capability.verdict.instant) {
          throw Errors.conflict("This offer's booking class is not enabled for instant sale", { classKey: capability.verdict.classKey, reason: capability.verdict.reason });
        }
        // The booking kind must be the kind of that class: a live key for live book, the Batch 5 ticket key for TicketOnly.
        if (!bookingKindSellable(input.bookingKind, capability.verdict)) {
          throw Errors.conflict("The booking kind does not match this offer's booking class", { classKey: capability.verdict.classKey, reason: "booking_kind_mismatch" });
        }
        // Doc 29 Batch 6: the route is the class's, never the caller's.
        externalRoute = parseClassKey(capability.verdict.classKey)?.route === "external";
      }
      const { control } = await readControl(code, input.environment, accountId);
      if (control.paused) throw Errors.conflict("Supplier bookings are paused", { reason: control.reason ?? null, scope: control.scope });
      if (input.expectedNetMinor > BigInt(control.maxBookingNetMinor)) throw Errors.conflict("Booking net cost is above the per-booking cap", { capMinor: control.maxBookingNetMinor });
      const attempt = customer ? (await db.supplierBooking.count({ where: { orderItemId: input.orderItemId! } })) + 1 : 1;
      const orderId = customer ? (input.orderId ?? (await db.orderItem.findUniqueOrThrow({ where: { id: input.orderItemId! } })).orderId) : null;

      // ON CONFLICT DO NOTHING: a raced key, or a live attempt for the order item, never aborts the caller's transaction.
      const inserted = await db.supplierBooking.createMany({
        skipDuplicates: true,
        data: [
          {
            id,
            orderId,
            orderItemId: input.orderItemId ?? null,
            supplierId: supplier.id,
            mappingId: input.mappingId ?? null,
            environment: input.environment,
            attempt,
            idempotencyKey: input.idempotencyKey,
            clientRef,
            bookingKind: input.bookingKind,
            mode,
            afterReserve,
            tourExternalId: String(input.tourId),
            offerExternalId: String(input.offerId),
            serviceDate: new Date(`${input.serviceDate}T00:00:00Z`),
            timeSlotId: input.slot ? String(input.slot.timeSlotId) : null,
            startMinutes: input.slot?.startMinutes ?? null,
            endMinutes: input.slot?.endMinutes ?? null,
            adults: input.adults,
            children: input.children ?? 0,
            infants: input.infants ?? 0,
            hotelId: input.hotelId ? String(input.hotelId) : null,
            guestName: input.guestName.trim(),
            expectedNetMinor: input.expectedNetMinor,
            expectedNetUsdMinor: input.expectedNetUsdMinor,
            // Stored without guest name or contact details.
            requestPayload: { ...body, guestName: "[stored separately]" } as Prisma.InputJsonValue,
            requestHash,
            accountId,
            requestedBy: input.requestedBy ?? null,
            externalRoute: externalRoute ? true : null,
            nextActionAt: now,
          },
        ],
      });
      if (inserted.count === 0) {
        const raced = await db.supplierBooking.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (raced) return this.replayIntent(db, raced, requestHash, now);
        throw Errors.conflict("A live booking for this order item already exists", { orderItemId: input.orderItemId ?? null });
      }
      await writeEvent(db, id, "state_change", { toState: "queued", detail: { mode, afterReserve } });
      await enqueue(db, mode === "one_step" ? "create" : "reserve", id, now);
      return db.supplierBooking.findUniqueOrThrow({ where: { id } });
    };
    return tx ? run(tx) : prisma.$transaction(run, TX_OPTIONS);
  },

  /** The same key again: the stored row when the request matches (and its job, after a crash), else a conflict. */
  async replayIntent(db: Tx, existing: SupplierBooking, requestHash: string, now: Date) {
    if (existing.requestHash !== null && existing.requestHash !== requestHash) {
      throw Errors.conflict("This idempotency key was used for a different booking request", { bookingId: existing.id });
    }
    if (existing.state === "queued") await enqueue(db, nextJobKind(existing)!, existing.id, now);
    return existing;
  },

  /**
   * Staff clear the attention flag of one attempt after a privileged
   * resolution (B5, booking.privileged_resolution). Conditional: only while
   * the flag is still the one the approval was asked against, the attempt
   * belongs to that order, its state is not one where the flag holds a
   * money step (`ATTENTION_HOLDS_STATES`), and it was never late-accepted
   * (R-B5-6: the flag is then the CR-B1-10 hold). R-B5-16: a late-accepted
   * booking may be cleared only with `lateAcceptanceResolved` (the dedicated
   * reason `late_acceptance_resolved`) and only once it is settled
   * (`lateAcceptanceSettled`); that reason on any other booking matches
   * nothing. Never changes state;
   * appends an `operator_action` event with the reason code and approval id.
   * Runs on the caller's transaction, so the approval it burns and this write
   * commit together. The booking row is locked first, so a late-acceptance
   * alert written meanwhile is seen.
   */
  async clearAttention(
    tx: Tx,
    bookingId: string,
    opts: { orderId: string; expectedAttentionAt: Date; actorId: string | null; reasonCode: string; approvalId: string; lateAcceptanceResolved?: boolean },
  ): Promise<"cleared" | "late_accepted" | "not_matched"> {
    await tx.$queryRaw`SELECT 1 FROM supplier_bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
    if (await this.wasLateAccepted(bookingId, tx)) {
      if (!opts.lateAcceptanceResolved || !(await this.lateAcceptanceSettled(bookingId, tx))) return "late_accepted";
    } else if (opts.lateAcceptanceResolved) {
      return "not_matched";
    }
    const r = await tx.supplierBooking.updateMany({
      where: { id: bookingId, orderId: opts.orderId, attentionRequiredAt: opts.expectedAttentionAt, state: { notIn: [...ATTENTION_HOLDS_STATES] } },
      data: { attentionRequiredAt: null },
    });
    if (r.count !== 1) return "not_matched";
    const b = await tx.supplierBooking.findUniqueOrThrow({ where: { id: bookingId }, select: { state: true } });
    await writeEvent(tx, bookingId, "operator_action", {
      fromState: b.state,
      toState: b.state,
      actor: opts.actorId ?? "staff",
      detail: { via: "clear_attention", reason: opts.reasonCode, approvalId: opts.approvalId },
    });
    return "cleared";
  },

  /** Ask for a cancellation (operator / drill). Runs as a job under the lease. */
  async requestCancel(bookingId: string, opts: { now?: () => Date } = {}) {
    const b = await prisma.supplierBooking.findUnique({ where: { id: bookingId } });
    if (!b) throw Errors.notFound("Supplier booking");
    if (!b.supplierBookingId || !CANCELLABLE.includes(b.state)) throw Errors.conflict(`A booking in state ${b.state} cannot be cancelled`, { bookingId });
    if (ticketCancelRefused(b)) throw Errors.conflict("Issued tickets cannot be cancelled with the operator; a refund is a goodwill exception for our team", { bookingId, reason: "tickets_issued" });
    await enqueue(prisma, "cancel", b.id, (opts.now ?? (() => new Date()))());
  },

  /**
   * Work through due jobs until none are left or the time budget is spent.
   * Claims go by priority, then send deadline, then due time (SUP-7). A
   * mutation starts only with a full mutation timeout left in the budget; when
   * it does not fit, read jobs still run (SUP-7).
   */
  /**
   * `budgetMs`: no job is claimed after it. `mutationBudgetMs` (the booking
   * tick, review fix 1): the budget the mutation window is measured against
   * instead, from this run's own start, so time a caller spent before the
   * run does not shrink the window. A mutation still starts only with
   * `mutationTimeoutMs + 30 s` of it left; the caller sets it so that point
   * stays inside the function's `maxDuration`.
   */
  async runDueJobs(deps: EngineDeps, opts: { budgetMs: number; maxJobs?: number; mutationBudgetMs?: number }) {
    const now = deps.now ?? (() => new Date());
    const holder = deps.holder ?? `worker-${uuidv7().slice(-8)}`;
    const mutationMs = deps.mutationTimeoutMs ?? 150_000;
    const code = deps.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
    const account = engineAccount(deps);
    const mutationsAllowed = deps.mutations !== false && account !== null;
    // The scheduled run (B3): the reserves and confirms of order-item attempts only, each gated on the payment behind it,
    // (B5) the cancel of an order-item attempt an open supported customer cancellation request names, and (doc 22
    // §32.22) the payment saga's hold-release cancel of an order-item attempt no confirm was ever sent for.
    const paidOnly = deps.mutations === "paid_only";
    const started = Date.now();
    const done: { job: string; kind: string; outcome: string }[] = [];
    const supplier = await supplierFor(code);
    const confirmedInRun: SupplierBooking[] = [];
    const full: Deps = { ...deps, holder, mutationTimeoutMs: mutationMs, now, confirmedInRun };
    await this.sweepStuck(full);
    const stranded = await this.flagStrandedAccounts(full, account);

    for (let i = 0; i < (opts.maxJobs ?? 50); i++) {
      const elapsed = Date.now() - started;
      const remaining = opts.budgetMs - elapsed;
      if (remaining <= 0) break;
      const mutationRemaining = (opts.mutationBudgetMs ?? opts.budgetMs) - elapsed;
      const t = now();
      // Held kinds are not even claimed, so they cannot crowd out recovery, polling and the watchdog.
      const excluded = new Set(heldKinds(await bookingControl(code, deps.environment, account ?? DEFAULT_BOOKING_ACCOUNT_ID)));
      if (!mutationsAllowed || mutationRemaining < mutationMs + MUTATION_START_MARGIN_MS) for (const k of MUTATION_KINDS) excluded.add(k);
      if (paidOnly) for (const k of MUTATION_KINDS) if (!PAID_ONLY_KINDS.includes(k)) excluded.add(k);
      // `attempts` counts consecutive errors, not runs.
      const claimed = await prisma.$queryRaw<{ id: string; kind: string; supplier_booking_id: string | null; attempts: number }[]>`
        UPDATE supplier_jobs SET status = 'running', locked_by = ${holder}, locked_until = now() + make_interval(secs => ${(mutationMs + 60_000) / 1000}::double precision), updated_at = now()
        WHERE id = (
          SELECT j.id FROM supplier_jobs j JOIN supplier_bookings b ON b.id = j.supplier_booking_id
          WHERE j.status = 'queued' AND j.run_after <= ${t}
            AND b.supplier_id = ${supplier.id}::uuid AND b.environment = ${deps.environment}::supplier_environment
            AND (${account}::text IS NULL OR b.account_id = ${account})
            AND j.kind <> ALL(${excluded.size ? [...excluded] : ["-"]}::text[])
            AND (${paidOnly}::boolean = false OR j.kind NOT IN ('confirm', 'reserve', 'cancel') OR b.order_item_id IS NOT NULL)
            AND (${paidOnly}::boolean = false OR j.kind <> 'cancel' OR EXISTS (
              SELECT 1 FROM cancellation_requests cr
              WHERE cr.supplier_booking_id = b.id AND cr.order_item_id = b.order_item_id
                AND cr.kind = 'supported' AND cr.status IN ('requested', 'cancelling', 'cancel_unverified') AND cr.closed_at IS NULL)
              -- The saga's hold release (doc 22 §32.22): asked for, and no confirm ever sent (releaseCancelDue).
              -- Only while the attempt holds or is still being looked up, never once confirmed (review P3-6).
              OR (b.state::text = ANY(${RELEASE_CANCEL_STATES}::text[])
                AND EXISTS (SELECT 1 FROM supplier_booking_events e WHERE e.supplier_booking_id = b.id AND e.kind = 'release_requested')
                AND (SELECT count(*) FROM supplier_booking_events e WHERE e.supplier_booking_id = b.id AND e.kind = 'request_sent' AND e.operation = ${OPERATION.confirm})
                  <= (SELECT count(*) FROM supplier_booking_events e WHERE e.supplier_booking_id = b.id AND e.kind = 'not_sent' AND e.operation = ${OPERATION.confirm})))
          ORDER BY j.priority DESC, j.deadline_at ASC NULLS LAST, j.run_after, j.created_at
          FOR UPDATE OF j SKIP LOCKED LIMIT 1
        )
        RETURNING id, kind, supplier_booking_id, attempts`;
      const job = claimed[0];
      if (!job) break;
      let outcome = "ok";
      try {
        outcome = await this.runJob(job.kind, job.supplier_booking_id!, full);
        // A handler that re-queued its own job has already set it back to queued; this then matches nothing.
        await prisma.supplierJob.updateMany({ where: { id: job.id, status: "running", lockedBy: holder }, data: { status: "succeeded", attempts: 0, lockedBy: null, lockedUntil: null } });
      } catch (e) {
        outcome = `failed: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`;
        await this.jobFailed(job, e, full);
      }
      done.push({ job: job.id, kind: job.kind, outcome });
    }
    // CO-40: once the job loop is over, so a voucher download never delays a job or eats the mutation window.
    if (confirmedInRun.length) await this.afterConfirmedInRun(full, confirmedInRun.splice(0), opts.budgetMs - (Date.now() - started));
    return { holder, processed: done, stranded };
  },

  /**
   * CR-B1-8: a worker claims only its own account's jobs, so open rows
   * written under another account (the `default` test rows once an agency is
   * pinned, or rows from before an agency change) are never resolved by it.
   * That is the right refusal for mutations, and reads are not let through
   * either, since nothing shows the two accounts are the same agency. But such
   * rows must not go quiet: each open one gets attention and one
   * `account_stranded` alert, once. Its jobs stay queued for a worker of that
   * account (or a human); nothing is sent or re-read. `open` counts them all.
   */
  async flagStrandedAccounts(deps: Deps, account: string | null): Promise<{ open: number; flagged: number }> {
    // A worker without an account claims every account's read jobs (`account IS NULL` above): nothing is stranded.
    if (account === null) return { open: 0, flagged: 0 };
    const supplier = await supplierFor(deps.supplierCode ?? TRAVELDESK_SUPPLIER_CODE);
    const scope = { supplierId: supplier.id, environment: deps.environment, accountId: { not: account }, state: { notIn: TERMINAL } };
    const open = await prisma.supplierBooking.count({ where: scope });
    if (open === 0) return { open, flagged: 0 };
    const unflagged = await prisma.supplierBooking.findMany({
      where: { ...scope, events: { none: { kind: "alert", detail: { path: ["reason"], equals: "account_stranded" } } } },
      select: { id: true },
      take: 100,
    });
    const t = deps.now();
    for (const r of unflagged) {
      await prisma.$transaction(async (tx) => {
        await tx.supplierBooking.updateMany({ where: { id: r.id, attentionRequiredAt: null }, data: { attentionRequiredAt: t } });
        await writeEvent(tx, r.id, "alert", { detail: { reason: "account_stranded" } });
      }, TX_OPTIONS);
    }
    return { open, flagged: unflagged.length };
  },

  /**
   * A job threw. A mutation job is never retried and never parks its
   * booking: a booking still in a sending state is turned into
   * `outcome_unknown` by the sweep, and one that never left its waiting state
   * gets its job back from the sweep (SUP-8). A read job retries with capped
   * exponential backoff; at the alert threshold it raises a dead-letter alert
   * and attention, and keeps going (SUP-5).
   */
  async jobFailed(job: { id: string; kind: string; supplier_booking_id: string | null; attempts: number }, e: unknown, deps: Deps) {
    const msg = (e instanceof Error ? e.message : "error").slice(0, 500);
    const errors = job.attempts + 1;
    if (MUTATION_KINDS.includes(job.kind)) {
      await prisma.supplierJob.updateMany({ where: { id: job.id, lockedBy: deps.holder }, data: { status: "failed", attempts: errors, lastError: msg, lockedBy: null, lockedUntil: null } });
      if (job.supplier_booking_id) await writeEvent(prisma, job.supplier_booking_id, "alert", { detail: { reason: "mutation_job_failed", jobKind: job.kind } });
      return;
    }
    const delay = Math.min(RECOVERY_DELAY_MS * 2 ** Math.min(errors - 1, 10), READ_RETRY_MAX_MS);
    await prisma.supplierJob.updateMany({
      where: { id: job.id, lockedBy: deps.holder },
      data: { status: "queued", attempts: errors, lastError: msg, runAfter: new Date(deps.now().getTime() + delay), lockedBy: null, lockedUntil: null },
    });
    if (errors === READ_JOB_ALERT_ERRORS && job.supplier_booking_id) {
      const t = deps.now();
      await prisma.supplierBooking.updateMany({ where: { id: job.supplier_booking_id, attentionRequiredAt: null }, data: { attentionRequiredAt: t } });
      await writeEvent(prisma, job.supplier_booking_id, "dead_letter", { detail: { jobKind: job.kind, errors } });
    }
  },

  /** Execute one job. Returns a short outcome label. Re-queues itself (by updating the job row) when it must wait. */
  async runJob(kind: string, bookingId: string, deps: Deps): Promise<string> {
    const b = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: bookingId } });
    if (MUTATION_KINDS.includes(kind)) {
      const ttlMs = deps.mutationTimeoutMs + 60_000;
      const lease = await acquireLease(b, deps.holder, ttlMs);
      if (!lease) {
        await enqueue(prisma, kind, b.id, new Date(deps.now().getTime() + 15_000), deps.holder);
        return "lease_busy";
      }
      // Reads inside a mutation job (balance, the cancel re-read) are counted, never refused (CR-B1-9).
      const jobDeps: Deps = { ...deps, adapter: gated(deps.adapter, readGateFor(b, deps, "count", 0)) };
      try {
        return await withLeaseHeartbeat(b, lease, ttlMs, deps.leaseHeartbeatMs ?? LEASE_HEARTBEAT_MS, async () => {
          switch (kind) {
            case "reserve":
            case "create":
              return this.doSubmit(b, kind, lease, jobDeps);
            case "confirm":
              return this.doConfirm(b, lease, jobDeps);
            default:
              return this.doCancel(b, lease, jobDeps);
          }
        });
      } finally {
        await releaseLease(b, lease);
      }
    }
    // SUP-6: reads wait while another worker's mutation is in flight on the account (a serial lane at the
    // supplier would time them out), and come out of the shared per-account budget. Neither counts as an error.
    if (await mutationInFlight(b.supplierId, b.environment, { accountId: b.accountId, except: deps.holder })) {
      await enqueue(prisma, kind, b.id, new Date(deps.now().getTime() + 15_000), deps.holder);
      return "lane_busy";
    }
    if (!(await takeReadToken(deps.supplierCode ?? TRAVELDESK_SUPPLIER_CODE, b.environment, b.accountId, deps.readLimits))) {
      await enqueue(prisma, kind, b.id, new Date(deps.now().getTime() + 30_000), deps.holder);
      return "read_budget";
    }
    // The token above pays for the first request; each further page or read takes its own (CR-B1-9).
    const readDeps: Deps = { ...deps, adapter: gated(deps.adapter, readGateFor({ ...b, laneAccountId: b.accountId }, deps, "enforce", 1)) };
    switch (kind) {
      case "recover":
        return this.doRecover(b, readDeps);
      case "poll":
      case "watchdog":
        return this.doPoll(b, readDeps);
      default:
        throw new Error(`unknown job kind ${kind}`);
    }
  },

  /**
   * Move a booking into its sending state and record `request_sent` in the
   * same transaction, after re-checking that this worker still owns the
   * lease (SUP-11): a lease taken over since acquisition has a new generation.
   *
   * `request_sent` records this worker's clock against the database clock
   * (`dbSkewMs`). A confirm runs its last deadline check here, on the
   * database clock (CR-B1-6): `pastConfirmSendBy`, the rule
   * `EngineSagaApi.confirmSendBy` reports to the saga. Rows sent before the
   * skew was recorded keep the worker-clock checks only.
   *
   * A confirm also, under the booking's row lock (`releaseHold` takes the
   * same lock), checks that the saga has not asked for the hold to be
   * released, and re-reads the payment evidence immediately before the move
   * to `confirming` (CR-B3-1). Before that lock it takes the order item's
   * payment saga and payment rows `FOR SHARE`, so no saga move, capture
   * change or refund on them commits between that re-read and the send
   * record. Either the release or the confirm wins, never both, and a saga
   * that left an evidence state first stops the send.
   */
  async startSend(b: SupplierBooking, to: SupplierBookingState, lease: Lease, operation: string, deps: Deps, detail?: Record<string, unknown>) {
    const result = await prisma.$transaction(async (tx): Promise<SupplierBooking | "lease_lost" | "deadline_too_close" | "released" | "no_payment_evidence" | null> => {
      const owned = await tx.$queryRaw<{ n: number; db_now: Date }[]>`
        SELECT 1 AS n, now() AS db_now FROM supplier_account_leases
        WHERE supplier_id = ${b.supplierId}::uuid AND environment = ${b.environment}::supplier_environment AND account_id = ${b.accountId}
          AND holder = ${lease.holder} AND generation = ${lease.generation} AND lease_until > now()
        FOR UPDATE`;
      if (owned.length === 0) return "lease_lost";
      const sentAt = deps.now();
      const dbNow = owned[0].db_now;
      if (operation === OPERATION.confirm) {
        // The saga's rows before the booking's: a saga transaction holding its own rows while it asks for a release then never waits on a send that waits on it.
        if (b.orderItemId) {
          await tx.$queryRaw`SELECT 1 FROM payment_sagas WHERE order_item_id = ${b.orderItemId}::uuid FOR SHARE`;
          await tx.$queryRaw`SELECT 1 FROM payments WHERE id IN (SELECT payment_id FROM payment_sagas WHERE order_item_id = ${b.orderItemId}::uuid) FOR SHARE`;
        }
        await tx.$queryRaw`SELECT 1 FROM supplier_bookings WHERE id = ${b.id}::uuid FOR UPDATE`;
        if (await releaseRequested(tx, b.id)) return "released";
        if (pastConfirmSendBy(b, deps, await reserveSkewMs(tx, b.id), sentAt, dbNow)) return "deadline_too_close";
        // PAY-1, CR-B3-1: the last evidence read, under the locks above.
        if (needsPayment(b) && !(await this.paymentEvidence(b, { payments: deps.paymentsInTx?.(tx) ?? deps.payments }))) return "no_payment_evidence";
      }
      const res = await tx.supplierBooking.updateMany({ where: { id: b.id, state: b.state }, data: { state: to, requestSentAt: sentAt } });
      if (res.count === 0) return null;
      await writeEvent(tx, b.id, "state_change", { fromState: b.state, toState: to });
      await writeEvent(tx, b.id, "request_sent", { operation, detail: { ...detail, dbSkewMs: sentAt.getTime() - dbNow.getTime() } });
      return tx.supplierBooking.findUniqueOrThrow({ where: { id: b.id } });
    }, TX_OPTIONS);
    if (result && typeof result !== "string") await notifySaga(deps.saga, result);
    return result;
  },

  /**
   * The response event of a mutation: allowlisted outcome, HTTP status and
   * supplier clock skew. Then the answer is noted for the outage circuit
   * breaker (`noteMutationHealth`); a fault there is reported and never
   * stops the booking's own transition.
   */
  async responseEvent(b: SupplierBooking, operation: string, o: MutationOutcome, t0: number, deps: Deps) {
    const call = deps.adapter.lastCall?.() ?? null;
    const detail: Record<string, unknown> =
      o.kind === "accepted" ? { supplierStatus: o.snapshot.status, rawStatus: o.snapshot.rawStatus } : o.kind === "rejected" ? { code: o.code } : { error: o.reason, sent: o.sent };
    await writeEvent(prisma, b.id, "response", { operation, httpStatus: call?.httpStatus ?? null, durationMs: Date.now() - t0, detail: { ...detail, skewMs: skewMs(deps.adapter, deps.now()) } });
    try {
      await noteMutationHealth({ supplierCode: deps.supplierCode ?? TRAVELDESK_SUPPLIER_CODE, supplierId: b.supplierId, environment: b.environment, accountId: b.accountId }, o, b.id);
    } catch (e) {
      emitEvent("supplier.outage_breaker_failed", { reason: e instanceof Error ? e.name : "error" }, "error");
    }
  },

  /** Re-queue a mutation job for later and tell a human, when the key answers for another account (SUP-10). The other id is not stored. */
  async refuseForAccount(b: SupplierBooking, kind: string, deps: Deps) {
    const t = deps.now();
    await prisma.supplierBooking.updateMany({ where: { id: b.id, state: b.state }, data: { attentionRequiredAt: b.attentionRequiredAt ?? t, errorCode: "account_mismatch", errorMessage: "The supplier key acts for another account; mutations are refused" } });
    await writeEvent(prisma, b.id, "alert", { detail: { reason: "account_mismatch", jobKind: kind } });
    await enqueue(prisma, kind, b.id, new Date(t.getTime() + 5 * 60_000), deps.holder);
    return "account_mismatch";
  },

  /**
   * SUP-7: refuse a new reservation while queued confirms and cancels would
   * not all fit before the earliest of their send deadlines.
   */
  async admissionThreatened(b: SupplierBooking, deps: Deps) {
    const [row] = await prisma.$queryRaw<{ n: number; earliest: Date | null }[]>`
      SELECT count(*)::int AS n, min(j.deadline_at) AS earliest
      FROM supplier_jobs j JOIN supplier_bookings b ON b.id = j.supplier_booking_id
      WHERE j.status IN ('queued', 'running') AND j.kind IN ('confirm', 'cancel')
        AND b.supplier_id = ${b.supplierId}::uuid AND b.environment = ${b.environment}::supplier_environment AND b.account_id = ${b.accountId}`;
    if (!row?.earliest) return false;
    const p95 = deps.mutationP95Ms ?? DEFAULT_MUTATION_P95_MS;
    return deps.now().getTime() + (row.n + 1) * p95 > row.earliest.getTime();
  },

  async doSubmit(b: SupplierBooking, kind: "reserve" | "create", lease: Lease, deps: Deps) {
    if (b.state !== "queued") return `skip:${b.state}`;
    // CR-B3-5: the scheduled run reserves only for an order item whose payment backs it; until then the job waits for a later run.
    if (deps.mutations === "paid_only" && (kind !== "reserve" || !(await this.reserveBacked(b, deps)))) {
      await enqueue(prisma, kind, b.id, new Date(deps.now().getTime() + 60_000), deps.holder);
      return "reserve_unbacked";
    }
    // PAY-1: a one-step create charges at once. Never for an order (intake refuses it; this catches a row written some other way).
    if (kind === "create" && needsPayment(b)) {
      await transitionWithEvent(b, "not_created", { errorCode: "create_needs_payment", errorMessage: "A booking for an order reserves first and confirms on captured payment" }, { saga: deps.saga });
      return "not_created:create_needs_payment";
    }
    const adapter = deps.adapter;
    if (kind === "reserve" ? !adapter.hold : !adapter.book) {
      await transitionWithEvent(b, "not_created", { errorCode: "not_supported", errorMessage: `The supplier adapter cannot ${kind}` }, { saga: deps.saga });
      return "not_created:not_supported";
    }
    // Cap and funds floor, checked right before money moves. A local refusal was never sent: not_created (CR-10).
    const control = await bookingControl(deps.supplierCode ?? TRAVELDESK_SUPPLIER_CODE, b.environment, b.accountId);
    if (b.expectedNetMinor > BigInt(control.maxBookingNetMinor)) {
      await transitionWithEvent(b, "not_created", { errorCode: "booking_cap", errorMessage: `Expected net ${b.expectedNetMinor} above cap ${control.maxBookingNetMinor}` }, { saga: deps.saga });
      return "not_created:booking_cap";
    }
    if (kind === "reserve" && (await this.admissionThreatened(b, deps))) {
      await enqueue(prisma, kind, b.id, new Date(deps.now().getTime() + 30_000), deps.holder);
      return "admission_deferred";
    }
    const funds = await adapter.funds().catch(() => null);
    if (!funds) {
      await enqueue(prisma, kind, b.id, new Date(deps.now().getTime() + 60_000), deps.holder);
      return "balance_unavailable";
    }
    if (accountMismatch(b, funds.accountId)) return this.refuseForAccount(b, kind, deps);
    // Doc 29 §4.5 (D1): fail closed on figures that do not add up, and check a further item of an order against its running total.
    const checked = await this.fundsCheck(b, funds as FundsWithWallet);
    if (!checked.ok) return this.refuseForFunds(b, kind, checked.reason, deps);
    const after = checked.spendableMinor - b.expectedNetMinor;
    if (after < BigInt(control.minFundsAfterMinor)) {
      await transitionWithEvent(b, "not_created", { errorCode: "balance_floor", errorMessage: `Funds after booking ${after} below floor ${control.minFundsAfterMinor}` }, { saga: deps.saga });
      return "not_created:balance_floor";
    }
    if (await this.heldByKillSwitch(kind, b, deps)) return "paused";
    const operation = OPERATION[kind];
    const sending = await this.startSend(b, "reserving", lease, operation, deps);
    if (sending === "lease_lost") {
      await enqueue(prisma, kind, b.id, new Date(deps.now().getTime() + 15_000), deps.holder);
      return "lease_lost";
    }
    // Only a confirm is gated on the deadline, the release or the evidence.
    if (!sending || typeof sending === "string") return "lost_race";
    const attempt: AttemptRequest = {
      clientRef: b.clientRef,
      expected: expectedFrom(b),
      body: { ...(b.requestPayload as Record<string, unknown>), guestName: b.guestName },
      ...(b.externalRoute === true ? { externalRoute: true } : {}),
    };
    const t0 = Date.now();
    const o = kind === "reserve" ? await adapter.hold!(attempt) : await adapter.book!(attempt);
    // From here on a database fault leaves the booking in `reserving`; the sweep turns it into outcome_unknown (SUP-8).
    await this.responseEvent(b, operation, o, t0, deps);
    if (o.kind === "unknown" && !o.sent) {
      // The request never left this process (SUP-3).
      await transitionWithEvent(sending, "not_created", { errorCode: o.reason, errorMessage: "Not sent" }, { saga: deps.saga });
      return `not_created:${o.reason}`;
    }
    if (o.kind === "rejected") {
      await transitionWithEvent(sending, "rejected", { errorCode: o.code, errorMessage: "Refused by the supplier before processing" }, { saga: deps.saga });
      return `rejected:${o.code}`;
    }
    if (o.kind === "unknown") {
      // Invariant 2: no resend. Look it up. An undocumented 4xx lands here too (SUP-3).
      const next = new Date(deps.now().getTime() + RECOVERY_DELAY_MS);
      await transitionWithEvent(
        sending,
        "outcome_unknown",
        { errorCode: o.reason, errorMessage: "Outcome not seen", nextActionAt: next },
        { detail: { error: o.reason, via: operation }, next: [{ kind: "recover", runAfter: next }], holder: deps.holder, saga: deps.saga },
      );
      return "outcome_unknown";
    }
    // Keep the supplier id first, so a failure further down still leaves the booking findable by id.
    await prisma.supplierBooking.updateMany({ where: { id: b.id }, data: { supplierBookingId: o.snapshot.ref } });
    let outcome = "apply_failed";
    try {
      outcome = await this.applySupplierState(sending, o.snapshot, deps, kind === "reserve" ? "reserved_at" : "created", undefined, kind === "create" ? o.tickets : undefined);
      return outcome;
    } finally {
      // After the state is kept: the wallet must have moved the right way (doc 29 §4.5 rule 4), checked only when the
      // kept state is one the supplier debits for (`debitsWallet`). Never throws.
      await this.walletDirectionGuard(b, { spendableMinor: checked.currentMinor, wallet: (funds as FundsWithWallet).wallet }, o.snapshot, deps, outcome);
    }
  },

  /**
   * The funds a reserve is checked against (doc 29 §4.5 rules 1–3). With the
   * raw wallet figures (TravelDesk): the lower of `payableBalance` and
   * `creditFacility − balance`, refused when a figure is missing, the payable
   * figure is negative, or the two differ by more than a cent beyond Outly's
   * own open holds on the account. An adapter that reports one figure only is
   * taken at its word. For an order, a further item is checked against the
   * lower of that figure and the order's running total: the anchor read
   * (`runningAnchor`: the earliest pre-send read of another attempt of the
   * order that is still live) minus the expected cost of each live attempt
   * whose reserve was sent since. Reads of released attempts, of attempts
   * that never sent and of this booking itself never anchor, so an old low
   * read cannot block a retry after a top-up. Every check that passes is
   * recorded as a `funds_check` event with the current read.
   */
  async fundsCheck(b: SupplierBooking, funds: FundsWithWallet): Promise<{ ok: true; spendableMinor: bigint; currentMinor: bigint } | { ok: false; reason: FundsRefusal | "funds_record_invalid" }> {
    let current = funds.spendableMinor;
    if (funds.wallet) {
      const v = walletSpendable(funds.wallet, await openHoldsMinor(b));
      if (!v.ok) return v;
      current = v.spendableMinor;
    }
    let running: bigint | null = null;
    let spendable = current;
    if (b.orderId) {
      const scope = { orderId: b.orderId, supplierId: b.supplierId, environment: b.environment, accountId: b.accountId };
      const live = { ...scope, id: { not: b.id }, state: { notIn: [...GUARD_RELEASING_STATES, "queued"] as SupplierBookingState[] } };
      const reads = await prisma.supplierBookingEvent.findMany({ where: { kind: "funds_check", booking: live }, select: { id: true, supplierBookingId: true, at: true, detail: true } });
      const first = runningAnchor(reads.map((r) => ({ ...r, bookingId: r.supplierBookingId })));
      if (first) {
        const firstRead = (first.detail as { fundsMinor?: unknown } | null)?.fundsMinor;
        if (typeof firstRead !== "number" || !Number.isSafeInteger(firstRead)) return { ok: false, reason: "funds_record_invalid" };
        const since = await prisma.supplierBooking.findMany({
          where: {
            ...live,
            events: { some: { kind: "request_sent", operation: { in: [OPERATION.reserve, OPERATION.create] }, at: { gte: first.at } } },
          },
          select: { expectedNetMinor: true, chargedNetMinor: true },
        });
        const reserved = since.reduce((sum, x) => sum + (x.chargedNetMinor !== null && x.chargedNetMinor > x.expectedNetMinor ? x.chargedNetMinor : x.expectedNetMinor), 0n);
        ({ spendableMinor: spendable, runningMinor: running } = orderSpendable(current, BigInt(firstRead), reserved));
      }
    }
    await writeEvent(prisma, b.id, "funds_check", { detail: { fundsMinor: Number(current), runningMinor: running === null ? null : Number(running) } });
    return { ok: true, spendableMinor: spendable, currentMinor: current };
  },

  /**
   * Fail closed on wallet figures that do not add up (doc 29 §4.5 rule 2):
   * nothing is sent, the job waits, and a human is told once per booking
   * (attention, `funds_unverified`, an alert event; the ops sweep emails it).
   * After that alert the re-check backs off (`fundsRecheckDelayMs`: the wait
   * grows with the time since the booking was flagged, 1 to 15 minutes, on
   * the engine clock), so a wallet that
   * stays inconsistent does not read the balance every minute for ever.
   */
  async refuseForFunds(b: SupplierBooking, kind: string, reason: FundsRefusal | "funds_record_invalid", deps: Deps) {
    const t = deps.now();
    const told = await prisma.supplierBookingEvent.count({ where: { supplierBookingId: b.id, kind: "alert", detail: { path: ["reason"], equals: "funds_unverified" } } });
    if (told === 0) {
      await prisma.supplierBooking.updateMany({ where: { id: b.id, state: b.state }, data: { attentionRequiredAt: b.attentionRequiredAt ?? t, errorCode: "funds_unverified", errorMessage: "The supplier wallet figures failed the funds check; nothing was sent" } });
      await writeEvent(prisma, b.id, "alert", { detail: { reason: "funds_unverified", code: reason, jobKind: kind } });
      emitEvent("supplier.funds_unverified", { environment: b.environment, account: b.accountId, reason }, "error");
    }
    await enqueue(prisma, kind, b.id, new Date(t.getTime() + fundsRecheckDelayMs(told === 0 ? null : (b.attentionRequiredAt ?? t), t)), deps.holder);
    return `funds_unverified:${reason}`;
  },

  /**
   * Direction guard (doc 29 §4.5 rule 4), production only: right after an
   * accepted reserve or create, read the wallet again. Funds that did not
   * move, or rose by about the booking's cost, are clear evidence that the
   * sign convention or the debit-at-reserve assumption is wrong: all supplier
   * writes are paused (`all_writes`, `pauseForWalletDirection`). A larger
   * drop is other bookings on the same agency (staff also book through the
   * TravelDesk portal, doc 29 §8.4 decision 3) and passes. A smaller drop, a
   * rise of another size or an unreadable wallet may be another movement
   * (a portal cancellation, a top-up): an alert, never a pause. Every verdict
   * is recorded as a `wallet_direction` event. A fault here is reported and
   * never changes the booking.
   *
   * `outcome` is what `applySupplierState` kept. Only a state the supplier
   * debits for (`debitsWallet`: reserved, awaiting payment, confirmed,
   * awaiting the supplier) is checked; any other outcome (cancelled,
   * expired, held for a re-read, manual review, a lost race, a fault) is
   * recorded as `not_applicable` without a read and never pauses.
   */
  async walletDirectionGuard(
    b: SupplierBooking,
    before: { spendableMinor: bigint; wallet?: WalletFigures },
    snapshot: Pick<SupplierSnapshot, "chargedNetMinor">,
    deps: Pick<EngineDeps, "adapter" | "supplierCode">,
    outcome: string,
  ) {
    if (b.environment !== "production" || !before.wallet) return;
    try {
      if (!debitsWallet(outcome)) {
        await writeEvent(prisma, b.id, "wallet_direction", { detail: { verdict: "not_applicable", outcome: outcome.slice(0, 40) } });
        return;
      }
      const cost = snapshot.chargedNetMinor !== null && snapshot.chargedNetMinor > 0n ? snapshot.chargedNetMinor : b.expectedNetMinor;
      const read = (await deps.adapter.funds().catch(() => null)) as (FundsWithWallet & { accountId: string }) | null;
      const afterMinor = read?.wallet && !accountMismatch(b, read.accountId) ? candidateSpendable(read.wallet) : null;
      let verdict: DirectionVerdict | "unverified" = "unverified";
      if (afterMinor !== null) {
        verdict = walletDirection({ beforeMinor: before.spendableMinor, afterMinor, costMinor: cost });
        await writeEvent(prisma, b.id, "wallet_direction", { detail: { verdict, fundsMinor: Number(afterMinor), deltaMinor: Number(afterMinor - before.spendableMinor), expectedMinor: Number(cost) } });
      } else {
        await writeEvent(prisma, b.id, "wallet_direction", { detail: { verdict } });
      }
      if (verdict !== "unverified" && DIRECTION_PAUSES.includes(verdict)) {
        await pauseForWalletDirection({ supplierCode: deps.supplierCode ?? TRAVELDESK_SUPPLIER_CODE, supplierId: b.supplierId, environment: b.environment, accountId: b.accountId }, b.id, verdict);
      } else if (verdict === "partial" || verdict === "rose_unexplained" || verdict === "unverified") {
        await writeEvent(prisma, b.id, "alert", { detail: { reason: "wallet_direction_unclear", verdict } });
        emitEvent("supplier.wallet_direction", { environment: b.environment, account: b.accountId, verdict }, "warn");
      }
    } catch (e) {
      emitEvent("supplier.wallet_guard_failed", { reason: e instanceof Error ? e.name : "error" }, "error");
    }
  },

  /** Re-read the controls immediately before a money-taking call; when this kind is held, put the job back for later. */
  async heldByKillSwitch(kind: string, b: SupplierBooking, deps: Deps) {
    const control = await bookingControl(deps.supplierCode ?? TRAVELDESK_SUPPLIER_CODE, b.environment, b.accountId);
    if (!heldKinds(control).includes(kind)) return false;
    await enqueue(prisma, kind, b.id, new Date(deps.now().getTime() + 60_000), deps.holder);
    return true;
  },

  /** Provider-verified capture for this booking's order item, or null (PAY-1). The engine never infers payment. */
  async paymentEvidence(b: SupplierBooking, deps: Pick<EngineDeps, "payments">): Promise<PaymentEvidence | null> {
    if (!b.orderItemId) return null;
    const ev = await (deps.payments ?? noPaymentEvidence).capturedFor(b.orderItemId);
    return ev && ev.orderItemId === b.orderItemId && ev.capturedMinor > 0n ? ev : null;
  },

  /**
   * Whether an open supported customer cancellation request names this
   * order-item attempt (B5): `kind = 'supported'`, still `requested`,
   * `cancelling` or `cancel_unverified`. An exception request, a closed one
   * or one for another attempt does not count. Read-only.
   */
  async cancelRequested(b: Pick<SupplierBooking, "id" | "orderItemId">): Promise<boolean> {
    if (!b.orderItemId) return false;
    const n = await prisma.cancellationRequest.count({
      where: { supplierBookingId: b.id, orderItemId: b.orderItemId, kind: "supported", status: { in: [...PAID_ONLY_CANCEL_STATUSES] }, closedAt: null },
    });
    return n > 0;
  },

  /**
   * Whether this order-item attempt's cancel is the payment saga's hold
   * release (doc 22 §32.22): `releaseHold` recorded `release_requested`, and
   * no confirm was ever sent for it (`confirmsSent`, the rule `releaseHold`
   * itself applies). Once the release is recorded no confirm can be sent
   * (`startSend` checks it under the booking's row lock). Only while the
   * attempt holds a reservation or is still being looked up
   * (`RELEASE_CANCEL_STATES`, where a cancel either goes or waits), never
   * once it is `confirmed` some other way, e.g. by recovery or a poll (review
   * P3-6): that is a human's decision. Read-only.
   */
  async releaseCancelDue(b: Pick<SupplierBooking, "id" | "orderItemId" | "state">): Promise<boolean> {
    if (!b.orderItemId || !(RELEASE_CANCEL_STATES as readonly string[]).includes(b.state)) return false;
    if (!(await releaseRequested(prisma, b.id))) return false;
    return (await this.confirmsSent(b.id)) <= 0;
  },

  /** Whether the item's payment saga holds a payment that backs a reserve (`reserveBackedBy`, CR-B3-5). Read-only. */
  async reserveBacked(b: SupplierBooking, deps: Pick<Deps, "now">): Promise<boolean> {
    if (!b.orderId || !b.orderItemId) return false;
    const sagas = await prisma.paymentSaga.findMany({ where: { orderId: b.orderId }, select: reserveBackingSelect });
    return reserveBackedBy({ orderId: b.orderId, orderItemId: b.orderItemId }, sagas, deps.now());
  },

  /**
   * Payment hook (the B3 saga calls it after recording capture): queue the
   * confirm of a booking waiting for payment once the port has evidence. The
   * confirm job re-reads the evidence and the deadline right before sending.
   * A reservation a human was told about is never confirmed automatically,
   * nor one whose release was asked for. `deadline_too_close` when the
   * deadline gate would refuse the send already (`pastConfirmSendBy`, SUP-2):
   * the saga then refunds (LATE_PAYMENT_POLICY) and the watchdog records the
   * hold's end. The checks and the queueing run under the booking's row lock
   * (the one `releaseHold` takes), so a release and this never interleave
   * (CR-B3-1). The evidence is read first, outside that lock: it is only a
   * hint here, and the confirm's send re-reads it under the lock.
   */
  async confirmIfPaid(bookingId: string, deps: Pick<EngineDeps, "payments" | "mutationTimeoutMs" | "now">) {
    const first = await prisma.supplierBooking.findUnique({ where: { id: bookingId } });
    if (!first) throw Errors.notFound("Supplier booking");
    if (first.state !== "awaiting_payment") return `skip:${first.state}`;
    const paid = Boolean(await this.paymentEvidence(first, deps));
    const t = (deps.now ?? (() => new Date()))();
    return prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ db_now: Date }[]>`SELECT now() AS db_now FROM supplier_bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
      if (!locked) throw Errors.notFound("Supplier booking");
      const b = await tx.supplierBooking.findUniqueOrThrow({ where: { id: bookingId } });
      if (b.state !== "awaiting_payment") return `skip:${b.state}`;
      if (b.attentionRequiredAt) return "attention_required";
      if (await releaseRequested(tx, b.id)) return "released";
      if (pastConfirmSendBy(b, deps, await reserveSkewMs(tx, b.id), t, locked.db_now)) return "deadline_too_close";
      if (!paid) return "no_payment_evidence";
      const job = confirmJob(b, t, deps);
      await enqueue(tx, job.kind, b.id, job.runAfter, undefined, job.deadlineAt);
      return "confirm_queued";
    }, TX_OPTIONS);
  },

  /**
   * `EngineSagaApi.confirmSendBy`: the last instant a confirm of this attempt
   * may be sent, on the database clock when the reserving worker's skew is
   * known (`confirmSendByOnDbClock`, the rule the send's own gate applies).
   * Null while the reservation deadline is unknown: then no confirm is sent.
   */
  async confirmSendByFor(bookingId: string, deps: Pick<EngineDeps, "mutationTimeoutMs">): Promise<Date | null> {
    const b = await prisma.supplierBooking.findUnique({ where: { id: bookingId }, select: { reservationDeadline: true, externalRoute: true, reservedAt: true } });
    if (!b) throw Errors.notFound("Supplier booking");
    return confirmSendByOnDbClock(b, deps, await reserveSkewMs(prisma, bookingId))?.at ?? null;
  },

  /**
   * Release an unused hold (B3 saga, `EngineSagaApi.releaseHold`). Refused
   * (`not_applicable`) once a confirm was sent, or when the attempt is already
   * closed or past its hold. Otherwise, under the booking's row lock (the one
   * a confirm's `startSend` takes), it records `release_requested`, so no
   * confirm is sent from then on, and drops any queued confirm:
   *  - still `queued` (nothing sent): closed as `not_created` at once;
   *  - held, or a reserve still in flight or unresolved: a cancel is queued.
   *    The order item is released only when a re-read shows the supplier's
   *    cancelled status (SUP-3, SUP-13), or the supplier reports the hold
   *    expired. The cancel runs on the scheduled worker run too
   *    (`releaseCancelDue`, doc 22 §32.22), inside its mutation window and
   *    lease; a `new_sales` pause never holds it (SUP-2).
   * `reason` is kept as a code (SEC-11).
   */
  async releaseHold(bookingId: string, reason: string, deps: Pick<EngineDeps, "now" | "saga"> = {}): Promise<"queued" | "not_applicable"> {
    const t = (deps.now ?? (() => new Date()))();
    const outcome = await prisma.$transaction(async (tx): Promise<{ result: "queued" | "not_applicable"; closed: SupplierBooking | null }> => {
      await tx.$queryRaw`SELECT 1 FROM supplier_bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
      const b = await tx.supplierBooking.findUnique({ where: { id: bookingId } });
      if (!b) throw Errors.notFound("Supplier booking");
      const releasable: SupplierBookingState[] = ["queued", "reserving", ...HOLDING, "outcome_unknown", "not_found_unresolved"];
      if (!releasable.includes(b.state)) return { result: "not_applicable", closed: null };
      const confirms = await tx.supplierBookingEvent.count({ where: { supplierBookingId: b.id, kind: "request_sent", operation: OPERATION.confirm } });
      const notSent = await tx.supplierBookingEvent.count({ where: { supplierBookingId: b.id, kind: "not_sent", operation: OPERATION.confirm } });
      if (confirms - notSent > 0) return { result: "not_applicable", closed: null };
      const first = !(await releaseRequested(tx, b.id));
      if (first) await writeEvent(tx, b.id, "release_requested", { detail: { reason } });
      await tx.supplierJob.updateMany({ where: { supplierBookingId: b.id, kind: "confirm", status: "queued" }, data: { status: "cancelled", lockedBy: null, lockedUntil: null } });
      if (b.state === "queued") {
        const closed = await transitionWithEvent(b, "not_created", { errorCode: "released_before_send", errorMessage: "Released by the payment saga before any request was sent" }, { detail: { via: "release", reason }, tx });
        await tx.supplierJob.updateMany({ where: { supplierBookingId: b.id, kind: { in: ["reserve", "create"] }, status: "queued" }, data: { status: "cancelled" } });
        return { result: "queued", closed };
      }
      await enqueue(tx, "cancel", b.id, t);
      return { result: "queued", closed: null };
    }, TX_OPTIONS);
    if (outcome.closed) await notifySaga(deps.saga, outcome.closed);
    return outcome.result;
  },

  /** Confirms sent for this booking, minus those that never left Outly. Q-B6: a confirm is never sent twice. */
  async confirmsSent(bookingId: string) {
    const [sent, notSent] = await Promise.all([
      prisma.supplierBookingEvent.count({ where: { supplierBookingId: bookingId, kind: "request_sent", operation: OPERATION.confirm } }),
      prisma.supplierBookingEvent.count({ where: { supplierBookingId: bookingId, kind: "not_sent", operation: OPERATION.confirm } }),
    ]);
    return sent - notSent;
  },

  /** Hold a reservation for the watchdog with attention set: no confirm will follow automatically. */
  async holdWithAttention(b: SupplierBooking, deps: Deps, error: { errorCode: string; errorMessage: string }, detail: Record<string, unknown>) {
    const t = deps.now();
    await prisma.supplierBooking.updateMany({ where: { id: b.id, state: b.state }, data: { attentionRequiredAt: b.attentionRequiredAt ?? t, ...error } });
    await writeEvent(prisma, b.id, "attention", { operation: OPERATION.confirm, detail });
    const w = watchdogJob(b, t);
    await enqueue(prisma, w.kind, b.id, w.runAfter, deps.holder);
  },

  async doConfirm(b: SupplierBooking, lease: Lease, deps: Deps) {
    if (!HOLDING.includes(b.state) || !b.supplierBookingId || !deps.adapter.confirm) return `skip:${b.state}`;
    if (b.attentionRequiredAt) return "attention_required";
    // The saga asked for this hold to be released: no confirm follows (B3).
    if (await releaseRequested(prisma, b.id)) return "released";
    if ((await this.confirmsSent(b.id)) > 0) {
      await this.holdWithAttention(b, deps, { errorCode: "confirm_already_sent", errorMessage: "A confirm was sent before; a human decides" }, { reason: "confirm_already_sent" });
      return "confirm_already_sent";
    }
    // Deadline gate (SUP-2): never send a confirm that could land after the hold lapses; the watchdog takes over.
    const tooClose = async () => {
      const t = deps.now();
      const sendBy = confirmSendBy(b, deps);
      if (sendBy && t <= sendBy) return null;
      const left = b.reservationDeadline ? b.reservationDeadline.getTime() - t.getTime() : null;
      await this.holdWithAttention(
        b,
        deps,
        { errorCode: "confirm_deadline_too_close", errorMessage: left === null ? "Reservation deadline unknown" : `${Math.floor(left / 1000)} s left before the reservation deadline` },
        { reason: "confirm_deadline_too_close", msLeft: left },
      );
      return "deadline_too_close";
    };
    const early = await tooClose();
    if (early) return early;
    if (await this.heldByKillSwitch("confirm", b, deps)) return "paused";
    // PAY-1: re-read the capture evidence immediately before the send.
    const evidence = needsPayment(b) ? await this.paymentEvidence(b, deps) : null;
    if (needsPayment(b) && !evidence) return "awaiting_payment";
    const acct = await deps.adapter.account().catch(() => null);
    if (!acct) {
      await enqueue(prisma, "confirm", b.id, new Date(deps.now().getTime() + 15_000), deps.holder, confirmSendBy(b, deps));
      return "account_unavailable";
    }
    if (accountMismatch(b, acct.accountId)) return this.refuseForAccount(b, "confirm", deps);
    // CR-8: the steps above may have taken time (evidence may be a network call in B3); check the deadline again.
    const late = await tooClose();
    if (late) return late;
    // CR-B1-6, CR-B3-1: and once more on the database clock, with the release and the evidence, in the transaction that records the send.
    const sending = await this.startSend(b, "confirming", lease, OPERATION.confirm, deps, evidence ? { paymentId: evidence.paymentId, provider: evidence.provider } : {});
    if (sending === "deadline_too_close") {
      const left = b.reservationDeadline ? b.reservationDeadline.getTime() - deps.now().getTime() : null;
      await this.holdWithAttention(b, deps, { errorCode: "confirm_deadline_too_close", errorMessage: "Too close to the reservation deadline on the database clock" }, { reason: "confirm_deadline_too_close", via: "db_clock", msLeft: left });
      return "deadline_too_close";
    }
    if (sending === "lease_lost") {
      await enqueue(prisma, "confirm", b.id, new Date(deps.now().getTime() + 15_000), deps.holder, confirmSendBy(b, deps));
      return "lease_lost";
    }
    if (sending === "released") return "released";
    // The evidence went away after the read above (the saga released, refunded or flagged): nothing is sent.
    if (sending === "no_payment_evidence") return "awaiting_payment";
    if (!sending) return "lost_race";
    const t0 = Date.now();
    const o = await deps.adapter.confirm(refOf(b));
    await this.responseEvent(b, OPERATION.confirm, o, t0, deps);
    if (o.kind === "accepted") {
      if (o.snapshot.status === "ON_HOLD") {
        // Confirm answered but the booking is still a reservation. Never confirm again automatically (Q-B6):
        // back to the hold with attention; the watchdog records how it ends.
        return this.applySupplierState(sending, o.snapshot, deps, "confirm", { errorCode: "confirm_still_reserved", errorMessage: "Confirm returned a reservation" });
      }
      return this.applySupplierState(sending, o.snapshot, deps, "confirmed", undefined, o.tickets);
    }
    if (o.kind === "unknown" && !o.sent) {
      // Never left Outly: the reservation is as it was. Record that this confirm was not sent, then try again inside the deadline.
      await writeEvent(prisma, b.id, "not_sent", { operation: OPERATION.confirm, detail: { error: o.reason } });
      await transitionWithEvent(sending, b.state, {}, { detail: { via: "confirm", error: o.reason }, next: [confirmJob(b, new Date(deps.now().getTime() + 15_000), deps)], holder: deps.holder, saga: deps.saga });
      return `not_sent:${o.reason}`;
    }
    // Whatever happened, the reservation id is known: re-read it rather than resend.
    const definite = o.kind === "rejected";
    const reason = o.kind === "rejected" ? o.code : o.reason;
    const next = new Date(deps.now().getTime() + (definite ? 0 : RECOVERY_DELAY_MS));
    await transitionWithEvent(sending, "outcome_unknown", { errorCode: reason, errorMessage: "Confirm outcome not seen", nextActionAt: next }, { detail: { error: reason, via: "confirm" }, next: [{ kind: "recover", runAfter: next }], holder: deps.holder, saga: deps.saga });
    return `outcome_unknown:${reason}`;
  },

  /**
   * Cancel (SUP-13). The answer proves nothing by itself: only a re-read with
   * the cancelled status releases the order item. A policy refusal is
   * `cancel_refused`; a 400 "not found" or a validation answer is an incident
   * (`outcome_unknown` with attention), never a refusal.
   */
  async doCancel(b: SupplierBooking, lease: Lease, deps: Deps) {
    // B5, doc 22 §32.22: the scheduled run cancels only what a customer asked for, or a hold the payment saga released
    // before any confirm was sent; the claim checked it, this re-checks it under the lease.
    if (deps.mutations === "paid_only" && !(await this.cancelRequested(b)) && !(await this.releaseCancelDue(b))) {
      await enqueue(prisma, "cancel", b.id, new Date(deps.now().getTime() + 60_000), deps.holder);
      return "cancel_unrequested";
    }
    if (["queued", ...SENDING, ...RECOVERING].includes(b.state)) {
      // Another step is in flight or unresolved; cancel once it settles.
      await enqueue(prisma, "cancel", b.id, new Date(deps.now().getTime() + 15_000), deps.holder);
      return "cancel_pending";
    }
    if (!b.supplierBookingId || !CANCELLABLE.includes(b.state) || !deps.adapter.cancel) return `skip:${b.state}`;
    // Doc 29 §4.4: a confirmed ticket is never cancelled through the API, whoever queued the job.
    if (ticketCancelRefused(b)) return "skip:tickets_issued";
    const acct = await deps.adapter.account().catch(() => null);
    if (!acct) {
      await enqueue(prisma, "cancel", b.id, new Date(deps.now().getTime() + 15_000), deps.holder);
      return "account_unavailable";
    }
    if (accountMismatch(b, acct.accountId)) return this.refuseForAccount(b, "cancel", deps);
    // An unconfirmed hold the payment saga released (no confirm ever sent): if the supplier refuses to cancel it, it can
    // still lapse on its own (review 86 B5-01). Decided before the send, on the state the hold was in.
    const lapses = HOLDING.includes(b.state) && (await this.releaseCancelDue(b));
    // Already refused once and left to lapse: never ask again; the watchdog records the end.
    if (lapses && b.errorCode === RELEASE_LAPSES_CODE) return "hold_lapses";
    const sending = await this.startSend(b, "cancelling", lease, OPERATION.cancel, deps);
    if (sending === "lease_lost") {
      await enqueue(prisma, "cancel", b.id, new Date(deps.now().getTime() + 15_000), deps.holder);
      return "lease_lost";
    }
    if (!sending || typeof sending === "string") return "lost_race";
    const t0 = Date.now();
    const o = await deps.adapter.cancel(refOf(b));
    await this.responseEvent(b, OPERATION.cancel, o, t0, deps);
    const t = deps.now();
    const recover = (delayMs: number): NextJob[] => [{ kind: "recover", runAfter: new Date(t.getTime() + delayMs) }];
    if (o.kind === "accepted") {
      if (o.snapshot.status === "CANCELLED" && isSameBooking(b, o.snapshot)) return this.applySupplierState(sending, o.snapshot, deps, "cancel");
      // A 200 the re-read does not reflect yet: keep the order item and read again.
      await transitionWithEvent(
        sending,
        "cancel_unverified",
        { ...responseData(o.snapshot), errorCode: "cancel_not_reflected", errorMessage: "Cancel answered; the supplier does not show it cancelled yet", nextActionAt: new Date(t.getTime() + RECOVERY_DELAY_MS) },
        { detail: { via: "cancel", supplierStatus: o.snapshot.status }, next: recover(RECOVERY_DELAY_MS), holder: deps.holder, saga: deps.saga },
      );
      return "cancel_unverified";
    }
    if (o.kind === "unknown" && o.reason === ANSWERED_UNVERIFIED_REASON) {
      // SUP-3: a 200 is not proof. The order item stays locked until a re-read shows the cancelled status.
      await transitionWithEvent(
        sending,
        "cancel_unverified",
        { errorCode: "cancel_reread_failed", errorMessage: "Cancel answered; the re-read failed", nextActionAt: new Date(t.getTime() + RECOVERY_DELAY_MS) },
        { detail: { via: "cancel", reason: "reread_failed" }, next: recover(RECOVERY_DELAY_MS), holder: deps.holder, saga: deps.saga },
      );
      return "cancel_unverified";
    }
    if (o.kind === "rejected" && lapses) {
      // Review 86 B5-01: TravelDesk documents that TicketOnly bookings cannot be cancelled, and a reservation (status 7)
      // that is never confirmed times out (status 8) at its deadline, which returns the balance. So a refused release
      // does not wait for a person: the hold goes back to its state (release_requested still blocks any confirm) and
      // the watchdog reads it after the deadline (sent + reservationTimeout at the latest, UTC). Only a read showing
      // it expired or cancelled releases the order item and lets the saga release the card authorisation.
      await transitionWithEvent(
        sending,
        b.state,
        { errorCode: RELEASE_LAPSES_CODE, errorMessage: "The supplier refused to cancel the unconfirmed hold; it is left to lapse at its deadline" },
        { detail: { via: "cancel", code: o.code, fallback: "hold_lapses" }, next: [watchdogJob(b, t)], holder: deps.holder, saga: deps.saga },
      );
      return "cancel_refused_hold_lapses";
    }
    if (o.kind === "rejected" && o.code === "refused_policy") {
      await transitionWithEvent(sending, "cancel_refused", { errorCode: "cancel_refused", errorMessage: "The supplier refused the cancellation" }, { detail: { via: "cancel", code: o.code }, saga: deps.saga });
      return "cancel_refused";
    }
    if (o.kind === "unknown" && !o.sent) {
      // Never sent: back to where it was, and try again.
      await transitionWithEvent(sending, b.state, {}, { detail: { via: "cancel", error: o.reason }, next: [{ kind: "cancel", runAfter: new Date(t.getTime() + 15_000) }], holder: deps.holder, saga: deps.saga });
      return `not_sent:${o.reason}`;
    }
    // An unknown outcome, or a refusal that is not a policy answer (not found, invalid, auth): an incident.
    const code = o.kind === "rejected" ? `cancel_${o.code}` : o.reason;
    await transitionWithEvent(
      sending,
      "outcome_unknown",
      { errorCode: code, errorMessage: "Cancel outcome not settled", nextActionAt: new Date(t.getTime() + RECOVERY_DELAY_MS), ...(o.kind === "rejected" ? { attentionRequiredAt: b.attentionRequiredAt ?? t } : {}) },
      { detail: { via: "cancel", error: code }, next: recover(RECOVERY_DELAY_MS), holder: deps.holder, saga: deps.saga },
    );
    return o.kind === "rejected" ? `incident:${o.code}` : "outcome_unknown";
  },

  /** Find out what happened after an unknown outcome. Never resends anything. */
  async doRecover(b: SupplierBooking, deps: Deps) {
    if (!RECOVERING.includes(b.state)) return `skip:${b.state}`;
    if (b.state === "cancel_unverified") return this.verifyCancel(b, deps);
    const lastOp = await prisma.supplierBookingEvent.findFirst({ where: { supplierBookingId: b.id, kind: "request_sent" }, orderBy: { at: "desc" } });
    let found: SupplierSnapshot | null = null;
    if (b.supplierBookingId) {
      const r = await deps.adapter.readStatus(refOf(b));
      if (r.kind === "failed" && r.reason === READ_BUDGET_REASON) return this.awaitReadBudget(b, "recover", deps);
      // The job retries with capped backoff; a dead-letter alert follows repeated failures, and reading goes on.
      if (r.kind !== "found") throw new Error(`Booking re-read: ${r.kind === "failed" ? r.reason : "not_found"}`);
      found = r.snapshot;
    } else {
      const r = await deps.adapter.findByClientRef(b.clientRef, { serviceDate: isoDate(b.serviceDate), offerExternalId: b.offerExternalId });
      await writeEvent(prisma, b.id, "recovery_search", { operation: "bookings.list", detail: { matches: r.matches.length, complete: r.complete, search: b.recoverySearches + 1 } });
      if (r.matches.length > 1) {
        // Two bookings under one reference: no re-read can settle which one is ours.
        await transitionWithEvent(b, "manual_review", { errorCode: "ambiguous_recovery", errorMessage: `${r.matches.length} bookings carry this reference`, attentionRequiredAt: b.attentionRequiredAt ?? deps.now() }, { saga: deps.saga });
        return "manual_review";
      }
      if (r.matches.length === 1) found = r.matches[0];
      else return this.keepSearching(b, deps, lastOp?.operation ?? null, r.complete);
    }
    await prisma.supplierBooking.updateMany({ where: { id: b.id }, data: { supplierBookingId: found.ref } });
    await writeEvent(prisma, b.id, "response", { operation: "recovery", detail: { supplierStatus: found.status, rawStatus: found.rawStatus } });
    // A confirm whose outcome was unknown and that still shows a reservation: a confirm is never resent (Q-B6).
    if (found.status === "ON_HOLD" && lastOp?.operation === OPERATION.confirm) {
      return this.applySupplierState(b, found, deps, "recovered", { errorCode: "confirm_unknown_still_reserved", errorMessage: "Confirm outcome unknown; still a reservation" });
    }
    // A cancel whose outcome was unknown and that did not take: the booking is live; a human decides whether to cancel again.
    if (lastOp?.operation === OPERATION.cancel && found.status !== "CANCELLED" && found.status !== "EXPIRED") {
      return this.applySupplierState(b, found, deps, "recovered", { errorCode: "cancel_unknown_not_cancelled", errorMessage: "Cancel outcome unknown; the booking is still live" });
    }
    return this.applySupplierState(b, found, deps, "recovered");
  },

  /** The read budget ran out mid-job (CR-B1-9): the job waits like any read-budget refusal, which is not an error. */
  async awaitReadBudget(b: SupplierBooking, kind: string, deps: Deps) {
    await enqueue(prisma, kind, b.id, new Date(deps.now().getTime() + 30_000), deps.holder);
    return "read_budget";
  },

  /** Nothing found by reference yet. Not proof that nothing was made (SUP-3): keep blocking and keep looking. */
  async keepSearching(b: SupplierBooking, deps: Deps, lastOperation: string | null, complete: boolean) {
    const t = deps.now();
    // An incomplete list is no search at all.
    const searches = b.recoverySearches + (complete ? 1 : 0);
    const sinceSent = t.getTime() - (b.requestSentAt?.getTime() ?? 0);
    // A one-step create charges at once and is never past a hold window; a reserve is judged after the hold.
    const isCreate = lastOperation === OPERATION.create;
    const settled = complete && searches >= RECOVERY_MIN_SEARCHES && sinceSent > (isCreate ? deps.mutationTimeoutMs : RESERVE_SETTLED_MS);
    if (settled && b.state === "outcome_unknown") {
      // The order item stays locked, a human is told, and the search goes on with backoff.
      const next = new Date(t.getTime() + rereadBackoffMs(b, t, 120_000));
      const moved = await transitionWithEvent(
        b,
        "not_found_unresolved",
        { recoverySearches: searches, attentionRequiredAt: b.attentionRequiredAt ?? t, errorCode: isCreate ? "create_unknown_not_found" : "not_found_after_recovery", errorMessage: "Request sent; not found by reference yet", nextActionAt: next },
        { detail: { via: "recovery", search: searches }, next: [{ kind: "recover", runAfter: next }], holder: deps.holder, saga: deps.saga },
      );
      return moved ? "not_found_unresolved" : "lost_race";
    }
    const delay = b.state === "not_found_unresolved" ? rereadBackoffMs(b, t, 120_000) : searches < RECOVERY_MIN_SEARCHES ? RECOVERY_DELAY_MS : 120_000;
    await prisma.supplierBooking.updateMany({ where: { id: b.id, state: b.state }, data: { recoverySearches: searches, nextActionAt: new Date(t.getTime() + delay) } });
    await enqueue(prisma, "recover", b.id, new Date(t.getTime() + delay), deps.holder);
    return complete ? "searching" : "searching:list_incomplete";
  },

  /** Re-read a cancel until the supplier shows it cancelled (SUP-3, SUP-13). Never resends the cancel. */
  async verifyCancel(b: SupplierBooking, deps: Deps) {
    const t = deps.now();
    const r = await deps.adapter.readStatus(refOf(b));
    if (r.kind === "found" && (r.snapshot.status === "CANCELLED" || r.snapshot.status === "EXPIRED")) {
      await writeEvent(prisma, b.id, "response", { operation: "recovery", detail: { supplierStatus: r.snapshot.status, rawStatus: r.snapshot.rawStatus } });
      return this.applySupplierState(b, r.snapshot, deps, "cancel_verified");
    }
    const next = new Date(t.getTime() + rereadBackoffMs(b, t, RECOVERY_DELAY_MS));
    if (r.kind === "found") {
      // Still live after the cancel answered: keep the order item, tell a human, keep reading.
      await prisma.supplierBooking.updateMany({
        where: { id: b.id, state: b.state },
        data: { ...responseData(r.snapshot), errorCode: "cancel_not_reflected", errorMessage: "Cancel answered; the supplier still shows the booking live", attentionRequiredAt: b.attentionRequiredAt ?? t, nextActionAt: next },
      });
      if (!b.attentionRequiredAt) await writeEvent(prisma, b.id, "attention", { detail: { via: "cancel_verify", reason: "cancel_not_reflected", supplierStatus: r.snapshot.status } });
    } else {
      await prisma.supplierBooking.updateMany({ where: { id: b.id, state: b.state }, data: { nextActionAt: next } });
    }
    await enqueue(prisma, "recover", b.id, next, deps.holder);
    return "cancel_unverified";
  },

  /** External-confirmation polling (with backoff, SUP-17) and the reservation watchdog. */
  async doPoll(b: SupplierBooking, deps: Deps) {
    if (!b.supplierBookingId) return `skip:${b.state}`;
    if (b.state !== "awaiting_external" && !HOLDING.includes(b.state)) return `skip:${b.state}`;
    const r = await deps.adapter.readStatus(refOf(b));
    if (r.kind === "failed" && r.reason === READ_BUDGET_REASON) return this.awaitReadBudget(b, b.state === "awaiting_external" ? "poll" : "watchdog", deps);
    if (r.kind !== "found") throw new Error(`Booking re-read: ${r.kind === "failed" ? r.reason : "not_found"}`);
    const s = r.snapshot;
    const t = deps.now();
    if (b.state === "awaiting_external") {
      await writeEvent(prisma, b.id, "poll", { operation: "bookings.list", detail: { supplierStatus: s.status, pollCount: b.pollCount + 1 } });
      if (s.status === "PENDING") {
        // Doc 29 Batch 6 (external-confirmation.ts): poll every 15 s (never under 10 s) inside the wait limit; at the
        // limit hand the booking to our team and keep reading, more slowly. Nothing is refunded here: the booking may
        // still confirm, and money goes back only once the supplier shows it failed or gone.
        const polls = b.pollCount + 1;
        const since = b.confirmedAt ?? b.reservedAt ?? b.createdAt;
        const handoffAt = externalHandoffAt({ since, serviceDate: isoDate(b.serviceDate), startMinutes: b.startMinutes });
        const due = t.getTime() >= handoffAt.getTime();
        const handOff = due && !b.attentionRequiredAt;
        await prisma.supplierBooking.updateMany({
          where: { id: b.id, state: b.state },
          data: { ...responseData(s), pollCount: polls, ...(handOff ? { attentionRequiredAt: t, errorCode: EXTERNAL_HANDOFF_CODE, errorMessage: "The external supplier has not confirmed within the wait limit" } : {}) },
        });
        if (handOff) {
          await writeEvent(prisma, b.id, "attention", { detail: { reason: EXTERNAL_HANDOFF_CODE, pollCount: polls } });
          emitEvent("supplier.external_handoff", { supplierBookingId: b.id, pollCount: polls }, "warn");
        }
        const interval = externalPollDelayMs(due ? t.getTime() - handoffAt.getTime() : null);
        await enqueue(prisma, "poll", b.id, new Date(t.getTime() + interval), deps.holder);
        return handOff ? "handed_off" : "still_in_progress";
      }
      return this.applySupplierState(b, s, deps, "poll");
    }
    await writeEvent(prisma, b.id, "poll", { operation: "watchdog", detail: { supplierStatus: s.status } });
    if (s.status === "ON_HOLD") {
      const deadline = this.holdDeadline(b, s, deps);
      if (deadline && (!b.reservationDeadline || deadline < b.reservationDeadline)) await prisma.supplierBooking.updateMany({ where: { id: b.id, state: b.state }, data: { reservationDeadline: deadline } });
      const w = watchdogJob({ reservationDeadline: deadline }, t);
      await enqueue(prisma, w.kind, b.id, w.runAfter, deps.holder);
      return "still_reserved";
    }
    return this.applySupplierState(b, s, deps, "watchdog");
  },

  /**
   * A hold's deadline, never later than what we already know (CR-9): the
   * least of the supplier's expiry, the stored deadline and, for a first
   * sighting, the request time plus the adapter's hold length.
   */
  holdDeadline(b: SupplierBooking, s: SupplierSnapshot, deps: Deps): Date | null {
    const caps = deps.adapter.capabilities().holds;
    const candidates: number[] = [];
    if (s.holdExpiresAtUtc) candidates.push(Date.parse(s.holdExpiresAtUtc));
    if (b.reservationDeadline) candidates.push(b.reservationDeadline.getTime());
    // Doc 29 Batch 6: an external provider's hold length is its own; only the supplier's answer says when it ends.
    if (!b.reservedAt && b.requestSentAt && caps && b.externalRoute !== true) candidates.push(b.requestSentAt.getTime() + caps.minutes * 60_000);
    const valid = candidates.filter((x) => Number.isFinite(x));
    return valid.length ? new Date(Math.min(...valid)) : null;
  },

  /**
   * SUP-1: the answer did not prove a confirmed booking. It is not confirmed
   * and the order item stays locked: the booking waits in outcome_unknown, a
   * human is told, and recovery re-reads it with backoff.
   */
  async holdUnconfirmed(b: SupplierBooking, s: SupplierSnapshot, reasons: ConfirmationFailure[], deps: Deps, via: string) {
    await writeEvent(prisma, b.id, "attention", { detail: { via, reason: "unconfirmed_snapshot", failures: reasons, supplierStatus: s.status } });
    const held = await this.holdForReread(b, s, deps, { errorCode: "unconfirmed_snapshot", errorMessage: reasons.join(", ") }, { via, failures: reasons, supplierStatus: s.status });
    return held ? "unconfirmed" : "lost_race";
  },

  /**
   * PAY-1: the supplier shows a customer booking as booked but there is no
   * captured payment. It is not confirmed: it waits in outcome_unknown, a
   * human is told, and recovery re-reads it. Once evidence exists a re-read
   * may confirm it.
   */
  async holdUnpaid(b: SupplierBooking, s: SupplierSnapshot, deps: Deps, via: string) {
    await writeEvent(prisma, b.id, "supplier_final_without_payment", { detail: { via, supplierStatus: s.status } });
    const held = await this.holdForReread(b, s, deps, { errorCode: "supplier_final_without_payment", errorMessage: "The supplier shows it booked; no captured payment" }, { via, reason: "supplier_final_without_payment", supplierStatus: s.status });
    return held ? "final_without_payment" : "lost_race";
  },

  /**
   * R-B5-16 (lead decision, 3 November 2026): whether a late-accepted booking
   * is settled, so a human may lift its CR-B1-10 hold with
   * `late_acceptance_resolved`. Only two cases are settled:
   *
   *  (a) it is `cancelled`, `expired` or `rejected` and, after the latest
   *      late-acceptance alert, a read from the supplier moved it there (a
   *      `state_change` event to that state whose answer was the matching
   *      supplier status). An end Outly recorded on its own (a local expiry,
   *      or `not_created` for a request refused at intake) is not evidence:
   *      the late acceptance shows the supplier may hold a real booking. A
   *      `late_acceptance_duplicate` row left `not_created` is never settled;
   *  (b) it is `confirmed` and is the item's only live attempt.
   *
   * Recovering and holding states are never settled.
   */
  async lateAcceptanceSettled(bookingId: string, db: Db = prisma): Promise<boolean> {
    const b = await db.supplierBooking.findUnique({ where: { id: bookingId }, select: { state: true, orderItemId: true } });
    if (!b) return false;
    if (b.state === "confirmed") {
      if (!b.orderItemId) return true;
      const live = await db.supplierBooking.count({ where: { orderItemId: b.orderItemId, id: { not: bookingId }, state: { notIn: [...GUARD_RELEASING_STATES] } } });
      return live === 0;
    }
    const supplierStatus = SUPPLIER_ENDED_STATUS[b.state];
    if (!supplierStatus) return false;
    const alert = await db.supplierBookingEvent.findFirst({
      where: { supplierBookingId: bookingId, kind: "alert", OR: LATE_ACCEPTANCE_REASONS.map((reason) => ({ detail: { path: ["reason"], equals: reason } })) },
      orderBy: { at: "desc" },
      select: { at: true },
    });
    if (!alert) return false;
    const reread = await db.supplierBookingEvent.count({
      where: { supplierBookingId: bookingId, kind: "state_change", at: { gte: alert.at }, toState: b.state, detail: { path: ["supplierStatus"], equals: supplierStatus } },
    });
    return reread > 0;
  },

  /** Whether reconciliation re-blocked this booking after a late acceptance (its alert event). */
  async wasLateAccepted(bookingId: string, db: Db = prisma) {
    const n = await db.supplierBookingEvent.count({
      where: { supplierBookingId: bookingId, kind: "alert", OR: LATE_ACCEPTANCE_REASONS.map((reason) => ({ detail: { path: ["reason"], equals: reason } })) },
    });
    return n > 0;
  },

  /** Keep a booking blocking in outcome_unknown with attention set, and queue a re-read with backoff — in one transaction. */
  async holdForReread(b: SupplierBooking, s: SupplierSnapshot, deps: Deps, error: { errorCode: string; errorMessage: string }, detail: Record<string, unknown>) {
    const t = deps.now();
    const next = new Date(t.getTime() + rereadBackoffMs(b, t, RECOVERY_DELAY_MS));
    const moved = await transitionWithEvent(b, "outcome_unknown", { ...responseData(s), ...error, attentionRequiredAt: b.attentionRequiredAt ?? t, nextActionAt: next }, { detail, next: [{ kind: "recover", runAfter: next }], holder: deps.holder, saga: deps.saga });
    return moved !== null;
  },

  /**
   * Move a booking to the state the supplier reports and queue whatever
   * follows, in one transaction. `attention` keeps the booking where the
   * supplier says but tells a human and holds back any automatic confirm.
   * A clean answer clears an earlier attention flag (recovery settled it),
   * except on a booking re-blocked after a late acceptance: Outly had closed
   * it and may have remedied it already, so it keeps its flag and nothing
   * follows automatically until a human clears it (CR-B1-10).
   */
  async applySupplierState(b: SupplierBooking, s: SupplierSnapshot, deps: Deps, via: string, attention?: { errorCode: string; errorMessage: string }, tickets?: TicketEvidence) {
    let to = stateFor(s.status);
    if (to === null) {
      return (await this.holdForReread(b, s, deps, { errorCode: "supplier_status_unknown", errorMessage: "The supplier reports a status the engine does not act on" }, { via, reason: "supplier_status_unknown", rawStatus: s.rawStatus }))
        ? "unknown_status"
        : "lost_race";
    }
    // SUP-3: only an answer about our booking may release the order item.
    if ((to === "cancelled" || to === "expired" || to === "rejected") && !isSameBooking(b, s)) {
      const t = deps.now();
      await writeEvent(prisma, b.id, "attention", { detail: { via, reason: "supplier_identity_mismatch", supplierStatus: s.status } });
      // The answer's own fields are not stored: they describe some other booking.
      const moved = await transitionWithEvent(b, "manual_review", { errorCode: "supplier_identity_mismatch", errorMessage: "The supplier's answer is not about this booking", attentionRequiredAt: b.attentionRequiredAt ?? t }, { detail: { via, supplierStatus: s.status }, saga: deps.saga });
      return moved ? "manual_review" : "lost_race";
    }
    // PAY-1: a customer booking is never confirmed without captured payment, whatever the supplier reports.
    if ((to === "confirmed" || to === "awaiting_external") && needsPayment(b) && !(await this.paymentEvidence(b, deps))) return this.holdUnpaid(b, s, deps, via);
    if (to === "confirmed") {
      const verdict = isConfirmedSnapshot(expectedFrom(b), s);
      if (!verdict.confirmed) return this.holdUnconfirmed(b, s, verdict.reasons, deps, via);
    }
    if (to === "reserved" && needsPayment(b)) to = "awaiting_payment";
    const t = deps.now();
    const holding = HOLDING.includes(to);
    let problem = attention ?? null;
    // A reservation's amount must match what we asked for (shared tolerance); otherwise it is held for a human.
    if (holding && !problem && (s.chargedNetMinor === null || !withinChargeTolerance(s.chargedNetMinor, b.expectedNetMinor))) {
      problem = { errorCode: "charged_amount_mismatch", errorMessage: `charged ${s.chargedNetMinor ?? "none"} vs expected ${b.expectedNetMinor}` };
    }
    const deadline = holding ? this.holdDeadline(b, s, deps) : null;
    // Doc 29 Batch 6: an external hold too short to confirm safely, or of unknown length, is never confirmed (its send-by
    // is unknown, `confirmSendBy`): no confirm follows, the payment saga releases it at once, and our team is told.
    if (holding && !problem && b.externalRoute === true && !externalHoldUsable(b.reservedAt ?? t, deadline)) {
      problem = { errorCode: EXTERNAL_HOLD_UNUSABLE_CODE, errorMessage: deadline ? `External hold of ${Math.floor((deadline.getTime() - (b.reservedAt ?? t).getTime()) / 1000)} s is too short to confirm` : "External hold deadline unknown" };
    }
    // Doc 29 Batch 6: the external supplier failed the booking. After a confirm was sent the card may have been
    // captured: the payment saga refunds the item (it sees `rejected`), and our team is told as well.
    let note: { errorCode: string; errorMessage: string } | null = null;
    if (to === "rejected" && !problem) {
      const failed = { errorCode: EXTERNAL_FAILED_CODE, errorMessage: "The external supplier did not confirm the booking" };
      if ((await this.confirmsSent(b.id)) > 0) problem = failed;
      else note = failed;
    }
    // The unusable-hold code outlives the release that follows, so the ops alert still sees it.
    const kept = b.errorCode === EXTERNAL_HOLD_UNUSABLE_CODE ? { errorCode: b.errorCode, errorMessage: b.errorMessage ?? "" } : null;
    const lateHeld = !problem && b.attentionRequiredAt !== null && (await this.wasLateAccepted(b.id));
    const code = problem ?? note ?? kept;
    const extra: Prisma.SupplierBookingUpdateManyMutationInput = lateHeld ? { ...responseData(s) } : { ...responseData(s), errorCode: code?.errorCode ?? null, errorMessage: code?.errorMessage ?? null };
    if (problem) extra.attentionRequiredAt = b.attentionRequiredAt ?? t;
    else if (!lateHeld && (holding || to === "confirmed" || to === "awaiting_external")) extra.attentionRequiredAt = null;
    if (holding) {
      extra.reservationDeadline = deadline;
      extra.reservedAt = b.reservedAt ?? t;
    }
    if (to === "confirmed" || to === "awaiting_external") extra.confirmedAt = b.confirmedAt ?? t;
    if (to === "cancelled") extra.cancelledAt = t;

    const next: NextJob[] = [];
    if (holding) {
      // SUP-2: every reservation gets a watchdog at its deadline, whatever else follows it.
      next.push(watchdogJob({ reservationDeadline: deadline }, t));
      if (!problem && !lateHeld) {
        if (to === "reserved" && b.afterReserve === "confirm") next.push(confirmJob({ reservationDeadline: deadline }, t, deps));
        else if (to === "reserved" && b.afterReserve === "cancel") next.push({ kind: "cancel", runAfter: t });
        else if (to === "awaiting_payment" && !(await releaseRequested(prisma, b.id)) && (await this.paymentEvidence(b, deps))) next.push(confirmJob({ reservationDeadline: deadline }, t, deps));
      }
    }
    if (to === "awaiting_external") next.push({ kind: "poll", runAfter: new Date(t.getTime() + POLL_INTERVAL_MS) });
    const wallet = { snapshot: s, supplierCode: deps.supplierCode ?? TRAVELDESK_SUPPLIER_CODE, at: t };
    const transition = { detail: { via, supplierStatus: s.status, rawStatus: s.rawStatus, reason: problem?.errorCode }, next, holder: deps.holder, saga: deps.saga, wallet };
    // B4 (TKT-1): codes from the answer that confirms an order-item booking persist in the same transaction.
    const confirming = to === "confirmed" && b.state !== "confirmed" && b.orderItemId !== null;
    const issued = confirming && tickets?.kind === "issued" && tickets.set.count > 0 ? tickets.set : null;
    let persisted: PersistResult | null = null;
    let persistFailed = false;
    let nb: SupplierBooking | null;
    if (issued) {
      try {
        nb = await transitionWithEvent(b, to, extra, { ...transition, afterWrite: async (tx, row) => (persisted = await documentService.persistIssuedTickets(tx, row, issued, t)) });
      } catch (e) {
        // F47: the codes could not be kept. Confirm anyway (the supplier did), then mark the tickets pending below.
        persisted = null;
        persistFailed = true;
        emitEvent("tickets.persist_failed", { supplierBookingId: b.id, reason: e instanceof Error ? e.name : "error" }, "error");
        nb = await transitionWithEvent(b, to, extra, transition);
      }
    } else nb = await transitionWithEvent(b, to, extra, transition);
    if (!nb) return "lost_race";
    if (problem) await writeEvent(prisma, b.id, "attention", { detail: { via, reason: problem.errorCode, supplierStatus: s.status } });
    if (to === "rejected" && (problem ?? note)?.errorCode === EXTERNAL_FAILED_CODE) emitEvent("supplier.external_failed", { supplierBookingId: b.id, afterConfirm: problem !== null }, "warn");
    if (problem?.errorCode === EXTERNAL_HOLD_UNUSABLE_CODE && b.errorCode !== EXTERNAL_HOLD_UNUSABLE_CODE) {
      emitEvent("supplier.external_hold_unusable", { supplierBookingId: b.id, holdMs: deadline ? deadline.getTime() - (b.reservedAt ?? t).getTime() : null }, "warn");
    }
    if (confirming && nb.state === "confirmed") {
      await this.ticketsAfterConfirm(nb, tickets, persisted, persistFailed, t);
      // Only our own confirm answer (review fix 5): a poll or recovery read must not be followed by another call at once.
      if (via === "confirmed") deps.confirmedInRun?.push(nb);
    }
    return nb.state;
  },

  /**
   * CO-40 (checkout redesign batch 4): hand each order-item booking this run
   * confirmed to `deps.afterConfirmed`, once, after the job loop has
   * finished. Skipped (the documents tick picks it up) when no hook is set,
   * when less than `AFTER_CONFIRM_MIN_REMAINING_MS` of the run is left, or
   * while another worker's mutation is in flight on the account (the
   * supplier's serial lane). Never throws.
   */
  async afterConfirmedInRun(deps: Deps, bookings: SupplierBooking[], remainingMs: number) {
    if (!deps.afterConfirmed) return;
    for (const b of bookings) {
      if (!b.orderItemId) continue;
      try {
        if (remainingMs < AFTER_CONFIRM_MIN_REMAINING_MS) {
          emitEvent("document.after_confirm", { supplierBookingId: b.id, outcome: "skipped", reason: "out_of_time" });
          continue;
        }
        if (await mutationInFlight(b.supplierId, b.environment, { accountId: b.accountId, except: deps.holder })) {
          emitEvent("document.after_confirm", { supplierBookingId: b.id, outcome: "skipped", reason: "lane_busy" });
          continue;
        }
        const started = Date.now();
        const out = await deps.afterConfirmed(b);
        remainingMs -= Date.now() - started;
        const claimed = out && typeof out === "object" && "claimed" in out && typeof out.claimed === "number" ? out.claimed : null;
        emitEvent("document.after_confirm", { supplierBookingId: b.id, outcome: "ran", claimed });
      } catch (e) {
        emitEvent("document.after_confirm", { supplierBookingId: b.id, outcome: "failed", reason: e instanceof Error ? e.name : "error" }, "warn");
      }
    }
  },

  /**
   * After a committed confirmation of an order-item booking (B4, F47): report
   * persisted codes, or mark the tickets pending. Issuance evidenced by the
   * answer (codes that failed to persist, or ticket data Outly could not read)
   * allows the automatic document read; no codes at all leaves that to the
   * Q-T1 rule in the document service. Never fails the confirmation: the
   * document job's sweep finds a confirmed booking without a codes row.
   */
  async ticketsAfterConfirm(nb: SupplierBooking, tickets: TicketEvidence | undefined, persisted: PersistResult | null, persistFailed: boolean, t: Date) {
    try {
      if (persisted) return reportPersisted(nb.id, persisted);
      const pending =
        persistFailed && tickets?.kind === "issued"
          ? { reason: "persist_failed" as const, evidence: tickets.set.source }
          : tickets?.kind === "malformed"
            ? { reason: "malformed" as const, evidence: tickets.source }
            : tickets?.kind === "issued"
              ? { reason: "no_codes" as const, evidence: tickets.set.source } // an issued but empty set
              : { reason: "no_codes" as const, evidence: null };
      await documentService.markTicketsPending(prisma, nb, pending, t);
    } catch (e) {
      emitEvent("tickets.persist_failed", { supplierBookingId: nb.id, reason: e instanceof Error ? e.name : "error" }, "error");
    }
  },

  /**
   * Repairs after crashes:
   *  - A booking left in a sending state past the mutation timeout, with no
   *    live mutation lease on its account, becomes outcome_unknown and goes to
   *    recovery (never resent). The lease, on the database clock, is what
   *    shows that a call may still be in flight (SUP-11).
   *  - A waiting booking without a live job gets its next job, attention rows
   *    included (SUP-5).
   *  - Jobs whose lock expired (database clock) go back to the queue.
   */
  async sweepStuck(deps: Deps) {
    const now = deps.now();
    const limit = new Date(now.getTime() - deps.mutationTimeoutMs - 60_000);
    const supplier = await supplierFor(deps.supplierCode ?? TRAVELDESK_SUPPLIER_CODE);
    const scope = { supplierId: supplier.id, environment: deps.environment };
    const stuck = await prisma.supplierBooking.findMany({ where: { ...scope, state: { in: SENDING }, requestSentAt: { lt: limit } }, take: 50 });
    for (const b of stuck) {
      if (await mutationInFlight(b.supplierId, b.environment, { accountId: b.accountId })) continue;
      await transitionWithEvent(b, "outcome_unknown", { errorCode: "worker_lost", errorMessage: "No response recorded; the worker stopped mid-call" }, { detail: { via: "sweep", reason: "worker_lost" }, next: [{ kind: "recover", runAfter: now }], saga: deps.saga });
    }
    // Waiting bookings whose next job was never written (a crash between the state change and the enqueue).
    const waiting = await prisma.supplierBooking.findMany({
      where: { ...scope, state: { in: ["queued", ...HOLDING, "awaiting_external", ...RECOVERING] }, updatedAt: { lt: new Date(now.getTime() - 120_000) } },
      take: 100,
    });
    for (const b of waiting) {
      const live = await prisma.supplierJob.findMany({ where: { supplierBookingId: b.id, status: { in: ["queued", "running"] } }, select: { kind: true } });
      const kind = nextJobKind(b);
      if (HOLDING.includes(b.state)) {
        // A reservation always has its watchdog, even while its confirm is held (SUP-2).
        if (!live.some((j) => j.kind === "watchdog")) {
          const w = watchdogJob(b, now);
          await enqueue(prisma, w.kind, b.id, w.runAfter);
        }
        if (live.length === 0 && kind === "confirm") {
          const c = confirmJob(b, now, deps);
          await enqueue(prisma, c.kind, b.id, c.runAfter, undefined, c.deadlineAt);
        } else if (live.length === 0 && kind === "cancel") await enqueue(prisma, "cancel", b.id, now);
      } else if (live.length === 0 && kind) await enqueue(prisma, kind, b.id, now);
    }
    // Handlers check the booking state first, and a mutation is only sent after the booking left its starting
    // state, so a re-run never resends.
    await prisma.$executeRaw`
      UPDATE supplier_jobs j SET status = 'queued', run_after = ${now}, last_error = 'lock expired', locked_by = NULL, locked_until = NULL, updated_at = now()
      FROM supplier_bookings b
      WHERE b.id = j.supplier_booking_id AND j.status = 'running' AND j.locked_until < now()
        AND b.supplier_id = ${supplier.id}::uuid AND b.environment = ${deps.environment}::supplier_environment`;
  },
};

/**
 * Check and burn an applied approval for a control change, inside the
 * control's transaction. The approval must be for this exact change, applied
 * within the approval TTL, and the actor must be its requester or approver.
 * Also used by the capability flags (supplier-capability.service.ts).
 */
export async function useApproval(tx: Tx, actor: Actor, approvalId: string, operation: PrivilegedOperation, payload: Record<string, unknown>, environment: SupplierEnvironment, now: Date) {
  const row = await tx.privilegedApproval.findUnique({ where: { id: approvalId } });
  const permission = OPERATION_PERMISSION[operation];
  const fail = (why: string) => Errors.conflict(`The approval cannot be used: ${why}`, { approvalId });
  if (!row) throw Errors.notFound("Approval request");
  if (row.operation !== operation || row.permission !== permission || row.environment !== environment) throw fail("it is for another operation");
  if (row.status !== "applied" || !row.appliedAt) throw fail("it is not approved");
  if (row.payloadHash !== privilegedPayloadHash(operation, permission, environment, payload)) throw fail("it is for a different change");
  if (now.getTime() - row.appliedAt.getTime() > APPROVAL_TTL_MS) throw fail("it has expired");
  if (!hasPermission(actor, permission) || (actor.id !== row.requestedBy && actor.id !== row.approvedBy)) throw Errors.forbidden(permission);
  const used = await tx.idempotencyKey.createMany({
    skipDuplicates: true,
    data: [{ key: `privileged_use:${approvalId}`, scope: "privileged_use", requestHash: row.payloadHash, completedAt: now, expiresAt: new Date(row.appliedAt.getTime() + APPROVAL_TTL_MS + 86_400_000) }],
  });
  if (used.count === 0) throw fail("it was used already");
}
