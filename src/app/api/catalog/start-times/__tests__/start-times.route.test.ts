import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, dubaiToday } from "@/lib/utils";

/**
 * `GET /api/catalog/start-times` (doc 29 Batch 2, review B2-R13): both rate
 * limits run before anything else, the query is strict, a date more than 366
 * days ahead keeps the page's stored times without a lookup, and the answer
 * carries a short shared cache. The service is replaced; nothing reaches a
 * database or TravelDesk.
 */

const PRODUCT = "0190a000-0000-7000-8000-000000000001";
const state = vi.hoisted(() => ({
  answer: null as unknown,
  calls: [] as unknown[],
  ipLimits: [] as { scope: string; limit: number; windowSeconds: number }[],
  globalLimits: [] as { key: string; limit: number; windowSeconds: number }[],
  refuseIp: false,
}));

vi.mock("@/server/lib/logger", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/server/lib/guards", () => ({
  publicRateLimit: vi.fn(async (_req: unknown, scope: string, opts: { limit: number; windowSeconds: number }) => {
    state.ipLimits.push({ scope, ...opts });
    if (state.refuseIp) {
      const { Errors } = await import("@/server/lib/errors");
      throw Errors.rateLimited(30);
    }
  }),
}));
vi.mock("@/server/lib/rate-limit", () => ({
  enforceMemoryRateLimit: vi.fn((opts: { key: string; limit: number; windowSeconds: number }) => {
    state.globalLimits.push(opts);
    return { allowed: true, remaining: 1, retryAfterSeconds: 0 };
  }),
}));
vi.mock("@/server/services/start-times.service", () => ({
  startTimesService: {
    startTimes: vi.fn(async (input: unknown) => {
      state.calls.push(input);
      return state.answer;
    }),
  },
}));

const { GET } = await import("../route");
const call = (qs: string) => GET(new NextRequest(`http://localhost/api/catalog/start-times?${qs}`), { params: Promise.resolve({}) });
const DATE = addDays(dubaiToday(), 3);

beforeEach(() => {
  state.calls = [];
  state.ipLimits = [];
  state.globalLimits = [];
  state.refuseIp = false;
  state.answer = { source: "supplier", checkedAt: "2026-11-23T08:00:00.000Z", stale: false, times: [{ time: "10:00", status: "available" }] };
});

describe("GET /api/catalog/start-times", () => {
  it("answers the times with a short shared cache, after the per-IP and per-instance limits", async () => {
    const res = await call(`productId=${PRODUCT.toUpperCase()}&variantId=shared&date=${DATE}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(state.answer);
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=30, stale-while-revalidate=30");
    expect(state.ipLimits).toEqual([{ scope: "start-times", limit: 30, windowSeconds: 60 }]);
    expect(state.globalLimits).toEqual([{ key: "pub:start-times:global", limit: 600, windowSeconds: 60 }]);
    // The product id is lower-cased for the cache key.
    expect(state.calls).toEqual([{ productId: PRODUCT, variantId: "shared", serviceDate: DATE }]);
  });

  it("a refused rate limit stops the request before any lookup", async () => {
    state.refuseIp = true;
    const res = await call(`productId=${PRODUCT}&variantId=shared&date=${DATE}`);
    expect(res.status).toBe(429);
    expect(state.calls).toEqual([]);
  });

  it("a date more than 366 days ahead keeps the stored times, with no lookup", async () => {
    const res = await call(`productId=${PRODUCT}&variantId=shared&date=${addDays(dubaiToday(), 367)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ source: "stored", reason: "unavailable" });
    expect(state.calls).toEqual([]);
    // 366 days ahead is still asked.
    await call(`productId=${PRODUCT}&variantId=shared&date=${addDays(dubaiToday(), 366)}`);
    expect(state.calls).toHaveLength(1);
  });

  it.each([
    ["no params", ""],
    ["a product that is not a uuid", `productId=desert-safari&variantId=shared&date=${DATE}`],
    ["a variant with other characters", `productId=${PRODUCT}&variantId=Shared%20Tour&date=${DATE}`],
    ["a date that does not exist", `productId=${PRODUCT}&variantId=shared&date=2027-02-30`],
    ["an unknown parameter", `productId=${PRODUCT}&variantId=shared&date=${DATE}&name=zz`],
  ])("%s is a validation error with no lookup", async (_name, qs) => {
    const res = await call(qs);
    expect(res.status).toBe(422);
    expect(state.calls).toEqual([]);
  });

  it("is timed as catalog_start_times (Server-Timing, doc 29 §6.6)", () => {
    expect(readFileSync("src/app/api/catalog/start-times/route.ts", "utf8")).toContain('{ timing: "catalog_start_times" }');
  });
});
