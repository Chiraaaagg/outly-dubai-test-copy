import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { amountIn, formatIn, priceInDisplay } from "./currency";
import type { Money, PaxCount } from "./types";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* ----------------------------------------------------------------------------
 * Money
 * ------------------------------------------------------------------------- */

/**
 * Money formatting delegates to `src/lib/currency.ts`, which owns the display
 * rules for all three currencies — INR and AED are stored, USD is derived from
 * AED at the central-bank peg. These names stay because most of the codebase
 * imports them, and they now take a `DisplayCurrency`, so a USD visitor sees
 * dollars everywhere and not only where `<Amount>` renders.
 */
export const formatMoney = formatIn;
export const pick = amountIn;
export const priceIn = priceInDisplay;

export function addMoney(a: Money, b: Money): Money {
  return { inr: a.inr + b.inr, aed: a.aed + b.aed };
}

export function scaleMoney(a: Money, n: number): Money {
  return { inr: Math.round(a.inr * n), aed: Math.round(a.aed * n) };
}

export const ZERO: Money = { inr: 0, aed: 0 };

export function savingsPercent(price: Money, compareAt?: Money): number | null {
  if (!compareAt || compareAt.inr <= price.inr) return null;
  return Math.round(((compareAt.inr - price.inr) / compareAt.inr) * 100);
}

/* ----------------------------------------------------------------------------
 * Pax
 * ------------------------------------------------------------------------- */

export const EMPTY_PAX: PaxCount = { adult: 2, child: 0, infant: 0, senior: 0 };

export function paxTotal(pax: PaxCount): number {
  return pax.adult + pax.child + pax.infant + pax.senior;
}

export function paxBillable(pax: PaxCount): number {
  // Infants are free on every OUTLYY SKU; they still occupy a seat count.
  return pax.adult + pax.child + pax.senior;
}

export function paxLabel(pax: PaxCount): string {
  const parts: string[] = [];
  if (pax.adult) parts.push(`${pax.adult} adult${pax.adult > 1 ? "s" : ""}`);
  if (pax.child) parts.push(`${pax.child} child${pax.child > 1 ? "ren" : ""}`);
  if (pax.senior) parts.push(`${pax.senior} senior${pax.senior > 1 ? "s" : ""}`);
  if (pax.infant) parts.push(`${pax.infant} infant${pax.infant > 1 ? "s" : ""}`);
  return parts.length ? parts.join(", ") : "No guests selected";
}

/* ----------------------------------------------------------------------------
 * Time & dates — all deterministic so SSR and client agree (no hydration drift)
 * ------------------------------------------------------------------------- */

export function formatDuration(minutes: number): string {
  if (!minutes || minutes <= 0) return "Duration on request";
  if (minutes >= 1440) {
    const days = Math.round(minutes / 1440);
    return `${days} day${days > 1 ? "s" : ""}`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h} ${h === 1 ? "hour" : "hours"}`;
  return `${m} min`;
}

export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Service dates are literal Asia/Dubai calendar days (PRD-18). Dubai is UTC+4
 * all year (no daylight saving), so the offset is a constant and the result
 * does not depend on the browser's or the server's own time zone.
 */
export const DUBAI_UTC_OFFSET_MS = 4 * 3600_000;

/** Today's service date in Dubai, `YYYY-MM-DD`. The one "today" for the widget, search and the quote. */
export function dubaiToday(now: Date = new Date()): string {
  return new Date(now.getTime() + DUBAI_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/** The UTC instant at which a Dubai service date starts (00:00 in Dubai). */
export function dubaiDayStartUtc(dateKey: string): Date {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) - DUBAI_UTC_OFFSET_MS);
}

const DUBAI_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DUBAI_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sun 15 Nov 2026, 21:00" for a date whose UTC fields hold the wall-clock time to show. */
function statementWords(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${DUBAI_WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${DUBAI_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm}`;
}

/** The statement for a booking that has no free-cancellation window (quote, review, status page). */
export const NON_REFUNDABLE_STATEMENT = "This booking is non-refundable once confirmed.";

/**
 * The one cancellation statement for an open-dated ticket (doc 29 §4.4,
 * Batch 5): the codes are issued at confirmation and TravelDesk cannot cancel
 * them. Shown on the product page, the checkout review, the status page, the
 * ticket card and the tickets email.
 */
export const TICKET_NON_REFUNDABLE_STATEMENT = "These tickets are non-refundable once issued.";

/**
 * The one cancellation statement for a quote or a booking, from the quote's
 * own `freeCancellationUntilUtc` (CR-B2-6; checkout redesign CO-01): the
 * exact deadline in Dubai time. The quote, the review step and the status
 * page all show these words, so the customer reads the same terms at every
 * step. null means none: non-refundable once confirmed.
 */
export function freeCancellationCopy(untilUtc: string | null): string {
  const ms = untilUtc ? Date.parse(untilUtc) : NaN;
  if (Number.isNaN(ms)) return NON_REFUNDABLE_STATEMENT;
  return `Free cancellation until ${statementWords(new Date(ms + DUBAI_UTC_OFFSET_MS))} Dubai time. After that, the booking is non-refundable.`;
}

/** The ticket validity line for open-dated tickets (TicketOnly), or null when the supplier gave no last day. */
export function ticketValidityCopy(validUntil: string | null | undefined): string | null {
  if (!validUntil || !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) return null;
  // Shape alone lets "2027-02-30" through, which the Date constructor rolls into March.
  if (toDateKey(parseDateKey(validUntil)) !== validUntil) return null;
  return `Ticket valid until ${formatDateLong(validUntil)}.`;
}

/**
 * The cancellation sentence before a server quote exists (activity widget,
 * trip, checkout details): the catalogue figure stated as the operator's
 * policy, with the exact terms confirmed at review. Same words everywhere
 * before the quote (CO-01); the quote's `freeCancellationCopy` replaces it
 * from the review step on.
 */
export function cancellationPolicyBeforeQuote(hours: number): string {
  if (!(hours > 0)) return "The operator's policy: non-refundable once confirmed. Your exact terms are confirmed with the price before you pay.";
  return `The operator's policy: free cancellation up to ${hours} hours before the start. Your exact deadline, in Dubai time, is confirmed with the price before you pay.`;
}

export function parseDateKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function addDays(key: string, days: number): string {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + days);
  return toDateKey(d);
}

export function formatDateKey(key: string, opts?: Intl.DateTimeFormatOptions): string {
  const d = parseDateKey(key);
  return d.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...opts,
  });
}

export function formatDateLong(key: string): string {
  return parseDateKey(key).toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/* ----------------------------------------------------------------------------
 * Deterministic pseudo-randomness.
 * Availability, "X booked this month" style numbers and mock latency all derive
 * from a hash of stable inputs — never Math.random — so the server and the
 * client render identical markup and no fake scarcity can drift between views.
 * ------------------------------------------------------------------------- */

export function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function seeded(input: string, max: number): number {
  return hash(input) % max;
}

/* ----------------------------------------------------------------------------
 * Misc
 * ------------------------------------------------------------------------- */

export function slugToTitle(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function pluralise(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export function bookingReference(seed: string): string {
  const n = seeded(seed, 900000) + 100000;
  return `OUT-${n}`;
}
