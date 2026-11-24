import "server-only";
import { createHash } from "node:crypto";
import type { SupplierEnvironment } from "@prisma/client";
import type { SupplierQuoteInput, SupplierQuoteResult, SupplierQuoteService } from "../quotes/contracts";
import { prisma } from "../lib/db";
import { env } from "../lib/env";
import type { Tristate } from "../suppliers/booking-port";
import { travelDeskExternalRefSchema } from "../suppliers/traveldesk/traveldesk.adapter";
import { TravelDeskReadClient } from "../suppliers/traveldesk/traveldesk.client";
import type { TravelDeskAvailabilityRow, TravelDeskTicketStock } from "../suppliers/traveldesk/traveldesk.codec";
import { traveldeskConfigFrom, type TravelDeskConfig } from "../suppliers/traveldesk/traveldesk.config";
import { approvedSlotHoursHold, offerTermsHash, parseStoredOffer, parseStoredPolicy } from "../suppliers/traveldesk/traveldesk.offer-terms";
import { hotelOnPickupList, listedStartsOn, pickupShapeFits, quoteSlot, quoteTickets, unitsFrom, type ListedStart } from "../suppliers/traveldesk/traveldesk.quote";
import { TtlCache } from "../suppliers/cache";
import { cleanHotelText } from "./pickup-hotels.service";
import { bookingAccountId, DEFAULT_BOOKING_ACCOUNT_ID, takeBrowseReadToken, takeQuoteReadToken } from "./supplier-booking.service";
import { alertingQuoteToken } from "./quote-budget-alert";

/**
 * Supplier quote for one line (SUP-14, doc 22 §23 B2; `SupplierQuoteService`
 * in quotes/contracts.ts).
 *
 * Every call reads seats and price afresh: no cache, no stale-on-error
 * (SUP-19). Each read counts against the shared per-account budget (SUP-6) as
 * a quote read: quotes may use only their share of each window, so they can
 * never starve recovery, polls, the watchdog or reconciliation (CR-B2-3,
 * suppliers/read-budget.ts). A spent quote share or window is
 * `supplier_unavailable`, with nothing read, never a stale answer. The quote does
 * not wait for a quiet lane: a read that collides with a booking mutation
 * times out and is refused the same way. The one exception to "no cache" is
 * the offer's pickup hotel list (`GET /hotels/foroffer`), kept for
 * `PICKUP_HOTELS_TTL_MS`: it says where the supplier collects from, not
 * whether or at what price it sells.
 *
 * Before reading, the line is checked against what the mapping review
 * approved: an inactive mapping, a mapping in another environment than the
 * configured TravelDesk, a removed offer, or stored terms whose hash differs
 * from `approved_offer_hash` (SUP-15) are all `availability_unknown`. Readiness
 * refuses these earlier; the quote does not rely on it. Units TravelDesk
 * cannot take are `unit_rule_failed`. Pickup is `pickup_unavailable` when a
 * direct-reporting offer is given a hotel, an offer that collects is given
 * none, or the hotel is not on that offer's list.
 *
 * The rules themselves (slot join, cutoffs, sentinels, TicketOnly, rounding)
 * are pure and live in `suppliers/traveldesk/traveldesk.quote.ts`.
 *
 * The same service answers the public start-times read (`startTimes`, doc 29
 * Batch 2). That read is indicative, cached for a minute and drawn from the
 * separate browse share of the read budget; it never feeds a quote, which
 * still reads afresh from the quote share.
 */

/** What one quote needs from the database. */
export interface SupplierQuoteContext {
  mapping: {
    id: string;
    isActive: boolean;
    environment: SupplierEnvironment | null;
    adapter: string;
    supplierCode: string;
    externalRef: unknown;
    approvedOfferHash: string | null;
    /** The offer hours the approval recorded (review 85 A1), compared where a slot's end is derived from them. */
    approvedSlotHours: number | null;
  };
  offer: { payload: unknown; removed: boolean } | null;
  tour: { payload: unknown; removed: boolean } | null;
}

/** The TravelDesk reads a quote can make; `TravelDeskReadClient` satisfies it. */
export interface TravelDeskQuoteSource {
  getAvailability(offerId: number, from: string, to: string, opts: { isExternal: boolean }): Promise<{ rows: TravelDeskAvailabilityRow[] }>;
  getTicketStock(offerId: number): Promise<TravelDeskTicketStock>;
  listPickupHotels(offerId: number): Promise<{ hotelId: number; name?: string | null }[]>;
}

/** How long an offer's pickup hotel list is reused. Seats and prices are never cached. */
export const PICKUP_HOTELS_TTL_MS = 10 * 60_000;
/** Above this many cached lists, expired ones are dropped; if none are, all are. */
const PICKUP_HOTELS_MAX_ENTRIES = 500;
/**
 * The form of a TravelDesk hotel id as the quote takes it: plain decimal, at
 * most nine digits, the form the engine sends back as `hotelId`
 * (engine-saga.service.ts refuses anything else at intake).
 */
export const PICKUP_HOTEL_REF = /^[1-9][0-9]{0,8}$/;

/** How long one offer's rows for one date serve the public start-times read (doc 29 §6.3, §6.6). Quotes never use them. */
export const START_TIMES_TTL_MS = 60_000;
/** How long past expiry those rows may still be shown, labelled with their time, when a refresh is refused or fails. */
export const START_TIMES_STALE_MS = 120_000;
const START_TIMES_MAX_ENTRIES = 500;

/**
 * The public start-times read for one mapping and date (doc 29 Batch 2).
 * `not_listed`: the offer is not sold as listed starts, so the page keeps its
 * stored times; `busy`: the browse share of the read budget is spent and no
 * recent answer is cached; the other two as for a quote. Never a price.
 */
export type StartTimesResult =
  | { ok: true; times: ListedStart[]; checkedAt: string; stale: boolean }
  | { ok: false; reason: "not_listed" | "busy" | "supplier_unavailable" | "availability_unknown" };

export interface SupplierStartTimesReader {
  startTimes(input: { mappingId: string; serviceDate: string }): Promise<StartTimesResult>;
}

class BrowseBudgetSpent extends Error {}

export interface SupplierQuoteDeps {
  load(mappingId: string): Promise<SupplierQuoteContext | null>;
  /** The live TravelDesk reader for this environment, or null when it is not configured for it. */
  source(environment: SupplierEnvironment): { source: TravelDeskQuoteSource; accountId: string } | null;
  /** One read from the account's quote share of the read budget (`takeQuoteReadToken`). False: refuse without reading. */
  takeQuoteReadToken(supplierCode: string, environment: SupplierEnvironment, accountId: string): Promise<boolean>;
  /** One read from the browse share (`takeBrowseReadToken`, Batch 2). Absent: the start-times read never calls the supplier. */
  takeBrowseReadToken?(supplierCode: string, environment: SupplierEnvironment, accountId: string): Promise<boolean>;
  /** Clock for the start-times cache, in ms; defaults to `now()`. */
  nowMs?(): number;
  now(): Date;
}

const refuse = (reason: Extract<SupplierQuoteResult, { ok: false }>["reason"]): SupplierQuoteResult => ({ ok: false, reason });

export function createSupplierQuoteService(deps: SupplierQuoteDeps): SupplierQuoteService & SupplierStartTimesReader {
  // Per environment, account and offer. Only successful reads are kept.
  const pickupHotels = new Map<string, { until: number; hotels: { hotelId: number; name?: string | null }[] }>();
  // Start-times rows per supplier, environment, account, offer and date (Batch 2). Browse only: a quote never reads it.
  const startRows = new TtlCache<TravelDeskAvailabilityRow[]>({
    ttlMs: START_TIMES_TTL_MS,
    staleIfErrorMs: START_TIMES_STALE_MS,
    maxEntries: START_TIMES_MAX_ENTRIES,
    now: () => (deps.nowMs ? deps.nowMs() : deps.now().getTime()),
  });

  /** The approved, readable, live-book offer behind a mapping, or why not. Shared by quote and start times. */
  async function approvedOffer(mappingId: string) {
    const ctx = await deps.load(mappingId);
    if (!ctx) return null;
    const { mapping } = ctx;
    if (!mapping.isActive || !mapping.environment || mapping.adapter !== "traveldesk") return null;
    const ref = travelDeskExternalRefSchema.safeParse(mapping.externalRef);
    if (!ref.success) return null;
    if (!ctx.offer || ctx.offer.removed || !ctx.tour || ctx.tour.removed) return null;
    const hash = offerTermsHash(ctx.offer.payload, ctx.tour.payload);
    if (!hash || hash !== mapping.approvedOfferHash || !approvedSlotHoursHold(ctx.offer.payload, mapping.approvedSlotHours)) return null;
    const offer = parseStoredOffer(ctx.offer.payload);
    if (!offer || offer.offerId !== ref.data.offerId) return null;
    return { mapping: { ...mapping, environment: mapping.environment }, ref: ref.data, offer };
  }

  /** The offer's pickup hotels: from the short cache, else one budgeted read. Null: no token. */
  async function hotelsFor(live: { source: TravelDeskQuoteSource; accountId: string }, supplierCode: string, environment: SupplierEnvironment, offerId: number) {
    const key = `${supplierCode}:${environment}:${live.accountId}:${offerId}`;
    const at = deps.now().getTime();
    const hit = pickupHotels.get(key);
    if (hit && hit.until > at) return hit.hotels;
    if (!(await deps.takeQuoteReadToken(supplierCode, environment, live.accountId))) return null;
    const hotels = await live.source.listPickupHotels(offerId);
    if (pickupHotels.size >= PICKUP_HOTELS_MAX_ENTRIES) {
      for (const [k, v] of pickupHotels) if (v.until <= at) pickupHotels.delete(k);
      if (pickupHotels.size >= PICKUP_HOTELS_MAX_ENTRIES) pickupHotels.clear();
    }
    pickupHotels.set(key, { until: at + PICKUP_HOTELS_TTL_MS, hotels });
    return hotels;
  }

  return {
    async quote(input: SupplierQuoteInput): Promise<SupplierQuoteResult> {
      const ctx = await deps.load(input.mappingId);
      if (!ctx) return refuse("availability_unknown");
      const { mapping } = ctx;
      if (!mapping.isActive || !mapping.environment || mapping.adapter !== "traveldesk") return refuse("availability_unknown");
      const ref = travelDeskExternalRefSchema.safeParse(mapping.externalRef);
      if (!ref.success) return refuse("availability_unknown");
      // On-request bookings are invisible to the API (HTML §Booking types).
      if (ref.data.bookingKind === "on_request") return refuse("on_request");
      if (ref.data.bookingKind === "unknown") return refuse("availability_unknown");

      if (!ctx.offer || ctx.offer.removed || !ctx.tour || ctx.tour.removed) return refuse("availability_unknown");
      const hash = offerTermsHash(ctx.offer.payload, ctx.tour.payload);
      if (!hash || hash !== mapping.approvedOfferHash || !approvedSlotHoursHold(ctx.offer.payload, mapping.approvedSlotHours)) return refuse("availability_unknown");
      const offer = parseStoredOffer(ctx.offer.payload);
      const policy = parseStoredPolicy(ctx.tour.payload);
      if (!offer || offer.offerId !== ref.data.offerId) return refuse("availability_unknown");

      const units = unitsFrom(input.supplierUnits);
      if (!units) return refuse("unit_rule_failed");
      if (!pickupShapeFits(offer.isDirectReporting, input.pickup)) return refuse("pickup_unavailable");

      const live = deps.source(mapping.environment);
      if (!live) return refuse("supplier_unavailable");

      const issuesTicketsAtConfirm: Tristate = ref.data.ticketEvidence?.issuesTicketsAtConfirm ?? "unknown";
      // A ref that cannot be a TravelDesk hotel id is refused before any read (Batch 3): no list is spent on it.
      if (input.pickup && !PICKUP_HOTEL_REF.test(input.pickup.hotelRef)) return refuse("pickup_unavailable");
      try {
        let pickupHotelName: string | null = null;
        if (input.pickup) {
          const hotels = await hotelsFor(live, mapping.supplierCode, mapping.environment, ref.data.offerId);
          if (!hotels) return refuse("supplier_unavailable");
          if (!hotelOnPickupList(input.pickup.hotelRef, hotels)) return refuse("pickup_unavailable");
          // The same collapse and cap as the list the customer saw (pickup-hotels.service.ts).
          pickupHotelName = cleanHotelText(hotels.find((h) => String(h.hotelId) === input.pickup!.hotelRef)?.name);
        }
        if (!(await deps.takeQuoteReadToken(mapping.supplierCode, mapping.environment, live.accountId))) return refuse("supplier_unavailable");
        const withHotel = (r: SupplierQuoteResult): SupplierQuoteResult => (r.ok && input.pickup ? { ...r, pickupHotelName } : r);
        if (ref.data.bookingKind === "ticket_only") {
          const stock = await live.source.getTicketStock(ref.data.offerId);
          return withHotel(quoteTickets({ offer, policy, serviceDate: input.serviceDate, units, stock, now: deps.now(), issuesTicketsAtConfirm }));
        }
        const { rows } = await live.source.getAvailability(ref.data.offerId, input.serviceDate, input.serviceDate, { isExternal: ref.data.isExternal });
        return withHotel(quoteSlot({ offer, policy, serviceDate: input.serviceDate, slotRef: input.slotRef, units, rows, now: deps.now(), issuesTicketsAtConfirm }));
      } catch {
        // Timeouts, HTTP errors, a non-AED price (codec) and invalid dates all end here. Nothing is retried.
        return refuse("supplier_unavailable");
      }
    },

    /**
     * Doc 29 Batch 2: the listed starts of an "any time" live-book offer on a
     * date, for the public page. The same approval checks as a quote; rows
     * cached per offer, date, environment and account for
     * `START_TIMES_TTL_MS`, and each refresh takes a browse read, never a
     * quote read. A spent browse share serves a recent cached answer
     * (`stale`) or `busy`. The caller decides whether the offer's class is
     * switched on; this only refuses an offer that is not wholly "any time".
     */
    async startTimes(input): Promise<StartTimesResult> {
      const a = await approvedOffer(input.mappingId);
      if (!a || a.ref.bookingKind !== "live_book") return { ok: false, reason: "availability_unknown" };
      if (listedStartsOn(a.offer, input.serviceDate, [], deps.now()) === null) return { ok: false, reason: "not_listed" };
      const take = deps.takeBrowseReadToken;
      const live = deps.source(a.mapping.environment);
      if (!live || !take) return { ok: false, reason: "supplier_unavailable" };
      const key = `${a.mapping.supplierCode}:${a.mapping.environment}:${live.accountId}:${a.ref.offerId}:${input.serviceDate}`;
      try {
        const cached = await startRows.get(key, async () => {
          if (!(await take(a.mapping.supplierCode, a.mapping.environment, live.accountId))) throw new BrowseBudgetSpent();
          const { rows } = await live.source.getAvailability(a.ref.offerId, input.serviceDate, input.serviceDate, { isExternal: a.ref.isExternal });
          return rows;
        });
        const times = listedStartsOn(a.offer, input.serviceDate, cached.value, deps.now());
        if (!times) return { ok: false, reason: "not_listed" };
        return { ok: true, times, checkedAt: new Date(cached.fetchedAt).toISOString(), stale: cached.stale };
      } catch (e) {
        return { ok: false, reason: e instanceof BrowseBudgetSpent ? "busy" : "supplier_unavailable" };
      }
    },
  };
}

async function loadContext(mappingId: string): Promise<SupplierQuoteContext | null> {
  const m = await prisma.productSupplierMapping.findUnique({ where: { id: mappingId }, include: { supplier: { select: { code: true, adapter: true } } } });
  if (!m) return null;
  const item = async (kind: "offer" | "tour", externalId: string | null) => {
    if (!externalId || !m.environment) return null;
    const row = await prisma.supplierCatalogueItem.findUnique({
      where: { supplierId_environment_kind_externalId: { supplierId: m.supplierId, environment: m.environment, kind, externalId } },
      select: { payload: true, removedAt: true },
    });
    return row ? { payload: row.payload, removed: row.removedAt !== null } : null;
  };
  return {
    mapping: {
      id: m.id,
      isActive: m.isActive,
      environment: m.environment,
      adapter: m.supplier.adapter,
      supplierCode: m.supplier.code,
      externalRef: m.externalRef,
      approvedOfferHash: m.approvedOfferHash,
      approvedSlotHours: m.approvedSlotHours,
    },
    offer: await item("offer", m.supplierOfferId),
    tour: await item("tour", m.supplierProductId),
  };
}

/** One reader per process and configuration; it holds no availability cache. */
let reader: { key: string; client: TravelDeskReadClient } | null = null;

/** The configured TravelDesk, when it is the given environment's: a mapping is quoted only against its own environment's API. */
function configFor(environment: SupplierEnvironment) {
  const config = traveldeskConfigFrom(env());
  return config && config.environment === environment ? config : null;
}

/**
 * The supplier account whose read budget a quote in `environment` draws on,
 * or null when TravelDesk is not configured for that environment (the quote
 * is then `supplier_unavailable`). Readiness records it with the mapping facts.
 */
export function supplierCheckAccountId(environment: SupplierEnvironment): string | null {
  const config = configFor(environment);
  return config ? accountOf(config) : null;
}

function accountOf(config: TravelDeskConfig): string {
  return bookingAccountId(config.environment, config.agencyId) ?? DEFAULT_BOOKING_ACCOUNT_ID;
}

function liveSource(environment: SupplierEnvironment) {
  const config = configFor(environment);
  if (!config) return null;
  const key = `${config.environment}:${config.readTimeoutMs}:${createHash("sha256").update(config.apiKey).digest("hex")}`;
  if (!reader || reader.key !== key) reader = { key, client: new TravelDeskReadClient(config) };
  return { source: reader.client, accountId: accountOf(config) };
}

export const supplierQuoteService: SupplierQuoteService & SupplierStartTimesReader = createSupplierQuoteService({
  load: loadContext,
  source: liveSource,
  // A budget refusal sends the customer to the inquiry: record it for the ops alert (quote-budget-alert.ts).
  takeQuoteReadToken: alertingQuoteToken((code, environment, accountId) => takeQuoteReadToken(code, environment, accountId)),
  takeBrowseReadToken: (code, environment, accountId) => takeBrowseReadToken(code, environment, accountId, { route: "start_times" }),
  now: () => new Date(),
});
