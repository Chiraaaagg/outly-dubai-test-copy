import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dbEnabled, runId } from "../../__tests__/helpers/fixtures";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import { checkedOut, cleanupB3, deliver, harness, sagaState, type Harness } from "./_b3-harness";

/**
 * The payment saga on Postgres against fake gateways and a fake engine
 * (doc 22 §26 F1, F3, F4, F5, F9, F10, F16, F29, F42–F46, F56; PAY-2,
 * PAY-6). Imported by evidence.test.ts (the payments db suite). Synthetic
 * amounts: AED 10_000 fils, INR 230_000 paise.
 */

type Prisma = typeof import("../../lib/db").prisma;

describe.skipIf(!dbEnabled)("B3 payment saga (disposable database)", () => {
  let prisma: Prisma;
  let paymentEvidenceFrom: typeof import("../evidence").paymentEvidenceFrom;
  let openRefund: typeof import("../refunds").openRefund;
  let refundableMinor: typeof import("../refunds").refundableMinor;
  let runPaymentsTick: typeof import("../inbox").runPaymentsTick;
  const run = runId();

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    await cleanupB3(prisma);
    ({ paymentEvidenceFrom } = await import("../evidence"));
    ({ openRefund, refundableMinor } = await import("../refunds"));
    ({ runPaymentsTick } = await import("../inbox"));
  });

  afterAll(async () => {
    await cleanupB3(prisma);
  });

  async function ledgerOf(paymentId: string) {
    const rows = await prisma.ledgerEntry.findMany({ where: { paymentId, book: "customer_money" }, orderBy: { createdAt: "asc" } });
    return { kinds: rows.map((r) => r.kind), sum: rows.reduce((s, r) => s + r.amountMinor, 0n), refs: rows.map((r) => r.evidenceRef) };
  }

  async function remediesOf(orderItemId: string) {
    return prisma.customerRemedy.findMany({ where: { orderItemId }, orderBy: { createdAt: "asc" } });
  }

  const evidence = (orderItemId: string) => paymentEvidenceFrom(prisma).capturedFor(orderItemId);

  /** The engine reserved; tell the saga, then report the confirm (the fake engine settles it at once). */
  async function reserveAndConfirm(x: Harness, orderItemId: string) {
    x.engine.reserve(orderItemId);
    await x.saga.notifier.bookingChanged(orderItemId, "awaiting_payment");
    await x.saga.notifier.bookingChanged(orderItemId, x.engine.bookings.get(orderItemId)!.state);
  }

  describe("happy paths on both rails", () => {
    it("F1: AED card hold → reserve → capture → confirm, driven by the job with no browser", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card");
      const pid = c.gw.pay(c.providerOrderId);
      const w = c.gw.webhook("payment.authorized", pid);
      expect((await x.inbox.receive("fake-aed-card", w.raw, w.headers)).result).toBe("stored");
      // The job may meet older due rows first; run it until this event is done.
      for (let i = 0; i < 10 && (await sagaState(x, c.sagaId)).state === "session_created"; i++) await runPaymentsTick(x.inbox, x.saga);
      expect((await sagaState(x, c.sagaId)).state).toBe("reserve_pending");
      // Reserve and capture: no capture before the reservation exists.
      expect(x.aed.callsOf("capture")).toHaveLength(0);
      expect(await evidence(c.orderItemId)).toBeNull();
      x.engine.reserve(c.orderItemId);
      await runPaymentsTick(x.inbox, x.saga);
      await runPaymentsTick(x.inbox, x.saga);
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("fulfilled");
      expect(s.payment).toMatchObject({ status: "captured", capturedMinor: 10_000n, threeDs: "passed", risk: "normal" });
      expect(x.aed.callsOf("capture")).toEqual([[pid, 10_000n, `capture:${c.paymentId}`]]);
      expect(x.engine.confirmsSent).toBe(1);
      expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "confirmed" });
      const l = await ledgerOf(c.paymentId);
      expect(l).toMatchObject({ kinds: ["capture"], sum: 10_000n });
      expect(l.refs[0]).toBe(`capture:test:fake-aed-card:${pid}:10000`);
      expect(await evidence(c.orderItemId)).toMatchObject({ paymentId: c.paymentId, capturedMinor: 10_000n, currency: "AED" });
    });

    it("INR UPI is capture-first: captured → reserve → confirm", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "upi");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.captured", pid);
      expect((await sagaState(x, c.sagaId)).state).toBe("reserve_pending");
      expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "paid" });
      await reserveAndConfirm(x, c.orderItemId);
      expect((await sagaState(x, c.sagaId)).state).toBe("fulfilled");
      expect(x.inr.callsOf("capture")).toHaveLength(0);
      expect((await ledgerOf(c.paymentId)).sum).toBe(230_000n);
    });

    it("INR card debits at authorization: it is captured before the reserve", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "card");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      expect(x.inr.callsOf("capture")).toHaveLength(1);
      expect(x.engine.count("startAttempt")).toBe(1);
      expect((await sagaState(x, c.sagaId)).state).toBe("reserve_pending");
      await reserveAndConfirm(x, c.orderItemId);
      expect((await sagaState(x, c.sagaId)).state).toBe("fulfilled");
    });
  });

  describe("capture faults", () => {
    it("F3: a capture timeout is capture_unknown; the same payment is re-read, never charged again", async () => {
      for (const applied of [true, false]) {
        const x = await harness(prisma);
        const c = await checkedOut(x, run, "AED", "card");
        const pid = c.gw.pay(c.providerOrderId);
        await deliver(x, c.gw, "payment.authorized", pid);
        // Reads: before reserve, before capture; then the one after the lost answer is also lost.
        c.gw.script("getPayment", { kind: "pass" }, { kind: "pass" }, { kind: "unknown", sent: true, applied: false });
        c.gw.script("capture", { kind: "unknown", sent: true, applied });
        x.engine.reserve(c.orderItemId);
        await x.saga.notifier.bookingChanged(c.orderItemId, "awaiting_payment");
        const s = await sagaState(x, c.sagaId);
        expect(s.state).toBe("capture_unknown");
        expect(s.payment!.status).toBe("capture_unknown");
        expect(x.aed.callsOf("void")).toHaveLength(0);
        await x.saga.advance(c.sagaId);
        await x.saga.notifier.bookingChanged(c.orderItemId, "confirmed");
        expect((await sagaState(x, c.sagaId)).state).toBe("fulfilled");
        const keys = x.aed.callsOf("capture").map((a) => a[2]);
        expect(new Set(keys)).toEqual(new Set([`capture:${c.paymentId}`]));
        expect(x.aed.payments.get(pid)!.capturedMinor).toBe(10_000n);
        expect(x.engine.confirmsSent).toBe(1);
      }
    });

    it("F9 / PAY-2 / F10: capture unknown at the hold deadline never confirms; the hold is released; a capture found later is refunded", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      c.gw.script("getPayment", { kind: "pass" }, { kind: "pass" }, { kind: "unknown", sent: true, applied: false });
      c.gw.script("capture", { kind: "unknown", sent: true, applied: true });
      x.engine.reserve(c.orderItemId);
      await x.saga.notifier.bookingChanged(c.orderItemId, "awaiting_payment");
      expect((await sagaState(x, c.sagaId)).state).toBe("capture_unknown");
      const bookingId = x.engine.bookings.get(c.orderItemId)!.id;
      // F10: the engine's evidence re-read refuses while capture is unresolved.
      expect(await evidence(c.orderItemId)).toBeNull();
      expect(await x.engine.confirmIfPaid(bookingId)).toBe("not_ready");

      c.gw.readsUnavailable = true;
      x.clock.advance(11 * 60_000);
      await x.saga.advance(c.sagaId);
      expect((await sagaState(x, c.sagaId)).state).toBe("release_pending");
      expect(x.engine.calls.filter((k) => k.op === "releaseHold").map((k) => k.reason)).toEqual(["capture_unknown_at_deadline"]);
      expect(x.engine.bookings.get(c.orderItemId)!.state).toBe("cancelled");

      // The provider comes back: the capture had landed. Refund it automatically.
      c.gw.readsUnavailable = false;
      await x.saga.advance(c.sagaId);
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("refunded");
      expect(x.engine.confirmsSent).toBe(0);
      expect(x.engine.count("startAttempt")).toBe(1);
      expect(await ledgerOf(c.paymentId)).toMatchObject({ kinds: ["capture", "refund"], sum: 0n });
      expect(await evidence(c.orderItemId)).toBeNull();
      expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "refunded" });
    });
  });

  describe("supplier failures and their remedies (never supplier writes)", () => {
    it("F4: card authorized, reserve rejected: the hold is voided and the remedy closed", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      x.engine.reserve(c.orderItemId, "rejected");
      await x.saga.notifier.bookingChanged(c.orderItemId, "rejected");
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("released");
      expect(s.payment).toMatchObject({ status: "voided", capturedMinor: 0n });
      expect(s.payment!.voidedAt).not.toBeNull();
      expect(x.aed.callsOf("capture")).toHaveLength(0);
      expect(x.aed.callsOf("void")).toEqual([[pid, `void:${c.paymentId}`]]);
      expect((await remediesOf(c.orderItemId)).map((r) => [r.kind, r.status, r.supplierBookingId])).toEqual([["release_authorization", "completed", x.engine.bookings.get(c.orderItemId)!.id]]);
      expect(await prisma.refund.count({ where: { paymentId: c.paymentId } })).toBe(0);
      expect((await ledgerOf(c.paymentId)).kinds).toEqual([]);
      // The remedy asked nothing of the engine beyond the attempt itself, and never wrote the attempt row.
      expect(x.engine.calls.map((k) => k.op)).toEqual(["startAttempt"]);
      const row = await prisma.supplierBooking.findUniqueOrThrow({ where: { id: x.engine.bookings.get(c.orderItemId)!.id } });
      expect(row).toMatchObject({ state: "queued", errorCode: null, attentionRequiredAt: null });
      expect(row.updatedAt.getTime()).toBe(row.createdAt.getTime());
      expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "payment_failed" });
    });

    it("F5: UPI paid, reserve rejected: full automatic refund tracked to success", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "upi");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.captured", pid);
      x.engine.reserve(c.orderItemId, "rejected");
      await x.saga.notifier.bookingChanged(c.orderItemId, "rejected");
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("refunded");
      expect(s.payment).toMatchObject({ status: "refunded", capturedMinor: 230_000n, refundedMinor: 230_000n });
      const refunds = await prisma.refund.findMany({ where: { paymentId: c.paymentId } });
      expect(refunds.map((r) => [r.status, r.amountMinor, r.reason, r.outlyFunded])).toEqual([["succeeded", 230_000n, "reserve_rejected", false]]);
      expect((await remediesOf(c.orderItemId)).map((r) => [r.kind, r.status])).toEqual([["refund", "completed"]]);
      expect(await ledgerOf(c.paymentId)).toMatchObject({ kinds: ["capture", "refund"], sum: 0n });
      expect(x.inr.callsOf("refund")).toHaveLength(1);
    });

    it("F43: captured, then confirm definitively rejected: refund of the item allocation", async () => {
      const x = await harness(prisma);
      x.engine.confirmOutcome = "rejected";
      const c = await checkedOut(x, run, "INR", "upi");
      await deliver(x, c.gw, "payment.captured", c.gw.pay(c.providerOrderId));
      await reserveAndConfirm(x, c.orderItemId);
      expect((await sagaState(x, c.sagaId)).state).toBe("refunded");
      expect(x.engine.confirmsSent).toBe(1);
      expect((await prisma.refund.findFirstOrThrow({ where: { paymentId: c.paymentId } })).reason).toBe("confirm_rejected");
    });

    it("F44: captured, but the deadline gate refuses the send: the hold is released and the money refunded", async () => {
      const x = await harness(prisma);
      x.engine.confirmOutcome = "too_late";
      const c = await checkedOut(x, run, "AED", "card");
      await deliver(x, c.gw, "payment.authorized", c.gw.pay(c.providerOrderId));
      x.engine.reserve(c.orderItemId);
      await x.saga.notifier.bookingChanged(c.orderItemId, "awaiting_payment");
      expect((await sagaState(x, c.sagaId)).state).toBe("refunded");
      expect(x.engine.confirmsSent).toBe(0);
      expect(x.engine.calls.filter((k) => k.op === "releaseHold").map((k) => k.reason)).toEqual(["confirm_too_late"]);
    });

    it("F42: confirm sent with no answer is never re-confirmed; past the deadline a human is told and no money moves", async () => {
      const x = await harness(prisma);
      x.engine.confirmOutcome = "unknown";
      const c = await checkedOut(x, run, "AED", "card");
      await deliver(x, c.gw, "payment.authorized", c.gw.pay(c.providerOrderId));
      await reserveAndConfirm(x, c.orderItemId);
      await x.saga.advance(c.sagaId);
      expect(await sagaState(x, c.sagaId)).toMatchObject({ state: "confirm_pending", attentionRequiredAt: null });
      x.clock.advance(20 * 60_000);
      await x.saga.advance(c.sagaId);
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("confirm_pending");
      expect(s.attentionRequiredAt).not.toBeNull();
      expect(x.engine.confirmsSent).toBe(1);
      expect(x.engine.count("confirmIfPaid")).toBe(1);
      expect(await prisma.refund.count({ where: { paymentId: c.paymentId } })).toBe(0);
    });

    it("doc 29 Batch 6 (review 89 B6-13): an external item whose confirm was sent gets no deadline flag in recovery; an internal one still does", async () => {
      for (const state of ["confirming", "outcome_unknown", "awaiting_external"]) {
        const x = await harness(prisma);
        x.engine.confirmOutcome = "unknown";
        const c = await checkedOut(x, run, "AED", "card");
        x.engine.external.add(c.orderItemId);
        await deliver(x, c.gw, "payment.authorized", c.gw.pay(c.providerOrderId));
        await reserveAndConfirm(x, c.orderItemId);
        x.engine.set(c.orderItemId, state);
        x.clock.advance(20 * 60_000);
        await x.saga.advance(c.sagaId);
        expect(await sagaState(x, c.sagaId), state).toMatchObject({ state: "confirm_pending", attentionRequiredAt: null });
        expect(await prisma.refund.count({ where: { paymentId: c.paymentId } })).toBe(0);
      }
      const x = await harness(prisma);
      x.engine.confirmOutcome = "unknown";
      const c = await checkedOut(x, run, "AED", "card");
      await deliver(x, c.gw, "payment.authorized", c.gw.pay(c.providerOrderId));
      await reserveAndConfirm(x, c.orderItemId);
      x.engine.set(c.orderItemId, "outcome_unknown");
      x.clock.advance(20 * 60_000);
      await x.saga.advance(c.sagaId);
      expect((await sagaState(x, c.sagaId)).attentionRequiredAt).not.toBeNull();
    });

    it("an engine intake refusal after capture (paused between payment and reserve) refunds", async () => {
      const x = await harness(prisma);
      x.engine.refuseIntake = true;
      const c = await checkedOut(x, run, "INR", "upi");
      await deliver(x, c.gw, "payment.captured", c.gw.pay(c.providerOrderId));
      expect((await sagaState(x, c.sagaId)).state).toBe("refunded");
      expect(x.engine.bookings.size).toBe(0);
    });
  });

  describe("refunds", () => {
    it("F16: an accepted refund is tracked to success, and a failed one goes to a human", async () => {
      for (const outcome of ["succeeded", "failed"] as const) {
        const x = await harness(prisma, { refundsSettle: "manual" });
        const c = await checkedOut(x, run, "INR", "upi");
        const pid = c.gw.pay(c.providerOrderId);
        await deliver(x, c.gw, "payment.captured", pid);
        x.engine.reserve(c.orderItemId, "rejected");
        await x.saga.notifier.bookingChanged(c.orderItemId, "rejected");
        expect((await sagaState(x, c.sagaId)).state).toBe("refund_pending");
        const r = await prisma.refund.findFirstOrThrow({ where: { paymentId: c.paymentId } });
        expect(r.status).toBe("accepted");
        c.gw.settleRefund(r.providerRefundId!, outcome);
        await deliver(x, c.gw, "refund.processed", pid);
        const s = await sagaState(x, c.sagaId);
        expect(s.state).toBe(outcome === "succeeded" ? "refunded" : "attention");
        expect((await prisma.refund.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(outcome);
        expect((await remediesOf(c.orderItemId)).map((m) => m.status)).toEqual([outcome === "succeeded" ? "completed" : "failed"]);
        expect((await ledgerOf(c.paymentId)).sum).toBe(outcome === "succeeded" ? 0n : 230_000n);
      }
    });

    it("an unknown refund answer is re-sent with the same key, never a new one", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "upi");
      await deliver(x, c.gw, "payment.captured", c.gw.pay(c.providerOrderId));
      c.gw.script("refund", { kind: "unknown", sent: true, applied: true });
      x.engine.reserve(c.orderItemId, "rejected");
      await x.saga.notifier.bookingChanged(c.orderItemId, "rejected");
      await x.saga.advance(c.sagaId);
      expect((await sagaState(x, c.sagaId)).state).toBe("refunded");
      const keys = x.inr.callsOf("refund").map((a) => a[2]);
      expect(keys.length).toBeGreaterThanOrEqual(2);
      expect(new Set(keys).size).toBe(1);
      expect(x.inr.refunds.size).toBe(1);
    });

    it("refund cap: never above the captured amount, in code and in the database", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "upi");
      await deliver(x, c.gw, "payment.captured", c.gw.pay(c.providerOrderId));
      const base = { paymentId: c.paymentId, orderId: c.r.orderId, orderItemId: c.orderItemId, kind: "refund" as const, reason: "zz-b3 cap", currency: "INR" as const, supplierBookingId: null, outlyFunded: false };
      await expect(prisma.$transaction((tx) => openRefund(tx, { ...base, amountMinor: 230_001n }))).rejects.toMatchObject({ reason: "refund_cap" });
      await prisma.$transaction((tx) => openRefund(tx, { ...base, amountMinor: 200_000n }));
      await expect(prisma.$transaction((tx) => openRefund(tx, { ...base, amountMinor: 30_001n }))).rejects.toMatchObject({ reason: "refund_cap" });
      await expect(prisma.$transaction((tx) => openRefund(tx, { ...base, amountMinor: 1n, currency: "AED" }))).rejects.toMatchObject({ reason: "refund_cap" });
      // The trigger refuses a direct write too.
      const { uuidv7 } = await import("../../lib/ids");
      await expect(
        prisma.refund.create({ data: { id: uuidv7(), paymentId: c.paymentId, orderItemId: c.orderItemId, provider: "fake-inr-pacb", idempotencyKey: `zz-b3-${uuidv7()}`, amountMinor: 30_001n, currency: "INR", reason: "zz-b3 direct" } }),
      ).rejects.toThrow(/refunds: non-failed refunds would total/);
    });
  });

  describe("risk, late and duplicate payments, disputes", () => {
    it("F29: a failed 3DS or an elevated risk outcome never reserves; the money goes back", async () => {
      const x = await harness(prisma);
      const card = await checkedOut(x, run, "AED", "card");
      await deliver(x, card.gw, "payment.authorized", card.gw.pay(card.providerOrderId, { threeDs: "failed" }));
      expect((await sagaState(x, card.sagaId)).state).toBe("released");
      const upi = await checkedOut(x, run, "INR", "upi");
      await deliver(x, upi.gw, "payment.captured", upi.gw.pay(upi.providerOrderId, { risk: "elevated" }));
      expect((await sagaState(x, upi.sagaId)).state).toBe("refunded");
      expect(x.engine.count("startAttempt")).toBe(0);
      expect(await prisma.refund.findFirstOrThrow({ where: { paymentId: upi.paymentId } })).toMatchObject({ reason: "risk_refused" });
    });

    it("F46: payment after the quote expired is refunded (UPI) or released (card), never booked", async () => {
      const x = await harness(prisma);
      const upi = await checkedOut(x, run, "INR", "upi", { ttlMs: 3 * 60_000 });
      const card = await checkedOut(x, run, "AED", "card", { ttlMs: 3 * 60_000 });
      x.clock.advance(4 * 60_000);
      // The pages closed with the quote (CR-B3-7); these payments were in flight at the expiry and the provider took them anyway.
      await deliver(x, upi.gw, "payment.captured", upi.gw.pay(upi.providerOrderId, { afterExpiry: true }));
      await deliver(x, card.gw, "payment.authorized", card.gw.pay(card.providerOrderId, { afterExpiry: true }));
      expect((await sagaState(x, upi.sagaId)).state).toBe("refunded");
      expect((await sagaState(x, card.sagaId)).state).toBe("released");
      expect(x.engine.count("startAttempt")).toBe(0);
      expect((await prisma.refund.findFirstOrThrow({ where: { paymentId: upi.paymentId } })).reason).toBe("late_payment");
    });

    it("late webhook after release: a capture that appears on a released saga is refunded", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "card");
      const pid = c.gw.pay(c.providerOrderId, { threeDs: "failed" });
      await deliver(x, c.gw, "payment.authorized", pid);
      // Debited at authorization: released means waiting for the provider's automatic return.
      expect((await sagaState(x, c.sagaId)).state).toBe("release_pending");
      // The provider captured after all.
      const p = c.gw.payments.get(pid)!;
      p.status = "captured";
      p.capturedMinor = p.amountMinor;
      await deliver(x, c.gw, "payment.captured", pid);
      expect((await sagaState(x, c.sagaId)).state).toBe("refunded");
      expect(x.engine.count("startAttempt")).toBe(0);
    });

    it("F45: a second payment on the same order is refunded and fulfils nothing", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "upi");
      const first = c.gw.pay(c.providerOrderId);
      const second = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.captured", first);
      await deliver(x, c.gw, "payment.captured", second);
      await reserveAndConfirm(x, c.orderItemId);
      expect((await sagaState(x, c.sagaId)).state).toBe("fulfilled");
      const payments = await prisma.payment.findMany({ where: { orderId: c.r.orderId }, include: { refunds: true, saga: true } });
      expect(payments).toHaveLength(2);
      const dup = payments.find((p) => p.gatewayPaymentId === second)!;
      expect(dup.saga).toBeNull();
      expect(dup).toMatchObject({ source: "gateway_verified", status: "refunded", refundedMinor: 230_000n, providerOrderId: null, gatewayOrderId: c.providerOrderId });
      expect(dup.refunds.map((r) => [r.reason, r.status])).toEqual([["duplicate_payment", "succeeded"]]);
      expect(x.engine.count("startAttempt")).toBe(1);
      expect(await evidence(c.orderItemId)).toMatchObject({ paymentId: c.paymentId });
    });

    it("F56: a dispute is recorded, flags the saga, freezes refunds and automates nothing else", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "upi");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.captured", pid);
      await reserveAndConfirm(x, c.orderItemId);
      const d = await deliver(x, c.gw, "dispute.opened", pid);
      expect(d.result).toBe("stored");
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("fulfilled");
      expect(s.attentionRequiredAt).not.toBeNull();
      expect(await prisma.paymentEvent.count({ where: { provider: "fake-inr-pacb", providerPaymentId: pid, type: "dispute.opened", state: "processed" } })).toBe(1);
      await expect(
        prisma.$transaction((tx) => openRefund(tx, { paymentId: c.paymentId, orderId: c.r.orderId, orderItemId: c.orderItemId, kind: "refund", reason: "zz-b3", amountMinor: 1n, currency: "INR", supplierBookingId: null, outlyFunded: false })),
      ).rejects.toMatchObject({ reason: "refunds_frozen" });
      expect(x.inr.callsOf("refund")).toHaveLength(0);
      // Flagged for a human: no longer evidence for any confirm.
      expect(await evidence(c.orderItemId)).toBeNull();
    });
  });

  describe("independent review B3 (CR-B3-1 to CR-B3-10)", () => {
    const refundsOf = (paymentId: string) => prisma.refund.findMany({ where: { paymentId }, orderBy: { createdAt: "asc" } });

    it("CR-B3-1: a confirm sent while the saga judged it too late is never refunded: confirmed keeps the capture, a failure refunds", async () => {
      for (const outcome of ["confirmed", "rejected"] as const) {
        const x = await harness(prisma);
        x.engine.confirmOutcome = "too_late";
        const c = await checkedOut(x, run, "AED", "card");
        await deliver(x, c.gw, "payment.authorized", c.gw.pay(c.providerOrderId));
        // The worker's send commits between the saga's too-late answer and its release request.
        x.engine.onRelease = (b) => {
          if (!b.confirmSent) x.engine.sendConfirm(c.orderItemId);
        };
        x.engine.reserve(c.orderItemId);
        await x.saga.notifier.bookingChanged(c.orderItemId, "awaiting_payment");
        let s = await sagaState(x, c.sagaId);
        expect(s.state).toBe("confirm_pending");
        expect(s.payment).toMatchObject({ status: "captured", capturedMinor: 10_000n });
        expect(x.engine.calls.filter((k) => k.op === "releaseHold").map((k) => k.reason)).toEqual(["confirm_too_late"]);
        expect(await refundsOf(c.paymentId)).toEqual([]);
        expect(await remediesOf(c.orderItemId)).toEqual([]);
        // More ticks while the supplier has not answered: still no money moves.
        await x.saga.advance(c.sagaId);
        expect(await refundsOf(c.paymentId)).toEqual([]);

        x.engine.set(c.orderItemId, outcome);
        await x.saga.notifier.bookingChanged(c.orderItemId, outcome);
        s = await sagaState(x, c.sagaId);
        if (outcome === "confirmed") {
          expect(s.state).toBe("fulfilled");
          expect(await refundsOf(c.paymentId)).toEqual([]);
          expect((await ledgerOf(c.paymentId)).sum).toBe(10_000n);
          expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "confirmed" });
        } else {
          expect(s.state).toBe("refunded");
          expect((await refundsOf(c.paymentId)).map((r) => [r.reason, r.status])).toEqual([["confirm_rejected", "succeeded"]]);
        }
        expect(x.engine.confirmsSent).toBe(1);
      }
    });

    it("CR-B3-1: money goes back only after the engine shows the hold released", async () => {
      const x = await harness(prisma);
      x.engine.confirmOutcome = "too_late";
      x.engine.releaseVerifies = "later";
      const c = await checkedOut(x, run, "AED", "card");
      await deliver(x, c.gw, "payment.authorized", c.gw.pay(c.providerOrderId));
      x.engine.reserve(c.orderItemId);
      await x.saga.notifier.bookingChanged(c.orderItemId, "awaiting_payment");
      expect((await sagaState(x, c.sagaId)).state).toBe("release_pending");
      // The cancel is on its way: a refund is recorded as waiting, nothing is sent.
      const [waiting] = await remediesOf(c.orderItemId);
      expect(waiting).toMatchObject({ kind: "refund", status: "pending", refundId: null, reason: "confirm_too_late", supplierBookingId: x.engine.bookings.get(c.orderItemId)!.id });
      await x.saga.advance(c.sagaId);
      expect(await refundsOf(c.paymentId)).toEqual([]);
      expect(x.aed.callsOf("refund")).toHaveLength(0);

      x.engine.set(c.orderItemId, "cancelled");
      await x.saga.notifier.bookingChanged(c.orderItemId, "cancelled");
      expect((await sagaState(x, c.sagaId)).state).toBe("refunded");
      const refunds = await refundsOf(c.paymentId);
      expect(refunds.map((r) => [r.reason, r.status, r.amountMinor])).toEqual([["confirm_too_late", "succeeded", 10_000n]]);
      // The same remedy row carries the refund.
      expect((await remediesOf(c.orderItemId)).map((m) => [m.id, m.kind, m.status, m.refundId])).toEqual([[waiting.id, "refund", "completed", refunds[0].id]]);
      expect(x.engine.confirmsSent).toBe(0);
    });

    it("CR-B3-2: a late capture whose provider read fails while its webhook is processed stays retryable, then is refunded", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "upi");
      x.clock.advance(41 * 60_000);
      await x.saga.advance(c.sagaId);
      expect((await sagaState(x, c.sagaId)).state).toBe("failed");
      const pid = c.gw.pay(c.providerOrderId, { afterExpiry: true });
      // The event's own read works; the saga's read while acting on it does not.
      c.gw.script("getPayment", { kind: "pass" }, { kind: "unknown", sent: true, applied: false });
      const w = c.gw.webhook("payment.captured", pid);
      const r = await x.inbox.receive(c.gw.provider, w.raw, w.headers);
      if (r.result !== "stored") throw new Error("not stored");
      expect(await x.inbox.processOne(r.id)).toBe("processing_failed");
      expect(await prisma.paymentEvent.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ state: "processing_failed", lastErrorCode: "provider_read_unknown", processedAt: null });
      expect(await refundsOf(c.paymentId)).toEqual([]);
      x.clock.advance(5 * 60_000);
      expect(await x.inbox.processOne(r.id)).toBe("processed");
      expect((await sagaState(x, c.sagaId)).state).toBe("refunded");
      expect((await refundsOf(c.paymentId)).map((f) => [f.reason, f.status])).toEqual([["late_payment", "succeeded"]]);
      expect(x.engine.count("startAttempt")).toBe(0);
    });

    it("CR-B3-2: the job keeps reading a released saga: a capture with no webhook is refunded", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "card");
      const pid = c.gw.pay(c.providerOrderId, { threeDs: "failed" });
      await deliver(x, c.gw, "payment.authorized", pid);
      expect((await sagaState(x, c.sagaId)).state).toBe("release_pending");
      // The provider released the debit on its own; then captured after all, and sent nothing.
      const p = c.gw.payments.get(pid)!;
      p.status = "voided";
      await x.saga.advance(c.sagaId);
      expect((await sagaState(x, c.sagaId)).state).toBe("released");
      p.status = "captured";
      p.capturedMinor = p.amountMinor;
      await runPaymentsTick(x.inbox, x.saga);
      expect((await sagaState(x, c.sagaId)).state).toBe("refunded");
      expect((await refundsOf(c.paymentId)).map((f) => f.reason)).toEqual(["late_payment"]);
    });

    it("CR-B3-3 / F1: a captured UPI payment whose webhooks are all lost is found by reconciliation and processed", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "upi");
      const pid = c.gw.pay(c.providerOrderId);
      await runPaymentsTick(x.inbox, x.saga);
      // Too early to ask the provider.
      expect((await sagaState(x, c.sagaId)).state).toBe("session_created");
      expect(x.inr.callsOf("listPaymentsForOrder").filter((a) => a[0] === c.providerOrderId)).toHaveLength(0);
      x.clock.advance(3 * 60_000);
      await runPaymentsTick(x.inbox, x.saga);
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("reserve_pending");
      expect(s.payment).toMatchObject({ gatewayPaymentId: pid, status: "captured", capturedMinor: 230_000n });
      expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "paid" });
      expect(x.engine.count("startAttempt")).toBe(1);
    });

    it("CR-B3-3: at the session deadline an unreadable provider flags a human instead of failing the order; the money is found later", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "upi");
      c.gw.pay(c.providerOrderId);
      c.gw.readsUnavailable = true;
      x.clock.advance(41 * 60_000);
      await runPaymentsTick(x.inbox, x.saga);
      let s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("session_created");
      expect(s.attentionRequiredAt).not.toBeNull();
      expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "pending_payment" });
      c.gw.readsUnavailable = false;
      await runPaymentsTick(x.inbox, x.saga);
      s = await sagaState(x, c.sagaId);
      // Paid in time, but known only long after the quote: refunded, never booked (§22.2).
      expect(s.state).toBe("refunded");
      expect((await refundsOf(c.paymentId)).map((f) => f.reason)).toEqual(["late_payment"]);
      expect(x.engine.count("startAttempt")).toBe(0);
    });

    it("CR-B3-4: a declined attempt binds nothing; the next successful attempt is the payment; only a later success is a duplicate", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card");
      const declined = c.gw.pay(c.providerOrderId, { outcome: "failed" });
      await deliver(x, c.gw, "payment.failed", declined);
      let s = await sagaState(x, c.sagaId);
      expect(s).toMatchObject({ state: "session_created", attentionRequiredAt: null });
      expect(s.payment!.gatewayPaymentId).toBeNull();
      expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "pending_payment" });

      const ok = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", ok);
      s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("reserve_pending");
      expect(s.payment!.gatewayPaymentId).toBe(ok);
      await reserveAndConfirm(x, c.orderItemId);
      expect((await sagaState(x, c.sagaId)).state).toBe("fulfilled");

      // A second successful payment on the same order is the duplicate: voided and recorded; the order is left alone.
      const second = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", second);
      s = await sagaState(x, c.sagaId);
      expect(s).toMatchObject({ state: "fulfilled", attentionRequiredAt: null });
      const payments = await prisma.payment.findMany({ where: { orderId: c.r.orderId }, include: { saga: true } });
      expect(payments.map((p) => p.gatewayPaymentId).sort()).toEqual([ok, second].sort());
      const dup = payments.find((p) => p.gatewayPaymentId === second)!;
      expect(dup).toMatchObject({ status: "voided", saga: null });
      expect(x.aed.callsOf("void")).toEqual([[second, `void:${dup.id}`]]);
      expect(x.aed.callsOf("capture")).toEqual([[ok, 10_000n, `capture:${c.paymentId}`]]);
      expect(await refundsOf(c.paymentId)).toEqual([]);
    });

    it("CR-B3-10: a mismatched second payment is quarantined for finance and leaves the bound order alone", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card");
      await deliver(x, c.gw, "payment.authorized", c.gw.pay(c.providerOrderId));
      const odd = c.gw.pay(c.providerOrderId, { amountMinor: 9_999n });
      await deliver(x, c.gw, "payment.authorized", odd);
      expect(await sagaState(x, c.sagaId)).toMatchObject({ state: "reserve_pending", attentionRequiredAt: null });
      const dup = await prisma.payment.findFirstOrThrow({ where: { orderId: c.r.orderId, gatewayPaymentId: odd } });
      expect(dup).toMatchObject({ failureCode: "quarantined_amount_mismatch", amountMinor: 9_999n, status: "created" });
      await runPaymentsTick(x.inbox, x.saga);
      expect(x.aed.callsOf("void")).toHaveLength(0);
      expect(await prisma.refund.count({ where: { paymentId: dup.id } })).toBe(0);
    });

    it("CR-B3-5: a reserve that never answers is remedied at its deadline and flagged (UPI refunded, card hold voided)", async () => {
      const x = await harness(prisma);
      const upi = await checkedOut(x, run, "INR", "upi");
      const card = await checkedOut(x, run, "AED", "card");
      await deliver(x, upi.gw, "payment.captured", upi.gw.pay(upi.providerOrderId));
      await deliver(x, card.gw, "payment.authorized", card.gw.pay(card.providerOrderId));
      for (const c of [upi, card]) {
        const s = await sagaState(x, c.sagaId);
        expect(s.state).toBe("reserve_pending");
        // The quote expiry plus the reserve budget (30 minutes).
        const quote = await prisma.quote.findUniqueOrThrow({ where: { id: c.q.quoteId } });
        expect(s.deadlineAt!.getTime()).toBe(quote.expiresAt.getTime() + 30 * 60_000);
      }
      // Held by a pause: the reserve was never sent.
      x.clock.advance(20 * 60_000);
      await x.saga.advance(upi.sagaId);
      await x.saga.advance(card.sagaId);
      expect((await sagaState(x, upi.sagaId)).state).toBe("reserve_pending");
      x.clock.advance(25 * 60_000);
      await x.saga.advance(upi.sagaId);
      await x.saga.advance(card.sagaId);
      const u = await sagaState(x, upi.sagaId);
      expect(u.state).toBe("refunded");
      expect(u.attentionRequiredAt).not.toBeNull();
      expect((await refundsOf(upi.paymentId)).map((f) => [f.reason, f.status])).toEqual([["reserve_deadline", "succeeded"]]);
      const k = await sagaState(x, card.sagaId);
      expect(k.state).toBe("released");
      expect(k.attentionRequiredAt).not.toBeNull();
      expect(k.payment!.status).toBe("voided");
      expect(x.engine.bookings.get(upi.orderItemId)!.state).toBe("not_created");
      expect(x.engine.calls.filter((e) => e.op === "releaseHold").map((e) => e.reason)).toEqual(["reserve_deadline", "reserve_deadline"]);
    });

    it("CR-B3-6: a hold is captured only before the engine's confirm send-by; an unknown send-by never captures", async () => {
      for (const mode of ["unknown", "too_close"] as const) {
        const x = await harness(prisma);
        const c = await checkedOut(x, run, "AED", "card");
        await deliver(x, c.gw, "payment.authorized", c.gw.pay(c.providerOrderId));
        if (mode === "unknown") x.engine.sendByUnknown = true;
        x.engine.reserve(c.orderItemId);
        // Hold 15 minutes, send-by 10, capture by 8.
        if (mode === "too_close") x.clock.advance(9 * 60_000);
        await x.saga.notifier.bookingChanged(c.orderItemId, "awaiting_payment");
        const s = await sagaState(x, c.sagaId);
        expect(s.state).toBe("released");
        expect(s.payment!.status).toBe("voided");
        expect(x.aed.callsOf("capture")).toHaveLength(0);
        expect(x.engine.calls.filter((e) => e.op === "releaseHold").map((e) => e.reason)).toEqual([mode === "unknown" ? "send_by_unknown" : "hold_deadline"]);
        expect(x.engine.confirmsSent).toBe(0);
      }
    });

    it("CR-B3-9: a capture that resolves after the quote's life is refunded, never reserved on the stale quote", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "card");
      const pid = c.gw.pay(c.providerOrderId);
      // Debit at authorization: the capture's answer is lost and the next read too.
      c.gw.script("capture", { kind: "unknown", sent: true, applied: true });
      c.gw.script("getPayment", { kind: "pass" }, { kind: "pass" }, { kind: "unknown", sent: true, applied: false });
      const d = await deliver(x, c.gw, "payment.authorized", pid);
      expect((await sagaState(x, c.sagaId)).state).toBe("capture_unknown");
      expect(await prisma.paymentEvent.count({ where: { provider: c.gw.provider, providerEventId: d.webhook.eventId, state: "processing_failed" } })).toBe(1);
      x.clock.advance(30 * 60_000);
      await x.saga.advance(c.sagaId);
      expect((await sagaState(x, c.sagaId)).state).toBe("refunded");
      expect((await refundsOf(c.paymentId)).map((f) => f.reason)).toEqual(["late_payment"]);
      expect(x.engine.count("startAttempt")).toBe(0);
    });

    it("CR-B3-8: a refund made at the provider counts; Outly refunds only the rest", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "upi");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.captured", pid);
      // Finance refunded part in the provider's dashboard.
      const p = c.gw.payments.get(pid)!;
      p.refundedMinor = 30_000n;
      p.status = "partially_refunded";
      x.engine.reserve(c.orderItemId, "rejected");
      await x.saga.notifier.bookingChanged(c.orderItemId, "rejected");
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("refunded");
      expect((await refundsOf(c.paymentId)).map((f) => [f.status, f.amountMinor])).toEqual([["succeeded", 200_000n]]);
      expect(s.payment).toMatchObject({ refundedMinor: 230_000n, status: "refunded" });
    });

    it("CR-B3-8: an unknown refund refused on its re-send is settled by the provider's read, never by the refusal", async () => {
      for (const landed of [true, false]) {
        const x = await harness(prisma, { refundsSettle: "manual" });
        const c = await checkedOut(x, run, "INR", "upi");
        await deliver(x, c.gw, "payment.captured", c.gw.pay(c.providerOrderId));
        const { refundId } = await prisma.$transaction((tx) =>
          openRefund(tx, { paymentId: c.paymentId, orderId: c.r.orderId, orderItemId: c.orderItemId, kind: "refund", reason: "zz-b3 refund", amountMinor: 230_000n, currency: "INR", supplierBookingId: null, outlyFunded: false }),
        );
        c.gw.script("refund", { kind: "unknown", sent: true, applied: landed });
        expect(await x.saga.refunds.drive(refundId)).toBe("unknown");
        for (const r of c.gw.refunds.values()) c.gw.settleRefund(r.id, "succeeded");
        // The provider forgot the key: the re-send is refused outright.
        c.gw.forgetKeys();
        c.gw.script("refund", { kind: "failed", code: "idempotency_key_expired" });
        expect(await x.saga.refunds.drive(refundId)).toBe(landed ? "succeeded" : "failed");
        expect((await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).status).toBe(landed ? "succeeded" : "failed");
        expect(x.inr.callsOf("refund")).toHaveLength(2);
      }
    });

    it("booking tick cap (batch 4 follow-up 1): refunds the cap stopped wait unchanged; the next run drives them, each sent once", async () => {
      const x = await harness(prisma);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const c = await checkedOut(x, run, "INR", "upi");
        await deliver(x, c.gw, "payment.captured", c.gw.pay(c.providerOrderId));
        const { refundId } = await prisma.$transaction((tx) =>
          openRefund(tx, { paymentId: c.paymentId, orderId: c.r.orderId, orderItemId: c.orderItemId, kind: "refund", reason: "zz-b3 cap", amountMinor: 1_000n, currency: "INR", supplierBookingId: null, outlyFunded: false }),
        );
        ids.push(refundId);
      }
      const statusOf = async () => (await prisma.refund.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: "asc" } })).map((r) => r.status);
      // The cap is hit mid-tail: once this harness's gateway has been asked for one refund, nothing more starts.
      await x.saga.advanceOpen({ stop: () => x.inr.callsOf("refund").length >= 1 });
      expect(x.inr.callsOf("refund")).toHaveLength(1);
      expect((await statusOf()).filter((st) => st === "requested")).toHaveLength(2);
      // The next run, uncapped, completes them.
      await x.saga.advanceOpen();
      expect(await statusOf()).toEqual(["succeeded", "succeeded", "succeeded"]);
      // No double refund: one provider call per refund, each with its own key.
      const calls = x.inr.callsOf("refund");
      expect(calls).toHaveLength(3);
      // And a further run sends nothing.
      await x.saga.advanceOpen();
      expect(x.inr.callsOf("refund")).toHaveLength(3);
    });

    describe("refund accounting: refunded_minor is a max-merge, refundable is captured − (GREATEST(R, S) + O)", () => {
      /** UPI captured and waiting for its reserve; an Outly refund of 100_000 accepted at the provider, not settled. */
      async function withOpenRefund() {
        const x = await harness(prisma, { refundsSettle: "manual" });
        const c = await checkedOut(x, run, "INR", "upi");
        const pid = c.gw.pay(c.providerOrderId);
        await deliver(x, c.gw, "payment.captured", pid);
        const { refundId } = await prisma.$transaction((tx) =>
          openRefund(tx, { paymentId: c.paymentId, orderId: c.r.orderId, orderItemId: c.orderItemId, kind: "refund", reason: "zz-b3 accounting", amountMinor: 100_000n, currency: "INR", supplierBookingId: null, outlyFunded: false }),
        );
        expect(await x.saga.refunds.drive(refundId)).toBe("accepted");
        const providerRefundId = (await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).providerRefundId!;
        return { x, c, pid, refundId, providerRefundId };
      }
      const paymentOf = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });

      it("sync first, then settle: the refund is counted once", async () => {
        const { x, c, refundId, providerRefundId } = await withOpenRefund();
        c.gw.settleRefund(providerRefundId, "succeeded");
        await x.saga.advance(c.sagaId);
        expect(await paymentOf(c.paymentId)).toMatchObject({ refundedMinor: 100_000n });
        // Landed and still open: counted twice for now, which can only refuse.
        expect(await refundableMinor(prisma, c.paymentId)).toBe(30_000n);
        expect(await x.saga.refunds.drive(refundId)).toBe("succeeded");
        expect(await paymentOf(c.paymentId)).toMatchObject({ refundedMinor: 100_000n, status: "partially_refunded" });
        expect(await refundableMinor(prisma, c.paymentId)).toBe(130_000n);
      });

      it("settle first, then sync: the same total", async () => {
        const { x, c, refundId, providerRefundId } = await withOpenRefund();
        c.gw.settleRefund(providerRefundId, "succeeded");
        expect(await x.saga.refunds.drive(refundId)).toBe("succeeded");
        expect(await paymentOf(c.paymentId)).toMatchObject({ refundedMinor: 100_000n });
        await x.saga.advance(c.sagaId);
        expect(await paymentOf(c.paymentId)).toMatchObject({ refundedMinor: 100_000n });
        expect(await refundableMinor(prisma, c.paymentId)).toBe(130_000n);
      });

      it("a dashboard refund alongside an open Outly refund: both count, in code and in the database cap", async () => {
        const { x, c, pid, refundId, providerRefundId } = await withOpenRefund();
        const p = c.gw.payments.get(pid)!;
        p.refundedMinor += 50_000n;
        p.status = "partially_refunded";
        await x.saga.advance(c.sagaId);
        expect(await paymentOf(c.paymentId)).toMatchObject({ refundedMinor: 50_000n });
        expect(await refundableMinor(prisma, c.paymentId)).toBe(80_000n);
        const base = { paymentId: c.paymentId, orderId: c.r.orderId, orderItemId: c.orderItemId, kind: "refund" as const, reason: "zz-b3 accounting", currency: "INR" as const, supplierBookingId: null, outlyFunded: false };
        await expect(prisma.$transaction((tx) => openRefund(tx, { ...base, amountMinor: 80_001n }))).rejects.toMatchObject({ reason: "refund_cap" });
        const { uuidv7 } = await import("../../lib/ids");
        await expect(
          prisma.refund.create({ data: { id: uuidv7(), paymentId: c.paymentId, orderItemId: c.orderItemId, provider: "fake-inr-pacb", idempotencyKey: `zz-b3-${uuidv7()}`, amountMinor: 80_001n, currency: "INR", reason: "zz-b3 direct" } }),
        ).rejects.toThrow(/refunds:/);
        c.gw.settleRefund(providerRefundId, "succeeded");
        expect(await x.saga.refunds.drive(refundId)).toBe("succeeded");
        expect(await paymentOf(c.paymentId)).toMatchObject({ refundedMinor: 150_000n });
        expect(await refundableMinor(prisma, c.paymentId)).toBe(80_000n);
      });
    });

    it("CR-B3-8: a duplicate gets one automatic refund; a failed one goes to finance and is never re-sent", async () => {
      const x = await harness(prisma, { refundsSettle: "manual" });
      const c = await checkedOut(x, run, "INR", "upi");
      const first = c.gw.pay(c.providerOrderId);
      const second = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.captured", first);
      await deliver(x, c.gw, "payment.captured", second);
      const dup = await prisma.payment.findFirstOrThrow({ where: { orderId: c.r.orderId, gatewayPaymentId: second } });
      const r = await prisma.refund.findFirstOrThrow({ where: { paymentId: dup.id } });
      expect(r).toMatchObject({ status: "accepted", reason: "duplicate_payment" });
      c.gw.settleRefund(r.providerRefundId!, "failed");
      await runPaymentsTick(x.inbox, x.saga);
      await runPaymentsTick(x.inbox, x.saga);
      expect((await prisma.refund.findMany({ where: { paymentId: dup.id } })).map((f) => f.status)).toEqual(["failed"]);
      expect(await prisma.payment.findUniqueOrThrow({ where: { id: dup.id } })).toMatchObject({ failureCode: "duplicate_refund_failed" });
      expect(x.inr.callsOf("refund").filter((a) => a[0] === second)).toHaveLength(1);
      expect((await sagaState(x, c.sagaId)).attentionRequiredAt).toBeNull();
    });
  });

  describe("independent review B3 recheck (CR-B3-14 to CR-B3-16, CR-B3-7, CR-B3-12)", () => {
    const DAY = 86_400_000;
    /** Sagas the job-budget tests create far in the future, retired after each test. */
    const ahead: string[] = [];

    /**
     * The job-budget tests run their clock weeks ahead, where no other suite's
     * saga is urgent or inside a watch window. Their own sagas would be both,
     * for the next of these tests and for a later run on the same database,
     * so they are closed and moved out of every window afterwards.
     */
    afterEach(async () => {
      if (!ahead.length) return;
      await prisma.$executeRaw`UPDATE "payment_sagas" SET "state" = 'failed', "deadline_at" = NULL, "created_at" = "created_at" - interval '400 days' WHERE "id" = ANY(${ahead.splice(0)}::uuid[])`;
    });

    async function aheadCheckout(x: Harness) {
      const c = await checkedOut(x, run, "AED", "card");
      ahead.push(c.sagaId);
      return c;
    }

    /** Mark every saga already in the database checked at `at`, as earlier job runs would have. */
    async function allCheckedAt(at: Date) {
      await prisma.$executeRaw`UPDATE "payment_sagas" SET "checked_at" = ${at}`;
    }

    async function checkedAtOf(ids: string[]) {
      const rows = await prisma.paymentSaga.findMany({ where: { id: { in: ids } }, select: { id: true, checkedAt: true } });
      return ids.map((id) => rows.find((r) => r.id === id)?.checkedAt?.getTime() ?? null);
    }

    it("CR-B3-16: a dashboard refund after the confirm was sent leaves the saga waiting, flagged, with no Outly refund", async () => {
      const x = await harness(prisma);
      x.engine.confirmOutcome = "unknown";
      const c = await checkedOut(x, run, "AED", "card");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      await reserveAndConfirm(x, c.orderItemId);
      await x.saga.advance(c.sagaId);
      expect(await sagaState(x, c.sagaId)).toMatchObject({ state: "confirm_pending", attentionRequiredAt: null });
      expect(x.engine.bookings.get(c.orderItemId)!.state).toBe("confirming");
      expect(await evidence(c.orderItemId)).not.toBeNull();

      c.gw.dashboardRefund(pid, 4_000n);
      await runPaymentsTick(x.inbox, x.saga);
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("confirm_pending");
      expect(s.attentionRequiredAt).not.toBeNull();
      expect(s.payment).toMatchObject({ refundedMinor: 4_000n, status: "partially_refunded" });
      // The supplier's answer now finds no evidence: the engine holds it for a human (supplier-booking.service.test.ts).
      expect(await evidence(c.orderItemId)).toBeNull();
      expect(await prisma.refund.count({ where: { paymentId: c.paymentId } })).toBe(0);
      expect(c.gw.callsOf("refund")).toHaveLength(0);
      expect(x.engine.count("releaseHold")).toBe(0);
      expect(x.engine.confirmsSent).toBe(1);
    });

    it("CR-B3-12: a payment captured for less than the order at entry stops in attention and moves no money", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card");
      const pid = c.gw.pay(c.providerOrderId);
      // Captured at the provider before Outly saw the payment, and only in part.
      await c.gw.capture(pid, 4_000n, "zz-b3-dashboard-capture");
      await deliver(x, c.gw, "payment.captured", pid);
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("attention");
      expect(s.payment).toMatchObject({ capturedMinor: 4_000n });
      expect(x.engine.count("startAttempt")).toBe(0);
      expect(await prisma.refund.count({ where: { paymentId: c.paymentId } })).toBe(0);
    });

    it("CR-B3-12: a hold still authorized past its automatic release, or a void failing near the expiry, is told to a human", async () => {
      // INR card: the provider releases the debit itself after three days; this one still reports it authorized.
      const x = await harness(prisma);
      const inr = await checkedOut(x, run, "INR", "card", { ttlMs: 3 * 60_000 });
      const aed = await checkedOut(x, run, "AED", "card", { ttlMs: 3 * 60_000 });
      x.clock.advance(4 * 60_000);
      const ipid = inr.gw.pay(inr.providerOrderId, { afterExpiry: true });
      const apid = aed.gw.pay(aed.providerOrderId, { afterExpiry: true });
      aed.gw.script("void", { kind: "failed", code: "acquirer_unavailable" });
      await deliver(x, inr.gw, "payment.authorized", ipid);
      await deliver(x, aed.gw, "payment.authorized", apid);
      for (const id of [inr.sagaId, aed.sagaId]) expect(await sagaState(x, id)).toMatchObject({ state: "release_pending", attentionRequiredAt: null });
      const stuck = inr.gw.payments.get(ipid)!;
      stuck.authorizationExpiresAt = null; // the provider keeps reporting it authorized; the row keeps the expiry it was given

      x.clock.advance(3 * 86_400_000);
      await x.saga.advance(inr.sagaId);
      expect((await sagaState(x, inr.sagaId)).attentionRequiredAt).toBeNull();
      x.clock.advance(61 * 60_000);
      await x.saga.advance(inr.sagaId);
      expect(await sagaState(x, inr.sagaId)).toMatchObject({ state: "release_pending" });
      expect((await sagaState(x, inr.sagaId)).attentionRequiredAt).not.toBeNull();

      // AED hold: seven days; the void keeps failing, so a human hears before the expiry, not after.
      x.clock.advance(4 * 86_400_000 - 61 * 60_000 - 10 * 60_000);
      await x.saga.advance(aed.sagaId);
      expect((await sagaState(x, aed.sagaId)).attentionRequiredAt).toBeNull();
      x.clock.advance(6 * 60_000);
      await x.saga.advance(aed.sagaId);
      expect(await sagaState(x, aed.sagaId)).toMatchObject({ state: "release_pending" });
      expect((await sagaState(x, aed.sagaId)).attentionRequiredAt).not.toBeNull();
      expect(await prisma.refund.count({ where: { paymentId: { in: [inr.paymentId, aed.paymentId] } } })).toBe(0);
    });

    it("CR-B3-15: an unknown refund is judged by its own record at the provider, never by the payment's refunded total", async () => {
      const x = await harness(prisma, { refundsSettle: "manual" });
      const c = await checkedOut(x, run, "INR", "upi");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.captured", pid);
      const { refundId } = await prisma.$transaction((tx) =>
        openRefund(tx, { paymentId: c.paymentId, orderId: c.r.orderId, orderItemId: c.orderItemId, kind: "refund", reason: "zz-b3 refund", amountMinor: 100_000n, currency: "INR", supplierBookingId: null, outlyFunded: false }),
      );
      // Outly's request never landed, and finance refunded the same amount in the dashboard meanwhile.
      c.gw.script("refund", { kind: "unknown", sent: true, applied: false });
      expect(await x.saga.refunds.drive(refundId)).toBe("unknown");
      c.gw.dashboardRefund(pid, 100_000n);
      c.gw.forgetKeys();
      c.gw.script("refund", { kind: "failed", code: "idempotency_key_expired" });
      // Unreadable list: nothing is decided.
      c.gw.script("listRefunds", { kind: "unknown", sent: true, applied: false });
      expect(await x.saga.refunds.drive(refundId)).toBe("unknown");
      c.gw.script("refund", { kind: "failed", code: "idempotency_key_expired" });
      // The provider's total (100_000) would have passed it as landed; its own record says it never existed.
      expect(await x.saga.refunds.drive(refundId)).toBe("failed");
      expect(await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).toMatchObject({ status: "failed", providerRefundId: null });
      await x.saga.advance(c.sagaId);
      expect(await refundableMinor(prisma, c.paymentId)).toBe(130_000n);
    });

    it("CR-B3-15: an unknown refund that did land is found by its reference and tracked by its provider refund id", async () => {
      const x = await harness(prisma, { refundsSettle: "manual" });
      const c = await checkedOut(x, run, "INR", "upi");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.captured", pid);
      const { refundId } = await prisma.$transaction((tx) =>
        openRefund(tx, { paymentId: c.paymentId, orderId: c.r.orderId, orderItemId: c.orderItemId, kind: "refund", reason: "zz-b3 refund", amountMinor: 100_000n, currency: "INR", supplierBookingId: null, outlyFunded: false }),
      );
      c.gw.script("refund", { kind: "unknown", sent: true, applied: true });
      expect(await x.saga.refunds.drive(refundId)).toBe("unknown");
      c.gw.forgetKeys();
      c.gw.script("refund", { kind: "failed", code: "idempotency_key_expired" });
      // Found, still pending at the provider: accepted under its own id, not settled from the payment's total.
      expect(await x.saga.refunds.drive(refundId)).toBe("accepted");
      const providerRefundId = [...c.gw.refunds.values()].find((f) => f.paymentId === pid)!.id;
      expect(await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).toMatchObject({ status: "accepted", providerRefundId });
      c.gw.settleRefund(providerRefundId, "succeeded");
      expect(await x.saga.refunds.drive(refundId)).toBe("succeeded");
      expect(c.gw.callsOf("getRefund").map((a) => a[0])).toContain(providerRefundId);
    });

    it("CR-B3-14: sagas never checked come first, and the next run reaches the ones this run did not", async () => {
      const x = await harness(prisma);
      // Far ahead of every other suite's sagas, whose deadlines are then long past (not urgent).
      x.clock.freeze();
      x.clock.advance(40 * DAY);
      await allCheckedAt(x.clock.now());
      x.clock.advance(60_000);
      const fresh = [];
      for (let i = 0; i < 3; i++) fresh.push((await aheadCheckout(x)).sagaId);
      // Not urgent: only the order of checking decides.
      await prisma.paymentSaga.updateMany({ where: { id: { in: fresh } }, data: { deadlineAt: new Date(x.clock.now().getTime() + DAY) } });
      const older = await prisma.paymentSaga.findMany({ where: { state: { notIn: ["fulfilled", "refunded", "released", "failed", "attention"] }, id: { notIn: fresh } }, select: { id: true } });
      expect(older.length).toBeGreaterThan(0);

      const first = x.clock.now().getTime();
      // Paging by id would have spent this budget on the oldest sagas and never reached the newest.
      expect(await x.saga.advanceOpen({ liveLimit: 3, watchLimit: 0 })).toBe(3);
      expect(await checkedAtOf(fresh)).toEqual([first, first, first]);

      x.clock.advance(60_000);
      expect(await x.saga.advanceOpen({ liveLimit: 1, watchLimit: 0 })).toBe(1);
      // The next run took a saga checked before these three, not one of them again.
      expect(await checkedAtOf(fresh)).toEqual([first, first, first]);
      const next = await prisma.paymentSaga.count({ where: { id: { in: older.map((o) => o.id) }, checkedAt: new Date(x.clock.now().getTime()) } });
      expect(next).toBe(1);
    });

    it("CR-B3-14: a live saga close to its deadline goes before one never checked; a flagged one does not", async () => {
      const x = await harness(prisma);
      x.clock.freeze();
      x.clock.advance(60 * DAY);
      await allCheckedAt(x.clock.now());
      x.clock.advance(60_000);
      const now = x.clock.now().getTime();
      const calm = (await aheadCheckout(x)).sagaId;
      const urgent = (await aheadCheckout(x)).sagaId;
      const flagged = (await aheadCheckout(x)).sagaId;
      await prisma.paymentSaga.update({ where: { id: calm }, data: { deadlineAt: new Date(now + DAY), checkedAt: null } });
      await prisma.paymentSaga.update({ where: { id: urgent }, data: { deadlineAt: new Date(now + 5 * 60_000), checkedAt: new Date(now - 30_000) } });
      await prisma.paymentSaga.update({ where: { id: flagged }, data: { deadlineAt: new Date(now + 60_000), checkedAt: new Date(now - 30_000), attentionRequiredAt: new Date(now) } });

      // Two slots: half go to urgent sagas, the other half to the least recently checked.
      expect(await x.saga.advanceOpen({ liveLimit: 2, watchLimit: 0 })).toBe(2);
      expect(await checkedAtOf([urgent, calm, flagged])).toEqual([now, now, now - 30_000]);
    });

    it("CR-B3-14: the late-money watch has its own budget, rotates, and drops unbound sagas after a day", async () => {
      const x = await harness(prisma);
      x.clock.freeze();
      x.clock.advance(80 * DAY);
      await allCheckedAt(x.clock.now());
      x.clock.advance(60_000);
      const now = x.clock.now().getTime();
      const bound = await aheadCheckout(x);
      const recent = await aheadCheckout(x);
      const old = await aheadCheckout(x);
      const live = await aheadCheckout(x);
      // Closed sagas, as the saga would leave them; a bound one inside the eight-day window, unbound ones either side of one day.
      await prisma.payment.update({ where: { id: bound.paymentId }, data: { gatewayPaymentId: `zz-b3-unknown-${run}-${bound.paymentId.slice(-8)}` } });
      await prisma.paymentSaga.update({ where: { id: bound.sagaId }, data: { state: "failed", createdAt: new Date(now - 3 * DAY), checkedAt: null } });
      await prisma.paymentSaga.update({ where: { id: recent.sagaId }, data: { state: "failed", createdAt: new Date(now - 2 * 3_600_000), checkedAt: null } });
      await prisma.paymentSaga.update({ where: { id: old.sagaId }, data: { state: "failed", createdAt: new Date(now - 2 * DAY), checkedAt: null } });
      await prisma.paymentSaga.update({ where: { id: live.sagaId }, data: { checkedAt: null } });

      expect(await x.saga.advanceOpen({ liveLimit: 0, watchLimit: 1 })).toBe(1);
      x.clock.advance(60_000);
      expect(await x.saga.advanceOpen({ liveLimit: 0, watchLimit: 1 })).toBe(1);
      const [b, r, o, l] = await checkedAtOf([bound.sagaId, recent.sagaId, old.sagaId, live.sagaId]);
      expect(b).toBe(now);
      expect(r).toBe(now + 60_000);
      // Unbound past a day: nothing can still arrive for it. Live sagas are not the watch's budget.
      expect(o).toBeNull();
      expect(l).toBeNull();
    });

    it("CR-B3-14: no saga starts after the time budget", async () => {
      let t = 0;
      const x = await harness(prisma, { elapsedMs: () => t });
      x.clock.freeze();
      x.clock.advance(100 * DAY);
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push((await aheadCheckout(x)).sagaId);
      expect(await x.saga.advanceOpen({ budgetMs: 0 })).toBe(0);
      expect(await checkedAtOf(ids)).toEqual([null, null, null]);
      // Each saga visited costs 1 s here: a 2.5 s budget starts three and no more.
      const current = x.engine.current.bind(x.engine);
      x.engine.current = async (orderItemId: string) => {
        t += 1_000;
        return current(orderItemId);
      };
      expect(await x.saga.advanceOpen({ budgetMs: 2_500 })).toBe(3);
      expect((await checkedAtOf(ids)).every((v) => v !== null)).toBe(true);
    });
  });
});
