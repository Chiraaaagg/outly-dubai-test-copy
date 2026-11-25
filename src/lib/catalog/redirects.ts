import "server-only";
import { unstable_cache } from "next/cache";
import { prisma } from "@/server/lib/db";
import { log } from "@/server/lib/logger";
import { CATALOG_TAG } from "@/server/lib/catalog-cache";

/**
 * Where a retired listing's old slug goes (doc 30 §3.9, D12). Consulted only
 * when the slug is not a published listing.
 *
 *  - The replacement is published, not deleted and indexable (reviewed, an
 *    active link without `noindex`): a permanent redirect to it.
 *  - Otherwise (the replacement was unpublished, rolled back or is waiting
 *    for review): a temporary redirect to the old listing's category page.
 *  - The old listing is live again (restored and published): nothing; the
 *    page itself serves it.
 *
 * Cached with the catalogue (tag "catalog", 60 s), so a publish, retire or
 * restore is reflected as soon as the catalogue is revalidated.
 */

export type RetiredSlugTarget = { to: string; permanent: boolean } | null;

/** Only a well-formed slug is looked up (review 106 N1-14): random paths cost no query and no cache entry. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function lookupRetiredSlug(slug: string): Promise<RetiredSlugTarget> {
  if (slug.length < 3 || slug.length > 80 || !SLUG.test(slug)) return null;
  try {
    const r = await prisma.productRedirect.findUnique({
      where: { oldSlug: slug },
      select: {
        oldProduct: { select: { status: true, deletedAt: true, categorySlug: true } },
        targetProduct: { select: { slug: true, status: true, deletedAt: true, listingLink: { select: { noindex: true, reviewedAt: true, deactivatedAt: true } } } },
      },
    });
    if (!r) return null;
    if (!r.oldProduct.deletedAt && r.oldProduct.status === "published") return null;
    const t = r.targetProduct;
    const indexable = !t.listingLink || (!t.listingLink.deactivatedAt && !t.listingLink.noindex && t.listingLink.reviewedAt !== null);
    if (t.status === "published" && !t.deletedAt && indexable) return { to: `/activities/${t.slug}`, permanent: true };
    return { to: `/categories/${r.oldProduct.categorySlug}`, permanent: false };
  } catch (error) {
    log.warn("catalog.redirect_lookup_failed", { error });
    return null;
  }
}

const cachedLookup = unstable_cache(lookupRetiredSlug, ["retired-slug-v1"], { tags: [CATALOG_TAG], revalidate: 60 });

/** The cached lookup, reached only by well-formed slugs. */
export async function resolveRetiredSlug(slug: string): Promise<RetiredSlugTarget> {
  if (slug.length < 3 || slug.length > 80 || !SLUG.test(slug)) return null;
  return cachedLookup(slug);
}
