import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Combobox } from "../combobox";
import { filterOptions, focusLeaves, isListKey, moveActive, normaliseForSearch, pinSelected, resultAnnouncement, type ComboboxOption } from "../combobox-logic";

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

  it("with no query the chosen row is rendered even past the display cap, first, so opening starts on it", () => {
    const many: ComboboxOption[] = Array.from({ length: 150 }, (_, i) => ({ value: String(i + 1), label: `zz Hotel ${String(i + 1).padStart(3, "0")}` }));
    const capped = filterOptions(many, "", 100);
    const pinned = pinSelected(capped, many, "140");
    expect(pinned.shown).toHaveLength(100);
    expect(pinned.shown[0].value).toBe("140");
    expect(pinned.total).toBe(150);
    // Already shown, nothing chosen, or an unknown value: unchanged.
    expect(pinSelected(capped, many, "5")).toBe(capped);
    expect(pinSelected(capped, many, null)).toBe(capped);
    expect(pinSelected(capped, many, "999")).toBe(capped);
  });

  it("the panel closes only when focus leaves the whole field, so Tab can reach the empty state's action", () => {
    const inside = { id: "inside" } as unknown as Node;
    const root = { contains: (n: Node | null) => n === inside };
    expect(focusLeaves(root, inside)).toBe(false);
    expect(focusLeaves(root, { id: "elsewhere" } as unknown as EventTarget)).toBe(true);
    expect(focusLeaves(root, null)).toBe(true);
    expect(focusLeaves(null, inside)).toBe(true);
    // And the field no longer closes on Tab itself.
    const src = readFileSync(join(process.cwd(), "src/components/ui/combobox.tsx"), "utf8");
    expect(src).not.toMatch(/key === "Tab"/);
  });

  it("the live region says how many match, in words", () => {
    expect(resultAnnouncement(0, 0, { one: "hotel", many: "hotels" })).toBe("No hotels match");
    expect(resultAnnouncement(1, 1, { one: "hotel", many: "hotels" })).toBe("1 hotel matches");
    expect(resultAnnouncement(5, 5, { one: "hotel", many: "hotels" })).toBe("5 hotels match");
    expect(resultAnnouncement(300, 100, { one: "hotel", many: "hotels" })).toMatch(/300 hotels match, first 100 shown/);
  });
});

/** The outer HTML of the `<div>` starting at `start`, by counting nested divs (static markup, no DOM in the unit project). */
function elementAt(html: string, start: number): string {
  let depth = 0;
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = start;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return html.slice(start);
}

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
    // The trigger opens a panel; the combobox role belongs to the filter field inside it (ARIA 1.2).
    expect(html).toMatch(/<button id="hotel" type="button"[^>]*aria-haspopup="dialog"/);
    expect(html).not.toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-labelledby="hotel-label hotel-value"');
    expect(html).toContain('aria-describedby="hotel-hint hotel-error"');
    // A button may not carry aria-invalid or aria-required: the error is read through the description.
    expect(/<button[^>]*>/.exec(html)![0]).not.toMatch(/aria-invalid|aria-required/);
    expect(html).toContain("Example Marina Hotel");
    expect(html).toContain('id="hotel-error"');
    expect(html).not.toContain('role="listbox"');
  });

  it("open: the focused filter field is the combobox, expanded and controlling a listbox of options only, with a polite count", () => {
    const html = render({ value: "42", defaultOpen: true });
    const input = /<input[^>]*>/.exec(html)![0];
    expect(input).toContain('role="combobox"');
    expect(input).toContain('aria-expanded="true"');
    expect(input).toContain('aria-autocomplete="list"');
    expect(input).toContain('aria-label="Search hotels"');
    expect(input).toContain('aria-required="true"');
    expect(input).toContain('aria-describedby="hotel-hint"');
    expect(input).toMatch(/aria-activedescendant="[^"]+-opt-\d+"/);
    const list = /role="listbox"[^>]*id="([^"]+)"|id="([^"]+)" role="listbox"/.exec(html);
    expect(list).not.toBeNull();
    const listId = list![1] ?? list![2];
    expect(input).toContain(`aria-controls="${listId}"`);
    // The trigger controls the panel, a dialog named by the field's label.
    const panel = /<div id="([^"]+)" role="dialog" aria-labelledby="hotel-label"/.exec(html);
    expect(panel).not.toBeNull();
    expect(/<button[^>]*>/.exec(html)![0]).toContain(`aria-controls="${panel![1]}"`);
    expect(html.match(/role="option"/g)).toHaveLength(4);
    expect(html).toMatch(/role="option" aria-selected="true"/);
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("4 hotels match");
    // Options are not in the tab order: no buttons inside the list.
    expect(html.slice(html.indexOf('role="listbox"'))).not.toContain("<button");
  });

  it("the listbox holds options only: the cap line and the empty state with its action sit beside it", () => {
    const many: ComboboxOption[] = Array.from({ length: 5 }, (_, i) => ({ value: String(i + 1), label: `zz Hotel ${i + 1}` }));
    const capped = render({ options: many, maxShown: 3, defaultOpen: true });
    const listHtml = elementAt(capped, capped.lastIndexOf("<div", capped.indexOf('role="listbox"')));
    expect(listHtml.match(/role="option"/g)).toHaveLength(3);
    // Nothing but options inside: no paragraph, no button, no cap line.
    expect(listHtml).not.toMatch(/<p|<button|Showing/);
    expect(capped).toContain("Showing 3 of 5");

    const empty = render({ options: [], defaultOpen: true, emptyAction: () => h("button", { type: "button" }, "Ask our team") });
    expect(empty).not.toContain('role="listbox"');
    expect(empty).toContain("No hotels match");
    expect(empty).toContain("Ask our team");
    // With nothing to show the filter is collapsed and controls nothing.
    const input = /<input[^>]*>/.exec(empty)![0];
    expect(input).toContain('aria-expanded="false"');
    expect(input).not.toContain("aria-controls");
  });

  it("while unavailable the trigger stays focusable (aria-disabled, not disabled), so an error link can land on it", () => {
    const html = render({ options: [], disabled: true, error: "We can't load the pickup hotels right now." });
    const trigger = /<button[^>]*>/.exec(html)![0];
    expect(trigger).toContain('aria-disabled="true"');
    expect(trigger).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it("keeps one polite live region mounted while closed, empty, so the first count is announced", () => {
    const html = render();
    expect(html).toMatch(/<p role="status" aria-live="polite" class="sr-only"><\/p>/);
  });

  it("uses the project's tokens only: no foreign palette, no purple accent, no glyph tick, no blur", () => {
    const src = readFileSync(join(process.cwd(), "src/components/ui/combobox.tsx"), "utf8");
    const code = src.replace(/^\/\/.*$/gm, "");
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    // No blur effect (the focus handler's onBlur is not one).
    expect(code.replace(/onBlur/g, "")).not.toMatch(/purple|violet|8b5cf6|backdrop|blur/i);
    expect(code).not.toContain("✓");
    expect(code).toContain("motion-reduce:");
    // The provenance header is kept.
    expect(src.startsWith('// Source: 21st.dev "Combobox" by halaska-studio (21st.dev demo id 34727')).toBe(true);
    expect(src).toContain("Licence: MIT");
  });
});
