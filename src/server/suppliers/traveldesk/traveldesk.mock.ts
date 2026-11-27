import { Errors } from "../../lib/errors";
import {
  SupplierError,
  type AvailabilityRequest,
  type AvailabilityResult,
  type BookingRequest,
  type BookingResult,
  type CancelResult,
  type LookupResult,
  type SupplierCapabilities,
  type SupplierPort,
} from "../port";
import { TRAVELDESK_CAPABILITIES, travelDeskExternalRefSchema } from "./traveldesk.adapter";

/**
 * TravelDeskMockAdapter — what `SUPPLIER_ADAPTER_TRAVELDESK=mock` (the default)
 * hands out. Deterministic, network-free, and always labelled `source: "mock"`
 * so nothing downstream can mistake it for supplier data.
 *
 * Availability: a valid mapping is "available" except on the 7th, 14th, 21st
 * and 28th of a month ("sold_out") — enough to exercise both UI states.
 * Booking refuses exactly like the live adapter in Stage 1: a mock must not
 * pretend a capability OUTLY does not have yet.
 */
export class TravelDeskMockAdapter implements SupplierPort {
  readonly name = "traveldesk-mock";

  constructor(private readonly now: () => Date = () => new Date()) {}

  capabilities(): SupplierCapabilities {
    return TRAVELDESK_CAPABILITIES;
  }

  async checkAvailability(req: AvailabilityRequest): Promise<AvailabilityResult> {
    const ref = travelDeskExternalRefSchema.safeParse(req.mapping.externalRef);
    if (!ref.success) {
      throw new SupplierError("error", this.name, { message: "Supplier mapping is incomplete", details: { reason: "invalid_mapping" } });
    }
    const checkedAt = this.now().toISOString();
    if (ref.data.bookingKind === "on_request" || ref.data.bookingKind === "unknown") {
      return { status: "quote_only", spotsLeft: null, slots: [], nextDates: [], checkedAt, source: "mock", capacityIsReliable: false };
    }
    const day = Number(req.date.slice(8, 10));
    const soldOut = day % 7 === 0;
    return {
      status: soldOut ? "sold_out" : "available",
      spotsLeft: null,
      slots: req.timeslot ? [{ time: req.timeslot, status: soldOut ? "sold_out" : "available" }] : [],
      nextDates: [],
      checkedAt,
      source: "mock",
      capacityIsReliable: false,
    };
  }

  async createBooking(_req: BookingRequest): Promise<BookingResult> {
    throw Errors.notImplemented("TravelDesk booking (Stage 2, not approved)");
  }

  async lookupBooking(_supplierRef: string): Promise<LookupResult> {
    return { outcome: "not_supported", reason: "TravelDesk booking lookup is Stage 2" };
  }

  async cancelBooking(_supplierRef: string, _reason: string): Promise<CancelResult> {
    return { outcome: "not_supported", reason: "TravelDesk cancellation is Stage 2" };
  }
}
