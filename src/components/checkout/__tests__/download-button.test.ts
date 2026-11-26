import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DownloadButton } from "../download-button";

/**
 * Imported Download Button (bidyut10, 21st.dev), ported with OUTLYY colours
 * (checkout redesign batch 2). Initial render only: the phase timers are the
 * author's and run in the browser.
 */

describe("DownloadButton", () => {
  it("starts idle with its label visible and the other phases hidden from screen readers", () => {
    const html = renderToStaticMarkup(
      h(DownloadButton, {
        label: "Download voucher",
        downloadingLabel: "Downloading voucher",
        doneLabel: "Voucher downloaded",
      }),
    );
    expect(html).toContain('type="button"');
    expect(html).toContain('data-phase="idle"');
    expect(html).not.toContain("aria-busy");
    expect(html).toMatch(/<span aria-hidden="false"[^>]*>Download voucher<\/span>/);
    expect(html).toMatch(/<span aria-hidden="true"[^>]*>Downloading voucher<\/span>/);
    expect(html).toMatch(/<span aria-hidden="true"[^>]*>Voucher downloaded<\/span>/);
    // The live region is empty until something happens.
    expect(html).toContain('<span class="sr-only" aria-live="polite"></span>');
  });

  it("uses the marigold fill with ink text and a 48px target", () => {
    const html = renderToStaticMarkup(h(DownloadButton));
    expect(html).toContain("bg-sun-500");
    expect(html).toContain("text-ink-900");
    expect(html).toContain("h-12");
    expect(html).not.toMatch(/neutral-|emerald-/);
  });

  it("passes other button props through", () => {
    const html = renderToStaticMarkup(h(DownloadButton, { "aria-describedby": "voucher-file", className: "w-full" }));
    expect(html).toContain('aria-describedby="voucher-file"');
    expect(html).toContain("w-full");
  });
});
