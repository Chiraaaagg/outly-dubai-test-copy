import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CollapsiblePromo } from "../collapsible-promo";

/**
 * Imported Collapsible Form Fields (cnippet-dev, 21st.dev) as the review
 * step's promo field (checkout redesign batch 2, CO-25, checklist 9): collapsed
 * behind "Have a promo code?" until opened (approved structural edit), with
 * the code field, Apply and one error line inside.
 */

describe("CollapsiblePromo", () => {
  it("starts collapsed: only the trigger is shown, not announced as open", () => {
    const html = renderToStaticMarkup(h(CollapsiblePromo, {}));
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Have a promo code\?/);
    expect(html).not.toContain('id="promo-code"');
  });

  it("open, it shows the labelled code field and Apply", () => {
    const html = renderToStaticMarkup(h(CollapsiblePromo, { open: true, value: "FIRSTTRIP" }));
    expect(html).toMatch(/<button[^>]*aria-expanded="true"/);
    expect(html).toMatch(/<label[^>]*for="promo-code"[^>]*>Promo code<\/label>/);
    expect(html).toMatch(/<input[^>]*id="promo-code"[^>]*value="FIRSTTRIP"/);
    expect(html).toMatch(/>Apply<\/button>/);
  });

  it("an unknown code is one error line tied to the field", () => {
    const html = renderToStaticMarkup(h(CollapsiblePromo, { open: true, value: "NOPE", error: "That code isn't valid." }));
    expect(html).toMatch(/<input[^>]*aria-invalid="true"/);
    expect(html).toMatch(/<input[^>]*aria-describedby="promo-code-error"/);
    expect(html).toMatch(/<div role="alert"[^>]*id="promo-code-error"[^>]*>That code isn&#x27;t valid\.<\/div>/);
  });

  it("names an applied promo on the trigger", () => {
    expect(renderToStaticMarkup(h(CollapsiblePromo, { triggerLabel: "Promo FIRSTTRIP applied" }))).toContain("Promo FIRSTTRIP applied");
  });
});
