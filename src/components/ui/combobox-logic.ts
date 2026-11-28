/**
 * Pure logic of the Combobox (combobox.tsx): filtering and keyboard movement.
 * Kept apart so it is tested without a browser (the unit project has no DOM).
 */

export interface ComboboxOption {
  /** What `onChange` receives. Unique within the list. */
  value: string;
  label: string;
  /** A second line, e.g. a hotel's area. Searched as well as the label. */
  detail?: string | null;
}

/** Lower case, accents and punctuation folded to spaces, so "Hôtel D'Or" matches "hotel d or". */
export function normaliseForSearch(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface FilterResult {
  shown: ComboboxOption[];
  /** How many options match in all, before the display cap. */
  total: number;
}

/**
 * The options that match `query`: every word of the query must start a word
 * of the label or the detail. Labels that start with the query come first;
 * otherwise the list keeps its own order. At most `limit` are returned
 * (rendering a few hundred rows on every keystroke would cost a mid-range
 * phone more than the 100 ms budget, doc 29 §6.6).
 */
export function filterOptions(options: readonly ComboboxOption[], query: string, limit = 100): FilterResult {
  const words = normaliseForSearch(query).split(" ").filter(Boolean);
  if (!words.length) return { shown: options.slice(0, limit), total: options.length };
  const first: ComboboxOption[] = [];
  const rest: ComboboxOption[] = [];
  const whole = words.join(" ");
  for (const o of options) {
    const label = normaliseForSearch(o.label);
    const hay = ` ${label} ${normaliseForSearch(o.detail ?? "")} `;
    if (!words.every((w) => hay.includes(` ${w}`))) continue;
    (label.startsWith(whole) ? first : rest).push(o);
  }
  const all = [...first, ...rest];
  return { shown: all.slice(0, limit), total: all.length };
}

export type ListKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "PageDown" | "PageUp";
const PAGE = 10;

/** The active option after a navigation key, clamped to the list (WAI-ARIA 1.2 listbox popup). -1: none (empty list). */
export function moveActive(key: ListKey, current: number, count: number): number {
  if (count <= 0) return -1;
  const at = current < 0 ? -1 : Math.min(current, count - 1);
  switch (key) {
    case "ArrowDown":
      return Math.min(at + 1, count - 1);
    case "ArrowUp":
      return at <= 0 ? 0 : at - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "PageDown":
      return Math.min(Math.max(at, 0) + PAGE, count - 1);
    case "PageUp":
      return Math.max(at - PAGE, 0);
  }
}

export function isListKey(key: string): key is ListKey {
  return key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End" || key === "PageDown" || key === "PageUp";
}

/** What the polite live region says for a result. */
export function resultAnnouncement(total: number, shown: number, noun: { one: string; many: string }): string {
  if (total === 0) return `No ${noun.many} match`;
  if (total > shown) return `${total} ${noun.many} match, first ${shown} shown. Keep typing to narrow the list`;
  return total === 1 ? `1 ${noun.one} matches` : `${total} ${noun.many} match`;
}

/**
 * The rows to render with the chosen one always among them: when `value` names
 * an option that the display cap left out, it is put first (the last row
 * shown drops out). Used for an empty query, so opening the list starts on
 * the chosen hotel wherever it sits in a long list.
 */
export function pinSelected(result: FilterResult, options: readonly ComboboxOption[], value: string | null): FilterResult {
  if (value === null || result.shown.some((o) => o.value === value)) return result;
  const chosen = options.find((o) => o.value === value);
  if (!chosen || result.shown.length === 0) return result;
  return { shown: [chosen, ...result.shown.slice(0, result.shown.length - 1)], total: result.total };
}

/**
 * Whether a blur leaves the combobox: focus moves to an element outside
 * `root`, or nowhere (the window lost focus or a non-focusable spot was
 * pressed). The panel then closes; Tab inside the field (the filter to the
 * empty state's action, the action back to the trigger) keeps it open.
 */
export function focusLeaves(root: { contains(node: Node | null): boolean } | null, next: EventTarget | null): boolean {
  if (!root) return true;
  return !(next && root.contains(next as Node));
}
