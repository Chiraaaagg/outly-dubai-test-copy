import type { TravelDeskAvailabilityRow, TravelDeskHotel, TravelDeskNetPrice, TravelDeskTicketStock } from "../../traveldesk/traveldesk.codec";

/**
 * Synthetic TravelDesk catalogue payloads and fresh answers for the quote and
 * offer-terms tests. Prices are invented round numbers, not supplier rates.
 * `storedOffer` / `storedTour` are shaped like what the catalogue sync stores
 * (bigints as decimal strings, supplier-catalog.service.ts `toJson`).
 */

export const SERVICE_DATE = "2026-11-12"; // a Thursday
export const THURSDAY = 8; // DaysOfWeek bit: Mon 1 … Sun 64

type Json = Record<string, unknown>;

export function storedSlot(over: Json = {}): Json {
  return {
    timeSlotId: 11,
    name: null,
    startMinutes: 1260,
    endMinutes: 1365,
    daysOffered: 0,
    isAnyTime: false,
    isOnRequest: false,
    minimumAdvancedBookingHours: 12,
    isExternal: false,
    ...over,
  };
}

export function storedOffer(over: Json = {}): Json {
  return {
    offerId: 501,
    tourId: 3001,
    name: "Synthetic evening cruise",
    code: null,
    bookingKind: "live_book",
    bookingTypeRaw: 1,
    daysOffered: 0,
    durationHours: 2,
    minPax: 1,
    maxPax: 20,
    paxLimits: { adults: [null, null], children: [null, null], infants: [null, null] },
    privateType: "sharing",
    childrenAllowed: true,
    childAge: 12,
    infantsAllowed: true,
    infantAge: 3,
    isDirectReporting: true,
    isDirectCollection: false,
    isExternal: false,
    tripUnit: null,
    minimumAdvancedPaymentRaw: null,
    timeSlots: [storedSlot()],
    pricingPeriods: [{ periodId: 1, dateStart: "2026-01-01", dateEnd: null, price: { currency: "AED", perAdultMinor: "10000", perChildMinor: "6000", perTripMinor: "0" } }],
    ...over,
  };
}

export function storedTour(over: Json = {}): Json {
  return {
    tourId: 3001,
    name: "Synthetic cruise tour",
    categories: [],
    isExternal: false,
    cancellationPolicy: [
      { moreThanHours: 24, refundPercent: 50 },
      { moreThanHours: 72, refundPercent: 100 },
    ],
    hasTermsAndConditions: true,
    hasSalesDescription: true,
    faqCount: 0,
    itineraryCount: 0,
    photoCount: 0,
    ...over,
  };
}

export function netPrice(over: Partial<TravelDeskNetPrice> = {}): TravelDeskNetPrice {
  return {
    currency: "AED",
    date: SERVICE_DATE,
    isBookable: true,
    perAdultMinor: 10_000n,
    perChildMinor: 6_000n,
    perTripMinor: 0n,
    perAdultUsdMinor: 2_700n,
    perChildUsdMinor: 1_600n,
    perTripUsdMinor: 0n,
    recPerAdultMinor: null,
    recPerChildMinor: null,
    recPerTripMinor: null,
    hasDiscount: false,
    vatRaw: null,
    conversionRateRaw: null,
    supplierCurrencyCode: null,
    roundedFields: [],
    ...over,
  };
}

export function row(over: Partial<Omit<TravelDeskAvailabilityRow, "price">> & { price?: Partial<TravelDeskNetPrice> } = {}): TravelDeskAvailabilityRow {
  const { price, ...rest } = over;
  return { date: SERVICE_DATE, timeSlotId: 11, startMinutes: 1260, endMinutes: 1365, seatsLeft: 30, price: netPrice(price), ...rest };
}

export function ticketStock(over: Partial<Omit<TravelDeskTicketStock, "price">> & { price?: Partial<TravelDeskNetPrice> } = {}): TravelDeskTicketStock {
  const { price, ...rest } = over;
  return {
    offerId: 502,
    adultTicketRequired: true,
    adultTicketsLeft: 40,
    childTicketRequired: true,
    childTicketsLeft: 25,
    sameTicketForAdultAndChild: false,
    validUntil: "2027-12-31",
    // TicketOnly prices are dated the purchase day: the tests' NOW, 1 Nov 2026 in Dubai.
    price: netPrice({ date: "2026-11-01", ...price }),
    ...rest,
  };
}

/** `GET /hotels/foroffer` for an offer that collects from hotels (synthetic ids and names). */
export function pickupHotels(): TravelDeskHotel[] {
  return [
    { hotelId: 42, name: "Example Marina Hotel", regionId: 3, regionName: "Dubai Marina", cityId: 1, cityName: "Dubai" },
    { hotelId: 43, name: "Example Creek Hotel", regionId: 4, regionName: "Deira", cityId: 1, cityName: "Dubai" },
  ];
}
