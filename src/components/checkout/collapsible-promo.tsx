/*
 * Collapsible Form Fields ("v-collapsible-5"), imported from 21st.dev, used as
 * the collapsed promo code field on Review & pay.
 * Author: cnippet-dev. Source: https://21st.dev/@cnippet-dev/components/v-collapsible-5
 * (demo id 24934), retrieved 12 Nov 2026.
 * Licence: the owner holds a licence for this component (owner decision,
 * 12 Nov 2026). 21st.dev states "no-license"; the owner's licence covers it.
 * Ported from the prototype's edited copy,
 * docs/checkout-redesign-review/components/collapsible-form-fields/outly/component.tsx
 * (original: ../component.tsx in the same folder).
 *
 * Edits carried over from the prototype copy (recorded in components/SOURCES.md):
 *   - copy: "Unit Pricing", "Base Price", "$", tax and discount labels replaced
 *     with promo code copy; Settings2 icon replaced with a chevron;
 *   - approved structural edit (owner, 12 Nov 2026): the card title and the
 *     icon trigger merged into one full-width trigger, the price input moved
 *     into the panel as the promo code field, the second hidden field removed,
 *     an Apply button (InputGroupButton, same kit) and a FieldError line added;
 *   - spacing: fixed h-54 / max-w-xs wrapper removed, 44px+ targets;
 *   - wiring: open state, value and apply can be controlled.
 * Edits for the app (docs/checkout-redesign-review/notes/batch2-components.md):
 *   - "use client" kept; imports point at src/components/ui/shadcn/ (the gap
 *     fillers the prototype resolved: 21st-shipped Button and Card, shadcn
 *     base-vega Collapsible, new-york-v4 Field and Input Group);
 *   - panel animation: the Radix `data-[state=open]:animate-collapsible-down`
 *     classes never apply to Base UI (it sets data-open / data-closed and
 *     --collapsible-panel-height), so they are replaced by a 200ms height
 *     transition on Base UI's own variable, as the prototype's CSS did.
 */
"use client";

import { ChevronDownIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/shadcn/legacy-button";
import {
  Card,
  CardContent,
} from "@/components/ui/shadcn/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/shadcn/collapsible";
import {
  Field,
  FieldError,
  FieldLabel,
} from "@/components/ui/shadcn/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/shadcn/input-group";

export interface PatternProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  triggerLabel?: ReactNode;
  fieldLabel?: ReactNode;
  placeholder?: string;
  applyLabel?: ReactNode;
  value?: string;
  onValueChange?: (value: string) => void;
  onApply?: () => void;
  error?: ReactNode;
}

export function Pattern({
  open,
  onOpenChange,
  triggerLabel = "Have a promo code?",
  fieldLabel = "Promo code",
  placeholder = "For example WINTER10",
  applyLabel = "Apply",
  value,
  onValueChange,
  onApply,
  error,
}: PatternProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setIsOpen = (next: boolean) => {
    setInternalOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div className="w-full">
      <Card>
        <CardContent className="p-2">
          <Collapsible
            className="flex flex-col gap-3"
            onOpenChange={setIsOpen}
            open={isOpen}
          >
            <CollapsibleTrigger
              render={
                <Button
                  className="h-11 w-full justify-between px-3 text-base font-semibold"
                  variant="ghost"
                />
              }
            >
              {triggerLabel}
              <ChevronDownIcon
                aria-hidden="true"
                className={isOpen ? "size-4 rotate-180" : "size-4"}
              />
            </CollapsibleTrigger>

            <CollapsibleContent className="h-[var(--collapsible-panel-height)] overflow-hidden transition-[height] duration-200 ease-[var(--ease-out-soft)] data-[ending-style]:h-0 data-[starting-style]:h-0">
              <Field className="px-3 pb-3">
                <FieldLabel htmlFor="promo-code">{fieldLabel}</FieldLabel>
                <InputGroup className="h-12">
                  <InputGroupInput
                    id="promo-code"
                    name="promo-code"
                    value={value}
                    onChange={(event) => onValueChange?.(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        onApply?.();
                      }
                    }}
                    placeholder={placeholder}
                    type="text"
                    autoComplete="off"
                    autoCapitalize="characters"
                    spellCheck={false}
                    className="h-full text-base"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? "promo-code-error" : undefined}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      size="sm"
                      variant="secondary"
                      className="h-11 px-4 text-sm font-bold"
                      onClick={onApply}
                    >
                      {applyLabel}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                {error ? (
                  <FieldError id="promo-code-error">{error}</FieldError>
                ) : null}
              </Field>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>
    </div>
  );
}

export default Pattern;

// App name for the same component.
export { Pattern as CollapsiblePromo, type PatternProps as CollapsiblePromoProps };
