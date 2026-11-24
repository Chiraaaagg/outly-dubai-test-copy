import type { CustomerOrderState, CustomerTone } from "@/lib/customer-status";
import { cn } from "@/lib/utils";
import { stateLabel } from "./presenters";

/**
 * The customer state as a pill. Built on the console `StatusPill`
 * (src/app/admin/_components/ui.tsx): the same rounded bordered chip and the
 * same tone tokens, so a state reads the same to a customer and to the team.
 * The label is always text; the colour only repeats it.
 */
const TONES: Record<CustomerTone, string> = {
  neutral: "bg-ink-100 text-ink-700 border-ink-200",
  progress: "bg-[var(--color-info-bg)] text-[var(--color-info)] border-[color-mix(in_oklab,var(--color-info)_28%,white)]",
  success: "bg-[var(--color-success-bg)] text-[var(--color-success)] border-[color-mix(in_oklab,var(--color-success)_28%,white)]",
  warning: "bg-[var(--color-warning-bg)] text-[var(--color-warning)] border-[color-mix(in_oklab,var(--color-warning)_28%,white)]",
  danger: "bg-[var(--color-danger-bg)] text-[var(--color-danger)] border-[color-mix(in_oklab,var(--color-danger)_28%,white)]",
};

export function StatePill({
  state,
  tone,
  size = "md",
  className,
}: {
  state: CustomerOrderState;
  tone: CustomerTone;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-full border font-semibold",
        size === "sm" ? "px-2 py-0.5 text-2xs" : "px-2.5 py-1 text-xs",
        TONES[tone] ?? TONES.neutral,
        className,
      )}
    >
      {stateLabel(state)}
    </span>
  );
}

/** Card border and wash for a tone, from the booking confirmation hero. */
export const TONE_PANEL: Record<CustomerTone, string> = {
  neutral: "border-ink-200 bg-shell",
  progress: "border-[color-mix(in_oklab,var(--color-info)_30%,white)] bg-[var(--color-info-bg)]",
  success: "border-[color-mix(in_oklab,var(--color-success)_30%,white)] bg-[var(--color-success-bg)]",
  warning: "border-[color-mix(in_oklab,var(--color-warning)_30%,white)] bg-[var(--color-warning-bg)]",
  danger: "border-[color-mix(in_oklab,var(--color-danger)_30%,white)] bg-[var(--color-danger-bg)]",
};
