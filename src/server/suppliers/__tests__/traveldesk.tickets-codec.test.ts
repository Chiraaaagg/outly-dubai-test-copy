import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { IssuedTicketSet, type TicketEvidence } from "../../documents/contracts";
import { bookingFrom, bookingWire, sanitiseBooking, TravelDeskBookingClient, ticketEvidenceFrom } from "../traveldesk/traveldesk.booking";
import { traveldeskConfigFrom, type TravelDeskConfig } from "../traveldesk/traveldesk.config";
import { isTravelDeskApiError, type TravelDeskCallEvent } from "../traveldesk/traveldesk.http";

/**
 * TKT-1, TKT-9: `ticketsDetails` from confirm, create and get-by-id answers
 * parsed into ticket evidence beside the booking, never inside it. Synthetic
 * codes and hosts only; a fake fetch, no network.
 */

const BASE = "https://testapi.traveldesk.me/public/b2b/v1";
const config = {
  ...(traveldeskConfigFrom({
    SUPPLIER_ADAPTER_TRAVELDESK: "live",
    TRAVELDESK_ENV: "test",
    TRAVELDESK_API_BASE_URL: BASE,
    TRAVELDESK_API_KEY: "test-key-not-real",
  }) as TravelDeskConfig),
  bookingsEnabled: true,
};

/** Synthetic admission codes. None of them may appear in anything serialised. */
const CODES = ["SYNTH-CODE-ALPHA-0001", "SYNTH-CODE-BRAVO-0002", "SYNTH-CODE-CHARLIE-0003"];
const GUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CODE_LINK = (code: string) => `https://testapi.traveldesk.me/public/b2b/v1/bookings/downloadcode?Code=${Buffer.from(code).toString("base64")}&DisplayType=1`;

const BOOKING = {
  id: 4321,
  date: "2026-11-10T00:00:00",
  offerId: 77,
  bookingType: 2,
  bookingReference: "OUTTD-TKT1",
  tourId: 5,
  adults: 2,
  children: 1,
  infants: 0,
  totalCost: 240,
  totalCostUsd: 66,
  totalPaidFromBalance: 240,
  status: 1,
  isExternalConfirmationInProgress: false,
  isExternalBookingFailed: false,
  hasTickets: true,
  downloadVoucherUrl: `https://testapi.traveldesk.me/public/b2b/v1/bookings/4321/downloadvoucher?Guid=${GUID}`,
  downloadTicketsUrl: "https://elsewhere.example/bookings/4321/downloadtickets",
  guid: GUID,
};

function unit(code: unknown, over: Record<string, unknown> = {}) {
  return {
    code,
    ticketFor: "Adult",
    ticketTypeId: 11,
    ticketTypeName: "Adult admission",
    ticketCodeDisplayType: 1,
    downloadCodeLink: typeof code === "string" ? CODE_LINK(code) : null,
    isSent: false,
    validUntil: "2026-11-10T23:59:00",
    ...over,
  };
}

const DETAILS = {
  code: "SYNTH-BOOKING-LEVEL-CODE",
  title: "Synthetic tickets",
  ticketCodeDisplayType: 1,
  tickets: [unit(CODES[0]), unit(CODES[1], { ticketTypeId: "12" }), unit(CODES[2], { ticketFor: "CHILD", ticketTypeId: 13, ticketTypeName: "Child admission" })],
};

/** Everything a serialised value must never contain. */
const FORBIDDEN = [...CODES, "SYNTH-BOOKING-LEVEL-CODE", "downloadCodeLink", "downloadcode", "Guid=", GUID, "http://", "https://", "elsewhere.example", ...CODES.map((c) => Buffer.from(c).toString("base64"))];

function expectClean(serialised: string) {
  for (const f of FORBIDDEN) expect(serialised).not.toContain(f);
}

function stringify(v: unknown) {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}

function issued(e: TicketEvidence): IssuedTicketSet {
  if (e.kind !== "issued") throw new Error(`expected issued evidence, got ${e.kind}`);
  return e.set;
}

describe("ticketEvidenceFrom", () => {
  it("parses every unit's code into a set, counted by unit", () => {
    const set = issued(ticketEvidenceFrom(DETAILS, "confirm_response"));
    expect(set.source).toBe("confirm_response");
    expect(set.count).toBe(3);
    expect(set.units()).toEqual({ adult: 2, child: 1, infant: 0, unknown: 0 });
    expect(set.tickets().map((t) => t.code)).toEqual(CODES);
    expect(set.tickets()[0]).toEqual({
      unitIndex: 0,
      ticketFor: "adult",
      ticketTypeId: "11",
      ticketTypeName: "Adult admission",
      displayType: 1,
      code: CODES[0],
      validUntil: "2026-11-10T23:59:00.000Z",
    });
    expect(set.tickets()[1].ticketTypeId).toBe("12");
    expect(set.tickets()[2]).toMatchObject({ unitIndex: 2, ticketFor: "child", ticketTypeId: "13" });
  });

  it("keeps no link, Guid, sent flag or booking-level code", () => {
    const set = issued(ticketEvidenceFrom({ ...DETAILS, guid: GUID, downloadUrl: CODE_LINK("x") }, "create_response"));
    for (const t of set.tickets()) expect(Object.keys(t).sort()).toEqual(["code", "displayType", "ticketFor", "ticketTypeId", "ticketTypeName", "unitIndex", "validUntil"]);
    expectClean(stringify(set.tickets().map(({ code: _code, ...rest }) => rest)));
  });

  it("maps exact adult, child and infant names and the integer codes 0, 1, 2 (TEST drill); anything else is unknown", () => {
    const fors: unknown[] = ["adult", "ADULT", "Child", "infant", " adult", "adults", "Senior", 0, 1, 2, 3, -1, 1.5, "0", null, undefined, true];
    const set = issued(ticketEvidenceFrom({ tickets: fors.map((f, i) => unit(`SYNTH-${i}`, { ticketFor: f })) }, "document_read"));
    expect(set.tickets().map((t) => t.ticketFor)).toEqual([
      "adult", "adult", "child", "infant", "unknown", "unknown", "unknown",
      "adult", "child", "infant", "unknown", "unknown", "unknown", "unknown",
      "unknown", "unknown", "unknown",
    ]);
    expect(set.units()).toEqual({ adult: 3, child: 2, infant: 2, unknown: 10 });
  });

  it("reads optional fields leniently: odd types become null, never a failure", () => {
    const set = issued(
      ticketEvidenceFrom(
        {
          tickets: [
            unit("SYNTH-A", { ticketTypeId: true, ticketTypeName: 7, ticketCodeDisplayType: "1", validUntil: 12345 }),
            unit("SYNTH-B", { ticketTypeId: "", ticketTypeName: "  ", ticketCodeDisplayType: null, validUntil: "not a date" }),
            { code: "SYNTH-C" },
            unit("SYNTH-D", { validUntil: "2026-11-10T20:00:00+04:00" }),
          ],
        },
        "confirm_response",
      ),
    );
    const [a, b, c, d] = set.tickets();
    expect(a).toMatchObject({ ticketTypeId: null, ticketTypeName: null, displayType: null, validUntil: null });
    expect(b).toMatchObject({ ticketTypeId: null, ticketTypeName: null, displayType: null, validUntil: null });
    expect(c).toEqual({ unitIndex: 2, ticketFor: "unknown", ticketTypeId: null, ticketTypeName: null, displayType: null, code: "SYNTH-C", validUntil: null });
    expect(d.validUntil).toBe("2026-11-10T16:00:00.000Z");
  });

  it("absent or null ticket data is none", () => {
    expect(ticketEvidenceFrom(undefined, "confirm_response")).toEqual({ kind: "none" });
    expect(ticketEvidenceFrom(null, "confirm_response")).toEqual({ kind: "none" });
  });

  it("present but unreadable ticket data is malformed, with a short reason and no value", () => {
    const cases: [unknown, string][] = [
      ["SYNTH-CODE-ALPHA-0001", "details_not_object"],
      [42, "details_not_object"],
      [[unit("SYNTH-X")], "details_not_object"],
      [{}, "tickets_missing"],
      [{ code: "SYNTH-CODE-ALPHA-0001", tickets: null }, "tickets_missing"],
      [{ tickets: "SYNTH-CODE-ALPHA-0001" }, "tickets_missing"],
      [{ tickets: [] }, "tickets_empty"],
      [{ tickets: ["SYNTH-CODE-ALPHA-0001"] }, "unit_not_object"],
      [{ tickets: [null] }, "unit_not_object"],
      [{ tickets: [[]] }, "unit_not_object"],
      [{ tickets: [unit("SYNTH-OK"), unit(undefined)] }, "code_missing"],
      [{ tickets: [unit("")] }, "code_missing"],
      [{ tickets: [unit("   ")] }, "code_missing"],
      [{ tickets: [unit(12345)] }, "code_missing"],
      [{ tickets: [unit({ value: "SYNTH" })] }, "code_missing"],
      [{ tickets: [unit("x".repeat(1001))] }, "code_too_long"],
      [{ tickets: Array.from({ length: 501 }, (_, i) => unit(`SYNTH-${i}`)) }, "too_many_tickets"],
    ];
    for (const [raw, reason] of cases) {
      const e = ticketEvidenceFrom(raw, "create_response");
      expect(e).toEqual({ kind: "malformed", source: "create_response", reason });
      expectClean(stringify(e));
    }
  });
});

describe("IssuedTicketSet never shows a code", () => {
  it("JSON, String and util.inspect show a count only", () => {
    const set = issued(ticketEvidenceFrom(DETAILS, "confirm_response"));
    const views = [JSON.stringify(set), String(set), `${set}`, inspect(set), inspect({ nested: { set } }, { depth: 10 }), JSON.stringify({ tickets: { kind: "issued", set } })];
    for (const v of views) expectClean(v);
    expect(JSON.parse(JSON.stringify(set))).toEqual({ issuedTickets: 3, source: "confirm_response" });
  });
});

describe("the booking parse is never failed by ticket data", () => {
  const bad: unknown[] = ["SYNTH-CODE-ALPHA-0001", { tickets: [] }, { tickets: [{ code: 5 }] }, 7, [1, 2]];

  it("a confirmed booking with odd ticket data stays a confirmed booking", async () => {
    for (const ticketsDetails of bad) {
      const { client } = clientFor(() => json({ ...BOOKING, ticketsDetails }));
      const a = await client.confirm("4321");
      expect(a.booking).toMatchObject({ supplierBookingId: "4321", status: 1, bookingReference: "OUTTD-TKT1", serviceDate: "2026-11-10" });
      expect(a.tickets.kind).toBe("malformed");
      expectClean(stringify(a));
    }
  });

  it("TravelDeskBooking and sanitiseBooking hold no ticket data, Guid or URL", () => {
    const b = bookingFrom(bookingWire.parse({ ...BOOKING, ticketsDetails: DETAILS }));
    expectClean(stringify(b));
    expectClean(JSON.stringify(sanitiseBooking(b)));
    expect(Object.keys(b)).not.toContain("ticketsDetails");
  });
});

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function clientFor(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const events: TravelDeskCallEvent[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(String(input), init ?? {});
  }) as typeof fetch;
  const client = new TravelDeskBookingClient(config, { fetch: fetchFn, onEvent: (e) => events.push(e) });
  return { client, calls, events };
}

describe("TravelDeskBookingClient answers with ticket evidence", () => {
  it("confirm, create and get-by-id each tag their source", async () => {
    const { client, calls } = clientFor(() => json({ ...BOOKING, ticketsDetails: DETAILS }));
    const confirmed = await client.confirm("4321");
    const created = await client.create({ referenceNumber: "OUTTD-TKT1" });
    const read = await client.readTicketsById("4321");
    expect(issued(confirmed.tickets).source).toBe("confirm_response");
    expect(issued(created.tickets).source).toBe("create_response");
    expect(issued(read.tickets).source).toBe("document_read");
    expect(issued(read.tickets).tickets().map((t) => t.code)).toEqual(CODES);
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["POST", `${BASE}/bookings/confirm`],
      ["POST", `${BASE}/bookings`],
      ["GET", `${BASE}/bookings/4321`],
    ]);
    for (const a of [confirmed, created, read]) {
      expectClean(stringify(a));
      expectClean(stringify(sanitiseBooking(a.booking)));
    }
  });

  it("an answer without ticket data is none", async () => {
    const { client } = clientFor(() => json(BOOKING));
    expect((await client.confirm("4321")).tickets).toEqual({ kind: "none" });
    const { client: nulls } = clientFor(() => json({ ...BOOKING, ticketsDetails: null }));
    expect((await nulls.create({})).tickets).toEqual({ kind: "none" });
  });

  it("the document calls take an integer id only, refused before anything is sent", async () => {
    const { client, calls } = clientFor(() => json(BOOKING));
    for (const id of ["", "0", "-1", "12a", "4321?x=1", "../4321", "1e3", " 4321", "https://elsewhere.example/1"]) {
      const read = await client.readTicketsById(id).catch((e) => e);
      expect(isTravelDeskApiError(read) && read.kind).toBe("refused");
      const pdf = await client.downloadTickets(id, { maxBytes: 1000 }).catch((e) => e);
      expect(isTravelDeskApiError(pdf) && pdf.kind).toBe("refused");
    }
    expect(calls).toHaveLength(0);
  });

  it("call events and errors carry no code", async () => {
    const { client, events } = clientFor(() => json({ ...BOOKING, ticketsDetails: DETAILS }));
    await client.readTicketsById("4321");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: "bookings.get", pathTemplate: "/bookings/{Id}", outcome: "ok" });
    expectClean(JSON.stringify(events));
  });
});
