/**
 * Address clean-up of published TravelDesk listings (doc 30 §3.9 follow-up).
 * Pure helpers shared by the listing service and the import page:
 *
 *  - `cleanSlugOf`: a listing published as "<base>-<n>" because a retired
 *    page still held "<base>" can move to "<base>".
 *  - `tombstoneSlug`: the non-public address the retired page takes so the
 *    unique slug is free. It contains "--", which no editor, import or URL
 *    can produce (single hyphens only: `slugSchema`, `pr_old_slug_check`
 *    and the storefront's redirect lookup all refuse it), so it can never be
 *    requested, redirected from or reused by a new listing.
 *  - `retireDecision`: the retire rules of the publish path (instant, open
 *    order, open inquiry, not published), in that order.
 */

const SUFFIXED = /^([a-z0-9]+(?:-[a-z0-9]+)*)-([1-9][0-9]{0,2})$/;
export const TOMBSTONE_MARK = "--retired-";

/** "<base>-<n>" (n = 1..999) to "<base>"; null for any other slug or a base shorter than a slug may be. */
export function cleanSlugOf(slug: string): string | null {
  const m = SUFFIXED.exec(slug);
  if (!m || m[1].length < 3) return null;
  return m[1];
}

/** The retired page's freed-up address: "<base>--retired-<first 8 of its id>". */
export function tombstoneSlug(base: string, productId: string): string {
  return `${base}${TOMBSTONE_MARK}${productId.replace(/-/g, "").slice(0, 8).toLowerCase()}`;
}

/** Whether `slug` is the tombstone a move to `base` gave the product `productId`. */
export function isTombstoneOf(slug: string, base: string, productId: string): boolean {
  return slug === tombstoneSlug(base, productId);
}

export type RetireFacts = {
  fulfilmentMode: string;
  effectiveMode: string | null;
  status: string;
  openOrders: number;
  openInquiries: number;
};

/** Null when the old page may be retired; otherwise why it is kept (the publish path's wording). */
export function retireDecision(f: RetireFacts): string | null {
  if (f.fulfilmentMode === "instant" || f.effectiveMode === "instant") return "old listing is instant";
  if (f.openOrders > 0) return "old listing has an open order";
  if (f.openInquiries > 0) return "old listing has an open inquiry";
  if (f.status !== "published") return "old listing is not published";
  return null;
}

/** The version reason of a retire written by the publish service; restore checks it (N1-11). */
export const RETIRE_REASON_PREFIX = "Replaced by ";
/** The version reason of a redirect-only retire (the old page was already archived); restore drops the redirect only. */
export const REDIRECT_ONLY_REASON_PREFIX = "Redirected to ";

/** The retire marker a version reason starts with, or null. */
export function retireMarkerOf(reason: string | null | undefined): typeof RETIRE_REASON_PREFIX | typeof REDIRECT_ONLY_REASON_PREFIX | null {
  if (reason?.startsWith(RETIRE_REASON_PREFIX)) return RETIRE_REASON_PREFIX;
  if (reason?.startsWith(REDIRECT_ONLY_REASON_PREFIX)) return REDIRECT_ONLY_REASON_PREFIX;
  return null;
}

/** The document with its slug, and its own-slug placeholder image refs (`img:activity:<slug>:<n>`), moved to `to`. */
export function withSlug(content: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  const own = `img:activity:${from}:`;
  const images = Array.isArray(content.images) ? content.images.map((i) => (typeof i === "string" && i.startsWith(own) ? `img:activity:${to}:${i.slice(own.length)}` : i)) : content.images;
  return { ...content, slug: to, ...(images === undefined ? {} : { images }) };
}

/** The "Retire old page" result line (the admin action's summary). */
export function retireSummary(r: { mode: "retired" | "redirected"; oldSlug: string; slug: string; references: string[]; releasedFrom: string | null }): string {
  const named = r.mode === "redirected" && r.references.length ? `; still named by ${r.references.join(", ")} (moving to the clean address makes those name this listing)` : "";
  // A dormant redirect taken over from another imported listing (review P3-1): say which one let go of the page.
  const released = r.releasedFrom ? `; ${r.releasedFrom} no longer replaces it` : "";
  return r.mode === "retired" ? `${r.oldSlug} retired; it redirects to ${r.slug}${released}` : `${r.oldSlug} (already archived) now redirects to ${r.slug}${named}${released}`;
}
