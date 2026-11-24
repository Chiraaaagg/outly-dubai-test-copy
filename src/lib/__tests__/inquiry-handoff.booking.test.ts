import { describe, expect, it } from "vitest";
import {
  forgetBookingForInquiry,
  INQUIRY_BOOKING_KEY,
  inquiryHref,
  inquiryNotesFromBooking,
  inquiryReasonText,
  parseInquiryReason,
  readBookingForInquiry,
  rememberBookingForInquiry,
} from "../inquiry-handoff";

/** Doc 29 Batch 6 (review 89 B6-16): "Send it to our team" from the status page carries the booking. Pure. */
describe("inquiry from a released external booking", () => {
  it("review 89 B6-21 (PRV-4): the measured /inquiry URL never carries a booking reference; the tab's sessionStorage hands it over once", () => {
    expect(inquiryHref("external_hold", "booking")).toBe("/inquiry?from=booking&reason=external_hold");
    expect(inquiryHref("cutoff")).toBe("/inquiry?from=checkout&reason=cutoff");
    const reasons = ["mixed", "over_limit", "cutoff", "time_slot", "sold_out", "pickup", "ticket_validity", "unavailable", "external_hold"] as const;
    for (const r of reasons) for (const from of ["checkout", "booking"] as const) expect(inquiryHref(r, from)).not.toMatch(/OUT-|order=/i);
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    rememberBookingForInquiry("OUT-10000017", storage);
    expect(store.get(INQUIRY_BOOKING_KEY)).toBe("OUT-10000017");
    expect(readBookingForInquiry(storage)).toBe("OUT-10000017");
    forgetBookingForInquiry(storage);
    expect(readBookingForInquiry(storage)).toBeNull();
    // Anything that is not a reference is neither kept nor read.
    rememberBookingForInquiry("not a reference", storage);
    expect(store.size).toBe(0);
    store.set(INQUIRY_BOOKING_KEY, "<script>");
    expect(readBookingForInquiry(storage)).toBeNull();
    expect(parseInquiryReason("external_hold")).toBe("external_hold");
    expect(inquiryReasonText("external_hold")).toContain("our team books it");
  });

  it("the form note names the activity, date, time and guests", () => {
    const note = inquiryNotesFromBooking({ reference: "OUT-10000017", items: [{ title: "Desert safari (synthetic)", serviceDate: "2030-01-15", timeslot: "15:00", paxLabel: "2 adults" }] });
    expect(note).toBe("Booking OUT-10000017 could not be booked online. Please book: Desert safari (synthetic), 2030-01-15 at 15:00, 2 adults.");
    expect(inquiryNotesFromBooking({ reference: "OUT-10000017", items: [] })).toBeNull();
  });
});
