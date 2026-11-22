/**
 * The pickup hotel list of one product variant (`GET /api/catalog/pickup-hotels`,
 * doc 29 §7.3 Batch 3), with a small in-memory cache per page load so the
 * details step, Edit and back do not ask again. Only ids travel in the URL;
 * what the visitor types is filtered in the browser (doc 29 §6.5).
 */

export interface PickupHotelOption {
  /** TravelDesk hotel id, plain decimal: sent back as the quote's `pickup.hotelRef`. */
  id: string;
  name: string;
  area: string | null;
}

export type PickupHotelList = { status: "ready"; hotels: PickupHotelOption[] } | { status: "unavailable" };

const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; promise: Promise<PickupHotelList> }>();

const isHotel = (h: unknown): h is PickupHotelOption =>
  typeof h === "object" &&
  h !== null &&
  typeof (h as PickupHotelOption).id === "string" &&
  /^[1-9][0-9]{0,8}$/.test((h as PickupHotelOption).id) &&
  typeof (h as PickupHotelOption).name === "string" &&
  ((h as PickupHotelOption).area === null || typeof (h as PickupHotelOption).area === "string");

async function load(productId: string, variantId: string): Promise<PickupHotelList> {
  const qs = new URLSearchParams({ productId, variantId });
  const res = await fetch(`/api/catalog/pickup-hotels?${qs}`, { credentials: "omit", headers: { accept: "application/json" } });
  if (!res.ok) return { status: "unavailable" };
  const body = (await res.json()) as { ok?: boolean; hotels?: unknown };
  if (body.ok !== true || !Array.isArray(body.hotels)) return { status: "unavailable" };
  return { status: "ready", hotels: body.hotels.filter(isHotel) };
}

/** The list for one variant. Never rejects: any failure is `unavailable`, which is not kept. */
export function fetchPickupHotels(productId: string, variantId: string, now = Date.now()): Promise<PickupHotelList> {
  const key = `${productId}:${variantId}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.promise;
  const promise = load(productId, variantId)
    .catch((): PickupHotelList => ({ status: "unavailable" }))
    .then((r) => {
      if (r.status !== "ready") cache.delete(key);
      return r;
    });
  cache.set(key, { at: now, promise });
  return promise;
}

/** Tests only. */
export function clearPickupHotelCache(): void {
  cache.clear();
}
