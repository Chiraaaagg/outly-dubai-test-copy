import { describe, expect, it } from "vitest";
import {
  availabilityFrom,
  availabilityWire,
  balanceFrom,
  balanceWire,
  bookingKindFrom,
  datePart,
  hhmmToMinutes,
  hotelsFrom,
  hotelsWire,
  isOfferedOn,
  minutesToHhmm,
  netPriceFrom,
  netTotalMinor,
  offerListWire,
  offerSummariesFrom,
  privateTypeFrom,
  ticketStockFrom,
  ticketStockWire,
  tourDetailFrom,
  tourDetailsWire,
  tourListWire,
  tourSummariesFrom,
  TravelDeskCurrencyError,
  travelDeskPax,
} from "../traveldesk/traveldesk.codec";

/* Fixtures follow the DTO shapes in the TravelDesk spec (OfferPrice, Offer, TimeSlotPublicDto, …). */

function offerPrice(over: Record<string, unknown> = {}) {
  return {
    offerId: 501,
    currency: "AED",
    recPricePerAdult: 250,
    recPricePerChild: 200,
    recPricePerTrip: null,
    pricePerAdult: 185.5,
    pricePerChild: 150,
    pricePerTrip: 0,
    pricePerAdultUsd: 50.51,
    pricePerChildUsd: 40.84,
    pricePerTripUsd: 0,
    pricePerAdultBeforeDiscount: 185.5,
    discountPercent: null,
    hasDiscount: false,
    hasWidgetDiscount: false,
    isBookable: true,
    supplierCurrencyCode: "AED",
    conversionRate: 1,
    vat: 5,
    date: "2026-11-03T00:00:00",
    ...over,
  };
}

function pricingPeriod(over: Record<string, unknown> = {}) {
  const { date: _date, isBookable: _b, ...rest } = offerPrice();
  return { ...rest, id: 9001, dateStart: "2026-10-01T00:00:00", dateEnd: "2027-03-31T00:00:00", ...over };
}

function timeSlot(over: Record<string, unknown> = {}) {
  return {
    id: 71,
    name: "Morning",
    startTime: 570,
    endTime: 810,
    daysOffered: 127,
    isAnyTime: false,
    isOnRequest: false,
    offerId: 501,
    minimumAdvancedBooking: 12,
    isExternal: false,
    ...over,
  };
}

function offer(over: Record<string, unknown> = {}) {
  return {
    id: 501,
    name: "Desert Safari — Sharing",
    code: "DS-SHR",
    daysOffered: 0,
    numberOfHours: 6,
    minNumOfPeople: 1,
    maxNumOfPeople: 40,
    minimumAdvancedPayment: null,
    privateType: 0,
    childrenAllowed: true,
    childAge: 12,
    infantsAllowed: true,
    infantAge: 3,
    heroImage: { id: 1, caption: null, description: null, relatedId: 501, isSharedStorage: false },
    pricingPeriods: [pricingPeriod()],
    isDirectReporting: false,
    isAppendTransactionFeeB2b: false,
    isDirectCollection: false,
    description: "Pickup from hotel",
    timeSlots: [timeSlot()],
    bookingType: 1,
    isExternal: false,
    tripUnit: null,
    ...over,
  };
}

function availabilityRow(availability: Record<string, unknown> = {}, price: Record<string, unknown> = {}) {
  return {
    availability: { id: 1, date: "2026-11-03T00:00:00", startTime: 960, endTime: 1320, timeSlotId: 71, left: 12, ...availability },
    price: offerPrice(price),
  };
}

const tourDetailsFixture = {
  id: 3001,
  name: "Red Dune Desert Safari",
  heroImage: { id: 5, caption: "Dunes", description: null, relatedId: 3001, isSharedStorage: false },
  languageId: 1,
  language: "English",
  googlePlacesRating: 4.6,
  totalRatingsCount: 1234,
  totalRating: 4.7,
  offers: [
    offer({ id: 500, bookingType: 0, name: "On request", timeSlots: [timeSlot({ id: 70, isOnRequest: true })] }),
    offer(),
    offer({
      id: 502,
      bookingType: 2,
      name: "Tickets",
      privateType: 1,
      timeSlots: [timeSlot({ id: 72, isAnyTime: true, startTime: 0, endTime: null, minimumAdvancedBooking: null, isExternal: undefined })],
      pricingPeriods: [pricingPeriod({ id: 9100 }), pricingPeriod({ id: 9101, currency: null })],
    }),
    offer({ id: 503, bookingType: 7, privateType: 9, pricingPeriods: null, timeSlots: null }),
  ],
  termsAndConditions: "  ",
  salesDescription: "Dune bashing, BBQ dinner",
  cancellationPolicy: [
    { hours: 24, percents: 100 },
    { hours: 0, percents: 0 },
  ],
  photos: [{ id: 1 }, { id: 2 }],
  categories: [{ id: 4, name: "Desert", url: "desert-safari" }],
  faqList: [{ question: "q", answer: "a" }],
  itineraries: null,
  notesToAgent: null,
  isExternal: false,
  videoUrl: null,
  additionalVideos: ["https://video.example/1"],
};

describe("tour list", () => {
  it("parses a realistic TourList and ignores unknown fields", () => {
    const wire = tourListWire.parse([
      { id: 3001, name: "Red Dune Desert Safari", languageId: 1, language: "English", categories: [{ id: 4, name: "Desert", url: "desert-safari" }], totalRating: 4.7, totalRatingsCount: 1234, heroImage: { id: 5 }, brandNewField: { x: 1 } },
      { id: 3002, name: null, language: null, categories: null, totalRating: 0, totalRatingsCount: 0 },
    ]);
    expect(wire[0]).not.toHaveProperty("brandNewField");
    expect(tourSummariesFrom(wire)).toEqual([
      { tourId: 3001, name: "Red Dune Desert Safari", categories: [{ id: 4, name: "Desert", slug: "desert-safari" }] },
      { tourId: 3002, name: null, categories: [] },
    ]);
  });

  it("rejects a tour without an integer id", () => {
    expect(tourListWire.safeParse([{ id: "3001" }]).success).toBe(false);
    expect(tourListWire.safeParse([{ id: 1.5 }]).success).toBe(false);
  });
});

describe("tour details", () => {
  const detail = tourDetailFrom(tourDetailsWire.parse(tourDetailsFixture));

  it("normalises the tour header", () => {
    expect(detail).toMatchObject({
      tourId: 3001,
      name: "Red Dune Desert Safari",
      isExternal: false,
      categories: [{ id: 4, name: "Desert", slug: "desert-safari" }],
      cancellationPolicy: [
        { moreThanHours: 24, refundPercent: 100 },
        { moreThanHours: 0, refundPercent: 0 },
      ],
      hasTermsAndConditions: false, // whitespace only
      hasSalesDescription: true,
      faqCount: 1,
      itineraryCount: 0,
      photoCount: 2,
    });
  });

  it("maps bookingType 0/1/2 and flags unknown values instead of guessing", () => {
    expect(detail.offers.map((o) => [o.offerId, o.bookingKind, o.bookingTypeRaw])).toEqual([
      [500, "on_request", 0],
      [501, "live_book", 1],
      [502, "ticket_only", 2],
      [503, "unknown", 7],
    ]);
    expect(detail.warnings).toContain("offer 503: unknown bookingType 7");
    expect(detail.offers[3]).toMatchObject({ privateType: "unknown", timeSlots: [], pricingPeriods: [] });
    expect(detail.offers[2].privateType).toBe("private");
    expect(detail.offers[1].privateType).toBe("sharing");
  });

  it("keeps offer rules and time slot flags", () => {
    const live = detail.offers[1];
    expect(live).toMatchObject({
      tourId: 3001,
      name: "Desert Safari — Sharing",
      code: "DS-SHR",
      daysOffered: 0,
      durationHours: 6,
      minPax: 1,
      maxPax: 40,
      childrenAllowed: true,
      childAge: 12,
      infantsAllowed: true,
      infantAge: 3,
      isDirectReporting: false,
      isDirectCollection: false,
      tripUnit: null,
      minimumAdvancedPaymentRaw: null,
    });
    expect(live.timeSlots).toEqual([
      { timeSlotId: 71, name: "Morning", startMinutes: 570, endMinutes: 810, daysOffered: 127, isAnyTime: false, isOnRequest: false, minimumAdvancedBookingHours: 12, isExternal: false },
    ]);
    expect(detail.offers[0].timeSlots[0].isOnRequest).toBe(true);
    expect(detail.offers[2].timeSlots[0]).toMatchObject({ isAnyTime: true, endMinutes: null, minimumAdvancedBookingHours: null, isExternal: false });
  });

  it("keeps the undocumented slot unit count when sent, and leaves the slot shape unchanged when not (doc 29 Batch 1a)", () => {
    const d = tourDetailFrom(
      tourDetailsWire.parse({ ...tourDetailsFixture, offers: [offer({ timeSlots: [timeSlot({ numberOfUnits: 10 }), timeSlot({ id: 72, numberOfUnits: null })] })] }),
    );
    expect(d.offers[0].timeSlots[0].numberOfUnits).toBe(10);
    expect("numberOfUnits" in d.offers[0].timeSlots[1]).toBe(false);
    expect(tourDetailsWire.safeParse({ ...tourDetailsFixture, offers: [offer({ timeSlots: [timeSlot({ numberOfUnits: "10" })] })] }).success).toBe(false);
  });

  it("AED pricing periods are priced; a null-currency period has price null and a warning", () => {
    const periods = detail.offers[2].pricingPeriods;
    expect(periods[0]).toMatchObject({ periodId: 9100, dateStart: "2026-10-01", dateEnd: "2027-03-31" });
    expect(periods[0].price).toMatchObject({ currency: "AED", perAdultMinor: 18550n, perChildMinor: 15000n, isBookable: false, date: null });
    expect(periods[1]).toEqual({ periodId: 9101, dateStart: "2026-10-01", dateEnd: "2027-03-31", price: null });
    expect(detail.warnings).toContain("pricing period 9101: TravelDesk price currency is missing");
  });

  it("a USD pricing period is also refused, not converted", () => {
    const d = tourDetailFrom(tourDetailsWire.parse({ ...tourDetailsFixture, offers: [offer({ pricingPeriods: [pricingPeriod({ id: 9200, currency: "USD" })] })] }));
    expect(d.offers[0].pricingPeriods[0].price).toBeNull();
    expect(d.warnings).toEqual(["pricing period 9200: TravelDesk price currency is not AED"]);
  });

  it("requires isExternal and the offer's mandatory fields", () => {
    const { isExternal: _x, ...noFlag } = tourDetailsFixture;
    expect(tourDetailsWire.safeParse(noFlag).success).toBe(false);
    expect(tourDetailsWire.safeParse({ ...tourDetailsFixture, offers: [{ ...offer(), bookingType: "LiveBook" }] }).success).toBe(false);
  });
});

describe("offer list", () => {
  it("normalises prices per period with warnings for non-AED", () => {
    const wire = offerListWire.parse([
      { id: 501, name: "Desert Safari — Sharing", tourId: 3001, tourName: "Red Dune Desert Safari", prices: [pricingPeriod(), pricingPeriod({ id: 9002, currency: "EUR" })] },
      { id: 502, name: null, tourId: 3001, tourName: null, prices: null },
    ]);
    const { offers, warnings } = offerSummariesFrom(wire);
    expect(offers).toHaveLength(2);
    expect(offers[0]).toMatchObject({ offerId: 501, tourId: 3001, tourName: "Red Dune Desert Safari" });
    expect(offers[0].pricingPeriods[0].price?.perAdultMinor).toBe(18550n);
    expect(offers[0].pricingPeriods[1].price).toBeNull();
    expect(offers[1]).toEqual({ offerId: 502, tourId: 3001, name: null, tourName: null, pricingPeriods: [] });
    expect(warnings).toEqual(["pricing period 9002: TravelDesk price currency is not AED"]);
  });
});

describe("availability", () => {
  it("AED rows normalise; the date keeps only YYYY-MM-DD", () => {
    const { rows, warnings } = availabilityFrom(availabilityWire.parse([availabilityRow({ date: "2026-10-15T00:00:00" }, { date: "2026-10-15T00:00:00" })]));
    expect(warnings).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date: "2026-10-15", timeSlotId: 71, startMinutes: 960, endMinutes: 1320, seatsLeft: 12 });
    expect(rows[0].price).toMatchObject({ currency: "AED", date: "2026-10-15", isBookable: true, perAdultMinor: 18550n, perTripMinor: 0n, recPerAdultMinor: 25000n, recPerTripMinor: null, vatRaw: 5, conversionRateRaw: 1, supplierCurrencyCode: "AED", roundedFields: [] });
  });

  it("a USD row rejects the whole response", () => {
    const wire = availabilityWire.parse([availabilityRow(), availabilityRow({ id: 2 }, { currency: "USD" })]);
    expect(() => availabilityFrom(wire)).toThrow(TravelDeskCurrencyError);
    try {
      availabilityFrom(wire);
    } catch (e) {
      expect((e as TravelDeskCurrencyError).received).toBe("USD");
    }
  });

  it("a null or absent currency is an error, never assumed AED", () => {
    expect(() => availabilityFrom(availabilityWire.parse([availabilityRow({}, { currency: null })]))).toThrow(/missing/);
    const { currency: _c, ...noCurrency } = offerPrice();
    expect(() => availabilityFrom(availabilityWire.parse([{ availability: availabilityRow().availability, price: noCurrency }]))).toThrow(TravelDeskCurrencyError);
  });

  it("a not-bookable row with no currency is a date with no price in force: dropped and reported, never priced (doc 29 Batch 1a)", () => {
    const { rows, warnings } = availabilityFrom(
      availabilityWire.parse([availabilityRow({ timeSlotId: 0, startTime: 0, endTime: 0, left: 0 }, { currency: null, isBookable: false }), availabilityRow({ id: 2 })]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].timeSlotId).toBe(71);
    expect(warnings).toEqual(["availability row for slot 0 on 2026-11-03: no price in force (not on sale)"]);
    // Only that exact shape is tolerated: a bookable row without a currency, or a non-AED unbookable row, still refuses the read.
    expect(() => availabilityFrom(availabilityWire.parse([availabilityRow({}, { currency: null, isBookable: true })]))).toThrow(TravelDeskCurrencyError);
    expect(() => availabilityFrom(availabilityWire.parse([availabilityRow({}, { currency: "USD", isBookable: false })]))).toThrow(TravelDeskCurrencyError);
  });

  it("lower-case aed is accepted", () => {
    expect(availabilityFrom(availabilityWire.parse([availabilityRow({}, { currency: "aed" })])).rows[0].price.currency).toBe("AED");
  });

  it("drops rows with an unparseable date and reports them", () => {
    const { rows, warnings } = availabilityFrom(
      availabilityWire.parse([availabilityRow({ date: "15/10/2026", timeSlotId: 88 }), availabilityRow({ date: "" , timeSlotId: 89 }), availabilityRow()]),
    );
    expect(rows.map((r) => r.date)).toEqual(["2026-11-03"]);
    expect(warnings).toEqual(["availability row for slot 88: unparseable date", "availability row for slot 89: unparseable date"]);
  });

  it("rejects rows missing seats left or with a non-integer time", () => {
    const row = availabilityRow();
    const { left: _l, ...noLeft } = row.availability;
    expect(availabilityWire.safeParse([{ ...row, availability: noLeft }]).success).toBe(false);
    expect(availabilityWire.safeParse([availabilityRow({ startTime: 9.5 })]).success).toBe(false);
  });
});

describe("ticket stock", () => {
  it("normalises stock and price", () => {
    const stock = ticketStockFrom(
      ticketStockWire.parse({
        stock: { offerId: 502, isAdultTicketRequired: true, adultTicketsLeft: 40, isChildTicketRequired: true, childTicketsLeft: 15, isSameTicketForAdultAndChild: false, validUntil: "2026-12-31T00:00:00" },
        price: offerPrice({ offerId: 502, date: null }),
      }),
    );
    expect(stock).toMatchObject({ offerId: 502, adultTicketRequired: true, adultTicketsLeft: 40, childTicketRequired: true, childTicketsLeft: 15, sameTicketForAdultAndChild: false, validUntil: "2026-12-31" });
    expect(stock.price).toMatchObject({ currency: "AED", date: null, perAdultMinor: 18550n });
  });

  it("a ticket price without CurrencyCode (null currency, USD amounts) is refused", () => {
    const wire = ticketStockWire.parse({
      stock: { offerId: 502, isAdultTicketRequired: true, adultTicketsLeft: 1, isChildTicketRequired: false, childTicketsLeft: 0, isSameTicketForAdultAndChild: true, validUntil: null },
      price: offerPrice({ currency: null }),
    });
    expect(() => ticketStockFrom(wire)).toThrow(TravelDeskCurrencyError);
  });
});

describe("hotels and balance", () => {
  it("hotels for an offer", () => {
    expect(
      hotelsFrom(hotelsWire.parse([
        { id: 10, name: "Atlantis The Palm", regionId: 3, regionName: "Palm Jumeirah", cityId: 1, cityName: "Dubai", extra: true },
        { id: 11, name: null, regionId: null, regionName: null, cityId: 1, cityName: null },
      ])),
    ).toEqual([
      { hotelId: 10, name: "Atlantis The Palm", regionId: 3, regionName: "Palm Jumeirah", cityId: 1, cityName: "Dubai" },
      { hotelId: 11, name: null, regionId: null, regionName: null, cityId: 1, cityName: null },
    ]);
  });

  it("balance in minor units, negatives allowed", () => {
    expect(balanceFrom(balanceWire.parse({ id: 77, balance: 1234.5, creditFacility: 5000, payableBalance: -50.25 }))).toEqual({
      agencyId: 77,
      currencyRequested: "AED",
      balanceMinor: 123450n,
      creditFacilityMinor: 500000n,
      payableBalanceMinor: -5025n,
    });
  });
});

describe("money precision", () => {
  it("rounds >2dp amounts half-up and lists every rounded field", () => {
    const p = netPriceFrom(offerPrice({ pricePerAdult: 123.456, pricePerChildUsd: 0.005, recPricePerTrip: 9.999 }) as Parameters<typeof netPriceFrom>[0]);
    expect(p.perAdultMinor).toBe(12346n);
    expect(p.perChildUsdMinor).toBe(1n);
    expect(p.recPerTripMinor).toBe(1000n);
    expect(p.roundedFields).toEqual(["pricePerAdult", "pricePerChildUsd", "recPricePerTrip"]);
  });

  it("float-hostile values convert exactly", () => {
    const p = netPriceFrom(offerPrice({ pricePerAdult: 0.29, pricePerChild: 1.15, pricePerTrip: 4.35 }) as Parameters<typeof netPriceFrom>[0]);
    expect([p.perAdultMinor, p.perChildMinor, p.perTripMinor]).toEqual([29n, 115n, 435n]);
    expect(p.roundedFields).toEqual([]);
  });

  it("non-finite money fails schema validation", () => {
    expect(availabilityWire.safeParse([availabilityRow({}, { pricePerAdult: Number.POSITIVE_INFINITY })]).success).toBe(false);
    expect(availabilityWire.safeParse([availabilityRow({}, { pricePerAdult: "185.50" })]).success).toBe(false);
  });
});

describe("enums and dates", () => {
  it("bookingKindFrom / privateTypeFrom", () => {
    expect([0, 1, 2, 3, -1, 7].map(bookingKindFrom)).toEqual(["on_request", "live_book", "ticket_only", "unknown", "unknown", "unknown"]);
    expect([0, 1, 2].map(privateTypeFrom)).toEqual(["sharing", "private", "unknown"]);
  });

  it("datePart", () => {
    expect(datePart("2026-10-15T00:00:00")).toBe("2026-10-15");
    expect(datePart("2026-10-15T23:59:59+04:00")).toBe("2026-10-15");
    expect(datePart("2026-10-15")).toBe("2026-10-15");
    expect(datePart(null)).toBeNull();
    expect(datePart(undefined)).toBeNull();
    expect(datePart("")).toBeNull();
    expect(datePart("Oct 15 2026")).toBeNull();
  });

  it("isOfferedOn — DaysOfWeek bit flags, Mon 1 … Sun 64", () => {
    expect(isOfferedOn(0, "2026-10-27")).toBe(true);
    expect(isOfferedOn(127, "2026-10-27")).toBe(true);
    // 2026-10-26 is a Monday, 2026-10-25 a Sunday, 2026-10-27 a Tuesday.
    expect(isOfferedOn(1, "2026-10-26")).toBe(true);
    expect(isOfferedOn(1, "2026-10-27")).toBe(false);
    expect(isOfferedOn(1, "2026-10-25")).toBe(false);
    expect(isOfferedOn(64, "2026-10-25")).toBe(true);
    expect(isOfferedOn(64, "2026-10-26")).toBe(false);
    expect(isOfferedOn(2, "2026-10-27")).toBe(true);
    expect(isOfferedOn(32, "2026-10-31")).toBe(true); // Saturday
    expect(isOfferedOn(1 | 64, "2026-10-28")).toBe(false); // Wednesday
  });

  it("minutesToHhmm / hhmmToMinutes", () => {
    expect(minutesToHhmm(0)).toBe("00:00");
    expect(minutesToHhmm(570)).toBe("09:30");
    expect(minutesToHhmm(960)).toBe("16:00");
    expect(minutesToHhmm(1439)).toBe("23:59");
    expect(hhmmToMinutes("09:30")).toBe(570);
    expect(hhmmToMinutes("00:00")).toBe(0);
    expect(hhmmToMinutes("23:59")).toBe(1439);
    for (const bad of ["9:30", "24:00", "23:60", "0930", "09:30:00", "", "ab:cd"]) expect(hhmmToMinutes(bad), bad).toBeNull();
    for (const m of [0, 1, 570, 961, 1439]) expect(hhmmToMinutes(minutesToHhmm(m))).toBe(m);
  });
});

describe("pax and totals", () => {
  it("seniors are adults; infants stay separate", () => {
    expect(travelDeskPax({ adult: 2, child: 1, infant: 1, senior: 1 })).toEqual({ adults: 3, children: 1, infants: 1 });
    expect(travelDeskPax({ adult: 0, child: 0, infant: 0, senior: 2 })).toEqual({ adults: 2, children: 0, infants: 0 });
  });

  it("netTotalMinor = adults × adult + children × child + per-trip once; infants free", () => {
    const price = { perAdultMinor: 15000n, perChildMinor: 10000n, perTripMinor: 5000n };
    const pax = travelDeskPax({ adult: 2, child: 1, infant: 2, senior: 1 });
    expect(netTotalMinor(price, pax)).toBe(3n * 15000n + 10000n + 5000n);
    expect(netTotalMinor(price, { adults: 0, children: 0 })).toBe(5000n);
    expect(netTotalMinor({ perAdultMinor: 18550n, perChildMinor: 15000n, perTripMinor: 0n }, { adults: 2, children: 0 })).toBe(37100n);
  });
});
