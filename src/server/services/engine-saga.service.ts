import "server-only";
import type { SupplierEnvironment } from "@prisma/client";
import { z } from "zod";
import { prisma, type Tx } from "../lib/db";
import { env } from "../lib/env";
import { Errors } from "../lib/errors";
import type { EngineSagaApi, SagaNotifier } from "../payments/contracts";
import { dbPaymentEvidence } from "../payments/evidence";
import { GUARD_RELEASING_STATES, type PaymentEvidencePort } from "../suppliers/booking-port";
import { checkOfferCapability } from "../suppliers/capability-gate";
import { travelDeskExternalRefSchema } from "../suppliers/traveldesk/traveldesk.adapter";
import { traveldeskConfigFrom } from "../suppliers/traveldesk/traveldesk.config";
import { parseStoredOffer } from "../suppliers/traveldesk/traveldesk.offer-terms";
import { exactSlotOf, slotRulesFor, unitsFrom } from "../suppliers/traveldesk/traveldesk.quote";
import { bookingAccountId, supplierBookingService, TRAVELDESK_SUPPLIER_CODE } from "./supplier-booking.service";
import { supplierGuestName } from "@/lib/guest-name";

/**
 * What the payment saga may ask of the booking engine (`EngineSagaApi`,
 * payments/contracts.ts, doc 22 §23 B3). Nothing else in the saga touches
 * attempt state: every call ends in supplier-booking.service.ts.
 *
 *  - `startAttempt(tx, …)` builds the intent from the order item and the
 *    stored quote line it was sold from: the approved mapping, the exact
 *    slot, the units as TravelDesk pax, the pickup hotel and the supplier's
 *    own AED and USD nets from the quote. Nothing is re-priced or guessed: a
 *    line that does not carry a field the booking needs refuses the attempt
 *    (a conflict with a `reason`). It runs in the saga's transaction, starts
 *    in `await_payment` mode (`fulfilmentOrigin: instant_checkout`) and is
 *    idempotent per order item: the key is `order:<o>:item:<i>:try:1`, so a
 *    repeat returns the same attempt and the saga never makes a second one
 *    (only a human may, invariant 2).
 *  - `confirmIfPaid(id)` queues the confirm; the confirm job re-reads the
 *    payment evidence and the deadline itself before sending. `too_late` when
 *    the deadline gate refuses already, or the attempt is closed or released.
 *  - `releaseHold(id, reason)` cancels an unused reservation, verified by a
 *    re-read showing the cancelled status; refused once a confirm was sent.
 *    The release and the confirm's send take the same booking row lock, so
 *    exactly one of them wins (CR-B3-1).
 *  - `confirmSendBy(id)` is the last instant the engine would still send the
 *    confirm: the reservation deadline (the least the engine has learnt,
 *    CR-9) less the confirm budget, on the database clock. It is the rule the
 *    send's own gate applies (`pastConfirmSendBy`), so the saga captures by
 *    the engine's deadline and never by a second one. Null while the
 *    deadline is unknown: then no confirm is sent.
 */

/** What the saga API needs from the configured TravelDesk. */
export interface EngineSagaConfig {
  environment: SupplierEnvironment;
  agencyId?: string | null;
  mutationTimeoutMs: number;
}

export interface EngineSagaDeps {
  /** The configured TravelDesk, or null when it is not configured. */
  config(): EngineSagaConfig | null;
  payments: PaymentEvidencePort;
  saga?: SagaNotifier;
  supplierCode?: string;
  now?: () => Date;
}

const minorString = z.string().regex(/^\d{1,15}$/);

/** The parts of a stored quote line (`QuoteLineRecord`, quote.service.ts) a booking is built from. */
const quoteLineSchema = z.object({
  /** The line's position in the quote (`QuoteLineSnapshot.index`); absent on lines stored without one. */
  index: z.number().int().nonnegative().optional(),
  mappingId: z.string().uuid(),
  approvedOfferHash: z.string().min(1),
  supplierEnvironment: z.enum(["test", "production"]),
  supplierAccountId: z.string().nullable().optional(),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slotRef: z.string().nullable(),
  units: z.record(z.string(), z.number().int().nonnegative()),
  unitDefinitions: z.array(z.object({ unitId: z.string(), supplierUnit: z.string() }).passthrough()),
  pickup: z.object({ hotelRef: z.string() }).nullable(),
  supplierNetAedMinor: minorString,
  /** TravelDesk's own USD figure for the same net (SUP-24); never derived from AED. */
  supplierNetUsdMinor: minorString.nullable().optional(),
});

/**
 * Supplier unit counts of a quote line: the same rule as the quote's own
 * supplier check (`supplierUnitsFor`, quote.service.ts), on the stored line.
 */
function supplierUnitsOf(defs: { unitId: string; supplierUnit: string }[], units: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of defs) {
    const n = Object.hasOwn(units, d.unitId) ? units[d.unitId] : 0;
    if (n > 0) out[d.supplierUnit] = (Object.hasOwn(out, d.supplierUnit) ? out[d.supplierUnit] : 0) + n;
  }
  return out;
}

function refuse(reason: string, message: string): never {
  throw Errors.conflict(message, { reason });
}

/** States from which no confirm can follow any more. */
const CLOSED_FOR_CONFIRM: readonly string[] = [...GUARD_RELEASING_STATES, "cancel_refused"];
/** States in which the confirm is on its way or done. */
const CONFIRM_UNDERWAY: readonly string[] = ["confirming", "confirmed", "awaiting_external"];

export function createEngineSagaApi(deps: EngineSagaDeps): EngineSagaApi {
  const code = deps.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
  const now = deps.now ?? (() => new Date());

  return {
    async startAttempt(tx: unknown, input: { orderId: string; orderItemId: string; quoteId: string }) {
      const db = (tx ?? prisma) as Tx;
      const item = await db.orderItem.findUnique({
        where: { id: input.orderItemId },
        select: { orderId: true, quoteId: true, mappingId: true, fulfilmentOrigin: true, serviceDate: true, timeslot: true, quoteLineIndex: true, order: { select: { leadName: true } } },
      });
      if (!item) throw Errors.notFound("Order item");
      if (item.orderId !== input.orderId) refuse("order_mismatch", "The order item belongs to another order");
      if (item.fulfilmentOrigin !== "instant_checkout") refuse("not_instant_checkout", "This order item was not sold through instant checkout");
      if (!item.quoteId || item.quoteId !== input.quoteId) refuse("quote_mismatch", "The order item was not sold from this quote");
      if (!item.mappingId) refuse("mapping_missing", "The order item names no supplier mapping");

      const quote = await db.quote.findUnique({ where: { id: input.quoteId }, select: { usedByOrderId: true, lines: true } });
      if (!quote) throw Errors.notFound("Quote");
      if (quote.usedByOrderId !== input.orderId) refuse("quote_not_bound", "The quote is not bound to this order");
      const lines = (Array.isArray(quote.lines) ? quote.lines : []).map((l) => quoteLineSchema.safeParse(l));
      let line: z.infer<typeof quoteLineSchema>;
      if (typeof item.quoteLineIndex === "number") {
        // Multi-item, lead-approved 3 Nov 2026: the item's own line, by its index. Two lines of one order may
        // name the same mapping (another date), so the mapping alone no longer picks the line.
        const own = lines[item.quoteLineIndex];
        if (!own?.success || own.data.mappingId !== item.mappingId || (own.data.index !== undefined && own.data.index !== item.quoteLineIndex)) {
          refuse("quote_line_unreadable", "The quote has no readable line for this item at its index");
        }
        line = own.data;
        if ((line.slotRef ?? null) !== (item.timeslot ?? null)) refuse("slot_mismatch", "The order item and its quote line name different slots");
      } else {
        // Items written before multi-item checkout carry no index: the single line with the item's mapping.
        const matching = lines.flatMap((r) => (r.success && r.data.mappingId === item.mappingId ? [r.data] : []));
        if (matching.length !== 1) refuse("quote_line_unreadable", "The quote has no single readable line for this item");
        line = matching[0];
      }
      if (line.serviceDate !== item.serviceDate.toISOString().slice(0, 10)) refuse("service_date_mismatch", "The order item and its quote line name different dates");

      const mapping = await db.productSupplierMapping.findUnique({ where: { id: line.mappingId }, include: { supplier: { select: { code: true, adapter: true } } } });
      if (!mapping || !mapping.isActive || mapping.supplier.code !== code) refuse("mapping_inactive", "The supplier mapping is not active");
      if (mapping.environment !== line.supplierEnvironment) refuse("mapping_environment_changed", "The mapping's environment changed since the quote");
      if (mapping.approvedOfferHash !== line.approvedOfferHash) refuse("mapping_changed", "The approved offer terms changed since the quote");
      const ref = travelDeskExternalRefSchema.safeParse(mapping.externalRef);
      if (!ref.success || ref.data.bookingKind !== "live_book") refuse("not_live_book", "Only live-book offers may be booked");

      const config = deps.config();
      if (!config || config.environment !== line.supplierEnvironment) refuse("supplier_not_configured", "TravelDesk is not configured for this environment");
      const accountId = bookingAccountId(config.environment, config.agencyId);
      if (!accountId) refuse("supplier_account_unpinned", "No supplier account is pinned for this environment");
      if (line.supplierAccountId && line.supplierAccountId !== accountId) refuse("supplier_account_changed", "The supplier account changed since the quote");

      // The exact slot the supplier check accepted, with its end time from the approved stored offer.
      const slot = exactSlotOf(line.slotRef);
      if (!slot) refuse("slot_unknown", "The quote line names no exact supplier slot");
      const offerRow = mapping.supplierOfferId
        ? await db.supplierCatalogueItem.findUnique({
            where: { supplierId_environment_kind_externalId: { supplierId: mapping.supplierId, environment: config.environment, kind: "offer", externalId: mapping.supplierOfferId } },
            select: { payload: true, removedAt: true },
          })
        : null;
      const stored = offerRow && !offerRow.removedAt ? parseStoredOffer(offerRow.payload) : null;
      if (!stored || stored.offerId !== ref.data.offerId) refuse("offer_unreadable", "The approved offer cannot be read");
      // The same capability lookup readiness used (doc 29 §3.3): a class switched off since the quote is refused here, before any supplier call.
      const capability = await checkOfferCapability(db, {
        adapter: mapping.supplier.adapter,
        supplierId: mapping.supplierId,
        environment: config.environment,
        offerExternalId: mapping.supplierOfferId!,
        payload: offerRow!.payload,
        termsHash: mapping.approvedOfferHash,
      });
      if (!capability.verdict.instant) refuse("capability_not_enabled", `This offer's booking class (${capability.verdict.classKey}) is not enabled for instant sale: ${capability.verdict.reason}`);
      const rules = slotRulesFor(stored.timeSlots, slot.timeSlotId, slot.startMinutes);
      const endMinutes = stored.timeSlots.find((s) => s.timeSlotId === slot.timeSlotId && s.startMinutes === slot.startMinutes)?.endMinutes ?? null;
      if (!rules || endMinutes === null) refuse("slot_rules_unknown", "The slot's stored rules or end time are unknown");

      const pax = unitsFrom(supplierUnitsOf(line.unitDefinitions, line.units));
      if (!pax) refuse("unit_rule_failed", "The quote line's units are not TravelDesk pax");
      let hotelId: number | null = null;
      if (line.pickup) {
        if (!/^[1-9][0-9]{0,8}$/.test(line.pickup.hotelRef)) refuse("pickup_unreadable", "The pickup hotel reference is not a TravelDesk hotel id");
        hotelId = Number(line.pickup.hotelRef);
      }
      const expectedNetMinor = BigInt(line.supplierNetAedMinor);
      if (expectedNetMinor <= 0n) refuse("supplier_net_missing", "The quote line carries no supplier net");
      if (line.supplierNetUsdMinor === undefined || line.supplierNetUsdMinor === null) refuse("supplier_usd_net_missing", "The quote line carries no TravelDesk USD net");
      const leadName = item.order.leadName.trim();
      if (!leadName) refuse("guest_name_missing", "The order has no lead traveller name");
      // TravelDesk accepts Latin letters and spaces only; the checkout already refused anything else.
      const guestName = supplierGuestName(leadName);
      if (!guestName) refuse("guest_name_unsupported", "The lead traveller name has no Latin-letter form TravelDesk accepts");

      const b = await supplierBookingService.createIntent(
        db,
        {
          environment: config.environment,
          idempotencyKey: `order:${input.orderId}:item:${input.orderItemId}:try:1`,
          orderId: input.orderId,
          orderItemId: input.orderItemId,
          mappingId: line.mappingId,
          bookingKind: "live_book",
          mode: "two_step",
          afterReserve: "await_payment",
          fulfilmentOrigin: "instant_checkout",
          quoteId: input.quoteId,
          tourId: ref.data.tourId,
          offerId: ref.data.offerId,
          serviceDate: line.serviceDate,
          slot: { timeSlotId: slot.timeSlotId, startMinutes: slot.startMinutes, endMinutes },
          adults: pax.adults,
          children: pax.children,
          infants: pax.infants,
          hotelId,
          guestName,
          expectedNetMinor,
          expectedNetUsdMinor: BigInt(line.supplierNetUsdMinor),
        },
        { supplierCode: code, now, accountId },
      );
      return { supplierBookingId: b.id };
    },

    async confirmIfPaid(supplierBookingId: string) {
      const config = deps.config();
      const r = await supplierBookingService.confirmIfPaid(supplierBookingId, { payments: deps.payments, mutationTimeoutMs: config?.mutationTimeoutMs, now });
      if (r === "confirm_queued") return "queued";
      if (r === "deadline_too_close" || r === "released") return "too_late";
      if (r.startsWith("skip:")) {
        const state = r.slice("skip:".length);
        if (CONFIRM_UNDERWAY.includes(state)) return "queued";
        if (CLOSED_FOR_CONFIRM.includes(state)) return "too_late";
      }
      // No evidence yet, no reservation yet, attention, or an unresolved outcome.
      return "not_ready";
    },

    async releaseHold(supplierBookingId: string, reason: string) {
      return supplierBookingService.releaseHold(supplierBookingId, reason, { now, saga: deps.saga });
    },

    async confirmSendBy(supplierBookingId: string) {
      const at = await supplierBookingService.confirmSendByFor(supplierBookingId, { mutationTimeoutMs: deps.config()?.mutationTimeoutMs });
      return at ? at.toISOString() : null;
    },
  };
}

/** The production API: the configured TravelDesk and provider-verified payment evidence. Ledger's saga calls this. */
export const engineSagaApi: EngineSagaApi = createEngineSagaApi({
  config: () => traveldeskConfigFrom(env()),
  payments: dbPaymentEvidence,
});
