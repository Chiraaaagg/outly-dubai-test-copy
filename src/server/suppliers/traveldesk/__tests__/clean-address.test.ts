import { describe, expect, it } from "vitest";
import { slugSchema } from "../../../schemas/activity.schema";
import { cleanSlugOf, isTombstoneOf, REDIRECT_ONLY_REASON_PREFIX, RETIRE_REASON_PREFIX, retireDecision, retireMarkerOf, retireSummary, tombstoneSlug, TOMBSTONE_MARK, withSlug } from "../clean-address";

/**
 * Address clean-up of published TravelDesk listings (doc 30 §3.9 follow-up): the "<base>-<n>" parse, the
 * retired page's non-public tombstone, and the publish path's retire rules in their order.
 */

const ID = "0192f3a4-b5c6-7d8e-9f00-112233445566";

describe("cleanSlugOf", () => {
  it("strips a -<n> suffix from the slugs published next to a retired page", () => {
    for (const [slug, base] of [
      ["dubai-dolphinarium-2", "dubai-dolphinarium"],
      ["dubai-frame-2", "dubai-frame"],
      ["global-village-2", "global-village"],
      ["the-palm-monorail-2", "the-palm-monorail"],
      ["ocean-empress-dinner-cruise-12", "ocean-empress-dinner-cruise"],
    ]) {
      expect(cleanSlugOf(slug)).toBe(base);
    }
  });

  it("refuses slugs without a numeric suffix, a zero or leading zero, a 4-digit suffix and a too-short base", () => {
    for (const slug of ["dubai-frame", "dubai-frame-0", "dubai-frame-02", "dubai-frame-1000", "ab-2", "2", "-2", "dubai-frame-2x", "Dubai-Frame-2", "dubai--frame-2"]) {
      expect(cleanSlugOf(slug)).toBeNull();
    }
  });
});

describe("tombstoneSlug", () => {
  it("is base, the marker and the first 8 hex of the id", () => {
    expect(tombstoneSlug("dubai-frame", ID)).toBe("dubai-frame--retired-0192f3a4");
    expect(isTombstoneOf("dubai-frame--retired-0192f3a4", "dubai-frame", ID)).toBe(true);
    expect(isTombstoneOf("dubai-frame--retired-0192f3a4", "dubai-frame-2", ID)).toBe(false);
    expect(isTombstoneOf("dubai-frame", "dubai-frame", ID)).toBe(false);
  });

  it("can never be a public address: no editor, import or URL slug has a double hyphen", () => {
    const t = tombstoneSlug("global-village", ID);
    expect(t).toContain(TOMBSTONE_MARK);
    expect(slugSchema.safeParse(t).success).toBe(false);
    expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t)).toBe(false);
    expect(cleanSlugOf(t)).toBeNull();
  });
});

describe("retireDecision (the publish path's rules, in order)", () => {
  const live = { fulfilmentMode: "inquiry", effectiveMode: "inquiry", status: "published", openOrders: 0, openInquiries: 0 };

  it("retires a published inquiry page with no open work", () => {
    expect(retireDecision(live)).toBeNull();
    expect(retireDecision({ ...live, effectiveMode: null })).toBeNull();
  });

  it("keeps an instant page, then open orders, then open inquiries, then an unpublished page", () => {
    expect(retireDecision({ ...live, fulfilmentMode: "instant", openOrders: 1 })).toBe("old listing is instant");
    expect(retireDecision({ ...live, effectiveMode: "instant" })).toBe("old listing is instant");
    expect(retireDecision({ ...live, openOrders: 2, openInquiries: 1 })).toBe("old listing has an open order");
    expect(retireDecision({ ...live, openInquiries: 1, status: "draft" })).toBe("old listing has an open inquiry");
    expect(retireDecision({ ...live, status: "draft" })).toBe("old listing is not published");
  });
});

describe("retireMarkerOf (review P2-2, P2-3)", () => {
  it("tells a soft-delete retire from a redirect-only one, and anything else from both", () => {
    expect(retireMarkerOf("Replaced by dubai-frame-2: cleanup")).toBe(RETIRE_REASON_PREFIX);
    expect(retireMarkerOf("Redirected to global-village-2: cleanup")).toBe(REDIRECT_ONLY_REASON_PREFIX);
    expect(retireMarkerOf("Retired for catalogue re-import (2026-11-20)")).toBeNull();
    expect(retireMarkerOf("Address change: address freed")).toBeNull();
    expect(retireMarkerOf(null)).toBeNull();
    expect(RETIRE_REASON_PREFIX.startsWith(REDIRECT_ONLY_REASON_PREFIX) || REDIRECT_ONLY_REASON_PREFIX.startsWith(RETIRE_REASON_PREFIX)).toBe(false);
  });
});

describe("withSlug (review P3: own placeholder images follow the slug)", () => {
  it("moves the slug and the listing's own img:activity refs both ways, and leaves other images alone", () => {
    const doc = { slug: "dubai-frame-2", title: "Frame", images: ["img:activity:dubai-frame-2:0", "img:activity:dubai-frame-2:3", "img:activity:dubai-frame-2-night:0", "https://cdn.example.test/a.webp", "img:activity:other:1"] };
    const moved = withSlug(doc, "dubai-frame-2", "dubai-frame");
    expect(moved).toEqual({ slug: "dubai-frame", title: "Frame", images: ["img:activity:dubai-frame:0", "img:activity:dubai-frame:3", "img:activity:dubai-frame-2-night:0", "https://cdn.example.test/a.webp", "img:activity:other:1"] });
    expect(withSlug(moved, "dubai-frame", "dubai-frame-2")).toEqual(doc);
    expect(withSlug({ slug: "abc-2" }, "abc-2", "abc")).toEqual({ slug: "abc" });
  });
});

describe("retireSummary", () => {
  const base = { oldSlug: "dubai-frame", slug: "dubai-frame-2", references: [] as string[], releasedFrom: null as string | null };
  it("names the listing that no longer replaces the page after a takeover (review final 3)", () => {
    expect(retireSummary({ ...base, mode: "retired" })).toBe("dubai-frame retired; it redirects to dubai-frame-2");
    expect(retireSummary({ ...base, mode: "retired", releasedFrom: "Dubai Frame tickets" })).toBe("dubai-frame retired; it redirects to dubai-frame-2; Dubai Frame tickets no longer replaces it");
    expect(retireSummary({ ...base, mode: "redirected", references: ["collection:budget-dubai"] })).toBe(
      "dubai-frame (already archived) now redirects to dubai-frame-2; still named by collection:budget-dubai (moving to the clean address makes those name this listing)",
    );
  });
});
