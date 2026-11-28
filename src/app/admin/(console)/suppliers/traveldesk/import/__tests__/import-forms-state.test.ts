import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The retire and address forms after the action answered (review P3): an error marks the reason input invalid and
 * points it at the message; a success renders a focusable status line; in production the submit is a confirm
 * step (the Alert Dialog trigger), elsewhere a plain submit. `useActionState` is replaced to set the answer.
 */

const answer = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useActionState: () => [answer.current, () => {}, false] };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/admin/_actions/traveldesk-import", () => ({
  applyTravelDeskImportAction: async () => null,
  copyTravelDeskPhotosAction: async () => null,
  markListingReviewedAction: async () => null,
  moveToCleanAddressAction: async () => null,
  previewTravelDeskImportAction: async () => null,
  publishListingsAction: async () => null,
  restoreReplacedAction: async () => null,
  retireOldPageAction: async () => null,
  rollbackTravelDeskImportAction: async () => null,
  undoCleanAddressAction: async () => null,
}));

const { CleanAddressForm, RetireOldPageForm, ReviewActions } = await import("../import-forms");
const { openWhenValid, reportingAction } = await import("../import-ui");
const LINK = "00000000-0000-7000-8000-000000000001";
const options = [{ productId: "00000000-0000-7000-8000-0000000000a1", slug: "dubai-frame", title: "Dubai Frame", archived: false }];
const reasonInput = (html: string) => /<input[^>]*name="reason"[^>]*\/>/.exec(html)?.[0] ?? "";

describe("retire and address forms after an answer", () => {
  it("an error marks the reason invalid and describes it by the message", () => {
    answer.current = { ok: false, message: "Not retired: old listing is instant" };
    for (const html of [
      renderToStaticMarkup(createElement(RetireOldPageForm, { linkId: LINK, title: "Frame", options })),
      renderToStaticMarkup(createElement(CleanAddressForm, { linkId: LINK, mode: "move", from: "dubai-frame-2", to: "dubai-frame" })),
    ]) {
      const input = reasonInput(html);
      expect(input).toContain('aria-invalid="true"');
      const described = /aria-describedby="([^"]+)"/.exec(input)?.[1];
      expect(described).toBeTruthy();
      expect(html).toContain(`id="${described}"`);
      expect(html).toMatch(new RegExp(`id="${described}"[^>]*>\\s*<p role="alert"`));
    }
  });

  it("no error: the reason is not marked invalid", () => {
    answer.current = null;
    const input = reasonInput(renderToStaticMarkup(createElement(CleanAddressForm, { linkId: LINK, mode: "move", from: "dubai-frame-2", to: "dubai-frame" })));
    expect(input).not.toContain("aria-invalid");
    expect(input).not.toContain("aria-describedby");
  });

  it("a success is a focusable status line (focus moves there on mount)", () => {
    answer.current = { ok: true, data: { batchId: LINK, summary: "Moved to dubai-frame; dubai-frame-2 redirects to it" } };
    const html = renderToStaticMarkup(createElement(CleanAddressForm, { linkId: LINK, mode: "move", from: "dubai-frame-2", to: "dubai-frame" }));
    expect(html).toMatch(/<p tabindex="-1" role="status"[^>]*>Moved to dubai-frame; dubai-frame-2 redirects to it\.<\/p>/);
  });

  it("in production the submit is a confirm step; elsewhere it submits at once", () => {
    answer.current = null;
    const prod = renderToStaticMarkup(createElement(RetireOldPageForm, { linkId: LINK, title: "Frame", options, confirm: true }));
    expect(prod).not.toMatch(/<button type="submit"/);
    expect(prod).toMatch(/<button type="button"[^>]*>(<span[^>]*>)?Retire and redirect…/);
    const test = renderToStaticMarkup(createElement(RetireOldPageForm, { linkId: LINK, title: "Frame", options }));
    expect(test).toMatch(/<button type="submit"[^>]*>(<span[^>]*>)?Retire and redirect</);
  });

  it("a row's outcome region is mounted empty outside the forms; a form reporting to it shows no line of its own", () => {
    const props = { linkId: LINK, title: "Frame", slug: "dubai-frame-2", retireOptions: [], cleanAddress: "dubai-frame", movedFrom: null, canRestore: true, confirm: false };
    answer.current = null;
    const idle = renderToStaticMarkup(createElement(ReviewActions, props));
    expect(idle).toMatch(/^<div[^>]*><p tabindex="-1" role="status" aria-live="polite" aria-atomic="true"[^>]*><\/p><form/);
    expect(idle).toContain("Move to dubai-frame");
    expect(idle).toContain("Restore old page");
    answer.current = { ok: true, data: { batchId: LINK, summary: "Moved to dubai-frame; dubai-frame-2 redirects to it" } };
    const done = renderToStaticMarkup(createElement(ReviewActions, props));
    expect(done).not.toContain("Moved to dubai-frame;");
    expect(done).not.toContain("<form");
  });

  it("the confirmation opens only for a form the browser accepts", () => {
    let asked = 0;
    expect(openWhenValid({ reportValidity: () => (asked++, false) })).toBe(false);
    expect(openWhenValid({ reportValidity: () => (asked++, true) })).toBe(true);
    expect(openWhenValid(null)).toBe(false);
    expect(asked).toBe(2);
  });

  it("the action itself reports a success before it returns, and never an error (final review P3-4)", async () => {
    const seen: string[] = [];
    const ok = reportingAction(async () => ({ ok: true as const, data: { summary: "Moved to dubai-frame" } }), (t) => seen.push(t));
    const order: string[] = [];
    const r = await ok(null, new FormData()).then((x) => (order.push(`returned after ${seen.length}`), x));
    expect(r).toEqual({ ok: true, data: { summary: "Moved to dubai-frame" } });
    expect(seen).toEqual(["Moved to dubai-frame"]);
    expect(order).toEqual(["returned after 1"]);
    const failed = reportingAction(async () => ({ ok: false as const, message: "Not retired" }), (t) => seen.push(t));
    expect(await failed(null, new FormData())).toMatchObject({ ok: false });
    expect(await reportingAction(async () => ({ ok: true as const, data: { summary: "x" } }), undefined)(null, new FormData())).toMatchObject({ ok: true });
    expect(seen).toEqual(["Moved to dubai-frame"]);
  });
});
