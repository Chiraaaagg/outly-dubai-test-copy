import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../lib/actor";
import { FulfilmentOriginError, orderService, type CreateOrderInput, type CreateOrderItemInput } from "../order.service";

/**
 * Provenance and manual-payment rules of order.service.ts (doc 22 PRD-3,
 * PAY-9). Pure: the database module and audit are replaced and every call
 * gets a fake transaction, so nothing here opens a connection. The database
 * side runs in src/server/payments/__tests__/evidence.test.ts (db project).
 */

const state = vi.hoisted(() => ({ audits: [] as unknown[][] }));

vi.mock("../../lib/db", () => ({
  prisma: { $transaction: vi.fn(async () => { throw new Error("tests pass their own transaction"); }) },
  TX_OPTIONS: {},
}));
vi.mock("../../lib/audit", () => ({ audit: vi.fn(async (...args: unknown[]) => void state.audits.push(args)) }));

/** The transaction type, without naming the database module (which would mark this a db suite). */
type Tx = NonNullable<Parameters<typeof orderService.createOrder>[2]>;

const staff: Actor = { type: "agent", id: "00000000-0000-7000-8000-000000000001", roles: ["agent"], permissions: new Set(["orders.create", "payments.record"]) };

/** Synthetic amounts only. */
function item(over: Partial<CreateOrderItemInput> = {}): CreateOrderItemInput {
  return {
    titleSnapshot: "Synthetic tour",
    tierSnapshot: "A",
    slugSnapshot: "synthetic-tour",
    kindSnapshot: "activity",
    confirmationSnapshot: "manual",
    fulfilmentModeSnapshot: "inquiry",
    freeCancellationHoursSnapshot: 24,
    durationMinutesSnapshot: 60,
    serviceDate: "2030-01-15",
    pax: { adult: 1, child: 0, infant: 0, senior: 0 } as CreateOrderItemInput["pax"],
    addons: [],
    unitInr: 1_000n,
    unitAed: 45n,
    totalInr: 1_000n,
    totalAed: 45n,
    fulfilmentOrigin: "assisted_conversion",
    ...over,
  };
}

function orderInput(over: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    rail: "assisted",
    currency: "INR",
    paymentCollection: "manual_link",
    traveller: { fullName: "Synthetic Traveller", phoneE164: "+910000000000" },
    items: [item()],
    ...over,
  };
}

interface FakeTx {
  tx: Tx;
  orderCreates: Array<{ data: { items: { create: Array<Record<string, unknown>> } } }>;
  paymentCreates: Array<{ data: Record<string, unknown> }>;
  orderUpdates: unknown[];
}

function fakeTx(order: { currency: "INR" | "AED"; totalInr: bigint; totalAed: bigint; origins?: string[] } | null = null): FakeTx {
  const f: Omit<FakeTx, "tx"> = { orderCreates: [], paymentCreates: [], orderUpdates: [] };
  const tx = {
    $queryRaw: vi.fn(async () => [{ n: 1n }]),
    guest: { create: vi.fn(async () => ({ id: "guest-1" })) },
    order: {
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(async () =>
        order ? { id: "order-1", currency: order.currency, totalInr: order.totalInr, totalAed: order.totalAed, items: (order.origins ?? ["assisted_conversion"]).map((o) => ({ fulfilmentOrigin: o })) } : null,
      ),
      create: vi.fn(async (args: FakeTx["orderCreates"][number]) => {
        f.orderCreates.push(args);
        return { id: "order-1", totalInr: 1_000n, totalAed: 45n };
      }),
      update: vi.fn(async (args: unknown) => void f.orderUpdates.push(args)),
    },
    payment: {
      create: vi.fn(async (args: FakeTx["paymentCreates"][number]) => {
        f.paymentCreates.push(args);
        return { ...args.data, id: "payment-1" };
      }),
    },
  };
  return { ...f, tx: tx as unknown as Tx };
}

beforeEach(() => {
  state.audits.length = 0;
});

describe("createOrder fulfilment origin", () => {
  it("stores the origin on every item", async () => {
    const f = fakeTx();
    await orderService.createOrder(orderInput({ items: [item(), item({ slugSnapshot: "second" })] }), staff, f.tx);
    expect(f.orderCreates[0].data.items.create.map((i) => i.fulfilmentOrigin)).toEqual(["assisted_conversion", "assisted_conversion"]);
  });

  it("refuses an item without a known origin (422)", async () => {
    const f = fakeTx();
    for (const fulfilmentOrigin of [undefined, "", "gateway"]) {
      await expect(orderService.createOrder(orderInput({ items: [item({ fulfilmentOrigin: fulfilmentOrigin as never })] }), staff, f.tx)).rejects.toMatchObject({ status: 422 });
    }
    expect(f.orderCreates).toHaveLength(0);
  });

  const instant = (over: Partial<CreateOrderInput> = {}) =>
    orderInput({ rail: "self_serve", paymentCollection: "gateway", items: [item({ fulfilmentOrigin: "instant_checkout", fulfilmentModeSnapshot: "instant" })], ...over });

  it("refuses instant checkout while quotes and the gateway do not exist", async () => {
    const f = fakeTx();
    const err = await orderService.createOrder(instant(), staff, f.tx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FulfilmentOriginError);
    expect(err).toMatchObject({ status: 409, reason: "instant_checkout_disabled" });
    expect(f.orderCreates).toHaveLength(0);
  });

  it("refuses instant checkout on the assisted rail or without gateway collection, even for a test", async () => {
    const f = fakeTx();
    for (const over of [{ rail: "assisted" as const }, { paymentCollection: "manual_link" as const }, { paymentCollection: "bank_transfer" as const }]) {
      await expect(orderService.createOrder(instant(over), staff, f.tx, { allowInstantCheckout: "test-only" })).rejects.toMatchObject({ reason: "instant_checkout_needs_gateway" });
    }
    expect(f.orderCreates).toHaveLength(0);
  });

  it("refuses an order that mixes instant checkout and assisted items", async () => {
    const f = fakeTx();
    const mixed = instant({ items: [item({ fulfilmentOrigin: "instant_checkout" }), item()] });
    await expect(orderService.createOrder(mixed, staff, f.tx, { allowInstantCheckout: "test-only" })).rejects.toMatchObject({ reason: "mixed_fulfilment_origins" });
  });

  it("refuses before replaying an idempotency key", async () => {
    const f = fakeTx();
    await expect(orderService.createOrder(instant({ idempotencyKey: "k" }), staff, f.tx)).rejects.toMatchObject({ reason: "instant_checkout_disabled" });
    expect((f.tx as unknown as { order: { findFirst: ReturnType<typeof vi.fn> } }).order.findFirst).not.toHaveBeenCalled();
  });

  it("the test-only flag works in a test process and nowhere else", async () => {
    expect(process.env.NODE_ENV).toBe("test");
    const f = fakeTx();
    await orderService.createOrder(instant(), staff, f.tx, { allowInstantCheckout: "test-only" });
    expect(f.orderCreates[0].data.items.create[0].fulfilmentOrigin).toBe("instant_checkout");

    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(orderService.createOrder(instant(), staff, fakeTx().tx, { allowInstantCheckout: "test-only" })).rejects.toMatchObject({ reason: "instant_checkout_disabled" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("recordManualPayment (PAY-9)", () => {
  const inr = { currency: "INR" as const, totalInr: 1_000n, totalAed: 45n };

  it("writes a manual row, never a gateway one", async () => {
    const f = fakeTx(inr);
    await orderService.recordManualPayment(staff, "order-1", { amountMinor: 1_000n, currency: "INR", gatewayPaymentId: "pay_typed_by_agent" }, f.tx);
    expect(f.paymentCreates[0].data).toMatchObject({ gateway: "manual", source: "manual", status: "captured", amountMinor: 1_000n, currency: "INR", gatewayPaymentId: "pay_typed_by_agent" });
    expect(f.orderUpdates).toHaveLength(1);
    expect(state.audits[0][3]).toEqual({ after: { paymentId: "payment-1", amountMinor: "1000", currency: "INR" }, reason: undefined });
  });

  it("matches against the total in the order's own currency", async () => {
    const f = fakeTx({ currency: "AED", totalInr: 1_000n, totalAed: 45n });
    await orderService.recordManualPayment(staff, "order-1", { amountMinor: 45n, currency: "AED" }, f.tx);
    expect(f.paymentCreates).toHaveLength(1);
    await expect(orderService.recordManualPayment(staff, "order-1", { amountMinor: 1_000n, currency: "INR" }, f.tx)).rejects.toMatchObject({ status: 422 });
  });

  it.each([
    ["a different amount", { amountMinor: 999n, currency: "INR" as const }],
    ["a different currency", { amountMinor: 1_000n, currency: "AED" as const }],
  ])("refuses %s without a variance reason (422) and writes nothing", async (_label, input) => {
    const f = fakeTx(inr);
    await expect(orderService.recordManualPayment(staff, "order-1", input, f.tx)).rejects.toMatchObject({ status: 422 });
    await expect(orderService.recordManualPayment(staff, "order-1", { ...input, varianceReason: "   " }, f.tx)).rejects.toMatchObject({ status: 422 });
    expect(f.paymentCreates).toHaveLength(0);
    expect(f.orderUpdates).toHaveLength(0);
  });

  it("records a variance with its reason and the expected figures in the audit row", async () => {
    const f = fakeTx(inr);
    await orderService.recordManualPayment(staff, "order-1", { amountMinor: 1_050n, currency: "INR", varianceReason: " Customer paid the bank fee " }, f.tx);
    expect(f.paymentCreates[0].data).toMatchObject({ amountMinor: 1_050n, source: "manual" });
    expect(state.audits[0][3]).toEqual({
      after: { paymentId: "payment-1", amountMinor: "1050", currency: "INR", expectedMinor: "1000", expectedCurrency: "INR" },
      reason: "Customer paid the bank fee",
    });
  });

  it("refuses an over-long variance reason", async () => {
    const f = fakeTx(inr);
    await expect(orderService.recordManualPayment(staff, "order-1", { amountMinor: 1n, currency: "INR", varianceReason: "x".repeat(501) }, f.tx)).rejects.toMatchObject({ status: 422 });
  });

  it("refuses an order with an instant checkout item (409)", async () => {
    const f = fakeTx({ ...inr, origins: ["instant_checkout"] });
    await expect(orderService.recordManualPayment(staff, "order-1", { amountMinor: 1_000n, currency: "INR" }, f.tx)).rejects.toMatchObject({ status: 409, details: { reason: "instant_checkout_order" } });
    expect(f.paymentCreates).toHaveLength(0);
  });

  it("refuses an unknown order (404)", async () => {
    await expect(orderService.recordManualPayment(staff, "missing", { amountMinor: 1_000n, currency: "INR" }, fakeTx(null).tx)).rejects.toMatchObject({ status: 404 });
  });

  it("keeps the permission and negative-amount checks", async () => {
    const f = fakeTx(inr);
    const readonly: Actor = { ...staff, permissions: new Set() };
    await expect(orderService.recordManualPayment(readonly, "order-1", { amountMinor: 1_000n, currency: "INR" }, f.tx)).rejects.toMatchObject({ status: 403 });
    await expect(orderService.recordManualPayment(staff, "order-1", { amountMinor: -1n, currency: "INR", varianceReason: "x" }, f.tx)).rejects.toMatchObject({ status: 422 });
    expect(f.paymentCreates).toHaveLength(0);
  });
});
