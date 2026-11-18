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
 *
 * Every read, of either class, counts towards the window total. Because
 * quotes can never hold more than `quoteCap` of it, engine reads always have
 * at least `engineReserve` reads per window whatever the quote traffic: an
 * engine read is refused only when the whole window is spent, and by then
 * the engine itself has used at least its reserve.
 */

export type ReadClass = "engine" | "quote";

/**
 * Supplier reads per account per minute, all classes together.
 * PROVISIONAL ops parameter: TravelDesk gives no numeric rate limit (Q-O1); to be
 * set from the supplier's answer or observed throttling.
 */
export const DEFAULT_READ_BUDGET_PER_MINUTE = 120;

/**
 * Largest share of each window that quote reads may use, rounded down; the
 * rest is reserved for engine reads. With the default budget, 30 quote reads
 * and a 90-read engine reserve per minute.
 * PROVISIONAL ops parameter: to be tuned from real quote traffic and the
 * engine's recovery load.
 */
export const QUOTE_READ_SHARE = 0.25;

export interface ReadLimits {
  /** Reads per window, all classes. */
  perMinute: number;
  /** Most quote reads per window. */
  quoteCap: number;
  /** Least engine reads per window, whatever quotes have used. */
  engineReserve: number;
}

/** The limits for a budget and quote share. A share outside 0…1 is clamped; a non-number share gives quotes nothing. */
export function readLimits(perMinute = DEFAULT_READ_BUDGET_PER_MINUTE, quoteShare = QUOTE_READ_SHARE): ReadLimits {
  const total = Math.max(0, Math.floor(perMinute));
  const share = Number.isFinite(quoteShare) ? Math.min(1, Math.max(0, quoteShare)) : 0;
  const quoteCap = Math.floor(total * share);
  return { perMinute: total, quoteCap, engineReserve: total - quoteCap };
}

/**
 * The one budget every taker uses (N5): engine reads, reconciliation, the
 * catalogue sync and customer quotes all derive their limits from this single
 * object, so the engine reserve can never shrink because one caller was given
 * a different total than another. Production code never passes another
 * value; the engine's `readLimits` dependency exists for tests only, and
 * replaces the whole object (total and quote cap together).
 */
export const READ_BUDGET: ReadLimits = readLimits(DEFAULT_READ_BUDGET_PER_MINUTE, QUOTE_READ_SHARE);

/** Reads already taken in the current window. */
export interface ReadWindow {
  used: number;
  quoteUsed: number;
}

/**
 * The window after one more read of `cls`, or null when it is refused. A
 * fresh window starts from `{ used: 0, quoteUsed: 0 }`. `takeReadToken`
 * applies the same rule in one SQL update.
 */
export function admitRead(window: ReadWindow, cls: ReadClass, limits: ReadLimits): ReadWindow | null {
  if (window.used >= limits.perMinute) return null;
  if (cls === "quote" && window.quoteUsed >= limits.quoteCap) return null;
  return { used: window.used + 1, quoteUsed: window.quoteUsed + (cls === "quote" ? 1 : 0) };
}
