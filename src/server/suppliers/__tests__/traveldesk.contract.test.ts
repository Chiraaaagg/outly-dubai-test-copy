import { describe, expect, it } from "vitest";
import offersFixture from "./fixtures/traveldesk/offers.json";
import tourFixture from "./fixtures/traveldesk/tour-5.json";
import {
  availabilityFrom,
  availabilityWire,
  offerListWire,
  offerSummariesFrom,
  tourDetailFrom,
  tourDetailsWire,
  TravelDeskCurrencyError,
} from "../traveldesk/traveldesk.codec";

/**
 * Contract tests against the shape of TravelDesk TEST API responses recorded
 * 27 Oct 2026 by `npm run traveldesk:probe`, trimmed to structure (descriptions,
 * photos, itineraries and FAQs removed). Every price in the fixtures and in the
 * availability rows below is a synthetic value: this repository is public and
 * must never carry supplier rates.
 */

describe("TravelDesk contract — recorded tour detail (tour 5)", () => {
  it("parses with the production schema and keeps the undocumented pax limits", () => {
    const parsed = tourDetailsWire.safeParse(tourFixture);
    expect(parsed.success).toBe(true);
    const tour = tourDetailFrom(parsed.data!);
    expect(tour.tourId).toBe(5);
    expect(tour.warnings).toEqual([]);
    expect(tour.cancellationPolicy).toEqual([
      { moreThanHours: 24, refundPercent: 50 },
      { moreThanHours: 48, refundPercent: 75 },
      { moreThanHours: 72, refundPercent: 100 },
    ]);
    const offer = tour.offers[0];
    expect(offer.offerId).toBe(62);
    expect(offer.bookingKind).toBe("live_book");
    expect(offer.isDirectReporting).toBe(true);
    expect(offer.tripUnit).toBeNull(); // sent as ""
    expect(offer.paxLimits.adults.length).toBe(2);
    expect(offer.timeSlots[0]).toMatchObject({ timeSlotId: 18, startMinutes: 1260, endMinutes: 1365, minimumAdvancedBookingHours: 12 });
    const period = offer.pricingPeriods[0].price!;
    expect(period.perAdultMinor).toBe(10000n);
    expect(period.recPerAdultMinor).toBe(12500n);
    expect(period.perAdultMinor < period.recPerAdultMinor!).toBe(true); // net below recommended retail
  });
});

describe("TravelDesk contract — recorded /offers", () => {
  it("parses, and every recorded period is priced in AED", () => {
    const parsed = offerListWire.safeParse(offersFixture);
    expect(parsed.success).toBe(true);
    const { offers, warnings } = offerSummariesFrom(parsed.data!);
    expect(warnings).toEqual([]);
    expect(offers.length).toBe(2);
    for (const o of offers) for (const p of o.pricingPeriods) expect(p.price?.currency).toBe("AED");
  });
});

function wireRow(over: { currency?: string | null; left?: number; startTime?: number; endTime?: number; timeSlotId?: number; pricePerAdult?: number } = {}) {
  return {
    availability: { id: 0, date: "2026-11-01T00:00:00", startTime: over.startTime ?? 540, endTime: over.endTime ?? 1080, timeSlotId: over.timeSlotId ?? 206, left: over.left ?? 100 },
    price: {
      offerId: 45,
      currency: over.currency === undefined ? "AED" : over.currency,
      recPricePerAdult: 125,
      recPricePerChild: 100,
      recPricePerTrip: 0,
      pricePerAdult: over.pricePerAdult ?? 100.01,
      pricePerChild: 80,
      pricePerTrip: 0,
      pricePerAdultUsd: 27.25,
      pricePerChildUsd: 21.8,
      pricePerTripUsd: 0,
      isBookable: true,
      supplierCurrencyCode: null,
      conversionRate: 3.65,
      vat: 5,
      date: "2026-11-01T00:00:00",
    },
  };
}

describe("TravelDesk contract — observed availability behaviour", () => {
  it("omitting CurrencyCode returned lowercase 'aed' — accepted as AED", () => {
    const { rows } = availabilityFrom(availabilityWire.parse([wireRow({ currency: "aed" })]));
    expect(rows[0].price.currency).toBe("AED");
    expect(rows[0].price.perAdultMinor).toBe(10001n);
  });

  it("an unsupported CurrencyCode echoed the code with USD amounts — rejected", () => {
    expect(() => availabilityFrom(availabilityWire.parse([wireRow({ currency: "XYZ", pricePerAdult: 27.25 })]))).toThrow(TravelDeskCurrencyError);
  });

  it("CurrencyCode=INR returned INR amounts — rejected for cost (AED only)", () => {
    expect(() => availabilityFrom(availabilityWire.parse([wireRow({ currency: "INR", pricePerAdult: 2599.5 })]))).toThrow(TravelDeskCurrencyError);
  });

  it("non-operating days come back as rows with left 0 and isBookable true", () => {
    const { rows } = availabilityFrom(availabilityWire.parse([wireRow({ left: 0 })]));
    expect(rows[0]).toMatchObject({ seatsLeft: 0, price: { isBookable: true } });
  });

  it("a slot ending at midnight reports endTime 0; one slot id repeats with several start times", () => {
    const { rows } = availabilityFrom(
      availabilityWire.parse([wireRow({ timeSlotId: 19, startTime: 900, endTime: 1380 }), wireRow({ timeSlotId: 19, startTime: 960, endTime: 0 })]),
    );
    expect(rows.map((r) => [r.timeSlotId, r.startMinutes, r.endMinutes])).toEqual([
      [19, 900, 1380],
      [19, 960, 0],
    ]);
  });
});
