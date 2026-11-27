import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../lib/ids";
import { dbEnabled, runId } from "../../__tests__/helpers/fixtures";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import { checkedOut, cleanupB3, deliver, harness, quoteFixture, sagaState, startInput, type Harness } from "./_b3-harness";

/**
 * Checkout gates and the webhook inbox on Postgres (doc 22 §23 B3; PAY-5,
 * PAY-13; F2, F21, F29, F30, F52, F57). Imported by evidence.test.ts (the
 * payments db suite). Fakes only: no provider is contacted.
 */

type Prisma = typeof import("../../lib/db").prisma;

describe.skipIf(!dbEnabled)("B3 checkout and payment inbox (disposable database)", () => {
  let prisma: Prisma;
  const run = runId();

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    await cleanupB3(prisma);
  });

  afterAll(async () => {
    await cleanupB3(prisma);
  });

  async function h(opts?: Parameters<typeof harness>[1]): Promise<Harness> {
    return harness(prisma, opts);
  }

  describe("checkoutService.start", () => {
    it("creates the order, marks the quote used, binds the verification and opens one session (AED)", async () => {
      const x = await h();
      const c = await checkedOut(x, run, "AED", "card");
      const order = await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId }, include: { items: true } });
      expect(order).toMatchObject({ status: "pending_payment", rail: "self_serve", paymentCollection: "gateway", currency: "AED", subtotalAed: 11_000n, discountAed: 1_500n, taxAed: 500n, totalAed: 10_000n, totalInr: 0n, leadPhone: "+971501234567" });
      expect(order.items).toHaveLength(1);
      expect(order.items[0]).toMatchObject({ fulfilmentOrigin: "instant_checkout", chargedCurrency: "AED", chargedAmountMinor: 11_000n, discountAllocMinor: 1_500n, taxAllocMinor: 500n, quoteId: c.q.quoteId, netCostAed: 5_000n });
      expect(order.items[0].marginSnapshot).toMatchObject({ floorBps: 1500 });
      expect(await prisma.quote.findUniqueOrThrow({ where: { id: c.q.quoteId } })).toMatchObject({ status: "used", usedByOrderId: order.id });
      expect((await prisma.orderContactVerification.findUniqueOrThrow({ where: { id: c.q.verificationId } })).orderId).toBe(order.id);
      const s = await sagaState(x, c.sagaId);
      expect(s).toMatchObject({ state: "session_created", rail: "aed_card", orderItemId: order.items[0].id });
      expect(s.payment).toMatchObject({ source: "gateway_verified", status: "created", provider: "fake-aed-card", providerAccountId: "fake-account-1", environment: "test", rail: "aed_card", amountMinor: 10_000n, idempotencyKey: `pay:${order.id}:1`, providerOrderId: c.providerOrderId });
      expect(c.r.redirectUrl).toContain(c.providerOrderId);
      expect(x.aed.callsOf("createSession")).toHaveLength(1);
    });

    it("is idempotent per quote: a repeat returns the same order and page, with no second session", async () => {
      const x = await h();
      const q = await quoteFixture(x, run, "INR");
      const a = await x.checkout.start(startInput(q, "upi"));
      const b = await x.checkout.start(startInput(q, "upi"));
      expect(a).toEqual(b);
      expect(x.inr.callsOf("createSession")).toHaveLength(1);
      expect(await prisma.order.count({ where: { quote: { id: q.quoteId } } })).toBe(1);
    });

    it("a session that failed to open is re-requested with the same key on the repeat", async () => {
      const x = await h();
      const q = await quoteFixture(x, run, "INR");
      x.inr.script("createSession", { kind: "throw" });
      expect(await x.checkout.start(startInput(q, "upi"))).toEqual({ ok: false, reason: "payment_session_unavailable" });
      const again = await x.checkout.start(startInput(q, "upi"));
      expect(again.ok).toBe(true);
      const keys = x.inr.callsOf("createSession").map((args) => (args[0] as { idempotencyKey: string }).idempotencyKey);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(1);
    });

    it.each([
      ["release switch off", (x: Harness): void => { x.gates.release = false; }, "release_switch_off"],
      ["supplier new sales paused (kill switch)", (x: Harness): void => { x.gates.salesOpen = false; }, "sales_paused"],
      ["queue admission refuses", (x: Harness): void => { x.gates.admission = false; }, "queue_busy"],
      ["readiness now inquiry", (x: Harness): void => { x.gates.readiness = "inquiry"; }, "requires_inquiry"],
    ] as const)("refuses before any order or session when %s (PAY-5, F21)", async (_label, set, reason) => {
      const x = await h();
      const q = await quoteFixture(x, run, "AED");
      set(x);
      expect(await x.checkout.start(startInput(q, "card"))).toEqual({ ok: false, reason });
      expect(x.aed.callsOf("createSession")).toHaveLength(0);
      expect(await prisma.quote.findUniqueOrThrow({ where: { id: q.quoteId } })).toMatchObject({ status: "active", usedByOrderId: null });
    });

    it("refuses an unknown method, another owner's quote and an expired quote", async () => {
      const x = await h();
      const q = await quoteFixture(x, run, "AED");
      expect(await x.checkout.start(startInput(q, "upi"))).toEqual({ ok: false, reason: "method_not_supported" });
      expect(await x.checkout.start({ ...startInput(q, "card"), owner: { kind: "guest", guestSessionId: uuidv7() } })).toEqual({ ok: false, reason: "quote_not_found" });
      const expired = await quoteFixture(x, run, "AED", { ttlMs: 60_000 });
      x.clock.advance(2 * 60_000);
      expect(await x.checkout.start(startInput(expired, "card"))).toEqual({ ok: false, reason: "quote_expired" });
      expect(x.aed.callsOf("createSession")).toHaveLength(0);
    });

    describe("order-bound verification (TKT-4)", () => {
      it("refuses a traveller phone that differs from the verified one", async () => {
        const x = await h();
        const q = await quoteFixture(x, run, "AED");
        const input = startInput(q, "card");
        expect(await x.checkout.start({ ...input, traveller: { ...input.traveller, phoneE164: "+971509999999" } })).toEqual({ ok: false, reason: "verified_contact_mismatch" });
        expect(await x.checkout.start({ ...input, traveller: { ...input.traveller, phoneE164: null, email: "zz-b3@outlyy.test" } })).toEqual({ ok: false, reason: "verified_contact_missing" });
        expect(x.aed.callsOf("createSession")).toHaveLength(0);
        expect((await prisma.orderContactVerification.findUniqueOrThrow({ where: { id: q.verificationId } })).orderId).toBeNull();
      });

      it("refuses another quote's verification", async () => {
        const x = await h();
        const a = await quoteFixture(x, run, "AED");
        const b = await quoteFixture(x, run, "AED");
        expect(await x.checkout.start({ ...startInput(a, "card"), verificationId: b.verificationId })).toEqual({ ok: false, reason: "verification_required" });
        expect(await x.checkout.start({ ...startInput(a, "card"), verificationId: uuidv7() })).toEqual({ ok: false, reason: "verification_required" });
        expect(x.aed.callsOf("createSession")).toHaveLength(0);
      });

      it("refuses a verification already bound to another order, and an expired one", async () => {
        const x = await h();
        const done = await checkedOut(x, run, "AED", "card");
        const q = await quoteFixture(x, run, "AED");
        // Point this quote's verification at the other order, as if bound elsewhere.
        await prisma.orderContactVerification.update({ where: { id: q.verificationId }, data: { orderId: done.r.orderId } });
        expect(await x.checkout.start(startInput(q, "card"))).toEqual({ ok: false, reason: "verification_already_bound" });

        const old = await quoteFixture(x, run, "AED");
        await prisma.orderContactVerification.update({ where: { id: old.verificationId }, data: { verifiedAt: new Date(Date.now() - 11 * 60_000) } });
        expect(await x.checkout.start(startInput(old, "card"))).toEqual({ ok: false, reason: "verification_expired" });
        expect(x.aed.callsOf("createSession")).toHaveLength(1);
      });
    });

    it("never hands out a stale link: a quote about to lapse, a lapsed quote and a closed saga are refused (F46)", async () => {
      const x = await h();
      const short = await quoteFixture(x, run, "INR", { ttlMs: 90_000 });
      expect(await x.checkout.start(startInput(short, "upi"))).toEqual({ ok: false, reason: "quote_expired" });
      expect(x.inr.callsOf("createSession")).toHaveLength(0);

      const q = await quoteFixture(x, run, "INR");
      expect((await x.checkout.start(startInput(q, "upi"))).ok).toBe(true);
      x.clock.advance(9 * 60_000);
      expect(await x.checkout.start(startInput(q, "upi"))).toEqual({ ok: false, reason: "quote_expired" });

      const live = await quoteFixture(x, run, "AED");
      const r = await x.checkout.start(startInput(live, "card"));
      if (!r.ok) throw new Error(r.reason);
      expect(await x.checkout.start(startInput(live, "card"))).toEqual(r);
      await prisma.paymentSaga.update({ where: { orderId: r.orderId }, data: { state: "failed" } });
      expect(await x.checkout.start(startInput(live, "card"))).toEqual({ ok: false, reason: "quote_expired" });
    });

    it("the payment window is the earlier of the quote expiry and the provider session's", async () => {
      const x = await h();
      x.inr.sessionTtlMs = 5 * 60_000;
      const c = await checkedOut(x, run, "INR", "upi");
      expect((await sagaState(x, c.sagaId)).deadlineAt!.toISOString()).toBe(x.inr.orders.get(c.providerOrderId)!.expiresAt);
      const d = await checkedOut(x, run, "AED", "card");
      const quote = await prisma.quote.findUniqueOrThrow({ where: { id: d.q.quoteId } });
      expect((await sagaState(x, d.sagaId)).deadlineAt!.getTime()).toBe(quote.expiresAt.getTime());
    });

    it("CR-B3-7: the provider is told to stop taking payment when the quote lapses, and its page refuses after that", async () => {
      const x = await h();
      const c = await checkedOut(x, run, "AED", "card");
      const quote = await prisma.quote.findUniqueOrThrow({ where: { id: c.q.quoteId } });
      const [input] = x.aed.callsOf("createSession").at(-1)! as [{ expiresAt: string }];
      expect(input.expiresAt).toBe(quote.expiresAt.toISOString());
      expect(x.aed.orders.get(c.providerOrderId)!.expiresAt).toBe(quote.expiresAt.toISOString());
      x.clock.advance(quote.expiresAt.getTime() - x.clock.now().getTime());
      expect(() => x.aed.pay(c.providerOrderId)).toThrow(/has expired/);
      expect([...x.aed.payments.values()].filter((p) => p.providerOrderId === c.providerOrderId)).toEqual([]);
    });

    it("stops new sessions at the uncaptured-hold cap (F29) and at the Outly-funded cap (F52)", async () => {
      const x = await h();
      const holds = await prisma.paymentSaga.count({ where: { rail: "aed_card", state: { in: ["authorized", "reserve_pending", "reserved", "capture_unknown"] } } });
      x.gates.limits = { ...x.gates.limits, maxUncapturedHolds: holds };
      const q = await quoteFixture(x, run, "AED");
      expect(await x.checkout.start(startInput(q, "card"))).toEqual({ ok: false, reason: "exposure_cap" });

      x.gates.limits = { ...x.gates.limits, maxUncapturedHolds: 1_000_000 };
      const funded = await prisma.customerRemedy.aggregate({ where: { outlyFunded: true, currency: "AED", status: { notIn: ["cancelled", "failed"] }, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, _sum: { amountMinor: true } });
      const done = await checkedOut(x, run, "AED", "card");
      await prisma.customerRemedy.create({
        data: { id: uuidv7(), orderId: done.r.orderId, orderItemId: done.orderItemId, kind: "alternative_offered", reason: "zz-b3 outly funded", amountMinor: 100n, currency: "AED", outlyFunded: true },
      });
      x.gates.limits = { ...x.gates.limits, outlyFundedCapMinor: { INR: 1_000_000_000, AED: Number((funded._sum.amountMinor ?? 0n) + 50n) } };
      const q2 = await quoteFixture(x, run, "AED");
      expect(await x.checkout.start(startInput(q2, "card"))).toEqual({ ok: false, reason: "exposure_cap" });
      expect(x.aed.callsOf("createSession")).toHaveLength(1);
    });

    describe("per-order instant cap (doc 22 §32.24, owner: 500 AED per order), the quote's rule repeated", () => {
      const orders = async () => prisma.order.count();

      it("AED: a quote total exactly at the cap opens a session; one fil over is refused before any order or session", async () => {
        const x = await h();
        const at = await quoteFixture(x, run, "AED"); // 10_000 fils
        x.gates.limits = { ...x.gates.limits, maxInstantOrderAedMinor: 10_000 };
        expect((await x.checkout.start(startInput(at, "card"))).ok).toBe(true);

        const over = await quoteFixture(x, run, "AED");
        x.gates.limits = { ...x.gates.limits, maxInstantOrderAedMinor: 9_999 };
        const before = await orders();
        expect(await x.checkout.start(startInput(over, "card"))).toEqual({ ok: false, reason: "order_over_limit" });
        expect(await orders()).toBe(before);
        expect((await prisma.quote.findUniqueOrThrow({ where: { id: over.quoteId } })).status).toBe("active");
        expect(x.aed.callsOf("createSession")).toHaveLength(1);
      });

      it("INR: converted with the FX row; just under passes, just over is refused, and a fraction over is not rounded onto the cap", async () => {
        const x = await h();
        // ₹2,300 = 230_000 paise. At 23.00: 10_000 fils exactly. At 23.01: 9_995.65 fils.
        x.gates.fx = "23.00";
        x.gates.limits = { ...x.gates.limits, maxInstantOrderAedMinor: 10_000 };
        expect((await x.checkout.start(startInput(await quoteFixture(x, run, "INR"), "upi"))).ok).toBe(true);
        x.gates.limits = { ...x.gates.limits, maxInstantOrderAedMinor: 9_999 };
        expect(await x.checkout.start(startInput(await quoteFixture(x, run, "INR"), "upi"))).toEqual({ ok: false, reason: "order_over_limit" });

        x.gates.fx = "23.01";
        x.gates.limits = { ...x.gates.limits, maxInstantOrderAedMinor: 9_996 };
        expect((await x.checkout.start(startInput(await quoteFixture(x, run, "INR"), "upi"))).ok).toBe(true);
        // Rounded down, 9_995.65 would sit exactly on a 9_995 cap; the strict direction refuses it.
        x.gates.limits = { ...x.gates.limits, maxInstantOrderAedMinor: 9_995 };
        expect(await x.checkout.start(startInput(await quoteFixture(x, run, "INR"), "upi"))).toEqual({ ok: false, reason: "order_over_limit" });
        expect(x.inr.callsOf("createSession")).toHaveLength(2);
      });

      it("INR with no usable FX row is refused (fx_input_missing); an AED order does not read it", async () => {
        const x = await h();
        x.gates.fx = null;
        expect(await x.checkout.start(startInput(await quoteFixture(x, run, "INR"), "upi"))).toEqual({ ok: false, reason: "fx_input_missing" });
        expect((await x.checkout.start(startInput(await quoteFixture(x, run, "AED"), "card"))).ok).toBe(true);
        expect(x.inr.callsOf("createSession")).toHaveLength(0);
      });

      it("a missing cap setting fails closed: the production reader's closed limits refuse every order", async () => {
        const x = await h();
        const { CLOSED_EXPOSURE_LIMITS } = await import("../exposure-limits");
        x.gates.limits = CLOSED_EXPOSURE_LIMITS;
        expect(await x.checkout.start(startInput(await quoteFixture(x, run, "AED"), "card"))).toEqual({ ok: false, reason: "exposure_cap" });
        expect(await x.checkout.start(startInput(await quoteFixture(x, run, "INR"), "upi"))).toEqual({ ok: false, reason: "exposure_cap" });
        expect(x.aed.callsOf("createSession")).toHaveLength(0);
        expect(x.inr.callsOf("createSession")).toHaveLength(0);
      });

      it("a multi-item quote counts as one order: every line under the cap, the total over it, is refused", async () => {
        const x = await h();
        const q = await quoteFixture(x, run, "AED", { items: 3 }); // 10_000 + 11_000 + 12_000
        expect(q.totalMinor).toBe(33_000n);
        x.gates.limits = { ...x.gates.limits, maxInstantOrderAedMinor: 32_999 };
        expect(await x.checkout.start(startInput(q, "card"))).toEqual({ ok: false, reason: "order_over_limit" });
        x.gates.limits = { ...x.gates.limits, maxInstantOrderAedMinor: 33_000 };
        expect((await x.checkout.start(startInput(q, "card"))).ok).toBe(true);
      });

      it("a cap lowered after the order was written refuses re-opening a session that was never stored", async () => {
        const x = await h();
        const q = await quoteFixture(x, run, "AED");
        x.aed.script("createSession", { kind: "throw" });
        expect(await x.checkout.start(startInput(q, "card"))).toEqual({ ok: false, reason: "payment_session_unavailable" });
        x.gates.limits = { ...x.gates.limits, maxInstantOrderAedMinor: 9_999 };
        expect(await x.checkout.start(startInput(q, "card"))).toEqual({ ok: false, reason: "order_over_limit" });
      });

      it("the production reader: no row, or a row without the cap, gives the closed limits", async () => {
        const { readExposureLimits, CLOSED_EXPOSURE_LIMITS, EXPOSURE_LIMITS_SETTING_KEY } = await import("../exposure-limits");
        const saved = await prisma.setting.findUnique({ where: { key: EXPOSURE_LIMITS_SETTING_KEY } });
        try {
          await prisma.setting.deleteMany({ where: { key: EXPOSURE_LIMITS_SETTING_KEY } });
          expect(await readExposureLimits()).toEqual(CLOSED_EXPOSURE_LIMITS);
          await prisma.setting.create({ data: { key: EXPOSURE_LIMITS_SETTING_KEY, value: { maxUncapturedHolds: 3, maxRiskyPaymentsPer15Min: 5 } } });
          expect(await readExposureLimits()).toEqual(CLOSED_EXPOSURE_LIMITS);
          await prisma.setting.update({ where: { key: EXPOSURE_LIMITS_SETTING_KEY }, data: { value: { maxInstantOrderAedMinor: 50_000 } } });
          expect(await readExposureLimits()).toEqual({ maxUncapturedHolds: 3, maxRiskyPaymentsPer15Min: 5, outlyFundedWindowDays: 30, outlyFundedCapMinor: { INR: 0, AED: 0 }, maxInstantOrderAedMinor: 50_000 });
        } finally {
          await prisma.setting.deleteMany({ where: { key: EXPOSURE_LIMITS_SETTING_KEY } });
          if (saved) await prisma.setting.create({ data: { key: saved.key, value: saved.value as object, updatedBy: saved.updatedBy } });
        }
      });
    });
  });

  describe("payment inbox", () => {
    it("stores a verified event once, as a digest; a duplicate is acknowledged and not reprocessed (F2)", async () => {
      const x = await h();
      const c = await checkedOut(x, run, "INR", "upi");
      const pid = c.gw.pay(c.providerOrderId);
      const w = c.gw.webhook("payment.captured", pid);
      const first = await x.inbox.receive("fake-inr-pacb", w.raw, w.headers);
      const second = await x.inbox.receive("fake-inr-pacb", w.raw, w.headers);
      expect(first.result).toBe("stored");
      expect(second).toEqual({ result: "duplicate", providerEventId: w.eventId });
      const rows = await prisma.paymentEvent.findMany({ where: { provider: "fake-inr-pacb", providerEventId: w.eventId } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "verified", type: "payment.captured", providerPaymentId: pid });
      expect(rows[0].payloadDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(rows[0])).not.toContain("payment_id");
      if (first.result !== "stored") throw new Error("not stored");
      expect(await x.inbox.processOne(first.id)).toBe("processed");
      expect(await x.inbox.processOne(first.id)).toBeNull();
      expect(x.engine.count("startAttempt")).toBe(1);
    });

    it("rejects a forged or tampered body and a stale signed timestamp, storing nothing", async () => {
      const x = await h();
      const before = await prisma.paymentEvent.count();
      const w = x.aed.webhook("payment.authorized", "pay_x");
      const tampered = new Uint8Array(w.raw);
      tampered[tampered.length - 2] ^= 1;
      expect((await x.inbox.receive("fake-aed-card", tampered, w.headers)).result).toBe("rejected");
      const forged = new Headers(w.headers);
      forged.set("x-fake-signature", `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`);
      expect((await x.inbox.receive("fake-aed-card", w.raw, forged)).result).toBe("rejected");
      const stale = x.aed.webhook("payment.authorized", "pay_x", { at: new Date(Date.now() - 10 * 60_000) });
      expect((await x.inbox.receive("fake-aed-card", stale.raw, stale.headers)).result).toBe("rejected");
      const inr = x.inr.webhook("payment.captured", "pay_y");
      expect((await x.inbox.receive("fake-inr-pacb", inr.raw, new Headers())).result).toBe("rejected");
      expect((await x.inbox.receive("not-a-provider", inr.raw, inr.headers)).result).toBe("not_found");
      expect(await prisma.paymentEvent.count()).toBe(before);
    });

    it("a replayed body-signed event (no timestamp) is stopped by its event id (F2)", async () => {
      const x = await h();
      const c = await checkedOut(x, run, "INR", "upi");
      const pid = c.gw.pay(c.providerOrderId);
      const first = await deliver(x, c.gw, "payment.captured", pid, { eventId: `evt_replay_${run}` });
      const replay = await x.inbox.receive("fake-inr-pacb", first.webhook.raw, first.webhook.headers);
      expect(replay.result).toBe("duplicate");
      expect(x.engine.count("startAttempt")).toBe(1);
    });

    it("an older event processed after a newer one changes nothing (out of order)", async () => {
      const x = await h();
      const c = await checkedOut(x, run, "AED", "card");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      x.engine.reserve(c.orderItemId);
      await x.saga.notifier.bookingChanged(c.orderItemId, "awaiting_payment");
      await x.saga.notifier.bookingChanged(c.orderItemId, "confirmed");
      expect((await sagaState(x, c.sagaId)).state).toBe("fulfilled");
      // A late "authorized" event from before the capture: the read says captured, nothing moves.
      await deliver(x, c.gw, "payment.authorized", pid);
      expect((await sagaState(x, c.sagaId)).state).toBe("fulfilled");
      expect(x.aed.callsOf("capture")).toHaveLength(1);
      expect(x.engine.count("startAttempt")).toBe(1);
    });

    it("acts on the provider's read, never on the webhook body", async () => {
      const x = await h();
      const c = await checkedOut(x, run, "AED", "card");
      const pid = c.gw.pay(c.providerOrderId, { outcome: "requires_action" });
      await deliver(x, c.gw, "payment.captured", pid);
      // The body said captured; the provider says the customer has not finished 3DS.
      expect((await sagaState(x, c.sagaId)).state).toBe("session_created");
      expect(x.engine.count("startAttempt")).toBe(0);
    });

    it("a processing failure is retryable with backoff, then processed (F30)", async () => {
      const x = await h();
      const c = await checkedOut(x, run, "INR", "upi");
      const pid = c.gw.pay(c.providerOrderId);
      c.gw.script("getPayment", { kind: "unknown", sent: true, applied: false });
      const w = c.gw.webhook("payment.captured", pid);
      const r = await x.inbox.receive("fake-inr-pacb", w.raw, w.headers);
      if (r.result !== "stored") throw new Error("not stored");
      expect(await x.inbox.processOne(r.id)).toBe("processing_failed");
      const failed = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: r.id } });
      expect(failed).toMatchObject({ state: "processing_failed", lastErrorCode: "provider_read_unknown", attempts: 1, processedAt: null });
      expect(failed.nextAttemptAt!.getTime()).toBeGreaterThan(x.clock.now().getTime());
      // Not due yet.
      expect(await x.inbox.processOne(r.id)).toBeNull();
      x.clock.advance(5 * 60_000);
      expect(await x.inbox.processOne(r.id)).toBe("processed");
      expect((await sagaState(x, c.sagaId)).state).toBe("reserve_pending");
    });

    it("a payment on an account, currency or amount other than the one bound stops in attention and moves no money (F2)", async () => {
      for (const over of [{ accountId: "someone-else" }, { currency: "INR" as const }, { amountMinor: 9_999n }]) {
        const x = await h();
        const c = await checkedOut(x, run, "AED", "card");
        const pid = c.gw.pay(c.providerOrderId, over);
        await deliver(x, c.gw, "payment.authorized", pid);
        const s = await sagaState(x, c.sagaId);
        expect(s.attentionRequiredAt).not.toBeNull();
        expect(s.payment!.gatewayPaymentId).toBeNull();
        expect(x.engine.count("startAttempt")).toBe(0);
        expect(x.aed.callsOf("capture")).toHaveLength(0);
      }
    });
  });
});
