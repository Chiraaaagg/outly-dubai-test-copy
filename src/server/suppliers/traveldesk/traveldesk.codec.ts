import { z } from "zod";
import { decimalToMinor } from "../../domain/decimal";

/**
 * TravelDesk wire schemas (read DTOs only) and their normalised OUTLY shapes.
 *
 * Schema policy (plan §12, Kestrel K-36):
 *  - Validate the fields OUTLY reads; ignore unknown fields (TravelDesk may add
 *    some). Nullable where the spec says nullable.
 *  - Enums arrive as integers. Unknown values map to "unknown", never to a
 *    guessed meaning, so a new booking type cannot be treated as bookable.
 *  - Money arrives as JSON doubles. It is converted with `decimalToMinor`
 *    (string-exact, half-up to 2 dp) and every price must say "AED".
 *  - Dates arrive as date-time strings; only the YYYY-MM-DD part is kept.
 *
 * Spec line numbers refer to traveldesk_api_spec.json (4,892 lines).
 */

/* ---------------------------------------------------------------------------
 * Shared pieces
 * ------------------------------------------------------------------------ */

const num = z.number().finite();
const int = z.number().int();
const str = z.string();
const nstr = z.string().nullable().optional();
const nnum = z.number().finite().nullable().optional();
const nint = z.number().int().nullable().optional();

const categoryWire = z.object({ id: int, name: nstr, url: nstr });

/** CancellationPolicy (L4227): `{hours: "If more than specified number of hours", percents: refund percent}`. */
const cancellationRuleWire = z.object({ hours: int, percents: int });

/** OfferPrice (L4401) — also the base of OfferPricingPeriod (L4568). */
const offerPriceWire = z.object({
  offerId: int,
  currency: nstr,
  recPricePerAdult: nnum,
  recPricePerChild: nnum,
  recPricePerTrip: nnum,
  pricePerAdult: num,
  pricePerChild: num,
  pricePerTrip: num,
  pricePerAdultUsd: num,
  pricePerChildUsd: num,
  pricePerTripUsd: num,
  discountPercent: nnum,
  hasDiscount: z.boolean().optional(),
  isBookable: z.boolean(),
  supplierCurrencyCode: nstr,
  conversionRate: nnum,
  vat: nnum,
  date: nstr,
});

const pricingPeriodWire = offerPriceWire.extend({
  id: int,
  dateStart: nstr,
  dateEnd: nstr,
  // Spec marks `date` and `isBookable` on the base type; periods may omit them.
  isBookable: z.boolean().optional(),
});

/**
 * The undocumented slot unit count as kept on the slot: absent when not sent
 * (or null), the number when it is a whole number, else 0, a value the
 * capability derivation never accepts (it flags anything but 1 as
 * `slot_units_unexplained`).
 */
export function slotUnitsFrom(v: unknown): { numberOfUnits?: number } {
  if (v === undefined || v === null) return {};
  return { numberOfUnits: typeof v === "number" && Number.isSafeInteger(v) ? v : 0 };
}

/** TimeSlotPublicDto (L3654). */
const timeSlotWire = z.object({
  id: int,
  name: nstr,
  startTime: int,
  endTime: nint,
  daysOffered: int,
  isAnyTime: z.boolean(),
  isOnRequest: z.boolean(),
  minimumAdvancedBooking: nint,
  isExternal: z.boolean().optional(),
  // Not in the spec; sent on a few offers only (1 or 10, 22 Nov 2026). Meaning unknown (doc 29 §8.2 Q7).
  // Any shape is accepted so an odd value never fails the tour parse (review R10); `slotUnitsFrom` keeps it for review.
  numberOfUnits: z.unknown().optional(),
});

/** Offer (L3504). */
const offerWire = z.object({
  id: int,
  name: nstr,
  code: nstr,
  daysOffered: int,
  numberOfHours: int,
  minNumOfPeople: int,
  maxNumOfPeople: int,
  // Not in the spec, but returned by the test API (observed 27 Oct 2026): per-category limits.
  minNumberOfAdult: nint,
  maxNumberOfAdult: nint,
  minNumberOfChild: nint,
  maxNumberOfChild: nint,
  minNumberOfInfant: nint,
  maxNumberOfInfant: nint,
  minimumAdvancedPayment: nint,
  privateType: int,
  childrenAllowed: z.boolean(),
  childAge: int,
  infantsAllowed: z.boolean(),
  infantAge: int,
  pricingPeriods: z.array(pricingPeriodWire).nullable().optional(),
  isDirectReporting: z.boolean(),
  isDirectCollection: z.boolean().optional(),
  description: nstr,
  timeSlots: z.array(timeSlotWire).nullable().optional(),
  bookingType: int,
  isExternal: z.boolean(),
  tripUnit: nstr,
});

/* ---------------------------------------------------------------------------
 * Response schemas
 * ------------------------------------------------------------------------ */

/** TourList (L3855) — GET /tours. */
export const tourListWire = z.array(
  z.object({
    id: int,
    name: nstr,
    languageId: int.optional(),
    language: nstr,
    categories: z.array(categoryWire).nullable().optional(),
    totalRating: nnum,
    totalRatingsCount: nnum,
  }),
);

/** TourDetails (L3709) — GET /tours/{Id}. */
export const tourDetailsWire = z.object({
  id: int,
  name: nstr,
  languageId: int.optional(),
  language: nstr,
  offers: z.array(offerWire).nullable().optional(),
  termsAndConditions: nstr,
  salesDescription: nstr,
  cancellationPolicy: z.array(cancellationRuleWire).nullable().optional(),
  categories: z.array(categoryWire).nullable().optional(),
  faqList: z.array(z.unknown()).nullable().optional(),
  itineraries: z.array(z.unknown()).nullable().optional(),
  photos: z.array(z.unknown()).nullable().optional(),
  isExternal: z.boolean(),
  videoUrl: nstr,
});

/** OfferList (L3619) — GET /offers. */
export const offerListWire = z.array(
  z.object({
    id: int,
    name: nstr,
    tourId: int,
    tourName: nstr,
    prices: z.array(pricingPeriodWire).nullable().optional(),
  }),
);

/** AvailabilityWithPricesDto[] (L3491) — GET /availability/byoffer. */
export const availabilityWire = z.array(
  z.object({
    availability: z.object({
      id: int.optional(),
      date: str,
      startTime: int,
      endTime: int,
      timeSlotId: int,
      left: int,
    }),
    price: offerPriceWire,
  }),
);

/** OfferTicketsStockWithPriceDto (L4005) — GET /tickets/byoffer. */
export const ticketStockWire = z.object({
  stock: z.object({
    offerId: int,
    isAdultTicketRequired: z.boolean(),
    adultTicketsLeft: int,
    isChildTicketRequired: z.boolean(),
    childTicketsLeft: int,
    isSameTicketForAdultAndChild: z.boolean(),
    validUntil: nstr,
  }),
  price: offerPriceWire,
});

/** HotelBaseDto[] (L3929) — GET /hotels/foroffer. */
export const hotelsWire = z.array(
  z.object({ id: int, name: nstr, regionId: nint, regionName: nstr, cityId: int, cityName: nstr }),
);

/** TourCategoryDto[] (L4057) — GET /tourscategories. */
export const categoriesWire = z.array(categoryWire);

/** AgencyBalance (L4199) — GET /balance. */
export const balanceWire = z.object({ id: int, balance: num, creditFacility: num, payableBalance: num });

/* ---------------------------------------------------------------------------
 * Normalised shapes
 * ------------------------------------------------------------------------ */

export type TravelDeskBookingKind = "on_request" | "live_book" | "ticket_only" | "unknown";
export type TravelDeskPrivateType = "sharing" | "private" | "unknown";

/** OfferBookingType (L4129): 0 OnRequest, 1 LiveBook, 2 TicketOnly. */
export function bookingKindFrom(raw: number): TravelDeskBookingKind {
  if (raw === 0) return "on_request";
  if (raw === 1) return "live_book";
  if (raw === 2) return "ticket_only";
  return "unknown";
}

/** OfferPrivateType (L4144): 0 Sharing, 1 Private. */
export function privateTypeFrom(raw: number): TravelDeskPrivateType {
  if (raw === 0) return "sharing";
  if (raw === 1) return "private";
  return "unknown";
}

const ISO_DATE = /^(\d{4}-\d{2}-\d{2})/;

/** "2026-10-15T00:00:00" → "2026-10-15". The time part is never trusted (HTML §Conventions). */
export function datePart(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = ISO_DATE.exec(value);
  return m ? m[1] : null;
}

/** 570 → "09:30". */
export function minutesToHhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "09:30" → 570; null when malformed. */
export function hhmmToMinutes(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** DaysOfWeek bit flags (L1987; HTML: Mon 1 … Sun 64, 0 and 127 both mean every day). */
export function isOfferedOn(daysOffered: number, isoDate: string): boolean {
  if (daysOffered === 0 || (daysOffered & 127) === 127) return true;
  const d = new Date(`${isoDate}T00:00:00Z`);
  const jsDay = d.getUTCDay(); // 0 Sunday … 6 Saturday; the date is a calendar date, not an instant
  const bit = jsDay === 0 ? 64 : 1 << (jsDay - 1);
  return (daysOffered & bit) !== 0;
}

export interface TravelDeskNetPrice {
  currency: "AED";
  date: string | null;
  isBookable: boolean;
  perAdultMinor: bigint;
  perChildMinor: bigint;
  perTripMinor: bigint;
  perAdultUsdMinor: bigint;
  perChildUsdMinor: bigint;
  perTripUsdMinor: bigint;
  /** Recommended retail, "for reference" (L4415). Never charged, never shown as OUTLY's price. */
  recPerAdultMinor: bigint | null;
  recPerChildMinor: bigint | null;
  recPerTripMinor: bigint | null;
  hasDiscount: boolean;
  /** Raw, undocumented fields kept for the Q-C3 / Q-C4 investigation. Never used in arithmetic. */
  vatRaw: number | null;
  conversionRateRaw: number | null;
  supplierCurrencyCode: string | null;
  /** Field names whose value had more than 2 decimals and was rounded. */
  roundedFields: string[];
}

export class TravelDeskCurrencyError extends Error {
  constructor(readonly received: string | null) {
    super(`TravelDesk price currency is ${received === null ? "missing" : "not AED"}`);
    this.name = "TravelDeskCurrencyError";
  }
}

function minorOf(field: string, value: number, rounded: string[]): bigint {
  const r = decimalToMinor(value);
  if (r.rounded) rounded.push(field);
  return r.minor;
}

/**
 * Normalise an OfferPrice. Throws `TravelDeskCurrencyError` unless the price
 * says AED: an unsupported or missing CurrencyCode silently returns USD
 * amounts (HTML §Conventions; L1076), which would under-read cost 3.67×.
 */
export function netPriceFrom(wire: z.infer<typeof offerPriceWire>): TravelDeskNetPrice {
  const currency = wire.currency ?? null;
  if (currency === null || currency.toUpperCase() !== "AED") throw new TravelDeskCurrencyError(currency);
  const rounded: string[] = [];
  const rec = (field: string, v: number | null | undefined) => (v === null || v === undefined ? null : minorOf(field, v, rounded));
  return {
    currency: "AED",
    date: datePart(wire.date),
    isBookable: wire.isBookable ?? false,
    perAdultMinor: minorOf("pricePerAdult", wire.pricePerAdult, rounded),
    perChildMinor: minorOf("pricePerChild", wire.pricePerChild, rounded),
    perTripMinor: minorOf("pricePerTrip", wire.pricePerTrip, rounded),
    perAdultUsdMinor: minorOf("pricePerAdultUsd", wire.pricePerAdultUsd, rounded),
    perChildUsdMinor: minorOf("pricePerChildUsd", wire.pricePerChildUsd, rounded),
    perTripUsdMinor: minorOf("pricePerTripUsd", wire.pricePerTripUsd, rounded),
    recPerAdultMinor: rec("recPricePerAdult", wire.recPricePerAdult),
    recPerChildMinor: rec("recPricePerChild", wire.recPricePerChild),
    recPerTripMinor: rec("recPricePerTrip", wire.recPricePerTrip),
    hasDiscount: wire.hasDiscount ?? false,
    vatRaw: wire.vat ?? null,
    conversionRateRaw: wire.conversionRate ?? null,
    supplierCurrencyCode: wire.supplierCurrencyCode ?? null,
    roundedFields: rounded,
  };
}

export interface TravelDeskTimeSlot {
  timeSlotId: number;
  name: string | null;
  startMinutes: number;
  endMinutes: number | null;
  daysOffered: number;
  isAnyTime: boolean;
  isOnRequest: boolean;
  minimumAdvancedBookingHours: number | null;
  isExternal: boolean;
  /**
   * Undocumented slot unit count, kept as received. Absent when TravelDesk does
   * not send it, so payloads of offers without it hash as before. Never used
   * as a capacity: the capability derivation flags any value but 1 for review.
   * A value sent that is not a whole number is kept as 0 (`slotUnitsFrom`),
   * so it is flagged too rather than failing the parse.
   */
  numberOfUnits?: number;
}

export interface TravelDeskPricingPeriod {
  periodId: number;
  dateStart: string | null;
  dateEnd: string | null;
  /** Null when the period's currency is not AED; then it must not be used. */
  price: TravelDeskNetPrice | null;
}

export interface TravelDeskOffer {
  offerId: number;
  tourId: number;
  name: string | null;
  code: string | null;
  bookingKind: TravelDeskBookingKind;
  bookingTypeRaw: number;
  daysOffered: number;
  durationHours: number;
  minPax: number;
  maxPax: number;
  /** Per-category limits, when TravelDesk sends them (undocumented fields; null when absent). */
  paxLimits: { adults: [number | null, number | null]; children: [number | null, number | null]; infants: [number | null, number | null] };
  privateType: TravelDeskPrivateType;
  childrenAllowed: boolean;
  childAge: number;
  infantsAllowed: boolean;
  infantAge: number;
  isDirectReporting: boolean;
  isDirectCollection: boolean;
  isExternal: boolean;
  tripUnit: string | null;
  minimumAdvancedPaymentRaw: number | null;
  timeSlots: TravelDeskTimeSlot[];
  pricingPeriods: TravelDeskPricingPeriod[];
}

export interface TravelDeskCancellationRule {
  /** "If more than specified number of hours" — reference point undocumented (Q-K1). */
  moreThanHours: number;
  refundPercent: number;
}

export interface TravelDeskTourSummary {
  tourId: number;
  name: string | null;
  categories: { id: number; name: string | null; slug: string | null }[];
}

export interface TravelDeskTourDetail extends TravelDeskTourSummary {
  isExternal: boolean;
  offers: TravelDeskOffer[];
  cancellationPolicy: TravelDeskCancellationRule[];
  hasTermsAndConditions: boolean;
  hasSalesDescription: boolean;
  faqCount: number;
  itineraryCount: number;
  photoCount: number;
  warnings: string[];
}

function categoriesFrom(list: z.infer<typeof categoryWire>[] | null | undefined) {
  return (list ?? []).map((c) => ({ id: c.id, name: c.name ?? null, slug: c.url ?? null }));
}

function periodFrom(p: z.infer<typeof pricingPeriodWire>, warnings: string[]): TravelDeskPricingPeriod {
  let price: TravelDeskNetPrice | null = null;
  try {
    price = netPriceFrom({ ...p, isBookable: p.isBookable ?? false });
  } catch (e) {
    if (e instanceof TravelDeskCurrencyError) warnings.push(`pricing period ${p.id}: ${e.message}`);
    else throw e;
  }
  return { periodId: p.id, dateStart: datePart(p.dateStart), dateEnd: datePart(p.dateEnd), price };
}

export function offerFrom(tourId: number, o: z.infer<typeof offerWire>, warnings: string[]): TravelDeskOffer {
  const kind = bookingKindFrom(o.bookingType);
  if (kind === "unknown") warnings.push(`offer ${o.id}: unknown bookingType ${o.bookingType}`);
  return {
    offerId: o.id,
    tourId,
    name: o.name ?? null,
    code: o.code ?? null,
    bookingKind: kind,
    bookingTypeRaw: o.bookingType,
    daysOffered: o.daysOffered,
    durationHours: o.numberOfHours,
    minPax: o.minNumOfPeople,
    maxPax: o.maxNumOfPeople,
    paxLimits: {
      adults: [o.minNumberOfAdult ?? null, o.maxNumberOfAdult ?? null],
      children: [o.minNumberOfChild ?? null, o.maxNumberOfChild ?? null],
      infants: [o.minNumberOfInfant ?? null, o.maxNumberOfInfant ?? null],
    },
    privateType: privateTypeFrom(o.privateType),
    childrenAllowed: o.childrenAllowed,
    childAge: o.childAge,
    infantsAllowed: o.infantsAllowed,
    infantAge: o.infantAge,
    isDirectReporting: o.isDirectReporting,
    isDirectCollection: o.isDirectCollection ?? false,
    isExternal: o.isExternal,
    // The API sends "" as well as null for "no unit" (observed).
    tripUnit: o.tripUnit?.trim() ? o.tripUnit.trim() : null,
    minimumAdvancedPaymentRaw: o.minimumAdvancedPayment ?? null,
    // A slot id can repeat with different start times (observed on an isAnyTime
    // private offer: 4 ids × 9 start times). Identity is (timeSlotId, startMinutes).
    timeSlots: (o.timeSlots ?? []).map((t) => ({
      timeSlotId: t.id,
      name: t.name ?? null,
      startMinutes: t.startTime,
      endMinutes: t.endTime ?? null,
      daysOffered: t.daysOffered,
      isAnyTime: t.isAnyTime,
      isOnRequest: t.isOnRequest,
      minimumAdvancedBookingHours: t.minimumAdvancedBooking ?? null,
      isExternal: t.isExternal ?? false,
      ...slotUnitsFrom(t.numberOfUnits),
    })),
    pricingPeriods: (o.pricingPeriods ?? []).map((p) => periodFrom(p, warnings)),
  };
}

export function tourSummariesFrom(wire: z.infer<typeof tourListWire>): TravelDeskTourSummary[] {
  return wire.map((t) => ({ tourId: t.id, name: t.name ?? null, categories: categoriesFrom(t.categories) }));
}

export function tourDetailFrom(wire: z.infer<typeof tourDetailsWire>): TravelDeskTourDetail {
  const warnings: string[] = [];
  return {
    tourId: wire.id,
    name: wire.name ?? null,
    categories: categoriesFrom(wire.categories),
    isExternal: wire.isExternal,
    offers: (wire.offers ?? []).map((o) => offerFrom(wire.id, o, warnings)),
    cancellationPolicy: (wire.cancellationPolicy ?? []).map((r) => ({ moreThanHours: r.hours, refundPercent: r.percents })),
    hasTermsAndConditions: Boolean(wire.termsAndConditions && wire.termsAndConditions.trim()),
    hasSalesDescription: Boolean(wire.salesDescription && wire.salesDescription.trim()),
    faqCount: wire.faqList?.length ?? 0,
    itineraryCount: wire.itineraries?.length ?? 0,
    photoCount: wire.photos?.length ?? 0,
    warnings,
  };
}

export interface TravelDeskOfferSummary {
  offerId: number;
  tourId: number;
  name: string | null;
  tourName: string | null;
  pricingPeriods: TravelDeskPricingPeriod[];
}

export function offerSummariesFrom(wire: z.infer<typeof offerListWire>): { offers: TravelDeskOfferSummary[]; warnings: string[] } {
  const warnings: string[] = [];
  const offers = wire.map((o) => ({
    offerId: o.id,
    tourId: o.tourId,
    name: o.name ?? null,
    tourName: o.tourName ?? null,
    pricingPeriods: (o.prices ?? []).map((p) => periodFrom(p, warnings)),
  }));
  return { offers, warnings };
}

export interface TravelDeskAvailabilityRow {
  date: string;
  timeSlotId: number;
  startMinutes: number;
  endMinutes: number;
  /** "Seats left total. Number of adults + children can't exceed this value" (L3482). */
  seatsLeft: number;
  price: TravelDeskNetPrice;
}

/**
 * Throws TravelDeskCurrencyError if any row is not priced in AED. Rows with an
 * unparseable date are dropped and reported.
 *
 * One tolerance (doc 29 §7.3 Batch 1a): a row that is not bookable and carries
 * no currency at all is a date with no price in force (observed on date-only
 * offers, 22 Nov 2026). It is dropped and reported, so the date reads as not
 * on sale instead of failing the whole read. A bookable row without a
 * currency, and any row in another currency, still throws.
 */
export function availabilityFrom(wire: z.infer<typeof availabilityWire>): { rows: TravelDeskAvailabilityRow[]; warnings: string[] } {
  const warnings: string[] = [];
  const rows: TravelDeskAvailabilityRow[] = [];
  for (const r of wire) {
    const date = datePart(r.availability.date);
    if (!date) {
      warnings.push(`availability row for slot ${r.availability.timeSlotId}: unparseable date`);
      continue;
    }
    if ((r.price.currency === null || r.price.currency === undefined) && r.price.isBookable === false) {
      warnings.push(`availability row for slot ${r.availability.timeSlotId} on ${date}: no price in force (not on sale)`);
      continue;
    }
    rows.push({
      date,
      timeSlotId: r.availability.timeSlotId,
      startMinutes: r.availability.startTime,
      endMinutes: r.availability.endTime,
      seatsLeft: r.availability.left,
      price: netPriceFrom(r.price),
    });
  }
  return { rows, warnings };
}

export interface TravelDeskTicketStock {
  offerId: number;
  adultTicketRequired: boolean;
  adultTicketsLeft: number;
  childTicketRequired: boolean;
  childTicketsLeft: number;
  sameTicketForAdultAndChild: boolean;
  /** Earliest expiry among tickets in stock. */
  validUntil: string | null;
  price: TravelDeskNetPrice;
}

export function ticketStockFrom(wire: z.infer<typeof ticketStockWire>): TravelDeskTicketStock {
  return {
    offerId: wire.stock.offerId,
    adultTicketRequired: wire.stock.isAdultTicketRequired,
    adultTicketsLeft: wire.stock.adultTicketsLeft,
    childTicketRequired: wire.stock.isChildTicketRequired,
    childTicketsLeft: wire.stock.childTicketsLeft,
    sameTicketForAdultAndChild: wire.stock.isSameTicketForAdultAndChild,
    validUntil: datePart(wire.stock.validUntil),
    price: netPriceFrom(wire.price),
  };
}

export interface TravelDeskHotel {
  hotelId: number;
  name: string | null;
  regionId: number | null;
  regionName: string | null;
  cityId: number;
  cityName: string | null;
}

export function hotelsFrom(wire: z.infer<typeof hotelsWire>): TravelDeskHotel[] {
  return wire.map((h) => ({
    hotelId: h.id,
    name: h.name ?? null,
    regionId: h.regionId ?? null,
    regionName: h.regionName ?? null,
    cityId: h.cityId,
    cityName: h.cityName ?? null,
  }));
}

export interface TravelDeskBalance {
  agencyId: number;
  /** In the currency requested with CurrencyCode. The balance's own currency is undocumented (Q-C1). */
  currencyRequested: "AED";
  balanceMinor: bigint;
  creditFacilityMinor: bigint;
  payableBalanceMinor: bigint;
}

export function balanceFrom(wire: z.infer<typeof balanceWire>): TravelDeskBalance {
  return {
    agencyId: wire.id,
    currencyRequested: "AED",
    balanceMinor: decimalToMinor(wire.balance).minor,
    creditFacilityMinor: decimalToMinor(wire.creditFacility).minor,
    payableBalanceMinor: decimalToMinor(wire.payableBalance).minor,
  };
}

/** Pax as TravelDesk counts them. OUTLY seniors are adults; there is no senior category (L1410–L1424). */
export function travelDeskPax(pax: { adult: number; child: number; infant: number; senior: number }) {
  return { adults: pax.adult + pax.senior, children: pax.child, infants: pax.infant };
}

/**
 * Net total for a pax mix: adults × adult + children × child + per-trip; infants free
 * (HTML §Booking). Integer arithmetic only.
 */
export function netTotalMinor(price: Pick<TravelDeskNetPrice, "perAdultMinor" | "perChildMinor" | "perTripMinor">, pax: { adults: number; children: number }): bigint {
  return BigInt(pax.adults) * price.perAdultMinor + BigInt(pax.children) * price.perChildMinor + price.perTripMinor;
}
