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
 * this suite writes is deleted again (a missing row reads as off). Synthetic
 * ids and amounts only.
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
    // Nothing left over from an earlier failed run of this suite.
    await prisma.supplierCapabilityFlag.deleteMany({ where: { adapter: "traveldesk", classKey: SELF } });
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
    await prisma.supplierCapabilityFlag.deleteMany({ where: { adapter: "traveldesk", classKey: SELF } });
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
    await prisma.supplierCapabilityFlag.create({ data: { id: uuidv7(), adapter: "traveldesk", environment: "test", classKey: SELF, enabled: true, requiresOfferEvidence: true, reason: "zz date-only db test" } });
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
    await prisma.supplierCapabilityFlag.updateMany({ where: { adapter: "traveldesk", environment: "test", classKey: SELF }, data: { enabled: false } });
    const off = await readiness();
    expect(off.blockers).toContain("slot_rules_unknown");
    expect(off.mapping).toMatchObject({ dateOnlySellable: false });
  });
});
