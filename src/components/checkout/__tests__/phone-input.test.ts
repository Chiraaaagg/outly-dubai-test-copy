import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COUNTRIES, PhoneInput } from "../phone-input";

/**
 * Imported Phone Input (mohitsapat, 21st.dev) on the checkout details step
 * (checkout redesign batch 2, CO-24, CO-29). Pins the approved label fix (the
 * country button's name contains its visible dial code, WCAG 2.5.3), the
 * country it starts on, and the field semantics the checkout passes through.
 */

const UAE_FIRST = [
  ...COUNTRIES.filter((c) => c.code === "AE" || c.code === "IN").sort((a) => (a.code === "AE" ? -1 : 1)),
  ...COUNTRIES.filter((c) => c.code !== "AE" && c.code !== "IN"),
];

function render(over: Partial<Parameters<typeof PhoneInput>[0]> = {}): string {
  return renderToStaticMarkup(
    h(PhoneInput, {
      id: "phone",
      name: "tel-national",
      defaultCountry: "AE",
      countries: UAE_FIRST,
      label: "Mobile number",
      value: "",
      ...over,
    }),
  );
}

describe("PhoneInput", () => {
  it("starts on the given country, and its button names the visible dial code", () => {
    const html = render();
    expect(html).toContain('aria-label="Country code: United Arab Emirates +971"');
    expect(html).toContain(">+971<");
    expect(render({ defaultCountry: "IN" })).toContain('aria-label="Country code: India +91"');
  });

  it("is a tel input with the checkout's id, name and autocomplete", () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*type="tel"/);
    expect(html).toMatch(/<input[^>]*inputMode="tel"/i);
    expect(html).toMatch(/<input[^>]*autoComplete="tel-national"/i);
    expect(html).toMatch(/<input[^>]*id="phone"/);
    expect(html).toMatch(/<input[^>]*aria-label="Mobile number"/);
  });

  it("passes the invalid state and its description to the input, and marks the field", () => {
    const html = render({ "aria-invalid": true, "aria-describedby": "phone-hint phone-error" });
    expect(html).toMatch(/<input[^>]*aria-invalid="true"/);
    expect(html).toMatch(/<input[^>]*aria-describedby="phone-hint phone-error"/);
    expect(html).toContain("has-[input[aria-invalid=true]]:border-danger");
  });

  it("offers UAE first, then India", () => {
    expect(UAE_FIRST.slice(0, 2).map((c) => c.code)).toEqual(["AE", "IN"]);
  });
});
