import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import Stripe from "stripe";
import { gatewayReturnUrls } from "@/lib/checkout-return";
import type { Currency } from "@/lib/types";
import {
  RAIL_CURRENCY,
  type CreateSessionInput,
  type ExpireSessionOutcome,
  type GatewayAccount,
  type GatewayOutcome,
  type GatewayPaymentSnapshot,
  type GatewayRefundSnapshot,
  type MethodCapabilities,
  type PaymentGateway,
  type PaymentRail,
  type PaymentSession,
  type ProviderPaymentStatus,
  type VerifiedGatewayEvent,
} from "../contracts";
import { stripeConfigFrom, type StripeConfig, type StripeEnvSlice } from "./stripe.config";

/**
 * Stripe adapter behind the `PaymentGateway` port (doc 22 §32.11).
 *
 * One Stripe account (UAE) and one webhook endpoint serve every configured
 * rail: `aed_card` (AED) and, until Razorpay exists, `inr_pacb` (INR by
 * card). The registry learns the rails from `rails()`; `account().rail` is
 * the first of them.
 *
 *  - Hosted Checkout (mode `payment`), so card data never reaches Outly. Card
 *    only (Apple Pay and Google Pay are card wallets on hosted Checkout); no
 *    UPI, netbanking, Link or other wallets.
 *  - Cards are held (`capture_method: manual`), captured once (partial
 *    capture allowed) or voided by cancelling the PaymentIntent.
 *  - A Checkout Session lives at least 30 minutes, longer than a quote, so
 *    the reported session expiry can be later than the quote's; the saga
 *    closes the page with `expireSession` once the quote lapses.
 *  - Every write carries an `Idempotency-Key`; the SDK never retries
 *    (`maxNetworkRetries: 0`), the saga owns retries and keys.
 *  - Every read checks the account (once per process, `GET /v1/account`),
 *    the mode (`livemode`) and that the currency belongs to a configured
 *    rail. Any mismatch is `unknown`, never `ok`.
 *  - Webhooks are verified over the exact raw bytes (`t=<unix>,v1=<hmac>`
 *    over `${t}.${rawBody}`, 300 s window) before anything is parsed, and
 *    only name the payment: the saga re-reads it with `getPayment`.
 *
 * Amounts are minor units (fils for AED, paise for INR; Stripe uses two
 * decimals for both). Nothing here reads `process.env`.
 */

/** Pinned; must equal the API version this SDK release is generated for (typecheck enforces it). */
export const STRIPE_API_VERSION = "2026-09-30.endive" as const;
export const STRIPE_PROVIDER = "stripe";
export const STRIPE_WEBHOOK_TOLERANCE_S = 300;
/** Checkout `expires_at` must be 30 minutes to 24 hours after creation. */
export const CHECKOUT_MIN_LIFETIME_MS = 30 * 60_000;
export const CHECKOUT_MAX_LIFETIME_MS = 24 * 3600_000;
/** Margin for the clock difference between Outly and Stripe at session creation. */
export const CHECKOUT_CLOCK_MARGIN_MS = 60_000;
/** The shortest session asked for: Stripe's minimum plus the clock margin. The saga expires it when the quote lapses. */
export const CHECKOUT_REQUESTED_MIN_LIFETIME_MS = CHECKOUT_MIN_LIFETIME_MS + CHECKOUT_CLOCK_MARGIN_MS;
/**
 * Stripe's minimum charge per presentment currency, in minor units: AED 2.00,
 * INR 0.50. A charge converted to the settlement currency must also meet the
 * AED minimum after conversion; that is not checked here (it needs an FX
 * rate), so a small INR charge can still be refused by Stripe.
 */
export const STRIPE_MIN_AMOUNT_MINOR: Readonly<Record<Currency, bigint>> = { AED: 200n, INR: 50n };
/** Stripe's largest amount: eight digits of minor units. */
export const STRIPE_MAX_AMOUNT_MINOR = 99_999_999n;
/** Online card authorizations live seven days unless the charge reports `capture_before`. */
export const CARD_AUTHORIZATION_LIFETIME_MS = 7 * 86_400_000;
const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 50;
/** Refund metadata key carrying Outly's reference (its idempotency key), read back by `listRefunds` (CR-B3-15). */
export const REFUND_REFERENCE_KEY = "reference";

/** The Stripe calls this adapter makes. A real `Stripe` client satisfies it; tests inject a fake. */
export interface StripeApi {
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams, options: Stripe.RequestOptions): Promise<Stripe.Checkout.Session>;
      retrieve(id: string, params?: Stripe.Checkout.SessionRetrieveParams, options?: Stripe.RequestOptions): Promise<Stripe.Checkout.Session>;
      list(params?: Stripe.Checkout.SessionListParams, options?: Stripe.RequestOptions): Promise<Stripe.ApiList<Stripe.Checkout.Session>>;
      expire(id: string, params?: Stripe.Checkout.SessionExpireParams, options?: Stripe.RequestOptions): Promise<Stripe.Checkout.Session>;
    };
  };
  paymentIntents: {
    retrieve(id: string, params?: Stripe.PaymentIntentRetrieveParams, options?: Stripe.RequestOptions): Promise<Stripe.PaymentIntent>;
    capture(id: string, params?: Stripe.PaymentIntentCaptureParams, options?: Stripe.RequestOptions): Promise<Stripe.PaymentIntent>;
    cancel(id: string, params?: Stripe.PaymentIntentCancelParams, options?: Stripe.RequestOptions): Promise<Stripe.PaymentIntent>;
  };
  refunds: {
    create(params?: Stripe.RefundCreateParams, options?: Stripe.RequestOptions): Promise<Stripe.Refund>;
    retrieve(id: string, params?: Stripe.RefundRetrieveParams, options?: Stripe.RequestOptions): Promise<Stripe.Refund>;
    list(params?: Stripe.RefundListParams, options?: Stripe.RequestOptions): Promise<Stripe.ApiList<Stripe.Refund>>;
  };
  accounts: {
    retrieveCurrent(params?: Stripe.AccountRetrieveCurrentParams, options?: Stripe.RequestOptions): Promise<Stripe.Account>;
  };
}

/** The real client: pinned API version, no SDK retries, an explicit timeout, no telemetry. */
export function createStripeClient(config: StripeConfig): StripeApi {
  return new Stripe(config.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 0,
    timeout: config.timeoutMs,
    telemetry: false,
    appInfo: { name: "outly" },
  });
}

/** A method Stripe is not used for here. */
export class StripeUnsupportedMethodError extends Error {
  constructor(readonly method: string) {
    super(`stripe does not support method ${method}`);
    this.name = "StripeUnsupportedMethodError";
  }
}

type Failed = { kind: "failed"; definite: true; code: string };
type Unknown = { kind: "unknown"; sent: boolean; reason: string };

const failed = (code: string): Failed => ({ kind: "failed", definite: true, code: code.slice(0, 64) });
const unknown = (reason: string, sent = true): Unknown => ({ kind: "unknown", sent, reason: reason.slice(0, 64) });

/** Errors the network layer reports before any byte reached Stripe. */
const NEVER_SENT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ERR_INVALID_URL"]);

/**
 * A thrown Stripe call as a port outcome. Only a definite answer from Stripe
 * (a card decline, a refused request) is `failed`; everything else (network,
 * timeout, 5xx, 429, 409, idempotency conflicts, authentication) is
 * `unknown`, because the request may have acted or will work once fixed.
 */
export function classifyStripeError(e: unknown): Failed | Unknown {
  if (e instanceof Stripe.errors.StripeError) {
    const status = e.statusCode;
    if (status === 409) return unknown("conflict");
    if (status !== undefined && status >= 500) return unknown("provider_error");
    switch (e.type) {
      case "StripeCardError":
        return failed(e.code ?? e.decline_code ?? "card_declined");
      case "StripeInvalidRequestError":
        return failed(e.code ?? "invalid_request");
      case "StripeIdempotencyError":
        return unknown("idempotency_conflict");
      case "StripeRateLimitError":
        return unknown("rate_limited");
      case "StripeAPIError":
        return unknown("provider_error");
      case "StripeAuthenticationError":
        return unknown("authentication");
      case "StripePermissionError":
        return unknown("permission");
      case "StripeConnectionError": {
        const detail = e.detail as { code?: unknown } | undefined;
        const code = detail && typeof detail === "object" && typeof detail.code === "string" ? detail.code : null;
        if (code === "ETIMEDOUT") return unknown("timeout");
        return unknown("connection", !(code !== null && NEVER_SENT_CODES.has(code)));
      }
      default:
        return unknown("stripe_error");
    }
  }
  return unknown("unexpected_error");
}

const PI_ID = /^pi_[A-Za-z0-9]{1,250}$/;
const CS_ID = /^cs_(test|live)_[A-Za-z0-9]{1,250}$/;
const RE_ID = /^(re|pyr)_[A-Za-z0-9]{1,250}$/;
const EVT_ID = /^evt_[A-Za-z0-9]{1,250}$/;

function iso(unixSeconds: number | null | undefined): string | null {
  return typeof unixSeconds === "number" && Number.isFinite(unixSeconds) ? new Date(unixSeconds * 1000).toISOString() : null;
}

function idOf(v: string | { id: string } | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.id;
}

function refundStatus(s: string | null): GatewayRefundSnapshot["status"] {
  if (s === "succeeded") return "succeeded";
  if (s === "failed" || s === "canceled") return "failed";
  return "pending";
}

/**
 * 3DS as the reserve gate reads it (`RESERVE_REQUIRES`). A reported result
 * wins. Without one:
 *  - Apple Pay is `not_applicable`: its device cryptogram authenticates the
 *    payment (lead decision, 3 November 2026);
 *  - Google Pay stays `unknown`: a PAN_ONLY Google Pay card is not device
 *    authenticated, so the gate refuses it and the hold is voided. What
 *    Stripe reports for Google Pay with `request_three_d_secure: "any"` is an
 *    A6 test-mode check;
 *  - every other wallet, and a plain card, stays `unknown`.
 */
function threeDsOf(charge: Stripe.Charge | null): GatewayPaymentSnapshot["threeDs"] {
  const card = charge?.payment_method_details?.card;
  const result = card?.three_d_secure?.result;
  if (result === "authenticated" || result === "attempt_acknowledged") return "passed";
  if (result === "failed") return "failed";
  if (!result && card?.wallet?.type === "apple_pay") return "not_applicable";
  return "unknown";
}

function riskOf(charge: Stripe.Charge | null): GatewayPaymentSnapshot["risk"] {
  const r = charge?.outcome?.risk_level;
  return r === "normal" || r === "elevated" || r === "highest" ? r : "unknown";
}

function statusOf(pi: Stripe.PaymentIntent, captured: bigint, refunded: bigint): ProviderPaymentStatus | null {
  switch (pi.status) {
    case "requires_capture":
      return "authorized";
    case "succeeded":
      if (refunded > 0n) return refunded >= captured ? "refunded" : "partially_refunded";
      return "captured";
    case "canceled":
      return pi.cancellation_reason === "expired" ? "expired" : "voided";
    case "requires_payment_method":
      return pi.last_payment_error ? "failed" : "requires_action";
    case "requires_action":
    case "requires_confirmation":
    case "processing":
      return "requires_action";
    default:
      return null;
  }
}

export interface StripeGatewayOptions {
  config: StripeConfig;
  /** Injected in tests; defaults to `createStripeClient(config)`. */
  client?: StripeApi;
  now?: () => Date;
}

export class StripeGateway implements PaymentGateway {
  readonly provider = STRIPE_PROVIDER;
  private readonly config: StripeConfig;
  private readonly client: StripeApi;
  private readonly now: () => Date;
  private readonly live: boolean;
  private readonly currencies: ReadonlySet<Currency>;
  /** Set once `GET /v1/account` answered: true when it named the configured account. */
  private accountVerified: boolean | null = null;

  constructor(opts: StripeGatewayOptions) {
    if (!opts.config.rails.length) throw new Error("Stripe gateway needs at least one rail");
    this.config = opts.config;
    this.client = opts.client ?? createStripeClient(opts.config);
    this.now = opts.now ?? (() => new Date());
    this.live = opts.config.environment === "production";
    this.currencies = new Set(opts.config.rails.map((r) => RAIL_CURRENCY[r]));
  }

  /** Every rail this one Stripe account serves; the registry maps each to this instance. */
  rails(): readonly PaymentRail[] {
    return this.config.rails;
  }

  account(): GatewayAccount {
    return { provider: STRIPE_PROVIDER, accountId: this.config.accountId, environment: this.config.environment, rail: this.config.rails[0] };
  }

  capabilities(method: string): MethodCapabilities {
    if (method !== "card") throw new StripeUnsupportedMethodError(method);
    return {
      authorization: "hold",
      release: "void",
      authorizationLifetimeMs: CARD_AUTHORIZATION_LIFETIME_MS,
      partialCapture: true,
      multipleCapture: false,
      webhookSigned: true,
      webhookSignedTimestamp: true,
    };
  }

  /** A Stripe currency code as a configured rail's currency, or null. */
  private currencyOf(code: string | null | undefined): Currency | null {
    const c = (code ?? "").toUpperCase();
    return (this.currencies as ReadonlySet<string>).has(c) ? (c as Currency) : null;
  }

  /**
   * Whether the key acts for the configured account. Asked once per process;
   * a mismatch is remembered, a failed read is asked again next time.
   */
  private async accountState(): Promise<"ok" | "mismatch" | "unknown"> {
    if (this.accountVerified === true) return "ok";
    if (this.accountVerified === false) return "mismatch";
    try {
      const a = await this.client.accounts.retrieveCurrent();
      this.accountVerified = a.id === this.config.accountId;
      return this.accountVerified ? "ok" : "mismatch";
    } catch {
      return "unknown";
    }
  }

  /** Null when the account is verified; otherwise the outcome to return (nothing was sent for the operation itself). */
  private async accountRefusal(): Promise<Unknown | null> {
    const s = await this.accountState();
    if (s === "ok") return null;
    return unknown(s === "mismatch" ? "account_mismatch" : "account_unverified", false);
  }

  /** The PaymentIntent (with its latest charge expanded) as a snapshot, or why it cannot be trusted. */
  private snapshot(pi: Stripe.PaymentIntent, providerOrderId: string | null): { ok: true; payment: GatewayPaymentSnapshot } | { ok: false; reason: string } {
    if (pi.object !== "payment_intent" || !PI_ID.test(pi.id)) return { ok: false, reason: "not_a_payment_intent" };
    if (pi.livemode !== this.live) return { ok: false, reason: "livemode_mismatch" };
    const currency = this.currencyOf(pi.currency);
    if (!currency) return { ok: false, reason: "currency_mismatch" };
    const latest = pi.latest_charge;
    if (typeof latest === "string") return { ok: false, reason: "charge_not_expanded" };
    const charge = latest ?? null;
    if (charge) {
      if (charge.livemode !== this.live) return { ok: false, reason: "livemode_mismatch" };
      if (charge.currency.toUpperCase() !== currency) return { ok: false, reason: "currency_mismatch" };
      if (idOf(charge.payment_intent) !== pi.id) return { ok: false, reason: "charge_mismatch" };
    }
    const amountMinor = BigInt(pi.amount);
    const capturedMinor = BigInt(charge ? charge.amount_captured : pi.amount_received);
    // Stripe counts the released part of a hold in `amount_refunded`: all of it when an uncaptured PaymentIntent is
    // cancelled or lapses, the uncaptured rest after a partial capture. Only refunds of captured money count here.
    const releasedMinor = charge ? (charge.captured ? charge.amount - charge.amount_captured : charge.amount_refunded) : 0;
    const refundedMinor = BigInt(charge ? Math.max(0, charge.amount_refunded - releasedMinor) : 0);
    const status = statusOf(pi, capturedMinor, refundedMinor);
    if (!status) return { ok: false, reason: "status_unrecognised" };
    const card = charge?.payment_method_details?.card ?? null;
    const authorizedAt = charge && charge.status === "succeeded" ? iso(charge.created) : null;
    const captureBefore = iso(card?.capture_before);
    const authorizationExpiresAt =
      captureBefore ?? (status === "authorized" && authorizedAt ? new Date(Date.parse(authorizedAt) + CARD_AUTHORIZATION_LIFETIME_MS).toISOString() : null);
    const method = charge?.payment_method_details?.type ?? (pi.payment_method_types.length === 1 ? pi.payment_method_types[0] : null);
    return {
      ok: true,
      payment: {
        providerPaymentId: pi.id,
        providerOrderId,
        accountId: this.config.accountId,
        status,
        currency,
        amountMinor,
        capturedMinor,
        refundedMinor,
        method,
        threeDs: threeDsOf(charge),
        risk: riskOf(charge),
        authorizedAt,
        authorizationExpiresAt,
      },
    };
  }

  /** The Checkout Session that produced a PaymentIntent; null when none did. Throws on a failed read. */
  private async sessionIdFor(paymentIntentId: string): Promise<string | null> {
    const page = await this.client.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 2 });
    if (page.data.length > 1) throw new Error("stripe: more than one Checkout Session for one PaymentIntent");
    const s = page.data[0];
    if (!s) return null;
    if (s.livemode !== this.live) throw new Error("stripe: Checkout Session livemode mismatch");
    return s.id;
  }

  /** A write's PaymentIntent as an outcome; the session lookup is best effort (the write already happened). */
  private async writeOutcome(pi: Stripe.PaymentIntent): Promise<GatewayOutcome> {
    let providerOrderId: string | null = null;
    try {
      providerOrderId = await this.sessionIdFor(pi.id);
    } catch {
      providerOrderId = null;
    }
    const s = this.snapshot(pi, providerOrderId);
    return s.ok ? { kind: "ok", payment: s.payment } : unknown(s.reason);
  }

  async createSession(input: CreateSessionInput): Promise<{ ok: true; session: PaymentSession } | { ok: false; code: string }> {
    if (input.method !== "card") return { ok: false, code: "method_not_supported" };
    const currency = this.currencyOf(input.currency);
    if (!currency || currency !== input.currency) return { ok: false, code: "currency_not_configured" };
    if (input.amountMinor <= 0n || input.amountMinor > STRIPE_MAX_AMOUNT_MINOR) return { ok: false, code: "amount_invalid" };
    if (input.amountMinor < STRIPE_MIN_AMOUNT_MINOR[currency]) return { ok: false, code: "amount_below_provider_minimum" };
    if (!input.idempotencyKey || input.idempotencyKey.length > 255) return { ok: false, code: "idempotency_key_invalid" };
    let returnUrl: URL;
    try {
      returnUrl = new URL(input.returnUrl);
    } catch {
      return { ok: false, code: "return_url_invalid" };
    }
    if (returnUrl.protocol !== "https:" && !(this.config.environment === "test" && returnUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(returnUrl.hostname))) {
      return { ok: false, code: "return_url_invalid" };
    }

    // Stripe closes the page at `expires_at`: 30 minutes to 24 hours after creation. A quote is shorter, so the page
    // is asked to live at least 31 minutes and the saga expires it when the quote lapses (`expireSession`, CR-B3-7).
    const now = this.now().getTime();
    const requested = Date.parse(input.expiresAt);
    if (!Number.isFinite(requested) || requested <= now) return { ok: false, code: "expires_at_invalid" };
    const target = Math.min(Math.max(requested, now + CHECKOUT_REQUESTED_MIN_LIFETIME_MS), now + CHECKOUT_MAX_LIFETIME_MS - CHECKOUT_CLOCK_MARGIN_MS);
    const expiresAtS = Math.floor(target / 1000);

    const account = await this.accountState();
    if (account === "mismatch") return { ok: false, code: "account_mismatch" };
    if (account === "unknown") throw new Error("stripe: account could not be verified");

    const metadata = { orderId: input.orderId, quoteId: input.quoteId, idempotencyKey: input.idempotencyKey };
    const returnUrls = gatewayReturnUrls(returnUrl);
    let session: Stripe.Checkout.Session;
    try {
      session = await this.client.checkout.sessions.create(
        {
          mode: "payment",
          line_items: [{ quantity: 1, price_data: { currency: currency.toLowerCase(), unit_amount: Number(input.amountMinor), product_data: { name: "Outly booking" } } }],
          allowed_payment_method_types: ["card"],
          adaptive_pricing: { enabled: false },
          payment_method_options: { card: { request_three_d_secure: "any" } },
          payment_intent_data: { capture_method: "manual", metadata },
          client_reference_id: input.orderId,
          metadata,
          expires_at: expiresAtS,
          // Same neutral page, told apart only by a wording hint (`?result=success|cancel`, CO-08). The page never trusts it.
          success_url: returnUrls.success,
          cancel_url: returnUrls.cancel,
        },
        { idempotencyKey: input.idempotencyKey },
      );
    } catch (e) {
      const o = classifyStripeError(e);
      // A definite refusal closes the attempt; anything else may have created a session, so the caller retries with the same key.
      if (o.kind === "failed") return { ok: false, code: o.code };
      throw new Error(`stripe: createSession ${o.reason}`);
    }

    if (!CS_ID.test(session.id) || session.livemode !== this.live) return { ok: false, code: "session_mismatch" };
    if ((session.currency ?? "").toUpperCase() !== currency || session.amount_total !== Number(input.amountMinor)) return { ok: false, code: "session_mismatch" };
    if (!session.url || !session.url.startsWith("https://")) return { ok: false, code: "session_without_url" };
    const endsAt = session.expires_at * 1000;
    if (!Number.isFinite(endsAt) || endsAt <= now) return { ok: false, code: "session_expiry_mismatch" };
    return { ok: true, session: { sessionId: session.id, providerOrderId: session.id, redirectUrl: session.url, expiresAt: new Date(endsAt).toISOString() } };
  }

  /**
   * Closes an open Checkout Session (`POST /v1/checkout/sessions/:id/expire`)
   * with an idempotency key. A session that is no longer open is read back:
   * already expired is `ok/expired`; complete (the customer paid first) is
   * `ok/completed`, so the saga reconciles.
   */
  async expireSession(providerOrderId: string, idempotencyKey: string): Promise<ExpireSessionOutcome> {
    if (!CS_ID.test(providerOrderId)) return failed("order_not_found");
    if (!idempotencyKey || idempotencyKey.length > 255) return failed("idempotency_key_invalid");
    const refusal = await this.accountRefusal();
    if (refusal) return refusal;
    let session: Stripe.Checkout.Session;
    try {
      session = await this.client.checkout.sessions.expire(providerOrderId, {}, { idempotencyKey });
    } catch (e) {
      const o = classifyStripeError(e);
      if (o.kind === "unknown") return o;
      // Refused, most often because the session is no longer open: read what it is.
      try {
        session = await this.client.checkout.sessions.retrieve(providerOrderId);
      } catch (e2) {
        const r = classifyStripeError(e2);
        return r.kind === "unknown" ? r : o;
      }
      if (session.status === "open") return o;
    }
    if (session.id !== providerOrderId || session.livemode !== this.live) return unknown("session_mismatch");
    if (session.status === "expired") return { kind: "ok", state: "expired" };
    if (session.status === "complete") return { kind: "ok", state: "completed" };
    return unknown("session_status_unrecognised");
  }

  async getPayment(providerPaymentId: string): Promise<GatewayOutcome> {
    if (!PI_ID.test(providerPaymentId)) return failed("payment_not_found");
    const refusal = await this.accountRefusal();
    if (refusal) return refusal;
    let pi: Stripe.PaymentIntent;
    let sessionId: string | null;
    try {
      pi = await this.client.paymentIntents.retrieve(providerPaymentId, { expand: ["latest_charge"] });
      sessionId = await this.sessionIdFor(providerPaymentId);
    } catch (e) {
      return classifyStripeError(e);
    }
    const s = this.snapshot(pi, sessionId);
    return s.ok ? { kind: "ok", payment: s.payment } : unknown(s.reason);
  }

  /** A Checkout Session produces at most one PaymentIntent; declined tries stay on it as charges. */
  async listPaymentsForOrder(providerOrderId: string): Promise<{ ok: true; payments: GatewayPaymentSnapshot[] } | { ok: false; reason: string }> {
    if (!CS_ID.test(providerOrderId)) return { ok: false, reason: "order_not_found" };
    const refusal = await this.accountRefusal();
    if (refusal) return { ok: false, reason: refusal.reason };
    let session: Stripe.Checkout.Session;
    try {
      session = await this.client.checkout.sessions.retrieve(providerOrderId, { expand: ["payment_intent", "payment_intent.latest_charge"] });
    } catch (e) {
      const o = classifyStripeError(e);
      return { ok: false, reason: o.kind === "failed" ? o.code : o.reason };
    }
    if (session.id !== providerOrderId || session.livemode !== this.live) return { ok: false, reason: "session_mismatch" };
    if (!this.currencyOf(session.currency)) return { ok: false, reason: "currency_mismatch" };
    const pi = session.payment_intent;
    if (pi === null) return { ok: true, payments: [] };
    if (typeof pi === "string") return { ok: false, reason: "payment_intent_not_expanded" };
    const s = this.snapshot(pi, session.id);
    return s.ok ? { ok: true, payments: [s.payment] } : { ok: false, reason: s.reason };
  }

  async capture(providerPaymentId: string, amountMinor: bigint, idempotencyKey: string): Promise<GatewayOutcome> {
    if (!PI_ID.test(providerPaymentId)) return failed("payment_not_found");
    if (amountMinor <= 0n || amountMinor > STRIPE_MAX_AMOUNT_MINOR) return failed("amount_invalid");
    const refusal = await this.accountRefusal();
    if (refusal) return refusal;
    let pi: Stripe.PaymentIntent;
    try {
      pi = await this.client.paymentIntents.capture(providerPaymentId, { amount_to_capture: Number(amountMinor), expand: ["latest_charge"] }, { idempotencyKey });
    } catch (e) {
      return classifyStripeError(e);
    }
    return this.writeOutcome(pi);
  }

  async void(providerPaymentId: string, idempotencyKey: string): Promise<GatewayOutcome> {
    if (!PI_ID.test(providerPaymentId)) return failed("payment_not_found");
    const refusal = await this.accountRefusal();
    if (refusal) return refusal;
    let pi: Stripe.PaymentIntent;
    try {
      pi = await this.client.paymentIntents.cancel(providerPaymentId, { expand: ["latest_charge"] }, { idempotencyKey });
    } catch (e) {
      return classifyStripeError(e);
    }
    return this.writeOutcome(pi);
  }

  async refund(
    providerPaymentId: string,
    amountMinor: bigint,
    idempotencyKey: string,
  ): Promise<{ kind: "accepted"; providerRefundId: string } | { kind: "failed"; definite: true; code: string } | { kind: "unknown"; sent: boolean; reason: string }> {
    if (!PI_ID.test(providerPaymentId)) return failed("payment_not_found");
    if (amountMinor <= 0n || amountMinor > STRIPE_MAX_AMOUNT_MINOR) return failed("amount_invalid");
    if (!idempotencyKey || idempotencyKey.length > 255) return failed("idempotency_key_invalid");
    const refusal = await this.accountRefusal();
    if (refusal) return refusal;
    let r: Stripe.Refund;
    try {
      r = await this.client.refunds.create(
        { payment_intent: providerPaymentId, amount: Number(amountMinor), metadata: { [REFUND_REFERENCE_KEY]: idempotencyKey } },
        { idempotencyKey },
      );
    } catch (e) {
      return classifyStripeError(e);
    }
    if (!RE_ID.test(r.id) || idOf(r.payment_intent) !== providerPaymentId) return unknown("refund_mismatch");
    if (!this.currencyOf(r.currency)) return unknown("currency_mismatch");
    if (BigInt(r.amount) !== amountMinor) return unknown("refund_amount_mismatch");
    return { kind: "accepted", providerRefundId: r.id };
  }

  async getRefund(providerRefundId: string): Promise<{ status: "pending" | "succeeded" | "failed"; amountMinor: bigint } | { status: "unknown"; reason: string }> {
    if (!RE_ID.test(providerRefundId)) return { status: "unknown", reason: "refund_not_found" };
    const refusal = await this.accountRefusal();
    if (refusal) return { status: "unknown", reason: refusal.reason };
    let r: Stripe.Refund;
    try {
      r = await this.client.refunds.retrieve(providerRefundId);
    } catch (e) {
      const o = classifyStripeError(e);
      return { status: "unknown", reason: o.kind === "failed" ? o.code : o.reason };
    }
    if (r.id !== providerRefundId) return { status: "unknown", reason: "refund_mismatch" };
    if (!this.currencyOf(r.currency)) return { status: "unknown", reason: "currency_mismatch" };
    return { status: refundStatus(r.status), amountMinor: BigInt(r.amount) };
  }

  /** Every refund on the PaymentIntent, paginated to completion; anything short of the full list is `ok: false`. */
  async listRefunds(providerPaymentId: string): Promise<{ ok: true; refunds: GatewayRefundSnapshot[] } | { ok: false; reason: string }> {
    if (!PI_ID.test(providerPaymentId)) return { ok: false, reason: "payment_not_found" };
    const refusal = await this.accountRefusal();
    if (refusal) return { ok: false, reason: refusal.reason };
    const out: GatewayRefundSnapshot[] = [];
    const seen = new Set<string>();
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      let list: Stripe.ApiList<Stripe.Refund>;
      try {
        list = await this.client.refunds.list({ payment_intent: providerPaymentId, limit: LIST_PAGE_SIZE, ...(startingAfter ? { starting_after: startingAfter } : {}) });
      } catch (e) {
        const o = classifyStripeError(e);
        return { ok: false, reason: o.kind === "failed" ? o.code : o.reason };
      }
      for (const r of list.data) {
        if (idOf(r.payment_intent) !== providerPaymentId) return { ok: false, reason: "refund_mismatch" };
        if (!this.currencyOf(r.currency)) return { ok: false, reason: "currency_mismatch" };
        if (seen.has(r.id)) return { ok: false, reason: "pagination_repeated" };
        seen.add(r.id);
        const ref = r.metadata?.[REFUND_REFERENCE_KEY];
        out.push({ providerRefundId: r.id, reference: typeof ref === "string" && ref ? ref : null, amountMinor: BigInt(r.amount), status: refundStatus(r.status) });
      }
      if (!list.has_more) return { ok: true, refunds: out };
      const last = list.data[list.data.length - 1];
      if (!last) return { ok: false, reason: "pagination_stalled" };
      startingAfter = last.id;
    }
    return { ok: false, reason: "too_many_refunds" };
  }

  /**
   * Verifies `Stripe-Signature` over the exact raw bytes (constant-time,
   * every `v1` entry, 300 s either side of now), then parses. Null for
   * anything not authentic, malformed, not valid UTF-8, from the other mode
   * or another account. An authentic event of a type the saga does not use
   * is returned without a payment id, so Stripe stops retrying it and the
   * saga ignores it.
   */
  verifyWebhook(rawBody: Uint8Array, headers: Headers): VerifiedGatewayEvent | null {
    const header = headers.get("stripe-signature");
    if (!header || header.length > 4096) return null;
    let t: string | null = null;
    const v1: string[] = [];
    for (const part of header.split(",")) {
      const i = part.indexOf("=");
      if (i <= 0) continue;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      if (k === "t") {
        if (t !== null || !/^\d{1,12}$/.test(v)) return null;
        t = v;
      } else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
    }
    if (t === null || v1.length === 0 || v1.length > 8) return null;
    if (Math.abs(this.now().getTime() / 1000 - Number(t)) > STRIPE_WEBHOOK_TOLERANCE_S) return null;
    const raw = Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
    const expected = createHmac("sha256", this.config.webhookSecret).update(`${t}.`).update(raw).digest();
    let match = false;
    for (const sig of v1) if (timingSafeEqual(Buffer.from(sig, "hex"), expected)) match = true;
    if (!match) return null;

    // Parsed only after the signature over these exact bytes matched.
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      return null;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const b = body as Record<string, unknown>;
    if (typeof b.id !== "string" || !EVT_ID.test(b.id)) return null;
    if (typeof b.type !== "string" || !b.type || b.type.length > 100) return null;
    if (b.livemode !== this.live) return null;
    if (b.account !== undefined && b.account !== null && b.account !== this.config.accountId) return null;
    const data = b.data as Record<string, unknown> | undefined;
    const object = data && typeof data === "object" ? (data.object as Record<string, unknown> | undefined) : undefined;
    const mapped = mapEvent(b.type, object && typeof object === "object" ? object : null);
    return {
      providerEventId: b.id,
      type: mapped.type,
      providerPaymentId: mapped.paymentIntentId,
      occurredAt: typeof b.created === "number" ? iso(b.created) : null,
    };
  }
}

const PAYMENT_INTENT_EVENTS = new Set(["payment_intent.amount_capturable_updated", "payment_intent.succeeded", "payment_intent.canceled", "payment_intent.payment_failed"]);
const CHECKOUT_EVENTS = new Set(["checkout.session.completed", "checkout.session.expired"]);
const REFUND_EVENTS = new Set(["charge.refund.updated", "refund.created", "refund.updated", "refund.failed"]);

function piIdIn(v: unknown): string | null {
  const id = typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : null;
  return id && PI_ID.test(id) ? id : null;
}

/**
 * The payment an event names, for the event types the saga acts on. Stripe
 * disputes are reported as `dispute.<suffix>` so the saga's dispute handling
 * (`isDisputeType`) sees them. Every other type keeps its name and names no
 * payment.
 */
function mapEvent(type: string, object: Record<string, unknown> | null): { type: string; paymentIntentId: string | null } {
  if (!object) return { type, paymentIntentId: null };
  if (CHECKOUT_EVENTS.has(type) && object.object === "checkout.session") return { type, paymentIntentId: piIdIn(object.payment_intent) };
  if (PAYMENT_INTENT_EVENTS.has(type) && object.object === "payment_intent") return { type, paymentIntentId: piIdIn(object.id) };
  if (REFUND_EVENTS.has(type) && object.object === "refund") return { type, paymentIntentId: piIdIn(object.payment_intent) };
  if (type.startsWith("charge.dispute.") && object.object === "dispute") return { type: `dispute.${type.slice("charge.dispute.".length)}`, paymentIntentId: piIdIn(object.payment_intent) };
  return { type, paymentIntentId: null };
}

/**
 * One gateway per configuration, so the account check runs once per process.
 * Keyed by a hash, never by the key itself.
 */
const instances = new Map<string, StripeGateway>();

/** The Stripe gateway the env selects, or null when Stripe is off or refused. */
export function stripeGatewayFromEnv(env: StripeEnvSlice): StripeGateway | null {
  const config = stripeConfigFrom(env);
  if (!config) return null;
  const id = createHash("sha256")
    .update([config.mode, config.accountId, config.rails.join(","), config.secretKey, config.webhookSecret].join("\u0000"))
    .digest("hex");
  let g = instances.get(id);
  if (!g) {
    g = new StripeGateway({ config });
    instances.set(id, g);
  }
  return g;
}
