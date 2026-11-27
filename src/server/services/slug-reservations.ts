import "server-only";
import type { Prisma } from "@prisma/client";
import { cleanSlugOf, TOMBSTONE_MARK } from "../suppliers/traveldesk/clean-address";

/**
 * Which activity slugs are spoken for (doc 30 §3.9 follow-up, review of the
 * address clean-up P1-1). A slug is taken while a product row holds it,
 * deleted or not (a deleted URL is never handed to a new listing), and while
 * a permanent redirect starts from it (`product_redirects.old_slug`): a
 * listing created there would silently take over a retired or moved page's
 * old links. Every writer that picks or changes a slug asks here: activity
 * create, update, duplicate and restore-version, the CSV import and the
 * TravelDesk importer. No database trigger (that needs a migration).
 *
 * Also: the "moved to its clean address" redirect of a product (the
 * retired page's row carries the tombstone slug, the redirect starts from
 * "<base>-<n>" and the product lives at "<base>"). While it exists, the
 * product's slug is fixed; undo the move first.
 */

type Db = Pick<Prisma.TransactionClient, "product" | "productRedirect">;

/** "product" when a product row holds `slug`, "redirect" when a redirect starts from it, else null. */
export async function slugTaken(db: Db, slug: string): Promise<"product" | "redirect" | null> {
  const [product, redirect] = await Promise.all([db.product.findUnique({ where: { slug }, select: { id: true } }), db.productRedirect.findUnique({ where: { oldSlug: slug }, select: { id: true } })]);
  return product ? "product" : redirect ? "redirect" : null;
}

/** The subset of `slugs` a product or a redirect holds (one query each). */
export async function takenSlugs(db: Db, slugs: string[]): Promise<Set<string>> {
  if (!slugs.length) return new Set();
  const [products, redirects] = await Promise.all([
    db.product.findMany({ where: { slug: { in: slugs } }, select: { slug: true } }),
    db.productRedirect.findMany({ where: { oldSlug: { in: slugs } }, select: { oldSlug: true } }),
  ]);
  return new Set([...products.map((p) => p.slug), ...redirects.map((r) => r.oldSlug)]);
}

/** Every redirect source slug starting with `prefix` (to extend a product-slug "taken" set). */
export async function redirectSlugsStartingWith(db: Db, prefix: string): Promise<string[]> {
  return (await db.productRedirect.findMany({ where: { oldSlug: { startsWith: prefix } }, select: { oldSlug: true } })).map((r) => r.oldSlug);
}

/** The conflict message for a taken slug. */
export function takenMessage(slug: string, by: "product" | "redirect"): string {
  return by === "product" ? `Slug "${slug}" is already in use` : `Slug "${slug}" is reserved: a retired or moved page's old address redirects from it`;
}

/** The base "<base>" of a tombstone "<base>--retired-<id8>", or null. */
export function tombstoneBase(slug: string): string | null {
  const i = slug.indexOf(TOMBSTONE_MARK);
  return i > 0 ? slug.slice(0, i) : null;
}

/**
 * The redirect a move to the clean address left for `productId` (the target), found by the redirect itself, not by
 * the product's current slug: its old product carries a tombstone and its source is "<tombstone base>-<n>".
 */
export async function moveRedirectTo(db: Db, productId: string) {
  const rows = await db.productRedirect.findMany({
    where: { targetProductId: productId, oldProduct: { slug: { contains: TOMBSTONE_MARK } } },
    select: { id: true, oldSlug: true, linkId: true, oldProductId: true, targetProductId: true, oldProduct: { select: { slug: true } } },
  });
  return rows.find((r) => cleanSlugOf(r.oldSlug) !== null && cleanSlugOf(r.oldSlug) === tombstoneBase(r.oldProduct.slug)) ?? null;
}
