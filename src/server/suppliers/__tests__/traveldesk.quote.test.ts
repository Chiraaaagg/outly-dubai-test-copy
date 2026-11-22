import { describe, expect, it } from "vitest";
import type { TravelDeskAvailabilityRow } from "../traveldesk/traveldesk.codec";
import { parseStoredOffer, parseStoredPolicy, type StoredOffer } from "../traveldesk/traveldesk.offer-terms";
import {
  ageBandMismatches,
  chargedTotalMinor,
  nearestDirhamMinor,
  dubaiInstantMs,
  HALF_DIRHAM_MARGIN_MINOR_PER_UNIT,
  freeCancellationUntilMs,
  hotelOnPickupList,
  netUsdMinorOf,
  offerReadinessFacts,
  paxAllowed,
  pickupShapeFits,
  quoteSlot,
  quoteTickets,
  slotCutoffMs,
  slotRulesFor,
  unitsFrom,
  type QuoteUnits,
} from "../traveldesk/traveldesk.quote";
import { pickupHotels, row, SERVICE_DATE, storedOffer, storedSlot, storedTour, THURSDAY, ticketStock } from "./fixtures/traveldesk-terms";

/**
 * Supplier quote rules (SUP-14, SUP-24): the slot metadata join, cutoffs,
 * closed days, sentinels, per-trip capacity, TicketOnly, rounding and the
 * supplier's free-cancellation deadline. Pure: stored payloads and fresh rows
 * are synthetic fixtures.
 */

const NOW = new Date("2026-11-01T08:00:00Z");
const TWO_ADULTS_ONE_CHILD: QuoteUnits = { adults: 2, children: 1, infants: 0 };
const policy = parseStoredPolicy(storedTour());

function offerOf(over: Record<string, unknown> = {}): StoredOffer {
  const o = parseStoredOffer(storedOffer(over));
  if (!o) throw new Error("fixture does not parse");
  return o;
}

function slot(rows: TravelDeskAvailabilityRow[], over: { offer?: StoredOffer; slotRef?: string | null; units?: QuoteUnits; now?: Date; policy?: typeof policy } = {}) {
  return quoteSlot({
    offer: over.offer ?? offerOf(),
    policy: over.policy === undefined ? policy : over.policy,
    serviceDate: SERVICE_DATE,
    slotRef: over.slotRef === undefined ? "21:00" : over.slotRef,
    units: over.units ?? TWO_ADULTS_ONE_CHILD,
    rows,
    now: over.now ?? NOW,
    issuesTicketsAtConfirm: "unknown",
  });
}

describe("live-book slot quote (SUP-14)", () => {
  it("prices exactly from the fresh row and joins the stored slot rules", () => {
    expect(slot([row()])).toEqual({
      ok: true,
      slotRef: "11@21:00",
      netAedMinor: 26_000n, // 2 × 10,000 + 1 × 6,000 (synthetic)
      netUsdMinor: 7_000n, // 2 × 2,700 + 1 × 1,600, the supplier's own USD figure
      checkedAt: NOW.toISOString(),
      capacity: "limited",
      seatsLeft: 30,
      // 21:00 Asia/Dubai is 17:00 UTC; the slot closes 12 hours before.
      cutoffUtc: "2026-11-12T05:00:00.000Z",
      issuesTicketsAtConfirm: "unknown",
      // 72 h before 00:00 Asia/Dubai on the service date (2026-11-11T20:00Z).
      supplierFreeCancellationUntilUtc: "2026-11-08T20:00:00.000Z",
      ticketValidUntil: null,
    });
  });

  it("an on-request slot is on_request, even inside a bookable offer (Q-A3)", () => {
    expect(slot([row()], { offer: offerOf({ timeSlots: [storedSlot({ isOnRequest: true })] }) })).toEqual({ ok: false, reason: "on_request" });
  });

  it("refuses after the advance-booking cutoff", () => {
    expect(slot([row()], { now: new Date("2026-11-12T05:00:00Z") })).toEqual({ ok: false, reason: "past_cutoff" });
    expect(slot([row()], { now: new Date("2026-11-12T04:59:59Z") }).ok).toBe(true);
  });

  it("a negative minimumAdvancedBooking (Q-A5, unconfirmed) is read as hours before the start: the strictest reading", () => {
    const offer = offerOf({ timeSlots: [storedSlot({ minimumAdvancedBookingHours: -24 })] });
    expect(slotCutoffMs(SERVICE_DATE, 1260, -24)).toBe(Date.parse("2026-11-11T17:00:00Z"));
    expect(slot([row()], { offer, now: new Date("2026-11-11T18:00:00Z") })).toEqual({ ok: false, reason: "past_cutoff" });
    const before = slot([row()], { offer, now: new Date("2026-11-11T16:00:00Z") });
    expect(before.ok && before.cutoffUtc).toBe("2026-11-11T17:00:00.000Z");
  });

  it("without an advance rule the cutoff is the slot start itself", () => {
    const offer = offerOf({ timeSlots: [storedSlot({ minimumAdvancedBookingHours: null })] });
    const r = slot([row()], { offer });
    expect(r.ok && r.cutoffUtc).toBe("2026-11-12T17:00:00.000Z");
    expect(slot([row()], { offer, now: new Date("2026-11-12T17:00:00Z") })).toEqual({ ok: false, reason: "past_cutoff" });
  });

  it("a weekday outside daysOffered is closed, for the offer and for the slot", () => {
    expect(slot([row()], { offer: offerOf({ daysOffered: 1 }) })).toEqual({ ok: false, reason: "closed" });
    expect(slot([row()], { offer: offerOf({ daysOffered: THURSDAY }) }).ok).toBe(true);
    expect(slot([row()], { offer: offerOf({ timeSlots: [storedSlot({ daysOffered: 64 })] }) })).toEqual({ ok: false, reason: "closed" });
  });

  it("a non-operating day (left 0, isBookable true) is closed, not sold out (doc 21 Q-A1)", () => {
    expect(slot([row({ seatsLeft: 0 })])).toEqual({ ok: false, reason: "closed" });
  });

  it("not bookable, or fewer seats than guests, is sold out", () => {
    expect(slot([row({ price: { isBookable: false } })])).toEqual({ ok: false, reason: "sold_out" });
    expect(slot([row({ seatsLeft: 2 })])).toEqual({ ok: false, reason: "sold_out" });
    // Infants take no seat.
    expect(slot([row({ seatsLeft: 2 })], { units: { adults: 2, children: 0, infants: 1 } }).ok).toBe(true);
  });

  it("sentinel capacities (Q-A6) are unknown capacity, never a seat count", () => {
    for (const left of [99_999, 999_999]) {
      const r = slot([row({ seatsLeft: left })]);
      expect(r).toMatchObject({ ok: true, capacity: "unknown", seatsLeft: null });
    }
  });

  it("per-trip offers have unknown capacity and are priced once per trip (Q-C8)", () => {
    const offer = offerOf({ privateType: "private" });
    const r = slot([row({ seatsLeft: 1, price: { perAdultMinor: 0n, perChildMinor: 0n, perTripMinor: 50_000n } })], { offer });
    expect(r).toMatchObject({ ok: true, capacity: "unknown", seatsLeft: null, netAedMinor: 50_000n });
    // Inferred from the price as well: adult and child zero, one vehicle price.
    const sharedCar = slot([row({ seatsLeft: 1, price: { perAdultMinor: 0n, perChildMinor: 0n, perTripMinor: 50_000n } })]);
    expect(sharedCar).toMatchObject({ ok: true, capacity: "unknown" });
  });

  it("several slots at one start time: the first with enough seats is used (L3654)", () => {
    const offer = offerOf({ timeSlots: [storedSlot(), storedSlot({ timeSlotId: 12 })] });
    const r = slot([row({ seatsLeft: 1 }), row({ timeSlotId: 12, seatsLeft: 9 })], { offer });
    expect(r).toMatchObject({ ok: true, slotRef: "12@21:00", seatsLeft: 9 });
    // An exact reference picks that slot only.
    expect(slot([row({ seatsLeft: 1 }), row({ timeSlotId: 12, seatsLeft: 9 })], { offer, slotRef: "11@21:00" })).toEqual({ ok: false, reason: "sold_out" });
  });

  it("slot references: exact, bare time, or none when the date has one start; anything else is invalid", () => {
    expect(slot([row()], { slotRef: "11@21:00" }).ok).toBe(true);
    expect(slot([row()], { slotRef: null }).ok).toBe(true);
    const two = offerOf({ timeSlots: [storedSlot(), storedSlot({ timeSlotId: 12, startMinutes: 600 })] });
    expect(slot([row(), row({ timeSlotId: 12, startMinutes: 600 })], { offer: two, slotRef: null })).toEqual({ ok: false, reason: "invalid_slot" });
    expect(slot([row()], { slotRef: "25:00" })).toEqual({ ok: false, reason: "invalid_slot" });
    expect(slot([row()], { slotRef: "nine pm" })).toEqual({ ok: false, reason: "invalid_slot" });
    expect(slot([row()], { slotRef: "10:00" })).toEqual({ ok: false, reason: "invalid_slot" });
  });

  it("a row without stored rules is never sold; silence for a known slot is unknown, not sold out", () => {
    expect(slot([row({ timeSlotId: 99 })])).toEqual({ ok: false, reason: "availability_unknown" });
    expect(slot([])).toEqual({ ok: false, reason: "availability_unknown" });
    expect(slot([row({ date: "2026-11-13" })])).toEqual({ ok: false, reason: "availability_unknown" });
  });

  it("joins an id repeated over start times only when every entry agrees (isAnyTime offers)", () => {
    const agree = [storedSlot({ startMinutes: 540, isAnyTime: true }), storedSlot({ startMinutes: 600, isAnyTime: true })];
    const offer = offerOf({ timeSlots: agree });
    expect(slotRulesFor(offer.timeSlots, 11, 660)?.startMinutes).toBe(540);
    const disagree = offerOf({ timeSlots: [agree[0], storedSlot({ startMinutes: 600, isAnyTime: true, isOnRequest: true })] });
    expect(slotRulesFor(disagree.timeSlots, 11, 660)).toBeNull();
    expect(slot([row({ startMinutes: 660 })], { offer: disagree, slotRef: "11@11:00" })).toEqual({ ok: false, reason: "availability_unknown" });
  });

  it("pax outside the offer's rules is unit_rule_failed", () => {
    expect(slot([row()], { offer: offerOf({ childrenAllowed: false }) })).toEqual({ ok: false, reason: "unit_rule_failed" });
    expect(slot([row()], { offer: offerOf({ maxPax: 2 }) })).toEqual({ ok: false, reason: "unit_rule_failed" });
    expect(paxAllowed(offerOf({ paxLimits: { adults: [null, null], children: [null, 0], infants: [null, null] } }), TWO_ADULTS_ONE_CHILD)).toBe(false);
  });
});

describe("rounding and amounts (SUP-24)", () => {
  it("keeps a rounded price only while the summed error fits the shared one-fil tolerance", () => {
    const rounded = row({ price: { roundedFields: ["pricePerAdult"] } });
    expect(slot([rounded], { units: { adults: 2, children: 0, infants: 0 } }).ok).toBe(true);
    expect(slot([rounded], { units: { adults: 3, children: 0, infants: 0 } })).toEqual({ ok: false, reason: "availability_unknown" });
  });

  it("reports the USD net only when it is exact and given; it never changes the AED decision", () => {
    const party = TWO_ADULTS_ONE_CHILD;
    expect(netUsdMinorOf(row().price, party)).toBe(7_000n);
    // A rounded USD field that is summed: not exact.
    expect(netUsdMinorOf(row({ price: { roundedFields: ["pricePerChildUsd"] } }).price, party)).toBeNull();
    // A rounded USD field that is not summed (no children): still exact.
    expect(netUsdMinorOf(row({ price: { roundedFields: ["pricePerChildUsd"] } }).price, { adults: 2, children: 0, infants: 0 })).toBe(5_400n);
    // No USD figure at all against a non-zero AED net.
    const noUsd = row({ price: { perAdultUsdMinor: 0n, perChildUsdMinor: 0n } });
    expect(netUsdMinorOf(noUsd.price, party)).toBeNull();
    expect(slot([noUsd])).toMatchObject({ ok: true, netAedMinor: 26_000n, netUsdMinor: null });
    // Per trip: the trip's USD figure counts once.
    expect(netUsdMinorOf(row({ price: { perAdultMinor: 0n, perChildMinor: 0n, perTripMinor: 50_000n, perAdultUsdMinor: 0n, perChildUsdMinor: 0n, perTripUsdMinor: 13_600n } }).price, party)).toBe(13_600n);
  });

  it("refuses a row priced for another date", () => {
    expect(slot([row({ price: { date: "2026-11-01" } })])).toEqual({ ok: false, reason: "availability_unknown" });
  });
});

describe("whole-dirham charge (doc 22 §32.25)", () => {
  const price = (perAdultMinor: bigint, perChildMinor = 0n, perTripMinor = 0n) => ({ perAdultMinor, perChildMinor, perTripMinor });
  const adults = (n: number) => ({ adults: n, children: 0 });

  it("charges the net rounded to the nearest whole dirham; whole-dirham nets are unchanged", () => {
    expect(chargedTotalMinor(price(10_000n, 6_000n), { adults: 2, children: 1 })).toBe(26_000n);
    expect(chargedTotalMinor(price(12_370n), adults(1))).toBe(12_400n); // synthetic 123.70 → 124
    expect(chargedTotalMinor(price(12_320n), adults(1))).toBe(12_300n); // synthetic 123.20 → 123
    expect(chargedTotalMinor(price(0n, 0n, 50_030n), adults(1))).toBe(50_000n); // per trip, counted once
  });

  it("rounds the booking total, not each unit (TravelDesk, 12 Nov 2026)", () => {
    // 2 × 123.70 = 247.40 → 247 (per unit would have been 248).
    expect(chargedTotalMinor(price(12_370n), adults(2))).toBe(24_700n);
    expect(chargedTotalMinor(price(12_320n), adults(2))).toBe(24_600n);
    // An adult and a child each under half a dirham, whose fils add up past it: 183.80 → 184.
    expect(chargedTotalMinor(price(12_340n, 6_040n), { adults: 1, children: 1 })).toBe(18_400n);
  });

  it("has no answer at or within a fil per unit of half a dirham, where the direction is unknown", () => {
    for (const fils of [12_349n, 12_350n, 12_351n]) expect(chargedTotalMinor(price(fils), adults(1))).toBeNull();
    expect(chargedTotalMinor(price(12_348n), adults(1))).toBe(12_300n);
    expect(chargedTotalMinor(price(12_352n), adults(1))).toBe(12_400n);
    // Three units at 123.17: the total 369.51 sits within 3 fils of half a dirham.
    expect(chargedTotalMinor(price(12_317n), adults(3))).toBeNull();
    expect(HALF_DIRHAM_MARGIN_MINOR_PER_UNIT).toBe(1n);
  });

  it("rounds exactly half a dirham to even (TravelDesk: 100.50 → 100, 101.50 → 102)", () => {
    expect(nearestDirhamMinor(10_050n, 0n)).toBe(10_000n);
    expect(nearestDirhamMinor(10_150n, 0n)).toBe(10_200n);
    expect(nearestDirhamMinor(10_051n, 0n)).toBe(10_100n);
    expect(nearestDirhamMinor(10_049n, 0n)).toBe(10_000n);
    // With a margin, the half itself and its neighbours have no answer.
    expect(nearestDirhamMinor(10_050n, 1n)).toBeNull();
    expect(nearestDirhamMinor(10_051n, 1n)).toBeNull();
    expect(nearestDirhamMinor(10_052n, 1n)).toBe(10_100n);
  });

  it("the slot quote's net is the whole-dirham charge, and refuses when it is unknown", () => {
    const fractional = row({ price: { perAdultMinor: 12_370n, perChildMinor: 6_000n } });
    expect(slot([fractional], { units: { adults: 1, children: 0, infants: 0 } })).toMatchObject({ ok: true, netAedMinor: 12_400n });
    expect(slot([fractional], { units: { adults: 1, children: 1, infants: 0 } })).toMatchObject({ ok: true, netAedMinor: 18_400n });
    // The booking total is rounded once: 247.40 → 247.
    expect(slot([fractional], { units: { adults: 2, children: 0, infants: 0 } })).toMatchObject({ ok: true, netAedMinor: 24_700n });
    expect(slot([row({ price: { perAdultMinor: 12_350n } })], { units: { adults: 1, children: 0, infants: 0 } })).toEqual({ ok: false, reason: "availability_unknown" });
    // The USD figure stays the listed one.
    expect(slot([fractional], { units: { adults: 1, children: 0, infants: 0 } })).toMatchObject({ netUsdMinor: 2_700n });
  });

  it("the TicketOnly quote's net is the whole-dirham charge too", () => {
    const offer = offerOf({ offerId: 502, bookingKind: "ticket_only", bookingTypeRaw: 2, timeSlots: [] });
    const q = (perAdultMinor: bigint, units: QuoteUnits) =>
      quoteTickets({ offer, policy, serviceDate: SERVICE_DATE, units, stock: ticketStock({ price: { perAdultMinor } }), now: NOW, issuesTicketsAtConfirm: "yes" });
    expect(q(12_320n, { adults: 1, children: 0, infants: 0 })).toMatchObject({ ok: true, netAedMinor: 12_300n });
    expect(q(12_370n, { adults: 2, children: 0, infants: 0 })).toMatchObject({ ok: true, netAedMinor: 24_700n });
    expect(q(12_350n, { adults: 1, children: 0, infants: 0 })).toEqual({ ok: false, reason: "availability_unknown" });
  });
});

describe("TicketOnly (Q-T2)", () => {
  const offer = offerOf({ offerId: 502, bookingKind: "ticket_only", bookingTypeRaw: 2, timeSlots: [] });
  const tickets = (over: Parameters<typeof ticketStock>[0] = {}, units: QuoteUnits = TWO_ADULTS_ONE_CHILD) =>
    quoteTickets({ offer, policy, serviceDate: SERVICE_DATE, units, stock: ticketStock(over), now: NOW, issuesTicketsAtConfirm: "yes" });

  it("uses today's price (the purchase day) for a later visit, within the ticket's validity", () => {
    // NOW is 1 Nov 2026 in Dubai; the visit is 12 Nov.
    expect(tickets()).toMatchObject({ ok: true, ticketValidUntil: "2027-12-31" });
    // A price dated the visit day, or any other day, belongs to another pricing period.
    expect(tickets({ price: { date: SERVICE_DATE } })).toEqual({ ok: false, reason: "availability_unknown" });
    expect(tickets({ price: { date: null } })).toEqual({ ok: false, reason: "availability_unknown" });
    // The visit must fall on or before the last valid day.
    expect(tickets({ validUntil: "2026-11-11" })).toEqual({ ok: false, reason: "availability_unknown" });
    expect(tickets({ validUntil: SERVICE_DATE })).toMatchObject({ ok: true, ticketValidUntil: SERVICE_DATE });
    expect(tickets({ validUntil: null })).toMatchObject({ ok: true, ticketValidUntil: null });
  });

  it("purchase day is the Dubai date, and a visit before today is refused", () => {
    const at = (now: Date, serviceDate: string, priceDate: string) =>
      quoteTickets({ offer, policy, serviceDate, units: TWO_ADULTS_ONE_CHILD, stock: ticketStock({ price: { date: priceDate } }), now, issuesTicketsAtConfirm: "yes" });
    // 21:30 UTC on 1 Nov is 01:30 on 2 Nov in Dubai.
    expect(at(new Date("2026-11-01T21:30:00Z"), SERVICE_DATE, "2026-11-02").ok).toBe(true);
    expect(at(new Date("2026-11-01T21:30:00Z"), SERVICE_DATE, "2026-11-01")).toEqual({ ok: false, reason: "availability_unknown" });
    expect(at(new Date("2026-11-13T08:00:00Z"), SERVICE_DATE, "2026-11-13")).toEqual({ ok: false, reason: "past_cutoff" });
    // Same-day visit still works.
    expect(at(new Date("2026-11-12T08:00:00Z"), SERVICE_DATE, SERVICE_DATE).ok).toBe(true);
    // Today's price holds until midnight in Dubai: the cutoff is the start of the next Dubai day.
    expect(at(new Date("2026-11-01T21:30:00Z"), SERVICE_DATE, "2026-11-02")).toMatchObject({ cutoffUtc: "2026-11-02T20:00:00.000Z" });
  });

  it("date-scoped stock quotes exactly, with the stock as limited capacity", () => {
    expect(tickets()).toMatchObject({ ok: true, slotRef: null, netAedMinor: 26_000n, netUsdMinor: 7_000n, capacity: "limited", seatsLeft: 25, cutoffUtc: "2026-11-01T20:00:00.000Z", issuesTicketsAtConfirm: "yes" });
    expect(tickets({ adultTicketsLeft: 1 })).toEqual({ ok: false, reason: "sold_out" });
    expect(tickets({ price: { isBookable: false } })).toEqual({ ok: false, reason: "sold_out" });
  });

  it("a sentinel stock count (Q-A6) may mean not stocked: never sold against", () => {
    expect(tickets({ childTicketsLeft: 999_999 })).toEqual({ ok: false, reason: "availability_unknown" });
    // Not asked for: an adults-only party is not affected by the child sentinel.
    expect(tickets({ childTicketsLeft: 999_999 }, { adults: 2, children: 0, infants: 0 }).ok).toBe(true);
  });
});

describe("free cancellation and time", () => {
  it("uses the smallest full-refund window, counted from 00:00 Asia/Dubai; none or unknown is null", () => {
    expect(dubaiInstantMs(SERVICE_DATE, 0)).toBe(Date.parse("2026-11-11T20:00:00Z"));
    expect(freeCancellationUntilMs(SERVICE_DATE, [{ moreThanHours: 72, refundPercent: 100 }, { moreThanHours: 48, refundPercent: 100 }])).toBe(Date.parse("2026-11-09T20:00:00Z"));
    expect(freeCancellationUntilMs(SERVICE_DATE, [{ moreThanHours: 24, refundPercent: 50 }])).toBeNull();
    expect(freeCancellationUntilMs(SERVICE_DATE, [])).toBeNull();
    expect(freeCancellationUntilMs(SERVICE_DATE, null)).toBeNull();
    const r = slot([row()], { policy: null });
    expect(r.ok && r.supplierFreeCancellationUntilUtc).toBeNull();
  });
});

describe("readiness facts from the stored offer", () => {
  const TODAY = "2026-11-01";
  const period = (over: Record<string, unknown> = {}, price: Record<string, unknown> | null = {}) => ({
    periodId: 1,
    dateStart: "2026-01-01",
    dateEnd: null,
    price: price === null ? null : { currency: "AED", perAdultMinor: "10000", perChildMinor: "6000", perTripMinor: "0", ...price },
    ...over,
  });

  it("units, highest net per unit over periods in force, and the smallest full-refund window", () => {
    const offer = offerOf({ pricingPeriods: [period(), period({ dateStart: "2026-12-20" }, { perAdultMinor: "11000" }), period({ dateEnd: "2026-10-31" }, { perAdultMinor: "99000" })] });
    expect(offerReadinessFacts(offer, policy, TODAY)).toEqual({
      supplierUnits: ["adult", "child", "infant"],
      netAedMinorByUnit: { adult: 11_000n, child: 6_000n, infant: 0n, trip: 0n }, // the expired period is ignored
      supplierFreeCancellationHours: 72,
      isDirectReporting: true,
      slotStartMinutes: [1260],
      anyTimeSlots: false,
    });
    // Starts are unique and ascending; an "any time" slot is reported; an unknown offer has no starts.
    const many = offerOf({ timeSlots: [storedSlot({ startMinutes: 1260 }), storedSlot({ timeSlotId: 12, startMinutes: 600, isAnyTime: true }), storedSlot({ timeSlotId: 13, startMinutes: 600 })] });
    expect(offerReadinessFacts(many, policy, TODAY)).toMatchObject({ slotStartMinutes: [600, 1260], anyTimeSlots: true });
    expect(offerReadinessFacts(null, policy, TODAY)).toMatchObject({ slotStartMinutes: null, anyTimeSlots: null });
    expect(offerReadinessFacts(offerOf({ isDirectReporting: false }), policy, TODAY).isDirectReporting).toBe(false);
  });

  it("drops units the offer refuses and adds trip for per-trip pricing", () => {
    const noKids = offerOf({ childrenAllowed: false, paxLimits: { adults: [null, null], children: [null, null], infants: [null, 0] } });
    expect(offerReadinessFacts(noKids, policy, TODAY).supplierUnits).toEqual(["adult"]);
    const car = offerOf({ privateType: "private", pricingPeriods: [period({}, { perAdultMinor: "0", perChildMinor: "0", perTripMinor: "50000" })] });
    expect(offerReadinessFacts(car, policy, TODAY)).toMatchObject({ supplierUnits: ["adult", "child", "infant", "trip"], netAedMinorByUnit: { adult: 0n, trip: 50_000n } });
  });

  it("nets are unknown without a priced period in force, with an unpriced one, or with mixed person and trip pricing", () => {
    expect(offerReadinessFacts(offerOf({ pricingPeriods: [] }), policy, TODAY).netAedMinorByUnit).toBeNull();
    expect(offerReadinessFacts(offerOf({ pricingPeriods: [period({ dateEnd: "2026-10-31" })] }), policy, TODAY).netAedMinorByUnit).toBeNull();
    expect(offerReadinessFacts(offerOf({ pricingPeriods: [period(), period({}, null)] }), policy, TODAY).netAedMinorByUnit).toBeNull();
    expect(offerReadinessFacts(offerOf({ pricingPeriods: [period({}, { perTripMinor: "20000" })] }), policy, TODAY).netAedMinorByUnit).toBeNull();
  });

  it("refund hours: 0 when no window refunds in full (or the window is 0 h), null when the policy is unknown; nothing without an offer", () => {
    expect(offerReadinessFacts(offerOf(), [{ moreThanHours: 24, refundPercent: 50 }], TODAY).supplierFreeCancellationHours).toBe(0);
    expect(offerReadinessFacts(offerOf(), [{ moreThanHours: 0, refundPercent: 100 }], TODAY).supplierFreeCancellationHours).toBe(0);
    expect(offerReadinessFacts(offerOf(), null, TODAY).supplierFreeCancellationHours).toBeNull();
    expect(offerReadinessFacts(null, policy, TODAY)).toEqual({ supplierUnits: [], netAedMinorByUnit: null, supplierFreeCancellationHours: 72, isDirectReporting: null, slotStartMinutes: null, anyTimeSlots: null });
  });
});

describe("supplier units", () => {
  it("maps adult, child, infant and one trip; refuses unknown units, bad counts, several trips and no seated guest", () => {
    expect(unitsFrom({ adult: 2, child: 1, infant: 1 })).toEqual({ adults: 2, children: 1, infants: 1 });
    expect(unitsFrom({ adult: 1, trip: 1 })).toEqual({ adults: 1, children: 0, infants: 0 });
    expect(unitsFrom({ senior: 1 })).toBeNull();
    expect(unitsFrom({ adult: 1.5 })).toBeNull();
    expect(unitsFrom({ adult: -1 })).toBeNull();
    expect(unitsFrom({ adult: 2, trip: 2 })).toBeNull();
    expect(unitsFrom({ infant: 1 })).toBeNull();
  });
});

describe("pickup (CR-B2-4)", () => {
  it("a direct-reporting offer takes no hotel; an offer that collects needs one", () => {
    expect(pickupShapeFits(true, null)).toBe(true);
    expect(pickupShapeFits(true, { hotelRef: "42" })).toBe(false);
    expect(pickupShapeFits(false, { hotelRef: "42" })).toBe(true);
    expect(pickupShapeFits(false, null)).toBe(false);
  });

  it("a hotel matches only by its exact TravelDesk id", () => {
    expect(hotelOnPickupList("42", pickupHotels())).toBe(true);
    for (const ref of ["99", "042", "+42", "42.0", " 42", "Example Marina Hotel", ""]) expect(hotelOnPickupList(ref, pickupHotels())).toBe(false);
    expect(hotelOnPickupList("42", [])).toBe(false);
  });

  it("N3: a supplier child or infant band must reach the top of the page's band; a wider one is harmless", () => {
    const page = { child: { min: 3, max: 11 }, infant: { min: null, max: 2 } };
    const terms = (over: Partial<Pick<StoredOffer, "childrenAllowed" | "childAge" | "infantsAllowed" | "infantAge">>) => ({ childrenAllowed: true, childAge: 12, infantsAllowed: true, infantAge: 3, ...over });
    expect(ageBandMismatches(terms({}), page)).toEqual([]);
    // Wider supplier bands only book the guest in the category the quote priced.
    expect(ageBandMismatches(terms({ childAge: 14, infantAge: 5 }), page)).toEqual([]);
    // A 10- or 11-year-old page child would be a TravelDesk adult; a 2-year-old page infant a TravelDesk child.
    expect(ageBandMismatches(terms({ childAge: 10 }), page)).toEqual(["child"]);
    expect(ageBandMismatches(terms({ infantAge: 2 }), page)).toEqual(["infant"]);
    // Unknown ages fail; units the offer does not accept are not checked.
    expect(ageBandMismatches(terms({ childAge: 0, infantAge: 0 }), page)).toEqual(["child", "infant"]);
    expect(ageBandMismatches(terms({ childrenAllowed: false, childAge: 0, infantsAllowed: false, infantAge: 0 }), page)).toEqual([]);
    // A page band without an upper limit cannot be covered.
    expect(ageBandMismatches(terms({}), { ...page, child: { min: 3, max: null } })).toEqual(["child"]);
  });
});
