/*
 * shadcn/ui Button (new-york-v4). MIT, shadcn/ui.
 * Source: https://ui.shadcn.com/r/styles/new-york-v4/button.json
 * Verbatim copy: docs/checkout-redesign-review/components/_shadcn/registry/new-york-v4/ui/button.tsx
 *
 * Gap filler used by the OTP Verification Card and the input group (Collapsible
 * promo field). Not the app's own Button (src/components/ui/button.tsx).
 * Edits (docs/checkout-redesign-review/notes/batch2-components.md):
 *   - shadcn colour tokens mapped onto OUTLYY tokens (primary = sun-500 with
 *     ink-900 text, owner decision b; accent = sun-50; secondary = shell;
 *     ring = sun-700; destructive = danger); radius = --radius-control;
 *   - dark: variants dropped (the app is light only);
 *   - `cn` from @/lib/utils instead of the `cn` package; Slot from `radix-ui`
 *     (unchanged).
 */
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-[var(--radius-control)] text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-sun-700 focus-visible:ring-[3px] focus-visible:ring-sun-700/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-danger aria-invalid:ring-danger/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-sun-500 text-ink-900 hover:bg-sun-600",
        destructive: "bg-danger text-white hover:bg-danger/90 focus-visible:ring-danger/20",
        outline: "border bg-sand shadow-xs hover:bg-sun-50 hover:text-ink-900",
        secondary: "bg-shell text-ink-900 hover:bg-shell/80",
        ghost: "hover:bg-sun-50 hover:text-ink-900",
        link: "text-sun-700 underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-[var(--radius-control)] px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-[var(--radius-control)] px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-[var(--radius-control)] px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-[var(--radius-control)] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
