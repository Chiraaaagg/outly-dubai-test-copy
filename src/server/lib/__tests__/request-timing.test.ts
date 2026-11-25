import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Request timing (doc 29 §6.6, Batch 1c): `Server-Timing` carries three fixed
 * names with durations and nothing else, on success and error responses of
 * the quote route only (review R6); the `route.timing` line carries the route code, the
 * status and durations; concurrent requests never share a context; and the
 * supplier HTTP client reports each call's duration into the request it ran
 * in. No database: the `db` phase is fed directly here (its Prisma extension
 * is covered in request-timing.db.test.ts).
 */

const emitted = vi.hoisted(() => [] as { name: string; fields: Record<string, unknown> }[]);
vi.mock("../structured-events", async (orig) => {
  const real = await orig<typeof import("../structured-events")>();
  return { ...real, emitEvent: (name: string, fields: Record<string, unknown>) => emitted.push({ name, fields: real.structuredFields(name, fields) ?? {} }) };
});

import { recordPhase, serverTimingHeader, SERVER_TIMING_ROUTES, timingFields, withRequestTiming, TIMING_ROUTES } from "../request-timing";
import { handle, json } from "../http";
import { Errors } from "../errors";
import { traveldeskConfigFrom, type TravelDeskConfig } from "../../suppliers/traveldesk/traveldesk.config";
import { TravelDeskHttp } from "../../suppliers/traveldesk/traveldesk.http";

/** Only `name;dur=number` entries, comma separated: no `desc`, no free text. */
const SERVER_TIMING = /^(?:(?:supplier|db|total);dur=\d+(?:\.\d)?)(?:, (?:supplier|db|total);dur=\d+(?:\.\d)?)*$/;

beforeEach(() => {
  emitted.length = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("request timing context", () => {
  it("records nothing outside a timed request", async () => {
    expect(() => recordPhase("db", 5)).not.toThrow();
    const { timing } = await withRequestTiming(async () => 1);
    expect(timing.db).toEqual({ ms: 0, count: 0 });
  });

  it("sums each phase inside the request and ignores bad values", async () => {
    let t = 100;
    const { result, timing } = await withRequestTiming(
      async () => {
        recordPhase("supplier", 120.25);
        recordPhase("supplier", 30);
        recordPhase("db", 4);
        recordPhase("db", Number.NaN);
        recordPhase("db", -1);
        await Promise.resolve();
        recordPhase("db", 2);
        t = 300;
        return "done";
      },
      () => t,
    );
    expect(result).toBe("done");
    expect(timing).toEqual({ totalMs: 200, supplier: { ms: 150.25, count: 2 }, db: { ms: 6, count: 2 } });
  });

  it("keeps concurrent requests apart", async () => {
    const tick = () => new Promise((r) => setTimeout(r, 1));
    const [a, b] = await Promise.all([
      withRequestTiming(async () => {
        recordPhase("db", 1);
        await tick();
        recordPhase("db", 1);
      }),
      withRequestTiming(async () => {
        await tick();
        recordPhase("supplier", 7);
      }),
    ]);
    expect(a.timing.db.count).toBe(2);
    expect(a.timing.supplier.count).toBe(0);
    expect(b.timing.db.count).toBe(0);
    expect(b.timing.supplier).toEqual({ ms: 7, count: 1 });
  });

  it("formats the header with fixed names and one decimal, leaving out phases with no calls", () => {
    expect(serverTimingHeader({ totalMs: 1234.567, supplier: { ms: 1000.04, count: 1 }, db: { ms: 12.35, count: 3 } })).toBe("supplier;dur=1000, db;dur=12.4, total;dur=1234.6");
    expect(serverTimingHeader({ totalMs: 3, supplier: { ms: 0, count: 0 }, db: { ms: 0, count: 0 } })).toBe("total;dur=3");
    expect(timingFields("quote", 201, { totalMs: 10.6, supplier: { ms: 5.4, count: 1 }, db: { ms: 2.5, count: 2 } })).toEqual({
      route: "quote",
      status: 201,
      totalMs: 11,
      supplierMs: 5,
      supplierCalls: 1,
      dbMs: 3,
      dbQueries: 2,
    });
  });
});

describe("handle(fn, { timing })", () => {
  const ORDER_REF = ["OUT", "10000017"].join("-");
  const req = (path: string) => new NextRequest(`http://localhost${path}`, { headers: { "x-request-id": "req-synthetic-1" } });

  it("adds Server-Timing and one log line of durations to the quote route's response", async () => {
    const POST = handle(
      async () => {
        recordPhase("supplier", 80);
        recordPhase("db", 3);
        return json({ ok: true, reference: ORDER_REF });
      },
      { timing: "quote" },
    );
    const res = await POST(req("/api/quotes"), undefined as never);
    const header = res.headers.get("server-timing") ?? "";
    expect(header).toMatch(SERVER_TIMING);
    expect(header).toMatch(/^supplier;dur=80, db;dur=3, total;dur=/);
    // No identifier of any kind: not the reference, the request id or the path.
    expect(header).not.toMatch(/OUT|req-|\/|desc/);
    const lines = emitted.filter((e) => e.name === "route.timing");
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0].fields).sort()).toEqual(["dbMs", "dbQueries", "route", "status", "supplierCalls", "supplierMs", "totalMs"]);
    expect(lines[0].fields).toMatchObject({ route: "quote", status: 200, supplierMs: 80, supplierCalls: 1, dbMs: 3, dbQueries: 1 });
    expect(JSON.stringify(lines)).not.toMatch(/OUT-|req-synthetic|\/api/);
  });

  it.each(["checkout", "checkout_verify_start", "checkout_verify", "order_status"] as const)(
    "logs %s's durations but sends no Server-Timing header (review R6)",
    async (route) => {
      const GET = handle(
        async () => {
          recordPhase("db", 3);
          throw Errors.notFound("Order");
        },
        { timing: route },
      );
      const res = await GET(req(`/api/orders/${ORDER_REF}/status`), undefined as never);
      expect(res.status).toBe(404);
      expect(res.headers.get("server-timing")).toBeNull();
      const lines = emitted.filter((e) => e.name === "route.timing");
      expect(lines).toHaveLength(1);
      expect(lines[0].fields).toMatchObject({ route, status: 404, dbQueries: 1 });
      expect(JSON.stringify(lines)).not.toMatch(/OUT-|req-synthetic|\/api/);
    },
  );

  it("only quote and the two public read routes send the header (doc 29 §6.6)", () => {
    expect(SERVER_TIMING_ROUTES).toEqual(["quote", "catalog_start_times", "pickup_hotels"]);
  });

  it.each(["catalog_start_times", "pickup_hotels"] as const)("adds Server-Timing with durations only to the %s read route", async (route) => {
    const GET = handle(
      async () => {
        recordPhase("supplier", 40);
        return json({ ok: true });
      },
      { timing: route },
    );
    const res = await GET(req("/api/catalog/start-times"), undefined as never);
    const header = res.headers.get("server-timing") ?? "";
    expect(header).toMatch(SERVER_TIMING);
    expect(header).toMatch(/^supplier;dur=40, total;dur=/);
    expect(header).not.toMatch(/req-synthetic|\/api/);
  });

  it("times error responses too, with their status", async () => {
    const POST = handle(
      async () => {
        throw Errors.rateLimited(30);
      },
      { timing: "quote" },
    );
    const res = await POST(req("/api/quotes"), undefined as never);
    expect(res.status).toBe(429);
    expect(res.headers.get("server-timing")).toMatch(/^total;dur=/);
    expect(emitted.find((e) => e.name === "route.timing")?.fields).toMatchObject({ route: "quote", status: 429 });
  });

  it("leaves untimed routes alone", async () => {
    const GET = handle(async () => json({ ok: true }));
    const res = await GET(req("/api/health"), undefined as never);
    expect(res.headers.get("server-timing")).toBeNull();
    expect(emitted.some((e) => e.name === "route.timing")).toBe(false);
  });

  it("every route code is a short code the structured logger keeps", () => {
    for (const r of TIMING_ROUTES) expect(r).toMatch(/^[a-z_]{1,40}$/);
  });
});

describe("the timed routes", () => {
  it.each([
    ["src/app/api/quotes/route.ts", "quote"],
    ["src/app/api/checkout/handler.ts", "checkout"],
    ["src/app/api/checkout/verify/start/route.ts", "checkout_verify_start"],
    ["src/app/api/checkout/verify/route.ts", "checkout_verify"],
    ["src/app/api/orders/[reference]/status/route.ts", "order_status"],
  ])("%s is timed as %s", async (file, route) => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(file, "utf8")).toContain(`{ timing: "${route}" }`);
  });
});

describe("supplier calls report into the request", () => {
  const config = traveldeskConfigFrom({
    SUPPLIER_ADAPTER_TRAVELDESK: "live",
    TRAVELDESK_ENV: "test",
    TRAVELDESK_API_BASE_URL: "https://testapi.traveldesk.me/public/b2b/v1",
    TRAVELDESK_API_KEY: ["synthetic", "value", "for", "tests"].join("-"),
  }) as TravelDeskConfig;

  it("adds each call's duration, success or failure, to the supplier phase", async () => {
    let clock = 0;
    let answer = 200;
    const fetchImpl = (async () => {
      clock += 250;
      return new Response(answer === 200 ? JSON.stringify({ ok: 1 }) : "", { status: answer, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const http = new TravelDeskHttp(config, { fetch: fetchImpl, now: () => clock });
    const { timing } = await withRequestTiming(async () => {
      await http.getJson("balance", "/balance", "/balance", undefined, z.unknown());
      answer = 503;
      await http.getJson("balance", "/balance", "/balance", undefined, z.unknown()).catch(() => null);
    });
    expect(timing.supplier).toEqual({ ms: 500, count: 2 });
  });
});
