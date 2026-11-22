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
 * refused line, or an activity without another time to choose.
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
  if (!activity || activity.timeSlots.length < 2) return null;
  const q = new URLSearchParams({ date: item.date, retime: item.id });
  return `/activities/${encodeURIComponent(item.slug)}?${q.toString()}#book`;
}
