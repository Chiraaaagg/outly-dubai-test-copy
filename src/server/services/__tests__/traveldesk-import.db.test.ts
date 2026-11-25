import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import type { Actor } from "../../lib/actor";
import { isAppError } from "../../lib/errors";
import { uuidv7 } from "../../lib/ids";
import { readLimits } from "../../suppliers/read-budget";
import { tourDetailFrom, tourDetailsWire, type TravelDeskTourDetail, type TravelDeskTourSummary } from "../../suppliers/traveldesk/traveldesk.codec";
import { offerTermsHash } from "../../suppliers/traveldesk/traveldesk.offer-terms";
import { MemoryPhotoStore, type PhotoCopyDeps } from "../../imports/photo-copy";
import { PENDING_TEXT } from "../../suppliers/traveldesk/traveldesk.listing-build";

/**
 * Doc 30 N1 against the LOCAL disposable test database: preview and apply of
 * one step, exact links written like a reviewed approval, adopt-in-place,
 * import twice creates nothing, an offer linked after the preview refuses
 * the apply, the generic publish refuses an unreviewed import, review, bulk
 * publish with retire and permanent redirect, the redirect gate, rollback by
 * batch id with the old page restored, and the generic revert delegating.
 *
 * Synthetic wire JSON under a run-scoped supplier code and `zz-test-` slugs;
 * removed in afterAll. Photos go through a fake fetch into a memory store:
 * no network. Nets are invented, deliberately odd numbers so a leak would be
 * visible. Pricing settings are saved before and restored after.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const RUN = uuidv7().slice(-8);
const CODE = `zz-tdn1-${RUN}`;
const BASE = 930_000_000 + Math.floor(Math.random() * 60_000_000);
const LANE = { readLimits: readLimits(100_000) };
const SETTING_KEYS = ["pricing.margin_policy", "pricing.margin_cost_inputs", "pricing.fx_inr_per_aed", "pricing.listing_rule"];
const NET_NEEDLES = ["12347", "123.47", "9871", "98.71"];

const admin: Actor = { type: "admin", id: uuidv7(), roles: ["admin"], permissions: new Set(["*"]) };

function period(adult: number, child: number) {
  return { id: 1, offerId: 1, currency: "AED", recPricePerAdult: null, recPricePerChild: null, recPricePerTrip: null, pricePerAdult: adult, pricePerChild: child, pricePerTrip: 0, pricePerAdultUsd: 0, pricePerChildUsd: 0, pricePerTripUsd: 0, discountPercent: null, supplierCurrencyCode: null, conversionRate: null, vat: null, dateStart: "2024-01-01T00:00:00", dateEnd: null };
}

function wireOffer(id: number, start: number, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `zz synthetic offer ${id}`,
    code: null,
    daysOffered: 0,
    numberOfHours: 2,
    minNumOfPeople: 1,
    maxNumOfPeople: 20,
    privateType: 0,
    childrenAllowed: true,
    childAge: 12,
    infantsAllowed: true,
    infantAge: 3,
    pricingPeriods: [period(123.47, 98.71)],
    isDirectReporting: true,
    description: null,
    timeSlots: [{ id: 1, name: null, startTime: start, endTime: start + 120, daysOffered: 0, isAnyTime: false, isOnRequest: false, minimumAdvancedBooking: 12 }],
    bookingType: 1,
    isExternal: false,
    tripUnit: null,
    ...over,
  };
}

function wireTour(id: number, name: string, offers: Record<string, unknown>[]) {
  return {
    id,
    name,
    language: "English",
    isExternal: false,
    cancellationPolicy: [{ hours: 24, percents: 100 }],
    categories: [{ id: 1, name: "Dhow Cruise", url: null }],
    termsAndConditions: "<p>Bring photo ID.</p>",
    salesDescription: "<p>Sail the creek at sunset on a wooden dhow. Dinner on board.</p><p>Inclusions:</p><ul><li>Buffet dinner</li></ul>",
    faqList: [{ question: "Dinner?", answer: "<p>Buffet</p>" }],
    itineraries: [{ title: "Boarding" }],
    photos: [{ id: 7, srcSet: [{ type: "image/webp", sizes: [{ src: "https://media.example.test/7-hd.webp", width: 1280, height: 720 }] }] }],
    videoUrl: null,
    offers,
  };
}

function source(wires: Record<string, unknown>[]) {
  const details: TravelDeskTourDetail[] = wires.map((w) => tourDetailFrom(tourDetailsWire.parse(w)));
  return {
    async listTours(): Promise<TravelDeskTourSummary[]> {
      return details.map((t) => ({ tourId: t.tourId, name: t.name, categories: [] }));
    },
    async getTour(id: number) {
      const t = details.find((x) => x.tourId === id);
      if (!t) throw new Error("missing");
      return t;
    },
  };
}

const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1]);
function fakePhotos(store: MemoryPhotoStore): PhotoCopyDeps {
  return { fetchPhoto: async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff, 0]), type: "image/jpeg" }), reencode: async () => ({ bytes: WEBP, type: "image/webp" }), store, environment: "test", sleep: async () => {} };
}

const code = (e: unknown) => (isAppError(e) ? e.code : String(e));

describe.skipIf(!enabled)("TravelDesk importer, N1 (local DB)", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let catalog: typeof import("../supplier-catalog.service").supplierCatalogService;
  let importer: typeof import("../traveldesk-import.service").traveldeskImportService;
  let listings: typeof import("../traveldesk-listing.service").traveldeskListingService;
  let activities: typeof import("../activity.service").activityService;
  let importService: typeof import("../import.service").importService;
  let settings: typeof import("../../repositories/settings.repo").settingsRepo;
  let lookupRetiredSlug: typeof import("@/lib/catalog/redirects").lookupRetiredSlug;
  const saved = new Map<string, unknown>();
  const TOUR = BASE;
  const TOUR_LINKED = BASE + 100;
  const A = TOUR + 1;
  const B = TOUR + 2;
  const C = TOUR + 3;
  const D = TOUR_LINKED + 1;
  let supplierId = "";
  let category = "";
  let oldId = "";
  let linkedId = "";
  const oldSlug = `zz-test-${RUN}-old-cruise`;

  async function makeProduct(slug: string, title: string) {
    const created = await activities.create(admin, {
      slug,
      title,
      subtitle: "An older synthetic page.",
      tier: "B",
      categorySlug: category,
      secondaryCategorySlugs: [],
      collectionSlugs: [],
      images: [`img:activity:${slug}:0`],
      imageAlt: title,
      durationMinutes: 120,
      isPrivate: false,
      pickupIncluded: false,
      pickupZones: [],
      confirmation: "manual",
      fulfilmentMode: "inquiry",
      freeCancellationHours: 24,
      mobileVoucher: true,
      dietary: [],
      suitability: [],
      location: "Dubai Creek",
      meetingPoint: "Dhow wharf",
      timeSlots: [],
      price: { adult: { aed: 150, inr: 3600 } },
      inclusions: ["Dinner"],
      exclusions: [],
      itinerary: [],
      importantInfo: [],
      cancellationPolicy: "Free cancellation up to 24 hours before the start.",
      variants: [],
      addOns: [],
      faqs: [],
      relatedSlugs: [],
      comboSlugs: [],
      supplier: { id: "outlyy-direct", name: "OUTLYY direct", source: "direct", reliability: 90, verifiedSince: "2026" },
      badges: {},
      seo: { title, description: "An older synthetic page.", keywords: [] },
    });
    await activities.setStatus(admin, created.id, "published");
    return created.id;
  }

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    ({ supplierCatalogService: catalog } = await import("../supplier-catalog.service"));
    ({ traveldeskImportService: importer } = await import("../traveldesk-import.service"));
    ({ traveldeskListingService: listings } = await import("../traveldesk-listing.service"));
    ({ activityService: activities } = await import("../activity.service"));
    ({ importService } = await import("../import.service"));
    ({ settingsRepo: settings } = await import("../../repositories/settings.repo"));
    ({ lookupRetiredSlug } = await import("@/lib/catalog/redirects"));
    for (const k of SETTING_KEYS) saved.set(k, (await prisma.setting.findUnique({ where: { key: k } }))?.value ?? null);
    const now = Date.now();
    await settings.set("pricing.margin_policy", { version: 1, floorBps: 1500, effectiveFrom: new Date(now - 86_400_000).toISOString() });
    await settings.set("pricing.margin_cost_inputs", { version: 1, source: "zz synthetic", recordedAt: new Date(now - 86_400_000).toISOString(), lines: [{ name: "gateway", kind: "percent_of_charge", bps: 250 }] });
    await settings.set("pricing.fx_inr_per_aed", { version: 1, inrPerAed: "24.10", source: "zz synthetic", recordedAt: new Date(now - 86_400_000).toISOString(), expiresAt: new Date(now + 7 * 86_400_000).toISOString() });
    await settings.set("pricing.listing_rule", { version: 1, targetBps: 1700, recordedAt: new Date(now - 86_400_000).toISOString() });
    category = (await prisma.category.findFirstOrThrow({ where: { deletedAt: null }, select: { slug: true } })).slug;

    await catalog.syncTravelDeskCatalogue(
      source([
        wireTour(TOUR, `zz test ${RUN} Evening Dhow Cruise TD-4411`, [wireOffer(A, 1200), wireOffer(B, 1200, { numberOfHours: 3 }), wireOffer(C, 1200, { bookingType: 0 })]),
        wireTour(TOUR_LINKED, `zz test ${RUN} Linked Cruise`, [wireOffer(D, 1080)]),
      ]),
      "test",
      { supplierCode: CODE, lane: LANE },
    );
    supplierId = (await prisma.supplier.findUniqueOrThrow({ where: { code: CODE } })).id;
    oldId = await makeProduct(oldSlug, "Old synthetic dhow cruise");
    // An already-linked listing (adopt in place): its one option maps one to one to offer D.
    linkedId = await makeProduct(`zz-test-${RUN}-linked`, "Linked synthetic cruise");
    const offer = await prisma.supplierCatalogueItem.findFirstOrThrow({ where: { supplierId, kind: "offer", externalId: String(D) } });
    const tour = await prisma.supplierCatalogueItem.findFirstOrThrow({ where: { supplierId, kind: "tour", externalId: String(TOUR_LINKED) } });
    await prisma.productSupplierMapping.create({
      data: { id: uuidv7(), productId: linkedId, supplierId, variantCode: null, externalRef: { tourId: TOUR_LINKED, offerId: D, bookingKind: "live_book", isExternal: false }, supplierProductId: String(TOUR_LINKED), supplierOfferId: String(D), bookingKind: "live_book", environment: "test", syncStatus: "ok", approvedOfferHash: offerTermsHash(offer.payload, tour.payload), approvedSlotHours: 2 },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    const products = await prisma.product.findMany({ where: { slug: { startsWith: `zz-test-${RUN}` } }, select: { id: true } });
    const ids = products.map((p) => p.id);
    await prisma.productRedirect.deleteMany({ where: { OR: [{ oldProductId: { in: ids } }, { targetProductId: { in: ids } }] } });
    await prisma.supplierListingLink.deleteMany({ where: { productId: { in: ids } } });
    await prisma.supplierMappingCandidate.deleteMany({ where: { productId: { in: ids } } });
    await prisma.productSupplierMapping.deleteMany({ where: { productId: { in: ids } } });
    await prisma.importBatch.deleteMany({ where: { sourceRef: { contains: CODE } } });
    await prisma.productEligibility.deleteMany({ where: { productId: { in: ids } } });
    await prisma.product.deleteMany({ where: { id: { in: ids } } });
    if (supplierId) {
      await prisma.supplierTourContent.deleteMany({ where: { supplierId } });
      await prisma.supplierOfferCapability.deleteMany({ where: { supplierId } }).catch(() => {});
      await prisma.supplierCatalogueItem.deleteMany({ where: { supplierId } });
      await prisma.supplierSyncRun.deleteMany({ where: { supplierCode: CODE } }).catch(() => {});
      await prisma.supplier.delete({ where: { id: supplierId } }).catch(() => {});
    }
    for (const [k, v] of saved) {
      if (v === null) await prisma.setting.deleteMany({ where: { key: k } });
      else await settings.set(k, v);
    }
    await prisma.$disconnect();
  });

  let batchId = "";
  let instantLinkId = "";
  let inquiryLinkId = "";
  let instantId = "";
  let instantSlug: string | null = null;

  it("previews S0: one instant listing of two options, one inquiry listing (D4), one adoption; no net in the batch", async () => {
    const p = await importer.preview(admin, "test", "S0", { supplierCode: CODE });
    batchId = p.batchId;
    const mine = p.rows.filter((r) => r.identity.tourId === TOUR || r.identity.tourId === TOUR_LINKED);
    expect(mine.map((r) => [r.identity.tourId, r.identity.kind, r.action, r.options.map((o) => o.offerId)])).toEqual([
      [TOUR, "instant", "create", [A, B]],
      [TOUR, "inquiry", "create", [C]],
      [TOUR_LINKED, "instant", "adopt", [D]],
    ]);
    const instant = mine[0];
    expect(instant.input).toMatchObject({ fulfilmentMode: "inquiry", confirmation: "instant", freeCancellationHours: 0, timeSlots: ["20:00"], location: PENDING_TEXT });
    expect(instant.input!.title).toBe(`zz test ${RUN} Evening Dhow Cruise`);
    expect(instant.input!.variants.map((v) => v.name)).toEqual(["Shared · 2 hours · meet at the venue", "Shared · 3 hours · meet at the venue"]);
    expect(instant.input!.relatedSlugs).toContain(mine[1].slug);
    const stored = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(stored.source).toBe("traveldesk");
    for (const n of NET_NEEDLES) expect(JSON.stringify(stored.preview)).not.toContain(n);
  });

  it("refuses the apply when an offer was linked after the preview, and leaves the batch failed", async () => {
    const p = await importer.preview(admin, "test", "S0", { supplierCode: CODE });
    const tmp = await prisma.productSupplierMapping.create({ data: { id: uuidv7(), productId: oldId, supplierId, variantCode: `zz-${RUN}`, externalRef: {}, supplierOfferId: String(A), environment: "test", isActive: true } });
    await expect(importer.apply(admin, p.batchId, { photos: null })).rejects.toSatisfy((e) => code(e) === "CONFLICT");
    await prisma.productSupplierMapping.delete({ where: { id: tmp.id } });
    expect((await prisma.importBatch.findUniqueOrThrow({ where: { id: p.batchId } })).status).toBe("failed");
  });

  it("applies: drafts in inquiry mode, exact links written as a reviewed approval would, copied photos, no net anywhere", async () => {
    const store = new MemoryPhotoStore();
    const r = await importer.apply(admin, batchId, { photos: fakePhotos(store) });
    expect(r.created.map((c) => c.slug).filter((s) => s.startsWith(`zz-test-${RUN}`))).toHaveLength(2);
    expect(r.adopted.map((a) => a.productId)).toContain(linkedId);
    const links = await prisma.supplierListingLink.findMany({ where: { supplierId, deactivatedAt: null }, include: { product: true } });
    const instant = links.find((l) => l.kind === "instant" && l.tourExternalId === String(TOUR))!;
    const inquiry = links.find((l) => l.kind === "inquiry")!;
    const adopted = links.find((l) => l.adopted)!;
    instantLinkId = instant.id;
    inquiryLinkId = inquiry.id;
    instantId = instant.productId;
    instantSlug = instant.product.slug;
    expect(instant).toMatchObject({ noindex: true, reviewedAt: null, classKey: "live.fixed_slot_single.self.internal.per_person", startMinutes: [1200], splitNumber: 1, pricingRuleVersion: 1, importBatchId: batchId });
    expect(instant.pendingFields).toEqual(["location", "meetingPoint", "tier", "categorySlug"]);
    expect(instant.product).toMatchObject({ status: "draft", fulfilmentMode: "inquiry", deletedAt: null });
    expect((instant.product.content as { images: string[] }).images).toEqual([...store.objects.keys()].map((k) => store.publicUrl(k)));
    expect(inquiry.route).toBe("internal");
    expect((inquiry.product.content as { confirmation: string }).confirmation).toBe("manual");
    expect(adopted).toMatchObject({ productId: linkedId, noindex: false });
    expect(adopted.reviewedAt).not.toBeNull();

    // One approved candidate, one mapping and one approve audit row per option, the mapping as reviewCandidate writes it.
    const maps = await prisma.productSupplierMapping.findMany({ where: { productId: instantId, supplierOfferId: { not: null } }, orderBy: { variantCode: "asc" } });
    expect(maps.map((m) => [m.variantCode, m.supplierOfferId, m.isActive, m.syncStatus])).toEqual([
      [`td-${A}`, String(A), true, "ok"],
      [`td-${B}`, String(B), true, "ok"],
    ]);
    const tourRow = await prisma.supplierCatalogueItem.findFirstOrThrow({ where: { supplierId, kind: "tour", externalId: String(TOUR) } });
    for (const m of maps) {
      const offer = await prisma.supplierCatalogueItem.findFirstOrThrow({ where: { supplierId, kind: "offer", externalId: m.supplierOfferId! } });
      expect(m.approvedOfferHash).toBe(offerTermsHash(offer.payload, tourRow.payload));
      expect(m.approvedSlotHours).toBe(m.supplierOfferId === String(A) ? 2 : 3);
    }
    const candidates = await prisma.supplierMappingCandidate.findMany({ where: { productId: instantId } });
    expect(candidates.every((c) => c.source === "import" && c.state === "approved" && c.mappingId)).toBe(true);
    const approvals = await prisma.auditLog.findMany({ where: { entityId: instantId, action: "supplier_mapping.approve" } });
    expect(approvals).toHaveLength(2);

    // The net never enters content, versions or audit rows.
    const versions = await prisma.productVersion.findMany({ where: { productId: { in: [instantId, inquiry.productId] } } });
    const audits = await prisma.auditLog.findMany({ where: { entityId: { in: [instantId, inquiry.productId, batchId] } } });
    const blob = JSON.stringify([links.map((l) => l.product.content), versions, audits, links], (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const n of NET_NEEDLES) expect(blob).not.toContain(n);
  });

  it("imports nothing the second time", async () => {
    const again = await importer.preview(admin, "test", "S0", { supplierCode: CODE });
    const mine = again.rows.filter((r) => r.identity.tourId === TOUR || r.identity.tourId === TOUR_LINKED);
    expect(mine.map((r) => r.action)).toEqual(["skip", "skip", "skip"]);
  });

  it("round-trips imported listings through the spreadsheet (D13): export, edit, preview, apply", async () => {
    const { csv, rows } = await listings.exportCsv(admin, { batchId });
    expect(rows).toBe(3);
    expect(csv).toContain(instantSlug!);
    const preview = await importService.preview(admin, { source: "csv", text: csv, fileName: "zz-roundtrip.csv" });
    expect(preview.rowsFailed).toBe(0);
    expect(preview.rows.every((r) => r.action === "update")).toBe(true);
    const r = await importService.apply(admin, preview.batchId, { publish: true, reason: "zz synthetic round trip" });
    // An unreviewed import is held as a draft even when the sheet asks to publish.
    expect(r.heldForReview).toContain(instantSlug);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: instantId } });
    expect(after.status).toBe("draft");
    const doc = after.content as { variants: { id: string; units?: unknown[] }[] };
    expect(doc.variants.map((v) => [v.id, v.units?.length])).toEqual([
      [`td-${A}`, 3],
      [`td-${B}`, 3],
    ]);
    // The import's own version stays the lock baseline; the round trip changed no editorial field.
    const link = await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: instantLinkId } });
    expect(link.importVersion).toBe(1);
  });

  it("the generic publish refuses an unreviewed import; review refuses placeholders and shared sibling copy", async () => {
    await expect(activities.setStatus(admin, instantId, "published")).rejects.toSatisfy((e) => code(e) === "CONFLICT");
    expect((await activities.bulkSetStatus(admin, { ids: [instantId] }, "published")).changed).toBe(0);
    await expect(listings.markReviewed(admin, instantLinkId, { replacesProductId: oldId, confirmTierAndCategory: true, note: "copy and facts checked" })).rejects.toSatisfy((e) => code(e) === "VALIDATION_FAILED");

    const current = await activities.get(admin, instantId);
    const { id: _i, rating: _r, reviewCount: _c, bookedThisMonth: _b, ...input } = current.content;
    await activities.update(admin, instantId, { ...input, location: "Dubai Creek", meetingPoint: "Al Seef dhow wharf" }, { expectedVersion: current.version });
    // Same subtitle as the inquiry sibling: own copy first.
    await expect(listings.markReviewed(admin, instantLinkId, { replacesProductId: oldId, confirmTierAndCategory: true, note: "copy and facts checked" })).rejects.toSatisfy((e) => code(e) === "VALIDATION_FAILED");
    const v2 = await activities.get(admin, instantId);
    const { id: _i2, rating: _r2, reviewCount: _c2, bookedThisMonth: _b2, ...input2 } = v2.content;
    await activities.update(admin, instantId, { ...input2, subtitle: "A sunset dhow cruise with dinner, at a fixed start." }, { expectedVersion: v2.version });
    await expect(listings.markReviewed(admin, instantLinkId, { replacesProductId: oldId, confirmTierAndCategory: false, note: "copy and facts checked" })).rejects.toSatisfy((e) => isAppError(e));
    const reviewed = await listings.markReviewed(admin, instantLinkId, { replacesProductId: oldId, confirmTierAndCategory: true, note: "copy and facts checked" });
    expect(reviewed).toMatchObject({ noindex: false, replacesProductId: oldId, pendingFields: [] });
    expect(reviewed.lockedFields).toEqual(["subtitle"]);
  });

  it("publishes the reviewed listing and retires the old page with a permanent redirect; an unreviewed one is stopped", async () => {
    const res = await listings.publish(admin, [instantLinkId, inquiryLinkId], "publish S0 synthetic batch");
    expect(res[0]).toMatchObject({ outcome: "published", retired: oldSlug });
    expect(res[1]).toMatchObject({ outcome: "stopped", reason: "not marked reviewed" });
    const old = await prisma.product.findUniqueOrThrow({ where: { id: oldId } });
    expect(old.deletedAt).not.toBeNull();
    const target = await prisma.product.findUniqueOrThrow({ where: { id: instantId } });
    expect(target.status).toBe("published");
    expect(await lookupRetiredSlug(oldSlug)).toEqual({ to: `/activities/${target.slug}`, permanent: true });

    // The redirect is permanent only while the target is published and indexable.
    await prisma.product.update({ where: { id: instantId }, data: { status: "draft" } });
    expect(await lookupRetiredSlug(oldSlug)).toEqual({ to: `/categories/${old.categorySlug}`, permanent: false });
    await prisma.product.update({ where: { id: instantId }, data: { status: "published" } });
  });

  it("rolls the batch back by id: listings deleted, links and mappings deactivated, the old page restored and its redirect removed", async () => {
    const r = await importer.rollback(admin, batchId, "synthetic rollback of the S0 batch");
    expect(r).toMatchObject({ rolledBack: 2, restored: 1 });
    const old = await prisma.product.findUniqueOrThrow({ where: { id: oldId } });
    expect(old).toMatchObject({ deletedAt: null, status: "published" });
    expect(await prisma.productRedirect.count({ where: { oldProductId: oldId } })).toBe(0);
    expect(await lookupRetiredSlug(oldSlug)).toBeNull();
    const target = await prisma.product.findUniqueOrThrow({ where: { id: instantId } });
    expect(target.deletedAt).not.toBeNull();
    expect(await prisma.productSupplierMapping.count({ where: { productId: instantId, isActive: true, supplierOfferId: { not: null } } })).toBe(0);
    const links = await prisma.supplierListingLink.findMany({ where: { importBatchId: batchId } });
    expect(links.length).toBe(3);
    expect(links.every((l) => l.deactivatedAt !== null)).toBe(true);
    // The adopted listing is untouched.
    expect((await prisma.product.findUniqueOrThrow({ where: { id: linkedId } })).deletedAt).toBeNull();
  });

  it("re-imports after a rollback, and the generic revert undoes an unchanged TravelDesk batch", async () => {
    const p = await importer.preview(admin, "test", "S0", { supplierCode: CODE });
    const mine = p.rows.filter((r) => r.identity.tourId === TOUR);
    expect(mine.map((r) => r.action)).toEqual(["create", "create"]);
    await importer.apply(admin, p.batchId, { photos: null });
    const r = await importService.revert(admin, p.batchId);
    expect(r.reverted).toBeGreaterThanOrEqual(2);
    expect(await prisma.supplierListingLink.count({ where: { importBatchId: p.batchId, deactivatedAt: null } })).toBe(0);
  });
});
