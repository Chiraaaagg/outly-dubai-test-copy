import type { TravelDeskBooking } from "../../suppliers/traveldesk/traveldesk.booking";
import type { TravelDeskBookingTransport } from "../../suppliers/traveldesk/traveldesk.booking-adapter";
import { TravelDeskApiError } from "../../suppliers/traveldesk/traveldesk.http";

/**
 * Scripted TravelDesk behind the real TravelDesk adapter, for the saga suite
 * that runs the real engine (saga-engine.db-suite.ts). The same behaviour as
 * the engine suite's fake (supplier-booking.service.test.ts), reduced to what
 * the saga paths need: each mutation takes the next step from its queue
 * (default "ok"); a reservation holds for 15 minutes on the test clock, reads
 * after its deadline show it timed out (status 8), and a confirm after the
 * deadline is refused. Amounts are synthetic. Not a test file itself.
 */

/** `in_progress` and `external_failed` (doc 29 Batch 6): the confirm answers an external confirmation still running, or failed (201 with the flag). */
type Step = "ok" | "lost" | "in_progress" | "external_failed" | TravelDeskApiError;

export class ScriptedTravelDesk implements TravelDeskBookingTransport {
  calls: string[] = [];
  store = new Map<string, TravelDeskBooking>();
  steps: Record<"reserve" | "confirm" | "create" | "cancel", Step[]> = { reserve: [], confirm: [], create: [], cancel: [] };
  /** Spendable funds TravelDesk reports (synthetic). */
  fundsMinor = 10_000_000n;
  /**
   * Per reserve call, in order: minor units TravelDesk charges above (or below)
   * the request's `totalCost`. Seen on TravelDesk TEST for some pickup offers
   * (drill of 4 November 2026); the engine holds such a reservation for a human.
   */
  chargeOffsets: bigint[] = [];
  private seq = 60_000 + Math.floor(Math.random() * 1000);

  constructor(private readonly clock: () => Date) {}

  private make(body: Record<string, unknown>, status: number): TravelDeskBooking {
    const id = String(this.seq++);
    const cost = BigInt(Math.round(Number(body.totalCost) * 100));
    const b: TravelDeskBooking = {
      supplierBookingId: id,
      status,
      statusName: String(status),
      bookingReference: String(body.referenceNumber),
      serviceDate: String(body.date),
      offerId: Number(body.offerId),
      tourId: 1,
      bookingType: 1,
      timeSlotId: body.timeSlotId === undefined ? null : Number(body.timeSlotId),
      startMinutes: body.startTime === undefined ? null : Number(body.startTime),
      adults: Number(body.adults),
      children: Number(body.children),
      infants: Number(body.infants),
      totalCostMinor: cost,
      totalCostUsdMinor: 0n,
      paidFromBalanceMinor: cost,
      refundMinor: null,
      reservationDeadline: status === 7 ? new Date(this.clock().getTime() + 15 * 60_000).toISOString() : null,
      reservationTimeout: null,
      externalInProgress: false,
      externalFailed: false,
      externalFailureMessage: null,
      voucherNotReady: false,
      hasTickets: false,
      creationState: null,
    };
    this.store.set(id, b);
    return b;
  }

  private step(op: keyof ScriptedTravelDesk["steps"]): Step {
    return this.steps[op].shift() ?? "ok";
  }

  /** A reservation past its deadline has timed out. */
  private expire(b: TravelDeskBooking) {
    if (b.status !== 7 || !b.reservationDeadline || this.clock().getTime() <= Date.parse(b.reservationDeadline)) return b;
    const out = { ...b, status: 8 };
    this.store.set(b.supplierBookingId, out);
    return out;
  }

  async reserve(body: Record<string, unknown>) {
    this.calls.push("reserve");
    const s = this.step("reserve");
    if (s instanceof TravelDeskApiError) throw s;
    let b = this.make(body, 7);
    const offset = this.chargeOffsets.shift() ?? 0n;
    if (offset !== 0n) {
      b = { ...b, totalCostMinor: b.totalCostMinor + offset, paidFromBalanceMinor: (b.paidFromBalanceMinor ?? 0n) + offset };
      this.store.set(b.supplierBookingId, b);
    }
    if (s === "lost") throw new TravelDeskApiError("timeout", "bookings.reserve");
    return b;
  }

  async create(body: Record<string, unknown>) {
    this.calls.push("create");
    const s = this.step("create");
    if (s instanceof TravelDeskApiError) throw s;
    const b = this.make(body, 1);
    if (s === "lost") throw new TravelDeskApiError("timeout", "bookings.create");
    return b;
  }

  async confirm(id: string) {
    this.calls.push("confirm");
    const s = this.step("confirm");
    if (s instanceof TravelDeskApiError) throw s;
    if (s === "lost") throw new TravelDeskApiError("timeout", "bookings.confirm");
    const held = this.expire(this.store.get(id)!);
    if (held.status !== 7) throw new TravelDeskApiError("bad_request", "bookings.confirm", { status: 400, reason: "The reservation is no longer active" });
    const b = { ...held, status: 1, reservationDeadline: null, externalInProgress: s === "in_progress", externalFailed: s === "external_failed" };
    this.store.set(id, b);
    return b;
  }

  async cancel(id: string) {
    this.calls.push("cancel");
    const s = this.step("cancel");
    if (s instanceof TravelDeskApiError) throw s;
    this.store.set(id, { ...this.store.get(id)!, status: 4, refundMinor: this.store.get(id)!.paidFromBalanceMinor });
    if (s === "lost") throw new TravelDeskApiError("timeout", "bookings.cancel");
    return { isSuccess: true, message: null };
  }

  async getBalance() {
    return { agencyId: 1, currencyRequested: "AED" as const, balanceMinor: 0n, creditFacilityMinor: this.fundsMinor, payableBalanceMinor: this.fundsMinor };
  }

  async getReservation(id: string) {
    this.calls.push("getReservation");
    const b = this.store.get(id);
    if (!b) throw new TravelDeskApiError("not_found", "bookings.reservation", { status: 404 });
    const r = this.expire(b);
    if (r.status !== 7) throw new TravelDeskApiError("bad_request", "bookings.reservation", { status: 400 });
    return r;
  }

  async listBookingsPage(q: { from: string; to: string; offerId?: number }, page: number, onPage = 100) {
    this.calls.push("list");
    const all = [...this.store.values()].map((b) => this.expire(b)).filter((b) => b.serviceDate! >= q.from && b.serviceDate! <= q.to && (!q.offerId || b.offerId === q.offerId));
    return { rows: all.slice((page - 1) * onPage, page * onPage), totalCount: all.length };
  }
}
