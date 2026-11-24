import { describe, expect, it, vi } from "vitest";
import { admitRead, READ_BUDGET, type ReadClass, type ReadWindow } from "../../suppliers/read-budget";
import { offerTermsHash, slotHoursOf } from "../../suppliers/traveldesk/traveldesk.offer-terms";
import { row, storedOffer, storedTour } from "../../suppliers/__tests__/fixtures/traveldesk-terms";
import type { SupplierQuoteResult } from "../../quotes/contracts";
import { fakeMargin, instantDoc, mapping, product, PRODUCT_ID } from "./_b2-fakes";

/**
 * Doc 29 Batch 7 (date-only offers, built switched off) on the service side:
 *
 *  - readiness: the time rule passes a date-only offer only when its key is
 *    switched on (`dateOnlySellable`) and the page offers no times; with the
 *    flag off nothing changes (`slot_rules_unknown` still applies);
 *  - the supplier quote copies the fresh row (`availabilitySlot`), and the
 *    quote line stores it;
 *  - the public start-times read: one start answers `not_listed` (date only,
 *    no chips), several answer the listed starts, all from the browse share.
 *
 * The database module is replaced; nothing opens a connection or a socket.
 * Synthetic data only.
 */

vi.mock("../../lib/db", () => ({ prisma: {}, TX_OPTIONS: {} }));
vi.mock("../../lib/env", () => ({ env: () => ({}) }));

const { createSupplierQuoteService, DATE_ONLY_START_TIMES_TTL_MS } = await import("../supplier-quote.service");
const { createStartTimesService } = await import("../start-times.service");
const { assessReadiness, fromCatalogReadiness, READINESS_RULES_VERSION, slotTimesAgree } = await import("../readiness.service");
const { createQuoteService } = await import("../quote.service");
type Deps = Parameters<typeof createSupplierQuoteService>[0];
type Context = NonNullable<Awaited<ReturnType<Deps["load"]>>>;

const NOW = new Date("2026-11-01T08:00:00Z");
const DATE = "2026-12-31";
const DATE_ONLY = storedOffer({ timeSlots: [], durationHours: 3 });
/** Readiness facts of a date-only offer: no stored start, no "any time" slot. */
const dateOnlyMapping = (over: Parameters<typeof mapping>[0] = {}) => mapping({ slotStartMinutes: [], anyTimeSlots: false, dateOnlySellable: true, ...over });
const datePage = instantDoc({ timeSlots: [] });

describe("readiness: the time rule for a date-only offer", () => {
  it("passes with its key switched on and no page times; never with page times, stored starts or an unknown offer", () => {
    expect(slotTimesAgree([], { slotStartMinutes: [], anyTimeSlots: false, dateOnlySellable: true })).toBe("ok");
    expect(slotTimesAgree(["19:00"], { slotStartMinutes: [], anyTimeSlots: false, dateOnlySellable: true })).toBe("slot_times_mismatch");
    expect(slotTimesAgree([], { slotStartMinutes: [540], anyTimeSlots: false, dateOnlySellable: true })).toBe("slot_times_mismatch");
    expect(slotTimesAgree([], { slotStartMinutes: null, anyTimeSlots: null, dateOnlySellable: true })).toBe("slot_times_mismatch");
    // Flag off (or not reported): exactly the rule before Batch 7.
    expect(slotTimesAgree([], { slotStartMinutes: [], anyTimeSlots: false, dateOnlySellable: false })).toBe("slot_times_mismatch");
    expect(slotTimesAgree([], { slotStartMinutes: [], anyTimeSlots: false })).toBe("slot_times_mismatch");
    expect(slotTimesAgree(["09:00"], { slotStartMinutes: [540], anyTimeSlots: false, dateOnlySellable: false })).toBe("ok");
  });

  it("a date-only product is instant only with its key on; with it off it stays inquiry on slot_rules_unknown, as before", async () => {
    const assess = (m: ReturnType<typeof mapping>, doc = datePage) => assessReadiness({ product: product({}, doc), mappings: [m], releaseEnabled: true, margin: fakeMargin() });
    const on = await assess(dateOnlyMapping());
    expect(on.reasons).toEqual([]);
    expect(on.effective).toBe("instant");
    // Flag off: the catalogue side keeps the blocker (slotRulesKnown false) and reports dateOnlySellable false.
    const off = await assess(dateOnlyMapping({ dateOnlySellable: false, slotRulesKnown: false, capabilityReady: false }));
    expect(off.effective).toBe("inquiry");
    expect(off.reasons).toEqual(expect.arrayContaining(["slot_rules_unknown", "capability_not_ready", "slot_times_mismatch"]));
    // A page that offers start times for a date-only offer is refused: its times come only from availability.
    expect((await assess(dateOnlyMapping(), instantDoc({ timeSlots: ["19:00"] }))).reasons).toContain("slot_times_mismatch");
  });

  it("fromCatalogReadiness carries dateOnlySellable only when the catalogue side says true", () => {
    const variant = (facts: Record<string, unknown>, blockers: string[] = []) => ({
      productId: PRODUCT_ID,
      environment: "test" as const,
      evaluatedAt: NOW.toISOString(),
      variants: [
        {
          variantCode: null,
          blockers,
          mapping: {
            mappingId: "m-1",
            variantCode: null,
            environment: "test",
            isActive: true,
            syncStatus: "ok",
            lastSyncedAt: null,
            bookingKind: "live_book",
            tourExternalId: "9701",
            offerExternalId: "97011",
            approvedOfferHash: "a".repeat(64),
            currentOfferHash: "a".repeat(64),
            issuesTicketsAtConfirm: "unknown",
            supplierUnits: ["adult"],
            netAedMinorByUnit: null,
            supplierFreeCancellationHours: 0,
            isDirectReporting: true,
            slotStartMinutes: [],
            anyTimeSlots: false,
            accountId: "acct",
            ...facts,
          },
        },
      ],
    });
    expect(fromCatalogReadiness(variant({ dateOnlySellable: true }) as never)[0]).toMatchObject({ dateOnlySellable: true, slotRulesKnown: true });
    expect(fromCatalogReadiness(variant({}, ["slot_rules_unknown"]) as never)[0]).toMatchObject({ dateOnlySellable: false, slotRulesKnown: false });
    expect(fromCatalogReadiness(variant({ dateOnlySellable: "yes" }) as never)[0].dateOnlySellable).toBe(false);
  });

  it("parity with the flag off (review 92 B7-10): a zero-slot mapping without dateOnlySellable gets exactly the reasons it got before Batch 7", async () => {
    // Before Batch 7 the catalogue side reported such a mapping with slot_rules_unknown and capability_not_ready, and no dateOnlySellable field.
    const before = mapping({ slotStartMinutes: [], anyTimeSlots: false, slotRulesKnown: false, capabilityReady: false });
    const assess = (m: ReturnType<typeof mapping>, doc = datePage) => assessReadiness({ product: product({}, doc), mappings: [m], releaseEnabled: true, margin: fakeMargin() });
    for (const doc of [datePage, instantDoc()]) {
      const base = await assess(before, doc);
      expect(base.reasons).toEqual(expect.arrayContaining(["capability_not_ready", "slot_rules_unknown", "slot_times_mismatch"]));
      expect((await assess({ ...before, dateOnlySellable: false }, doc)).reasons).toEqual(base.reasons);
      expect((await assess({ ...before, dateOnlySellable: null }, doc)).reasons).toEqual(base.reasons);
      expect(base.effective).toBe("inquiry");
    }
  });
});

/** One shared read-budget window, applied with the pure rule (as start-times.unit.test.ts). */
function budget(limits = READ_BUDGET) {
  let window: ReadWindow = { used: 0, quoteUsed: 0 };
  const taken: ReadClass[] = [];
  const take = (cls: ReadClass) => async () => {
    const next = admitRead(window, cls, limits);
    if (!next) return false;
    window = next;
    taken.push(cls);
    return true;
  };
  return { take, taken };
}

function context(offer: Record<string, unknown> = DATE_ONLY): Context {
  return {
    mapping: {
      id: "m-1",
      isActive: true,
      environment: "test",
      adapter: "traveldesk",
      supplierCode: "traveldesk",
      externalRef: { tourId: 3001, offerId: 501, bookingKind: "live_book", isExternal: false },
      approvedOfferHash: offerTermsHash(offer, storedTour())!,
      approvedSlotHours: slotHoursOf(offer),
    },
    offer: { payload: offer, removed: false },
    tour: { payload: storedTour(), removed: false },
  };
}

function harness(rows: (date: string) => ReturnType<typeof row>[], ctx: Context = context()) {
  const calls: string[] = [];
  const b = budget();
  const source = {
    async getAvailability(offerId: number, from: string) {
      calls.push(`availability:${offerId}:${from}`);
      return { rows: rows(from) };
    },
    async getTicketStock(): Promise<never> {
      throw new Error("not used");
    },
    async listPickupHotels() {
      return [{ hotelId: 42, name: "Synthetic Hotel" }];
    },
  };
  const svc = createSupplierQuoteService({
    load: async () => ctx,
    source: (environment) => ({ source, accountId: `acct-${environment}` }),
    takeQuoteReadToken: b.take("quote"),
    takeBrowseReadToken: b.take("browse"),
    now: () => NOW,
    nowMs: () => NOW.getTime(),
  });
  return { svc, calls, budget: b };
}

const wholeDay = (date: string) => [row({ date, timeSlotId: 0, startMinutes: 0, endMinutes: 1439, seatsLeft: 40, price: { date } })];
const twoStarts = (date: string) => [
  row({ date, timeSlotId: 7, startMinutes: 1080, endMinutes: 1260, seatsLeft: 30, price: { date } }),
  row({ date, timeSlotId: 8, startMinutes: 1200, endMinutes: 1380, seatsLeft: 3, price: { date } }),
];

describe("supplierQuoteService for a date-only offer", () => {
  it("the quote reads afresh from the quote share and carries the row it accepted", async () => {
    const h = harness(wholeDay);
    const q = await h.svc.quote({ mappingId: "m-1", serviceDate: DATE, slotRef: null, dateOnly: true, supplierUnits: { adult: 2 }, pickup: null });
    expect(q).toMatchObject({ ok: true, slotRef: null, availabilitySlot: { timeSlotId: 0, startMinutes: 0, endMinutes: 1439 } });
    expect(h.calls).toEqual([`availability:501:${DATE}`]);
    expect(h.budget.taken).toEqual(["quote"]);
    // Without readiness's date-only verdict the same offer is refused, as before Batch 7 (B7-08).
    expect(await h.svc.quote({ mappingId: "m-1", serviceDate: DATE, slotRef: null, supplierUnits: { adult: 2 }, pickup: null })).toEqual({ ok: false, reason: "availability_unknown" });
  });

  it("the pickup offer checks the hotel on the offer's list first (Batch 3 path), then quotes the row", async () => {
    const pickup = storedOffer({ timeSlots: [], durationHours: 3, isDirectReporting: false });
    const h = harness(wholeDay, context(pickup));
    expect(await h.svc.quote({ mappingId: "m-1", serviceDate: DATE, slotRef: null, dateOnly: true, supplierUnits: { adult: 2 }, pickup: null })).toEqual({ ok: false, reason: "pickup_unavailable" });
    expect(await h.svc.quote({ mappingId: "m-1", serviceDate: DATE, slotRef: null, dateOnly: true, supplierUnits: { adult: 2 }, pickup: { hotelRef: "77" } })).toEqual({ ok: false, reason: "pickup_unavailable" });
    expect(await h.svc.quote({ mappingId: "m-1", serviceDate: DATE, slotRef: null, dateOnly: true, supplierUnits: { adult: 2 }, pickup: { hotelRef: "42" } })).toMatchObject({
      ok: true,
      pickupHotelName: "Synthetic Hotel",
      availabilitySlot: { timeSlotId: 0, startMinutes: 0, endMinutes: 1439 },
    });
  });

  it("start times: one start answers its shown start (null for 00:00), several the listed starts; one browse read per offer and date", async () => {
    const one = harness(wholeDay);
    expect(await one.svc.startTimes({ mappingId: "m-1", serviceDate: DATE, dateOnly: true })).toEqual({ ok: true, times: [], checkedAt: NOW.toISOString(), stale: false, dateOnlyStart: { startsAt: null, status: "available" } });
    expect(one.budget.taken).toEqual(["browse"]);
    const real = harness((date) => [row({ date, timeSlotId: 4, startMinutes: 900, endMinutes: 1080, seatsLeft: 40, price: { date } })]);
    expect(await real.svc.startTimes({ mappingId: "m-1", serviceDate: DATE, dateOnly: true })).toMatchObject({ ok: true, dateOnlyStart: { startsAt: "15:00", status: "available" } });
    const several = harness(twoStarts);
    const r = await several.svc.startTimes({ mappingId: "m-1", serviceDate: DATE, dateOnly: true });
    expect(r).toEqual({ ok: true, checkedAt: NOW.toISOString(), stale: false, times: [{ time: "18:00", status: "available" }, { time: "20:00", status: "limited" }] });
    expect(JSON.stringify(r)).not.toMatch(/price|Minor|seats|501|3001/);
    await several.svc.startTimes({ mappingId: "m-1", serviceDate: DATE, dateOnly: true });
    expect(several.calls).toHaveLength(1);
    expect(several.budget.taken).toEqual(["browse"]);
  });

  it("start times are kept five minutes for a date-only offer (B7-07), and without the date-only verdict nothing is read", async () => {
    let ms = NOW.getTime();
    const calls: string[] = [];
    const b = budget();
    const svc = createSupplierQuoteService({
      load: async () => context(),
      source: () => ({
        source: {
          async getAvailability(_o: number, from: string) {
            calls.push(from);
            return { rows: wholeDay(from) };
          },
          async getTicketStock(): Promise<never> {
            throw new Error("not used");
          },
          async listPickupHotels() {
            return [];
          },
        },
        accountId: "acct",
      }),
      takeQuoteReadToken: b.take("quote"),
      takeBrowseReadToken: b.take("browse"),
      now: () => new Date(ms),
      nowMs: () => ms,
    });
    expect(DATE_ONLY_START_TIMES_TTL_MS).toBe(5 * 60_000);
    await svc.startTimes({ mappingId: "m-1", serviceDate: DATE, dateOnly: true });
    ms += 4 * 60_000;
    await svc.startTimes({ mappingId: "m-1", serviceDate: DATE, dateOnly: true });
    expect(calls).toHaveLength(1);
    ms += 60_000;
    await svc.startTimes({ mappingId: "m-1", serviceDate: DATE, dateOnly: true });
    expect(calls).toHaveLength(2);
    expect(await svc.startTimes({ mappingId: "m-1", serviceDate: DATE })).toEqual({ ok: false, reason: "not_listed" });
    expect(calls).toHaveLength(2);
  });
});

describe("createStartTimesService: a date-only offer asks the supplier only with its key on", () => {
  function svc(m: ReturnType<typeof mapping>) {
    const asked: unknown[] = [];
    const s = createStartTimesService({
      readiness: {
        async assess(productId) {
          const a = await assessReadiness({ product: product({}, datePage), mappings: [m], releaseEnabled: true, margin: fakeMargin() });
          return { ...a, result: { productId, requested: a.requested, effective: a.effective, reasons: a.reasons, readinessVersion: READINESS_RULES_VERSION, evaluatedAt: NOW.toISOString() } };
        },
      },
      reader: {
        async startTimes(input) {
          asked.push(input);
          return { ok: true, times: [], checkedAt: NOW.toISOString(), stale: false, dateOnlyStart: { startsAt: "15:00", status: "available" as const } };
        },
      },
      now: () => NOW,
    });
    return { s, asked };
  }
  const q = { productId: PRODUCT_ID, variantId: "shared", serviceDate: "2026-11-05" };

  it("on: the supplier is asked as date only, and a one-start date answers date_only with its start", async () => {
    const h = svc(dateOnlyMapping());
    expect(await h.s.startTimes(q)).toEqual({ source: "date_only", checkedAt: NOW.toISOString(), stale: false, startsAt: "15:00", status: "available" });
    expect(h.asked).toEqual([{ mappingId: "0190a000-0000-7000-8000-0000000000aa", serviceDate: "2026-11-05", dateOnly: true }]);
  });

  it("off: no supplier read at all", async () => {
    const h = svc(dateOnlyMapping({ dateOnlySellable: false, slotRulesKnown: false }));
    expect(await h.s.startTimes(q)).toEqual({ source: "stored", reason: "not_listed" });
    expect(h.asked).toEqual([]);
  });
});

describe("quote service: a date-only line stores the availability row and shows no time", () => {
  it("the stored line carries availabilitySlot; the public line does not; the slot reference stays null", async () => {
    const supplier: SupplierQuoteResult = {
      ok: true,
      slotRef: null,
      netAedMinor: 30_000n,
      netUsdMinor: 8_200n,
      checkedAt: NOW.toISOString(),
      capacity: "limited",
      seatsLeft: 40,
      cutoffUtc: "2026-12-30T20:00:00.000Z",
      issuesTicketsAtConfirm: "no",
      supplierFreeCancellationUntilUtc: null,
      ticketValidUntil: null,
      availabilitySlot: { timeSlotId: 0, startMinutes: 0, endMinutes: 1439 },
    };
    const stored: unknown[] = [];
    const asked: unknown[] = [];
    const svc = createQuoteService({
      readiness: {
        async assess(productId) {
          const a = await assessReadiness({ product: product({}, datePage), mappings: [dateOnlyMapping()], releaseEnabled: true, margin: fakeMargin() });
          return { ...a, result: { productId, requested: a.requested, effective: a.effective, reasons: a.reasons, readinessVersion: READINESS_RULES_VERSION, evaluatedAt: NOW.toISOString() } };
        },
        async reevaluate() {
          return null;
        },
      },
      supplierQuote: {
        quote: async (input) => {
          asked.push(input);
          return supplier;
        },
      },
      margin: fakeMargin(),
      store: {
        async findActiveByFingerprint() {
          return [];
        },
        async replace({ quote }) {
          stored.push(quote);
          return true;
        },
      },
      isFirstBooking: async () => false,
      instantOrderCap: async () => ({ capAedMinor: 1_000_000_000, inrPerAed: "25.00" }),
      now: () => NOW,
    });
    const q = await svc.create({ kind: "guest", guestSessionId: "0190a000-0000-7000-8000-0000000000e1" }, {
      lines: [{ productId: PRODUCT_ID, variantId: "shared", serviceDate: DATE, slotRef: null, units: { adult: 2, child: 1 }, addonIds: [], pickup: null }],
      currency: "AED",
      couponCode: null,
    });
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(q.lines[0]).toMatchObject({ slotRef: null, availabilitySlot: { timeSlotId: 0, startMinutes: 0, endMinutes: 1439 } });
    expect(stored).toHaveLength(1);
    const { toPublicQuote } = await import("../quote.service");
    expect(JSON.stringify(toPublicQuote(q))).not.toContain("availabilitySlot");
    // The supplier check is told the mapping sells as date only (B7-08).
    expect(asked).toEqual([expect.objectContaining({ dateOnly: true })]);
  });
});

describe("quote service: date-only refund window and seat count (review 92 B7-02; owner decisions a and b)", () => {
  async function quoteWith(supplier: SupplierQuoteResult, hours: number) {
    const doc = instantDoc({ timeSlots: [], freeCancellationHours: hours });
    const m = dateOnlyMapping({ issuesTicketsAtConfirm: "no", supplierFreeCancellationHours: hours || null });
    const svc = createQuoteService({
      readiness: {
        async assess(productId) {
          const a = await assessReadiness({ product: product({}, doc), mappings: [m], releaseEnabled: true, margin: fakeMargin() });
          return { ...a, result: { productId, requested: a.requested, effective: a.effective, reasons: a.reasons, readinessVersion: READINESS_RULES_VERSION, evaluatedAt: NOW.toISOString() } };
        },
        async reevaluate() {
          return null;
        },
      },
      supplierQuote: { quote: async () => supplier },
      margin: fakeMargin(),
      store: { findActiveByFingerprint: async () => [], replace: async () => true },
      isFirstBooking: async () => false,
      instantOrderCap: async () => ({ capAedMinor: 1_000_000_000, inrPerAed: "25.00" }),
      now: () => NOW,
    });
    return svc.create({ kind: "guest", guestSessionId: "0190a000-0000-7000-8000-0000000000e1" }, {
      lines: [{ productId: PRODUCT_ID, variantId: "shared", serviceDate: DATE, slotRef: "18:00", units: { adult: 2, child: 1 }, addonIds: [], pickup: null }],
      currency: "AED",
      couponCode: null,
    });
  }
  const base: SupplierQuoteResult = {
    ok: true,
    slotRef: "7@18:00",
    netAedMinor: 30_000n,
    netUsdMinor: 8_200n,
    checkedAt: NOW.toISOString(),
    capacity: "limited",
    seatsLeft: 30,
    cutoffUtc: "2026-12-30T20:00:00.000Z",
    issuesTicketsAtConfirm: "no",
    // 24 h before 00:00 Dubai on 31 Dec.
    supplierFreeCancellationUntilUtc: "2026-12-29T20:00:00.000Z",
    ticketValidUntil: null,
    availabilitySlot: { timeSlotId: 7, startMinutes: 1080, endMinutes: 1260 },
  };

  it("the customer's deadline counts from 00:00 on the service date even when the line names an 18:00 start", async () => {
    const q = await quoteWith(base, 24);
    expect(q.ok).toBe(true);
    // Counted from 18:00 it would be 30 Dec 14:00 UTC, later than the supplier's window, and the line would be refused.
    expect(q.ok && q.lines[0].freeCancellationUntilUtc).toBe("2026-12-29T20:00:00.000Z");
    // A fixed-slot line (no availability row) still counts from its start, as before.
    const { availabilitySlot: _drop, ...fixed } = base as Extract<SupplierQuoteResult, { ok: true }>;
    expect(await quoteWith(fixed, 24)).toMatchObject({ ok: false });
  });

  it("no seat count given (sentinel) is quoted; unknown capacity without that statement is still refused", async () => {
    expect((await quoteWith({ ...base, capacity: "unknown", seatsLeft: null, seatsUnstated: true }, 0)).ok).toBe(true);
    expect((await quoteWith({ ...base, capacity: "unknown", seatsLeft: null }, 0)).ok).toBe(false);
  });
});
