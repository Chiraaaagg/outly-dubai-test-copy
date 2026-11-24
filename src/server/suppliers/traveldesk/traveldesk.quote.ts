import { dubaiToday } from "@/lib/utils";
import type { SupplierQuoteResult } from "../../quotes/contracts";
import type { Tristate } from "../booking-port";
import { CHARGED_AMOUNT_TOLERANCE_MINOR } from "./traveldesk.confirmation";
import {
  hhmmToMinutes,
  isOfferedOn,
  minutesToHhmm,
  netTotalMinor,
  type TravelDeskAvailabilityRow,
  type TravelDeskCancellationRule,
  type TravelDeskNetPrice,
  type TravelDeskTicketStock,
} from "./traveldesk.codec";
import { slotEndMinutes, type StoredOffer, type StoredSlot } from "./traveldesk.offer-terms";

/**
 * Fresh TravelDesk answer + stored catalogue rules → one supplier quote
 * (SUP-14, SUP-24; `SupplierQuoteResult` in quotes/contracts.ts).
 *
 * The availability rows carry seats and the date's net price; the rules that
 * decide whether a slot may be sold (on request, days offered, advance
 * booking, pax limits, cancellation policy) are only in the tour payload the
 * catalogue sync stored. This module joins the two. Every reading below that
 * the documentation does not settle is resolved in the direction that refuses
 * or shortens a promise, never the one that sells more:
 *
 *  - Times. TravelDesk states no timezone (Q-A2). Dates and slot starts are
 *    read as Asia/Dubai (UTC+4, no daylight saving): that puts every derived
 *    instant earlier than a UTC reading would.
 *  - `minimumAdvancedBooking` is in hours before the slot (or opening) start
 *    (doc 21 §4): the cut-off is the start minus the hours. TravelDesk
 *    answered Q-A5 (doc 29 §8.7): a negative value counts against the
 *    opening time too, so it moves the cut-off later the same day (start
 *    10:00 with -5 h: bookable until 15:00). Missing means the start itself.
 *  - Non-operating days come back as rows with `left: 0, isBookable: true`
 *    (doc 21 Q-A1): that is `closed`, as is a weekday outside `daysOffered`.
 *  - `left` 99999 / 999999 are sentinels (Q-A6), and on per-trip offers `left`
 *    may count vehicles (Q-C8): capacity is then `unknown`, never a count.
 *  - TicketOnly (Q-T2, TravelDesk's written answer, 17 Nov 2026): the price
 *    belongs to a pricing period, the window in which a ticket can be BOUGHT,
 *    and open-dated tickets carry a separate validity, the window in which it
 *    can be USED. So the price is the one dated today (the purchase day,
 *    Asia/Dubai), and the visit date must fall from today up to `validUntil`.
 *  - The full-refund deadline counts the policy hours back from the
 *    activity's start, Asia/Dubai: the slot start, or 00:00 on the service
 *    date when no start is known (the earliest it can begin). TravelDesk
 *    answered Q-K1 "counted from the activity start", and the owner replaced
 *    the Dubai-midnight rule on 23 Nov 2026 (doc 29 §8.7; conflict C12
 *    reversed). Cancelling must happen strictly before it. Tickets have none.
 *  - The AED net is what TravelDesk shows as charged: the booking total
 *    rounded to whole dirhams, half to even (`chargedTotalMinor`). Within a
 *    fil per unit of half a dirham there is no quote.
 *  - The USD net is reported only when every USD field it sums arrived with
 *    at most two decimals, and is null when TravelDesk sent no USD figure
 *    (zero USD against a non-zero AED net). It is never derived from AED.
 *
 * Refusals name the cause where the stored rules settle it: a party the
 * offer's pax rules do not accept is `unit_rule_failed`; anything the rules
 * cannot decide stays `availability_unknown`.
 *
 * Slot references: the result's `slotRef` is always `<timeSlotId>@HH:mm`
 * (slot identity is the pair, codec.ts). The request may give that, a bare
 * `HH:mm`, or null when the date has exactly one start time.
 *
 * Pure: no env, db or logger.
 */

/** Asia/Dubai is UTC+4 all year. */
const DUBAI_OFFSET_MS = 4 * 3_600_000;
/** Capacity values that mean "unlimited or not stocked", not a count (Q-A6). */
export const CAPACITY_SENTINELS: ReadonlySet<number> = new Set([99_999, 999_999]);
/** The supplier units a TravelDesk mapping can carry (`UnitDefinition.supplierUnit`). */
export const TRAVELDESK_SUPPLIER_UNITS = ["adult", "child", "infant", "trip"] as const;

type Refusal = Extract<SupplierQuoteResult, { ok: false }>["reason"];
type Ok = Extract<SupplierQuoteResult, { ok: true }>;

const refuse = (reason: Refusal): SupplierQuoteResult => ({ ok: false, reason });

export interface QuoteUnits {
  adults: number;
  children: number;
  infants: number;
}

/**
 * Supplier units → TravelDesk pax. Null for an unknown unit, a negative or
 * fractional count, more than one trip (how per-trip prices scale is open,
 * Q-C8) or no seated guest.
 */
export function unitsFrom(supplierUnits: Record<string, number>): QuoteUnits | null {
  const known = new Set<string>(TRAVELDESK_SUPPLIER_UNITS);
  for (const [k, v] of Object.entries(supplierUnits)) {
    if (!known.has(k) || !Number.isInteger(v) || v < 0) return null;
  }
  if ((supplierUnits.trip ?? 0) > 1) return null;
  const u = { adults: supplierUnits.adult ?? 0, children: supplierUnits.child ?? 0, infants: supplierUnits.infant ?? 0 };
  return u.adults + u.children === 0 ? null : u;
}

/** The offer's own pax rules. TravelDesk would refuse the booking otherwise; per-category limits are undocumented fields (codec.ts). */
export function paxAllowed(o: Pick<StoredOffer, "minPax" | "maxPax" | "paxLimits" | "childrenAllowed" | "infantsAllowed">, u: QuoteUnits): boolean {
  const seats = u.adults + u.children;
  if (seats < o.minPax || (o.maxPax > 0 && seats > o.maxPax)) return false;
  if (u.children > 0 && !o.childrenAllowed) return false;
  if (u.infants > 0 && !o.infantsAllowed) return false;
  const within = (n: number, [lo, hi]: [number | null, number | null]) => (lo === null || n >= lo) && (hi === null || n <= hi);
  return within(u.adults, o.paxLimits.adults) && within(u.children, o.paxLimits.children) && within(u.infants, o.paxLimits.infants);
}

/** UTC instant of a literal Asia/Dubai date plus minutes after midnight. */
export function dubaiInstantMs(isoDate: string, minutes: number): number {
  return Date.parse(`${isoDate}T00:00:00Z`) + minutes * 60_000 - DUBAI_OFFSET_MS;
}

/** Latest instant a slot may be booked: its start minus the advance hours; a negative value is later than the start (doc 29 §8.7). */
export function slotCutoffMs(serviceDate: string, startMinutes: number, advanceHours: number | null): number {
  const start = dubaiInstantMs(serviceDate, startMinutes);
  return advanceHours === null ? start : start - advanceHours * 3_600_000;
}

/**
 * Full-refund deadline from the tour policy, or null when the policy offers
 * no full refund or is unknown. "If more than H hours": the smallest H with a
 * 100% refund wins; the deadline itself is excluded. Counted from the
 * activity start (`startMinutes` after Dubai midnight on the service date;
 * midnight when unknown), doc 29 §8.7.
 */
export function freeCancellationUntilMs(serviceDate: string, policy: TravelDeskCancellationRule[] | null, startMinutes: number | null = null): number | null {
  if (!policy) return null;
  const full = policy.filter((r) => r.refundPercent >= 100 && r.moreThanHours >= 0).map((r) => r.moreThanHours);
  if (full.length === 0) return null;
  return dubaiInstantMs(serviceDate, startMinutes ?? 0) - Math.min(...full) * 3_600_000;
}

/**
 * SUP-24: a price field TravelDesk sent with more than two decimals was
 * rounded half-up, so each unit may be off by half a fil. The quote is only
 * good while the summed error stays inside the one tolerance the confirmation
 * and reconciliation checks use (`CHARGED_AMOUNT_TOLERANCE_MINOR`).
 */
export function roundingWithinTolerance(price: Pick<TravelDeskNetPrice, "roundedFields">, u: QuoteUnits): boolean {
  const r = new Set(price.roundedFields);
  const units = (r.has("pricePerAdult") ? u.adults : 0) + (r.has("pricePerChild") ? u.children : 0) + (r.has("pricePerTrip") ? 1 : 0);
  // Each counted unit is at most 0.5 minor off: total ≤ units / 2.
  return BigInt(units) <= 2n * CHARGED_AMOUNT_TOLERANCE_MINOR;
}

/**
 * How close, per priced unit, a fil amount may sit to half a dirham before
 * its whole-dirham rounding counts as unknown. TravelDesk's own net can be a
 * fil off the listed price (drill of 4 Nov 2026: the reservation's `netRate`
 * was a fil below the availability price), and a price field rounded from
 * more than two decimals is up to half a fil off (SUP-24).
 */
export const HALF_DIRHAM_MARGIN_MINOR_PER_UNIT = 1n;

/**
 * Fils to whole dirhams, nearest, half to even (TravelDesk, 12 Nov 2026:
 * 100.50 → 100, 101.50 → 102). Null within `margin` fils of a half dirham:
 * TravelDesk's own total can be a fil off ours, so the side is unknown there.
 */
export function nearestDirhamMinor(minor: bigint, margin: bigint): bigint | null {
  const fils = minor % 100n;
  const distance = fils > 50n ? fils - 50n : 50n - fils;
  if (distance < margin || (distance === margin && margin > 0n)) return null;
  const down = minor - fils;
  if (fils === 50n) return (down / 100n) % 2n === 0n ? down : down + 100n;
  return fils > 50n ? down + 100n : down;
}

/**
 * What TravelDesk shows as charged for a pax mix (`totalPaidFromBalance`),
 * in AED minor units, or null when it cannot be told in advance.
 *
 * TravelDesk (12 Nov 2026, doc 22 §32.32): the field is the booking-level
 * total (adults, children and the trip price combined) rounded to whole AED,
 * half to even. The balance itself keeps the fils, so the real debit can sit
 * up to half a dirham above this figure; the margin's fixed fee input covers
 * that. The booking is priced from TravelDesk's stored rates, which can be a
 * fil off the availability price (4 Nov 2026 drill: `netRate` a fil below),
 * so an amount within `HALF_DIRHAM_MARGIN_MINOR_PER_UNIT` fils per unit of
 * half a dirham has no quote (`availability_unknown`). Whole-dirham nets are
 * unchanged. Infants are free (`netTotalMinor`).
 */
export function chargedTotalMinor(price: Pick<TravelDeskNetPrice, "perAdultMinor" | "perChildMinor" | "perTripMinor">, u: Pick<QuoteUnits, "adults" | "children">): bigint | null {
  const parts: { unitMinor: bigint; count: bigint }[] = [
    { unitMinor: price.perAdultMinor, count: BigInt(u.adults) },
    { unitMinor: price.perChildMinor, count: BigInt(u.children) },
    { unitMinor: price.perTripMinor, count: 1n },
  ].filter((p) => p.count > 0n && p.unitMinor !== 0n);
  if (parts.some((p) => p.unitMinor < 0n)) return null;
  const units = parts.reduce((n, p) => n + p.count, 0n);
  return nearestDirhamMinor(netTotalMinor(price, u), units * HALF_DIRHAM_MARGIN_MINOR_PER_UNIT);
}

/**
 * The supplier's own USD figure for the same net (SUP-24), in US cents, or
 * null when it is not exact or not given. Same arithmetic as `netTotalMinor`:
 * the listed USD prices, not the whole-dirham charge (`chargedTotalMinor`).
 */
export function netUsdMinorOf(price: TravelDeskNetPrice, u: QuoteUnits): bigint | null {
  const used = [...(u.adults > 0 ? ["pricePerAdultUsd"] : []), ...(u.children > 0 ? ["pricePerChildUsd"] : []), "pricePerTripUsd"];
  if (used.some((f) => price.roundedFields.includes(f))) return null;
  const usd = BigInt(u.adults) * price.perAdultUsdMinor + BigInt(u.children) * price.perChildUsdMinor + price.perTripUsdMinor;
  if (usd === 0n && netTotalMinor(price, u) > 0n) return null;
  return usd;
}

/** Per-trip offers: priced per vehicle, where `left` may count vehicles (Q-C8). */
function perTripPriced(o: Pick<StoredOffer, "privateType">, price: TravelDeskNetPrice): boolean {
  return o.privateType === "private" || (price.perTripMinor > 0n && price.perAdultMinor === 0n && price.perChildMinor === 0n);
}

function parseSlotRef(ref: string | null): { timeSlotId: number | null; startMinutes: number } | null | "malformed" {
  if (ref === null) return null;
  const exact = /^(\d{1,9})@(\d{2}:\d{2})$/.exec(ref);
  const start = hhmmToMinutes(exact ? exact[2] : ref);
  if (start === null) return "malformed";
  return { timeSlotId: exact ? Number(exact[1]) : null, startMinutes: start };
}

export function slotRefOf(timeSlotId: number, startMinutes: number): string {
  return `${timeSlotId}@${minutesToHhmm(startMinutes)}`;
}

/** The exact slot a quote's `<timeSlotId>@HH:mm` reference names; null for any other form (a booking needs both). */
export function exactSlotOf(ref: string | null): { timeSlotId: number; startMinutes: number } | null {
  const p = parseSlotRef(ref);
  return p && p !== "malformed" && p.timeSlotId !== null ? { timeSlotId: p.timeSlotId, startMinutes: p.startMinutes } : null;
}

/**
 * Stored rules for one availability row. Identity is (timeSlotId, start); an
 * id repeated over several starts (isAnyTime offers) is used only when every
 * entry agrees on the rules. Null: unknown, so the row is never sold.
 */
export function slotRulesFor(slots: StoredSlot[], timeSlotId: number, startMinutes: number): StoredSlot | null {
  const exact = slots.find((s) => s.timeSlotId === timeSlotId && s.startMinutes === startMinutes);
  if (exact) return exact;
  const same = slots.filter((s) => s.timeSlotId === timeSlotId);
  if (same.length === 0) return null;
  const key = (s: StoredSlot) => `${s.daysOffered}|${s.isOnRequest}|${s.isAnyTime}|${s.minimumAdvancedBookingHours}`;
  return same.every((s) => key(s) === key(same[0])) ? same[0] : null;
}

/** What readiness needs from an approved offer (readiness.service.ts `MappingReadiness`). */
export interface OfferReadinessFacts {
  /** Supplier units the offer accepts, from `TRAVELDESK_SUPPLIER_UNITS`. */
  supplierUnits: string[];
  /** Highest stored net per supplier unit, AED minor units; null when unknown. */
  netAedMinorByUnit: Record<string, bigint> | null;
  /** Full-refund hours before the activity starts (Asia/Dubai, doc 29 §8.7): 0 = never, null = unknown. */
  supplierFreeCancellationHours: number | null;
  /** True: the guest makes their own way, no pickup. False: the offer collects from hotels. Null: offer unknown. */
  isDirectReporting: boolean | null;
  /** The stored slots' start times, minutes after midnight, unique and ascending; null when the offer is unknown (doc 29 Batch 0). */
  slotStartMinutes: number[] | null;
  /** Whether any stored slot is an "any time" slot; null when the offer is unknown. */
  anyTimeSlots: boolean | null;
}

/** One pax type's age band as the page gives it: inclusive whole years, null for no limit. */
export interface PageAgeBand {
  min: number | null;
  max: number | null;
}

/**
 * Supplier units whose TravelDesk age band does not reach as high as the
 * page's band for the same unit (N3). TravelDesk prices a child only under
 * `childAge` and an infant only under `infantAge`; an older guest pays the
 * next band up at the gate, or is refused. So every page child (up to
 * `page.child.max`) must be under `childAge`, and every page infant under
 * `infantAge`. A supplier band that reaches higher is harmless: the guest is
 * then booked in the category the quote priced, which costs at least as much.
 * Only units the offer accepts are checked. A page band without an upper
 * limit cannot be covered, and an age of 0 or less reads as unknown.
 */
export function ageBandMismatches(
  offer: Pick<StoredOffer, "childrenAllowed" | "childAge" | "infantsAllowed" | "infantAge">,
  page: { child: PageAgeBand; infant: PageAgeBand },
): ("child" | "infant")[] {
  const covers = (supplierUnder: number, band: PageAgeBand) => supplierUnder > 0 && band.max !== null && band.max < supplierUnder;
  const out: ("child" | "infant")[] = [];
  if (offer.childrenAllowed && !covers(offer.childAge, page.child)) out.push("child");
  if (offer.infantsAllowed && !covers(offer.infantAge, page.infant)) out.push("infant");
  return out;
}

/**
 * Readiness facts from the stored offer and tour policy, before any date is
 * chosen. Each reading is the one that keeps a product inquiry when in doubt:
 *
 *  - Units: adult unless the offer caps adults at zero; child and infant only
 *    when allowed and not capped at zero; trip only for per-trip priced offers.
 *  - Nets: the highest net per unit over every pricing period still in force
 *    on `today` or later (infants are free, `netTotalMinor`). Unknown when no
 *    such period exists, one of them has no price, or the offer charges per
 *    person and per trip at once (no single unit then carries the trip cost).
 *    Live quotes re-check the actual net for the date.
 *  - Refund hours: the smallest window with a full refund, counted from the
 *    activity start like `freeCancellationUntilMs` and the customer's
 *    deadline. A window of 0 hours reads as no free cancellation.
 */
export function offerReadinessFacts(offer: StoredOffer | null, policy: TravelDeskCancellationRule[] | null, today: string): OfferReadinessFacts {
  let supplierFreeCancellationHours: number | null = null;
  if (policy) {
    const full = policy.filter((r) => r.refundPercent >= 100 && r.moreThanHours >= 0).map((r) => r.moreThanHours);
    supplierFreeCancellationHours = full.length ? Math.min(...full) : 0;
  }
  if (!offer) return { supplierUnits: [], netAedMinorByUnit: null, supplierFreeCancellationHours, isDirectReporting: null, slotStartMinutes: null, anyTimeSlots: null };

  const periods = offer.pricingPeriods.filter((p) => p.dateEnd === null || p.dateEnd.slice(0, 10) >= today);
  const prices = periods.flatMap((p) => (p.price ? [p.price] : []));
  const perTrip = offer.privateType === "private" || prices.some((p) => p.perTripMinor > 0n);
  const capped = ([, hi]: [number | null, number | null]) => hi === 0;
  const supplierUnits = [
    ...(capped(offer.paxLimits.adults) ? [] : ["adult"]),
    ...(offer.childrenAllowed && !capped(offer.paxLimits.children) ? ["child"] : []),
    ...(offer.infantsAllowed && !capped(offer.paxLimits.infants) ? ["infant"] : []),
    ...(perTrip ? ["trip"] : []),
  ];

  const max = (xs: bigint[]) => xs.reduce((a, b) => (b > a ? b : a), 0n);
  const mixed = prices.some((p) => p.perTripMinor > 0n) && prices.some((p) => p.perAdultMinor > 0n || p.perChildMinor > 0n);
  const known = prices.length > 0 && prices.length === periods.length && !mixed;
  const netAedMinorByUnit = known
    ? {
        adult: max(prices.map((p) => p.perAdultMinor)),
        child: max(prices.map((p) => p.perChildMinor)),
        infant: 0n,
        trip: max(prices.map((p) => p.perTripMinor)),
      }
    : null;
  const slotStartMinutes = [...new Set(offer.timeSlots.map((s) => s.startMinutes))].sort((a, b) => a - b);
  const anyTimeSlots = offer.timeSlots.some((s) => s.isAnyTime);
  return { supplierUnits, netAedMinorByUnit, supplierFreeCancellationHours, isDirectReporting: offer.isDirectReporting, slotStartMinutes, anyTimeSlots };
}

/**
 * Whether a pickup selection has the shape the offer needs, before any hotel
 * is looked up: a direct-reporting offer takes no hotel, and any other offer
 * collects from one, so it needs one. Both mismatches are `pickup_unavailable`.
 */
export function pickupShapeFits(isDirectReporting: boolean, pickup: { hotelRef: string } | null): boolean {
  return isDirectReporting ? pickup === null : pickup !== null;
}

/**
 * Whether `hotelRef` names a hotel on the offer's pickup list
 * (`GET /hotels/foroffer`). A ref is the TravelDesk hotel id in plain decimal,
 * the form the booking sends back as `hotelId`; names, padded or signed
 * numbers never match.
 */
export function hotelOnPickupList(hotelRef: string, hotels: readonly { hotelId: number }[]): boolean {
  return /^[1-9][0-9]*$/.test(hotelRef) && hotels.some((h) => String(h.hotelId) === hotelRef);
}

export interface SlotQuoteInput {
  offer: StoredOffer;
  policy: TravelDeskCancellationRule[] | null;
  serviceDate: string;
  slotRef: string | null;
  units: QuoteUnits;
  /** Fresh, uncached rows for the service date. */
  rows: TravelDeskAvailabilityRow[];
  now: Date;
  issuesTicketsAtConfirm: Tristate;
}

/** Live-book offers: pick the exact slot and decide from fresh rows plus stored rules. */
export function quoteSlot(input: SlotQuoteInput): SupplierQuoteResult {
  const { offer, serviceDate, units, now } = input;
  if (!isOfferedOn(offer.daysOffered, serviceDate)) return refuse("closed");
  if (!paxAllowed(offer, units)) return refuse("unit_rule_failed");

  const wanted = parseSlotRef(input.slotRef);
  if (wanted === "malformed") return refuse("invalid_slot");
  const rows = input.rows.filter((r) => r.date === serviceDate);
  const starts = new Set([...rows.map((r) => r.startMinutes), ...offer.timeSlots.filter((s) => isOfferedOn(s.daysOffered, serviceDate)).map((s) => s.startMinutes)]);
  let target: { timeSlotId: number | null; startMinutes: number };
  if (wanted) target = wanted;
  else if (starts.size === 1) target = { timeSlotId: null, startMinutes: [...starts][0] };
  else return refuse(starts.size === 0 ? "availability_unknown" : "invalid_slot");

  const matches = (s: { timeSlotId: number; startMinutes: number }) => s.startMinutes === target.startMinutes && (target.timeSlotId === null || s.timeSlotId === target.timeSlotId);
  const stored = offer.timeSlots.filter(matches);
  const group = rows.filter(matches);
  if (stored.length === 0 && group.length === 0) return refuse("invalid_slot");
  // Doc 29 Batch 2: an "any time" offer sells only one of its listed starts, never a start the stored
  // slots do not list (even when a fresh row names it), and only with an end the booking can send:
  // the stored end, or start plus the offer's hours (`slotEndMinutes`, OpenAPI TimeSlotPublicDto.endTime).
  if (offer.timeSlots.some((s) => s.isAnyTime) && (stored.length === 0 || stored.some((s) => slotEndMinutes(s, offer.durationHours) === null))) {
    return refuse(stored.length === 0 ? "invalid_slot" : "availability_unknown");
  }
  if (group.length === 0) {
    // Silence is not sold out: closed when the stored rules say so, otherwise unknown.
    return refuse(stored.every((s) => !isOfferedOn(s.daysOffered, serviceDate)) ? "closed" : "availability_unknown");
  }

  const seats = units.adults + units.children;
  const reasons: Refusal[] = [];
  // Several slots may share a start time: "use first that have enough available seats left" (L3654).
  for (const r of group) {
    const rules = slotRulesFor(offer.timeSlots, r.timeSlotId, r.startMinutes);
    if (!rules) {
      reasons.push("availability_unknown");
      continue;
    }
    if (rules.isOnRequest) {
      reasons.push("on_request");
      continue;
    }
    // Review 85 A2: the booking sends the derived end (start plus the offer's hours), while the OpenAPI booking schema says to
    // copy the availability entry's. Where the end is derived and this row names a different one, which TravelDesk would book is unknown.
    if (rules.endMinutes === null && r.endMinutes !== slotEndMinutes({ startMinutes: r.startMinutes, endMinutes: null }, offer.durationHours)) {
      reasons.push("availability_unknown");
      continue;
    }
    if (!isOfferedOn(rules.daysOffered, serviceDate) || (r.seatsLeft === 0 && r.price.isBookable)) {
      reasons.push("closed");
      continue;
    }
    if (!r.price.isBookable || r.seatsLeft <= 0) {
      reasons.push("sold_out");
      continue;
    }
    const cutoff = slotCutoffMs(serviceDate, r.startMinutes, rules.minimumAdvancedBookingHours);
    if (now.getTime() >= cutoff) {
      reasons.push("past_cutoff");
      continue;
    }
    const unknownCapacity = CAPACITY_SENTINELS.has(r.seatsLeft) || perTripPriced(offer, r.price);
    if (!unknownCapacity && r.seatsLeft < seats) {
      reasons.push("sold_out");
      continue;
    }
    if (r.price.date !== null && r.price.date !== serviceDate) {
      reasons.push("availability_unknown");
      continue;
    }
    const charged = chargedTotalMinor(r.price, units);
    if (!roundingWithinTolerance(r.price, units) || charged === null) {
      reasons.push("availability_unknown");
      continue;
    }
    return ok(input, {
      slotRef: slotRefOf(r.timeSlotId, r.startMinutes),
      netAedMinor: charged,
      netUsdMinor: netUsdMinorOf(r.price, units),
      capacity: unknownCapacity ? "unknown" : "limited",
      seatsLeft: unknownCapacity ? null : r.seatsLeft,
      cutoffUtc: new Date(cutoff).toISOString(),
    });
  }
  return refuse(pickReason(reasons));
}

/** One start time as the public start-times read shows it (doc 29 Batch 2): a time and a mark, nothing else. */
export interface ListedStart {
  /** `HH:mm`, Asia/Dubai. */
  time: string;
  /** `available`; `limited` when few seats are left (no count is given); `sold_out`; `unavailable` (closed, past the cut-off, unknown). */
  status: "available" | "limited" | "sold_out" | "unavailable";
}

/** At or below this many seats a start is marked `limited`. The count itself never leaves the server. */
export const LIMITED_SEATS_AT = 5;

/**
 * The listed starts of an "any time" offer on one date, from fresh rows plus
 * the stored rules (doc 29 Batch 2), for the public start-times read. Only
 * the offer's own stored starts are listed: a row at any other start is
 * ignored, so the page can never offer a time the quote would refuse
 * (`quoteSlot`). A start with no row reads `unavailable` (silence is not
 * availability). Prices in the rows are never returned. Null when the offer
 * is not wholly "any time" with known end times (stored, or derived from the
 * offer's hours, `slotEndMinutes`): the page then keeps its
 * stored times. Indicative only; the quote stays the one promise.
 */
export function listedStartsOn(offer: StoredOffer, serviceDate: string, rows: TravelDeskAvailabilityRow[], now: Date): ListedStart[] | null {
  if (offer.timeSlots.length === 0 || offer.timeSlots.some((s) => !s.isAnyTime || slotEndMinutes(s, offer.durationHours) === null)) return null;
  const starts = [...new Set(offer.timeSlots.map((s) => s.startMinutes))].sort((a, b) => a - b);
  const dated = rows.filter((r) => r.date === serviceDate);
  return starts.map((start): ListedStart => {
    const time = minutesToHhmm(start);
    if (!isOfferedOn(offer.daysOffered, serviceDate)) return { time, status: "unavailable" };
    // Several rows may share a start (quoteSlot uses the first with seats): the best mark wins.
    const rank: ListedStart["status"][] = ["unavailable", "sold_out", "limited", "available"];
    let best = 0;
    for (const r of dated.filter((x) => x.startMinutes === start)) {
      const rules = slotRulesFor(offer.timeSlots, r.timeSlotId, r.startMinutes);
      if (!rules || rules.isOnRequest || !isOfferedOn(rules.daysOffered, serviceDate)) continue;
      // The quote refuses a row whose end differs from the derived one (review 85 A2): never show it as open.
      if (rules.endMinutes === null && r.endMinutes !== slotEndMinutes({ startMinutes: r.startMinutes, endMinutes: null }, offer.durationHours)) continue;
      if (now.getTime() >= slotCutoffMs(serviceDate, start, rules.minimumAdvancedBookingHours)) continue;
      if (r.seatsLeft === 0 && r.price.isBookable) continue; // a closed day (Q-A1)
      let status: ListedStart["status"];
      if (!r.price.isBookable || r.seatsLeft <= 0) status = "sold_out";
      else {
        const unknownCapacity = CAPACITY_SENTINELS.has(r.seatsLeft) || perTripPriced(offer, r.price);
        status = !unknownCapacity && r.seatsLeft <= LIMITED_SEATS_AT ? "limited" : "available";
      }
      best = Math.max(best, rank.indexOf(status));
    }
    return { time, status: rank[best] };
  });
}

/** One answer for a start time whose rows all failed: unknown wins (fail closed), then the most specific. */
function pickReason(reasons: Refusal[]): Refusal {
  const order: Refusal[] = ["availability_unknown", "on_request", "closed", "past_cutoff", "sold_out"];
  return order.find((r) => reasons.includes(r)) ?? "availability_unknown";
}

export interface TicketQuoteInput {
  offer: StoredOffer;
  policy: TravelDeskCancellationRule[] | null;
  serviceDate: string;
  units: QuoteUnits;
  stock: TravelDeskTicketStock;
  now: Date;
  issuesTicketsAtConfirm: Tristate;
}

/**
 * TicketOnly offers. The stock read takes no date: its price is the one of the
 * pricing period open today, the day we buy (Q-T2). The ticket can be used
 * until `validUntil`, so a quote needs a price dated today and a visit date
 * from today up to the validity.
 */
export function quoteTickets(input: TicketQuoteInput): SupplierQuoteResult {
  const { offer, serviceDate, units, stock: s } = input;
  const today = dubaiToday(input.now);
  if (serviceDate < today) return refuse("past_cutoff");
  if (!isOfferedOn(offer.daysOffered, serviceDate)) return refuse("closed");
  if (!paxAllowed(offer, units)) return refuse("unit_rule_failed");
  // A price for another day belongs to another pricing period: never charge or show it.
  if (s.price.date !== today) return refuse("availability_unknown");
  // A visit after the stock's validity is its own reason (review 86 B5-03): the date is the problem, not the stock.
  if (s.validUntil !== null && s.validUntil < serviceDate) return refuse("ticket_validity_ended");
  if (!s.price.isBookable) return refuse("sold_out");
  const seats = units.adults + units.children;
  const needs: Array<{ left: number; n: number }> = [];
  if (s.sameTicketForAdultAndChild) {
    if (s.adultTicketRequired) needs.push({ left: s.adultTicketsLeft, n: seats });
  } else {
    if (s.adultTicketRequired) needs.push({ left: s.adultTicketsLeft, n: units.adults });
    if (s.childTicketRequired && units.children > 0) needs.push({ left: s.childTicketsLeft, n: units.children });
  }
  // A sentinel may mean "not stocked" as well as "unlimited" (Q-A6): never sell against it.
  if (needs.some((x) => CAPACITY_SENTINELS.has(x.left))) return refuse("availability_unknown");
  if (needs.some((x) => x.left < x.n)) return refuse("sold_out");
  const charged = chargedTotalMinor(s.price, units);
  if (!roundingWithinTolerance(s.price, units) || charged === null) return refuse("availability_unknown");
  return ok(input, {
    slotRef: null,
    netAedMinor: charged,
    netUsdMinor: netUsdMinorOf(s.price, units),
    capacity: needs.length ? "limited" : "unknown",
    seatsLeft: needs.length ? Math.min(...needs.map((x) => x.left)) : null,
    // Today's price holds until midnight in Dubai, when the next day's pricing
    // period may start: the quote must expire then (and refuse too close to it).
    cutoffUtc: new Date(dubaiInstantMs(today, 24 * 60)).toISOString(),
    ticketValidUntil: s.validUntil,
    openDatedTicket: true,
  });
}

function ok(
  input: { serviceDate: string; policy: TravelDeskCancellationRule[] | null; now: Date; issuesTicketsAtConfirm: Tristate },
  part: Pick<Ok, "slotRef" | "netAedMinor" | "netUsdMinor" | "capacity" | "seatsLeft" | "cutoffUtc"> & { ticketValidUntil?: string | null; openDatedTicket?: true },
): SupplierQuoteResult {
  // Doc 29 §4.4: issued tickets can never be cancelled, so a ticket quote carries no supplier refund window, whatever the tour policy says.
  // Otherwise the window counts back from the booked slot's start (doc 29 §8.7).
  const startMinutes = part.slotRef ? (exactSlotOf(part.slotRef)?.startMinutes ?? null) : null;
  const free = part.openDatedTicket ? null : freeCancellationUntilMs(input.serviceDate, input.policy, startMinutes);
  return {
    ok: true,
    ...part,
    ticketValidUntil: part.ticketValidUntil ?? null,
    checkedAt: input.now.toISOString(),
    issuesTicketsAtConfirm: input.issuesTicketsAtConfirm,
    supplierFreeCancellationUntilUtc: free === null ? null : new Date(free).toISOString(),
  };
}
