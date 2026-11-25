import type { ReactNode } from "react";
import { Check, Circle, Clock, Minus, X } from "lucide-react";
import type { CustomerOrderStatus, StepStatus } from "@/lib/customer-status";
import { formatDubaiAndUtc, isoForTimeElement } from "@/lib/customer-status";
import { cn } from "@/lib/utils";
import { timelineRows } from "./presenters";

/** An instant as `<time>`: Asia/Dubai plus UTC in the text, ISO in `dateTime` (criterion 4). */
export function DubaiTime({ iso, className }: { iso: string; className?: string }) {
  const text = formatDubaiAndUtc(iso);
  if (!text) return null;
  return (
    <time dateTime={isoForTimeElement(iso)} className={className}>
      {text}
    </time>
  );
}

const DISC: Record<StepStatus, string> = {
  done: "bg-[var(--color-success-bg)] text-[var(--color-success)]",
  in_progress: "bg-[var(--color-info-bg)] text-[var(--color-info)]",
  failed: "bg-[var(--color-danger-bg)] text-[var(--color-danger)]",
  not_started: "bg-ink-100 text-ink-500",
  not_applicable: "bg-ink-100 text-ink-400",
};

const ICON: Record<StepStatus, ReactNode> = {
  done: <Check className="h-3.5 w-3.5" />,
  in_progress: <Clock className="h-3.5 w-3.5" />,
  failed: <X className="h-3.5 w-3.5" />,
  not_started: <Circle className="h-3 w-3" />,
  not_applicable: <Minus className="h-3.5 w-3.5" />,
};

/**
 * Payment → booking → tickets (→ refund) as an ordered list. Modelled on the
 * console inquiry timeline (src/app/admin/_components/inquiry/timeline.tsx):
 * a small tone disc per row, a bold line and a quiet timestamp. Each row says
 * its step, its state in words ("Done", "In progress") and the server's own
 * label; the disc is decorative.
 */
export function StatusTimeline({ steps, className }: { steps: CustomerOrderStatus["steps"]; className?: string }) {
  const rows = timelineRows(steps);
  return (
    <ol className={cn("space-y-4", className)} data-testid="order-timeline">
      {rows.map((row) => (
        <li key={row.key} className="flex gap-3" data-step={row.key} data-step-status={row.step.status}>
          <span
            className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", DISC[row.step.status])}
            aria-hidden="true"
          >
            {ICON[row.step.status]}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              <span className="font-bold text-ink-900">{row.title}</span>
              <span className="text-ink-600">: {row.statusText}</span>
            </p>
            <p className="mt-0.5 text-sm leading-relaxed text-ink-700">{row.step.label}</p>
            {row.step.at && (
              <p className="mt-0.5 text-xs text-ink-500">
                <DubaiTime iso={row.step.at} />
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
