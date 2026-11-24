import { describe, expect, it } from "vitest";
import { inquiryHref, inquiryNotesFromBooking, inquiryReasonText, parseInquiryReason } from "../inquiry-handoff";

/** Doc 29 Batch 6 (review 89 B6-16): "Send it to our team" from the status page carries the booking. Pure. */
describe("inquiry from a released external booking", () => {
  it("the link names the booking reference only, never personal data, and only from the status page", () => {
    expect(inquiryHref("external_hold", "booking", "OUT-10000017")).toBe("/inquiry?from=booking&reason=external_hold&order=OUT-10000017");
    expect(inquiryHref("external_hold", "booking", "not a reference")).toBe("/inquiry?from=booking&reason=external_hold");
    expect(inquiryHref("cutoff", "checkout", "OUT-10000017")).toBe("/inquiry?from=checkout&reason=cutoff");
    expect(parseInquiryReason("external_hold")).toBe("external_hold");
    expect(inquiryReasonText("external_hold")).toContain("our team books it");
  });

  it("the form note names the activity, date, time and guests", () => {
    const note = inquiryNotesFromBooking({ reference: "OUT-10000017", items: [{ title: "Desert safari (synthetic)", serviceDate: "2030-01-15", timeslot: "15:00", paxLabel: "2 adults" }] });
    expect(note).toBe("Booking OUT-10000017 could not be booked online. Please book: Desert safari (synthetic), 2030-01-15 at 15:00, 2 adults.");
    expect(inquiryNotesFromBooking({ reference: "OUT-10000017", items: [] })).toBeNull();
  });
});
