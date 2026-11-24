import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbEnabled, runId } from "../../__tests__/helpers/fixtures";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import { uuidv7 } from "../../lib/ids";
import type { EngineDeps } from "../../services/supplier-booking.service";
import { TravelDeskApiError } from "../../suppliers/traveldesk/traveldesk.http";
import type { EngineSagaApi, SagaNotifier } from "../contracts";
import type { PaymentSagaService } from "../saga";
import { checkedOut, cleanupB3, deliver, harness, sagaState, type Harness } from "./_b3-harness";
import { ScriptedTravelDesk } from "./_traveldesk-fake";

/**
 * The payment saga with the REAL engine seam (`createEngineSagaApi`,
 * engine-saga.service.ts), the real booking engine and worker
 * (`supplierBookingService.runDueJobs`) and the real TravelDesk adapter over
 * a scripted TravelDesk, on Postgres (CR-B3-11). Fake gateways only.
 * Imported by evidence.test.ts (the payments db suite).
 *
 * Each test has its own synthetic supplier row (`zz-b3-td-<id>`), so a worker
 * run never claims another test's jobs. Synthetic amounts: AED 10_000 fils
 * charged, supplier net 5_000.
 */

type Prisma = typeof import("../../lib/db").prisma;

const OFFER = 778_001;
const OFFER_HASH = "b".repeat(64);

describe.skipIf(!dbEnabled)("B3 payment saga with the real engine and a scripted TravelDesk (disposable database)", () => {
  let prisma: Prisma;
  let engine: typeof import("../../services/supplier-booking.service");
  const run = runId();
  const suppliers: { id: string; code: string }[] = [];

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    await cleanupB3(prisma);
    engine = await import("../../services/supplier-booking.service");
  });

  afterAll(async () => {
    await cleanupB3(prisma);
    const ids = suppliers.map((s) => s.id);
    await prisma.supplierAccountLease.deleteMany({ where: { supplierId: { in: ids } } });
    for (const s of suppliers) await prisma.setting.deleteMany({ where: { key: { startsWith: `supplier_budget.${s.code}.` } } });
  });

  /** A harness whose saga talks to the real engine, wired as wiring.ts does it, with hooks for racing the release. */
  async function withEngine() {
    const base = await harness(prisma);
    const code = `zz-b3-td-${uuidv7().slice(-12)}`;
    const supplier = await prisma.supplier.create({ data: { id: uuidv7(), code, name: "zz-b3 TravelDesk (saga with the engine)", source: "api", adapter: "traveldesk" } });
    suppliers.push({ id: supplier.id, code });
    const { storedOffer, storedSlot } = await import("../../suppliers/__tests__/fixtures/traveldesk-terms");
    await prisma.supplierCatalogueItem.create({
      data: {
        id: uuidv7(),
        supplierId: supplier.id,
        environment: "test",
        kind: "offer",
        externalId: String(OFFER),
        parentExternalId: "1",
        name: "zz-b3 engine saga offer",
        bookingKind: "live_book",
        payload: storedOffer({ offerId: OFFER, tourId: 1, timeSlots: [storedSlot({ timeSlotId: 9, startMinutes: 1260, endMinutes: 1365 })] }) as never,
        payloadHash: "x",
      },
    });

    const { createEngineSagaApi } = await import("../../services/engine-saga.service");
    const { createPaymentSaga, dbBookingStateReader } = await import("../saga");
    const { createPaymentInbox } = await import("../inbox");
    const { createGatewayRegistry } = await import("../registry");
    const { paymentEvidenceFrom } = await import("../evidence");
    const { TravelDeskBookingAdapter } = await import("../../suppliers/traveldesk/traveldesk.booking-adapter");
    const { readLimits } = await import("../../suppliers/read-budget");

    const now = base.clock.now;
    const td = new ScriptedTravelDesk(now);
    const payments = paymentEvidenceFrom(prisma);
    let saga: PaymentSagaService | null = null;
    const notifier: SagaNotifier = { bookingChanged: (i, s) => saga!.notifier.bookingChanged(i, s) };
    const api = createEngineSagaApi({ config: () => ({ environment: "test", agencyId: null, mutationTimeoutMs: 1_000 }), payments, saga: notifier, supplierCode: code, now });
    /** `tooLate`: the saga's own deadline view says too late (its clock ran past the send-by). `beforeRelease`: runs before the engine takes the booking lock. */
    const hooks: { tooLate: boolean; beforeRelease: (() => Promise<void>) | null } = { tooLate: false, beforeRelease: null };
    const seam: EngineSagaApi = {
      ...api,
      confirmIfPaid: async (id) => (hooks.tooLate ? "too_late" : api.confirmIfPaid(id)),
      releaseHold: async (id, reason) => {
        if (hooks.beforeRelease) await hooks.beforeRelease();
        return api.releaseHold(id, reason);
      },
    };
    const gateways = createGatewayRegistry([base.inr, base.aed], { production: false });
    saga = createPaymentSaga({ gateways, engine: seam, bookings: dbBookingStateReader, now });
    const inbox = createPaymentInbox({ gateways, saga, now });
    const h: Harness = { ...base, saga, inbox };

    const deps = (over: Partial<EngineDeps> = {}): EngineDeps => ({
      adapter: new TravelDeskBookingAdapter(td, { environment: "test", now }),
      environment: "test",
      supplierCode: code,
      mutationTimeoutMs: 1_000,
      now,
      readLimits: readLimits(1_000_000),
      payments,
      saga: notifier,
      ...over,
    });

    /** Worker runs (manual: mutations allowed), the clock moving on when nothing was due. */
    async function work(over: Partial<EngineDeps> = {}, rounds = 8) {
      const outcomes: string[] = [];
      for (let i = 0; i < rounds; i++) {
        const r = await engine.supplierBookingService.runDueJobs(deps(over), { budgetMs: 60_000 });
        outcomes.push(...r.processed.map((p) => `${p.kind}:${p.outcome}`));
        if (!r.processed.length) base.clock.advance(31_000);
      }
      return outcomes;
    }

    /** Checkout of a quote whose line(s) are mapped to the scripted TravelDesk offer. */
    async function sold(items = 1) {
      return checkedOut(h, run, "AED", "card", {
        items,
        async line(productId) {
          const mapping = await prisma.productSupplierMapping.create({
            data: {
              id: uuidv7(),
              productId,
              supplierId: supplier.id,
              externalRef: { tourId: 1, offerId: OFFER, bookingKind: "live_book", isExternal: false },
              supplierProductId: "1",
              supplierOfferId: String(OFFER),
              bookingKind: "live_book",
              environment: "test",
              syncStatus: "ok",
              approvedOfferHash: OFFER_HASH,
            },
          });
          return { mappingId: mapping.id, approvedOfferHash: OFFER_HASH, slotRef: "9@21:00", supplierNetUsdMinor: "1400" };
        },
      });
    }

    async function booking(orderItemId: string) {
      return prisma.supplierBooking.findFirstOrThrow({ where: { orderItemId } });
    }

    return { h, td, hooks, work, sold, booking };
  }

  async function events(bookingId: string, kind: string) {
    return prisma.supplierBookingEvent.count({ where: { supplierBookingId: bookingId, kind } });
  }

  it("pay → reserve → capture → confirm, end to end on the real engine", async () => {
    const e = await withEngine();
    const c = await e.sold();
    const pid = c.gw.pay(c.providerOrderId);
    await deliver(e.h, c.gw, "payment.authorized", pid);
    expect((await sagaState(e.h, c.sagaId)).state).toBe("reserve_pending");
    const queued = await e.booking(c.orderItemId);
    expect(queued).toMatchObject({ state: "queued", afterReserve: "await_payment", idempotencyKey: `order:${c.r.orderId}:item:${c.orderItemId}:try:1` });
    expect(c.gw.callsOf("capture")).toHaveLength(0);

    await e.work();
    const s = await sagaState(e.h, c.sagaId);
    expect(s.state).toBe("fulfilled");
    expect(s.payment).toMatchObject({ status: "captured", capturedMinor: 10_000n });
    expect(c.gw.callsOf("capture")).toEqual([[pid, 10_000n, `capture:${c.paymentId}`]]);
    const b = await e.booking(c.orderItemId);
    expect(b.state).toBe("confirmed");
    expect(e.td.calls.filter((x) => x === "reserve" || x === "confirm")).toEqual(["reserve", "confirm"]);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "confirmed" });
    expect(await prisma.refund.count({ where: { paymentId: c.paymentId } })).toBe(0);
  });

  it("multi-item on the real engine (TravelDesk TEST drill, 4 Nov 2026): item 2 charged off its quote is held for a human; items 1 and 3 still confirm; item 2 is refunded at its expiry", async () => {
    const e = await withEngine();
    // Reserves in item order; the second is charged 40 fils more than asked, as TravelDesk TEST did for two pickup offers.
    e.td.chargeOffsets.push(0n, 40n, 0n);
    const c = await e.sold(3);
    const pid = c.gw.pay(c.providerOrderId);
    await deliver(e.h, c.gw, "payment.authorized", pid);
    await e.work();
    const b = await Promise.all(c.itemIds.map((id) => e.booking(id)));
    expect(b.map((x) => x.state)).toEqual(["confirmed", "awaiting_payment", "confirmed"]);
    expect(b[1]).toMatchObject({ errorCode: "charged_amount_mismatch" });
    expect(b[1].attentionRequiredAt).not.toBeNull();
    expect(e.td.calls.filter((x) => x === "reserve" || x === "confirm")).toEqual(["reserve", "reserve", "reserve", "confirm", "confirm"]);
    let s = await sagaState(e.h, c.sagaId);
    expect(s.state).toBe("confirm_pending");
    // The engine's hold on item 2 is item-scoped: the saga is not flagged, items 1 and 3 kept their evidence.
    expect(s.attentionRequiredAt).toBeNull();
    expect(c.gw.callsOf("capture")).toHaveLength(1);
    // Past item 2's hold: the watchdog records the expiry and the saga refunds exactly its allocation.
    e.h.clock.advance(20 * 60_000);
    await e.work();
    expect((await e.booking(c.itemIds[1])).state).toBe("expired");
    s = await sagaState(e.h, c.sagaId);
    expect(s.state).toBe("fulfilled");
    const refunds = await prisma.refund.findMany({ where: { paymentId: c.paymentId } });
    expect(refunds.map((r) => [r.orderItemId, r.amountMinor, r.status])).toEqual([[c.itemIds[1], 11_000n, "succeeded"]]);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "partially_confirmed" });
  });

  it("reserve rejected → the hold is voided, with no supplier call beyond the reserve", async () => {
    const e = await withEngine();
    e.td.steps.reserve.push(new TravelDeskApiError("auth", "bookings.reserve", { status: 403 }));
    const c = await e.sold();
    const pid = c.gw.pay(c.providerOrderId);
    await deliver(e.h, c.gw, "payment.authorized", pid);
    await e.work();
    expect((await e.booking(c.orderItemId)).state).toBe("rejected");
    const s = await sagaState(e.h, c.sagaId);
    expect(s.state).toBe("released");
    expect(s.payment).toMatchObject({ status: "voided", capturedMinor: 0n });
    expect(c.gw.callsOf("capture")).toHaveLength(0);
    expect(c.gw.callsOf("void")).toEqual([[pid, `void:${c.paymentId}`]]);
    expect(e.td.calls).toEqual(["reserve"]);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "payment_failed" });
  });

  /** Paid and captured, the confirm queued by the engine, the worker not run yet. */
  async function capturedWithConfirmQueued(e: Awaited<ReturnType<typeof withEngine>>) {
    const c = await e.sold();
    await deliver(e.h, c.gw, "payment.authorized", c.gw.pay(c.providerOrderId));
    // The reserve runs with the saga not told, so the saga moves only when the test says.
    await e.work({ saga: undefined }, 2);
    expect((await e.booking(c.orderItemId)).state).toBe("awaiting_payment");
    await e.h.saga.advance(c.sagaId);
    expect((await sagaState(e.h, c.sagaId)).state).toBe("confirm_pending");
    expect(await prisma.supplierJob.findUnique({ where: { dedupeKey: `confirm:${(await e.booking(c.orderItemId)).id}` } })).toMatchObject({ status: "queued" });
    return c;
  }

  it("CR-B3-1 race, confirm first: the saga judged it too late, but the worker sent the confirm; the capture is kept and fulfilled", async () => {
    const e = await withEngine();
    const c = await capturedWithConfirmQueued(e);
    e.hooks.tooLate = true;
    // The worker claims the queued confirm and sends it before the saga's release takes the booking lock.
    e.hooks.beforeRelease = async () => {
      e.hooks.beforeRelease = null;
      await e.work({ saga: undefined }, 1);
    };
    await e.h.saga.advance(c.sagaId);
    const b = await e.booking(c.orderItemId);
    expect(b.state).toBe("confirmed");
    expect(await events(b.id, "release_requested")).toBe(0);
    expect(await prisma.refund.count({ where: { paymentId: c.paymentId } })).toBe(0);
    expect(await prisma.customerRemedy.count({ where: { orderItemId: c.orderItemId } })).toBe(0);
    await e.h.saga.advance(c.sagaId);
    const s = await sagaState(e.h, c.sagaId);
    expect(s.state).toBe("fulfilled");
    expect(s.payment).toMatchObject({ status: "captured", capturedMinor: 10_000n, refundedMinor: 0n });
    expect(e.td.calls.filter((x) => x === "confirm")).toHaveLength(1);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: c.r.orderId } })).toMatchObject({ status: "confirmed" });
  });

  it("CR-B3-1 race, release first: no confirm is ever sent, and the refund waits for the verified cancel", async () => {
    const e = await withEngine();
    const c = await capturedWithConfirmQueued(e);
    e.hooks.tooLate = true;
    await e.h.saga.advance(c.sagaId);
    const held = await e.booking(c.orderItemId);
    expect(await events(held.id, "release_requested")).toBe(1);
    expect((await sagaState(e.h, c.sagaId)).state).toBe("release_pending");
    expect(await prisma.refund.count({ where: { paymentId: c.paymentId } })).toBe(0);
    expect(await prisma.customerRemedy.findMany({ where: { orderItemId: c.orderItemId } })).toMatchObject([{ kind: "refund", status: "pending", refundId: null, reason: "confirm_too_late" }]);

    // The manual worker run sends the cancel; the engine verifies it and tells the saga.
    await e.work();
    expect((await e.booking(c.orderItemId)).state).toBe("cancelled");
    expect(e.td.calls).toContain("cancel");
    expect(e.td.calls).not.toContain("confirm");
    const s = await sagaState(e.h, c.sagaId);
    expect(s.state).toBe("refunded");
    expect(await prisma.refund.findMany({ where: { paymentId: c.paymentId } })).toMatchObject([{ reason: "confirm_too_late", status: "succeeded", amountMinor: 10_000n }]);
    expect(await prisma.customerRemedy.findMany({ where: { orderItemId: c.orderItemId } })).toMatchObject([{ kind: "refund", status: "completed" }]);
  });
  /* -------------------------------------------------------------------------
   * Doc 29 Batch 6: external confirmations after the capture
   * ---------------------------------------------------------------------- */

  it("an external confirmation still in progress past its wait limit is handed to our team and never refunded; once the supplier fails it, the item is refunded in full", async () => {
    const e = await withEngine();
    e.td.steps.confirm.push("in_progress");
    const c = await e.sold();
    await deliver(e.h, c.gw, "payment.authorized", c.gw.pay(c.providerOrderId));
    await e.work();
    expect((await e.booking(c.orderItemId)).state).toBe("awaiting_external");
    expect((await sagaState(e.h, c.sagaId)).state).toBe("confirm_pending");
    expect(c.gw.callsOf("capture")).toHaveLength(1);

    // Forty minutes later the supplier is still working: handed off, still waiting, no money moved back.
    for (let i = 0; i < 10; i++) {
      e.h.clock.advance(4 * 60_000);
      await e.work({}, 2);
      await e.h.saga.advance(c.sagaId);
    }
    const handed = await e.booking(c.orderItemId);
    expect(handed).toMatchObject({ state: "awaiting_external", errorCode: "external_confirmation_handoff" });
    expect(handed.attentionRequiredAt).not.toBeNull();
    expect((await sagaState(e.h, c.sagaId)).state).toBe("confirm_pending");
    expect(await prisma.refund.count({ where: { paymentId: c.paymentId } })).toBe(0);

    // The supplier now shows it failed: rejected, refunded in full through the saga's refund path, no cancel sent.
    const id = handed.supplierBookingId!;
    e.td.store.set(id, { ...e.td.store.get(id)!, externalInProgress: false, externalFailed: true });
    e.h.clock.advance(11 * 60_000);
    await e.work({}, 3);
    await e.h.saga.advance(c.sagaId);
    expect(await e.booking(c.orderItemId)).toMatchObject({ state: "rejected", errorCode: "external_booking_failed" });
    expect((await sagaState(e.h, c.sagaId)).state).toBe("refunded");
    expect(await prisma.refund.findMany({ where: { paymentId: c.paymentId } })).toMatchObject([{ reason: "confirm_rejected", status: "succeeded", amountMinor: 10_000n }]);
    expect(e.td.calls).not.toContain("cancel");
  });

  it("a confirm answered 201 with the external failed flag after the capture refunds the item in full and tells our team", async () => {
    const e = await withEngine();
    e.td.steps.confirm.push("external_failed");
    const c = await e.sold();
    await deliver(e.h, c.gw, "payment.authorized", c.gw.pay(c.providerOrderId));
    await e.work();
    const b = await e.booking(c.orderItemId);
    expect(b).toMatchObject({ state: "rejected", errorCode: "external_booking_failed" });
    expect(b.attentionRequiredAt).not.toBeNull();
    await e.h.saga.advance(c.sagaId);
    expect((await sagaState(e.h, c.sagaId)).state).toBe("refunded");
    expect(await prisma.refund.findMany({ where: { paymentId: c.paymentId } })).toMatchObject([{ reason: "confirm_rejected", status: "succeeded", amountMinor: 10_000n }]);
    expect(e.td.calls.filter((x) => x === "reserve" || x === "confirm" || x === "cancel")).toEqual(["reserve", "confirm"]);
  });
});
