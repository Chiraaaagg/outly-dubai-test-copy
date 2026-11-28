import "server-only";
import { Prisma } from "@prisma/client";
import { prisma, TX_OPTIONS } from "../lib/db";
import type { Actor } from "../lib/actor";
import { requirePermission } from "../lib/actor";
import { audit } from "../lib/audit";
import { Errors, isAppError } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { revalidateCatalog } from "../lib/catalog-cache";
import { activitySchema } from "../schemas/activity.schema";
import { PENDING_TEXT } from "../suppliers/traveldesk/traveldesk.listing-build";
import { cleanSlugOf } from "../suppliers/traveldesk/clean-address";
import { tombstoneBase } from "./slug-reservations";
import { importService } from "./import.service";
import { readinessService } from "./readiness.service";
import { restoreReplacedInTx } from "./traveldesk-import.service";
import { moveToCleanAddressInTx, redirectArchivedInTx, retireCheck, retireInTx, undoCleanAddressInTx } from "./traveldesk-address";
import { recordEditorialLocks } from "./listing-locks";
import { env } from "../lib/env";
import { log } from "../lib/logger";

/**
 * Review queue, publish and replace for imported TravelDesk listings (doc 30
 * §2 steps 3–4, §3.9; owner decisions D8, D12).
 *
 *  - Mark reviewed: a person confirms copy and facts and picks the old page
 *    this listing replaces (pre-filled from stored suggestions). Refused while
 *    a field TravelDesk does not supply still shows its placeholder, while a
 *    sibling listing of the same tour has the same title or subtitle (each
 *    needs its own copy), or when the old page is not a plain listing. The
 *    editorial fields a person changed since the import are recorded as
 *    locked (N3 never overwrites them). `noindex` lifts here.
 *  - Publish (bulk, at most 50): each item commits alone. A listing goes
 *    live only when reviewed. Its old page is retired at that moment, never
 *    before, through the existing soft delete, with a permanent redirect
 *    (`product_redirects`). An old page that is instant, or has an open order
 *    or inquiry, is not retired (reported); an old slug still named in the
 *    site data or another listing's related or combo slugs stops the item
 *    until it is repointed.
 *  - Restore: the retired page comes back published and its redirect goes.
 *  - Retire old page (after publish): the same retire rules for a page the
 *    listing was published without retiring; an old page already archived
 *    some other way only gets the redirect (and a retire version, so restore
 *    works). The link records it as the page it replaces.
 *  - Move to clean address, and its undo: traveldesk-address.ts.
 */

export const PUBLISH_BATCH_LIMIT = 50;

export interface ReviewQueueRow {
  linkId: string;
  productId: string;
  slug: string;
  title: string;
  status: string;
  kind: string;
  tourExternalId: string;
  classKey: string | null;
  splitNumber: number;
  environment: string;
  adopted: boolean;
  reviewedAt: Date | null;
  noindex: boolean;
  pendingFields: string[];
  lockedFields: string[];
  replaces: { productId: string; slug: string; title: string; deletedAt: Date | null } | null;
  suggestions: { productId: string; slug: string; title: string; score: number }[];
  importBatchId: string | null;
  /** Published, nothing retired yet: old pages "Retire old page" offers (the suggestions and the page holding the clean address). */
  retireOptions: { productId: string; slug: string; title: string; archived: boolean }[];
  /** Published as "<base>-<n>" with "<base>" retired and redirecting here: the address it can move to. */
  cleanAddress: string | null;
  /** Moved to its clean address: the "<base>-<n>" it came from (undo moves it back). */
  movedFrom: string | null;
}

export type PublishItemResult =
  | { linkId: string; outcome: "published"; slug: string; retired: string | null; notRetired?: string }
  | { linkId: string; outcome: "stopped"; reason: string; references?: string[] };

/** Placeholder fields still showing, by name (checked at review and again at publish; review 106 N1-09). */
function stillPending(doc: { location: string; meetingPoint: string; images: string[] }): string[] {
  const out: string[] = [];
  if (doc.location.trim() === PENDING_TEXT) out.push("location");
  if (doc.meetingPoint.trim() === PENDING_TEXT) out.push("meetingPoint");
  if (doc.images.every((i) => i.startsWith("img:"))) out.push("images");
  return out;
}

/** Sibling pages of the same tour with the same title or subtitle: each needs its own copy (§3.3). */
async function sharedCopy(tx: Prisma.TransactionClient, link: { id: string; supplierId: string; environment: string; tourExternalId: string }, doc: { title: string; subtitle: string }): Promise<string[]> {
  const siblings = await tx.supplierListingLink.findMany({
    where: { id: { not: link.id }, supplierId: link.supplierId, environment: link.environment as "test" | "production", tourExternalId: link.tourExternalId, deactivatedAt: null },
    include: { product: { select: { slug: true, title: true, subtitle: true, deletedAt: true } } },
  });
  const norm = (v: string | null) => (v ?? "").trim().toLowerCase();
  return siblings.filter((x) => !x.product.deletedAt && (norm(x.product.title) === norm(doc.title) || norm(x.product.subtitle) === norm(doc.subtitle))).map((x) => x.product.slug);
}

/** A listing imported from the test catalogue never reviews or replaces a page of a production deployment (review 106 N1-17). */
function assertEnvironment(link: { environment: string }) {
  if (env().isProduction && link.environment !== "production") throw Errors.conflict("This listing was imported from the TravelDesk test catalogue; it cannot be reviewed or published here", { environment: link.environment });
}

export const traveldeskListingService = {
  async queue(actor: Actor, filters: { environment?: "test" | "production"; batchId?: string; reviewed?: boolean } = {}): Promise<ReviewQueueRow[]> {
    requirePermission(actor, "products.edit");
    const links = await prisma.supplierListingLink.findMany({
      where: {
        deactivatedAt: null,
        ...(filters.environment ? { environment: filters.environment } : {}),
        ...(filters.batchId ? { importBatchId: filters.batchId } : {}),
        ...(filters.reviewed === undefined ? {} : filters.reviewed ? { reviewedAt: { not: null } } : { reviewedAt: null }),
      },
      include: { product: { select: { id: true, slug: true, title: true, status: true, deletedAt: true } }, replaces: { select: { id: true, slug: true, title: true, deletedAt: true } } },
      orderBy: [{ tourExternalId: "asc" }, { kind: "asc" }, { splitNumber: "asc" }],
      take: 500,
    });
    const candidates = await prisma.supplierMappingCandidate.findMany({
      where: { offerExternalId: { in: [...new Set(links.flatMap((l) => l.offerExternalIds))] }, source: { not: "import" }, state: { in: ["suggested", "approved"] }, product: { deletedAt: null } },
      select: { offerExternalId: true, score: true, product: { select: { id: true, slug: true, title: true } } },
    });
    // The address clean-up (traveldesk-address.ts): who holds each "<base>", and the redirects of these links.
    const active = links.filter((l) => !l.product.deletedAt);
    const live = active.filter((l) => l.product.status === "published" && l.reviewedAt);
    const bases = [...new Set(live.flatMap((l) => cleanSlugOf(l.product.slug) ?? []))];
    const [holders, redirects] = await Promise.all([
      bases.length ? prisma.product.findMany({ where: { slug: { in: bases } }, select: { id: true, slug: true, title: true, deletedAt: true } }) : Promise.resolve([]),
      active.length
        ? prisma.productRedirect.findMany({ where: { OR: [{ oldSlug: { in: bases } }, { linkId: { in: active.map((l) => l.id) } }] }, select: { oldSlug: true, oldProductId: true, targetProductId: true, linkId: true, oldProduct: { select: { slug: true } } } })
        : Promise.resolve([]),
    ]);
    const holderBy = new Map(holders.map((h) => [h.slug, h]));
    const address = (l: (typeof links)[number]) => {
      // A move is found by its redirect (slug-reservations.ts), published or not: the undo stays offered.
      const move = redirects.find((x) => x.linkId === l.id && x.targetProductId === l.productId && cleanSlugOf(x.oldSlug) !== null && cleanSlugOf(x.oldSlug) === tombstoneBase(x.oldProduct.slug));
      const movedFrom = move?.oldSlug ?? null;
      if (!live.includes(l)) return { retireOptions: [], cleanAddress: null, movedFrom };
      const r = l.replaces;
      const base = cleanSlugOf(l.product.slug);
      const holder = base ? holderBy.get(base) : undefined;
      const cleanAddress = base && holder?.deletedAt && redirects.some((x) => x.oldSlug === base && x.targetProductId === l.productId && x.oldProductId === holder.id) ? base : null;
      const options = new Map<string, ReviewQueueRow["retireOptions"][number]>();
      // The page the link names, when it is still live, is the only one it may retire (retireOld refuses another).
      if (r && !r.deletedAt) options.set(r.id, { productId: r.id, slug: r.slug, title: r.title, archived: false });
      else if (!r) {
        for (const c of candidates) if (l.offerExternalIds.includes(c.offerExternalId) && c.product.id !== l.productId) options.set(c.product.id, { productId: c.product.id, slug: c.product.slug, title: c.product.title, archived: false });
        if (holder && holder.id !== l.productId && !(holder.deletedAt && redirects.some((x) => x.oldSlug === holder.slug))) options.set(holder.id, { productId: holder.id, slug: holder.slug, title: holder.title, archived: Boolean(holder.deletedAt) });
      }
      return { retireOptions: [...options.values()].slice(0, 6), cleanAddress, movedFrom };
    };
    return links
      .filter((l) => !l.product.deletedAt)
      .map((l) => {
        const best = new Map<string, ReviewQueueRow["suggestions"][number]>();
        for (const c of candidates) {
          if (!l.offerExternalIds.includes(c.offerExternalId) || c.product.id === l.productId) continue;
          const prev = best.get(c.product.id);
          if (!prev || prev.score < c.score) best.set(c.product.id, { productId: c.product.id, slug: c.product.slug, title: c.product.title, score: c.score });
        }
        return {
          linkId: l.id,
          productId: l.productId,
          slug: l.product.slug,
          title: l.product.title,
          status: l.product.status,
          kind: l.kind,
          tourExternalId: l.tourExternalId,
          classKey: l.classKey,
          splitNumber: l.splitNumber,
          environment: l.environment,
          adopted: l.adopted,
          reviewedAt: l.reviewedAt,
          noindex: l.noindex,
          pendingFields: l.pendingFields,
          lockedFields: l.lockedFields,
          replaces: l.replaces ? { productId: l.replaces.id, slug: l.replaces.slug, title: l.replaces.title, deletedAt: l.replaces.deletedAt } : null,
          suggestions: [...best.values()].sort((a, b) => b.score - a.score).slice(0, 5),
          importBatchId: l.importBatchId,
          ...address(l),
        };
      });
  },

  /** Mark one imported listing reviewed (§2 step 3). `confirmTierAndCategory` is the editor's statement that the pre-filled tier and category are right. */
  async markReviewed(actor: Actor, linkId: string, input: { replacesProductId: string | null; confirmTierAndCategory: boolean; note: string }) {
    requirePermission(actor, "products.edit");
    if (!actor.id) throw Errors.unauthorized();
    if (input.note.trim().length < 8) throw Errors.validation({ note: "Give a reason of at least 8 characters — it goes in the audit log" });
    const row = await prisma.$transaction(async (tx) => {
      const link = await tx.supplierListingLink.findUnique({ where: { id: linkId }, include: { product: true } });
      if (!link || link.deactivatedAt) throw Errors.notFound("Imported listing");
      if (link.product.deletedAt) throw Errors.conflict("This listing was deleted");
      if (link.reviewedAt) throw Errors.conflict("This listing is already marked reviewed");
      assertEnvironment(link);
      const doc = activitySchema.safeParse(link.product.content);
      if (!doc.success) throw Errors.conflict("The listing's document is not valid — fix it in the editor first");
      const missing = stillPending(doc.data);
      if (missing.length) throw Errors.validation({ fields: `Fill these first: ${missing.join(", ")}` });
      if ((link.pendingFields.includes("tier") || link.pendingFields.includes("categorySlug")) && !input.confirmTierAndCategory) {
        throw Errors.validation({ confirmTierAndCategory: "Confirm the tier and category (TravelDesk supplies neither)" });
      }
      const same = await sharedCopy(tx, link, doc.data);
      if (same.length) throw Errors.validation({ copy: `Give this page its own title and subtitle: ${same.join(", ")} uses the same` });
      if (input.replacesProductId) {
        if (input.replacesProductId === link.productId) throw Errors.validation({ replacesProductId: "A listing cannot replace itself" });
        const old = await tx.product.findUnique({ where: { id: input.replacesProductId }, select: { id: true, deletedAt: true, listingLink: { select: { deactivatedAt: true } } } });
        if (!old || old.deletedAt) throw Errors.validation({ replacesProductId: "The old listing does not exist or is deleted" });
        if (old.listingLink && !old.listingLink.deactivatedAt) throw Errors.validation({ replacesProductId: "That listing is itself an imported TravelDesk listing" });
      }
      const now = new Date();
      // Guarded: of two concurrent reviews only one writes (review 106 N1-20).
      const claimed = await tx.supplierListingLink.updateMany({
        where: { id: link.id, reviewedAt: null, deactivatedAt: null },
        data: { reviewedAt: now, reviewedBy: actor.id, noindex: false, pendingFields: [], replacesProductId: input.replacesProductId },
      });
      if (claimed.count !== 1) throw Errors.conflict("This listing was reviewed by someone else just now");
      const locked = (await recordEditorialLocks(tx, link.productId)) ?? [];
      const updated = await tx.supplierListingLink.findUniqueOrThrow({ where: { id: link.id } });
      await audit(actor, "traveldesk_listing.review", { type: "product", id: link.productId }, { after: { linkId: link.id, replacesProductId: input.replacesProductId, lockedFields: locked }, reason: input.note.trim() }, tx);
      return updated;
    }, TX_OPTIONS).catch((e: unknown) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw Errors.conflict("Another imported listing already replaces that old listing");
      throw e;
    });
    revalidateCatalog();
    return row;
  },

  /** Bulk publish reviewed drafts, retiring the pages they replace (§2 step 4). Each item commits alone. */
  async publish(actor: Actor, linkIds: string[], reason: string): Promise<PublishItemResult[]> {
    requirePermission(actor, "products.publish");
    requirePermission(actor, "products.delete");
    if (!actor.id) throw Errors.unauthorized();
    const ids = [...new Set(linkIds)];
    if (ids.length === 0) throw Errors.validation({ ids: "Select at least one listing" });
    if (ids.length > PUBLISH_BATCH_LIMIT) throw Errors.validation({ ids: `At most ${PUBLISH_BATCH_LIMIT} listings per run` });
    if (reason.trim().length < 8) throw Errors.validation({ reason: "Give a reason of at least 8 characters — it goes in the audit log" });
    const why = reason.trim();
    const results: PublishItemResult[] = [];
    for (const linkId of ids) {
      try {
        const r = await publishOne(actor, linkId, why);
        results.push(r);
        if (r.outcome === "published") {
          revalidateCatalog();
          const link = await prisma.supplierListingLink.findUnique({ where: { id: linkId }, select: { productId: true, replacesProductId: true } });
          await readinessService.reevaluateMany([link!.productId, ...(link!.replacesProductId ? [link!.replacesProductId] : [])], "status_change");
        }
      } catch (e) {
        // One item's failure never loses the others' results (review 106 N1-16).
        if (!isAppError(e)) log.error("traveldesk_listing.publish_item_failed", { linkId, error: e });
        results.push({ linkId, outcome: "stopped", reason: isAppError(e) ? e.message : "unexpected error; see the log" });
      }
    }
    return results;
  },

  /** Bring a retired page back (published) and remove its redirect (§3.9 restore path). */
  async restoreReplaced(actor: Actor, linkId: string, reason: string) {
    requirePermission(actor, "products.publish");
    requirePermission(actor, "products.delete");
    if (reason.trim().length < 8) throw Errors.validation({ reason: "Give a reason of at least 8 characters — it goes in the audit log" });
    const touched: string[] = [];
    const redirect = await prisma.$transaction((tx) => restoreReplacedInTx(tx, actor, linkId, reason.trim(), touched), TX_OPTIONS);
    if (!redirect) throw Errors.conflict("Nothing was retired for this listing");
    revalidateCatalog();
    await readinessService.reevaluateMany(touched, "restore");
    return { restored: touched.length, oldSlug: redirect.oldSlug, redirectOnly: redirect.redirectOnly };
  },

  /**
   * Retire the old page of an already published listing (one published with "replaces: none", or whose old page
   * was archived some other way). The publish path's rules: a reference to the old slug, an open order or inquiry,
   * an instant or unpublished old page each refuse it with the reason. An old page already archived only gets the
   * permanent redirect (refused if its slug already has one, or on open work); references to its slug are returned,
   * not refused (they already name a page that is gone). The link records the page as the one it replaces,
   * so restoreReplaced undoes either case (the old page comes back published).
   */
  async retireOld(actor: Actor, linkId: string, oldProductId: string, reason: string) {
    requirePermission(actor, "products.publish");
    requirePermission(actor, "products.delete");
    if (!actor.id) throw Errors.unauthorized();
    if (reason.trim().length < 8) throw Errors.validation({ reason: "Give a reason of at least 8 characters — it goes in the audit log" });
    const why = reason.trim();
    const out = await prisma.$transaction(async (tx) => {
      const pre = await tx.supplierListingLink.findUnique({ where: { id: linkId }, select: { productId: true } });
      if (!pre) throw Errors.notFound("Imported listing");
      if (oldProductId === pre.productId) throw Errors.validation({ oldProductId: "A listing cannot replace itself" });
      // The product rows first, by id (review 110 R110-01).
      await tx.$queryRaw`SELECT id FROM products WHERE id = ANY(${[pre.productId, oldProductId].sort()}::uuid[]) ORDER BY id FOR UPDATE`;
      const link = await tx.supplierListingLink.findUniqueOrThrow({ where: { id: linkId }, include: { product: true } });
      if (link.deactivatedAt) throw Errors.notFound("Imported listing");
      assertEnvironment(link);
      const p = link.product;
      if (!link.reviewedAt || link.noindex) throw Errors.conflict("This listing is not marked reviewed");
      if (p.deletedAt || p.status !== "published") throw Errors.conflict("Publish this listing first; publishing retires the page it replaces");
      if (link.replacesProductId && link.replacesProductId !== oldProductId) throw Errors.conflict("This listing already replaces another page; restore that one first");
      const old = await tx.product.findUnique({ where: { id: oldProductId }, include: { listingLink: { select: { deactivatedAt: true } } } });
      if (!old) throw Errors.validation({ oldProductId: "The old listing does not exist" });
      if (old.listingLink && !old.listingLink.deactivatedAt) throw Errors.validation({ oldProductId: "That listing is itself an imported TravelDesk listing" });
      let mode: "retired" | "redirected";
      let references: string[] = [];
      let takeover: { linkId: string; title: string } | null = null;
      if (!old.deletedAt) {
        const check = await retireCheck(tx, old, p);
        if (check.kind === "stop") throw Errors.conflict(`${check.reason}: ${check.references.join(", ")} — repoint those first`, { references: check.references });
        if (check.kind === "keep") throw Errors.conflict(`Not retired: ${check.reason}`);
        ({ takeover } = await retireInTx(tx, actor, old, p, linkId, why));
        mode = "retired";
      } else {
        ({ references, takeover } = await redirectArchivedInTx(tx, actor, old, p, linkId, why));
        mode = "redirected";
      }
      if (!link.replacesProductId) await tx.supplierListingLink.update({ where: { id: linkId }, data: { replacesProductId: old.id } });
      return { listingId: p.id, oldId: old.id, oldSlug: old.slug, slug: p.slug, mode, references, releasedFrom: takeover?.title ?? null };
    }, TX_OPTIONS).catch((e: unknown) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw Errors.conflict("Another imported listing already replaces that old listing");
      throw e;
    });
    revalidateCatalog();
    await readinessService.reevaluateMany([out.listingId, out.oldId], "status_change");
    return out;
  },

  /** Move a published "<base>-<n>" listing to "<base>" (traveldesk-address.ts). */
  async moveToCleanAddress(actor: Actor, linkId: string, reason: string) {
    requirePermission(actor, "products.publish");
    requirePermission(actor, "products.delete");
    if (!actor.id) throw Errors.unauthorized();
    if (reason.trim().length < 8) throw Errors.validation({ reason: "Give a reason of at least 8 characters — it goes in the audit log" });
    const moved = await prisma.$transaction(async (tx) => {
      const link = await tx.supplierListingLink.findUnique({ where: { id: linkId }, select: { environment: true } });
      if (!link) throw Errors.notFound("Imported listing");
      assertEnvironment(link);
      return moveToCleanAddressInTx(tx, actor, linkId, reason);
    }, TX_OPTIONS).catch((e: unknown) => {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw Errors.conflict("Another listing took one of these addresses, or already replaces that old page, just now — reload and try again");
      throw e;
    });
    revalidateCatalog();
    await readinessService.reevaluateMany([moved.listingId], "editor_save");
    return moved;
  },

  /** Undo a move to the clean address: back to "<base>-<n>", the retired page gets "<base>" back. */
  async undoCleanAddress(actor: Actor, linkId: string, reason: string) {
    requirePermission(actor, "products.publish");
    requirePermission(actor, "products.delete");
    if (!actor.id) throw Errors.unauthorized();
    if (reason.trim().length < 8) throw Errors.validation({ reason: "Give a reason of at least 8 characters — it goes in the audit log" });
    const moved = await prisma.$transaction(async (tx) => {
      const link = await tx.supplierListingLink.findUnique({ where: { id: linkId }, select: { environment: true, deactivatedAt: true } });
      if (!link || link.deactivatedAt) throw Errors.notFound("Imported listing");
      assertEnvironment(link);
      return undoCleanAddressInTx(tx, actor, linkId, reason);
    }, TX_OPTIONS);
    if (!moved) throw Errors.conflict("This listing was not moved to a clean address");
    revalidateCatalog();
    await readinessService.reevaluateMany([moved.listingId], "editor_save");
    return moved;
  },

  /** The spreadsheet round trip for imported listings (D13): the import-compatible CSV of these listings only. */
  async exportCsv(actor: Actor, filters: { batchId?: string } = {}) {
    requirePermission(actor, "products.edit");
    const links = await prisma.supplierListingLink.findMany({ where: { deactivatedAt: null, ...(filters.batchId ? { importBatchId: filters.batchId } : {}) }, select: { productId: true } });
    return importService.exportCsv(actor, { productIds: links.map((l) => l.productId) });
  },
};

async function publishOne(actor: Actor, linkId: string, reason: string): Promise<PublishItemResult> {
  return prisma.$transaction(async (tx) => {
    const link = await tx.supplierListingLink.findUnique({ where: { id: linkId }, include: { product: true, replaces: true } });
    if (!link || link.deactivatedAt) return { linkId, outcome: "stopped", reason: "not an active imported listing" };
    if (!link.reviewedAt || link.noindex) return { linkId, outcome: "stopped", reason: "not marked reviewed" };
    assertEnvironment(link);
    const p = link.product;
    if (p.deletedAt) return { linkId, outcome: "stopped", reason: "listing deleted" };
    const doc = activitySchema.safeParse(p.content);
    if (!doc.success) return { linkId, outcome: "stopped", reason: "invalid document" };
    // Edits after review are checked again (N1-09).
    const missing = stillPending(doc.data);
    if (missing.length) return { linkId, outcome: "stopped", reason: `fill these first: ${missing.join(", ")}` };
    const same = await sharedCopy(tx, link, doc.data);
    if (same.length) return { linkId, outcome: "stopped", reason: `same title or subtitle as ${same.join(", ")}` };

    // References to the old slug stop the item until repointed (§3.9).
    const old = link.replaces;
    let retire = false;
    let notRetired: string | undefined;
    if (old && !old.deletedAt) {
      const check = await retireCheck(tx, old, p);
      if (check.kind === "stop") return { linkId, outcome: "stopped", reason: check.reason, references: check.references };
      if (check.kind === "keep") notRetired = check.reason;
      else retire = true;
    }

    if (p.status !== "published") {
      const version = p.version + 1;
      const written = await tx.product.updateMany({ where: { id: p.id, version: p.version, deletedAt: null }, data: { status: "published", version, publishedAt: p.publishedAt ?? new Date() } });
      if (written.count !== 1) throw Errors.conflict(`"${p.slug}" changed while it was being published — try again`);
      await tx.productVersion.create({ data: { id: uuidv7(), productId: p.id, version, content: { ...doc.data, fulfilmentMode: p.fulfilmentMode } as unknown as Prisma.InputJsonValue, status: "published", actorId: actor.id, reason } });
      await audit(actor, "activity.publish", { type: "product", id: p.id }, { before: { status: p.status }, after: { status: "published", linkId }, reason }, tx);
    }

    if (retire && old) await retireInTx(tx, actor, old, p, linkId, reason);
    return { linkId, outcome: "published", slug: p.slug, retired: retire && old ? old.slug : null, ...(notRetired ? { notRetired } : {}) };
  }, TX_OPTIONS);
}
