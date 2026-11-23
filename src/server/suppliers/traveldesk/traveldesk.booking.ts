import { z } from "zod";
import { supplierGuestName } from "@/lib/guest-name";
import { IssuedTicketSet, type IssuedTicket, type TicketEvidence, type TicketSource, type TicketUnit } from "../../documents/contracts";
import { decimalToMinor, minorToDecimalString } from "../../domain/decimal";
import { balanceFrom, balanceWire } from "./traveldesk.codec";
import type { TravelDeskConfig } from "./traveldesk.config";
import { TravelDeskApiError, TravelDeskHttp, type TravelDeskHttpOptions } from "./traveldesk.http";

/**
 * TravelDesk booking DTOs, request builder and client (Stage 2).
 *
 * Reads (get booking, get reservation, list) are plain GETs. Mutations
 * (reserve, confirm, create, cancel) go through `TravelDeskHttp.postJson`,
 * which runs the mutation gate on every call: production is refused, and test
 * needs TRAVELDESK_BOOKINGS_ENABLED=true.
 *
 * What OUTLY keeps from a response is reduced on purpose: the voucher Guid,
 * ticket codes, download URLs and guest contact details are bearer secrets or
 * PII (plan §9, §11). `TravelDeskBooking`, and so `sanitiseBooking`, never
 * holds any of them. Ticket codes from confirm, create and get-by-id answers
 * are parsed separately into `TicketEvidence` (B4, TKT-1), which travels
 * beside the booking and serialises as a count only.
 *
 * Spec lines refer to traveldesk_api_spec.json.
 */

const num = z.number().finite();
const nnum = z.number().finite().nullable().optional();
const nstr = z.string().nullable().optional();

/** Fields shared by AgencyBookingDetailsPublicDto, AgencyBookingReservationPublicDto and AgencyBookingPublicDto (L2012, L2932, L2485). */
export const bookingWire = z.object({
  id: z.number().int(),
  date: z.string(),
  offerId: z.number().int(),
  bookingType: z.number().int(),
  bookingReference: nstr,
  tourId: z.number().int(),
  timeSlotId: z.number().int().nullable().optional(),
  startTime: z.number().int().nullable().optional(),
  endTime: z.number().int().nullable().optional(),
  adults: z.number().int(),
  children: z.number().int(),
  infants: z.number().int(),
  totalCost: num,
  totalCostUsd: num,
  totalPaidFromBalance: nnum,
  totalPaidFromBalanceUsd: nnum,
  refund: nnum,
  refundUsd: nnum,
  status: z.number().int(),
  creationState: z.number().int().optional(),
  isExternalBookingFailed: z.boolean().optional(),
  externalBookingFailureMessage: nstr,
  isExternalConfirmationInProgress: z.boolean().optional(),
  isExternalVoucherNotReady: z.boolean().optional(),
  reservationTimeout: z.number().int().nullable().optional(),
  reservationDeadline: nstr,
  hasTickets: z.boolean().optional(),
  /** OpenAPI (22 Nov 2026): "Tickets valid until if applicable". A date without a time zone. */
  ticketsValidUntil: nstr,
  /**
   * The pickup time TravelDesk returns for most tours, by area and tour (doc 29 §8.7). Its shape is not documented:
   * read leniently (`pickupMinutesOf`), so an odd value never fails the booking parse.
   */
  pickUpTime: z.unknown().optional(),
});

export const bookingListWire = z.object({
  page: z.number().int(),
  onPage: z.number().int(),
  totalCount: z.number().int(),
  data: z.array(bookingWire).nullable().optional(),
});

/** AgencyBookingCancellationResult (L1503): isSuccess is always true; refusals are a 400 with text. */
export const cancellationWire = z.object({ isSuccess: z.boolean(), message: nstr });

/** BookingStatus (L4087). */
export const BOOKING_STATUS = {
  0: "New",
  1: "PendingVerification",
  2: "PendingOnRequest",
  3: "PaymentRequired",
  4: "Cancelled",
  5: "Completed",
  6: "PaymentFailed",
  7: "Prebooked",
  8: "TimedOut",
} as const;

export interface TravelDeskBooking {
  supplierBookingId: string;
  status: number;
  statusName: string;
  bookingReference: string | null;
  serviceDate: string | null;
  offerId: number;
  tourId: number;
  bookingType: number;
  timeSlotId: number | null;
  startMinutes: number | null;
  adults: number;
  children: number;
  infants: number;
  totalCostMinor: bigint;
  totalCostUsdMinor: bigint;
  paidFromBalanceMinor: bigint | null;
  refundMinor: bigint | null;
  reservationDeadline: string | null;
  reservationTimeout: number | null;
  /** Null when TravelDesk left the flag out: absent means unknown, never false (SUP-1). */
  externalInProgress: boolean | null;
  /** Null when TravelDesk left the flag out: absent means unknown, never false (SUP-1). */
  externalFailed: boolean | null;
  externalFailureMessage: string | null;
  voucherNotReady: boolean;
  hasTickets: boolean;
  creationState: number | null;
  /** Booking-level ticket validity, `YYYY-MM-DD` (doc 29 Batch 5); absent or null when TravelDesk gives none. */
  ticketsValidUntil?: string | null;
  /** The supplier's pickup time, minutes after midnight Asia/Dubai (doc 29 §8.7); null when absent or unreadable. */
  pickupMinutes?: number | null;
}

/**
 * The returned pickup time as minutes after midnight, Asia/Dubai, like
 * `startTime`. Accepted: a plain time of day only, as whole minutes (0 to
 * 1439), "HH:mm" or "HH:mm:ss". Anything else is unknown (null) and is not
 * shown. That includes a date-time: without a zone it is ambiguous, since
 * TravelDesk's zone-less `reservationDeadline` is UTC and a pickup read as
 * Dubai time could be 4 hours off (review 86 R-01; asked of TravelDesk). A
 * missing pickup time is safer than a wrong one.
 */
export function pickupMinutesOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) && v >= 0 && v < 24 * 60 ? v : null;
  if (typeof v !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d{1,7})?)?$/.exec(v.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function minor(v: number | null | undefined): bigint | null {
  return v === null || v === undefined ? null : decimalToMinor(String(v)).minor;
}

/** "2026-11-03T00:00:00" → "2026-11-03"; the time part is never trusted for tour dates. */
function datePart(v: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  return m ? m[1] : null;
}

/**
 * `reservationDeadline` carries no timezone offset. TravelDesk confirmed it is
 * UTC (doc 29 §8.7, 23 Nov 2026), so a value without an offset is read as UTC;
 * one with an offset keeps it. The engine still never trusts it past
 * `sent + reservationTimeout` (snapshotFrom's `holdCapUtc`, CR-9).
 */
function deadlineIso(v: string | null | undefined): string | null {
  if (!v) return null;
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`;
  const t = Date.parse(withZone);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function bookingFrom(w: z.infer<typeof bookingWire>): TravelDeskBooking {
  return {
    supplierBookingId: String(w.id),
    status: w.status,
    statusName: BOOKING_STATUS[w.status as keyof typeof BOOKING_STATUS] ?? "Unknown",
    bookingReference: w.bookingReference ?? null,
    serviceDate: datePart(w.date),
    offerId: w.offerId,
    tourId: w.tourId,
    bookingType: w.bookingType,
    timeSlotId: w.timeSlotId ?? null,
    startMinutes: w.startTime ?? null,
    adults: w.adults,
    children: w.children,
    infants: w.infants,
    totalCostMinor: decimalToMinor(String(w.totalCost)).minor,
    totalCostUsdMinor: decimalToMinor(String(w.totalCostUsd)).minor,
    paidFromBalanceMinor: minor(w.totalPaidFromBalance),
    refundMinor: minor(w.refund),
    reservationDeadline: deadlineIso(w.reservationDeadline),
    reservationTimeout: w.reservationTimeout ?? null,
    externalInProgress: w.isExternalConfirmationInProgress ?? null,
    externalFailed: w.isExternalBookingFailed ?? null,
    externalFailureMessage: w.externalBookingFailureMessage ?? null,
    voucherNotReady: w.isExternalVoucherNotReady === true,
    hasTickets: w.hasTickets === true,
    creationState: w.creationState ?? null,
    ticketsValidUntil: w.ticketsValidUntil ? datePart(w.ticketsValidUntil) : null,
    pickupMinutes: pickupMinutesOf(w.pickUpTime),
  };
}

/* ---------------------------------------------------------------------------
 * Ticket data (B4, TKT-1)
 * ------------------------------------------------------------------------ */

/**
 * The booking DTO plus the raw `ticketsDetails` (L2472). The ticket part is
 * `unknown` here so that odd ticket data can never fail the booking parse: a
 * confirmed booking stays a confirmed booking, and `ticketEvidenceFrom` reads
 * the ticket part on its own. Confirm, create and get-by-id answers carry it;
 * the list and the reservation read do not (doc 21 §9).
 */
export const bookingWithTicketsWire = bookingWire.extend({ ticketsDetails: z.unknown().optional() });

/** Why ticket data present in an answer could not be read. Short codes only, never a value. */
export type TicketMalformedReason = "details_not_object" | "tickets_missing" | "tickets_empty" | "too_many_tickets" | "unit_not_object" | "code_missing" | "code_too_long";

/** Bounds on what a ticket answer may hold; beyond them it is malformed, never cut. */
const MAX_TICKET_UNITS = 500;
const MAX_CODE_CHARS = 1_000;
const MAX_TYPE_NAME_CHARS = 200;

/**
 * `ticketsDetails` and one entry of its `tickets[]`. The wire types of these
 * fields are not documented, so everything but the list and the code is read
 * leniently further down. zod strips every key not named here, so
 * `downloadCodeLink` (which carries the code, Base64-encoded), `isSent`, any
 * Guid and any URL are dropped at parse. The booking-level code, title and
 * display type are dropped too: how they relate to the per-unit codes is
 * undocumented, so only per-unit codes count.
 */
const ticketsDetailsShape = z.object({ tickets: z.array(z.unknown()) });
const ticketUnitShape = z.object({
  code: z.unknown().optional(),
  ticketFor: z.unknown().optional(),
  ticketTypeId: z.unknown().optional(),
  ticketTypeName: z.unknown().optional(),
  ticketCodeDisplayType: z.unknown().optional(),
  validUntil: z.unknown().optional(),
});

/**
 * BookingTicketFor: an integer, 0 adult, 1 child, 2 infant (TravelDesk's API
 * guide, "Ticket codes"; seen on TEST in the TicketOnly drill, 17 Nov 2026).
 * An exact, case-insensitive name is still accepted; anything else is `unknown`.
 */
const TICKET_FOR_CODES: Readonly<Record<number, TicketUnit>> = { 0: "adult", 1: "child", 2: "infant" };

function ticketUnitOf(v: unknown): TicketUnit {
  if (typeof v === "number") return Number.isInteger(v) ? (TICKET_FOR_CODES[v] ?? "unknown") : "unknown";
  if (typeof v !== "string") return "unknown";
  const l = v.toLowerCase();
  return l === "adult" || l === "child" || l === "infant" ? l : "unknown";
}

function ticketTypeIdOf(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

function malformed(source: TicketSource, reason: TicketMalformedReason): TicketEvidence {
  return { kind: "malformed", source, reason };
}

/**
 * `ticketsDetails` as ticket evidence:
 *  - absent or null: `none`;
 *  - present with one or more units, each with a non-empty string code: `issued`;
 *  - anything else present (not an object, no list, an empty list, a unit
 *    without a code): `malformed`. The supplier returned ticket data, so the
 *    tickets count as issued and a document read may follow.
 * Never throws and never reports a value in the reason.
 */
export function ticketEvidenceFrom(raw: unknown, source: TicketSource): TicketEvidence {
  if (raw === undefined || raw === null) return { kind: "none" };
  if (typeof raw !== "object" || Array.isArray(raw)) return malformed(source, "details_not_object");
  const details = ticketsDetailsShape.safeParse(raw);
  if (!details.success) return malformed(source, "tickets_missing");
  const units = details.data.tickets;
  if (units.length === 0) return malformed(source, "tickets_empty");
  if (units.length > MAX_TICKET_UNITS) return malformed(source, "too_many_tickets");
  const tickets: IssuedTicket[] = [];
  for (const [unitIndex, rawUnit] of units.entries()) {
    const parsed = Array.isArray(rawUnit) ? null : ticketUnitShape.safeParse(rawUnit);
    if (!parsed?.success) return malformed(source, "unit_not_object");
    const u = parsed.data;
    if (typeof u.code !== "string" || !u.code.trim()) return malformed(source, "code_missing");
    if (u.code.length > MAX_CODE_CHARS) return malformed(source, "code_too_long");
    tickets.push({
      unitIndex,
      ticketFor: ticketUnitOf(u.ticketFor),
      ticketTypeId: ticketTypeIdOf(u.ticketTypeId),
      ticketTypeName: typeof u.ticketTypeName === "string" && u.ticketTypeName.trim() ? u.ticketTypeName.trim().slice(0, MAX_TYPE_NAME_CHARS) : null,
      displayType: typeof u.ticketCodeDisplayType === "number" && Number.isFinite(u.ticketCodeDisplayType) ? u.ticketCodeDisplayType : null,
      code: u.code,
      // Same no-timezone rule as the reservation deadline: read as UTC (Q-A2).
      validUntil: typeof u.validUntil === "string" ? deadlineIso(u.validUntil) : null,
    });
  }
  return { kind: "issued", set: new IssuedTicketSet(tickets, source) };
}

/**
 * A confirm, create or get-by-id answer: the booking (no ticket data) and,
 * beside it, what the answer said about tickets. Serialising it shows ticket
 * counts only (`IssuedTicketSet`).
 */
export interface TravelDeskBookingAnswer {
  booking: TravelDeskBooking;
  tickets: TicketEvidence;
}

function answerFrom(w: z.infer<typeof bookingWithTicketsWire>, source: TicketSource): TravelDeskBookingAnswer {
  return { booking: bookingFrom(w), tickets: ticketEvidenceFrom(w.ticketsDetails, source) };
}

/** A stored supplier booking id as the integer TravelDesk paths take; anything else is refused before a request is built. */
function bookingIdOf(bookingId: string, operation: string): string {
  if (!/^[1-9]\d{0,15}$/.test(bookingId)) throw new TravelDeskApiError("refused", operation, { message: `TravelDesk ${operation}: booking id must be a positive integer` });
  return bookingId;
}

/** What `downloadTickets` asks for. The spec mislabels binary media types, so the document service sniffs the bytes. */
const PDF_ACCEPT = "application/pdf, application/octet-stream;q=0.9, */*;q=0.8";

/** What OUTLY stores of a response: the normalised booking with bigint → string, nothing secret. */
export function sanitiseBooking(b: TravelDeskBooking): Record<string, unknown> {
  return JSON.parse(JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export interface BookingRequestInput {
  serviceDate: string;
  offerId: number;
  adults: number;
  children: number;
  infants: number;
  guestName: string;
  /** Client reference; echoed (we expect) as bookingReference — Q-B1. */
  clientRef: string;
  totalCostMinor: bigint;
  totalCostUsdMinor: bigint;
  hotelId?: number | null;
  /** LiveBook only; TicketOnly leaves slot and times out (HTML §Booking types). */
  slot?: { timeSlotId: number; startMinutes: number; endMinutes: number } | null;
  phone?: string | null;
  remarks?: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLIENT_REF = /^[A-Za-z0-9-]{4,40}$/;

/**
 * BookingCreateB2bCommandRequest (L1375) with OUTLY's rules (plan §15):
 * date without time; cashCollect always 0 (never ask the guest to pay on the
 * tour); payByBalance and currency omitted (HTML §Booking); no email (avoid
 * direct supplier → guest contact until Q-T5 is answered).
 */
export function buildBookingRequest(i: BookingRequestInput): Record<string, unknown> {
  if (!ISO_DATE.test(i.serviceDate)) throw new Error("TravelDesk booking: serviceDate must be YYYY-MM-DD");
  if (!CLIENT_REF.test(i.clientRef)) throw new Error("TravelDesk booking: clientRef must be 4–40 characters of A–Z, 0–9 or -");
  const guestName = supplierGuestName(i.guestName);
  if (!guestName) throw new Error("TravelDesk booking: guestName must be Latin letters and spaces");
  if (i.adults + i.children <= 0) throw new Error("TravelDesk booking: at least one seated guest");
  if (i.totalCostMinor <= 0n) throw new Error("TravelDesk booking: totalCost must be positive");
  const body: Record<string, unknown> = {
    date: i.serviceDate,
    offerId: i.offerId,
    adults: i.adults,
    children: i.children,
    infants: i.infants,
    guestName,
    referenceNumber: i.clientRef,
    totalCost: Number(minorToDecimalString(i.totalCostMinor)),
    totalCostUsd: Number(minorToDecimalString(i.totalCostUsdMinor)),
    cashCollect: 0,
  };
  if (i.hotelId) body.hotelId = i.hotelId;
  if (i.slot) {
    body.timeSlotId = i.slot.timeSlotId;
    body.startTime = i.slot.startMinutes;
    body.endTime = i.slot.endMinutes;
  }
  if (i.phone) body.phone = i.phone;
  if (i.remarks) body.remarks = i.remarks.slice(0, 500);
  return body;
}

export class TravelDeskBookingClient {
  private readonly http: TravelDeskHttp;

  constructor(config: TravelDeskConfig, opts: TravelDeskHttpOptions = {}) {
    // One request at a time: the agency is processed serially (HTML §Retries).
    this.http = new TravelDeskHttp(config, { maxConcurrent: 1, ...opts });
  }

  get environment() {
    return this.http.environment;
  }

  async reserve(body: Record<string, unknown>) {
    return bookingFrom(await this.http.postJson("bookings.reserve", "/bookings/reserve", "/bookings/reserve", body, bookingWire));
  }

  /** The confirm answer carries `ticketsDetails`; its return is the issuance moment (doc 21 §9, TKT-1). */
  async confirm(reservationId: string): Promise<TravelDeskBookingAnswer> {
    return answerFrom(
      await this.http.postJson("bookings.confirm", "/bookings/confirm", "/bookings/confirm", { id: Number(reservationId) }, bookingWithTicketsWire),
      "confirm_response",
    );
  }

  /** One-step create; the answer carries `ticketsDetails` like confirm. */
  async create(body: Record<string, unknown>): Promise<TravelDeskBookingAnswer> {
    return answerFrom(await this.http.postJson("bookings.create", "/bookings", "/bookings", body, bookingWithTicketsWire), "create_response");
  }

  async cancel(bookingId: string) {
    return this.http.postJson("bookings.cancel", "/bookings/cancel", "/bookings/cancel", { id: Number(bookingId) }, cancellationWire);
  }

  /** Read before every reserve / create for the balance floor. */
  async getBalance() {
    return balanceFrom(await this.http.getJson("balance", "/balance", "/balance", { CurrencyCode: "AED" }, balanceWire));
  }

  /**
   * Get-by-id with its ticket data: the deliberate document read (B4). Its
   * answer may carry ticket codes, and reading it may issue them (doc 21 §9,
   * Q-T1), so the engine never calls it for status: status reads go through
   * the list and the reservation read (SUP-4). Its only caller is
   * `TravelDeskDocumentSource`.
   */
  async readTicketsById(bookingId: string): Promise<TravelDeskBookingAnswer> {
    const id = bookingIdOf(bookingId, "bookings.get");
    return answerFrom(await this.http.getJson("bookings.get", "/bookings/{Id}", `/bookings/${id}`, undefined, bookingWithTicketsWire), "document_read");
  }

  /**
   * The tickets PDF (`GET /bookings/{Id}/downloadtickets`, bearer key). The
   * URL is the configured base plus this fixed path and the integer id, never
   * `downloadTicketsUrl` or any other URL from an answer. Downloading it
   * counts as issuing the tickets (doc 21 §9). Bounded by `maxBytes` and the
   * read timeout; a body over the cap fails as `invalid_response` with
   * `tooLarge` set.
   */
  async downloadTickets(bookingId: string, opts: { maxBytes: number }): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const id = bookingIdOf(bookingId, "bookings.downloadtickets");
    return this.http.getBinary("bookings.downloadtickets", "/bookings/{Id}/downloadtickets", `/bookings/${id}/downloadtickets`, { maxBytes: opts.maxBytes, accept: PDF_ACCEPT });
  }

  /**
   * The booking voucher PDF (`GET /bookings/{Id}/downloadvoucher`, bearer
   * key). For a live booking this is the customer document, tickets included
   * (OpenAPI `downloadTicketsUrl`: a separate tickets PDF exists only for
   * TicketOnly bookings with allocated stock). Built like `downloadTickets`:
   * fixed path and the integer id, never the voucher URL from an answer.
   */
  async downloadVoucher(bookingId: string, opts: { maxBytes: number }): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const id = bookingIdOf(bookingId, "bookings.downloadvoucher");
    return this.http.getBinary("bookings.downloadvoucher", "/bookings/{Id}/downloadvoucher", `/bookings/${id}/downloadvoucher`, { maxBytes: opts.maxBytes, accept: PDF_ACCEPT });
  }

  async getReservation(reservationId: string) {
    return bookingFrom(
      await this.http.getJson("bookings.reservation", "/bookings/reservation/{id}", `/bookings/reservation/${Number(reservationId)}`, undefined, bookingWire),
    );
  }

  /** One page of the booking list. The list DTO carries no ticket data (doc 21 §9), so it is a safe status read. */
  async listBookingsPage(q: { from: string; to: string; offerId?: number }, page: number, onPage = 100) {
    const wire = await this.http.getJson(
      "bookings.list",
      "/bookings",
      "/bookings",
      { Page: page, OnPage: Math.max(100, onPage), From: q.from, To: q.to, OffersIds: q.offerId ? [q.offerId] : undefined },
      bookingListWire,
    );
    return { rows: (wire.data ?? []).map(bookingFrom), totalCount: wire.totalCount };
  }

  /** Tour-date window, optionally one offer; every page. OnPage below 100 is treated as 100 (L392). Throws rather than return a truncated list. */
  async listBookings(q: { from: string; to: string; offerId?: number }) {
    const out: TravelDeskBooking[] = [];
    for (let page = 1; ; page++) {
      if (page > 50) throw new Error("TravelDesk booking list: more than 50 pages; narrow the date window");
      const wire = await this.http.getJson(
        "bookings.list",
        "/bookings",
        "/bookings",
        { Page: page, OnPage: 100, From: q.from, To: q.to, OffersIds: q.offerId ? [q.offerId] : undefined },
        bookingListWire,
      );
      const rows = wire.data ?? [];
      out.push(...rows.map(bookingFrom));
      if (rows.length === 0 || out.length >= wire.totalCount) break;
    }
    return out;
  }
}
