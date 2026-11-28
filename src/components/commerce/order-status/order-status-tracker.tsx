/*
 * Order Status Tracker, imported from 21st.dev.
 * Author: ravikatiyar162. Source: https://21st.dev/@ravikatiyar162/components/order-status-tracker
 * (demo id 8205), retrieved 12 Nov 2026.
 * Licence: the owner holds a licence for this component (owner decision,
 * 12 Nov 2026). 21st.dev states no licence (empty field); the owner's licence
 * covers it.
 * Ported from the prototype's edited copy,
 * docs/checkout-redesign-review/components/order-status-tracker/outly/component.tsx
 * (original: ../component.tsx in the same folder).
 *
 * Edits carried over from the prototype copy (recorded in components/SOURCES.md):
 *   - copy: "$" -> "AED " (two decimals, tabular numerals); "Order Summary"
 *     and "Track order" became props (summaryTitle, actionLabel); decorative
 *     images get empty alt text;
 *   - spacing: illustration w-32 -> w-14, item image 48px on phones, card
 *     padding p-4 sm:p-6, 48px action button;
 *   - colour: tracking line green-600 (3.2:1 on sand) -> lagoon-700;
 *   - approved structural edit (owner, 12 Nov 2026): the action button renders
 *     only when an actionLabel is given.
 * Edits for the app (docs/checkout-redesign-review/notes/batch2-components.md):
 *   - "use client" (Motion, imported from `motion/react`, the same engine as
 *     framer-motion, so the app keeps one package); Button = the 21st-shipped Button in
 *     src/components/ui/shadcn/legacy-button.tsx;
 *   - brand colours: card = paper, foreground = ink-900, muted-foreground =
 *     ink-600, muted = shell; tracking line class written as text-lagoon-700;
 *     radius = --radius-card (the prototype's rounded-xl / rounded-lg);
 *   - copy (part B): `currency` prop (default "AED") instead of the fixed
 *     "AED " prefix, because an order can settle in INR;
 *   - follow-up (part B): `price` may be null, which hides it (an unreadable
 *     amount is never printed as 0.00);
 *   - review fix (part B): `initial={false}` instead of `initial="hidden"`, so
 *     the server-rendered headline is visible (opacity 0 is not stopped by
 *     reduced motion). The variants stay; the entrance no longer plays.
 * The page still wraps it in <MotionConfig reducedMotion="user">.
 * Post-payment batch A6 (owner approval 27 Nov 2026): `progress`, when given,
 * takes the place of the item and summary cards (the Booking Progress Card,
 * which carries the reference, the activity, its date and the milestones), so
 * nothing is said twice while the booking is still on its way. The item row
 * wraps on narrow screens and the price is grouped (12,345.00), so a long
 * title or an INR amount never pushes past the card at 320 px.
 */
"use client";

import * as React from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/shadcn/legacy-button";

// Define TypeScript types for the component props for type safety and reusability
interface OrderItemProps {
  imageUrl: string;
  name: string;
  details: string;
  /** Major units; null hides the price rather than printing a wrong figure. */
  price: number | null;
}

interface OrderSummaryItemProps {
  label: string;
  value: string;
}

interface OrderStatusProps {
  illustrationUrl: string;
  statusTitle: string;
  statusDescription: string;
  item: OrderItemProps;
  summary: OrderSummaryItemProps[];
  /** A6: shown instead of the item and summary cards while the booking is on its way. */
  progress?: React.ReactNode;
  trackingStatus: string;
  onTrackOrder?: () => void;
  className?: string;
  summaryTitle?: string;
  actionLabel?: string;
  /** Currency code printed before the price (copy edit, part B: INR orders exist). */
  currency?: string;
}

// Reusable Card component for consistent styling
const InfoCard = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-[var(--radius-card)] border bg-paper text-ink-900 p-4 sm:p-6",
        className
      )}
      {...props}
    />
  )
);
InfoCard.displayName = "InfoCard";


export const OrderStatus: React.FC<OrderStatusProps> = ({
  illustrationUrl,
  statusTitle,
  statusDescription,
  item,
  summary,
  progress,
  trackingStatus,
  onTrackOrder,
  className,
  summaryTitle = "Progress",
  actionLabel,
  currency = "AED",
}) => {
  // Animation variants for Framer Motion
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.1, delayChildren: 0.2 },
    },
  };

  const itemVariants = {
    hidden: { y: 20, opacity: 0 },
    visible: { y: 0, opacity: 1 },
  };

  return (
    <motion.div
      className={cn("max-w-md w-full mx-auto p-4 font-sans", className)}
      variants={containerVariants}
      // Rendered in its final state (review fix, part B): `initial="hidden"` server-rendered the
      // headline and status at opacity 0, and reduced motion does not stop opacity animations.
      initial={false}
      animate="visible"
    >
      {/* Header section with illustration and status */}
      <motion.div variants={itemVariants} className="text-center space-y-2 mb-6">
        <img
          src={illustrationUrl}
          alt=""
          className="w-14 h-14 mx-auto"
        />
        <h1 className="text-2xl font-bold text-ink-900">{statusTitle}</h1>
        <p className="text-ink-600">{statusDescription}</p>
      </motion.div>

      {progress ? (
        <motion.div variants={itemVariants} className="mb-6">
          {progress}
        </motion.div>
      ) : (
        <>
      {/* Ordered item details card */}
      <motion.div variants={itemVariants} className="mb-6">
        <InfoCard>
          {/* Wraps on a narrow screen (post-payment break-ui pass): a long title or a large amount moves the
              price under the text instead of pushing it past the card's edge at 320 px. */}
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
            <img
              src={item.imageUrl}
              alt=""
              className="w-12 h-12 sm:w-16 sm:h-16 shrink-0 rounded-[var(--radius-card)] bg-shell object-cover"
            />
            <div className="min-w-0 flex-1 basis-32">
              <p className="font-semibold text-ink-900 break-words">{item.name}</p>
              <p className="text-sm text-ink-600">{item.details}</p>
            </div>
            {item.price !== null && Number.isFinite(item.price) ? (
              <p className="ml-auto font-bold text-ink-900 tabular-nums whitespace-nowrap">
                {currency} {item.price.toLocaleString(currency === "INR" ? "en-IN" : "en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            ) : null}
          </div>
        </InfoCard>
      </motion.div>

      {/* Order summary card */}
      <motion.div variants={itemVariants} className="mb-6">
        <InfoCard className="space-y-4">
            <h2 className="font-semibold text-lg text-ink-900">{summaryTitle}</h2>
            {summary.map((line, index) => (
                <div key={index} className="flex justify-between items-center text-sm">
                    <p className="text-ink-600">{line.label}</p>
                    <p className="text-ink-900 font-medium text-right">{line.value}</p>
                </div>
            ))}
        </InfoCard>
      </motion.div>

        </>
      )}

      {/* Action button and final status text */}
      <motion.div variants={itemVariants} className="text-center space-y-3">
        {actionLabel ? (
          <Button onClick={onTrackOrder} className="w-full h-12 text-base font-bold">
              {actionLabel}
          </Button>
        ) : null}
        <p className="text-xs text-lagoon-700 font-medium">{trackingStatus}</p>
      </motion.div>
    </motion.div>
  );
};

export type { OrderStatusProps, OrderItemProps, OrderSummaryItemProps };
