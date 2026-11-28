import "server-only";
import { createHash } from "node:crypto";
import type { SupplierEnvironment } from "@prisma/client";
import { effectiveModeFrom, storefrontGate } from "@/lib/catalog/eligibility";
import { prisma } from "../lib/db";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { travelDeskExternalRefSchema } from "../suppliers/traveldesk/traveldesk.adapter";
import { TravelDeskReadClient } from "../suppliers/traveldesk/traveldesk.client";
import type { TravelDeskHotel } from "../suppliers/traveldesk/traveldesk.codec";
import { traveldeskConfigFrom } from "../suppliers/traveldesk/traveldesk.config";
import { bookingAccountId, DEFAULT_BOOKING_ACCOUNT_ID, takeBrowseReadToken } from "./supplier-booking.service";

/**
 * An offer's pickup hotel list for the storefront (doc 29 §7.3 Batch 3,
 * §6.3, §6.5): the public read behind `GET /api/catalog/pickup-hotels`.
 *
 * It answers only for a published product with pickup whose effective mode
 * is instant, for the mapping that books the asked variant; anything else is
 * `not_offered` and makes no supplier call. The list is read with
 * `GET /hotels/foroffer` from the browse share of the read budget
 * (`takeBrowseReadToken`, suppliers/read-budget.ts; the same class the
 * start-times read uses, as route `pickup_hotels`, which keeps a reserve
 * start-times reads cannot take), never the quote or engine share, and kept
 * per offer and environment for `PICKUP_HOTEL_LIST_TTL_MS`. A refused token or
 * a failed read is `unavailable` (kept briefly, so a failing supplier is not
 * asked again on every keystroke of every visitor); the page then offers the
 * inquiry. Concurrent misses for one offer share one read.
 *
 * Only the hotel id, its display name and its area leave the server. The
 * quote does not trust this list: it reads the offer's list itself from the
 * quote share and refuses a hotel that is not on it
 * (supplier-quote.service.ts). Typed search text never reaches the server:
 * the page filters this list in the browser.
 */

/** How long one offer's list is reused. Same as the quote's own pickup cache (`PICKUP_HOTELS_TTL_MS`). */
export const PICKUP_HOTEL_LIST_TTL_MS = 10 * 60_000;
/** How long an unavailable answer is reused. */
export const PICKUP_HOTEL_FAILURE_TTL_MS = 30_000;
/** Above this many cached lists, expired ones are dropped; if none are, all are. */
const MAX_ENTRIES = 500;
/** A longer list is cut here (the page filters it in the browser). */
export const PICKUP_HOTEL_LIST_MAX = 2000;
const NAME_MAX = 120;

export interface PickupHotel {
  /** The TravelDesk hotel id in plain decimal: what the quote sends back as `pickup.hotelRef`. */
  id: string;
  name: string;
  /** Region, else city, when the supplier names one. */
  area: string | null;
}

export type PickupHotelsResult = { ok: true; hotels: PickupHotel[]; asOf: string } | { ok: false; reason: "not_offered" | "unavailable" };

/** The offer behind one product variant, when the storefront may sell it instantly with pickup. */
export interface PickupHotelTarget {
  supplierCode: string;
  environment: SupplierEnvironment;
  offerId: number;
}

export interface PickupHotelSource {
  listPickupHotels(offerId: number): Promise<Pick<TravelDeskHotel, "hotelId" | "name" | "regionName" | "cityName">[]>;
}

export interface PickupHotelsDeps {
  target(productId: string, variantId: string): Promise<PickupHotelTarget | null>;
  /** The live TravelDesk reader for this environment, or null when it is not configured for it. */
  source(environment: SupplierEnvironment): { source: PickupHotelSource; accountId: string } | null;
  takeBrowseReadToken(supplierCode: string, environment: SupplierEnvironment, accountId: string): Promise<boolean>;
  now(): Date;
}

/** Whitespace collapsed, trimmed and capped at 120 characters; null when empty. Also the quote's hotel name snapshot (supplier-quote.service.ts). */
export const cleanHotelText = (s: string | null | undefined) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, NAME_MAX) : null;
};

/** The public projection: named hotels only, one row per id, sorted by name. */
export function publicHotels(rows: readonly Pick<TravelDeskHotel, "hotelId" | "name" | "regionName" | "cityName">[]): PickupHotel[] {
  const seen = new Set<number>();
  const out: PickupHotel[] = [];
  for (const h of rows) {
    if (!Number.isSafeInteger(h.hotelId) || h.hotelId <= 0 || seen.has(h.hotelId)) continue;
    const name = cleanHotelText(h.name);
    if (!name) continue;
    seen.add(h.hotelId);
    out.push({ id: String(h.hotelId), name, area: cleanHotelText(h.regionName) ?? cleanHotelText(h.cityName) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id));
  return out.slice(0, PICKUP_HOTEL_LIST_MAX);
}

export function createPickupHotelsService(deps: PickupHotelsDeps) {
  const cache = new Map<string, { until: number; result: PickupHotelsResult }>();
  const inFlight = new Map<string, Promise<PickupHotelsResult>>();

  function remember(key: string, result: PickupHotelsResult, ttl: number) {
    const at = deps.now().getTime();
    if (cache.size >= MAX_ENTRIES) {
      for (const [k, v] of cache) if (v.until <= at) cache.delete(k);
      if (cache.size >= MAX_ENTRIES) cache.clear();
    }
    cache.set(key, { until: at + ttl, result });
  }

  async function read(target: PickupHotelTarget, key: string): Promise<PickupHotelsResult> {
    const live = deps.source(target.environment);
    if (!live) return { ok: false, reason: "unavailable" };
    if (!(await deps.takeBrowseReadToken(target.supplierCode, target.environment, live.accountId))) {
      // Not cached: the next window may have room.
      return { ok: false, reason: "unavailable" };
    }
    try {
      const rows = await live.source.listPickupHotels(target.offerId);
      const result: PickupHotelsResult = { ok: true, hotels: publicHotels(rows), asOf: deps.now().toISOString() };
      remember(key, result, PICKUP_HOTEL_LIST_TTL_MS);
      return result;
    } catch (error) {
      log.warn("pickup_hotels.read_failed", { offerId: target.offerId, environment: target.environment, error });
      const result: PickupHotelsResult = { ok: false, reason: "unavailable" };
      remember(key, result, PICKUP_HOTEL_FAILURE_TTL_MS);
      return result;
    }
  }

  return {
    async list(productId: string, variantId: string): Promise<PickupHotelsResult> {
      const target = await deps.target(productId, variantId);
      if (!target) return { ok: false, reason: "not_offered" };
      // One list per offer and environment, whichever product or variant asks for it.
      const key = `${target.environment}:${target.offerId}`;
      const hit = cache.get(key);
      if (hit && hit.until > deps.now().getTime()) return hit.result;
      const pending = inFlight.get(key);
      if (pending) return pending;
      const p = read(target, key).finally(() => inFlight.delete(key));
      inFlight.set(key, p);
      return p;
    },
  };
}

/* ---------------------------------------------------------------------------
 * Database and supplier wiring
 * ------------------------------------------------------------------------ */

function configFor(environment: SupplierEnvironment) {
  const config = traveldeskConfigFrom(env());
  return config && config.environment === environment ? config : null;
}

/**
 * The mapping that books `variantId` of a published, instant product with
 * pickup, as `mappingForVariant` (readiness.service.ts) picks it: the
 * variant's own mapping, else a product-level one for a single-variant
 * product. Live-book TravelDesk offers in the configured environment only.
 */
async function loadTarget(productId: string, variantId: string): Promise<PickupHotelTarget | null> {
  const product = await prisma.product.findFirst({
    where: { id: productId, deletedAt: null, status: "published", pickupIncluded: true },
    select: {
      content: true,
      eligibility: { select: { effectiveMode: true, readinessVersion: true } },
      mappings: { where: { isActive: true }, select: { variantCode: true, environment: true, externalRef: true, supplier: { select: { code: true, adapter: true } } } },
    },
  });
  if (!product || effectiveModeFrom(product.eligibility, storefrontGate()) !== "instant") return null;
  const variants = ((product.content as { variants?: { id?: unknown; soldOut?: unknown }[] } | null)?.variants ?? []).filter((v) => typeof v?.id === "string" && v.soldOut !== true);
  if (!variants.some((v) => v.id === variantId)) return null;
  const tds = product.mappings.filter((m) => m.supplier.adapter === "traveldesk");
  const mapping = tds.find((m) => m.variantCode === variantId) ?? (variants.length === 1 ? tds.find((m) => m.variantCode === null) : undefined);
  if (!mapping?.environment || !configFor(mapping.environment)) return null;
  const ref = travelDeskExternalRefSchema.safeParse(mapping.externalRef);
  if (!ref.success || ref.data.bookingKind !== "live_book") return null;
  return { supplierCode: mapping.supplier.code, environment: mapping.environment, offerId: ref.data.offerId };
}

/** One reader per process and configuration. */
let reader: { key: string; client: TravelDeskReadClient } | null = null;

function liveSource(environment: SupplierEnvironment) {
  const config = configFor(environment);
  if (!config) return null;
  const key = `${config.environment}:${config.readTimeoutMs}:${createHash("sha256").update(config.apiKey).digest("hex")}`;
  if (!reader || reader.key !== key) reader = { key, client: new TravelDeskReadClient(config) };
  return { source: reader.client, accountId: bookingAccountId(config.environment, config.agencyId) ?? DEFAULT_BOOKING_ACCOUNT_ID };
}

export const pickupHotelsService = createPickupHotelsService({
  target: loadTarget,
  source: liveSource,
  takeBrowseReadToken: (code, environment, accountId) => takeBrowseReadToken(code, environment, accountId, { route: "pickup_hotels" }),
  now: () => new Date(),
});
