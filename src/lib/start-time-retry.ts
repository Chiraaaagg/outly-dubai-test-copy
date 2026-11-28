import type { LineRestoreReason } from "./pricing";
import type { Activity, CartItem } from "./types";

/**
 * Stale start time at quote (doc 29 Batch 2, §3.5: "focus moves to the
 * control that must change after a refusal"). When the server quote refuses
 * a cart line only because its start time is gone (`sold_out`) or not one of
 * the supplier's listed starts (`invalid_slot`), and the activity has other
 * times, checkout offers "Choose another time": back to the activity page,
 * where the widget restores the line, says the time is gone and moves focus
 * to the start times. Choosing again replaces the line in the cart.
 *
 * The link carries the date and the cart line id (slug, date, time, variant):
 * no person, no amount. The server re-quotes the new time; nothing here
 * decides what may be sold.
 */

export const RETIME_REASONS: readonly string[] = ["sold_out", "invalid_slot"];

/** Cart line ids as `toCartItem` builds them; anything else is ignored. */
const LINE_ID = /^[a-z0-9-]{1,80}-\d{4}-\d{2}-\d{2}-[A-Za-z0-9: ]{1,20}-[a-z0-9-]{1,60}$/;

export function parseRetimeId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  return v.length <= 200 && LINE_ID.test(v) ? v : null;
}

/**
 * The "Choose another time" link for a refused quote, or null when a new
 * time cannot fix it: any refused line for another reason, more than one
 * refused line, or an activity without another time to choose (a date-only
 * activity, with no stored times, counts when its line carries a start).
 */
export function retimeHrefFor(
  refused: readonly { index: number; reason: string }[],
  cart: readonly CartItem[],
  activities: readonly Pick<Activity, "slug" | "timeSlots">[],
): string | null {
  if (refused.length === 0 || refused.some((l) => !RETIME_REASONS.includes(l.reason))) return null;
  const indexes = new Set(refused.map((l) => l.index));
  if (indexes.size !== 1) return null;
  const item = cart[[...indexes][0]];
  if (!item || item.kind !== "activity" || !parseRetimeId(item.id)) return null;
  const activity = activities.find((a) => a.slug === item.slug);
  // Doc 29 Batch 7 (review 92 B7-06): a page with no stored times whose line carries a start came from a date-only
  // offer's fresh starts; the activity page reads them again, so another time can be chosen there.
  const dateOnlyStart = activity?.timeSlots.length === 0 && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.time);
  if (!activity || (activity.timeSlots.length < 2 && !dateOnlyStart)) return null;
  const q = new URLSearchParams({ date: item.date, retime: item.id });
  return `/activities/${encodeURIComponent(item.slug)}?${q.toString()}#book`;
}

/**
 * Refusals the guests can fix on the activity page (guest picker fix, D1): a
 * guest type the option has no unit for (`unknown_unit`), or a number its
 * units do not take (`unit_rule_failed`).
 */
export const GUEST_REASONS: readonly string[] = ["unknown_unit", "unit_rule_failed"];

/**
 * The "Change guests" link for a refused quote, or null when changing the
 * guests cannot fix it: any refused line for another reason, or more than
 * one refused line. Like "Choose another time" it restores the cart line on
 * its activity page (`retime`, the line id), marked `change=guests`: the
 * widget keeps the line's time, drops the guests its option cannot book,
 * says so and moves focus to the guests. Continuing replaces the line.
 */
export function guestsHrefFor(refused: readonly { index: number; reason: string }[], cart: readonly CartItem[]): string | null {
  if (refused.length === 0 || refused.some((l) => !GUEST_REASONS.includes(l.reason))) return null;
  const indexes = new Set(refused.map((l) => l.index));
  if (indexes.size !== 1) return null;
  const item = cart[[...indexes][0]];
  if (!item || item.kind !== "activity" || !parseRetimeId(item.id)) return null;
  const q = new URLSearchParams({ date: item.date, retime: item.id, change: "guests" });
  return `/activities/${encodeURIComponent(item.slug)}?${q.toString()}#book`;
}

/** Why a restored line was sent back (`change` in the activity page URL); anything but "guests" is the start time. */
export function parseRestoreReason(raw: string | null | undefined): LineRestoreReason {
  return raw === "guests" ? "guests" : "time";
}

/**
 * The start time the checkout review shows for a line (doc 29 Batch 7, owner
 * decision c): the quoted supplier start (`<timeSlotId>@HH:mm`) when the
 * cart line has no time of its own, as for a date-only offer whose one row
 * names a real start; otherwise the cart line's time.
 */
export function reviewTime(itemTime: string, quotedSlotRef: string | null): string {
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(itemTime)) return itemTime;
  const m = quotedSlotRef ? /@(([01]\d|2[0-3]):[0-5]\d)$/.exec(quotedSlotRef) : null;
  return m ? m[1] : itemTime;
}

/** What the product page says for a date-only date with one start (doc 29 Batch 7). */
export interface DateOnlyStartView {
  /** "Starts 15:00", or why the date cannot be booked; null when there is nothing to say. */
  line: string | null;
  /** "Pickup time is on your voucher." for a pickup offer the guest can book; null otherwise. */
  note: string | null;
  /** The guest cannot continue on this date. */
  blocked: boolean;
}

/**
 * The one-start date-only view (owner decision c; review 92 B7-11, B7-13).
 *  - The start is shown only as the activity's start ("Starts 15:00"), never
 *    as a pickup time: TravelDesk returns the pickup time on the booking,
 *    and the availability row's start is not it. A pickup offer adds
 *    "Pickup time is on your voucher."
 *  - A date the quote would refuse (`status` not available or limited: not
 *    offered that weekday, past the cut-off, sold out, unpriced) shows no
 *    start and blocks: "Not available on this date. Choose another date."
 *  - A line sent back from checkout because this very start was refused is
 *    never sent back to it: on the same date and start it blocks with
 *    "Choose another date", whatever a cached answer says.
 */
export function dateOnlyStartView(input: {
  startsAt: string | null;
  status: "available" | "limited" | "sold_out" | "unavailable";
  pickup: boolean;
  date: string;
  retime: { date: string; time: string } | null;
}): DateOnlyStartView {
  const refusedHere = input.retime !== null && input.retime.date === input.date && input.startsAt !== null && input.retime.time === input.startsAt;
  if (refusedHere) return { line: `The ${input.startsAt} start can't be booked for your group on this date. Choose another date.`, note: null, blocked: true };
  if (input.status !== "available" && input.status !== "limited") return { line: "Not available on this date. Choose another date.", note: null, blocked: true };
  return { line: input.startsAt ? `Starts ${input.startsAt}` : null, note: input.pickup ? "Pickup time is on your voucher." : null, blocked: false };
}
