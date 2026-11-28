/*
 * shadcn/ui Textarea (new-york-v4). MIT, shadcn/ui.
 * Source: https://ui.shadcn.com/r/styles/new-york-v4/textarea.json
 * Verbatim copy: docs/checkout-redesign-review/components/_shadcn/registry/new-york-v4/ui/textarea.tsx
 * Registry dependency of the input group (InputGroupTextarea). Edits: colour
 * tokens mapped onto OUTLYY as in ./input.tsx; radius = --radius-control;
 * dark: variants dropped; `cn` from @/lib/utils.
 */
import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-[var(--radius-control)] border border-ink-300 bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-ink-600 focus-visible:border-sun-700 focus-visible:ring-[3px] focus-visible:ring-sun-700/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger aria-invalid:ring-danger/20 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
