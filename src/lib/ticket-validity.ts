/**
 * Open-dated ticket facts as a customer may see them (doc 29 Batch 5). Pure,
 * shared by the server (status projection, tickets email) and the browser.
 * Never takes or returns a ticket code: only the last valid day and how many
 * tickets of each type were issued.
 */

import { TICKET_NON_REFUNDABLE_STATEMENT, ticketValidityCopy } from "./utils";

/** One ticket type of an issued booking, e.g. "Aquarium (adult)" × 2. Combo offers issue one code per guest per type. */
export interface TicketTypeCount {
  label: string;
  count: number;
}

/** What the status page, the ticket card and the email show for an open-dated ticket item. */
export interface CustomerTicketFacts {
  /** Last day the tickets can be used, YYYY-MM-DD; null when the supplier gave none. */
  validUntil: string | null;
  /** "Ticket valid until Wednesday, 31 March 2027." or null. */
  validityCopy: string | null;
  /** Always `TICKET_NON_REFUNDABLE_STATEMENT`. */
  nonRefundableCopy: string;
  /** Issued tickets per type; empty until the codes are issued. */
  types: TicketTypeCount[];
  /**
   * Neutral copy when the issued tickets stop being valid before the visit date
   * (review 86 B5-02; staff are alerted by the documents sweep), else null.
   * Never set from the pre-sale stock hint.
   */
  validityConcern: string | null;
}

/** Shown when the issued tickets' last valid day is before the visit date. States no cause and promises no refund. */
export const TICKET_VALIDITY_CONCERN = "Our team is checking that your tickets can be used on your visit date. We'll contact you before your visit.";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The calendar day a supplier validity stands for. A date (`stock.validUntil`)
 * is taken as it is. An issued ticket's `validUntil` arrives without a time
 * zone and is stored as if it were UTC (traveldesk.booking.ts, Q-A2), so its
 * UTC calendar day is the day the supplier wrote. Converting it to Dubai time
 * would move a late-evening value (for example 23:59) to the next day.
 */
export function validityDayOf(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && DAY.test(value)) return value;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

const realDay = (d: string | null): d is string => d !== null && ticketValidityCopy(d) !== null;

/**
 * The last day to show (TravelDesk OpenAPI, 22 Nov 2026), in this order:
 *  1. issued tickets: the earliest per-ticket `validUntil` ("valid-until date
 *     of this stock or external ticket"), the only day every ticket of the
 *     booking honours;
 *  2. else the booking's own `ticketsValidUntil` ("tickets valid until if
 *     applicable");
 *  3. else, before any ticket is issued, the stock's `validUntil` the quote
 *     carried, which is only "the earliest expiration date among tickets in
 *     stock": a pre-sale hint, never preferred over 1 or 2.
 * Null when none is a real calendar day.
 */
export function ticketValidUntilDay(
  quoteValidUntil: string | null | undefined,
  issued: readonly (Date | string | null | undefined)[],
  bookingValidUntil: string | null | undefined = null,
): string | null {
  const perTicket = issued.map(validityDayOf).filter(realDay).sort();
  if (perTicket.length) return perTicket[0];
  const booking = validityDayOf(bookingValidUntil);
  if (realDay(booking)) return booking;
  const stock = validityDayOf(quoteValidUntil);
  return realDay(stock) ? stock : null;
}

const UNIT_WORD: Readonly<Record<string, string>> = { adult: "adult", child: "child", infant: "infant" };
const MAX_LABEL = 80;

/** Supplier text made safe to print: control characters removed, spaces collapsed, length capped. */
function cleanTypeName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const t = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, MAX_LABEL) : null;
}

/**
 * Issued tickets grouped by type and guest category, in issue order. A combo
 * offer issues one code per guest per ticket type, so 2 adults on a two-park
 * combo read "Park A (adult) × 2" and "Park B (adult) × 2", never "4 tickets".
 * A unit without a type name reads by its category alone ("Adult ticket").
 */
export function ticketTypeSummary(units: readonly { ticketTypeName: string | null; ticketFor: string }[]): TicketTypeCount[] {
  const out: TicketTypeCount[] = [];
  for (const u of units) {
    const name = cleanTypeName(u.ticketTypeName);
    const word = UNIT_WORD[u.ticketFor];
    const label = name ? (word ? `${name} (${word})` : name) : word ? `${word[0].toUpperCase()}${word.slice(1)} ticket` : "Ticket";
    const found = out.find((t) => t.label === label);
    if (found) found.count += 1;
    else out.push({ label, count: 1 });
  }
  return out;
}

/** One line per type, e.g. "Park A (adult) × 2". */
export function ticketTypeLine(t: TicketTypeCount): string {
  return `${t.label} × ${t.count}`;
}

/** The customer facts of an open-dated ticket item. */
export function customerTicketFacts(input: {
  quoteValidUntil: string | null | undefined;
  issued: readonly { ticketTypeName: string | null; ticketFor: string; validUntil: Date | string | null }[];
  bookingValidUntil?: string | null;
  /** The visit date, YYYY-MM-DD (the order item's service date). */
  visitDate?: string | null;
}): CustomerTicketFacts {
  const validUntil = ticketValidUntilDay(input.quoteValidUntil, input.issued.map((t) => t.validUntil), input.bookingValidUntil ?? null);
  // Only what the supplier issued counts here, never the stock hint (the quote already refused a stock ending before the visit).
  const issuedDay = ticketValidUntilDay(null, input.issued.map((t) => t.validUntil), input.bookingValidUntil ?? null);
  const visit = input.visitDate && DAY.test(input.visitDate) ? input.visitDate : null;
  return {
    validUntil,
    validityCopy: ticketValidityCopy(validUntil),
    nonRefundableCopy: TICKET_NON_REFUNDABLE_STATEMENT,
    types: ticketTypeSummary(input.issued),
    validityConcern: issuedDay && visit && issuedDay < visit ? TICKET_VALIDITY_CONCERN : null,
  };
}
