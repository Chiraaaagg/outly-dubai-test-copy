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
  it("authorised and ready: a real link to the document in the item's card, offered once", () => {
    const html = render(status());
    // A5: a booked item's file is in its own card; the top block is for items without a card.
    expect(html).not.toContain('data-testid="voucher-actions"');
    expect(html).toContain('data-testid="ticket-card-download"');
    const links = html.match(/<a [^>]*data-slot="download-button"[^>]*>/g) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain(`href="${DOC_HREF}"`);
    expect(links[0]).not.toContain("download=");
    // The item list does not repeat the same link.
    expect(html.match(new RegExp(`href="${DOC_HREF}"`, "g"))).toHaveLength(1);
  });

  it("an item without a card (completed) keeps its download in the top block", () => {
    const html = render(status({ state: "completed", items: [item({ state: "completed", tickets: { fulfilment: "issued", documents: [doc] } })] }));
    expect(html).toContain('data-testid="voucher-actions"');
    expect(html).not.toContain('data-testid="ticket-card"');
  });

  it("not authorised (canDownload false): no download link and no document URL, the code unlock instead", () => {
    const html = render(status({ canDownload: false, items: [item({ tickets: { fulfilment: "issued", documents: [] } })] }));
    expect(html).not.toContain('data-testid="voucher-actions"');
    expect(html).not.toContain("/api/tickets/documents/");
    expect(html).toContain("Send me a code");
    expect(html).not.toContain("Text me a code");
  });
});

describe("OrderStatusView: honest unlock (A1)", () => {
  const lockedStatus = (unlockChannels?: ("email" | "phone")[]) =>
    status({ canDownload: false, unlockChannels, items: [item({ tickets: { fulfilment: "issued", documents: [] } })] });

  it("an order verified by email: the code goes to the email, and the page says so", () => {
    const html = render(lockedStatus(["email"]));
    expect(html).toContain("Send me a code");
    expect(html).toContain("We&#x27;ll email a 6-digit code to the address you booked with.");
    expect(html).not.toMatch(/text a 6-digit code|phone number you booked with/);
  });

  it("an order verified by phone, while texts work: the page names the phone", () => {
    expect(render(lockedStatus(["phone"]))).toContain("We&#x27;ll text a 6-digit code to the phone number you booked with.");
  });

  it("no channel can deliver a code now: no code button, the emailed link and support instead", () => {
    const html = render(lockedStatus([]));
    expect(html).not.toContain("Send me a code");
    expect(html).toContain("open this booking from the link in the email we sent you");
    expect(html).toContain("Message us on WhatsApp");
  });

  it("an older projection without the field: email only, never a phone code", () => {
    const html = render(lockedStatus(undefined));
    expect(html).toContain("We&#x27;ll email a 6-digit code");
    expect(html).not.toContain("text a 6-digit code");
  });

  it("the card says the file is ready but locked, and points to the unlock", () => {
    const html = render(lockedStatus(["email"]));
    expect(html).toContain("Your voucher is ready. Confirm it&#x27;s you above to download it.");
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

  it("without a start time: the date-only card, never 00:00", () => {
    const html = render(status({ items: [item({ timeslot: null, tickets: { fulfilment: "issued", documents: [doc] } })] }));
    expect(html).toContain('data-testid="booking-confirmation"');
    expect(html).toContain('data-variant="date_only"');
    const card = html.slice(html.indexOf('data-testid="ticket-card"'), html.indexOf("items-heading"));
    expect(card).not.toContain("00:00");
    expect(card).not.toContain("When (Dubai time)");
  });

  it("a free-text time (an agent's '21:00 sailing') falls back to the date, with the time as given", () => {
    const html = render(status({ items: [item({ timeslot: "21:00 sailing", tickets: { fulfilment: "issued", documents: [doc] } })] }));
    expect(html).toContain('data-variant="date_only"');
    expect(html).toContain("21:00 sailing");
  });

  it("names a known pickup in the card instead of 'where to go is on your voucher'", () => {
    const html = render(status({ items: [item({ pickup: { time: "16:30", hotel: "Synthetic Marina Hotel" }, tickets: { fulfilment: "issued", documents: [doc] } })] }));
    const card = html.slice(html.indexOf('data-testid="ticket-card"'), html.indexOf("items-heading"));
    expect(card).toContain("Pickup at");
    expect(card).toContain("16:30");
    expect(card).toContain("Synthetic Marina Hotel");
    expect(card).toContain("Have the voucher PDF ready at pickup.");
    expect(card).not.toContain("Where to go is on your voucher.");
  });

  it("a single-item order shows its total on the card", () => {
    expect(render(status())).toContain(">Paid</p>");
  });
});

describe("OrderStatusView: tracker", () => {
  it("single item, booked: neutral row names with the state in words", () => {
    const html = render(status());
    expect(html).toMatch(/>Payment<\/p>/);
    expect(html).toMatch(/>Booking with the operator<\/p>/);
    expect(html).toMatch(/>Voucher<\/p>/);
    expect(html).not.toContain('data-testid="booking-progress"');
    // The headline is visible in the server render (no opacity 0 from the entrance).
    expect(html).not.toMatch(/style="opacity:0/);
  });

  it("an open-dated tickets order names its row Tickets (A7)", () => {
    const html = render(
      status({ items: [item({ timeslot: null, ticket: { validUntil: null, validityCopy: null, nonRefundableCopy: "Non-refundable.", types: [] }, tickets: { fulfilment: "issued", documents: [{ ...doc, kind: "tickets_pdf" }] } })] }),
    );
    expect(html).toMatch(/>Tickets<\/p>/);
    expect(html).toMatch(/<h4[^>]*>Tickets<\/h4>/);
    expect(html).not.toMatch(/>Voucher<\/(p|h4)>/);
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
    // A5: the booked item gets its card; the refunding one does not.
    expect(html).toContain('data-testid="booking-confirmation"');
    expect(html.match(/data-testid="ticket-card"/g)).toHaveLength(1);
    expect(html).toContain('data-item-id="a"');
    expect(html).not.toContain('data-item-id="b"');
  });

  it("an unreadable total does not throw", () => {
    expect(() => render(status({ totalMinor: "not-a-number" }))).not.toThrow();
  });
});

describe("OrderStatusView: unreadable amount (follow-up C)", () => {
  it("hides the price instead of printing 0.00; the card stays, without its Paid cell", () => {
    const html = render(status({ totalMinor: "not-a-number" }));
    expect(html).not.toContain("AED 0.00");
    expect(html).toContain('data-testid="booking-confirmation"');
    expect(html).not.toContain(">Paid</p>");
  });
});

describe("OrderStatusView: open-dated tickets (doc 29 Batch 5)", () => {
  const ticketDoc = { ...doc, kind: "tickets_pdf" as const };
  const ticket = {
    validUntil: "2030-07-16",
    validityCopy: "Ticket valid until Tuesday, 16 July 2030.",
    nonRefundableCopy: "These tickets are non-refundable once issued.",
    types: [
      { label: "Park A (adult)", count: 2 },
      { label: "Park B (adult)", count: 2 },
    ],
  };
  const ticketItem = (over: Partial<CustomerItemStatus> = {}) =>
    item({
      title: "Synthetic attraction",
      timeslot: null,
      paxLabel: "2 adults",
      cancellationTerms: ticket.nonRefundableCopy,
      cancellation: { kind: "not_eligible", reason: "tickets_issued", exceptionAllowed: true },
      ticket,
      tickets: { fulfilment: "issued", documents: [ticketDoc] },
      ...over,
    });

  it("the ticket card shows the visit date without a time, the validity, each ticket type, non-refundable once issued and the secure download", () => {
    const html = render(status({ items: [ticketItem()] }));
    expect(html).toContain('data-testid="booking-confirmation"');
    expect(html).toContain("Visit date");
    expect(html).not.toContain("When (Dubai time)");
    expect(html).toContain("Ticket valid until Tuesday, 16 July 2030.");
    expect(html).toContain("Park A (adult) × 2");
    expect(html).toContain("Park B (adult) × 2");
    expect((html.match(/These tickets are non-refundable once issued\./g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('data-testid="ticket-card-download"');
    expect(html).toContain("Download tickets");
    // The download goes through the access-checked document route only.
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => h.includes("/api/tickets/"));
    expect(new Set(hrefs)).toEqual(new Set([DOC_HREF]));
  });

  it("not authorised: the card shows no download and no document URL; the code unlock instead", () => {
    const html = render(status({ canDownload: false, items: [ticketItem({ tickets: { fulfilment: "issued", documents: [] } })] }));
    expect(html).toContain('data-testid="booking-confirmation"');
    expect(html).not.toContain('data-testid="ticket-card-download"');
    expect(html).not.toContain("/api/tickets/documents/");
    expect(html).toContain("These tickets are non-refundable once issued.");
  });

  it("a voucher booking keeps the voucher card and label", () => {
    const html = render(status());
    expect(html).toContain("Download voucher");
    expect(html).not.toContain("Visit date");
    expect(html).not.toContain("non-refundable once issued");
  });
});

describe("OrderStatusView: an external supplier's booking (doc 29 Batch 6)", () => {
  const statement = "This operator confirms bookings through their own system, so confirmation can take a few minutes after you pay.";

  it("shows the item's confirmation statement while waiting, with no download before the operator confirms", () => {
    const html = render(
      status({
        state: "booking_processing",
        tone: "progress",
        headline: "Payment received. We're booking your Dhow cruise dinner with the operator.",
        nextStep: "This operator confirms through their own system, so it can take a few minutes. This page updates by itself.",
        steps: {
          payment: { status: "done", label: "Payment received", at: "2030-01-01T10:01:00.000Z" },
          booking: { status: "in_progress", label: "Confirming with the operator", at: null },
          tickets: { status: "not_started", label: "Follows the operator's confirmation", at: null },
          refund: null,
        },
        items: [item({ state: "booking_processing", tickets: { fulfilment: "not_applicable", documents: [] }, externalConfirmation: statement })],
        pollAfterMs: 5_000,
      }),
    );
    expect(html).toContain('data-testid="external-confirmation"');
    expect(html).toContain(statement);
    expect(html).not.toContain("/api/tickets/documents/");
  });

  it("keeps the statement once booked, and shows none for an item without it", () => {
    expect(render(status({ items: [item({ tickets: { fulfilment: "issued", documents: [doc] }, externalConfirmation: statement })] }))).toContain(statement);
    expect(render(status())).not.toContain('data-testid="external-confirmation"');
  });
});

describe("OrderStatusView: a released external hold (owner decision d)", () => {
  it("offers the existing 'Send it to our team' inquiry route, only when the projection names it", () => {
    const html = render(status({ state: "payment_released", tone: "neutral", inquiryHref: "/inquiry?from=booking&reason=external_hold", items: [item({ state: "payment_released", tickets: { fulfilment: "not_applicable", documents: [] } })] }));
    expect(html).toContain('data-testid="send-to-team"');
    expect(html).toContain('href="/inquiry?from=booking&amp;reason=external_hold"');
    expect(html).toContain("Send it to our team");
    expect(render(status())).not.toContain('data-testid="send-to-team"');
  });
});
