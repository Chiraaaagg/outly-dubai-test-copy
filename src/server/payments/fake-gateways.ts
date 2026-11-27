import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Currency } from "@/lib/types";
import type {
  CreateSessionInput,
  GatewayAccount,
  GatewayOutcome,
  GatewayPaymentSnapshot,
  GatewayRefundSnapshot,
  MethodCapabilities,
  PaymentGateway,
  PaymentRail,
  PaymentSession,
  ProviderPaymentStatus,
  VerifiedGatewayEvent,
} from "./contracts";

/**
 * Fake payment gateways for B3 (doc 22 §23 B3: "Both INR and AED pass on
 * fakes"). No provider is selected, so nothing here imitates a real API: each
 * fake keeps a small in-memory provider (orders, payments, refunds) and
 * behaves exactly as its `capabilities()` say. Tests drive the customer's
 * side (`pay`), the clock (`now`) and faults (`script`).
 *
 *  - `fake-inr-pacb` (rail `inr_pacb`): `upi` is capture-only (the payment is
 *    final when it succeeds; refund is the only way back); `card` debits at
 *    authorization (the customer is debited when authorized; an uncaptured
 *    authorization is auto-refunded after three days; no partial capture).
 *    Webhooks are signed with HMAC-SHA256 over the raw body only, with no
 *    signed timestamp: replay protection is event-id uniqueness.
 *  - `fake-aed-card` (rail `aed_card`): `card` is a true hold with partial
 *    capture and void, living seven days. Webhooks carry `t=<unix>,v1=<hmac>`
 *    over `${t}.${rawBody}` and are refused outside a five-minute window.
 *
 * Mutations are idempotent per key, like the providers the port is written
 * for: a repeated key returns the first answer and never acts twice. A
 * scripted `unknown` with `applied: true` is a lost response (the provider
 * acted, the caller did not hear); with `applied: false` the request never
 * landed.
 *
 * Every amount a test uses is synthetic.
 */

export type FakeOperation = "createSession" | "getPayment" | "listPaymentsForOrder" | "capture" | "void" | "refund" | "getRefund" | "listRefunds";

export type FakeFault =
  | { kind: "unknown"; sent: boolean; applied: boolean; reason?: string }
  | { kind: "failed"; code: string }
  /** createSession only: the call throws, as a network failure would. */
  | { kind: "throw" }
  /** No fault for this call; lets a script reach a later call. */
  | { kind: "pass" };

interface FakeOrder {
  providerOrderId: string;
  sessionId: string;
  orderId: string;
  currency: Currency;
  amountMinor: bigint;
  method: string;
  idempotencyKey: string;
  redirectUrl: string;
  expiresAt: string;
}

interface FakePayment {
  id: string;
  providerOrderId: string;
  accountId: string;
  currency: Currency;
  amountMinor: bigint;
  capturedMinor: bigint;
  refundedMinor: bigint;
  status: ProviderPaymentStatus;
  method: string;
  threeDs: GatewayPaymentSnapshot["threeDs"];
  risk: GatewayPaymentSnapshot["risk"];
  authorizedAt: string | null;
  authorizationExpiresAt: string | null;
}

interface FakeRefund {
  id: string;
  paymentId: string;
  /** The caller's idempotency key; null for a refund made in the provider's dashboard. */
  reference: string | null;
  amountMinor: bigint;
  status: "pending" | "succeeded" | "failed";
}

export interface FakeGatewayOptions {
  accountId?: string;
  environment?: "test" | "production";
  /** Webhook signing secret; synthetic, test-only. */
  webhookSecret?: string;
  now?: () => Date;
  /** `immediately`: a refund succeeds on its first read; `manual`: it stays pending until `settleRefund`. */
  refundsSettle?: "immediately" | "manual";
}

const WEBHOOK_TOLERANCE_S = 300;
const SIGNATURE_HEADER = "x-fake-signature";

function hmacHex(secret: string, data: Buffer): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

function sameHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** The provider-side state and mechanics both fakes share. */
abstract class FakeGatewayBase implements PaymentGateway {
  abstract readonly provider: string;
  abstract readonly rail: PaymentRail;
  protected readonly accountId: string;
  protected readonly environment: "test" | "production";
  readonly webhookSecret: string;
  now: () => Date;
  refundsSettle: "immediately" | "manual";

  readonly orders = new Map<string, FakeOrder>();
  readonly payments = new Map<string, FakePayment>();
  readonly refunds = new Map<string, FakeRefund>();
  /** Every call the port received, in order, for assertions ("never a second charge"). */
  readonly calls: Array<{ op: FakeOperation; args: unknown[] }> = [];
  private readonly faults = new Map<FakeOperation, FakeFault[]>();
  private readonly keyed = new Map<string, unknown>();
  private seq = 0;
  private readonly instance = randomBytes(6).toString("hex");

  constructor(opts: FakeGatewayOptions) {
    this.accountId = opts.accountId ?? "fake-account-1";
    this.environment = opts.environment ?? "test";
    this.webhookSecret = opts.webhookSecret ?? "fake-webhook-secret-not-real";
    this.now = opts.now ?? (() => new Date());
    this.refundsSettle = opts.refundsSettle ?? "immediately";
  }

  abstract capabilities(method: string): MethodCapabilities;
  protected abstract sign(raw: Buffer, unixSeconds: number): Record<string, string>;
  protected abstract verifySignature(raw: Buffer, headers: Headers): boolean;

  account(): GatewayAccount {
    return { provider: this.provider, accountId: this.accountId, environment: this.environment, rail: this.rail };
  }

  /** Unique across instances, like a real provider's ids (tests share one database). */
  protected id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.provider.replace(/-/g, "")}_${this.instance}_${this.seq}`;
  }

  /** Queue a fault for the next call of `op` (first in, first out). */
  script(op: FakeOperation, ...faults: FakeFault[]): this {
    this.faults.set(op, [...(this.faults.get(op) ?? []), ...faults]);
    return this;
  }

  callsOf(op: FakeOperation): unknown[][] {
    return this.calls.filter((c) => c.op === op).map((c) => c.args);
  }

  /** How long a hosted session stays payable at the provider. */
  sessionTtlMs = 15 * 60_000;

  /** The provider forgets every idempotency key (an expired key window): a repeat is a fresh request. */
  forgetKeys() {
    this.keyed.clear();
  }

  /** While true every `getPayment` and `listPaymentsForOrder` answers unknown (the provider is unreachable). */
  readsUnavailable = false;

  private nextFault(op: FakeOperation): FakeFault | undefined {
    if ((op === "getPayment" || op === "listPaymentsForOrder") && this.readsUnavailable) return { kind: "unknown", sent: true, applied: false, reason: "unreachable" };
    const f = this.faults.get(op)?.shift();
    return f?.kind === "pass" ? undefined : f;
  }

  /** A keyed mutation: replays return the first answer; a scripted fault applies to a fresh key only. */
  private keyedCall<T>(op: FakeOperation, key: string, act: () => T, unknownOf: (f: Extract<FakeFault, { kind: "unknown" }>) => T, failedOf: (code: string) => T): T {
    const cacheKey = `${op}:${key}`;
    if (this.keyed.has(cacheKey)) return this.keyed.get(cacheKey) as T;
    const fault = this.nextFault(op);
    if (fault?.kind === "failed") {
      const r = failedOf(fault.code);
      this.keyed.set(cacheKey, r);
      return r;
    }
    if (fault?.kind === "unknown") {
      if (fault.applied) this.keyed.set(cacheKey, act());
      return unknownOf(fault);
    }
    const r = act();
    this.keyed.set(cacheKey, r);
    return r;
  }

  private expireIfDue(p: FakePayment) {
    if (p.status === "authorized" && p.authorizationExpiresAt && this.now().getTime() >= Date.parse(p.authorizationExpiresAt)) p.status = "expired";
  }

  snapshotOf(p: FakePayment): GatewayPaymentSnapshot {
    this.expireIfDue(p);
    return {
      providerPaymentId: p.id,
      providerOrderId: p.providerOrderId,
      accountId: p.accountId,
      status: p.status,
      currency: p.currency,
      amountMinor: p.amountMinor,
      capturedMinor: p.capturedMinor,
      refundedMinor: p.refundedMinor,
      method: p.method,
      threeDs: p.threeDs,
      risk: p.risk,
      authorizedAt: p.authorizedAt,
      authorizationExpiresAt: p.authorizationExpiresAt,
    };
  }

  async createSession(input: CreateSessionInput): Promise<{ ok: true; session: PaymentSession } | { ok: false; code: string }> {
    this.calls.push({ op: "createSession", args: [input] });
    this.capabilities(input.method);
    const cacheKey = `createSession:${input.idempotencyKey}`;
    if (this.keyed.has(cacheKey)) return this.keyed.get(cacheKey) as { ok: true; session: PaymentSession };
    const fault = this.nextFault("createSession");
    if (fault?.kind === "throw") throw new Error("fake gateway: connection reset");
    if (fault?.kind === "failed") return { ok: false, code: fault.code };
    const providerOrderId = this.id("order");
    // The page closes at the caller's expiry, or sooner at the provider's own session limit (CR-B3-7).
    const requested = Date.parse(input.expiresAt);
    if (!Number.isFinite(requested) || requested <= this.now().getTime()) return { ok: false, code: "expires_at_invalid" };
    const session: PaymentSession = {
      sessionId: this.id("session"),
      providerOrderId,
      redirectUrl: `https://${this.provider}.invalid/pay/${providerOrderId}`,
      expiresAt: new Date(Math.min(this.now().getTime() + this.sessionTtlMs, requested)).toISOString(),
    };
    this.orders.set(providerOrderId, {
      providerOrderId,
      sessionId: session.sessionId,
      orderId: input.orderId,
      currency: input.currency,
      amountMinor: input.amountMinor,
      method: input.method,
      idempotencyKey: input.idempotencyKey,
      redirectUrl: session.redirectUrl,
      expiresAt: session.expiresAt,
    });
    const r = { ok: true as const, session };
    this.keyed.set(cacheKey, r);
    return r;
  }

  /**
   * The customer pays on the hosted page. What the payment becomes follows
   * the method's semantics; `amountMinor`, `currency` and `accountId` let a
   * test fake a provider that reports something else. The page refuses
   * payment once the session expired; `afterExpiry` fakes a payment the
   * provider took anyway (one already in flight at the expiry, or a provider
   * whose orders do not expire), which Outly must refund as late (F46).
   */
  pay(
    providerOrderId: string,
    opts: {
      outcome?: "success" | "failed" | "requires_action";
      threeDs?: GatewayPaymentSnapshot["threeDs"];
      risk?: GatewayPaymentSnapshot["risk"];
      amountMinor?: bigint;
      currency?: Currency;
      accountId?: string;
      method?: string;
      afterExpiry?: boolean;
    } = {},
  ): string {
    const order = this.orders.get(providerOrderId);
    if (!order) throw new Error(`fake gateway: no order ${providerOrderId}`);
    if (!opts.afterExpiry && this.now().getTime() >= Date.parse(order.expiresAt)) throw new SessionExpiredError(providerOrderId);
    const method = opts.method ?? order.method;
    const caps = this.capabilities(method);
    const amountMinor = opts.amountMinor ?? order.amountMinor;
    const now = this.now();
    const outcome = opts.outcome ?? "success";
    const authorized = outcome === "success";
    const status: ProviderPaymentStatus =
      outcome === "failed" ? "failed" : outcome === "requires_action" ? "requires_action" : caps.authorization === "capture_only" ? "captured" : "authorized";
    const p: FakePayment = {
      id: this.id("pay"),
      providerOrderId,
      accountId: opts.accountId ?? this.accountId,
      currency: opts.currency ?? order.currency,
      amountMinor,
      capturedMinor: status === "captured" ? amountMinor : 0n,
      refundedMinor: 0n,
      status,
      method,
      threeDs: opts.threeDs ?? (method === "upi" ? "not_applicable" : "passed"),
      risk: opts.risk ?? "normal",
      authorizedAt: authorized ? now.toISOString() : null,
      authorizationExpiresAt: authorized && caps.authorizationLifetimeMs !== null && status === "authorized" ? new Date(now.getTime() + caps.authorizationLifetimeMs).toISOString() : null,
    };
    this.payments.set(p.id, p);
    return p.id;
  }

  async getPayment(providerPaymentId: string): Promise<GatewayOutcome> {
    this.calls.push({ op: "getPayment", args: [providerPaymentId] });
    const fault = this.nextFault("getPayment");
    if (fault?.kind === "unknown") return { kind: "unknown", sent: fault.sent, reason: fault.reason ?? "timeout" };
    if (fault?.kind === "failed") return { kind: "failed", definite: true, code: fault.code };
    const p = this.payments.get(providerPaymentId);
    if (!p) return { kind: "failed", definite: true, code: "payment_not_found" };
    return { kind: "ok", payment: this.snapshotOf(p) };
  }

  /** Every attempt on one provider order, in the order they were made (the reconciliation read). */
  async listPaymentsForOrder(providerOrderId: string): Promise<{ ok: true; payments: GatewayPaymentSnapshot[] } | { ok: false; reason: string }> {
    this.calls.push({ op: "listPaymentsForOrder", args: [providerOrderId] });
    const fault = this.nextFault("listPaymentsForOrder");
    if (fault?.kind === "unknown") return { ok: false, reason: fault.reason ?? "timeout" };
    if (fault?.kind === "failed") return { ok: false, reason: fault.code };
    return { ok: true, payments: [...this.payments.values()].filter((p) => p.providerOrderId === providerOrderId).map((p) => this.snapshotOf(p)) };
  }

  async capture(providerPaymentId: string, amountMinor: bigint, idempotencyKey: string): Promise<GatewayOutcome> {
    this.calls.push({ op: "capture", args: [providerPaymentId, amountMinor, idempotencyKey] });
    return this.keyedCall<GatewayOutcome>(
      "capture",
      idempotencyKey,
      () => {
        const p = this.payments.get(providerPaymentId);
        if (!p) return { kind: "failed", definite: true, code: "payment_not_found" };
        this.expireIfDue(p);
        if (p.status !== "authorized") return { kind: "failed", definite: true, code: `not_capturable_${p.status}` };
        const caps = this.capabilities(p.method);
        if (amountMinor <= 0n || amountMinor > p.amountMinor) return { kind: "failed", definite: true, code: "amount_invalid" };
        if (!caps.partialCapture && amountMinor !== p.amountMinor) return { kind: "failed", definite: true, code: "partial_capture_not_supported" };
        p.status = "captured";
        p.capturedMinor = amountMinor;
        return { kind: "ok", payment: this.snapshotOf(p) };
      },
      (f) => ({ kind: "unknown", sent: f.sent, reason: f.reason ?? "timeout" }),
      (code) => ({ kind: "failed", definite: true, code }),
    );
  }

  async void(providerPaymentId: string, idempotencyKey: string): Promise<GatewayOutcome> {
    this.calls.push({ op: "void", args: [providerPaymentId, idempotencyKey] });
    return this.keyedCall<GatewayOutcome>(
      "void",
      idempotencyKey,
      () => {
        const p = this.payments.get(providerPaymentId);
        if (!p) return { kind: "failed", definite: true, code: "payment_not_found" };
        if (this.capabilities(p.method).release !== "void") return { kind: "failed", definite: true, code: "void_not_supported" };
        this.expireIfDue(p);
        if (p.status === "voided") return { kind: "ok", payment: this.snapshotOf(p) };
        if (p.status !== "authorized") return { kind: "failed", definite: true, code: `not_voidable_${p.status}` };
        p.status = "voided";
        return { kind: "ok", payment: this.snapshotOf(p) };
      },
      (f) => ({ kind: "unknown", sent: f.sent, reason: f.reason ?? "timeout" }),
      (code) => ({ kind: "failed", definite: true, code }),
    );
  }

  async refund(providerPaymentId: string, amountMinor: bigint, idempotencyKey: string) {
    this.calls.push({ op: "refund", args: [providerPaymentId, amountMinor, idempotencyKey] });
    type R = { kind: "accepted"; providerRefundId: string } | { kind: "failed"; definite: true; code: string } | { kind: "unknown"; sent: boolean; reason: string };
    return this.keyedCall<R>(
      "refund",
      idempotencyKey,
      () => {
        const p = this.payments.get(providerPaymentId);
        if (!p) return { kind: "failed", definite: true, code: "payment_not_found" };
        const pending = [...this.refunds.values()].filter((r) => r.paymentId === p.id && r.status !== "failed").reduce((s, r) => s + r.amountMinor, 0n);
        if (amountMinor <= 0n || pending + amountMinor > p.capturedMinor) return { kind: "failed", definite: true, code: "refund_exceeds_captured" };
        const r: FakeRefund = { id: this.id("rfnd"), paymentId: p.id, reference: idempotencyKey, amountMinor, status: "pending" };
        this.refunds.set(r.id, r);
        return { kind: "accepted", providerRefundId: r.id };
      },
      (f) => ({ kind: "unknown", sent: f.sent, reason: f.reason ?? "timeout" }),
      (code) => ({ kind: "failed", definite: true, code }),
    );
  }

  /** Complete a pending refund (provider side). */
  settleRefund(providerRefundId: string, status: "succeeded" | "failed") {
    const r = this.refunds.get(providerRefundId);
    if (!r || r.status !== "pending") return;
    r.status = status;
    if (status === "succeeded") {
      const p = this.payments.get(r.paymentId)!;
      p.refundedMinor += r.amountMinor;
      p.status = p.refundedMinor >= p.capturedMinor ? "refunded" : "partially_refunded";
    }
  }

  /** A refund made outside Outly, in the provider's dashboard: it succeeds at once and carries no reference. */
  dashboardRefund(providerPaymentId: string, amountMinor: bigint): string {
    const p = this.payments.get(providerPaymentId);
    if (!p) throw new Error(`fake gateway: no payment ${providerPaymentId}`);
    const r: FakeRefund = { id: this.id("rfnd"), paymentId: p.id, reference: null, amountMinor, status: "pending" };
    this.refunds.set(r.id, r);
    this.settleRefund(r.id, "succeeded");
    return r.id;
  }

  async listRefunds(providerPaymentId: string): Promise<{ ok: true; refunds: GatewayRefundSnapshot[] } | { ok: false; reason: string }> {
    this.calls.push({ op: "listRefunds", args: [providerPaymentId] });
    const fault = this.nextFault("listRefunds");
    if (fault?.kind === "unknown") return { ok: false, reason: fault.reason ?? "timeout" };
    if (fault?.kind === "failed") return { ok: false, reason: fault.code };
    return {
      ok: true,
      refunds: [...this.refunds.values()].filter((r) => r.paymentId === providerPaymentId).map((r) => ({ providerRefundId: r.id, reference: r.reference, amountMinor: r.amountMinor, status: r.status })),
    };
  }

  async getRefund(providerRefundId: string) {
    this.calls.push({ op: "getRefund", args: [providerRefundId] });
    const fault = this.nextFault("getRefund");
    if (fault && fault.kind !== "throw" && fault.kind !== "pass") return { status: "unknown" as const, reason: fault.kind === "failed" ? fault.code : (fault.reason ?? "timeout") };
    const r = this.refunds.get(providerRefundId);
    if (!r) return { status: "unknown" as const, reason: "refund_not_found" };
    if (r.status === "pending" && this.refundsSettle === "immediately") this.settleRefund(r.id, "succeeded");
    return { status: r.status, amountMinor: r.amountMinor };
  }

  /**
   * A webhook as this provider would send it: the exact bytes and signed
   * headers. `body` may add fields (a test that the content is never trusted).
   */
  webhook(type: string, providerPaymentId: string | null, opts: { eventId?: string; at?: Date; body?: Record<string, unknown> } = {}): { raw: Uint8Array; headers: Headers; eventId: string } {
    const at = opts.at ?? this.now();
    const eventId = opts.eventId ?? this.id("evt");
    const json = JSON.stringify({ id: eventId, type, payment_id: providerPaymentId, created: Math.floor(at.getTime() / 1000), ...opts.body });
    const raw = Buffer.from(json, "utf8");
    const headers = new Headers({ "content-type": "application/json", ...this.sign(raw, Math.floor(at.getTime() / 1000)) });
    return { raw: new Uint8Array(raw), headers, eventId };
  }

  verifyWebhook(rawBody: Uint8Array, headers: Headers): VerifiedGatewayEvent | null {
    const raw = Buffer.from(rawBody);
    if (!this.verifySignature(raw, headers)) return null;
    // Parsed only after the signature over these exact bytes matched.
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return null;
    }
    if (!body || typeof body !== "object") return null;
    const b = body as Record<string, unknown>;
    if (typeof b.id !== "string" || !b.id || b.id.length > 200 || typeof b.type !== "string" || !b.type || b.type.length > 100) return null;
    const paymentId = typeof b.payment_id === "string" && b.payment_id.length <= 200 ? b.payment_id : null;
    const created = typeof b.created === "number" && Number.isFinite(b.created) ? new Date(b.created * 1000).toISOString() : null;
    return { providerEventId: b.id, type: b.type, providerPaymentId: paymentId, occurredAt: created };
  }

  protected signatureHeader(headers: Headers): string | null {
    const v = headers.get(SIGNATURE_HEADER);
    return v && v.length <= 512 ? v : null;
  }
}

/** INR through a cross-border payment aggregator: UPI capture-only, card debit at authorization. */
export class FakeInrPacbGateway extends FakeGatewayBase {
  readonly provider = "fake-inr-pacb";
  readonly rail = "inr_pacb" as const;

  constructor(opts: FakeGatewayOptions = {}) {
    super(opts);
  }

  capabilities(method: string): MethodCapabilities {
    const signing = { webhookSigned: true, webhookSignedTimestamp: false };
    if (method === "upi") return { authorization: "capture_only", release: "refund", authorizationLifetimeMs: null, partialCapture: false, multipleCapture: false, ...signing };
    if (method === "card") return { authorization: "debit_at_authorization", release: "auto_refund", authorizationLifetimeMs: 3 * 86_400_000, partialCapture: false, multipleCapture: false, ...signing };
    throw new UnsupportedMethodError(this.provider, method);
  }

  protected sign(raw: Buffer): Record<string, string> {
    return { [SIGNATURE_HEADER]: hmacHex(this.webhookSecret, raw) };
  }

  protected verifySignature(raw: Buffer, headers: Headers): boolean {
    const sig = this.signatureHeader(headers);
    return sig !== null && sameHex(sig, hmacHex(this.webhookSecret, raw));
  }
}

/** AED through a UAE card acquirer: a true hold with partial capture and void, seven days. */
export class FakeAedCardGateway extends FakeGatewayBase {
  readonly provider = "fake-aed-card";
  readonly rail = "aed_card" as const;

  constructor(opts: FakeGatewayOptions = {}) {
    super(opts);
  }

  capabilities(method: string): MethodCapabilities {
    if (method === "card") {
      return { authorization: "hold", release: "void", authorizationLifetimeMs: 7 * 86_400_000, partialCapture: true, multipleCapture: false, webhookSigned: true, webhookSignedTimestamp: true };
    }
    throw new UnsupportedMethodError(this.provider, method);
  }

  protected sign(raw: Buffer, unixSeconds: number): Record<string, string> {
    const t = String(unixSeconds);
    return { [SIGNATURE_HEADER]: `t=${t},v1=${hmacHex(this.webhookSecret, Buffer.concat([Buffer.from(`${t}.`), raw]))}` };
  }

  protected verifySignature(raw: Buffer, headers: Headers): boolean {
    const sig = this.signatureHeader(headers);
    const m = sig ? /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(sig) : null;
    if (!m) return false;
    const t = Number(m[1]);
    if (Math.abs(this.now().getTime() / 1000 - t) > WEBHOOK_TOLERANCE_S) return false;
    return sameHex(m[2], hmacHex(this.webhookSecret, Buffer.concat([Buffer.from(`${m[1]}.`), raw])));
  }
}

export type FakeGateway = FakeInrPacbGateway | FakeAedCardGateway;

/** The customer tried to pay on a hosted page whose session had expired; the provider took nothing. */
export class SessionExpiredError extends Error {
  constructor(readonly providerOrderId: string) {
    super(`fake gateway: session for ${providerOrderId} has expired`);
    this.name = "SessionExpiredError";
  }
}

/** A method the gateway does not offer. */
export class UnsupportedMethodError extends Error {
  constructor(
    readonly provider: string,
    readonly method: string,
  ) {
    super(`${provider} does not support method ${method}`);
    this.name = "UnsupportedMethodError";
  }
}

export const FAKE_PROVIDERS = ["fake-inr-pacb", "fake-aed-card"] as const;
