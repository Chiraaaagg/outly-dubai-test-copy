import "server-only";
import { z } from "zod";
import { prisma, type Tx } from "../lib/db";
import { customerTicketFacts, type CustomerTicketFacts } from "@/lib/ticket-validity";

/**
 * Open-dated ticket facts per order item (doc 29 Batch 5), for the status
 * projection and the tickets email. Read-only.
 *
 * An item is a ticket item when its latest supplier attempt is TicketOnly,
 * or its quote line was an open-dated ticket quote. Its "valid until" is the
 * earliest issued ticket's own, else the booking's `ticketsValidUntil` (kept
 * in the attempt's sanitised `lastResponse`), else the stock's validity the
 * quote carried, a pre-sale hint (`ticketValidUntilDay`). Its ticket types
 * come from the stored ticket rows.
 *
 * Ticket codes never leave the database here: the ticket rows are read with
 * an explicit select of the booking id, guest category, type name and
 * validity only (`TICKET_FACT_SELECT`), never the ciphertext, key id or hash.
 */

type Db = Pick<Tx, "orderItem" | "supplierBooking" | "quote" | "supplierTicketCode">;

/** The only ticket-row fields this module reads. Asserted by its unit test. */
export const TICKET_FACT_SELECT = Object.freeze({ supplierBookingId: true, unitIndex: true, ticketFor: true, ticketTypeName: true, validUntil: true } as const);

const lineSchema = z.object({
  index: z.number().int().nonnegative().optional(),
  mappingId: z.string().optional(),
  serviceDate: z.string().optional(),
  ticketValidUntil: z.string().nullable().optional(),
  openDatedTicket: z.boolean().optional(),
});
type Line = z.infer<typeof lineSchema>;

/** The item's own quote line: by its index when it has one, else the single line with its mapping and day. */
function lineFor(item: { quoteLineIndex: number | null; mappingId: string | null; serviceDate: Date }, lines: unknown): Line | null {
  const raw = Array.isArray(lines) ? lines : [];
  if (typeof item.quoteLineIndex === "number") {
    const own = lineSchema.safeParse(raw[item.quoteLineIndex]);
    return own.success && (own.data.index === undefined || own.data.index === item.quoteLineIndex) ? own.data : null;
  }
  const day = item.serviceDate.toISOString().slice(0, 10);
  const parsed = raw.map((l) => lineSchema.safeParse(l)).flatMap((r) => (r.success ? [r.data] : []));
  const matching = parsed.filter((l) => l.mappingId === item.mappingId && l.serviceDate === day);
  return matching.length === 1 ? matching[0] : null;
}

/** The booking-level `ticketsValidUntil` day the engine kept in the attempt's last snapshot, or null. */
function bookingValidity(lastResponse: unknown): string | null {
  const v = (lastResponse as { ticketsValidUntil?: unknown } | null)?.ticketsValidUntil;
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** Ticket facts for the order's items, keyed by order item id; items that are not tickets are absent. */
export async function ticketFactsForOrder(orderId: string, opts: { orderItemIds?: readonly string[]; db?: Db } = {}): Promise<Map<string, CustomerTicketFacts>> {
  const db = opts.db ?? prisma;
  const items = await db.orderItem.findMany({
    where: { orderId, ...(opts.orderItemIds ? { id: { in: [...opts.orderItemIds] } } : {}) },
    select: { id: true, quoteId: true, quoteLineIndex: true, mappingId: true, serviceDate: true },
  });
  const out = new Map<string, CustomerTicketFacts>();
  if (items.length === 0) return out;
  const ids = items.map((i) => i.id);
  const [bookings, quotes] = await Promise.all([
    db.supplierBooking.findMany({ where: { orderItemId: { in: ids } }, select: { id: true, orderItemId: true, bookingKind: true, lastResponse: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    (() => {
      const quoteIds = [...new Set(items.flatMap((i) => (i.quoteId ? [i.quoteId] : [])))];
      return quoteIds.length ? db.quote.findMany({ where: { id: { in: quoteIds } }, select: { id: true, lines: true } }) : Promise.resolve([] as { id: string; lines: unknown }[]);
    })(),
  ]);
  const latest = new Map<string, { id: string; bookingKind: string; lastResponse: unknown }>();
  for (const b of bookings) if (b.orderItemId && !latest.has(b.orderItemId)) latest.set(b.orderItemId, b);

  const candidates = items.flatMap((item) => {
    const line = lineFor(item, quotes.find((q) => q.id === item.quoteId)?.lines);
    const booking = latest.get(item.id) ?? null;
    const isTicket = booking ? booking.bookingKind === "ticket_only" : line?.openDatedTicket === true;
    return isTicket ? [{ item, line, booking }] : [];
  });
  const ticketBookingIds = candidates.flatMap((c) => (c.booking ? [c.booking.id] : []));
  const codes = ticketBookingIds.length
    ? // Only the live code set (at most one valid or incomplete ticket-codes document per booking); superseded rows would count twice.
      await db.supplierTicketCode.findMany({
        where: { supplierBookingId: { in: ticketBookingIds }, document: { status: { in: ["valid", "incomplete"] } } },
        select: TICKET_FACT_SELECT,
        orderBy: [{ unitIndex: "asc" }],
      })
    : [];
  for (const c of candidates) {
    const issued = c.booking ? codes.filter((t) => t.supplierBookingId === c.booking!.id) : [];
    out.set(c.item.id, customerTicketFacts({ quoteValidUntil: c.line?.ticketValidUntil ?? null, issued, bookingValidUntil: bookingValidity(c.booking?.lastResponse) }));
  }
  return out;
}
