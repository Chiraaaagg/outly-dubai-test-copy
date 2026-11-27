import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StripeGateway, STRIPE_WEBHOOK_TOLERANCE_S } from "../stripe/stripe-gateway";
import { ACCOUNT_ID, FakeStripe, liveConfig, OTHER_ACCOUNT_ID, OTHER_WEBHOOK_SECRET, signed, stripeEvent, testConfig, WEBHOOK_SECRET } from "./_stripe-fake";

/**
 * Stripe webhook verification (doc 27 §1 case 1). Headers are built with the
 * SDK's `generateTestHeaderString`; the gateway's client is a fake that is
 * never called. Placeholder secrets only.
 */

const NOW = new Date("2030-01-10T08:00:00Z");
const T = Math.floor(NOW.getTime() / 1000);
const PI = "pi_PLACEHOLDER0000000000000001";

function gateway(over: Parameters<typeof testConfig>[0] = {}, now: () => Date = () => NOW) {
  const client = new FakeStripe(now);
  return { gw: new StripeGateway({ config: testConfig(over), client, now }), client };
}

function piEvent(type = "payment_intent.amount_capturable_updated", over: Record<string, unknown> = {}) {
  return stripeEvent(type, { id: PI, object: "payment_intent" }, { created: T, ...over });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Stripe webhook signature", () => {
  it("accepts a body signed by the SDK helper and names the payment; never calls Stripe", () => {
    const { gw, client } = gateway();
    const ev = piEvent();
    const w = signed(ev, { timestamp: T });
    expect(gw.verifyWebhook(w.raw, w.headers)).toEqual({ providerEventId: ev.id, type: "payment_intent.amount_capturable_updated", providerPaymentId: PI, occurredAt: NOW.toISOString() });
    expect(client.calls).toHaveLength(0);
  });

  it("refuses a tampered body, a wrong secret, a stale or future timestamp", () => {
    const { gw } = gateway();
    const w = signed(piEvent(), { timestamp: T });
    const tampered = new Uint8Array(w.raw);
    tampered[tampered.length - 2] ^= 1;
    expect(gw.verifyWebhook(tampered, w.headers)).toBeNull();
    // One byte appended (a trailing newline a proxy might add).
    expect(gw.verifyWebhook(new Uint8Array([...w.raw, 0x0a]), w.headers)).toBeNull();

    const wrong = signed(piEvent(), { timestamp: T, secret: OTHER_WEBHOOK_SECRET });
    expect(gw.verifyWebhook(wrong.raw, wrong.headers)).toBeNull();

    for (const skew of [-(STRIPE_WEBHOOK_TOLERANCE_S + 1), STRIPE_WEBHOOK_TOLERANCE_S + 1, -86_400, 86_400]) {
      const s = signed(piEvent(), { timestamp: T + skew });
      expect(gw.verifyWebhook(s.raw, s.headers), `skew ${skew}`).toBeNull();
    }
    for (const skew of [-STRIPE_WEBHOOK_TOLERANCE_S, STRIPE_WEBHOOK_TOLERANCE_S]) {
      const s = signed(piEvent(), { timestamp: T + skew });
      expect(gw.verifyWebhook(s.raw, s.headers), `skew ${skew}`).not.toBeNull();
    }
    // The signed timestamp moved by one second: the signature no longer matches.
    const moved = new Headers({ "stripe-signature": w.header.replace(`t=${T}`, `t=${T + 1}`) });
    expect(gw.verifyWebhook(w.raw, moved)).toBeNull();
  });

  it("refuses a missing or malformed header", () => {
    const { gw } = gateway();
    const w = signed(piEvent(), { timestamp: T });
    const sig = w.header.split("v1=")[1];
    const bad = [
      "",
      "garbage",
      `v1=${sig}`,
      `t=${T}`,
      `t=,v1=${sig}`,
      `t=abc,v1=${sig}`,
      `t=-${T},v1=${sig}`,
      `t=${T}.5,v1=${sig}`,
      `t=1234567890123,v1=${sig}`,
      `t=${T},v1=${sig.toUpperCase()}`,
      `t=${T},v1=${sig.slice(1)}`,
      `t=${T},v0=${sig}`,
      `t=${T},v1=${sig}${"0".repeat(4096)}`,
    ];
    expect(gw.verifyWebhook(w.raw, new Headers())).toBeNull();
    for (const h of bad) expect(gw.verifyWebhook(w.raw, new Headers({ "stripe-signature": h })), h).toBeNull();
    // Whitespace around the parts, as some proxies fold headers, is tolerated.
    expect(gw.verifyWebhook(w.raw, new Headers({ "stripe-signature": `t=${T}, v1=${sig}` }))).not.toBeNull();
  });

  it("header parsing: a duplicate t is refused; several v1 entries (secret rotation) match any one", () => {
    const { gw } = gateway();
    const ev = piEvent();
    const w = signed(ev, { timestamp: T });
    const sig = w.header.split("v1=")[1];
    expect(gw.verifyWebhook(w.raw, new Headers({ "stripe-signature": `t=${T},t=${T},v1=${sig}` }))).toBeNull();
    expect(gw.verifyWebhook(w.raw, new Headers({ "stripe-signature": `t=${T},v1=${sig},t=${T - 1}` }))).toBeNull();

    // During a rotation Stripe signs with the old and the new secret.
    const old = signed(ev, { timestamp: T, secret: OTHER_WEBHOOK_SECRET }).header.split("v1=")[1];
    expect(gw.verifyWebhook(w.raw, new Headers({ "stripe-signature": `t=${T},v1=${old},v1=${sig}` }))).not.toBeNull();
    expect(gw.verifyWebhook(w.raw, new Headers({ "stripe-signature": `t=${T},v1=${sig},v1=${old}` }))).not.toBeNull();
    // Unknown schemes beside a valid v1 are ignored, as Stripe documents.
    expect(gw.verifyWebhook(w.raw, new Headers({ "stripe-signature": `t=${T},v0=${old},v1=${sig}` }))).not.toBeNull();
    // Only the old secret's signature: refused.
    expect(gw.verifyWebhook(w.raw, new Headers({ "stripe-signature": `t=${T},v1=${old}` }))).toBeNull();
    // More than eight v1 entries is not a rotation: refused even with the right one among them.
    expect(gw.verifyWebhook(w.raw, new Headers({ "stripe-signature": `t=${T},${Array(8).fill(`v1=${old}`).join(",")},v1=${sig}` }))).toBeNull();
  });

  it("refuses a correctly signed body that is not valid UTF-8", () => {
    const { gw } = gateway();
    // Two invalid bytes inside a string value: a lenient decoder would turn them into U+FFFD and parse valid JSON.
    const text = JSON.stringify({ ...piEvent(), note: "XY" });
    const at = text.indexOf("XY");
    const raw = new Uint8Array([...new TextEncoder().encode(text.slice(0, at)), 0xff, 0xfe, ...new TextEncoder().encode(text.slice(at + 2))]);
    expect(JSON.parse(new TextDecoder().decode(raw)).note).toBe("��");
    const sig = createHmac("sha256", WEBHOOK_SECRET).update(`${T}.`).update(raw).digest("hex");
    expect(gw.verifyWebhook(raw, new Headers({ "stripe-signature": `t=${T},v1=${sig}` }))).toBeNull();
    // The same construction over valid bytes verifies, so the refusal is the encoding.
    const ok = new TextEncoder().encode(text);
    const okSig = createHmac("sha256", WEBHOOK_SECRET).update(`${T}.`).update(ok).digest("hex");
    expect(gw.verifyWebhook(ok, new Headers({ "stripe-signature": `t=${T},v1=${okSig}` }))).not.toBeNull();
  });

  it("verifies over the exact bytes of a view into a larger buffer", () => {
    const { gw } = gateway();
    const w = signed(piEvent(), { timestamp: T });
    const big = new Uint8Array(w.raw.length + 20);
    big.set(w.raw, 10);
    expect(gw.verifyWebhook(big.subarray(10, 10 + w.raw.length), w.headers)).not.toBeNull();
  });

  it("never JSON.parses a body before its signature matched", () => {
    const { gw } = gateway();
    const ev = piEvent();
    const good = signed(ev, { timestamp: T });
    const wrong = signed(ev, { timestamp: T, secret: OTHER_WEBHOOK_SECRET });
    const stale = signed(ev, { timestamp: T - 3600 });
    const tampered = new Uint8Array(good.raw);
    tampered[3] ^= 1;
    const spy = vi.spyOn(JSON, "parse");
    expect(gw.verifyWebhook(wrong.raw, wrong.headers)).toBeNull();
    expect(gw.verifyWebhook(stale.raw, stale.headers)).toBeNull();
    expect(gw.verifyWebhook(tampered, good.headers)).toBeNull();
    expect(gw.verifyWebhook(new TextEncoder().encode("{not json"), new Headers({ "stripe-signature": `t=${T},v1=${"0".repeat(64)}` }))).toBeNull();
    expect(gw.verifyWebhook(good.raw, new Headers())).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(gw.verifyWebhook(good.raw, good.headers)).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refuses an authentic body that is not an event", () => {
    const { gw } = gateway();
    for (const body of ["[]", "null", "\"evt\"", "{not json", JSON.stringify({ ...piEvent(), id: "ev_wrongprefix" }), JSON.stringify({ ...piEvent(), id: 7 }), JSON.stringify({ ...piEvent(), type: "" }), JSON.stringify({ ...piEvent(), type: "x".repeat(101) })]) {
      const w = signed(body, { timestamp: T });
      expect(gw.verifyWebhook(w.raw, w.headers), body.slice(0, 40)).toBeNull();
    }
  });

  it("refuses an event from the other mode or another account", () => {
    const test = gateway().gw;
    const live = new StripeGateway({ config: liveConfig(), client: new FakeStripe(() => NOW), now: () => NOW });
    const liveEv = signed(piEvent(undefined, { livemode: true }), { timestamp: T });
    const testEv = signed(piEvent(undefined, { livemode: false }), { timestamp: T });
    expect(test.verifyWebhook(liveEv.raw, liveEv.headers)).toBeNull();
    expect(live.verifyWebhook(testEv.raw, testEv.headers)).toBeNull();
    expect(live.verifyWebhook(liveEv.raw, liveEv.headers)).not.toBeNull();
    const noMode = signed(piEvent(undefined, { livemode: undefined }), { timestamp: T });
    expect(test.verifyWebhook(noMode.raw, noMode.headers)).toBeNull();

    const foreign = signed(piEvent(undefined, { account: OTHER_ACCOUNT_ID }), { timestamp: T });
    expect(test.verifyWebhook(foreign.raw, foreign.headers)).toBeNull();
    const own = signed(piEvent(undefined, { account: ACCOUNT_ID }), { timestamp: T });
    expect(test.verifyWebhook(own.raw, own.headers)).not.toBeNull();
    const bogus = signed(piEvent(undefined, { account: 42 }), { timestamp: T });
    expect(test.verifyWebhook(bogus.raw, bogus.headers)).toBeNull();
  });
});

describe("Stripe webhook event mapping", () => {
  const { gw } = gateway();
  const verify = (type: string, object: Record<string, unknown> | null) => {
    const ev = stripeEvent(type, object as Record<string, unknown>, { created: T });
    const w = signed(ev, { timestamp: T });
    const r = gw.verifyWebhook(w.raw, w.headers);
    expect(r, type).not.toBeNull();
    return r!;
  };

  it("names the PaymentIntent for every subscribed type", () => {
    for (const type of ["checkout.session.completed", "checkout.session.expired"]) {
      expect(verify(type, { id: "cs_test_PLACEHOLDER", object: "checkout.session", payment_intent: PI })).toMatchObject({ type, providerPaymentId: PI });
      expect(verify(type, { id: "cs_test_PLACEHOLDER", object: "checkout.session", payment_intent: { id: PI, object: "payment_intent" } })).toMatchObject({ providerPaymentId: PI });
    }
    // A session that closed unpaid has no PaymentIntent.
    expect(verify("checkout.session.expired", { id: "cs_test_PLACEHOLDER", object: "checkout.session", payment_intent: null }).providerPaymentId).toBeNull();
    for (const type of ["payment_intent.amount_capturable_updated", "payment_intent.succeeded", "payment_intent.canceled", "payment_intent.payment_failed"]) {
      expect(verify(type, { id: PI, object: "payment_intent" })).toEqual({ providerEventId: expect.stringMatching(/^evt_/), type, providerPaymentId: PI, occurredAt: NOW.toISOString() });
    }
    for (const type of ["charge.refund.updated", "refund.created", "refund.updated", "refund.failed"]) {
      expect(verify(type, { id: "re_PLACEHOLDER", object: "refund", payment_intent: PI })).toMatchObject({ type, providerPaymentId: PI });
    }
  });

  it("renames charge.dispute.* to dispute.* so the saga's dispute handling sees it", () => {
    for (const suffix of ["created", "updated", "closed", "funds_withdrawn", "funds_reinstated"]) {
      expect(verify(`charge.dispute.${suffix}`, { id: "dp_PLACEHOLDER", object: "dispute", payment_intent: PI })).toMatchObject({ type: `dispute.${suffix}`, providerPaymentId: PI });
    }
    // The same prefixes refunds.ts freezes refunds on (DISPUTE_PREFIXES).
    expect(verify("charge.dispute.created", { id: "dp_PLACEHOLDER", object: "dispute", payment_intent: PI }).type.startsWith("dispute.")).toBe(true);
  });

  it("an unknown type is authentic but names no payment; a mismatched object names none either", () => {
    expect(verify("customer.created", { id: "cus_PLACEHOLDER", object: "customer" })).toMatchObject({ type: "customer.created", providerPaymentId: null });
    expect(verify("charge.succeeded", { id: "ch_PLACEHOLDER", object: "charge", payment_intent: PI })).toMatchObject({ type: "charge.succeeded", providerPaymentId: null });
    expect(verify("payment_intent.succeeded", { id: "ch_PLACEHOLDER", object: "charge", payment_intent: PI }).providerPaymentId).toBeNull();
    expect(verify("refund.created", { id: "re_PLACEHOLDER", object: "charge", payment_intent: PI }).providerPaymentId).toBeNull();
    expect(verify("charge.dispute.created", { id: "dp_PLACEHOLDER", object: "charge", payment_intent: PI })).toMatchObject({ type: "charge.dispute.created", providerPaymentId: null });
    expect(verify("payment_intent.succeeded", { id: "pi_../../x", object: "payment_intent" }).providerPaymentId).toBeNull();
    expect(verify("checkout.session.completed", { id: "cs_test_PLACEHOLDER", object: "checkout.session", payment_intent: "ch_notapi" }).providerPaymentId).toBeNull();
    expect(verify("payment_intent.succeeded", null).providerPaymentId).toBeNull();
  });
});
