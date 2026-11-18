import { describe, expect, it } from "vitest";
import { RESERVE_REQUIRES, type CreateSessionInput } from "../contracts";
import {
  CARD_AUTHORIZATION_LIFETIME_MS,
  CHECKOUT_CLOCK_MARGIN_MS,
  CHECKOUT_MAX_LIFETIME_MS,
  CHECKOUT_REQUESTED_MIN_LIFETIME_MS,
  classifyStripeError,
  REFUND_REFERENCE_KEY,
  StripeGateway,
  StripeUnsupportedMethodError,
} from "../stripe/stripe-gateway";
import { FakeStripe, liveConfig, OTHER_ACCOUNT_ID, stripeError, testConfig, type PayOptions } from "./_stripe-fake";

/**
 * StripeGateway against an in-memory Stripe (doc 27 §1 cases 2–10 and 13).
 * No network: the gateway is always given the fake client. Synthetic amounts
 * (AED 10_000 fils, INR 230_000 paise) and placeholder ids only.
 */

const NOW = new Date("2030-01-10T08:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const MIN = 60_000;
const ORDER = "00000000-0000-7000-8000-0000000000a1";
const QUOTE = "00000000-0000-7000-8000-0000000000a2";

function setup(over: Parameters<typeof testConfig>[0] = {}) {
  const clock = { t: NOW.getTime() };
  const now = () => new Date(clock.t);
  const client = new FakeStripe(now);
  const gw = new StripeGateway({ config: testConfig(over), client, now });
  return { gw, client, clock };
}

function input(over: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    orderId: ORDER,
    quoteId: QUOTE,
    currency: "AED",
    amountMinor: 10_000n,
    idempotencyKey: "pay:order-a1:1",
    returnUrl: "https://outly.example/checkout/return",
    method: "card",
    expiresAt: new Date(NOW.getTime() + 10 * MIN).toISOString(),
    ...over,
  };
}

async function session(s: ReturnType<typeof setup>, over: Partial<CreateSessionInput> = {}) {
  const r = await s.gw.createSession(input(over));
  if (!r.ok) throw new Error(`createSession refused: ${r.code}`);
  return r.session;
}

/** A session the customer paid on: the PaymentIntent is held (`requires_capture`). */
async function held(s: ReturnType<typeof setup>, pay: PayOptions = {}, over: Partial<CreateSessionInput> = {}) {
  const ses = await session(s, over);
  return { ses, pi: s.client.pay(ses.providerOrderId, pay) };
}

async function snap(s: ReturnType<typeof setup>, pi: string) {
  const o = await s.gw.getPayment(pi);
  if (o.kind !== "ok") throw new Error(`getPayment: ${JSON.stringify(o)}`);
  return o.payment;
}

const createParams = (s: ReturnType<typeof setup>) => s.client.callsOf("sessions.create").at(-1)!.params as Record<string, any>;

describe("case 2: minor units", () => {
  it("AED is sent in fils and INR in paise: unit_amount equals amountMinor", async () => {
    const s = setup({ rails: ["aed_card", "inr_pacb"] });
    await session(s);
    expect(createParams(s).line_items).toEqual([{ quantity: 1, price_data: { currency: "aed", unit_amount: 10_000, product_data: { name: "Outly booking" } } }]);
    await session(s, { currency: "INR", amountMinor: 230_000n, idempotencyKey: "pay:order-a1:inr" });
    expect(createParams(s).line_items[0].price_data).toMatchObject({ currency: "inr", unit_amount: 230_000 });
  });

  it("refuses amounts ≤ 0 or above 99,999,999 before calling Stripe", async () => {
    const s = setup();
    for (const amountMinor of [0n, -1n, -10_000n, 100_000_000n, 10n ** 12n]) {
      expect(await s.gw.createSession(input({ amountMinor })), String(amountMinor)).toEqual({ ok: false, code: "amount_invalid" });
    }
    expect(s.client.calls).toHaveLength(0);
    expect((await s.gw.createSession(input({ amountMinor: 99_999_999n }))).ok).toBe(true);
  });

  it("enforces Stripe's minimum charge: AED 199 fils and INR 49 paise refused, 200 and 50 accepted", async () => {
    const s = setup({ rails: ["aed_card", "inr_pacb"] });
    expect(await s.gw.createSession(input({ amountMinor: 199n }))).toEqual({ ok: false, code: "amount_below_provider_minimum" });
    expect(await s.gw.createSession(input({ currency: "INR", amountMinor: 49n }))).toEqual({ ok: false, code: "amount_below_provider_minimum" });
    expect(s.client.callsOf("sessions.create")).toHaveLength(0);
    expect((await s.gw.createSession(input({ amountMinor: 200n, idempotencyKey: "k-aed" }))).ok).toBe(true);
    expect((await s.gw.createSession(input({ currency: "INR", amountMinor: 50n, idempotencyKey: "k-inr" }))).ok).toBe(true);
  });

  it("refuses a session whose amount or currency differs from the request", async () => {
    const s = setup();
    s.client.tamper("sessions.create", (o) => ({ ...o, amount_total: (o.amount_total as number) + 1 }));
    expect(await s.gw.createSession(input({ idempotencyKey: "k1" }))).toEqual({ ok: false, code: "session_mismatch" });
    s.client.tamper("sessions.create", (o) => ({ ...o, amount_total: 100 }));
    expect(await s.gw.createSession(input({ idempotencyKey: "k2" }))).toEqual({ ok: false, code: "session_mismatch" });
    s.client.tamper("sessions.create", (o) => ({ ...o, currency: "inr" }));
    expect(await s.gw.createSession(input({ idempotencyKey: "k3" }))).toEqual({ ok: false, code: "session_mismatch" });
    s.client.tamper("sessions.create", (o) => ({ ...o, livemode: true }));
    expect(await s.gw.createSession(input({ idempotencyKey: "k4" }))).toEqual({ ok: false, code: "session_mismatch" });
    s.client.tamper("sessions.create", (o) => ({ ...o, id: "cs_live_PLACEHOLDER/../x" }));
    expect(await s.gw.createSession(input({ idempotencyKey: "k5" }))).toEqual({ ok: false, code: "session_mismatch" });
    s.client.tamper("sessions.create", (o) => ({ ...o, url: "http://checkout.stripe.com/x" }));
    expect(await s.gw.createSession(input({ idempotencyKey: "k6" }))).toEqual({ ok: false, code: "session_without_url" });
    s.client.tamper("sessions.create", (o) => ({ ...o, url: null }));
    expect(await s.gw.createSession(input({ idempotencyKey: "k7" }))).toEqual({ ok: false, code: "session_without_url" });
  });

  it("reports amounts read back in minor units, as bigints", async () => {
    const s = setup();
    const { pi } = await held(s);
    expect(await snap(s, pi)).toMatchObject({ currency: "AED", amountMinor: 10_000n, capturedMinor: 0n, refundedMinor: 0n });
  });
});

describe("case 3: currency and account", () => {
  it("a currency outside the configured rails is unknown on the PaymentIntent and the charge", async () => {
    const s = setup();
    const { pi } = await held(s);
    s.client.tamper("pi.retrieve", (o) => ({ ...o, currency: "inr", latest_charge: { ...(o.latest_charge as object), currency: "inr" } }));
    expect(await s.gw.getPayment(pi)).toEqual({ kind: "unknown", sent: true, reason: "currency_mismatch" });
    s.client.tamper("pi.retrieve", (o) => ({ ...o, currency: "usd" }));
    expect(await s.gw.getPayment(pi)).toMatchObject({ kind: "unknown", reason: "currency_mismatch" });
    // The charge in another currency than its PaymentIntent.
    s.client.tamper("pi.retrieve", (o) => ({ ...o, latest_charge: { ...(o.latest_charge as object), currency: "usd" } }));
    expect(await s.gw.getPayment(pi)).toMatchObject({ kind: "unknown", reason: "currency_mismatch" });
    // Writes read back the same way.
    s.client.tamper("pi.capture", (o) => ({ ...o, currency: "inr" }));
    expect(await s.gw.capture(pi, 10_000n, "capture:p1")).toMatchObject({ kind: "unknown", reason: "currency_mismatch" });
  });

  it("a currency outside the rails is ok:false on the session and unknown on refunds", async () => {
    const s = setup();
    const { ses, pi } = await held(s);
    s.client.tamper("sessions.retrieve", (o) => ({ ...o, currency: "usd" }));
    expect(await s.gw.listPaymentsForOrder(ses.providerOrderId)).toEqual({ ok: false, reason: "currency_mismatch" });
    await s.gw.capture(pi, 10_000n, "capture:p1");
    s.client.tamper("refunds.create", (o) => ({ ...o, currency: "inr" }));
    expect(await s.gw.refund(pi, 1_000n, "refund:r1")).toEqual({ kind: "unknown", sent: true, reason: "currency_mismatch" });
    const id = [...s.client.refundRows.keys()][0];
    s.client.tamper("refunds.retrieve", (o) => ({ ...o, currency: "inr" }));
    expect(await s.gw.getRefund(id)).toEqual({ status: "unknown", reason: "currency_mismatch" });
    s.client.tamper("refunds.list", (o) => ({ ...o, data: (o.data as object[]).map((r) => ({ ...r, currency: "usd" })) }));
    expect(await s.gw.listRefunds(pi)).toEqual({ ok: false, reason: "currency_mismatch" });
  });

  it("INR passes when both rails are configured, and is refused when only aed_card is", async () => {
    const both = setup({ rails: ["aed_card", "inr_pacb"] });
    const { pi } = await held(both, {}, { currency: "INR", amountMinor: 230_000n });
    expect(await snap(both, pi)).toMatchObject({ currency: "INR", amountMinor: 230_000n, status: "authorized" });
    expect(both.gw.rails()).toEqual(["aed_card", "inr_pacb"]);

    const aedOnly = setup();
    expect(await aedOnly.gw.createSession(input({ currency: "INR", amountMinor: 230_000n }))).toEqual({ ok: false, code: "currency_not_configured" });
    expect(aedOnly.client.calls).toHaveLength(0);
    // An INR PaymentIntent read through an AED-only gateway is not trusted.
    const otherStripe = setup({ rails: ["aed_card", "inr_pacb"] });
    const x = await held(otherStripe, {}, { currency: "INR", amountMinor: 230_000n });
    const gwAed = new StripeGateway({ config: testConfig(), client: otherStripe.client, now: () => NOW });
    expect(await gwAed.getPayment(x.pi)).toMatchObject({ kind: "unknown", reason: "currency_mismatch" });
  });

  it("an account mismatch is unknown with sent:false, on every operation, and nothing else is called", async () => {
    const s = setup();
    const { ses, pi } = await held(s);
    const fresh = new FakeStripe(() => NOW);
    fresh.sessions.set(ses.providerOrderId, s.client.sessions.get(ses.providerOrderId)!);
    fresh.accountId = OTHER_ACCOUNT_ID;
    const gw = new StripeGateway({ config: testConfig(), client: fresh, now: () => NOW });
    const refused = { kind: "unknown", sent: false, reason: "account_mismatch" };
    expect(await gw.getPayment(pi)).toEqual(refused);
    expect(await gw.capture(pi, 10_000n, "capture:p1")).toEqual(refused);
    expect(await gw.void(pi, "void:p1")).toEqual(refused);
    expect(await gw.refund(pi, 1_000n, "refund:r1")).toEqual(refused);
    expect(await gw.expireSession(ses.providerOrderId, "expire:p1")).toEqual(refused);
    expect(await gw.listPaymentsForOrder(ses.providerOrderId)).toEqual({ ok: false, reason: "account_mismatch" });
    expect(await gw.getRefund("re_PLACEHOLDER0001")).toEqual({ status: "unknown", reason: "account_mismatch" });
    expect(await gw.listRefunds(pi)).toEqual({ ok: false, reason: "account_mismatch" });
    expect(await gw.createSession(input())).toEqual({ ok: false, code: "account_mismatch" });
    // Asked once per process, and a mismatch is remembered.
    expect(fresh.calls.map((c) => c.op)).toEqual(["account"]);
  });

  it("an account that cannot be verified is unknown with sent:false, and is asked again next time", async () => {
    const s = setup();
    const { pi } = await held(s);
    const fresh = new FakeStripe(() => NOW);
    fresh.intents.set(pi, s.client.intents.get(pi)!);
    for (const [k, v] of s.client.charges) fresh.charges.set(k, v);
    for (const [k, v] of s.client.sessions) fresh.sessions.set(k, v);
    const gw = new StripeGateway({ config: testConfig(), client: fresh, now: () => NOW });
    fresh.fail("account", stripeError.connection("ECONNRESET"));
    expect(await gw.getPayment(pi)).toEqual({ kind: "unknown", sent: false, reason: "account_unverified" });
    fresh.fail("account", stripeError.api(503));
    expect(await gw.capture(pi, 10_000n, "capture:p1")).toEqual({ kind: "unknown", sent: false, reason: "account_unverified" });
    expect(fresh.callsOf("pi.capture")).toHaveLength(0);
    // createSession cannot know whether to retry: it throws, and the checkout retries with the same key.
    fresh.fail("account", stripeError.connection());
    await expect(gw.createSession(input())).rejects.toThrow(/account could not be verified/);
    expect(fresh.callsOf("sessions.create")).toHaveLength(0);
    expect(await gw.getPayment(pi)).toMatchObject({ kind: "ok" });
    expect(fresh.callsOf("account")).toHaveLength(4);
    await gw.getPayment(pi);
    expect(fresh.callsOf("account")).toHaveLength(4);
  });
});

describe("case 4: idempotency", () => {
  it("sends the caller's key as Idempotency-Key on createSession, capture, void, refund and expireSession", async () => {
    const s = setup();
    const ses = await session(s, { idempotencyKey: "pay:order-a1:7" });
    expect(s.client.callsOf("sessions.create")[0].options).toEqual({ idempotencyKey: "pay:order-a1:7" });
    // A repeat with the same key returns the same session (Stripe replays the first answer).
    expect((await session(s, { idempotencyKey: "pay:order-a1:7" })).sessionId).toBe(ses.sessionId);
    expect(s.client.sessions.size).toBe(1);

    const pi = s.client.pay(ses.providerOrderId);
    await s.gw.capture(pi, 10_000n, "capture:p1");
    expect(s.client.callsOf("pi.capture")[0].options).toEqual({ idempotencyKey: "capture:p1" });
    await s.gw.refund(pi, 1_000n, "refund:r1");
    expect(s.client.callsOf("refunds.create")[0].options).toEqual({ idempotencyKey: "refund:r1" });

    const other = await held(s, {}, { idempotencyKey: "pay:order-b:1" });
    await s.gw.void(other.pi, "void:p2");
    expect(s.client.callsOf("pi.cancel")[0].options).toEqual({ idempotencyKey: "void:p2" });

    const open = await session(s, { idempotencyKey: "pay:order-c:1" });
    await s.gw.expireSession(open.providerOrderId, "expire:p3");
    expect(s.client.callsOf("sessions.expire")[0].options).toEqual({ idempotencyKey: "expire:p3" });
  });

  it("a lost capture answer retried with the same key captures once", async () => {
    const s = setup();
    const { pi } = await held(s);
    s.client.fail("pi.capture", stripeError.connection("ETIMEDOUT"), { applied: true });
    expect(await s.gw.capture(pi, 10_000n, "capture:p1")).toEqual({ kind: "unknown", sent: true, reason: "timeout" });
    expect(await s.gw.capture(pi, 10_000n, "capture:p1")).toMatchObject({ kind: "ok", payment: { status: "captured", capturedMinor: 10_000n } });
    expect(s.client.charges.get(s.client.intents.get(pi)!.latest_charge as string)!.amount_captured).toBe(10_000);
  });

  it("refuses an empty or oversized key before calling Stripe", async () => {
    const s = setup();
    expect(await s.gw.createSession(input({ idempotencyKey: "" }))).toEqual({ ok: false, code: "idempotency_key_invalid" });
    expect(await s.gw.createSession(input({ idempotencyKey: "k".repeat(256) }))).toEqual({ ok: false, code: "idempotency_key_invalid" });
    expect(await s.gw.refund("pi_PLACEHOLDER0001", 1_000n, "")).toEqual({ kind: "failed", definite: true, code: "idempotency_key_invalid" });
    expect(await s.gw.expireSession("cs_test_PLACEHOLDER0001", "")).toEqual({ kind: "failed", definite: true, code: "idempotency_key_invalid" });
    expect(s.client.calls).toHaveLength(0);
  });
});

describe("case 5: error classification", () => {
  it("card and invalid-request errors are definite and carry their code", () => {
    expect(classifyStripeError(stripeError.card("card_declined"))).toEqual({ kind: "failed", definite: true, code: "card_declined" });
    expect(classifyStripeError(stripeError.card("expired_card"))).toEqual({ kind: "failed", definite: true, code: "expired_card" });
    const noCode = Object.assign(stripeError.card(), { code: undefined, decline_code: "insufficient_funds" });
    expect(classifyStripeError(noCode)).toEqual({ kind: "failed", definite: true, code: "insufficient_funds" });
    expect(classifyStripeError(stripeError.invalid("resource_missing", 404))).toEqual({ kind: "failed", definite: true, code: "resource_missing" });
    expect(classifyStripeError(stripeError.invalid("amount_too_small"))).toEqual({ kind: "failed", definite: true, code: "amount_too_small" });
    expect(classifyStripeError(stripeError.invalid("x".repeat(100))).kind === "failed" && (classifyStripeError(stripeError.invalid("x".repeat(100))) as { code: string }).code.length).toBe(64);
  });

  it("connection, timeout, 5xx, 429, 409, idempotency, authentication and permission errors are unknown", () => {
    const cases: Array<[Error, string]> = [
      [stripeError.connection(), "connection"],
      [stripeError.connection("ECONNRESET"), "connection"],
      [stripeError.connection("EPIPE"), "connection"],
      [stripeError.connection("ETIMEDOUT"), "timeout"],
      [stripeError.api(500), "provider_error"],
      [stripeError.api(502), "provider_error"],
      [stripeError.api(503), "provider_error"],
      [stripeError.rateLimit(), "rate_limited"],
      [stripeError.conflict(), "conflict"],
      [stripeError.idempotency(), "idempotency_conflict"],
      [stripeError.auth(), "authentication"],
      [stripeError.permission(), "permission"],
      [new Error("not a Stripe error"), "unexpected_error"],
    ];
    for (const [e, reason] of cases) expect(classifyStripeError(e), reason).toEqual({ kind: "unknown", sent: true, reason });
  });

  it("sent:false only when the request certainly never left: DNS failure or a refused connection", () => {
    for (const code of ["ENOTFOUND", "ECONNREFUSED"]) expect(classifyStripeError(stripeError.connection(code))).toEqual({ kind: "unknown", sent: false, reason: "connection" });
    // Also never sent: a temporary DNS failure and an unusable URL fail before any connection.
    for (const code of ["EAI_AGAIN", "ERR_INVALID_URL"]) expect(classifyStripeError(stripeError.connection(code))).toMatchObject({ sent: false });
    for (const code of ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNABORTED", "EHOSTUNREACH"]) expect(classifyStripeError(stripeError.connection(code))).toMatchObject({ kind: "unknown", sent: true });
  });

  it("operations return the classification; createSession throws on an unknown outcome", async () => {
    const s = setup();
    const { pi } = await held(s);
    s.client.fail("pi.capture", stripeError.card("card_declined"));
    expect(await s.gw.capture(pi, 10_000n, "capture:p1")).toEqual({ kind: "failed", definite: true, code: "card_declined" });
    s.client.fail("pi.capture", stripeError.api(500));
    expect(await s.gw.capture(pi, 10_000n, "capture:p1")).toEqual({ kind: "unknown", sent: true, reason: "provider_error" });
    s.client.fail("pi.cancel", stripeError.connection("ENOTFOUND"));
    expect(await s.gw.void(pi, "void:p1")).toEqual({ kind: "unknown", sent: false, reason: "connection" });
    s.client.fail("pi.retrieve", stripeError.rateLimit());
    expect(await s.gw.getPayment(pi)).toEqual({ kind: "unknown", sent: true, reason: "rate_limited" });

    for (const e of [stripeError.connection(), stripeError.connection("ETIMEDOUT"), stripeError.api(500), stripeError.rateLimit(), stripeError.conflict(), stripeError.idempotency(), stripeError.auth(), stripeError.permission()]) {
      s.client.fail("sessions.create", e);
      await expect(s.gw.createSession(input({ idempotencyKey: "pay:retry" }))).rejects.toThrow(/stripe: createSession/);
    }
    s.client.fail("sessions.create", stripeError.invalid("parameter_invalid_integer"));
    expect(await s.gw.createSession(input({ idempotencyKey: "pay:definite" }))).toEqual({ ok: false, code: "parameter_invalid_integer" });
  });
});

describe("case 6: status mapping", () => {
  it("requires_capture is authorized; succeeded is captured, partially_refunded or refunded", async () => {
    const s = setup();
    const { pi } = await held(s);
    expect(await snap(s, pi)).toMatchObject({ status: "authorized", capturedMinor: 0n, refundedMinor: 0n });
    expect(await s.gw.capture(pi, 10_000n, "capture:p1")).toMatchObject({ kind: "ok", payment: { status: "captured", capturedMinor: 10_000n, refundedMinor: 0n } });
    await s.gw.refund(pi, 4_000n, "refund:r1");
    expect(await snap(s, pi)).toMatchObject({ status: "partially_refunded", capturedMinor: 10_000n, refundedMinor: 4_000n });
    await s.gw.refund(pi, 6_000n, "refund:r2");
    expect(await snap(s, pi)).toMatchObject({ status: "refunded", refundedMinor: 10_000n });
  });

  it("canceled with reason expired is expired; any other reason is voided", async () => {
    const s = setup();
    const { pi } = await held(s);
    const v = await s.gw.void(pi, "void:p1");
    expect(v).toMatchObject({ kind: "ok", payment: { status: "voided" } });
    for (const reason of [null, "requested_by_customer", "abandoned", "duplicate", "fraudulent", "automatic", "failed_invoice"]) {
      s.client.tamper("pi.retrieve", (o) => ({ ...o, cancellation_reason: reason }));
      expect((await snap(s, pi)).status, String(reason)).toBe("voided");
    }
    s.client.tamper("pi.retrieve", (o) => ({ ...o, cancellation_reason: "expired" }));
    expect((await snap(s, pi)).status).toBe("expired");
  });

  it("a released hold reports nothing captured and nothing refunded (Stripe refunds the uncaptured amount)", async () => {
    const s = setup();
    const { pi } = await held(s);
    const v = await s.gw.void(pi, "void:p1");
    // The charge now says amount_refunded = amount: that is the hold released, not money refunded.
    expect(s.client.charges.get(s.client.intents.get(pi)!.latest_charge as string)).toMatchObject({ amount_refunded: 10_000, amount_captured: 0 });
    expect(v).toMatchObject({ kind: "ok", payment: { status: "voided", capturedMinor: 0n, refundedMinor: 0n } });
    expect(await snap(s, pi)).toMatchObject({ status: "voided", capturedMinor: 0n, refundedMinor: 0n });
    // A hold Stripe let lapse is reported the same way.
    s.client.tamper("pi.retrieve", (o) => ({ ...o, cancellation_reason: "expired" }));
    expect(await snap(s, pi)).toMatchObject({ status: "expired", capturedMinor: 0n, refundedMinor: 0n });
  });

  it("a partial capture reports the captured part; the released rest is not a refund", async () => {
    const s = setup();
    const { pi } = await held(s);
    expect(await s.gw.capture(pi, 6_000n, "capture:p1")).toMatchObject({ kind: "ok", payment: { status: "captured", capturedMinor: 6_000n, refundedMinor: 0n } });
    await s.gw.refund(pi, 1_000n, "refund:r1");
    expect(await snap(s, pi)).toMatchObject({ status: "partially_refunded", capturedMinor: 6_000n, refundedMinor: 1_000n });
    await s.gw.refund(pi, 5_000n, "refund:r2");
    expect(await snap(s, pi)).toMatchObject({ status: "refunded", capturedMinor: 6_000n, refundedMinor: 6_000n });
  });

  it("requires_payment_method is failed with an error and requires_action without; processing and confirmation wait", async () => {
    const s = setup();
    const ses = await session(s);
    const declined = s.client.pay(ses.providerOrderId, { decline: true });
    expect(await snap(s, declined)).toMatchObject({ status: "failed", capturedMinor: 0n, authorizedAt: null });
    s.client.tamper("pi.retrieve", (o) => ({ ...o, last_payment_error: null }));
    expect((await snap(s, declined)).status).toBe("requires_action");
    for (const status of ["processing", "requires_confirmation", "requires_action"]) {
      s.client.tamper("pi.retrieve", (o) => ({ ...o, status }));
      expect((await snap(s, declined)).status, status).toBe("requires_action");
    }
  });

  it("an unknown status, or a malformed PaymentIntent, is unknown", async () => {
    const s = setup();
    const { pi } = await held(s);
    for (const status of ["requires_reauthorization", "", null]) {
      s.client.tamper("pi.retrieve", (o) => ({ ...o, status }));
      expect(await s.gw.getPayment(pi), String(status)).toEqual({ kind: "unknown", sent: true, reason: "status_unrecognised" });
    }
    s.client.tamper("pi.retrieve", (o) => ({ ...o, object: "charge" }));
    expect(await s.gw.getPayment(pi)).toMatchObject({ kind: "unknown", reason: "not_a_payment_intent" });
    s.client.tamper("pi.retrieve", (o) => ({ ...o, livemode: true }));
    expect(await s.gw.getPayment(pi)).toMatchObject({ kind: "unknown", reason: "livemode_mismatch" });
    s.client.tamper("pi.retrieve", (o) => ({ ...o, latest_charge: { ...(o.latest_charge as object), livemode: true } }));
    expect(await s.gw.getPayment(pi)).toMatchObject({ kind: "unknown", reason: "livemode_mismatch" });
    s.client.tamper("pi.retrieve", (o) => ({ ...o, latest_charge: (o.latest_charge as { id: string }).id }));
    expect(await s.gw.getPayment(pi)).toMatchObject({ kind: "unknown", reason: "charge_not_expanded" });
    s.client.tamper("pi.retrieve", (o) => ({ ...o, latest_charge: { ...(o.latest_charge as object), payment_intent: "pi_PLACEHOLDEROTHER" } }));
    expect(await s.gw.getPayment(pi)).toMatchObject({ kind: "unknown", reason: "charge_mismatch" });
    expect(await s.gw.getPayment("ch_notapaymentintent")).toEqual({ kind: "failed", definite: true, code: "payment_not_found" });
  });

  it("reports the Checkout Session as the provider order", async () => {
    const s = setup();
    const { ses, pi } = await held(s);
    expect((await snap(s, pi)).providerOrderId).toBe(ses.providerOrderId);
    expect(await s.gw.listPaymentsForOrder(ses.providerOrderId)).toMatchObject({ ok: true, payments: [{ providerPaymentId: pi, providerOrderId: ses.providerOrderId, status: "authorized" }] });
    const unpaid = await session(s, { idempotencyKey: "pay:unpaid" });
    expect(await s.gw.listPaymentsForOrder(unpaid.providerOrderId)).toEqual({ ok: true, payments: [] });
    s.client.tamper("sessions.retrieve", (o) => ({ ...o, payment_intent: pi }));
    expect(await s.gw.listPaymentsForOrder(ses.providerOrderId)).toEqual({ ok: false, reason: "payment_intent_not_expanded" });
    s.client.tamper("sessions.retrieve", (o) => ({ ...o, livemode: true }));
    expect(await s.gw.listPaymentsForOrder(ses.providerOrderId)).toEqual({ ok: false, reason: "session_mismatch" });
  });
});

describe("case 7: 3DS and risk", () => {
  async function read(pay: PayOptions) {
    const s = setup();
    const { pi } = await held(s, pay);
    return snap(s, pi);
  }

  it("only an authenticated result passes; absent or unrecognised values never become passed", async () => {
    expect((await read({ threeDs: "authenticated" })).threeDs).toBe("passed");
    expect((await read({ threeDs: "attempt_acknowledged" })).threeDs).toBe("passed");
    expect((await read({ threeDs: "failed" })).threeDs).toBe("failed");
    for (const threeDs of [null, "exempted", "not_supported", "processing_error", "", "AUTHENTICATED", "passed"]) {
      const t = (await read({ threeDs })).threeDs;
      expect(t, String(threeDs)).toBe("unknown");
      expect((RESERVE_REQUIRES.threeDs as readonly string[]).includes(t)).toBe(false);
    }
  });

  it("Apple Pay with no result is not_applicable; with failed it is failed", async () => {
    expect((await read({ wallet: "apple_pay", threeDs: null })).threeDs).toBe("not_applicable");
    expect((await read({ wallet: "apple_pay", threeDs: "failed" })).threeDs).toBe("failed");
    expect((await read({ wallet: "apple_pay", threeDs: "authenticated" })).threeDs).toBe("passed");
    expect((await read({ wallet: "apple_pay", threeDs: "exempted" })).threeDs).toBe("unknown");
  });

  it("Google Pay, Link or any other wallet with no result is unknown, so reserve is refused", async () => {
    for (const wallet of ["google_pay", "link", "samsung_pay", "masterpass", "visa_checkout", "amex_express_checkout"]) {
      const t = (await read({ wallet, threeDs: null })).threeDs;
      expect(t, wallet).toBe("unknown");
      expect((RESERVE_REQUIRES.threeDs as readonly string[]).includes(t)).toBe(false);
    }
  });

  it("risk passes Stripe's level through; anything else is unknown", async () => {
    for (const risk of ["normal", "elevated", "highest"] as const) expect((await read({ risk })).risk).toBe(risk);
    for (const risk of [null, "not_assessed", "unknown", "low", ""]) expect((await read({ risk })).risk, String(risk)).toBe("unknown");
  });

  it("the hold expiry comes from capture_before, with a 7-day fallback from the authorization", async () => {
    const at = new Date(NOW.getTime() - 5 * MIN);
    const cb = NOW_S + 3 * 86_400;
    const a = await read({ at, captureBefore: cb });
    expect(a).toMatchObject({ authorizedAt: at.toISOString(), authorizationExpiresAt: new Date(cb * 1000).toISOString() });
    const b = await read({ at, captureBefore: null });
    expect(b.authorizationExpiresAt).toBe(new Date(at.getTime() + CARD_AUTHORIZATION_LIFETIME_MS).toISOString());
    expect(CARD_AUTHORIZATION_LIFETIME_MS).toBe(7 * 86_400_000);
  });
});

describe("case 8: session expiry", () => {
  const expiresAtSent = (s: ReturnType<typeof setup>) => createParams(s).expires_at as number;

  it("a 10-minute quote asks Stripe for now + 31 minutes", async () => {
    const s = setup();
    const ses = await session(s);
    expect(CHECKOUT_REQUESTED_MIN_LIFETIME_MS).toBe(31 * MIN);
    expect(expiresAtSent(s)).toBe(Math.floor((NOW.getTime() + 31 * MIN) / 1000));
    // Reported is Stripe's own expiry, later than the quote's: the saga expires the session when the quote lapses.
    expect(ses.expiresAt).toBe(new Date(expiresAtSent(s) * 1000).toISOString());
  });

  it("a quote longer than 31 minutes asks for exactly the quote's expiry", async () => {
    const s = setup();
    const at = new Date(NOW.getTime() + 45 * MIN + 500);
    await session(s, { expiresAt: at.toISOString() });
    expect(expiresAtSent(s)).toBe(Math.floor(at.getTime() / 1000));
  });

  it("more than 24 hours is capped below Stripe's 24-hour limit", async () => {
    const s = setup();
    await session(s, { expiresAt: new Date(NOW.getTime() + 30 * 3600_000).toISOString() });
    const sent = expiresAtSent(s) * 1000;
    expect(sent).toBe(NOW.getTime() + CHECKOUT_MAX_LIFETIME_MS - CHECKOUT_CLOCK_MARGIN_MS);
    expect(sent).toBeLessThanOrEqual(NOW.getTime() + 24 * 3600_000);
  });

  it("reports Stripe's own expiry; an expiry not in the future is refused", async () => {
    const s = setup();
    s.client.tamper("sessions.create", (o) => ({ ...o, expires_at: NOW_S + 40 * 60 }));
    expect((await session(s, { idempotencyKey: "k1" })).expiresAt).toBe(new Date((NOW_S + 40 * 60) * 1000).toISOString());
    s.client.tamper("sessions.create", (o) => ({ ...o, expires_at: NOW_S - 1 }));
    expect(await s.gw.createSession(input({ idempotencyKey: "k2" }))).toEqual({ ok: false, code: "session_expiry_mismatch" });
    s.client.tamper("sessions.create", (o) => ({ ...o, expires_at: NOW_S }));
    expect(await s.gw.createSession(input({ idempotencyKey: "k3" }))).toEqual({ ok: false, code: "session_expiry_mismatch" });
    s.client.tamper("sessions.create", (o) => ({ ...o, expires_at: null }));
    expect(await s.gw.createSession(input({ idempotencyKey: "k4" }))).toEqual({ ok: false, code: "session_expiry_mismatch" });
  });

  it("refuses a quote expiry that has passed or cannot be read, before calling Stripe", async () => {
    const s = setup();
    for (const expiresAt of [NOW.toISOString(), new Date(NOW.getTime() - 1).toISOString(), "not a date", ""]) {
      expect(await s.gw.createSession(input({ expiresAt })), expiresAt).toEqual({ ok: false, code: "expires_at_invalid" });
    }
    expect(s.client.calls).toHaveLength(0);
  });
});

describe("case 9: expireSession", () => {
  it("an open session returns ok/expired", async () => {
    const s = setup();
    const ses = await session(s);
    expect(await s.gw.expireSession(ses.providerOrderId, "expire:p1")).toEqual({ kind: "ok", state: "expired" });
    expect(s.client.sessions.get(ses.providerOrderId)!.status).toBe("expired");
  });

  it("when Stripe refuses, the session is read back: expired is ok/expired, complete is ok/completed, open is the refusal", async () => {
    const s = setup();
    const ses = await session(s);
    await s.gw.expireSession(ses.providerOrderId, "expire:p1");
    // A second key (a new attempt) meets a session that is no longer open.
    expect(await s.gw.expireSession(ses.providerOrderId, "expire:p1:again")).toEqual({ kind: "ok", state: "expired" });
    expect(s.client.callsOf("sessions.retrieve")).toHaveLength(1);

    const paid = await held(s, {}, { idempotencyKey: "pay:paid" });
    expect(await s.gw.expireSession(paid.ses.providerOrderId, "expire:p2")).toEqual({ kind: "ok", state: "completed" });

    const open = await session(s, { idempotencyKey: "pay:open" });
    s.client.fail("sessions.expire", stripeError.invalid("parameter_unknown"));
    expect(await s.gw.expireSession(open.providerOrderId, "expire:p3")).toEqual({ kind: "failed", definite: true, code: "parameter_unknown" });
  });

  it("network and 5xx errors are unknown, on the expire or on the read back", async () => {
    const s = setup();
    const ses = await session(s);
    for (const e of [stripeError.connection(), stripeError.connection("ETIMEDOUT"), stripeError.api(500), stripeError.api(503), stripeError.rateLimit()]) {
      s.client.fail("sessions.expire", e);
      expect(await s.gw.expireSession(ses.providerOrderId, "expire:p1")).toMatchObject({ kind: "unknown", sent: true });
    }
    s.client.fail("sessions.expire", stripeError.notOpen()).fail("sessions.retrieve", stripeError.api(502));
    expect(await s.gw.expireSession(ses.providerOrderId, "expire:p1")).toEqual({ kind: "unknown", sent: true, reason: "provider_error" });
    // The read back refused too: the expire's own refusal is returned.
    s.client.fail("sessions.expire", stripeError.notOpen()).fail("sessions.retrieve", stripeError.invalid("resource_missing", 404));
    expect(await s.gw.expireSession(ses.providerOrderId, "expire:p1")).toEqual({ kind: "failed", definite: true, code: "checkout_session_not_open" });
    expect(s.client.sessions.get(ses.providerOrderId)!.status).toBe("open");
  });

  it("a livemode or account mismatch is unknown", async () => {
    const s = setup();
    const ses = await session(s);
    s.client.tamper("sessions.expire", (o) => ({ ...o, livemode: true }));
    expect(await s.gw.expireSession(ses.providerOrderId, "expire:p1")).toEqual({ kind: "unknown", sent: true, reason: "session_mismatch" });
    const other = await session(s, { idempotencyKey: "pay:other" });
    const third = await session(s, { idempotencyKey: "pay:third" });
    s.client.tamper("sessions.expire", (o) => ({ ...o, id: ses.providerOrderId }));
    expect(await s.gw.expireSession(other.providerOrderId, "expire:p2")).toEqual({ kind: "unknown", sent: true, reason: "session_mismatch" });
    s.client.fail("sessions.expire", stripeError.notOpen()).tamper("sessions.retrieve", (o) => ({ ...o, livemode: true, status: "complete" }));
    expect(await s.gw.expireSession(third.providerOrderId, "expire:p3")).toMatchObject({ kind: "unknown", reason: "session_mismatch" });
    s.client.tamper("sessions.expire", (o) => ({ ...o, status: "open" }));
    expect(await s.gw.expireSession(third.providerOrderId, "expire:p4")).toMatchObject({ kind: "unknown", reason: "session_status_unrecognised" });

    const mismatch = new FakeStripe(() => NOW);
    mismatch.accountId = OTHER_ACCOUNT_ID;
    const gw = new StripeGateway({ config: testConfig(), client: mismatch, now: () => NOW });
    expect(await gw.expireSession(ses.providerOrderId, "expire:p5")).toEqual({ kind: "unknown", sent: false, reason: "account_mismatch" });
    expect(mismatch.callsOf("sessions.expire")).toHaveLength(0);
  });

  it("refuses an id that is not a Checkout Session without calling Stripe", async () => {
    const s = setup();
    for (const id of ["pi_PLACEHOLDER", "cs_PLACEHOLDER", "cs_test_../x", ""]) expect(await s.gw.expireSession(id, "expire:p1"), id).toEqual({ kind: "failed", definite: true, code: "order_not_found" });
    expect(s.client.calls).toHaveLength(0);
  });
});

describe("case 10: refunds", () => {
  async function captured(s: ReturnType<typeof setup>) {
    const { pi } = await held(s);
    await s.gw.capture(pi, 10_000n, "capture:p1");
    return pi;
  }

  it("the refund reference round-trips; a dashboard refund has none", async () => {
    const s = setup();
    const pi = await captured(s);
    const r = await s.gw.refund(pi, 2_500n, "refund:00000000-0000-7000-8000-0000000000r1");
    expect(r).toMatchObject({ kind: "accepted", providerRefundId: expect.stringMatching(/^re_/) });
    expect(s.client.callsOf("refunds.create")[0].params).toEqual({ payment_intent: pi, amount: 2_500, metadata: { [REFUND_REFERENCE_KEY]: "refund:00000000-0000-7000-8000-0000000000r1" } });
    const dash = s.client.dashboardRefund(pi, 500);
    expect(await s.gw.listRefunds(pi)).toEqual({
      ok: true,
      refunds: [
        { providerRefundId: (r as { providerRefundId: string }).providerRefundId, reference: "refund:00000000-0000-7000-8000-0000000000r1", amountMinor: 2_500n, status: "succeeded" },
        { providerRefundId: dash, reference: null, amountMinor: 500n, status: "succeeded" },
      ],
    });
    expect(await s.gw.getRefund((r as { providerRefundId: string }).providerRefundId)).toEqual({ status: "succeeded", amountMinor: 2_500n });
  });

  it("refund answers that do not match the request are unknown", async () => {
    const s = setup();
    const pi = await captured(s);
    s.client.tamper("refunds.create", (o) => ({ ...o, amount: 999 }));
    expect(await s.gw.refund(pi, 1_000n, "refund:r1")).toEqual({ kind: "unknown", sent: true, reason: "refund_amount_mismatch" });
    s.client.tamper("refunds.create", (o) => ({ ...o, payment_intent: "pi_PLACEHOLDEROTHER" }));
    expect(await s.gw.refund(pi, 1_000n, "refund:r2")).toEqual({ kind: "unknown", sent: true, reason: "refund_mismatch" });
    s.client.fail("refunds.create", stripeError.invalid("charge_already_refunded"));
    expect(await s.gw.refund(pi, 1_000n, "refund:r3")).toEqual({ kind: "failed", definite: true, code: "charge_already_refunded" });
  });

  it("listRefunds paginates to completion", async () => {
    const s = setup();
    const pi = await captured(s);
    for (let i = 0; i < 250; i++) s.client.dashboardRefund(pi, 1);
    const r = await s.gw.listRefunds(pi);
    expect(r.ok && r.refunds.length).toBe(250);
    expect(r.ok && new Set(r.refunds.map((x) => x.providerRefundId)).size).toBe(250);
    const pages = s.client.callsOf("refunds.list");
    expect(pages.map((c) => c.params?.starting_after ?? null)).toEqual([null, expect.stringMatching(/^re_/), expect.stringMatching(/^re_/)]);
    expect(pages.every((c) => c.params?.limit === 100 && c.params?.payment_intent === pi)).toBe(true);
  });

  it("has_more with an empty page, a repeated id, a foreign refund or the 50-page cap is ok:false", async () => {
    const s = setup();
    const pi = await captured(s);
    s.client.dashboardRefund(pi, 100);
    s.client.tamper("refunds.list", (o) => ({ ...o, data: [], has_more: true }));
    expect(await s.gw.listRefunds(pi)).toEqual({ ok: false, reason: "pagination_stalled" });

    s.client.tamper("refunds.list", (o) => ({ ...o, data: [...(o.data as object[]), ...(o.data as object[])] }));
    expect(await s.gw.listRefunds(pi)).toEqual({ ok: false, reason: "pagination_repeated" });
    // The repeat on the next page (a cursor that went back).
    let first: object[] = [];
    s.client.tamper("refunds.list", (o) => ((first = o.data as object[]), { ...o, has_more: true })).tamper("refunds.list", (o) => ({ ...o, data: first, has_more: false }));
    expect(await s.gw.listRefunds(pi)).toEqual({ ok: false, reason: "pagination_repeated" });

    s.client.tamper("refunds.list", (o) => ({ ...o, data: (o.data as object[]).map((r) => ({ ...r, payment_intent: "pi_PLACEHOLDEROTHER" })) }));
    expect(await s.gw.listRefunds(pi)).toEqual({ ok: false, reason: "refund_mismatch" });

    const calls = s.client.callsOf("refunds.list").length;
    for (let page = 0; page < 51; page++) {
      s.client.tamper("refunds.list", () => ({ object: "list", has_more: true, data: [{ id: `re_PLACEHOLDERPAGE${page}`, object: "refund", amount: 1, currency: "aed", payment_intent: pi, status: "succeeded", metadata: {} }] }));
    }
    expect(await s.gw.listRefunds(pi)).toEqual({ ok: false, reason: "too_many_refunds" });
    expect(s.client.callsOf("refunds.list").length - calls).toBe(50);
  });

  it("refund statuses map to pending, succeeded or failed", async () => {
    const s = setup();
    const pi = await captured(s);
    s.client.refundStatus = "pending";
    const r = (await s.gw.refund(pi, 1_000n, "refund:r1")) as { providerRefundId: string };
    expect(await s.gw.getRefund(r.providerRefundId)).toEqual({ status: "pending", amountMinor: 1_000n });
    for (const [status, mapped] of [["requires_action", "pending"], ["succeeded", "succeeded"], ["failed", "failed"], ["canceled", "failed"]] as const) {
      s.client.tamper("refunds.retrieve", (o) => ({ ...o, status }));
      expect(await s.gw.getRefund(r.providerRefundId), status).toEqual({ status: mapped, amountMinor: 1_000n });
    }
    s.client.tamper("refunds.retrieve", (o) => ({ ...o, id: "re_PLACEHOLDEROTHER" }));
    expect(await s.gw.getRefund(r.providerRefundId)).toEqual({ status: "unknown", reason: "refund_mismatch" });
    expect(await s.gw.getRefund("pi_notarefund")).toEqual({ status: "unknown", reason: "refund_not_found" });
  });
});

describe("case 13: createSession inputs", () => {
  it("refuses any method other than card, and capabilities() throws for one", async () => {
    const s = setup();
    for (const method of ["upi", "netbanking", "link", "apple_pay", "google_pay", "wallet", "Card", ""]) {
      expect(await s.gw.createSession(input({ method })), method).toEqual({ ok: false, code: "method_not_supported" });
      expect(() => s.gw.capabilities(method)).toThrow(StripeUnsupportedMethodError);
    }
    expect(s.client.calls).toHaveLength(0);
    expect(s.gw.capabilities("card")).toEqual({
      authorization: "hold",
      release: "void",
      authorizationLifetimeMs: CARD_AUTHORIZATION_LIFETIME_MS,
      partialCapture: true,
      multipleCapture: false,
      webhookSigned: true,
      webhookSignedTimestamp: true,
    });
  });

  it("refuses a return URL that is not https (http to localhost only in test mode)", async () => {
    const s = setup();
    for (const returnUrl of ["http://outly.example/checkout/return", "javascript:alert(1)", "ftp://outly.example/r", "data:text/html,x", "not a url", "", "//outly.example/r", "http://localhost.evil.example/r", "http://10.0.0.1/r"]) {
      expect(await s.gw.createSession(input({ returnUrl })), returnUrl).toEqual({ ok: false, code: "return_url_invalid" });
    }
    expect(s.client.calls).toHaveLength(0);
    expect((await s.gw.createSession(input({ returnUrl: "http://localhost:3000/checkout/return", idempotencyKey: "k1" }))).ok).toBe(true);
    expect((await s.gw.createSession(input({ returnUrl: "http://127.0.0.1:3000/checkout/return", idempotencyKey: "k2" }))).ok).toBe(true);

    const live = new StripeGateway({ config: liveConfig(), client: Object.assign(new FakeStripe(() => NOW), { live: true }), now: () => NOW });
    expect(await live.createSession(input({ returnUrl: "http://localhost:3000/checkout/return" }))).toEqual({ ok: false, code: "return_url_invalid" });
    expect((await live.createSession(input())).ok).toBe(true);
  });

  it("asks for a card-only hosted page with manual capture; metadata holds only the three ids", async () => {
    const s = setup();
    await session(s);
    const p = createParams(s);
    const ids = { orderId: ORDER, quoteId: QUOTE, idempotencyKey: "pay:order-a1:1" };
    expect(Object.keys(p).sort()).toEqual(
      ["adaptive_pricing", "allowed_payment_method_types", "cancel_url", "client_reference_id", "expires_at", "line_items", "metadata", "mode", "payment_intent_data", "payment_method_options", "success_url"].sort(),
    );
    expect(p).toMatchObject({
      mode: "payment",
      allowed_payment_method_types: ["card"],
      adaptive_pricing: { enabled: false },
      payment_method_options: { card: { request_three_d_secure: "any" } },
      payment_intent_data: { capture_method: "manual", metadata: ids },
      client_reference_id: ORDER,
      metadata: ids,
      // Distinct, and only a wording hint apart (CO-08): no reference, session id or contact in either.
      success_url: "https://outly.example/checkout/return?result=success",
      cancel_url: "https://outly.example/checkout/return?result=cancel",
    });
    expect(Object.keys(p.payment_intent_data)).toEqual(["capture_method", "metadata"]);
    expect(p.metadata).toEqual(ids);
    expect(p.payment_intent_data.metadata).toEqual(ids);
  });
});
