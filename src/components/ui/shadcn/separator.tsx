/*
 * shadcn/ui Separator (new-york-v4). MIT, shadcn/ui.
 * Source: https://ui.shadcn.com/r/styles/new-york-v4/separator.json
 * Verbatim copy: docs/checkout-redesign-review/components/_shadcn/registry/new-york-v4/ui/separator.tsx
 * Edits: bg-border -> bg-ink-200 (OUTLYY border token); `cn` from @/lib/utils.
 */
"use client";

import * as React from "react";
import { Separator as SeparatorPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 bg-ink-200 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
