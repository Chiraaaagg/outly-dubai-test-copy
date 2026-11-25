import "server-only";
import { createHash } from "node:crypto";
import { Prisma, type SupplierEnvironment } from "@prisma/client";
import { dubaiToday } from "@/lib/utils";
import type { Activity } from "@/lib/types";
import { prisma, TX_OPTIONS, type Tx } from "../lib/db";
import type { Actor } from "../lib/actor";
import { requirePermission, SYSTEM_ACTOR } from "../lib/actor";
import { audit } from "../lib/audit";
import { env } from "../lib/env";
import { Errors, isAppError } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { log } from "../lib/logger";
import { revalidateCatalog } from "../lib/catalog-cache";
import { emitEvent } from "../lib/structured-events";
import { settingsRepo } from "../repositories/settings.repo";
import { activitySchema, type ActivityInput } from "../schemas/activity.schema";
import { RULE_TARGET_MARGIN_BPS } from "../domain/rule-price";
import { copyTourPhotos, type PhotoCopyDeps } from "../imports/photo-copy";
import { configuredPhotoCopier } from "../imports/photo-store";
import type { UpkeepDigestContext } from "../notifications/templates";
import { loadCapabilityGate } from "../suppliers/capability-gate";
import type { TourContentFaq, TourContentItineraryStep, TourContentPhoto } from "../suppliers/traveldesk/traveldesk.content";
import { buildListingDraft, EDITORIAL_FIELDS, personLocksBetween, type BuildContent } from "../suppliers/traveldesk/traveldesk.listing-build";
import { inquiryListing, instantListing, type PlanOffer, type PlanTourContent } from "../suppliers/traveldesk/traveldesk.listing-plan";
import { approvedSlotHoursHold, offerTermsHash, offerTermsOf, parseStoredOffer, type OfferTerms, type StoredOffer } from "../suppliers/traveldesk/traveldesk.offer-terms";
import {
  canHoldPrices,
  changedFields,
  classifyOptions,
  digestListings,
  inputOf,
  logValue,
  mergeDocument,
  applyPriceLocks,
  photosHashOf,
  PRICE_AUTO_LIMIT_BPS,
  priceMoveBps,
  priceTable,
  termsDiff,
  TOUR_CONTENT_KEEP_AFTER_REMOVAL_MS,
  unavailabilityStep,
  type OptionState,
  type PriceMode,
} from "../suppliers/traveldesk/traveldesk.upkeep";
import { activityService } from "./activity.service";
import { recordEditorialLocks } from "./listing-locks";
import { readinessService } from "./readiness.service";
import { lastCompleteSync, TRAVELDESK_SUPPLIER_CODE, travelDeskMappingRow } from "./supplier-catalog.service";
import { contentSummary, planOfferOf, readPlanRules } from "./traveldesk-dry-run.service";
import { LISTING_RULE_SETTING_KEY, listingRuleSchema } from "./traveldesk-import.service";

/**
 * Daily upkeep of imported TravelDesk listings, build N3 (doc 30 §3.10;
 * owner decisions D17, D18, D19; the pure rules are in
 * `traveldesk.upkeep.ts`).
 *
 * When: right after each COMPLETE catalogue sync, inside the same run and
 * lease (`traveldesk-catalogue-sync.service.ts`). It reads only what the sync
 * stored: no TravelDesk call, so it spends nothing of the shared read budget.
 * Photo copies (only when the supplier's photo list changed and the field is
 * not locked) go through the same checked copier as the importer, a few
 * tours per run and only while time is left.
 *
 * Which listings: active `supplier_listing_links` rows the importer CREATED
 * (`adopted = false`). Adopted pages were written by people before the
 * import and every other listing keeps today's rule: a changed offer reads
 * `changed` and sells as inquiry until a person re-approves (K3; parity
 * test). Nothing here touches orders, quotes or bookings: each order keeps
 * the terms of its own quote.
 *
 * Per listing, ONE transaction: the new document through
 * `activityService.update` (version row, `activity.update` audit; the
 * system actor), the mapping re-approvals (D17: hash and slot hours
 * re-recorded by the system, audit `supplier_mapping.auto_reapprove` naming
 * each changed term and listing fact with old and new value, the recorded
 * ticket answer kept, R8), mapping deactivations for removed offers, the
 * link's upkeep state, and the change rows the admin log and the digest
 * read. A save by a person in between makes the version guard refuse: the
 * listing is retried by the next run. A changed hash is re-recorded only
 * together with the facts that follow from it; when the facts cannot be
 * applied (no draft, the unit set changed under a held price) the mapping
 * stays `changed` and the listing sells as inquiry.
 *
 * Resumable: listings run oldest `upkeep_at` first and each is idempotent (an
 * unchanged supplier gives an unchanged document and no rows). A run stops
 * starting listings at its deadline; the next run continues.
 *
 * Digest (D17): one email per environment and Dubai day to `OWNER_ALERT_EMAIL`
 * (the N2 environment value, read here by name only), queued in the
 * transaction that marks the rows digested; sent after commit and otherwise
 * by the outbox sweep. No recipient: rows wait and the run logs it. The email
 * holds slugs, titles, kinds and field names: no text, no prices, no nets.
 *
 * Content retention (review 103 N0-13): a tour's `supplier_tour_content` row
 * is deleted 30 days after the catalogue stopped seeing the tour.
 */

export const UPKEEP_ACTION = "traveldesk_listing.upkeep";
const DIGEST_EVENT = "TRAVELDESK_UPKEEP_DIGEST";
/** Photo copies per run (network); the rest wait for the next run. */
const MAX_PHOTO_TOURS_PER_RUN = 3;
/** A photo copy starts only with at least this much time left before the deadline (review 108 N3-06)... */
const PHOTO_MIN_REMAINING_MS = 60_000;
/** ...and stops before the next photo once less than this is left (one fetch has a 15 s limit). */
const PHOTO_STOP_REMAINING_MS = 20_000;
/** Change rows per digest; the rest go in the next one. */
const DIGEST_MAX_ROWS = 2_000;
const REASON = "TravelDesk daily upkeep (doc 30 N3)";

export interface UpkeepOptions {
  supplierCode?: string;
  /** The catalogue sync run this upkeep follows (stored on every change row). */
  runId?: string | null;
  now?: () => Date;
  /** Epoch ms: no listing starts after it. */
  deadlineMs?: number;
  /** Photo copier; default the configured one (null: none configured, photos are not refreshed). */
  photos?: PhotoCopyDeps | null;
  /** Test seam: the digest recipient (default `OWNER_ALERT_EMAIL`). */
  recipient?: string | null;
}

export interface UpkeepResult {
  environment: SupplierEnvironment;
  links: number;
  processed: number;
  /** Listings whose document, mappings or state this run changed. */
  changed: number;
  reapproved: number;
  reviews: number;
  unavailable: number;
  hidden: number;
  skipped: { linkId: string; reason: string }[];
  incomplete: boolean;
  contentPurged: number;
  digest: "queued" | "none" | "no_recipient" | "already_sent" | "failed";
  touchedProductIds: string[];
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** The owner's address (`OWNER_ALERT_EMAIL`, the N2 contract), or null. Never an admin setting. */
export function ownerDigestRecipient(raw: string | undefined = env().OWNER_ALERT_EMAIL): string | null {
  const v = raw?.trim();
  return v && v.length <= 254 && EMAIL.test(v) ? v : null;
}

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex");
const photoList = (v: unknown): TourContentPhoto[] => (Array.isArray(v) ? (v as TourContentPhoto[]) : []);
/** JSON with object keys sorted at every level (key order of stored JSONB is not the code's). */
const canonical = (v: unknown): string =>
  JSON.stringify(v ?? null, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const asJson = (v: unknown) => (v === undefined ? Prisma.JsonNull : (JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue));

/* ------------------------------------------------------------------ shared run data */

interface CatalogueRow {
  kind: string;
  externalId: string;
  parentExternalId: string | null;
  name: string | null;
  bookingKind: string | null;
  isExternal: boolean;
  payload: unknown;
  firstSeenAt: Date;
  lastSeenAt: Date;
  removedAt: Date | null;
}

interface ContentRow {
  tourExternalId: string;
  name: string;
  salesDescription: string;
  terms: string;
  videoUrl: string | null;
  faq: unknown;
  itinerary: unknown;
  photos: unknown;
  warnings: string[];
  schemaVersion: number;
  contentHash: string;
}

interface RunData {
  supplier: { id: string; adapter: string };
  environment: SupplierEnvironment;
  now: Date;
  today: string;
  rules: Awaited<ReturnType<typeof readPlanRules>>["rules"];
  /** The recorded listing rule, when it agrees with the code's target; null: no automatic repricing. */
  rule: { version: number } | null;
  gate: Awaited<ReturnType<typeof loadCapabilityGate>>;
  lastComplete: Date | null;
  items: Map<string, CatalogueRow>;
  content: Map<string, ContentRow>;
  /** Offers linked by any active link of the environment. */
  linkedOffers: Set<string>;
  /** Active links per tour. */
  linksPerTour: Map<string, { id: string; createdAt: Date; adopted: boolean }[]>;
}

async function listingRule(): Promise<{ version: number } | null> {
  const parsed = listingRuleSchema.safeParse(await settingsRepo.get<unknown>(LISTING_RULE_SETTING_KEY, null));
  return parsed.success && parsed.data.targetBps === RULE_TARGET_MARGIN_BPS ? { version: parsed.data.version } : null;
}

async function loadRunData(code: string, environment: SupplierEnvironment, now: Date): Promise<{ data: RunData; links: { id: string }[] } | null> {
  const supplier = await prisma.supplier.findUnique({ where: { code }, select: { id: true, adapter: true } });
  if (!supplier) return null;
  const links = await prisma.supplierListingLink.findMany({
    where: { supplierId: supplier.id, environment, deactivatedAt: null },
    select: { id: true, tourExternalId: true, offerExternalIds: true, createdAt: true, upkeepAt: true, adopted: true },
    orderBy: [{ upkeepAt: { sort: "asc", nulls: "first" } }, { id: "asc" }],
  });
  const tours = [...new Set(links.map((l) => l.tourExternalId))];
  const [items, contents, { rules }, rule, lastComplete] = await Promise.all([
    prisma.supplierCatalogueItem.findMany({
      where: { supplierId: supplier.id, environment, OR: [{ kind: "tour", externalId: { in: tours } }, { kind: "offer", parentExternalId: { in: tours } }, { kind: "offer", externalId: { in: links.flatMap((l) => l.offerExternalIds) } }] },
      select: { kind: true, externalId: true, parentExternalId: true, name: true, bookingKind: true, isExternal: true, payload: true, firstSeenAt: true, lastSeenAt: true, removedAt: true },
    }),
    // The parsed fields only; never `raw` (review 103 N0-06).
    prisma.supplierTourContent.findMany({
      where: { supplierId: supplier.id, environment, tourExternalId: { in: tours } },
      select: { tourExternalId: true, name: true, salesDescription: true, terms: true, videoUrl: true, faq: true, itinerary: true, photos: true, warnings: true, schemaVersion: true, contentHash: true },
    }),
    readPlanRules(now),
    listingRule(),
    lastCompleteSync(code, environment),
  ]);
  const gate = await loadCapabilityGate(prisma, { adapter: supplier.adapter, supplierId: supplier.id, environment, offerExternalIds: items.filter((i) => i.kind === "offer").map((i) => i.externalId) });
  const linksPerTour = new Map<string, { id: string; createdAt: Date; adopted: boolean }[]>();
  for (const l of links) linksPerTour.set(l.tourExternalId, [...(linksPerTour.get(l.tourExternalId) ?? []), { id: l.id, createdAt: l.createdAt, adopted: l.adopted }]);
  return {
    links,
    data: {
      supplier,
      environment,
      now,
      today: dubaiToday(now),
      rules,
      rule,
      gate,
      lastComplete,
      items: new Map(items.map((i) => [`${i.kind}:${i.externalId}`, i])),
      content: new Map(contents.map((c) => [c.tourExternalId, c])),
      linkedOffers: new Set(links.flatMap((l) => l.offerExternalIds)),
      linksPerTour,
    },
  };
}

/* ------------------------------------------------------------------ change rows */

interface ChangeBase {
  linkId: string;
  productId: string;
  environment: SupplierEnvironment;
  runId: string | null;
}

interface ChangeRow {
  kind: string;
  field?: string;
  offerExternalId?: string | null;
  before?: unknown;
  after?: unknown;
  status: "applied" | "review" | "info";
}

async function writeChanges(tx: Tx, base: ChangeBase, rows: ChangeRow[], now: Date): Promise<number> {
  let reviews = 0;
  for (const r of rows) {
    const field = (r.field ?? "").slice(0, 80);
    const data = { offerExternalId: r.offerExternalId ?? null, before: asJson(r.before), after: asJson(r.after) };
    if (r.status === "review") {
      // One open review per listing, kind and field: a repeat updates it, and re-enters the digest only when it moved.
      const open = await tx.supplierListingChange.findFirst({ where: { linkId: base.linkId, kind: r.kind, field, status: "review" }, select: { id: true, after: true } });
      // A person already closed this exact item: not raised again until it changes.
      const closed = open ? null : await tx.supplierListingChange.findFirst({ where: { linkId: base.linkId, kind: r.kind, field, status: "resolved" }, orderBy: { resolvedAt: "desc" }, select: { after: true } });
      if (closed && JSON.stringify(closed.after ?? null) === JSON.stringify(r.after ?? null)) continue;
      if (open) {
        if (JSON.stringify(open.after ?? null) !== JSON.stringify(r.after ?? null)) {
          await tx.supplierListingChange.update({ where: { id: open.id }, data: { ...data, runId: base.runId, digestedAt: null, digestNotificationId: null, updatedAt: now } });
        }
        continue;
      }
      reviews += 1;
    }
    await tx.supplierListingChange.create({ data: { id: uuidv7(), ...base, kind: r.kind, field, status: r.status, ...data, createdAt: now, updatedAt: now } });
  }
  return reviews;
}

/* ------------------------------------------------------------------ one listing */

interface OneOptions {
  actor: Actor;
  allowPriceJump?: boolean;
  /** Resolve this review row (a person approved the price move) in the same transaction; `prices` are the ones the person saw. */
  resolve?: { changeId: string; note: string; prices: unknown };
  runId: string | null;
  photos: PhotoCopyDeps | null;
  photoBudget: { left: number; deadlineMs: number | undefined };
  /** Epoch ms, the run's own clock (the deadline is measured on it). */
  clock: () => number;
}

interface OneResult {
  outcome: "changed" | "unchanged" | "skipped";
  /** Whether the copied photos were written to the page (else their files are removed). */
  imagesUsed?: boolean;
  reason?: string;
  reapproved: number;
  reviews: number;
  unavailable: boolean;
  hidden: boolean;
  productId: string;
}

function buildContentOf(c: ContentRow | undefined): BuildContent | null {
  if (!c) return null;
  return { name: c.name, salesDescription: c.salesDescription, terms: c.terms, videoUrl: c.videoUrl, faq: (c.faq as TourContentFaq[]) ?? [], itinerary: (c.itinerary as TourContentItineraryStep[]) ?? [] };
}

/** Photos to copy for this listing before its transaction (network stays outside it). */
async function maybeCopyPhotos(
  link: { lockedFields: string[]; photosHash: string | null; importVersion: number; productId: string },
  content: ContentRow | undefined,
  doc: ActivityInput,
  opts: OneOptions,
  now: number,
): Promise<{ images: string[] | null; hash: string | null; keys: string[] }> {
  const none = (hash: string | null) => ({ images: null, hash, keys: [] as string[] });
  if (!content) return none(link.photosHash);
  const hash = photosHashOf(content.photos);
  // An N1 listing's copies were made from the photos stored at import: record that list as the starting point.
  // No hash yet: still placeholders (the importer's photo copy records the list it copied, review 108 N3-07), or a
  // link from before N3 whose copies were made from the photos stored at import.
  if (link.photosHash === null) return none(doc.images.every((i) => i.startsWith("img:")) ? null : hash);
  if (link.photosHash === hash) return none(hash);
  if (!opts.photos || opts.photoBudget.left <= 0) return none(link.photosHash);
  const deadline = opts.photoBudget.deadlineMs;
  if (deadline !== undefined && deadline - now < PHOTO_MIN_REMAINING_MS) return none(link.photosHash);
  const baseline = await prisma.productVersion.findUnique({ where: { productId_version: { productId: link.productId, version: link.importVersion } }, select: { content: true } });
  const baseImages = (baseline?.content as { images?: unknown } | null)?.images;
  if (link.lockedFields.includes("images") || JSON.stringify(baseImages ?? null) !== JSON.stringify(doc.images)) return none(hash);
  opts.photoBudget.left -= 1;
  const stopAt = deadline === undefined ? undefined : () => deadline - opts.clock() < PHOTO_STOP_REMAINING_MS;
  const r = await copyTourPhotos(photoList(content.photos), { ...opts.photos, stopAt });
  if (!r.urls.length) return none(link.photosHash);
  return { images: r.urls.slice(0, 12), hash, keys: r.keys };
}

async function upkeepOne(data: RunData, linkId: string, opts: OneOptions): Promise<OneResult> {
  const { now, environment } = data;
  const pre = await prisma.supplierListingLink.findUnique({ where: { id: linkId }, include: { product: { select: { id: true, version: true, content: true, deletedAt: true } } } });
  if (!pre || pre.deactivatedAt) return { outcome: "skipped", reason: "inactive", reapproved: 0, reviews: 0, unavailable: false, hidden: false, productId: pre?.productId ?? "" };
  const base: OneResult = { outcome: "unchanged", reapproved: 0, reviews: 0, unavailable: false, hidden: false, productId: pre.productId };
  if (pre.adopted) return { ...base, outcome: "skipped", reason: "adopted" };
  if (pre.product.deletedAt) return { ...base, outcome: "skipped", reason: "deleted" };
  const parsed = activitySchema.safeParse(pre.product.content);
  if (!parsed.success) return { ...base, outcome: "skipped", reason: "invalid_document" };
  const content = data.content.get(pre.tourExternalId);
  const photo = await maybeCopyPhotos(pre, content, inputOf(parsed.data), opts, opts.clock());
  // Review 108 N3-16: copied files nobody references are removed (skipped listing, failed transaction).
  const dropPhotos = async () => {
    if (photo.keys.length && opts.photos?.store.delete) await Promise.all(photo.keys.map((k) => opts.photos!.store.delete!(k).catch(() => {})));
  };
  let result: OneResult;
  try {
    result = await upkeepTx(data, linkId, pre, content, photo, opts, base);
  } catch (error) {
    await dropPhotos();
    throw error;
  }
  if (!result.imagesUsed) await dropPhotos();
  return result;
}

async function upkeepTx(
  data: RunData,
  linkId: string,
  pre: { productId: string; product: { version: number } },
  content: ContentRow | undefined,
  photo: { images: string[] | null; hash: string | null },
  opts: OneOptions,
  base: OneResult,
): Promise<OneResult> {
  const { now, environment } = data;
  return prisma.$transaction(async (tx) => {
    const link = await tx.supplierListingLink.findUnique({ where: { id: linkId } });
    const product = await tx.product.findUnique({ where: { id: pre.productId } });
    if (!link || link.deactivatedAt || !product || product.deletedAt) return { ...base, outcome: "skipped", reason: "inactive" } as OneResult;
    if (product.version !== pre.product.version) return { ...base, outcome: "skipped", reason: "edited_meanwhile" } as OneResult;
    const doc = activitySchema.parse(product.content) as Activity;
    const current = inputOf(doc);
    const cb: ChangeBase = { linkId, productId: product.id, environment, runId: opts.runId };
    const changes: ChangeRow[] = [];
    const tour = data.items.get(`tour:${link.tourExternalId}`);
    const tourLive = Boolean(tour && !tour.removedAt);
    const offerRow = (id: string) => data.items.get(`offer:${id}`);
    const offerGone = (id: string) => {
      const o = offerRow(id);
      return !o || Boolean(o.removedAt) || o.parentExternalId !== link.tourExternalId;
    };
    // Review 108 N3-09: an option the upkeep sold out (still sold out on the page) sells nothing either.
    const systemSoldOut = (id: string) => link.soldOutOfferIds.includes(id) && current.variants.find((v) => v.id === `td-${id}`)?.soldOut === true;
    const gone = !tourLive || link.offerExternalIds.every((id) => offerGone(id) || systemSoldOut(id));
    // Review 108 N3-04 (b): an approval must reach the price step, or nothing was applied.
    const refuseResolve = () => {
      if (opts.resolve) throw Errors.conflict("Nothing was applied: the listing is hidden or its tour is gone. The review stays open");
    };

    // Review 108 N3-05: a hidden listing a person published again is upkept again (its state is cleared, audited).
    let resumed = false;
    if (link.hiddenAt && product.status === "published") {
      await tx.supplierListingLink.update({ where: { id: link.id }, data: { hiddenAt: null, unavailableSince: null } });
      await tx.supplierListingChange.updateMany({ where: { linkId, kind: "returned_after_hidden", status: "review" }, data: { status: "resolved", resolution: "superseded", resolvedAt: now, updatedAt: now } });
      await audit(opts.actor, UPKEEP_ACTION, { type: "product", id: product.id }, { before: { hiddenAt: link.hiddenAt.toISOString() }, after: { linkId, step: "resumed", runId: opts.runId } }, tx);
      changes.push({ kind: "resumed", status: "applied", before: { hiddenAt: link.hiddenAt.toISOString() }, after: { status: "published" } });
      link.hiddenAt = null;
      link.unavailableSince = null;
      resumed = true;
    }

    // D19: a hidden listing stays hidden; its tour coming back is for a person.
    if (link.hiddenAt) {
      refuseResolve();
      if (!gone) {
        const reviews = await writeChanges(tx, cb, [{ kind: "returned_after_hidden", status: "review", after: { tour: link.tourExternalId } }], now);
        if (reviews) await tx.supplierListingLink.update({ where: { id: link.id }, data: { upkeepAt: now } });
        return { ...base, reviews } as OneResult;
      }
      await tx.supplierListingLink.update({ where: { id: link.id }, data: { upkeepAt: now } });
      return base;
    }
    const step = unavailabilityStep(link, gone, now);
    if (step === "mark" || step === "hide" || gone) refuseResolve();
    if (step === "mark") {
      if (changes.length) await writeChanges(tx, cb, changes, now);
      await tx.supplierListingLink.update({ where: { id: link.id }, data: { unavailableSince: now, upkeepAt: now } });
      await writeChanges(tx, cb, [{ kind: "unavailable", status: "applied", after: { since: now.toISOString(), tourRemoved: !tourLive } }], now);
      await audit(opts.actor, UPKEEP_ACTION, { type: "product", id: product.id }, { after: { linkId, step: "unavailable", runId: opts.runId } }, tx);
      return { ...base, outcome: "changed", unavailable: true } as OneResult;
    }
    if (step === "hide") {
      if (product.status === "published") {
        const version = product.version + 1;
        const written = await tx.product.updateMany({ where: { id: product.id, version: product.version, deletedAt: null }, data: { status: "draft", version } });
        if (written.count !== 1) return { ...base, outcome: "skipped", reason: "edited_meanwhile" } as OneResult;
        await tx.productVersion.create({ data: { id: uuidv7(), productId: product.id, version, content: { ...doc, fulfilmentMode: product.fulfilmentMode } as unknown as Prisma.InputJsonValue, status: "draft", actorId: opts.actor.id, reason: `${REASON}: hidden after 14 days unavailable` } });
        await audit(opts.actor, "activity.unpublish", { type: "product", id: product.id }, { before: { status: "published" }, after: { status: "draft", linkId, reason: "traveldesk_tour_gone_14_days" }, reason: REASON }, tx);
        await tx.supplierListingLink.update({ where: { id: link.id }, data: { hiddenAt: now, upkeepAt: now } });
        await recordEditorialLocks(tx, product.id, { systemFields: [], rebase: true });
      } else {
        await tx.supplierListingLink.update({ where: { id: link.id }, data: { hiddenAt: now, upkeepAt: now } });
      }
      await writeChanges(tx, cb, [{ kind: "hidden", status: "applied", before: { status: product.status }, after: { status: product.status === "published" ? "draft" : product.status, unavailableSince: link.unavailableSince?.toISOString() } }], now);
      return { ...base, outcome: "changed", hidden: true } as OneResult;
    }
    if (gone) {
      await tx.supplierListingLink.update({ where: { id: link.id }, data: { upkeepAt: now } });
      return base;
    }
    let stateChanged = resumed;
    if (step === "clear") {
      changes.push({ kind: "available_again", status: "applied", before: { since: link.unavailableSince?.toISOString() } });
      stateChanged = true;
    }

    const baseline = ((await tx.productVersion.findUnique({ where: { productId_version: { productId: product.id, version: link.importVersion } }, select: { content: true } }))?.content as Record<string, unknown> | null) ?? null;

    // Options.
    const mappings = await tx.productSupplierMapping.findMany({ where: { productId: product.id, supplierId: data.supplier.id, environment } });
    const planOf = new Map<number, PlanOffer>();
    const storedOf = new Map<number, StoredOffer>();
    const states: OptionState[] = link.offerExternalIds.map((id) => {
      const variantId = `td-${id}`;
      const v = current.variants.find((x) => x.id === variantId);
      const row = offerRow(id);
      const removed = offerGone(id);
      let plan: PlanOffer | null = null;
      if (!removed && row && tour) {
        plan = planOfferOf(row, tour, { gate: data.gate, today: data.today, at: now, lastComplete: data.lastComplete, activeLinks: [], suggestions: [] });
        planOf.set(Number(id), plan);
        const st = parseStoredOffer(row.payload);
        if (st) storedOf.set(Number(id), st);
      }
      return {
        offerId: Number(id),
        variantId,
        inDoc: Boolean(v),
        soldOutInDoc: v?.soldOut === true,
        removed,
        classKey: plan ? plan.classKey : null,
        dimensions: plan ? { arrival: plan.dimensions.arrival, route: plan.dimensions.route, fulfilment: plan.dimensions.fulfilment } : null,
        startMinutes: plan ? plan.startMinutes : null,
      };
    });
    const cls = classifyOptions(link, states);
    const soldOut = new Set<string>();
    const soldOutIds = new Set(link.soldOutOfferIds);
    const deactivate: string[] = [];
    for (const v of cls.verdicts) {
      const m = mappings.find((x) => x.variantCode === v.variantId && x.supplierOfferId === String(v.offerId));
      const st = states.find((s) => s.offerId === v.offerId)!;
      if (v.verdict === "removed") {
        if (st.inDoc && !st.soldOutInDoc) soldOut.add(v.variantId);
        if (m?.isActive) deactivate.push(m.id);
        if ((st.inDoc && !st.soldOutInDoc) || m?.isActive) changes.push({ kind: "offer_removed", field: v.variantId, offerExternalId: String(v.offerId), status: "applied", after: { soldOut: true, mappingDeactivated: Boolean(m?.isActive) } });
        soldOutIds.add(String(v.offerId));
      } else if (v.verdict === "diverged" || v.verdict === "never_instant") {
        soldOut.add(v.variantId);
        soldOutIds.add(String(v.offerId));
        const p = planOf.get(v.offerId);
        changes.push({ kind: v.verdict, field: v.variantId, offerExternalId: String(v.offerId), status: "review", after: { soldOut: true, reason: v.reason, classKey: p?.classKey ?? null, startMinutes: p?.startMinutes ?? null } });
      } else if (v.verdict === "inactive" && soldOutIds.has(String(v.offerId)) && !st.removed && m && !m.isActive) {
        changes.push({ kind: "offer_revived", field: v.variantId, offerExternalId: String(v.offerId), status: "review", after: { offer: String(v.offerId) } });
      }
    }
    const kept = new Set(cls.kept.map((id) => `td-${id}`));

    // The fresh draft for the kept options: the same plan and builder as the importer (same rules, same prices).
    let draft: ActivityInput | null = null;
    const keptPlans = cls.kept.map((id) => planOf.get(id)).filter((p): p is PlanOffer => Boolean(p));
    if (keptPlans.length) {
      const contentMap = new Map<number, PlanTourContent>(content ? [[Number(link.tourExternalId), contentSummary(content)]] : []);
      const planned =
        link.kind === "instant"
          ? instantListing(Number(link.tourExternalId), cls.signature.classKey ?? link.classKey!, link.splitNumber, keptPlans, data.rules, contentMap)
          : inquiryListing(Number(link.tourExternalId), "S0", link.arrival, link.fulfilment, keptPlans, data.rules, contentMap);
      const built = buildListingDraft(planned, storedOf, buildContentOf(content), {
        supplier: { name: current.supplier.name, reliability: current.supplier.reliability, verifiedSince: current.supplier.verifiedSince },
        categorySlug: current.categorySlug,
        images: current.images,
        takenSlugs: new Set(),
        siblingCount: data.linksPerTour.get(link.tourExternalId)?.length ?? 1,
        relatedSlugs: current.relatedSlugs,
      });
      if (built.ok) draft = built.input;
      else changes.push({ kind: "reprice_blocked", status: "review", after: { reasons: built.reasons.filter((r) => !r.startsWith("invalid:")).slice(0, 12) } });
    }

    // D18: price.
    let priceMode: PriceMode = "keep";
    const lockedNow = new Set([...link.lockedFields, ...(baseline ? personLocksBetween(baseline, current as unknown as Record<string, unknown>) : [])]);
    if (draft) {
      // §3.7 (review 108 N3-14): a price a person raised is never lowered; when no consistent page price fits, hold.
      const lockedDraft = applyPriceLocks(current, draft, lockedNow, kept);
      if (!lockedDraft) {
        priceMode = canHoldPrices(current, draft, kept) ? "hold" : "keep";
        changes.push({ kind: "reprice_blocked", field: "price_lock", status: "review", after: { reason: "price_raised_by_a_person_does_not_fit_the_rule_band" } });
      }
      draft = lockedDraft ?? draft;
    }
    if (draft && !changes.some((c) => c.field === "price_lock")) {
      const move = priceMoveBps(current, draft, kept);
      const auto = data.rule !== null && (move <= PRICE_AUTO_LIMIT_BPS || opts.allowPriceJump === true);
      priceMode = auto ? "apply" : canHoldPrices(current, draft, kept) ? "hold" : "keep";
      if (data.rule === null) changes.push({ kind: "reprice_blocked", field: "rule", status: "review", after: { reason: "listing_rule_missing" } });
      else if (!auto) {
        const before = priceTable(current);
        const after = priceTable(draft);
        changes.push({ kind: "price_jump", status: "review", before: Object.fromEntries([...kept].map((k) => [k, before[k]])), after: { prices: Object.fromEntries([...kept].map((k) => [k, after[k]])), moveBps: Number.isFinite(move) ? move : null } });
      }
    }
    if (opts.resolve) {
      if (priceMode !== "apply" || !draft) throw Errors.conflict("This price change cannot be applied now (no draft, no recorded listing rule, or a price a person raised); the listing keeps its prices");
      // Review 108 N3-04 (a): only the prices the person reviewed.
      const table = priceTable(draft);
      const fresh = Object.fromEntries([...kept].map((k) => [k, table[k]]));
      const seen = (opts.resolve.prices as Record<string, unknown> | null) ?? {};
      if (canonical(fresh) !== canonical(seen)) {
        throw Errors.conflict("The prices moved since this review was raised; reload the log and review the new figures");
      }
    }

    const textChanged = Boolean(content && content.contentHash !== link.contentHash);
    const merged = mergeDocument({
      current,
      baseline,
      prevTextHashes: (link.supplierTextHashes as Record<string, string> | null) ?? {},
      draft,
      lockedFields: link.lockedFields,
      textChanged,
      kept,
      soldOut,
      supplierPolicyHours: planOf.get(cls.kept[0])?.freeCancellationHours ?? null,
      priceMode,
      images: photo.images,
    });
    for (const f of merged.lockedTextChanged) changes.push({ kind: "locked_text_changed", field: f, status: "info" });

    // D17: re-approve changed terms of kept options, only together with the facts that follow from them.
    const factsApplied = Boolean(draft) && priceMode !== "keep";
    const approvedTerms = { ...((link.approvedTerms as Record<string, OfferTerms> | null) ?? {}) };
    const listingFacts = changedFields(current, merged.next).filter((c) => c.kind !== "text" && c.kind !== "photos");
    const factDiff = listingFacts.map((c) => ({ field: `listing.${c.field}`, before: logValue(c.field, current), after: logValue(c.field, merged.next) }));
    let reapproved = 0;
    for (const id of cls.kept) {
      const sid = String(id);
      const m = mappings.find((x) => x.variantCode === `td-${id}` && x.supplierOfferId === sid);
      const row = offerRow(sid);
      if (!m || !m.isActive || !row || !tour) continue;
      const hash = offerTermsHash(row.payload, tour.payload);
      const terms = offerTermsOf(row.payload, tour.payload);
      const drifted = m.syncStatus !== "ok" || m.approvedOfferHash !== hash || !approvedSlotHoursHold(row.payload, m.approvedSlotHours);
      if (!drifted) {
        if (terms && !approvedTerms[sid]) approvedTerms[sid] = terms;
        continue;
      }
      if (!factsApplied || !hash || !terms) continue;
      const next = travelDeskMappingRow(row, { externalId: tour.externalId, payload: tour.payload }, environment, m.externalRef);
      await tx.productSupplierMapping.update({ where: { id: m.id }, data: next.mappingData });
      const fields = [...termsDiff(approvedTerms[sid] ?? null, terms), ...factDiff];
      await audit(
        opts.actor,
        "supplier_mapping.auto_reapprove",
        { type: "product", id: product.id },
        {
          before: { mappingId: m.id, approvedOfferHash: m.approvedOfferHash, approvedSlotHours: m.approvedSlotHours, syncStatus: m.syncStatus },
          after: { mappingId: m.id, offerExternalId: sid, approvedOfferHash: next.approvedOfferHash, approvedSlotHours: next.approvedSlotHours, fields, ticketAnswerKept: Boolean((next.externalRef as { ticketEvidence?: unknown }).ticketEvidence), source: "upkeep", runId: opts.runId },
          reason: opts.resolve ? opts.resolve.note : REASON,
        },
        tx,
      );
      changes.push({ kind: "terms", field: `td-${id}`, offerExternalId: sid, status: "applied", before: { approvedOfferHash: m.approvedOfferHash }, after: { approvedOfferHash: next.approvedOfferHash, fields } });
      approvedTerms[sid] = terms;
      reapproved += 1;
    }
    for (const mid of deactivate) {
      await tx.productSupplierMapping.update({ where: { id: mid }, data: { isActive: false } });
      await audit(opts.actor, "supplier_mapping.deactivate", { type: "product", id: product.id }, { after: { mappingId: mid, reason: "offer_removed_upstream", runId: opts.runId } }, tx);
    }

    // New offers on the tour are never added by themselves (K9): listed once, on the tour's first listing.
    // The tour's first listing the upkeep processes (adopted ones are skipped; review 108 N3-08).
    const first = data.linksPerTour.get(link.tourExternalId)?.filter((l) => !l.adopted).sort((a, b) => (a.id < b.id ? -1 : 1))[0];
    if (first?.id === link.id) {
      for (const o of data.items.values()) {
        if (o.kind !== "offer" || o.parentExternalId !== link.tourExternalId || o.removedAt || data.linkedOffers.has(o.externalId)) continue;
        if (o.firstSeenAt.getTime() <= link.createdAt.getTime()) continue;
        changes.push({ kind: "new_offer", field: o.externalId, offerExternalId: o.externalId, status: "review", after: { offer: o.externalId, bookingKind: o.bookingKind } });
      }
    }

    // The document, through the activity service (version row, audit).
    const docChanged = JSON.stringify(current) !== JSON.stringify(merged.next);
    let version = link.importVersion;
    if (docChanged) {
      // N1's rule: a system write passes the editorial fields it wrote and moves the lock baseline to its own version.
      // The upkeep never writes a locked field, so a person's edits stay locked and nothing it wrote is locked.
      const systemFields = personLocksBetween(current as unknown as Record<string, unknown>, merged.next as unknown as Record<string, unknown>);
      const row = await activityService.update(opts.actor, product.id, merged.next, { tx, expectedVersion: product.version, reason: opts.resolve ? `${REASON}: price change approved` : REASON, locks: { systemFields, rebase: true } });
      version = row.version;
      for (const c of changedFields(current, merged.next)) changes.push({ kind: c.kind, field: c.field, status: "applied", before: logValue(c.field, current), after: logValue(c.field, merged.next) });
    }

    // With a document write the locks and the baseline were recorded by `recordEditorialLocks` above; without one, the
    // locks this run found are stored here.
    const linkData: Prisma.SupplierListingLinkUpdateInput = {
      upkeepAt: now,
      ...(docChanged ? {} : { lockedFields: merged.locked.slice(0, 60) }),
      soldOutOfferIds: [...soldOutIds].slice(0, 12),
      approvedTerms: asJson(approvedTerms) as Prisma.InputJsonValue,
      photosHash: photo.hash,
      ...(merged.textHashes ? { supplierTextHashes: merged.textHashes } : {}),
      ...(step === "clear" ? { unavailableSince: null } : {}),
      ...(draft && content ? { contentHash: content.contentHash } : {}),
      ...(factsApplied && link.kind === "instant" && cls.kept.length ? { classKey: cls.signature.classKey, startMinutes: cls.signature.startMinutes } : {}),
      ...(priceMode === "apply" && data.rule ? { pricingRuleVersion: data.rule.version } : {}),
    };
    await tx.supplierListingLink.update({ where: { id: link.id }, data: linkData });
    const reviews = await writeChanges(tx, cb, changes, now);
    // Review 108 N3-15: price reviews whose condition went away this run are closed as superseded.
    if (draft) {
      const raised = new Set(changes.filter((c) => c.status === "review").map((c) => `${c.kind}|${c.field ?? ""}`));
      const stale = (await tx.supplierListingChange.findMany({ where: { linkId, status: "review", kind: { in: ["price_jump", "reprice_blocked"] } }, select: { id: true, kind: true, field: true } })).filter((r) => !raised.has(`${r.kind}|${r.field}`) && r.id !== opts.resolve?.changeId);
      if (stale.length) await tx.supplierListingChange.updateMany({ where: { id: { in: stale.map((r) => r.id) } }, data: { status: "resolved", resolution: "superseded", resolvedAt: now, updatedAt: now } });
    }
    if (opts.resolve) {
      const done = await tx.supplierListingChange.updateMany({ where: { id: opts.resolve.changeId, status: "review" }, data: { status: "resolved", resolution: "applied", resolvedAt: now, resolvedBy: opts.actor.id ?? null, updatedAt: now } });
      if (done.count !== 1) throw Errors.conflict("This review was already resolved");
    }
    const any = docChanged || reapproved > 0 || deactivate.length > 0 || stateChanged || changes.some((c) => c.status === "applied");
    if (any) await audit(opts.actor, UPKEEP_ACTION, { type: "product", id: product.id }, { after: { linkId, runId: opts.runId, version, reapproved, soldOut: [...soldOut], priceMode, kinds: [...new Set(changes.map((c) => c.kind))] } }, tx);
    return { ...base, outcome: any ? "changed" : "unchanged", reapproved, reviews, imagesUsed: Boolean(photo.images && docChanged && JSON.stringify(merged.next.images) === JSON.stringify(photo.images)) } as OneResult;
  }, { maxWait: 10_000, timeout: 60_000 });
}

/* ------------------------------------------------------------------ digest */

async function queueDigest(supplier: { id: string; code: string }, environment: SupplierEnvironment, now: Date, recipient: string | null): Promise<UpkeepResult["digest"]> {
  const scope = { environment, digestedAt: null, link: { supplierId: supplier.id } };
  if (!recipient) {
    const waiting = await prisma.supplierListingChange.count({ where: scope });
    if (waiting) log.warn("traveldesk_upkeep.digest_no_recipient", { environment, waiting });
    return waiting ? "no_recipient" : "none";
  }
  const day = dubaiToday(now);
  const dedupKey = `td_upkeep_digest:${supplier.code}:${environment}:${day}`;
  let id: string | null = null;
  try {
    id = await prisma.$transaction(async (tx) => {
      if (await tx.notification.findUnique({ where: { dedupKey }, select: { id: true } })) return "already";
      const rows = await tx.supplierListingChange.findMany({
        where: scope,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: DIGEST_MAX_ROWS,
        select: { id: true, kind: true, field: true, status: true, offerExternalId: true, product: { select: { slug: true, title: true } } },
      });
      if (!rows.length) return null;
      const grouped = digestListings(rows.map((r) => ({ slug: r.product.slug, title: r.product.title, kind: r.kind, field: r.field, status: r.status, offerExternalId: r.offerExternalId })));
      const context: UpkeepDigestContext = {
        environment,
        day,
        changeCount: rows.length,
        reviewCount: rows.filter((r) => r.status === "review").length,
        listings: grouped.listings,
        moreListings: grouped.more,
        adminUrl: `${env().NEXT_PUBLIC_SITE_URL.replace(/\/+$/, "")}/admin/suppliers/traveldesk/changes`,
      };
      const nid = uuidv7();
      await tx.notification.create({
        data: { id: nid, event: DIGEST_EVENT, channel: "email", recipient, payload: context as unknown as Prisma.InputJsonValue, status: "queued", attempt: 1, lockedUntil: null, dedupKey, createdAt: now },
      });
      await tx.supplierListingChange.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { digestedAt: now, digestNotificationId: nid } });
      return nid;
    }, TX_OPTIONS);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "already_sent";
    log.warn("traveldesk_upkeep.digest_failed", { environment, error: error instanceof Error ? error.name : "error" });
    return "failed";
  }
  if (id === "already") return "already_sent";
  if (!id) return "none";
  try {
    const { notificationService } = await import("./notification.service");
    await notificationService.retryFailed(1, now, { ids: [id] });
  } catch {
    emitEvent("notification.failed", { notificationId: id, event: DIGEST_EVENT, channel: "email", reason: "upkeep_digest_send_threw" }, "error");
  }
  return "queued";
}

/* ------------------------------------------------------------------ retention */

async function purgeRemovedTourContent(supplierId: string, environment: SupplierEnvironment, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - TOUR_CONTENT_KEEP_AFTER_REMOVAL_MS);
  // Only tours that still have a content row, oldest removal first (review 108 N3-12): a backlog drains run by run.
  return prisma.$executeRaw`
    DELETE FROM "supplier_tour_content" WHERE "id" IN (
      SELECT c."id" FROM "supplier_tour_content" c
      JOIN "supplier_catalogue_items" i ON i."supplier_id" = c."supplier_id" AND i."environment" = c."environment" AND i."kind" = 'tour' AND i."external_id" = c."tour_external_id"
      WHERE c."supplier_id" = ${supplierId}::uuid AND c."environment" = ${environment}::"supplier_environment"
        AND i."removed_at" < ${cutoff} AND i."last_seen_at" < ${cutoff}
      ORDER BY i."removed_at" ASC LIMIT 500)`;
}

/* ------------------------------------------------------------------ service */

function emptyResult(environment: SupplierEnvironment): UpkeepResult {
  return { environment, links: 0, processed: 0, changed: 0, reapproved: 0, reviews: 0, unavailable: 0, hidden: 0, skipped: [], incomplete: false, contentPurged: 0, digest: "none", touchedProductIds: [] };
}

export const traveldeskUpkeepService = {
  /**
   * The run after a complete catalogue sync (system actor). Never throws:
   * a failed listing is skipped and reported, and the run goes on.
   */
  async run(environment: SupplierEnvironment, opts: UpkeepOptions = {}): Promise<UpkeepResult> {
    const now = (opts.now ?? (() => new Date()))();
    const code = opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
    const result = emptyResult(environment);
    let loaded: Awaited<ReturnType<typeof loadRunData>>;
    try {
      loaded = await loadRunData(code, environment, now);
    } catch (error) {
      log.warn("traveldesk_upkeep.load_failed", { environment, error: error instanceof Error ? error.name : "error" });
      result.incomplete = true;
      return result;
    }
    if (!loaded) return result;
    const { data, links } = loaded;
    result.links = links.length;
    const photos = opts.photos === undefined ? configuredPhotoCopier() : opts.photos;
    const clock = () => (opts.now ? opts.now().getTime() : Date.now());
    const one: OneOptions = { actor: SYSTEM_ACTOR, runId: opts.runId ?? null, photos, photoBudget: { left: MAX_PHOTO_TOURS_PER_RUN, deadlineMs: opts.deadlineMs }, clock };
    const touched = new Set<string>();
    for (const l of links) {
      if (opts.deadlineMs !== undefined && clock() >= opts.deadlineMs) {
        result.incomplete = true;
        break;
      }
      try {
        // Claimed before the work (review 108 N3-06): a listing the platform kills mid-way is not first in line forever.
        await prisma.supplierListingLink.updateMany({ where: { id: l.id }, data: { upkeepAt: now } });
        const r = await upkeepOne(data, l.id, one);
        result.processed += 1;
        if (r.outcome === "skipped") {
          if (r.reason !== "adopted") result.skipped.push({ linkId: l.id, reason: r.reason ?? "skipped" });
          continue;
        }
        if (r.outcome === "changed") {
          result.changed += 1;
          touched.add(r.productId);
        }
        result.reapproved += r.reapproved;
        result.reviews += r.reviews;
        if (r.unavailable) result.unavailable += 1;
        if (r.hidden) result.hidden += 1;
      } catch (error) {
        result.processed += 1;
        result.skipped.push({ linkId: l.id, reason: isAppError(error) ? error.code.toLowerCase() : "error" });
        log.warn("traveldesk_upkeep.listing_failed", { linkId: l.id, error: error instanceof Error ? error.name : "error" });
      }
    }
    result.touchedProductIds = [...touched];
    if (touched.size) {
      revalidateCatalog();
      try {
        await readinessService.reevaluateMany(result.touchedProductIds, "sync");
      } catch (error) {
        log.warn("traveldesk_upkeep.readiness_failed", { products: touched.size, error: error instanceof Error ? error.name : "error" });
      }
    }
    try {
      result.contentPurged = await purgeRemovedTourContent(data.supplier.id, environment, now);
    } catch (error) {
      log.warn("traveldesk_upkeep.content_purge_failed", { environment, error: error instanceof Error ? error.name : "error" });
    }
    result.digest = await queueDigest({ id: data.supplier.id, code }, environment, now, opts.recipient !== undefined ? opts.recipient : ownerDigestRecipient());
    return result;
  },

  /** The admin "supplier changes" log: newest first, filterable by listing and status. Sell prices and facts only. */
  async changes(actor: Actor, filters: { environment?: SupplierEnvironment; productId?: string; status?: "applied" | "review" | "resolved" | "info"; take?: number } = {}) {
    requirePermission(actor, "products.edit");
    return prisma.supplierListingChange.findMany({
      where: { ...(filters.environment ? { environment: filters.environment } : {}), ...(filters.productId ? { productId: filters.productId } : {}), ...(filters.status ? { status: filters.status } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Math.min(Math.max(filters.take ?? 200, 1), 500),
      include: { product: { select: { id: true, slug: true, title: true, status: true } } },
    });
  },

  /**
   * A person approves a price move above 20% (D18): the listing is brought up
   * to date now with the move allowed, and the review is resolved in the same
   * transaction, only if the prices are still the ones the review showed.
   * Never below the floor: the draft builder refuses such a price.
   */
  async approvePriceChange(actor: Actor, changeId: string, note: string) {
    requirePermission(actor, "products.edit");
    // Review 108 N3-20: price decisions are `pricing.edit` (the catalogue's pricing permission).
    requirePermission(actor, "pricing.edit");
    if (!actor.id) throw Errors.unauthorized();
    if (note.trim().length < 8) throw Errors.validation({ note: "Give a reason of at least 8 characters — it goes in the audit log" });
    const change = await prisma.supplierListingChange.findUnique({ where: { id: changeId }, include: { link: { select: { supplier: { select: { code: true } } } } } });
    if (!change || change.kind !== "price_jump" || change.status !== "review") throw Errors.notFound("Open price review");
    const loaded = await loadRunData(change.link.supplier.code, change.environment, new Date());
    if (!loaded) throw Errors.conflict("The TravelDesk supplier is missing");
    const r = await upkeepOne(loaded.data, change.linkId, { actor, allowPriceJump: true, resolve: { changeId, note: note.trim(), prices: (change.after as { prices?: unknown } | null)?.prices ?? null }, runId: null, photos: null, photoBudget: { left: 0, deadlineMs: undefined }, clock: Date.now });
    if (r.outcome === "skipped") throw Errors.conflict(`The listing could not be updated now (${r.reason}); try again`);
    revalidateCatalog();
    await readinessService.reevaluateMany([r.productId], "sync");
    return { productId: r.productId, reapproved: r.reapproved };
  },

  /** Close a review without applying anything (the person handled it, e.g. in the editor). */
  async dismissReview(actor: Actor, changeId: string, note: string) {
    requirePermission(actor, "products.edit");
    if (!actor.id) throw Errors.unauthorized();
    if (note.trim().length < 8) throw Errors.validation({ note: "Give a reason of at least 8 characters — it goes in the audit log" });
    return prisma.$transaction(async (tx) => {
      const now = new Date();
      const done = await tx.supplierListingChange.updateMany({ where: { id: changeId, status: "review" }, data: { status: "resolved", resolution: "dismissed", resolvedAt: now, resolvedBy: actor.id, updatedAt: now } });
      if (done.count !== 1) throw Errors.notFound("Open review");
      const row = await tx.supplierListingChange.findUniqueOrThrow({ where: { id: changeId }, select: { productId: true, kind: true, field: true } });
      await audit(actor, "traveldesk_listing.review_dismiss", { type: "product", id: row.productId }, { after: { changeId, kind: row.kind, field: row.field }, reason: note.trim() }, tx);
      return { changeId };
    }, TX_OPTIONS);
  },
};

/** Fields the upkeep may write from supplier text (re-exported for the admin page). */
export const UPKEEP_EDITORIAL_FIELDS = EDITORIAL_FIELDS;
