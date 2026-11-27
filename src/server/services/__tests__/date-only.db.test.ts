import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import { uuidv7 } from "../../lib/ids";
import { storedOffer, storedTour } from "../../suppliers/__tests__/fixtures/traveldesk-terms";
import { offerTermsHash } from "../../suppliers/traveldesk/traveldesk.offer-terms";

/**
 * Doc 29 Batch 7 against the LOCAL disposable database: the mapping half of
 * readiness (`supplierCatalogService.mappingReadinessFor`) for a live-book
 * offer with no slot metadata. With its date-only key off (no flag row, the
 * default) the `slot_rules_unknown` blocker stays, exactly as before; with
 * the flag on and evidence for the key and current terms it is replaced by
 * the gated path (`dateOnlySellable`). The target guard refuses anything but
 * the disposable test database. Rows live under a run-scoped supplier code
 * and a `zz-test-` product slug and are removed in afterAll; the flag row
 * rows this suite writes are deleted again by their own ids (a missing row
 * reads as off), and it refuses to start if a row for the key exists already
 * (review 92 B7-10). Synthetic ids and amounts only.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const RUN = uuidv7().slice(-8);
const CODE = `zz-b7-${RUN}`;
const BASE = 910_000_000 + Math.floor(Math.random() * 40_000_000);
const SELF = "live.date_only_no_slot_metadata.self.internal.per_person";

describe.skipIf(!enabled)("date-only readiness (doc 29 Batch 7, local DB)", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let catalog: typeof import("../supplier-catalog.service").supplierCatalogService;
  let supplierId: string;
  let productId: string;
  let flagId: string | null = null;
  const TOUR = BASE;
  const OFFER = BASE + 1;
  const offerPayload = storedOffer({ offerId: OFFER, tourId: TOUR, timeSlots: [], durationHours: 3 });
  const tourPayload = storedTour({ tourId: TOUR });
  const terms = offerTermsHash(offerPayload, tourPayload)!;
  const readiness = async () => (await catalog.mappingReadinessFor(productId, "test", { supplierCode: CODE })).variants[0];

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    ({ supplierCatalogService: catalog } = await import("../supplier-catalog.service"));
    // Review 92 B7-10: a row for this key on the shared local database is not ours to delete; refuse to start instead.
    if (await prisma.supplierCapabilityFlag.count({ where: { adapter: "traveldesk", environment: "test", classKey: SELF } })) {
      throw new Error("a test-environment flag row for the date-only key already exists on this database; this suite will not change it");
    }
    supplierId = uuidv7();
    await prisma.supplier.create({ data: { id: supplierId, code: CODE, name: "zz date-only test", source: "api", adapter: "traveldesk" } });
    for (const [kind, externalId, parent, payload] of [
      ["tour", String(TOUR), null, tourPayload],
      ["offer", String(OFFER), String(TOUR), offerPayload],
    ] as const) {
      await prisma.supplierCatalogueItem.create({
        data: { id: uuidv7(), supplierId, environment: "test", kind, externalId, parentExternalId: parent, name: `zz b7 ${kind}`, bookingKind: kind === "offer" ? "live_book" : null, payload: payload as never, payloadHash: "x" },
      });
    }
    const any = await prisma.product.findFirstOrThrow({ select: { categorySlug: true } });
    productId = uuidv7();
    await prisma.product.create({
      data: { id: productId, slug: `zz-test-${RUN}-b7`, title: "zz date-only product", tier: "C", status: "draft", categorySlug: any.categorySlug, confirmation: "instant", content: {} },
    });
    await prisma.productSupplierMapping.create({
      data: {
        id: uuidv7(),
        productId,
        supplierId,
        variantCode: null,
        externalRef: { tourId: TOUR, offerId: OFFER, bookingKind: "live_book", isExternal: false },
        supplierProductId: String(TOUR),
        supplierOfferId: String(OFFER),
        bookingKind: "live_book",
        environment: "test",
        syncStatus: "ok",
        approvedOfferHash: terms,
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    // Only the row this suite created, by its id.
    if (flagId) await prisma.supplierCapabilityFlag.deleteMany({ where: { id: flagId } });
    await prisma.productSupplierMapping.deleteMany({ where: { supplierId } });
    await prisma.supplierCatalogueItem.deleteMany({ where: { supplierId } });
    // Evidence rows cascade with the supplier.
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    await prisma.product.deleteMany({ where: { slug: { startsWith: `zz-test-${RUN}` } } });
    await prisma.$disconnect();
  });

  it("with the key off (no flag row) the blocker stays, as before Batch 7", async () => {
    const v = await readiness();
    expect(v.blockers).toEqual(expect.arrayContaining(["slot_rules_unknown", "capability_not_ready"]));
    expect(v.mapping).toMatchObject({ capabilityClassKey: SELF, capabilityRefusal: "flag_off", dateOnlySellable: false, slotStartMinutes: [], anyTimeSlots: false });
  });

  it("the flag on without evidence is still refused, and the blocker stays", async () => {
    flagId = uuidv7();
    await prisma.supplierCapabilityFlag.create({ data: { id: flagId, adapter: "traveldesk", environment: "test", classKey: SELF, enabled: true, requiresOfferEvidence: true, reason: "zz date-only db test" } });
    const v = await readiness();
    expect(v.blockers).toContain("slot_rules_unknown");
    expect(v.mapping).toMatchObject({ capabilityRefusal: "offer_evidence_missing", dateOnlySellable: false });
  });

  it("flag on and evidence for the key and current terms: the gated path replaces slot_rules_unknown", async () => {
    await prisma.supplierOfferEnablement.create({
      data: { id: uuidv7(), supplierId, environment: "test", offerExternalId: String(OFFER), classKey: SELF, evidenceKind: "contract_test", reference: "zz b7 contract test", offerTermsHash: terms },
    });
    const v = await readiness();
    expect(v.blockers).not.toContain("slot_rules_unknown");
    expect(v.blockers).not.toContain("capability_not_ready");
    expect(v.mapping).toMatchObject({ capabilityRefusal: null, dateOnlySellable: true, listedStartsSellable: false });
    // Switched off again: back to the blocker at once.
    await prisma.supplierCapabilityFlag.update({ where: { id: flagId! }, data: { enabled: false } });
    const off = await readiness();
    expect(off.blockers).toContain("slot_rules_unknown");
    expect(off.mapping).toMatchObject({ dateOnlySellable: false });
  });

  it("production is locked until Q5 (owner decision d): the gate refuses even a flag row written straight into the table", async () => {
    // Same offer and mapping, in production; a flag row and evidence written directly, bypassing the service's refusal.
    await prisma.supplierCatalogueItem.createMany({
      data: [
        { id: uuidv7(), supplierId, environment: "production", kind: "tour", externalId: String(TOUR), parentExternalId: null, name: "zz b7 tour", bookingKind: null, payload: tourPayload as never, payloadHash: "x" },
        { id: uuidv7(), supplierId, environment: "production", kind: "offer", externalId: String(OFFER), parentExternalId: String(TOUR), name: "zz b7 offer", bookingKind: "live_book", payload: offerPayload as never, payloadHash: "x" },
      ],
    });
    const prodProduct = uuidv7();
    const any = await prisma.product.findFirstOrThrow({ select: { categorySlug: true } });
    await prisma.product.create({ data: { id: prodProduct, slug: `zz-test-${RUN}-b7-prod`, title: "zz date-only product prod", tier: "C", status: "draft", categorySlug: any.categorySlug, confirmation: "instant", content: {} } });
    await prisma.productSupplierMapping.create({
      data: {
        id: uuidv7(),
        productId: prodProduct,
        supplierId,
        variantCode: null,
        externalRef: { tourId: TOUR, offerId: OFFER, bookingKind: "live_book", isExternal: false },
        supplierProductId: String(TOUR),
        supplierOfferId: String(OFFER),
        bookingKind: "live_book",
        environment: "production",
        syncStatus: "ok",
        approvedOfferHash: terms,
      },
    });
    const prodFlag = uuidv7();
    if (await prisma.supplierCapabilityFlag.count({ where: { adapter: "traveldesk", environment: "production", classKey: SELF } })) throw new Error("a production flag row for the date-only key already exists on this database");
    await prisma.supplierCapabilityFlag.create({ data: { id: prodFlag, adapter: "traveldesk", environment: "production", classKey: SELF, enabled: true, requiresOfferEvidence: true, reason: "zz date-only lock test" } });
    try {
      await prisma.supplierOfferEnablement.create({
        data: { id: uuidv7(), supplierId, environment: "production", offerExternalId: String(OFFER), classKey: SELF, evidenceKind: "production_booking", reference: "zz b7 lock test", offerTermsHash: terms },
      });
      const v = (await catalog.mappingReadinessFor(prodProduct, "production", { supplierCode: CODE })).variants[0];
      expect(v.blockers).toEqual(expect.arrayContaining(["slot_rules_unknown", "capability_not_ready"]));
      expect(v.mapping).toMatchObject({ capabilityRefusal: "class_not_sellable", dateOnlySellable: false });
    } finally {
      await prisma.supplierCapabilityFlag.deleteMany({ where: { id: prodFlag } });
    }
  });
});
