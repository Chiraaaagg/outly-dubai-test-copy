import "server-only";
import { Prisma, type SupplierEnvironment } from "@prisma/client";
import { z } from "zod";
import { prisma, TX_OPTIONS, type Tx } from "../lib/db";
import type { Actor } from "../lib/actor";
import { requirePermission } from "../lib/actor";
import { audit } from "../lib/audit";
import { Errors } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { log } from "../lib/logger";
import { revalidateCatalog } from "../lib/catalog-cache";
import { settingsRepo } from "../repositories/settings.repo";
import { activityInputSchema, activitySchema, type ActivityInput } from "../schemas/activity.schema";
import { RULE_TARGET_MARGIN_BPS } from "../domain/rule-price";
import { copyTourPhotos, type PhotoCopyDeps } from "../imports/photo-copy";
import { configuredPhotoCopier } from "../imports/photo-store";
import type { TourContentFaq, TourContentItineraryStep, TourContentPhoto } from "../suppliers/traveldesk/traveldesk.content";
import { buildListingDraft, EDITORIAL_FIELDS, type BuildContent, type PendingField } from "../suppliers/traveldesk/traveldesk.listing-build";
import { PLAN_STEPS, type PlannedListing, type PlanStepId } from "../suppliers/traveldesk/traveldesk.listing-plan";
import { offerTermsHash, offerTermsOf, parseStoredOffer, type StoredOffer } from "../suppliers/traveldesk/traveldesk.offer-terms";
import { photosHashOf } from "../suppliers/traveldesk/traveldesk.upkeep";
import { categoryFor } from "../suppliers/traveldesk/traveldesk.text-rules";
import { productLifecycle, activityService } from "./activity.service";
import { readinessService } from "./readiness.service";
import { recordEditorialLocks } from "./listing-locks";
import { lockOfferLinks, TRAVELDESK_SUPPLIER_CODE, travelDeskMappingRow } from "./supplier-catalog.service";
import { traveldeskDryRunService } from "./traveldesk-dry-run.service";

/**
 * TravelDesk importer, build N1 (doc 30 §2 step 2, §3.3–§3.5, §3.8, §5).
 *
 *   preview   One offer type (step S0–S5) at a time: the dry-run plan for the
 *             step (same rules, same prices), each listing built into a draft
 *             activity document (`buildListingDraft`) and stored on an
 *             `import_batches` row (source `traveldesk`). Nothing touches
 *             products. Inquiry listings (D4) come with their tour's first
 *             instant step; listings already imported, and offers already
 *             linked anywhere, are skipped and reported; the 3 already-linked
 *             listings whose options match one to one are adopted in place.
 *   apply     Photos are copied first (outside the transaction; network behind
 *             an injected client). Then ONE transaction: each listing created
 *             as a DRAFT through `activityService.create` (versions, audit),
 *             mode inquiry; per option one approved mapping candidate (source
 *             `import`), one mapping row built by `travelDeskMappingRow` (the
 *             same row and hash a reviewed approval writes) and one
 *             `supplier_mapping.approve` audit row; one `supplier_listing_links`
 *             row (noindex, unreviewed). Approval never changes mode or price.
 *   rollback  By import batch id: created listings soft-deleted through
 *             `productLifecycle`, their mappings deactivated, candidates closed,
 *             link rows kept and deactivated; a page they replaced is restored
 *             and its redirect removed. `revert` (the generic import undo) is
 *             the same with "nothing edited since" required.
 *
 * Secrecy: previews, batches, links, versions and audit rows hold prices
 * derived by the rule, never the supplier net (doc 30 §3.6).
 */

export const LISTING_RULE_SETTING_KEY = "pricing.listing_rule";
/** The production setting doc 30 §1.5 write 4 records: the rule's version and target. */
export const listingRuleSchema = z
  .object({ version: z.number().int().min(1), targetBps: z.number().int().min(1500).max(5000), recordedAt: z.string().datetime() })
  .strict();

const IMPORT_TX = { maxWait: 15_000, timeout: 180_000 } as const;
/** Per run, so one click never starts an unbounded transaction. */
export const MAX_LISTINGS_PER_IMPORT = 120;
/** A preview older than this is refused at apply: prices and facts may have moved (review 106 N1-05). */
export const PREVIEW_MAX_AGE_MS = 24 * 3_600_000;

export type TdRowAction = "create" | "adopt" | "skip" | "blocked";

export interface TdIdentity {
  tourId: number;
  kind: "instant" | "inquiry";
  arrival: string;
  route: string;
  fulfilment: string;
  splitNumber: number;
  classKey: string | null;
  startMinutes: number[];
  offerIds: number[];
}

export interface TdPreviewRow {
  row: number;
  key: string;
  step: PlanStepId;
  action: TdRowAction;
  ok: boolean;
  slug: string;
  title: string;
  input: ActivityInput | null;
  options: { variantId: string; offerId: number }[];
  identity: TdIdentity;
  pendingFields: PendingField[];
  warnings: string[];
  reasons: string[];
  skippedOffers: number[];
  adoptProductId: string | null;
  /** Stored matcher suggestion pre-filling "replaces" at review (§3.9). */
  replacesSuggestion: { productId: string; slug: string; title: string } | null;
  contentHash: string | null;
  photos: number;
  /** Per option, the offer terms hash at preview; apply refuses when any differs (review 106 N1-05). */
  offerHashes: Record<string, string | null>;
  /** Per option, the stored offer payload hash at preview (covers the nets the prices came from). */
  offerPayloadHashes: Record<string, string>;
}

export interface TdPreview {
  batchId: string;
  environment: SupplierEnvironment;
  step: PlanStepId;
  ruleVersion: number;
  rows: TdPreviewRow[];
  counts: Record<TdRowAction, number>;
}

/* ------------------------------------------------------------------ helpers */

async function listingRule(): Promise<{ version: number; targetBps: number }> {
  const raw = await settingsRepo.get<unknown>(LISTING_RULE_SETTING_KEY, null);
  const parsed = listingRuleSchema.safeParse(raw);
  if (!parsed.success) throw Errors.conflict(`Record the listing price rule (${LISTING_RULE_SETTING_KEY}) before importing`, { setting: LISTING_RULE_SETTING_KEY });
  if (parsed.data.targetBps !== RULE_TARGET_MARGIN_BPS) {
    throw Errors.conflict(`The recorded listing rule targets ${parsed.data.targetBps} bps but the dry run prices at ${RULE_TARGET_MARGIN_BPS} bps; they must agree`, { setting: LISTING_RULE_SETTING_KEY });
  }
  return parsed.data;
}

function requireImport(actor: Actor) {
  requirePermission(actor, "imports.run");
  requirePermission(actor, "products.edit");
  requirePermission(actor, "suppliers.manage");
  // The plan reads nets (dry run); the batch itself stores only rule prices.
  requirePermission(actor, "suppliers.costs.view");
  if (!actor.id) throw Errors.unauthorized();
}

function identityOf(l: PlannedListing, offerIds: number[]): TdIdentity {
  return {
    tourId: l.tourId,
    kind: l.kind,
    arrival: l.arrival,
    route: l.kind === "inquiry" ? (l.route ?? "any") : (l.route ?? "unknown"),
    fulfilment: l.fulfilment,
    splitNumber: l.splitNumber,
    classKey: l.classKey,
    startMinutes: l.kind === "inquiry" ? [] : l.startTimes.map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))),
    offerIds,
  };
}

const identityKey = (i: { tourExternalId: string; kind: string; arrival: string; route: string; fulfilment: string; splitNumber: number }) =>
  `${i.tourExternalId}|${i.kind}|${i.arrival}|${i.route}|${i.fulfilment}|${i.splitNumber}`;

const photoList = (v: unknown): TourContentPhoto[] => (Array.isArray(v) ? (v as TourContentPhoto[]) : []);

/** The document's supplier block: the supplier's own name and score, shown on the page; the row itself is never written (N1-18). */
function supplierBlock(s: { name: string; reliabilityScore: Prisma.Decimal; createdAt: Date }) {
  return { name: s.name, reliability: Math.max(0, Math.min(100, Math.round(Number(s.reliabilityScore)))), verifiedSince: s.createdAt.toISOString().slice(0, 7) };
}

/* ------------------------------------------------------------------ service */

export const traveldeskImportService = {
  async preview(actor: Actor, environment: SupplierEnvironment, step: PlanStepId, opts: { supplierCode?: string; now?: () => Date } = {}): Promise<TdPreview> {
    requireImport(actor);
    if (!PLAN_STEPS.some((s) => s.id === step)) throw Errors.validation({ step: "Unknown step" });
    const rule = await listingRule();
    const code = opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
    const supplier = await prisma.supplier.findUnique({ where: { code } });
    if (!supplier) throw Errors.conflict("Run a catalogue sync first: the TravelDesk supplier has no catalogue yet");
    // The priced plan and the hashes stored beside it must describe one catalogue state (review 106 nit): the
    // payload hashes are read before the report and compared after it; a sync in between refuses the preview.
    const hashesBefore = new Map(
      (await prisma.supplierCatalogueItem.findMany({ where: { supplierId: supplier.id, environment, removedAt: null }, select: { kind: true, externalId: true, payloadHash: true } })).map((r) => [`${r.kind}:${r.externalId}`, r.payloadHash]),
    );
    const report = await traveldeskDryRunService.report(actor, environment, { supplierCode: code, now: opts.now });
    const planned = report.listings.filter((l) => l.step === step);
    if (planned.length > MAX_LISTINGS_PER_IMPORT) throw Errors.conflict(`Step ${step} plans ${planned.length} listings; at most ${MAX_LISTINGS_PER_IMPORT} per run`);

    const tourIds = [...new Set(planned.map((l) => String(l.tourId)))];
    const offerIds = [...new Set(planned.flatMap((l) => l.options.map((o) => String(o.offerId))))];
    const [contents, offerRows, tourRows, links, categories, products] = await Promise.all([
      // Never the `raw` column (N0 review): the parsed fields only.
      prisma.supplierTourContent.findMany({
        where: { supplierId: supplier.id, environment, tourExternalId: { in: tourIds } },
        select: { tourExternalId: true, name: true, salesDescription: true, terms: true, videoUrl: true, faq: true, itinerary: true, photos: true, contentHash: true },
      }),
      prisma.supplierCatalogueItem.findMany({ where: { supplierId: supplier.id, environment, kind: "offer", externalId: { in: offerIds }, removedAt: null }, select: { externalId: true, parentExternalId: true, payload: true, payloadHash: true } }),
      prisma.supplierCatalogueItem.findMany({ where: { supplierId: supplier.id, environment, kind: "tour", externalId: { in: tourIds }, removedAt: null }, select: { externalId: true, payload: true, payloadHash: true } }),
      prisma.supplierListingLink.findMany({ where: { supplierId: supplier.id, environment, deactivatedAt: null }, select: { tourExternalId: true, kind: true, arrival: true, route: true, fulfilment: true, splitNumber: true, offerExternalIds: true, product: { select: { slug: true } } } }),
      prisma.category.findMany({ where: { deletedAt: null }, select: { slug: true } }),
      prisma.product.findMany({ select: { slug: true } }),
    ]);
    const moved = [...offerRows.map((o) => ["offer", o.externalId, o.payloadHash] as const), ...tourRows.map((t) => ["tour", t.externalId, t.payloadHash] as const)].filter(([k, id, h]) => hashesBefore.get(`${k}:${id}`) !== h);
    if (moved.length || offerRows.length !== offerIds.length) throw Errors.conflict("The TravelDesk catalogue changed while this preview was built — preview again");
    const content = new Map(contents.map((c) => [Number(c.tourExternalId), c]));
    const stored = new Map<number, StoredOffer>();
    const tourPayload = new Map(tourRows.map((t) => [t.externalId, t.payload]));
    const hashes = new Map<number, string | null>();
    const payloadHashes = new Map(offerRows.map((o) => [Number(o.externalId), o.payloadHash]));
    for (const o of offerRows) {
      const p = parseStoredOffer(o.payload);
      if (p) stored.set(Number(o.externalId), p);
      hashes.set(Number(o.externalId), o.parentExternalId && tourPayload.has(o.parentExternalId) ? offerTermsHash(o.payload, tourPayload.get(o.parentExternalId)) : null);
    }
    const tourCats = new Map(
      tourRows.map((t) => {
        const cats = (t.payload as { categories?: { name?: string | null }[] } | null)?.categories ?? [];
        return [Number(t.externalId), cats.map((c) => c.name ?? "").filter(Boolean)];
      }),
    );
    // RR-01: a link's split number is fixed at import. Planned listings are matched to the group's links by their
    // offers, never by position (review 106 N1-23): split numbers are recomputed from the catalogue on every preview.
    const groupOf = (i: { tourExternalId: string; kind: string; arrival: string; route: string; fulfilment: string }) => `${i.tourExternalId}|${i.kind}|${i.arrival}|${i.route}|${i.fulfilment}`;
    const groupLinks = new Map<string, typeof links>();
    for (const l of links) groupLinks.set(groupOf(l), [...(groupLinks.get(groupOf(l)) ?? []), l]);
    const usedSplits = new Map<string, number>();
    for (const l of links) usedSplits.set(groupOf(l), Math.max(usedSplits.get(groupOf(l)) ?? 0, l.splitNumber));
    const linkedSlugsByTour = new Map<number, string[]>();
    for (const l of links) linkedSlugsByTour.set(Number(l.tourExternalId), [...(linkedSlugsByTour.get(Number(l.tourExternalId)) ?? []), l.product.slug]);
    const known = new Set(categories.map((c) => c.slug));
    const taken = new Set(products.map((p) => p.slug));
    const sb = supplierBlock(supplier);
    const siblings = new Map<number, number>();
    for (const l of report.listings) siblings.set(l.tourId, (siblings.get(l.tourId) ?? 0) + 1);

    const rows: TdPreviewRow[] = [];
    const seenIdentity = new Set<string>();
    planned.forEach((l, i) => {
      const optionIds = l.options.map((o) => o.offerId);
      const identity = identityOf(l, optionIds);
      const linked = l.options.filter((o) => o.linkedTo.length > 0).map((o) => o.offerId);
      const suggestion = l.oldPages.find((p) => !l.adoptProduct || p.productId !== l.adoptProduct.productId) ?? null;
      const c = content.get(l.tourId) ?? null;
      const base: TdPreviewRow = {
        row: i + 1,
        key: l.key,
        step,
        action: "blocked",
        ok: false,
        slug: "",
        title: l.tourName ?? `Tour ${l.tourId}`,
        input: null,
        options: [],
        identity,
        pendingFields: [],
        warnings: [],
        reasons: [],
        skippedOffers: linked,
        adoptProductId: null,
        replacesSuggestion: suggestion ? { productId: suggestion.productId, slug: suggestion.slug, title: suggestion.title } : null,
        contentHash: c?.contentHash ?? null,
        photos: photoList(c?.photos).length,
        offerHashes: Object.fromEntries(l.options.map((o) => [String(o.offerId), hashes.get(o.offerId) ?? null])),
        offerPayloadHashes: Object.fromEntries(l.options.map((o) => [String(o.offerId), payloadHashes.get(o.offerId) ?? ""])),
      };
      const group = groupOf({ tourExternalId: String(l.tourId), ...identity });
      const mine = new Set(optionIds.map(String));
      const inGroup = groupLinks.get(group) ?? [];
      const same = inGroup.find((x) => x.offerExternalIds.length === mine.size && x.offerExternalIds.every((o) => mine.has(o)));
      if (same) {
        identity.splitNumber = same.splitNumber;
        rows.push({ ...base, action: "skip", ok: true, slug: same.product.slug, reasons: ["already_imported"] });
        return;
      }
      const overlap = inGroup.find((x) => x.offerExternalIds.some((o) => mine.has(o)));
      if (overlap) {
        rows.push({ ...base, reasons: [`identity_shifted:${overlap.product.slug}`] });
        return;
      }
      if (inGroup.length) {
        if (l.kind === "inquiry") {
          // One inquiry listing per group (D4); new never-instant offers join it by review (N3), not by a second page.
          rows.push({ ...base, reasons: [`inquiry_listing_exists:${inGroup[0].product.slug}`] });
          return;
        }
        // A new listing beside imported ones is numbered after the group's highest stored split.
        const next = (usedSplits.get(group) ?? 0) + 1;
        usedSplits.set(group, next);
        identity.splitNumber = next;
      }
      // RR-01: two planned listings never share an identity (review 106 N1-02); a duplicate is a plan bug, so it blocks.
      const idKey = identityKey({ tourExternalId: String(l.tourId), ...identity });
      if (seenIdentity.has(idKey)) {
        rows.push({ ...base, reasons: ["identity_duplicate"] });
        return;
      }
      seenIdentity.add(idKey);
      // Adopt in place (§3.9): every option already linked, one to one, to one product.
      if (l.adoptProduct && linked.length === l.options.length) {
        rows.push({ ...base, action: "adopt", ok: true, slug: l.adoptProduct.slug, adoptProductId: l.adoptProduct.productId, options: l.options.map((o) => ({ variantId: `td-${o.offerId}`, offerId: o.offerId })) });
        return;
      }
      // Doc 30 §3.5: an offer whose stored terms cannot be read (no terms hash) is never linked (N1-15).
      const unreadable = l.options.filter((o) => o.linkedTo.length === 0 && !hashes.get(o.offerId)).map((o) => `td-${o.offerId}:terms_unreadable`);
      if (unreadable.length) {
        rows.push({ ...base, reasons: unreadable });
        return;
      }
      const buildContent: BuildContent | null = c
        ? { name: c.name, salesDescription: c.salesDescription, terms: c.terms, videoUrl: c.videoUrl, faq: (c.faq as unknown as TourContentFaq[]) ?? [], itinerary: (c.itinerary as unknown as TourContentItineraryStep[]) ?? [] }
        : null;
      const built = buildListingDraft(l, stored, buildContent, {
        supplier: sb,
        categorySlug: categoryFor(c?.name || l.tourName || "", tourCats.get(l.tourId) ?? [], known),
        images: [],
        takenSlugs: taken,
        siblingCount: siblings.get(l.tourId) ?? 1,
      });
      if (!built.ok) {
        rows.push({ ...base, reasons: built.reasons });
        return;
      }
      taken.add(built.input.slug);
      if (!c) built.warnings.push("content_missing");
      rows.push({ ...base, action: "create", ok: true, slug: built.input.slug, title: built.input.title, input: built.input, options: built.options, pendingFields: built.pendingFields, warnings: built.warnings });
    });

    // "Other ways to do this" (§3.3): sibling listings of a tour link to each other.
    for (const r of rows.filter((x) => x.action === "create" && x.input)) {
      const sib = [...rows.filter((x) => x !== r && x.identity.tourId === r.identity.tourId && (x.action === "create" || x.action === "adopt")).map((x) => x.slug), ...(linkedSlugsByTour.get(r.identity.tourId) ?? [])];
      r.input = activityInputSchema.parse({ ...r.input!, relatedSlugs: [...new Set(sib)].filter((s) => s && s !== r.slug).slice(0, 12) });
    }

    const counts = { create: 0, adopt: 0, skip: 0, blocked: 0 } as Record<TdRowAction, number>;
    for (const r of rows) counts[r.action] += 1;
    const id = uuidv7();
    await prisma.importBatch.create({
      data: {
        id,
        source: "traveldesk",
        status: "previewed",
        sourceRef: `traveldesk:${environment}:${step}:${code}`,
        mapping: { environment, step, supplierCode: code, ruleVersion: rule.version } as Prisma.InputJsonValue,
        rowsTotal: rows.length,
        rowsOk: rows.filter((r) => r.action === "create" || r.action === "adopt").length,
        rowsFailed: counts.blocked,
        errors: rows.filter((r) => r.action === "blocked").map((r) => ({ row: r.row, field: r.key, message: r.reasons.join(", ") })) as unknown as Prisma.InputJsonValue,
        preview: rows as unknown as Prisma.InputJsonValue,
        createdBy: actor.id!,
      },
    });
    await audit(actor, "traveldesk_import.preview", { type: "import_batch", id }, { after: { environment, step, counts, ruleVersion: rule.version } });
    return { batchId: id, environment, step, ruleVersion: rule.version, rows, counts };
  },

  /**
   * Apply a previewed TravelDesk batch: drafts, exact links, link rows. Every
   * row is re-checked under the transaction, which holds the offer-link lock
   * of the supplier and environment (review 106 N1-07): an identity imported
   * since the preview, an offer linked since, an offer whose terms changed
   * since (N1-05), a changed listing rule, or a preview older than 24 hours
   * refuses the whole batch (409). Photos are not copied here (N1-12e): run
   * `copyPhotos` afterwards, a few tours per call.
   */
  async apply(actor: Actor, batchId: string, opts: { reason?: string; now?: () => Date } = {}) {
    requireImport(actor);
    const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
    if (!batch || batch.source !== "traveldesk") throw Errors.notFound("TravelDesk import batch");
    if (batch.status !== "previewed") throw Errors.conflict(`This batch was already ${batch.status}`);
    const meta = z.object({ environment: z.enum(["test", "production"]), step: z.string(), supplierCode: z.string(), ruleVersion: z.number().int() }).parse(batch.mapping);
    const environment = meta.environment as SupplierEnvironment;
    const rows = (Array.isArray(batch.preview) ? batch.preview : []) as unknown as TdPreviewRow[];
    const todo = rows.filter((r) => r.ok && (r.action === "create" || r.action === "adopt"));
    if (todo.length === 0) throw Errors.conflict("Nothing to import in this batch");
    const at = (opts.now ?? (() => new Date()))();
    if (at.getTime() - batch.createdAt.getTime() > PREVIEW_MAX_AGE_MS) throw Errors.conflict("This preview is more than 24 hours old — preview again");
    const rule = await listingRule();
    if (rule.version !== meta.ruleVersion) throw Errors.conflict(`The listing price rule changed since this preview (v${meta.ruleVersion} → v${rule.version}) — preview again`);
    const supplier = await prisma.supplier.findUnique({ where: { code: meta.supplierCode } });
    if (!supplier) throw Errors.conflict("The TravelDesk supplier is missing");
    const reason = opts.reason?.trim() || `TravelDesk import ${meta.step} (${environment})`;

    const now = new Date();
    const result = await prisma
      .$transaction(async (tx) => {
        const claimed = await tx.importBatch.updateMany({ where: { id: batchId, status: "previewed" }, data: { status: "applied", appliedAt: now } });
        if (claimed.count !== 1) throw Errors.conflict("This batch is being applied or was already applied");
        await lockOfferLinks(tx, supplier.id, environment);
        const allOffers = [...new Set(todo.filter((r) => r.action === "create").flatMap((r) => r.options.map((o) => String(o.offerId))))];
        const active = await tx.productSupplierMapping.findMany({ where: { supplierId: supplier.id, environment, isActive: true, supplierOfferId: { in: allOffers } }, select: { supplierOfferId: true } });
        if (active.length) throw Errors.conflict(`Linked after this preview: offer ${active.map((a) => a.supplierOfferId).join(", ")} — preview again`);
        const catalogue = await tx.supplierCatalogueItem.findMany({
          where: { supplierId: supplier.id, environment, removedAt: null, OR: [{ kind: "offer", externalId: { in: allOffers } }, { kind: "tour", externalId: { in: [...new Set(todo.map((r) => String(r.identity.tourId)))] } }] },
        });
        const offerRow = new Map(catalogue.filter((c) => c.kind === "offer").map((c) => [c.externalId, c]));
        const tourRow = new Map(catalogue.filter((c) => c.kind === "tour").map((c) => [c.externalId, c]));
        // The terms the preview priced must still be the terms (review 106 N1-05).
        for (const r of todo.filter((x) => x.action === "create")) {
          const tour = tourRow.get(String(r.identity.tourId));
          for (const o of r.options) {
            const offer = offerRow.get(String(o.offerId));
            const current = offer && tour ? offerTermsHash(offer.payload, tour.payload) : null;
            if (!current || current !== r.offerHashes?.[String(o.offerId)] || offer!.payloadHash !== r.offerPayloadHashes?.[String(o.offerId)]) throw Errors.conflict(`Offer ${o.offerId} changed or vanished since this preview — preview again`);
          }
        }

        const created: { productId: string; slug: string; linkId: string }[] = [];
        const adopted: { productId: string; slug: string; linkId: string }[] = [];
        for (const r of todo) {
          const tourId = String(r.identity.tourId);
          const linkBase = {
            id: uuidv7(),
            supplierId: supplier.id,
            environment,
            tourExternalId: tourId,
            kind: r.identity.kind,
            arrival: r.identity.arrival,
            route: r.identity.route,
            fulfilment: r.identity.fulfilment,
            splitNumber: r.identity.splitNumber,
            classKey: r.identity.classKey,
            startMinutes: r.identity.startMinutes,
            contentHash: r.contentHash,
            pricingRuleVersion: meta.ruleVersion,
            importBatchId: batchId,
          };
          if (r.action === "adopt") {
            const p = await tx.product.findUnique({ where: { id: r.adoptProductId! }, select: { id: true, slug: true, version: true, deletedAt: true, mappings: { where: { supplierId: supplier.id, environment, isActive: true }, select: { supplierOfferId: true } } } });
            const want = new Set(r.options.map((o) => String(o.offerId)));
            const have = new Set((p?.mappings ?? []).map((m) => m.supplierOfferId).filter((x): x is string => Boolean(x)));
            if (!p || p.deletedAt || have.size !== want.size || [...want].some((o) => !have.has(o))) throw Errors.conflict(`"${r.slug}" no longer matches its offers one to one — preview again`);
            // An adopted listing is already live, reviewed and hand-written: it stays indexable and every editorial field is locked (§3.7, §3.9; N1-08).
            const adoptData = { ...linkBase, productId: p.id, offerExternalIds: [...want], importVersion: p.version, adopted: true, noindex: false, reviewedAt: now, reviewedBy: actor.id, lockedFields: [...EDITORIAL_FIELDS], deactivatedAt: null };
            // A product has one link row ever: a link deactivated by an earlier rollback is taken up again.
            const prior = await tx.supplierListingLink.findUnique({ where: { productId: p.id }, select: { id: true, deactivatedAt: true } });
            if (prior && !prior.deactivatedAt) throw Errors.conflict(`"${r.slug}" is already linked — preview again`);
            if (prior) {
              const { id: _id, ...rest } = adoptData;
              await tx.supplierListingLink.update({ where: { id: prior.id }, data: rest });
              linkBase.id = prior.id;
            } else await tx.supplierListingLink.create({ data: adoptData });
            await audit(actor, "traveldesk_listing.adopt", { type: "product", id: p.id }, { after: { linkId: linkBase.id, batchId, offers: [...want], identity: r.identity }, reason }, tx);
            adopted.push({ productId: p.id, slug: p.slug, linkId: linkBase.id });
            continue;
          }
          const input = activityInputSchema.parse(r.input);
          const row = await activityService.create(actor, input, { status: "draft", reason, tx, supplierId: supplier.id });
          // Doc 30 N3 (review 108 N3-07): the terms approved here, so the first automatic re-approval names each changed term.
          const approvedTerms: Record<string, unknown> = {};
          for (const o of r.options) {
            const offer = offerRow.get(String(o.offerId))!;
            const tour = tourRow.get(tourId)!;
            const { mappingData, externalRef, approvedOfferHash, approvedSlotHours } = travelDeskMappingRow(offer, tour, environment);
            const terms = offerTermsOf(offer.payload, tour.payload);
            if (terms) approvedTerms[String(o.offerId)] = terms;
            const mappingId = uuidv7();
            const top = await tx.productSupplierMapping.aggregate({ where: { productId: row.id }, _max: { priority: true } });
            await tx.productSupplierMapping.create({ data: { id: mappingId, productId: row.id, supplierId: supplier.id, variantCode: o.variantId, priority: (top._max.priority ?? 0) + 1, ...mappingData } });
            const candidateId = uuidv7();
            await tx.supplierMappingCandidate.create({
              data: { id: candidateId, productId: row.id, variantCode: o.variantId, supplierId: supplier.id, environment, tourExternalId: tourId, offerExternalId: String(o.offerId), state: "approved", score: 100, source: "import", reviewedBy: actor.id, reviewedAt: now, reviewNote: reason, mappingId },
            });
            await audit(
              actor,
              "supplier_mapping.approve",
              { type: "product", id: row.id },
              { before: null, after: { mappingId, candidateId, externalRef, environment, approvedOfferHash, approvedSlotHours, source: "import", batchId }, reason },
              tx,
            );
          }
          await tx.supplierListingLink.create({ data: { ...linkBase, productId: row.id, offerExternalIds: r.options.map((o) => String(o.offerId)), importVersion: 1, pendingFields: r.pendingFields, approvedTerms: approvedTerms as Prisma.InputJsonValue } });
          await tx.importBatchItem.create({ data: { id: uuidv7(), batchId, productId: row.id, action: "create", beforeVersion: null, afterVersion: 1, slug: row.slug } });
          created.push({ productId: row.id, slug: row.slug, linkId: linkBase.id });
        }
        await tx.importBatch.update({ where: { id: batchId }, data: { rowsOk: created.length + adopted.length } });
        await audit(actor, "traveldesk_import.apply", { type: "import_batch", id: batchId }, { after: { environment, step: meta.step, created: created.length, adopted: adopted.length }, reason }, tx);
        return { created, adopted };
      }, IMPORT_TX)
      .catch(async (error: unknown) => {
        await prisma.importBatch.updateMany({ where: { id: batchId, status: "previewed" }, data: { status: "failed" } }).catch(() => {});
        log.error("traveldesk_import.apply_failed", { batchId, error });
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw Errors.conflict("A listing or an offer of this batch was imported by another run — preview again");
        throw error;
      });
    revalidateCatalog();
    await readinessService.reevaluateMany([...result.created, ...result.adopted].map((c) => c.productId), "import_apply");
    return { batchId, ...result };
  },

  /**
   * Copy TravelDesk photos into our own storage for imported drafts still on a
   * placeholder image (doc 30 §3.8), at most `maxTours` tours per call so a
   * request never runs long (review 106 N1-12e); call again while `remaining`
   * is above 0. One copy per tour, shared by its listings. Each listing's
   * update is its own versioned write; it moves the lock baseline, so the
   * copied photos never count as a person's edit. Uploaded objects no
   * listing took are deleted again (N1-12d).
   */
  async copyPhotos(actor: Actor, opts: { photos?: PhotoCopyDeps | null; batchId?: string; environment?: SupplierEnvironment; maxTours?: number; reason?: string } = {}) {
    requirePermission(actor, "imports.run");
    requirePermission(actor, "products.edit");
    const photos = opts.photos === undefined ? configuredPhotoCopier() : opts.photos;
    if (!photos) throw Errors.conflict("Photo copying is not configured (bucket, public base URL and TravelDesk media hosts)");
    const links = await prisma.supplierListingLink.findMany({
      where: { deactivatedAt: null, adopted: false, pendingFields: { has: "images" }, product: { deletedAt: null }, ...(opts.batchId ? { importBatchId: opts.batchId } : {}), ...(opts.environment ? { environment: opts.environment } : {}) },
      select: { id: true, productId: true, supplierId: true, environment: true, tourExternalId: true },
      orderBy: [{ tourExternalId: "asc" }],
    });
    const tours = [...new Map(links.map((l) => [`${l.supplierId}|${l.environment}|${l.tourExternalId}`, l])).values()];
    const batch = tours.slice(0, Math.max(1, Math.min(10, opts.maxTours ?? 5)));
    const reason = opts.reason?.trim() || "TravelDesk photos copied";
    const done: string[] = [];
    const failures: Record<string, string[]> = {};
    for (const t of batch) {
      const content = await prisma.supplierTourContent.findUnique({ where: { supplierId_environment_tourExternalId: { supplierId: t.supplierId, environment: t.environment, tourExternalId: t.tourExternalId } }, select: { photos: true } });
      const copied = await copyTourPhotos(photoList(content?.photos), photos);
      if (copied.failures.length) failures[t.tourExternalId] = copied.failures.map((f) => f.reason);
      if (copied.urls.length === 0) continue;
      let used = false;
      for (const l of links.filter((x) => x.supplierId === t.supplierId && x.environment === t.environment && x.tourExternalId === t.tourExternalId)) {
        try {
          await prisma.$transaction(async (tx) => {
            const p = await tx.product.findUniqueOrThrow({ where: { id: l.productId } });
            const doc = activitySchema.safeParse(p.content);
            if (p.deletedAt || !doc.success || !doc.data.images.every((i) => i.startsWith("img:"))) return;
            const next = { ...doc.data, images: copied.urls, fulfilmentMode: p.fulfilmentMode };
            const version = p.version + 1;
            const w = await tx.product.updateMany({ where: { id: p.id, version: p.version, deletedAt: null }, data: { content: next as unknown as Prisma.InputJsonValue, version } });
            if (w.count !== 1) return;
            await tx.productVersion.create({ data: { id: uuidv7(), productId: p.id, version, content: next as unknown as Prisma.InputJsonValue, status: p.status, actorId: actor.id, reason } });
            await audit(actor, "activity.update", { type: "product", id: p.id }, { before: { version: p.version }, after: { version, photos: copied.urls.length, source: "traveldesk_photos" }, reason }, tx);
            const link = await tx.supplierListingLink.findUniqueOrThrow({ where: { id: l.id }, select: { pendingFields: true } });
            // Doc 30 N3 (review 108 N3-07): the photo list these copies came from; the upkeep copies again when it moves.
            await tx.supplierListingLink.update({ where: { id: l.id }, data: { pendingFields: link.pendingFields.filter((f) => f !== "images"), photosHash: photosHashOf(content?.photos) } });
            await recordEditorialLocks(tx, p.id, { systemFields: ["images"], rebase: true });
            used = true;
            done.push(p.id);
          }, TX_OPTIONS);
        } catch (e) {
          log.warn("traveldesk_import.photo_update_failed", { productId: l.productId, error: e });
        }
      }
      if (!used) await Promise.all(copied.keys.map((k) => photos.store.delete?.(k).catch(() => {})));
    }
    if (done.length) revalidateCatalog();
    return { listingsUpdated: done.length, toursTried: batch.length, remainingTours: Math.max(0, tours.length - batch.length), failures };
  },

  /** TravelDesk batches, newest first (admin list). Rows carry rule prices only, never nets. */
  async batches(actor: Actor, opts: { take?: number } = {}) {
    requirePermission(actor, "imports.run");
    return prisma.importBatch.findMany({
      where: { source: "traveldesk" },
      orderBy: { createdAt: "desc" },
      take: Math.min(50, opts.take ?? 20),
      select: { id: true, status: true, sourceRef: true, rowsTotal: true, rowsOk: true, rowsFailed: true, createdAt: true, appliedAt: true, revertedAt: true },
    });
  },

  async batch(actor: Actor, batchId: string): Promise<{ id: string; status: string; sourceRef: string | null; rows: TdPreviewRow[] }> {
    requirePermission(actor, "imports.run");
    const b = await prisma.importBatch.findUnique({ where: { id: batchId } });
    if (!b || b.source !== "traveldesk") throw Errors.notFound("TravelDesk import batch");
    return { id: b.id, status: b.status, sourceRef: b.sourceRef, rows: (Array.isArray(b.preview) ? b.preview : []) as unknown as TdPreviewRow[] };
  },

  /**
   * Roll a TravelDesk batch back by its id (doc 30 §5 N1 rollback): created
   * listings are soft-deleted through `productLifecycle`, their mappings
   * deactivated and candidates closed; link rows are kept and deactivated; an
   * old page one of them replaced is restored (published again) and its
   * redirect removed. Adopted links are only deactivated.
   *
   * Refused, with the listings named (review 106 N1-10): any created listing
   * that is instant (requested or effective) or has an open order or inquiry;
   * a published one unless `force` (the caller has unpublished it, or means
   * to take it down). `requireUnchanged` makes it the immediate undo of the
   * generic import revert: every created listing must still be at the version
   * the import wrote.
   */
  async rollback(actor: Actor, batchId: string, reason: string, opts: { requireUnchanged?: boolean; force?: boolean } = {}) {
    requirePermission(actor, "imports.run");
    requirePermission(actor, "products.delete");
    requirePermission(actor, "suppliers.manage");
    if (reason.trim().length < 8) throw Errors.validation({ reason: "Give a reason of at least 8 characters — it goes in the audit log" });
    const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
    if (!batch || batch.source !== "traveldesk") throw Errors.notFound("TravelDesk import batch");
    if (batch.status !== "applied") throw Errors.conflict(`Only applied batches can be rolled back (this one is ${batch.status})`);
    const touched: string[] = [];
    let deleted = 0;
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.importBatch.updateMany({ where: { id: batchId, status: "applied" }, data: { status: "reverted", revertedAt: new Date() } });
      if (claimed.count !== 1) throw Errors.conflict("This batch is being rolled back or was already rolled back");
      const links = await tx.supplierListingLink.findMany({
        where: { importBatchId: batchId, deactivatedAt: null },
        include: { product: { select: { id: true, slug: true, version: true, deletedAt: true, status: true, fulfilmentMode: true, eligibility: { select: { effectiveMode: true } } } } },
      });
      // Review 110 R110-01: lock in the upkeep's order (mapping rows by id, then product, then link), so a rollback and
      // a running upkeep never wait on each other in a cycle.
      const lockIds = [...new Set(links.map((l) => l.productId))];
      if (lockIds.length) await tx.$queryRaw`SELECT id FROM product_supplier_mappings WHERE product_id = ANY(${lockIds}::uuid[]) ORDER BY id FOR UPDATE`;
      const created = links.filter((l) => !l.adopted && !l.product.deletedAt);
      if (opts.requireUnchanged) {
        const moved = links.filter((l) => !l.adopted && (l.product.deletedAt || l.product.version !== l.importVersion));
        if (moved.length) throw Errors.conflict(`${moved.map((l) => `"${l.product.slug}"`).join(", ")} changed after this import — use the TravelDesk rollback instead`, { slugs: moved.map((l) => l.product.slug) });
      }
      const ids = created.map((l) => l.productId);
      const [inquiries, orders] = await Promise.all([
        tx.inquiryItem.findMany({ where: { productId: { in: ids }, inquiry: { status: { in: [...OPEN_INQUIRY] } } }, select: { productId: true } }),
        tx.orderItem.findMany({ where: { productId: { in: ids }, order: { status: { in: [...OPEN_ORDER] } } }, select: { productId: true } }),
      ]);
      const busy = new Set([...inquiries, ...orders].map((x) => x.productId));
      const refused = created.flatMap((l) => {
        const why =
          l.product.fulfilmentMode === "instant" || l.product.eligibility?.effectiveMode === "instant"
            ? "instant"
            : busy.has(l.productId)
              ? "open order or inquiry"
              : l.product.status === "published" && !opts.force
                ? "published (unpublish it first, or roll back with force)"
                : null;
        return why ? [`"${l.product.slug}": ${why}`] : [];
      });
      if (refused.length) throw Errors.conflict(`Not rolled back: ${refused.join("; ")}`, { refused });
      const now = new Date();
      for (const l of links) {
        await tx.supplierListingLink.update({ where: { id: l.id }, data: { deactivatedAt: now } });
        if (l.adopted) continue;
        touched.push(l.productId);
        deleted += 1;
        await restoreReplacedInTx(tx, actor, l.id, reason, touched);
        if (!l.product.deletedAt) await productLifecycle.softDeleteInTx(tx, actor, l.productId, reason);
        await tx.productSupplierMapping.updateMany({ where: { productId: l.productId, supplierOfferId: { not: null }, isActive: true }, data: { isActive: false } });
        await tx.supplierMappingCandidate.updateMany({ where: { productId: l.productId, source: "import", state: "approved" }, data: { state: "rejected", reviewedBy: actor.id, reviewedAt: now, reviewNote: `Rolled back: ${reason.trim()}`.slice(0, 500) } });
      }
      // Defensive: a product this batch created without a link row (none should exist) is removed too.
      const linked = new Set(links.map((l) => l.productId));
      for (const item of await tx.importBatchItem.findMany({ where: { batchId, action: "create" }, select: { productId: true } })) {
        if (linked.has(item.productId)) continue;
        const p = await tx.product.findUnique({ where: { id: item.productId }, select: { deletedAt: true } });
        if (p && !p.deletedAt) {
          await productLifecycle.softDeleteInTx(tx, actor, item.productId, reason);
          touched.push(item.productId);
          deleted += 1;
        }
      }
      await audit(actor, "traveldesk_import.rollback", { type: "import_batch", id: batchId }, { after: { links: links.length, deleted, requireUnchanged: Boolean(opts.requireUnchanged), force: Boolean(opts.force) }, reason }, tx);
    }, IMPORT_TX);
    revalidateCatalog();
    await readinessService.reevaluateMany(touched, "import_revert");
    return { batchId, rolledBack: deleted, restored: touched.length - deleted };
  },
};

const OPEN_INQUIRY = ["new", "assigned", "contacted", "quoted", "negotiating", "payment_pending"] as const;
const OPEN_ORDER = ["pending_payment", "paid", "supplier_pending", "confirmed", "partially_confirmed"] as const;

/**
 * Undo the retire of the page this link replaced (doc 30 §3.9 restore path):
 * the old listing is restored and published again, the redirect to this
 * link's listing removed, and the link no longer names it. Shared by the
 * batch rollback and the publish service's restore. Refused when the old page
 * changed after the retire (deleted again for another reason, say: its latest
 * version is not the retire this link wrote; review 106 N1-11). No-op when
 * nothing was retired for this link.
 */
export async function restoreReplacedInTx(tx: Tx, actor: Actor, linkId: string, reason: string, touched: string[]) {
  const redirect = await tx.productRedirect.findFirst({ where: { linkId } });
  if (!redirect) return null;
  const old = await tx.product.findUnique({ where: { id: redirect.oldProductId } });
  if (old?.deletedAt) {
    requirePermission(actor, "products.publish");
    const latest = await tx.productVersion.findUnique({ where: { productId_version: { productId: old.id, version: old.version } }, select: { reason: true } });
    if (!latest?.reason?.startsWith(RETIRE_REASON_PREFIX)) throw Errors.conflict(`"${old.slug}" changed after it was retired — restore it from the console instead`, { slug: old.slug });
    const version = old.version + 1;
    const written = await tx.product.updateMany({ where: { id: old.id, version: old.version }, data: { deletedAt: null, status: "published", version, publishedAt: old.publishedAt ?? new Date() } });
    if (written.count !== 1) throw Errors.conflict(`"${old.slug}" changed while it was being restored — try again`);
    await tx.productVersion.create({ data: { id: uuidv7(), productId: old.id, version, content: old.content as Prisma.InputJsonValue, status: "published", actorId: actor.id, reason } });
    await audit(actor, "activity.restore", { type: "product", id: old.id }, { before: { status: old.status, deletedAt: old.deletedAt }, after: { status: "published", deletedAt: null, restoredFrom: "replacement_rollback", linkId }, reason }, tx);
    touched.push(old.id);
  }
  await tx.productRedirect.delete({ where: { id: redirect.id } });
  await tx.supplierListingLink.updateMany({ where: { id: linkId, replacesProductId: redirect.oldProductId }, data: { replacesProductId: null } });
  await audit(actor, "product_redirect.remove", { type: "product", id: redirect.oldProductId }, { before: { oldSlug: redirect.oldSlug, targetProductId: redirect.targetProductId }, reason }, tx);
  return redirect;
}

/** The version reason of a retire written by the publish service; restore checks it (N1-11). */
export const RETIRE_REASON_PREFIX = "Replaced by ";
