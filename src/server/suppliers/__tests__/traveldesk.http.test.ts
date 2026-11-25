import { describe, expect, it } from "vitest";
import { z } from "zod";
import { balanceWire } from "../traveldesk/traveldesk.codec";
import { traveldeskConfigFrom, type TravelDeskConfig } from "../traveldesk/traveldesk.config";
import {
  buildQuery,
  isServerErrorPage,
  isTravelDeskApiError,
  joinUrl,
  TravelDeskApiError,
  TravelDeskHttp,
  type TravelDeskCallEvent,
  type TravelDeskHttpOptions,
} from "../traveldesk/traveldesk.http";

const KEY = "test-key-not-real";
const BASE = "https://testapi.traveldesk.me/public/b2b/v1";

const config = traveldeskConfigFrom({
  SUPPLIER_ADAPTER_TRAVELDESK: "live",
  TRAVELDESK_ENV: "test",
  TRAVELDESK_API_BASE_URL: BASE,
  TRAVELDESK_API_KEY: KEY,
}) as TravelDeskConfig;

const anyJson = z.unknown();
const BALANCE = { id: 77, balance: 1500.5, creditFacility: 0, payableBalance: 1500.5 };

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  }) as typeof fetch;
  return { fn, calls };
}

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function client(respond: (url: string, init: RequestInit) => Response | Promise<Response>, opts: TravelDeskHttpOptions = {}) {
  const f = fakeFetch(respond);
  const events: TravelDeskCallEvent[] = [];
  const http = new TravelDeskHttp(config, { fetch: f.fn, now: () => 1_000, onEvent: (e) => events.push(e), ...opts });
  return { http, calls: f.calls, events };
}

async function failure(p: Promise<unknown>): Promise<TravelDeskApiError> {
  try {
    await p;
  } catch (e) {
    expect(isTravelDeskApiError(e)).toBe(true);
    return e as TravelDeskApiError;
  }
  throw new Error("expected a TravelDeskApiError");
}

/** The key must never appear in the error (message or enumerable fields) or in any emitted event. */
function expectNoKey(err: TravelDeskApiError | null, events: TravelDeskCallEvent[]) {
  if (err) {
    expect(err.message).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
    expect(String(err.stack ?? "")).not.toContain(KEY);
  }
  expect(JSON.stringify(events)).not.toContain(KEY);
}

describe("buildQuery / joinUrl", () => {
  it("repeats keys for arrays, skips undefined, stringifies scalars", () => {
    expect(buildQuery(undefined)).toBe("");
    expect(buildQuery({})).toBe("");
    expect(buildQuery({ a: undefined })).toBe("");
    expect(buildQuery({ ToursIds: [1, 2], Language: undefined, IncludePrices: true, From: "2026-10-15" })).toBe(
      "?ToursIds=1&ToursIds=2&IncludePrices=true&From=2026-10-15",
    );
    expect(buildQuery({ q: "a b&c" })).toBe("?q=a+b%26c");
  });

  it("joins onto the base URL and refuses paths that repeat the prefix or are relative", () => {
    expect(joinUrl(BASE, "/tours/12")).toBe(`${BASE}/tours/12`);
    expect(() => joinUrl(BASE, "/public/b2b/v1/tours")).toThrow(/must not repeat/);
    expect(() => joinUrl(BASE, "tours")).toThrow(/must start with/);
  });
});

describe("TravelDeskHttp.getJson — request", () => {
  it("builds base + path + query, sends exactly `Bearer <key>`, GET, redirect error, with a signal", async () => {
    const { http, calls } = client(() => json(BALANCE));
    const out = await http.getJson("tours.get", "/tours/{Id}", "/tours/12", { CurrencyCode: "AED", ToursIds: [3, 4], Language: undefined }, anyJson);
    expect(out).toEqual(BALANCE);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/tours/12?CurrencyCode=AED&ToursIds=3&ToursIds=4`);
    const { init } = calls[0];
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeUndefined();
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("accept")).toBe("application/json");
  });

  it("refuses a path that repeats the prefix before any fetch", async () => {
    const { http, calls } = client(() => json(BALANCE));
    await expect(http.getJson("x", "/x", "/public/b2b/v1/balance", undefined, anyJson)).rejects.toThrow(/must not repeat/);
    expect(calls).toHaveLength(0);
  });

  it("validates and returns the parsed body; unknown fields are stripped", async () => {
    const { http } = client(() => json({ ...BALANCE, extra: "ignored" }));
    await expect(http.getJson("balance", "/balance", "/balance", undefined, balanceWire)).resolves.toEqual(BALANCE);
  });
});

describe("TravelDeskHttp.getJson — error classification", () => {
  it("400 plain text → bad_request with a truncated, whitespace-collapsed reason", async () => {
    const long = `Date   is\n in the past. ${"x".repeat(500)}`;
    const { http, events } = client(() => new Response(long, { status: 400, headers: { "content-type": "text/plain" } }));
    const err = await failure(http.getJson("availability.byoffer", "/availability/byoffer", "/availability/byoffer", undefined, anyJson));
    expect(err).toMatchObject({ kind: "bad_request", status: 400, operation: "availability.byoffer" });
    expect(err.reason?.startsWith("Date is in the past. xxx")).toBe(true);
    expect(err.reason?.endsWith("…")).toBe(true);
    expect(err.reason?.length).toBe(201);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe("bad_request");
    expectNoKey(err, events);
  });

  it("400 short plain text keeps the whole reason (e.g. foreign booking id)", async () => {
    const { http } = client(() => new Response("Not found", { status: 400 }));
    const err = await failure(http.getJson("op", "/x", "/x", undefined, anyJson));
    expect(err.reason).toBe("Not found");
  });

  it("400 with a JSON-encoded string body keeps the string as the reason (TravelDesk cancel refusal, A5 sandbox)", async () => {
    const text = "At the moment we can only cancel bookings within the full refund period. Please contact support for partial refund. ";
    const { http, events } = client(() => new Response(JSON.stringify(text), { status: 400, headers: { "content-type": "application/json; charset=utf-8" } }));
    const err = await failure(http.getJson("bookings.cancel", "/bookings/cancel", "/bookings/cancel", undefined, anyJson));
    expect(err).toMatchObject({ kind: "bad_request", status: 400 });
    expect(err.reason).toBe(text.trim());
    expectNoKey(err, events);
    const blank = client(() => json("  ", { status: 400 }));
    expect((await failure(blank.http.getJson("op", "/x", "/x", undefined, anyJson))).reason).toBeUndefined();
    const numeric = client(() => json(42, { status: 400 }));
    expect((await failure(numeric.http.getJson("op", "/x", "/x", undefined, anyJson))).reason).toBeUndefined();
  });

  it("a 400 carrying a web server's 5xx error page is a server failure, never a refusal (3 Nov 2026 TEST outage, doc 22 §32.22)", async () => {
    // The shape TravelDesk TEST sent for every POST during the outage: an IIS page, JSON-encoded. Its title sits past the 200-character reason cap.
    const iis = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"> <html xmlns="http://www.w3.org/1999/xhtml"> <head> <meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"/> <title>IIS 10.0 Detailed Error - 502.5 - Process Failure</title> </head> <body> <h3>HTTP Error 502.5 - Process Failure</h3> </body> </html>`;
    const wrapped = client(() => new Response(JSON.stringify(iis), { status: 400, headers: { "content-type": "application/json; charset=utf-8" } }));
    const err = await failure(wrapped.http.getJson("bookings.reserve", "/bookings/reserve", "/bookings/reserve", undefined, anyJson));
    expect(err).toMatchObject({ kind: "server", status: 400, serverErrorPage: true });
    expect(err.reason).toBeUndefined();
    expect(wrapped.events[0]).toMatchObject({ outcome: "server", status: 400 });
    expectNoKey(err, wrapped.events);
    const plain = client(() => new Response("<html><head><title>HTTP Error 503.0 - Service Unavailable</title></head></html>", { status: 404, headers: { "content-type": "text/html" } }));
    expect(await failure(plain.http.getJson("op", "/x", "/x", undefined, anyJson))).toMatchObject({ kind: "server", status: 404, serverErrorPage: true });
    // A business 400 that merely mentions a number stays a bad request; a real 5xx needs no flag.
    const business = client(() => new Response(JSON.stringify("Error 502: offer 502 is not bookable"), { status: 400, headers: { "content-type": "application/json" } }));
    expect(await failure(business.http.getJson("op", "/x", "/x", undefined, anyJson))).toMatchObject({ kind: "bad_request", status: 400 });
    const real = client(() => new Response(iis, { status: 502 }));
    const realErr = await failure(real.http.getJson("op", "/x", "/x", undefined, anyJson));
    expect(realErr).toMatchObject({ kind: "server", status: 502 });
    expect(realErr.serverErrorPage).toBeUndefined();
    expect(isServerErrorPage(400, "<html><title>IIS 10.0 Detailed Error - 503.2 - Service Unavailable</title></html>")).toBe(true);
    expect(isServerErrorPage(400, "<html><h1 class='x'>HTTP Error 500.19</h1></html>")).toBe(true);
    expect(isServerErrorPage(400, "Bad date")).toBe(false);
  });

  it("the 5xx-page rule is narrow: never a 401/403/422, never echoed input, never outside the page's title or h1 (review P3-3)", async () => {
    // A 422 echoing a guest name that reads like a server error stays a validation answer.
    const echoed = client(() => json([{ fieldName: "GuestName", errorMessage: "HTTP Error 500.0 - <title>HTTP Error 500</title> is not a valid name" }], { status: 422 }));
    expect(await failure(echoed.http.getJson("bookings.reserve", "/x", "/x", undefined, anyJson))).toMatchObject({ kind: "validation", status: 422 });
    // 401 and 403 keep `auth` whatever page comes with them.
    const page = "<html><head><title>IIS 10.0 Detailed Error - 502.5 - Process Failure</title></head></html>";
    for (const status of [401, 403]) {
      const err = await failure(client(() => new Response(page, { status, headers: { "content-type": "text/html" } })).http.getJson("op", "/x", "/x", undefined, anyJson));
      expect(err).toMatchObject({ kind: "auth", status });
      expect(err.serverErrorPage).toBeUndefined();
    }
    // A JSON 400 (not an HTML page) that quotes the phrase is a bad request.
    const quoted = client(() => json({ title: "Bad Request", detail: "Guest name 'HTTP Error 500' rejected" }, { status: 400 }));
    expect(await failure(quoted.http.getJson("op", "/x", "/x", undefined, anyJson))).toMatchObject({ kind: "bad_request" });
    const quotedString = client(() => new Response(JSON.stringify("HTTP Error 502.5 - Process Failure"), { status: 400, headers: { "content-type": "application/json" } }));
    expect(await failure(quotedString.http.getJson("op", "/x", "/x", undefined, anyJson))).toMatchObject({ kind: "bad_request" });
    // An HTML 400 whose phrase sits only in the body text, not its title or h1.
    expect(isServerErrorPage(400, "<html><title>Booking</title><body><p>HTTP Error 502.5</p></body></html>")).toBe(false);
    expect(isServerErrorPage(422, page)).toBe(false);
  });

  it("a 2xx whose body read times out is marked bodyLost: the answer is lost, but TravelDesk answered (review P3-4)", async () => {
    const stalled = () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(Object.assign(new Error("body read timed out"), { name: "TimeoutError" }));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const ok = await failure(client(stalled).http.getJson("bookings.reserve", "/x", "/x", undefined, anyJson));
    expect(ok).toMatchObject({ kind: "timeout", status: 200, bodyLost: true });
    // The same failure on a 5xx body is no lost answer.
    const bad = await failure(
      client(() => new Response(new ReadableStream({ start: (c) => c.error(Object.assign(new Error("t"), { name: "TimeoutError" })) }), { status: 503 })).http.getJson("op", "/x", "/x", undefined, anyJson),
    );
    expect(bad).toMatchObject({ kind: "timeout", status: 503 });
    expect(bad.bodyLost).toBeUndefined();
  });

  it("400 problem details prefers detail over title, falls back to title", async () => {
    const withDetail = client(() => json({ type: "about:blank", title: "Bad Request", status: 400, detail: "Offer is not bookable" }, { status: 400 }));
    expect((await failure(withDetail.http.getJson("op", "/x", "/x", undefined, anyJson))).reason).toBe("Offer is not bookable");
    const titleOnly = client(() => json({ title: "Bad Request", status: 400, detail: "" }, { status: 400 }));
    expect((await failure(titleOnly.http.getJson("op", "/x", "/x", undefined, anyJson))).reason).toBe("Bad Request");
    const neither = client(() => json({ status: 400 }, { status: 400 }));
    expect((await failure(neither.http.getJson("op", "/x", "/x", undefined, anyJson))).reason).toBeUndefined();
  });

  it("401 and 403 (empty body) → auth", async () => {
    for (const status of [401, 403]) {
      const { http, events } = client(() => new Response(null, { status }));
      const err = await failure(http.getJson("balance", "/balance", "/balance", undefined, anyJson));
      expect(err).toMatchObject({ kind: "auth", status });
      expect(err.reason).toBeUndefined();
      expect(events[0]).toMatchObject({ outcome: "auth", status });
      expectNoKey(err, events);
    }
  });

  it("404 → not_found, 415 → unsupported_media, 500 empty → server, 503 → server", async () => {
    const cases: [number, string][] = [
      [404, "not_found"],
      [415, "unsupported_media"],
      [500, "server"],
      [503, "server"],
    ];
    for (const [status, kind] of cases) {
      const { http, events } = client(() => new Response(null, { status }));
      const err = await failure(http.getJson("tours.get", "/tours/{Id}", "/tours/1", undefined, anyJson));
      expect(err).toMatchObject({ kind, status });
      expect(err.message).toBe(`TravelDesk tours.get failed: ${kind} (${status})`);
      expect(events).toEqual([expect.objectContaining({ outcome: kind, status })]);
    }
  });

  it("422 [{fieldName, errorMessage}] → validation with fieldErrors", async () => {
    const body = [
      { fieldName: "Date", errorMessage: "Date must be in the future" },
      { fieldName: "Adults", errorMessage: "y".repeat(400) },
      "garbage",
      { fieldName: 5 },
    ];
    const { http } = client(() => json(body, { status: 422 }));
    const err = await failure(http.getJson("op", "/x", "/x", undefined, anyJson));
    expect(err.kind).toBe("validation");
    expect(err.fieldErrors).toHaveLength(3);
    expect(err.fieldErrors?.[0]).toEqual({ fieldName: "Date", errorMessage: "Date must be in the future" });
    expect(err.fieldErrors?.[1].errorMessage.length).toBe(201);
    expect(err.fieldErrors?.[2]).toEqual({ fieldName: "", errorMessage: "" });
  });

  it("429 → rate_limited with retry-after seconds; non-numeric retry-after ignored", async () => {
    const a = client(() => new Response(null, { status: 429, headers: { "retry-after": "30" } }));
    expect(await failure(a.http.getJson("op", "/x", "/x", undefined, anyJson))).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 30 });
    const b = client(() => new Response(null, { status: 429, headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" } }));
    expect((await failure(b.http.getJson("op", "/x", "/x", undefined, anyJson))).retryAfterSeconds).toBeUndefined();
  });

  it("302 and other non-2xx statuses → unexpected_status", async () => {
    for (const status of [302, 308, 409]) {
      const { http } = client(() => new Response(null, { status, headers: status < 400 ? { location: "https://evil.example/" } : {} }));
      expect(await failure(http.getJson("op", "/x", "/x", undefined, anyJson))).toMatchObject({ kind: "unexpected_status", status });
    }
  });

  it("fetch rejecting with TypeError → network; the underlying error (which may carry the URL/key) is not attached", async () => {
    const { http, events } = client(() => {
      throw new TypeError(`fetch failed for ${BASE}/balance with Bearer ${KEY}`);
    });
    const err = await failure(http.getJson("balance", "/balance", "/balance", undefined, anyJson));
    expect(err).toMatchObject({ kind: "network", status: null });
    expect((err as { cause?: unknown }).cause).toBeUndefined();
    expect(events).toEqual([expect.objectContaining({ outcome: "network", status: null, bytes: null })]);
    expectNoKey(err, events);
  });

  it("fetch rejecting with a TimeoutError or AbortError DOMException → timeout", async () => {
    for (const name of ["TimeoutError", "AbortError"]) {
      const { http, events } = client(() => {
        throw new DOMException(`The operation timed out (${KEY})`, name);
      });
      const err = await failure(http.getJson("balance", "/balance", "/balance", undefined, anyJson));
      expect(err.kind).toBe("timeout");
      expect(events[0].outcome).toBe("timeout");
      expectNoKey(err, events);
    }
  });

  it("200 with a non-JSON or empty body → invalid_response", async () => {
    for (const body of ["<html>oops</html>", "", "   "]) {
      const { http, events } = client(() => new Response(body, { status: 200 }));
      const err = await failure(http.getJson("balance", "/balance", "/balance", undefined, anyJson));
      expect(err).toMatchObject({ kind: "invalid_response", status: 200 });
      expect(err.message).toContain("not JSON");
      expect(events[0].outcome).toBe("invalid_response");
    }
  });

  it("schema mismatch → invalid_response with issue paths and codes, not values", async () => {
    const { http, events } = client(() => json({ id: "seventy-seven", balance: 1, payableBalance: 2 }));
    const err = await failure(http.getJson("balance", "/balance", "/balance", undefined, balanceWire));
    expect(err.kind).toBe("invalid_response");
    expect(err.issues).toEqual(expect.arrayContaining(["id: invalid_type", "creditFacility: invalid_type"]));
    expect(JSON.stringify(err)).not.toContain("seventy-seven");
    expect(events[0].outcome).toBe("invalid_response");
    const root = client(() => json("a string"));
    expect((await failure(root.http.getJson("balance", "/balance", "/balance", undefined, balanceWire))).issues?.[0]).toMatch(/^\(root\): /);
  });

  it("oversize via declared content-length is refused before reading", async () => {
    const { http, events } = client(() => new Response("[]", { status: 200, headers: { "content-length": "1000" } }), { maxResponseBytes: 10 });
    const err = await failure(http.getJson("tours.list", "/tours", "/tours", undefined, anyJson));
    expect(err.kind).toBe("invalid_response");
    expect(err.message).toContain("too large");
    expect(events[0]).toMatchObject({ outcome: "invalid_response", bytes: null });
  });

  it("oversize via a streamed body without content-length is refused and the stream cancelled", async () => {
    let cancelled = false;
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(enc.encode('"aaaaaaaa'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { http } = client(() => new Response(stream, { status: 200 }), { maxResponseBytes: 32 });
    const err = await failure(http.getJson("tours.list", "/tours", "/tours", undefined, anyJson));
    expect(err.kind).toBe("invalid_response");
    expect(err.message).toContain("too large");
    expect(cancelled).toBe(true);
  });

  it("a body exactly at the cap is accepted", async () => {
    const body = JSON.stringify("x".repeat(8)); // 10 bytes
    const { http } = client(() => new Response(body, { status: 200 }), { maxResponseBytes: 10 });
    await expect(http.getJson("op", "/x", "/x", undefined, anyJson)).resolves.toBe("x".repeat(8));
  });
});

describe("TravelDeskHttp — events", () => {
  it("emits one event per call with the path template only — no concrete id, no query, no key", async () => {
    let t = 5_000;
    const { http, events } = client(
      () => {
        t += 42;
        return json(BALANCE);
      },
      { now: () => t },
    );
    await http.getJson("tours.get", "/tours/{Id}", "/tours/98765", { CurrencyCode: "AED", Language: "secret-lang" }, anyJson);
    expect(events).toEqual([
      { operation: "tours.get", method: "GET", pathTemplate: "/tours/{Id}", environment: "test", status: 200, durationMs: 42, outcome: "ok", bytes: JSON.stringify(BALANCE).length, serverDate: null },
    ]);
    const s = JSON.stringify(events);
    expect(s).not.toContain("98765");
    expect(s).not.toContain("CurrencyCode");
    expect(s).not.toContain("secret-lang");
    expect(s).not.toContain("testapi");
    expectNoKey(null, events);
  });

  it("emits exactly one event on failure too", async () => {
    const { http, events } = client(() => new Response("nope", { status: 400 }));
    await failure(http.getJson("op", "/x", "/x", undefined, anyJson));
    expect(events).toHaveLength(1);
  });
});

describe("TravelDeskHttp — concurrency", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("maxConcurrent 1 serialises calls", async () => {
    const pending = [deferred<Response>(), deferred<Response>()];
    let i = 0;
    const { http, calls } = client(() => pending[i++].promise, { maxConcurrent: 1 });
    const a = http.getJson("a", "/a", "/a", undefined, anyJson);
    const b = http.getJson("b", "/b", "/b", undefined, anyJson);
    await tick();
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/a`]);
    pending[0].resolve(json({ n: 1 }));
    await expect(a).resolves.toEqual({ n: 1 });
    await tick();
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/a`, `${BASE}/b`]);
    pending[1].resolve(json({ n: 2 }));
    await expect(b).resolves.toEqual({ n: 2 });
  });

  it("a caller arriving while a slot is handed over cannot exceed the limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const { http } = client(
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((r) => release.push(r));
        inFlight -= 1;
        return json({});
      },
      { maxConcurrent: 1, maxQueued: 100 },
    );
    const a = http.getJson("a", "/a", "/a", undefined, anyJson);
    const b = http.getJson("b", "/b", "/b", undefined, anyJson);
    await tick();
    release.shift()!();
    // Start callers after 0..59 microtask hops, so at least one lands in the gap
    // between A's completion and B's wake-up.
    const late: Promise<unknown>[] = [];
    for (let hop = 0; hop < 60; hop++) {
      let p: Promise<void> = Promise.resolve();
      for (let n = 0; n < hop; n++) p = p.then(() => {});
      late.push(p.then(() => http.getJson(`c${hop}`, "/c", "/c", undefined, anyJson)));
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(peak).toBe(1);
    while (release.length) {
      release.shift()!();
      await new Promise((r) => setTimeout(r, 1));
    }
    await Promise.all([a, b, ...late]);
    expect(peak).toBe(1);
  });

  it("a full queue fails fast as busy without sending anything", async () => {
    const hold = deferred<Response>();
    const { http, calls } = client(() => hold.promise, { maxConcurrent: 1, maxQueued: 1 });
    const a = http.getJson("a", "/a", "/a", undefined, anyJson);
    const b = http.getJson("b", "/b", "/b", undefined, anyJson);
    const c = await failure(http.getJson("c", "/c", "/c", undefined, anyJson));
    expect(c.kind).toBe("busy");
    hold.resolve(json({}));
    await a;
    await b.catch(() => {});
    expect(calls.map((x) => x.url)).not.toContain(`${BASE}/c`);
  });

  it("waiting for a slot counts against the read timeout", async () => {
    const short = { ...config, readTimeoutMs: 20 };
    const hold = deferred<Response>();
    const http = new TravelDeskHttp(short, { fetch: (() => hold.promise) as unknown as typeof fetch, maxConcurrent: 1 });
    const a = http.getJson("a", "/a", "/a", undefined, anyJson);
    const b = await failure(http.getJson("b", "/b", "/b", undefined, anyJson));
    expect(b.kind).toBe("timeout");
    hold.resolve(json({}));
    await a.catch(() => {});
  });

  it("a failed call releases its slot", async () => {
    let i = 0;
    const { http, calls } = client(
      () => {
        i += 1;
        if (i === 1) throw new TypeError("fetch failed");
        return json({ ok: true });
      },
      { maxConcurrent: 1 },
    );
    const a = http.getJson("a", "/a", "/a", undefined, anyJson);
    const b = http.getJson("b", "/b", "/b", undefined, anyJson);
    await expect(a).rejects.toMatchObject({ kind: "network" });
    await expect(b).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("default concurrency allows two in flight", async () => {
    const pending = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    let i = 0;
    const { http, calls } = client(() => pending[i++].promise);
    const ps = [0, 1, 2].map((n) => http.getJson(`op${n}`, "/x", `/x${n}`, undefined, anyJson));
    await tick();
    expect(calls).toHaveLength(2);
    pending[0].resolve(json(0));
    pending[1].resolve(json(1));
    await tick();
    pending[2].resolve(json(2));
    await expect(Promise.all(ps)).resolves.toEqual([0, 1, 2]);
    expect(calls).toHaveLength(3);
  });
});

describe("postJson mutation gate", () => {
  const body = { id: 1 };

  it("refuses before any request when bookings are disabled, in production, or the base URL does not match", async () => {
    const { fn, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
    const cases: TravelDeskConfig[] = [
      config, // bookingsEnabled false
      { ...config, environment: "production", bookingsEnabled: true },
      // Production on its own base URL, bookings on, but no agency pinned (§32.46).
      { ...config, environment: "production", host: "api.traveldesk.me", baseUrl: "https://api.traveldesk.me/public/b2b/v1", bookingsEnabled: true, agencyId: null },
      { ...config, bookingsEnabled: true, baseUrl: "https://api.traveldesk.me/public/b2b/v1" },
    ];
    for (const c of cases) {
      const err = await new TravelDeskHttp(c, { fetch: fn }).postJson("bookings.cancel", "/bookings/cancel", "/bookings/cancel", body, anyJson).catch((e) => e);
      expect(isTravelDeskApiError(err) && err.kind).toBe("refused");
    }
    expect(calls).toHaveLength(0);
  });

  it("production with bookings on and the agency pinned sends to the production host only", async () => {
    const { fn, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
    const prod: TravelDeskConfig = { ...config, environment: "production", host: "api.traveldesk.me", baseUrl: "https://api.traveldesk.me/public/b2b/v1", bookingsEnabled: true, agencyId: "7001" };
    await new TravelDeskHttp(prod, { fetch: fn }).postJson("bookings.cancel", "/bookings/cancel", "/bookings/cancel", body, anyJson);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.startsWith("https://api.traveldesk.me/public/b2b/v1/")).toBe(true);
  });

  it("a POST that cannot get a slot in time is busy and never sent (SUP-18)", async () => {
    let release: (r: Response) => void = () => {};
    const held = new Promise<Response>((r) => (release = r));
    const { fn, calls } = fakeFetch(() => held);
    const http = new TravelDeskHttp({ ...config, bookingsEnabled: true }, { fetch: fn, maxConcurrent: 1, postQueueWaitMs: 10 });
    const first = http.getJson("a", "/a", "/a", undefined, anyJson);
    const err = await http.postJson("bookings.confirm", "/bookings/confirm", "/bookings/confirm", body, anyJson).catch((e) => e);
    expect(isTravelDeskApiError(err) && err.kind).toBe("busy");
    expect(calls).toHaveLength(1);
    release(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    await first;
  });

  it("records the response Date header on the call event (SUP-21)", async () => {
    const events: TravelDeskCallEvent[] = [];
    const { fn } = fakeFetch(() => new Response("{}", { status: 200, headers: { "content-type": "application/json", date: "Sun, 01 Nov 2026 08:00:05 GMT" } }));
    await new TravelDeskHttp({ ...config, bookingsEnabled: true }, { fetch: fn, onEvent: (e) => events.push(e) }).postJson("bookings.cancel", "/bookings/cancel", "/bookings/cancel", body, anyJson);
    expect(events[0].serverDate).toBe("Sun, 01 Nov 2026 08:00:05 GMT");
  });

  it("sends a JSON POST when the test environment has bookings enabled", async () => {
    const { fn, calls } = fakeFetch(() => new Response(JSON.stringify({ isSuccess: true }), { status: 200, headers: { "content-type": "application/json" } }));
    await new TravelDeskHttp({ ...config, bookingsEnabled: true }, { fetch: fn }).postJson("bookings.cancel", "/bookings/cancel", "/bookings/cancel", body, anyJson);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.body).toBe(JSON.stringify(body));
  });
});
