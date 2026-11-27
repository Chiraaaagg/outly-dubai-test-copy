"use client";

import type { ReactNode } from "react";
import { CheckoutSummary, type CheckoutLine } from "@/components/checkout/checkout-summary";
import { Card } from "@/components/ui/primitives";
import type { QuoteResponse } from "@/lib/api";
import type { Money } from "@/lib/types";

/** A server quote that priced every line (`POST /api/quotes`, 201). */
export type ServerQuote = Extract<QuoteResponse, { ok: true }>;

/** Major units (two decimals at most) as integer minor units. */
function toMinor(major: number): number {
  return Math.round(major * 100);
}

/**
 * The checkout's order summary card.
 *
 * Presentation (checkout redesign batch 2): headed "Your <activity>" (or
 * "Your trip"), the date, guests and pickup block the page passes as
 * `details`, then the approved Checkout Summary component for the money:
 * subtotal, an applied promo as its own discount line, and the total. The
 * data is unchanged: the amounts passed in are the quote's own when there is
 * one (the checkout derives them from it). Checkout Summary sums its rows, so
 * any difference between the quote total and subtotal minus discount (tax
 * allocations) is shown as its own "Taxes and fees" row; the total printed is
 * therefore always the `total` passed in, exactly (AC-CO-02).
 *
 * With a server quote, each line's refund deadline is shown exactly as the
 * quote words it (`freeCancellationCopy`: the exact deadline in Dubai time,
 * CO-01), before anything is paid (CR-B2-6). Only with a quote does the card
 * say the amount is exactly what will be charged; without one the total is
 * labelled as still to be confirmed.
 */
export function OrderSummary({
  itemCount,
  subtotal,
  discount,
  couponCode,
  total,
  deposit,
  payDeposit,
  payCurrency,
  quote,
  lineTitle,
  title,
  details,
  subtotalLabel,
  className,
  idPrefix = "order-summary",
}: {
  itemCount: number;
  subtotal: Money;
  discount: Money;
  couponCode: string | null;
  total: Money;
  deposit: { now: Money; later: Money };
  payDeposit: boolean;
  payCurrency: "INR" | "AED";
  quote: ServerQuote | null;
  /** The title of the cart item a quote line prices (lines carry the cart's index). */
  lineTitle: (index: number) => string;
  /** Visible heading, e.g. "Your Dubai Marina dinner cruise". Without it the card reads "Order summary". */
  title?: string;
  /** Date, guests and pickup, shown above the money. */
  details?: ReactNode;
  /** Label of the subtotal row. */
  subtotalLabel?: string;
  className?: string;
  /** Prefix for the card's element ids: a page that renders two summaries (phone bar and column) passes distinct ones. */
  idPrefix?: string;
}) {
  const refundId = `${idPrefix}-refund`;
  const pick = (m: Money) => (payCurrency === "INR" ? m.inr : m.aed);
  const subtotalMinor = toMinor(pick(subtotal));
  const discountMinor = toMinor(pick(discount));
  const totalMinor = toMinor(pick(total));
  const lines: CheckoutLine[] = [];
  if (discountMinor > 0) {
    lines.push({ id: "promo", label: `Promo ${couponCode ?? ""}`.trim(), amount: -discountMinor, discount: true, note: <span className="text-ink-600">Applied</span> });
  }
  const rest = totalMinor - (subtotalMinor - discountMinor);
  if (rest !== 0) lines.push({ id: "taxes", label: "Taxes and fees", amount: rest });

  return (
    <Card className={className ?? "p-5"}>
      <h2 className="text-lg">
        {title ? (
          <>
            <span className="sr-only">Order summary: </span>
            {title}
          </>
        ) : (
          "Order summary"
        )}
      </h2>
      {details ? <div className="mt-3">{details}</div> : null}
      <CheckoutSummary
        className="mt-4 rounded-none border-0 border-t bg-transparent px-0 pb-0 pt-4 shadow-none"
        subtotal={subtotalMinor}
        currency={payCurrency}
        locale="en-GB"
        subtotalLabel={subtotalLabel ?? `Subtotal (${itemCount} ${itemCount === 1 ? "activity" : "activities"})`}
        totalLabel="Total to pay"
        lines={lines}
        footer={
          <>
            <p className="text-xs text-ink-600">Taxes and booking fees included. Charged in {payCurrency}.</p>
            {payDeposit && (
              <p className="text-xs text-ink-600">
                Pay {pick(deposit.now).toFixed(2)} {payCurrency} now; the balance of {pick(deposit.later).toFixed(2)} {payCurrency} is
                due 7 days before travel.
              </p>
            )}
            {quote ? (
              <p className="text-xs font-semibold text-[var(--color-success)]">This is the exact amount your card will be charged.</p>
            ) : (
              <p className="text-xs text-ink-600">We confirm the exact amount with the operator before you pay.</p>
            )}
          </>
        }
      />
      {quote && quote.lines.length > 0 && (
        <section aria-labelledby={refundId} className="mt-3 border-t border-ink-200 pt-3">
          <h3 id={refundId} className="text-sm font-bold text-ink-900">
            Cancellation and refund
          </h3>
          <ul className="mt-1 space-y-1 text-xs text-ink-600">
            {quote.lines.map((line) => (
              <li key={line.index}>
                <span className="font-semibold text-ink-900">{lineTitle(line.index)}: </span>
                {line.freeCancellationUntilUtc ? (
                  <time dateTime={line.freeCancellationUntilUtc}>{line.freeCancellationCopy}</time>
                ) : (
                  line.freeCancellationCopy
                )}
                {line.ticketValidUntil && line.ticketValidityCopy ? (
                  <>
                    {" "}
                    <time dateTime={line.ticketValidUntil}>{line.ticketValidityCopy}</time>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}
    </Card>
  );
}
