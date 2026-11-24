import { describe, expect, it } from "vitest";
import { IssuedTicketSet } from "../../documents/contracts";
import type { TravelDeskBooking } from "../traveldesk/traveldesk.booking";
import { traveldeskConfigFrom, type TravelDeskConfig } from "../traveldesk/traveldesk.config";
import { TravelDeskDocumentSource, type TravelDeskDocumentTransport } from "../traveldesk/traveldesk.documents";
import { isTravelDeskApiError, TravelDeskApiError, TravelDeskHttp, type TravelDeskCallEvent, type TravelDeskHttpOptions } from "../traveldesk/traveldesk.http";

/**
 * The deliberate document step (B4, TKT-1, TKT-9, SUP-4): get-by-id with its
 * ticket data and the tickets PDF, both from a fixed path on the configured
 * base URL. Fake transport and fake fetch only; synthetic bytes and codes.
 */

const KEY = "test-key-not-real";
const BASE = "https://testapi.traveldesk.me/public/b2b/v1";
const config = traveldeskConfigFrom({
  SUPPLIER_ADAPTER_TRAVELDESK: "live",
  TRAVELDESK_ENV: "test",
  TRAVELDESK_API_BASE_URL: BASE,
  TRAVELDESK_API_KEY: KEY,
}) as TravelDeskConfig;

const PDF = new TextEncoder().encode("%PDF-1.7\nsynthetic tickets\n%%EOF");
const CODE = "SYNTH-CODE-DOC-0001";

function booking(over: Partial<TravelDeskBooking> = {}): TravelDeskBooking {
  return {
    supplierBookingId: "4321",
    status: 1,
    statusName: "PendingVerification",
    bookingReference: "OUTTD-DOC",
    serviceDate: "2026-11-10",
    offerId: 77,
    tourId: 5,
    bookingType: 2,
    timeSlotId: null,
    startMinutes: null,
    adults: 1,
    children: 0,
    infants: 0,
    totalCostMinor: 12_000n,
    totalCostUsdMinor: 3_300n,
    paidFromBalanceMinor: 12_000n,
    refundMinor: null,
    reservationDeadline: null,
    reservationTimeout: null,
    externalInProgress: false,
    externalFailed: false,
    externalFailureMessage: null,
    voucherNotReady: false,
    hasTickets: true,
    creationState: null,
    ...over,
  };
}

const ticketSet = () => new IssuedTicketSet([{ unitIndex: 0, ticketFor: "adult", ticketTypeId: "11", ticketTypeName: "Adult", displayType: 1, code: CODE, validUntil: null }], "document_read");

function fakeTransport(over: Partial<TravelDeskDocumentTransport> = {}): TravelDeskDocumentTransport {
  return {
    readTicketsById: async () => ({ booking: booking(), tickets: { kind: "issued", set: ticketSet() } }),
    downloadTickets: async () => ({ bytes: PDF, contentType: "application/octet-stream" }),
    downloadVoucher: async () => ({ bytes: PDF, contentType: "application/octet-stream" }),
    ...over,
  };
}

const throwing = (e: unknown) => async () => {
  throw e;
};

describe("TravelDeskDocumentSource", () => {
  it("names itself and leaves Q-T1 open", () => {
    const s = new TravelDeskDocumentSource(fakeTransport());
    expect(s.supplierCode).toBe("traveldesk");
    expect(s.documentReadIssuesTickets).toBe("unknown");
  });

  it("readTickets returns the answer's identity and its ticket evidence", async () => {
    const out = await new TravelDeskDocumentSource(fakeTransport()).readTickets("4321");
    expect(out.kind).toBe("found");
    if (out.kind !== "found") return;
    expect(out.identity).toEqual({ supplierBookingId: "4321", bookingReference: "OUTTD-DOC", serviceDate: "2026-11-10", offerExternalId: "77" });
    expect(out.evidence.kind === "issued" && out.evidence.set.tickets()[0].code).toBe(CODE);
    expect(JSON.stringify(out)).not.toContain(CODE);
  });

  it("readTickets passes none and malformed through unchanged", async () => {
    for (const tickets of [{ kind: "none" } as const, { kind: "malformed", source: "document_read", reason: "tickets_empty" } as const]) {
      const out = await new TravelDeskDocumentSource(fakeTransport({ readTicketsById: async () => ({ booking: booking(), tickets }) })).readTickets("4321");
      expect(out.kind === "found" && out.evidence).toEqual(tickets);
    }
  });

  it("readTickets: 404 is not_found, other errors fail with their kind", async () => {
    const src = (e: unknown) => new TravelDeskDocumentSource(fakeTransport({ readTicketsById: throwing(e) }));
    expect(await src(new TravelDeskApiError("not_found", "bookings.get", { status: 404 })).readTickets("4321")).toEqual({ kind: "not_found" });
    expect(await src(new TravelDeskApiError("server", "bookings.get", { status: 503 })).readTickets("4321")).toEqual({ kind: "failed", reason: "server" });
    expect(await src(new TravelDeskApiError("timeout", "bookings.get")).readTickets("4321")).toEqual({ kind: "failed", reason: "timeout" });
    expect(await src(new TravelDeskApiError("refused", "bookings.get")).readTickets("abc")).toEqual({ kind: "failed", reason: "refused" });
    expect(await src(new Error("boom")).readTickets("4321")).toEqual({ kind: "failed", reason: "internal" });
  });

  it("fetchTicketsPdf maps ok, too large, not ready and failures", async () => {
    let asked: unknown = null;
    const ok = new TravelDeskDocumentSource(
      fakeTransport({
        downloadTickets: async (id, opts) => {
          asked = { id, opts };
          return { bytes: PDF, contentType: "image/jpeg" };
        },
      }),
    );
    expect(await ok.fetchTicketsPdf("4321", { maxBytes: 5_000 })).toEqual({ kind: "ok", bytes: PDF, declaredType: "image/jpeg" });
    expect(asked).toEqual({ id: "4321", opts: { maxBytes: 5_000 } });

    const src = (e: unknown) => new TravelDeskDocumentSource(fakeTransport({ downloadTickets: throwing(e) }));
    const cases: [unknown, unknown][] = [
      [new TravelDeskApiError("invalid_response", "bookings.downloadtickets", { status: 200, tooLarge: true }), { kind: "too_large" }],
      [new TravelDeskApiError("invalid_response", "bookings.downloadtickets", { status: 200 }), { kind: "failed", reason: "invalid_response" }],
      [new TravelDeskApiError("not_found", "bookings.downloadtickets", { status: 404 }), { kind: "not_ready" }],
      [new TravelDeskApiError("bad_request", "bookings.downloadtickets", { status: 400, reason: "Tickets are not ready" }), { kind: "not_ready" }],
      [new TravelDeskApiError("auth", "bookings.downloadtickets", { status: 403 }), { kind: "failed", reason: "auth" }],
      [new TravelDeskApiError("unexpected_status", "bookings.downloadtickets", { status: 302 }), { kind: "failed", reason: "unexpected_status" }],
      [new TravelDeskApiError("timeout", "bookings.downloadtickets"), { kind: "failed", reason: "timeout" }],
      [new Error("boom"), { kind: "failed", reason: "internal" }],
    ];
    for (const [err, want] of cases) expect(await src(err).fetchTicketsPdf("4321", { maxBytes: 5_000 })).toEqual(want);

    const empty = new TravelDeskDocumentSource(fakeTransport({ downloadTickets: async () => ({ bytes: new Uint8Array(0), contentType: "application/pdf" }) }));
    expect(await empty.fetchTicketsPdf("4321", { maxBytes: 5_000 })).toEqual({ kind: "failed", reason: "empty_body" });
  });
});

/* ---------------------------------------------------------------------------
 * The live source over a fake fetch
 * ------------------------------------------------------------------------ */

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

function liveSource(respond: (url: string, init: RequestInit) => Response | Promise<Response>, opts: TravelDeskHttpOptions = {}, cfg: TravelDeskConfig = config) {
  const f = fakeFetch(respond);
  const events: TravelDeskCallEvent[] = [];
  const source = TravelDeskDocumentSource.fromConfig(cfg, { fetch: f.fn, onEvent: (e) => events.push(e), ...opts });
  return { source, calls: f.calls, events };
}

const EVIL = "https://elsewhere.example/steal";
const WIRE = {
  id: 4321,
  date: "2026-11-10T00:00:00",
  offerId: 77,
  bookingType: 2,
  bookingReference: "OUTTD-DOC",
  tourId: 5,
  adults: 1,
  children: 0,
  infants: 0,
  totalCost: 120,
  totalCostUsd: 33,
  status: 1,
  downloadTicketsUrl: `${EVIL}/downloadtickets`,
  downloadVoucherUrl: `${EVIL}/downloadvoucher?Guid=0f8fad5b-d9cb-469f-a165-70867728950e`,
  ticketsDetails: { tickets: [{ code: CODE, ticketFor: "Adult", downloadCodeLink: `${EVIL}/downloadcode?Code=U1lOVEg=`, isSent: true }] },
};

describe("TravelDeskDocumentSource over the live client", () => {
  it("reads get-by-id, then fetches the PDF from the fixed path, never from a URL in the answer", async () => {
    const { source, calls, events } = liveSource((url) =>
      url.endsWith("/downloadtickets") ? new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } }) : Response.json(WIRE),
    );
    const read = await source.readTickets("4321");
    expect(read.kind === "found" && read.evidence.kind).toBe("issued");
    const pdf = await source.fetchTicketsPdf("4321", { maxBytes: 10_000 });
    expect(pdf).toEqual({ kind: "ok", bytes: PDF, declaredType: "application/pdf" });

    expect(calls.map((c) => c.url)).toEqual([`${BASE}/bookings/4321`, `${BASE}/bookings/4321/downloadtickets`]);
    for (const c of calls) {
      expect(c.url).not.toContain("elsewhere.example");
      expect(c.init.method).toBe("GET");
      expect(c.init.redirect).toBe("error");
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(c.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    }
    expect(new Headers(calls[1].init.headers).get("accept")).toContain("application/pdf");
    expect(events.map((e) => [e.operation, e.pathTemplate, e.outcome, e.bytes])).toEqual([
      ["bookings.get", "/bookings/{Id}", "ok", JSON.stringify(WIRE).length],
      ["bookings.downloadtickets", "/bookings/{Id}/downloadtickets", "ok", PDF.byteLength],
    ]);
    const logged = JSON.stringify(events);
    for (const f of ["4321", KEY, CODE, "elsewhere", "testapi"]) expect(logged).not.toContain(f);
  });

  it("fetches the voucher from the fixed path with the key, never from the voucher URL in the answer", async () => {
    const { source, calls, events } = liveSource((url) =>
      url.endsWith("/downloadvoucher") ? new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } }) : Response.json(WIRE),
    );
    expect(await source.fetchVoucherPdf("4321", { maxBytes: 10_000 })).toEqual({ kind: "ok", bytes: PDF, declaredType: "application/pdf" });
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/bookings/4321/downloadvoucher`]);
    expect(calls[0].init.redirect).toBe("error");
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(events.map((e) => [e.operation, e.pathTemplate, e.outcome])).toEqual([["bookings.downloadvoucher", "/bookings/{Id}/downloadvoucher", "ok"]]);
    for (const f of ["4321", KEY, "Guid", "elsewhere"]) expect(JSON.stringify(events)).not.toContain(f);

    const notYet = liveSource(() => new Response("", { status: 404 }));
    expect(await notYet.source.fetchVoucherPdf("4321", { maxBytes: 1_000 })).toEqual({ kind: "not_ready" });
    // TravelDesk answers 502 while an external voucher is not ready (doc 22 §32.32); the tickets download keeps 502 a failure.
    const external = liveSource(() => new Response("", { status: 502 }));
    expect(await external.source.fetchVoucherPdf("4321", { maxBytes: 1_000 })).toEqual({ kind: "not_ready" });
    expect((await external.source.fetchTicketsPdf("4321", { maxBytes: 1_000 })).kind).toBe("failed");
    const tooBig = liveSource(() => new Response(PDF, { status: 200 }));
    expect(await tooBig.source.fetchVoucherPdf("4321", { maxBytes: 4 })).toEqual({ kind: "too_large" });
  });

  it("a 404 or 400 on the download is not ready; a 404 on the read is not found", async () => {
    const notFound = liveSource(() => new Response("", { status: 404 }));
    expect(await notFound.source.readTickets("4321")).toEqual({ kind: "not_found" });
    expect(await notFound.source.fetchTicketsPdf("4321", { maxBytes: 1_000 })).toEqual({ kind: "not_ready" });
    const notYet = liveSource(() => new Response("Tickets are not generated yet", { status: 400 }));
    expect(await notYet.source.fetchTicketsPdf("4321", { maxBytes: 1_000 })).toEqual({ kind: "not_ready" });
  });

  it("a PDF over the cap is too_large, whether declared or streamed", async () => {
    const declared = liveSource(() => new Response(PDF, { status: 200, headers: { "content-length": String(PDF.byteLength) } }));
    expect(await declared.source.fetchTicketsPdf("4321", { maxBytes: PDF.byteLength - 1 })).toEqual({ kind: "too_large" });
    const streamed = liveSource(() => new Response(endless().stream, { status: 200 }));
    expect(await streamed.source.fetchTicketsPdf("4321", { maxBytes: 64 })).toEqual({ kind: "too_large" });
  });
});

/* ---------------------------------------------------------------------------
 * TravelDeskHttp.getBinary
 * ------------------------------------------------------------------------ */

function endless() {
  const state = { cancelled: false, pulled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled += 1;
      controller.enqueue(new Uint8Array(16).fill(0x25));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

function http(respond: (url: string, init: RequestInit) => Response | Promise<Response>, cfg: TravelDeskConfig = config) {
  const f = fakeFetch(respond);
  const events: TravelDeskCallEvent[] = [];
  return { http: new TravelDeskHttp(cfg, { fetch: f.fn, onEvent: (e) => events.push(e) }), calls: f.calls, events };
}

const binary = (h: TravelDeskHttp, maxBytes = 1_000, path = "/bookings/4321/downloadtickets") =>
  h.getBinary("bookings.downloadtickets", "/bookings/{Id}/downloadtickets", path, { maxBytes, accept: "application/pdf" });

async function failure(p: Promise<unknown>): Promise<TravelDeskApiError> {
  try {
    await p;
  } catch (e) {
    expect(isTravelDeskApiError(e)).toBe(true);
    return e as TravelDeskApiError;
  }
  throw new Error("expected a TravelDeskApiError");
}

describe("TravelDeskHttp.getBinary", () => {
  it("returns the raw bytes and Content-Type without parsing them", async () => {
    const notJson = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x7b]);
    const { http: h, calls, events } = http(() => new Response(notJson, { status: 200, headers: { "content-type": "image/jpeg" } }));
    expect(await binary(h)).toEqual({ bytes: notJson, contentType: "image/jpeg" });
    expect(calls[0].url).toBe(`${BASE}/bookings/4321/downloadtickets`);
    expect(new Headers(calls[0].init.headers).get("accept")).toBe("application/pdf");
    expect(events).toEqual([
      { operation: "bookings.downloadtickets", method: "GET", pathTemplate: "/bookings/{Id}/downloadtickets", environment: "test", status: 200, durationMs: expect.any(Number), outcome: "ok", bytes: 7, serverDate: null },
    ]);
  });

  it("refuses a declared size over the cap before reading the body", async () => {
    const e = endless();
    const { http: h, events } = http(() => new Response(e.stream, { status: 200, headers: { "content-length": "5000" } }));
    const err = await failure(binary(h, 1_000));
    expect(err).toMatchObject({ kind: "invalid_response", tooLarge: true });
    expect(err.message).toContain("too large");
    expect(e.state.cancelled).toBe(true);
    expect(events[0]).toMatchObject({ outcome: "invalid_response", bytes: null });
  });

  it("refuses a streamed body once it passes the cap, and cancels the stream", async () => {
    const e = endless();
    const { http: h } = http(() => new Response(e.stream, { status: 200 }));
    const err = await failure(binary(h, 100));
    expect(err).toMatchObject({ kind: "invalid_response", tooLarge: true });
    expect(e.state.cancelled).toBe(true);
    expect(e.state.pulled).toBeLessThan(20);
  });

  it("accepts a body exactly at the cap", async () => {
    const { http: h } = http(() => new Response(PDF, { status: 200 }));
    expect((await binary(h, PDF.byteLength)).bytes).toEqual(PDF);
  });

  it("refuses redirects: redirect mode is error, a 3xx is never followed, a followed answer is never read", async () => {
    const r302 = http(() => new Response(null, { status: 302, headers: { location: EVIL } }));
    const err = await failure(binary(r302.http));
    expect(err).toMatchObject({ kind: "unexpected_status", status: 302 });
    expect(r302.calls).toHaveLength(1);
    expect(r302.calls[0].init.redirect).toBe("error");

    // What a conforming fetch does with redirect: "error".
    const rejected = http(() => Promise.reject(new TypeError(`fetch failed: redirect to ${EVIL}`)));
    const net = await failure(binary(rejected.http));
    expect(net.kind).toBe("network");
    expect(JSON.stringify(net) + net.message).not.toContain("elsewhere");

    // A fetch that followed anyway is refused, not read.
    const followed = http(() => {
      const res = new Response(PDF, { status: 200 });
      Object.defineProperty(res, "redirected", { value: true });
      return res;
    });
    const f = await failure(binary(followed.http));
    expect(f.kind).toBe("unexpected_status");
    expect(f.message).toContain("redirect refused");
  });

  it("times out on the read timeout", async () => {
    const quick = { ...config, readTimeoutMs: 20 };
    const { http: h, events } = http(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
      quick,
    );
    const err = await failure(binary(h));
    expect(err.kind).toBe("timeout");
    expect(events[0].outcome).toBe("timeout");
  });

  it("a body that stalls and is aborted mid-stream is a timeout", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x25]));
        controller.error(new DOMException("The operation timed out.", "TimeoutError"));
      },
    });
    const { http: h } = http(() => new Response(stalled, { status: 200 }));
    expect((await failure(binary(h))).kind).toBe("timeout");
  });

  it("only ever fetches the configured base plus a fixed path", async () => {
    const { http: h, calls } = http(() => new Response(PDF, { status: 200 }));
    for (const path of [EVIL, "//elsewhere.example/x", "/bookings/4321/downloadtickets?Guid=x", "/bookings/../balance", "/bookings/4321/downloadtickets#x", "bookings/4321", "/public/b2b/v1/bookings/4321"]) {
      const err = await failure(binary(h, 1_000, path));
      expect(err.kind).toBe("refused");
    }
    for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect((await failure(binary(h, maxBytes))).kind).toBe("refused");
    expect(calls).toHaveLength(0);
  });

  it("classifies error statuses like getJson, keeping a short reason only", async () => {
    const cases: [Response, string][] = [
      [new Response("", { status: 401 }), "auth"],
      [new Response("Booking not found", { status: 404 }), "not_found"],
      [new Response("x".repeat(500), { status: 400 }), "bad_request"],
      [new Response("", { status: 503 }), "server"],
    ];
    for (const [res, kind] of cases) {
      const { http: h } = http(() => res);
      const err = await failure(binary(h));
      expect(err.kind).toBe(kind);
      expect((err.reason ?? "").length).toBeLessThanOrEqual(201);
    }
    // A huge error body is read only up to the error cap; the status still decides.
    const e = endless();
    const { http: h } = http(() => new Response(e.stream, { status: 404 }));
    expect((await failure(binary(h, 10_000_000))).kind).toBe("not_found");
    expect(e.state.cancelled).toBe(true);
  });

  it("the key never reaches an error or an event", async () => {
    const { http: h, events } = http(() => new Response(`bad key ${KEY.slice(0, 3)}`, { status: 403 }));
    const err = await failure(binary(h));
    expect(JSON.stringify(err) + err.message + String(err.stack)).not.toContain(KEY);
    expect(JSON.stringify(events)).not.toContain(KEY);
  });
});
