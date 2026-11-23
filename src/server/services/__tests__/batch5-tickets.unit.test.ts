import { describe, expect, it, vi } from "vitest";
import type { CustomerOrderState } from "@/lib/customer-status";
import { TICKET_NON_REFUNDABLE_STATEMENT } from "@/lib/utils";
import { TICKET_VALIDITY_CONCERN } from "@/lib/ticket-validity";
import { ticketCancelRefused } from "../../suppliers/booking-port";
import { ticketEvidenceFrom } from "../../suppliers/traveldesk/traveldesk.booking";
import type { CancellationFacts } from "../cancellation.service";

/**
 * Doc 29 Batch 5 (open-dated tickets), the state and leak guards:
 *  - exhaustive: every payment saga state × every supplier attempt state for a
 *    ticket item, including the unknown-confirm and confirm-after-capture
 *    paths: never a self-serve cancellation, never a free-cancellation
 *    promise, and the one statement "non-refundable once issued" wherever a
 *    statement is shown;
 *  - the engine never sends a cancel for a confirmed ticket (every state);
 *  - the checkout review line, the status projection and the tickets email
 *    say non-refundable once issued and show the validity;
 *  - ticket codes and their image links never reach a projection, the email,
 *    a log line or a CRM payload.
 * Pure: the database module throws if touched. Synthetic values only; the
 * fake codes are assembled at run time and are obviously not real.
 */

vi.mock("../../lib/db", () => ({
  prisma: new Proxy({}, { get: () => { throw new Error("no database in this suite"); } }),
  TX_OPTIONS: {},
}));

const { projectCustomerStatus } = await import("../order-status.service");
const { evaluateCancellation } = await import("../cancellation.service");
const { ticketFactsForOrder, TICKET_FACT_SELECT } = await import("../ticket-facts.service");
const { toPublicQuote } = await import("../quote.service");
const { renderTicketsReady } = await import("../../notifications/templates");
const { redact } = await import("../../lib/logger");
const { mapDeal } = await import("../../crm/crm.mapping");
const { directOrderState, fakeConfig } = await import("../../crm/__tests__/_memory-store");
type Snapshot = import("../order-status.service").StatusSnapshot;
type Item = import("../order-status.service").StatusItemSnapshot;

/** Obviously fake, assembled at run time (the public scanner refuses realistic codes). */
const FAKE_CODE = ["FAKE", "TICKET", "CODE", String(4 * 1000 + 2)].join("-");
const FAKE_LINK = ["https:", "", "example.test", "codes", `${FAKE_CODE}.jpg`].join("/");

const SAGA_STATES = ["session_created", "authorized", "captured", "capture_unknown", "reserve_pending", "reserved", "confirm_pending", "fulfilled", "release_pending", "released", "refund_pending", "refunded", "failed", "attention"];
const BOOKING_STATES = [
  "queued",
  "reserving",
  "reserved",
  "confirming",
  "awaiting_external",
  "confirmed",
  "outcome_unknown",
  "not_created",
  "rejected",
  "expired",
  "cancelling",
  "cancelled",
  "cancel_refused",
  "manual_review",
  "awaiting_payment",
  "not_found_unresolved",
  "cancel_unverified",
];
/** The confirm was sent and its outcome is not known yet (doc 29 §4.4 "attention: confirm outcome unknown"). */
const CONFIRM_UNKNOWN = ["confirming", "outcome_unknown", "not_found_unresolved", "manual_review", "awaiting_external"];

const NOW = new Date("2030-01-10T08:00:00.000Z");
const T0 = new Date("2030-01-10T07:00:00.000Z");
const ITEM = "01890000-0000-7000-8000-0000000000a1";
const BOOKING = "01890000-0000-7000-8000-0000000000b1";
const ticketFacts = {
  validUntil: "2030-07-16",
  validityCopy: "Ticket valid until Tuesday, 16 July 2030.",
  nonRefundableCopy: TICKET_NON_REFUNDABLE_STATEMENT,
  types: [
    { label: "Park A (adult)", count: 2 },
    { label: "Park B (adult)", count: 2 },
  ],
  validityConcern: null,
};

function facts(bookingState: string, over: Partial<CancellationFacts> = {}): CancellationFacts {
  return {
    orderItemId: ITEM,
    rail: "self_serve",
    fulfilmentOrigin: "instant_checkout",
    serviceDate: "2030-01-15",
    startMinutes: null,
    booking: { id: BOOKING, state: bookingState, bookingKind: "ticket_only" },
    // Even a stored policy that offered a refund window (an older or wrong quote) never makes a ticket cancellable.
    policy: { freeCancellationUntilUtc: "2030-01-14T20:00:00.000Z", nonRefundableAfterConfirm: false },
    issuesTicketsAtConfirm: "no",
    ticketsStored: false,
    currency: "AED",
    payableMinor: 45_000n,
    payment: { id: "01890000-0000-7000-8000-0000000000c1", captured: true, verified: true, refundableMinor: 45_000n, frozen: false },
    orderPaid: true,
    ...over,
  };
}

function snap(sagaState: string, bookingState: string | null, captured: boolean, issued: boolean): Snapshot {
  const item: Item = {
    id: ITEM,
    title: "Synthetic attraction ticket",
    serviceDate: "2030-01-15",
    timeslot: null,
    pax: { adult: 2 },
    status: bookingState === "confirmed" ? "confirmed" : "pending",
    booking: bookingState ? { state: bookingState, startMinutes: null, confirmedAt: bookingState === "confirmed" ? T0 : null, cancelledAt: null, updatedAt: T0 } : null,
    tickets: issued
      ? { fulfilment: "issued", documents: [{ id: "01890000-0000-7000-8000-0000000000d1", kind: "tickets_pdf", version: 1, status: "valid", contentType: "application/pdf", byteSize: 2048, createdAt: T0.toISOString() }] }
      : { fulfilment: bookingState === "confirmed" ? "ticket_pending" : "not_applicable", documents: [] },
    refunds: [],
    remedies: [],
    request: null,
    cancellation: facts(bookingState ?? "queued"),
    instant: true,
    ticket: ticketFacts,
  };
  return {
    order: { reference: "OUT-10000017", status: "paid", rail: "self_serve", currency: "AED", totalMinor: 45_000n, placedAt: T0, updatedAt: T0, paidAt: captured ? T0 : null },
    saga: { orderItemId: ITEM, state: sagaState, deadlineAt: new Date("2030-01-10T08:20:00.000Z"), attentionRequiredAt: null, updatedAt: T0 },
    payment: { status: captured ? "captured" : "authorized", capturedMinor: captured ? 45_000n : 0n, refundedMinor: 0n, authorizedAt: T0, capturedAt: captured ? T0 : null },
    items: [item],
    canDownload: true,
  };
}

const FORBIDDEN_KEY = /^(code|ticketCode.*|codeCiphertext|codeHash|codeKeyId|downloadCodeLink|downloadTicketsUrl|supplierBookingId)$/i;
function forbiddenKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [...(FORBIDDEN_KEY.test(k) ? [`${path}.${k}`] : []), ...forbiddenKeys(v, `${path}.${k}`)]);
  return [];
}

describe("exhaustive: a ticket item in every saga state × attempt state", () => {
  const combos = SAGA_STATES.flatMap((saga) => [null, ...BOOKING_STATES].flatMap((booking) => [false, true].flatMap((captured) => [false, true].map((issued) => ({ saga, booking, captured, issued })))));

  it(`never offers a self-serve cancellation or a free-cancellation promise, and says non-refundable once issued (${combos.length} combinations)`, () => {
    for (const c of combos) {
      const label = JSON.stringify(c);
      const out = projectCustomerStatus(snap(c.saga, c.booking, c.captured, c.issued), NOW);
      const item = out.items[0];
      expect(item.cancellation.kind, label).not.toBe("eligible");
      // A ticket is refused as issued; a refusal the operator recorded or a past date keeps its own (also non-refundable) reason.
      if (item.cancellation.kind === "not_eligible") expect(["tickets_issued", "non_refundable", "activity_started"], label).toContain(item.cancellation.reason);
      if (item.cancellationTerms !== null && item.cancellationTerms !== undefined) expect(item.cancellationTerms, label).toBe(TICKET_NON_REFUNDABLE_STATEMENT);
      expect(JSON.stringify(out), label).not.toMatch(/free cancellation/i);
      expect(item.ticket, label).toEqual(ticketFacts);
      expect(forbiddenKeys(out), label).toEqual([]);
      expect(JSON.stringify(out), label).not.toContain(FAKE_CODE);
    }
  });

  it("unknown confirm after capture: the customer is told we are booking or checking, never booked, never refunded, never offered a cancellation", () => {
    const allowed: CustomerOrderState[] = ["booking_processing", "needs_attention"];
    for (const booking of CONFIRM_UNKNOWN) {
      const out = projectCustomerStatus(snap("confirm_pending", booking, true, false), NOW);
      expect(allowed, booking).toContain(out.state);
      expect(out.items[0].cancellation.kind, booking).toBe("none");
      expect(out.steps.refund, booking).toBeNull();
    }
  });

  it("confirm after capture: confirmed and issued is booked with the download; confirmed while the codes are fetched is 'being prepared'", () => {
    const done = projectCustomerStatus(snap("fulfilled", "confirmed", true, true), NOW);
    expect(done.state).toBe("confirmed");
    expect(done.items[0].tickets.documents).toHaveLength(1);
    expect(done.items[0].cancellationTerms).toBe(TICKET_NON_REFUNDABLE_STATEMENT);
    expect(done.items[0].cancellation).toEqual({ kind: "not_eligible", reason: "tickets_issued", exceptionAllowed: true });
    const late = projectCustomerStatus(snap("fulfilled", "confirmed", true, false), NOW);
    expect(late.state).toBe("confirmed_ticket_pending");
    expect(late.items[0].cancellation).toMatchObject({ kind: "not_eligible", reason: "tickets_issued" });
  });

  it("proven absent after capture: a refund, with no ticket statement left on a refunded item", () => {
    for (const saga of ["refund_pending", "refunded"]) {
      const out = projectCustomerStatus(snap(saga, "not_created", true, false), NOW);
      expect(["refund_processing", "refunded"]).toContain(out.state);
      expect(out.items[0].cancellationTerms).toBeNull();
      expect(out.items[0].cancellation.kind).toBe("none");
    }
  });
});

describe("evaluateCancellation: a ticket booking is never cancellable online (doc 29 §4.4)", () => {
  it("every attempt state, before and after the visit date, with every payment shape", () => {
    const payments: CancellationFacts["payment"][] = [
      null,
      { id: "p", captured: true, verified: true, refundableMinor: 45_000n, frozen: false },
      { id: "p", captured: false, verified: true, refundableMinor: 0n, frozen: false },
      { id: "p", captured: true, verified: true, refundableMinor: 45_000n, frozen: true },
    ];
    for (const state of BOOKING_STATES) {
      for (const payment of payments) {
        for (const now of [NOW, new Date("2030-01-16T08:00:00Z")]) {
          const v = evaluateCancellation(facts(state, { payment }), now);
          expect(v.kind, `${state} ${now.toISOString()}`).not.toBe("eligible");
        }
      }
    }
    // Confirmed, before the visit: the goodwill request to our team stays open.
    expect(evaluateCancellation(facts("confirmed"), NOW)).toEqual({ kind: "not_eligible", reason: "tickets_issued", exceptionAllowed: true });
    // The same facts for a live booking are eligible: the refusal is about the ticket, not the policy.
    expect(evaluateCancellation(facts("confirmed", { booking: { id: BOOKING, state: "confirmed", bookingKind: "live_book" } }), NOW).kind).toBe("eligible");
  });
});

describe("ticketCancelRefused: the engine never sends a cancel for a confirmed ticket", () => {
  it("every state: refused once confirmed or confirming externally, or with a confirmation time; unconfirmed reservations still release; live bookings untouched", () => {
    const refusedStates = new Set(["confirmed", "awaiting_external"]);
    for (const state of BOOKING_STATES) {
      expect(ticketCancelRefused({ bookingKind: "ticket_only", state, confirmedAt: null }), state).toBe(refusedStates.has(state));
      expect(ticketCancelRefused({ bookingKind: "ticket_only", state, confirmedAt: T0 }), state).toBe(true);
      expect(ticketCancelRefused({ bookingKind: "live_book", state, confirmedAt: T0 }), state).toBe(false);
    }
    // The hold of a reserved ticket (status 7, no codes yet) is released normally.
    expect(ticketCancelRefused({ bookingKind: "ticket_only", state: "awaiting_payment", confirmedAt: null })).toBe(false);
  });
});

describe("checkout review: the quote's one cancellation statement for a ticket line", () => {
  const record = (openDatedTicket: boolean) =>
    ({
      ok: true,
      quoteId: "0190a000-0000-7000-8000-0000000000f1",
      expiresAt: "2030-01-10T20:00:00.000Z",
      currency: "AED",
      totalMinor: 30_000n,
      lines: [
        {
          index: 0,
          productId: "0190a000-0000-7000-8000-000000000001",
          variantId: "v1",
          serviceDate: "2030-01-15",
          slotRef: null,
          units: { adult: 2 },
          addonIds: [],
          chargedMinor: 30_000n,
          discountAllocMinor: 0n,
          taxAllocMinor: 0n,
          freeCancellationUntilUtc: null,
          nonRefundableAfterConfirm: true,
          ticketValidUntil: "2030-07-16",
          ...(openDatedTicket ? { openDatedTicket: true } : {}),
        },
      ],
    }) as unknown as Parameters<typeof toPublicQuote>[0];

  it("says non-refundable once issued and the validity; a slot line keeps its own words", () => {
    const pub = toPublicQuote(record(true));
    if (!pub.ok) throw new Error("expected a quote");
    expect(pub.lines[0]).toMatchObject({ openDatedTicket: true, freeCancellationCopy: TICKET_NON_REFUNDABLE_STATEMENT, ticketValidityCopy: "Ticket valid until Tuesday, 16 July 2030." });
    const live = toPublicQuote(record(false));
    if (!live.ok) throw new Error("expected a quote");
    expect(live.lines[0]).toMatchObject({ openDatedTicket: false, freeCancellationCopy: "This booking is non-refundable once confirmed." });
  });
});

describe("ticketFactsForOrder: the loader reads no code", () => {
  function fakeDb() {
    const calls: { select?: Record<string, unknown> }[] = [];
    const db = {
      orderItem: {
        findMany: async () => [
          { id: "i-ticket", quoteId: "q1", quoteLineIndex: 0, mappingId: "m1", serviceDate: new Date("2030-01-15T00:00:00Z") },
          { id: "i-live", quoteId: "q1", quoteLineIndex: 1, mappingId: "m2", serviceDate: new Date("2030-01-15T00:00:00Z") },
          { id: "i-quoted", quoteId: "q1", quoteLineIndex: 2, mappingId: "m1", serviceDate: new Date("2030-01-16T00:00:00Z") },
        ],
      },
      supplierBooking: {
        findMany: async () => [
          { id: "b-ticket", orderItemId: "i-ticket", bookingKind: "ticket_only", lastResponse: { ticketsValidUntil: "2030-12-31" }, createdAt: T0 },
          { id: "b-live", orderItemId: "i-live", bookingKind: "live_book", lastResponse: null, createdAt: T0 },
        ],
      },
      quote: {
        findMany: async () => [
          {
            id: "q1",
            lines: [
              { index: 0, mappingId: "m1", serviceDate: "2030-01-15", ticketValidUntil: "2031-01-01", openDatedTicket: true },
              { index: 1, mappingId: "m2", serviceDate: "2030-01-15", ticketValidUntil: null },
              { index: 2, mappingId: "m1", serviceDate: "2030-01-16", ticketValidUntil: "2031-01-01", openDatedTicket: true },
            ],
          },
        ],
      },
      supplierTicketCode: {
        findMany: async (args: { select?: Record<string, unknown> }) => {
          calls.push(args);
          // What a careless select would return; the loader must not pass it on.
          return [
            { supplierBookingId: "b-ticket", unitIndex: 0, ticketFor: "adult", ticketTypeName: "Park A", validUntil: new Date("2030-07-16T00:00:00Z"), codeCiphertext: FAKE_CODE },
            { supplierBookingId: "b-ticket", unitIndex: 1, ticketFor: "adult", ticketTypeName: "Park B", validUntil: new Date("2030-08-01T00:00:00Z"), codeCiphertext: FAKE_CODE },
          ];
        },
      },
    };
    return { db, calls };
  }

  it("selects only booking id, unit, category, type name and validity; ticket items only; per-ticket validity first", async () => {
    const { db, calls } = fakeDb();
    const out = await ticketFactsForOrder("o1", { db: db as never });
    expect(Object.keys(TICKET_FACT_SELECT).sort()).toEqual(["supplierBookingId", "ticketFor", "ticketTypeName", "unitIndex", "validUntil"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].select).toEqual(TICKET_FACT_SELECT);
    expect([...out.keys()].sort()).toEqual(["i-quoted", "i-ticket"]);
    expect(out.get("i-ticket")).toEqual({
      validUntil: "2030-07-16",
      validityCopy: "Ticket valid until Tuesday, 16 July 2030.",
      nonRefundableCopy: TICKET_NON_REFUNDABLE_STATEMENT,
      types: [
        { label: "Park A (adult)", count: 1 },
        { label: "Park B (adult)", count: 1 },
      ],
      validityConcern: null,
    });
    // Review 86 B5-05: only the valid (complete) code set is read; an incomplete one is still "being prepared".
    expect(calls[0]).toMatchObject({ where: { document: { status: "valid", invalidatedAt: null } } });
    // Not booked yet: the stock's validity from the quote, as a pre-sale hint.
    expect(out.get("i-quoted")).toMatchObject({ validUntil: "2031-01-01", types: [] });
    expect(JSON.stringify([...out.values()])).not.toContain(FAKE_CODE);
  });
});

describe("tickets email: validity, ticket types and non-refundable once issued", () => {
  const link = `https://example.test/t#${"a".repeat(40)}`;
  it("doc 29 §8.7: the supplier's pickup time goes into the email when present", () => {
    const r = renderTicketsReady({ orderReference: "OUT-10000017", link, items: [{ title: "Synthetic safari", pickup: "Pickup at 08:15 Dubai time from Example Marina Hotel" }] });
    for (const body of [r.text, r.html]) expect(body).toContain("Pickup at 08:15 Dubai time from Example Marina Hotel");
    expect(renderTicketsReady({ orderReference: "OUT-10000017", link, items: [{ title: "Synthetic safari" }] }).text).not.toContain("Pickup at");
  });

  it("review 86 B5-02: the validity concern goes into the email when set", () => {
    const r = renderTicketsReady({ orderReference: "OUT-10000017", link, items: [{ title: "Synthetic attraction", ticket: { validityCopy: null, validityConcern: TICKET_VALIDITY_CONCERN, types: [] } }] });
    for (const body of [r.text, r.html]) expect(body).toContain(TICKET_VALIDITY_CONCERN.slice(0, 40));
  });

  it("an open-dated ticket item adds its lines; a voucher-only email is unchanged", () => {
    const r = renderTicketsReady({ orderReference: "OUT-10000017", link, items: [{ title: "Synthetic attraction", dateLabel: "15 Jan 2030", ticket: { validityCopy: "Ticket valid until Tuesday, 16 July 2030.", types: ["Park A (adult) × 2", "Park B (adult) × 2"] } }] });
    for (const body of [r.text, r.html]) {
      expect(body).toContain(TICKET_NON_REFUNDABLE_STATEMENT);
      expect(body).toContain("Ticket valid until Tuesday, 16 July 2030.");
      expect(body).toContain("Park B (adult) × 2");
      expect(body).not.toContain(FAKE_CODE);
    }
    const plain = renderTicketsReady({ orderReference: "OUT-10000017", link, items: [{ title: "Dhow cruise", dateLabel: "15 Jan 2030" }] });
    expect(plain.text).not.toContain(TICKET_NON_REFUNDABLE_STATEMENT);
  });
});

describe("ticket codes and their image links never reach a log line or a CRM payload", () => {
  it("the logger redacts the code, the per-code image link and the tickets URL", () => {
    const out = JSON.stringify(redact({ booking: { code: FAKE_CODE, downloadCodeLink: FAKE_LINK, downloadTicketsUrl: FAKE_LINK, ticketCodeTitle: FAKE_CODE, ticketsDetails: { tickets: [{ code: FAKE_CODE }] } } }));
    expect(out).not.toContain(FAKE_CODE);
    expect(out).not.toContain("example.test");
  });

  it("the codec drops the per-code image link and the booking-level code fields at parse", () => {
    const raw = {
      ticketCode: FAKE_CODE,
      ticketCodeTitle: FAKE_CODE,
      downloadCodeLink: FAKE_LINK,
      tickets: [{ code: FAKE_CODE, ticketFor: 0, ticketTypeId: null, ticketTypeName: "Park A", ticketCodeDisplayType: 1, validUntil: "2030-07-16T00:00:00", downloadCodeLink: FAKE_LINK }],
    };
    const e = ticketEvidenceFrom(raw, "confirm_response");
    expect(e.kind).toBe("issued");
    if (e.kind !== "issued") return;
    // The set serialises to counts only, and its tickets carry no link.
    expect(JSON.stringify(e)).not.toContain(FAKE_CODE);
    expect(JSON.stringify(e)).not.toContain("example.test");
    for (const t of e.set.tickets()) expect(Object.keys(t)).not.toContain("downloadCodeLink");
    // External tickets have no type id (OpenAPI): still issued, still labelled.
    expect(e.set.tickets()[0]).toMatchObject({ ticketTypeId: null, ticketTypeName: "Park A", validUntil: "2030-07-16T00:00:00.000Z" });
  });

  it("a CRM deal for a ticket order carries no code, even if one were smuggled into the facts", () => {
    const state = directOrderState("01890000-0000-7000-8000-0000000000e1", { status: "confirmed", authorised: true, capturedMinor: 45_000n });
    state.order!.items = [{ title: "Synthetic attraction", serviceDate: "2030-01-15", totalMinor: 45_000n, status: "confirmed", needsDocument: true, documentReady: true, ...({ ticketCode: FAKE_CODE, downloadCodeLink: FAKE_LINK } as object) }];
    const m = mapDeal(state, fakeConfig());
    expect(m.visible).toBe(true);
    expect(JSON.stringify(m)).not.toContain(FAKE_CODE);
    expect(JSON.stringify(m)).not.toContain("example.test");
  });
});
