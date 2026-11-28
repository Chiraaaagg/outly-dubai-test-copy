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
//   - the vendor's sync-on-value effect is gone with the day strip (it only served the strip);
//   - narrow columns: two columns when the picker is under 18rem wide (320 px phone, 200% zoom), three
//     otherwise, by container query; the arrow keys read the columns actually laid out;
//   - the radio group can take `aria-labelledby` (the visible heading) and `aria-describedby` (a notice);
//     the live line is mounted empty and filled after, and says "Checking times with the operator"
//     while loading.
//   - more than 12 times (a listing may list up to 96) scroll inside the grid, 15rem high (about four and
//     a half rows of chips), so the sticky booking card no longer grows with the number of times; scroll
//     padding keeps a focused chip's ring clear of the box edge, and the checked time is scrolled into
//     view inside the box (never the page) when the grid mounts or the date or value changes.
// Licence text: THIRD-PARTY-NOTICES.md at the repository root (MIT, copyright Klyv contributors).
"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
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
  /** Accessible name of the radio group, when no visible heading names it (`labelledBy`). */
  label?: string;
  /** Id of the visible heading that names the radio group. */
  labelledBy?: string;
  /** Id of a notice about the times (e.g. why a time was refused), read with the group. */
  describedBy?: string;
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
  if (n === 0) return "No start times can be booked on this date";
  return `${n} start ${n === 1 ? "time" : "times"} available`;
}

/** Above this many times the list scrolls inside itself (a listing may offer up to 96, every 15 minutes). */
export const SCROLL_AFTER_SLOTS = 12;

/**
 * Gives a long list of times a fixed height of 15rem: about four and a half
 * rows of this picker's 44 px chips (about five of the smaller `TimeSlots`
 * chips), so the booking card, sticky on desktop, no longer grows with the
 * number of times and the cut row shows there is more. It does not promise the
 * card fits every screen. Sized in rem so it grows with text zoom. The padding
 * keeps the first and last rows' focus rings inside the box; the scroll
 * padding keeps a chip focused mid-list clear of the edge, for native focus
 * scrolling and `revealTime` alike. Short lists are unchanged.
 */
export function longTimesClass(count: number): string | undefined {
  return count > SCROLL_AFTER_SLOTS ? "-m-1.5 max-h-[15rem] overflow-y-auto scroll-py-2 p-1.5" : undefined;
}

/** Marks the element that scrolls a long list of times (set with `longTimesClass`). */
export const TIMES_SCROLL_ATTR = "data-times-scroll";

/**
 * The box `scrollTop` that shows a chip whole with `padding` clear above and
 * below it (its focus ring); the current one when it already shows. Rects are
 * viewport pixels. Pure, so it is unit-tested without a DOM.
 */
export function scrollTopToReveal(box: { top: number; bottom: number; scrollTop: number }, chip: { top: number; bottom: number }, padding: number): number {
  if (chip.top < box.top + padding) return Math.max(0, box.scrollTop - (box.top + padding - chip.top));
  if (chip.bottom > box.bottom - padding) return box.scrollTop + (chip.bottom - (box.bottom - padding));
  return box.scrollTop;
}

/**
 * Scrolls only the long-list box around `chip` so the chip shows whole. Never
 * scrolls the page: a caller that also moves the page does so itself, once.
 */
export function revealTime(chip: HTMLElement | null | undefined): void {
  const box = chip?.closest<HTMLElement>(`[${TIMES_SCROLL_ATTR}]`);
  if (!chip || !box || box === chip) return;
  const b = box.getBoundingClientRect();
  const pad = Number.parseFloat(getComputedStyle(box).scrollPaddingTop) || 0;
  box.scrollTop = scrollTopToReveal({ top: b.top, bottom: b.bottom, scrollTop: box.scrollTop }, chip.getBoundingClientRect(), pad);
}

/**
 * Up and Down in a wrapped row of chips of different widths: the usable chip
 * in the nearest row below (1) or above (-1) whose centre is closest to this
 * one's; null at the first or last row. `boxes` are layout offsets.
 */
export function rowNeighbour(index: number, dir: 1 | -1, boxes: readonly ({ top: number; center: number } | null)[], usableAt: readonly boolean[]): number | null {
  const here = boxes[index];
  if (!here) return null;
  let rowTop: number | null = null;
  boxes.forEach((b, i) => {
    if (!b || !usableAt[i] || (dir === 1 ? b.top <= here.top : b.top >= here.top)) return;
    if (rowTop === null || (dir === 1 ? b.top < rowTop : b.top > rowTop)) rowTop = b.top;
  });
  if (rowTop === null) return null;
  let best: number | null = null;
  let distance = Infinity;
  boxes.forEach((b, i) => {
    if (!b || !usableAt[i] || b.top !== rowTop) return;
    const d = Math.abs(b.center - here.center);
    if (d < distance) {
      distance = d;
      best = i;
    }
  });
  return best;
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
  labelledBy,
  describedBy,
  loading,
  timeZoneLabel = DUBAI_TIME_LABEL,
  groupRef,
  note,
  className,
}: TimeSlotPickerProps) {
  const uid = useId();
  const slotRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Mounted empty, then filled, so the first line after the times arrive is announced (a live region that
  // mounts holding its text is often not read).
  const [liveLine, setLiveLine] = useState("");
  const liveText = loading ? "Checking times with the operator" : availableTimesLine(slots);
  useEffect(() => {
    // A tick later, after the region is in the page.
    const t = setTimeout(() => setLiveLine(liveText), 0);
    return () => clearTimeout(t);
  }, [liveText]);

  const checkedSlot = slots.findIndex((slot) => slot.time === value && usable(slot));
  const slotStop = checkedSlot >= 0 ? checkedSlot : slots.findIndex(usable);
  const long = slots.length > SCROLL_AFTER_SLOTS;

  // A long list starts scrolled to its top: show the checked time (e.g. 19:30) inside the box, never moving the page.
  useLayoutEffect(() => {
    if (long && !loading && checkedSlot >= 0) revealTime(slotRefs.current[checkedSlot]);
  }, [date, value, slots.length, loading, long, checkedSlot]);

  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    // Up and down move by a laid-out row: two or three columns, by the picker's width.
    const grid = event.currentTarget.parentElement;
    const columns = (grid && getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length) || 3;
    const next = nextUsableIndex(event.key, index, slots, columns);
    if (next === null) return;
    event.preventDefault();
    onValueChange?.(slots[next].time);
    slotRefs.current[next]?.focus();
  };

  return (
    <div className={cn("@container flex w-full flex-col gap-2", className)} data-date={date}>
      {loading ? (
        <div className="grid grid-cols-2 gap-2 @[18rem]:grid-cols-3" aria-hidden="true">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="skeleton h-11 rounded-full" aria-hidden="true" />
          ))}
        </div>
      ) : slots.length === 0 || !slots.some(usable) ? (
        <p className="rounded-[var(--radius-control)] border border-dashed border-ink-300 px-4 py-5 text-center text-sm font-medium text-ink-600">
          No start times can be booked on this date. Pick another date, or ask our team on WhatsApp.
        </p>
      ) : (
        <div
          ref={groupRef}
          role="radiogroup"
          aria-label={labelledBy ? undefined : label}
          aria-labelledby={labelledBy}
          aria-describedby={[describedBy, `${uid}-zone`].filter(Boolean).join(" ")}
          tabIndex={-1}
          className={cn("grid grid-cols-2 gap-2 outline-none @[18rem]:grid-cols-3", longTimesClass(slots.length))}
          data-times-scroll={long || undefined}
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
      <p className="sr-only" role="status" aria-live="polite">
        {liveLine}
      </p>
    </div>
  );
}

export default TimeSlotPicker;
