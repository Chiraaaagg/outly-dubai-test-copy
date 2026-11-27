import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GuestSelector } from "../pickers";
import { PriceBlock } from "../price";
import { guestAgesNotice, guestRowAges, offerPaxAges, PAGE_PAX_AGES, unitAgesFor } from "@/lib/pax-ages";
import type { UnitDefinition } from "@/server/quotes/contracts";
import type { PaxCount, PriceBand } from "@/lib/types";

/**
 * The guest picker and the page's price lines with each option's own ages
 * (doc 30 N4, D22). Server-rendered markup: the visible hints, the words a
 * screen reader gets, the stepper descriptions and closed rows. Default
 * bands must render the page's wording exactly as before.
 */

const PAX: PaxCount = { adult: 2, child: 0, infant: 0, senior: 0 };
const noop = () => {};

const unit = (unitId: "adult" | "child" | "infant", ages: { ageMin: number | null; ageMax: number | null }): UnitDefinition => ({
  unitId,
  label: unitId,
  per: "person",
  ...ages,
  residency: "any",
  heightMinCm: null,
  heightMaxCm: null,
  seatConsuming: true,
  minQty: 0,
  maxQty: 10,
  price: { inr: 1000, aed: 40 },
  supplierUnit: unitId,
});

/** Visible text only: strips tags and the screen-reader copies. */
function visible(html: string): string {
  return html
    .replace(/<span class="sr-only">[^<]*<\/span>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function picker(props: Partial<Parameters<typeof GuestSelector>[0]> = {}): string {
  return renderToStaticMarkup(h(GuestSelector, { value: PAX, onChange: noop, ...props }));
}

describe("guest picker ages", () => {
  it("parity: without a variant's own ages the page's hints render as before", () => {
    const html = picker();
    const text = visible(html);
    for (const hint of ["Age 12+", "Age 3–11", "Under 3 · usually free", "Age 60+ · reduced rate on many activities"]) expect(text).toContain(hint);
    // Passing the default variant's ages renders the same markup.
    expect(picker({ ages: guestRowAges({ units: [unit("adult", { ageMin: null, ageMax: null }), unit("child", { ageMin: null, ageMax: null })] }) })).toBe(html);
    expect(picker({ ages: guestRowAges(undefined) })).toBe(html);
  });

  it("screen readers get the ranges in words, and each stepper is described by its row's ages", () => {
    const html = picker();
    expect(html).toContain('<span aria-hidden="true">Age 3–11</span><span class="sr-only">Ages 3 to 11</span>');
    expect(html).toContain('<span class="sr-only">Age 12 and over</span>');
    expect(html).toContain('<span class="sr-only">Under 3, usually free</span>');
    const ids = [...html.matchAll(/<p id="([^"]+)" class="text-xs text-ink-500">/g)].map((m) => m[1]);
    expect(ids).toHaveLength(4);
    for (const id of ids) expect(html.split(`aria-describedby="${id}"`).length - 1).toBe(2);
    // Steppers keep their names and stay native buttons (keyboard, focus).
    expect(html).toContain('aria-label="Increase Children"');
    expect(html).toContain('type="button"');
  });

  it("an option with a child band under 8 and no infants shows its own ages and closes the infant row", () => {
    const bands = offerPaxAges({ childrenAllowed: true, childAge: 8, infantsAllowed: false, infantAge: 3 })!;
    const ages = guestRowAges({ units: [unit("adult", unitAgesFor(bands, "adult")), unit("child", unitAgesFor(bands, "child"))] });
    const html = picker({ ages });
    const text = visible(html);
    expect(text).toContain("Age 8+");
    expect(text).toContain("Age 3–7");
    expect(text).toContain("Under 3 · not available on this option");
    expect(html).toContain('<span class="sr-only">Ages 3 to 7</span>');
    // The infant row's increase is disabled; the others are not.
    const infantIncrease = html.match(/<button[^>]*aria-label="Increase Infants"[^>]*>/)![0];
    expect(infantIncrease).toContain(' disabled=""');
    expect(html.match(/<button[^>]*aria-label="Increase Children"[^>]*>/)![0]).not.toContain(' disabled=""');
  });

  it("an option with an infant band under 2 shows children from 2", () => {
    const bands = offerPaxAges({ childrenAllowed: true, childAge: 12, infantsAllowed: true, infantAge: 2 })!;
    const ages = guestRowAges({ units: (["adult", "child", "infant"] as const).map((id) => unit(id, unitAgesFor(bands, id))) });
    const text = visible(picker({ ages }));
    expect(text).toContain("Age 2–11");
    expect(text).toContain("Under 2 · usually free");
    expect(text).toContain("Age 12+");
  });
});

describe("option switch notice and closed rows (review 102 N4-02, N4-06)", () => {
  const bands = offerPaxAges({ childrenAllowed: true, childAge: 8, infantsAllowed: false, infantAge: 3 })!;
  const noInfants = { units: [unit("adult", unitAgesFor(bands, "adult")), unit("child", unitAgesFor(bands, "child"))] };
  const page = { units: [unit("adult", { ageMin: null, ageMax: null }), unit("child", { ageMin: null, ageMax: null }), unit("infant", { ageMin: null, ageMax: null })] };

  it("a caller that shows notices gets one polite live region, mounted while empty", () => {
    const empty = picker({ notice: null });
    expect(empty).toContain('<div role="status" aria-live="polite"></div>');
    // Callers that never pass a notice (combo, design system) render no region: their markup is unchanged.
    expect(picker()).not.toContain('role="status"');
  });

  it("the notice for an option switch is shown inline, inside the live region, above the rows", () => {
    const notice = guestAgesNotice(page, noInfants, { adult: 2, child: 1, infant: 1, senior: 0 })!;
    expect(notice).toBe("This option doesn't take infants, so 1 infant was removed from your guests. This option counts children as ages 3 to 7. Check your guest numbers.");
    const html = picker({ notice, ages: guestRowAges(noInfants) });
    const region = html.match(/<div role="status" aria-live="polite">(.*?)<\/div>/)![1];
    expect(region).toContain(notice.replace(/'/g, "&#x27;"));
    expect(html.indexOf('role="status"')).toBeLessThan(html.indexOf("Adults"));
  });

  it("the guests are one named group; a closed row's reason is its description, with no fake control", () => {
    const html = picker({ ages: guestRowAges(noInfants) });
    const group = html.match(/<div role="group" aria-label="Guests" aria-describedby="([^"]+)"/)!;
    expect(html).toContain(`<p id="${group[1]}" class="sr-only">Infants: Under 3, not available on this option.</p>`);
    // Every stepper is still a native button; the closed row adds no focusable element.
    expect(html.match(/<button/g)).toHaveLength(8);
    // Without closed rows the group has no description.
    expect(picker()).toContain('<div role="group" aria-label="Guests" class="space-y-1">');
  });
});

describe("page price lines", () => {
  const band: PriceBand = { adult: { inr: 5000, aed: 200 }, child: { inr: 4000, aed: 160 }, infant: { inr: 0, aed: 0 } } as PriceBand;
  const block = (ages?: Parameters<typeof PriceBlock>[0]["ages"]) => visible(renderToStaticMarkup(h(PriceBlock, { band, ...(ages !== undefined ? { ages } : {}) })));

  it("parity: the page's own ages by default", () => {
    expect(block()).toContain("Child (3–11):");
    expect(block()).toContain("Infant (under 3): Free");
    expect(block(PAGE_PAX_AGES)).toBe(block());
  });

  it("a listing's shared own ages, or none when its options differ", () => {
    const bands = offerPaxAges({ childrenAllowed: true, childAge: 10, infantsAllowed: true, infantAge: 2 })!;
    expect(block(bands)).toContain("Child (2–9):");
    expect(block(bands)).toContain("Infant (under 2): Free");
    expect(block(null)).toContain("Child (age by option):");
  });

  it("no infant line when no option books infants (review 102 N4-05)", () => {
    const html = visible(renderToStaticMarkup(h(PriceBlock, { band, infantsSold: false })));
    expect(html).not.toContain("Infant");
    expect(html).toContain("Child (3–11):");
    // Only an infant line to show: no empty list.
    const onlyInfant = renderToStaticMarkup(h(PriceBlock, { band: { adult: band.adult, infant: band.infant } as PriceBand, infantsSold: false }));
    expect(onlyInfant).not.toContain("<ul");
  });
});
