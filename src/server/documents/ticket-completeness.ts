/**
 * Completeness of an issued ticket set (TKT-2, F48), per ticket type.
 *
 * TravelDesk (doc 29 §8.6, OpenAPI): an offer that combines admissions (for
 * example two attractions in one offer) returns one code per guest for each
 * ticket type, each labelled by `ticketTypeId` and `ticketTypeName`. External
 * codes carry no `ticketTypeId`; their `ticketTypeName` (the supplier's
 * product name) is the type. So a set is complete when, for every distinct
 * type present, the codes per guest category equal the booked guests:
 *  - adults and children: exactly the booked count, per type;
 *  - infants: exactly the booked count for a type that tickets infants (it
 *    carries at least one infant code); a type with no infant code does not
 *    ticket infants (infants are free there) and is not checked for them.
 * A single-type offer reduces to one comparison per category. More codes
 * than guests in a category of one type, or a type with fewer codes, is
 * incomplete (fail closed). Codes whose category Outly cannot map
 * (`unknown`) never count, towards a type or otherwise.
 *
 * Pure: no database, no codes read (only the category and type labels).
 */

import type { IssuedTicket } from "./contracts";

export interface BookedGuests {
  adult: number;
  child: number;
  infant: number;
}

type TicketLabels = Pick<IssuedTicket, "ticketFor" | "ticketTypeId" | "ticketTypeName">;

/** The type a code belongs to: its id, else its name (external codes), else the one untyped group. */
export function ticketTypeKey(t: Pick<IssuedTicket, "ticketTypeId" | "ticketTypeName">): string {
  if (t.ticketTypeId !== null && t.ticketTypeId !== "") return `id:${t.ticketTypeId}`;
  if (t.ticketTypeName !== null && t.ticketTypeName !== "") return `name:${t.ticketTypeName}`;
  return "untyped";
}

/** True when every ticket type present has exactly one code per booked guest in each ticketed category. */
export function isCompleteTicketSet(booked: BookedGuests, tickets: readonly TicketLabels[]): boolean {
  const byType = new Map<string, BookedGuests>();
  for (const t of tickets) {
    if (t.ticketFor === "unknown") continue;
    const key = ticketTypeKey(t);
    const counts = byType.get(key) ?? { adult: 0, child: 0, infant: 0 };
    counts[t.ticketFor] += 1;
    byType.set(key, counts);
  }
  if (byType.size === 0) return false;
  for (const counts of byType.values()) {
    if (counts.adult !== booked.adult || counts.child !== booked.child) return false;
    if (counts.infant > 0 && counts.infant !== booked.infant) return false;
  }
  return true;
}
