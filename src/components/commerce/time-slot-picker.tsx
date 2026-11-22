// Source: 21st.dev "Time Slot Picker" by klyv-ui (21st.dev demo id 43217, component id 24930)
// https://21st.dev/@klyv-ui/components/time-slot-picker
// Licence: MIT (https://github.com/Klyv-UI/klyv/blob/main/LICENSE), read from the 21st.dev page on 23 November 2026.
// Retrieved with the 21st.dev MCP get_component on 23 November 2026. The unmodified copy is commit 7970ae8.
//
// Adapted for OUTLYY, doc 29 Batch 2 (every change is recorded in docs/21st-dev-implementation.md §4c):
//   - the day strip is removed: the booking widget keeps its own DateStrip and calendar sheet, so the
//     date is chosen once; this component is only the vendor's time grid for one date (`date` prop);
//   - the value is the start time `HH:mm` (what the cart line and the quote carry), not `date T time`;
//   - times are printed as the literal `HH:mm` the supplier lists, never through the browser's clock,
//     and the zone line is fixed to the activity's own zone ("Dubai time, Asia/Dubai"), not the browser's;
//   - project tokens: ink-900 selected chip (as DateStrip and TimeSlots), ink-200/300 lines, paper surface,
//     tabular numerals, 44 px targets; no new colour;
//   - availability is said in words ("Few left", "Sold out", "Unavailable"), not by strike-through alone;
//   - loading skeleton chips, and one polite live line ("5 start times available") for screen readers;
//   - keyboard: the vendor's roving radio group kept (arrows skip unavailable times), Home and End added,
//     the arrow logic moved to the pure `nextUsableIndex` so it can be unit-tested without a DOM;
//   - motion: colour transitions only, under `motion-safe`, and nothing animates on a keyboard move;
//   - the vendor's sync-on-value effect is gone with the day strip (it only served the strip).
"use client";

import { useId, useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export interface TimeSlotPickerSlot {
  /** 24-hour `HH:mm`, Asia/Dubai, as the supplier lists it. */
  time: string;
  /** `available` by default. Unavailable times stay visible so the gaps make sense. */
  status?: "available" | "limited" | "sold_out" | "unavailable";
}

export interface TimeSlotPickerProps {
  /** ISO `yyyy-mm-dd` the times belong to (chosen in the page's own date strip). */
  date: string;
  slots: TimeSlotPickerSlot[];
  /** Controlled choice, `HH:mm`, or undefined. */
  value?: string;
  onValueChange?: (time: string) => void;
  /** Accessible name of the radio group; also the visible heading's id target. */
  label?: string;
  /** Skeleton chips while the times for `date` load. */
  loading?: boolean;
  /** Printed under the grid. Fixed by default to the activity's zone, never the browser's. */
  timeZoneLabel?: string;
  /** Lets the page move focus here (e.g. after a refused time). */
  groupRef?: React.Ref<HTMLDivElement>;
  /** Extra line under the grid, e.g. "As of 14:05". */
  note?: React.ReactNode;
  className?: string;
}

/** Dubai has no daylight saving, so the zone is one fixed line. */
export const DUBAI_TIME_LABEL = "Times are Dubai time (Asia/Dubai, GMT+4)";

const usable = (s: TimeSlotPickerSlot | undefined) => !!s && (s.status === undefined || s.status === "available" || s.status === "limited");

/**
 * The next usable index from `index` for a key, or null when the key is not a
 * navigation key or no other slot is usable. Arrows wrap and skip unusable
 * slots (the vendor's rule); Home and End go to the first and last usable.
 */
export function nextUsableIndex(key: string, index: number, slots: readonly TimeSlotPickerSlot[], columns: number): number | null {
  const count = slots.length;
  if (count === 0) return null;
  if (key === "Home" || key === "End") {
    const order = key === "Home" ? slots.map((_, i) => i) : slots.map((_, i) => count - 1 - i);
    return order.find((i) => usable(slots[i])) ?? null;
  }
  const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns };
  const delta = step[key];
  if (delta === undefined) return null;
  for (let offset = 1; offset <= count; offset += 1) {
    const next = (((index + delta * offset) % count) + count) % count;
    if (usable(slots[next])) return next;
  }
  return null;
}

/** "5 start times available", for the polite live line. */
export function availableTimesLine(slots: readonly TimeSlotPickerSlot[]): string {
  const n = slots.filter(usable).length;
  if (n === 0) return "No start times available on this date";
  return `${n} start ${n === 1 ? "time" : "times"} available`;
}

const WORD: Record<string, string | undefined> = { limited: "Few left", sold_out: "Sold out", unavailable: "Unavailable" };

/**
 * Start-time picker for one date: a radio group of the supplier's listed
 * start times. Unavailable times stay in the grid, said in words and skipped
 * by the arrow keys. The zone is always printed.
 */
export function TimeSlotPicker({
  date,
  slots,
  value,
  onValueChange,
  label = "Choose a start time",
  loading,
  timeZoneLabel = DUBAI_TIME_LABEL,
  groupRef,
  note,
  className,
}: TimeSlotPickerProps) {
  const uid = useId();
  const slotRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Three columns fit five-character times at 320 px; the arrow-key rows follow the narrowest layout.
  const columns = 3;

  const checkedSlot = slots.findIndex((slot) => slot.time === value && usable(slot));
  const slotStop = checkedSlot >= 0 ? checkedSlot : slots.findIndex(usable);

  const onKey = (event: KeyboardEvent, index: number) => {
    const next = nextUsableIndex(event.key, index, slots, columns);
    if (next === null) return;
    event.preventDefault();
    onValueChange?.(slots[next].time);
    slotRefs.current[next]?.focus();
  };

  return (
    <div className={cn("flex w-full flex-col gap-2", className)} data-date={date}>
      {loading ? (
        <div className="grid grid-cols-3 gap-2" aria-busy="true" aria-label="Checking times with the operator">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="skeleton h-11 rounded-full" aria-hidden="true" />
          ))}
        </div>
      ) : slots.length === 0 || !slots.some(usable) ? (
        <p className="rounded-[var(--radius-control)] border border-dashed border-ink-300 px-4 py-5 text-center text-sm font-medium text-ink-600">
          No start times left on this date. Pick another date, or ask our team on WhatsApp.
        </p>
      ) : (
        <div
          ref={groupRef}
          role="radiogroup"
          aria-label={label}
          aria-describedby={`${uid}-zone`}
          tabIndex={-1}
          className="grid grid-cols-3 gap-2 outline-none"
        >
          {slots.map((slot, index) => {
            const open = usable(slot);
            const checked = index === checkedSlot;
            const word = WORD[slot.status ?? "available"];
            return (
              <button
                key={slot.time}
                ref={(node) => {
                  slotRefs.current[index] = node;
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={!open}
                tabIndex={index === slotStop ? 0 : -1}
                onClick={() => onValueChange?.(slot.time)}
                onKeyDown={(event) => onKey(event, index)}
                className={cn(
                  "flex min-h-11 flex-col items-center justify-center rounded-full border px-2 py-1 text-sm tnum motion-safe:transition-colors",
                  checked
                    ? "border-ink-900 bg-ink-900 font-bold text-white"
                    : "border-ink-300 bg-paper font-semibold text-ink-800 [@media(hover:hover)]:hover:border-ink-900",
                  "disabled:cursor-not-allowed disabled:border-ink-200 disabled:bg-ink-100 disabled:font-medium disabled:text-ink-600",
                )}
              >
                <span className={cn(!open && "line-through decoration-ink-400")}>{slot.time}</span>
                {word && (
                  <span className={cn("text-2xs font-bold leading-tight", checked ? "text-white" : slot.status === "limited" ? "text-[var(--color-warning)]" : "text-ink-600")}>
                    {word}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <p id={`${uid}-zone`} className="text-xs font-medium text-ink-500">
        {timeZoneLabel}
      </p>
      {note}
      <p className="sr-only" aria-live="polite">
        {loading ? "" : availableTimesLine(slots)}
      </p>
    </div>
  );
}

export default TimeSlotPicker;
