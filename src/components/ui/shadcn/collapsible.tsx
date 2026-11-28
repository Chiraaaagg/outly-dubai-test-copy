/*
 * shadcn/ui Collapsible (base-vega, Base UI). MIT, shadcn/ui.
 * Source: https://ui.shadcn.com/r/styles/base-vega/collapsible.json
 * Verbatim copy: docs/checkout-redesign-review/components/_shadcn/registry/base-vega/ui/collapsible.tsx
 *
 * Gap filler for the Collapsible promo field, which uses Base UI's `render`
 * prop on the trigger (the Radix collapsible 21st.dev shipped has none; see
 * components/SOURCES.md). No edits.
 */
"use client";

import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({ ...props }: CollapsiblePrimitive.Panel.Props) {
  return <CollapsiblePrimitive.Panel data-slot="collapsible-content" {...props} />;
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
