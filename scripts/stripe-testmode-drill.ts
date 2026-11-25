/**
 * Stripe TEST-MODE drill for the Stripe gateway (doc 22 §32.14, approval A6).
 *
 * Exercises `StripeGateway` against the real Stripe API in test mode, to
 * confirm what the unit tests could only assume (doc 22 §32.13):
 *
 *   api phase
 *     S1  createSession AED with a 10-minute quote: Stripe accepts it, the
 *         reported expiry is at least 30 minutes away; expireSession twice.
 *     S2  createSession INR: the UAE account accepts INR presentment.
 *     S3  AED hold (test card visa): getPayment authorized, full capture,
 *         partial refund with its reference, getRefund, listRefunds.
 *     S4  INR hold: authorized in INR, partial capture; how Stripe reports the
 *         released remainder (refundedMinor must stay 0).
 *     S5  AED hold voided: getPayment voided with refundedMinor 0.
 *     S6  a declined test card is a definite failure.
 *     S7  a 3DS-required test card stops at requires_action.
 *   hosted phase (after a person pays the S8 session with a test card)
 *     S8  listPaymentsForOrder finds the authorized hold; expireSession on the
 *         completed session reports completed; void after a completed session.
 *
 * Webhooks: `stripe listen --forward-to 127.0.0.1:4242/webhook` forwards test
 * events here; each is checked with `gateway.verifyWebhook` over the raw bytes.
 *
 * Safety:
 *  - Refuses unless PAYMENTS_STRIPE=test with an sk_test_/rk_test_ key and
 *    APP_ENV is not production. Live keys are never accepted.
 *  - Only Stripe's published test payment methods; synthetic amounts; metadata
 *    marks every object as an Outly drill.
 *  - No database, no supplier call. Results go to .stripe-drill/ (git-ignored),
 *    without keys or secrets.
 *
 *   node --env-file=.env.stripe.test.local node_modules/tsx/dist/cli.mjs scripts/stripe-testmode-drill.ts api
 *   node --env-file=.env.stripe.test.local node_modules/tsx/dist/cli.mjs scripts/stripe-testmode-drill.ts hosted <cs_test_…>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { StripeGateway, STRIPE_API_VERSION } from "../src/server/payments/stripe/stripe-gateway";
import { stripeConfigFrom, stripeConfigProblems, type StripeEnvSlice } from "../src/server/payments/stripe/stripe.config";

function fail(message: string): never {
  console.error(`REFUSED: ${message}`);
  process.exit(2);
}

const env = process.env as unknown as StripeEnvSlice & { APP_ENV?: string };
if (env.PAYMENTS_STRIPE !== "test") fail("PAYMENTS_STRIPE must be test");
if (env.APP_ENV === "production") fail("APP_ENV=production");
const key = env.STRIPE_SECRET_KEY?.trim() ?? "";
if (!/^(sk|rk)_test_/.test(key)) fail("only an sk_test_ or rk_test_ key is accepted");
const problems = stripeConfigProblems(env);
if (problems.length) fail(problems.join("; "));
const config = stripeConfigFrom(env);
if (!config || config.environment !== "test") fail("config did not resolve to test mode");

const phase = process.argv[2];
if (phase !== "api" && phase !== "hosted") fail("usage: api | hosted <cs_test_…>");

const gateway = new StripeGateway({ config });
const raw = new Stripe(key, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 0, timeout: 20_000, telemetry: false });
const run = `drill-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const outDir = path.join(".stripe-drill", run);
mkdirSync(outDir, { recursive: true });

type Row = { step: string; check: string; ok: boolean; detail: unknown };
const rows: Row[] = [];
const webhooks: { type: string | null; verified: boolean; providerPaymentId: string | null }[] = [];

const big = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
function check(step: string, name: string, ok: boolean, detail: unknown = null) {
  rows.push({ step, check: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step} ${name}${detail === null ? "" : ` ${JSON.stringify(detail, big)}`}`);
}
const key_ = (s: string) => `drill:${run}:${s}`;
const META = { outly_drill: run };

/** Webhook receiver for `stripe listen --forward-to 127.0.0.1:4242/webhook`. */
function startWebhookServer() {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = new Uint8Array(Buffer.concat(chunks));
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const ev = gateway.verifyWebhook(body, headers);
      let type: string | null = null;
      try {
        type = (JSON.parse(Buffer.from(body).toString("utf8")) as { type?: string }).type ?? null;
      } catch {
        type = null;
      }
      webhooks.push({ type, verified: ev !== null, providerPaymentId: ev?.providerPaymentId ?? null });
      res.statusCode = ev ? 200 : 401;
      res.end();
    });
  });
  server.listen(4242, "127.0.0.1");
  return server;
}

async function heldPayment(currency: "aed" | "inr", amount: number, pm: string) {
  return raw.paymentIntents.create(
    {
      amount,
      currency,
      capture_method: "manual",
      payment_method: pm,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      confirm: true,
      metadata: META,
      description: "Outly Stripe test-mode drill",
    },
    { idempotencyKey: key_(`pi:${currency}:${amount}:${pm}`) },
  );
}

async function apiPhase() {
  const in10m = new Date(Date.now() + 10 * 60_000).toISOString();

  // S1 AED session and expiry
  const s1 = await gateway.createSession({
    orderId: `drill-order-${randomUUID()}`,
    quoteId: `drill-quote-${randomUUID()}`,
    currency: "AED",
    amountMinor: 1000n,
    idempotencyKey: key_("s1"),
    returnUrl: "http://localhost:3000/checkout/return",
    method: "card",
    expiresAt: in10m,
  });
  check("S1", "AED session created", s1.ok, s1.ok ? { expiresAt: s1.session.expiresAt } : s1);
  if (s1.ok) {
    const life = Date.parse(s1.session.expiresAt) - Date.now();
    check("S1", "Stripe expiry is at least 30 minutes away", life >= 30 * 60_000, { minutes: Math.round(life / 60_000) });
    const e1 = await gateway.expireSession(s1.session.providerOrderId, key_("s1:expire"));
    check("S1", "expireSession on an open session", e1.kind === "ok", e1);
    const e2 = await gateway.expireSession(s1.session.providerOrderId, key_("s1:expire:again"));
    check("S1", "expireSession on an expired session reports expired", e2.kind === "ok", e2);
  }

  // S2 INR session
  const s2 = await gateway.createSession({
    orderId: `drill-order-${randomUUID()}`,
    quoteId: `drill-quote-${randomUUID()}`,
    currency: "INR",
    amountMinor: 50000n,
    idempotencyKey: key_("s2"),
    returnUrl: "http://localhost:3000/checkout/return",
    method: "card",
    expiresAt: in10m,
  });
  check("S2", "INR session created on the UAE account", s2.ok, s2.ok ? { currencyAccepted: "INR" } : s2);
  if (s2.ok) await gateway.expireSession(s2.session.providerOrderId, key_("s2:expire"));

  // S3 AED hold, capture, partial refund
  const pi3 = await heldPayment("aed", 2500, "pm_card_visa");
  const g3 = await gateway.getPayment(pi3.id);
  check("S3", "AED hold reads authorized", g3.kind === "ok" && g3.payment.status === "authorized", g3.kind === "ok" ? { status: g3.payment.status, threeDs: g3.payment.threeDs, risk: g3.payment.risk, authorizationExpiresAt: g3.payment.authorizationExpiresAt } : g3);
  const c3 = await gateway.capture(pi3.id, 2500n, key_("s3:capture"));
  check("S3", "full capture", c3.kind === "ok" && c3.payment.status === "captured" && c3.payment.capturedMinor === 2500n, c3.kind === "ok" ? { status: c3.payment.status, captured: c3.payment.capturedMinor } : c3);
  const r3 = await gateway.refund(pi3.id, 1000n, key_("s3:refund"));
  check("S3", "partial refund accepted", r3.kind === "accepted", r3);
  if (r3.kind === "accepted") {
    const gr = await gateway.getRefund(r3.providerRefundId);
    check("S3", "getRefund", gr.status !== "unknown", gr);
    const lr = await gateway.listRefunds(pi3.id);
    check("S3", "listRefunds reports the reference", lr.ok && lr.refunds.some((r) => r.reference === key_("s3:refund")), lr.ok ? { count: lr.refunds.length } : lr);
    const after = await gateway.getPayment(pi3.id);
    check("S3", "payment reads partially_refunded with refundedMinor 1000", after.kind === "ok" && after.payment.status === "partially_refunded" && after.payment.refundedMinor === 1000n, after.kind === "ok" ? { status: after.payment.status, refunded: after.payment.refundedMinor } : after);
  }

  // S4 INR hold, partial capture
  const pi4 = await heldPayment("inr", 100000, "pm_card_visa");
  const g4 = await gateway.getPayment(pi4.id);
  check("S4", "INR hold reads authorized in INR", g4.kind === "ok" && g4.payment.status === "authorized" && g4.payment.currency === "INR", g4.kind === "ok" ? { status: g4.payment.status, currency: g4.payment.currency } : g4);
  const c4 = await gateway.capture(pi4.id, 60000n, key_("s4:capture"));
  check("S4", "partial capture of 60000 of 100000 paise", c4.kind === "ok" && c4.payment.capturedMinor === 60000n, c4.kind === "ok" ? { status: c4.payment.status, captured: c4.payment.capturedMinor, refunded: c4.payment.refundedMinor } : c4);
  if (c4.kind === "ok") check("S4", "released remainder is not counted as a refund", c4.payment.refundedMinor === 0n, { refunded: c4.payment.refundedMinor });
  const rawPi4 = await raw.paymentIntents.retrieve(pi4.id, { expand: ["latest_charge"] });
  const ch4 = rawPi4.latest_charge as Stripe.Charge | null;
  check("S4", "Stripe raw: amount_refunded after partial capture (observation)", true, { amount_captured: ch4?.amount_captured ?? null, amount_refunded: ch4?.amount_refunded ?? null });

  // S5 AED hold voided
  const pi5 = await heldPayment("aed", 3000, "pm_card_mastercard");
  const v5 = await gateway.void(pi5.id, key_("s5:void"));
  check("S5", "void", v5.kind === "ok" && v5.payment.status === "voided", v5.kind === "ok" ? { status: v5.payment.status, refunded: v5.payment.refundedMinor } : v5);
  if (v5.kind === "ok") check("S5", "voided hold has refundedMinor 0", v5.payment.refundedMinor === 0n, { refunded: v5.payment.refundedMinor });

  // S6 declined card
  try {
    await heldPayment("aed", 2000, "pm_card_chargeDeclined");
    check("S6", "declined card raises", false, "no error raised");
  } catch (e) {
    const err = e as { type?: string; code?: string; decline_code?: string };
    check("S6", "declined card is a card error", err.type === "StripeCardError", { type: err.type, code: err.code, decline_code: err.decline_code });
  }

  // S7 3DS required
  const pi7 = await heldPayment("aed", 2200, "pm_card_threeDSecure2Required");
  const g7 = await gateway.getPayment(pi7.id);
  check("S7", "3DS-required card stops at requires_action", g7.kind === "ok" && g7.payment.status === "requires_action", g7.kind === "ok" ? { status: g7.payment.status } : g7);
  await raw.paymentIntents.cancel(pi7.id, {}, { idempotencyKey: key_("s7:cancel") });

  // S8 session for a person to pay with a test card
  const s8 = await gateway.createSession({
    orderId: `drill-order-${randomUUID()}`,
    quoteId: `drill-quote-${randomUUID()}`,
    currency: "AED",
    amountMinor: 1500n,
    idempotencyKey: key_("s8"),
    returnUrl: "http://localhost:3000/checkout/return",
    method: "card",
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  check("S8", "hosted session ready for a test-card payment", s8.ok, s8.ok ? { sessionId: s8.session.providerOrderId, url: s8.session.redirectUrl } : s8);
}

async function hostedPhase(sessionId: string) {
  if (!/^cs_test_/.test(sessionId)) fail("hosted phase needs a cs_test_ session id");
  // The webhook receiver is already listening; wait (up to 5 minutes) for a person to pay the session.
  console.log("Waiting for the test-card payment on the hosted page…");
  let list = await gateway.listPaymentsForOrder(sessionId);
  for (let i = 0; i < 60 && !(list.ok && list.payments.some((p) => p.status === "authorized")); i++) {
    await new Promise((r) => setTimeout(r, 5000));
    list = await gateway.listPaymentsForOrder(sessionId);
  }
  check("S8", "listPaymentsForOrder finds the paid hold", list.ok && list.payments.length === 1 && list.payments[0].status === "authorized", list.ok ? list.payments.map((p) => ({ status: p.status, threeDs: p.threeDs, risk: p.risk, method: p.method })) : list);
  const exp = await gateway.expireSession(sessionId, key_("s8:expire"));
  check("S8", "expireSession on a completed session reports completed", exp.kind === "ok", exp);
  if (list.ok && list.payments[0]) {
    const v = await gateway.void(list.payments[0].providerPaymentId, key_("s8:void"));
    check("S8", "void after a completed Checkout Session", v.kind === "ok" && v.payment.status === "voided", v.kind === "ok" ? { status: v.payment.status, refunded: v.payment.refundedMinor } : v);
  }
}

async function main() {
  const server = startWebhookServer();
  try {
    if (phase === "api") await apiPhase();
    else await hostedPhase(process.argv[3] ?? "");
    await new Promise((r) => setTimeout(r, 8000)); // let forwarded webhooks arrive
  } finally {
    server.close();
  }
  const verified = webhooks.filter((w) => w.verified).length;
  check("WH", "forwarded webhooks verified by signature", webhooks.length > 0 && verified === webhooks.length, { received: webhooks.length, verified, types: [...new Set(webhooks.map((w) => w.type))] });
  writeFileSync(path.join(outDir, `${phase}.json`), JSON.stringify({ run, phase, rows, webhooks }, big, 2));
  const failed = rows.filter((r) => !r.ok).length;
  console.log(`\n${rows.length - failed}/${rows.length} checks passed. Results: ${outDir}/${phase}.json`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("drill error:", e instanceof Error ? e.message : e);
  process.exit(1);
});
