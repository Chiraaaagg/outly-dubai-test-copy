import { describe, expect, it } from "vitest";
import type { CustomerDocument, CustomerItemStatus, CustomerOrderStatus, CustomerStep } from "@/lib/customer-status";
import {
  announcementFor,
  dateSpanText,
  currentMilestone,
  deliveryText,
  documentWord,
  dubaiClock,
  orderDocumentWord,
  progressMilestones,
  resendWaitText,
  ticketStatusText,
  timelineRows,
} from "../presenters";

/**
 * Post-payment batch A: "tickets" or "voucher" by what the files are (A7),
 * the progress card's milestones (A6) and the ticket email's words (A3/A4).
 * Synthetic values only.
 */

function doc(id: string, kind: CustomerDocument["kind"]): CustomerDocument {
  return { id, kind, version: 1, contentType: "application/pdf", byteSize: 1000, href: `/api/tickets/documents/${id}` };
}

const ticketFacts = { validUntil: "2030-07-16", validityCopy: "Valid until 16 July 2030.", nonRefundableCopy: "Non-refundable once issued.", types: [] };

function item(over: Partial<CustomerItemStatus> = {}): CustomerItemStatus {
  return {
    orderItemId: "a",
    title: "Synthetic cruise",
    serviceDate: "2030-01-15",
    timeslot: "21:00",
    paxLabel: "2 adults",
    state: "confirmed",
    tickets: { fulfilment: "issued", documents: [] },
    refundUntilUtc: null,
    cancellation: { kind: "none" },
    ...over,
  };
}

function step(status: CustomerStep["status"], label = "", at: string | null = null): CustomerStep {
  return { status, label, at };
}

describe("tickets or voucher (A7)", () => {
  it("names an item by the kind of its listed files, then by being an open-dated ticket, else voucher", () => {
    expect(documentWord(item({ tickets: { fulfilment: "issued", documents: [doc("t", "tickets_pdf")] } }))).toBe("tickets");
    expect(documentWord(item({ tickets: { fulfilment: "issued", documents: [doc("v", "voucher_pdf")] } }))).toBe("voucher");
    expect(documentWord(item({ tickets: { fulfilment: "issued", documents: [doc("t", "tickets_pdf"), doc("v", "voucher_pdf")] } }))).toBe("voucher");
    // Locked or not ready: no files listed, so the item's own kind decides.
    expect(documentWord(item({ ticket: ticketFacts }))).toBe("tickets");
    expect(documentWord(item())).toBe("voucher");
  });

  it("an order is one word when every item agrees, mixed otherwise", () => {
    expect(orderDocumentWord([item({ ticket: ticketFacts }), item({ ticket: ticketFacts })])).toBe("tickets");
    expect(orderDocumentWord([item(), item()])).toBe("vouchers");
    expect(orderDocumentWord([item()])).toBe("voucher");
    expect(orderDocumentWord([item(), item({ ticket: ticketFacts })])).toBe("mixed");
    expect(orderDocumentWord([])).toBe("voucher");
  });

  it("the status sentence follows the word", () => {
    expect(ticketStatusText({ fulfilment: "issued", documents: [doc("t", "tickets_pdf")] }, "confirmed", true, "tickets")).toBe(
      "Your tickets are ready. Download them and keep them with you on the day.",
    );
    expect(ticketStatusText({ fulfilment: "issued", documents: [] }, "confirmed", false, "tickets")).toBe("Your tickets are ready. To keep them private, confirm it's you.");
    expect(ticketStatusText({ fulfilment: "ticket_pending", documents: [] }, "confirmed", true, "tickets")).toBe("Booked. Your tickets are being prepared.");
    // The default stays the voucher wording.
    expect(ticketStatusText({ fulfilment: "ticket_pending", documents: [] }, "confirmed")).toBe("Booked. Your voucher is being prepared.");
  });

  it("the timeline's tickets row is named for the order", () => {
    const steps = { payment: step("done"), booking: step("done"), tickets: step("done"), refund: null };
    expect(timelineRows(steps, "tickets").map((r) => r.title)).toEqual(["Payment", "Booking with the operator", "Tickets"]);
    expect(timelineRows(steps).map((r) => r.title)).toEqual(["Payment", "Booking with the operator", "Voucher"]);
    expect(timelineRows(steps, "mixed")[2].title).toBe("Tickets and vouchers");
  });

  it("the announcement names tickets for a tickets item, and counts several", () => {
    const before = { state: "confirmed" as const, headline: "Booked.", items: [item({ ticket: ticketFacts, tickets: { fulfilment: "ticket_pending", documents: [] } })] };
    const after = { ...before, items: [item({ ticket: ticketFacts, tickets: { fulfilment: "issued", documents: [doc("t", "tickets_pdf")] } })] };
    expect(announcementFor(before, after)).toBe("Synthetic cruise: tickets ready.");
    const two = (f: "issued" | "ticket_pending") => [item({ orderItemId: "a", tickets: { fulfilment: f, documents: [] } }), item({ orderItemId: "b", tickets: { fulfilment: f, documents: [] } })];
    expect(announcementFor({ ...before, items: two("ticket_pending") }, { ...before, items: two("issued") })).toBe("Vouchers ready for 2 activities.");
  });
});

describe("progress milestones (A6)", () => {
  const base = (steps: Partial<CustomerOrderStatus["steps"]>, items: CustomerItemStatus[] = [item({ state: "booking_processing" })]) => ({
    steps: { payment: step("not_started"), booking: step("not_started"), tickets: step("not_started"), refund: null, ...steps },
    items,
  });

  it("checking payment: payment is current, the rest wait, no time is shown before a row is done", () => {
    const rows = progressMilestones(base({ payment: step("in_progress", "Waiting for Stripe to confirm") }, [item({ state: "awaiting_payment" })]));
    expect(rows.map((r) => [r.key, r.state])).toEqual([
      ["payment", "current"],
      ["operator", "waiting"],
      ["tickets", "waiting"],
    ]);
    expect(rows[0].title).toBe("Checking your payment");
    expect(rows[0].detail).toBe("Waiting for Stripe to confirm");
    expect(rows.every((r) => r.at === null)).toBe(true);
    expect(currentMilestone(rows)?.key).toBe("payment");
  });

  it("payment received with its time, operator confirmation in progress", () => {
    const rows = progressMilestones(
      base({ payment: step("done", "Payment received", "2030-01-01T10:01:00.000Z"), booking: step("in_progress", "Confirming with the operator") }),
    );
    expect(rows[0]).toMatchObject({ title: "Payment received", state: "done", at: "2030-01-01T10:01:00.000Z", detail: null });
    expect(rows[1]).toMatchObject({ title: "Operator confirmation", state: "current", stateText: "In progress", at: null });
    // Neutral until done (review fix 3): never "Voucher ready" beside a row that is not done.
    expect(rows[2].title).toBe("Voucher");
  });

  it("confirmed with its time, tickets being prepared, the word from the item", () => {
    const rows = progressMilestones(
      base(
        { payment: step("done", "", "2030-01-01T10:01:00.000Z"), booking: step("done", "", "2030-01-01T10:41:00.000Z"), tickets: step("in_progress") },
        [item({ state: "confirmed_ticket_pending", ticket: ticketFacts, tickets: { fulfilment: "ticket_pending", documents: [] } })],
      ),
    );
    expect(rows[1]).toMatchObject({ title: "Confirmed by the operator", at: "2030-01-01T10:41:00.000Z" });
    expect(rows[2]).toMatchObject({ title: "Getting your tickets", state: "current" });
  });

  it("several items keep the payment row, and count the confirmed activities while the rest are pending", () => {
    const rows = progressMilestones(
      base({ payment: step("done", "", "2030-01-01T10:01:00.000Z"), booking: step("in_progress") }, [
        item({ orderItemId: "a", state: "confirmed" }),
        item({ orderItemId: "b", state: "booking_processing" }),
        item({ orderItemId: "c", state: "booking_processing" }),
      ]),
    );
    expect(rows.map((r) => r.key)).toEqual(["payment", "operator", "tickets"]);
    expect(rows[1].detail).toBe("1 of 3 activities confirmed");
  });

  it("only one row is current, and a step that does not apply says so", () => {
    const rows = progressMilestones(base({ payment: step("in_progress"), booking: step("in_progress"), tickets: step("not_applicable") }));
    expect(rows.filter((r) => r.state === "current")).toHaveLength(1);
    expect(rows[1].state).toBe("waiting");
    expect(rows[2]).toMatchObject({ state: "skipped", title: "No voucher needed", stateText: "Not needed" });
  });

  it("carries no percentage, countdown or estimate", () => {
    const rows = progressMilestones(base({ payment: step("done", "", "2030-01-01T10:01:00.000Z"), booking: step("in_progress") }));
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/%|\bminutes?\b|\bseconds?\b|remaining|estimated/i);
  });
});

describe("ticket email words (A3)", () => {
  const masked = "j•••@example.com";

  it("says sent only when sent, and delivered only when delivered", () => {
    expect(deliveryText({ state: "sent", recipientMasked: masked }, "tickets", true).line).toBe(`Tickets sent to ${masked}.`);
    expect(deliveryText({ state: "delivered", recipientMasked: masked }, "tickets", true).line).toBe(`Tickets delivered to ${masked}.`);
    for (const state of ["pending", "sent", "failed", "bounced"] as const) {
      // Only a negative ("couldn't be delivered") may use the word before a verified delivery event.
      expect(deliveryText({ state, recipientMasked: masked }, "voucher", true).line).not.toMatch(/(?<!be )delivered/i);
    }
  });

  it("pending, failed and bounced say what to do, and point at the files on the page", () => {
    const pending = deliveryText({ state: "pending", recipientMasked: masked }, "voucher", true);
    expect(pending.line).toBe(`We're emailing your voucher to ${masked}.`);
    expect(pending.next).toContain("You can download it on this page.");
    expect(deliveryText({ state: "failed", recipientMasked: masked }, "tickets", true).line).toContain("Our team has been alerted.");
    const bounced = deliveryText({ state: "bounced", recipientMasked: masked }, "tickets", false);
    expect(bounced.line).toContain("the address rejected it");
    expect(bounced.next).toContain("Confirm it's you on this page to download them.");
    expect(bounced.tone).toBe("warning");
  });

  it("never prints an address the server did not mask", () => {
    expect(deliveryText({ state: "sent", recipientMasked: null }, "voucher", true).line).toBe("Voucher sent.");
  });

  it("the resend wait is a Dubai clock time", () => {
    expect(dubaiClock("2030-01-01T10:52:00.000Z")).toBe("14:52");
    const now = Date.parse("2030-01-01T10:44:00.000Z");
    expect(resendWaitText("2030-01-01T10:52:00.000Z", now)).toBe("You can ask again at 14:52 Dubai time.");
    // The 24-hour limit can move it to tomorrow: the day is named.
    expect(resendWaitText("2030-01-02T09:12:00.000Z", now)).toBe("You can ask again on Wed 2 Jan at 13:12 Dubai time.");
    expect(resendWaitText(null)).toBe("You can ask again a little later.");
    expect(dubaiClock("not a time")).toBe("");
  });
});

describe("date span (progress card label)", () => {
  it("one, two and several days, short, in order, without repeats", () => {
    expect(dateSpanText(["2030-01-15"])).toBe("Tue 15 Jan 2030");
    expect(dateSpanText(["2030-01-15", "2030-01-11", "2030-01-15"])).toBe("Fri 11 Jan and Tue 15 Jan 2030");
    expect(dateSpanText(["2030-01-15", "2030-01-11", "2030-01-12", "2030-01-13"])).toBe("Fri 11 Jan to Tue 15 Jan 2030");
    expect(dateSpanText(["2029-12-31", "2030-01-02"])).toBe("Mon 31 Dec 2029 and Wed 2 Jan 2030");
    expect(dateSpanText(["bad"])).toBe("");
  });
});
