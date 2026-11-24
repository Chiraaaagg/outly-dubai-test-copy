import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OrderRequestError,
  exchangeTicketToken,
  fetchOrderStatus,
  requestCancellation,
  startRecovery,
  verifyRecovery,
} from "../order-status";

/**
 * Browser fetchers for the B5 order routes, against a stubbed `fetch`
 * (no network). They map the uniform 404 to "not visible", never to a
 * message about whether a reference exists. Synthetic values only.
 */

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

function reply(status: number, body: unknown) {
  return vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
}

const STATUS = {
  reference: "OUT-123455",
  state: "booking_processing",
  tone: "progress",
  headline: "Payment received. We are confirming with the operator.",
  nextStep: "Nothing to do; this page updates by itself.",
  rail: "self_serve",
  currency: "AED",
  totalMinor: "56000",
  placedAt: "2026-11-02T10:00:00.000Z",
  updatedAt: "2026-11-02T10:01:00.000Z",
  steps: {
    payment: { status: "done", label: "Payment received", at: "2026-11-02T10:00:30.000Z" },
    booking: { status: "in_progress", label: "Confirming", at: null },
    tickets: { status: "not_started", label: "After confirmation", at: null },
    refund: null,
  },
  deadlines: { refundUntilUtc: null, remedyAtUtc: "2026-11-02T12:00:00.000Z", remedyKind: "refund" },
  items: [],
  pollAfterMs: 5000,
};

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchOrderStatus", () => {
  it("returns the projection for a visible order, same-origin and no-store", async () => {
    vi.stubGlobal("fetch", reply(200, STATUS));
    await expect(fetchOrderStatus(" out-123455 ")).resolves.toMatchObject({ reference: "OUT-123455", state: "booking_processing" });
    expect(calls[0].url).toBe("/api/orders/OUT-123455/status");
    expect(calls[0].init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
  });

  it("maps the uniform 404 to null", async () => {
    vi.stubGlobal("fetch", reply(404, { error: { code: "NOT_FOUND" } }));
    await expect(fetchOrderStatus("OUT-123455")).resolves.toBeNull();
  });

  it("makes no request for a malformed reference", async () => {
    const f = reply(200, STATUS);
    vi.stubGlobal("fetch", f);
    await expect(fetchOrderStatus("OUT-123456")).resolves.toBeNull();
    await expect(fetchOrderStatus("../admin")).resolves.toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("throws typed errors for rate limits, malformed bodies and the network", async () => {
    vi.stubGlobal("fetch", reply(429, {}));
    await expect(fetchOrderStatus("OUT-123455")).rejects.toMatchObject({ kind: "rate_limited" });
    vi.stubGlobal("fetch", reply(200, { reference: "OUT-123455" }));
    await expect(fetchOrderStatus("OUT-123455")).rejects.toMatchObject({ kind: "server" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const e = await fetchOrderStatus("OUT-123455").catch((err: unknown) => err);
    expect(e).toBeInstanceOf(OrderRequestError);
    expect((e as OrderRequestError).kind).toBe("offline");
  });
});

describe("requestCancellation", () => {
  it("posts the item and kind and returns the request status", async () => {
    vi.stubGlobal("fetch", reply(202, { status: "requested" }));
    await expect(requestCancellation("OUT-123455", "item-1", "cancel")).resolves.toEqual({ kind: "accepted", status: "requested" });
    expect(calls[0].url).toBe("/api/orders/OUT-123455/cancellation");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ orderItemId: "item-1", kind: "cancel" });
  });

  it("returns the server's reason when not eligible, and not_found for the uniform 404", async () => {
    vi.stubGlobal("fetch", reply(409, { error: { code: "NOT_ELIGIBLE", reason: "past_deadline" } }));
    await expect(requestCancellation("OUT-123455", "item-1", "cancel")).resolves.toEqual({ kind: "not_eligible", reason: "past_deadline" });
    vi.stubGlobal("fetch", reply(404, { error: { code: "NOT_FOUND" } }));
    await expect(requestCancellation("OUT-123455", "item-1", "exception")).resolves.toEqual({ kind: "not_found" });
  });
});

describe("recovery", () => {
  it("returns the challenge id for every accepted start", async () => {
    vi.stubGlobal("fetch", reply(200, { challengeId: "ch-1" }));
    await expect(startRecovery({ reference: "OUT-123455", channel: "phone", contact: "+919876543210" })).resolves.toEqual({ challengeId: "ch-1" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ reference: "OUT-123455", channel: "phone", contact: "+919876543210" });
  });

  it("names a rate limit on start", async () => {
    vi.stubGlobal("fetch", reply(429, { error: { code: "RATE_LIMITED" } }));
    await expect(startRecovery({ reference: "OUT-123455", channel: "email", contact: "a@example.test" })).rejects.toMatchObject({ kind: "rate_limited" });
  });

  it("sends digits only and maps every failed code to one answer", async () => {
    vi.stubGlobal("fetch", reply(200, { reference: "out-123455" }));
    await expect(verifyRecovery({ challengeId: "ch-1", code: "12 34 56" })).resolves.toEqual({ ok: true, reference: "OUT-123455" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ challengeId: "ch-1", code: "123456" });
    vi.stubGlobal("fetch", reply(400, { error: { code: "CODE_INVALID" } }));
    await expect(verifyRecovery({ challengeId: "ch-1", code: "000000" })).resolves.toEqual({ ok: false });
  });
});

describe("exchangeTicketToken", () => {
  it("posts the token and returns the order reference", async () => {
    vi.stubGlobal("fetch", reply(200, { ok: true, purpose: "view_status", expiresAt: "2026-11-09T00:00:00.000Z", reference: "OUT-123455" }));
    await expect(exchangeTicketToken("tok_synthetic")).resolves.toEqual({ ok: true, reference: "OUT-123455" });
    expect(calls[0]).toMatchObject({ url: "/api/tickets/exchange", init: { method: "POST", credentials: "same-origin" } });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ token: "tok_synthetic" });
  });

  it("treats an expired or invalid token as not ok, and a missing reference as null", async () => {
    vi.stubGlobal("fetch", reply(404, { error: { code: "NOT_FOUND" } }));
    await expect(exchangeTicketToken("tok_synthetic")).resolves.toEqual({ ok: false });
    vi.stubGlobal("fetch", reply(200, { ok: true, purpose: "view_status", expiresAt: "2026-11-09T00:00:00.000Z" }));
    await expect(exchangeTicketToken("tok_synthetic")).resolves.toEqual({ ok: true, reference: null });
  });
});

describe("private order modules", () => {
  const root = path.resolve(import.meta.dirname, "../../../..");
  const files = [
    "src/lib/api/order-status.ts",
    "src/components/commerce/order-status/order-status-view.tsx",
    "src/components/commerce/order-status/cancellation-panel.tsx",
    "src/components/commerce/order-status/recovery-form.tsx",
    "src/components/commerce/order-status/support.tsx",
    "src/components/commerce/order-status/ticket-list.tsx",
    "src/app/booking/[reference]/page.tsx",
    "src/app/booking/confirmation/page.tsx",
    "src/app/manage-booking/page.tsx",
    "src/app/voucher/[reference]/page.tsx",
  ];

  it("send no analytics event and render no PageView (PRV-4)", () => {
    for (const f of files) {
      const src = readFileSync(path.join(root, f), "utf8");
      expect(src, f).not.toMatch(/from\s+["']@\/lib\/analytics["']/);
      expect(src, f).not.toMatch(/\btrack\(/);
      expect(src, f).not.toMatch(/<PageView|components\/analytics/);
      expect(src, f).not.toMatch(/WhatsAppButton|WhatsAppCard/);
    }
  });

  it("read no fixture bookings", () => {
    for (const f of files) {
      const src = readFileSync(path.join(root, f), "utf8");
      expect(src, f).not.toMatch(/data\/bookings|bookingByReference|mocksAllowed/);
    }
  });
});
