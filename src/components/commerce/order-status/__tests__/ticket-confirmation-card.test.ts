import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnimatedTicket } from "../ticket-confirmation-card";

/**
 * Imported Ticket Confirmation Card (ravikatiyar162, 21st.dev), ported from the
 * prototype's edited copy (checkout redesign batch 2). Pins the approved edits:
 * h2 heading, AED amount, Dubai time, no barcode (owner decision d), meeting
 * point through the `icon` prop. Confetti only starts in a browser effect, so a
 * server render never contains it. Synthetic values.
 */

function render(over: Partial<Parameters<typeof AnimatedTicket>[0]> = {}): string {
  return renderToStaticMarkup(
    h(AnimatedTicket, {
      title: "Dhow cruise dinner",
      subtitle: "Confirmed by the operator at 14:41 Dubai time.",
      ticketId: "OUT-000001",
      amount: 560,
      // 14:30 UTC is 18:30 in Dubai (UTC+4, no DST).
      date: new Date("2026-11-18T14:30:00.000Z"),
      cardHolder: "Marina Walk jetty",
      last4Digits: "Gate 3",
      barcodeValue: "Show the voucher PDF at the jetty",
      ...over,
    }),
  );
}

describe("AnimatedTicket", () => {
  it("uses an h2 for its heading, never a second h1", () => {
    const html = render();
    expect(html).toContain("Dhow cruise dinner</h2>");
    expect(html).not.toContain("<h1");
  });

  it("shows the amount in AED and the time in Dubai", () => {
    const html = render();
    expect(html).toContain("AED 560.00");
    expect(html).toContain("When (Dubai time)");
    expect(html).toContain("18 Nov 2026");
    expect(html).toContain("18:30");
  });

  it("draws no barcode, only the jetty instruction", () => {
    const html = render();
    expect(html).toContain("Show the voucher PDF at the jetty");
    expect(html).not.toContain("Barcode for value");
    expect(html).not.toContain("<rect");
  });

  it("renders the given icon in place of the card mark, and falls back to the mark", () => {
    expect(render({ icon: h("span", { "data-testid": "pin" }) })).toContain('data-testid="pin"');
    expect(render()).toContain('fill="#EA001B"');
  });

  it("renders no confetti on the server", () => {
    const html = render();
    expect(html).not.toContain("@keyframes fall");
  });

  it("uses OUTLYY tokens", () => {
    const html = render();
    expect(html).toContain("bg-paper");
    expect(html).toContain("text-sun-700");
    expect(html).not.toMatch(/\b(?:bg|text|border)-(?:card|primary|muted|background|foreground)\b/);
  });
});

describe("AnimatedTicket: open-dated ticket additions (doc 29 §8.5, Batch 5)", () => {
  it("date only under its own label, with details and an action, each only when given", () => {
    const html = render({ dateOnly: true, dateLabel: "Visit date", details: h("p", null, "Ticket valid until Tuesday, 16 July 2030."), action: h("a", { href: "/api/tickets/documents/x" }, "Download tickets") });
    expect(html).toContain("Visit date");
    expect(html).toContain("Wed 18 Nov 2026");
    expect(html).not.toContain("18:30");
    expect(html).toContain("Ticket valid until Tuesday, 16 July 2030.");
    expect(html).toContain("Download tickets");
    const plain = render();
    expect(plain).toContain("When (Dubai time)");
    expect(plain).not.toContain("Download tickets");
  });
});
