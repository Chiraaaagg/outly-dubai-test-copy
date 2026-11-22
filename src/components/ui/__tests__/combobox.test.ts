import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Combobox } from "../combobox";
import { filterOptions, isListKey, moveActive, normaliseForSearch, resultAnnouncement, type ComboboxOption } from "../combobox-logic";

/**
 * Imported Combobox (halaska-studio, 21st.dev id 34727, MIT), adapted for the
 * pickup hotel search (doc 29 Batch 3). The unit project has no DOM, so the
 * keyboard and filter rules are tested on the pure logic, and the markup the
 * checkout relies on (labels, ARIA 1.2 roles, tokens) on a static render.
 * Synthetic hotel names only.
 */

const HOTELS: ComboboxOption[] = [
  { value: "43", label: "Example Creek Hotel", detail: "Deira" },
  { value: "42", label: "Example Marina Hotel", detail: "Dubai Marina" },
  { value: "77", label: "Hôtel Exemple d'Or", detail: "Palm Jumeirah" },
  { value: "78", label: "Marina View Suites", detail: "Dubai Marina" },
];

describe("filtering", () => {
  it("is case- and accent-insensitive and matches word starts in the name or the area", () => {
    expect(normaliseForSearch("  Hôtel D'Or  ")).toBe("hotel d or");
    expect(filterOptions(HOTELS, "hotel d or").shown.map((o) => o.value)).toEqual(["77"]);
    expect(filterOptions(HOTELS, "DEIRA").shown.map((o) => o.value)).toEqual(["43"]);
    expect(filterOptions(HOTELS, "palm").shown.map((o) => o.value)).toEqual(["77"]);
    expect(filterOptions(HOTELS, "rina").shown).toEqual([]);
  });

  it("every typed word must match; names that start with the query come first", () => {
    expect(filterOptions(HOTELS, "marina").shown.map((o) => o.value)).toEqual(["78", "42"]);
    expect(filterOptions(HOTELS, "example marina").shown.map((o) => o.value)).toEqual(["42"]);
    expect(filterOptions(HOTELS, "").shown).toHaveLength(4);
  });

  it("a few hundred hotels: filtered in well under the keystroke budget and capped for rendering", () => {
    const many: ComboboxOption[] = Array.from({ length: 600 }, (_, i) => ({ value: String(1000 + i), label: `Example Hotel ${i}`, detail: i % 2 ? "Deira" : "Dubai Marina" }));
    const t0 = performance.now();
    const r = filterOptions(many, "example deira", 100);
    const ms = performance.now() - t0;
    expect(r.total).toBe(300);
    expect(r.shown).toHaveLength(100);
    expect(ms).toBeLessThan(50);
  });
});

describe("keyboard", () => {
  it("arrows, Home, End and the page keys move the highlight and stop at the ends", () => {
    expect(moveActive("ArrowDown", 0, 4)).toBe(1);
    expect(moveActive("ArrowDown", 3, 4)).toBe(3);
    expect(moveActive("ArrowUp", 0, 4)).toBe(0);
    expect(moveActive("ArrowUp", 2, 4)).toBe(1);
    expect(moveActive("Home", 3, 4)).toBe(0);
    expect(moveActive("End", 0, 4)).toBe(3);
    expect(moveActive("PageDown", 0, 40)).toBe(10);
    expect(moveActive("PageDown", 35, 40)).toBe(39);
    expect(moveActive("PageUp", 5, 40)).toBe(0);
    expect(moveActive("ArrowDown", 7, 3)).toBe(2);
    expect(moveActive("ArrowDown", 0, 0)).toBe(-1);
  });

  it("Enter, Escape, Tab and letters are not list keys (the filter field keeps them)", () => {
    for (const k of ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]) expect(isListKey(k)).toBe(true);
    for (const k of ["Enter", "Escape", "Tab", "a", " "]) expect(isListKey(k)).toBe(false);
  });

  it("the live region says how many match, in words", () => {
    expect(resultAnnouncement(0, 0, { one: "hotel", many: "hotels" })).toBe("No hotels match");
    expect(resultAnnouncement(1, 1, { one: "hotel", many: "hotels" })).toBe("1 hotel matches");
    expect(resultAnnouncement(5, 5, { one: "hotel", many: "hotels" })).toBe("5 hotels match");
    expect(resultAnnouncement(300, 100, { one: "hotel", many: "hotels" })).toMatch(/300 hotels match, first 100 shown/);
  });
});

function render(props: Partial<Parameters<typeof Combobox>[0]> = {}): string {
  return renderToStaticMarkup(
    h(Combobox, {
      id: "hotel",
      label: "Hotel for pickup",
      hint: "The operator collects you from this hotel.",
      required: true,
      options: HOTELS,
      value: null,
      onChange: () => {},
      searchLabel: "Search hotels",
      noun: { one: "hotel", many: "hotels" },
      ...props,
    }),
  );
}

describe("markup (WAI-ARIA 1.2)", () => {
  it("closed: the trigger is named by the visible label and its value, described by hint and error", () => {
    const html = render({ value: "42", error: "Choose the hotel the operator collects you from." });
    expect(html).toContain('<label id="hotel-label" for="hotel"');
    expect(html).toMatch(/<button id="hotel" type="button"[^>]*role="combobox"[^>]*aria-haspopup="listbox"/);
    expect(html).toContain('aria-required="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-labelledby="hotel-label hotel-value"');
    expect(html).toContain('aria-describedby="hotel-hint hotel-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("Example Marina Hotel");
    expect(html).toContain('id="hotel-error"');
    expect(html).not.toContain('role="listbox"');
  });

  it("open: the expanded combobox and its labelled filter field control a listbox of options, with a polite count", () => {
    const html = render({ value: "42", defaultOpen: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toMatch(/<input[^>]*aria-autocomplete="list"[^>]*aria-label="Search hotels"/);
    const list = /role="listbox"[^>]*id="([^"]+)"|id="([^"]+)" role="listbox"/.exec(html);
    expect(list).not.toBeNull();
    const listId = list![1] ?? list![2];
    expect(html).toContain(`aria-controls="${listId}"`);
    expect(html.match(/role="option"/g)).toHaveLength(4);
    expect(html).toMatch(/role="option" aria-selected="true"/);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("4 hotels match");
    // Options are not in the tab order: no buttons inside the list.
    expect(html.slice(html.indexOf('role="listbox"'))).not.toContain("<button");
  });

  it("uses the project's tokens only: no foreign palette, no purple accent, no glyph tick, no blur", () => {
    const src = readFileSync(join(process.cwd(), "src/components/ui/combobox.tsx"), "utf8");
    const code = src.replace(/^\/\/.*$/gm, "");
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(code).not.toMatch(/purple|violet|8b5cf6|backdrop|blur/i);
    expect(code).not.toContain("✓");
    expect(code).toContain("motion-reduce:");
    // The provenance header is kept.
    expect(src.startsWith('// Source: 21st.dev "Combobox" by halaska-studio (21st.dev demo id 34727')).toBe(true);
    expect(src).toContain("Licence: MIT");
  });
});
