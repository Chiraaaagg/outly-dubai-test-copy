/**
 * B3 contracts: payment gateway port, payment saga states, inbox events,
 * refunds, ledgers and customer remedies (doc 22 §22.1 item 6, §23 B3).
 *
 * Owned by the lead; change only between batches. A vocabulary, not a
 * service: no "server-only", env, db or logger imports. No provider is
 * selected (doc 22 §29 questions 11, 12): B3 builds fake gateways only, and a
 * real adapter needs written qualification, owner onboarding and A6.
 */

import type { Currency } from "@/lib/types";

/* ---------------------------------------------------------------------------
 * Rails and method semantics (PAY-3, PAY-4)
 * ------------------------------------------------------------------------ */

/** Each order is bound to one rail and one currency. */
export type PaymentRail = "inr_pacb" | "aed_card";

export const RAIL_CURRENCY: Record<PaymentRail, Currency> = { inr_pacb: "INR", aed_card: "AED" };

export interface MethodCapabilities {
  /**
   * `hold`: authorization reserves funds, capture moves them (card).
   * `debit_at_authorization`: the customer is debited when authorized (e.g. Razorpay "authorized").
   * `capture_only`: the payment is final when it succeeds (UPI).
   */
  authorization: "hold" | "debit_at_authorization" | "capture_only";
  /** How unused money goes back: release a hold, an automatic refund by the provider, or an explicit refund. */
  release: "void" | "auto_refund" | "refund";
  /** How long an uncaptured authorization lives at the provider; null when not applicable. */
  authorizationLifetimeMs: number | null;
  partialCapture: boolean;
  multipleCapture: boolean;
  /** Whether webhooks carry a signed timestamp (replay window), or only a body signature. */
  webhookSignedTimestamp: boolean;
  /** Whether webhooks are signed at all. Unsigned providers are trigger-only: act on an authenticated read. */
  webhookSigned: boolean;
}

/** The order of operations a method allows (doc 22 §22.1 item 6). */
export function sagaFor(c: MethodCapabilities): "authorize_reserve_capture_confirm" | "capture_reserve_confirm" {
  return c.authorization === "hold" ? "authorize_reserve_capture_confirm" : "capture_reserve_confirm";
}

/* ---------------------------------------------------------------------------
 * Gateway port
 * ------------------------------------------------------------------------ */

export interface GatewayAccount {
  provider: string;
  accountId: string;
  environment: "test" | "production";
  rail: PaymentRail;
}

export type ProviderPaymentStatus =
  | "requires_action"
  | "authorized"
  | "captured"
  | "voided"
  | "refunded"
  | "partially_refunded"
  | "failed"
  | "expired";

export interface GatewayPaymentSnapshot {
  providerPaymentId: string;
  providerOrderId: string | null;
  accountId: string;
  status: ProviderPaymentStatus;
  currency: Currency;
  amountMinor: bigint;
  capturedMinor: bigint;
  refundedMinor: bigint;
  method: string | null;
  threeDs: "passed" | "failed" | "not_applicable" | "unknown";
  risk: "normal" | "elevated" | "highest" | "unknown";
  authorizedAt: string | null;
  authorizationExpiresAt: string | null;
}

export type GatewayOutcome =
  | { kind: "ok"; payment: GatewayPaymentSnapshot }
  | { kind: "failed"; definite: true; code: string }
  /** `sent: false` means the request certainly never reached the provider. */
  | { kind: "unknown"; sent: boolean; reason: string };

export interface CreateSessionInput {
  orderId: string;
  quoteId: string;
  currency: Currency;
  amountMinor: bigint;
  /** Stable per order and attempt; a repeat returns the same session. */
  idempotencyKey: string;
  returnUrl: string;
  method: string;
  /**
   * When Outly stops taking payment: the quote's expiry (CR-B3-7). An adapter
   * sends it as the hosted page or order expiry where the provider allows,
   * and reports the provider's own `PaymentSession.expiresAt`.
   *
   * The reported expiry may be later than this ONLY when the gateway
   * implements `expireSession` (a provider with a minimum session life, e.g.
   * Stripe Checkout's 30 minutes). The saga then expires the session once
   * the quote lapses. Any other gateway never reports a later time. A
   * payment that still arrives after this instant is late (F46): a hold is
   * voided, captured money is refunded.
   */
  expiresAt: string;
}

export interface PaymentSession {
  sessionId: string;
  providerOrderId: string;
  /** Hosted page URL; card data never touches Outly. */
  redirectUrl: string;
  expiresAt: string;
}

/** One refund as the provider holds it. */
export interface GatewayRefundSnapshot {
  providerRefundId: string;
  /** The reference Outly sent with the refund (its idempotency key); null for a refund made outside Outly, e.g. in the provider's dashboard. */
  reference: string | null;
  amountMinor: bigint;
  status: "pending" | "succeeded" | "failed";
}

/**
 * The answer to `expireSession`. `ok` is definite: `expired` means the hosted
 * page takes no more payment (also when it had already expired); `completed`
 * means the customer finished paying before it could be expired, so the saga
 * reconciles the order's payments now.
 */
export type ExpireSessionOutcome =
  | { kind: "ok"; state: "expired" | "completed" }
  | { kind: "failed"; definite: true; code: string }
  /** `sent: false` means the request certainly never reached the provider. */
  | { kind: "unknown"; sent: boolean; reason: string };

export interface VerifiedGatewayEvent {
  providerEventId: string;
  type: string;
  providerPaymentId: string | null;
  occurredAt: string | null;
}

export interface PaymentGateway {
  account(): GatewayAccount;
  capabilities(method: string): MethodCapabilities;
  createSession(input: CreateSessionInput): Promise<{ ok: true; session: PaymentSession } | { ok: false; code: string }>;
  /** Authenticated read; the source of truth over any webhook. */
  getPayment(providerPaymentId: string): Promise<GatewayOutcome>;
  /** Every payment attempt the provider holds for one provider order: reconciliation when webhooks are lost (CR-B3-3). */
  listPaymentsForOrder(providerOrderId: string): Promise<{ ok: true; payments: GatewayPaymentSnapshot[] } | { ok: false; reason: string }>;
  capture(providerPaymentId: string, amountMinor: bigint, idempotencyKey: string): Promise<GatewayOutcome>;
  void(providerPaymentId: string, idempotencyKey: string): Promise<GatewayOutcome>;
  /** The adapter also sends `idempotencyKey` as the refund's own reference, which `listRefunds` reports back (CR-B3-15). */
  refund(providerPaymentId: string, amountMinor: bigint, idempotencyKey: string): Promise<{ kind: "accepted"; providerRefundId: string } | { kind: "failed"; definite: true; code: string } | { kind: "unknown"; sent: boolean; reason: string }>;
  getRefund(providerRefundId: string): Promise<{ status: "pending" | "succeeded" | "failed"; amountMinor: bigint } | { status: "unknown"; reason: string }>;
  /** Every refund the provider holds for one payment: finds a refund whose answer was lost by its reference (CR-B3-15). */
  listRefunds(providerPaymentId: string): Promise<{ ok: true; refunds: GatewayRefundSnapshot[] } | { ok: false; reason: string }>;
  /**
   * Optional. Closes an open hosted session (`PaymentSession.providerOrderId`)
   * at the provider, with an idempotency key. A gateway that reports a session
   * expiry later than `CreateSessionInput.expiresAt` must implement it; the
   * saga calls it once the quote has lapsed and retries `unknown` on the next
   * run. Fakes do not implement it. Contract change approved by the lead,
   * 3 November 2026 (doc 22 §32.11, Stripe session expiry).
   */
  expireSession?(providerOrderId: string, idempotencyKey: string): Promise<ExpireSessionOutcome>;
  /** Verifies the signature over the exact raw bytes; null for anything not authentic. Never parses before verifying. */
  verifyWebhook(rawBody: Uint8Array, headers: Headers): VerifiedGatewayEvent | null;
}

/* ---------------------------------------------------------------------------
 * Payment saga (per order; one or more instant items)
 *
 * Multi-item, lead-approved 3 Nov 2026 (doc 22 §32.16 question 1). One saga
 * and one payment per order, whatever its item count (at most
 * `MAX_INSTANT_ITEMS_PER_ORDER`, quotes/contracts.ts). `payment_sagas.
 * order_item_id` names the first item; every item of the order belongs to the
 * saga, in `order_items.quote_line_index` order. All or nothing until the
 * capture: the items are reserved one at a time, and any definite failure
 * releases every hold and voids the payment (refunds it in full when captured
 * first). After the capture each item stands alone: a failed confirm refunds
 * exactly that item's allocation. The states below are the order's.
 * ------------------------------------------------------------------------ */

export type PaymentSagaState =
  | "session_created"
  | "authorized"
  | "captured"
  | "capture_unknown"
  | "reserve_pending"
  | "reserved"
  | "confirm_pending"
  | "fulfilled"
  | "release_pending"
  | "released"
  | "refund_pending"
  | "refunded"
  | "failed"
  | "attention";

/** Reserve may start only when the provider reports these (PAY-6). Applies to every item of a multi-item order. */
export const RESERVE_REQUIRES = { threeDs: ["passed", "not_applicable"] as const, risk: ["normal"] as const };

/**
 * Saga states in which an item of a multi-item order may be confirmed
 * (payment evidence, evidence.ts). Narrower than a single item's: no item is
 * confirmed before every item is reserved and the whole amount captured, so a
 * capture-first order can still be refunded in full when a later item's
 * reserve fails. Multi-item, lead-approved 3 Nov 2026.
 */
export const MULTI_ITEM_CONFIRM_STATES = ["confirm_pending", "fulfilled"] as const;

/** Late payments after quote or hold expiry are refunded, never auto-rebooked (doc 22 §22.2). */
export const LATE_PAYMENT_POLICY: "refund" = "refund";

/* ---------------------------------------------------------------------------
 * Inbox (PAY-13)
 * ------------------------------------------------------------------------ */

export type InboxState = "received" | "verified" | "processing_failed" | "processed";

/* ---------------------------------------------------------------------------
 * Remedies (SUP-20, TKT-8): never write supplier attempt state
 * ------------------------------------------------------------------------ */

export type RemedyKind = "release_authorization" | "refund" | "alternative_offered";

/**
 * One remedy is for one order item. Its amount never exceeds that item's
 * allocation (`order_items` charged amount less discount share plus tax
 * share), enforced per item by the database (trigger
 * `refunds_enforce_item_cap`). Multi-item, lead-approved 3 Nov 2026.
 */
export interface RemedyRequest {
  orderId: string;
  orderItemId: string;
  kind: RemedyKind;
  reason: string;
  amountMinor: bigint;
  currency: Currency;
  /** The supplier attempt this remedy compensates; the attempt keeps its own state. */
  supplierBookingId: string | null;
  /** Outly pays while supplier liability is unresolved; capped by owner policy (question 8). */
  outlyFunded: boolean;
}

/* ---------------------------------------------------------------------------
 * Ledgers (PAY-10): three separate books, reconciled, never auto-corrected
 * ------------------------------------------------------------------------ */

export type LedgerBook = "customer_money" | "supplier_wallet" | "gateway_settlement";

export interface LedgerEntry {
  book: LedgerBook;
  orderId: string | null;
  supplierBookingId: string | null;
  paymentId: string | null;
  currency: Currency;
  /** Positive is money in to Outly (or into the supplier wallet for that book). */
  amountMinor: bigint;
  kind: string;
  evidenceRef: string;
  occurredAt: string;
}

/* ---------------------------------------------------------------------------
 * B3 seams between checkout (Juniper), payments (Ledger) and the engine (Halyard)
 * ------------------------------------------------------------------------ */

/** Ledger: `src/server/payments/checkout.service.ts`. Called by Juniper's `POST /api/checkout`. */
export interface CheckoutService {
  /**
   * Creates the instant order from an active quote the owner holds, binds the
   * order-bound contact verification, and opens one gateway session. Idempotent
   * per quote. Refuses when the release switch, readiness, pause or queue
   * admission says no, before any session is created (PAY-5).
   */
  start(input: {
    owner: { kind: "customer"; customerId: string } | { kind: "guest"; guestSessionId: string };
    quoteId: string;
    verificationId: string;
    method: string;
    traveller: { fullName: string; phoneE164: string | null; email: string | null };
    returnUrl: string;
    ip: string | null;
  }): Promise<{ ok: true; orderId: string; orderReference: string; redirectUrl: string } | { ok: false; reason: string }>;
}

/** Ledger implements; the engine calls it after any state change of an order-item attempt. */
export interface SagaNotifier {
  bookingChanged(orderItemId: string, supplierState: string): Promise<void>;
}

/** What the payment saga may ask of the engine (Halyard). Nothing else writes attempt state. */
export interface EngineSagaApi {
  /**
   * createIntent(tx, …) for the order item; the attempt starts in await_payment mode.
   * Multi-item, lead-approved 3 Nov 2026: one call per item, made by the saga one item at
   * a time in `quote_line_index` order, each only after the previous item is reserved. The
   * engine builds the attempt from the item's own quote line (by its index).
   */
  startAttempt(tx: unknown, input: { orderId: string; orderItemId: string; quoteId: string }): Promise<{ supplierBookingId: string }>;
  /** Queue the confirm; the engine re-checks payment evidence and the deadline itself. */
  confirmIfPaid(supplierBookingId: string): Promise<"queued" | "not_ready" | "too_late">;
  /** Release an unused hold (status-4 verified by the engine); never used after a confirm was sent. */
  releaseHold(supplierBookingId: string, reason: string): Promise<"queued" | "not_applicable">;
  /**
   * The latest instant at which the engine would still send the confirm (the supplier
   * deadline minus the engine's confirm budget, on database time), or null when unknown.
   * The saga captures only before this instant (CR-B3 P2: one deadline, owned by the engine).
   */
  confirmSendBy(supplierBookingId: string): Promise<string | null>;
}
