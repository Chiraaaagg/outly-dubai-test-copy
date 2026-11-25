import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma as P } from "@prisma/client";
import { uuidv7 } from "../../lib/ids";
import { SYSTEM_ACTOR } from "../../lib/actor";
import { dbEnabled, runId } from "../../__tests__/helpers/fixtures";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import type { CreateOrderItemInput } from "../../services/order.service";
// The B3 database suites (checkout, inbox, saga, saga with the real engine, saga with Stripe) run
// in this file, the payments suite listed in vitest.suites.mjs.
import "./checkout-inbox.db-suite";
import "./saga.db-suite";
import "./saga-engine.db-suite";
import "./saga-multi.db-suite";
import "./stripe-saga.db-suite";
import "./checkout-grant.db-suite";

/**
 * Payment evidence and manual-payment provenance on Postgres (doc 22 PAY-1,
 * PAY-9, PRD-3). The pure rules are in evidence.unit.test.ts and
 * order.service.unit.test.ts; this proves the same answers come out of real
 * rows, columns and checks.
 *
 * Every row is synthetic (synthetic amounts, `test-evidence` names) and is
 * written inside a transaction that is always rolled back, so nothing
 * persists. The port and the order service both take that transaction.
 */

type Prisma = typeof import("../../lib/db").prisma;
type Tx = Parameters<Parameters<Prisma["$transaction"]>[0]>[0];

const ROLLBACK = new Error("ROLLBACK");

async function rolledBack(prisma: Prisma, fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

describe.skipIf(!dbEnabled)("payment evidence and manual payments (disposable database)", () => {
  let prisma: Prisma;
  let orderService: typeof import("../../services/order.service").orderService;
  let paymentEvidenceFrom: typeof import("../evidence").paymentEvidenceFrom;
  const run = runId();

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    ({ orderService } = await import("../../services/order.service"));
    ({ paymentEvidenceFrom } = await import("../evidence"));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function comboItem(tx: Tx, over: Partial<CreateOrderItemInput> = {}): Promise<CreateOrderItemInput> {
    const combo = await tx.combo.create({ data: { id: uuidv7(), slug: `zz-evidence-${run}-${uuidv7().slice(-8)}`, name: "test-evidence", confirmation: "manual" } });
    return {
      comboId: combo.id,
      titleSnapshot: "test-evidence",
      tierSnapshot: "C",
      slugSnapshot: combo.slug,
      kindSnapshot: "combo",
      confirmationSnapshot: "manual",
      fulfilmentModeSnapshot: "inquiry",
      freeCancellationHoursSnapshot: 24,
      durationMinutesSnapshot: 60,
      serviceDate: "2030-01-15",
      pax: { adult: 1, child: 0, infant: 0, senior: 0 } as CreateOrderItemInput["pax"],
      addons: [],
      unitInr: 230_000n,
      unitAed: 10_000n,
      totalInr: 230_000n,
      totalAed: 10_000n,
      fulfilmentOrigin: "assisted_conversion",
      ...over,
    };
  }

  /** A single-item AED instant-checkout order (test-only flag), total 10_000 fils. */
  async function instantOrder(tx: Tx, items = 1) {
    const list = [];
    for (let i = 0; i < items; i++) list.push(await comboItem(tx, { fulfilmentOrigin: "instant_checkout", fulfilmentModeSnapshot: "instant" }));
    const order = await orderService.createOrder(
      { rail: "self_serve", currency: "AED", paymentCollection: "gateway", traveller: { fullName: "test-evidence", phoneE164: "+971000000000" }, items: list },
      SYSTEM_ACTOR,
      tx,
      { allowInstantCheckout: "test-only" },
    );
    const rows = await tx.orderItem.findMany({ where: { orderId: order.id }, orderBy: { id: "asc" } });
    return { orderId: order.id, itemIds: rows.map((r) => r.id) };
  }

  function gatewayPayment(tx: Tx, orderId: string, over: Partial<P.PaymentUncheckedCreateInput> = {}) {
    return tx.payment.create({
      data: {
        id: uuidv7(),
        orderId,
        gateway: "fake-aed-card",
        gatewayPaymentId: `fp_${uuidv7()}`,
        source: "gateway_verified",
        provider: "fake-aed-card",
        providerAccountId: "fake-account-1",
        environment: "test",
        rail: "aed_card",
        status: "captured",
        currency: "AED",
        amountMinor: 10_000n,
        capturedMinor: over.status && over.status !== "captured" ? 0n : ((over.amountMinor as bigint | undefined) ?? 10_000n),
        capturedAt: new Date("2030-01-10T08:00:00Z"),
        ...over,
      },
    });
  }

  /** The saga binding a payment to the order's item (B3): only this payment can be evidence. */
  function sagaFor(tx: Tx, orderId: string, orderItemId: string, paymentId: string | null, state = "confirm_pending") {
    return tx.paymentSaga.create({ data: { id: uuidv7(), orderId, orderItemId, paymentId, rail: "aed_card", state } });
  }

  it("createOrder stores each item's origin, and the column check accepts both values", async () => {
    await rolledBack(prisma, async (tx) => {
      const assisted = await orderService.createOrder(
        { rail: "assisted", currency: "INR", paymentCollection: "manual_link", traveller: { fullName: "test-evidence", phoneE164: "+910000000000" }, items: [await comboItem(tx)] },
        SYSTEM_ACTOR,
        tx,
      );
      expect((await tx.orderItem.findFirstOrThrow({ where: { orderId: assisted.id } })).fulfilmentOrigin).toBe("assisted_conversion");
      const { itemIds } = await instantOrder(tx);
      expect((await tx.orderItem.findUniqueOrThrow({ where: { id: itemIds[0] } })).fulfilmentOrigin).toBe("instant_checkout");
    });
  });

  it("createOrder refuses instant checkout without the test-only flag and writes nothing", async () => {
    await rolledBack(prisma, async (tx) => {
      const before = await tx.order.count();
      const item = await comboItem(tx, { fulfilmentOrigin: "instant_checkout" });
      await expect(
        orderService.createOrder({ rail: "self_serve", currency: "AED", paymentCollection: "gateway", traveller: { fullName: "test-evidence", phoneE164: "+971000000000" }, items: [item] }, SYSTEM_ACTOR, tx),
      ).rejects.toMatchObject({ status: 409, reason: "instant_checkout_disabled" });
      expect(await tx.order.count()).toBe(before);
    });
  });

  it("a verified capture of the charged total, bound by the item's saga, is evidence", async () => {
    await rolledBack(prisma, async (tx) => {
      const { orderId, itemIds } = await instantOrder(tx);
      const port = paymentEvidenceFrom(tx);
      expect(await port.capturedFor(itemIds[0])).toBeNull();
      const p = await gatewayPayment(tx, orderId);
      // A captured payment the saga did not bind is not evidence.
      expect(await port.capturedFor(itemIds[0])).toBeNull();
      const saga = await sagaFor(tx, orderId, itemIds[0], p.id);
      expect(await port.capturedFor(itemIds[0])).toMatchObject({ orderItemId: itemIds[0], paymentId: p.id, provider: "fake-aed-card", currency: "AED", capturedMinor: 10_000n });
      // Releasing, refunding or a human flag removes it; so does any refund row that has not failed.
      await tx.paymentSaga.update({ where: { id: saga.id }, data: { state: "release_pending" } });
      expect(await port.capturedFor(itemIds[0])).toBeNull();
      await tx.paymentSaga.update({ where: { id: saga.id }, data: { state: "confirm_pending", attentionRequiredAt: new Date() } });
      expect(await port.capturedFor(itemIds[0])).toBeNull();
      await tx.paymentSaga.update({ where: { id: saga.id }, data: { attentionRequiredAt: null } });
      await tx.refund.create({ data: { id: uuidv7(), paymentId: p.id, orderItemId: itemIds[0], provider: "fake-aed-card", idempotencyKey: `zz-ev-${uuidv7()}`, amountMinor: 1n, currency: "AED", reason: "test-evidence" } });
      expect(await port.capturedFor(itemIds[0])).toBeNull();
    });
  });

  it("manual, uncaptured, short, wrong-currency and other-order payments never count", async () => {
    await rolledBack(prisma, async (tx) => {
      const { orderId, itemIds } = await instantOrder(tx);
      const other = await instantOrder(tx);
      const port = paymentEvidenceFrom(tx);
      const manual = await gatewayPayment(tx, orderId, { source: "manual" });
      // Even bound by the saga, a manual row is never evidence.
      await sagaFor(tx, orderId, itemIds[0], manual.id);
      await gatewayPayment(tx, orderId, { gateway: "manual" });
      await gatewayPayment(tx, orderId, { status: "authorized" });
      await gatewayPayment(tx, orderId, { status: "refunded" });
      await gatewayPayment(tx, orderId, { amountMinor: 9_999n });
      await gatewayPayment(tx, orderId, { currency: "INR", amountMinor: 999_999n });
      await gatewayPayment(tx, orderId, { gatewayPaymentId: null });
      // A full verified capture on a different order is not this item's payment.
      const otherPayment = await gatewayPayment(tx, other.orderId);
      await sagaFor(tx, other.orderId, other.itemIds[0], otherPayment.id);
      expect(await port.capturedFor(itemIds[0])).toBeNull();
      expect(await port.capturedFor(other.itemIds[0])).not.toBeNull();
    });
  });

  it("a multi-item order has no evidence until per-item allocations exist", async () => {
    await rolledBack(prisma, async (tx) => {
      const { orderId, itemIds } = await instantOrder(tx, 2);
      const p = await gatewayPayment(tx, orderId, { amountMinor: 20_000n });
      await sagaFor(tx, orderId, itemIds[0], p.id);
      const port = paymentEvidenceFrom(tx);
      expect(await port.capturedFor(itemIds[0])).toBeNull();
      expect(await port.capturedFor(itemIds[1])).toBeNull();
    });
  });

  it("an unknown order item has no evidence", async () => {
    await rolledBack(prisma, async (tx) => {
      expect(await paymentEvidenceFrom(tx).capturedFor(uuidv7())).toBeNull();
    });
  });

  it("recordManualPayment writes gateway manual, source manual, and is refused on an instant checkout order", async () => {
    await rolledBack(prisma, async (tx) => {
      const order = await orderService.createOrder(
        { rail: "assisted", currency: "INR", paymentCollection: "manual_link", traveller: { fullName: "test-evidence", phoneE164: "+910000000000" }, items: [await comboItem(tx)] },
        SYSTEM_ACTOR,
        tx,
      );
      const p = await orderService.recordManualPayment(SYSTEM_ACTOR, order.id, { amountMinor: 230_000n, currency: "INR", gatewayPaymentId: `pay_${run}` }, tx);
      expect(await tx.payment.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ gateway: "manual", source: "manual", status: "captured" });
      await expect(orderService.recordManualPayment(SYSTEM_ACTOR, order.id, { amountMinor: 1n, currency: "INR" }, tx)).rejects.toMatchObject({ status: 422 });

      const variance = await orderService.recordManualPayment(SYSTEM_ACTOR, order.id, { amountMinor: 1n, currency: "INR", varianceReason: "test-evidence variance" }, tx);
      const auditRow = await tx.auditLog.findFirstOrThrow({ where: { action: "payment.record_manual", entityId: order.id, reason: "test-evidence variance" } });
      expect(auditRow.after).toMatchObject({ paymentId: variance.id, expectedMinor: "230000", expectedCurrency: "INR" });

      const instant = await instantOrder(tx);
      await expect(orderService.recordManualPayment(SYSTEM_ACTOR, instant.orderId, { amountMinor: 10_000n, currency: "AED" }, tx)).rejects.toMatchObject({ status: 409 });
      expect(await tx.payment.count({ where: { orderId: instant.orderId } })).toBe(0);
    });
  });
});
