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

describe("AnimatedTicket: post-payment A5 repair", () => {
  it("leaves the Paid cell out when no amount is given, and groups a large amount", () => {
    const html = render({ amount: null });
    expect(html).not.toContain(">Paid<");
    expect(html).toContain("OUT-000001");
    expect(render({ amount: 123456.5, currency: "INR" })).toContain("INR 1,23,456.50");
    expect(render({ amount: 12345 })).toContain("AED 12,345.00");
  });

  it("takes an h3 under a section heading", () => {
    const html = render({ headingLevel: 3 });
    expect(html).toContain("Dhow cruise dinner</h3>");
    expect(html).not.toContain("<h2");
  });

  it("the server render is the final state: no entrance attribute, no animation class, no confetti", () => {
    const html = render({ entrance: true });
    expect(html).not.toContain("data-entrance=");
    expect(html).not.toContain("animate-[pop-in");
    expect(html).not.toContain("confetti");
  });

  it("clips its cut-outs inside the card (no sideways scroll on a 320 px phone)", () => {
    const html = render();
    expect(html).toContain("overflow-hidden");
    expect(html).toContain("p-5 sm:p-8");
  });

  it("the check mark and cut-outs are decorative", () => {
    const html = render();
    expect(html.match(/aria-hidden="true"/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("ConfettiBurst", () => {
  it("is hidden from assistive technology and never takes pointer events", async () => {
    const { ConfettiBurst } = await import("../ticket-confirmation-card");
    const html = renderToStaticMarkup(h(ConfettiBurst, {}));
    expect(html).toMatch(/^<div[^>]*aria-hidden="true"/);
    expect(html).toContain("pointer-events-none");
    expect(html).toContain("confetti-fall");
    // The keyframe lives in globals.css, not in a <style> injected per mount.
    expect(html).not.toContain("<style");
  });
});

describe("Ticket card entrance in print (fix round 1, L9)", () => {
  it("a card still waiting for its entrance prints in its final state", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../../../../app/globals.css", import.meta.url), "utf8");
    const blocks = css.split("@media print").slice(1);
    expect(blocks.some((b) => /\[data-entrance\]\s*\{[^}]*opacity:\s*1\s*!important/.test(b))).toBe(true);
  });
});
