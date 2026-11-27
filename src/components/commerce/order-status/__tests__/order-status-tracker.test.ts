import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MotionConfig } from "motion/react";
import { describe, expect, it } from "vitest";
import { OrderStatus } from "../order-status-tracker";

/**
 * Imported Order Status Tracker (ravikatiyar162, 21st.dev) as the booking
 * status header (checkout redesign batch 2, CO-14). Pins the approved edits:
 * the headline as the page's h1, the progress rows, the amount in the order's
 * currency with two decimals, decorative images, and no button unless there is
 * an action. Synthetic values.
 */

const base = {
  illustrationUrl: "/brand/outlyy-mark.svg",
  statusTitle: "Payment received. We're booking your dhow cruise with the operator.",
  statusDescription: "This page updates by itself.",
  item: { imageUrl: "/brand/outlyy-mark.svg", name: "Dhow cruise dinner", details: "18 Nov · 21:00 · 1 adult", price: 229 },
  summaryTitle: "Progress",
  summary: [
    { label: "Payment received", value: "Done" },
    { label: "Booked with the operator", value: "In progress" },
    { label: "Voucher ready", value: "Not started" },
  ],
  trackingStatus: "Ref OUT-000001 · updated 14:39 Dubai time",
};

function render(over: Partial<Parameters<typeof OrderStatus>[0]> = {}): string {
  return renderToStaticMarkup(h(MotionConfig, { reducedMotion: "user" }, h(OrderStatus, { ...base, ...over })));
}

describe("OrderStatus (tracker)", () => {
  it("heads the page with the status headline as its one h1, then the next step", () => {
    const html = render();
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Payment received. We&#x27;re booking your dhow cruise with the operator.</h1>");
    expect(html).toContain("This page updates by itself.");
  });

  it("lists the three progress rows with their state in words", () => {
    const html = render();
    expect(html).toContain("Progress</h2>");
    for (const row of base.summary) {
      expect(html).toContain(`>${row.label}</p>`);
      expect(html).toContain(`>${row.value}</p>`);
    }
  });

  it("prints the amount in the order's currency with two decimals", () => {
    expect(render()).toContain("AED 229.00");
    // Grouped in the currency's own way (post-payment break-ui pass).
    expect(render({ currency: "INR", item: { ...base.item, price: 14000 } })).toContain("INR 14,000.00");
    expect(render({ currency: "INR", item: { ...base.item, price: 12345678.9 } })).toContain("INR 1,23,45,678.90");
  });

  it("has decorative images only, and no button without an action", () => {
    const html = render();
    expect(html.match(/<img[^>]*alt=""/g)).toHaveLength(2);
    expect(html).not.toContain("<button");
    expect(render({ actionLabel: "Send me a code" })).toMatch(/<button[^>]*>Send me a code<\/button>/);
  });

  it("uses the lagoon-700 tracking line and OUTLYY surfaces", () => {
    const html = render();
    expect(html).toContain("text-lagoon-700");
    expect(html).toContain("Ref OUT-000001 · updated 14:39 Dubai time");
    expect(html).not.toMatch(/\b(?:bg|text)-(?:card|foreground|muted-foreground)\b/);
  });
});

describe("OrderStatus (tracker): post-payment A6", () => {
  it("a progress slot replaces the item and summary cards", () => {
    const html = render({ progress: h("section", { "data-testid": "slot" }, "Booking progress") });
    expect(html).toContain('data-testid="slot"');
    expect(html).not.toContain("Dhow cruise dinner");
    expect(html).not.toContain(">Progress</h2>");
    // The headline stays the page's one h1.
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("the item row wraps on a narrow screen instead of pushing the price out", () => {
    expect(render()).toContain("flex flex-wrap items-start");
  });
});
