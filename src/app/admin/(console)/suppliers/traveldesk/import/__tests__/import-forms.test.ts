import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The review queue's forms (doc 30 §3.9): the "Replaces old page" picker selects nothing by default (review
 * INT-08), and the retire and address forms of a published listing render labelled controls with nothing
 * pre-selected. The server actions stay authoritative and are not called here.
 */

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

const { CleanAddressForm, RetireOldPageForm, ReviewForm } = await import("../import-forms");

const LINK = "00000000-0000-7000-8000-000000000001";
const suggestions = [
  { productId: "00000000-0000-7000-8000-0000000000a1", slug: "old-desert-safari", title: "Old desert safari", score: 92 },
  { productId: "00000000-0000-7000-8000-0000000000a2", slug: "older-desert-safari", title: "Older desert safari", score: 70 },
];

/** The `<option>` elements carrying `selected` in the server-rendered markup. */
const selectedOptions = (html: string) => [...html.matchAll(/<option[^>]*selected[^>]*>([^<]*)/g)].map((m) => m[1]);

describe("ReviewForm (INT-08)", () => {
  it("defaults the old page to none and still lists every suggestion", () => {
    const html = renderToStaticMarkup(createElement(ReviewForm, { linkId: LINK, title: "Desert safari", suggestions, needsConfirm: false }));
    expect(selectedOptions(html)).toEqual(["None (a new page)"]);
    expect(html).toContain('value=""');
    for (const s of suggestions) expect(html).toContain(`value="${s.productId}"`);
    expect(html).toContain("Old desert safari (old-desert-safari, match 92)");
    expect(html).toMatch(/<label[^>]*for="replaces-[^"]+"[^>]*>Replaces old page<\/label>/);
  });

  it("defaults to none with no suggestions too", () => {
    const html = renderToStaticMarkup(createElement(ReviewForm, { linkId: LINK, title: "Desert safari", suggestions: [], needsConfirm: true }));
    expect(selectedOptions(html)).toEqual(["None (a new page)"]);
  });
});

describe("RetireOldPageForm", () => {
  it("labels the picker, pre-selects nothing, requires a choice and a reason, and marks an archived page as redirect only", () => {
    const html = renderToStaticMarkup(
      createElement(RetireOldPageForm, {
        linkId: LINK,
        title: "Global Village",
        options: [
          { productId: suggestions[0].productId, slug: "dubai-frame", title: "Dubai Frame", archived: false },
          { productId: suggestions[1].productId, slug: "global-village", title: "Global Village", archived: true },
        ],
      }),
    );
    expect(html).toMatch(/<label[^>]*for="([^"]+)-old"[^>]*>Retire old page<\/label>/);
    expect(selectedOptions(html)).toEqual(["Choose the page this one replaces"]);
    expect(html).toMatch(/<select[^>]*name="oldProductId"[^>]*required/);
    expect(html).toContain("Global Village (global-village, already archived: redirect only)");
    expect(html).toMatch(/<input[^>]*-reason"[^>]*required[^>]*minLength="8"[^>]*name="reason"/);
    expect(html).toContain("Reason to retire the old page</label>");
    expect(html).toContain('aria-label="Retire the old page of Global Village"');
  });
});

describe("CleanAddressForm", () => {
  it("names the target address on the button and labels the reason, for the move and the undo", () => {
    const move = renderToStaticMarkup(createElement(CleanAddressForm, { linkId: LINK, mode: "move", from: "dubai-frame-2", to: "dubai-frame" }));
    expect(move).toContain(">Move to dubai-frame</span></button>");
    expect(move).toContain("Reason to move to the clean address</label>");
    expect(move).toContain('aria-label="Move to dubai-frame (now dubai-frame-2)"');
    const undo = renderToStaticMarkup(createElement(CleanAddressForm, { linkId: LINK, mode: "undo", from: "dubai-frame", to: "dubai-frame-2" }));
    expect(undo).toContain(">Move back to dubai-frame-2</span></button>");
    expect(undo).toContain("Reason to undo the address move</label>");
  });
});
