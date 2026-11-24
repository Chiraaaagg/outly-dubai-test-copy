import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { IssuedTicketSet, type TicketEvidence } from "../../documents/contracts";
import { bookingFrom, bookingWire, type TravelDeskBooking } from "../traveldesk/traveldesk.booking";
import { ANSWERED_UNVERIFIED_REASON } from "../booking-port";
import {
  ANSWERED_UNVERIFIED,
  classifyCancelRefusal,
  mutationHealth,
  READ_BUDGET_REASON,
  SERVER_ERROR_PAGE_REASON,
  type ReadGate,
  snapshotFrom,
  TravelDeskBookingAdapter,
  type TravelDeskBookingTransport,
  travelDeskStatus,
} from "../traveldesk/traveldesk.booking-adapter";
import { TravelDeskApiError } from "../traveldesk/traveldesk.http";

/**
 * TravelDesk behind the engine's adapter contract (SUP-19): statuses, error
 * classes, the cancel 400 texts, funds, the hold cap (CR-9) and the list reads
 * that replace get-by-id (SUP-4, SUP-12). Pure: a scripted transport, no
 * network, synthetic amounts.
 */

const T0 = Date.parse("2026-11-01T08:00:00Z");

function booking(over: Partial<TravelDeskBooking> = {}): TravelDeskBooking {
  return {
    supplierBookingId: "100",
    status: 7,
    statusName: "Prebooked",
    bookingReference: "OUTTD-ABC",
    serviceDate: "2026-11-10",
    offerId: 77,
    tourId: 5,
    bookingType: 1,
    timeSlotId: 9,
    startMinutes: 600,
    adults: 2,
    children: 0,
    infants: 0,
    totalCostMinor: 24_000n,
    totalCostUsdMinor: 6_600n,
    paidFromBalanceMinor: 24_000n,
    refundMinor: null,
    reservationDeadline: new Date(T0 + 15 * 60_000).toISOString(),
    reservationTimeout: 15,
    externalInProgress: false,
    externalFailed: false,
    externalFailureMessage: null,
    voucherNotReady: false,
    hasTickets: false,
    creationState: null,
    ...over,
  };
}

/** A transport whose list pages are scripted per call; every call is recorded. */
function transport(over: Partial<TravelDeskBookingTransport> & { pages?: (call: number, page: number) => { rows: TravelDeskBooking[]; totalCount: number } } = {}) {
  const calls: string[] = [];
  let listCalls = 0;
  // The get-by-id and download methods exist only so a test can prove the adapter never calls them (SUP-4).
  const t: TravelDeskBookingTransport & { getBooking: () => never; readTicketsById: () => never; downloadTickets: () => never; downloadVoucher: () => never } = {
    reserve: async () => booking(),
    confirm: async () => booking({ status: 1, reservationDeadline: null }),
    create: async () => booking({ status: 1, reservationDeadline: null }),
    cancel: async () => ({ isSuccess: true, message: null }),
    getReservation: async () => {
      throw new TravelDeskApiError("bad_request", "bookings.reservation", { status: 400 });
    },
    listBookingsPage: async (_q, page) => {
      listCalls++;
      return over.pages ? over.pages(listCalls, page) : { rows: [], totalCount: 0 };
    },
    getBalance: async () => ({ agencyId: 42, currencyRequested: "AED" as const, balanceMinor: 50_000n, creditFacilityMinor: 100_000n, payableBalanceMinor: 120_000n }),
    getBooking: () => {
      throw new Error("get-by-id must never be called for status");
    },
    readTicketsById: () => {
      throw new Error("get-by-id must never be called for status");
    },
    downloadTickets: () => {
      throw new Error("the tickets download must never be called by the booking adapter");
    },
    downloadVoucher: () => {
      throw new Error("the voucher download must never be called by the booking adapter");
    },
    ...over,
  };
  const recorded = new Proxy(t, {
    get(target, prop) {
      const v = target[prop as keyof typeof target];
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { t: recorded, calls };
}

const ref = { supplierBookingId: "100", serviceDate: "2026-11-10", offerExternalId: "77" };
const adapterFor = (t: TravelDeskBookingTransport) => new TravelDeskBookingAdapter(t, { environment: "test", now: () => new Date(T0) });

describe("TravelDesk statuses as the engine sees them", () => {
  it("maps each status; a final status is only a candidate", () => {
    expect(travelDeskStatus({ status: 7, externalInProgress: false, externalFailed: false })).toBe("ON_HOLD");
    expect(travelDeskStatus({ status: 8, externalInProgress: null, externalFailed: null })).toBe("EXPIRED");
    expect(travelDeskStatus({ status: 4, externalInProgress: null, externalFailed: null })).toBe("CANCELLED");
    expect(travelDeskStatus({ status: 1, externalInProgress: true, externalFailed: false })).toBe("PENDING");
    // Doc 29 Batch 6: while the external confirmation is in progress the booking waits, whatever the failed flag says.
    expect(travelDeskStatus({ status: 1, externalInProgress: true, externalFailed: true })).toBe("PENDING");
    expect(travelDeskStatus({ status: 5, externalInProgress: null, externalFailed: null })).toBe("CONFIRMED");
    for (const s of [2, 3, 6, 99]) expect(travelDeskStatus({ status: s, externalInProgress: false, externalFailed: false })).toBe("UNKNOWN");
  });

  it("payment failed (6, with the supplier's message) and payment required (3) stay unknown; the message is not even decoded (review 85 A9)", () => {
    for (const status of [3, 6]) {
      const s = snapshotFrom(booking({ status }));
      expect(s).toMatchObject({ status: "UNKNOWN", rawStatus: status });
    }
    const decoded = bookingFrom(bookingWire.parse({ id: 1, date: "2026-11-10T00:00:00", offerId: 1, bookingType: 1, tourId: 1, adults: 1, children: 0, infants: 0, totalCost: 1, totalCostUsd: 1, status: 6, paymentErrorMessage: "Insufficient balance" }));
    expect(JSON.stringify(decoded, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("Insufficient");
  });

  it("keeps the raw status in the snapshot for the predicate, and no ticket claim it cannot make", () => {
    const s = snapshotFrom(booking({ status: 5, reservationDeadline: null }));
    expect(s).toMatchObject({ ref: "100", status: "CONFIRMED", rawStatus: 5, holdExpiresAtUtc: null, ticketsIssued: null, chargedNetMinor: 24_000n });
    expect(snapshotFrom(booking({ hasTickets: true })).ticketsIssued).toBe(true);
  });

  it("carries the returned pickup time (doc 29 §8.7) only when TravelDesk gave one", () => {
    expect(snapshotFrom(booking({ status: 5, pickupMinutes: 495 })).pickupMinutes).toBe(495);
    expect(snapshotFrom(booking({ status: 5, pickupMinutes: null }))).not.toHaveProperty("pickupMinutes");
    expect(snapshotFrom(booking({ status: 5 }))).not.toHaveProperty("pickupMinutes");
  });
});

describe("mutation outcomes", () => {
  it("separates never sent, documented refusal and unknown", async () => {
    const cases: [TravelDeskApiError | Error, unknown][] = [
      [new TravelDeskApiError("busy", "bookings.reserve"), { kind: "unknown", sent: false, reason: "busy" }],
      [new TravelDeskApiError("refused", "bookings.reserve"), { kind: "unknown", sent: false, reason: "refused" }],
      [new TravelDeskApiError("auth", "bookings.reserve", { status: 403 }), { kind: "rejected", definite: true, code: "auth" }],
      [new TravelDeskApiError("bad_request", "bookings.reserve", { status: 400, reason: "Bad date" }), { kind: "unknown", sent: true, reason: "bad_request" }],
      [new TravelDeskApiError("timeout", "bookings.reserve"), { kind: "unknown", sent: true, reason: "timeout" }],
      [new Error("socket"), { kind: "unknown", sent: true, reason: "internal" }],
    ];
    for (const [err, want] of cases) {
      const { t } = transport({
        reserve: async () => {
          throw err;
        },
      });
      expect(await adapterFor(t).hold({ clientRef: "OUTTD-ABC", expected: {} as never, body: {} })).toEqual(want);
    }
  });

  it("a wrapped web-server 5xx page is an unknown outcome with its own reason, for reserve, confirm and cancel alike (doc 22 §32.22)", async () => {
    const page = (op: string) => async () => {
      throw new TravelDeskApiError("server", op, { status: 400, serverErrorPage: true });
    };
    const want = { kind: "unknown", sent: true, reason: SERVER_ERROR_PAGE_REASON };
    expect(await adapterFor(transport({ reserve: page("bookings.reserve") }).t).hold({ clientRef: "OUTTD-ABC", expected: {} as never, body: {} })).toEqual(want);
    expect(await adapterFor(transport({ confirm: page("bookings.confirm") }).t).confirm(ref)).toEqual(want);
    // Never read as a cancel refusal: the page is not TravelDesk's answer.
    const cancel = transport({ cancel: page("bookings.cancel") });
    expect(await adapterFor(cancel.t).cancel(ref)).toEqual(want);
    expect(cancel.calls).not.toContain("listBookingsPage");
  });

  it("mutationHealth: only supplier-side failures count as an outage; a processed request is healthy (doc 22 §32.22)", () => {
    const unknown = (reason: string, sent = true) => ({ kind: "unknown" as const, sent, reason });
    for (const r of ["server", SERVER_ERROR_PAGE_REASON, "timeout", "network"]) expect(mutationHealth(unknown(r))).toBe("outage");
    expect(mutationHealth({ kind: "accepted", snapshot: snapshotFrom(booking()) })).toBe("healthy");
    expect(mutationHealth(unknown(ANSWERED_UNVERIFIED))).toBe("healthy");
    // Definite refusals, a 422 (HotelId), a plain 400, an unreadable answer and anything never sent are not outages.
    expect(mutationHealth({ kind: "rejected", definite: true, code: "auth" })).toBe("neutral");
    for (const r of ["validation", "bad_request", "invalid_response", "rate_limited", "internal"]) expect(mutationHealth(unknown(r))).toBe("neutral");
    for (const r of ["busy", "refused", "timeout"]) expect(mutationHealth(unknown(r, false))).toBe("neutral");
  });

  it("a 2xx whose body was lost stays an unknown, sent outcome with its own reason, and is no outage (review P3-4)", async () => {
    for (const [kind, reason] of [["timeout", "body_timeout"], ["network", "body_network"]] as const) {
      const { t } = transport({
        reserve: async () => {
          throw new TravelDeskApiError(kind, "bookings.reserve", { status: 200, bodyLost: true });
        },
      });
      const o = await adapterFor(t).hold({ clientRef: "OUTTD-ABC", expected: {} as never, body: {} });
      expect(o).toEqual({ kind: "unknown", sent: true, reason });
      expect(mutationHealth(o)).toBe("neutral");
    }
  });

  it("caps a hold at the send time plus the reservation timeout (CR-9)", async () => {
    // A deadline without a timezone read as UTC could be hours late; the cap never is.
    const { t } = transport({ reserve: async () => booking({ reservationDeadline: new Date(T0 + 4 * 3600_000).toISOString(), reservationTimeout: 15 }) });
    const o = await adapterFor(t).hold({ clientRef: "OUTTD-ABC", expected: {} as never, body: {} });
    expect(o.kind === "accepted" && o.snapshot.holdExpiresAtUtc).toBe(new Date(T0 + 15 * 60_000).toISOString());
  });

  it("classifies cancel refusals by their text, and never passes the text on (SUP-13, CR-B1-4)", async () => {
    expect(classifyCancelRefusal("Cancellation is not allowed for this booking")).toBe("refused_policy");
    expect(classifyCancelRefusal("Tickets already issued")).toBe("refused_policy");
    expect(classifyCancelRefusal("The booking is past the cancellation deadline")).toBe("refused_policy");
    expect(classifyCancelRefusal("This booking cannot be cancelled")).toBe("refused_policy");
    expect(classifyCancelRefusal("Non-refundable offer")).toBe("refused_policy");
    // The sandbox's own answer past the 100% window (A5 drill CX-6, 3 Nov 2026).
    expect(classifyCancelRefusal("At the moment we can only cancel bookings within the full refund period. Please contact support for partial refund.")).toBe("refused_policy");
    expect(classifyCancelRefusal("Refund period")).toBe("invalid");
    expect(classifyCancelRefusal("Not found")).toBe("not_found");
    expect(classifyCancelRefusal("Booking already cancelled")).toBe("already_cancelled");
    expect(classifyCancelRefusal("Booking has already been cancelled")).toBe("already_cancelled");
    // Mentioning cancel, cannot or allowed is not a policy answer.
    expect(classifyCancelRefusal("Invalid cancel request")).toBe("invalid");
    expect(classifyCancelRefusal("Cannot find booking")).toBe("invalid");
    expect(classifyCancelRefusal("Only one request is allowed at a time")).toBe("invalid");
    expect(classifyCancelRefusal("One or more validation errors occurred.")).toBe("invalid");
    expect(classifyCancelRefusal(undefined)).toBe("invalid");
    const { t } = transport({
      cancel: async () => {
        throw new TravelDeskApiError("bad_request", "bookings.cancel", { status: 400, reason: "Not found" });
      },
    });
    expect(await adapterFor(t).cancel(ref)).toEqual({ kind: "rejected", definite: true, code: "not_found" });
  });

  it("a cancel refusal is re-read first: a booking shown cancelled wins, otherwise the refusal stands (doc 22 §32.32)", async () => {
    const refuse = async () => {
      throw new TravelDeskApiError("bad_request", "bookings.cancel", { status: 400, reason: "Cancellation is not allowed for this booking" });
    };
    const cancelled = transport({ cancel: refuse, pages: () => ({ rows: [booking({ status: 4, reservationDeadline: null })], totalCount: 1 }) });
    const won = await adapterFor(cancelled.t).cancel(ref);
    expect(won.kind === "accepted" && won.snapshot.status).toBe("CANCELLED");
    const live = transport({ cancel: refuse, pages: () => ({ rows: [booking({ status: 1, reservationDeadline: null })], totalCount: 1 }) });
    expect(await adapterFor(live.t).cancel(ref)).toEqual({ kind: "rejected", definite: true, code: "refused_policy" });
    expect(live.calls).toContain("listBookingsPage");
    const unreadable = transport({
      cancel: refuse,
      listBookingsPage: async () => {
        throw new TravelDeskApiError("server", "bookings.list", { status: 503 });
      },
    });
    expect(await adapterFor(unreadable.t).cancel(ref)).toEqual({ kind: "rejected", definite: true, code: "refused_policy" });
  });

  it("a 400 'already cancelled' is re-read like a 200, never returned as a refusal (CR-B1-4)", async () => {
    const already = async () => {
      throw new TravelDeskApiError("bad_request", "bookings.cancel", { status: 400, reason: "Booking already cancelled" });
    };
    const listed = transport({ cancel: already, pages: () => ({ rows: [booking({ status: 4, reservationDeadline: null })], totalCount: 1 }) });
    const o = await adapterFor(listed.t).cancel(ref);
    expect(o.kind === "accepted" && o.snapshot.status).toBe("CANCELLED");
    expect(listed.calls).toContain("listBookingsPage");
    const failing = transport({
      cancel: already,
      listBookingsPage: async () => {
        throw new TravelDeskApiError("server", "bookings.list", { status: 503 });
      },
    });
    expect(await adapterFor(failing.t).cancel(ref)).toEqual({ kind: "unknown", sent: true, reason: ANSWERED_UNVERIFIED });
  });

  it("a cancel answered 200 counts only through a re-read; a failed re-read is unverified", async () => {
    const listed = transport({ pages: () => ({ rows: [booking({ status: 4, reservationDeadline: null })], totalCount: 1 }) });
    const o = await adapterFor(listed.t).cancel(ref);
    expect(o.kind === "accepted" && o.snapshot.status).toBe("CANCELLED");
    const failing = transport({
      listBookingsPage: async () => {
        throw new TravelDeskApiError("server", "bookings.list", { status: 503 });
      },
    });
    expect(await adapterFor(failing.t).cancel(ref)).toEqual({ kind: "unknown", sent: true, reason: ANSWERED_UNVERIFIED });
  });
});

describe("status reads (SUP-4, SUP-12)", () => {
  it("reads by list, falls back to the reservation read, and never calls get-by-id", async () => {
    const listed = transport({ pages: () => ({ rows: [booking({ status: 1, reservationDeadline: null })], totalCount: 1 }) });
    expect((await adapterFor(listed.t).readStatus(ref)).kind).toBe("found");
    expect(listed.calls).toEqual(["listBookingsPage"]);

    const held = transport({ getReservation: async () => booking() });
    const r = await adapterFor(held.t).readStatus(ref);
    expect(r.kind === "found" && r.snapshot.status).toBe("ON_HOLD");
    expect(held.calls).toEqual(["listBookingsPage", "getReservation"]);

    const gone = transport();
    expect(await adapterFor(gone.t).readStatus(ref)).toEqual({ kind: "not_found" });
    for (const c of [listed, held, gone]) expect(c.calls).not.toContain("getBooking");
  });

  it("re-reads a paged list and unites the passes; disagreeing totals make it incomplete", async () => {
    const a = booking({ supplierBookingId: "1", bookingReference: "OUTTD-A" });
    const b = booking({ supplierBookingId: "2", bookingReference: "OUTTD-B" });
    const c = booking({ supplierBookingId: "3", bookingReference: "OUTTD-C" });
    // First pass: an insert between pages shifts `b` out of view. Second pass sees it.
    const shifted = transport({
      pages: (call, page) => (call <= 2 ? (page === 1 ? { rows: [a], totalCount: 2 } : { rows: [c], totalCount: 2 }) : page === 1 ? { rows: [a], totalCount: 2 } : { rows: [b], totalCount: 2 }),
    });
    const w = await adapterFor(shifted.t).listWindow({ from: "2026-11-01", to: "2026-11-30" });
    expect(w.snapshots.map((s) => s.ref).sort()).toEqual(["1", "2", "3"]);
    expect(w.complete).toBe(true);

    const growing = transport({ pages: (call, page) => (page === 1 ? { rows: [a], totalCount: call <= 2 ? 2 : 3 } : { rows: [b], totalCount: call <= 2 ? 2 : 3 }) });
    const found = await adapterFor(growing.t).findByClientRef("OUTTD-B", { serviceDate: "2026-11-10", offerExternalId: "77" });
    expect(found.matches.map((m) => m.ref)).toEqual(["2"]);
    expect(found.complete).toBe(false);
  });

  it("an endless list is reported incomplete, not thrown or cut silently", async () => {
    const endless = transport({ pages: (_call, page) => ({ rows: [booking({ supplierBookingId: String(page) })], totalCount: 10_000 }) });
    const w = await adapterFor(endless.t).listWindow({ from: "2026-11-01", to: "2026-11-30" });
    expect(w.complete).toBe(false);
    expect(w.snapshots.length).toBe(50);
  });
});

describe("account and funds (SUP-10)", () => {
  it("funds are the lower of payable balance and credit minus balance, with the raw figures and the agency id (doc 29 §4.5)", async () => {
    const { t } = transport();
    // Credit 1 000.00, 500.00 used: 500.00 left; the payable figure (1 200.00) disagrees and the engine refuses it, the adapter reports the lower.
    expect(await adapterFor(t).funds()).toEqual({ spendableMinor: 50_000n, currency: "AED", accountId: "42", wallet: { balanceMinor: 50_000n, creditFacilityMinor: 100_000n, payableMinor: 120_000n } });
    const credit = transport({ getBalance: async () => ({ agencyId: 42, currencyRequested: "AED" as const, balanceMinor: 10_000n, creditFacilityMinor: 100_000n, payableBalanceMinor: 90_000n }) });
    expect((await adapterFor(credit.t).funds()).spendableMinor).toBe(90_000n);
    expect(await adapterFor(t).account()).toEqual({ accountId: "42" });
  });

  it("a prepaid wallet with a negative balance can book what was paid in (the production shape of 22 November)", async () => {
    const prepaid = transport({ getBalance: async () => ({ agencyId: 42, currencyRequested: "AED" as const, balanceMinor: -24_406n, creditFacilityMinor: 0n, payableBalanceMinor: 24_406n }) });
    expect((await adapterFor(prepaid.t).funds()).spendableMinor).toBe(24_406n);
  });

  it("a balance read that does not parse is never a figure", async () => {
    const broken = transport({ getBalance: async () => ({ agencyId: 42, currencyRequested: "AED" as const, balanceMinor: 0n, creditFacilityMinor: 0n }) as never });
    await expect(adapterFor(broken.t).funds()).rejects.toThrow();
  });

  it("records the status and Date header of the last call (SUP-21)", () => {
    const a = adapterFor(transport().t);
    expect(a.lastCall()).toBeNull();
    a.noteCall({ status: 201, serverDate: "Sun, 01 Nov 2026 08:00:05 GMT" });
    expect(a.lastCall()).toEqual({ httpStatus: 201, serverDate: "Sun, 01 Nov 2026 08:00:05 GMT" });
  });
});

describe("per-request read budget (CR-B1-9)", () => {
  /** A gate that allows `n` requests and records what was asked. */
  function gate(n: number) {
    const asked: string[] = [];
    let left = n;
    const g: ReadGate = {
      async take(op) {
        asked.push(op);
        if (left <= 0) return false;
        left -= 1;
        return true;
      },
    };
    return { g, asked };
  }

  it("asks before every list page; a refused page ends the listing incomplete, with what was read kept", async () => {
    const paged = transport({ pages: (_call, page) => ({ rows: [booking({ supplierBookingId: String(page) })], totalCount: 5 }) });
    const { g, asked } = gate(3);
    const w = await adapterFor(paged.t).withReadGate(g).listWindow({ from: "2026-11-01", to: "2026-11-30" });
    expect(w.complete).toBe(false);
    expect(w.snapshots.map((s) => s.ref)).toEqual(["1", "2", "3"]);
    expect(paged.calls.filter((c) => c === "listBookingsPage")).toHaveLength(3);
    expect(asked.every((op) => op === "bookings.list")).toBe(true);
  });

  it("a refused reservation read fails with the budget reason, never not-found", async () => {
    const empty = transport();
    const { g, asked } = gate(1);
    expect(await adapterFor(empty.t).withReadGate(g).readStatus(ref)).toEqual({ kind: "failed", reason: READ_BUDGET_REASON });
    expect(asked).toEqual(["bookings.list", "bookings.reservation"]);
    expect(empty.calls).not.toContain("getReservation");
  });

  it("a fully refused search is incomplete, so it never counts as a search", async () => {
    const { t, calls } = transport();
    const found = await adapterFor(t).withReadGate(gate(0).g).findByClientRef("OUTTD-X", { serviceDate: "2026-11-10", offerExternalId: "77" });
    expect(found).toEqual({ matches: [], complete: false });
    expect(calls).toEqual([]);
  });

  it("the balance read is counted but never refused", async () => {
    const { t } = transport();
    const { g, asked } = gate(0);
    expect((await adapterFor(t).withReadGate(g).funds()).accountId).toBe("42");
    expect(asked).toEqual(["balance"]);
  });

  it("a gated copy reports the parent's last call, and the frozen unverified reason is unchanged", () => {
    const a = adapterFor(transport().t);
    const copy = a.withReadGate(gate(10).g);
    a.noteCall({ status: 200, serverDate: "Sun, 01 Nov 2026 08:00:05 GMT" });
    expect(copy.lastCall()).toEqual({ httpStatus: 200, serverDate: "Sun, 01 Nov 2026 08:00:05 GMT" });
    expect(ANSWERED_UNVERIFIED).toBe(ANSWERED_UNVERIFIED_REASON);
  });
});

describe("ticket evidence from confirm and create (TKT-1)", () => {
  const CODES = ["SYNTH-ADAPTER-CODE-1", "SYNTH-ADAPTER-CODE-2"];
  const set = () =>
    new IssuedTicketSet(
      CODES.map((code, unitIndex) => ({ unitIndex, ticketFor: "adult" as const, ticketTypeId: "11", ticketTypeName: "Adult", displayType: 1, code, validUntil: null })),
      "confirm_response",
    );
  const confirmed = booking({ status: 1, reservationDeadline: null });
  const FORBIDDEN = [...CODES, "downloadCodeLink", "Guid=", "http://", "https://"];
  const clean = (v: unknown) => {
    const s = JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)) + inspect(v, { depth: 10 });
    for (const f of FORBIDDEN) expect(s).not.toContain(f);
  };

  it("confirm and book return the evidence beside the snapshot, never inside it", async () => {
    const issued: TicketEvidence = { kind: "issued", set: set() };
    const { t } = transport({ confirm: async () => ({ booking: confirmed, tickets: issued }), create: async () => ({ booking: confirmed, tickets: issued }) });
    const a = adapterFor(t);
    for (const o of [await a.confirm(ref), await a.book({ clientRef: "OUTTD-ABC", expected: {} as never, body: {} })]) {
      expect(o.kind).toBe("accepted");
      if (o.kind !== "accepted") continue;
      expect(o.tickets).toBe(issued);
      expect(o.tickets?.kind === "issued" && o.tickets.set.tickets().map((x) => x.code)).toEqual(CODES);
      expect(o.snapshot.ticketsIssued).toBe(true);
      expect(Object.keys(o.snapshot)).not.toContain("tickets");
      clean(o.snapshot);
      clean(o);
    }
  });

  it("malformed ticket data still counts as issued; none leaves the claim to hasTickets", async () => {
    const malformed: TicketEvidence = { kind: "malformed", source: "create_response", reason: "code_missing" };
    const m = await adapterFor(transport({ create: async () => ({ booking: confirmed, tickets: malformed }) }).t).book({ clientRef: "OUTTD-ABC", expected: {} as never, body: {} });
    expect(m.kind === "accepted" && [m.snapshot.ticketsIssued, m.tickets]).toEqual([true, malformed]);

    const none = await adapterFor(transport({ confirm: async () => ({ booking: confirmed, tickets: { kind: "none" } }) }).t).confirm(ref);
    expect(none.kind === "accepted" && [none.snapshot.ticketsIssued, none.tickets]).toEqual([null, { kind: "none" }]);
    const flagged = await adapterFor(transport({ confirm: async () => ({ booking: { ...confirmed, hasTickets: true }, tickets: { kind: "none" } }) }).t).confirm(ref);
    expect(flagged.kind === "accepted" && flagged.snapshot.ticketsIssued).toBe(true);
  });

  it("a transport answering a bare booking is read as no ticket data", async () => {
    const o = await adapterFor(transport().t).confirm(ref);
    expect(o.kind === "accepted" && [o.snapshot.ticketsIssued, o.tickets]).toEqual([null, { kind: "none" }]);
  });

  it("errors keep their outcome and carry no tickets", async () => {
    const { t } = transport({
      confirm: async () => {
        throw new TravelDeskApiError("timeout", "bookings.confirm");
      },
    });
    expect(await adapterFor(t).confirm(ref)).toEqual({ kind: "unknown", sent: true, reason: "timeout" });
  });

  it("status reads, client-ref search, window listing and cancel never reach get-by-id or the download (SUP-4)", async () => {
    const issuing = ["getBooking", "readTicketsById", "downloadTickets", "downloadVoucher"];
    const pages = () => ({ rows: [booking({ status: 1, reservationDeadline: null })], totalCount: 1 });
    const runs: string[][] = [];
    const listed = transport({ pages });
    await adapterFor(listed.t).readStatus(ref);
    await adapterFor(listed.t).findByClientRef("OUTTD-ABC", { serviceDate: "2026-11-10", offerExternalId: "77" });
    await adapterFor(listed.t).listWindow({ from: "2026-11-01", to: "2026-11-30" });
    await adapterFor(listed.t).cancel(ref);
    runs.push(listed.calls);
    const held = transport({ getReservation: async () => booking() });
    await adapterFor(held.t).readStatus(ref);
    await adapterFor(held.t).cancel(ref);
    runs.push(held.calls);
    const gone = transport();
    await adapterFor(gone.t).readStatus(ref);
    await adapterFor(gone.t).cancel(ref);
    runs.push(gone.calls);
    for (const calls of runs) {
      expect(calls.length).toBeGreaterThan(0);
      for (const m of issuing) expect(calls).not.toContain(m);
    }
  });

  it("the transport type has no get-by-id and no download", () => {
    type Has<K extends string> = K extends keyof TravelDeskBookingTransport ? true : false;
    const excluded: [Has<"readTicketsById">, Has<"getBooking">, Has<"downloadTickets">, Has<"downloadVoucher">] = [false, false, false, false];
    expect(excluded).toEqual([false, false, false, false]);
  });
});

/* ---------------------------------------------------------------------------
 * External-supplier bookings (doc 29 Batch 6)
 * ------------------------------------------------------------------------ */

describe("external-supplier bookings (doc 29 Batch 6)", () => {
  /** An AgencyBookingPublicDto list row as TravelDesk documents it; ids and amounts synthetic. */
  const wire = (over: Record<string, unknown> = {}) => ({
    id: 100,
    date: "2026-11-10T00:00:00",
    offerId: 77,
    bookingType: 1,
    bookingReference: "OUTTD-ABC",
    tourId: 5,
    timeSlotId: 9,
    startTime: 600,
    adults: 2,
    children: 0,
    infants: 0,
    totalCost: 240,
    totalCostUsd: 66,
    totalPaidFromBalance: 240,
    status: 1,
    isExternalConfirmationInProgress: false,
    isExternalBookingFailed: false,
    isExternalVoucherNotReady: false,
    ...over,
  });
  const read = (over: Record<string, unknown>) => snapshotFrom(bookingFrom(bookingWire.parse(wire(over))));

  it("a booking the external supplier rejected is created (201) with the failed flag: once the confirmation is no longer in progress it reads REJECTED", () => {
    for (const status of [0, 1, 5]) {
      expect(read({ status, isExternalBookingFailed: true }).status).toBe("REJECTED");
    }
    // A reservation the external supplier refused holds nothing either.
    expect(read({ status: 7, isExternalBookingFailed: true, reservationDeadline: "2026-11-01T08:15:00" }).status).toBe("REJECTED");
    expect(read({ status: 7, isExternalBookingFailed: false, reservationDeadline: "2026-11-01T08:15:00" }).status).toBe("ON_HOLD");
  });

  it("while the confirmation is in progress it waits, whatever the failed flag says; a missing flag is never a rejection", () => {
    expect(read({ isExternalConfirmationInProgress: true }).status).toBe("PENDING");
    expect(read({ isExternalConfirmationInProgress: true, isExternalBookingFailed: true }).status).toBe("PENDING");
    expect(read({ isExternalConfirmationInProgress: undefined, isExternalBookingFailed: true }).status).toBe("CONFIRMED");
    expect(read({ isExternalConfirmationInProgress: undefined, isExternalBookingFailed: true })).toMatchObject({ externalInProgress: null, externalFailed: true });
  });

  it("document links before the confirmation finished: the booking waits, and no link, Guid or failure text reaches the snapshot", () => {
    const s = read({
      isExternalConfirmationInProgress: true,
      isExternalVoucherNotReady: true,
      downloadVoucherUrl: "https://example.invalid/voucher/0000",
      downloadTicketsUrl: "https://example.invalid/tickets/0000",
      externalBookingFailureMessage: "Synthetic supplier text",
    });
    expect(s.status).toBe("PENDING");
    const json = JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(json).not.toContain("example.invalid");
    expect(json).not.toContain("Synthetic supplier text");
    expect(s.ticketsIssued).toBeNull();
  });

  it("a voucher not ready after the confirmation does not stop the confirmation; the download answers not ready (502) until it is", () => {
    expect(read({ isExternalVoucherNotReady: true }).status).toBe("CONFIRMED");
  });

  it("takes the hold deadline from the reserve answer, short holds included, and never assumes 15 minutes for an external offer", async () => {
    const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
    const hold = async (r: Partial<TravelDeskBooking>, externalRoute?: boolean) => {
      const { t } = transport({ reserve: async () => booking(r) });
      const o = await adapterFor(t).hold({ clientRef: "c", expected: {} as never, body: {}, ...(externalRoute ? { externalRoute } : {}) });
      return o.kind === "accepted" ? o.snapshot.holdExpiresAtUtc : "not accepted";
    };
    // A five-minute provider hold: its own deadline, UTC.
    expect(await hold({ reservationDeadline: at(5), reservationTimeout: null }, true)).toBe(at(5));
    expect(await hold({ reservationDeadline: at(5), reservationTimeout: 5 }, true)).toBe(at(5));
    // The answer's timeout alone bounds it.
    expect(await hold({ reservationDeadline: null, reservationTimeout: 5 }, true)).toBe(at(5));
    // A later deadline is still capped (CR-9), never trusted past the send plus the timeout.
    expect(await hold({ reservationDeadline: at(60), reservationTimeout: 7 }, true)).toBe(at(7));
    // Neither a deadline nor a timeout: the hold has no known end (never confirmed), instead of an assumed 15 minutes.
    expect(await hold({ reservationDeadline: null, reservationTimeout: null }, true)).toBeNull();
    // An internal offer keeps today's rule: the documented 15 minutes.
    expect(await hold({ reservationDeadline: null, reservationTimeout: null })).toBe(at(15));
  });

  it("reads `reservationDeadline` without a zone as UTC", () => {
    expect(bookingFrom(bookingWire.parse(wire({ status: 7, reservationDeadline: "2026-11-01T08:05:00" }))).reservationDeadline).toBe("2026-11-01T08:05:00.000Z");
  });
});
