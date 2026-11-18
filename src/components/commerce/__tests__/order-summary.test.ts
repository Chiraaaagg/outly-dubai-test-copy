import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrderSummary, type ServerQuote } from "../order-summary";
import { freeCancellationCopy } from "@/lib/utils";

/**
 * The checkout order summary shows each line's exact refund deadline when a
 * server quote is present (CR-B2-6 / B2 recheck): the quote's own words, the
 * exact deadline in Dubai time (CO-01), inside a machine-readable <time>. Synthetic figures.
 */

const UNTIL = "2026-11-03T20:00:00.000Z";

function quote(lines: Array<{ index: number; freeCancellationUntilUtc: string | null }>): ServerQuote {
  return {
    ok: true,
    quoteId: "0190a000-0000-7000-8000-0000000000f1",
    currency: "AED",
    totalMinor: "56000",
    expiresAt: "2026-11-01T08:10:00.000Z",
    lines: lines.map((l) => ({
      index: l.index,
      productId: "0190a000-0000-7000-8000-000000000001",
      variantId: "shared",
      serviceDate: "2026-11-05",
      slotRef: "17@18:00",
      units: { adult: 2 },
      addonIds: [],
      chargedMinor: "56000",
      discountAllocMinor: "0",
      taxAllocMinor: "0",
      freeCancellationUntilUtc: l.freeCancellationUntilUtc,
      freeCancellationCopy: freeCancellationCopy(l.freeCancellationUntilUtc),
      nonRefundableAfterConfirm: l.freeCancellationUntilUtc === null,
    })),
  };
}

function render(over: Partial<ComponentProps<typeof OrderSummary>> = {}): string {
  const money = { inr: 14_000, aed: 560 };
  return renderToStaticMarkup(
    createElement(OrderSummary, {
      itemCount: 1,
      subtotal: money,
      discount: { inr: 0, aed: 0 },
      couponCode: null,
      total: money,
      deposit: { now: money, later: { inr: 0, aed: 0 } },
      payDeposit: false,
      payCurrency: "AED",
      quote: null,
      lineTitle: (i) => ["Synthetic desert safari", "Synthetic dhow cruise"][i] ?? "Activity",
      ...over,
    }),
  );
}

describe("OrderSummary: refund deadline at checkout", () => {
  it("without a quote it shows no refund section", () => {
    const html = render();
    expect(html).toContain("Order summary");
    expect(html).not.toContain("Cancellation and refund");
  });

  it("with a quote it shows each line's exact deadline, in Dubai time, with the instant as datetime", () => {
    const html = render({ itemCount: 2, quote: quote([{ index: 0, freeCancellationUntilUtc: UNTIL }, { index: 1, freeCancellationUntilUtc: null }]) });
    expect(html).toContain('<section aria-labelledby="order-summary-refund"');
    expect(html).toContain('<h3 id="order-summary-refund"');
    expect(html).toContain("Synthetic desert safari");
    expect(html).toContain(`<time dateTime="${UNTIL}">Free cancellation until Wed 4 Nov 2026, 00:00 Dubai time. After that, the booking is non-refundable.</time>`);
    expect(html).toContain("Synthetic dhow cruise");
    expect(html).toContain("This booking is non-refundable once confirmed.");
  });

  it("with a quote it promises the card charge only: instant checkout takes cards, not UPI (doc 22 §32.11)", () => {
    const html = render({ quote: quote([{ index: 0, freeCancellationUntilUtc: UNTIL }]) });
    expect(html).toContain("This is the exact amount your card will be charged.");
    expect(html).not.toMatch(/\bUPI\b|\bnetbanking\b|\bEMI\b/i);
  });
});
