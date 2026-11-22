import type { PickupHotelList, PickupHotelOption } from "@/lib/api/pickup-hotels";
import type { Activity, CartItem, PickupHotelChoice } from "@/lib/types";

/**
 * Which hotel each pickup activity in the cart collects from (doc 29 §7.3
 * Batch 3; owner decision §8.4 row 11, conflict C2): **one hotel field for
 * the whole cart**, and a separate choice for one activity only when that
 * activity's own hotel list does not contain the hotel chosen for the cart.
 *
 * The chosen hotel goes on each pickup cart line (`CartItem.pickupHotel`:
 * TravelDesk id and display name), never into a URL; the quote sends the id
 * and the server checks it against the offer's list again. Pure, so the
 * rules are tested without the page.
 */

export type ListState = PickupHotelList | { status: "loading" };

export interface PickupItem {
  itemId: string;
  title: string;
  productId: string;
  variantId: string;
  /** `productId:variantId`: one list per key. */
  listKey: string;
  chosen: PickupHotelChoice | undefined;
}

export type PickupStatus =
  | { kind: "loading" }
  | { kind: "unavailable" }
  /** The cart hotel is on this activity's list, or none is chosen yet. */
  | { kind: "cart" }
  /** The cart hotel is not on this activity's list: it needs its own choice from `hotels`. */
  | { kind: "own"; hotels: PickupHotelOption[] };

export interface PickupPlanRow {
  item: PickupItem;
  status: PickupStatus;
  /** The hotel this line will be quoted with, or null. */
  hotel: PickupHotelChoice | null;
}

/** The cart lines that need a pickup hotel, with the variant the quote will price (as `quoteLinesFor` picks it). */
export function pickupItemsFor(cart: readonly CartItem[], activities: readonly Activity[]): PickupItem[] {
  const out: PickupItem[] = [];
  for (const item of cart) {
    if (item.kind !== "activity") continue;
    const activity = activities.find((a) => a.slug === item.slug);
    if (!activity?.pickupIncluded || !activity.productId) continue;
    const variantId = item.variantId ?? (activity.variants.length === 1 ? activity.variants[0].id : undefined);
    if (!variantId) continue;
    out.push({ itemId: item.id, title: item.title, productId: activity.productId, variantId, listKey: `${activity.productId}:${variantId}`, chosen: item.pickupHotel });
  }
  return out;
}

const onList = (hotels: readonly PickupHotelOption[], id: string | null | undefined) => (id ? hotels.find((h) => h.id === id) : undefined);

/** Every hotel any pickup activity in the cart collects from, once each, by name: the cart field's options. */
export function cartHotelOptions(lists: readonly ListState[]): PickupHotelOption[] {
  const byId = new Map<string, PickupHotelOption>();
  for (const l of lists) if (l.status === "ready") for (const h of l.hotels) if (!byId.has(h.id)) byId.set(h.id, h);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id));
}

/** The plan for every pickup line, given the lists loaded so far and the cart hotel. */
export function pickupPlan(items: readonly PickupItem[], lists: ReadonlyMap<string, ListState>, cartHotel: PickupHotelChoice | null): PickupPlanRow[] {
  return items.map((item) => {
    const list = lists.get(item.listKey) ?? { status: "loading" as const };
    if (list.status === "loading") return { item, status: { kind: "loading" }, hotel: null };
    // A list with no hotel cannot be chosen from: the same as one that could not be read.
    if (list.status === "unavailable" || list.hotels.length === 0) return { item, status: { kind: "unavailable" }, hotel: null };
    if (!cartHotel?.hotelId || onList(list.hotels, cartHotel.hotelId)) {
      const h = onList(list.hotels, cartHotel?.hotelId);
      return { item, status: { kind: "cart" }, hotel: h ? { hotelId: h.id, name: h.name } : null };
    }
    // Its own choice survives only while it is on its own list.
    const own = onList(list.hotels, item.chosen?.hotelId);
    return { item, status: { kind: "own", hotels: list.hotels }, hotel: own ? { hotelId: own.id, name: own.name } : null };
  });
}

/** The cart field's id, and each per-activity field's (also the error summary keys). */
export const CART_HOTEL_FIELD = "hotel";
export const itemHotelField = (itemId: string) => `hotel-${itemId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

/** Why the details step cannot continue to review, per field. Empty: every pickup line has a hotel. */
export function pickupErrors(plan: readonly PickupPlanRow[]): Record<string, string> {
  const errors: Record<string, string> = {};
  if (plan.some((r) => r.status.kind === "loading")) errors[CART_HOTEL_FIELD] = "The pickup hotels are still loading. Try again in a moment.";
  else if (plan.some((r) => r.status.kind === "unavailable")) errors[CART_HOTEL_FIELD] = "We can't load the pickup hotels right now. Try again, or send your trip to our team.";
  else if (plan.some((r) => r.status.kind === "cart" && !r.hotel)) errors[CART_HOTEL_FIELD] = "Choose the hotel the operator collects you from.";
  for (const r of plan) {
    if (r.status.kind === "own" && !r.hotel) errors[itemHotelField(r.item.itemId)] = `Choose a pickup hotel for ${r.item.title}.`;
  }
  return errors;
}

const same = (a: PickupHotelChoice | null | undefined, b: PickupHotelChoice | null | undefined) => (a?.hotelId ?? null) === (b?.hotelId ?? null) && (a?.name ?? null) === (b?.name ?? null);

/**
 * The cart line updates that bring each line's `pickupHotel` in line with the
 * plan. Lines whose list is still loading or unavailable are left as they
 * are (a kept choice comes back when the list does).
 */
export function pickupUpdates(plan: readonly PickupPlanRow[]): { itemId: string; pickupHotel: PickupHotelChoice | undefined }[] {
  const out: { itemId: string; pickupHotel: PickupHotelChoice | undefined }[] = [];
  for (const r of plan) {
    if (r.status.kind === "loading" || r.status.kind === "unavailable") continue;
    if (!same(r.hotel, r.item.chosen)) out.push({ itemId: r.item.itemId, pickupHotel: r.hotel ?? undefined });
  }
  return out;
}

/** The cart hotel to start from: the first pickup line's kept choice with an id. */
export function initialCartHotel(items: readonly PickupItem[]): PickupHotelChoice | null {
  const c = items.find((i) => i.chosen?.hotelId)?.chosen;
  return c ? { hotelId: c.hotelId, name: c.name } : null;
}

/** The hotel to carry into the inquiry form (doc 29 §7.3: in the form, never in the URL). */
export function hotelForInquiry(cart: readonly CartItem[]): string {
  return cart.find((i) => i.pickupHotel?.name)?.pickupHotel?.name.slice(0, 120) ?? "";
}
