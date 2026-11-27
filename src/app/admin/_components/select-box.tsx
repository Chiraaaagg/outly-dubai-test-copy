"use client";

import type { ReactNode } from "react";
import { Check, Minus } from "lucide-react";
import { Checkbox } from "@base-ui/react/checkbox";

/**
 * The console's checkbox, from the adapted "Team Members Data Table"
 * (olewandowski1 on 21st.dev, owner's 21st.dev Pro licence; see
 * THIRD-PARTY-NOTICES.md), on Base UI's Checkbox (already a dependency).
 * Indeterminate is exposed as `aria-checked="mixed"`.
 */

const BOX =
  "inline-flex size-5 shrink-0 items-center justify-center rounded-[4px] border border-ink-400 bg-paper align-middle text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900 data-[checked]:border-ink-900 data-[checked]:bg-ink-900 data-[indeterminate]:border-ink-900 data-[indeterminate]:bg-ink-900 data-[disabled]:opacity-50";

/** A row or select-all checkbox, named by `label` (no visible label). */
export function SelectBox({ checked, indeterminate, onChange, label, disabled }: { checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <Checkbox.Root checked={checked} indeterminate={indeterminate} onCheckedChange={(v) => onChange(v)} disabled={disabled} aria-label={label} className={BOX}>
      <Checkbox.Indicator className="flex data-[unchecked]:hidden">{indeterminate ? <Minus className="size-3.5" aria-hidden /> : <Check className="size-3.5" aria-hidden />}</Checkbox.Indicator>
    </Checkbox.Root>
  );
}

/** A form checkbox with a visible label; posts `name=on` when checked, like a native one. */
export function FormCheckbox({ name, id, required, defaultChecked, children }: { name: string; id: string; required?: boolean; defaultChecked?: boolean; children: ReactNode }) {
  return (
    <span className="flex items-start gap-2 text-xs text-ink-800">
      <Checkbox.Root id={id} name={name} value="on" required={required} defaultChecked={defaultChecked} aria-labelledby={`${id}-label`} className={`${BOX} mt-0.5`}>
        <Checkbox.Indicator className="flex data-[unchecked]:hidden">
          <Check className="size-3.5" aria-hidden />
        </Checkbox.Indicator>
      </Checkbox.Root>
      <label id={`${id}-label`} htmlFor={id}>
        {children}
      </label>
    </span>
  );
}
