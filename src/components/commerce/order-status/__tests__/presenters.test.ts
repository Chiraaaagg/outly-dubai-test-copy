import { describe, expect, it } from "vitest";
import { remedySentence } from "@/lib/customer-status";
import type {
  CancellationIneligibleReason,
  CancellationRequestStatus,
  CustomerDocument,
  CustomerItemStatus,
  CustomerOrderState,
  CustomerOrderStatus,
  CustomerStep,
} from "@/lib/customer-status";
import {
  INELIGIBLE_REASON_TEXT,
  STATE_LABEL,
  announcementFor,
  cancellationIsOpen,
  cancellationProgressText,
  documentLinkText,
  downloadableItems,
  formatMinor,
  ineligibleReasonText,
  lockedVoucherItems,
  nextPollDelay,
  pollDelay,
  remedyText,
  stateLabel,
  statusSignature,
  ticketStatusText,
  timelineRows,
  toneForState,
} from "../presenters";
import { retryAfterMs } from "@/lib/api/order-status";

/**
 * Customer words for the B5 projection. Synthetic values only. The copy
 * checks make sure the interim wording on the rebuilt pages promises no
 * fixed time (refund days, operator hours, "under a minute"): owner
 * question 2 is open, so those belong to the server's own sentences.
 */

const ALL_STATES: CustomerOrderState[] = [
  "awaiting_payment",
  "payment_processing",
  "booking_processing",
  "confirmed_ticket_pending",
  "confirmed",
  "partially_fulfilled",
  "payment_released",
  "refund_processing",
  "refunded",
  "payment_failed",
  "cancellation_processing",
  "cancelled",
  "needs_attention",
  "paid_confirmed_by_team",
  "completed",
];

const REASONS: CancellationIneligibleReason[] = [
  "past_deadline",
  "non_refundable",
  "tickets_issued",
  "activity_started",
  "not_supported",
  "payment_not_refundable",
];

const REQUEST_STATUSES: CancellationRequestStatus[] = [
  "requested",
  "cancelling",
  "cancel_unverified",
  "refund_pending",
  "refunded",
  "refused",
  "refund_failed",
  "exception_open",
  "exception_closed",
];

const TIMING_PROMISE = /\b\d+\s*(?:-|–)?\s*\d*\s*(?:working\s+)?(?:days?|hours?|minutes?|mins?)\b|under a minute|within/i;

function step(status: CustomerStep["status"], label = "Synthetic step"): CustomerStep {
  return { status, label, at: status === "not_started" ? null : "2026-11-07T14:00:00.000Z" };
}

function doc(id: string, kind: CustomerDocument["kind"] = "tickets_pdf", byteSize: number | null = 1_258_291): CustomerDocument {
  return { id, kind, version: 1, contentType: "application/pdf", byteSize, href: `/api/tickets/documents/${id}` };
}

describe("state vocabulary", () => {
  it("has a text label and a tone for every state", () => {
    for (const s of ALL_STATES) {
      expect(stateLabel(s)).toBe(STATE_LABEL[s]);
      expect(stateLabel(s).length).toBeGreaterThan(3);
      expect(["success", "progress", "warning", "danger", "neutral"]).toContain(toneForState(s));
    }
    expect(Object.keys(STATE_LABEL).sort()).toEqual([...ALL_STATES].sort());
  });

  it("never promises a time in a label", () => {
    for (const s of ALL_STATES) expect(stateLabel(s)).not.toMatch(TIMING_PROMISE);
  });

  it("marks a failed payment as danger and a confirmed one as success", () => {
    expect(toneForState("payment_failed")).toBe("danger");
    expect(toneForState("confirmed")).toBe("success");
    expect(toneForState("booking_processing")).toBe("progress");
    expect(toneForState("needs_attention")).toBe("warning");
  });
});

describe("timelineRows", () => {
  const steps: CustomerOrderStatus["steps"] = {
    payment: step("done", "Payment received"),
    booking: step("in_progress", "Confirming with the operator"),
    tickets: step("not_started", "Tickets come after confirmation"),
    refund: null,
  };

  it("orders payment, booking and tickets and states each in words", () => {
    const rows = timelineRows(steps);
    expect(rows.map((r) => r.key)).toEqual(["payment", "booking", "tickets"]);
    expect(rows.map((r) => r.statusText)).toEqual(["Done", "In progress", "Not started"]);
    expect(rows[0].step.label).toBe("Payment received");
  });

  it("adds the refund row only when one applies", () => {
    const rows = timelineRows({ ...steps, refund: step("in_progress", "Refund started") });
    expect(rows.map((r) => r.key)).toEqual(["payment", "booking", "tickets", "refund"]);
    expect(rows[3].title).toBe("Refund");
  });
});

describe("formatMinor", () => {
  it("formats minor units without float drift", () => {
    expect(formatMinor("1234500", "INR")).toBe("₹12,345");
    expect(formatMinor("56050", "AED")).toBe("AED 560.50");
    expect(formatMinor("5", "AED")).toBe("AED 0.05");
    expect(formatMinor("0", "INR")).toBe("₹0");
  });

  it("renders nothing for an unreadable amount", () => {
    expect(formatMinor("12.5", "INR")).toBe("");
    expect(formatMinor("abc", "AED")).toBe("");
  });
});

describe("ticket list text", () => {
  it("puts the file type and size in the link text", () => {
    const d = doc("d1");
    expect(documentLinkText(d, [d])).toEqual({ name: "Download tickets", file: "PDF, 1.2 MB" });
  });

  it("numbers several files of one kind and leaves a single other kind alone", () => {
    const a = doc("a");
    const b = doc("b", "tickets_pdf", 2048);
    const v = doc("v", "voucher_pdf", null);
    const all = [a, b, v];
    expect(documentLinkText(a, all).name).toBe("Download tickets, file 1 of 2");
    expect(documentLinkText(b, all)).toEqual({ name: "Download tickets, file 2 of 2", file: "PDF, 2 KB" });
    expect(documentLinkText(v, all)).toEqual({ name: "Download voucher", file: "PDF" });
  });

  it("describes each fulfilment state in a sentence", () => {
    expect(ticketStatusText({ fulfilment: "issued", documents: [doc("x")] })).toBe("Your voucher is ready. Download it and keep it with you on the day.");
    expect(ticketStatusText({ fulfilment: "ticket_pending", documents: [] })).toBe("Booked. Your voucher is being prepared.");
    // An item whose own booking is confirmed while the order still settles never says "Booked" (e2e, final run).
    expect(ticketStatusText({ fulfilment: "ticket_pending", documents: [] }, "booking_processing")).toBe("Your voucher will appear here once the operator confirms.");
    expect(ticketStatusText({ fulfilment: "ticket_pending", documents: [] }, "confirmed")).toBe("Booked. Your voucher is being prepared.");
    expect(ticketStatusText({ fulfilment: "attention", documents: [] })).toMatch(/team has been alerted/);
    expect(ticketStatusText({ fulfilment: "not_applicable", documents: [] }, "confirmed")).toMatch(/no ticket files/);
  });

  it("never says a hidden voucher 'will appear here' (CO-02)", () => {
    const hidden = ticketStatusText({ fulfilment: "issued", documents: [] }, "confirmed", false);
    expect(hidden).toBe("Your voucher is ready. To keep it private, confirm it's you.");
    expect(hidden).not.toMatch(/will appear here|not ready/);
    // A viewer who may download, with no file listed yet: the file is still being prepared.
    expect(ticketStatusText({ fulfilment: "issued", documents: [] }, "confirmed", true)).toMatch(/being prepared/);
  });

  it("never says there are no ticket files before the operator has confirmed (CO-15)", () => {
    for (const st of ["awaiting_payment", "payment_processing", "booking_processing"] as const) {
      expect(ticketStatusText({ fulfilment: "not_applicable", documents: [] }, st)).toBe("Your voucher will appear here once the operator confirms.");
    }
    expect(ticketStatusText({ fulfilment: "not_applicable", documents: [] }, "refunded")).toBe("There is no voucher for this activity.");
  });

  it("finds the items to unlock and the items to download (CO-02)", () => {
    const item = (id: string, fulfilment: CustomerItemStatus["tickets"]["fulfilment"], docs: CustomerDocument[]): CustomerItemStatus => ({
      orderItemId: id,
      title: id,
      serviceDate: "2030-01-15",
      timeslot: null,
      paxLabel: "1 adult",
      state: "confirmed",
      tickets: { fulfilment, documents: docs },
      refundUntilUtc: null,
      cancellation: { kind: "none" },
    });
    const items = [item("a", "issued", []), item("b", "ticket_pending", []), item("c", "issued", [doc("c1")])];
    expect(lockedVoucherItems({ items, canDownload: false }).map((i) => i.orderItemId)).toEqual(["a"]);
    // An authorised viewer never gets the unlock, whatever the files say.
    expect(lockedVoucherItems({ items, canDownload: true })).toEqual([]);
    expect(lockedVoucherItems({ items })).toEqual([]);
    expect(downloadableItems({ items }).map((i) => i.orderItemId)).toEqual(["c"]);
  });
});

describe("cancellation text", () => {
  it("has an honest reason sentence for every ineligible reason", () => {
    for (const r of REASONS) {
      expect(ineligibleReasonText(r)).toBe(INELIGIBLE_REASON_TEXT[r]);
      expect(ineligibleReasonText(r)).not.toMatch(TIMING_PROMISE);
    }
  });

  it("describes every request status without promising a time", () => {
    for (const s of REQUEST_STATUSES) {
      for (const k of ["supported", "exception"] as const) {
        const text = cancellationProgressText(s, k);
        expect(text.length).toBeGreaterThan(10);
        expect(text).not.toMatch(TIMING_PROMISE);
      }
    }
  });

  it("does not call an unverified cancellation done", () => {
    expect(cancellationProgressText("cancel_unverified", "supported")).toMatch(/waiting for them to confirm/);
    expect(cancellationProgressText("cancel_unverified", "supported")).not.toMatch(/has cancelled/);
  });

  it("treats only still-moving requests as open", () => {
    const at = "2026-11-02T10:00:00.000Z";
    expect(cancellationIsOpen({ kind: "requested", status: "cancelling", requestKind: "supported", requestedAt: at, updatedAt: at })).toBe(true);
    expect(cancellationIsOpen({ kind: "requested", status: "refunded", requestKind: "supported", requestedAt: at, updatedAt: at })).toBe(false);
    expect(cancellationIsOpen({ kind: "none" })).toBe(false);
  });
});

describe("live updates", () => {
  it("announces a change of state once and stays silent otherwise", () => {
    const before = { state: "booking_processing" as const, headline: "Payment received. We're booking your cruise with the operator." };
    const same = { state: "booking_processing" as const, headline: "Payment received. We're booking your cruise with the operator." };
    const next = { state: "confirmed" as const, headline: "Your cruise is booked." };
    expect(announcementFor(before, same)).toBeNull();
    expect(announcementFor(null, next)).toBeNull();
    expect(announcementFor(before, next)).toBe("Status updated: Your cruise is booked.");
  });

  it("new words in the same state are announced (an unknown capture resolving)", () => {
    const unsure = { state: "payment_processing" as const, headline: "We're still confirming your payment with the bank." };
    const paid = { state: "payment_processing" as const, headline: "Payment received. We're booking your cruise with the operator." };
    expect(announcementFor(unsure, paid)).toBe("Status updated: Payment received. We're booking your cruise with the operator.");
  });

  it("names the remedy only when the projection does (TKT-8), in the projection's own sentence (follow-up 3)", () => {
    // One sentence for a release and a refund: the box beside the time never contradicts the status text.
    expect(remedyText("release")).toBe(remedyText("refund"));
    expect(remedyText("release")).toBe(remedySentence("then", false));
    expect(remedyText("refund")).toBe("If the operator hasn't confirmed your booking by then, you get the full amount back automatically, as a released hold or a refund.");
    // Several activities: only the activity not confirmed comes back, never "the whole payment".
    expect(remedyText("refund", true)).toBe("If the operator hasn't confirmed an activity by then, you get its amount back automatically.");
    expect(remedyText(null)).toBeNull();
  });

  it("a new state with the same words is not announced (CO-14)", () => {
    const paid = { state: "payment_processing" as const, headline: "Payment received. We're booking your cruise with the operator." };
    const booking = { state: "booking_processing" as const, headline: "Payment received. We're booking your cruise with the operator." };
    expect(announcementFor(paid, booking)).toBeNull();
  });

  it("announces an item's voucher becoming ready even when the order state stays the same (CO-09)", () => {
    const tickets = (fulfilment: CustomerItemStatus["tickets"]["fulfilment"]) => ({ fulfilment, documents: [] });
    const base = { orderItemId: "i1", title: "Dinner cruise", serviceDate: "2030-01-15", timeslot: null, paxLabel: "1 adult", state: "partially_fulfilled" as const, refundUntilUtc: null, cancellation: { kind: "none" as const } };
    const before = { state: "partially_fulfilled" as const, headline: "Part of your order is booked.", items: [{ ...base, tickets: tickets("ticket_pending") }] };
    const after = { ...before, items: [{ ...base, tickets: tickets("issued") }] };
    expect(announcementFor(before, after)).toBe("Dinner cruise: voucher ready.");
    expect(announcementFor(after, after)).toBeNull();
  });

  it("backs off after failures and caps the delay", () => {
    expect(nextPollDelay(5_000, 0)).toBe(5_000);
    expect(nextPollDelay(5_000, 1)).toBe(10_000);
    expect(nextPollDelay(5_000, 10)).toBe(60_000);
    expect(nextPollDelay(100, 0)).toBe(2_000);
  });

  it("polls at the server's cadence for two minutes after a change, then at least 15 s, then at least 30 s (CO-09)", () => {
    expect(pollDelay(5_000, 0, 0)).toBe(5_000);
    expect(pollDelay(5_000, 0, 119_000)).toBe(5_000);
    expect(pollDelay(5_000, 0, 2 * 60_000)).toBe(15_000);
    expect(pollDelay(5_000, 0, 10 * 60_000)).toBe(30_000);
    // Never faster than the server asks, and failures still double it up to a minute.
    expect(pollDelay(60_000, 0, 0)).toBe(60_000);
    expect(pollDelay(5_000, 1, 10 * 60_000)).toBe(60_000);
    expect(pollDelay(5_000, 1, 0)).toBe(10_000);
  });

  it("review fix 6: after a 429 it waits at least Retry-After, and jitter only ever makes it later, by at most 20%", () => {
    expect(pollDelay(5_000, 1, 0, { retryAfterMs: 45_000 })).toBe(45_000);
    expect(pollDelay(5_000, 1, 0, { retryAfterMs: 1_000 })).toBe(10_000);
    expect(pollDelay(5_000, 0, 0, { random: 0 })).toBe(5_000);
    expect(pollDelay(5_000, 0, 0, { random: 0.5 })).toBe(5_500);
    expect(pollDelay(5_000, 0, 0, { random: 1 })).toBe(6_000);
    expect(pollDelay(5_000, 0, 0, { random: 7 })).toBe(6_000);
    expect(pollDelay(5_000, 0, 0, { random: -1 })).toBe(5_000);
  });

  it("Retry-After: whole seconds only, bounded to five minutes", () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs(" 2 ")).toBe(2_000);
    expect(retryAfterMs("99999")).toBe(300_000);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT")).toBeUndefined();
    expect(retryAfterMs("-5")).toBeUndefined();
  });

  it("the change signature moves with the state, the stamps, an item's state and its vouchers, and nothing else", () => {
    const base = { state: "confirmed_ticket_pending" as const, updatedAt: "2030-01-10T08:00:00.000Z", headline: "Booked." };
    const item = { orderItemId: "i1", state: "confirmed_ticket_pending" as const, tickets: { fulfilment: "ticket_pending" as const, documents: [] as Array<{ id: string; version: number }> } };
    const a = statusSignature({ ...base, items: [item] } as never);
    expect(statusSignature({ ...base, items: [item] } as never)).toBe(a);
    expect(statusSignature({ ...base, updatedAt: "2030-01-10T08:00:05.000Z", items: [item] } as never)).not.toBe(a);
    expect(statusSignature({ ...base, items: [{ ...item, tickets: { fulfilment: "issued", documents: [{ id: "d1", version: 1 }] } }] } as never)).not.toBe(a);
  });

});
