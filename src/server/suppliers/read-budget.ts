/**
 * Classes of supplier read in the shared per-account read budget (SUP-6,
 * CR-B2-3). The budget itself is one row per account in `settings`, counted
 * on the database clock (`takeReadToken` in supplier-booking.service.ts);
 * this module holds the rule it applies, so the rule can be tested without a
 * database.
 *
 * - `engine`: recovery, polls, the watchdog, reconciliation, worker reads and
 *   the catalogue sync. They may use the whole window.
 * - `quote`: customer quote reads (availability, ticket stock and the pickup
 *   hotel list). They may use at most `quoteCap` reads of the window.
 * - `browse` (doc 29 §6.3, Batches 2 and 3): unauthenticated page reads: an
 *   offer's start times on a date (`/api/catalog/start-times`) and its pickup
 *   hotel list (`/api/catalog/pickup-hotels`), both through
 *   `takeBrowseReadToken`. They may use at most `browseCap` reads, a share
 *   carved out of the customer share (quote plus browse), never out of the
 *   engine reserve, and never a read the quote share could still need: a
 *   browse read is refused when, after it, the window would have less room
 *   left than the quotes' unused share.
 *
 * Every read, of any class, counts towards the window total. Because quotes
 * can never hold more than `quoteCap` of it and browse reads more than
 * `browseCap`, and the two caps together are the customer share, engine reads
 * always have at least `engineReserve` reads per window whatever the customer
 * traffic: an engine read is refused only when the whole window is spent, and
 * by then the engine itself has used at least its reserve. A browse flood
 * changes neither guarantee, nor how many quote reads are admitted: browse
 * yields to quotes and engine. Decision of 23 November 2026, doc 29 §6.5.
 */

export type ReadClass = "engine" | "quote" | "browse";

/**
 * Which page a browse read is for (review 82, cross-feature Low). Start-time
 * date stepping may use at most `startTimesCap` of the browse share, so the
 * rest stays for pickup hotel lists: a burst of date stepping can no longer
 * leave a pickup buyer's hotel list `unavailable`. Hotel lists may use the
 * whole browse share; they are kept 10 minutes per offer on the server, and
 * a start-times page that loses a read still shows its stored times.
 */
export type BrowseRoute = "start_times" | "pickup_hotels";

/**
 * Supplier reads per account per minute, all classes together.
 * PROVISIONAL ops parameter: TravelDesk gives no numeric rate limit (Q-O1); to be
 * set from the supplier's answer or observed throttling.
 */
export const DEFAULT_READ_BUDGET_PER_MINUTE = 120;

/**
 * Largest share of each window that customer reads (quote and browse
 * together) may use, rounded down; the rest is the engine reserve. With the
 * default budget, 30 customer reads per minute and a 90-read engine reserve.
 * PROVISIONAL ops parameter: to be tuned from real quote traffic and the
 * engine's recovery load.
 */
export const QUOTE_READ_SHARE = 0.25;

/**
 * Largest share of each window that browse reads may use, rounded down. It is
 * carved out of the customer share above, never out of the engine reserve
 * (doc 29 §6.3), so the quotes keep the rest of that share. With the default
 * budget: 18 quote, 12 browse, 90 engine reserve.
 * PROVISIONAL ops parameter, like the two above.
 */
export const BROWSE_READ_SHARE = 0.1;

/**
 * Part of the browse share kept for pickup hotel lists, rounded up: start
 * times may use the rest (`startTimesCap`). With the default budget, start
 * times 8 and hotel lists at least 4 of the 12 browse reads a minute.
 * PROVISIONAL ops parameter, like the shares above.
 */
export const PICKUP_HOTELS_BROWSE_RESERVE = 1 / 3;

export interface ReadLimits {
  /** Reads per window, all classes. */
  perMinute: number;
  /** Most quote reads per window. */
  quoteCap: number;
  /** Most browse reads per window; absent counts as 0 (browse refused). */
  browseCap?: number;
  /** Most start-times browse reads per window (`BrowseRoute`); absent: no limit beyond `browseCap`. */
  startTimesCap?: number;
  /** Least engine reads per window, whatever quotes and browse have used. */
  engineReserve: number;
}

const clampShare = (s: number) => (Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0);

/**
 * The limits for a budget, customer share and browse share. A share outside
 * 0…1 is clamped and a non-number share gives that class nothing. The browse
 * cap comes out of the customer share (never more than all of it) and the
 * quotes keep the rest, so the engine reserve is the budget less the customer
 * share whatever the browse share. With no browse share the quotes have the
 * whole customer share.
 */
export function readLimits(perMinute = DEFAULT_READ_BUDGET_PER_MINUTE, customerShare = QUOTE_READ_SHARE, browseShare = 0, hotelReserveShare?: number): ReadLimits {
  const total = Math.max(0, Math.floor(perMinute));
  const customer = Math.floor(total * clampShare(customerShare));
  const browseCap = Math.min(customer, Math.floor(total * clampShare(browseShare)));
  const limits: ReadLimits = { perMinute: total, quoteCap: customer - browseCap, browseCap, engineReserve: total - customer };
  // The hotel lists' reserve inside browse; start times get the rest.
  if (hotelReserveShare !== undefined) limits.startTimesCap = browseCap - Math.min(browseCap, Math.ceil(browseCap * clampShare(hotelReserveShare)));
  return limits;
}

/**
 * The one budget every taker uses (N5): engine reads, reconciliation, the
 * catalogue sync and customer quotes all derive their limits from this single
 * object, so the engine reserve can never shrink because one caller was given
 * a different total than another. Production code never passes another
 * value; the engine's `readLimits` dependency exists for tests only, and
 * replaces the whole object (total and quote cap together).
 */
export const READ_BUDGET: ReadLimits = readLimits(DEFAULT_READ_BUDGET_PER_MINUTE, QUOTE_READ_SHARE, BROWSE_READ_SHARE, PICKUP_HOTELS_BROWSE_RESERVE);

/** Reads already taken in the current window. `browseUsed` and `startTimesUsed` absent count as 0 (rows written before them). */
export interface ReadWindow {
  used: number;
  quoteUsed: number;
  browseUsed?: number;
  /** Browse reads for start times (part of `browseUsed`). */
  startTimesUsed?: number;
}

/**
 * The window after one more read of `cls`, or null when it is refused. A
 * fresh window starts from `{ used: 0, quoteUsed: 0 }`. `route` names the
 * page of a browse read; a start-times read is also held to `startTimesCap`.
 * `takeReadToken` applies the same rule in one SQL update.
 */
export function admitRead(window: ReadWindow, cls: ReadClass, limits: ReadLimits, route?: BrowseRoute): ReadWindow | null {
  if (window.used >= limits.perMinute) return null;
  if (cls === "quote" && window.quoteUsed >= limits.quoteCap) return null;
  const browseUsed = window.browseUsed ?? 0;
  const startTimesUsed = window.startTimesUsed ?? 0;
  const startTimes = cls === "browse" && route === "start_times";
  if (cls === "browse") {
    if (browseUsed >= (limits.browseCap ?? 0)) return null;
    // Never a read the quotes' unused share could still need.
    if (window.used + 1 + Math.max(0, limits.quoteCap - window.quoteUsed) > limits.perMinute) return null;
    // Start times leave the hotel lists their reserve.
    if (startTimes && limits.startTimesCap !== undefined && startTimesUsed >= limits.startTimesCap) return null;
  }
  const next: ReadWindow = { used: window.used + 1, quoteUsed: window.quoteUsed + (cls === "quote" ? 1 : 0) };
  if (cls === "browse" || window.browseUsed !== undefined) next.browseUsed = browseUsed + (cls === "browse" ? 1 : 0);
  if (startTimes || window.startTimesUsed !== undefined) next.startTimesUsed = startTimesUsed + (startTimes ? 1 : 0);
  return next;
}
