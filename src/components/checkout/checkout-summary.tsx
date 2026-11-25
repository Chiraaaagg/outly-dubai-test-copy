/*
 * Checkout Summary, imported from 21st.dev.
 * Author: astralyxdev. Source: https://21st.dev/@astralyxdev/components/checkout-summary
 * (demo id 36084), retrieved 12 Nov 2026. Same file as
 * https://github.com/astralyxdev/astralyx-ui/blob/main/src/components/ui/checkout-summary.tsx (MIT).
 * Licence: the owner holds a licence for this component (owner decision,
 * 12 Nov 2026). 21st.dev states: MIT.
 * Ported from docs/checkout-redesign-review/components/checkout-summary/component.tsx
 * (no outly/ copy: the prototype passes props and classes only).
 *
 * Edits (docs/checkout-redesign-review/notes/batch2-components.md):
 *   - "use client" added: Fmt calls a hook;
 *   - helper imports point at ./checkout-summary-utils/ (the author's files);
 *   - brand colours: muted-foreground = ink-600; the line note (muted at 70%,
 *     3.7:1 on paper) = ink-600; discount tone (astralyx --green-soft-foreground)
 *     = sunset-600, OUTLYY's savings colour; border = ink-200.
 * Structure, props and the summed total are unchanged.
 */
"use client";

import type { ComponentProps, ReactNode } from "react";
import { Fmt } from "./checkout-summary-utils/fmt";
import { enterFade } from "./checkout-summary-utils/motion";
import { radius, surface } from "./checkout-summary-utils/styles";
import { cn } from "@/lib/utils";

/**
 * The order total, broken into the lines that make it.
 *
 * Every adjustment is its own row. A total that silently includes tax and
 * shipping is the single most common cause of an abandoned basket, and in
 * several jurisdictions showing tax as a separate line is not optional.
 *
 * Amounts are integer minor units, and the total is summed here rather than
 * accepted as a prop. A total that disagrees with the rows above it is a
 * customer-service ticket at best.
 *
 * Unknown values are supported explicitly: shipping that depends on an address
 * not yet given renders as "calculated at next step" rather than as zero.
 * Showing £0.00 for a charge that will be applied is a promise you cannot keep.
 */
export type CheckoutLine = {
  id: string;
  label: ReactNode;
  /** Minor units. Negative for a discount. `null` when not yet known. */
  amount: number | null;
  note?: ReactNode;
  /** Renders in the discount tone. Inferred from a negative amount otherwise. */
  discount?: boolean;
};

function CheckoutSummary({
  subtotal,
  lines = [],
  currency = "USD",
  locale = "en-GB",
  totalLabel = "Total",
  subtotalLabel = "Subtotal",
  pendingLabel = "calculated at next step",
  pendingNote = "Final total confirmed once delivery details are entered.",
  footer,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  /** Minor units, before adjustments. */
  subtotal: number;
  lines?: CheckoutLine[];
  currency?: string;
  locale?: string;
  totalLabel?: ReactNode;
  subtotalLabel?: ReactNode;
  /** Stands in for an amount that is not yet known. */
  pendingLabel?: ReactNode;
  /** Note shown while any line is still pending. */
  pendingNote?: ReactNode;
  footer?: ReactNode;
}) {
  const money = (minor: number) => (
    <Fmt
      type="currency"
      value={minor / 100}
      currency={currency}
      locale={locale}
      decimals={2}
    />
  );

  // Summed from the rows shown, so the two cannot disagree.
  const total = lines.reduce((sum, line) => sum + (line.amount ?? 0), subtotal);
  const pending = lines.some((line) => line.amount === null);

  return (
    <div
      data-slot="checkout-summary"
      className={cn(
        enterFade,
        surface,
        radius.surface,
        "flex flex-col gap-3 p-4",
        className,
      )}
      {...props}
    >
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex items-baseline gap-3">
          <dt className="text-ink-600 min-w-0 flex-1">
            {subtotalLabel}
          </dt>
          <dd className="shrink-0 tabular-nums">{money(subtotal)}</dd>
        </div>

        {lines.map((line) => {
          const isDiscount =
            line.discount ?? (line.amount !== null && line.amount < 0);
          return (
            <div key={line.id} className="flex items-baseline gap-3">
              <dt className="text-ink-600 min-w-0 flex-1">
                {line.label}
                {line.note && (
                  <span className="text-ink-600 block text-xs">
                    {line.note}
                  </span>
                )}
              </dt>
              <dd
                className={cn(
                  "shrink-0 tabular-nums",
                  // Never £0.00 for a charge that is coming.
                  line.amount === null && "text-ink-600 text-xs",
                  isDiscount && "text-sunset-600",
                )}
              >
                {line.amount === null ? pendingLabel : money(line.amount)}
              </dd>
            </div>
          );
        })}

        <div className="border-ink-200 flex items-baseline gap-3 border-t pt-3">
          <dt className="min-w-0 flex-1 font-medium">{totalLabel}</dt>
          <dd className="shrink-0 text-base font-semibold tabular-nums">
            {money(total)}
            {pending && (
              <span className="text-ink-600 ms-1 text-xs font-normal">
                +
              </span>
            )}
          </dd>
        </div>
      </dl>

      {pending && (
        <p className="text-ink-600 text-xs">{pendingNote}</p>
      )}

      {footer && <div className="flex flex-col gap-2">{footer}</div>}
    </div>
  );
}

export { CheckoutSummary };

export default CheckoutSummary;
