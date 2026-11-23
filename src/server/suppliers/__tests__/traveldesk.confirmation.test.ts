import { describe, expect, it } from "vitest";
import type { ConfirmationSnapshot, ExpectedBooking } from "../booking-port";
import { bookingFrom, bookingWire } from "../traveldesk/traveldesk.booking";
import {
  CHARGED_AMOUNT_TOLERANCE_MINOR,
  chargedFrom,
  confirmationSnapshotFrom,
  isConfirmedSnapshot,
  isSameBooking,
  TRAVELDESK_ACCEPT_PENDING_VERIFICATION_Q_B3,
  TRAVELDESK_FINAL_STATUSES,
} from "../traveldesk/traveldesk.confirmation";

/** SUP-1 acceptance: none of these confirms. Amounts are synthetic. */

const expected: ExpectedBooking = {
  clientRef: "OUTTD-T-1",
  offerExternalId: "777001",
  tourExternalId: "1",
  serviceDate: "2026-11-10",
  timeSlotId: "9",
  startMinutes: 1260,
  adults: 2,
  children: 1,
  infants: 0,
  expectedNetMinor: 24_000n,
};

const good: ConfirmationSnapshot = {
  rawStatus: 5,
  bookingReference: "OUTTD-T-1",
  offerExternalId: "777001",
  tourExternalId: "1",
  serviceDate: "2026-11-10",
  timeSlotId: "9",
  startMinutes: 1260,
  adults: 2,
  children: 1,
  infants: 0,
  chargedNetMinor: 24_000n,
  externalInProgress: false,
  externalFailed: false,
};

function reasons(over: Partial<ConfirmationSnapshot>) {
  const v = isConfirmedSnapshot(expected, { ...good, ...over });
  return v.confirmed ? [] : v.reasons;
}

describe("isConfirmedSnapshot (SUP-1)", () => {
  it("confirms an exact, final, fully flagged answer", () => {
    expect(isConfirmedSnapshot(expected, good)).toEqual({ confirmed: true });
  });

  it("final statuses: 5 always, 0 and 1 behind the Q-B3 constant (TravelDesk: both successful)", () => {
    expect(TRAVELDESK_FINAL_STATUSES.has(5)).toBe(true);
    expect(TRAVELDESK_FINAL_STATUSES.has(1)).toBe(TRAVELDESK_ACCEPT_PENDING_VERIFICATION_Q_B3);
    expect(TRAVELDESK_FINAL_STATUSES.has(0)).toBe(TRAVELDESK_ACCEPT_PENDING_VERIFICATION_Q_B3);
    const accepted = TRAVELDESK_ACCEPT_PENDING_VERIFICATION_Q_B3 ? [] : ["status_not_final"];
    expect(reasons({ rawStatus: 0 })).toEqual(accepted);
    expect(reasons({ rawStatus: 1 })).toEqual(accepted);
    for (const s of [2, 3, 4, 6, 7, 8, 99]) expect(reasons({ rawStatus: s })).toContain("status_not_final");
  });

  it("status 0 still needs every other check", () => {
    const status = TRAVELDESK_ACCEPT_PENDING_VERIFICATION_Q_B3 ? [] : ["status_not_final"];
    expect(reasons({ rawStatus: 0, externalInProgress: true })).toEqual([...status, "external_pending"]);
    expect(reasons({ rawStatus: 0, externalFailed: true })).toEqual([...status, "external_failed"]);
    expect(reasons({ rawStatus: 0, chargedNetMinor: null })).toEqual([...status, "amount_missing"]);
  });

  it.each([
    ["wrong date", { serviceDate: "2026-11-11" }],
    ["missing date", { serviceDate: null }],
    ["wrong offer", { offerExternalId: "777002" }],
    ["wrong tour", { tourExternalId: "2" }],
    ["wrong slot", { timeSlotId: "10" }],
    ["slot not echoed", { timeSlotId: null }],
    ["wrong start", { startMinutes: 1290 }],
    ["wrong adults", { adults: 3 }],
    ["wrong children", { children: 0 }],
    ["wrong infants", { infants: 1 }],
    ["pax not echoed", { adults: null }],
  ] as const)("identity: %s", (_name, over) => {
    expect(reasons(over)).toEqual(["identity_mismatch"]);
  });

  it("start time: TravelDesk does not echo it; accepted only with the same slot id echoed", () => {
    expect(reasons({ startMinutes: null })).toEqual([]);
    expect(reasons({ startMinutes: null, timeSlotId: null })).toEqual(["identity_mismatch"]);
    expect(reasons({ startMinutes: null, timeSlotId: "10" })).toEqual(["identity_mismatch"]);
    expect(reasons({ startMinutes: 1290 })).toEqual(["identity_mismatch"]);
  });

  it("start time: a slot-less booking never accepts a missing start against an expected one", () => {
    expect(isConfirmedSnapshot({ ...expected, timeSlotId: null }, { ...good, timeSlotId: null, startMinutes: null })).toEqual({
      confirmed: false,
      reasons: ["identity_mismatch"],
    });
  });

  it("a missing flag is unknown, never false", () => {
    expect(reasons({ externalInProgress: null })).toEqual(["flag_missing"]);
    expect(reasons({ externalFailed: null })).toEqual(["flag_missing"]);
  });

  it("external confirmation pending or failed", () => {
    expect(reasons({ externalInProgress: true })).toEqual(["external_pending"]);
    expect(reasons({ externalFailed: true })).toEqual(["external_failed"]);
  });

  it("the reference must equal our client reference", () => {
    expect(reasons({ bookingReference: "OUTTD-T-2" })).toEqual(["reference_mismatch"]);
    expect(reasons({ bookingReference: null })).toEqual(["reference_mismatch"]);
  });

  it("amount: null is missing; outside the shared tolerance is a mismatch", () => {
    expect(reasons({ chargedNetMinor: null })).toEqual(["amount_missing"]);
    expect(reasons({ chargedNetMinor: 0n })).toEqual(["amount_mismatch"]);
    expect(reasons({ chargedNetMinor: 24_000n + CHARGED_AMOUNT_TOLERANCE_MINOR })).toEqual([]);
    expect(reasons({ chargedNetMinor: 24_000n - CHARGED_AMOUNT_TOLERANCE_MINOR })).toEqual([]);
    expect(reasons({ chargedNetMinor: 24_000n + CHARGED_AMOUNT_TOLERANCE_MINOR + 1n })).toEqual(["amount_mismatch"]);
  });

  it("reports every failure at once", () => {
    expect(reasons({ rawStatus: 2, externalFailed: null, bookingReference: "x", adults: 1, chargedNetMinor: null })).toEqual([
      "status_not_final",
      "flag_missing",
      "reference_mismatch",
      "identity_mismatch",
      "amount_missing",
    ]);
  });
});

describe("TravelDesk answer → confirmation snapshot", () => {
  const wire = {
    id: 51_001,
    date: "2026-11-10T00:00:00",
    offerId: 777_001,
    bookingType: 1,
    bookingReference: "OUTTD-T-1",
    tourId: 1,
    timeSlotId: 9,
    startTime: 1260,
    adults: 2,
    children: 1,
    infants: 0,
    totalCost: 240,
    totalCostUsd: 66,
    status: 5,
    isExternalBookingFailed: false,
    isExternalConfirmationInProgress: false,
  };

  it("maps a complete answer to a confirmed snapshot", () => {
    const s = confirmationSnapshotFrom(bookingFrom(bookingWire.parse(wire)));
    expect(isConfirmedSnapshot(expected, s)).toEqual({ confirmed: true });
  });

  it("absent external flags decode as null, and the snapshot does not confirm", () => {
    const { isExternalBookingFailed: _a, isExternalConfirmationInProgress: _b, ...rest } = wire;
    const b = bookingFrom(bookingWire.parse(rest));
    expect(b.externalInProgress).toBeNull();
    expect(b.externalFailed).toBeNull();
    expect(isConfirmedSnapshot(expected, confirmationSnapshotFrom(b))).toEqual({ confirmed: false, reasons: ["flag_missing"] });
  });

  it("reservationDeadline is UTC (TravelDesk, doc 29 §8.7): without an offset it reads as UTC; an offset is kept", () => {
    const at = (reservationDeadline: string | null) => bookingFrom(bookingWire.parse({ ...wire, status: 7, reservationDeadline })).reservationDeadline;
    expect(at("2026-11-10T10:15:00")).toBe("2026-11-10T10:15:00.000Z");
    expect(at("2026-11-10T10:15:00.5")).toBe("2026-11-10T10:15:00.500Z");
    expect(at("2026-11-10T14:15:00+04:00")).toBe("2026-11-10T10:15:00.000Z");
    expect(at("not a date")).toBeNull();
    expect(at(null)).toBeNull();
  });

  it("charged amount: paid from balance first; a zero total with nothing paid is missing", () => {
    expect(chargedFrom({ paidFromBalanceMinor: 23_999n, totalCostMinor: 24_000n })).toBe(23_999n);
    expect(chargedFrom({ paidFromBalanceMinor: null, totalCostMinor: 24_000n })).toBe(24_000n);
    expect(chargedFrom({ paidFromBalanceMinor: null, totalCostMinor: 0n })).toBeNull();
    const zero = bookingFrom(bookingWire.parse({ ...wire, totalCost: 0, totalPaidFromBalance: null }));
    expect(isConfirmedSnapshot(expected, confirmationSnapshotFrom(zero))).toEqual({ confirmed: false, reasons: ["amount_missing"] });
  });
});

describe("isSameBooking (SUP-3, before releasing)", () => {
  const ours = { supplierBookingId: "51001", clientRef: "OUTTD-T-1" };

  it("matches on our id and reference", () => {
    expect(isSameBooking(ours, { supplierBookingId: "51001", bookingReference: "OUTTD-T-1" })).toBe(true);
  });

  it("an absent reference is not a mismatch; an absent id of ours checks the reference only", () => {
    expect(isSameBooking(ours, { supplierBookingId: "51001", bookingReference: null })).toBe(true);
    expect(isSameBooking({ supplierBookingId: null, clientRef: "OUTTD-T-1" }, { supplierBookingId: "51999", bookingReference: "OUTTD-T-1" })).toBe(true);
  });

  it("another id or another reference is not ours", () => {
    expect(isSameBooking(ours, { supplierBookingId: "51002", bookingReference: "OUTTD-T-1" })).toBe(false);
    expect(isSameBooking(ours, { supplierBookingId: "51001", bookingReference: "OUTTD-T-2" })).toBe(false);
    expect(isSameBooking({ supplierBookingId: null, clientRef: "OUTTD-T-1" }, { supplierBookingId: "51001", bookingReference: "AGENT-1" })).toBe(false);
  });
});

describe("doc 29 §8.7: the returned pickup time", () => {
  it("reads whole minutes, HH:mm, HH:mm:ss or a zoneless date-time; anything else is unknown, and never fails the parse", async () => {
    const { pickupMinutesOf } = await import("../traveldesk/traveldesk.booking");
    expect(pickupMinutesOf(495)).toBe(495);
    expect(pickupMinutesOf("08:15")).toBe(495);
    expect(pickupMinutesOf("08:15:00")).toBe(495);
    expect(pickupMinutesOf("2026-11-10T08:15:00")).toBe(495);
    for (const bad of [1440, -1, 8.5, "8:15", "24:00", "08:15Z", "2026-11-10T08:15:00+04:00", "08:15 - 08:45", "", null, undefined, {}, true]) expect(pickupMinutesOf(bad), String(bad)).toBeNull();
  });
});
