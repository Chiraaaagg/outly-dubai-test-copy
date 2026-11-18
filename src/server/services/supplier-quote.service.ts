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
import { offerTermsHash, parseStoredOffer, parseStoredPolicy } from "../suppliers/traveldesk/traveldesk.offer-terms";
import { hotelOnPickupList, pickupShapeFits, quoteSlot, quoteTickets, unitsFrom } from "../suppliers/traveldesk/traveldesk.quote";
import { bookingAccountId, DEFAULT_BOOKING_ACCOUNT_ID, takeQuoteReadToken } from "./supplier-booking.service";

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
  };
  offer: { payload: unknown; removed: boolean } | null;
  tour: { payload: unknown; removed: boolean } | null;
}

/** The TravelDesk reads a quote can make; `TravelDeskReadClient` satisfies it. */
export interface TravelDeskQuoteSource {
  getAvailability(offerId: number, from: string, to: string, opts: { isExternal: boolean }): Promise<{ rows: TravelDeskAvailabilityRow[] }>;
  getTicketStock(offerId: number): Promise<TravelDeskTicketStock>;
  listPickupHotels(offerId: number): Promise<{ hotelId: number }[]>;
}

/** How long an offer's pickup hotel list is reused. Seats and prices are never cached. */
export const PICKUP_HOTELS_TTL_MS = 10 * 60_000;
/** Above this many cached lists, expired ones are dropped; if none are, all are. */
const PICKUP_HOTELS_MAX_ENTRIES = 500;

export interface SupplierQuoteDeps {
  load(mappingId: string): Promise<SupplierQuoteContext | null>;
  /** The live TravelDesk reader for this environment, or null when it is not configured for it. */
  source(environment: SupplierEnvironment): { source: TravelDeskQuoteSource; accountId: string } | null;
  /** One read from the account's quote share of the read budget (`takeQuoteReadToken`). False: refuse without reading. */
  takeQuoteReadToken(supplierCode: string, environment: SupplierEnvironment, accountId: string): Promise<boolean>;
  now(): Date;
}

const refuse = (reason: Extract<SupplierQuoteResult, { ok: false }>["reason"]): SupplierQuoteResult => ({ ok: false, reason });

export function createSupplierQuoteService(deps: SupplierQuoteDeps): SupplierQuoteService {
  // Per environment, account and offer. Only successful reads are kept.
  const pickupHotels = new Map<string, { until: number; hotels: { hotelId: number }[] }>();

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
      if (!hash || hash !== mapping.approvedOfferHash) return refuse("availability_unknown");
      const offer = parseStoredOffer(ctx.offer.payload);
      const policy = parseStoredPolicy(ctx.tour.payload);
      if (!offer || offer.offerId !== ref.data.offerId) return refuse("availability_unknown");

      const units = unitsFrom(input.supplierUnits);
      if (!units) return refuse("unit_rule_failed");
      if (!pickupShapeFits(offer.isDirectReporting, input.pickup)) return refuse("pickup_unavailable");

      const live = deps.source(mapping.environment);
      if (!live) return refuse("supplier_unavailable");

      const issuesTicketsAtConfirm: Tristate = ref.data.ticketEvidence?.issuesTicketsAtConfirm ?? "unknown";
      try {
        if (input.pickup) {
          const hotels = await hotelsFor(live, mapping.supplierCode, mapping.environment, ref.data.offerId);
          if (!hotels) return refuse("supplier_unavailable");
          if (!hotelOnPickupList(input.pickup.hotelRef, hotels)) return refuse("pickup_unavailable");
        }
        if (!(await deps.takeQuoteReadToken(mapping.supplierCode, mapping.environment, live.accountId))) return refuse("supplier_unavailable");
        if (ref.data.bookingKind === "ticket_only") {
          const stock = await live.source.getTicketStock(ref.data.offerId);
          return quoteTickets({ offer, policy, serviceDate: input.serviceDate, units, stock, now: deps.now(), issuesTicketsAtConfirm });
        }
        const { rows } = await live.source.getAvailability(ref.data.offerId, input.serviceDate, input.serviceDate, { isExternal: ref.data.isExternal });
        return quoteSlot({ offer, policy, serviceDate: input.serviceDate, slotRef: input.slotRef, units, rows, now: deps.now(), issuesTicketsAtConfirm });
      } catch {
        // Timeouts, HTTP errors, a non-AED price (codec) and invalid dates all end here. Nothing is retried.
        return refuse("supplier_unavailable");
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

export const supplierQuoteService: SupplierQuoteService = createSupplierQuoteService({
  load: loadContext,
  source: liveSource,
  takeQuoteReadToken: (code, environment, accountId) => takeQuoteReadToken(code, environment, accountId),
  now: () => new Date(),
});
