/*
 * shadcn/ui Label (new-york-v4). MIT, shadcn/ui.
 * Source: https://ui.shadcn.com/r/styles/new-york-v4/label.json
 * Verbatim copy: docs/checkout-redesign-review/components/_shadcn/registry/new-york-v4/ui/label.tsx
 * Edits: `cn` from @/lib/utils instead of the `cn` package. No class changes.
 */
"use client";

import * as React from "react";
import { Label as LabelPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
