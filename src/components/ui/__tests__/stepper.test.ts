import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Stepper, StepperIndicator, StepperItem, StepperSeparator, StepperTitle, StepperTrigger } from "../stepper";

/**
 * Imported Stepper (kevingirelli, 21st.dev), ported with OUTLYY colour tokens
 * (checkout redesign batch 2). Structure and behaviour are the author's; these
 * checks pin what the checkout relies on: the landmark, aria-current, linear
 * locking, the screen-reader state text and the brand colour mapping.
 */

const TITLES = ["Activity", "Your details", "Review & pay", "Booked"];

function render(value: number, withTriggers = true): string {
  return renderToStaticMarkup(
    h(
      Stepper,
      {
        value,
        label: "Booking progress",
        labels: { complete: "done", current: "current step", upcoming: "" },
      },
      TITLES.map((title, index) =>
        h(
          StepperItem,
          { key: title, step: index },
          withTriggers
            ? h(StepperTrigger, null, h(StepperIndicator), h(StepperTitle, null, title))
            : [h(StepperIndicator, { key: "i" }), h(StepperTitle, { key: "t" }, title)],
          h(StepperSeparator),
        ),
      ),
    ),
  );
}

describe("Stepper", () => {
  it("is a named nav landmark around an ordered list of every step", () => {
    const html = render(2);
    expect(html).toMatch(/^<nav[^>]*aria-label="Booking progress"/);
    expect(html).toContain("<ol");
    expect(html.match(/<li /g)).toHaveLength(4);
    for (const title of TITLES) expect(html).toContain(title.replace("&", "&amp;"));
  });

  it("marks the current step with aria-current on its trigger and locks steps not reached yet", () => {
    const html = render(1);
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(4);
    expect(buttons[0]).not.toMatch(/ disabled=""/);
    expect(buttons[1]).toContain('aria-current="step"');
    expect(buttons[2]).toMatch(/ disabled=""/);
    expect(buttons[3]).toMatch(/ disabled=""/);
  });

  it("puts aria-current on the indicator when there is no trigger", () => {
    const html = render(1, false);
    expect(html).not.toContain("<button");
    expect(html).toMatch(/data-slot="stepper-indicator" data-state="current" aria-current="step"/);
  });

  it("reads each step's state after its number, since the check mark is not read", () => {
    const html = render(2);
    expect(html).toContain('<span class="sr-only">1</span><span class="sr-only">, done</span>');
    expect(html).toContain('3<span class="sr-only">, current step</span>');
    // An empty upcoming label reads nothing.
    expect(html).not.toContain(", ,");
  });

  it("uses OUTLYY tokens: marigold fill with ink text once complete, sun-700 number when current", () => {
    const html = render(2);
    expect(html).toContain("data-[state=complete]:bg-sun-500 data-[state=complete]:text-ink-900");
    expect(html).toContain("data-[state=current]:text-sun-700");
    expect(html).not.toMatch(/\b(?:bg|text|border)-(?:primary|muted|background)\b/);
  });
});
