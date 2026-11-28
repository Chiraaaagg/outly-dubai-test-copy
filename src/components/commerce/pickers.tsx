"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Minus, Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { track } from "@/lib/analytics";
import { guestRowAges, type GuestRowAge, type PaxAgeType } from "@/lib/pax-ages";
import type { ActivityStatus, PaxCount } from "@/lib/types";
import { addDays, cn, formatDateKey, paxLabel, paxTotal, parseDateKey, toDateKey } from "@/lib/utils";
import { longTimesClass, nextUsableIndex, revealTime, rowNeighbour, SCROLL_AFTER_SLOTS } from "./time-slot-picker";

/**
 * Date, time and guest selection.
 *
 * All three are bottom sheets on mobile (thumb-reachable, PRD §6) and inline
 * popovers on desktop. Availability is passed in rather than fetched here, so
 * the same components work on the ADP (live supplier availability), in search
 * (no availability) and in booking modification (supplier-constrained).
 */

/* ---------------------------------------------------------------------------
 * Date strip — the fast path. Seven tappable days, no calendar needed.
 * ------------------------------------------------------------------------ */

export function DateStrip({
  value,
  onChange,
  statusFor,
  days = 10,
  from,
  className,
}: {
  value: string;
  onChange: (date: string) => void;
  statusFor?: (date: string) => ActivityStatus;
  days?: number;
  from?: string;
  className?: string;
}) {
  const start = from ?? toDateKey(new Date());
  const dates = useMemo(
    () => Array.from({ length: days }, (_, i) => addDays(start, i)),
    [start, days],
  );

  return (
    <div className={cn("rail -mx-1 px-1", className)} role="group" aria-label="Choose a date">
      {dates.map((d, i) => {
        const status = statusFor?.(d) ?? "available";
        const selected = d === value;
        const soldOut = status === "sold_out";
        const date = parseDateKey(d);
        return (
          <button
            key={d}
            type="button"
            disabled={soldOut}
            onClick={() => {
              onChange(d);
              track("date_selected", { selected_date: d });
            }}
            aria-pressed={selected}
            className={cn(
              "rail-item flex min-w-[4.5rem] flex-col items-center gap-0.5 rounded-[var(--radius-control)] border px-3 py-2.5 text-center transition-colors",
              selected
                ? "border-ink-900 bg-ink-900 text-white"
                : soldOut
                  ? "cursor-not-allowed border-ink-200 bg-ink-100 text-ink-400"
                  : "border-ink-200 bg-paper text-ink-800 hover:border-ink-500",
            )}
          >
            <span className="text-2xs font-semibold uppercase tracking-wide">
              {i === 0 ? "Today" : i === 1 ? "Tmrw" : date.toLocaleDateString("en-IN", { weekday: "short" })}
            </span>
            <span className="font-display text-lg font-bold leading-none tnum">{date.getDate()}</span>
            <span className="text-2xs">{date.toLocaleDateString("en-IN", { month: "short" })}</span>
            {status === "limited" && !selected && (
              <span className="text-2xs font-bold text-[var(--color-warning)]">Few left</span>
            )}
            {soldOut && <span className="text-2xs font-bold">Sold out</span>}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Full calendar — for dates beyond the strip
 * ------------------------------------------------------------------------ */

export function DatePickerSheet({
  open,
  onClose,
  value,
  onChange,
  statusFor,
}: {
  open: boolean;
  onClose: () => void;
  value: string;
  onChange: (date: string) => void;
  statusFor?: (date: string) => ActivityStatus;
}) {
  const [cursor, setCursor] = useState(() => {
    const d = parseDateKey(value);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const today = toDateKey(new Date());
  const monthLabel = cursor.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const firstWeekday = new Date(cursor.getFullYear(), cursor.getMonth(), 1).getDay();
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();

  return (
    <Sheet open={open} onClose={onClose} title="Choose your date" description="Live availability from the operator.">
      <div className="mb-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
          className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-ink-100"
          aria-label="Previous month"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <p className="font-display font-bold">{monthLabel}</p>
        <button
          type="button"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
          className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-ink-100"
          aria-label="Next month"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} className="py-1 text-2xs font-bold uppercase text-ink-500">
            {d}
          </div>
        ))}
        {Array.from({ length: firstWeekday }, (_, i) => (
          <div key={`pad-${i}`} />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const key = toDateKey(new Date(cursor.getFullYear(), cursor.getMonth(), i + 1));
          const past = key < today;
          const status = statusFor?.(key) ?? "available";
          const disabled = past || status === "sold_out";
          const selected = key === value;
          return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => {
                onChange(key);
                track("date_selected", { selected_date: key });
                onClose();
              }}
              className={cn(
                "flex aspect-square flex-col items-center justify-center rounded-lg text-sm font-semibold tnum transition-colors",
                selected
                  ? "bg-ink-900 text-white"
                  : disabled
                    ? "cursor-not-allowed text-ink-300"
                    : "text-ink-800 hover:bg-shell",
              )}
            >
              {i + 1}
              {status === "limited" && !disabled && !selected && (
                <span className="mt-0.5 h-1 w-1 rounded-full bg-[var(--color-warning)]" />
              )}
            </button>
          );
        })}
      </div>

      <p className="mt-4 flex items-center gap-3 text-xs text-ink-500">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-warning)]" /> Few spots left
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-ink-300" /> Sold out
        </span>
      </p>
    </Sheet>
  );
}

export function DateField({
  value,
  onClick,
  label = "Date",
  className,
}: {
  value: string;
  onClick: () => void;
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-13 w-full items-center gap-3 rounded-[var(--radius-control)] border border-ink-200 bg-paper px-3.5 text-left transition-colors hover:border-ink-500",
        className,
      )}
    >
      <CalendarDays className="h-5 w-5 shrink-0 text-sun-500" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-2xs font-bold uppercase tracking-wide text-ink-500">{label}</span>
        <span className="block truncate text-sm font-bold text-ink-900">{formatDateKey(value)}</span>
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------------------
 * Guests
 * ------------------------------------------------------------------------ */

const PAX_ROWS: { key: keyof PaxCount & PaxAgeType; label: string; min: number }[] = [
  { key: "adult", label: "Adults", min: 1 },
  { key: "child", label: "Children", min: 0 },
  { key: "infant", label: "Infants", min: 0 },
  { key: "senior", label: "Seniors", min: 0 },
];

/** The page's own age wording (no variant): "Age 12+", "Age 3–11", "Under 3 · usually free", "Age 60+ · …". */
const PAGE_ROW_AGES = guestRowAges(undefined);

export function GuestSelector({
  value,
  onChange,
  max = 20,
  rows,
  ages = PAGE_ROW_AGES,
  limits,
  notice,
  focusable = false,
  focusRef,
  className,
}: {
  value: PaxCount;
  onChange: (pax: PaxCount) => void;
  max?: number;
  /** Which rows to show (`guestRowsFor`, owner decision 5: no Seniors row without a senior price). Default: all four. */
  rows?: readonly (keyof PaxCount)[];
  /**
   * Age wording per row (`guestRowAges` of the selected option, doc 30 N4, D22). Default: the page's
   * own. A row the option cannot book shows why and cannot be increased.
   */
  ages?: Record<PaxAgeType, GuestRowAge>;
  /** The most guests per row the selected option takes (`guestRowLimits`, guest picker fix D3); a row at its limit cannot be increased. */
  limits?: Partial<Record<PaxAgeType, number>>;
  /**
   * True: the guest group can take focus (programmatic only, `tabIndex` -1), so the caller can move focus to it (D1,
   * D6). It then shows the product's one focus treatment (`:focus-visible`, globals.css; re-review 111b N3).
   */
  focusable?: boolean;
  /** The guest group element, for the caller to focus from an effect or handler; never read during render. */
  focusRef?: React.Ref<HTMLDivElement>;
  /**
   * What changed for the guests already set when the option changed (`guestAgesNotice`, review 102 N4-02).
   * Given (even null), a polite live region stays mounted above the rows, so the text is announced when it arrives.
   */
  notice?: string | null;
  className?: string;
}) {
  const total = paxTotal(value);
  const uid = useId();
  const shown = PAX_ROWS.filter((row) => !rows || rows.includes(row.key));
  // A closed row has no control to focus, so its reason is the group's description, read on entering the steppers (N4-06).
  const closed = shown.filter((row) => !ages[row.key].allowed);
  const closedId = `${uid}-closed`;
  const noticeId = `${uid}-notice`;
  // The notice and the closed rows describe the group, so focus moved onto it reads why (re-review 111b N2).
  const describedBy = [notice ? noticeId : null, closed.length ? closedId : null].filter(Boolean).join(" ") || undefined;

  const set = (key: keyof PaxCount, next: number) => {
    const updated = { ...value, [key]: next };
    onChange(updated);
    track("guest_count_changed", {
      guest_count: paxTotal(updated),
      pax_breakdown: paxLabel(updated),
    });
  };

  return (
    <div
      ref={focusRef}
      role="group"
      aria-label="Guests"
      aria-describedby={describedBy}
      tabIndex={focusable ? -1 : undefined}
      className={cn("space-y-1", className)}
    >
      {notice !== undefined && (
        <div role="status" aria-live="polite">
          {notice ? <p id={noticeId} className="mb-2 rounded-[var(--radius-control)] bg-sun-50 p-3 text-xs font-semibold leading-relaxed text-sun-800">{notice}</p> : null}
        </div>
      )}
      {closed.length > 0 && (
        <p id={closedId} className="sr-only">
          {closed.map((row) => `${row.label}: ${ages[row.key].srHint}.`).join(" ")}
        </p>
      )}
      {shown.map((row) => {
        const age = ages[row.key];
        const hintId = `${uid}-${row.key}-age`;
        const limit = limits?.[row.key];
        return (
          <div key={row.key} className="flex items-center justify-between gap-4 py-2.5">
            <div className="min-w-0">
              <p className="text-[0.95rem] font-bold text-ink-900">{row.label}</p>
              {/* The visible hint uses symbols ("3–11", "12+"); screen readers get it in words (N4 accessibility). */}
              <p id={hintId} className="text-xs text-ink-500">
                <span aria-hidden="true">{age.hint}</span>
                <span className="sr-only">{age.srHint}</span>
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Stepper
                label={`Decrease ${row.label}`}
                describedBy={hintId}
                disabled={value[row.key] <= row.min}
                onClick={() => set(row.key, value[row.key] - 1)}
              >
                <Minus className="h-4 w-4" />
              </Stepper>
              <span className="w-8 text-center font-display text-lg font-bold tnum" aria-live="polite">
                {value[row.key]}
              </span>
              {/* A closed row's Increase stays focusable and says why (D5): its description is the row's hint. */}
              <Stepper
                label={`Increase ${row.label}`}
                describedBy={hintId}
                disabled={age.allowed && (total >= max || (limit !== undefined && value[row.key] >= limit))}
                unavailable={!age.allowed}
                onClick={() => set(row.key, value[row.key] + 1)}
              >
                <Plus className="h-4 w-4" />
              </Stepper>
            </div>
          </div>
        );
      })}

      {total >= 5 && (
        <p className="mt-2 rounded-[var(--radius-control)] bg-sun-50 p-3 text-xs leading-relaxed text-sun-800">
          <strong className="font-bold">Booking for {total}?</strong> A private vehicle usually costs
          less than two shared cars and keeps everyone together. We can also price the whole group on
          WhatsApp.
        </p>
      )}
    </div>
  );
}

function Stepper({
  children,
  onClick,
  disabled,
  unavailable,
  label,
  describedBy,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  /** Not available on this option: focusable, announced as unavailable (`aria-disabled`), and does nothing. */
  unavailable?: boolean;
  label: string;
  /** The row's age hint, read after the button's name. */
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      onClick={unavailable ? undefined : onClick}
      disabled={disabled}
      aria-disabled={unavailable || undefined}
      aria-label={label}
      aria-describedby={describedBy}
      className="flex h-11 w-11 items-center justify-center rounded-full border border-ink-300 text-ink-800 transition-colors hover:border-ink-900 disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:border-ink-300"
    >
      {children}
    </button>
  );
}

export function GuestField({
  value,
  onClick,
  className,
}: {
  value: PaxCount;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-13 w-full items-center gap-3 rounded-[var(--radius-control)] border border-ink-200 bg-paper px-3.5 text-left transition-colors hover:border-ink-500",
        className,
      )}
    >
      <Users className="h-5 w-5 shrink-0 text-sun-500" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-2xs font-bold uppercase tracking-wide text-ink-500">Guests</span>
        <span className="block truncate text-sm font-bold text-ink-900">{paxLabel(value)}</span>
      </span>
    </button>
  );
}

export function GuestSheet({
  open,
  onClose,
  value,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  value: PaxCount;
  onChange: (pax: PaxCount) => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Who's coming?"
      description="Child and senior rates are applied automatically."
      footer={
        <Button block onClick={onClose}>
          Done · {paxLabel(value)}
        </Button>
      }
    >
      <GuestSelector value={value} onChange={onChange} />
    </Sheet>
  );
}

/* ---------------------------------------------------------------------------
 * Time slots
 * ------------------------------------------------------------------------ */

/** Keys the long time list handles itself; every other key keeps its native behaviour. */
const NAV_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

export function TimeSlots({
  slots,
  value,
  onChange,
  className,
}: {
  slots: { time: string; status: ActivityStatus | string; spotsLeft?: number }[];
  value?: string;
  onChange: (time: string) => void;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const hintId = useId();
  const [focused, setFocused] = useState<number | null>(null);
  // A long list (up to 96 times) is one Tab stop with arrow keys, Home and End, like the listed-time picker;
  // a short list keeps one Tab stop per time, as before.
  const long = slots.length > SCROLL_AFTER_SLOTS;
  const open = (i: number) => !!slots[i] && slots[i].status !== "sold_out";
  const selected = slots.findIndex((s, i) => s.time === value && open(i));
  const stop = focused !== null && open(focused) ? focused : selected >= 0 ? selected : slots.findIndex((_, i) => open(i));

  // Show the chosen time inside the scroll box when the list mounts or the choice changes, never moving the page.
  useLayoutEffect(() => {
    if (long && selected >= 0) revealTime(refs.current[selected]);
  }, [long, selected, slots.length]);

  if (!slots.length) return null;

  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!NAV_KEYS.has(event.key)) return; // Tab, Enter and Space keep their native behaviour.
    const usableAt = slots.map((_, i) => open(i));
    const next =
      event.key === "ArrowUp" || event.key === "ArrowDown"
        ? rowNeighbour(
            index,
            event.key === "ArrowDown" ? 1 : -1,
            refs.current.map((b) => (b ? { top: b.offsetTop, center: b.offsetLeft + b.offsetWidth / 2 } : null)),
            usableAt,
          )
        : nextUsableIndex(event.key, index, slots.map((_, i) => ({ time: slots[i].time, status: usableAt[i] ? "available" : "sold_out" })), 1);
    // A navigation key is consumed even at the first or last row, so it never scrolls the page or box instead.
    event.preventDefault();
    if (next === null) return;
    refs.current[next]?.focus();
  };

  return (
    <div
      className={cn("flex flex-wrap gap-2", longTimesClass(slots.length), className)}
      role="group"
      aria-label="Choose a time"
      aria-describedby={long ? hintId : undefined}
      data-times-scroll={long || undefined}
    >
      {long && (
        <span id={hintId} hidden>
          Use the arrow keys to move between times, then Enter to choose one.
        </span>
      )}
      {slots.map((slot, index) => {
        const soldOut = slot.status === "sold_out";
        const isSelected = slot.time === value;
        return (
          <button
            key={slot.time}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            disabled={soldOut}
            aria-pressed={isSelected}
            tabIndex={long ? (index === stop ? 0 : -1) : undefined}
            onFocus={long ? () => setFocused(index) : undefined}
            // Leaving the list: the Tab stop goes back to the chosen (or first open) time, as in the listed-time picker.
            onBlur={
              long
                ? (event) => {
                    if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) setFocused(null);
                  }
                : undefined
            }
            onKeyDown={long ? (event) => onKey(event, index) : undefined}
            onClick={() => {
              onChange(slot.time);
              track("time_selected", { selected_time: slot.time });
            }}
            className={cn(
              "rounded-full border px-3.5 py-2 text-sm font-semibold transition-colors",
              isSelected
                ? "border-ink-900 bg-ink-900 text-white"
                : soldOut
                  ? "cursor-not-allowed border-ink-200 bg-ink-100 text-ink-400 line-through"
                  : "border-ink-300 bg-paper text-ink-800 hover:border-ink-900",
            )}
          >
            {slot.time}
            {slot.status === "limited" && !isSelected && (
              <span className="ml-1.5 text-2xs font-bold text-[var(--color-warning)]">
                {slot.spotsLeft} left
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
