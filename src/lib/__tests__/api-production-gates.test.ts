import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockUnavailableError, currentScenario, isMockUnavailable, mocksAllowed } from "../api/client";
import {
  cancelBooking,
  fetchBooking,
  quoteCancellation,
  resendVoucher,
  submitInquiry,
  submitOrder,
  type CreateOrderInput,
  type SubmitInquiryInput,
} from "../api";
import type { Booking } from "../types";

/**
 * Production gates on the browser API client (doc 22 B0 gates 5c and 5d):
 *  - `?mock=` scenarios are ignored in a production build except on
 *    /design-system (PRD-14);
 *  - the mocked fulfilment calls, which fabricate success, refuse in a
 *    production build with a typed `MockUnavailableError`.
 *
 * `process.env.NODE_ENV` is what Next inlines into the client bundle, so the
 * tests stub it per case.
 */

function at(url: string) {
  const u = new URL(url, "https://outlyy.test");
  vi.stubGlobal("window", { location: { pathname: u.pathname, search: u.search } });
}

const order: CreateOrderInput = {
  items: [],
  traveller: { fullName: "Test Traveller", email: "t@example.test", phone: "500000000", countryCode: "+971" } as CreateOrderInput["traveller"],
  paymentMethod: "upi",
  rail: "self_serve",
  currency: "AED",
  totalINR: 1000,
  totalAED: 43,
};

const inquiry: SubmitInquiryInput = {
  items: [],
  leadName: "Test Lead",
  leadPhone: "500000000",
  countryCode: "+971",
  datesFlexible: true,
  currency: "AED",
  source: "web",
  whatsappConsent: false,
} as unknown as SubmitInquiryInput;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("currentScenario (PRD-14)", () => {
  it("honours ?mock= outside production builds", () => {
    vi.stubEnv("NODE_ENV", "development");
    at("/inquiry?mock=error");
    expect(mocksAllowed()).toBe(true);
    expect(currentScenario()).toBe("error");
  });

  it("returns ok in a production build, whatever ?mock= says", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(mocksAllowed()).toBe(false);
    for (const url of ["/inquiry?mock=error", "/checkout?mock=supplier_pending", "/?mock=offline", "/design-systemx?mock=error"]) {
      at(url);
      expect(currentScenario()).toBe("ok");
    }
  });

  it("still honours ?mock= on /design-system in a production build", () => {
    vi.stubEnv("NODE_ENV", "production");
    at("/design-system?mock=slow");
    expect(currentScenario()).toBe("slow");
    at("/design-system/states?mock=error");
    expect(currentScenario()).toBe("error");
  });

  it("returns ok on the server and for unknown values", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(currentScenario()).toBe("ok"); // no window
    at("/inquiry?mock=not-a-scenario");
    expect(currentScenario()).toBe("ok");
  });

  it("sends a real inquiry in production even with ?mock=error on the link", async () => {
    vi.stubEnv("NODE_ENV", "production");
    at("/inquiry?mock=error");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ reference: "INQ-TEST01", slaDueAt: "2026-11-01T10:00:00.000Z", agent: {}, outOfHours: false }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await submitInquiry(inquiry);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("/api/inquiries");
    expect(result.reference).toBe("INQ-TEST01");
  });
});

describe("mocked fulfilment in production builds (gate 5d)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    at("/checkout");
  });

  it("submitOrder refuses with a typed MockUnavailableError instead of fabricating a confirmation", async () => {
    const e = await submitOrder(order).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(MockUnavailableError);
    expect(isMockUnavailable(e)).toBe(true);
    expect((e as MockUnavailableError).serverCode).toBe("UNAVAILABLE");
    expect((e as MockUnavailableError).retryable).toBe(false);
  });

  it("submitOrder refuses even when ?mock= asks for a confirmed or pending order", async () => {
    at("/checkout?mock=supplier_pending");
    await expect(submitOrder(order)).rejects.toBeInstanceOf(MockUnavailableError);
  });

  it("booking lookup, cancellation quote, cancellation and voucher resend refuse too", async () => {
    const booking = { reference: "OUT-TEST01", total: { inr: 1000, aed: 43 }, items: [] } as unknown as Booking;
    await expect(fetchBooking("OUT-TEST01")).rejects.toBeInstanceOf(MockUnavailableError);
    await expect(quoteCancellation(booking)).rejects.toBeInstanceOf(MockUnavailableError);
    await expect(cancelBooking("OUT-TEST01")).rejects.toBeInstanceOf(MockUnavailableError);
    await expect(resendVoucher("OUT-TEST01", "whatsapp")).rejects.toBeInstanceOf(MockUnavailableError);
  });
});

describe("mocked fulfilment outside production builds (demo behaviour kept)", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.useFakeTimers();
  });

  it("submitOrder still resolves a demo order", async () => {
    at("/checkout");
    const p = submitOrder(order);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toMatchObject({ status: "confirmed", voucherEtaMinutes: 1 });
  });

  it("submitOrder still honours ?mock=supplier_pending", async () => {
    at("/checkout?mock=supplier_pending");
    const p = submitOrder(order);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toMatchObject({ status: "supplier_pending" });
  });

  it("voucher resend still resolves", async () => {
    at("/booking/confirmation");
    const p = resendVoucher("OUT-TEST01", "email");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toEqual({ ok: true, channel: "email" });
  });
});
