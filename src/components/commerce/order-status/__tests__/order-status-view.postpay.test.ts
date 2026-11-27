import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CustomerDocument, CustomerItemStatus, CustomerOrderStatus, TicketDeliveryView } from "@/lib/customer-status";
import { OrderStatusView } from "../order-status-view";

/**
 * Post-payment batch A on the status page, as the server renders it: a card
 * per booked item (A5), the progress card while waiting (A6), the ticket
 * email and resend (A3/A4), tickets or voucher (A7). Synthetic values only; no
 * network (effects do not run in a server render).
 */

const docOf = (id: string, kind: CustomerDocument["kind"] = "voucher_pdf"): CustomerDocument => ({
  id: `0190a000-0000-7000-8000-00000000d0${id}`,
  kind,
  version: 1,
  contentType: "application/pdf",
  byteSize: 48_000,
  href: `/api/tickets/documents/0190a000-0000-7000-8000-00000000d0${id}`,
});

function item(over: Partial<CustomerItemStatus> = {}): CustomerItemStatus {
  return {
    orderItemId: "0190a000-0000-7000-8000-0000000000a1",
    title: "Dhow cruise dinner",
    serviceDate: "2030-01-15",
    timeslot: "21:00",
    paxLabel: "1 adult",
    state: "confirmed",
    tickets: { fulfilment: "issued", documents: [] },
    refundUntilUtc: null,
    cancellationTerms: null,
    cancellation: { kind: "none" },
    ...over,
  };
}

function status(over: Partial<CustomerOrderStatus> = {}): CustomerOrderStatus {
  return {
    reference: "OUT-00000001",
    state: "confirmed",
    tone: "success",
    headline: "Your activities are booked.",
    nextStep: "Your vouchers are ready to download.",
    rail: "self_serve",
    currency: "AED",
    totalMinor: "45800",
    placedAt: "2030-01-01T10:00:00.000Z",
    updatedAt: "2030-01-01T10:43:00.000Z",
    steps: {
      payment: { status: "done", label: "Payment received", at: "2030-01-01T10:01:00.000Z" },
      booking: { status: "done", label: "Booked with the operator", at: "2030-01-01T10:41:00.000Z" },
      tickets: { status: "done", label: "Voucher ready", at: "2030-01-01T10:43:00.000Z" },
      refund: null,
    },
    deadlines: { refundUntilUtc: null, remedyAtUtc: null, remedyKind: null },
    items: [
      item({ orderItemId: "a", title: "Dhow cruise dinner", tickets: { fulfilment: "issued", documents: [docOf("01")] } }),
      item({ orderItemId: "b", title: "Desert safari", timeslot: "15:00", tickets: { fulfilment: "issued", documents: [docOf("02")] } }),
    ],
    canDownload: true,
    pollAfterMs: null,
    ...over,
  };
}

const render = (s: CustomerOrderStatus) => renderToStaticMarkup(h(OrderStatusView, { initial: s }));

describe("one ticket card per booked item (A5)", () => {
  it("two booked items: two cards under one h2, each an h3 with its own download, in a list", () => {
    const html = render(status());
    expect(html.match(/data-testid="booking-confirmation"/g)).toHaveLength(1);
    expect(html.match(/data-testid="ticket-card"/g)).toHaveLength(2);
    expect(html).toContain(">Confirmed activities</h2>");
    expect(html).toMatch(/<h3[^>]*>Dhow cruise dinner<\/h3>/);
    expect(html).toMatch(/<h3[^>]*>Desert safari<\/h3>/);
    // Short visible labels (they never wrap past the key on a phone), distinct accessible names.
    expect(html).toMatch(/Download voucher<span class="sr-only">: (<!-- -->)?Dhow cruise dinner<\/span>/);
    expect(html).toMatch(/Download voucher<span class="sr-only">: (<!-- -->)?Desert safari<\/span>/);
    // No per-item price exists: no "Paid" cell on a multi-item order's cards.
    expect(html).not.toContain(">Paid</p>");
    // One h1 only.
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("the confirmation time is the order's, so a multi-item card does not claim it per item", () => {
    const html = render(status());
    expect(html).not.toContain("Confirmed by the operator at");
    expect(html).toContain("Confirmed by the operator.");
  });

  it("an item still being prepared says so in its card; an item in attention says the team is on it", () => {
    const html = render(
      status({
        state: "confirmed_ticket_pending",
        pollAfterMs: 5_000,
        items: [
          item({ orderItemId: "a", state: "confirmed_ticket_pending", tickets: { fulfilment: "ticket_pending", documents: [] } }),
          item({ orderItemId: "b", title: "Desert safari", tickets: { fulfilment: "attention", documents: [] } }),
        ],
      }),
    );
    expect(html).toContain("Your voucher is being prepared. It appears here when ready.");
    expect(html).toContain("We&#x27;re having trouble getting your voucher from the operator. Our team is on it.");
  });

  it("a tickets item and a voucher item use their own words", () => {
    const html = render(
      status({
        items: [
          item({ orderItemId: "a", tickets: { fulfilment: "issued", documents: [docOf("01")] } }),
          item({
            orderItemId: "b",
            title: "Synthetic park",
            timeslot: null,
            ticket: { validUntil: "2030-07-16", validityCopy: "Valid until 16 July 2030.", nonRefundableCopy: "Non-refundable once issued.", types: [] },
            tickets: { fulfilment: "issued", documents: [docOf("02", "tickets_pdf")] },
          }),
        ],
      }),
    );
    expect(html).toMatch(/Download tickets<span class="sr-only">: (<!-- -->)?Synthetic park<\/span>/);
    expect(html).toContain("Show the tickets PDF at the entrance.");
    expect(html).toMatch(/<h4[^>]*>Tickets<\/h4>/);
    expect(html).toMatch(/<h4[^>]*>Voucher<\/h4>/);
  });

  it("several cards stack in one column on phones", () => {
    expect(render(status())).toContain("grid grid-cols-1 items-start gap-6");
  });
});

describe("progress card while waiting (A6)", () => {
  const waiting = (over: Partial<CustomerOrderStatus> = {}) =>
    status({
      state: "booking_processing",
      tone: "progress",
      headline: "Payment received. We're booking your 2 activities with the operator.",
      pollAfterMs: 5_000,
      steps: {
        payment: { status: "done", label: "Payment received", at: "2030-01-01T10:01:00.000Z" },
        booking: { status: "in_progress", label: "Confirming with the operator", at: null },
        tickets: { status: "not_started", label: "Follows the operator's confirmation", at: null },
        refund: null,
      },
      items: [
        item({ orderItemId: "a", state: "booking_processing", tickets: { fulfilment: "not_applicable", documents: [] } }),
        item({ orderItemId: "b", title: "Desert safari", state: "booking_processing", tickets: { fulfilment: "not_applicable", documents: [] } }),
      ],
      ...over,
    });

  it("replaces the item and progress cards, with the reference, the activity and the milestones", () => {
    const html = render(waiting());
    expect(html).toContain('data-testid="booking-progress"');
    expect(html).toContain(">Booking progress</h2>");
    expect(html).not.toContain(">Your activities</h2>");
    expect(html).toContain("OUT-00000001");
    expect(html).toContain("2 activities");
    // A multi-item order keeps its payment row, with its time.
    expect(html).toContain('data-milestone="payment" data-state="done"');
    expect(html).toContain("14:01 Dubai time");
    expect(html).toContain('data-milestone="operator" data-state="current"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Now: <span");
    expect(html).toContain('data-testid="progress-bar"');
  });

  it("has no percentage, countdown, rate, pause, cancel or security claim", () => {
    const card = render(waiting()).match(/<section[^>]*data-testid="booking-progress"[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(card).not.toBe("");
    expect(card).not.toMatch(/%|remaining|estimated|rate|Pause|Cancel|encrypted|secure/i);
    // Not a second live region.
    expect(card).not.toContain("aria-live");
    expect(card).not.toContain('role="status"');
  });

  it("the bar is decorative and only runs while the page is still checking", () => {
    const html = render(waiting());
    expect(html).toMatch(/data-testid="progress-bar"[^>]*>|aria-hidden="true" data-testid="progress-bar"/);
    expect(render(waiting({ pollAfterMs: null }))).not.toContain('data-testid="progress-bar"');
  });

  it("is not shown once the booking has settled", () => {
    expect(render(status())).not.toContain('data-testid="booking-progress"');
    expect(render(status({ state: "refunded", items: [item({ state: "refunded", tickets: { fulfilment: "not_applicable", documents: [] } })] }))).not.toContain(
      'data-testid="booking-progress"',
    );
  });

  it("checking the payment: the first milestone is current", () => {
    const html = render(
      waiting({
        state: "awaiting_payment",
        steps: {
          payment: { status: "in_progress", label: "Waiting for Stripe to confirm", at: null },
          booking: { status: "not_started", label: "", at: null },
          tickets: { status: "not_started", label: "", at: null },
          refund: null,
        },
      }),
    );
    expect(html).toContain('data-milestone="payment" data-state="current"');
    expect(html).toContain("Checking your payment");
  });
});

describe("the ticket email (A3) and resend (A4)", () => {
  const delivery = (over: Partial<TicketDeliveryView> = {}): TicketDeliveryView => ({
    channel: "email",
    state: "sent",
    recipientMasked: "j•••@example.com",
    at: "2030-01-01T10:44:00.000Z",
    canResend: true,
    resendAvailableAt: null,
    ...over,
  });

  it("sent: 'sent to' the masked address, with the time, and the resend button", () => {
    const html = render(status({ delivery: delivery() }));
    expect(html).toContain("Vouchers sent to j•••@example.com.");
    expect(html).toContain("14:44 Dubai time");
    expect(html).toContain('data-testid="resend-tickets"');
    expect(html).toContain("Email my vouchers again");
    expect(html).not.toMatch(/delivered/i);
  });

  it("delivered only for the delivered state", () => {
    expect(render(status({ delivery: delivery({ state: "delivered" }) }))).toContain("Vouchers delivered to j•••@example.com.");
  });

  it("pending and failed keep the downloads on the page and say what to do", () => {
    const pending = render(status({ delivery: delivery({ state: "pending", at: null }) }));
    expect(pending).toContain("We&#x27;re emailing your vouchers to j•••@example.com.");
    expect(pending).toContain('data-testid="ticket-card-download"');
    const failed = render(status({ delivery: delivery({ state: "failed" }) }));
    expect(failed).toContain("We couldn&#x27;t email your vouchers");
    expect(failed).toContain('data-testid="ticket-card-download"');
  });

  it("limited: the button is disabled and says when it opens again, in Dubai time", () => {
    const html = render(status({ delivery: delivery({ canResend: false, resendAvailableAt: "2030-01-01T10:52:00.000Z" }) }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="resend-tickets"|<button[^>]*data-testid="resend-tickets"[^>]*disabled=""/);
    expect(html).toMatch(/You can ask again (on Tue 1 Jan )?at 14:52 Dubai time\./);
  });

  it("not allowed and no time (no access, nothing to send): no button", () => {
    expect(render(status({ delivery: delivery({ canResend: false, resendAvailableAt: null }) }))).not.toContain('data-testid="resend-tickets"');
  });

  it("no delivery (no email on the order, or nothing sent): nothing is promised", () => {
    const html = render(status({ delivery: null }));
    expect(html).not.toContain('data-testid="ticket-delivery"');
    expect(html).not.toMatch(/sent to|emailing your/i);
  });

  it("a tickets order says tickets", () => {
    const html = render(
      status({
        delivery: delivery(),
        items: [item({ timeslot: null, ticket: { validUntil: null, validityCopy: null, nonRefundableCopy: "Non-refundable.", types: [] }, tickets: { fulfilment: "issued", documents: [docOf("01", "tickets_pdf")] } })],
      }),
    );
    expect(html).toContain("Tickets sent to j•••@example.com.");
    expect(html).toContain("Email my tickets again");
  });
});
