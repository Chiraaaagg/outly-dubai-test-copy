import type { ConfirmationFailure, ConfirmationSnapshot, ConfirmationVerdict, ExpectedBooking } from "../booking-port";
import type { TravelDeskBooking } from "./traveldesk.booking";
import { DATE_ONLY_CLASS_KEYS } from "./traveldesk.capability";

/**
 * When a TravelDesk answer counts as a confirmed booking (SUP-1, doc 22 §23 B1a).
 *
 * Pure: no env, db or logger, so the predicate is unit-tested on its own and
 * shared by the engine (confirm, poll, recovery) and reconciliation.
 *
 * A snapshot is confirmed only when every check passes. Anything the supplier
 * left out counts as unknown, never as a pass: a missing flag, a missing
 * charged amount or a missing slot is a failure.
 */

/**
 * Q-B3, answered by TravelDesk in writing (17 Nov 2026): statuses 0 (New) and
 * 1 (PendingVerification) are both successful bookings. 1 means created and
 * confirmed, awaiting a recheck by TravelDesk's operations team. 5 (Completed)
 * is final too. A status alone never confirms: every other check below must
 * also pass. Despite its name, this flag gates both 0 and 1. Set it to false
 * to go back to accepting 5 only.
 */
export const TRAVELDESK_ACCEPT_PENDING_VERIFICATION_Q_B3 = true;

/** Statuses that may count as confirmed, subject to every other check. */
export const TRAVELDESK_FINAL_STATUSES: ReadonlySet<number> = new Set(TRAVELDESK_ACCEPT_PENDING_VERIFICATION_Q_B3 ? [5, 1, 0] : [5]);

/**
 * How far the supplier's charged amount may differ from the expected net, in
 * AED minor units (plan §6.3: ± 1 fil for rounding). Confirmation,
 * reconciliation and the supplier quote's rounding check all use this one
 * value (SUP-24).
 */
export const CHARGED_AMOUNT_TOLERANCE_MINOR = 1n;

export function withinChargeTolerance(a: bigint, b: bigint): boolean {
  const d = a > b ? a - b : b - a;
  return d <= CHARGED_AMOUNT_TOLERANCE_MINOR;
}

/**
 * What TravelDesk says it charged. `totalPaidFromBalance` is the charge; when
 * it is absent, `totalCost` stands in (Q-C4 open), but a zero `totalCost` says
 * nothing and counts as missing.
 */
export function chargedFrom(r: Pick<TravelDeskBooking, "paidFromBalanceMinor" | "totalCostMinor">): bigint | null {
  if (r.paidFromBalanceMinor !== null) return r.paidFromBalanceMinor;
  return r.totalCostMinor > 0n ? r.totalCostMinor : null;
}

/** A TravelDesk answer reduced to what the predicate reads. */
export function confirmationSnapshotFrom(r: TravelDeskBooking): ConfirmationSnapshot {
  return {
    rawStatus: r.status,
    bookingReference: r.bookingReference,
    offerExternalId: String(r.offerId),
    tourExternalId: String(r.tourId),
    serviceDate: r.serviceDate,
    timeSlotId: r.timeSlotId === null ? null : String(r.timeSlotId),
    startMinutes: r.startMinutes,
    adults: r.adults,
    children: r.children,
    infants: r.infants,
    chargedNetMinor: chargedFrom(r),
    externalInProgress: r.externalInProgress,
    externalFailed: r.externalFailed,
  };
}

export function isConfirmedSnapshot(expected: ExpectedBooking, s: ConfirmationSnapshot): ConfirmationVerdict {
  const reasons: ConfirmationFailure[] = [];
  if (!TRAVELDESK_FINAL_STATUSES.has(s.rawStatus)) reasons.push("status_not_final");
  if (s.externalInProgress === null || s.externalFailed === null) reasons.push("flag_missing");
  if (s.externalInProgress === true) reasons.push("external_pending");
  if (s.externalFailed === true) reasons.push("external_failed");
  if (s.bookingReference !== expected.clientRef) reasons.push("reference_mismatch");
  // Exact match, null included: a slot we asked for and the supplier did not echo is a mismatch.
  // One exception, start time: TravelDesk's booking reads do not echo `startTime` (A5 drill,
  // 3 November 2026, offers with a timed slot answered null). A start time the supplier does
  // echo must match exactly; a missing one is accepted only when the slot id was echoed and
  // matches, the reference is ours and every other field matches. Q-C10 asks TravelDesk to echo it.
  const startMatches =
    s.startMinutes === expected.startMinutes ||
    (s.startMinutes === null && expected.timeSlotId !== null && s.timeSlotId === expected.timeSlotId);
  const identity =
    s.offerExternalId === expected.offerExternalId &&
    s.tourExternalId === expected.tourExternalId &&
    s.serviceDate === expected.serviceDate &&
    s.timeSlotId === expected.timeSlotId &&
    startMatches &&
    s.adults === expected.adults &&
    s.children === expected.children &&
    s.infants === expected.infants;
  if (!identity) reasons.push("identity_mismatch");
  if (s.chargedNetMinor === null) reasons.push("amount_missing");
  else if (!withinChargeTolerance(s.chargedNetMinor, expected.expectedNetMinor)) reasons.push("amount_mismatch");
  return reasons.length === 0 ? { confirmed: true } : { confirmed: false, reasons };
}

/**
 * Whether an answer is about our booking, before it may release the order item
 * (SUP-3: cancelled or expired). The id must match when we hold one, and the
 * reference must equal our client reference when the answer carries one.
 * Confirmation has its own, stricter check (`isConfirmedSnapshot`).
 */
export function isSameBooking(ours: { supplierBookingId: string | null; clientRef: string }, r: Pick<TravelDeskBooking, "supplierBookingId" | "bookingReference">): boolean {
  if (ours.supplierBookingId !== null && r.supplierBookingId !== ours.supplierBookingId) return false;
  return r.bookingReference === null || r.bookingReference === ours.clientRef;
}

/** The error code a booking carries when its reservation names another slot (`reservationSlotDiffers`); an ops-alert reason. */
export const RESERVATION_SLOT_MISMATCH_CODE = "reservation_slot_mismatch";

/**
 * Whether a reservation answer names another slot than the one we sent
 * (doc 29 Batch 7, review 92 B7-12), evaluated when the reservation is
 * applied, for date-only bookings only (`reservationSlotHeld`). A mismatch takes the `charged_amount_mismatch` path: the booking
 * waits for staff with no automatic confirm. It does not stop the payment
 * saga's capture (review 92 B7-15): the card is captured, and the item is
 * refunded when the hold runs out unless staff resolve it first. TravelDesk
 * returns `timeSlotId` on the reservation (it does not echo
 * `startTime`/`endTime`, which its schema marks write-only). An answer that
 * leaves the id out says nothing and passes here; the confirm check
 * (`isConfirmedSnapshot`) still demands an exact echo. `tourTime` is an
 * undocumented free-text field (no format, and on pickup tours it may be the
 * pickup), so it is not compared.
 */
export function reservationSlotDiffers(sentTimeSlotId: string | null, answer: Pick<ConfirmationSnapshot, "timeSlotId">): boolean {
  return sentTimeSlotId !== null && answer.timeSlotId !== null && answer.timeSlotId !== sentTimeSlotId;
}

/**
 * Whether the reserve-time slot check holds this booking (lead decision,
 * 24 Nov 2026): only for a booking of one of the two Batch 7 date-only keys
 * (`DATE_ONLY_CLASS_KEYS`, from its stored offer), because whether
 * TravelDesk's reserve answer echoes the sent `timeSlotId` is unproven. A
 * Batch 0–6 booking (fixed slot, listed starts, pickup, external, ticket) is
 * never held by it, whatever id its reserve answer carries: it behaves
 * exactly as before, and its confirm check still demands an exact echo.
 * `classKey` null (offer not stored or unreadable) is not date only.
 */
export function reservationSlotHeld(classKey: string | null, sentTimeSlotId: string | null, answer: Pick<ConfirmationSnapshot, "timeSlotId">): boolean {
  return classKey !== null && DATE_ONLY_CLASS_KEYS.includes(classKey) && reservationSlotDiffers(sentTimeSlotId, answer);
}
