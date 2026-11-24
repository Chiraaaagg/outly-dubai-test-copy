import { travelDeskMutationRefusal } from "./traveldesk.config";
import { z } from "zod";
import { Errors } from "../../lib/errors";
import { TtlCache } from "../cache";
import {
  SupplierError,
  type AvailabilityRequest,
  type AvailabilityResult,
  type AvailabilitySlot,
  type BookingRequest,
  type BookingResult,
  type CancelResult,
  type LookupResult,
  type SupplierCapabilities,
  type SupplierPort,
} from "../port";
import { TravelDeskReadClient } from "./traveldesk.client";
import { hhmmToMinutes, minutesToHhmm, travelDeskPax, type TravelDeskAvailabilityRow, type TravelDeskTicketStock } from "./traveldesk.codec";
import type { TravelDeskConfig } from "./traveldesk.config";
import { isTravelDeskApiError, type TravelDeskHttpOptions } from "./traveldesk.http";

/**
 * TravelDeskLiveAdapter — availability (GET only).
 *
 * Bookings do not go through this port: they need a durable intent, the
 * account lease and lookup recovery, which live in
 * `services/supplier-booking.service.ts` (plan §15.3). So `createBooking`
 * refuses, and `lookupBooking` and `cancelBooking` answer `not_supported` and
 * point there. Lookup used to read get-by-id, which may issue tickets
 * (SUP-4, CR-B1-12); status reads now go through the booking adapter's list
 * read only.
 *
 * Constructed with `config === null` (live mode but misconfigured) every
 * method throws NOT_CONFIGURED, the same fail-loud rule as Rathin
 * (registry.ts): a half-set environment never falls back to the mock.
 */

/**
 * Required shape of `product_supplier_mappings.external_ref` for a TravelDesk
 * mapping. Written only by the admin mapping review (never by sync), so the
 * offer an OUTLY variant books is always a human-approved choice.
 */
export const travelDeskExternalRefSchema = z.object({
  tourId: z.number().int().positive(),
  offerId: z.number().int().positive(),
  bookingKind: z.enum(["on_request", "live_book", "ticket_only", "unknown"]),
  isExternal: z.boolean(),
  /**
   * Evidence that this offer does or does not issue tickets at confirmation
   * (`OfferCapabilities.issuesTicketsAtConfirm`, Q-T1), with where it came
   * from. Absent means unknown, which refund promises treat as yes. Kept
   * across a re-approval of the same offer.
   */
  ticketEvidence: z
    .object({ issuesTicketsAtConfirm: z.enum(["yes", "no"]), source: z.string().min(1).max(200), recordedAt: z.string().min(1) })
    .optional(),
});
export type TravelDeskExternalRef = z.infer<typeof travelDeskExternalRefSchema>;

/**
 * Capabilities of the read-only adapter. `instantConfirmation` here is the
 * value for the mock and for a live adapter whose bookings are refused; a live
 * adapter whose bookings are allowed reports true (see `capabilities()`),
 * because the booking engine (supplier-booking.service) then confirms them. `hasRealtimeCapacity` stays false until live tests show `left` is
 * remaining inventory (port.ts §16 C5), so no scarcity copy is rendered.
 */
export const TRAVELDESK_CAPABILITIES: SupplierCapabilities = {
  instantConfirmation: false,
  supportsCancellation: false,
  supportsAmendment: false,
  supportsIdempotency: false, // "There is no duplicate check" (HTML §Retries)
  supportsBookingLookup: false, // status reads and recovery live in supplier-booking.service, never get-by-id (SUP-4)
  hasTimeslots: true,
  hasRealtimeCapacity: false,
  availabilityTtlSeconds: 600,
  maxRps: 1, // one agency's requests are processed one at a time (HTML §Retries)
  currency: "AED",
};

type AvailabilityPayload = { kind: "slots"; rows: TravelDeskAvailabilityRow[] } | { kind: "tickets"; stock: TravelDeskTicketStock };

export interface TravelDeskAdapterOptions extends TravelDeskHttpOptions {
  /** Clock for `checkedAt` and the cache. */
  nowMs?: () => number;
}

export class TravelDeskLiveAdapter implements SupplierPort {
  readonly name: string;
  private readonly client: TravelDeskReadClient | null;
  private readonly cache: TtlCache<AvailabilityPayload>;
  private readonly nowMs: () => number;

  constructor(
    private readonly config: TravelDeskConfig | null,
    opts: TravelDeskAdapterOptions = {},
  ) {
    this.name = config ? `traveldesk-live-${config.environment}` : "traveldesk-live";
    this.nowMs = opts.nowMs ?? Date.now;
    this.client = config ? new TravelDeskReadClient(config, { ...opts, now: opts.now ?? this.nowMs }) : null;
    this.cache = new TtlCache<AvailabilityPayload>({
      ttlMs: TRAVELDESK_CAPABILITIES.availabilityTtlSeconds * 1000,
      staleIfErrorMs: 60 * 60 * 1000,
      now: this.nowMs,
    });
  }

  /**
   * `instantConfirmation` is the gate catalog.service uses before a product
   * may be switched to instant. It is true exactly when booking mutations are
   * allowed (`travelDeskMutationRefusal`: bookings enabled, and in production
   * the agency pinned), so a product never goes instant where its bookings
   * would be refused. Every other
   * readiness, approval and second-approver check still applies.
   */
  capabilities(): SupplierCapabilities {
    return travelDeskMutationRefusal(this.config) === null ? { ...TRAVELDESK_CAPABILITIES, instantConfirmation: true } : TRAVELDESK_CAPABILITIES;
  }

  private assertConfigured(): TravelDeskReadClient {
    if (!this.config || !this.client) throw Errors.notConfigured("TravelDesk");
    return this.client;
  }

  async checkAvailability(req: AvailabilityRequest): Promise<AvailabilityResult> {
    const client = this.assertConfigured();
    const parsed = travelDeskExternalRefSchema.safeParse(req.mapping.externalRef);
    if (!parsed.success) {
      throw new SupplierError("error", this.name, { message: "Supplier mapping is incomplete", details: { reason: "invalid_mapping" } });
    }
    const ref = parsed.data;
    if (ref.bookingKind === "on_request" || ref.bookingKind === "unknown") {
      // On-request bookings are invisible to the API (HTML §Booking types): inquiry only.
      return this.result("quote_only", [], this.nowMs());
    }

    const key = `${ref.offerId}:${req.date}`;
    let cached;
    try {
      cached = await this.cache.get(
        key,
        async () =>
          ref.bookingKind === "ticket_only"
            ? { kind: "tickets" as const, stock: await client.getTicketStock(ref.offerId) }
            : { kind: "slots" as const, rows: (await client.getAvailability(ref.offerId, req.date, req.date, { isExternal: ref.isExternal })).rows },
        { fresh: req.fresh === true },
      );
    } catch (e) {
      throw this.toSupplierError(e);
    }
    if (req.fresh && cached.stale) {
      // Defence in depth: the pre-payment re-check must be live.
      throw new SupplierError("timeout", this.name, { details: { reason: "stale_only" } });
    }

    const pax = travelDeskPax(req.pax);
    const seats = pax.adults + pax.children;
    // Infants take no seat; a booking with no seated guest is not something TravelDesk sells.
    if (seats === 0) return this.result("unknown", [], cached.fetchedAt);
    if (cached.value.kind === "tickets") {
      const s = cached.value.stock;
      // `validUntil` is the EARLIEST expiry in stock, and the price's `isBookable`
      // is for the price's own date. Neither proves anything about a later date,
      // so those cases are "unknown", never "sold_out" (Q-T2).
      if (s.validUntil !== null && s.validUntil < req.date) return this.result("unknown", [], cached.fetchedAt);
      if (s.price.date !== null && s.price.date !== req.date) return this.result("unknown", [], cached.fetchedAt);
      const adultsOk = !s.adultTicketRequired || s.adultTicketsLeft >= (s.sameTicketForAdultAndChild ? seats : pax.adults);
      const childrenOk = s.sameTicketForAdultAndChild || !s.childTicketRequired || s.childTicketsLeft >= pax.children;
      const ok = s.price.isBookable && adultsOk && childrenOk;
      return this.result(ok ? "available" : "sold_out", [], cached.fetchedAt);
    }

    const rows = cached.value.rows.filter((r) => r.date === req.date);
    if (rows.length === 0) {
      // No rows is ambiguous (not offered that day, or missing inventory). Never claim sold out from silence.
      return this.result("unknown", [], cached.fetchedAt);
    }
    const wanted = req.timeslot ? hhmmToMinutes(req.timeslot) : null;
    // A malformed slot must not fall through to the whole-day answer.
    if (req.timeslot && wanted === null) return this.result("unknown", [], cached.fetchedAt);
    const bookable = (r: TravelDeskAvailabilityRow) => r.price.isBookable && r.seatsLeft >= seats;

    // Several slots may share a start time; "use first that have enough available seats left" (L3654).
    const byTime = new Map<number, TravelDeskAvailabilityRow[]>();
    for (const r of rows) byTime.set(r.startMinutes, [...(byTime.get(r.startMinutes) ?? []), r]);
    const slots: AvailabilitySlot[] = [...byTime.entries()]
      .sort(([a], [b]) => a - b)
      .map(([start, group]) => ({ time: minutesToHhmm(start), status: group.some(bookable) ? "available" : "sold_out" }));

    if (wanted !== null) {
      const group = byTime.get(wanted);
      if (!group) return this.result("unknown", slots, cached.fetchedAt);
      return this.result(group.some(bookable) ? "available" : "sold_out", slots, cached.fetchedAt);
    }
    return this.result(rows.some(bookable) ? "available" : "sold_out", slots, cached.fetchedAt);
  }

  async createBooking(_req: BookingRequest): Promise<BookingResult> {
    this.assertConfigured();
    // A synchronous call cannot be exactly-once with TravelDesk (no duplicate check, Q-B7):
    // bookings are durable intents run by the worker.
    throw Errors.notImplemented("TravelDesk bookings run through supplier-booking.service, not SupplierPort.createBooking");
  }

  /** Never get-by-id (SUP-4): its answer may carry ticket codes and reading it may issue them (CR-B1-12). */
  async lookupBooking(_supplierRef: string): Promise<LookupResult> {
    this.assertConfigured();
    return { outcome: "not_supported", reason: "TravelDesk booking status is read by supplier-booking.service (list read), never by id" };
  }

  async cancelBooking(_supplierRef: string, _reason: string): Promise<CancelResult> {
    this.assertConfigured();
    return { outcome: "not_supported", reason: "TravelDesk cancellations run through supplier-booking.service (requestCancel)" };
  }

  /** A stale (served-on-error) entry keeps its original `checkedAt`, so the UI shows "as of HH:MM". */
  private result(status: AvailabilityResult["status"], slots: AvailabilitySlot[], fetchedAt: number): AvailabilityResult {
    return {
      status,
      spotsLeft: null,
      slots,
      nextDates: [],
      checkedAt: new Date(fetchedAt).toISOString(),
      source: "live",
      capacityIsReliable: false,
    };
  }

  private toSupplierError(e: unknown): SupplierError {
    if (isTravelDeskApiError(e)) {
      const details = { kind: e.kind, status: e.status, operation: e.operation };
      if (e.kind === "timeout") return new SupplierError("timeout", this.name, { details });
      if (e.kind === "not_found") {
        return new SupplierError("error", this.name, { message: "The supplier no longer offers this option", details: { ...details, reason: "offer_unavailable" } });
      }
      return new SupplierError("error", this.name, { details });
    }
    return new SupplierError("error", this.name, { details: { kind: "internal" } });
  }
}
