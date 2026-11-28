import { describe, expect, it } from "vitest";
import { TravelDeskReadClient } from "../traveldesk/traveldesk.client";
import { traveldeskConfigFrom, type TravelDeskConfig } from "../traveldesk/traveldesk.config";

const config = traveldeskConfigFrom({
  SUPPLIER_ADAPTER_TRAVELDESK: "live",
  TRAVELDESK_ENV: "test",
  TRAVELDESK_API_BASE_URL: "https://testapi.traveldesk.me/public/b2b/v1",
  TRAVELDESK_API_KEY: "test-key-not-real",
}) as TravelDeskConfig;

function client() {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { c: new TravelDeskReadClient(config, { fetch: fetchImpl }), calls };
}

describe("TravelDeskReadClient — request guards (nothing is sent when they fail)", () => {
  it("rejects impossible or malformed dates", async () => {
    const { c, calls } = client();
    await expect(c.getAvailability(1, "2026-02-30", "2026-02-30", { isExternal: false })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(c.getAvailability(1, "2026-10-15T00:00:00", "2026-10-15", { isExternal: false })).rejects.toThrow(/YYYY-MM-DD/);
    expect(calls).toHaveLength(0);
  });

  it("enforces the 7-day window for external offers and 31 days for internal ones", async () => {
    const { c, calls } = client();
    await expect(c.getAvailability(1, "2026-11-01", "2026-11-08", { isExternal: true })).rejects.toThrow(/at most 7 days/);
    await expect(c.getAvailability(1, "2026-11-01", "2026-12-02", { isExternal: false })).rejects.toThrow(/at most 31 days/);
    await expect(c.getAvailability(1, "2026-11-02", "2026-11-01", { isExternal: false })).rejects.toThrow(/before From/);
    expect(calls).toHaveLength(0);
    await c.getAvailability(1, "2026-11-01", "2026-11-07", { isExternal: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("From=2026-11-01&To=2026-11-07&CurrencyCode=AED");
  });

  it("rejects ids outside int32", async () => {
    const { c, calls } = client();
    await expect(c.getTour(0)).rejects.toThrow(/positive int32/);
    await expect(c.getTicketStock(2 ** 31)).rejects.toThrow(/positive int32/);
    expect(calls).toHaveLength(0);
  });

  it("always sends CurrencyCode=AED where the endpoint accepts it", async () => {
    const { c, calls } = client();
    await c.listTours();
    expect(calls[0]).toContain("/public/b2b/v1/tours?CountryId=50&CurrencyCode=AED");
  });
});
