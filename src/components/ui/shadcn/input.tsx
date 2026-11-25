/*
 * shadcn/ui Input (new-york-v4). MIT, shadcn/ui.
 * Source: https://ui.shadcn.com/r/styles/new-york-v4/input.json
 * Verbatim copy: docs/checkout-redesign-review/components/_shadcn/registry/new-york-v4/ui/input.tsx
 * Edits: colour tokens mapped onto OUTLYY (input border = ink-300, ring =
 * sun-700, primary = sun-500 with ink-900 text, muted-foreground = ink-600,
 * destructive = danger); radius = --radius-control; dark: variants dropped;
 * `cn` from @/lib/utils.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-[var(--radius-control)] border border-ink-300 bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-sun-500 selection:text-ink-900 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-ink-900 placeholder:text-ink-600 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-sun-700 focus-visible:ring-[3px] focus-visible:ring-sun-700/50",
        "aria-invalid:border-danger aria-invalid:ring-danger/20",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
