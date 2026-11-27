/*
 * Button shipped by 21st.dev with the Stepper, Collapsible Form Fields, Checkout
 * Summary and Order Status Tracker components (an older shadcn/ui Button). MIT,
 * shadcn/ui.
 * Verbatim copy: docs/checkout-redesign-review/components/order-status-tracker/deps/components/ui/button.tsx
 *
 * Used by the Order Status Tracker and the Collapsible promo field trigger.
 * Not the app's own Button (src/components/ui/button.tsx).
 * Edits (docs/checkout-redesign-review/notes/batch2-components.md):
 *   - shadcn colour tokens mapped onto OUTLYY tokens (primary = sun-500 with
 *     ink-900 text, owner decision b; accent = sun-50; secondary = shell;
 *     ring = sun-700; destructive = danger); radius = --radius-control;
 *   - Slot from the `radix-ui` package (same Radix Slot) instead of
 *     `@radix-ui/react-slot`, so the app needs one Radix package, not two.
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius-control)] text-sm font-medium ring-offset-sand transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sun-700 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-sun-500 text-ink-900 hover:bg-sun-600",
        destructive: "bg-danger text-white hover:bg-danger/90",
        outline: "border border-ink-300 bg-sand hover:bg-sun-50 hover:text-ink-900",
        secondary: "bg-shell text-ink-900 hover:bg-shell/80",
        ghost: "hover:bg-sun-50 hover:text-ink-900",
        link: "text-sun-700 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-[var(--radius-control)] px-3",
        lg: "h-11 rounded-[var(--radius-control)] px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot.Root : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
