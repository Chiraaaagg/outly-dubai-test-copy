import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CustomerItemStatus, CustomerOrderStatus } from "@/lib/customer-status";
import { OrderStatusView } from "../order-status-view";

/**
 * The booking status page after batch 2 (review fix 13): what the server
 * render shows for each projection. Synthetic values; no network (effects do
 * not run in a server render).
 */

const DOC_HREF = "/api/tickets/documents/0190a000-0000-7000-8000-00000000d0c1";

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

const doc = { id: "0190a000-0000-7000-8000-00000000d0c1", kind: "voucher_pdf" as const, version: 1, contentType: "application/pdf", byteSize: 48_000, href: DOC_HREF };

function status(over: Partial<CustomerOrderStatus> = {}): CustomerOrderStatus {
  return {
    reference: "OUT-00000001",
    state: "confirmed",
    tone: "success",
    headline: "Your Dhow cruise dinner is booked.",
    nextStep: "Your voucher is ready to download.",
    rail: "self_serve",
    currency: "AED",
    totalMinor: "22900",
    placedAt: "2030-01-01T10:00:00.000Z",
    updatedAt: "2030-01-01T10:43:00.000Z",
    steps: {
      payment: { status: "done", label: "Payment received", at: "2030-01-01T10:01:00.000Z" },
      booking: { status: "done", label: "Booked with the operator", at: "2030-01-01T10:41:00.000Z" },
      tickets: { status: "done", label: "Voucher ready", at: "2030-01-01T10:43:00.000Z" },
      refund: null,
    },
    deadlines: { refundUntilUtc: null, remedyAtUtc: null, remedyKind: null },
    items: [item({ tickets: { fulfilment: "issued", documents: [doc] } })],
    canDownload: true,
    pollAfterMs: null,
    ...over,
  };
}

const render = (s: CustomerOrderStatus) => renderToStaticMarkup(h(OrderStatusView, { initial: s }));

describe("OrderStatusView: download access", () => {
  it("authorised and ready: a real link to the document, one per document", () => {
    const html = render(status());
    expect(html).toContain('data-testid="voucher-actions"');
    const links = html.match(/<a [^>]*data-slot="download-button"[^>]*>/g) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain(`href="${DOC_HREF}"`);
    expect(links[0]).not.toContain("download=");
  });

  it("not authorised (canDownload false): no download link and no document URL, the code unlock instead", () => {
    const html = render(status({ canDownload: false, items: [item({ tickets: { fulfilment: "issued", documents: [] } })] }));
    expect(html).not.toContain('data-testid="voucher-actions"');
    expect(html).not.toContain("/api/tickets/documents/");
    expect(html).toContain("Send me a code");
    // Channel-neutral while codes may go by email (doc 29 §8.4 row 10).
    expect(html).not.toContain("Text me a code");
    expect(html).toContain("mobile number or email you booked with");
  });
});

describe("OrderStatusView: confirmation card", () => {
  it("a confirmed single item with a start time shows it, with the meeting-point line once the voucher is listed", () => {
    const html = render(status());
    expect(html).toContain('data-testid="booking-confirmation"');
    expect(html).toContain("Show the voucher PDF at the meeting point");
    expect(html).not.toContain("jetty");
    expect(html).not.toContain("Barcode for value");
  });

  it("booked but the voucher not listed: the card, without the voucher line", () => {
    const html = render(
      status({ state: "confirmed_ticket_pending", items: [item({ state: "confirmed_ticket_pending", tickets: { fulfilment: "ticket_pending", documents: [] } })] }),
    );
    expect(html).toContain('data-testid="booking-confirmation"');
    expect(html).not.toContain("Show the voucher PDF");
  });

  it.each(["awaiting_payment", "payment_processing", "booking_processing", "needs_attention", "refunded"] as const)("not shown while %s", (state) => {
    const html = render(status({ state, items: [item({ state, tickets: { fulfilment: "not_applicable", documents: [] } })] }));
    expect(html).not.toContain('data-testid="booking-confirmation"');
  });

  it("not shown without a start time, rather than printing 00:00", () => {
    expect(render(status({ items: [item({ timeslot: null, tickets: { fulfilment: "issued", documents: [doc] } })] }))).not.toContain(
      'data-testid="booking-confirmation"',
    );
  });
});

describe("OrderStatusView: tracker", () => {
  it("single item: neutral row names with the state in words, never a done-sounding name beside a state that is not done", () => {
    const html = render(
      status({
        state: "booking_processing",
        steps: {
          payment: { status: "done", label: "Payment received", at: null },
          booking: { status: "in_progress", label: "", at: null },
          tickets: { status: "not_started", label: "", at: null },
          refund: null,
        },
        items: [item({ state: "booking_processing", tickets: { fulfilment: "not_applicable", documents: [] } })],
      }),
    );
    expect(html).toMatch(/>Payment<\/p>/);
    expect(html).toMatch(/>Booking with the operator<\/p>/);
    expect(html).toMatch(/>Voucher<\/p>/);
    expect(html).toContain(">Not started</p>");
    expect(html).not.toContain("Voucher ready</p>");
    // The headline is visible in the server render (no opacity 0 from the entrance).
    expect(html).not.toMatch(/style="opacity:0/);
  });

  it("several items: one row per activity with its own state, including a partial outcome", () => {
    const html = render(
      status({
        state: "partially_fulfilled",
        headline: "Part of your order is booked.",
        items: [
          item({ orderItemId: "a", title: "Dhow cruise dinner", state: "confirmed", tickets: { fulfilment: "issued", documents: [] } }),
          item({ orderItemId: "b", title: "Desert safari", state: "refund_processing", tickets: { fulfilment: "not_applicable", documents: [] } }),
        ],
      }),
    );
    expect(html).toContain("Your activities</h2>");
    expect(html).toContain("2 activities");
    expect(html).toMatch(/>Dhow cruise dinner<\/p><p[^>]*>[^<]+<\/p>/);
    expect(html).toMatch(/>Desert safari<\/p><p[^>]*>[^<]+<\/p>/);
    expect(html).not.toContain('data-testid="booking-confirmation"');
  });

  it("an unreadable total does not throw", () => {
    expect(() => render(status({ totalMinor: "not-a-number" }))).not.toThrow();
  });
});

describe("OrderStatusView: unreadable amount (follow-up C)", () => {
  it("hides the price and the confirmation card instead of printing 0.00", () => {
    const html = render(status({ totalMinor: "not-a-number" }));
    expect(html).not.toContain("AED 0.00");
    expect(html).not.toContain('data-testid="booking-confirmation"');
  });
});
