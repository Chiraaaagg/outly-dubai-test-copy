import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAppError } from "../../lib/errors";
import { storedOffer, storedSlot } from "../../suppliers/__tests__/fixtures/traveldesk-terms";

/**
 * engineSagaApi (B3): how the saga's calls map onto the engine. The
 * database module and the engine are replaced, and `startAttempt` reads a fake
 * transaction, so nothing opens a connection. Synthetic ids and amounts only.
 */

vi.mock("../../lib/db", () => ({ prisma: {}, TX_OPTIONS: {} }));
vi.mock("../../payments/evidence", () => ({ dbPaymentEvidence: { capturedFor: async () => null } }));
const engine = vi.hoisted(() => ({
  createIntent: vi.fn(async (_tx: unknown, _input: Record<string, unknown>, _opts: unknown) => ({ id: "sb-1" })),
  confirmIfPaid: vi.fn(async (_id: string, _deps: unknown) => "confirm_queued"),
  releaseHold: vi.fn(async (_id: string, _reason: string, _deps: unknown) => "queued" as const),
  confirmSendByFor: vi.fn(async (_id: string, _deps: unknown): Promise<Date | null> => null),
}));
vi.mock("../supplier-booking.service", () => ({
  TRAVELDESK_SUPPLIER_CODE: "traveldesk",
  bookingAccountId: (environment: string, pinned: string | null) => pinned ?? (environment === "test" ? "default" : null),
  supplierBookingService: engine,
}));

const { createEngineSagaApi } = await import("../engine-saga.service");

const ORDER = "0190a000-0000-7000-8000-000000000001";
const ITEM = "0190a000-0000-7000-8000-000000000002";
const QUOTE = "0190a000-0000-7000-8000-000000000003";
const MAPPING = "0190a000-0000-7000-8000-000000000004";
const HASH = "a".repeat(64);

function line(over: Record<string, unknown> = {}) {
  return {
    index: 0,
    mappingId: MAPPING,
    approvedOfferHash: HASH,
    supplierEnvironment: "test",
    supplierAccountId: "default",
    serviceDate: "2026-11-12",
    slotRef: "11@21:00",
    units: { adult: 2, kid: 1 },
    unitDefinitions: [
      { unitId: "adult", supplierUnit: "adult" },
      { unitId: "kid", supplierUnit: "child" },
    ],
    pickup: { hotelRef: "42" },
    supplierNetAedMinor: "30000",
    supplierNetUsdMinor: "8200",
    ...over,
  };
}

/** The flags migration 20261122120000 seeds: the two proven fixed-start keys, on, no per-offer evidence. */
const SEEDED_FLAGS = [
  { classKey: "live.fixed_slot_single.self.internal.per_person", enabled: true, requiresOfferEvidence: false },
  { classKey: "live.fixed_slot_choice.self.internal.per_person", enabled: true, requiresOfferEvidence: false },
];

function fakeTx(
  over: {
    item?: Record<string, unknown>;
    quote?: Record<string, unknown> | null;
    lines?: unknown[];
    mapping?: Record<string, unknown> | null;
    offer?: unknown;
    flags?: { classKey: string; enabled: boolean; requiresOfferEvidence: boolean }[];
  } = {},
) {
  return {
    orderItem: {
      findUnique: async () => ({
        orderId: ORDER,
        quoteId: QUOTE,
        mappingId: MAPPING,
        fulfilmentOrigin: "instant_checkout",
        serviceDate: new Date("2026-11-12T00:00:00Z"),
        order: { leadName: " Synthetic Lead " },
        ...over.item,
      }),
    },
    quote: { findUnique: async () => (over.quote === null ? null : { usedByOrderId: ORDER, lines: over.lines ?? [line()], ...over.quote }) },
    productSupplierMapping: {
      findUnique: async () =>
        over.mapping === null
          ? null
          : {
              id: MAPPING,
              isActive: true,
              environment: "test",
              approvedOfferHash: HASH,
              supplierId: "sup-1",
              supplierOfferId: "501",
              externalRef: { tourId: 3001, offerId: 501, bookingKind: "live_book", isExternal: false },
              supplier: { code: "traveldesk", adapter: "traveldesk" },
              ...over.mapping,
            },
    },
    supplierCatalogueItem: { findUnique: async () => ({ payload: over.offer ?? storedOffer({ timeSlots: [storedSlot()] }), removedAt: null }) },
    supplierCapabilityFlag: { findMany: async () => over.flags ?? SEEDED_FLAGS },
    supplierOfferEnablement: { findMany: async () => [] },
  };
}

const config = { environment: "test" as const, agencyId: null, mutationTimeoutMs: 150_000 };
const api = (cfg: typeof config | null = config) => createEngineSagaApi({ config: () => cfg, payments: { capturedFor: async () => null } });
const ids = { orderId: ORDER, orderItemId: ITEM, quoteId: QUOTE };

async function refusal(p: Promise<unknown>) {
  const e = await p.catch((x) => x);
  return isAppError(e) ? ((e.details as { reason?: string } | undefined)?.reason ?? e.code) : String(e);
}

describe("engineSagaApi (B3)", () => {
  beforeEach(() => {
    engine.createIntent.mockClear();
    engine.confirmIfPaid.mockReset();
    engine.releaseHold.mockClear();
  });

  it("startAttempt builds an await-payment intent from the order item and its quote line, in the caller's transaction", async () => {
    const tx = fakeTx();
    expect(await api().startAttempt(tx, ids)).toEqual({ supplierBookingId: "sb-1" });
    const [passedTx, input, opts] = engine.createIntent.mock.calls[0];
    expect(passedTx).toBe(tx);
    expect(input).toEqual({
      environment: "test",
      idempotencyKey: `order:${ORDER}:item:${ITEM}:try:1`,
      orderId: ORDER,
      orderItemId: ITEM,
      mappingId: MAPPING,
      bookingKind: "live_book",
      mode: "two_step",
      afterReserve: "await_payment",
      fulfilmentOrigin: "instant_checkout",
      quoteId: QUOTE,
      tourId: 3001,
      offerId: 501,
      serviceDate: "2026-11-12",
      slot: { timeSlotId: 11, startMinutes: 1260, endMinutes: 1365 },
      adults: 2,
      children: 1,
      infants: 0,
      hotelId: 42,
      guestName: "Synthetic Lead",
      expectedNetMinor: 30_000n,
      expectedNetUsdMinor: 8_200n,
    });
    expect(opts).toMatchObject({ supplierCode: "traveldesk", accountId: "default" });
  });

  it("startAttempt refuses anything the booking would have to guess, before the engine is called", async () => {
    const cases: [ReturnType<typeof fakeTx>, string][] = [
      [fakeTx({ item: { orderId: "another" } }), "order_mismatch"],
      [fakeTx({ item: { fulfilmentOrigin: "assisted_conversion" } }), "not_instant_checkout"],
      [fakeTx({ item: { quoteId: null } }), "quote_mismatch"],
      [fakeTx({ quote: { usedByOrderId: null } }), "quote_not_bound"],
      [fakeTx({ lines: [line(), line()] }), "quote_line_unreadable"],
      [fakeTx({ lines: [line({ supplierNetAedMinor: 30000 })] }), "quote_line_unreadable"],
      [fakeTx({ item: { serviceDate: new Date("2026-11-13T00:00:00Z") } }), "service_date_mismatch"],
      [fakeTx({ mapping: { isActive: false } }), "mapping_inactive"],
      [fakeTx({ mapping: { environment: "production" } }), "mapping_environment_changed"],
      [fakeTx({ mapping: { approvedOfferHash: "b".repeat(64) } }), "mapping_changed"],
      [fakeTx({ mapping: { externalRef: { tourId: 3001, offerId: 501, bookingKind: "ticket_only", isExternal: false } } }), "not_live_book"],
      [fakeTx({ lines: [line({ supplierAccountId: "another-agency" })] }), "supplier_account_changed"],
      [fakeTx({ lines: [line({ slotRef: "21:00" })] }), "slot_unknown"],
      [fakeTx({ lines: [line({ slotRef: "12@21:00" })] }), "slot_rules_unknown"],
      [fakeTx({ offer: storedOffer({ timeSlots: [storedSlot({ endMinutes: null })] }) }), "slot_rules_unknown"],
      [fakeTx({ offer: { not: "an offer" } }), "offer_unreadable"],
      // The capability gate (doc 29 Batch 1a): a class switched off since the quote, or a class never switched on.
      [fakeTx({ flags: [] }), "capability_not_enabled"],
      [fakeTx({ offer: storedOffer({ isDirectReporting: false, timeSlots: [storedSlot()] }) }), "capability_not_enabled"],
      [fakeTx({ mapping: { supplier: { code: "traveldesk", adapter: "manual" } } }), "capability_not_enabled"],
      [fakeTx({ lines: [line({ units: { trip: 2 }, unitDefinitions: [{ unitId: "trip", supplierUnit: "trip" }] })] }), "unit_rule_failed"],
      [fakeTx({ lines: [line({ pickup: { hotelRef: "Example Hotel" } })] }), "pickup_unreadable"],
      [fakeTx({ lines: [line({ supplierNetUsdMinor: null })] }), "supplier_usd_net_missing"],
      [fakeTx({ lines: [line({ supplierNetUsdMinor: undefined })] }), "supplier_usd_net_missing"],
      [fakeTx({ item: { order: { leadName: "  " } } }), "guest_name_missing"],
      [fakeTx({ item: { order: { leadName: "राहुल शर्मा" } } }), "guest_name_unsupported"],
    ];
    for (const [tx, reason] of cases) expect(await refusal(api().startAttempt(tx, ids)), reason).toBe(reason);
    expect(await refusal(api(null).startAttempt(fakeTx(), ids))).toBe("supplier_not_configured");
    expect(await refusal(api({ ...config, environment: "production" as never }).startAttempt(fakeTx(), ids))).toBe("supplier_not_configured");
    expect(engine.createIntent).not.toHaveBeenCalled();
  });

  it("multi-item: an item with a quote line index reads its own line, even when another line has the same mapping", async () => {
    // Two lines of one order on the same mapping, on two dates; the item is the second one (index 1).
    const lines = [line(), line({ index: 1, serviceDate: "2026-11-14", supplierNetAedMinor: "31000" })];
    const tx = fakeTx({ lines, item: { quoteLineIndex: 1, serviceDate: new Date("2026-11-14T00:00:00Z"), timeslot: "11@21:00" } });
    expect(await api().startAttempt(tx, ids)).toEqual({ supplierBookingId: "sb-1" });
    expect(engine.createIntent.mock.calls[0][1]).toMatchObject({ serviceDate: "2026-11-14", expectedNetMinor: 31_000n });
    engine.createIntent.mockClear();
    // Without an index, the same two lines are ambiguous and refused.
    expect(await refusal(api().startAttempt(fakeTx({ lines }), ids))).toBe("quote_line_unreadable");
    const cases: [ReturnType<typeof fakeTx>, string][] = [
      [fakeTx({ lines, item: { quoteLineIndex: 2, timeslot: "11@21:00" } }), "quote_line_unreadable"],
      [fakeTx({ lines: [line(), line({ index: 1, mappingId: "0190a000-0000-7000-8000-000000000009" })], item: { quoteLineIndex: 1, timeslot: "11@21:00" } }), "quote_line_unreadable"],
      [fakeTx({ lines: [line(), line({ index: 0 })], item: { quoteLineIndex: 1, timeslot: "11@21:00" } }), "quote_line_unreadable"],
      [fakeTx({ lines, item: { quoteLineIndex: 1, serviceDate: new Date("2026-11-14T00:00:00Z"), timeslot: "12@21:00" } }), "slot_mismatch"],
      [fakeTx({ lines, item: { quoteLineIndex: 1, timeslot: "11@21:00" } }), "service_date_mismatch"],
    ];
    for (const [t, reason] of cases) expect(await refusal(api().startAttempt(t, ids)), reason).toBe(reason);
    expect(engine.createIntent).not.toHaveBeenCalled();
  });

  it("confirmIfPaid maps the engine's answer onto queued, not_ready and too_late", async () => {
    const cases: [string, string][] = [
      ["confirm_queued", "queued"],
      ["skip:confirming", "queued"],
      ["skip:confirmed", "queued"],
      ["skip:awaiting_external", "queued"],
      ["deadline_too_close", "too_late"],
      ["released", "too_late"],
      ["skip:expired", "too_late"],
      ["skip:cancelled", "too_late"],
      ["skip:not_created", "too_late"],
      ["no_payment_evidence", "not_ready"],
      ["attention_required", "not_ready"],
      ["skip:queued", "not_ready"],
      ["skip:outcome_unknown", "not_ready"],
      ["skip:manual_review", "not_ready"],
    ];
    for (const [engineAnswer, expected] of cases) {
      engine.confirmIfPaid.mockResolvedValueOnce(engineAnswer);
      expect(await api().confirmIfPaid("sb-1"), engineAnswer).toBe(expected);
    }
    // The deadline gate uses the worker's own mutation timeout.
    expect(engine.confirmIfPaid.mock.calls[0][1]).toMatchObject({ mutationTimeoutMs: 150_000 });
  });

  it("confirmSendBy reports the engine's own send-by with the worker's mutation timeout, or null while it is unknown", async () => {
    engine.confirmSendByFor.mockResolvedValueOnce(new Date("2030-01-06T08:10:00Z"));
    expect(await api().confirmSendBy("sb-1")).toBe("2030-01-06T08:10:00.000Z");
    expect(engine.confirmSendByFor).toHaveBeenLastCalledWith("sb-1", { mutationTimeoutMs: 150_000 });
    engine.confirmSendByFor.mockResolvedValueOnce(null);
    expect(await api().confirmSendBy("sb-1")).toBeNull();
    // Not configured: the engine's default budget applies.
    engine.confirmSendByFor.mockResolvedValueOnce(null);
    await api(null).confirmSendBy("sb-1");
    expect(engine.confirmSendByFor).toHaveBeenLastCalledWith("sb-1", { mutationTimeoutMs: undefined });
  });

  it("releaseHold goes to the engine with the reason", async () => {
    expect(await api().releaseHold("sb-1", "payment_refunded")).toBe("queued");
    expect(engine.releaseHold).toHaveBeenCalledWith("sb-1", "payment_refunded", expect.objectContaining({}));
  });
});
