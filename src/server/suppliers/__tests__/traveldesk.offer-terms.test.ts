import { describe, expect, it } from "vitest";
import { offerTermsHash, offerTermsOf, parseStoredOffer, parseStoredPolicy, slotEndMinutes } from "../traveldesk/traveldesk.offer-terms";
import { storedOffer, storedSlot, storedTour } from "./fixtures/traveldesk-terms";

/**
 * The approved-offer hash (SUP-15): which stored changes count as a change of
 * terms and which do not. Pure; synthetic payloads.
 */

const base = offerTermsHash(storedOffer(), storedTour());

describe("approved offer hash (SUP-15)", () => {
  it("is a stable sha256 that ignores key order and bigint-vs-string money", () => {
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    const reordered = Object.fromEntries(Object.entries(storedOffer()).reverse());
    expect(offerTermsHash(reordered, storedTour())).toBe(base);
    const bigints = storedOffer({ pricingPeriods: [{ periodId: 1, dateStart: "2026-01-01", dateEnd: null, price: { perAdultMinor: 10_000n, perChildMinor: 6_000n, perTripMinor: 0n } }] });
    expect(offerTermsHash(bigints, storedTour())).toBe(base);
  });

  it("changes with the child age band, per-category limits and pax range", () => {
    expect(offerTermsHash(storedOffer({ childAge: 10 }), storedTour())).not.toBe(base);
    expect(offerTermsHash(storedOffer({ paxLimits: { adults: [1, null], children: [null, 4], infants: [null, null] } }), storedTour())).not.toBe(base);
    expect(offerTermsHash(storedOffer({ maxPax: 12 }), storedTour())).not.toBe(base);
    expect(offerTermsHash(storedOffer({ childrenAllowed: false }), storedTour())).not.toBe(base);
  });

  it("changes with slots, days offered, pickup, booking kind and the tour's cancellation policy", () => {
    expect(offerTermsHash(storedOffer({ timeSlots: [storedSlot({ startMinutes: 1200 })] }), storedTour())).not.toBe(base);
    expect(offerTermsHash(storedOffer({ timeSlots: [storedSlot({ minimumAdvancedBookingHours: -24 })] }), storedTour())).not.toBe(base);
    expect(offerTermsHash(storedOffer({ timeSlots: [storedSlot({ isOnRequest: true })] }), storedTour())).not.toBe(base);
    expect(offerTermsHash(storedOffer({ daysOffered: 8 }), storedTour())).not.toBe(base);
    expect(offerTermsHash(storedOffer({ isDirectReporting: false }), storedTour())).not.toBe(base);
    expect(offerTermsHash(storedOffer({ bookingKind: "ticket_only", bookingTypeRaw: 2 }), storedTour())).not.toBe(base);
    expect(offerTermsHash(storedOffer(), storedTour({ cancellationPolicy: [{ moreThanHours: 48, refundPercent: 100 }] }))).not.toBe(base);
  });

  it("changes when the price basis moves from per person to per trip, but not with the price itself", () => {
    const perTrip = storedOffer({ pricingPeriods: [{ periodId: 1, dateStart: null, dateEnd: null, price: { perAdultMinor: "0", perChildMinor: "0", perTripMinor: "50000" } }] });
    expect(offerTermsHash(perTrip, storedTour())).not.toBe(base);
    const dearer = storedOffer({ pricingPeriods: [{ periodId: 1, dateStart: "2026-01-01", dateEnd: null, price: { perAdultMinor: "11000", perChildMinor: "6500", perTripMinor: "0" } }] });
    expect(offerTermsHash(dearer, storedTour())).toBe(base);
    expect(offerTermsHash(storedOffer({ name: "Renamed" }), storedTour({ name: "Renamed tour", photoCount: 9 }))).toBe(base);
  });

  it("slot order and policy order do not matter", () => {
    const two = [storedSlot({ timeSlotId: 12, startMinutes: 1200 }), storedSlot()];
    expect(offerTermsHash(storedOffer({ timeSlots: two }), storedTour())).toBe(offerTermsHash(storedOffer({ timeSlots: [...two].reverse() }), storedTour()));
    const policy = storedTour().cancellationPolicy as unknown[];
    expect(offerTermsHash(storedOffer(), storedTour({ cancellationPolicy: [...policy].reverse() }))).toBe(base);
  });

  it("is null when a payload lacks a rule field, so the mapping can never pass readiness", () => {
    const { paxLimits: _drop, ...noLimits } = storedOffer();
    expect(offerTermsHash(noLimits, storedTour())).toBeNull();
    expect(offerTermsHash(storedOffer(), {})).toBeNull();
    expect(offerTermsHash(null, storedTour())).toBeNull();
    expect(parseStoredOffer({})).toBeNull();
    expect(parseStoredPolicy(storedTour())).toEqual([
      { moreThanHours: 24, refundPercent: 50 },
      { moreThanHours: 72, refundPercent: 100 },
    ]);
    expect(offerTermsOf(storedOffer(), storedTour())?.priceBasis).toEqual({ privateType: "sharing", tripUnit: null, perPerson: true, perTrip: false });
  });
});

describe("derived slot end (OpenAPI TimeSlotPublicDto.endTime)", () => {
  it("is the stored end, else start plus the offer's hours; unknown without positive whole hours or past midnight", () => {
    expect(slotEndMinutes({ startMinutes: 600, endMinutes: 690 }, 5)).toBe(690);
    expect(slotEndMinutes({ startMinutes: 600, endMinutes: null }, 3)).toBe(780);
    for (const h of [undefined, null, 0, -1, 1.5]) expect(slotEndMinutes({ startMinutes: 600, endMinutes: null }, h)).toBeNull();
    expect(slotEndMinutes({ startMinutes: 1260, endMinutes: null }, 3)).toBe(1440);
    expect(slotEndMinutes({ startMinutes: 1260, endMinutes: null }, 4)).toBeNull();
  });

  it("the hours join the approved terms only when a slot's end is derived, so existing hashes are unchanged", () => {
    const tour = storedTour();
    const withEnds = (h: number) => storedOffer({ durationHours: h, timeSlots: [storedSlot({ endMinutes: 1365 })] });
    expect(offerTermsHash(withEnds(2), tour)).toBe(offerTermsHash(withEnds(5), tour));
    expect(offerTermsOf(withEnds(2), tour)).not.toHaveProperty("slotHours");
    const derived = (h: number) => storedOffer({ durationHours: h, timeSlots: [storedSlot({ endMinutes: null })] });
    expect(offerTermsHash(derived(2), tour)).not.toBe(offerTermsHash(derived(3), tour));
    expect(offerTermsOf(derived(2), tour)).toMatchObject({ slotHours: 2 });
  });
});
