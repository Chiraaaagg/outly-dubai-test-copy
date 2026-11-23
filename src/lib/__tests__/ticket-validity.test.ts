import { describe, expect, it } from "vitest";
import { customerTicketFacts, TICKET_VALIDITY_CONCERN, ticketTypeLine, ticketTypeSummary, ticketValidUntilDay, validityDayOf } from "../ticket-validity";
import { TICKET_NON_REFUNDABLE_STATEMENT } from "../utils";

/**
 * Open-dated ticket facts as a customer sees them (doc 29 Batch 5): which
 * "valid until" day is shown, Dubai date boundaries, and combo offers
 * labelled per ticket type. Pure; synthetic values only, no ticket code.
 */

describe("validityDayOf: the calendar day a supplier validity stands for", () => {
  it("takes a date as it is and rejects what is not a day", () => {
    expect(validityDayOf("2027-03-31")).toBe("2027-03-31");
    expect(validityDayOf(null)).toBeNull();
    expect(validityDayOf(undefined)).toBeNull();
    expect(validityDayOf("not a date")).toBeNull();
  });

  it("an issued ticket's time-zone-less validity, stored as UTC, keeps the day the supplier wrote (no shift into the next Dubai day)", () => {
    // 23:59 written by the supplier: 03:59 the next day in Dubai, but the ticket is valid on 31 March.
    expect(validityDayOf(new Date("2027-03-31T23:59:59.000Z"))).toBe("2027-03-31");
    expect(validityDayOf("2027-03-31T23:59:59.000Z")).toBe("2027-03-31");
    expect(validityDayOf(new Date("2027-03-31T00:00:00.000Z"))).toBe("2027-03-31");
    // An explicit Dubai midnight is the previous UTC day: the earlier (safer) day is shown.
    expect(validityDayOf("2027-04-01T00:00:00+04:00")).toBe("2027-03-31");
  });
});

describe("ticketValidUntilDay: per-ticket first, then the booking's, then the stock hint (TravelDesk OpenAPI, 22 Nov 2026)", () => {
  it("issued tickets: the earliest per-ticket validity, even when the stock hint or the booking says later or earlier", () => {
    const issued = [new Date("2027-07-16T00:00:00Z"), new Date("2027-06-30T00:00:00Z"), null];
    expect(ticketValidUntilDay("2029-11-17", issued, "2027-12-31")).toBe("2027-06-30");
    expect(ticketValidUntilDay("2026-12-01", issued, null)).toBe("2027-06-30");
  });

  it("no per-ticket validity: the booking's own, else the stock's pre-sale hint, else none", () => {
    expect(ticketValidUntilDay("2029-11-17", [null, null], "2027-12-31")).toBe("2027-12-31");
    expect(ticketValidUntilDay("2029-11-17", [], null)).toBe("2029-11-17");
    expect(ticketValidUntilDay(null, [], null)).toBeNull();
  });

  it("impossible or malformed days are never shown", () => {
    expect(ticketValidUntilDay("2027-02-30", [], null)).toBeNull();
    expect(ticketValidUntilDay("2027-02-28", [], "2027-02-30")).toBe("2027-02-28");
    expect(ticketValidUntilDay(null, ["garbage"], "2027-13-01")).toBeNull();
    // Leap day.
    expect(ticketValidUntilDay("2028-02-29", [], null)).toBe("2028-02-29");
  });
});

describe("ticketTypeSummary: combo offers labelled per ticket type", () => {
  it("one code per guest per type: two adults on a two-part combo read as two types of two, never four tickets", () => {
    const units = [
      { ticketTypeName: "Park A", ticketFor: "adult" },
      { ticketTypeName: "Park B", ticketFor: "adult" },
      { ticketTypeName: "Park A", ticketFor: "adult" },
      { ticketTypeName: "Park B", ticketFor: "adult" },
      { ticketTypeName: "Park A", ticketFor: "child" },
    ];
    expect(ticketTypeSummary(units)).toEqual([
      { label: "Park A (adult)", count: 2 },
      { label: "Park B (adult)", count: 2 },
      { label: "Park A (child)", count: 1 },
    ]);
    expect(ticketTypeSummary(units).map(ticketTypeLine)).toEqual(["Park A (adult) × 2", "Park B (adult) × 2", "Park A (child) × 1"]);
  });

  it("without a type name the guest category labels it; supplier text is cleaned and capped", () => {
    expect(ticketTypeSummary([{ ticketTypeName: null, ticketFor: "adult" }, { ticketTypeName: "  ", ticketFor: "child" }, { ticketTypeName: null, ticketFor: "unknown" }])).toEqual([
      { label: "Adult ticket", count: 1 },
      { label: "Child ticket", count: 1 },
      { label: "Ticket", count: 1 },
    ]);
    const [t] = ticketTypeSummary([{ ticketTypeName: `Park\u0000\n  A${"x".repeat(200)}`, ticketFor: "infant" }]);
    expect(t.label.startsWith("Park A")).toBe(true);
    expect(t.label).not.toMatch(/[\u0000-\u001f]/);
    expect(t.label.length).toBeLessThanOrEqual(80 + " (infant)".length);
  });
});

describe("customerTicketFacts", () => {
  it("always carries the non-refundable statement, and never a code", () => {
    const fake = ["FAKE", "TICKET", "CODE", "0001"].join("-");
    const issued = [{ ticketTypeName: "Park A", ticketFor: "adult", validUntil: new Date("2027-07-16T00:00:00Z"), code: fake }];
    const facts = customerTicketFacts({ quoteValidUntil: "2029-01-01", issued, bookingValidUntil: null });
    expect(facts).toEqual({
      validUntil: "2027-07-16",
      validityCopy: "Ticket valid until Friday, 16 July 2027.",
      nonRefundableCopy: TICKET_NON_REFUNDABLE_STATEMENT,
      types: [{ label: "Park A (adult)", count: 1 }],
      validityConcern: null,
    });
    expect(JSON.stringify(facts)).not.toContain(fake);
    expect(TICKET_NON_REFUNDABLE_STATEMENT).toMatch(/non-refundable once issued/i);
  });

  it("review 86 B5-02: neutral copy when the issued tickets end before the visit date; never from the stock hint", () => {
    const issued = (day: string) => [{ ticketTypeName: "Park A", ticketFor: "adult", validUntil: new Date(`${day}T23:59:00Z`) }];
    expect(customerTicketFacts({ quoteValidUntil: null, issued: issued("2027-07-15"), visitDate: "2027-07-16" }).validityConcern).toBe(TICKET_VALIDITY_CONCERN);
    expect(customerTicketFacts({ quoteValidUntil: null, issued: issued("2027-07-16"), visitDate: "2027-07-16" }).validityConcern).toBeNull();
    // The booking's own validity counts as issued too.
    expect(customerTicketFacts({ quoteValidUntil: null, issued: [], bookingValidUntil: "2027-07-01", visitDate: "2027-07-16" }).validityConcern).toBe(TICKET_VALIDITY_CONCERN);
    // Before issue only the stock hint is known: no concern (the quote refused a stock that ends before the visit).
    expect(customerTicketFacts({ quoteValidUntil: "2027-07-01", issued: [], visitDate: "2027-07-16" }).validityConcern).toBeNull();
    expect(customerTicketFacts({ quoteValidUntil: null, issued: issued("2027-07-15") }).validityConcern).toBeNull();
    expect(TICKET_VALIDITY_CONCERN).not.toMatch(/refund|expired|sorry/i);
  });
});
