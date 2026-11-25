import { existsSync, readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /api/catalog/pickup-hotels` (doc 29 §7.3 Batch 3): Zod-checked query,
 * rate-limited per IP, a list cached at the edge, refusals never cached, and
 * only ids, names and areas in the body. The service is replaced; nothing
 * reaches a database or TravelDesk. Synthetic hotels only.
 */

const PRODUCT = "0190a000-0000-7000-8000-000000000001";
const state = vi.hoisted(() => ({ result: null as unknown, calls: [] as string[][], limited: 0 }));

vi.mock("@/server/lib/logger", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/server/lib/guards", () => ({
  publicRateLimit: vi.fn(async () => {
    state.limited++;
  }),
}));
vi.mock("@/server/services/pickup-hotels.service", () => ({
  pickupHotelsService: {
    list: vi.fn(async (productId: string, variantId: string) => {
      state.calls.push([productId, variantId]);
      return state.result;
    }),
  },
}));

const { GET } = await import("../route");
const call = (qs: string) => GET(new NextRequest(`http://localhost/api/catalog/pickup-hotels?${qs}`), { params: Promise.resolve({}) });

beforeEach(() => {
  state.calls = [];
  state.limited = 0;
  state.result = { ok: true, hotels: [{ id: "42", name: "Example Marina Hotel", area: "Dubai Marina" }], asOf: "2026-11-23T08:00:00.000Z" };
});

describe("GET /api/catalog/pickup-hotels", () => {
  it("answers the list with an edge cache, after the rate limit", async () => {
    const res = await call(`productId=${PRODUCT}&variantId=shared`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(state.result);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=120, stale-while-revalidate=60");
    expect(state.calls).toEqual([[PRODUCT, "shared"]]);
    expect(state.limited).toBe(1);
  });

  it("a refusal is 200 and never cached", async () => {
    for (const reason of ["not_offered", "unavailable"]) {
      state.result = { ok: false, reason };
      const res = await call(`productId=${PRODUCT}&variantId=shared`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false, reason });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it.each([
    ["no params", ""],
    ["a product that is not a uuid", "productId=desert-safari&variantId=shared"],
    ["a variant with other characters", `productId=${PRODUCT}&variantId=Shared%20Tour`],
    ["typed text in the query", `productId=${PRODUCT}&variantId=shared&q=marina`],
    ["a repeated param", `productId=${PRODUCT}&productId=${PRODUCT}&variantId=shared`],
  ])("%s is a validation error (422) with no lookup", async (_name, qs) => {
    const res = await call(qs);
    expect(res.status).toBe(422);
    expect(state.calls).toEqual([]);
  });

  it("is timed as pickup_hotels (Server-Timing, doc 29 §6.6)", () => {
    expect(readFileSync("src/app/api/catalog/pickup-hotels/route.ts", "utf8")).toContain('{ timing: "pickup_hotels" }');
  });

  it("draws from the one browse read class it shares with /api/catalog/start-times (doc 29 §6.3)", () => {
    const token = /import \{[^}]*\btakeBrowseReadToken\b[^}]*\} from "\.\/supplier-booking\.service"/;
    expect(readFileSync("src/server/services/pickup-hotels.service.ts", "utf8")).toMatch(token);
    expect(readFileSync("src/server/services/supplier-quote.service.ts", "utf8")).toMatch(token);
    expect(existsSync("src/server/suppliers/browse-budget.ts")).toBe(false);
    expect(existsSync("src/server/services/supplier-browse-budget.ts")).toBe(false);
    expect(readFileSync("src/app/api/catalog/start-times/route.ts", "utf8")).toContain('{ timing: "catalog_start_times" }');
  });
});
