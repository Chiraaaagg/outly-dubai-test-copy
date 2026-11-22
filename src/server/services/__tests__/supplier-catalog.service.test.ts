import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import type { Actor } from "../../lib/actor";
import { isAppError } from "../../lib/errors";
import { uuidv7 } from "../../lib/ids";
import type { TravelDeskOffer, TravelDeskTourDetail, TravelDeskTourSummary } from "../../suppliers/traveldesk/traveldesk.codec";
import { offerTermsHash } from "../../suppliers/traveldesk/traveldesk.offer-terms";
import { assessReadiness, fromCatalogReadiness } from "../readiness.service";
import { fakeMargin, instantDoc, product } from "./_b2-fakes";

/**
 * Catalogue sync, candidate generation and mapping review against the LOCAL
 * test database. Every row lives under a run-scoped supplier code and
 * `zz-test-` product slugs, so the real synced catalogue is never touched, and
 * is removed in afterAll. Audit rows stay (append-only by design).
 *
 * The target guard refuses anything but the disposable test database.
 */

// The authenticator step-up is approval.service's own suite; here it accepts unless a test says otherwise.
vi.mock("../approval.service", async (importOriginal) => ({ ...(await importOriginal<typeof import("../approval.service")>()), verifyStepUp: vi.fn(async () => null) }));

const enabled = Boolean(process.env.DATABASE_URL);
const RUN = uuidv7().slice(-8);
const CODE = `zz-td-${RUN}`;
const BASE = 900_000_000 + Math.floor(Math.random() * 90_000_000);

const admin: Actor = { type: "admin", id: uuidv7(), roles: ["admin"], permissions: new Set(["*"]) };
const content: Actor = { type: "admin", id: uuidv7(), roles: ["content"], permissions: new Set(["products.edit"]) };

function offer(id: number, tourId: number, over: Partial<TravelDeskOffer> = {}): TravelDeskOffer {
  return {
    offerId: id,
    tourId,
    name: "Dinner Cruise, Upper Deck (9.00pm - 10.45pm), Direct Reporting",
    code: null,
    bookingKind: "live_book",
    bookingTypeRaw: 1,
    daysOffered: 0,
    durationHours: 2,
    minPax: 1,
    maxPax: 50,
    paxLimits: { adults: [null, null], children: [null, null], infants: [null, null] },
    privateType: "sharing",
    childrenAllowed: true,
    childAge: 12,
    infantsAllowed: true,
    infantAge: 5,
    isDirectReporting: true,
    isDirectCollection: false,
    isExternal: false,
    tripUnit: null,
    minimumAdvancedPaymentRaw: null,
    timeSlots: [{ timeSlotId: 1, name: null, startMinutes: 1260, endMinutes: 1365, daysOffered: 0, isAnyTime: false, isOnRequest: false, minimumAdvancedBookingHours: 12, isExternal: false }],
    pricingPeriods: [
      {
        periodId: 1,
        dateStart: "2024-01-01",
        dateEnd: null,
        price: {
          currency: "AED",
          date: null,
          isBookable: true,
          perAdultMinor: 12000n,
          perChildMinor: 8000n,
          perTripMinor: 0n,
          perAdultUsdMinor: 3400n,
          perChildUsdMinor: 2300n,
          perTripUsdMinor: 0n,
          recPerAdultMinor: 19000n,
          recPerChildMinor: null,
          recPerTripMinor: null,
          hasDiscount: false,
          vatRaw: 5,
          conversionRateRaw: 3.65,
          supplierCurrencyCode: null,
          roundedFields: [],
        },
      },
    ],
    ...over,
  };
}

function tour(id: number, name: string, offers: TravelDeskOffer[]): TravelDeskTourDetail {
  return {
    tourId: id,
    name,
    categories: [],
    isExternal: false,
    offers,
    cancellationPolicy: [{ moreThanHours: 24, refundPercent: 100 }],
    hasTermsAndConditions: true,
    hasSalesDescription: true,
    faqCount: 0,
    itineraryCount: 0,
    photoCount: 0,
    warnings: [],
  };
}

function source(tours: TravelDeskTourDetail[], failing: number[] = []) {
  return {
    async listTours(): Promise<TravelDeskTourSummary[]> {
      return tours.map((t) => ({ tourId: t.tourId, name: t.name, categories: [] }));
    },
    async getTour(id: number) {
      if (failing.includes(id)) throw new Error("boom");
      const t = tours.find((x) => x.tourId === id);
      if (!t) throw new Error("missing");
      return t;
    },
  };
}

describe.skipIf(!enabled)("supplierCatalogService (local DB)", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let svc: typeof import("../supplier-catalog.service").supplierCatalogService;
  let catalogService: typeof import("../catalog.service").catalogService;
  let readinessService: typeof import("../readiness.service").readinessService;
  let productId: string;
  const TOUR = BASE;
  const OFFER_A = BASE + 1;
  const OFFER_B = BASE + 2;

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    ({ supplierCatalogService: svc } = await import("../supplier-catalog.service"));
    ({ catalogService } = await import("../catalog.service"));
    ({ readinessService } = await import("../readiness.service"));
    const any = await prisma.product.findFirstOrThrow({ select: { categorySlug: true } });
    productId = uuidv7();
    await prisma.product.create({
      data: {
        id: productId,
        slug: `zz-test-${RUN}-dhow`,
        title: "Dhow Cruise Dinner - Marina",
        tier: "B",
        status: "draft",
        categorySlug: any.categorySlug,
        confirmation: "instant",
        durationMinutes: 90,
        content: {
          price: { adult: { inr: 3000, aed: 109 }, child: { inr: 2500, aed: 89 } },
          timeSlots: ["Approx 9.00 pm to 10:30 pm"],
          variants: [
            { id: "wooden", name: "Traditional Wooden Dhow - direct boarding", delta: { inr: 0, aed: 0 } },
            { id: "deluxe", name: "Traditional Wooden Dhow Deluxe - direct boarding", delta: { inr: 1300, aed: 50 } },
          ],
        },
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    const sup = await prisma.supplier.findUnique({ where: { code: CODE } });
    if (sup) {
      await prisma.supplierMappingCandidate.deleteMany({ where: { supplierId: sup.id } });
      await prisma.productSupplierMapping.deleteMany({ where: { supplierId: sup.id } });
      await prisma.supplierPriceSnapshot.deleteMany({ where: { supplierId: sup.id } });
      await prisma.supplierCatalogueItem.deleteMany({ where: { supplierId: sup.id } });
      await prisma.supplier.delete({ where: { id: sup.id } });
    }
    await prisma.productSupplierMapping.deleteMany({ where: { productId } });
    await prisma.supplierMappingCandidate.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { slug: { startsWith: `zz-test-${RUN}` } } });
    await prisma.supplierSyncRun.deleteMany({ where: { supplierCode: CODE } });
    await prisma.$disconnect();
  });

  it("sync stores tours and offers, detects changes, and only a complete pull removes inventory", async () => {
    const t = tour(TOUR, "Alexandra Dhow Cruise in Dubai Marina", [offer(OFFER_A, TOUR), offer(OFFER_B, TOUR, { name: "Dinner Cruise, Lower Deck", pricingPeriods: [] })]);
    const first = await svc.syncTravelDeskCatalogue(source([t]), "test", { supplierCode: CODE });
    expect(first).toMatchObject({ tours: 1, offers: 2, added: 3, removed: 0, removalsApplied: true });

    // Each offer's capability is derived and stored with its provenance (doc 29 Batch 1a).
    const sup = await prisma.supplier.findUniqueOrThrow({ where: { code: CODE } });
    const caps = await prisma.supplierOfferCapability.findMany({ where: { supplierId: sup.id, environment: "test" }, orderBy: { offerExternalId: "asc" } });
    expect(caps.map((c) => [c.offerExternalId, c.classKey, c.reviewReasons])).toEqual([
      [String(OFFER_A), "live.fixed_slot_single.self.internal.per_person", []],
      // No AED price period: the price basis is unknown, so the class is too.
      [String(OFFER_B), "unknown", ["no_aed_price"]],
    ]);
    expect(caps[0]).toMatchObject({ fulfilment: "live", timeShape: "fixed_slot_single", arrival: "self", route: "internal", pricingUnit: "per_person", derivationVersion: 1 });
    expect(caps[0].rawValues).toMatchObject({ bookingTypeRaw: 1, isDirectReporting: true, slotCount: 1, distinctStarts: 1, perPersonPriced: true, perUnitPriced: false });
    expect(caps[0].offerTermsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(caps[0].rawValues)).not.toMatch(/12000|8000/);

    const again = await svc.syncTravelDeskCatalogue(source([t]), "test", { supplierCode: CODE });
    expect(again).toMatchObject({ added: 0, changed: 0, removed: 0 });
    expect(await prisma.supplierOfferCapability.count({ where: { supplierId: sup.id, environment: "test" } })).toBe(2);

    const changed = tour(TOUR, t.name!, [offer(OFFER_A, TOUR, { maxPax: 40 }), t.offers[1]]);
    expect((await svc.syncTravelDeskCatalogue(source([changed]), "test", { supplierCode: CODE })).changed).toBe(1);

    // A failed tour fetch keeps that tour's items (removals are judged per tour, SUP-15).
    const partial = await svc.syncTravelDeskCatalogue(source([changed], [TOUR]), "test", { supplierCode: CODE });
    expect(partial).toMatchObject({ failedTours: [TOUR], removed: 0 });

    // An empty tour list (upstream glitch) never removes anything.
    const empty = await svc.syncTravelDeskCatalogue(source([]), "test", { supplierCode: CODE });
    expect(empty).toMatchObject({ removalsApplied: false, removalsSkipped: "empty_tour_list", removed: 0 });

    // Losing more than 20% of live items at once is treated as suspicious and skipped.
    const withoutB = tour(TOUR, t.name!, [changed.offers[0]]);
    const suspicious = await svc.syncTravelDeskCatalogue(source([withoutB]), "test", { supplierCode: CODE });
    expect(suspicious).toMatchObject({ removalsApplied: false, removalsSkipped: "too_many_removals", removed: 0 });

    // With enough other live items, the same single disappearance is applied, and coming back revives it.
    const filler = Array.from({ length: 6 }, (_, i) => tour(BASE + 100 + i, `Filler tour ${i}`, []));
    await svc.syncTravelDeskCatalogue(source([changed, ...filler]), "test", { supplierCode: CODE });
    const applied = await svc.syncTravelDeskCatalogue(source([withoutB, ...filler]), "test", { supplierCode: CODE });
    expect(applied).toMatchObject({ removalsApplied: true, removed: 1 });
    expect((await svc.syncTravelDeskCatalogue(source([changed, ...filler]), "test", { supplierCode: CODE })).revived).toBe(1);
  });

  it("generates suggestions only, with evidence, conflicts and margin; product content and mode untouched", async () => {
    const before = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    const r = await svc.generateCandidates("test", { supplierCode: CODE, productIds: [productId] });
    expect(r.upserted).toBeGreaterThan(0);
    const cands = await prisma.supplierMappingCandidate.findMany({ where: { productId } });
    expect(cands.every((c) => c.state === "suggested" && c.source === "matcher")).toBe(true);
    const deluxeA = cands.find((c) => c.variantCode === "deluxe" && c.offerExternalId === String(OFFER_A))!;
    expect(deluxeA.marginBps).toBe(2452); // (159 − 120) / 159
    expect(deluxeA.evidence as string[]).toContain("Slot times align (±45 min)");
    const woodenA = cands.find((c) => c.variantCode === "wooden" && c.offerExternalId === String(OFFER_A))!;
    expect((woodenA.conflicts as string[]).some((x) => x.startsWith("Margin -10.1% before fees is below 15.0%"))).toBe(true);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(after.content).toEqual(before.content);
    expect(after.fulfilmentMode).toBe("inquiry");
  });

  it("review needs suppliers.manage and a reason", async () => {
    const c = await prisma.supplierMappingCandidate.findFirstOrThrow({ where: { productId, variantCode: "deluxe", offerExternalId: String(OFFER_A) } });
    await expect(svc.reviewCandidate(content, c.id, "approve", "looks the same to me")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const err = await svc.reviewCandidate(admin, c.id, "approve", "short").catch((e) => e);
    expect(isAppError(err) && err.code).toBe("VALIDATION_FAILED");
  });

  it("approval writes one mapping (lower priority, env + offer recorded), audits it, and cannot make the product instant", async () => {
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { code: CODE } });
    const c = await prisma.supplierMappingCandidate.findFirstOrThrow({ where: { productId, variantCode: "deluxe", offerExternalId: String(OFFER_A) } });
    const reevaluate = vi.spyOn(readinessService, "reevaluate");
    const approved = await svc.reviewCandidate(admin, c.id, "approve", "Upper deck direct = Deluxe direct; 21:00 slot ok");
    expect(approved.state).toBe("approved");
    // Readiness is re-evaluated after the commit; a draft inquiry product stays inquiry.
    expect(reevaluate).toHaveBeenCalledWith(productId, "mapping_approve");
    reevaluate.mockRestore();
    expect(await prisma.productEligibility.findUnique({ where: { productId } })).toMatchObject({ effectiveMode: "inquiry" });
    const mapping = await prisma.productSupplierMapping.findUniqueOrThrow({ where: { id: approved.mappingId! } });
    expect(mapping).toMatchObject({ supplierId: supplier.id, variantCode: "deluxe", environment: "test", supplierOfferId: String(OFFER_A), supplierProductId: String(TOUR), bookingKind: "live_book", isActive: true });
    expect(mapping.externalRef).toEqual({ tourId: TOUR, offerId: OFFER_A, bookingKind: "live_book", isExternal: false });
    // The approved terms are recorded (SUP-15).
    const item = (kind: string, externalId: string) =>
      prisma.supplierCatalogueItem.findUniqueOrThrow({ where: { supplierId_environment_kind_externalId: { supplierId: supplier.id, environment: "test", kind, externalId } } });
    const hash = offerTermsHash((await item("offer", String(OFFER_A))).payload, (await item("tour", String(TOUR))).payload);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(mapping).toMatchObject({ approvedOfferHash: hash, syncStatus: "ok" });
    const auditRow = await prisma.auditLog.findFirst({ where: { action: "supplier_mapping.approve", entityId: productId }, orderBy: { createdAt: "desc" } });
    expect(auditRow?.reason).toContain("Upper deck");

    // A second approval for the same variant and environment is refused by the partial unique index.
    const other = await prisma.supplierMappingCandidate.findFirst({ where: { productId, variantCode: "deluxe", state: "suggested" } });
    expect(other).not.toBeNull();
    const err = await svc.reviewCandidate(admin, other!.id, "approve", "trying a second offer for deluxe").catch((e) => e);
    expect(isAppError(err) && err.code).toBe("CONFLICT");
    // Rolled back completely: mapping unchanged, the other candidate still suggested, one approve audit row.
    const unchanged = await prisma.productSupplierMapping.findUniqueOrThrow({ where: { id: approved.mappingId! } });
    expect(unchanged).toMatchObject({ supplierOfferId: String(OFFER_A), isActive: true });
    expect((await prisma.supplierMappingCandidate.findUniqueOrThrow({ where: { id: other!.id } })).state).toBe("suggested");
    expect(await prisma.auditLog.count({ where: { action: "supplier_mapping.approve", entityId: productId } })).toBe(1);

    // Approval never flips the product, and the instant flip is refused while TravelDesk cannot confirm.
    await prisma.supplier.update({ where: { id: supplier.id }, data: { status: "active" } });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).fulfilmentMode).toBe("inquiry");
    // env() must work here, so the refusal below is the capability check, not an env failure in the catch branch.
    // The release switch is turned on for this call only, so the capability check is what refuses.
    const { env, resetEnvCache } = await import("../../lib/env");
    const releaseBefore = process.env.INSTANT_RELEASE_ENABLED;
    process.env.INSTANT_RELEASE_ENABLED = "true";
    resetEnvCache();
    expect(() => env()).not.toThrow();
    const flip = await catalogService.setFulfilmentMode(admin, { kind: "product", id: productId }, "instant", "integration test: must be refused").catch((e) => e);
    if (releaseBefore === undefined) delete process.env.INSTANT_RELEASE_ENABLED;
    else process.env.INSTANT_RELEASE_ENABLED = releaseBefore;
    resetEnvCache();
    expect(isAppError(flip) && flip.code).toBe("CONFLICT");
    expect(isAppError(flip) && flip.message).toMatch(/cannot confirm bookings yet/);
    expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).fulfilmentMode).toBe("inquiry");

    // With a live TravelDesk whose bookings are allowed, the capability gate passes and the step-up
    // (requestPrivileged, not mocked here) is the next check to answer.
    const saved = Object.fromEntries(["INSTANT_RELEASE_ENABLED", "SUPPLIER_ADAPTER_TRAVELDESK", "TRAVELDESK_ENV", "TRAVELDESK_API_BASE_URL", "TRAVELDESK_API_KEY", "TRAVELDESK_BOOKINGS_ENABLED"].map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      INSTANT_RELEASE_ENABLED: "true",
      SUPPLIER_ADAPTER_TRAVELDESK: "live",
      TRAVELDESK_ENV: "test",
      TRAVELDESK_API_BASE_URL: "https://testapi.traveldesk.me/public/b2b/v1",
      TRAVELDESK_API_KEY: "capability-gate-key-not-real",
      TRAVELDESK_BOOKINGS_ENABLED: "true",
    });
    resetEnvCache();
    try {
      const live = await catalogService.setFulfilmentMode(admin, { kind: "product", id: productId }, "instant", "integration test: capability gate passes", { totpCode: "123456" }).catch((e) => e);
      // The capability gate passed: the next check, the fresh authenticator step-up, is what answers.
      expect(isAppError(live) && live.code).toBe("VALIDATION_FAILED");
      expect(isAppError(live) && live.message).toMatch(/authenticator code/);
      expect((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).fulfilmentMode).toBe("inquiry");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetEnvCache();
      await prisma.product.update({ where: { id: productId }, data: { fulfilmentMode: "inquiry" } });
    }
  });

  it("ticket evidence: admins only, with a code, a source and a reason; audited; never `no` while instant; kept on re-approval", async () => {
    const stepUp = vi.mocked((await import("../approval.service")).verifyStepUp);
    stepUp.mockClear();
    const c = await prisma.supplierMappingCandidate.findFirstOrThrow({ where: { productId, state: "approved", mappingId: { not: null } } });
    const mappingId = c.mappingId!;
    const input = { issuesTicketsAtConfirm: "no" as const, source: "TEST booking #300001: confirm answer had no ticketsDetails", note: "Pilot product checked on TEST", totpCode: "123456" };
    const ops: Actor = { type: "admin", id: uuidv7(), roles: ["ops"], permissions: new Set(["suppliers.manage"]) };
    const code = (e: unknown) => (isAppError(e) ? e.code : String(e));

    // The candidate list shows the mapping and no evidence yet.
    const listed = (await svc.listCandidates(admin, { state: "approved", environment: "test", supplierCode: CODE })).find((r) => r.id === c.id);
    expect(listed?.mapping).toEqual({ id: mappingId, ticketEvidence: null });

    // Refusals change nothing.
    expect(code(await svc.setTicketEvidence(ops, mappingId, input).catch((e) => e))).toBe("FORBIDDEN");
    expect(code(await svc.setTicketEvidence(admin, mappingId, { ...input, source: "short" }).catch((e) => e))).toBe("VALIDATION_FAILED");
    expect(code(await svc.setTicketEvidence(admin, mappingId, { ...input, note: "short" }).catch((e) => e))).toBe("VALIDATION_FAILED");
    stepUp.mockResolvedValueOnce("invalid_code");
    expect(code(await svc.setTicketEvidence(admin, mappingId, input).catch((e) => e))).toBe("VALIDATION_FAILED");
    expect(code(await svc.setTicketEvidence(admin, uuidv7(), input).catch((e) => e))).toBe("NOT_FOUND");
    expect((await prisma.productSupplierMapping.findUniqueOrThrow({ where: { id: mappingId } })).externalRef).not.toHaveProperty("ticketEvidence");

    // `no` is recorded, audited, and readiness re-runs.
    const reevaluate = vi.spyOn(readinessService, "reevaluate");
    const now = new Date("2030-04-01T08:00:00Z");
    const record = await svc.setTicketEvidence(admin, mappingId, input, now);
    expect(record).toEqual({ issuesTicketsAtConfirm: "no", source: input.source, recordedAt: now.toISOString() });
    expect(reevaluate).toHaveBeenCalledWith(productId, "ticket_evidence");
    reevaluate.mockRestore();
    expect(stepUp).toHaveBeenLastCalledWith(admin, "123456", now);
    const after = await prisma.productSupplierMapping.findUniqueOrThrow({ where: { id: mappingId } });
    expect(after.externalRef).toMatchObject({ offerId: Number(c.offerExternalId), ticketEvidence: record });
    const auditRow = await prisma.auditLog.findFirstOrThrow({ where: { action: "supplier_mapping.ticket_evidence", entityId: productId }, orderBy: { createdAt: "desc" } });
    expect(auditRow.reason).toBe(input.note);
    expect(auditRow.before).toMatchObject({ mappingId, ticketEvidence: null });
    expect(auditRow.after).toMatchObject({ mappingId, ticketEvidence: { issuesTicketsAtConfirm: "no" } });
    expect((await svc.listCandidates(admin, { state: "approved", environment: "test", supplierCode: CODE })).find((r) => r.id === c.id)?.mapping?.ticketEvidence).toEqual(record);

    // While the product is instant, `no` is refused; `yes` and clearing (tightening) are not.
    await prisma.product.update({ where: { id: productId }, data: { fulfilmentMode: "instant" } });
    try {
      expect(code(await svc.setTicketEvidence(admin, mappingId, input).catch((e) => e))).toBe("CONFLICT");
      expect((await svc.setTicketEvidence(admin, mappingId, { ...input, issuesTicketsAtConfirm: "yes" }))?.issuesTicketsAtConfirm).toBe("yes");
      expect(await svc.setTicketEvidence(admin, mappingId, { ...input, issuesTicketsAtConfirm: "unknown", source: "" })).toBeNull();
      expect((await prisma.productSupplierMapping.findUniqueOrThrow({ where: { id: mappingId } })).externalRef).not.toHaveProperty("ticketEvidence");
    } finally {
      await prisma.product.update({ where: { id: productId }, data: { fulfilmentMode: "inquiry" } });
    }

    // Re-approving the same offer keeps the answer (reviewCandidate).
    await svc.setTicketEvidence(admin, mappingId, input, now);
    await svc.revokeCandidate(admin, c.id, "re-review for evidence test");
    await svc.reviewCandidate(admin, c.id, "approve", "same offer approved again");
    expect((await prisma.productSupplierMapping.findUniqueOrThrow({ where: { id: mappingId } })).externalRef).toMatchObject({ ticketEvidence: { issuesTicketsAtConfirm: "no" } });

    // An inactive mapping is refused.
    await svc.revokeCandidate(admin, c.id, "revoked: inactive mapping check");
    expect(code(await svc.setTicketEvidence(admin, mappingId, input).catch((e) => e))).toBe("CONFLICT");
    await svc.reviewCandidate(admin, c.id, "approve", "restore approval after the check");
    // Later tests expect the mapping without an answer.
    expect(await svc.setTicketEvidence(admin, mappingId, { ...input, issuesTicketsAtConfirm: "unknown", source: "" })).toBeNull();
  });

  it("an approved candidate cannot be reviewed twice; revoke deactivates the mapping", async () => {
    const c = await prisma.supplierMappingCandidate.findFirstOrThrow({ where: { productId, state: "approved" } });
    const again = await svc.reviewCandidate(admin, c.id, "reject", "changing my mind here").catch((e) => e);
    expect(isAppError(again) && again.code).toBe("CONFLICT");
    const reevaluate = vi.spyOn(readinessService, "reevaluate");
    const revoked = await svc.revokeCandidate(admin, c.id, "Supplier changed the boat; re-review");
    expect(reevaluate).toHaveBeenCalledWith(productId, "mapping_revoke");
    reevaluate.mockRestore();
    expect(revoked.state).toBe("suggested"); // back up for review
    expect(revoked.mappingId).toBeNull();
    expect((await prisma.productSupplierMapping.findUniqueOrThrow({ where: { id: c.mappingId! } })).isActive).toBe(false);
  });

  it("two approvals of the same candidate at once: exactly one wins, one active mapping", async () => {
    const c = await prisma.supplierMappingCandidate.findFirstOrThrow({ where: { productId, variantCode: "deluxe", offerExternalId: String(OFFER_A) } });
    expect(c.state).toBe("suggested");
    const results = await Promise.allSettled([
      svc.reviewCandidate(admin, c.id, "approve", "first tab approving deluxe"),
      svc.reviewCandidate(admin, c.id, "approve", "second tab approving deluxe"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(isAppError(lost.reason) && lost.reason.code).toBe("CONFLICT");
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { code: CODE } });
    expect(await prisma.productSupplierMapping.count({ where: { productId, supplierId: supplier.id, variantCode: "deluxe", isActive: true } })).toBe(1);
  });

  it("an approval in another environment cannot overwrite an active mapping", async () => {
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { code: CODE } });
    const prodOffer = String(BASE + 9);
    await prisma.supplierCatalogueItem.create({
      data: { id: uuidv7(), supplierId: supplier.id, environment: "production", kind: "offer", externalId: prodOffer, parentExternalId: String(TOUR), name: "prod upper deck", bookingKind: "live_book", payload: {}, payloadHash: "x" },
    });
    const prodCand = await prisma.supplierMappingCandidate.create({
      data: { id: uuidv7(), productId, variantCode: "deluxe", supplierId: supplier.id, environment: "production", tourExternalId: String(TOUR), offerExternalId: prodOffer, source: "manual" },
    });
    const err = await svc.reviewCandidate(admin, prodCand.id, "approve", "production approval for deluxe").catch((e) => e);
    expect(isAppError(err) && err.code).toBe("CONFLICT");
    expect(isAppError(err) && err.message).toMatch(/active test mapping/);
    expect((await prisma.supplierMappingCandidate.findUniqueOrThrow({ where: { id: prodCand.id } })).state).toBe("suggested");
    const m = await prisma.productSupplierMapping.findFirstOrThrow({ where: { productId, supplierId: supplier.id, variantCode: "deluxe" } });
    expect(m).toMatchObject({ environment: "test", supplierOfferId: String(OFFER_A), isActive: true });
  });

  it("drift: a changed child age band marks the mapping changed and blocks readiness; price moves do not (SUP-15)", async () => {
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { code: CODE } });
    const mapping = () => prisma.productSupplierMapping.findFirstOrThrow({ where: { productId, supplierId: supplier.id, variantCode: "deluxe", isActive: true } });
    const readiness = async (variant: string) => (await svc.mappingReadinessFor(productId, "test", { supplierCode: CODE })).variants.find((v) => v.variantCode === variant)!;
    const filler = Array.from({ length: 6 }, (_, i) => tour(BASE + 100 + i, `Filler tour ${i}`, []));
    const lower = offer(OFFER_B, TOUR, { name: "Dinner Cruise, Lower Deck", pricingPeriods: [] });
    const asStored = tour(TOUR, "Alexandra Dhow Cruise in Dubai Marina", [offer(OFFER_A, TOUR, { maxPax: 40 }), lower]);

    const reevaluateMany = vi.spyOn(readinessService, "reevaluateMany");
    const same = await svc.syncTravelDeskCatalogue(source([asStored, ...filler]), "test", { supplierCode: CODE });
    expect(reevaluateMany).toHaveBeenCalledWith([productId], "sync");
    reevaluateMany.mockRestore();
    expect(same.mappingsChanged).toBe(0);
    expect((await mapping()).syncStatus).toBe("ok");
    const ready = await readiness("deluxe");
    // No supplier_sync_runs row exists for this supplier (a fresh deploy of Batch 1b): the offer's own last-seen time stands in, so nothing is demoted.
    expect(ready.blockers).toEqual([]);
    // The capability gate passes on a seeded class (doc 29 Batch 1a parity).
    expect(ready.mapping).toMatchObject({ capabilityClassKey: "live.fixed_slot_single.self.internal.per_person", capabilityRefusal: null });
    expect(ready.mapping).toMatchObject({ offerExternalId: String(OFFER_A), bookingKind: "live_book", issuesTicketsAtConfirm: "unknown" });
    expect(ready.mapping!.currentOfferHash).toBe(ready.mapping!.approvedOfferHash);
    // The facts readiness needs, from the stored offer and tour policy (synthetic nets), and the account a quote would check.
    const { supplierCheckAccountId } = await import("../supplier-quote.service");
    expect(ready.mapping).toMatchObject({
      supplierUnits: ["adult", "child", "infant"],
      netAedMinorByUnit: { adult: 12_000n, child: 8_000n, infant: 0n, trip: 0n },
      supplierFreeCancellationHours: 24,
      isDirectReporting: true,
      accountId: supplierCheckAccountId("test"),
    });
    expect(fromCatalogReadiness(await svc.mappingReadinessFor(productId, "test", { supplierCode: CODE })).find((x) => x.variantId === "deluxe")?.pickupOffered).toBe(false);
    // A fully mapped variant with synthetic instant content passes every readiness rule.
    const facts = fromCatalogReadiness(await svc.mappingReadinessFor(productId, "test", { supplierCode: CODE })).filter((x) => x.variantId === "deluxe");
    // The stored offer starts at 21:00 only, so the page offers 21:00 (doc 29 Batch 0 time-slot rule).
    const doc = instantDoc({ timeSlots: ["21:00"], variants: [{ ...instantDoc().variants[0], id: "deluxe" }] });
    expect(ready.mapping).toMatchObject({ slotStartMinutes: [1260], anyTimeSlots: false });
    expect(await assessReadiness({ product: product({ id: productId }, doc), mappings: facts, releaseEnabled: true, margin: fakeMargin() })).toMatchObject({ effective: "instant", reasons: [] });
    expect((await readiness("wooden")).blockers).toEqual(["variant_without_mapping"]);
    expect((await svc.mappingReadinessFor(productId, "production", { supplierCode: CODE })).variants.every((v) => v.blockers.includes("variant_without_mapping"))).toBe(true);

    const younger = tour(TOUR, asStored.name!, [offer(OFFER_A, TOUR, { maxPax: 40, childAge: 10 }), lower]);
    const drift = await svc.syncTravelDeskCatalogue(source([younger, ...filler]), "test", { supplierCode: CODE });
    expect(drift.mappingsChanged).toBe(1);
    expect((await mapping()).syncStatus).toBe("changed");
    // N3: children 10 and 11 are page children but TravelDesk adults here, so the child unit is not mapped either.
    const drifted = await readiness("deluxe");
    expect(drifted.blockers).toEqual(["mapping_changed_upstream", "unit_not_mapped"]);
    expect(drifted.mapping!.supplierUnits).toEqual(["adult", "infant"]);

    // A price-only change is not drift: every booking re-checks the price live.
    const price = offer(OFFER_A, TOUR).pricingPeriods[0];
    const dearer = tour(TOUR, asStored.name!, [offer(OFFER_A, TOUR, { maxPax: 40, pricingPeriods: [{ ...price, price: { ...price.price!, perAdultMinor: 12_600n } }] }), lower]);
    await svc.syncTravelDeskCatalogue(source([dearer, ...filler]), "test", { supplierCode: CODE });
    expect((await mapping()).syncStatus).toBe("ok");

    // An approval from before B2 has no hash: the next sync records the current terms once (code path, not SQL).
    const m = await mapping();
    await prisma.productSupplierMapping.update({ where: { id: m.id }, data: { approvedOfferHash: null } });
    expect((await readiness("deluxe")).blockers).toEqual(["mapping_changed_upstream"]);
    const backfill = await svc.syncTravelDeskCatalogue(source([dearer, ...filler]), "test", { supplierCode: CODE });
    expect(backfill.hashesBackfilled).toBe(1);
    expect(await mapping()).toMatchObject({ approvedOfferHash: m.approvedOfferHash, syncStatus: "ok" });
    expect((await svc.syncTravelDeskCatalogue(source([dearer, ...filler]), "test", { supplierCode: CODE })).hashesBackfilled).toBe(0);
  });

  it("a stale catalogue blocks readiness with catalogue_stale; a fresh complete run clears it (doc 29 Batch 1b)", async () => {
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { code: CODE } });
    const readiness = async () => (await svc.mappingReadinessFor(productId, "test", { supplierCode: CODE })).variants.find((v) => v.variantCode === "deluxe")!;
    const { CATALOGUE_STALE_AFTER_MS } = await import("../supplier-catalog.service");
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    const runRow = (finishedAt: Date, status = "complete") => ({
      id: uuidv7(),
      supplierCode: CODE,
      environment: "test",
      accountId: "zz-account",
      triggeredBy: "cron",
      status,
      startedAt: new Date(finishedAt.getTime() - 60_000),
      passStartedAt: new Date(finishedAt.getTime() - 60_000),
      finishedAt,
      tours: 1,
    });
    await prisma.supplierSyncRun.deleteMany({ where: { supplierCode: CODE } });
    expect((await readiness()).blockers).not.toContain("catalogue_stale");

    // No complete run yet: the offer's own last-seen time decides; an old one is stale.
    const offerRow = await prisma.supplierCatalogueItem.findUniqueOrThrow({
      where: { supplierId_environment_kind_externalId: { supplierId: supplier.id, environment: "test", kind: "offer", externalId: String(OFFER_A) } },
    });
    await prisma.supplierCatalogueItem.update({ where: { id: offerRow.id }, data: { lastSeenAt: hoursAgo(49) } });
    expect((await readiness()).blockers).toContain("catalogue_stale");
    // An incomplete run does not count as a complete sync.
    await prisma.supplierSyncRun.create({ data: { ...runRow(hoursAgo(1), "incomplete") } });
    expect((await readiness()).blockers).toContain("catalogue_stale");

    // The last complete run decides once one exists: older than the limit is stale, whatever the offer says.
    await prisma.supplierCatalogueItem.update({ where: { id: offerRow.id }, data: { lastSeenAt: offerRow.lastSeenAt } });
    await prisma.supplierSyncRun.create({ data: runRow(new Date(Date.now() - CATALOGUE_STALE_AFTER_MS - 60_000)) });
    const stale = await readiness();
    expect(stale.blockers).toContain("catalogue_stale");
    const facts = fromCatalogReadiness(await svc.mappingReadinessFor(productId, "test", { supplierCode: CODE })).filter((x) => x.variantId === "deluxe");
    const doc = instantDoc({ timeSlots: ["21:00"], variants: [{ ...instantDoc().variants[0], id: "deluxe" }] });
    const verdict = await assessReadiness({ product: product({ id: productId }, doc), mappings: facts, releaseEnabled: true, margin: fakeMargin() });
    expect(verdict.effective).toBe("inquiry");
    expect(verdict.reasons).toContain("catalogue_stale");

    // A fresh complete run clears it.
    await prisma.supplierSyncRun.create({ data: runRow(hoursAgo(2)) });
    const fresh = await readiness();
    expect(fresh.blockers).not.toContain("catalogue_stale");
    expect(fresh.mapping!.catalogueSyncedAt).not.toBeNull();

    // Review R2: a recent complete run does not refresh an offer it did not read (its tour failed): the offer's own read decides.
    await prisma.supplierCatalogueItem.update({ where: { id: offerRow.id }, data: { lastSeenAt: hoursAgo(49) } });
    expect((await readiness()).blockers).toContain("catalogue_stale");
    // A complete run that read no tour at all (every tour failed) is not a complete sync either.
    await prisma.supplierCatalogueItem.update({ where: { id: offerRow.id }, data: { lastSeenAt: offerRow.lastSeenAt } });
    await prisma.supplierSyncRun.deleteMany({ where: { supplierCode: CODE } });
    await prisma.supplierSyncRun.create({ data: runRow(new Date(Date.now() - CATALOGUE_STALE_AFTER_MS - 60_000)) });
    await prisma.supplierSyncRun.create({ data: { ...runRow(hoursAgo(1)), tours: 0, failedTours: [TOUR] } });
    expect((await readiness()).blockers).toContain("catalogue_stale");
    await prisma.supplierSyncRun.deleteMany({ where: { supplierCode: CODE } });
  });

  it("one failing tour no longer hides withdrawals in other tours (SUP-15)", async () => {
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { code: CODE } });
    const filler = Array.from({ length: 6 }, (_, i) => tour(BASE + 100 + i, `Filler tour ${i}`, []));
    const main = tour(TOUR, "Alexandra Dhow Cruise in Dubai Marina", [offer(OFFER_A, TOUR, { maxPax: 40 }), offer(OFFER_B, TOUR, { name: "Dinner Cruise, Lower Deck", pricingPeriods: [] })]);
    const X = BASE + 300;
    const Y = BASE + 310;
    // Names unlike the test product, so the matcher in later tests ignores them.
    const tourX = tour(X, "Failing tour", [offer(X + 1, X, { name: "Synthetic quad bike ride" })]);
    const tourY = tour(Y, "Healthy tour", [offer(Y + 1, Y, { name: "Synthetic camel trek" }), offer(Y + 2, Y, { name: "Synthetic sandboarding" })]);
    await svc.syncTravelDeskCatalogue(source([main, ...filler, tourX, tourY]), "test", { supplierCode: CODE });

    const withdrawn = tour(Y, "Healthy tour", [tourY.offers[0]]);
    const r = await svc.syncTravelDeskCatalogue(source([main, ...filler, tourX, withdrawn], [X]), "test", { supplierCode: CODE });
    expect(r).toMatchObject({ failedTours: [X], removalsApplied: true, removed: 1 });
    const item = (kind: string, externalId: number) =>
      prisma.supplierCatalogueItem.findUniqueOrThrow({ where: { supplierId_environment_kind_externalId: { supplierId: supplier.id, environment: "test", kind, externalId: String(externalId) } } });
    expect((await item("offer", Y + 2)).removedAt).not.toBeNull();
    expect((await item("offer", Y + 1)).removedAt).toBeNull();
    // The failing tour's own rows are kept until it loads again.
    expect((await item("tour", X)).removedAt).toBeNull();
    expect((await item("offer", X + 1)).removedAt).toBeNull();
  });

  it("reject records the reviewer and reason; regenerating never resurrects or overwrites reviewed rows", async () => {
    const c = await prisma.supplierMappingCandidate.findFirstOrThrow({ where: { productId, state: "suggested", environment: "test", source: "matcher" } });
    const rejected = await svc.reviewCandidate(admin, c.id, "reject", "Lower deck is not the deluxe product");
    expect(rejected).toMatchObject({ state: "rejected", reviewedBy: admin.id });
    // Make the stored evidence differ from what the matcher would write, so an overwrite would be visible.
    await prisma.supplierMappingCandidate.update({ where: { id: c.id }, data: { evidence: ["reviewer snapshot"] } });
    const regen = await svc.generateCandidates("test", { supplierCode: CODE, productIds: [productId] });
    expect(regen.upserted).toBeGreaterThan(0); // the matcher did run and re-suggest the product
    const still = await prisma.supplierMappingCandidate.findUniqueOrThrow({ where: { id: c.id } });
    expect(still.state).toBe("rejected");
    expect(still.reviewNote).toBe("Lower deck is not the deluxe product");
    expect(still.evidence).toEqual(["reviewer snapshot"]);

    const reopened = await svc.reopenCandidate(admin, c.id, "Second look after supplier update");
    expect(reopened.state).toBe("suggested");
    const again = await svc.reopenCandidate(admin, c.id, "reopening twice should fail").catch((e) => e);
    expect(isAppError(again) && again.code).toBe("CONFLICT");
  });

  it("approval is refused for an offer the supplier no longer lists", async () => {
    // Mark the test offers withdrawn (the sync's removal guard is covered above).
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { code: CODE } });
    await prisma.supplierCatalogueItem.updateMany({ where: { supplierId: supplier.id, environment: "test", kind: "offer" }, data: { removedAt: new Date() } });
    const c = await prisma.supplierMappingCandidate.findFirst({ where: { productId, state: "suggested", environment: "test", offerExternalId: { not: String(OFFER_A) } } });
    expect(c).not.toBeNull();
    const err = await svc.reviewCandidate(admin, c!.id, "approve", "approving a withdrawn offer").catch((e) => e);
    expect(isAppError(err) && err.code).toBe("CONFLICT");
  });

  it("price snapshots are stored in AED and replace earlier rows for the same dates", async () => {
    const row = (date: string, adult: bigint) => ({
      date,
      timeSlotId: 1,
      startMinutes: 1260,
      endMinutes: 1365,
      seatsLeft: 120,
      price: { ...offer(OFFER_A, TOUR).pricingPeriods[0].price!, perAdultMinor: adult, date },
    });
    const src = (adult: bigint) => ({ async getAvailability() { return { rows: [row("2026-11-01", adult), row("2026-11-02", adult)] }; } });
    await svc.snapshotAvailability(src(12000n), "test", [{ offerId: OFFER_A, isExternal: false }], "2026-11-01", "2026-11-02", { supplierCode: CODE });
    await svc.snapshotAvailability(src(12600n), "test", [{ offerId: OFFER_A, isExternal: false }], "2026-11-01", "2026-11-02", { supplierCode: CODE });
    const supplier = await prisma.supplier.findUniqueOrThrow({ where: { code: CODE } });
    const snaps = await prisma.supplierPriceSnapshot.findMany({ where: { supplierId: supplier.id, offerExternalId: String(OFFER_A) } });
    expect(snaps).toHaveLength(2);
    expect(snaps.every((s) => s.currency === "AED" && s.netAdultMinor === 12600n)).toBe(true);
  });
});
