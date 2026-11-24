/**
 * External-supplier bookings (doc 29 Batch 6): the timing rules the engine
 * applies to an offer whose availability and confirmation come from a third
 * party behind TravelDesk (`isExternal`). Only an attempt on that route
 * (`supplier_bookings.external_route`) follows them; every other attempt keeps
 * the rules of Batches 0–5.
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
 * The rules (owner decisions of 24 November 2026; the numbers are provisional
 * ops parameters):
 *
 *  1. Poll cadence. A poll is queued `EXTERNAL_POLL_INTERVAL_MS` (15 s) after
 *     the last read while the booking waits inside its wait limit, never
 *     sooner than `EXTERNAL_POLL_MIN_MS` (10 s). The booking tick runs once a
 *     minute, so the scheduled worker waits inside its run for a poll due
 *     within 15 s, at most `EXTERNAL_POLL_WAITS_PER_RUN` (3) times: up to four
 *     reads a minute, spaced by the queue, bounded by the run's time budget
 *     and the read budget. Only the `EXTERNAL_FAST_POLL_MAX` (8)
 *     longest-waiting bookings of an account poll at 15 s; the others are
 *     read once a minute, so the fast cadence takes at most 32 of the
 *     engine's 90 reads a minute. After the hand-off the interval is a quarter of the
 *     time since the hand-off, from one minute up to `EXTERNAL_POLL_MAX_MS`
 *     (10 min); polling goes on until the supplier shows an end state.
 *
 *  2. Wait limit (`externalHandoffAt`). The booking waits in
 *     `awaiting_external` until the earlier of
 *       - `EXTERNAL_WAIT_LIMIT_MS` (30 min) after it entered the state, and
 *       - `EXTERNAL_NEAR_SERVICE_MS` (3 h) before the guest is affected: the
 *         pickup time when the supplier gave one, else the activity start
 *         (Asia/Dubai; 00:00 on the service date when no start is known),
 *     but never sooner than `EXTERNAL_WAIT_FLOOR_MS` (5 min) after it entered
 *     the state. The hand-off is decided on time, not on a successful read:
 *     our team is told (attention, `external_confirmation_handoff`, ops
 *     alert) even while every read fails. Nothing is refunded at the limit:
 *     the booking may still confirm. The money goes back only once the
 *     supplier shows it failed or gone (`rejected`, `cancelled`, `expired`),
 *     through the payment saga's existing refund path. At the activity start,
 *     still unconfirmed, our team is told again (`external_unconfirmed_at_start`).
 *
 *  3. Hold length (`externalHoldUsable`, owner decision a). Short provider
 *     holds may sell. A hold is usable when the supplier's deadline is known
 *     and leaves at least `EXTERNAL_MIN_HOLD_MS` (3 min 30 s) after the reserve
 *     answer. Its confirm send-by is the deadline less
 *     `EXTERNAL_CONFIRM_MARGIN_MS` (60 s); the saga captures only before the
 *     send-by less its 2-minute capture budget, so a usable hold leaves at
 *     least 30 s to capture, and the reserve, the capture and the confirm run
 *     in one booking tick (the saga is told inline). A confirm sent near the
 *     send-by can still land after the hold lapses (a confirm call may take up
 *     to the mutation timeout): TravelDesk then refuses it or its outcome is
 *     unknown, recovery reads the hold expired, and the saga refunds. A
 *     shorter hold, or one of unknown length, has no send-by: it is never
 *     confirmed, the saga releases it at once (voided on an authorise-first
 *     gateway, refunded on a capture-first one), our team is told
 *     (`external_hold_unusable`), and the customer is offered "Send it to our
 *     team".
 *
 *  4. Reservation still in progress (review 89 B6-03). A reserve answer whose
 *     `isExternalConfirmationInProgress` is true is no usable hold yet: the
 *     booking stays `reserved` (the saga does not capture), is re-read every
 *     15 s, and is released `EXTERNAL_IN_PROGRESS_RELEASE_LEAD_MS` (2 min, the
 *     saga's capture budget) before its send-by if it is still in progress;
 *     like an unusable hold, our team is then told
 *     (`external_reservation_released`) and the customer is offered "Send it
 *     to our team".
 *
 *  5. A failed booking after its charge (review 89 B6-05) counts as an open
 *     hold of the wallet for `EXTERNAL_REJECTED_HELD_MS` (24 h) while no refund
 *     is recorded, so the funds check does not fail closed on money the
 *     supplier has not given back yet.
 *
 * Pure: no env, db or logger.
 */

/** Interval between polls while inside the wait limit. */
export const EXTERNAL_POLL_INTERVAL_MS = 15_000;
/** TravelDesk: never poll more often than this. */
export const EXTERNAL_POLL_MIN_MS = 10_000;
/** How many times one scheduled worker run waits for a poll due within the interval (rule 1): up to four reads a minute. */
export const EXTERNAL_POLL_WAITS_PER_RUN = 3;
/**
 * Review 89 B6-17: at most this many waiting external bookings per account
 * are polled at the 15 s cadence, the longest-waiting first; the others are
 * read once a minute (`EXTERNAL_POLL_SLOW_MS`) until a fast place frees up.
 * 8 × 4 = 32 reads a minute at most from the engine's 90-a-minute reserve,
 * plus one a minute for each further waiting booking.
 */
export const EXTERNAL_FAST_POLL_MAX = 8;
/** Cadence of a waiting external booking outside the fast set. */
export const EXTERNAL_POLL_SLOW_MS = 60_000;
/** Shortest interval after the hand-off. */
export const EXTERNAL_POLL_AFTER_HANDOFF_MS = 60_000;
/** Longest interval between polls. */
export const EXTERNAL_POLL_MAX_MS = 10 * 60_000;
/** Normal wait in `awaiting_external` before the hand-off. */
export const EXTERNAL_WAIT_LIMIT_MS = 30 * 60_000;
/** The hand-off comes no later than this before the guest is affected (pickup, else start). */
export const EXTERNAL_NEAR_SERVICE_MS = 3 * 3_600_000;
/** And no sooner than this after the booking entered `awaiting_external`. */
export const EXTERNAL_WAIT_FLOOR_MS = 5 * 60_000;
/** An external confirm is sent no later than this before the hold's deadline (owner decision a). */
export const EXTERNAL_CONFIRM_MARGIN_MS = 60_000;
/** Least hold, from the reserve answer to the supplier's deadline, an external booking needs: margin + 2-min capture budget + 30 s. */
export const EXTERNAL_MIN_HOLD_MS = 3 * 60_000 + 30_000;
/** A reservation still in progress is released this long before its confirm send-by (the saga's capture budget). */
export const EXTERNAL_IN_PROGRESS_RELEASE_LEAD_MS = 2 * 60_000;
/** A failed external booking with a recorded charge and no recorded refund counts as an open wallet hold this long. */
export const EXTERNAL_REJECTED_HELD_MS = 24 * 3_600_000;

/** `supplier_bookings.error_code` of the hand-off at the wait limit. */
export const EXTERNAL_HANDOFF_CODE = "external_confirmation_handoff";
/** `supplier_bookings.error_code` of a booking still unconfirmed when the guest is affected. */
export const EXTERNAL_PAST_START_CODE = "external_unconfirmed_at_start";
/** `supplier_bookings.error_code` of a booking the external supplier failed (`isExternalBookingFailed`). */
export const EXTERNAL_FAILED_CODE = "external_booking_failed";
/** `supplier_bookings.error_code` of a confirmed external booking that reconciliation finds failed or in progress again (review 89 B6-18). */
export const EXTERNAL_FAILED_AFTER_CONFIRM_CODE = "external_failed_after_confirm";
/** `supplier_bookings.error_code` of an external hold too short (or of unknown length) to confirm safely. */
export const EXTERNAL_HOLD_UNUSABLE_CODE = "external_hold_unusable";
/** `supplier_bookings.error_code` of an external reservation the provider is still making (rule 4). */
export const EXTERNAL_HOLD_IN_PROGRESS_CODE = "external_reservation_in_progress";
/** `supplier_bookings.error_code` of a reservation released while the provider was still making it (rule 4; review 89 B6-15). */
export const EXTERNAL_RESERVATION_RELEASED_CODE = "external_reservation_released";
/** Codes kept through the release that follows, for the ops alert and the "Send it to our team" offer. */
export const EXTERNAL_RELEASE_CODES: readonly string[] = [EXTERNAL_HOLD_UNUSABLE_CODE, EXTERNAL_RESERVATION_RELEASED_CODE];

/** Asia/Dubai is UTC+4 all year. */
const DUBAI_OFFSET_MS = 4 * 3_600_000;

/** UTC instant of the given minutes after midnight in Dubai on the service date (00:00 Dubai when none is known). */
export function serviceStartMs(serviceDate: string, startMinutes: number | null): number {
  return Date.parse(`${serviceDate}T00:00:00Z`) + (startMinutes ?? 0) * 60_000 - DUBAI_OFFSET_MS;
}

/** The minute the guest is first affected (review 89 B6-08): the supplier's pickup time when earlier than the start. */
export function externalWaitStartMinutes(startMinutes: number | null, pickupMinutes: number | null): number | null {
  if (typeof pickupMinutes === "number" && (startMinutes === null || pickupMinutes < startMinutes)) return pickupMinutes;
  return startMinutes;
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
