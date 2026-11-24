/**
 * External-supplier bookings (doc 29 Batch 6): the timing rules the engine
 * applies to an offer whose availability and confirmation come from a third
 * party behind TravelDesk (`isExternal`).
 *
 * TravelDesk's documentation and written answers (doc 29 §8.6, §8.7):
 *  - after the confirm, poll the booking every 10–15 s, never more often than
 *    every 10 s, until `isExternalConfirmationInProgress` is false; then read
 *    `isExternalBookingFailed`. A rejected booking is still created (201);
 *  - confirmation can take 10–15 minutes in peak season;
 *  - the reserve hold depends on the external provider (one holds only five
 *    minutes): always take the deadline from the reserve answer, never assume
 *    15 minutes.
 *
 * The rules, all provisional ops parameters:
 *
 *  1. Poll cadence. A poll is queued `EXTERNAL_POLL_INTERVAL_MS` (15 s) after
 *     the last read while the booking is inside its wait limit, and never
 *     sooner than `EXTERNAL_POLL_MIN_MS` (10 s). The worker runs on the
 *     one-minute booking tick and stops when nothing is due, so in practice a
 *     poll runs on the next tick, about once a minute: less often than
 *     TravelDesk's 10–15 s, never more often. After the hand-off the interval
 *     is a quarter of the time since the hand-off, from one minute up to
 *     `EXTERNAL_POLL_MAX_MS` (10 min); polling goes on until the supplier
 *     shows an end state.
 *
 *  2. Wait limit (`externalHandoffAt`). The booking waits in
 *     `awaiting_external` until the earlier of
 *       - `EXTERNAL_WAIT_LIMIT_MS` (30 min, at least the 20 minutes TravelDesk's
 *         peak-season answer calls for) after it entered the state, and
 *       - `EXTERNAL_NEAR_SERVICE_MS` (3 h) before the activity starts
 *         (Asia/Dubai; 00:00 on the service date when no start is known), so a
 *         person still has time to reach the guest or arrange an alternative,
 *     but never sooner than `EXTERNAL_WAIT_FLOOR_MS` (5 min) after it entered
 *     the state: a hand-off before the supplier had any chance to answer helps
 *     nobody.
 *     At the limit the booking is handed to our team (attention plus the
 *     `external_confirmation_handoff` ops alert). Nothing is refunded there:
 *     the booking may still confirm. The money goes back only once the
 *     supplier shows it failed or gone (`rejected`, `cancelled`, `expired`),
 *     through the payment saga's existing refund path.
 *
 *  3. Hold length (`externalHoldUsable`). A hold is usable only when the
 *     supplier's deadline is known and leaves at least `EXTERNAL_MIN_HOLD_MS`
 *     (10 min) after the reserve answer: the confirm send-by (deadline minus
 *     the 5-minute confirm budget), less the saga's 2-minute capture budget,
 *     less about two booking ticks. A shorter or unknown hold is never
 *     confirmed: its send-by reads as unknown, the payment saga releases the
 *     hold at once and voids the card authorisation (nothing is captured),
 *     and our team is told (`external_hold_unusable`), who can arrange the
 *     booking by hand.
 *
 * Pure: no env, db or logger.
 */

/** Interval between polls while inside the wait limit. */
export const EXTERNAL_POLL_INTERVAL_MS = 15_000;
/** TravelDesk: never poll more often than this. */
export const EXTERNAL_POLL_MIN_MS = 10_000;
/** Shortest interval after the hand-off. */
export const EXTERNAL_POLL_AFTER_HANDOFF_MS = 60_000;
/** Longest interval between polls. */
export const EXTERNAL_POLL_MAX_MS = 10 * 60_000;
/** Normal wait in `awaiting_external` before the hand-off. */
export const EXTERNAL_WAIT_LIMIT_MS = 30 * 60_000;
/** The hand-off comes no later than this before the activity starts. */
export const EXTERNAL_NEAR_SERVICE_MS = 3 * 3_600_000;
/** And no sooner than this after the booking entered `awaiting_external`. */
export const EXTERNAL_WAIT_FLOOR_MS = 5 * 60_000;
/** Least hold, from the reserve answer to the supplier's deadline, an external booking needs to be confirmed. */
export const EXTERNAL_MIN_HOLD_MS = 10 * 60_000;

/** `supplier_bookings.error_code` of the hand-off at the wait limit. */
export const EXTERNAL_HANDOFF_CODE = "external_confirmation_handoff";
/** `supplier_bookings.error_code` of a booking the external supplier failed (`isExternalBookingFailed`). */
export const EXTERNAL_FAILED_CODE = "external_booking_failed";
/** `supplier_bookings.error_code` of an external hold too short (or of unknown length) to confirm safely. */
export const EXTERNAL_HOLD_UNUSABLE_CODE = "external_hold_unusable";

/** Asia/Dubai is UTC+4 all year. */
const DUBAI_OFFSET_MS = 4 * 3_600_000;

/** UTC instant the activity starts: the slot start in Dubai, or 00:00 Dubai on the service date when none is known. */
export function serviceStartMs(serviceDate: string, startMinutes: number | null): number {
  return Date.parse(`${serviceDate}T00:00:00Z`) + (startMinutes ?? 0) * 60_000 - DUBAI_OFFSET_MS;
}

/** When a booking waiting on its external supplier since `since` is handed to our team (rule 2). */
export function externalHandoffAt(p: { since: Date; serviceDate: string; startMinutes: number | null }): Date {
  const since = p.since.getTime();
  const normal = since + EXTERNAL_WAIT_LIMIT_MS;
  const nearService = serviceStartMs(p.serviceDate, p.startMinutes) - EXTERNAL_NEAR_SERVICE_MS;
  return new Date(Math.max(since + EXTERNAL_WAIT_FLOOR_MS, Math.min(normal, nearService)));
}

/**
 * Delay before the next poll (rule 1). `msSinceHandoff` is null before the
 * hand-off; after it the delay is a quarter of the time since the hand-off,
 * between one and ten minutes.
 */
export function externalPollDelayMs(msSinceHandoff: number | null): number {
  if (msSinceHandoff === null) return Math.max(EXTERNAL_POLL_MIN_MS, EXTERNAL_POLL_INTERVAL_MS);
  const quarter = Math.floor(Math.max(0, msSinceHandoff) / 4);
  return Math.max(EXTERNAL_POLL_MIN_MS, Math.min(Math.max(EXTERNAL_POLL_AFTER_HANDOFF_MS, quarter), EXTERNAL_POLL_MAX_MS));
}

/** Whether an external hold answered at `reservedAt` with `deadline` may be confirmed (rule 3). Unknown is never usable. */
export function externalHoldUsable(reservedAt: Date | null, deadline: Date | null): boolean {
  if (!reservedAt || !deadline) return false;
  return deadline.getTime() - reservedAt.getTime() >= EXTERNAL_MIN_HOLD_MS;
}
