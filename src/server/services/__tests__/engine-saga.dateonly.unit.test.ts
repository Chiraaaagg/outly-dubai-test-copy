import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAppError } from "../../lib/errors";
import { storedOffer, storedSlot } from "../../suppliers/__tests__/fixtures/traveldesk-terms";

/**
 * Doc 29 Batch 7, saga intake (`engineSagaApi.startAttempt`) for a date-only
 * offer: the booking intent carries exactly the availability row the quote
 * accepted (`availabilitySlot` on the stored quote line), never a stored or
 * made-up slot, and only while the offer's date-only key is switched on with
 * evidence. The database module and the engine are replaced, as in
 * engine-saga.service.unit.test.ts. Synthetic ids and amounts only.
 */

vi.mock("../../lib/db", () => ({ prisma: {}, TX_OPTIONS: {} }));
vi.mock("../../payments/evidence", () => ({ dbPaymentEvidence: { capturedFor: async () => null } }));
const engine = vi.hoisted(() => ({
  createIntent: vi.fn(async (_tx: unknown, _input: Record<string, unknown>, _opts: unknown) => ({ id: "sb-1" })),
  confirmIfPaid: vi.fn(async () => "confirm_queued"),
  releaseHold: vi.fn(async () => "queued" as const),
  confirmSendByFor: vi.fn(async (): Promise<Date | null> => null),
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
const SELF = "live.date_only_no_slot_metadata.self.internal.per_person";
const PICKUP = "live.date_only_no_slot_metadata.pickup_required.internal.per_person";
const ROW = { timeSlotId: 0, startMinutes: 0, endMinutes: 1439 };

function line(over: Record<string, unknown> = {}) {
  return {
    index: 0,
    mappingId: MAPPING,
    approvedOfferHash: HASH,
    supplierEnvironment: "test",
    supplierAccountId: "default",
    serviceDate: "2026-12-31",
    slotRef: null,
    units: { adult: 2, kid: 1 },
    unitDefinitions: [
      { unitId: "adult", supplierUnit: "adult" },
      { unitId: "kid", supplierUnit: "child" },
    ],
    pickup: null,
    supplierNetAedMinor: "52000",
    supplierNetUsdMinor: "14170",
    availabilitySlot: ROW,
    ...over,
  };
}

const flagsOn = [
  { classKey: SELF, enabled: true, requiresOfferEvidence: true },
  { classKey: PICKUP, enabled: true, requiresOfferEvidence: true },
];

function fakeTx(
  over: {
    item?: Record<string, unknown>;
    lines?: unknown[];
    offer?: unknown;
    flags?: { classKey: string; enabled: boolean; requiresOfferEvidence: boolean }[];
    evidence?: { offerExternalId: string; classKey: string; offerTermsHash: string; revokedAt: Date | null }[];
  } = {},
) {
  return {
    orderItem: {
      findUnique: async () => ({
        orderId: ORDER,
        quoteId: QUOTE,
        mappingId: MAPPING,
        fulfilmentOrigin: "instant_checkout",
        serviceDate: new Date("2026-12-31T00:00:00Z"),
        timeslot: null,
        quoteLineIndex: 0,
        order: { leadName: "Synthetic Lead" },
        ...over.item,
      }),
    },
    quote: { findUnique: async () => ({ usedByOrderId: ORDER, lines: over.lines ?? [line()] }) },
    productSupplierMapping: {
      findUnique: async () => ({
        id: MAPPING,
        isActive: true,
        environment: "test",
        approvedOfferHash: HASH,
        approvedSlotHours: 3,
        supplierId: "sup-1",
        supplierOfferId: "97011",
        externalRef: { tourId: 9701, offerId: 97011, bookingKind: "live_book", isExternal: false },
        supplier: { code: "traveldesk", adapter: "traveldesk" },
      }),
    },
    supplierCatalogueItem: {
      findUnique: async () => ({ payload: over.offer ?? storedOffer({ offerId: 97011, tourId: 9701, durationHours: 3, timeSlots: [] }), removedAt: null }),
      // Doc 30 N2: the gate reads each offer's stored tour for proof scopes.
      findMany: async () => [{ externalId: "97011", parentExternalId: "9701" }],
    },
    supplierClassProof: { findMany: async () => [] },
    supplierCapabilityFlag: { findMany: async () => over.flags ?? flagsOn },
    supplierOfferEnablement: {
      findMany: async () =>
        over.evidence ?? [
          { offerExternalId: "97011", classKey: SELF, offerTermsHash: HASH, revokedAt: null },
          { offerExternalId: "97011", classKey: PICKUP, offerTermsHash: HASH, revokedAt: null },
        ],
    },
  };
}

const config = { environment: "test" as const, agencyId: null, mutationTimeoutMs: 150_000 };
const api = () => createEngineSagaApi({ config: () => config, payments: { capturedFor: async () => null } });
const ids = { orderId: ORDER, orderItemId: ITEM, quoteId: QUOTE };

async function refusal(p: Promise<unknown>) {
  const e = await p.catch((x) => x);
  return isAppError(e) ? ((e.details as { reason?: string } | undefined)?.reason ?? e.code) : String(e);
}

describe("engineSagaApi.startAttempt for a date-only offer (doc 29 Batch 7)", () => {
  beforeEach(() => engine.createIntent.mockClear());

  it("the intent's slot is exactly the quote line's availability row (one row for the date: no slot reference)", async () => {
    expect(await api().startAttempt(fakeTx(), ids)).toEqual({ supplierBookingId: "sb-1" });
    expect(engine.createIntent.mock.calls[0][1]).toMatchObject({ offerId: 97011, serviceDate: "2026-12-31", slot: ROW, hotelId: null, expectedNetMinor: 52_000n });
  });

  it("a chosen one of several starts books that row: id, start and end as the row gave them", async () => {
    const tx = fakeTx({ item: { timeslot: "7@18:00" }, lines: [line({ slotRef: "7@18:00", availabilitySlot: { timeSlotId: 7, startMinutes: 1080, endMinutes: 1260 } })] });
    await api().startAttempt(tx, ids);
    expect(engine.createIntent.mock.calls[0][1]).toMatchObject({ slot: { timeSlotId: 7, startMinutes: 1080, endMinutes: 1260 } });
  });

  it("the pickup key books the hotel from the line beside the row", async () => {
    const tx = fakeTx({ lines: [line({ pickup: { hotelRef: "42" } })], offer: storedOffer({ offerId: 97011, tourId: 9701, durationHours: 3, timeSlots: [], isDirectReporting: false }) });
    await api().startAttempt(tx, ids);
    expect(engine.createIntent.mock.calls[0][1]).toMatchObject({ slot: ROW, hotelId: 42 });
  });

  it("refuses before the engine is called: no row on the line, a row naming another start, flag off, no evidence, other terms", async () => {
    const cases: [ReturnType<typeof fakeTx>, string][] = [
      [fakeTx({ lines: [line({ availabilitySlot: undefined })] }), "slot_unknown"],
      [fakeTx({ lines: [line({ availabilitySlot: null })] }), "slot_unknown"],
      [fakeTx({ item: { timeslot: "8@20:00" }, lines: [line({ slotRef: "8@20:00", availabilitySlot: { timeSlotId: 7, startMinutes: 1080, endMinutes: 1260 } })] }), "slot_unknown"],
      [fakeTx({ lines: [line({ availabilitySlot: { timeSlotId: 0, startMinutes: 600, endMinutes: 60 } })] }), "slot_unknown"],
      [fakeTx({ flags: [] }), "capability_not_enabled"],
      [fakeTx({ flags: [{ classKey: SELF, enabled: false, requiresOfferEvidence: true }] }), "capability_not_enabled"],
      [fakeTx({ evidence: [] }), "capability_not_enabled"],
      [fakeTx({ evidence: [{ offerExternalId: "97011", classKey: SELF, offerTermsHash: "b".repeat(64), revokedAt: null }] }), "capability_not_enabled"],
      // A line for an offer that lists slots never books from an availability row: it needs its stored slot.
      [fakeTx({ offer: storedOffer({ offerId: 97011, tourId: 9701, timeSlots: [storedSlot()] }), flags: [{ classKey: "live.fixed_slot_single.self.internal.per_person", enabled: true, requiresOfferEvidence: false }] }), "slot_unknown"],
    ];
    for (const [tx, reason] of cases) expect(await refusal(api().startAttempt(tx, ids)), reason).toBe(reason);
    expect(engine.createIntent).not.toHaveBeenCalled();
  });

  it("in production the Q5 code lock refuses the key even with a flag row on and evidence (owner decision d)", async () => {
    const prod = { environment: "production" as const, agencyId: "agency-1", mutationTimeoutMs: 150_000 };
    const tx = fakeTx({ lines: [line({ supplierEnvironment: "production", supplierAccountId: "agency-1" })] });
    tx.productSupplierMapping.findUnique = async () => ({ ...(await fakeTx().productSupplierMapping.findUnique()), environment: "production" });
    const prodApi = createEngineSagaApi({ config: () => prod, payments: { capturedFor: async () => null } });
    const e = await prodApi.startAttempt(tx, ids).catch((x) => x);
    expect(isAppError(e) && (e.details as { reason?: string }).reason).toBe("capability_not_enabled");
    // Refused by the lock (the class is not sellable there), not by a missing flag or evidence.
    expect(String((e as Error).message)).toContain("class_not_sellable");
    expect(engine.createIntent).not.toHaveBeenCalled();
  });
});
