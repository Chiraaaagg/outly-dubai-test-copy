import { describe, expect, it, vi } from "vitest";
import { pickupHotels } from "../../suppliers/__tests__/fixtures/traveldesk-terms";

/**
 * The storefront's pickup hotel list (doc 29 §7.3 Batch 3): only for an
 * instant pickup variant, from the browse share of the read budget, cached
 * per offer and environment, ids, names and areas only. The database and env
 * are replaced and the dependencies injected: no connection, no socket.
 * Synthetic hotels only.
 */

vi.mock("../../lib/db", () => ({ prisma: {}, TX_OPTIONS: {} }));
vi.mock("../../lib/env", () => ({ env: () => ({}) }));

const { createPickupHotelsService, publicHotels, PICKUP_HOTEL_FAILURE_TTL_MS, PICKUP_HOTEL_LIST_TTL_MS } = await import("../pickup-hotels.service");
type Deps = Parameters<typeof createPickupHotelsService>[0];

const NOW = new Date("2026-11-23T08:00:00Z");
const PRODUCT = "0190a000-0000-7000-8000-000000000001";
const OTHER = "0190a000-0000-7000-8000-000000000002";

function harness(opts: { target?: Deps["target"]; token?: () => boolean; fail?: () => boolean; configured?: boolean } = {}) {
  const calls: string[] = [];
  const tokens: string[] = [];
  const clock = { now: NOW };
  let release: (() => void) | null = null;
  const gate = { hold: false };
  const svc = createPickupHotelsService({
    target: opts.target ?? (async (productId) => (productId === PRODUCT || productId === OTHER ? { supplierCode: "traveldesk", environment: "test", offerId: 501 } : null)),
    source: () =>
      opts.configured === false
        ? null
        : {
            accountId: "acct-test",
            source: {
              async listPickupHotels(offerId: number) {
                calls.push(`hotels:${offerId}`);
                if (gate.hold) await new Promise<void>((r) => (release = r));
                if (opts.fail?.()) throw new Error("timeout");
                return pickupHotels();
              },
            },
          },
    takeBrowseReadToken: async (code, environment, account) => {
      tokens.push(`${code}:${environment}:${account}`);
      return opts.token ? opts.token() : true;
    },
    now: () => clock.now,
  });
  return { svc, calls, tokens, clock, gate, release: () => release?.() };
}

describe("pickupHotelsService.list", () => {
  it("answers with ids, names and areas only, sorted by name, from one browse-budget read", async () => {
    const h = harness();
    const r = await h.svc.list(PRODUCT, "shared");
    expect(r).toEqual({
      ok: true,
      asOf: NOW.toISOString(),
      hotels: [
        { id: "43", name: "Example Creek Hotel", area: "Deira" },
        { id: "42", name: "Example Marina Hotel", area: "Dubai Marina" },
      ],
    });
    expect(h.calls).toEqual(["hotels:501"]);
    expect(h.tokens).toEqual(["traveldesk:test:acct-test"]);
  });

  it("a variant that is not sold instantly with pickup is not_offered, with no supplier call and no token", async () => {
    const h = harness({ target: async () => null });
    expect(await h.svc.list(PRODUCT, "shared")).toEqual({ ok: false, reason: "not_offered" });
    expect(h.calls).toEqual([]);
    expect(h.tokens).toEqual([]);
  });

  it("keeps one list per offer and environment, whichever product asks, for the TTL", async () => {
    const h = harness();
    await h.svc.list(PRODUCT, "shared");
    await h.svc.list(OTHER, "private");
    expect(h.calls).toEqual(["hotels:501"]);
    h.clock.now = new Date(NOW.getTime() + PICKUP_HOTEL_LIST_TTL_MS);
    await h.svc.list(PRODUCT, "shared");
    expect(h.calls).toEqual(["hotels:501", "hotels:501"]);
  });

  it("concurrent misses share one read", async () => {
    const h = harness();
    h.gate.hold = true;
    const a = h.svc.list(PRODUCT, "shared");
    const b = h.svc.list(OTHER, "shared");
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    h.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).toEqual(rb);
    expect(h.calls).toEqual(["hotels:501"]);
  });

  it("no browse token: unavailable, nothing read, and not remembered", async () => {
    let allow = false;
    const h = harness({ token: () => allow });
    expect(await h.svc.list(PRODUCT, "shared")).toEqual({ ok: false, reason: "unavailable" });
    expect(h.calls).toEqual([]);
    allow = true;
    expect(await h.svc.list(PRODUCT, "shared")).toMatchObject({ ok: true });
  });

  it("a failed read is unavailable and kept briefly, so a failing supplier is not asked on every request", async () => {
    let failing = true;
    const h = harness({ fail: () => failing });
    expect(await h.svc.list(PRODUCT, "shared")).toEqual({ ok: false, reason: "unavailable" });
    expect(await h.svc.list(PRODUCT, "shared")).toEqual({ ok: false, reason: "unavailable" });
    expect(h.calls).toEqual(["hotels:501"]);
    failing = false;
    h.clock.now = new Date(NOW.getTime() + PICKUP_HOTEL_FAILURE_TTL_MS);
    expect(await h.svc.list(PRODUCT, "shared")).toMatchObject({ ok: true });
  });

  it("TravelDesk not configured for the environment: unavailable, no token taken", async () => {
    const h = harness({ configured: false });
    expect(await h.svc.list(PRODUCT, "shared")).toEqual({ ok: false, reason: "unavailable" });
    expect(h.tokens).toEqual([]);
  });
});

describe("publicHotels", () => {
  it("drops unnamed and duplicate hotels and bad ids, trims names, takes the city when there is no region", () => {
    expect(
      publicHotels([
        { hotelId: 7, name: "  Example   Palm  Resort ", regionName: null, cityName: "Dubai" },
        { hotelId: 7, name: "Example Palm Resort again", regionName: null, cityName: "Dubai" },
        { hotelId: 8, name: null, regionName: "Deira", cityName: "Dubai" },
        { hotelId: 9, name: "   ", regionName: "Deira", cityName: "Dubai" },
        { hotelId: 0, name: "Zero", regionName: null, cityName: null },
        { hotelId: 10, name: "Example Bay Hotel", regionName: " ", cityName: null },
      ]),
    ).toEqual([
      { id: "10", name: "Example Bay Hotel", area: null },
      { id: "7", name: "Example Palm Resort", area: "Dubai" },
    ]);
  });
});
