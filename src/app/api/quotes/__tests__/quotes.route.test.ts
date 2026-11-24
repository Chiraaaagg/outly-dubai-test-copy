import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Errors } from "@/server/lib/errors";
import type { QuoteResult, QuoteSnapshot } from "@/server/quotes/contracts";

/**
 * CR-B2-1: `POST /api/quotes` returns the public projection only. The quote
 * service is replaced by one that returns a full internal snapshot (synthetic
 * net, margin, FX, mapping, fingerprint, owner); every response body — quote,
 * refusal and error, for an existing and a new guest — is walked and must
 * hold no internal key or value.
 */

const GUEST_ID = "0190a000-0000-7000-8000-0000000000e1";
const NET = 31_337n; // synthetic supplier net; must never appear in a body

const state = vi.hoisted(() => ({
  result: null as unknown,
  error: null as unknown,
  existingGuest: true,
}));

vi.mock("@/server/lib/logger", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/server/lib/rate-limit", () => ({ enforceRateLimit: vi.fn(async () => undefined) }));
vi.mock("@/server/services/customer-auth.service", () => ({ customerAuthService: { resolveRequest: vi.fn(async () => null) } }));
vi.mock("@/server/services/guest-session.service", () => ({
  guestSessionService: {
    resolveRequest: vi.fn(async () => (state.existingGuest ? { id: GUEST_ID } : null)),
    create: vi.fn(async () => ({ id: GUEST_ID, token: "synthetic-guest-token", expiresAt: new Date("2026-11-02T08:00:00Z") })),
    owner: (h: { id: string }) => ({ kind: "guest", guestSessionId: h.id }),
  },
}));
vi.mock("@/server/services/quote.service", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/services/quote.service")>();
  return {
    ...real,
    quoteService: {
      create: vi.fn(async () => {
        if (state.error) throw state.error;
        return state.result;
      }),
    },
  };
});

const { POST } = await import("../route");
const { enforceRateLimit } = await import("@/server/lib/rate-limit");
const { guestSessionService } = await import("@/server/services/guest-session.service");
const { quoteService } = await import("@/server/services/quote.service");
const { log } = await import("@/server/lib/logger");

function internalSnapshot(): QuoteSnapshot {
  return {
    ok: true,
    quoteId: "0190a000-0000-7000-8000-0000000000f1",
    fingerprint: "f".repeat(64),
    owner: { kind: "guest", guestSessionId: GUEST_ID },
    currency: "INR",
    couponCode: "FIRSTTRIP",
    totalMinor: 1_260_000n,
    expiresAt: "2026-11-01T08:10:00.000Z",
    lines: [
      {
        index: 0,
        productId: "0190a000-0000-7000-8000-000000000001",
        productVersion: 4,
        variantId: "shared",
        mappingId: "0190a000-0000-7000-8000-0000000000aa",
        approvedOfferHash: "a".repeat(64),
        supplierEnvironment: "test",
        readinessRulesVersion: 2,
        serviceDate: "2026-11-02",
        slotRef: "17@09:00",
        units: { adult: 2, child: 1 },
        unitDefinitions: [],
        addonIds: [],
        pickup: { hotelRef: "hotel-42" },
        chargedMinor: 1_400_000n,
        discountAllocMinor: 140_000n,
        taxAllocMinor: 0n,
        supplierNetAedMinor: NET,
        supplierCheckedAt: "2026-11-01T08:00:00.000Z",
        margin: { policyVersion: 3, floorBps: 1500, grossMarginBps: 4100, costLines: [{ name: "gateway_fee", minor: 25_000n }], fx: { version: 2, inrPerAed: "23.75", source: "synthetic" } },
        freeCancellationUntilUtc: null,
        nonRefundableAfterConfirm: true,
      },
    ],
  };
}

const FORBIDDEN_KEY = /supplier|margin|cost|fx|inrPerAed|mapping|offerHash|fingerprint|owner|guestSession|customerId|policyVersion|floorBps|unitDefinitions|readiness|environment|productVersion|checkedAt|pickup|couponCode/i;
const FORBIDDEN_VALUE = [NET.toString(), "f".repeat(64), "a".repeat(64), GUEST_ID, "0190a000-0000-7000-8000-0000000000aa", "23.75", "hotel-42", "synthetic-guest-token"];

function forbiddenIn(v: unknown, path = "$"): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => forbiddenIn(x, `${path}[${i}]`));
  if (v && typeof v === "object") {
    return Object.entries(v).flatMap(([k, x]) => [...(FORBIDDEN_KEY.test(k) && !path.endsWith(".units") ? [`${path}.${k}`] : []), ...forbiddenIn(x, `${path}.${k}`)]);
  }
  return typeof v === "string" && FORBIDDEN_VALUE.some((f) => v.includes(f)) ? [`${path}=${v}`] : [];
}

function req() {
  return new NextRequest("http://localhost:3000/api/quotes", {
    method: "POST",
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: JSON.stringify({
      lines: [{ productId: "0190a000-0000-7000-8000-000000000001", variantId: "shared", serviceDate: "2026-11-02", slotRef: "17@09:00", units: { adult: 2, child: 1 }, addonIds: [], pickup: null }],
      currency: "INR",
      couponCode: null,
    }),
  });
}

async function call() {
  const res = await POST(req(), undefined as never);
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as unknown, text };
}

const cases: Array<[string, () => void, number]> = [
  ["a quote", () => void (state.result = internalSnapshot()), 201],
  ["a refusal with a private reason", () => void (state.result = { ok: false, lines: [{ index: 0, reason: "margin_below_floor" }] } satisfies QuoteResult), 200],
  ["a conflict error", () => void (state.error = Errors.conflict("This quote conflicts with another one — start again from your trip", { reason: "fingerprint_conflict" })), 409],
  ["an unexpected error", () => void (state.error = Object.assign(new Error(`boom ${NET}`), { snapshot: internalSnapshot() })), 500],
];

describe("POST /api/quotes: public projection only (CR-B2-1)", () => {
  beforeEach(() => {
    state.result = null;
    state.error = null;
    state.existingGuest = true;
  });

  for (const existingGuest of [true, false]) {
    it.each(cases)(`%s (${existingGuest ? "existing" : "new"} guest) carries no internal key or value`, async (_name, arrange, status) => {
      state.existingGuest = existingGuest;
      arrange();
      const r = await call();
      expect(r.status).toBe(status);
      expect(forbiddenIn(r.body)).toEqual([]);
    });
  }

  it("a quote body is exactly the allowlist", async () => {
    state.result = internalSnapshot();
    const { body } = await call();
    expect(body).toEqual({
      ok: true,
      quoteId: "0190a000-0000-7000-8000-0000000000f1",
      expiresAt: "2026-11-01T08:10:00.000Z",
      currency: "INR",
      totalMinor: "1260000",
      lines: [
        {
          index: 0,
          productId: "0190a000-0000-7000-8000-000000000001",
          variantId: "shared",
          serviceDate: "2026-11-02",
          slotRef: "17@09:00",
          units: { adult: 2, child: 1 },
          addonIds: [],
          chargedMinor: "1400000",
          discountAllocMinor: "140000",
          taxAllocMinor: "0",
          freeCancellationUntilUtc: null,
          freeCancellationCopy: "This booking is non-refundable once confirmed.",
          nonRefundableAfterConfirm: true,
          ticketValidUntil: null,
          ticketValidityCopy: null,
          openDatedTicket: false,
          externalConfirmationCopy: null,
        },
      ],
    });
  });

  it("a refusal is only index and reason, with private reasons folded into requires_inquiry", async () => {
    state.result = { ok: false, lines: [{ index: 0, reason: "policy_exceeds_supplier" }, { index: 1, reason: "sold_out" }] } satisfies QuoteResult;
    expect((await call()).body).toEqual({ ok: false, lines: [{ index: 0, reason: "requires_inquiry" }, { index: 1, reason: "sold_out" }] });
  });
});

describe("POST /api/quotes: global limit (CR-B2-3)", () => {
  beforeEach(() => {
    state.result = internalSnapshot();
    state.error = null;
    state.existingGuest = false;
    vi.mocked(enforceRateLimit).mockClear();
    vi.mocked(guestSessionService.create).mockClear();
    vi.mocked(quoteService.create).mockClear();
  });

  it("runs after both per-IP limits and before the owner limit, under one key for every caller", async () => {
    expect((await call()).status).toBe(201);
    const calls = vi.mocked(enforceRateLimit).mock.calls.map(([o]) => o);
    const keys = calls.map((o) => o.key);
    expect(keys).toHaveLength(4);
    expect(keys[0]).toMatch(/^quote:ip:/);
    expect(keys[1]).toMatch(/^quote:ipm:/);
    expect(keys[2]).toBe("quote:global");
    expect(keys[3]).toMatch(/^quote:owner:/);
    expect(calls[2]).toMatchObject({ key: "quote:global", limit: 40, windowSeconds: 60 });
    for (const o of calls) expect(o.onStoreFailure ?? "closed").toBe("closed");
  });

  it("the per-IP minute limit sits well below the global one, so two addresses cannot fill it (N4)", async () => {
    await call();
    const minute = vi.mocked(enforceRateLimit).mock.calls.map(([o]) => o).find((o) => o.key.startsWith("quote:ipm:"))!;
    expect(minute.windowSeconds).toBe(60);
    expect(minute.limit * 2).toBeLessThan(40);
  });

  it("a refused global limit is logged as saturated (N4 alert)", async () => {
    vi.mocked(log.warn).mockClear();
    vi.mocked(enforceRateLimit).mockImplementation(async (o) => {
      if (o.key === "quote:global") throw Errors.rateLimited(30);
      return undefined as never;
    });
    try {
      expect((await call()).status).toBe(429);
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith("quote.global_limit_saturated", expect.objectContaining({ limit: 40 }));
    } finally {
      vi.mocked(enforceRateLimit).mockImplementation(async () => undefined as never);
    }
  });

  it.each([
    ["exhausted", () => Errors.rateLimited(30), 429],
    ["its store down (fails closed)", () => Errors.unavailable(30), 503],
  ] as const)("global limit %s: refused before any session is opened, any quote written or any supplier called", async (_n, error, status) => {
    vi.mocked(enforceRateLimit).mockImplementation(async (o) => {
      if (o.key === "quote:global") throw error();
      return undefined as never;
    });
    try {
      expect((await call()).status).toBe(status);
      expect(guestSessionService.create).not.toHaveBeenCalled();
      expect(quoteService.create).not.toHaveBeenCalled();
    } finally {
      vi.mocked(enforceRateLimit).mockImplementation(async () => undefined as never);
    }
  });
});
