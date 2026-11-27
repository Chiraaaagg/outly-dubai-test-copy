import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/lib/env";
import { log } from "@/server/lib/logger";
import { classifyResendStatus, emailAdapter, EMAIL_TIMEOUT_MS, type EmailOutcome } from "../email.adapter";

/**
 * Email adapter outcome classification and the idempotency header (TKT-6,
 * PRV-6). The network is a fake `fetch`; nothing leaves the process.
 */

const MSG = { to: "guest@outlyy.test", subject: "Your tickets", html: "<p>hi</p>", text: "hi" };
const KEY = "0192f0a0-0000-7000-8000-000000000001";
const PROVIDER_BODY = "provider-secret-body token=abc123 to=guest@outlyy.test";

type FetchArgs = [string, RequestInit];
const saved = { ...process.env };

function resend(response: (init: RequestInit) => Promise<Response>) {
  const calls: FetchArgs[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return response(init);
    }),
  );
  return calls;
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

function logged(): string {
  const spies = [vi.mocked(log.info), vi.mocked(log.warn), vi.mocked(log.error)];
  return JSON.stringify(spies.flatMap((s) => s.mock.calls));
}

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_unit_test_key";
  process.env.EMAIL_FROM_TRANSACTIONAL = "OUTLYY <tickets@outlyy.test>";
  delete process.env.EMAIL_CATCH_ALL;
  process.env.APP_ENV = "development";
  resetEnvCache();
  vi.spyOn(log, "info");
  vi.spyOn(log, "warn");
  vi.spyOn(log, "error");
});

afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("email adapter: Resend outcomes", () => {
  it("sends the Idempotency-Key header and returns the provider id", async () => {
    const calls = resend(async () => new Response(JSON.stringify({ id: "re_abc123" }), { status: 200 }));
    const out = await emailAdapter.send(MSG, { idempotencyKey: KEY });
    expect(out).toEqual({ kind: "sent", providerId: "re_abc123" });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(header(init, "idempotency-key")).toBe(KEY);
    expect(header(init, "authorization")).toBe("Bearer re_unit_test_key");
    expect(JSON.parse(String(init.body)).to).toEqual(["guest@outlyy.test"]);
  });

  it.each([
    [429, { kind: "failed", retryable: true, httpStatus: 429, reason: "rate_limited" }],
    [400, { kind: "failed", retryable: false, httpStatus: 400, reason: "rejected" }],
    [422, { kind: "failed", retryable: false, httpStatus: 422, reason: "rejected" }],
    [401, { kind: "failed", retryable: false, httpStatus: 401, reason: "auth" }],
    [403, { kind: "failed", retryable: false, httpStatus: 403, reason: "auth" }],
    [409, { kind: "unknown", httpStatus: 409, reason: "conflict" }],
    [500, { kind: "unknown", httpStatus: 500, reason: "server_error" }],
    [503, { kind: "unknown", httpStatus: 503, reason: "server_error" }],
  ] as [number, EmailOutcome][])("HTTP %i → %o, without the provider body", async (status, expected) => {
    resend(async () => new Response(PROVIDER_BODY, { status }));
    const out = await emailAdapter.send(MSG, { idempotencyKey: KEY });
    expect(out).toEqual(expected);
    expect(classifyResendStatus(status)).toEqual(expected);
    expect(JSON.stringify(out)).not.toContain("provider-secret-body");
    expect(logged()).not.toContain("provider-secret-body");
  });

  it("a network error is unknown (the provider may have it)", async () => {
    resend(async () => {
      throw new TypeError("fetch failed: socket hang up");
    });
    expect(await emailAdapter.send(MSG, { idempotencyKey: KEY })).toEqual({ kind: "unknown", httpStatus: null, reason: "network" });
  });

  it("an abort from elsewhere is unknown", async () => {
    resend(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    expect(await emailAdapter.send(MSG, { idempotencyKey: KEY })).toEqual({ kind: "unknown", httpStatus: null, reason: "aborted" });
  });

  it("the client timeout is unknown, never failed", async () => {
    vi.useFakeTimers();
    resend(
      (init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const pending = emailAdapter.send(MSG, { idempotencyKey: KEY });
    await vi.advanceTimersByTimeAsync(EMAIL_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ kind: "unknown", httpStatus: null, reason: "timeout" });
  });

  it("a 2xx with an unreadable body still counts as sent", async () => {
    resend(async () => new Response("not json", { status: 200 }));
    const out = await emailAdapter.send(MSG, { idempotencyKey: KEY });
    expect(out.kind).toBe("sent");
  });

  it("EMAIL_CATCH_ALL redirects outside production", async () => {
    process.env.EMAIL_CATCH_ALL = "catch@outlyy.test";
    resetEnvCache();
    const calls = resend(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
    await emailAdapter.send(MSG, { idempotencyKey: KEY });
    expect(JSON.parse(String(calls[0][1].body)).to).toEqual(["catch@outlyy.test"]);
  });

  it("a missing sender is a retryable failure and nothing is sent", async () => {
    delete process.env.EMAIL_FROM_TRANSACTIONAL;
    resetEnvCache();
    const calls = resend(async () => new Response("{}", { status: 200 }));
    expect(await emailAdapter.send(MSG, { idempotencyKey: KEY })).toEqual({ kind: "failed", retryable: true, httpStatus: null, reason: "not_configured" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed idempotency key without sending", async () => {
    const calls = resend(async () => new Response("{}", { status: 200 }));
    expect((await emailAdapter.send(MSG, { idempotencyKey: "bad key\n" })).kind).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  it("the one-argument form throws on failure with the status only", async () => {
    resend(async () => new Response(PROVIDER_BODY, { status: 422 }));
    await expect(emailAdapter.send(MSG)).rejects.toThrow(/^Email failed: rejected \(HTTP 422\)$/);
    resend(async () => new Response(JSON.stringify({ id: "re_2" }), { status: 200 }));
    await expect(emailAdapter.send(MSG)).resolves.toEqual({ providerId: "re_2", costMinor: undefined });
  });
});

describe("email adapter: log adapter", () => {
  it("is deterministic per key, sends nothing and logs no subject", async () => {
    delete process.env.RESEND_API_KEY;
    resetEnvCache();
    const calls = resend(async () => new Response("{}", { status: 200 }));
    const a = await emailAdapter.send(MSG, { idempotencyKey: KEY });
    const b = await emailAdapter.send(MSG, { idempotencyKey: KEY });
    const c = await emailAdapter.send(MSG, { idempotencyKey: `${KEY.slice(0, -1)}2` });
    expect(a).toEqual(b);
    expect(a.kind === "sent" && a.providerId.startsWith("log-")).toBe(true);
    expect(c).not.toEqual(a);
    expect(calls).toHaveLength(0);
    expect(logged()).not.toContain("Your tickets");
    expect(logged()).not.toContain("guest@outlyy.test");
  });
});
