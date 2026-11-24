import {
  availabilityFrom,
  availabilityWire,
  balanceFrom,
  balanceWire,
  categoriesWire,
  hotelsFrom,
  hotelsWire,
  offerListWire,
  offerSummariesFrom,
  ticketStockFrom,
  ticketStockWire,
  tourDetailFrom,
  tourDetailsWire,
  tourListWire,
  tourSummariesFrom,
  TravelDeskCurrencyError,
} from "./traveldesk.codec";
import type { TravelDeskConfig } from "./traveldesk.config";
import { TravelDeskApiError, TravelDeskHttp, type TravelDeskHttpOptions } from "./traveldesk.http";

/**
 * TravelDesk read API — every GET OUTLY uses in Stage 1, one method each.
 *
 * Paths are the spec paths without the /public/b2b/v1 prefix (the base URL
 * carries it). CurrencyCode=AED is sent wherever the endpoint accepts it:
 * `tickets/byoffer` answers in USD with a null currency otherwise (L1076).
 * `/offers` takes no currency and is documented as always AED.
 *
 * No method here creates, changes or cancels anything.
 */

/** UAE (HTML §Tours and offers). Qatar 17, Oman 7, Saudi Arabia 69. */
export const TRAVELDESK_COUNTRY_UAE = 50;
/** External offers: "ask for at most 7 days at a time" (HTML §Tours and offers). */
export const TRAVELDESK_EXTERNAL_MAX_DAYS = 7;
/** Internal offers: no documented limit (Q-A1). Conservative until verified. */
export const TRAVELDESK_INTERNAL_MAX_DAYS = 31;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: string, label: string): void {
  const ms = Date.parse(`${value}T00:00:00Z`);
  // Round-trip so 2026-02-30 (which Date.parse rolls to 2 March) is rejected.
  if (!ISO_DATE.test(value) || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new Error(`TravelDesk ${label} must be YYYY-MM-DD`);
  }
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function assertPositiveId(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error(`TravelDesk ${label} must be a positive int32`);
}

/** Re-throw a currency failure as a TravelDesk invalid response, so callers handle one error type. */
function guardCurrency<T>(operation: string, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof TravelDeskCurrencyError) {
      throw new TravelDeskApiError("invalid_response", operation, { message: `TravelDesk ${operation}: ${e.message}` });
    }
    throw e;
  }
}

export class TravelDeskReadClient {
  private readonly http: TravelDeskHttp;

  constructor(config: TravelDeskConfig, opts: TravelDeskHttpOptions = {}) {
    this.http = new TravelDeskHttp(config, opts);
  }

  get environment() {
    return this.http.environment;
  }

  async getBalance() {
    const wire = await this.http.getJson("balance", "/balance", "/balance", { CurrencyCode: "AED" }, balanceWire);
    return balanceFrom(wire);
  }

  async listCategories(language?: string) {
    return this.http.getJson("tourscategories", "/tourscategories", "/tourscategories", { Language: language }, categoriesWire);
  }

  async listTours(countryId = TRAVELDESK_COUNTRY_UAE) {
    assertPositiveId(countryId, "CountryId");
    const wire = await this.http.getJson("tours.list", "/tours", "/tours", { CountryId: countryId, CurrencyCode: "AED" }, tourListWire);
    return tourSummariesFrom(wire);
  }

  async getTour(tourId: number) {
    assertPositiveId(tourId, "tour id");
    const wire = await this.http.getJson("tours.get", "/tours/{Id}", `/tours/${tourId}`, { CurrencyCode: "AED" }, tourDetailsWire);
    return tourDetailFrom(wire);
  }

  async listOffers(countryId = TRAVELDESK_COUNTRY_UAE) {
    assertPositiveId(countryId, "CountryId");
    const wire = await this.http.getJson("offers.list", "/offers", "/offers", { IncludePrices: true, CountryId: countryId }, offerListWire);
    return offerSummariesFrom(wire);
  }

  /**
   * Availability with date-specific net prices. Dates are sent as plain
   * YYYY-MM-DD: "a time breaks availability matching" (HTML §Conventions).
   */
  async getAvailability(offerId: number, from: string, to: string, opts: { isExternal: boolean }) {
    assertPositiveId(offerId, "offer id");
    assertIsoDate(from, "From");
    assertIsoDate(to, "To");
    const span = daysBetween(from, to);
    const max = opts.isExternal ? TRAVELDESK_EXTERNAL_MAX_DAYS : TRAVELDESK_INTERNAL_MAX_DAYS;
    if (span < 0) throw new Error("TravelDesk availability: To is before From");
    if (span + 1 > max) throw new Error(`TravelDesk availability: at most ${max} days per request`);
    const wire = await this.http.getJson(
      "availability.byoffer",
      "/availability/byoffer",
      "/availability/byoffer",
      { Id: offerId, From: from, To: to, CurrencyCode: "AED" },
      availabilityWire,
    );
    return guardCurrency("availability.byoffer", () => availabilityFrom(wire));
  }

  /** TicketOnly stock and price. CurrencyCode is mandatory in practice (L1076). */
  async getTicketStock(offerId: number) {
    assertPositiveId(offerId, "offer id");
    const wire = await this.http.getJson(
      "tickets.byoffer",
      "/tickets/byoffer",
      "/tickets/byoffer",
      { Id: offerId, CurrencyCode: "AED" },
      ticketStockWire,
    );
    return guardCurrency("tickets.byoffer", () => ticketStockFrom(wire));
  }

  async listPickupHotels(offerId: number) {
    assertPositiveId(offerId, "offer id");
    const wire = await this.http.getJson("hotels.foroffer", "/hotels/foroffer", "/hotels/foroffer", { OfferId: offerId }, hotelsWire);
    return hotelsFrom(wire);
  }
}
