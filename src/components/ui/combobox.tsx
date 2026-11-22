// Source: 21st.dev "Combobox" by halaska-studio (21st.dev demo id 34727, component id 19353), demo "Combobox with preselected value"
// https://21st.dev/@halaska-studio/components/combobox
// Licence: MIT (https://github.com/Halaska-Studio/ui/blob/main/LICENSE), read from the 21st.dev page on 23 November 2026.
// Retrieved with the 21st.dev MCP get_component on 23 November 2026. Unmodified below this header (plain JavaScript, inline styles, its own token set).
// (That line describes the retrieved file, kept verbatim at docs/21st-dev/vendor/combobox-halaska.jsx.txt; .txt so it is never built or linted.)
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
//   - Accessibility (WAI-ARIA 1.2): the visible label, hint and error belong to the field and name and
//     describe the trigger (`aria-labelledby`, `aria-describedby`, `aria-invalid`, `aria-required`); the
//     trigger keeps the author's `role="combobox"` (select-only pattern) with `aria-controls` added; the
//     filter field is a labelled text field that owns the highlight (`aria-autocomplete="list"`,
//     `aria-controls`, `aria-activedescendant`); options are `role="option"`
//     rows, not buttons in the tab order; Home, End, PageUp and PageDown move the highlight; Tab closes;
//     the highlighted row is kept in view; one polite live region says how many rows match.
//   - Scale: the filter is client-side over the list given (a few hundred hotels), accent- and
//     case-insensitive, by word start in the label or the detail line (combobox-logic.ts); at most
//     `maxShown` rows are rendered with a "keep typing" line, instead of virtualising.
//   - Layout: 48 px trigger and 44 px rows (touch targets), full width of its column, panel as wide as
//     the trigger and list capped at 40vh so it stays usable at 320 px and at 200% zoom; long names wrap.
//   - Empty state: `emptyAction` lets the page offer a way out (our team) with what was typed.
"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { filterOptions, isListKey, moveActive, resultAnnouncement, type ComboboxOption } from "./combobox-logic";

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
  const uid = `cbx${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const { shown: filtered, total } = useMemo(() => filterOptions(options, query, maxShown), [options, query, maxShown]);
  const selected = options.find((o) => o.value === value);
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const listId = `${uid}-list`;
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
    // Start on the chosen row, so Enter keeps it.
    setIdx(Math.max(0, options.findIndex((o) => o.value === value)));
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
    <div ref={ref} className={cn("relative flex min-w-0 flex-col", className)}>
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
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={`${labelId} ${valueId}`}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            openList();
          }
        }}
        className={cn(
          "mt-2 flex min-h-12 w-full items-center justify-between gap-3 rounded-[var(--radius-control)] border bg-paper px-3.5 py-2 text-left text-base outline-none transition-[border-color,box-shadow] duration-150 focus-visible:border-sun-700 focus-visible:ring-[3px] focus-visible:ring-sun-300/45 disabled:cursor-not-allowed disabled:bg-ink-100 disabled:text-ink-600",
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
      {open && (
        <div
          className={cn(
            "absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-[var(--radius-card)] border border-ink-200 bg-paper shadow-pop",
            "origin-top transition-[opacity,scale] duration-150 ease-[var(--ease-out-soft)] starting:scale-[0.97] starting:opacity-0 motion-reduce:starting:scale-100",
          )}
        >
          <div className="flex items-center gap-2 border-b border-ink-200 px-3.5">
            <Search aria-hidden="true" className="size-4 shrink-0 text-ink-600" />
            <input
              autoFocus
              type="text"
              aria-autocomplete="list"
              aria-label={searchLabel}
              aria-controls={listId}
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
                } else if (e.key === "Tab") {
                  setOpen(false);
                }
              }}
              className="min-h-12 w-full min-w-0 bg-transparent text-base text-ink-900 outline-none placeholder:text-ink-600"
            />
          </div>
          <p role="status" aria-live="polite" className="sr-only">
            {resultAnnouncement(total, filtered.length, noun)}
          </p>
          <div ref={listRef} id={listId} role="listbox" aria-labelledby={labelId} className="max-h-[40vh] overflow-y-auto overscroll-contain p-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-sm text-ink-700">
                <p className="font-semibold text-ink-900">No {noun.many} match &ldquo;{query.trim()}&rdquo;</p>
                {emptyAction ? <div className="mt-2">{emptyAction(query.trim())}</div> : null}
              </div>
            ) : (
              filtered.map((o, i) => (
                <div
                  key={o.value}
                  id={`${uid}-opt-${i}`}
                  role="option"
                  aria-selected={o.value === value}
                  // The filter field keeps focus; a press must not move it.
                  onMouseDown={(e) => e.preventDefault()}
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
              ))
            )}
            {total > filtered.length && (
              <p className="px-3 py-2 text-sm text-ink-600">
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
