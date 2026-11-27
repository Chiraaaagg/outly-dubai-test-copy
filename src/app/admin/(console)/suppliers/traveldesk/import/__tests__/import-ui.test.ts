import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { addWithinCap, filterPublishRows, pageOf, PUBLISH_MAX, publishResultRows, type PublishRow } from "../import-ui";

/**
 * Doc 30 N1 publish selection with the owner's decision 23 components: the
 * pure helpers (search, pages, the 50 cap, the dialog's result list) and the
 * table's server-rendered markup (labels, the always-present announced count,
 * the bar). The server action stays authoritative and is not called here.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/admin/_actions/traveldesk-import", () => ({ publishListingsAction: async () => null }));

const row = (n: number, over: Partial<PublishRow> = {}): PublishRow => ({
  linkId: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`,
  title: `Synthetic listing ${n}`,
  slug: `zz-listing-${n}`,
  replaces: null,
  ...over,
});

describe("publish table helpers", () => {
  it("searches title, slug and the page it replaces", () => {
    const rows = [row(1), row(2, { replaces: "old-desert-page" }), row(3, { title: "Evening Dhow" })];
    expect(filterPublishRows(rows, "dhow").map((r) => r.slug)).toEqual(["zz-listing-3"]);
    expect(filterPublishRows(rows, "OLD-DESERT").map((r) => r.slug)).toEqual(["zz-listing-2"]);
    expect(filterPublishRows(rows, "  ")).toHaveLength(3);
  });

  it("pages rows and clamps an out-of-range page", () => {
    const rows = Array.from({ length: 23 }, (_, i) => row(i + 1));
    expect(pageOf(rows, 1)).toMatchObject({ page: 1, pages: 3 });
    expect(pageOf(rows, 3).rows).toHaveLength(3);
    expect(pageOf(rows, 9).page).toBe(3);
    expect(pageOf([], 1)).toMatchObject({ rows: [], page: 1, pages: 1 });
  });

  it("never selects more than the service takes in one run", () => {
    const ids = Array.from({ length: 60 }, (_, i) => row(i + 1).linkId);
    const { next, dropped } = addWithinCap(new Set(), ids);
    expect(next.size).toBe(PUBLISH_MAX);
    expect(dropped).toBe(10);
    expect(addWithinCap(next, [ids[0]]).dropped).toBe(0);
  });

  it("the result list says applied or failed, with the reason", () => {
    const titles = new Map([
      [row(1).linkId, "Synthetic listing 1"],
      [row(2).linkId, "Synthetic listing 2"],
    ]);
    const out = publishResultRows(
      [
        { linkId: row(1).linkId, outcome: "published", slug: "zz-listing-1", retired: "old-page", notRetired: undefined },
        { linkId: row(2).linkId, outcome: "stopped", reason: "the old page is still named elsewhere", references: ["src/lib/data/x.ts"] },
      ],
      titles,
    );
    expect(out).toEqual([
      { state: "applied", linkId: row(1).linkId, title: "Synthetic listing 1", detail: "published as zz-listing-1; retired old-page with a permanent redirect" },
      { state: "failed", linkId: row(2).linkId, title: "Synthetic listing 2", detail: "the old page is still named elsewhere (src/lib/data/x.ts)" },
    ]);
  });
});

describe("publish table markup", () => {
  it("names every checkbox, shows the bar with its announced count, and badges the page each draft replaces", async () => {
    const { PublishTable } = await import("../publish-table");
    const html = renderToStaticMarkup(createElement(PublishTable, { rows: [row(1, { replaces: "old-page" }), row(2)] }));
    expect(html).toContain('aria-label="Select every reviewed draft on this page"');
    expect(html).toContain('aria-label="Select Synthetic listing 1"');
    expect(html).toMatch(/aria-live="polite"[^>]*>Select reviewed drafts to publish</);
    expect(html).toContain('aria-label="Search reviewed drafts"');
    expect(html).toContain("retires old-page");
    expect(html).toContain("new page");
    expect(html).toContain("View<span class=\"sr-only\"> visible columns</span>");
  });

  it("says so when nothing is waiting", async () => {
    const { PublishTable } = await import("../publish-table");
    expect(renderToStaticMarkup(createElement(PublishTable, { rows: [] }))).toContain("No reviewed draft is waiting.");
  });
});
