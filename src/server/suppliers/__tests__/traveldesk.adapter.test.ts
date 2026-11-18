import { describe, expect, it } from "vitest";
import type { PaxCount } from "@/lib/types";
import { isAppError } from "../../lib/errors";
import { idempotencyKeyFor, isSupplierError, SupplierError, type AvailabilityRequest, type BookingRequest, type SupplierMappingRef } from "../port";
import { TRAVELDESK_CAPABILITIES, TravelDeskLiveAdapter, type TravelDeskExternalRef } from "../traveldesk/traveldesk.adapter";
import { traveldeskConfigFrom, type TravelDeskConfig } from "../traveldesk/traveldesk.config";

const KEY = "test-key-not-real";
const BASE = "https://testapi.traveldesk.me/public/b2b/v1";
const config = traveldeskConfigFrom({
  SUPPLIER_ADAPTER_TRAVELDESK: "live",
  TRAVELDESK_ENV: "test",
  TRAVELDESK_API_BASE_URL: BASE,
  TRAVELDESK_API_KEY: KEY,
}) as TravelDeskConfig;

const DATE = "2026-11-03";
const T0 = Date.parse("2026-10-27T08:00:00.000Z");
const TTL_MS = 600_000;

const liveRef: TravelDeskExternalRef = { tourId: 3001, offerId: 501, bookingKind: "live_book", isExternal: false };
const ticketRef: TravelDeskExternalRef = { tourId: 3002, offerId: 502, bookingKind: "ticket_only", isExternal: false };

function mapping(externalRef: Record<string, unknown>): SupplierMappingRef {
  return {
    mappingId: "m-td-1",
    productId: "p1",
    productSlug: "red-dune-desert-safari",
    supplierId: "s-td",
    supplierCode: "traveldesk",
    adapter: "traveldesk",
    priority: 1,
    externalRef,
  };
}

const PAX2: PaxCount = { adult: 2, child: 0, infant: 0, senior: 0 };

function req(over: Partial<AvailabilityRequest> = {}, ref: Record<string, unknown> = liveRef): AvailabilityRequest {
  return { mapping: mapping(ref), date: DATE, pax: PAX2, ...over };
}

function offerPrice(over: Record<string, unknown> = {}) {
  return {
    offerId: 501,
    currency: "AED",
    recPricePerAdult: 250,
    recPricePerChild: 200,
    recPricePerTrip: null,
    pricePerAdult: 185.5,
    pricePerChild: 150,
    pricePerTrip: 0,
    pricePerAdultUsd: 50.51,
    pricePerChildUsd: 40.84,
    pricePerTripUsd: 0,
    discountPercent: null,
    hasDiscount: false,
    isBookable: true,
    supplierCurrencyCode: "AED",
    conversionRate: 1,
    vat: 5,
    date: `${DATE}T00:00:00`,
    ...over,
  };
}

function row(startTime: number, left: number, over: { date?: string; isBookable?: boolean; currency?: string | null; timeSlotId?: number } = {}) {
  return {
    availability: { id: startTime, date: over.date ?? `${DATE}T00:00:00`, startTime, endTime: startTime + 360, timeSlotId: over.timeSlotId ?? startTime, left },
    price: offerPrice({ isBookable: over.isBookable ?? true, ...(over.currency !== undefined ? { currency: over.currency } : {}) }),
  };
}

function stock(over: Record<string, unknown> = {}) {
  return {
    stock: {
      offerId: 502,
      isAdultTicketRequired: true,
      adultTicketsLeft: 10,
      isChildTicketRequired: true,
      childTicketsLeft: 10,
      isSameTicketForAdultAndChild: false,
      validUntil: "2026-12-31T00:00:00",
      ...over,
    },
    price: offerPrice({ offerId: 502, date: null }),
  };
}

type Responder = (url: URL) => Response | Promise<Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup(respond: Responder | unknown) {
  const calls: URL[] = [];
  const clock = { now: T0 };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    return typeof respond === "function" ? (respond as Responder)(url) : json(respond);
  }) as typeof fetch;
  const adapter = new TravelDeskLiveAdapter(config, { fetch: fetchImpl, nowMs: () => clock.now });
  return { adapter, calls, clock };
}

async function supplierFailure(p: Promise<unknown>): Promise<SupplierError> {
  try {
    await p;
  } catch (e) {
    expect(isSupplierError(e)).toBe(true);
    return e as SupplierError;
  }
  throw new Error("expected a SupplierError");
}

const booking: BookingRequest = {
  idempotencyKey: idempotencyKeyFor("o1", "i1"),
  orderId: "o1",
  orderItemId: "i1",
  orderReference: "OUT-100001",
  mapping: mapping(liveRef),
  serviceDate: DATE,
  pax: PAX2,
  lead: { fullName: "Test Lead", phoneE164: "+971500000000" },
};

describe("TravelDeskLiveAdapter — not configured", () => {
  const port = new TravelDeskLiveAdapter(null);

  it("every method throws NOT_CONFIGURED", async () => {
    expect(port.name).toBe("traveldesk-live");
    for (const p of [port.checkAvailability(req()), port.createBooking(booking), port.lookupBooking("x"), port.cancelBooking("x", "r")]) {
      try {
        await p;
        expect.unreachable("should throw");
      } catch (e) {
        expect(isAppError(e)).toBe(true);
        if (isAppError(e)) expect(e).toMatchObject({ code: "NOT_CONFIGURED", status: 503 });
      }
    }
  });
});

describe("TravelDeskLiveAdapter — mapping", () => {
  it("is named after the environment and keeps instantConfirmation false", () => {
    const { adapter } = setup([]);
    expect(adapter.name).toBe("traveldesk-live-test");
    expect(adapter.capabilities().instantConfirmation).toBe(false);
    expect(adapter.capabilities()).toEqual(TRAVELDESK_CAPABILITIES);
  });

  it("an invalid externalRef is a SupplierError invalid_mapping, with no fetch", async () => {
    const { adapter, calls } = setup([]);
    for (const ref of [{}, { ...liveRef, offerId: "501" }, { ...liveRef, offerId: 0 }, { ...liveRef, bookingKind: "instant" }, { tourId: 1, offerId: 2, bookingKind: "live_book" }]) {
      const err = await supplierFailure(adapter.checkAvailability(req({}, ref)));
      expect(err.code).toBe("error");
      expect(err.details).toEqual({ reason: "invalid_mapping" });
    }
    expect(calls).toHaveLength(0);
  });

  it("on_request and unknown mappings are quote_only and never call the API", async () => {
    const { adapter, calls } = setup([]);
    for (const bookingKind of ["on_request", "unknown"] as const) {
      const r = await adapter.checkAvailability(req({}, { ...liveRef, bookingKind }));
      expect(r).toEqual({
        status: "quote_only",
        spotsLeft: null,
        slots: [],
        nextDates: [],
        checkedAt: new Date(T0).toISOString(),
        source: "live",
        capacityIsReliable: false,
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("a malformed date is refused before any request", async () => {
    const { adapter, calls } = setup([]);
    const err = await supplierFailure(adapter.checkAvailability(req({ date: "2026-11-03T00:00:00" })));
    expect(err.code).toBe("error");
    expect(calls).toHaveLength(0);
  });
});

describe("TravelDeskLiveAdapter — live_book availability", () => {
  it("requests one day in AED with plain dates", async () => {
    const { adapter, calls } = setup([row(960, 10)]);
    await adapter.checkAvailability(req());
    expect(calls).toHaveLength(1);
    const url = calls[0];
    expect(url.origin).toBe("https://testapi.traveldesk.me");
    expect(url.pathname).toBe("/public/b2b/v1/availability/byoffer");
    expect(Object.fromEntries(url.searchParams)).toEqual({ Id: "501", From: DATE, To: DATE, CurrencyCode: "AED" });
    expect(url.searchParams.get("From")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("enough seats → available; slots sorted HH:mm; never reports capacity", async () => {
    const { adapter } = setup([row(960, 10), row(570, 4), row(1200, 0)]);
    const r = await adapter.checkAvailability(req());
    expect(r).toMatchObject({ status: "available", spotsLeft: null, source: "live", capacityIsReliable: false, nextDates: [] });
    expect(r.slots).toEqual([
      { time: "09:30", status: "available" },
      { time: "16:00", status: "available" },
      { time: "20:00", status: "sold_out" },
    ]);
    expect(r.slots.every((s) => s.spotsLeft === undefined)).toBe(true);
    expect(r.checkedAt).toBe(new Date(T0).toISOString());
  });

  it("duplicate start times: one full and one with seats → available", async () => {
    const { adapter } = setup([row(960, 0, { timeSlotId: 1 }), row(960, 5, { timeSlotId: 2 })]);
    const r = await adapter.checkAvailability(req({ timeslot: "16:00" }));
    expect(r.status).toBe("available");
    expect(r.slots).toEqual([{ time: "16:00", status: "available" }]);
  });

  it("not enough seats → sold_out", async () => {
    const { adapter } = setup([row(960, 1), row(570, 1)]);
    const r = await adapter.checkAvailability(req());
    expect(r.status).toBe("sold_out");
    expect(r.slots.map((s) => s.status)).toEqual(["sold_out", "sold_out"]);
  });

  it("isBookable false → sold_out even with seats", async () => {
    const { adapter } = setup([row(960, 50, { isBookable: false })]);
    expect((await adapter.checkAvailability(req())).status).toBe("sold_out");
  });

  it("zero rows → unknown, never sold_out", async () => {
    const { adapter } = setup([]);
    const r = await adapter.checkAvailability(req());
    expect(r.status).toBe("unknown");
    expect(r.slots).toEqual([]);
  });

  it("rows only for another date → unknown", async () => {
    const { adapter } = setup([row(960, 10, { date: "2026-11-04T00:00:00" })]);
    expect((await adapter.checkAvailability(req())).status).toBe("unknown");
  });

  it("requested timeslot missing → unknown (other slots still listed)", async () => {
    const { adapter } = setup([row(960, 10)]);
    const r = await adapter.checkAvailability(req({ timeslot: "09:30" }));
    expect(r.status).toBe("unknown");
    expect(r.slots).toEqual([{ time: "16:00", status: "available" }]);
  });

  it("malformed timeslot → unknown, never the whole-day answer", async () => {
    const { adapter } = setup([row(570, 0), row(960, 10)]);
    const r = await adapter.checkAvailability(req({ timeslot: "9:30" }));
    expect(r.status).toBe("unknown");
  });

  it("requested timeslot present → that slot's status, not the day's", async () => {
    const { adapter } = setup([row(570, 0), row(960, 10)]);
    expect((await adapter.checkAvailability(req({ timeslot: "09:30" }))).status).toBe("sold_out");
    expect((await adapter.checkAvailability(req({ timeslot: "16:00" }))).status).toBe("available");
    expect((await adapter.checkAvailability(req())).status).toBe("available");
  });

  it("seniors take seats as adults; infants take none", async () => {
    const { adapter } = setup([row(960, 3)]);
    expect((await adapter.checkAvailability(req({ pax: { adult: 1, child: 0, infant: 3, senior: 2 } }))).status).toBe("available");
    expect((await adapter.checkAvailability(req({ pax: { adult: 1, child: 1, infant: 0, senior: 2 } }))).status).toBe("sold_out");
    expect((await adapter.checkAvailability(req({ pax: { adult: 0, child: 0, infant: 0, senior: 4 } }))).status).toBe("sold_out");
  });
});

describe("TravelDeskLiveAdapter — ticket_only availability", () => {
  it("requests ticket stock in AED", async () => {
    const { adapter, calls } = setup(stock());
    expect((await adapter.checkAvailability(req({}, ticketRef))).status).toBe("available");
    expect(calls[0].pathname).toBe("/public/b2b/v1/tickets/byoffer");
    expect(Object.fromEntries(calls[0].searchParams)).toEqual({ Id: "502", CurrencyCode: "AED" });
  });

  it("validUntil (earliest expiry) before the date → unknown, never sold_out; on the date → available; null → available", async () => {
    expect((await setup(stock({ validUntil: "2026-11-02T00:00:00" })).adapter.checkAvailability(req({}, ticketRef))).status).toBe("unknown");
    expect((await setup(stock({ validUntil: `${DATE}T00:00:00` })).adapter.checkAvailability(req({}, ticketRef))).status).toBe("available");
    expect((await setup(stock({ validUntil: null })).adapter.checkAvailability(req({}, ticketRef))).status).toBe("available");
  });

  it("a ticket price dated for another day proves nothing about the requested date → unknown", async () => {
    const base = stock();
    const other = { ...base, price: { ...(base as { price: Record<string, unknown> }).price, date: "2026-10-28T00:00:00" } };
    expect((await setup(other).adapter.checkAvailability(req({}, ticketRef))).status).toBe("unknown");
  });

  it("infant-only pax → unknown (no seated guest)", async () => {
    const { adapter } = setup([row(960, 0)]);
    expect((await adapter.checkAvailability(req({ pax: { adult: 0, child: 0, infant: 1, senior: 0 } }))).status).toBe("unknown");
  });

  it("separate adult/child stock is checked per category", async () => {
    const s = { adultTicketsLeft: 2, childTicketsLeft: 1 };
    expect((await setup(stock(s)).adapter.checkAvailability(req({ pax: { adult: 1, child: 1, infant: 0, senior: 1 } }, ticketRef))).status).toBe("available");
    expect((await setup(stock(s)).adapter.checkAvailability(req({ pax: { adult: 3, child: 0, infant: 0, senior: 0 } }, ticketRef))).status).toBe("sold_out");
    expect((await setup(stock(s)).adapter.checkAvailability(req({ pax: { adult: 1, child: 2, infant: 0, senior: 0 } }, ticketRef))).status).toBe("sold_out");
    // A category the offer does not require is not checked.
    expect((await setup(stock({ ...s, isChildTicketRequired: false, childTicketsLeft: 0 })).adapter.checkAvailability(req({ pax: { adult: 1, child: 3, infant: 0, senior: 0 } }, ticketRef))).status).toBe("available");
  });

  it("same ticket for adult and child: adults + children against one pool", async () => {
    const s = { isSameTicketForAdultAndChild: true, adultTicketsLeft: 3, childTicketsLeft: 0 };
    expect((await setup(stock(s)).adapter.checkAvailability(req({ pax: { adult: 2, child: 1, infant: 1, senior: 0 } }, ticketRef))).status).toBe("available");
    expect((await setup(stock(s)).adapter.checkAvailability(req({ pax: { adult: 2, child: 2, infant: 0, senior: 0 } }, ticketRef))).status).toBe("sold_out");
  });

  it("isBookable false → sold_out", async () => {
    const body = stock();
    body.price = offerPrice({ offerId: 502, isBookable: false });
    expect((await setup(body).adapter.checkAvailability(req({}, ticketRef))).status).toBe("sold_out");
  });
});

describe("TravelDeskLiveAdapter — caching", () => {
  it("a second call within the TTL makes no new request (other pax reuse the same data)", async () => {
    const { adapter, calls, clock } = setup([row(960, 3)]);
    await adapter.checkAvailability(req());
    clock.now = T0 + TTL_MS - 1;
    const r = await adapter.checkAvailability(req({ pax: { adult: 4, child: 0, infant: 0, senior: 0 } }));
    expect(calls).toHaveLength(1);
    expect(r.status).toBe("sold_out");
    expect(r.checkedAt).toBe(new Date(T0).toISOString());
  });

  it("different dates and offers are separate cache entries", async () => {
    const { adapter, calls } = setup([row(960, 3)]);
    await adapter.checkAvailability(req());
    await adapter.checkAvailability(req({ date: "2026-11-04" }));
    await adapter.checkAvailability(req({}, { ...liveRef, offerId: 777 }));
    expect(calls).toHaveLength(3);
  });

  it("fresh: true refetches", async () => {
    const { adapter, calls, clock } = setup([row(960, 3)]);
    await adapter.checkAvailability(req());
    clock.now = T0 + 1_000;
    const r = await adapter.checkAvailability(req({ fresh: true }));
    expect(calls).toHaveLength(2);
    expect(r.checkedAt).toBe(new Date(T0 + 1_000).toISOString());
  });

  it("after the TTL a failing refresh serves the stale result with the ORIGINAL checkedAt", async () => {
    let fail = false;
    const { adapter, calls, clock } = setup(() => (fail ? new Response(null, { status: 500 }) : json([row(960, 3)])));
    await adapter.checkAvailability(req());
    fail = true;
    clock.now = T0 + TTL_MS + 5_000;
    const r = await adapter.checkAvailability(req());
    expect(calls).toHaveLength(2);
    expect(r.status).toBe("available");
    expect(r.checkedAt).toBe(new Date(T0).toISOString());
  });

  it("the pre-payment re-check (fresh) never serves stale data", async () => {
    let fail = false;
    const { adapter, clock } = setup(() => (fail ? new Response(null, { status: 500 }) : json([row(960, 3)])));
    await adapter.checkAvailability(req());
    fail = true;
    clock.now = T0 + 1_000;
    const err = await supplierFailure(adapter.checkAvailability(req({ fresh: true })));
    expect(err.code).toBe("error");
  });

  it("stale data older than TTL + 1h is not served", async () => {
    let fail = false;
    const { adapter, clock } = setup(() => (fail ? new Response(null, { status: 500 }) : json([row(960, 3)])));
    await adapter.checkAvailability(req());
    fail = true;
    clock.now = T0 + TTL_MS + 60 * 60 * 1000;
    expect((await supplierFailure(adapter.checkAvailability(req()))).details).toMatchObject({ kind: "server", status: 500 });
  });
});

describe("TravelDeskLiveAdapter — failures with no cache", () => {
  it("timeout → SupplierError timeout", async () => {
    const { adapter } = setup(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const err = await supplierFailure(adapter.checkAvailability(req()));
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(true);
    expect(err.details).toEqual({ kind: "timeout", status: null, operation: "availability.byoffer" });
  });

  it("404 → offer_unavailable", async () => {
    const { adapter } = setup(() => new Response(null, { status: 404 }));
    const err = await supplierFailure(adapter.checkAvailability(req()));
    expect(err.code).toBe("error");
    expect(err.details).toMatchObject({ reason: "offer_unavailable", kind: "not_found", status: 404 });
  });

  it("USD prices → error (invalid_response), never converted", async () => {
    const { adapter } = setup([row(960, 10, { currency: "USD" })]);
    const err = await supplierFailure(adapter.checkAvailability(req()));
    expect(err.code).toBe("error");
    expect(err.details).toMatchObject({ kind: "invalid_response", operation: "availability.byoffer" });
  });

  it("ticket stock with null currency → error", async () => {
    const body = stock();
    body.price = offerPrice({ currency: null });
    const err = await supplierFailure(setup(body).adapter.checkAvailability(req({}, ticketRef)));
    expect(err.details).toMatchObject({ kind: "invalid_response", operation: "tickets.byoffer" });
  });

  it("auth failure → error with kind auth; the key is not in the error", async () => {
    const { adapter } = setup(() => new Response(null, { status: 403 }));
    const err = await supplierFailure(adapter.checkAvailability(req()));
    expect(err.details).toMatchObject({ kind: "auth", status: 403 });
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect(JSON.stringify(err.toAppError())).not.toContain(KEY);
    expect(err.message).not.toContain(KEY);
  });
});

describe("TravelDeskLiveAdapter — booking goes through the engine; no lookup by id", () => {
  it("createBooking → NOT_IMPLEMENTED and never calls the API", async () => {
    const { adapter, calls } = setup([]);
    await expect(adapter.createBooking(booking)).rejects.toMatchObject({ code: "NOT_IMPLEMENTED", status: 501 });
    expect(calls).toHaveLength(0);
  });

  it("lookup and cancel → not_supported, without a request: get-by-id may issue tickets (SUP-4, CR-B1-12)", async () => {
    const { adapter, calls } = setup([]);
    for (const ref of ["TD-1", "303401", "9"]) await expect(adapter.lookupBooking(ref)).resolves.toMatchObject({ outcome: "not_supported" });
    await expect(adapter.cancelBooking("303401", "customer request")).resolves.toMatchObject({ outcome: "not_supported" });
    expect(calls).toHaveLength(0);
  });

  it("capabilities: no lookup and never instant, so no product can be flipped to instant yet", () => {
    expect(TRAVELDESK_CAPABILITIES).toMatchObject({
      instantConfirmation: false,
      supportsCancellation: false,
      supportsBookingLookup: false,
      supportsIdempotency: false,
      hasRealtimeCapacity: false,
      currency: "AED",
    });
  });
});
