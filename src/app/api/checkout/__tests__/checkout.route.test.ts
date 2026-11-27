import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Errors } from "@/server/lib/errors";
import type { CheckoutService } from "@/server/payments/contracts";

/**
 * `POST /api/checkout` and the verification routes, with the payments and
 * verification services replaced (doc 22 §23 B3). Checks the order of the
 * limits, that the owner and the client IP reach the service, that only
 * `{ orderReference, redirectUrl }` leaves on success, and that refusals are
 * folded into the public vocabulary. Synthetic ids only; nothing is written.
 */

const GUEST_ID = "0190a000-0000-7000-8000-0000000000e1";
const QUOTE_ID = "0190a000-0000-7000-8000-0000000000f1";
const VERIFICATION_ID = "0190a000-0000-7000-8000-0000000000c1";
const ORDER_ID = "0190a000-0000-7000-8000-0000000000d1";

const state = vi.hoisted(() => ({
  guest: true,
  release: true,
  start: null as unknown,
  startCalls: [] as unknown[],
  verifyResult: null as unknown,
}));

vi.mock("@/server/lib/logger", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/server/lib/rate-limit", () => ({ enforceRateLimit: vi.fn(async () => undefined) }));
vi.mock("@/server/services/customer-auth.service", () => ({ customerAuthService: { resolveRequest: vi.fn(async () => null) } }));
vi.mock("@/server/services/guest-session.service", () => ({
  guestSessionService: {
    resolveRequest: vi.fn(async () => (state.guest ? { guestSessionId: GUEST_ID } : null)),
    create: vi.fn(async () => {
      throw new Error("checkout never opens a guest session");
    }),
    owner: (h: { guestSessionId: string }) => ({ kind: "guest", guestSessionId: h.guestSessionId }),
  },
}));
vi.mock("@/server/services/contact-verification.service", () => ({
  contactVerificationService: {
    start: vi.fn(async () => ({ challengeId: "0190a000-0000-7000-8000-0000000000a1" })),
    verify: vi.fn(async () => state.verifyResult),
  },
}));
vi.mock("@/server/lib/env", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/lib/env")>();
  return { ...real, env: () => ({ ...real.env(), INSTANT_RELEASE_ENABLED: state.release }) };
});

const { createCheckoutHandler, publicRefusal } = await import("../handler");
const verifyStart = (await import("../verify/start/route")).POST;
const verifyCode = (await import("../verify/route")).POST;
const { enforceRateLimit } = await import("@/server/lib/rate-limit");
const { contactVerificationService } = await import("@/server/services/contact-verification.service");

const fakeCheckout: CheckoutService = {
  async start(input) {
    state.startCalls.push(input);
    if (state.start instanceof Error) throw state.start;
    return state.start as Awaited<ReturnType<CheckoutService["start"]>>;
  },
};
const POST = createCheckoutHandler(() => fakeCheckout);

function req(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { origin: "http://localhost:3000", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const goodBody = {
  quoteId: QUOTE_ID,
  verificationId: VERIFICATION_ID,
  method: "upi",
  traveller: { fullName: "Synthetic Traveller", phoneE164: "+971501234567", email: "traveller@example.test" },
};

async function call(body: unknown = goodBody, headers?: Record<string, string>) {
  const res = await POST(req("/api/checkout", body, headers), undefined as never);
  return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
}

beforeEach(() => {
  state.guest = true;
  state.release = true;
  state.start = { ok: true, orderId: ORDER_ID, orderReference: "OUT-TEST01", redirectUrl: "https://fake.invalid/pay/order_1" };
  state.startCalls = [];
  state.verifyResult = null;
  vi.mocked(enforceRateLimit).mockClear();
  vi.mocked(enforceRateLimit).mockImplementation(async () => undefined as never);
});

describe("POST /api/checkout", () => {
  it("returns only the order reference and the hosted page, never the order id", async () => {
    const r = await call();
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ orderReference: "OUT-TEST01", redirectUrl: "https://fake.invalid/pay/order_1" });
    expect(JSON.stringify(r.body)).not.toContain(ORDER_ID);
  });

  it("passes the guest owner, the quote, the verification, the normalised traveller and a server-built return URL", async () => {
    await call();
    expect(state.startCalls).toEqual([
      {
        owner: { kind: "guest", guestSessionId: GUEST_ID },
        quoteId: QUOTE_ID,
        verificationId: VERIFICATION_ID,
        method: "upi",
        traveller: { fullName: "Synthetic Traveller", phoneE164: "+971501234567", email: "traveller@example.test" },
        returnUrl: "http://localhost:3000/booking/confirmation",
        ip: null,
      },
    ]);
  });

  it("limits per IP before the body and per owner before the service, both failing closed", async () => {
    await call();
    const calls = vi.mocked(enforceRateLimit).mock.calls.map(([o]) => o);
    expect(calls.map((o) => o.key.replace(/:[^:]+$/, ""))).toEqual(["checkout:ip", "checkout:owner:guest"]);
    for (const o of calls) expect(o.onStoreFailure ?? "closed").toBe("closed");
  });

  it.each([
    ["exhausted", () => Errors.rateLimited(30), 429],
    ["its store down", () => Errors.unavailable(30), 503],
  ] as const)("an IP limit %s refuses before anything else runs", async (_n, error, status) => {
    vi.mocked(enforceRateLimit).mockImplementation(async (o) => {
      if (o.key.startsWith("checkout:ip:")) throw error();
      return undefined as never;
    });
    expect((await call()).status).toBe(status);
    expect(state.startCalls).toEqual([]);
  });

  it("an owner limit refuses before the service", async () => {
    vi.mocked(enforceRateLimit).mockImplementation(async (o) => {
      if (o.key.startsWith("checkout:owner:")) throw Errors.rateLimited(30);
      return undefined as never;
    });
    expect((await call()).status).toBe(429);
    expect(state.startCalls).toEqual([]);
  });

  it("refuses a cross-site request and an oversized or malformed body", async () => {
    expect((await call(goodBody, { origin: "https://evil.example" })).status).toBe(403);
    expect((await call({ ...goodBody, traveller: { ...goodBody.traveller, fullName: "x".repeat(5000) } })).status).toBe(413);
    expect((await call({ ...goodBody, amountMinor: "1" })).status).toBe(422);
    expect((await call({ ...goodBody, method: "crypto" })).status).toBe(422);
    expect((await call({ ...goodBody, traveller: { fullName: "A", phoneE164: "12345", email: null } })).status).toBe(422);
    expect((await call({ ...goodBody, traveller: { fullName: "A", phoneE164: null, email: null } })).status).toBe(422);
    // TravelDesk takes Latin letters only: a name in another script is refused before any payment.
    const script = await call({ ...goodBody, traveller: { ...goodBody.traveller, fullName: "محمد علي" } });
    expect(script.status).toBe(422);
    expect(JSON.stringify(script.body)).toContain("English letters");
    expect(state.startCalls).toEqual([]);
    // Accents and punctuation are fine: only the supplier copy is rewritten.
    expect((await call({ ...goodBody, traveller: { ...goodBody.traveller, fullName: "José O'Brien-Núñez" } })).status).toBe(201);
  });

  it("with the release switch off, refuses to inquiry without reading a session or calling the service", async () => {
    state.release = false;
    expect(await call()).toEqual({ status: 200, body: { refused: "requires_inquiry" } });
    expect(state.startCalls).toEqual([]);
  });

  it("without the session that made the quote, refuses and opens none", async () => {
    state.guest = false;
    expect((await call()).status).toBe(409);
    expect(state.startCalls).toEqual([]);
  });

  it("folds the service's refusal into the public vocabulary", async () => {
    state.start = { ok: false, reason: "exposure_cap" };
    expect((await call()).body).toEqual({ refused: "requires_inquiry" });
    state.start = { ok: false, reason: "quote_expired" };
    expect((await call()).body).toEqual({ refused: "quote_expired" });
  });

  it("never forwards a hosted page that is not an https URL (CR-B3-12)", async () => {
    state.start = { ok: true, orderId: ORDER_ID, orderReference: "OUT-TEST01", redirectUrl: "javascript:alert(1)" };
    const r = await call();
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain("javascript");
    state.start = { ok: true, orderId: ORDER_ID, orderReference: "OUT-TEST01", redirectUrl: "http://fake.invalid/pay/order_1" };
    const plain = await call();
    expect(plain.status).toBe(500);
    expect(JSON.stringify(plain.body)).not.toContain("fake.invalid");
  });
});

describe("POST /api/checkout: the guest download grant (checkout redesign batch 3, CO-02)", () => {
  const ENTRY = "v1.0190a000-0000-7000-8000-0000000000b1.1900000000." + "b".repeat(64);
  const grantState = { result: null as { value: string; expiresAt: Date } | null | Error, calls: [] as unknown[] };
  const grants = {
    async issue(input: unknown) {
      grantState.calls.push(input);
      if (grantState.result instanceof Error) throw grantState.result;
      return grantState.result;
    },
  };
  const withGrants = createCheckoutHandler(() => fakeCheckout, () => grants);
  const callWithGrants = (headers?: Record<string, string>) => withGrants(req("/api/checkout", goodBody, headers), undefined as never);
  const accessCookie = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("outlyy_ticket_access="));

  beforeEach(() => {
    grantState.result = { value: ENTRY, expiresAt: new Date("2030-01-11T12:00:00.000Z") };
    grantState.calls = [];
  });

  it("asks for the grant with the order id, the guest session, the request's verification id and the browser's current access cookie, and sets what it returns", async () => {
    const res = await callWithGrants({ cookie: "outlyy_ticket_access=v1.older-entry" });
    expect(res.status).toBe(201);
    expect(grantState.calls).toEqual([{ orderId: ORDER_ID, guestSessionId: GUEST_ID, verificationId: VERIFICATION_ID, existingCookie: "v1.older-entry" }]);
    const set = accessCookie(res)!;
    expect(set).toContain(`outlyy_ticket_access=${ENTRY}`);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    // The body is unchanged: still only the reference and the hosted page.
    expect(await res.json()).toEqual({ orderReference: "OUT-TEST01", redirectUrl: "https://fake.invalid/pay/order_1" });
  });

  it("sets no cookie when the grant service gives none (switch off, not the quote's session, not verified)", async () => {
    grantState.result = null;
    const res = await callWithGrants();
    expect(res.status).toBe(201);
    expect(accessCookie(res)).toBeUndefined();
  });

  it("a failing grant service never fails the checkout", async () => {
    grantState.result = new Error("database unavailable");
    const res = await callWithGrants();
    expect(res.status).toBe(201);
    expect(accessCookie(res)).toBeUndefined();
  });

  it("is never asked for a signed-in customer (who owns the order), a refusal or a bad hosted page", async () => {
    const { customerAuthService } = await import("@/server/services/customer-auth.service");
    vi.mocked(customerAuthService.resolveRequest).mockResolvedValueOnce({ customer: { id: "0190a000-0000-7000-8000-0000000000c9" } } as never);
    expect(accessCookie(await callWithGrants())).toBeUndefined();
    state.start = { ok: false, reason: "quote_expired" };
    expect(accessCookie(await callWithGrants())).toBeUndefined();
    state.start = { ok: true, orderId: ORDER_ID, orderReference: "OUT-TEST01", redirectUrl: "http://fake.invalid/pay/order_1" };
    expect((await callWithGrants()).status).toBe(500);
    expect(grantState.calls).toEqual([]);
  });

  it("the return URL handed to the payments side is the bare neutral page; the gateway adds only the hint", async () => {
    await callWithGrants();
    expect((state.startCalls[0] as { returnUrl: string }).returnUrl).toBe("http://localhost:3000/booking/confirmation");
  });
});

describe("publicRefusal", () => {
  it.each([
    ["quote_expired", "quote_expired"],
    ["quote_not_active", "quote_expired"],
    ["quote_not_found", "quote_expired"],
    ["verification_required", "verification_required"],
    ["queue_busy", "try_again"],
    ["payment_session_unavailable", "try_again"],
    ["release_switch_off", "requires_inquiry"],
    ["sales_paused", "requires_inquiry"],
    ["exposure_cap", "requires_inquiry"],
    ["payments_not_configured", "requires_inquiry"],
    ["toString", "requires_inquiry"],
    ["a_reason_added_later", "requires_inquiry"],
  ] as const)("%s → %s", (reason, expected) => {
    expect(publicRefusal(reason)).toBe(expected);
  });
});

describe("POST /api/checkout/verify/start and /api/checkout/verify", () => {
  it("start passes the owner and the client IP to the verification service and answers only the challenge id", async () => {
    const res = await verifyStart(req("/api/checkout/verify/start", { quoteId: QUOTE_ID, channel: "phone", contact: "+971501234567" }), undefined as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challengeId: "0190a000-0000-7000-8000-0000000000a1" });
    expect(vi.mocked(contactVerificationService.start)).toHaveBeenLastCalledWith({ quoteId: QUOTE_ID, channel: "phone", contact: "+971501234567", owner: { kind: "guest", guestSessionId: GUEST_ID }, ip: null });
    expect(vi.mocked(enforceRateLimit).mock.calls[0][0].key).toMatch(/^checkout:verify_start:ip:/);
  });

  it("verify answers the verification without the contact hash", async () => {
    state.verifyResult = { verificationId: VERIFICATION_ID, quoteId: QUOTE_ID, channel: "phone", contactHash: "c".repeat(64), method: "otp_sms", verifiedAt: "2026-11-01T08:00:00.000Z" };
    const res = await verifyCode(req("/api/checkout/verify", { challengeId: "0190a000-0000-7000-8000-0000000000a1", code: "123456" }), undefined as never);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ verificationId: VERIFICATION_ID, channel: "phone", verifiedAt: "2026-11-01T08:00:00.000Z" });
    expect(text).not.toContain("c".repeat(64));
  });

  it.each([
    ["invalid", 422],
    ["expired", 404],
    ["rate_limited", 429],
  ] as const)("verify maps a %s refusal to %s", async (refused, status) => {
    state.verifyResult = { refused };
    const res = await verifyCode(req("/api/checkout/verify", { challengeId: "0190a000-0000-7000-8000-0000000000a1", code: "123456" }), undefined as never);
    expect(res.status).toBe(status);
  });

  it("neither route runs without the session that made the quote", async () => {
    state.guest = false;
    vi.mocked(contactVerificationService.start).mockClear();
    vi.mocked(contactVerificationService.verify).mockClear();
    expect((await verifyStart(req("/api/checkout/verify/start", { quoteId: QUOTE_ID, channel: "email", contact: "a@example.test" }), undefined as never)).status).toBe(409);
    expect((await verifyCode(req("/api/checkout/verify", { challengeId: QUOTE_ID, code: "123456" }), undefined as never)).status).toBe(409);
    expect(contactVerificationService.start).not.toHaveBeenCalled();
    expect(contactVerificationService.verify).not.toHaveBeenCalled();
  });
});
