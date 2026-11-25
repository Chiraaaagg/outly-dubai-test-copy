import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CheckoutSummary } from "../checkout-summary";

/**
 * Imported Checkout Summary (astralyxdev, 21st.dev), ported with OUTLYY tokens
 * (checkout redesign batch 2). The total is summed from the rows shown, a
 * pending amount is never printed as zero, and savings use sunset, never green.
 * Synthetic figures (minor units).
 */

function render(props: Partial<Parameters<typeof CheckoutSummary>[0]> = {}): string {
  return renderToStaticMarkup(
    h(CheckoutSummary, {
      subtotal: 28_000,
      currency: "AED",
      locale: "en-GB",
      subtotalLabel: "Adult × 2",
      ...props,
    }),
  );
}

describe("CheckoutSummary", () => {
  it("formats amounts in the given currency, with tabular numerals", () => {
    const html = render();
    expect(html).toMatch(/AED\s280\.00/);
    expect(html).toContain("tabular-nums");
    expect(html).toContain("Adult × 2");
  });

  it("sums the total from the subtotal and every line, discounts included", () => {
    const html = render({
      lines: [
        { id: "promo", label: "Promo WINTER10", amount: -2_800, note: "10% off, applied" },
        { id: "extra", label: "Hotel pickup", amount: 5_000 },
      ],
    });
    // 280.00 - 28.00 + 50.00
    expect(html).toMatch(/AED\s302\.00/);
    expect(html).toContain("10% off, applied");
  });

  it("shows a discount in the OUTLYY savings colour", () => {
    const html = render({ lines: [{ id: "promo", label: "Promo", amount: -2_800 }] });
    expect(html).toContain("text-sunset-600");
    expect(html).not.toContain("green");
  });

  it("never prints zero for an amount not yet known", () => {
    const html = render({
      lines: [{ id: "pickup", label: "Pickup", amount: null }],
      pendingLabel: "confirmed at pickup",
      pendingNote: "Final total confirmed once pickup is chosen.",
    });
    expect(html).toContain("confirmed at pickup");
    expect(html).toContain("Final total confirmed once pickup is chosen.");
    expect(html).not.toMatch(/AED\s0\.00/);
  });

  it("renders the footer and keeps the card on OUTLYY surface tokens", () => {
    const html = render({ footer: h("p", null, "Taxes and fees included. Charged in AED.") });
    expect(html).toContain("Taxes and fees included. Charged in AED.");
    expect(html).toContain("bg-paper");
    expect(html).toContain("rounded-[var(--radius-card)]");
    expect(html).not.toMatch(/\b(?:bg|text|border)-(?:card|muted-foreground|border)\b/);
  });
});
