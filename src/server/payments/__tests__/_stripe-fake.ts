import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import type { StripeApi } from "../stripe/stripe-gateway";
import type { StripeConfig } from "../stripe/stripe.config";

/**
 * An in-memory Stripe for the adapter tests (doc 27 §1). It implements the
 * `StripeApi` slice `StripeGateway` uses and keeps the state Stripe would:
 * Checkout Sessions, PaymentIntents with their latest charge, refunds and
 * the account. No request ever leaves the process; the real client is never
 * built (the gateway is given this one).
 *
 * Modelled on Stripe's documented behaviour, including the parts that are
 * easy to forget:
 *  - a repeated `Idempotency-Key` returns the first response unchanged;
 *  - cancelling a PaymentIntent in `requires_capture` refunds the remaining
 *    `amount_capturable`, so the charge reports `amount_refunded` = amount
 *    with `amount_captured` 0; a partial capture refunds the rest the same way;
 *  - a Checkout Session in payment mode has no PaymentIntent until the
 *    customer pays.
 *
 * Every value is a placeholder and every amount synthetic. Key-shaped values
 * are assembled at runtime so no key-shaped literal sits in the source (the
 * public test copy runs under GitHub push protection).
 */

export const TEST_KEY = `${"sk_test"}_PLACEHOLDER000000000000000000`;
export const LIVE_KEY = `${"sk_live"}_PLACEHOLDER000000000000000000`;
export const WEBHOOK_SECRET = "whsec_PLACEHOLDER000000000000000000";
export const OTHER_WEBHOOK_SECRET = "whsec_PLACEHOLDER111111111111111111";
export const ACCOUNT_ID = "acct_PLACEHOLDER0001";
export const OTHER_ACCOUNT_ID = "acct_PLACEHOLDER0002";

export function testConfig(over: Partial<StripeConfig> = {}): StripeConfig {
  return { mode: "test", environment: "test", secretKey: TEST_KEY, webhookSecret: WEBHOOK_SECRET, accountId: ACCOUNT_ID, rails: ["aed_card"], timeoutMs: 20_000, ...over };
}

export function liveConfig(over: Partial<StripeConfig> = {}): StripeConfig {
  return testConfig({ mode: "live", environment: "production", secretKey: LIVE_KEY, ...over });
}

const rand = (n = 14) => randomBytes(n).toString("hex").slice(0, n);

/** Stripe errors as the SDK builds them from an HTTP answer (`generateV1Error`) or a socket failure. */
export const stripeError = {
  card: (code = "card_declined") => Stripe.errors.generateV1Error({ type: "card_error", code, statusCode: 402, message: "synthetic decline" }),
  invalid: (code = "resource_missing", statusCode = 400) => Stripe.errors.generateV1Error({ type: "invalid_request_error", code, statusCode, message: "synthetic invalid request" }),
  notOpen: () => Stripe.errors.generateV1Error({ type: "invalid_request_error", code: "checkout_session_not_open", statusCode: 400, message: "synthetic: session is not open" }),
  api: (statusCode = 500) => Stripe.errors.generateV1Error({ type: "api_error", statusCode, message: "synthetic api error" }),
  rateLimit: () => Stripe.errors.generateV1Error({ type: "invalid_request_error", code: "rate_limit", statusCode: 429, message: "synthetic rate limit" }),
  conflict: () => Stripe.errors.generateV1Error({ type: "invalid_request_error", code: "lock_timeout", statusCode: 409, message: "synthetic conflict" }),
  idempotency: () => Stripe.errors.generateV1Error({ type: "idempotency_error", statusCode: 400, message: "synthetic idempotency error" }),
  auth: () => Stripe.errors.generateV1Error({ type: "invalid_request_error", statusCode: 401, message: "synthetic authentication error" }),
  permission: () => Stripe.errors.generateV1Error({ type: "invalid_request_error", statusCode: 403, message: "synthetic permission error" }),
  /** What the SDK throws when the socket fails; `code` is the Node error code (`ETIMEDOUT` for its own timeout). */
  connection: (code?: string) =>
    new Stripe.errors.StripeConnectionError({ message: "synthetic connection error", detail: code ? Object.assign(new Error(`synthetic ${code}`), { code }) : undefined } as never),
};

type Obj = Record<string, unknown>;
export type FakeOp =
  | "sessions.create"
  | "sessions.retrieve"
  | "sessions.list"
  | "sessions.expire"
  | "pi.retrieve"
  | "pi.capture"
  | "pi.cancel"
  | "refunds.create"
  | "refunds.retrieve"
  | "refunds.list"
  | "account";

type Step = { kind: "throw"; error: Error; applied: boolean } | { kind: "tamper"; fn: (o: Obj) => Obj };

export interface FakeCall {
  op: FakeOp;
  id: string | null;
  params: Obj | undefined;
  options: Stripe.RequestOptions | undefined;
}

export interface PayOptions {
  /** `three_d_secure.result`; null for none reported. Default `authenticated`. */
  threeDs?: string | null;
  /** Card wallet type (`apple_pay`, `google_pay`, `link`…); null for a plain card. */
  wallet?: string | null;
  /** `outcome.risk_level`. Default `normal`. */
  risk?: string | null;
  /** `capture_before` in unix seconds; null for none. */
  captureBefore?: number | null;
  /** When the charge was authorized. Default the fake's clock. */
  at?: Date;
  /** A declined attempt: the PaymentIntent waits for another method and the session stays open. */
  decline?: boolean;
  /** Settle as captured at once (a payment captured outside the saga, e.g. in the dashboard). */
  captured?: boolean;
}

export class FakeStripe implements StripeApi {
  live = false;
  accountId = ACCOUNT_ID;
  /** Refunds are created in this status; `settleRefund` moves them on. */
  refundStatus: "pending" | "succeeded" = "succeeded";
  readonly sessions = new Map<string, Obj>();
  readonly intents = new Map<string, Obj>();
  readonly charges = new Map<string, Obj>();
  readonly refundRows = new Map<string, Obj>();
  readonly calls: FakeCall[] = [];
  private readonly steps = new Map<FakeOp, Step[]>();
  private readonly keyed = new Map<string, Obj>();

  constructor(public now: () => Date = () => new Date()) {}

  private nowS() {
    return Math.floor(this.now().getTime() / 1000);
  }

  /** The next call of `op` throws `error`; with `applied` the call takes effect first (a lost answer). */
  fail(op: FakeOp, error: Error, opts: { applied?: boolean } = {}) {
    this.queue(op).push({ kind: "throw", error, applied: opts.applied ?? false });
    return this;
  }

  /** The next `n` calls of `op` answer normally (to script a fault for a later call). */
  pass(op: FakeOp, n = 1) {
    for (let i = 0; i < n; i++) this.queue(op).push({ kind: "tamper", fn: (o) => o });
    return this;
  }

  /** The next call of `op` answers with `fn(response)` instead. */
  tamper(op: FakeOp, fn: (o: Obj) => Obj) {
    this.queue(op).push({ kind: "tamper", fn });
    return this;
  }

  private queue(op: FakeOp) {
    let q = this.steps.get(op);
    if (!q) this.steps.set(op, (q = []));
    return q;
  }

  callsOf(op: FakeOp) {
    return this.calls.filter((c) => c.op === op);
  }

  private async run<T>(op: FakeOp, id: string | null, params: Obj | undefined, options: Stripe.RequestOptions | undefined, act: () => Obj): Promise<T> {
    this.calls.push({ op, id, params: params ? structuredClone(params) : undefined, options });
    const step = this.steps.get(op)?.shift();
    if (step?.kind === "throw" && !step.applied) throw step.error;
    const key = options?.idempotencyKey;
    let out: Obj;
    const slot = key ? `${op}:${key}` : null;
    if (slot && this.keyed.has(slot)) out = structuredClone(this.keyed.get(slot)!);
    else {
      out = act();
      if (slot) this.keyed.set(slot, structuredClone(out));
    }
    if (step?.kind === "throw") throw step.error;
    if (step?.kind === "tamper") out = step.fn(out);
    return out as T;
  }

  private missing(): never {
    throw stripeError.invalid("resource_missing", 404);
  }

  /** A PaymentIntent with `latest_charge` expanded when asked. */
  private intentView(id: string, expandCharge: boolean): Obj {
    const pi = structuredClone(this.intents.get(id) ?? this.missing());
    if (expandCharge && typeof pi.latest_charge === "string") pi.latest_charge = structuredClone(this.charges.get(pi.latest_charge)!);
    return pi;
  }

  /* --------------------------------------------------------------- customer */

  /** The customer pays on the hosted page: a PaymentIntent (held, manual capture) and its charge. Returns the PaymentIntent id. */
  pay(sessionId: string, o: PayOptions = {}): string {
    const s = this.sessions.get(sessionId) ?? this.missing();
    const at = Math.floor((o.at ?? this.now()).getTime() / 1000);
    const piId = (s.payment_intent as string | null) ?? `pi_${rand(24)}`;
    const amount = s.amount_total as number;
    const chargeId = `ch_${rand(24)}`;
    const declined = Boolean(o.decline);
    const captured = !declined && Boolean(o.captured);
    this.charges.set(chargeId, {
      id: chargeId,
      object: "charge",
      livemode: this.live,
      currency: s.currency,
      amount,
      amount_captured: captured ? amount : 0,
      amount_refunded: 0,
      captured,
      refunded: false,
      status: declined ? "failed" : "succeeded",
      created: at,
      payment_intent: piId,
      outcome: { risk_level: o.risk === undefined ? "normal" : o.risk },
      payment_method_details: {
        type: "card",
        card: {
          three_d_secure: o.threeDs === null ? null : { result: o.threeDs ?? "authenticated" },
          wallet: o.wallet ? { type: o.wallet } : null,
          capture_before: o.captureBefore === undefined ? at + 7 * 86_400 : o.captureBefore,
        },
      },
    });
    this.intents.set(piId, {
      id: piId,
      object: "payment_intent",
      livemode: this.live,
      currency: s.currency,
      amount,
      amount_capturable: declined || captured ? 0 : amount,
      amount_received: captured ? amount : 0,
      status: declined ? "requires_payment_method" : captured ? "succeeded" : "requires_capture",
      cancellation_reason: null,
      last_payment_error: declined ? { code: "card_declined", type: "card_error" } : null,
      payment_method_types: ["card"],
      capture_method: "manual",
      latest_charge: chargeId,
      metadata: (s.payment_intent_data as Obj | undefined)?.metadata ?? {},
      created: at,
    });
    s.payment_intent = piId;
    if (!declined) s.status = "complete";
    return piId;
  }

  /** A refund made in the Stripe dashboard: no reference metadata. */
  dashboardRefund(piId: string, amount: number): string {
    return this.makeRefund(piId, amount, {}).id as string;
  }

  settleRefund(id: string, status: "succeeded" | "failed") {
    const r = this.refundRows.get(id)!;
    r.status = status;
  }

  /* ----------------------------------------------------------------- Stripe */

  readonly checkout: StripeApi["checkout"] = {
    sessions: {
      create: (params, options) =>
        this.run("sessions.create", null, params as unknown as Obj, options, () => {
          const id = `cs_test_${rand(24)}`;
          const item = params.line_items![0];
          const price = item.price_data!;
          const s: Obj = {
            id,
            object: "checkout.session",
            livemode: this.live,
            mode: params.mode,
            currency: price.currency,
            amount_total: (price.unit_amount ?? 0) * (item.quantity ?? 1),
            url: `https://checkout.stripe.com/c/pay/${id}`,
            expires_at: params.expires_at,
            status: "open",
            payment_intent: null,
            metadata: params.metadata,
            client_reference_id: params.client_reference_id,
            payment_intent_data: params.payment_intent_data,
            created: this.nowS(),
          };
          this.sessions.set(id, s);
          return structuredClone(s);
        }),
      retrieve: (id, params, options) =>
        this.run("sessions.retrieve", id, params as Obj | undefined, options, () => {
          const s = structuredClone(this.sessions.get(id) ?? this.missing());
          const expand = params?.expand ?? [];
          if (expand.includes("payment_intent") && typeof s.payment_intent === "string") s.payment_intent = this.intentView(s.payment_intent, expand.includes("payment_intent.latest_charge"));
          return s;
        }),
      list: (params, options) =>
        this.run("sessions.list", null, params as Obj | undefined, options, () => {
          const data = [...this.sessions.values()].filter((s) => !params?.payment_intent || s.payment_intent === params.payment_intent).map((s) => structuredClone(s));
          return { object: "list", data: data.slice(0, params?.limit ?? 10), has_more: data.length > (params?.limit ?? 10) };
        }),
      expire: (id, params, options) =>
        this.run("sessions.expire", id, params as Obj | undefined, options, () => {
          const s = this.sessions.get(id) ?? this.missing();
          if (s.status !== "open") throw stripeError.notOpen();
          s.status = "expired";
          return structuredClone(s);
        }),
    },
  };

  readonly paymentIntents: StripeApi["paymentIntents"] = {
    retrieve: (id, params, options) => this.run("pi.retrieve", id, params as Obj | undefined, options, () => this.intentView(id, Boolean(params?.expand?.includes("latest_charge")))),
    capture: (id, params, options) =>
      this.run("pi.capture", id, params as Obj | undefined, options, () => {
        const pi = this.intents.get(id) ?? this.missing();
        if (pi.status !== "requires_capture") throw stripeError.invalid("payment_intent_unexpected_state");
        const amount = params?.amount_to_capture ?? (pi.amount_capturable as number);
        if (amount > (pi.amount_capturable as number)) throw stripeError.invalid("amount_too_large");
        const charge = this.charges.get(pi.latest_charge as string)!;
        pi.status = "succeeded";
        pi.amount_received = amount;
        pi.amount_capturable = 0;
        charge.captured = true;
        charge.amount_captured = amount;
        // Stripe refunds the part of the hold that was not captured.
        charge.amount_refunded = (charge.amount as number) - amount;
        return this.intentView(id, Boolean(params?.expand?.includes("latest_charge")));
      }),
    cancel: (id, params, options) =>
      this.run("pi.cancel", id, params as Obj | undefined, options, () => {
        const pi = this.intents.get(id) ?? this.missing();
        if (pi.status === "succeeded" || pi.status === "canceled") throw stripeError.invalid("payment_intent_unexpected_state");
        if (pi.status === "requires_capture") {
          // "the remaining amount_capturable is automatically refunded" (Stripe API reference, cancel a PaymentIntent).
          const charge = this.charges.get(pi.latest_charge as string)!;
          charge.amount_refunded = charge.amount;
          charge.refunded = true;
        }
        pi.status = "canceled";
        pi.amount_capturable = 0;
        pi.cancellation_reason = params?.cancellation_reason ?? null;
        return this.intentView(id, Boolean(params?.expand?.includes("latest_charge")));
      }),
  };

  private makeRefund(piId: string, amount: number, metadata: Obj): Obj {
    const pi = this.intents.get(piId) ?? this.missing();
    if (pi.status !== "succeeded") throw stripeError.invalid("charge_not_refundable");
    const charge = this.charges.get(pi.latest_charge as string)!;
    const released = (charge.amount as number) - (charge.amount_captured as number);
    const refundedOfCaptured = (charge.amount_refunded as number) - released;
    if (amount > (charge.amount_captured as number) - refundedOfCaptured) throw stripeError.invalid("charge_already_refunded");
    charge.amount_refunded = (charge.amount_refunded as number) + amount;
    const id = `re_${rand(24)}`;
    const r: Obj = { id, object: "refund", amount, currency: pi.currency, payment_intent: piId, charge: charge.id, status: this.refundStatus, metadata, created: this.nowS() };
    this.refundRows.set(id, r);
    return r;
  }

  readonly refunds: StripeApi["refunds"] = {
    create: (params, options) =>
      this.run("refunds.create", null, params as Obj | undefined, options, () => structuredClone(this.makeRefund(params!.payment_intent!, params!.amount!, (params!.metadata ?? {}) as Obj))),
    retrieve: (id, params, options) => this.run("refunds.retrieve", id, params as Obj | undefined, options, () => structuredClone(this.refundRows.get(id) ?? this.missing())),
    list: (params, options) =>
      this.run("refunds.list", null, params as Obj | undefined, options, () => {
        const all = [...this.refundRows.values()].filter((r) => !params?.payment_intent || r.payment_intent === params.payment_intent);
        const start = params?.starting_after ? all.findIndex((r) => r.id === params.starting_after) + 1 : 0;
        const limit = params?.limit ?? 10;
        const data = all.slice(start, start + limit).map((r) => structuredClone(r));
        return { object: "list", data, has_more: start + limit < all.length };
      }),
  };

  readonly accounts: StripeApi["accounts"] = {
    retrieveCurrent: (params, options) => this.run("account", null, params as Obj | undefined, options, () => ({ id: this.accountId, object: "account" })),
  };
}

/** A Stripe event as the webhook endpoint receives it. */
export function stripeEvent(type: string, object: Obj, over: Obj = {}): Obj {
  return { id: `evt_${rand(24)}`, object: "event", api_version: "2026-09-30.endive", type, livemode: false, created: Math.floor(Date.now() / 1000), data: { object }, ...over };
}

/** Raw bytes and a `Stripe-Signature` header built by the SDK's own test helper. */
export function signed(payload: string | Obj, opts: { secret?: string; timestamp?: number } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const header = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: opts.secret ?? WEBHOOK_SECRET, timestamp: opts.timestamp });
  return { raw: new TextEncoder().encode(body), headers: new Headers({ "stripe-signature": header }), header, body };
}
