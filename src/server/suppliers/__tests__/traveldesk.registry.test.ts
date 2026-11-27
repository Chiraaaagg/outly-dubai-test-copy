import { describe, expect, it } from "vitest";
import { isAppError } from "../../lib/errors";
import { idempotencyKeyFor, isSupplierError, type BookingRequest, type SupplierMappingRef } from "../port";
import { RathinMockAdapter } from "../rathin/rathin.mock";
import { supplierFor, type SupplierEnv } from "../registry";
import { TRAVELDESK_CAPABILITIES, TravelDeskLiveAdapter } from "../traveldesk/traveldesk.adapter";
import { TravelDeskMockAdapter } from "../traveldesk/traveldesk.mock";

const KEY = "test-key-not-real";
const rathinOnly: SupplierEnv = { SUPPLIER_ADAPTER_RATHIN: "mock", RATHIN_TIMEOUT_MS: 8000 };
const liveTd: SupplierEnv = {
  ...rathinOnly,
  SUPPLIER_ADAPTER_TRAVELDESK: "live",
  TRAVELDESK_ENV: "test",
  TRAVELDESK_API_BASE_URL: "https://testapi.traveldesk.me/public/b2b/v1",
  TRAVELDESK_API_KEY: KEY,
};

const mapping: SupplierMappingRef = {
  mappingId: "m-td-1",
  productId: "p1",
  productSlug: "red-dune-desert-safari",
  supplierId: "s-td",
  supplierCode: "traveldesk",
  adapter: "traveldesk",
  priority: 1,
  externalRef: { tourId: 3001, offerId: 501, bookingKind: "live_book", isExternal: false },
};
const pax = { adult: 2, child: 0, infant: 0, senior: 0 };

const booking: BookingRequest = {
  idempotencyKey: idempotencyKeyFor("o1", "i1"),
  orderId: "o1",
  orderItemId: "i1",
  orderReference: "OUT-100001",
  mapping,
  serviceDate: "2026-11-03",
  pax,
  lead: { fullName: "Test Lead", phoneE164: "+971500000000" },
};

describe("supplierFor('traveldesk')", () => {
  it("selects the mock when SUPPLIER_ADAPTER_TRAVELDESK is unset or mock", () => {
    expect(supplierFor("traveldesk", rathinOnly)).toBeInstanceOf(TravelDeskMockAdapter);
    expect(supplierFor("traveldesk", { ...rathinOnly, SUPPLIER_ADAPTER_TRAVELDESK: "mock" })).toBeInstanceOf(TravelDeskMockAdapter);
    // Everything else set but mode mock: still the mock.
    expect(supplierFor({ adapter: "traveldesk", code: "traveldesk" }, { ...liveTd, SUPPLIER_ADAPTER_TRAVELDESK: "mock" })).toBeInstanceOf(TravelDeskMockAdapter);
  });

  it("live + valid config → TravelDeskLiveAdapter named traveldesk-live-test", () => {
    const port = supplierFor("traveldesk", liveTd);
    expect(port).toBeInstanceOf(TravelDeskLiveAdapter);
    expect(port.name).toBe("traveldesk-live-test");
  });

  it("live + invalid config → the live adapter, failing loudly with NOT_CONFIGURED (never the mock)", async () => {
    for (const bad of [
      { ...liveTd, TRAVELDESK_API_KEY: undefined },
      { ...liveTd, TRAVELDESK_API_BASE_URL: "https://api.traveldesk.me/public/b2b/v1" },
      { ...liveTd, APP_ENV: "production" as const },
      { ...liveTd, TRAVELDESK_ENV: undefined },
    ]) {
      const port = supplierFor("traveldesk", bad);
      expect(port).toBeInstanceOf(TravelDeskLiveAdapter);
      expect(port).not.toBeInstanceOf(TravelDeskMockAdapter);
      expect(port.name).toBe("traveldesk-live");
      try {
        await port.checkAvailability({ mapping, date: "2026-11-03", pax });
        expect.unreachable("should throw");
      } catch (e) {
        expect(isAppError(e)).toBe(true);
        if (isAppError(e)) {
          expect(e.code).toBe("NOT_CONFIGURED");
          expect(JSON.stringify(e)).not.toContain(KEY);
        }
      }
    }
  });

  it("an env literal with only Rathin keys still works for rathin", () => {
    expect(supplierFor("rathin", rathinOnly)).toBeInstanceOf(RathinMockAdapter);
  });
});

describe("TravelDeskMockAdapter", () => {
  const port = new TravelDeskMockAdapter(() => new Date("2026-10-27T08:00:00.000Z"));

  it("is deterministic: available except the 7th/14th/21st/28th, labelled mock", async () => {
    for (const [date, status] of [
      ["2026-11-03", "available"],
      ["2026-11-07", "sold_out"],
      ["2026-11-14", "sold_out"],
      ["2026-11-21", "sold_out"],
      ["2026-11-28", "sold_out"],
      ["2026-11-29", "available"],
      ["2026-11-01", "available"],
    ] as const) {
      const r = await port.checkAvailability({ mapping, date, pax });
      expect(r, date).toEqual({
        status,
        spotsLeft: null,
        slots: [],
        nextDates: [],
        checkedAt: "2026-10-27T08:00:00.000Z",
        source: "mock",
        capacityIsReliable: false,
      });
    }
    const again = await port.checkAvailability({ mapping, date: "2026-11-07", pax });
    expect(again.status).toBe("sold_out");
  });

  it("echoes the requested timeslot with the day's status", async () => {
    expect((await port.checkAvailability({ mapping, date: "2026-11-03", pax, timeslot: "16:00" })).slots).toEqual([{ time: "16:00", status: "available" }]);
    expect((await port.checkAvailability({ mapping, date: "2026-11-14", pax, timeslot: "16:00" })).slots).toEqual([{ time: "16:00", status: "sold_out" }]);
  });

  it("on_request mapping → quote_only; invalid mapping → invalid_mapping", async () => {
    const onRequest = { ...mapping, externalRef: { ...mapping.externalRef, bookingKind: "on_request" } };
    expect((await port.checkAvailability({ mapping: onRequest, date: "2026-11-03", pax })).status).toBe("quote_only");
    try {
      await port.checkAvailability({ mapping: { ...mapping, externalRef: {} }, date: "2026-11-03", pax });
      expect.unreachable("should throw");
    } catch (e) {
      expect(isSupplierError(e)).toBe(true);
      if (isSupplierError(e)) expect(e.details).toEqual({ reason: "invalid_mapping" });
    }
  });

  it("createBooking is NOT_IMPLEMENTED; lookup and cancel are not_supported", async () => {
    await expect(port.createBooking(booking)).rejects.toMatchObject({ code: "NOT_IMPLEMENTED" });
    await expect(port.lookupBooking("x")).resolves.toMatchObject({ outcome: "not_supported" });
    await expect(port.cancelBooking("x", "r")).resolves.toMatchObject({ outcome: "not_supported" });
  });

  it("shares the live capabilities", () => {
    expect(port.capabilities()).toBe(TRAVELDESK_CAPABILITIES);
  });
});

describe("TRAVELDESK_CAPABILITIES", () => {
  it("instantConfirmation is false by default — the mock and a live adapter without bookings keep products in inquiry", () => {
    expect(TRAVELDESK_CAPABILITIES.instantConfirmation).toBe(false);
  });

  it("a live adapter reports instantConfirmation only when TRAVELDESK_BOOKINGS_ENABLED is true", () => {
    const env = {
      SUPPLIER_ADAPTER_RATHIN: "mock" as const,
      RATHIN_TIMEOUT_MS: 8000,
      SUPPLIER_ADAPTER_TRAVELDESK: "live" as const,
      TRAVELDESK_ENV: "test" as const,
      TRAVELDESK_API_BASE_URL: "https://testapi.traveldesk.me/public/b2b/v1",
      TRAVELDESK_API_KEY: "capability-key-not-real",
    };
    expect(supplierFor("traveldesk", env).capabilities().instantConfirmation).toBe(false);
    expect(supplierFor("traveldesk", { ...env, TRAVELDESK_BOOKINGS_ENABLED: false }).capabilities().instantConfirmation).toBe(false);
    const on = supplierFor("traveldesk", { ...env, TRAVELDESK_BOOKINGS_ENABLED: true });
    expect(on.capabilities().instantConfirmation).toBe(true);
    // Only that flag changes; every other capability stays as verified.
    expect({ ...on.capabilities(), instantConfirmation: false }).toEqual(TRAVELDESK_CAPABILITIES);
    // Production: allowed only with the agency pinned (same rule as the booking mutations).
    const prodEnv = { ...env, APP_ENV: "production" as const, TRAVELDESK_ENV: "production" as const, TRAVELDESK_API_BASE_URL: "https://api.traveldesk.me/public/b2b/v1", TRAVELDESK_BOOKINGS_ENABLED: true };
    expect(supplierFor("traveldesk", prodEnv).capabilities().instantConfirmation).toBe(false);
    expect(supplierFor("traveldesk", { ...prodEnv, TRAVELDESK_AGENCY_ID: "7001" }).capabilities().instantConfirmation).toBe(true);
    expect(supplierFor("traveldesk", { ...prodEnv, TRAVELDESK_AGENCY_ID: "7001", TRAVELDESK_BOOKINGS_ENABLED: false }).capabilities().instantConfirmation).toBe(false);
    // The mock never confirms.
    expect(supplierFor("traveldesk", { ...env, SUPPLIER_ADAPTER_TRAVELDESK: "mock", TRAVELDESK_BOOKINGS_ENABLED: true }).capabilities().instantConfirmation).toBe(false);
  });
});

describe("supplierFor — TravelDesk live adapter is shared per configuration", () => {
  it("returns the same instance for the same config, a different one for another key", () => {
    const env = {
      SUPPLIER_ADAPTER_RATHIN: "mock" as const,
      RATHIN_TIMEOUT_MS: 8000,
      SUPPLIER_ADAPTER_TRAVELDESK: "live" as const,
      TRAVELDESK_ENV: "test" as const,
      TRAVELDESK_API_BASE_URL: "https://testapi.traveldesk.me/public/b2b/v1",
      TRAVELDESK_API_KEY: "shared-key-not-real",
    };
    const a = supplierFor("traveldesk", env);
    const b = supplierFor("traveldesk", env);
    const c = supplierFor("traveldesk", { ...env, TRAVELDESK_API_KEY: "other-key-not-real" });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});
