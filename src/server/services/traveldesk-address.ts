import "server-only";
import { Prisma, type Product } from "@prisma/client";
import type { Tx } from "../lib/db";
import type { Actor } from "../lib/actor";
import { requirePermission } from "../lib/actor";
import { audit } from "../lib/audit";
import { Errors } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { staticSlugReferences } from "../suppliers/traveldesk/slug-references";
import { cleanSlugOf, isTombstoneOf, REDIRECT_ONLY_REASON_PREFIX, RETIRE_REASON_PREFIX, retireDecision, retireMarkerOf, tombstoneSlug, TOMBSTONE_MARK, withSlug } from "../suppliers/traveldesk/clean-address";
import { activitySchema } from "../schemas/activity.schema";
import { productLifecycle } from "./activity.service";
import { recordEditorialLocks } from "./listing-locks";
import { moveRedirectTo, tombstoneBase } from "./slug-reservations";

/**
 * Retire and address rules of imported TravelDesk listings (doc 30 §3.9),
 * shared by publish, the later "retire old page" action, the "move to clean
 * address" action and its undo, and the restore path (restoreReplacedInTx).
 * Everything here runs inside the caller's transaction and never revalidates
 * the catalogue; the caller does after commit.
 *
 * Move to clean address: a listing published as "<base>-<n>" because the page
 * it replaced still held "<base>" takes "<base>". The retired page's row
 * keeps its id, history and redirects but its slug becomes the non-public
 * tombstone "<base>--retired-<id8>"; the redirect "<base>" -> listing goes
 * (the listing now lives there) and "<base>-<n>" -> listing is written so old
 * links, order and inquiry slug snapshots keep landing on the page.
 * `product_redirects.old_product_id` must differ from the target
 * (`pr_not_self_check`), so the new redirect names the retired page as its
 * old product. Redirects are resolved by target id at request time, so other
 * redirects already pointing at the listing follow it without a rewrite.
 *
 * Undo (and the restore path, which undoes a move first) is the exact
 * inverse: the listing goes back to "<base>-<n>", the retired page gets
 * "<base>" back, "<base>-<n>" -> listing goes and "<base>" -> listing returns
 * (so references to "<base>" keep landing on the listing), and a
 * `replaces_product_id` the move recorded is cleared again. A move is found
 * by its redirect (slug-reservations.ts `moveRedirectTo`), never by the
 * listing's current slug; while it stands the listing's slug is fixed
 * (activity update and restore-version refuse) and "<base>-<n>" is reserved.
 *
 * Retire markers (the latest version reason of the old page; restore checks
 * them, N1-11): "Replaced by " for a page this flow soft-deleted, which the
 * restore path publishes again; "Redirected to " for a page that was already
 * archived and only got the redirect, which the restore path leaves archived
 * (it drops the redirect only). A slug write on the old page keeps the marker
 * its latest version already has and never adds one.
 */

export { REDIRECT_ONLY_REASON_PREFIX, RETIRE_REASON_PREFIX, retireMarkerOf, withSlug };

/** The latest version reason of a product. */
export async function latestReason(tx: Tx, p: { id: string; version: number }): Promise<string | null> {
  return (await tx.productVersion.findUnique({ where: { productId_version: { productId: p.id, version: p.version } }, select: { reason: true } }))?.reason ?? null;
}

const OPEN_INQUIRY = ["new", "assigned", "contacted", "quoted", "negotiating", "payment_pending"] as const;
const OPEN_ORDER = ["pending_payment", "paid", "supplier_pending", "confirmed", "partially_confirmed"] as const;

/** Other listings (any product) whose related or combo slugs name `slug`, plus categories that feature it. */
export async function dbSlugReferences(db: Prisma.TransactionClient, slug: string, excludeProductId: string): Promise<string[]> {
  const [products, categories] = await Promise.all([
    db.$queryRaw<{ slug: string }[]>`
      SELECT slug FROM products
      WHERE deleted_at IS NULL AND id <> ${excludeProductId}::uuid
        AND (content->'relatedSlugs' ? ${slug} OR content->'comboSlugs' ? ${slug})
      ORDER BY slug LIMIT 50`,
    db.category.findMany({ where: { deletedAt: null, featuredSlugs: { has: slug } }, select: { slug: true } }),
  ]);
  return [...products.map((p) => `listing:${p.slug}`), ...categories.map((c) => `category:${c.slug}`)];
}

/** Site data and other listings that still name `slug`, the listing itself excluded (§3.9 "Other references"). */
export async function slugReferences(tx: Tx, slug: string, listing: { id: string; slug: string }): Promise<string[]> {
  return [...staticSlugReferences(slug), ...(await dbSlugReferences(tx, slug, listing.id))].filter((r) => r !== `listing:${listing.slug}`);
}

async function openWork(tx: Tx, productId: string) {
  const [openInquiries, openOrders] = await Promise.all([
    tx.inquiryItem.count({ where: { productId, inquiry: { status: { in: [...OPEN_INQUIRY] } } } }),
    tx.orderItem.count({ where: { productId, order: { status: { in: [...OPEN_ORDER] } } } }),
  ]);
  return { openInquiries, openOrders };
}

export type RetireCheck = { kind: "stop"; reason: string; references: string[] } | { kind: "keep"; reason: string } | { kind: "retire" };

/**
 * The publish path's retire rules for a live old page: a reference to its slug stops the item until repointed;
 * an instant page, an open order or inquiry, or a page that is not published is kept (reported).
 */
export async function retireCheck(tx: Tx, old: Product, listing: { id: string; slug: string }): Promise<RetireCheck> {
  const references = await slugReferences(tx, old.slug, listing);
  if (references.length) return { kind: "stop", reason: `the old slug "${old.slug}" is still named elsewhere`, references };
  const eligibility = await tx.productEligibility.findUnique({ where: { productId: old.id }, select: { effectiveMode: true } });
  const work = await openWork(tx, old.id);
  const kept = retireDecision({ fulfilmentMode: old.fulfilmentMode, effectiveMode: eligibility?.effectiveMode ?? null, status: old.status, ...work });
  return kept ? { kind: "keep", reason: kept } : { kind: "retire" };
}

/**
 * An existing redirect on the old page's slug. A dormant one (its old page is this same page, live and published
 * again, e.g. restored from the console after an earlier retire, so the storefront ignores it) may be taken over:
 * returned. Any other refuses (a redirect naming a different old page is never retargeted).
 */
async function redirectToTakeOver(tx: Tx, old: Product, listing: { id: string }) {
  const existing = await tx.productRedirect.findUnique({ where: { oldSlug: old.slug }, include: { oldProduct: { select: { deletedAt: true, status: true } } } });
  if (!existing) return null;
  if (existing.oldProductId === old.id && !existing.oldProduct.deletedAt && existing.oldProduct.status === "published") return existing;
  throw Errors.conflict(existing.targetProductId === listing.id ? `"${old.slug}" already redirects to this listing` : `"${old.slug}" already redirects to another listing; that redirect stays`);
}

/** A takeover from another link: that link's listing title (it no longer replaces the page), for the caller's report. */
export type Takeover = { linkId: string; title: string } | null;

/** Write the permanent redirect, taking over a dormant one: the link that held it no longer names the page. */
async function writeRedirect(tx: Tx, actor: Actor, dormant: Awaited<ReturnType<typeof redirectToTakeOver>>, old: Product, listing: { id: string }, linkId: string, reason: string): Promise<Takeover> {
  if (!dormant) {
    await tx.productRedirect.create({ data: { id: uuidv7(), oldSlug: old.slug, oldProductId: old.id, targetProductId: listing.id, linkId, createdBy: actor.id } });
    return null;
  }
  let takeover: Takeover = null;
  if (dormant.linkId && dormant.linkId !== linkId) {
    const released = await tx.supplierListingLink.updateMany({ where: { id: dormant.linkId, replacesProductId: old.id }, data: { replacesProductId: null } });
    const prior = await tx.supplierListingLink.findUnique({ where: { id: dormant.linkId }, select: { product: { select: { title: true } } } });
    if (released.count === 1 && prior) takeover = { linkId: dormant.linkId, title: prior.product.title };
  }
  await tx.productRedirect.update({ where: { id: dormant.id }, data: { oldProductId: old.id, targetProductId: listing.id, linkId, createdBy: actor.id } });
  await audit(actor, "product_redirect.retarget", { type: "product", id: old.id }, { before: { oldSlug: dormant.oldSlug, oldProductId: dormant.oldProductId, targetProductId: dormant.targetProductId, linkId: dormant.linkId }, after: { targetProductId: listing.id, linkId, released: takeover?.linkId ?? null }, reason }, tx);
  return takeover;
}

/** Soft delete the old page with the retire reason, and its permanent redirect to the listing. An existing redirect on its slug refuses it unless dormant (taken over). */
export async function retireInTx(tx: Tx, actor: Actor, old: Product, listing: { id: string; slug: string }, linkId: string, reason: string): Promise<{ takeover: Takeover }> {
  const dormant = await redirectToTakeOver(tx, old, listing);
  await productLifecycle.softDeleteInTx(tx, actor, old.id, `${RETIRE_REASON_PREFIX}${listing.slug}: ${reason}`);
  const takeover = await writeRedirect(tx, actor, dormant, old, listing, linkId, reason);
  await audit(actor, "traveldesk_listing.retire", { type: "product", id: old.id }, { after: { oldSlug: old.slug, replacedBy: listing.id, linkId, redirect: "permanent" }, reason }, tx);
  return { takeover };
}

/**
 * An old page that was archived some other way (no redirect on its slug): a version marked "Redirected to " (the
 * restore path then drops the redirect and leaves the page archived, review P2-2) and the permanent redirect. Open work on it stops it. References to its slug do not: the page already left every
 * list that names it when it was archived, and the redirect only mends links to it (publish checks references
 * only for a live old page). They are returned so the caller can report them; a move to the clean address makes
 * them name the listing.
 */
export async function redirectArchivedInTx(tx: Tx, actor: Actor, old: Product, listing: { id: string; slug: string }, linkId: string, reason: string): Promise<{ references: string[]; takeover: Takeover }> {
  if (!old.deletedAt) throw new Error("redirectArchivedInTx: the old page is live");
  if (old.slug.includes(TOMBSTONE_MARK)) throw Errors.conflict(`"${old.slug}" gave its address to another listing; undo that move first`);
  const dormant = await redirectToTakeOver(tx, old, listing);
  const references = await slugReferences(tx, old.slug, listing);
  const work = await openWork(tx, old.id);
  if (work.openOrders > 0) throw Errors.conflict("The old listing has an open order");
  if (work.openInquiries > 0) throw Errors.conflict("The old listing has an open inquiry");
  const why = `${REDIRECT_ONLY_REASON_PREFIX}${listing.slug}: ${reason}`;
  const version = old.version + 1;
  const written = await tx.product.updateMany({ where: { id: old.id, version: old.version, deletedAt: { not: null } }, data: { version } });
  if (written.count !== 1) throw Errors.conflict(`"${old.slug}" changed while it was being redirected — try again`);
  await tx.productVersion.create({ data: { id: uuidv7(), productId: old.id, version, content: old.content as Prisma.InputJsonValue, status: old.status, actorId: actor.id, reason: why } });
  const takeover = await writeRedirect(tx, actor, dormant, old, listing, linkId, reason);
  await audit(actor, "traveldesk_listing.retire", { type: "product", id: old.id }, { after: { oldSlug: old.slug, replacedBy: listing.id, linkId, redirect: "permanent", alreadyArchived: true, redirectOnly: true, references }, reason }, tx);
  return { references, takeover };
}

/* --------------------------------------------------- move to clean address */

/** Lock the product rows first, by id (the lock order every writer of an imported listing takes; review 110 R110-01). */
async function lockProducts(tx: Tx, ids: string[]) {
  const sorted = [...new Set(ids)].sort();
  await tx.$queryRaw`SELECT id FROM products WHERE id = ANY(${sorted}::uuid[]) ORDER BY id FOR UPDATE`;
}

/** The retired page's reason for a slug write: its latest retire marker kept (never added; review P2-3), else neutral. */
async function holderReason(tx: Tx, holder: Product, target: string, text: string): Promise<string> {
  const marker = retireMarkerOf(await latestReason(tx, holder));
  return marker ? `${marker}${target}: ${text}` : `Address change: ${text}`;
}

/**
 * The address writes are system writes for the editorial locks (listing-locks.ts): the image-ref rewrite is not a
 * person's edit, so `images` is never locked by it, and the baseline moves to the version written so a later
 * person's save does not see the rewritten refs as their change (review P2). Locks already recorded stay.
 */
const ADDRESS_LOCKS = { systemFields: ["images"], rebase: true } as const;

/** Version-guarded slug write with a version row and the editor's audit entry (activityService.update's shape). */
async function writeSlug(tx: Tx, actor: Actor, p: Product, slug: string, reason: string, opts: { deleted: boolean; contentSlug: boolean }) {
  const version = p.version + 1;
  const content = opts.contentSlug ? withSlug(p.content as Record<string, unknown>, p.slug, slug) : (p.content as Record<string, unknown>);
  const written = await tx.product.updateMany({
    where: { id: p.id, version: p.version, ...(opts.deleted ? { deletedAt: { not: null } } : { deletedAt: null }) },
    data: { slug, version, content: content as Prisma.InputJsonValue },
  });
  if (written.count !== 1) throw Errors.conflict(`"${p.slug}" changed while its address was being moved — reload and try again`, { slug: p.slug });
  await tx.productVersion.create({ data: { id: uuidv7(), productId: p.id, version, content: content as Prisma.InputJsonValue, status: p.status, actorId: actor.id, reason } });
  await audit(actor, "activity.update", { type: "product", id: p.id }, { before: { version: p.version, slug: p.slug, title: p.title }, after: { version, slug, title: p.title }, reason }, tx);
}

export type AddressMove = { linkId: string; listingId: string; retiredId: string; from: string; to: string; tombstone: string };

/**
 * Move a published imported listing from "<base>-<n>" to "<base>" (see the file comment). Refused, with the reason:
 * the slug has no "-<n>" suffix; "<base>" is held by a live product or by nothing retired; the retired page is not
 * the one this listing replaced (nor redirects to it); a redirect on "<base>" points elsewhere; "<base>-<n>"
 * already has a redirect; site data or another listing still names "<base>-<n>" (listed).
 */
export async function moveToCleanAddressInTx(tx: Tx, actor: Actor, linkId: string, reason: string): Promise<AddressMove> {
  requirePermission(actor, "products.publish");
  requirePermission(actor, "products.delete");
  const first = await tx.supplierListingLink.findUnique({ where: { id: linkId }, select: { productId: true, replacesProductId: true } });
  if (!first) throw Errors.notFound("Imported listing");
  const pre = await tx.product.findUnique({ where: { id: first.productId }, select: { slug: true } });
  const pending = pre ? cleanSlugOf(pre.slug) : null;
  const holderPre = pending ? await tx.product.findUnique({ where: { slug: pending }, select: { id: true } }) : null;
  await lockProducts(tx, [first.productId, ...(holderPre ? [holderPre.id] : [])]);

  const link = await tx.supplierListingLink.findUniqueOrThrow({ where: { id: linkId }, include: { product: true } });
  const listing = link.product;
  if (link.deactivatedAt) throw Errors.conflict("This imported listing was rolled back");
  if (!link.reviewedAt || link.noindex) throw Errors.conflict("This listing is not marked reviewed");
  if (listing.deletedAt || listing.status !== "published") throw Errors.conflict("Only a published listing can move to its clean address");
  const base = cleanSlugOf(listing.slug);
  if (!base) throw Errors.conflict(`"${listing.slug}" does not end in -<number>; there is no clean address to move to`);
  if (base !== pending) throw Errors.conflict(`"${listing.slug}" changed while its address was being moved — reload and try again`);

  const holder = await tx.product.findUnique({ where: { slug: base } });
  if (!holder) throw Errors.conflict(`No retired page holds "${base}"; change the slug in the editor instead`);
  if (!holder.deletedAt) throw Errors.conflict(`"${base}" is held by a live listing; retire it first`, { holderId: holder.id });
  const holderLink = await tx.supplierListingLink.findUnique({ where: { productId: holder.id }, select: { deactivatedAt: true } });
  if (holderLink && !holderLink.deactivatedAt) throw Errors.conflict(`"${base}" belongs to an active imported listing`);

  const baseRedirect = await tx.productRedirect.findUnique({ where: { oldSlug: base } });
  if (!baseRedirect) throw Errors.conflict(`"${base}" has no redirect to this listing; retire the old page first`);
  if (baseRedirect.targetProductId !== listing.id || baseRedirect.oldProductId !== holder.id) throw Errors.conflict(`"${base}" redirects to another listing; moving would break that redirect`);
  if (link.replacesProductId && link.replacesProductId !== holder.id) throw Errors.conflict("This listing replaces another page; restore that first");
  if (await tx.productRedirect.findUnique({ where: { oldSlug: listing.slug }, select: { id: true } })) throw Errors.conflict(`"${listing.slug}" already has a redirect; moving would loop`);

  const references = await slugReferences(tx, listing.slug, listing);
  if (references.length) throw Errors.conflict(`"${listing.slug}" is still named elsewhere: ${references.join(", ")} — repoint those to "${base}" first`, { references });

  if (!activitySchema.safeParse({ ...(listing.content as Record<string, unknown>), slug: base }).success) throw Errors.conflict("The listing's document is not valid — fix it in the editor first");

  const tombstone = tombstoneSlug(base, holder.id);
  if (await tx.product.findUnique({ where: { slug: tombstone }, select: { id: true } })) throw Errors.conflict(`The address "${tombstone}" is taken`);

  const why = reason.trim();
  // The retired page first, so "<base>" is free when the listing takes it. Its reason keeps the retire prefix,
  // so the restore path still recognises the page as retired by this listing (N1-11).
  await writeSlug(tx, actor, holder, tombstone, await holderReason(tx, holder, base, `address freed for the replacement; ${why}`), { deleted: true, contentSlug: false });
  await writeSlug(tx, actor, listing, base, `Moved to clean address ${base}: ${why}`, { deleted: false, contentSlug: true });
  await recordEditorialLocks(tx, listing.id, ADDRESS_LOCKS);
  await tx.productRedirect.delete({ where: { id: baseRedirect.id } });
  await tx.productRedirect.create({ data: { id: uuidv7(), oldSlug: listing.slug, oldProductId: holder.id, targetProductId: listing.id, linkId, createdBy: actor.id } });
  if (!link.replacesProductId) await tx.supplierListingLink.update({ where: { id: linkId }, data: { replacesProductId: holder.id } });
  await audit(
    actor,
    "traveldesk_listing.move_address",
    { type: "product", id: listing.id },
    { before: { slug: listing.slug, retiredSlug: base, redirect: `${base} -> ${listing.slug}` }, after: { slug: base, retiredSlug: tombstone, retiredId: holder.id, redirect: `${listing.slug} -> ${base}`, linkId, setReplaces: !link.replacesProductId }, reason: why },
    tx,
  );
  return { linkId, listingId: listing.id, retiredId: holder.id, from: listing.slug, to: base, tombstone };
}

/**
 * The state a move left for this link, found by its redirect (`moveRedirectTo`), or null when the listing was not
 * moved (or the move was undone). `base` comes from the retired page's tombstone, not from the listing's slug.
 */
export async function movedAddressInTx(tx: Tx, linkId: string) {
  const link = await tx.supplierListingLink.findUnique({ where: { id: linkId }, include: { product: true } });
  if (!link) return null;
  const r = await moveRedirectTo(tx, link.productId);
  if (!r || (r.linkId !== null && r.linkId !== linkId)) return null;
  const holder = await tx.product.findUniqueOrThrow({ where: { id: r.oldProductId } });
  const base = tombstoneBase(holder.slug)!;
  const redirect = await tx.productRedirect.findUniqueOrThrow({ where: { id: r.id } });
  return { link, listing: link.product, holder, redirect, base };
}

/**
 * Undo a move: the listing back to "<base>-<n>", the retired page back to "<base>", the redirects as before the
 * move ("<base>" -> listing again, so references to "<base>" still land on the listing), and a
 * `replaces_product_id` the move recorded cleared. Null when there is no move to undo.
 */
export async function undoCleanAddressInTx(tx: Tx, actor: Actor, linkId: string, reason: string): Promise<AddressMove | null> {
  const peek = await tx.supplierListingLink.findUnique({ where: { id: linkId }, select: { productId: true } });
  if (!peek) return null;
  const pre = await moveRedirectTo(tx, peek.productId);
  if (!pre) return null;
  await lockProducts(tx, [peek.productId, pre.oldProductId]);
  const moved = await movedAddressInTx(tx, linkId);
  if (!moved) return null;
  // Checked only when there is a move to undo: the batch rollback calls this for every link.
  requirePermission(actor, "products.publish");
  requirePermission(actor, "products.delete");
  const { listing, holder, redirect, base } = moved;
  const back = redirect.oldSlug;
  if (!isTombstoneOf(holder.slug, base, holder.id)) throw Errors.conflict(`The retired page's address "${holder.slug}" does not match its id; fix it by hand`);
  if (listing.slug !== base) throw Errors.conflict(`"${listing.slug}" is no longer at "${base}" (its slug changed after the move); set it back to "${base}" first`, { slug: listing.slug, base });
  const taken = await tx.product.findUnique({ where: { slug: back }, select: { id: true } });
  if (taken) throw Errors.conflict(`"${back}" is now used by another listing; the move cannot be undone`);
  if (await tx.productRedirect.findUnique({ where: { oldSlug: base }, select: { id: true } })) throw Errors.conflict(`"${base}" has a redirect of its own; remove it first`);
  const moveAudit = await tx.auditLog.findFirst({ where: { action: "traveldesk_listing.move_address", entityType: "product", entityId: listing.id }, orderBy: { createdAt: "desc" }, select: { after: true } });
  const setReplaces = (moveAudit?.after as { setReplaces?: unknown } | null)?.setReplaces === true;
  const why = reason.trim();
  await writeSlug(tx, actor, listing, back, `Moved back to ${back}: ${why}`, { deleted: Boolean(listing.deletedAt), contentSlug: true });
  await writeSlug(tx, actor, holder, base, await holderReason(tx, holder, back, `address returned; ${why}`), { deleted: true, contentSlug: false });
  if (!listing.deletedAt) await recordEditorialLocks(tx, listing.id, ADDRESS_LOCKS);
  await tx.productRedirect.delete({ where: { id: redirect.id } });
  await tx.productRedirect.create({ data: { id: uuidv7(), oldSlug: base, oldProductId: holder.id, targetProductId: listing.id, linkId, createdBy: actor.id } });
  if (setReplaces) await tx.supplierListingLink.updateMany({ where: { id: linkId, replacesProductId: holder.id }, data: { replacesProductId: null } });
  await audit(
    actor,
    "traveldesk_listing.move_address_undo",
    { type: "product", id: listing.id },
    { before: { slug: base, retiredSlug: holder.slug, redirect: `${back} -> ${base}` }, after: { slug: back, retiredSlug: base, retiredId: holder.id, redirect: `${base} -> ${back}`, linkId, clearedReplaces: setReplaces }, reason: why },
    tx,
  );
  return { linkId, listingId: listing.id, retiredId: holder.id, from: base, to: back, tombstone: holder.slug };
}
