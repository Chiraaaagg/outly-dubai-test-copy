import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import type { Actor } from "../../lib/actor";
import { isAppError } from "../../lib/errors";
import { uuidv7 } from "../../lib/ids";
import { readLimits } from "../../suppliers/read-budget";
import { tourDetailFrom, tourDetailsWire, type TravelDeskTourDetail, type TravelDeskTourSummary } from "../../suppliers/traveldesk/traveldesk.codec";
import { offerTermsHash } from "../../suppliers/traveldesk/traveldesk.offer-terms";

/**
 * Doc 30 N0 against the LOCAL disposable test database: the catalogue sync
 * stores tour content in `supplier_tour_content` without changing the stored
 * tour payload or an approved mapping's terms hash, and the dry-run report is
 * read-only and needs `suppliers.costs.view`.
 *
 * Rows live under a run-scoped supplier code and `zz-test-` slugs and are
 * removed in afterAll. The TravelDesk source is a fake built from synthetic
 * wire JSON: no network. Nets are invented round numbers.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const RUN = uuidv7().slice(-8);
const CODE = `zz-tdn0-${RUN}`;
const BASE = 930_000_000 + Math.floor(Math.random() * 60_000_000);
const LANE = { readLimits: readLimits(100_000) };

const admin: Actor = { type: "admin", id: uuidv7(), roles: ["admin"], permissions: new Set(["*"]) };
const finance: Actor = { type: "admin", id: uuidv7(), roles: ["finance"], permissions: new Set(["suppliers.costs.view"]) };
const ops: Actor = { type: "admin", id: uuidv7(), roles: ["ops"], permissions: new Set(["suppliers.manage"]) };

function period(adult: number, child: number) {
  return {
    id: 1,
    offerId: 1,
    currency: "AED",
    recPricePerAdult: null,
    recPricePerChild: null,
    recPricePerTrip: null,
    pricePerAdult: adult,
    pricePerChild: child,
    pricePerTrip: 0,
    pricePerAdultUsd: 0,
    pricePerChildUsd: 0,
    pricePerTripUsd: 0,
    discountPercent: null,
    supplierCurrencyCode: null,
    conversionRate: null,
    vat: null,
    dateStart: "2024-01-01T00:00:00",
    dateEnd: null,
  };
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
    pricingPeriods: [period(100, 80)],
    isDirectReporting: true,
    description: null,
    timeSlots: [{ id: 1, name: null, startTime: start, endTime: start + 120, daysOffered: 0, isAnyTime: false, isOnRequest: false, minimumAdvancedBooking: 12 }],
    bookingType: 1,
    isExternal: false,
    tripUnit: null,
    ...over,
  };
}

function wireTour(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    name: `zz synthetic tour ${id}`,
    language: "English",
    isExternal: false,
    cancellationPolicy: [{ hours: 24, percents: 100 }],
    categories: [],
    termsAndConditions: "<p>Bring photo ID.</p>",
    salesDescription: "<p>A <b>synthetic</b> evening cruise.</p><script>alert(1)</script>",
    faqList: [{ question: "Dinner?", answer: "<p>Buffet</p>" }],
    itineraries: [{ title: "Boarding" }],
    photos: [{ id: 7, srcSet: [{ type: "image/webp", sizes: [{ src: "https://media.example.test/7-hd.webp", width: 1280, height: 720 }] }] }],
    videoUrl: null,
    offers: [wireOffer(id + 1, 1200), wireOffer(id + 2, 540)],
    ...over,
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

describe.skipIf(!enabled)("TravelDesk content and dry run, N0 (local DB)", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let catalog: typeof import("../supplier-catalog.service").supplierCatalogService;
  let dryRun: typeof import("../traveldesk-dry-run.service").traveldeskDryRunService;
  const TOUR = BASE;

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    ({ supplierCatalogService: catalog } = await import("../supplier-catalog.service"));
    ({ traveldeskDryRunService: dryRun } = await import("../traveldesk-dry-run.service"));
  });

  afterAll(async () => {
    if (!prisma) return;
    const sup = await prisma.supplier.findUnique({ where: { code: CODE } });
    if (sup) {
      await prisma.productSupplierMapping.deleteMany({ where: { supplierId: sup.id } });
      await prisma.supplierTourContent.deleteMany({ where: { supplierId: sup.id } });
      await prisma.supplierCatalogueItem.deleteMany({ where: { supplierId: sup.id } });
      await prisma.supplier.delete({ where: { id: sup.id } });
    }
    await prisma.product.deleteMany({ where: { slug: { startsWith: `zz-test-${RUN}` } } });
    await prisma.$disconnect();
  });

  it("stores sanitised content apart and leaves the tour payload and an approved hash unchanged", async () => {
    const first = await catalog.syncTravelDeskCatalogue(source([wireTour(TOUR)]), "test", { supplierCode: CODE, lane: LANE });
    expect(first).toMatchObject({ tours: 1, offers: 2, contentStored: 1, contentChanged: 1 });
    expect(first.contentFailed).toBeUndefined();

    const sup = await prisma.supplier.findUniqueOrThrow({ where: { code: CODE } });
    const row = await prisma.supplierTourContent.findUniqueOrThrow({ where: { supplierId_environment_tourExternalId: { supplierId: sup.id, environment: "test", tourExternalId: String(TOUR) } } });
    expect(row.salesDescription).toBe("A synthetic evening cruise.");
    expect(row.terms).toBe("Bring photo ID.");
    expect(row.faq).toEqual([{ question: "Dinner?", answer: "Buffet" }]);
    expect((row.photos as { variants: { url: string }[] }[])[0].variants[0].url).toBe("https://media.example.test/7-hd.webp");
    expect(row.schemaVersion).toBe(1);

    const tourRow = await prisma.supplierCatalogueItem.findUniqueOrThrow({ where: { supplierId_environment_kind_externalId: { supplierId: sup.id, environment: "test", kind: "tour", externalId: String(TOUR) } } });
    expect(Object.keys(tourRow.payload as object)).not.toContain("content");
    const offerRow = await prisma.supplierCatalogueItem.findUniqueOrThrow({ where: { supplierId_environment_kind_externalId: { supplierId: sup.id, environment: "test", kind: "offer", externalId: String(TOUR + 1) } } });
    const approved = offerTermsHash(offerRow.payload, tourRow.payload);
    expect(approved).toMatch(/^[0-9a-f]{64}$/);

    // An approved mapping on the offer, then new supplier text and photos: content changes, terms and status do not.
    const any = await prisma.product.findFirstOrThrow({ select: { categorySlug: true } });
    const productId = uuidv7();
    await prisma.product.create({
      data: { id: productId, slug: `zz-test-${RUN}-old`, title: "Old synthetic page", tier: "B", status: "draft", categorySlug: any.categorySlug, confirmation: "instant", content: {} },
    });
    await prisma.productSupplierMapping.create({
      data: {
        id: uuidv7(),
        productId,
        supplierId: sup.id,
        variantCode: null,
        externalRef: { tourId: TOUR, offerId: TOUR + 1, bookingKind: "live_book", isExternal: false },
        supplierProductId: String(TOUR),
        supplierOfferId: String(TOUR + 1),
        bookingKind: "live_book",
        environment: "test",
        syncStatus: "ok",
        approvedOfferHash: approved,
        approvedSlotHours: 2,
      },
    });
    const second = await catalog.syncTravelDeskCatalogue(
      source([wireTour(TOUR, { salesDescription: "Rewritten text", photos: [], faqList: [{ unknownField: 1 }] })]),
      "test",
      { supplierCode: CODE, lane: LANE },
    );
    expect(second).toMatchObject({ contentStored: 1, contentChanged: 1, mappingsChanged: 0 });
    const mapping = await prisma.productSupplierMapping.findFirstOrThrow({ where: { productId } });
    expect(mapping.syncStatus).toBe("ok");
    expect(mapping.approvedOfferHash).toBe(approved);
    const tourAfter = await prisma.supplierCatalogueItem.findUniqueOrThrow({ where: { id: tourRow.id } });
    expect(offerTermsHash(offerRow.payload, tourAfter.payload)).toBe(approved);
    const after = await prisma.supplierTourContent.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.salesDescription).toBe("Rewritten text");
    expect(after.faq).toEqual([]);
    expect(after.warnings).toEqual(["faq 1: unknown shape (unknownField)"]);
    expect(after.firstFetchedAt.getTime()).toBe(row.firstFetchedAt.getTime());

    // The same content again only moves the fetch time.
    const third = await catalog.syncTravelDeskCatalogue(
      source([wireTour(TOUR, { salesDescription: "Rewritten text", photos: [], faqList: [{ unknownField: 1 }] })]),
      "test",
      { supplierCode: CODE, lane: LANE },
    );
    expect(third).toMatchObject({ contentStored: 1 });
    expect(third.contentChanged).toBeUndefined();
    const unchanged = await prisma.supplierTourContent.findUniqueOrThrow({ where: { id: row.id } });
    expect(unchanged.changedAt.getTime()).toBe(after.changedAt.getTime());

    // Review 103 N0-03: an older, slower run writing after a newer one never moves times back or trips stc_times_check.
    const earlier = new Date(unchanged.fetchedAt.getTime() - 3_600_000);
    for (const text of ["Rewritten text", "Older run's text"]) {
      const late = await catalog.syncTravelDeskCatalogue(source([wireTour(TOUR, { salesDescription: text, photos: [], faqList: [{ unknownField: 1 }] })]), "test", {
        supplierCode: CODE,
        lane: LANE,
        now: () => earlier,
      });
      expect(late.contentFailed).toBeUndefined();
      expect(late.contentStored).toBe(1);
    }
    const late = await prisma.supplierTourContent.findUniqueOrThrow({ where: { id: row.id } });
    expect(late.fetchedAt.getTime()).toBe(unchanged.fetchedAt.getTime());
    expect(late.changedAt.getTime()).toBe(earlier.getTime());
    expect(late.salesDescription).toBe("Older run's text");
  });

  it("the dry run needs suppliers.costs.view and writes nothing", async () => {
    await expect(dryRun.report(ops, "test", { supplierCode: CODE })).rejects.toSatisfy((e: unknown) => isAppError(e) && e.code === "FORBIDDEN");

    const sup = await prisma.supplier.findUniqueOrThrow({ where: { code: CODE } });
    const counts = async () =>
      Promise.all([
        prisma.supplierCatalogueItem.count({ where: { supplierId: sup.id } }),
        prisma.supplierTourContent.count({ where: { supplierId: sup.id } }),
        prisma.productSupplierMapping.count({ where: { supplierId: sup.id } }),
        prisma.product.count({ where: { slug: { startsWith: `zz-test-${RUN}` } } }),
      ]);
    const before = await counts();
    const report = await dryRun.report(finance, "test", { supplierCode: CODE });
    expect(await counts()).toEqual(before);

    // Two fixed-start options with different start times: one tour and key, two listings.
    const s0 = report.steps.find((s) => s.id === "S0")!;
    expect(s0).toMatchObject({ offers: 2, instantListingsByTourAndKey: 1, instantListings: 2, extraForStartTimes: 1, alreadyLinkedOffers: 1 });
    const listings = report.listings.filter((l) => l.tourId === TOUR);
    expect(listings.map((l) => [l.splitNumber, l.startTimes])).toEqual([
      [1, ["09:00"]],
      [2, ["20:00"]],
    ]);
    expect(listings[1].options[0].linkedTo.map((l) => l.slug)).toEqual([`zz-test-${RUN}-old`]);
    expect(listings[1].adoptProduct?.slug).toBe(`zz-test-${RUN}-old`);
    expect(listings[0].freeCancellationDropped).toBe(true);
    expect(listings[0].content).toMatchObject({ hasDescription: true, photos: 0, faq: 0, itinerary: 1, warnings: 1 });
    expect(listings[0].options[0].netAedMinor).toMatchObject({ adult: "10000", child: "8000" });
    expect(report.toursWithContent).toBe(1);
    expect(report.supplierCode).toBe(CODE);
  });
});
