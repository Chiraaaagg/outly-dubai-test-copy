import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PRD-16: the public collector never accepts an event only the server may
 * record (`SERVER_ONLY_EVENT_NAMES`), even though the taxonomy lists it.
 * The analytics service and the limiter are replaced; nothing is written.
 */

const state = vi.hoisted(() => ({ production: false, collected: [] as { event: string }[] }));

vi.mock("@/server/lib/logger", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/server/lib/rate-limit", () => ({ enforceRateLimit: vi.fn(async () => undefined), enforceMemoryRateLimit: vi.fn(() => undefined) }));
vi.mock("@/server/services/analytics.service", () => ({
  analyticsService: {
    collect: vi.fn(async (events: { event: string }[]) => {
      state.collected.push(...events);
      return { accepted: events.length, duplicates: 0 };
    }),
  },
}));
vi.mock("@/server/lib/env", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/lib/env")>();
  return { ...real, env: () => ({ ...real.env(), isProduction: state.production }) };
});

const { POST } = await import("../route");
const { SERVER_ONLY_EVENT_NAMES } = await import("@/lib/event-sources");
const { log } = await import("@/server/lib/logger");

function post(body: unknown) {
  const req = new NextRequest("http://localhost:3000/api/events", {
    method: "POST",
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req, undefined as never);
}

const ev = (event: string, n = 1) => ({ event, event_id: `evt-${event}-${n}`, value: 1 });

describe("POST /api/events: server-only names (PRD-16)", () => {
  beforeEach(() => {
    state.production = false;
    state.collected = [];
    vi.mocked(log.warn).mockClear();
  });

  it.each([...SERVER_ONLY_EVENT_NAMES])("development: a client %s is a 422 and nothing is collected", async (name) => {
    const res = await post(ev(name));
    expect(res.status).toBe(422);
    expect(state.collected).toEqual([]);
  });

  it("production: the server-only events in a batch are dropped and counted, the rest are kept", async () => {
    state.production = true;
    // A production origin list keeps only an explicitly configured site.
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
    const res = await post([ev("page_view"), ev("booking_confirmed"), ev("payment_initiated"), ev("inquiry_won")]).finally(() => vi.unstubAllEnvs());
    expect(res.status).toBe(204);
    expect(res.headers.get("x-events-accepted")).toBe("2");
    expect(res.headers.get("x-events-rejected")).toBe("2");
    expect(state.collected.map((e) => e.event)).toEqual(["page_view", "payment_initiated"]);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith("analytics.server_only_event_from_client", { names: ["booking_confirmed", "inquiry_won"] });
  });

  it("an ordinary client event is still accepted", async () => {
    const res = await post(ev("checkout_started"));
    expect(res.status).toBe(204);
    expect(state.collected.map((e) => e.event)).toEqual(["checkout_started"]);
  });

  it("covers the payment, supplier, ticket and conversion names PRD-16 makes server-only", () => {
    for (const n of ["payment_authorized", "payment_captured", "supplier_confirmed", "ticket_ready", "order_partially_fulfilled", "booking_confirmed"]) {
      expect(SERVER_ONLY_EVENT_NAMES.has(n)).toBe(true);
    }
    expect(SERVER_ONLY_EVENT_NAMES.has("payment_initiated")).toBe(false);
    expect(SERVER_ONLY_EVENT_NAMES.has("inquiry_submitted")).toBe(false);
  });
});
