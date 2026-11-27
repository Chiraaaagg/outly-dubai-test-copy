import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { FakeAedCardGateway, FakeInrPacbGateway, SessionExpiredError, UnsupportedMethodError } from "../fake-gateways";
import { createGatewayRegistry, paymentGateways, railForCurrency } from "../registry";
import { sagaFor, type GatewayPaymentSnapshot } from "../contracts";
import { committedRefundMinor, mergedRefundedMinor } from "../refunds";

/**
 * Pure B3 rules: fake gateway semantics and signatures, the registry, the
 * webhook handler, the binding check, the release switch before any read,
 * and the SUP-20 rule that nothing under src/server/payments writes supplier
 * attempt state. The database module is replaced; the saga, inbox and
 * checkout run against Postgres in evidence.test.ts (db project).
 */

vi.mock("../../lib/db", () => ({ prisma: new Proxy({}, { get: () => { throw new Error("no database in unit tests"); } }), TX_OPTIONS: {} }));

const NOW = new Date("2030-01-10T08:00:00Z");

function session(gw: FakeInrPacbGateway | FakeAedCardGateway, method: string, amountMinor = 10_000n, expiresInMs = 10 * 60_000) {
  const expiresAt = new Date(gw.now().getTime() + expiresInMs).toISOString();
  return gw.createSession({ orderId: "o1", quoteId: "q1", currency: gw.rail === "inr_pacb" ? "INR" : "AED", amountMinor, idempotencyKey: "pay:o1:1", returnUrl: "http://localhost/r", method, expiresAt });
}

describe("fake gateways", () => {
  it("declare per-method semantics, and sagaFor picks the order of operations", () => {
    const inr = new FakeInrPacbGateway();
    const aed = new FakeAedCardGateway();
    expect(inr.capabilities("upi")).toMatchObject({ authorization: "capture_only", release: "refund", partialCapture: false, webhookSignedTimestamp: false });
    expect(inr.capabilities("card")).toMatchObject({ authorization: "debit_at_authorization", release: "auto_refund", authorizationLifetimeMs: 3 * 86_400_000 });
    expect(aed.capabilities("card")).toMatchObject({ authorization: "hold", release: "void", partialCapture: true, authorizationLifetimeMs: 7 * 86_400_000, webhookSignedTimestamp: true });
    expect(sagaFor(aed.capabilities("card"))).toBe("authorize_reserve_capture_confirm");
    expect(sagaFor(inr.capabilities("upi"))).toBe("capture_reserve_confirm");
    expect(sagaFor(inr.capabilities("card"))).toBe("capture_reserve_confirm");
    expect(() => aed.capabilities("upi")).toThrow(UnsupportedMethodError);
  });

  it("UPI is final on success; a card hold is authorized until captured or voided", async () => {
    const inr = new FakeInrPacbGateway({ now: () => NOW });
    const s = await session(inr, "upi");
    if (!s.ok) throw new Error();
    const upi = inr.pay(s.session.providerOrderId);
    expect(await inr.getPayment(upi)).toMatchObject({ kind: "ok", payment: { status: "captured", capturedMinor: 10_000n } });
    expect(await inr.void(upi, "v1")).toMatchObject({ kind: "failed", code: "void_not_supported" });

    const aed = new FakeAedCardGateway({ now: () => NOW });
    const a = await session(aed, "card");
    if (!a.ok) throw new Error();
    const card = aed.pay(a.session.providerOrderId);
    expect(await aed.getPayment(card)).toMatchObject({ kind: "ok", payment: { status: "authorized", capturedMinor: 0n } });
    expect(await aed.void(card, "v1")).toMatchObject({ kind: "ok", payment: { status: "voided" } });
    expect(await aed.capture(card, 10_000n, "c1")).toMatchObject({ kind: "failed", code: "not_capturable_voided" });
  });

  it("CR-B3-7: a session ends at the caller's expiry or sooner at the provider's limit, and refuses payment after it", async () => {
    let now = NOW;
    const aed = new FakeAedCardGateway({ now: () => now });
    const a = await session(aed, "card", 10_000n, 4 * 60_000);
    if (!a.ok) throw new Error();
    expect(a.session.expiresAt).toBe(new Date(NOW.getTime() + 4 * 60_000).toISOString());
    const inr = new FakeInrPacbGateway({ now: () => now });
    inr.sessionTtlMs = 2 * 60_000;
    const u = await session(inr, "upi", 10_000n, 4 * 60_000);
    if (!u.ok) throw new Error();
    expect(u.session.expiresAt).toBe(new Date(NOW.getTime() + 2 * 60_000).toISOString());
    expect(await session(new FakeAedCardGateway({ now: () => now }), "card", 10_000n, 0)).toEqual({ ok: false, code: "expires_at_invalid" });

    now = new Date(NOW.getTime() + 4 * 60_000);
    expect(() => aed.pay(a.session.providerOrderId)).toThrow(SessionExpiredError);
    expect(() => inr.pay(u.session.providerOrderId)).toThrow(SessionExpiredError);
    expect(aed.payments.size + inr.payments.size).toBe(0);
    // A provider that took the payment anyway (in flight at the expiry): Outly refunds it as late (F46).
    expect(await aed.getPayment(aed.pay(a.session.providerOrderId, { afterExpiry: true }))).toMatchObject({ kind: "ok", payment: { status: "authorized" } });
  });

  it("a debited authorization cannot be partly captured; a hold can", async () => {
    const inr = new FakeInrPacbGateway();
    const s = await session(inr, "card");
    if (!s.ok) throw new Error();
    const p = inr.pay(s.session.providerOrderId);
    expect(await inr.capture(p, 5_000n, "c1")).toMatchObject({ kind: "failed", code: "partial_capture_not_supported" });
    const aed = new FakeAedCardGateway();
    const a = await session(aed, "card");
    if (!a.ok) throw new Error();
    const h = aed.pay(a.session.providerOrderId);
    expect(await aed.capture(h, 5_000n, "c1")).toMatchObject({ kind: "ok", payment: { capturedMinor: 5_000n } });
  });

  it("mutations are idempotent per key: a repeat never charges or refunds twice", async () => {
    const aed = new FakeAedCardGateway();
    const a = await session(aed, "card");
    if (!a.ok) throw new Error();
    const h = aed.pay(a.session.providerOrderId);
    const first = await aed.capture(h, 10_000n, "k");
    expect(await aed.capture(h, 10_000n, "k")).toEqual(first);
    expect(await aed.capture(h, 10_000n, "other")).toMatchObject({ kind: "failed" });
    const r1 = await aed.refund(h, 10_000n, "r");
    expect(await aed.refund(h, 10_000n, "r")).toEqual(r1);
    expect(await aed.refund(h, 1n, "r2")).toMatchObject({ kind: "failed", code: "refund_exceeds_captured" });
    expect(aed.refunds.size).toBe(1);
    expect((await session(aed, "card")).ok && aed.orders.size).toBe(1);
  });

  it("a scripted lost answer may or may not have acted; a retry with the key tells which", async () => {
    const aed = new FakeAedCardGateway();
    const a = await session(aed, "card");
    if (!a.ok) throw new Error();
    const h = aed.pay(a.session.providerOrderId);
    aed.script("capture", { kind: "unknown", sent: true, applied: true });
    expect(await aed.capture(h, 10_000n, "k")).toMatchObject({ kind: "unknown", sent: true });
    expect(aed.payments.get(h)!.status).toBe("captured");
    expect(await aed.capture(h, 10_000n, "k")).toMatchObject({ kind: "ok" });
  });

  it("an uncaptured authorization expires at the end of its lifetime", async () => {
    let now = NOW;
    const aed = new FakeAedCardGateway({ now: () => now });
    const a = await session(aed, "card");
    if (!a.ok) throw new Error();
    const h = aed.pay(a.session.providerOrderId);
    now = new Date(NOW.getTime() + 7 * 86_400_000);
    expect(await aed.getPayment(h)).toMatchObject({ kind: "ok", payment: { status: "expired" } });
  });

  describe("webhook signatures", () => {
    it("INR: HMAC over the raw body only; any byte change or a missing header fails", () => {
      const inr = new FakeInrPacbGateway({ now: () => NOW });
      const w = inr.webhook("payment.captured", "pay_1", { eventId: "evt_1" });
      expect(inr.verifyWebhook(w.raw, w.headers)).toEqual({ providerEventId: "evt_1", type: "payment.captured", providerPaymentId: "pay_1", occurredAt: NOW.toISOString() });
      const changed = new Uint8Array(w.raw);
      changed[5] ^= 1;
      expect(inr.verifyWebhook(changed, w.headers)).toBeNull();
      expect(inr.verifyWebhook(w.raw, new Headers())).toBeNull();
      expect(new FakeInrPacbGateway({ webhookSecret: "another" }).verifyWebhook(w.raw, w.headers)).toBeNull();
      // No signed timestamp: an old body still verifies; the inbox's event-id uniqueness stops the replay.
      const old = inr.webhook("payment.captured", "pay_1", { at: new Date(NOW.getTime() - 86_400_000) });
      expect(inr.verifyWebhook(old.raw, old.headers)).not.toBeNull();
    });

    it("AED: HMAC over `t.body`, refused outside five minutes and when the timestamp is altered", () => {
      let now = NOW;
      const aed = new FakeAedCardGateway({ now: () => now });
      const w = aed.webhook("payment.authorized", "pay_1");
      expect(aed.verifyWebhook(w.raw, w.headers)).not.toBeNull();
      const sig = w.headers.get("x-fake-signature")!;
      const altered = new Headers({ "x-fake-signature": sig.replace(/t=(\d+)/, (_m, t) => `t=${Number(t) + 1}`) });
      expect(aed.verifyWebhook(w.raw, altered)).toBeNull();
      now = new Date(NOW.getTime() + 301_000);
      expect(aed.verifyWebhook(w.raw, w.headers)).toBeNull();
    });

    it("never parses an unverified body, and refuses a verified body without an event id", () => {
      const inr = new FakeInrPacbGateway();
      const spy = vi.spyOn(JSON, "parse");
      expect(inr.verifyWebhook(new TextEncoder().encode("{not json"), new Headers({ "x-fake-signature": "00" }))).toBeNull();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
      const w = inr.webhook("payment.captured", "p", { body: { id: "" } });
      expect(inr.verifyWebhook(w.raw, w.headers)).toBeNull();
    });
  });
});

describe("gateway registry", () => {
  it("serves fakes by rail outside production; nothing is configured in production", () => {
    const inr = new FakeInrPacbGateway();
    const r = createGatewayRegistry([inr, new FakeAedCardGateway()], { production: false });
    expect(r.forRail("inr_pacb")).toBe(inr);
    expect(r.forProvider("fake-aed-card")).not.toBeNull();
    expect(r.forProvider("razorpay")).toBeNull();
    const prod = createGatewayRegistry([inr], { production: true });
    expect(() => prod.forRail("inr_pacb")).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
    expect(() => paymentGateways.forRail("aed_card")).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
    expect(paymentGateways.forProvider("fake-inr-pacb")).toBeNull();
    expect(railForCurrency("INR")).toBe("inr_pacb");
    expect(railForCurrency("USD")).toBeNull();
  });

  it("refuses any gateway that is not a fake: no real adapter exists", () => {
    const real = Object.assign(Object.create(FakeInrPacbGateway.prototype), new FakeInrPacbGateway());
    Object.defineProperty(real, "provider", { value: "razorpay" });
    real.account = () => ({ provider: "razorpay", accountId: "x", environment: "test", rail: "inr_pacb" });
    expect(() => createGatewayRegistry([real], { production: false }).forRail("inr_pacb")).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
  });
});

describe("webhook handler", () => {
  it("404 for an unknown provider, 413 over the cap, 401 for a rejected body, 200 stored or duplicate, 500 on a store fault", async () => {
    const { createPaymentWebhookHandler, MAX_PAYMENT_WEBHOOK_BYTES } = await import("../webhook-handler");
    const receive = vi.fn(async (_p: string, body: Uint8Array) => (body[0] === 0x7b ? { result: "stored" as const, id: "e", providerEventId: "x" } : { result: "rejected" as const }));
    const handle = createPaymentWebhookHandler({ receive }, (p) => p === "fake-inr-pacb");
    const req = (body: BodyInit, headers: Record<string, string> = {}) => new Request("http://localhost/api/webhooks/payments/x", { method: "POST", body, headers });
    expect((await handle(req("{}"), "unknown")).status).toBe(404);
    expect((await handle(req("{}"), "../etc")).status).toBe(404);
    expect((await handle(req(new Uint8Array(MAX_PAYMENT_WEBHOOK_BYTES + 1)), "fake-inr-pacb")).status).toBe(413);
    expect((await handle(req("nope"), "fake-inr-pacb")).status).toBe(401);
    expect((await handle(req("{}"), "fake-inr-pacb")).status).toBe(200);
    receive.mockRejectedValueOnce(new Error("db down"));
    expect((await handle(req("{}"), "fake-inr-pacb")).status).toBe(500);
    // The exact bytes reach the inbox.
    expect(Array.from(receive.mock.calls[2][1] as Uint8Array)).toEqual(Array.from(new TextEncoder().encode("{}")));
  });
});

describe("binding check", () => {
  it("names any difference between the provider's read and the bound payment", async () => {
    const { bindingMismatch } = await import("../saga");
    const account = { provider: "fake-aed-card", accountId: "acct", environment: "test" as const, rail: "aed_card" as const };
    const payment = { provider: "fake-aed-card", providerAccountId: "acct", environment: "test", currency: "AED" as const, amountMinor: 10_000n, providerOrderId: "ord", gatewayOrderId: "ord" };
    const snap: GatewayPaymentSnapshot = {
      providerPaymentId: "p",
      providerOrderId: "ord",
      accountId: "acct",
      status: "authorized",
      currency: "AED",
      amountMinor: 10_000n,
      capturedMinor: 0n,
      refundedMinor: 0n,
      method: "card",
      threeDs: "passed",
      risk: "normal",
      authorizedAt: null,
      authorizationExpiresAt: null,
    };
    expect(bindingMismatch(payment, snap, account)).toBeNull();
    expect(bindingMismatch(payment, { ...snap, accountId: "other" }, account)).toBe("account_mismatch");
    expect(bindingMismatch(payment, { ...snap, currency: "INR" }, account)).toBe("currency_mismatch");
    expect(bindingMismatch(payment, { ...snap, amountMinor: 9_999n }, account)).toBe("amount_mismatch");
    expect(bindingMismatch(payment, { ...snap, providerOrderId: "else" }, account)).toBe("order_mismatch");
    expect(bindingMismatch({ ...payment, provider: "x" }, snap, account)).toBe("provider_mismatch");
    // Same account id in test and live mode (CR-B3-12).
    expect(bindingMismatch({ ...payment, environment: "production" }, snap, account)).toBe("environment_mismatch");
    expect(bindingMismatch({ ...payment, environment: null }, snap, account)).toBe("environment_mismatch");
    expect(bindingMismatch(payment, { ...snap, capturedMinor: 10_001n }, account)).toBe("amounts_inconsistent");
  });
});

describe("checkout release switch", () => {
  it("refuses before reading anything when INSTANT_RELEASE_ENABLED is off", async () => {
    const { createCheckoutService } = await import("../checkout.service");
    const never = () => {
      throw new Error("must not be called");
    };
    const svc = createCheckoutService({
      gateways: createGatewayRegistry([new FakeAedCardGateway()], { production: false }),
      releaseEnabled: () => false,
      readiness: { evaluate: never },
      salesOpen: never,
      admission: never,
      exposureLimits: never,
      fxInrPerAed: never,
      now: () => NOW,
    });
    const input = {
      owner: { kind: "guest" as const, guestSessionId: "00000000-0000-7000-8000-000000000001" },
      quoteId: "00000000-0000-7000-8000-000000000002",
      verificationId: "00000000-0000-7000-8000-000000000003",
      method: "card",
      traveller: { fullName: "Synthetic", phoneE164: "+971501234567", email: null },
      returnUrl: "http://localhost/r",
      ip: null,
    };
    expect(await svc.start(input)).toEqual({ ok: false, reason: "release_switch_off" });
    expect(await svc.start({ ...input, quoteId: "not-a-uuid" })).toEqual({ ok: false, reason: "invalid_request" });
  });
});

describe("remedies never write supplier attempt state (SUP-20)", () => {
  it("no file under src/server/payments writes supplier_bookings", () => {
    const dir = path.resolve(process.cwd(), "src/server/payments");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(path.join(dir, f), "utf8");
      expect(src, f).not.toMatch(/supplierBooking\.(update|updateMany|create|createMany|upsert|delete|deleteMany)\b/);
      expect(src, f).not.toMatch(/(UPDATE|INSERT INTO|DELETE FROM)\s+"?supplier_bookings/i);
      expect(src, f).not.toMatch(/transitionWithEvent/);
    }
  });
});

describe("refund accounting (migration 20261101140000: GREATEST(R, S) + O)", () => {
  // Synthetic amounts: 230_000 captured, an Outly refund of 100_000, a dashboard refund of 50_000.
  it("sync first, then settle: the refund the provider already reported is not added again", () => {
    // Synced: R = 100_000 with the row still open, so it is counted twice until it settles (refuses, never allows).
    expect(committedRefundMinor({ refunded: 100_000n, succeeded: 0n, open: 100_000n })).toBe(200_000n);
    const r = mergedRefundedMinor(100_000n, 100_000n, 100_000n, 230_000n);
    expect(r).toBe(100_000n);
    expect(committedRefundMinor({ refunded: r, succeeded: 100_000n, open: 0n })).toBe(100_000n);
  });

  it("settle first, then sync: the provider's read keeps the same total", () => {
    const settled = mergedRefundedMinor(0n, 100_000n, 100_000n, 230_000n);
    expect(settled).toBe(100_000n);
    // The sync is a max-merge too (saga.ts syncPayment).
    expect(settled > 100_000n ? settled : 100_000n).toBe(100_000n);
    // Settled without a provider total, it still never falls below Outly's own succeeded refunds.
    expect(mergedRefundedMinor(0n, 100_000n, null, 230_000n)).toBe(100_000n);
  });

  it("a dashboard refund alongside an open Outly refund: both count, neither twice", () => {
    expect(committedRefundMinor({ refunded: 50_000n, succeeded: 0n, open: 100_000n })).toBe(150_000n);
    const r = mergedRefundedMinor(50_000n, 100_000n, 150_000n, 230_000n);
    expect(r).toBe(150_000n);
    expect(committedRefundMinor({ refunded: r, succeeded: 100_000n, open: 0n })).toBe(150_000n);
    // GREATEST(R, all non-failed rows) would be wrong: it would leave 130_000 refundable instead of 80_000.
    expect(230_000n - committedRefundMinor({ refunded: 50_000n, succeeded: 0n, open: 100_000n })).toBe(80_000n);
    expect(mergedRefundedMinor(200_000n, 100_000n, 300_000n, 230_000n)).toBe(230_000n);
  });
});
