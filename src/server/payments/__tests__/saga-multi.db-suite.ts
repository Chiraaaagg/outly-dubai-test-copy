import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbEnabled, runId } from "../../__tests__/helpers/fixtures";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import { checkedOut, cleanupB3, deliver, harness, quoteFixture, sagaState, startInput, type Harness } from "./_b3-harness";

/**
 * Multi-item instant checkout (owner decision of 3 November 2026, doc 22
 * §32.16 question 1; lead design of the same day) on Postgres against the
 * fake gateways and the fake engine. Imported by evidence.test.ts (the
 * payments db suite). Synthetic amounts: AED items of 10_000, 11_000 and
 * 12_000 fils; INR items of 230_000, 240_000 and 250_000 paise.
 *
 * All or nothing until the capture: items are reserved one at a time, any
 * definite failure releases every hold and voids (or refunds in full); an
 * unknown outcome flags the saga and never captures or voids early; no time
 * left before the earliest hold's capture point releases everything. After
 * the capture each item stands alone: a failed confirm refunds exactly that
 * item's allocation.
 */

type Prisma = typeof import("../../lib/db").prisma;
const MIN = 60_000;

describe.skipIf(!dbEnabled)("B3 multi-item payment saga (disposable database)", () => {
  let prisma: Prisma;
  let paymentEvidenceFrom: typeof import("../evidence").paymentEvidenceFrom;
  let openRefund: typeof import("../refunds").openRefund;
  let RefundRefused: typeof import("../refunds").RefundRefused;
  let loadStatusSnapshot: typeof import("../../services/order-status.service").loadStatusSnapshot;
  let projectCustomerStatus: typeof import("../../services/order-status.service").projectCustomerStatus;
  let CAPTURE_BUDGET_MS: number;
  let ITEM_RESERVE_BUDGET_MS: number;
  const run = runId();

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    await cleanupB3(prisma);
    ({ paymentEvidenceFrom } = await import("../evidence"));
    ({ openRefund, RefundRefused } = await import("../refunds"));
    ({ loadStatusSnapshot, projectCustomerStatus } = await import("../../services/order-status.service"));
    ({ CAPTURE_BUDGET_MS, ITEM_RESERVE_BUDGET_MS } = await import("../saga"));
  });

  afterAll(async () => {
    await cleanupB3(prisma);
  });

  const evidence = (orderItemId: string) => paymentEvidenceFrom(prisma).capturedFor(orderItemId);

  async function allocations(orderId: string) {
    const items = await prisma.orderItem.findMany({ where: { orderId }, orderBy: { quoteLineIndex: "asc" } });
    return items.map((i) => i.chargedAmountMinor! - i.discountAllocMinor! + i.taxAllocMinor!);
  }

  async function refundsOf(paymentId: string) {
    const rows = await prisma.refund.findMany({ where: { paymentId }, orderBy: { createdAt: "asc" } });
    return rows.map((r) => ({ orderItemId: r.orderItemId, amountMinor: r.amountMinor, status: r.status }));
  }

  async function ledgerSum(paymentId: string) {
    const rows = await prisma.ledgerEntry.findMany({ where: { paymentId, book: "customer_money" } });
    return { kinds: rows.map((r) => r.kind).sort(), sum: rows.reduce((s, r) => s + r.amountMinor, 0n) };
  }

  /** The order ids of the startAttempt calls, mapped back to the items: the supplier lane's order. */
  function startedItems(x: Harness, itemIds: string[]) {
    const byBooking = new Map([...x.engine.bookings.values()].map((b) => [b.id, b.orderItemId]));
    return x.engine.calls.filter((c) => c.op === "startAttempt").map((c) => itemIds.indexOf(byBooking.get(c.id)!));
  }

  /** The engine reserved this item; the engine tells the saga. */
  async function reserved(x: Harness, orderItemId: string, outcome: "awaiting_payment" | "rejected" = "awaiting_payment") {
    x.engine.reserve(orderItemId, outcome);
    await x.saga.notifier.bookingChanged(orderItemId, outcome);
  }

  async function customerStatus(orderId: string) {
    const snap = await loadStatusSnapshot({ orderId, canDownload: false });
    return projectCustomerStatus(snap!, new Date());
  }

  describe("happy paths", () => {
    it("AED card hold, 2 and 3 items: one hold, items reserved one at a time in position order, one full capture, then each confirmed", async () => {
      for (const n of [2, 3]) {
        const x = await harness(prisma);
        const c = await checkedOut(x, run, "AED", "card", { items: n });
        expect(c.itemIds).toHaveLength(n);
        expect(c.orderItemId).toBe(c.itemIds[0]);
        const alloc = await allocations(c.r.orderId);
        const total = alloc.reduce((s, a) => s + a, 0n);
        // The order total is exactly the sum of the item allocations, in one currency.
        expect((await sagaState(x, c.sagaId)).payment!.amountMinor).toBe(total);
        expect(total).toBe(c.q.totalMinor);

        const pid = c.gw.pay(c.providerOrderId);
        await deliver(x, c.gw, "payment.authorized", pid);
        expect((await sagaState(x, c.sagaId)).state).toBe("reserve_pending");
        for (let i = 0; i < n; i++) {
          // Only the next item is ever started, and only after the one before it is reserved.
          expect(x.engine.count("startAttempt"), `n=${n} i=${i}`).toBe(i + 1);
          expect(x.aed.callsOf("capture")).toHaveLength(0);
          expect(await evidence(c.itemIds[i])).toBeNull();
          await reserved(x, c.itemIds[i]);
        }
        expect(startedItems(x, c.itemIds)).toEqual([...Array(n).keys()]);
        // Every item reserved: the whole amount captured once, then each confirm queued on its own evidence.
        expect(x.aed.callsOf("capture")).toEqual([[pid, total, `capture:${c.paymentId}`]]);
        expect(x.engine.confirmsSent).toBe(n);
        await x.saga.notifier.bookingChanged(c.itemIds[0], "confirmed");
        const s = await sagaState(x, c.sagaId);
        expect(s.state).toBe("fulfilled");
        expect(s.payment).toMatchObject({ status: "captured", capturedMinor: total, refundedMinor: 0n });
        expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "confirmed" });
        expect((await prisma.orderItem.findMany({ where: { orderId: c.r.orderId } })).map((i) => i.status)).toEqual(Array(n).fill("confirmed"));
        // Evidence per item, each for exactly its allocation; together exactly the capture.
        const ev = await Promise.all(c.itemIds.map((id) => evidence(id)));
        expect(ev.map((e) => e?.capturedMinor)).toEqual(alloc);
        expect(ev.reduce((sum, e) => sum + e!.capturedMinor, 0n)).toBe(s.payment!.capturedMinor);
        expect(await ledgerSum(c.paymentId)).toEqual({ kinds: ["capture"], sum: total });
        expect((await customerStatus(c.r.orderId)).items.map((i) => i.state)).toEqual(Array(n).fill("confirmed"));
      }
    });

    it("INR capture first, 2 and 3 items: captured, every item reserved in order, and no confirm before the last reserve", async () => {
      for (const n of [2, 3]) {
        const x = await harness(prisma);
        const c = await checkedOut(x, run, "INR", "upi", { items: n });
        const alloc = await allocations(c.r.orderId);
        const total = alloc.reduce((s, a) => s + a, 0n);
        const pid = c.gw.pay(c.providerOrderId);
        await deliver(x, c.gw, "payment.captured", pid);
        for (let i = 0; i < n; i++) {
          expect((await sagaState(x, c.sagaId)).state).toBe("reserve_pending");
          // Captured, but no item may be confirmed before every item is reserved (all or nothing).
          for (const id of c.itemIds) expect(await evidence(id)).toBeNull();
          expect(x.engine.confirmsSent).toBe(0);
          await reserved(x, c.itemIds[i]);
        }
        expect(startedItems(x, c.itemIds)).toEqual([...Array(n).keys()]);
        expect(x.engine.confirmsSent).toBe(n);
        await x.saga.notifier.bookingChanged(c.itemIds[0], "confirmed");
        expect((await sagaState(x, c.sagaId)).state).toBe("fulfilled");
        expect(x.inr.callsOf("capture")).toHaveLength(0);
        expect(await ledgerSum(c.paymentId)).toEqual({ kinds: ["capture"], sum: total });
        expect((await Promise.all(c.itemIds.map((id) => evidence(id)))).map((e) => e?.capturedMinor)).toEqual(alloc);
      }
    });

    it("five items is the cap: checkout takes five, refuses six (too_many_items) before any order or session", async () => {
      const x = await harness(prisma);
      const six = await quoteFixture(x, run, "INR", { items: 6 });
      expect(await x.checkout.start(startInput(six, "upi"))).toEqual({ ok: false, reason: "too_many_items" });
      expect(await prisma.payment.count({ where: { quoteId: six.quoteId } })).toBe(0);
      const c = await checkedOut(x, run, "INR", "upi", { items: 5 });
      expect(c.itemIds).toHaveLength(5);
      expect((await prisma.orderItem.findMany({ where: { orderId: c.r.orderId }, orderBy: { quoteLineIndex: "asc" } })).map((i) => i.quoteLineIndex)).toEqual([0, 1, 2, 3, 4]);
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.captured", pid);
      for (const id of c.itemIds) await reserved(x, id);
      await x.saga.notifier.bookingChanged(c.itemIds[0], "confirmed");
      expect((await sagaState(x, c.sagaId)).state).toBe("fulfilled");
      expect(startedItems(x, c.itemIds)).toEqual([0, 1, 2, 3, 4]);
    });
  });

  describe("all or nothing until the capture", () => {
    it("hold: item 2 of 3 is rejected → item 1's hold released, the payment voided, nothing captured, item 3 never reserved", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card", { items: 3 });
      const alloc = await allocations(c.r.orderId);
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      await reserved(x, c.itemIds[0]);
      await reserved(x, c.itemIds[1], "rejected");
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("released");
      expect(s.payment).toMatchObject({ status: "voided", capturedMinor: 0n });
      expect(x.aed.callsOf("capture")).toHaveLength(0);
      expect(x.aed.callsOf("void")).toEqual([[pid, `void:${c.paymentId}`]]);
      expect(x.engine.count("startAttempt")).toBe(2);
      expect(x.engine.calls.filter((k) => k.op === "releaseHold").map((k) => k.id)).toEqual([x.engine.bookings.get(c.itemIds[0])!.id]);
      expect(x.engine.bookings.get(c.itemIds[0])!.state).toBe("cancelled");
      expect(x.engine.confirmsSent).toBe(0);
      // One remedy per item, each for its own allocation: "could not book; nothing charged".
      const remedies = await prisma.customerRemedy.findMany({ where: { orderId: c.r.orderId } });
      expect(remedies.map((r) => [c.itemIds.indexOf(r.orderItemId), r.kind, r.status, r.amountMinor]).sort()).toEqual(
        [0, 1, 2].map((i) => [i, "release_authorization", "completed", alloc[i]]).sort(),
      );
      expect(await prisma.refund.count({ where: { paymentId: c.paymentId } })).toBe(0);
      expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "payment_failed" });
      const status = await customerStatus(c.r.orderId);
      expect(status.state).toBe("payment_released");
      expect(status.headline).toMatch(/Nothing was charged/);
    });

    it("capture first: item 2 of 3 is rejected → the other hold released and the whole order refunded, item by item, nothing confirmed", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "upi", { items: 3 });
      const alloc = await allocations(c.r.orderId);
      const total = alloc.reduce((s, a) => s + a, 0n);
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.captured", pid);
      await reserved(x, c.itemIds[0]);
      await reserved(x, c.itemIds[1], "rejected");
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("refunded");
      expect(s.payment).toMatchObject({ capturedMinor: total, refundedMinor: total, status: "refunded" });
      expect(x.engine.confirmsSent).toBe(0);
      expect(x.engine.bookings.get(c.itemIds[0])!.state).toBe("cancelled");
      expect(x.engine.count("startAttempt")).toBe(2);
      // Per item, each exactly its allocation; together exactly the capture.
      expect(await refundsOf(c.paymentId)).toEqual(c.itemIds.map((id, i) => ({ orderItemId: id, amountMinor: alloc[i], status: "succeeded" })));
      expect(x.inr.callsOf("refund").map((a) => a[1])).toEqual(alloc);
      expect(await ledgerSum(c.paymentId)).toEqual({ kinds: ["capture", "refund", "refund", "refund"], sum: 0n });
      expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "refunded" });
      expect((await customerStatus(c.r.orderId)).state).toBe("refunded");
    });

    it("an unknown reserve outcome flags the saga: no further item, no capture, no void while that hold may exist", async () => {
      const x = await harness(prisma);
      x.engine.releaseVerifies = "later";
      const c = await checkedOut(x, run, "AED", "card", { items: 3 });
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      await reserved(x, c.itemIds[0]);
      x.engine.set(c.itemIds[1], "outcome_unknown");
      await x.saga.notifier.bookingChanged(c.itemIds[1], "outcome_unknown");
      let s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("reserve_pending");
      expect(s.attentionRequiredAt).not.toBeNull();
      expect(x.engine.count("startAttempt")).toBe(2);
      // Even when the unknown resolves into a reservation, nothing more is reserved and nothing captured.
      x.engine.reserve(c.itemIds[1]);
      await x.saga.advance(c.sagaId);
      x.engine.set(c.itemIds[1], "outcome_unknown");
      expect(x.engine.count("startAttempt")).toBe(2);
      expect(x.aed.callsOf("capture")).toHaveLength(0);
      // Past item 1's capture point: every hold is asked to go; the payment waits for the engine.
      x.clock.advance(9 * MIN);
      await x.saga.advance(c.sagaId);
      s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("release_pending");
      expect(x.aed.callsOf("void")).toHaveLength(0);
      expect(x.aed.callsOf("capture")).toHaveLength(0);
      await x.saga.advance(c.sagaId);
      expect(x.aed.callsOf("void")).toHaveLength(0);
      // The engine verifies both releases: only now is the hold voided.
      x.engine.set(c.itemIds[0], "cancelled");
      x.engine.set(c.itemIds[1], "cancelled");
      await x.saga.advance(c.sagaId);
      s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("released");
      expect(x.aed.callsOf("void")).toHaveLength(1);
      expect(x.aed.callsOf("capture")).toHaveLength(0);
    });

    it("not enough time before the earliest hold's capture point: release everything and void, the next item is never reserved", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card", { items: 2 });
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      // Item 1 is reserved; before the saga hears of it, its hold has no room for one more reserve.
      x.engine.reserve(c.itemIds[0]);
      // The fake engine's send-by is the hold (15 min) less 5 min.
      x.clock.advance(10 * MIN - CAPTURE_BUDGET_MS - ITEM_RESERVE_BUDGET_MS + 1_000);
      await x.saga.notifier.bookingChanged(c.itemIds[0], "awaiting_payment");
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("released");
      expect(s.payment!.status).toBe("voided");
      expect(x.engine.count("startAttempt")).toBe(1);
      expect(x.aed.callsOf("capture")).toHaveLength(0);
      expect(x.engine.bookings.get(c.itemIds[0])!.state).toBe("cancelled");
    });

    it("every item reserved but the earliest hold past its capture point: release and void, never captured", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card", { items: 2 });
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      await reserved(x, c.itemIds[0]);
      expect(x.engine.count("startAttempt")).toBe(2);
      x.clock.advance(10 * MIN - CAPTURE_BUDGET_MS + 1_000);
      await reserved(x, c.itemIds[1]);
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("released");
      expect(x.aed.callsOf("capture")).toHaveLength(0);
      expect(x.aed.callsOf("void")).toHaveLength(1);
      expect(c.itemIds.map((id) => x.engine.bookings.get(id)!.state)).toEqual(["cancelled", "cancelled"]);
    });
  });

  describe("after the capture each item stands alone", () => {
    it("item 2's confirm is rejected: exactly its allocation is refunded, items 1 and 3 stay confirmed, the customer sees which", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card", { items: 3 });
      const alloc = await allocations(c.r.orderId);
      const total = alloc.reduce((s, a) => s + a, 0n);
      x.engine.confirmOutcomeFor.set(c.itemIds[1], "rejected");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      for (const id of c.itemIds) await reserved(x, id);
      expect(x.aed.callsOf("capture")).toEqual([[pid, total, `capture:${c.paymentId}`]]);
      await x.saga.notifier.bookingChanged(c.itemIds[1], "rejected");
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("fulfilled");
      expect(s.attentionRequiredAt).toBeNull();
      expect(s.payment).toMatchObject({ capturedMinor: total, refundedMinor: alloc[1], status: "partially_refunded" });
      expect(await refundsOf(c.paymentId)).toEqual([{ orderItemId: c.itemIds[1], amountMinor: alloc[1], status: "succeeded" }]);
      expect(x.aed.callsOf("refund").map((a) => a[1])).toEqual([alloc[1]]);
      expect(await ledgerSum(c.paymentId)).toEqual({ kinds: ["capture", "refund"], sum: total - alloc[1] });
      // The other items keep their evidence; the refunded one has none.
      expect((await evidence(c.itemIds[0]))?.capturedMinor).toBe(alloc[0]);
      expect(await evidence(c.itemIds[1])).toBeNull();
      expect((await evidence(c.itemIds[2]))?.capturedMinor).toBe(alloc[2]);
      expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "partially_confirmed" });
      const items = await prisma.orderItem.findMany({ where: { orderId: c.r.orderId }, orderBy: { quoteLineIndex: "asc" } });
      expect(items.map((i) => i.status)).toEqual(["confirmed", "rejected", "confirmed"]);
      const remedy = await prisma.customerRemedy.findMany({ where: { orderId: c.r.orderId } });
      expect(remedy.map((r) => [r.orderItemId, r.kind, r.status, r.amountMinor])).toEqual([[c.itemIds[1], "refund", "completed", alloc[1]]]);
      const status = await customerStatus(c.r.orderId);
      expect(status.state).toBe("partially_fulfilled");
      const byItem = new Map(status.items.map((i) => [i.orderItemId, i.state]));
      expect(c.itemIds.map((id) => byItem.get(id))).toEqual(["confirmed", "refunded", "confirmed"]);
    });

    it("item 1's confirm is too late: its hold is released first, then exactly its allocation refunded; the others confirmed", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "upi", { items: 2 });
      const alloc = await allocations(c.r.orderId);
      x.engine.confirmOutcomeFor.set(c.itemIds[0], "too_late");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.captured", pid);
      for (const id of c.itemIds) await reserved(x, id);
      await x.saga.notifier.bookingChanged(c.itemIds[1], "confirmed");
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("fulfilled");
      expect(x.engine.bookings.get(c.itemIds[0])!.state).toBe("cancelled");
      expect(x.engine.calls.filter((k) => k.op === "releaseHold").map((k) => k.reason)).toEqual(["confirm_too_late"]);
      expect(await refundsOf(c.paymentId)).toEqual([{ orderItemId: c.itemIds[0], amountMinor: alloc[0], status: "succeeded" }]);
      expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "partially_confirmed" });
    });

    it("every confirm fails: every item refunded on its own, the order refunded in full", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card", { items: 2 });
      const alloc = await allocations(c.r.orderId);
      x.engine.confirmOutcome = "rejected";
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      for (const id of c.itemIds) await reserved(x, id);
      await x.saga.notifier.bookingChanged(c.itemIds[0], "rejected");
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("refunded");
      expect(await refundsOf(c.paymentId)).toEqual(c.itemIds.map((id, i) => ({ orderItemId: id, amountMinor: alloc[i], status: "succeeded" })));
      expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "refunded" });
    });

    it("refund cap per item: no item's refunds may exceed its allocation, even with money left on the payment", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card", { items: 2 });
      const alloc = await allocations(c.r.orderId);
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      for (const id of c.itemIds) await reserved(x, id);
      await x.saga.notifier.bookingChanged(c.itemIds[0], "confirmed");
      expect((await sagaState(x, c.sagaId)).state).toBe("fulfilled");
      const open = (orderItemId: string, amountMinor: bigint) =>
        prisma.$transaction((tx) =>
          openRefund(tx, { paymentId: c.paymentId, orderId: c.r.orderId, orderItemId, kind: "refund", reason: "zz_test", amountMinor, currency: "AED", supplierBookingId: null, outlyFunded: false }),
        );
      // Item 1's allocation plus one: the payment has room (21_000), the item does not.
      await expect(open(c.itemIds[0], alloc[0] + 1n)).rejects.toMatchObject({ reason: "refund_cap" });
      await expect(open(c.itemIds[0], alloc[0] + 1n)).rejects.toBeInstanceOf(RefundRefused);
      await open(c.itemIds[0], alloc[0] - 1_000n);
      await expect(open(c.itemIds[0], 1_001n)).rejects.toMatchObject({ reason: "refund_cap" });
      await open(c.itemIds[0], 1_000n);
      // The database refuses it on its own (trigger refunds_enforce_item_cap), with the payment still holding item 2's money.
      await expect(
        prisma.refund.create({
          data: { id: (await import("../../lib/ids")).uuidv7(), paymentId: c.paymentId, orderItemId: c.itemIds[0], provider: "fake-aed-card", idempotencyKey: `zz-cap-${run}-${c.paymentId}`, amountMinor: 1n, currency: "AED", reason: "zz_test" },
        }),
      ).rejects.toThrow(/above the allocation/);
      // The other item keeps its whole allocation.
      await open(c.itemIds[1], alloc[1]);
      await expect(open(c.itemIds[1], 1n)).rejects.toMatchObject({ reason: "refund_cap" });
    });
  });

  describe("B5 per-item cancellation keeps working", () => {
    it("every item of a fulfilled multi-item order carries the saga's payment; cancelling item 2 refunds exactly its allocation", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card", { items: 2 });
      const alloc = await allocations(c.r.orderId);
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      for (const id of c.itemIds) await reserved(x, id);
      await x.saga.notifier.bookingChanged(c.itemIds[0], "confirmed");
      expect((await sagaState(x, c.sagaId)).state).toBe("fulfilled");

      const { createCancellationService, loadCancellationFacts } = await import("../../services/cancellation.service");
      const facts = await loadCancellationFacts(c.r.orderId);
      expect(c.itemIds.map((id) => [facts.get(id)?.payment?.id, facts.get(id)?.payableMinor])).toEqual([
        [c.paymentId, alloc[0]],
        [c.paymentId, alloc[1]],
      ]);

      // Item 2's operator cancellation is verified (the engine's own suites cover the cancel itself).
      const bookingId = x.engine.bookings.get(c.itemIds[1])!.id;
      await prisma.supplierBooking.update({ where: { id: bookingId }, data: { state: "cancelled", cancelledAt: new Date(), closedAt: new Date() } });
      const { uuidv7 } = await import("../../lib/ids");
      const requestId = uuidv7();
      await prisma.cancellationRequest.create({
        data: { id: requestId, orderId: c.r.orderId, orderItemId: c.itemIds[1], supplierBookingId: bookingId, kind: "supported", status: "cancelling", requestedVia: "customer" },
      });
      const svc = createCancellationService({ requestCancel: async () => {}, driveRefund: (id) => x.saga.refunds.drive(id), now: x.clock.now });
      const row = await prisma.cancellationRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: { id: true, orderId: true, orderItemId: true, supplierBookingId: true, status: true, refundId: true, attentionRequiredAt: true, reasonCode: true, createdAt: true, eligibility: true },
      });
      expect(await svc.advance(row)).toBe("refunded");
      expect(await refundsOf(c.paymentId)).toEqual([{ orderItemId: c.itemIds[1], amountMinor: alloc[1], status: "succeeded" }]);
      expect((await sagaState(x, c.sagaId)).payment).toMatchObject({ refundedMinor: alloc[1], status: "partially_refunded" });
      // Item 1 is untouched and keeps its evidence.
      expect((await evidence(c.itemIds[0]))?.capturedMinor).toBe(alloc[0]);
    });
  });

  describe("review follow-ups (Sentinel, ce9d603..4e2b5c4)", () => {
    /** Every item reserved and the capture's answer lost; the read right after it is lost too, so the saga rests in capture_unknown. */
    async function lostCapture(x: Harness, n: number) {
      const c = await checkedOut(x, run, "AED", "card", { items: n });
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      for (const id of c.itemIds.slice(0, -1)) await reserved(x, id);
      c.gw.script("getPayment", { kind: "pass" }, { kind: "pass" }, { kind: "unknown", sent: true, applied: false });
      c.gw.script("capture", { kind: "unknown", sent: true, applied: false });
      await reserved(x, c.itemIds[n - 1]);
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("capture_unknown");
      expect(x.aed.callsOf("capture")).toHaveLength(1);
      return { c, pid };
    }

    it("P1-1: capture_unknown re-checks every item before capturing again: an item that expired releases everything, never a capture", async () => {
      const x = await harness(prisma);
      const { c } = await lostCapture(x, 3);
      x.engine.set(c.itemIds[1], "expired");
      await x.saga.advance(c.sagaId);
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("released");
      expect(s.payment).toMatchObject({ status: "voided", capturedMinor: 0n });
      expect(x.aed.callsOf("capture")).toHaveLength(1);
      expect(x.aed.callsOf("void")).toHaveLength(1);
    });

    it("P1-1: capture_unknown with an item turned outcome_unknown, an unknown send-by, or past the capture budget never captures again", async () => {
      for (const fault of ["outcome_unknown", "send_by_unknown", "budget"] as const) {
        const x = await harness(prisma);
        const { c } = await lostCapture(x, 3);
        if (fault === "outcome_unknown") x.engine.set(c.itemIds[1], "outcome_unknown");
        if (fault === "send_by_unknown") x.engine.sendByUnknown = true;
        // The fake's send-by is the reservation (15 min) less 5 min; the capture budget comes off that.
        if (fault === "budget") x.clock.advance(10 * MIN - CAPTURE_BUDGET_MS + 1_000);
        await x.saga.advance(c.sagaId);
        expect(x.aed.callsOf("capture"), fault).toHaveLength(1);
        expect((await sagaState(x, c.sagaId)).payment!.capturedMinor, fault).toBe(0n);
        if (fault !== "outcome_unknown") expect((await sagaState(x, c.sagaId)).state, fault).toBe("released");
      }
    });

    it("P1-1: capture_unknown on a multi-item order a human is looking at waits, captures nothing", async () => {
      const x = await harness(prisma);
      const { c } = await lostCapture(x, 2);
      await prisma.paymentSaga.update({ where: { id: c.sagaId }, data: { attentionRequiredAt: new Date() } });
      await x.saga.advance(c.sagaId);
      expect((await sagaState(x, c.sagaId)).state).toBe("capture_unknown");
      expect(x.aed.callsOf("capture")).toHaveLength(1);
    });

    it("P3-10: in reserved, an item that is no longer reserved still lets the capture deadline release everything", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card", { items: 2 });
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      await reserved(x, c.itemIds[0]);
      // A human is looking: the saga reaches `reserved` and waits there instead of capturing.
      await prisma.paymentSaga.update({ where: { id: c.sagaId }, data: { attentionRequiredAt: new Date() } });
      await reserved(x, c.itemIds[1]);
      expect((await sagaState(x, c.sagaId)).state).toBe("reserved");
      x.engine.set(c.itemIds[1], "outcome_unknown");
      x.clock.advance(10 * MIN - CAPTURE_BUDGET_MS + 1_000);
      await x.saga.advance(c.sagaId);
      const s = await sagaState(x, c.sagaId);
      expect(["release_pending", "released"]).toContain(s.state);
      expect(x.aed.callsOf("capture")).toHaveLength(0);
      expect(x.engine.calls.filter((k) => k.op === "releaseHold")).toHaveLength(2);
    });

    it("P2-4: an item-scoped problem after the capture does not withdraw the other items' evidence; the saga is told once they are done", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card", { items: 3 });
      x.engine.confirmOutcomeFor.set(c.itemIds[0], "too_late");
      // The operator refuses to release item 1's hold: only a human can say whether it is gone.
      x.engine.onRelease = (b) => {
        if (b.orderItemId === c.itemIds[0]) b.state = "cancel_refused";
      };
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      for (const id of c.itemIds) await reserved(x, id);
      await x.saga.advance(c.sagaId);
      // Items 2 and 3 were confirmed on their own evidence.
      expect(x.engine.bookings.get(c.itemIds[1])!.state).toBe("confirmed");
      expect(x.engine.bookings.get(c.itemIds[2])!.state).toBe("confirmed");
      expect(x.engine.confirmsSent).toBe(2);
      // Then, with no item left needing evidence, a human is told; nothing was refunded for item 1 yet.
      const s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("confirm_pending");
      expect(s.attentionRequiredAt).not.toBeNull();
      expect(await prisma.refund.count({ where: { paymentId: c.paymentId } })).toBe(0);
    });

    it("P3-6: an item refund smaller than the item's room records the shortfall on the item, and the saga stops in attention", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card", { items: 2 });
      const alloc = await allocations(c.r.orderId);
      x.engine.confirmOutcomeFor.set(c.itemIds[1], "rejected");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      for (const id of c.itemIds) await reserved(x, id);
      // 15_000 of the 21_000 went back outside Outly (a dashboard refund): only 6_000 is left for item 2's 11_000.
      await prisma.payment.update({ where: { id: c.paymentId }, data: { refundedMinor: 15_000n, status: "partially_refunded" } });
      await x.saga.notifier.bookingChanged(c.itemIds[1], "rejected");
      expect(await refundsOf(c.paymentId)).toEqual([{ orderItemId: c.itemIds[1], amountMinor: 6_000n, status: "succeeded" }]);
      const problems = await prisma.customerRemedy.findMany({ where: { orderItemId: c.itemIds[1], status: "failed" } });
      expect(problems.map((r) => [r.kind, r.reason, r.amountMinor, r.refundId])).toEqual([["refund", "item_refund_short", alloc[1] - 6_000n, null]]);
      expect((await sagaState(x, c.sagaId)).state).toBe("attention");
    });

    it("P3-5: a confirm found underway on a multi-item order with an item never reserved flags the saga and stays put", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "INR", "upi", { items: 3 });
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.captured", pid);
      // Item 1's confirm went out outside the saga (an anomaly): the saga never starts item 2.
      x.engine.reserve(c.itemIds[0]);
      x.engine.sendConfirm(c.itemIds[0], "confirming");
      await x.saga.notifier.bookingChanged(c.itemIds[0], "confirming");
      // Past the reserve deadline: the release finds the confirm underway, with items 2 and 3 never reserved.
      x.clock.advance(45 * MIN);
      await x.saga.advance(c.sagaId);
      const s = await sagaState(x, c.sagaId);
      expect(s.state).not.toBe("confirm_pending");
      expect(s.attentionRequiredAt).not.toBeNull();
      expect(x.engine.count("startAttempt")).toBe(1);
    });

    it("P2-3: no item of a multi-item order can be cancelled (not even by exception) until the saga is fulfilled", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card", { items: 2 });
      x.engine.confirmOutcomeFor.set(c.itemIds[1], "unknown");
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      for (const id of c.itemIds) await reserved(x, id);
      expect((await sagaState(x, c.sagaId)).state).toBe("confirm_pending");
      expect(x.engine.bookings.get(c.itemIds[0])!.state).toBe("confirmed");
      const { createCancellationService, loadCancellationFacts } = await import("../../services/cancellation.service");
      const before = await loadCancellationFacts(c.r.orderId);
      expect(c.itemIds.map((id) => before.get(id)?.orderSettling)).toEqual([true, true]);
      // The engine row the facts read: item 1 confirmed.
      await prisma.supplierBooking.update({ where: { id: x.engine.bookings.get(c.itemIds[0])!.id }, data: { state: "confirmed", confirmedAt: new Date() } });
      const svc = createCancellationService({ requestCancel: async () => {}, now: x.clock.now });
      for (const kind of ["cancel", "exception"] as const) {
        expect(await svc.request({ orderId: c.r.orderId, orderItemId: c.itemIds[0], kind, via: "customer" }), kind).toMatchObject({ ok: false, reason: "not_eligible" });
      }
      expect(await prisma.cancellationRequest.count({ where: { orderId: c.r.orderId } })).toBe(0);
      // Once fulfilled the order is settled: the item's own policy decides again (here non-refundable, so an exception may be asked).
      x.engine.set(c.itemIds[1], "confirmed");
      await x.saga.advance(c.sagaId);
      expect((await sagaState(x, c.sagaId)).state).toBe("fulfilled");
      expect((await loadCancellationFacts(c.r.orderId)).get(c.itemIds[0])?.orderSettling).toBeUndefined();
      expect(await svc.request({ orderId: c.r.orderId, orderItemId: c.itemIds[0], kind: "exception", via: "customer" })).toMatchObject({ ok: true });
    });

    it("P2-3: a one-item order's facts carry no settling flag", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card");
      expect((await (await import("../../services/cancellation.service")).loadCancellationFacts(c.r.orderId)).get(c.orderItemId)?.orderSettling).toBeUndefined();
    });

    it("P2-2: money refunded outside Outly settles one item's failed refund, never two", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card", { items: 3 });
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      for (const id of c.itemIds) await reserved(x, id);
      await x.saga.notifier.bookingChanged(c.itemIds[0], "confirmed");
      expect((await sagaState(x, c.sagaId)).state).toBe("fulfilled");
      const { refundSettledElsewhere } = await import("../../services/cancellation.service");
      const { uuidv7 } = await import("../../lib/ids");
      // 11_000 back at the provider outside Outly; items of 10_000 and 11_000 each have a failed cancellation refund.
      await prisma.payment.update({ where: { id: c.paymentId }, data: { refundedMinor: 11_000n, status: "partially_refunded" } });
      const failedRequest = async (orderItemId: string) => {
        const id = uuidv7();
        await prisma.cancellationRequest.create({ data: { id, orderId: c.r.orderId, orderItemId, kind: "supported", status: "refund_failed", requestedVia: "customer", reasonCode: "refund_failed" } });
        return id;
      };
      const second = await failedRequest(c.itemIds[1]);
      const first = await failedRequest(c.itemIds[0]);
      expect(await refundSettledElsewhere(prisma, second)).toBe(true);
      expect(await refundSettledElsewhere(prisma, first)).toBe(true);
      // Staff close the second as refunded at the provider: the outside 11_000 is now spoken for.
      await prisma.cancellationRequest.update({ where: { id: second }, data: { status: "refunded", closedAt: new Date(), reasonCode: "resolved_refunded_at_provider" } });
      expect(await refundSettledElsewhere(prisma, first)).toBe(false);
    });

    it("P3-7: the refund cap itself refuses an item that is not on the payment's order", async () => {
      const x = await harness(prisma);
      const a = await checkedOut(x, run, "INR", "upi", { items: 2 });
      const b = await checkedOut(x, run, "INR", "upi");
      // Captured, so the payment-level cap has room and only the item check can refuse.
      await deliver(x, a.gw, "payment.captured", a.gw.pay(a.providerOrderId));
      expect((await sagaState(x, a.sagaId)).payment!.capturedMinor).toBeGreaterThan(0n);
      const { uuidv7 } = await import("../../lib/ids");
      await expect(
        prisma.refund.create({
          data: { id: uuidv7(), paymentId: a.paymentId, orderItemId: b.orderItemId, provider: "fake-inr-pacb", currency: "INR", idempotencyKey: `zz-foreign-${run}-${a.paymentId}`, amountMinor: 1n, reason: "zz_test" },
        }),
      ).rejects.toThrow(/item cap: order item .* is not on the order of payment/);
    });

    it("P3-11: once an order has a saga, no item can be added to it or moved into or out of it", async () => {
      const x = await harness(prisma);
      const a = await checkedOut(x, run, "AED", "card", { items: 2 });
      const b = await checkedOut(x, run, "AED", "card");
      const { uuidv7 } = await import("../../lib/ids");
      const src = await prisma.orderItem.findUniqueOrThrow({ where: { id: a.itemIds[1] } });
      const { id: _id, orderId: _order, quoteLineIndex: _ix, ...copy } = src;
      await expect(
        prisma.orderItem.create({ data: { ...copy, id: uuidv7(), orderId: a.r.orderId, pax: copy.pax as object, addons: copy.addons as object, cancellationPolicySnapshot: copy.cancellationPolicySnapshot as object, marginSnapshot: copy.marginSnapshot as object } }),
      ).rejects.toThrow(/its items are fixed/);
      await expect(prisma.orderItem.update({ where: { id: a.itemIds[1] }, data: { orderId: b.r.orderId } })).rejects.toThrow(/its items are fixed/);
      // A status change is not a move.
      await prisma.orderItem.update({ where: { id: a.itemIds[1] }, data: { status: "pending" } });
    });

    it("P3-9: checkout uses the quote's own repeat key: two lines for one variant, date and slot are refused even under different mappings", async () => {
      const x = await harness(prisma);
      let first: string | null = null;
      const q = await quoteFixture(x, run, "AED", {
        items: 2,
        line: async (productId) => {
          first ??= productId;
          return { productId: first };
        },
      });
      expect(await x.checkout.start(startInput(q, "card"))).toEqual({ ok: false, reason: "too_many_items" });
    });
  });

  describe("TravelDesk TEST drill of 4 November 2026 (E2E stalled after item 1)", () => {
    it("item 1 confirms, then its ticket read needs staff: items 2 and 3 keep their evidence and confirm on the following runs", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card", { items: 3 });
      // Items 2 and 3 are not confirmable on the first run (the worker has not reached them).
      x.engine.heldForHuman.add(c.itemIds[1]);
      x.engine.heldForHuman.add(c.itemIds[2]);
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      for (const id of c.itemIds) await reserved(x, id);
      expect(x.engine.bookings.get(c.itemIds[0])!.state).toBe("confirmed");
      // Item 1's ticket read: no codes, staff must look (document.service `ticket_read_needs_staff`).
      const { uuidv7 } = await import("../../lib/ids");
      const booking1 = x.engine.bookings.get(c.itemIds[0])!.id;
      await prisma.supplierDocument.create({
        data: { id: uuidv7(), supplierBookingId: booking1, orderId: c.r.orderId, orderItemId: c.itemIds[0], kind: "ticket_codes", version: 1, status: "pending", source: "document_read", attentionRequiredAt: new Date() },
      });
      await x.saga.notifier.bookingChanged(c.itemIds[0], "confirmed");
      let s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("confirm_pending");
      expect(s.attentionRequiredAt).toBeNull();
      expect((await evidence(c.itemIds[1]))?.capturedMinor).toBeGreaterThan(0n);
      expect((await evidence(c.itemIds[2]))?.capturedMinor).toBeGreaterThan(0n);
      // The following scheduled runs reach items 2 and 3.
      x.engine.heldForHuman.clear();
      await x.saga.advance(c.sagaId);
      await x.saga.advance(c.sagaId);
      s = await sagaState(x, c.sagaId);
      expect(c.itemIds.map((id) => x.engine.bookings.get(id)!.state)).toEqual(["confirmed", "confirmed", "confirmed"]);
      expect(x.engine.confirmsSent).toBe(3);
      expect(s.state).toBe("fulfilled");
      expect(x.engine.calls.filter((k) => k.op === "confirmIfPaid").length).toBeGreaterThanOrEqual(5);
    });

    it("the drill's actual cause: items held for a human at reserve (charged amount mismatch) never block item 1; at expiry each is refunded on its own", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card", { items: 3 });
      const alloc = await allocations(c.r.orderId);
      x.engine.heldForHuman.add(c.itemIds[1]);
      x.engine.heldForHuman.add(c.itemIds[2]);
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      for (const id of c.itemIds) await reserved(x, id);
      // Several scheduled runs: item 1 confirmed; items 2 and 3 stay with the engine's human, the saga is not flagged.
      for (let i = 0; i < 3; i++) await x.saga.advance(c.sagaId);
      let s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("confirm_pending");
      expect(s.attentionRequiredAt).toBeNull();
      expect(x.engine.confirmsSent).toBe(1);
      // The holds lapse (the engine's watchdog records the expiry): exactly those items' allocations come back.
      x.engine.set(c.itemIds[1], "expired");
      x.engine.set(c.itemIds[2], "expired");
      await x.saga.advance(c.sagaId);
      s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("fulfilled");
      expect(await refundsOf(c.paymentId)).toEqual([
        { orderItemId: c.itemIds[1], amountMinor: alloc[1], status: "succeeded" },
        { orderItemId: c.itemIds[2], amountMinor: alloc[2], status: "succeeded" },
      ]);
      expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "partially_confirmed" });
    });
  });

  describe("concurrency, crashes and replays", () => {
    it("a crash between items resumes safely: the next item is started exactly once, never twice", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card", { items: 3 });
      const pid = c.gw.pay(c.providerOrderId);
      await deliver(x, c.gw, "payment.authorized", pid);
      x.engine.crashNextStart = true;
      // The process dies while starting item 2: the step's transaction rolls back with it.
      await reserved(x, c.itemIds[0]);
      let s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("reserve_pending");
      expect(await prisma.supplierBooking.count({ where: { orderItemId: c.itemIds[1] } })).toBe(0);
      // Two runs at once (the job and a webhook): one starts item 2, the other finds it started.
      await Promise.all([x.saga.advance(c.sagaId), x.saga.advance(c.sagaId)]);
      expect(await prisma.supplierBooking.count({ where: { orderItemId: c.itemIds[1] } })).toBe(1);
      expect(x.engine.count("startAttempt")).toBe(2);
      await x.saga.advance(c.sagaId);
      expect(x.engine.count("startAttempt")).toBe(2);
      await reserved(x, c.itemIds[1]);
      await reserved(x, c.itemIds[2]);
      await x.saga.notifier.bookingChanged(c.itemIds[0], "confirmed");
      s = await sagaState(x, c.sagaId);
      expect(s.state).toBe("fulfilled");
      for (const id of c.itemIds) expect(await prisma.supplierBooking.count({ where: { orderItemId: id } })).toBe(1);
      expect(x.aed.callsOf("capture")).toHaveLength(1);
    });

    it("a replayed webhook changes nothing: no second attempt, no second capture", async () => {
      const x = await harness(prisma);
      const c = await checkedOut(x, run, "AED", "card", { items: 2 });
      const pid = c.gw.pay(c.providerOrderId);
      const first = await deliver(x, c.gw, "payment.authorized", pid, { eventId: `evt_multi_${run}_${c.paymentId.slice(-6)}` });
      expect(first.result).toBe("stored");
      const replay = await x.inbox.receive(c.gw.provider, first.webhook.raw, first.webhook.headers);
      expect(replay.result).toBe("duplicate");
      // A second, distinct notification for the same payment is read and acted on idempotently.
      await deliver(x, c.gw, "payment.authorized", pid);
      expect(x.engine.count("startAttempt")).toBe(1);
      await reserved(x, c.itemIds[0]);
      await reserved(x, c.itemIds[1]);
      await deliver(x, c.gw, "payment.captured", pid);
      await x.saga.notifier.bookingChanged(c.itemIds[0], "confirmed");
      expect((await sagaState(x, c.sagaId)).state).toBe("fulfilled");
      expect(x.aed.callsOf("capture")).toHaveLength(1);
      expect(x.engine.count("startAttempt")).toBe(2);
      expect(x.engine.confirmsSent).toBe(2);
    });
  });
});
