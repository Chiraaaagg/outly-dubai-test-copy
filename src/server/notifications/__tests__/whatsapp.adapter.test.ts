import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/server/lib/env";
import { classifyWhatsAppStatus, whatsappAdapter, WhatsAppSendError, WHATSAPP_TIMEOUT_MS, type WhatsAppFailure } from "../whatsapp.adapter";

/**
 * WhatsApp adapter outcomes (doc 22 §32.9, TKT-6, PRV-6). The Cloud API has
 * no idempotency key this repository can verify, so none is sent; instead
 * every non-sent result is a typed outcome, and an ambiguous one is
 * `unknown` so the outbox never re-sends it automatically. The network is a
 * fake `fetch`; nothing leaves the process.
 */

const MSG = { to: "+971500000001", templateName: "inquiry_ack_v1", variables: { "1": "Asha", "2": "INQ-1" }, text: "hi" };
const PROVIDER_BODY = "provider-body token=abc123 to=+971500000001";
const saved = { ...process.env };

function cloud(response: (init: RequestInit) => Promise<Response>) {
  const calls: [string, RequestInit][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return response(init);
    }),
  );
  return calls;
}

async function failureOf(p: Promise<unknown>): Promise<WhatsAppFailure> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(WhatsAppSendError);
    expect(String((e as Error).message)).not.toContain("abc123");
    return (e as WhatsAppSendError).outcome;
  }
  throw new Error("expected a WhatsAppSendError");
}

beforeEach(() => {
  process.env.WHATSAPP_PROVIDER = "cloud_api";
  process.env.WHATSAPP_API_BASE_URL = "https://wa.example.test/v1";
  process.env.WHATSAPP_API_TOKEN = "unit-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "1234567890";
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = { ...saved };
  resetEnvCache();
});

describe("WhatsApp adapter outcomes", () => {
  it("a 2xx is sent with the provider's message id; no idempotency header is invented", async () => {
    const calls = cloud(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.ABC123" }] }), { status: 200 }));
    await expect(whatsappAdapter.send(MSG)).resolves.toEqual({ providerId: "wamid.ABC123" });
    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0][1].headers);
    expect(headers.get("idempotency-key")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["authorization", "content-type"]);
  });

  it("status classification: 429 retryable, other 4xx definite, 5xx and 408 unknown", () => {
    expect(classifyWhatsAppStatus(429)).toMatchObject({ kind: "failed", retryable: true, reason: "rate_limited" });
    expect(classifyWhatsAppStatus(400)).toMatchObject({ kind: "failed", retryable: false, reason: "rejected" });
    expect(classifyWhatsAppStatus(401)).toMatchObject({ kind: "failed", retryable: false, reason: "auth" });
    expect(classifyWhatsAppStatus(500)).toMatchObject({ kind: "unknown", reason: "server_error" });
    expect(classifyWhatsAppStatus(503)).toMatchObject({ kind: "unknown", reason: "server_error" });
    expect(classifyWhatsAppStatus(408)).toMatchObject({ kind: "unknown", reason: "server_error" });
  });

  it("a provider error never carries the provider's body", async () => {
    cloud(async () => new Response(PROVIDER_BODY, { status: 400 }));
    expect(await failureOf(whatsappAdapter.send(MSG))).toEqual({ kind: "failed", retryable: false, httpStatus: 400, reason: "rejected" });
    cloud(async () => new Response(PROVIDER_BODY, { status: 502 }));
    expect(await failureOf(whatsappAdapter.send(MSG))).toEqual({ kind: "unknown", httpStatus: 502, reason: "server_error" });
  });

  it("a network error or an unreadable 2xx is unknown: it may have gone out", async () => {
    cloud(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await failureOf(whatsappAdapter.send(MSG))).toEqual({ kind: "unknown", httpStatus: null, reason: "network" });
    cloud(async () => new Response("not json", { status: 200 }));
    expect(await failureOf(whatsappAdapter.send(MSG))).toMatchObject({ kind: "unknown", reason: "bad_response" });
  });

  it("a timeout is unknown", async () => {
    vi.useFakeTimers();
    cloud(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    const p = failureOf(whatsappAdapter.send(MSG));
    await vi.advanceTimersByTimeAsync(WHATSAPP_TIMEOUT_MS + 10);
    expect(await p).toEqual({ kind: "unknown", httpStatus: null, reason: "timeout" });
  });

  it("configuration gaps are retryable failures; a message without a template is definite; no request is made", async () => {
    const calls = cloud(async () => new Response("{}", { status: 200 }));
    delete process.env.WHATSAPP_API_TOKEN;
    resetEnvCache();
    expect(await failureOf(whatsappAdapter.send(MSG))).toEqual({ kind: "failed", retryable: true, httpStatus: null, reason: "not_configured" });
    process.env.WHATSAPP_API_TOKEN = "unit-token";
    resetEnvCache();
    expect(await failureOf(whatsappAdapter.send({ ...MSG, templateName: undefined }))).toMatchObject({ kind: "failed", retryable: false, reason: "invalid_message" });
    expect(calls).toHaveLength(0);
  });
});
