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
 *   `takeBrowseReadToken`. They may use at most `browseCap` reads,
 *   a share of their own beside the quote share, and never a read the quote
 *   share could still need: a browse read is refused when, after it, the
 *   window would have less room left than the quotes' unused share.
 *
 * Every read, of any class, counts towards the window total. Because quotes
 * can never hold more than `quoteCap` of it and browse reads more than
 * `browseCap`, engine reads always have at least `engineReserve` reads per
 * window whatever the customer traffic: an engine read is refused only when
 * the whole window is spent, and by then the engine itself has used at least
 * its reserve. A browse flood changes neither guarantee, nor how many quote
 * reads are admitted: browse yields to quotes and engine.
 */

export type ReadClass = "engine" | "quote" | "browse";

/**
 * Supplier reads per account per minute, all classes together.
 * PROVISIONAL ops parameter: TravelDesk gives no numeric rate limit (Q-O1); to be
 * set from the supplier's answer or observed throttling.
 */
export const DEFAULT_READ_BUDGET_PER_MINUTE = 120;

/**
 * Largest share of each window that quote reads may use, rounded down; the
 * rest is left to browse and engine reads. With the default budget, 30 quote
 * reads per minute (and, after the browse share below, a 78-read engine
 * reserve).
 * PROVISIONAL ops parameter: to be tuned from real quote traffic and the
 * engine's recovery load.
 */
export const QUOTE_READ_SHARE = 0.25;

/**
 * Largest share of each window that browse reads may use, rounded down; it
 * comes out of what was the engine-only remainder, so the quote share is
 * unchanged. With the default budget: 30 quote, 12 browse, 78 engine reserve.
 * PROVISIONAL ops parameter, like the two above.
 */
export const BROWSE_READ_SHARE = 0.1;

export interface ReadLimits {
  /** Reads per window, all classes. */
  perMinute: number;
  /** Most quote reads per window. */
  quoteCap: number;
  /** Most browse reads per window; absent counts as 0 (browse refused). */
  browseCap?: number;
  /** Least engine reads per window, whatever quotes and browse have used. */
  engineReserve: number;
}

const clampShare = (s: number) => (Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0);

/**
 * The limits for a budget, quote share and browse share. A share outside
 * 0…1 is clamped and a non-number share gives that class nothing; the browse
 * share never takes more than the quote share leaves.
 */
export function readLimits(perMinute = DEFAULT_READ_BUDGET_PER_MINUTE, quoteShare = QUOTE_READ_SHARE, browseShare = 0): ReadLimits {
  const total = Math.max(0, Math.floor(perMinute));
  const quoteCap = Math.floor(total * clampShare(quoteShare));
  const browseCap = Math.min(total - quoteCap, Math.floor(total * clampShare(browseShare)));
  return { perMinute: total, quoteCap, browseCap, engineReserve: total - quoteCap - browseCap };
}

/**
 * The one budget every taker uses (N5): engine reads, reconciliation, the
 * catalogue sync and customer quotes all derive their limits from this single
 * object, so the engine reserve can never shrink because one caller was given
 * a different total than another. Production code never passes another
 * value; the engine's `readLimits` dependency exists for tests only, and
 * replaces the whole object (total and quote cap together).
 */
export const READ_BUDGET: ReadLimits = readLimits(DEFAULT_READ_BUDGET_PER_MINUTE, QUOTE_READ_SHARE, BROWSE_READ_SHARE);

/** Reads already taken in the current window. `browseUsed` absent counts as 0 (rows written before the browse class). */
export interface ReadWindow {
  used: number;
  quoteUsed: number;
  browseUsed?: number;
}

/**
 * The window after one more read of `cls`, or null when it is refused. A
 * fresh window starts from `{ used: 0, quoteUsed: 0 }`. `takeReadToken`
 * applies the same rule in one SQL update.
 */
export function admitRead(window: ReadWindow, cls: ReadClass, limits: ReadLimits): ReadWindow | null {
  if (window.used >= limits.perMinute) return null;
  if (cls === "quote" && window.quoteUsed >= limits.quoteCap) return null;
  const browseUsed = window.browseUsed ?? 0;
  if (cls === "browse") {
    if (browseUsed >= (limits.browseCap ?? 0)) return null;
    // Never a read the quotes' unused share could still need.
    if (window.used + 1 + Math.max(0, limits.quoteCap - window.quoteUsed) > limits.perMinute) return null;
  }
  const next: ReadWindow = { used: window.used + 1, quoteUsed: window.quoteUsed + (cls === "quote" ? 1 : 0) };
  if (cls === "browse" || window.browseUsed !== undefined) next.browseUsed = browseUsed + (cls === "browse" ? 1 : 0);
  return next;
}
