// Source: 21st.dev "Combobox" by halaska-studio (21st.dev demo id 34727, component id 19353), demo "Combobox with preselected value"
// https://21st.dev/@halaska-studio/components/combobox
// Licence: MIT (https://github.com/Halaska-Studio/ui/blob/main/LICENSE), read from the 21st.dev page on 23 November 2026.
// Retrieved with the 21st.dev MCP get_component on 23 November 2026. The retrieved file (plain JavaScript, inline styles, its own token set)
// is kept verbatim at docs/21st-dev/vendor/combobox-halaska.jsx.txt (.txt so it is never built or linted); this file is the adaptation below.
//
// OUTLYY adaptation (doc 29 §7.3 Batch 3, §8.5; recorded in docs/21st-dev-implementation.md §6). The
// author's structure is kept: a trigger that opens a panel with a filter field above a listbox, the
// highlighted row moved with the arrow keys from the filter, Enter to pick, Escape to close and return
// focus to the trigger, a click outside to close. What changed, and why:
//   - TypeScript: typed props and options; the author's `tokens`, `motion`, theme and accent contexts and
//     `usePal` are removed (no second palette in the app).
//   - Colours, type, radii, shadow: the inline styles are replaced with the project's Tailwind tokens
//     (ink, sun, paper, danger; --radius-control field, --radius-card panel, shadow-pop; body font), so no
//     foreign colour and no purple accent remain. The selected row is marked with lucide's Check icon,
//     not the "✓" character.
//   - Motion: the author's `halaska-scale-in` keyframe and 16 px backdrop blur are dropped. The panel
//     is opaque paper and enters with a 150 ms opacity and 0.97 scale transition from the trigger's
//     edge; under reduced motion only the opacity changes (and the global rule makes it instant).
//   - Accessibility (WAI-ARIA 1.2, editable combobox inside a popup): the visible label, hint and error
//     belong to the field and name and describe the trigger (`aria-labelledby`, `aria-describedby`); the
//     combobox carries `aria-invalid` and `aria-required` (a button may not). The trigger is a button that opens a non-modal panel
//     (`aria-haspopup="dialog"`, `aria-expanded`, `aria-controls`); the author's `role="combobox"` moves to
//     the focused filter field, which carries `aria-expanded`, `aria-controls` (the listbox),
//     `aria-autocomplete="list"` and `aria-activedescendant`. The listbox holds options only; the empty
//     state, its action and the "Showing N of M" line are siblings of it. Options are `role="option"`
//     rows (the author's were `tabIndex={-1}` buttons); Home, End, PageUp and PageDown move the highlight; the
//     highlighted row is kept in view. The panel closes when focus leaves the field (not on Tab), so Tab
//     reaches the empty state's action. While unavailable the trigger is `aria-disabled`, still focusable,
//     so an error summary link lands on it. One polite live region, always mounted, says how many rows match.
//   - Scale: the filter is client-side over the list given (a few hundred hotels), accent- and
//     case-insensitive, by word start in the label or the detail line (combobox-logic.ts); at most
//     `maxShown` rows are rendered with a "keep typing" line, instead of virtualising.
//   - Layout: 48 px trigger and 44 px rows (touch targets), full width of its column, panel as wide as
//     the trigger and list capped at 40vh so it stays usable at 320 px and at 200% zoom; long names wrap.
//   - Empty state: `emptyAction` lets the page offer a way out (our team) with what was typed.
//   - Licence text: THIRD-PARTY-NOTICES.md at the repository root (MIT, copyright Halaska Studio).
"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { filterOptions, focusLeaves, isListKey, moveActive, pinSelected, resultAnnouncement, type ComboboxOption } from "./combobox-logic";

export type { ComboboxOption } from "./combobox-logic";

export interface ComboboxProps {
  /** The trigger's id: the target of the label and of an error summary link. */
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  options: readonly ComboboxOption[];
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Accessible name and placeholder of the filter field. */
  searchLabel: string;
  searchPlaceholder?: string;
  /** Words for the live region ("hotel", "hotels"). */
  noun?: { one: string; many: string };
  /** Shown under "No … match", with what was typed. */
  emptyAction?: (query: string) => ReactNode;
  disabled?: boolean;
  maxShown?: number;
  /** Starts open (tests and previews). */
  defaultOpen?: boolean;
  className?: string;
}

function Combobox({
  id,
  label,
  hint,
  error,
  required,
  options = [],
  value,
  onChange,
  placeholder = "Select…",
  searchLabel,
  searchPlaceholder,
  noun = { one: "result", many: "results" },
  emptyAction,
  disabled,
  maxShown = 100,
  defaultOpen = false,
  className,
}: ComboboxProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const uid = `cbx${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // With no query, the chosen row is always rendered, even past the display cap, so opening starts on it.
  const { shown: filtered, total } = useMemo(() => pinSelected(filterOptions(options, query, maxShown), options, query ? null : value), [options, query, maxShown, value]);
  const selected = options.find((o) => o.value === value);
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const listId = `${uid}-list`;
  const panelId = `${uid}-panel`;
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  const active = idx >= 0 && idx < filtered.length ? idx : -1;

  const closeAndReturn = () => {
    setOpen(false);
    ref.current?.querySelector<HTMLButtonElement>("[data-combobox-trigger]")?.focus();
  };
  const pick = (o: ComboboxOption) => {
    onChange(o.value);
    closeAndReturn();
  };
  const openList = () => {
    if (disabled) return;
    setQuery("");
    // Start on the chosen row, so Enter keeps it (its place in the rows shown for an empty query).
    setIdx(Math.max(0, pinSelected(filterOptions(options, "", maxShown), options, value).shown.findIndex((o) => o.value === value)));
    setOpen(true);
  };

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Keep the highlighted row in view as the keys move it.
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${uid}-opt-${active}`)}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, uid]);

  return (
    <div
      ref={ref}
      className={cn("relative flex min-w-0 flex-col", className)}
      // Close when focus leaves the whole field, not on Tab: Tab from the filter can then reach the empty state's action.
      onBlur={(e) => {
        if (open && focusLeaves(ref.current, e.relatedTarget)) setOpen(false);
      }}
    >
      <label id={labelId} htmlFor={id} className="block text-sm font-bold text-ink-900">
        {label}
        {!required && <span className="font-normal text-ink-600"> (optional)</span>}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="mt-0.5 text-sm text-ink-600">
          {hint}
        </p>
      ) : null}
      <button
        id={id}
        type="button"
        data-combobox-trigger
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-labelledby={`${labelId} ${valueId}`}
        // The error is read through the description; aria-invalid and aria-required belong to the combobox (the filter) below.
        aria-describedby={describedBy}
        // Not the native attribute: a disabled button leaves the tab order, and the error summary link must land here.
        aria-disabled={disabled || undefined}
        // While open, a press on the trigger keeps focus in the filter, so the panel does not close and reopen; the click closes.
        onMouseDown={(e) => {
          if (open) e.preventDefault();
        }}
        onClick={() => (open ? closeAndReturn() : openList())}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            openList();
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className={cn(
          "mt-2 flex min-h-12 w-full items-center justify-between gap-3 rounded-[var(--radius-control)] border bg-paper px-3.5 py-2 text-left text-base outline-none transition-[border-color,box-shadow] duration-150 focus-visible:border-sun-700 focus-visible:ring-[3px] focus-visible:ring-sun-300/45 aria-disabled:cursor-not-allowed aria-disabled:bg-ink-100 aria-disabled:text-ink-600",
          error ? "border-[var(--color-danger)]" : open ? "border-sun-700" : "border-ink-300",
        )}
      >
        <span id={valueId} className={cn("min-w-0 break-words", selected ? "text-ink-900" : "text-ink-600")}>
          {selected ? (
            <>
              <span className="font-semibold">{selected.label}</span>
              {selected.detail ? <span className="text-ink-600">, {selected.detail}</span> : null}
            </>
          ) : (
            placeholder
          )}
        </span>
        <ChevronDown aria-hidden="true" className={cn("size-4.5 shrink-0 text-ink-600 transition-transform duration-150", open && "rotate-180")} />
      </button>
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 flex gap-1.5 text-sm font-semibold text-[var(--color-danger)]">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
      {/* Always mounted and empty while closed, so the first count after opening is announced. */}
      <p role="status" aria-live="polite" className="sr-only">
        {open ? resultAnnouncement(total, filtered.length, noun) : ""}
      </p>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-labelledby={labelId}
          // A press anywhere in the panel but the filter keeps focus in the filter, so the panel is still open when the click lands.
          onMouseDown={(e) => {
            if (e.target !== inputRef.current) e.preventDefault();
          }}
          className={cn(
            "absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-[var(--radius-card)] border border-ink-200 bg-paper shadow-pop",
            "origin-top transition-[opacity,scale] duration-150 ease-[var(--ease-out-soft)] starting:scale-[0.97] starting:opacity-0 motion-reduce:starting:scale-100",
          )}
        >
          <div className="flex items-center gap-2 border-b border-ink-200 px-3.5">
            <Search aria-hidden="true" className="size-4 shrink-0 text-ink-600" />
            <input
              ref={inputRef}
              autoFocus
              type="text"
              role="combobox"
              aria-expanded={filtered.length > 0}
              aria-autocomplete="list"
              aria-label={searchLabel}
              aria-describedby={describedBy}
              aria-invalid={error ? true : undefined}
              aria-required={required || undefined}
              aria-controls={filtered.length > 0 ? listId : undefined}
              aria-activedescendant={active >= 0 ? `${uid}-opt-${active}` : undefined}
              autoComplete="off"
              spellCheck={false}
              value={query}
              placeholder={searchPlaceholder ?? searchLabel}
              onChange={(e) => {
                setQuery(e.target.value);
                setIdx(0);
              }}
              onKeyDown={(e) => {
                if (isListKey(e.key)) {
                  e.preventDefault();
                  setIdx((i) => moveActive(e.key as Parameters<typeof moveActive>[0], i, filtered.length));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (filtered[active]) pick(filtered[active]);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  closeAndReturn();
                }
              }}
              className="min-h-12 w-full min-w-0 bg-transparent text-base text-ink-900 outline-none placeholder:text-ink-600"
            />
          </div>
          <div className="max-h-[40vh] overflow-y-auto overscroll-contain">
            {filtered.length === 0 ? (
              <div className="px-4 py-4 text-sm text-ink-700">
                <p className="font-semibold text-ink-900">No {noun.many} match &ldquo;{query.trim()}&rdquo;</p>
                {emptyAction ? <div className="mt-2">{emptyAction(query.trim())}</div> : null}
              </div>
            ) : (
              <div ref={listRef} id={listId} role="listbox" aria-labelledby={labelId} className="p-1">
                {filtered.map((o, i) => (
                  <div
                    key={o.value}
                    id={`${uid}-opt-${i}`}
                    role="option"
                    aria-selected={o.value === value}
                    onClick={() => pick(o)}
                    onMouseMove={() => setIdx(i)}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-[0.5rem] px-3 py-2 text-[0.9375rem] text-ink-900",
                      active === i && "bg-sun-50",
                    )}
                  >
                    <span className="min-w-0 break-words">
                      <span className={cn(o.value === value && "font-semibold")}>{o.label}</span>
                      {o.detail ? <span className="block text-sm text-ink-600">{o.detail}</span> : null}
                    </span>
                    {o.value === value && <Check aria-hidden="true" className="size-4 shrink-0 text-sun-700" />}
                  </div>
                ))}
              </div>
            )}
            {total > filtered.length && (
              <p className="px-4 pb-3 pt-2 text-sm text-ink-600">
                Showing {filtered.length} of {total}. Keep typing to narrow the list.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export { Combobox };
export default Combobox;
