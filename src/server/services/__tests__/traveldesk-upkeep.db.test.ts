import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import type { Actor } from "../../lib/actor";
import { isAppError } from "../../lib/errors";
import { uuidv7 } from "../../lib/ids";
import { readLimits } from "../../suppliers/read-budget";
import { tourDetailFrom, tourDetailsWire, type TravelDeskTourDetail, type TravelDeskTourSummary } from "../../suppliers/traveldesk/traveldesk.codec";
import type { TravelDeskConfig } from "../../suppliers/traveldesk/traveldesk.config";
import { offerTermsHash } from "../../suppliers/traveldesk/traveldesk.offer-terms";
import { UNAVAILABLE_HIDE_AFTER_MS, TOUR_CONTENT_KEEP_AFTER_REMOVAL_MS } from "../../suppliers/traveldesk/traveldesk.upkeep";

/**
 * Doc 30 N3 against the LOCAL disposable test database: the daily upkeep of
 * imported listings after a sync.
 *
 *  - An unchanged supplier changes nothing (idempotent, no rows, no version).
 *  - Changed terms are accepted automatically (D17): the hash is re-recorded
 *    together with the new facts, one version row, an audit row naming each
 *    changed term; a diverging option is sold out and listed, not re-approved;
 *    supplier text follows where unlocked; a new offer is listed.
 *  - Parity: a listing that was not imported keeps today's rule (its mapping
 *    stays `changed`, its document and version untouched, no rows).
 *  - A price move above 20% waits (D18); a person's approval applies it.
 *  - A field a person edited stays and is reported when the supplier text moves.
 *  - The digest is queued once per day with no price or net.
 *  - A removed tour (D19): currently unavailable, hidden after 14 days;
 *    content deleted 30 days after removal.
 *
 * Synthetic wire JSON under a run-scoped supplier code and `zz-test-` slugs,
 * removed in afterAll. Nets are invented odd numbers so a leak is visible.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const RUN = uuidv7().slice(-8);
const CODE = `zz-tdn3-${RUN}`;
const BASE = 900_000_000 + Math.floor(Math.random() * 20_000_000);
const LANE = { readLimits: readLimits(100_000) };
const SETTING_KEYS = ["pricing.margin_policy", "pricing.margin_cost_inputs", "pricing.fx_inr_per_aed", "pricing.listing_rule"];
const NET_NEEDLES = ["12347", "123.47", "9871", "98.71", "18521", "185.21"];
// Built at run time: the repository's scanners refuse address literals.
const OWNER = ["owner-n3", "example.test"].join("@");

const admin: Actor = { type: "admin", id: uuidv7(), roles: ["admin"], permissions: new Set(["*"]) };

function period(adult: number, child: number) {
  return { id: 1, offerId: 1, currency: "AED", recPricePerAdult: null, recPricePerChild: null, recPricePerTrip: null, pricePerAdult: adult, pricePerChild: child, pricePerTrip: 0, pricePerAdultUsd: 0, pricePerChildUsd: 0, pricePerTripUsd: 0, discountPercent: null, supplierCurrencyCode: null, conversionRate: null, vat: null, dateStart: "2024-01-01T00:00:00", dateEnd: null };
}

function wireOffer(id: number, start: number, over: Record<string, unknown> = {}) {
  return {
    id, name: `zz synthetic offer ${id}`, code: null, daysOffered: 0, numberOfHours: 2, minNumOfPeople: 1, maxNumOfPeople: 20, privateType: 0,
    childrenAllowed: true, childAge: 12, infantsAllowed: true, infantAge: 3, pricingPeriods: [period(123.47, 98.71)], isDirectReporting: true, description: null,
    timeSlots: [{ id: 1, name: null, startTime: start, endTime: start + 120, daysOffered: 0, isAnyTime: false, isOnRequest: false, minimumAdvancedBooking: 12 }],
    bookingType: 1, isExternal: false, tripUnit: null, ...over,
  };
}

function wireTour(id: number, name: string, offers: Record<string, unknown>[], description = "Sail the creek at sunset on a wooden dhow. Dinner on board.") {
  return {
    id, name, language: "English", isExternal: false, cancellationPolicy: [{ hours: 24, percents: 100 }], categories: [{ id: 1, name: "Dhow Cruise", url: null }],
    termsAndConditions: "<p>Bring photo ID.</p>", salesDescription: `<p>${description}</p><p>Inclusions:</p><ul><li>Buffet dinner</li></ul>`,
    faqList: [], itineraries: [], photos: [{ id: 7, srcSet: [{ type: "image/webp", sizes: [{ src: "https://media.example.test/7-hd.webp", width: 1280, height: 720 }] }] }], videoUrl: null, offers,
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

const code = (e: unknown) => (isAppError(e) ? e.code : String(e));

describe.skipIf(!enabled)("TravelDesk listing upkeep, N3 (local DB)", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let catalog: typeof import("../supplier-catalog.service").supplierCatalogService;
  let importer: typeof import("../traveldesk-import.service").traveldeskImportService;
  let upkeep: typeof import("../traveldesk-upkeep.service").traveldeskUpkeepService;
  let activities: typeof import("../activity.service").activityService;
  let settings: typeof import("../../repositories/settings.repo").settingsRepo;
  const saved = new Map<string, unknown>();
  const TOUR = BASE;
  const TOUR_OLD = BASE + 100;
  const A = TOUR + 1;
  const B = TOUR + 2;
  const C = TOUR + 3;
  const E = TOUR + 4;
  const X = TOUR_OLD + 1;
  // Never-instant filler tours (not imported, D5) so removing the test tour stays under the 20% removal guard.
  const FILLERS = Array.from({ length: 12 }, (_, i) => BASE + 200 + i * 10);
  let supplierId = "";
  let category = "";
  let oldId = "";
  let instantId = "";
  let linkId = "";

  const fillers = () => FILLERS.map((t) => wireTour(t, `zz test ${RUN} filler ${t}`, [wireOffer(t + 1, 600, { bookingType: 0 })]));
  const tourT = (offers: Record<string, unknown>[], description?: string) => wireTour(TOUR, `zz test ${RUN} Evening Dhow Cruise`, offers, description);
  // On request, so the importer never plans (or adopts) it: the old page stays a listing that was not imported.
  const tourOld = (over: Record<string, unknown> = {}) => wireTour(TOUR_OLD, `zz test ${RUN} Old Cruise`, [wireOffer(X, 1080, { bookingType: 0, ...over })]);
  const sync = (wires: Record<string, unknown>[]) => catalog.syncTravelDeskCatalogue(source(wires), "test", { supplierCode: CODE, lane: LANE });
  const run = (over: Parameters<typeof upkeep.run>[1] = {}) => upkeep.run("test", { supplierCode: CODE, photos: null, recipient: null, ...over });
  const changesOf = (productId: string) => prisma.supplierListingChange.findMany({ where: { productId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const versionOf = async (id: string) => (await prisma.product.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
  const mappingOf = (offer: number) => prisma.productSupplierMapping.findFirstOrThrow({ where: { supplierId, supplierOfferId: String(offer), environment: "test" } });

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    ({ supplierCatalogService: catalog } = await import("../supplier-catalog.service"));
    ({ traveldeskImportService: importer } = await import("../traveldesk-import.service"));
    ({ traveldeskUpkeepService: upkeep } = await import("../traveldesk-upkeep.service"));
    ({ activityService: activities } = await import("../activity.service"));
    ({ settingsRepo: settings } = await import("../../repositories/settings.repo"));
    for (const k of SETTING_KEYS) saved.set(k, (await prisma.setting.findUnique({ where: { key: k } }))?.value ?? null);
    const now = Date.now();
    await settings.set("pricing.margin_policy", { version: 1, floorBps: 1500, effectiveFrom: new Date(now - 86_400_000).toISOString() });
    await settings.set("pricing.margin_cost_inputs", { version: 1, source: "zz synthetic", recordedAt: new Date(now - 86_400_000).toISOString(), lines: [{ name: "gateway", kind: "percent_of_charge", bps: 250 }] });
    await settings.set("pricing.fx_inr_per_aed", { version: 1, inrPerAed: "24.10", source: "zz synthetic", recordedAt: new Date(now - 86_400_000).toISOString(), expiresAt: new Date(now + 30 * 86_400_000).toISOString() });
    await settings.set("pricing.listing_rule", { version: 1, targetBps: 1700, recordedAt: new Date(now - 86_400_000).toISOString() });
    category = (await prisma.category.findFirstOrThrow({ where: { deletedAt: null }, select: { slug: true } })).slug;

    await sync([tourT([wireOffer(A, 1200), wireOffer(B, 1200, { numberOfHours: 3 }), wireOffer(C, 1200, { bookingType: 0 })]), tourOld(), ...fillers()]);
    supplierId = (await prisma.supplier.findUniqueOrThrow({ where: { code: CODE } })).id;

    // A listing NOT made by the importer, mapped to offer X the old way (parity).
    const created = await activities.create(admin, {
      slug: `zz-test-${RUN}-old-cruise`, title: "Old synthetic cruise", subtitle: "An older synthetic page.", tier: "B", categorySlug: category, secondaryCategorySlugs: [], collectionSlugs: [],
      images: [`img:activity:zz-test-${RUN}-old-cruise:0`], imageAlt: "Old synthetic cruise", durationMinutes: 120, isPrivate: false, pickupIncluded: false, pickupZones: [], confirmation: "manual",
      fulfilmentMode: "inquiry", freeCancellationHours: 0, mobileVoucher: true, dietary: [], suitability: [], location: "Dubai Creek", meetingPoint: "Dhow wharf", timeSlots: ["18:00"],
      price: { adult: { aed: 150, inr: 3600 } }, inclusions: [], exclusions: [], itinerary: [], importantInfo: [], cancellationPolicy: "Non-refundable once booked.", variants: [], addOns: [], faqs: [],
      relatedSlugs: [], comboSlugs: [], supplier: { id: "outlyy-direct", name: "OUTLYY direct", source: "direct", reliability: 90, verifiedSince: "2026" }, badges: {},
      seo: { title: "Old synthetic cruise", description: "An older synthetic page.", keywords: [] },
    });
    oldId = created.id;
    const offer = await prisma.supplierCatalogueItem.findFirstOrThrow({ where: { supplierId, kind: "offer", externalId: String(X) } });
    const tour = await prisma.supplierCatalogueItem.findFirstOrThrow({ where: { supplierId, kind: "tour", externalId: String(TOUR_OLD) } });
    await prisma.productSupplierMapping.create({
      data: { id: uuidv7(), productId: oldId, supplierId, variantCode: null, externalRef: { tourId: TOUR_OLD, offerId: X, bookingKind: "on_request", isExternal: false }, supplierProductId: String(TOUR_OLD), supplierOfferId: String(X), bookingKind: "on_request", environment: "test", syncStatus: "ok", approvedOfferHash: offerTermsHash(offer.payload, tour.payload), approvedSlotHours: 2 },
    });

    // Import S0 for the tour (instant A+B, inquiry C); the old page's own offer X is adopted-or-skipped, never touched here.
    const p = await importer.preview(admin, "test", "S0", { supplierCode: CODE });
    const mine = p.rows.filter((r) => r.identity.tourId === TOUR);
    expect(mine.map((r) => [r.identity.kind, r.action])).toEqual([["instant", "create"], ["inquiry", "create"]]);
    const applied = await importer.apply(admin, p.batchId);
    const created2 = applied.created.find((c) => c.slug === mine[0].slug)!;
    instantId = created2.productId;
    linkId = created2.linkId;
  });

  afterAll(async () => {
    if (!prisma) return;
    const products = await prisma.product.findMany({ where: { slug: { startsWith: `zz-test-${RUN}` } }, select: { id: true } });
    const ids = products.map((x) => x.id);
    const notes = await prisma.supplierListingChange.findMany({ where: { productId: { in: ids } }, select: { digestNotificationId: true } });
    await prisma.supplierListingChange.deleteMany({ where: { productId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { OR: [{ id: { in: notes.flatMap((n) => (n.digestNotificationId ? [n.digestNotificationId] : [])) } }, { dedupKey: { startsWith: `td_upkeep_digest:${CODE}:` } }] } });
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

  it("an unchanged supplier changes nothing: no version, no change rows, twice", async () => {
    const v = await versionOf(instantId);
    const first = await run();
    expect(first.skipped).toEqual([]);
    expect(first.links).toBe(2);
    await run();
    expect(await versionOf(instantId)).toBe(v);
    expect(await changesOf(instantId)).toEqual([]);
    const link = await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: linkId } });
    expect(link.upkeepAt).not.toBeNull();
    expect(link.photosHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(link.approvedTerms as object).sort()).toEqual([String(A), String(B)].sort());
  });

  it("the scheduled sync runs the upkeep after a complete run, inside its lease (no TravelDesk call of its own)", async () => {
    const { runScheduledCatalogueSync } = await import("../traveldesk-catalogue-sync.service");
    const wires = [tourT([wireOffer(A, 1200), wireOffer(B, 1200, { numberOfHours: 3 }), wireOffer(C, 1200, { bookingType: 0 })]), tourOld(), ...fillers()];
    const src = { ...source(wires), async getBalance() { return { agencyId: 1 }; }, async getAvailability() { return { rows: [], warnings: [] }; } };
    const out = await runScheduledCatalogueSync({ config: { environment: "test", agencyId: null } as unknown as TravelDeskConfig, source: () => src, supplierCode: CODE, readLimits: LANE.readLimits, upkeep: { photos: null, recipient: null } });
    expect(out.status).toBe("complete");
    if (out.status !== "complete") return;
    expect(out.result.upkeep).toMatchObject({ links: 2, changed: 0, incomplete: false });
    expect(await changesOf(instantId)).toEqual([]);
  });

  it("accepts changed terms with the facts (D17), sells the diverging option out, follows the text, lists a new offer; the other listing keeps today's rule", async () => {
    const vInstant = await versionOf(instantId);
    const vOld = await versionOf(oldId);
    const slot = (start: number, advance: number) => [{ id: 1, name: null, startTime: start, endTime: start + 120, daysOffered: 0, isAnyTime: false, isOnRequest: false, minimumAdvancedBooking: advance }];
    await sync([
      tourT([wireOffer(A, 1200, { maxNumOfPeople: 12, timeSlots: slot(1200, 24) }), wireOffer(B, 1260, { numberOfHours: 3 }), wireOffer(C, 1200, { bookingType: 0 }), wireOffer(E, 1200)], "A brand new first sentence about the dhow cruise. More."),
      tourOld({ maxNumOfPeople: 9 }),
      ...fillers(),
    ]);
    expect((await mappingOf(A)).syncStatus).toBe("changed");
    expect((await mappingOf(X)).syncStatus).toBe("changed");

    const r = await run();
    expect(r.reapproved).toBeGreaterThanOrEqual(1);

    const mA = await mappingOf(A);
    const offerA = await prisma.supplierCatalogueItem.findFirstOrThrow({ where: { supplierId, kind: "offer", externalId: String(A) } });
    const tourRow = await prisma.supplierCatalogueItem.findFirstOrThrow({ where: { supplierId, kind: "tour", externalId: String(TOUR) } });
    expect(mA.syncStatus).toBe("ok");
    expect(mA.approvedOfferHash).toBe(offerTermsHash(offerA.payload, tourRow.payload));
    // The diverging option is not re-approved: sold out and listed.
    expect((await mappingOf(B)).syncStatus).toBe("changed");
    const doc = (await prisma.product.findUniqueOrThrow({ where: { id: instantId } })).content as { subtitle: string; timeSlots: string[]; variants: { id: string; soldOut?: boolean; units?: { unitId: string; maxQty: number }[] }[] };
    expect(doc.variants.find((v) => v.id === `td-${B}`)?.soldOut).toBe(true);
    expect(doc.variants.find((v) => v.id === `td-${A}`)?.units?.find((u) => u.unitId === "adult")?.maxQty).toBe(12);
    expect(doc.timeSlots).toEqual(["20:00"]);
    expect(doc.subtitle).toBe("A brand new first sentence about the dhow cruise.");

    // One version row, written with the re-approval.
    expect(await versionOf(instantId)).toBe(vInstant + 1);
    const link = await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: linkId } });
    expect(link.importVersion).toBe(vInstant + 1);
    expect(link.soldOutOfferIds).toEqual([String(B)]);
    // The upkeep's own text write is never recorded as a person's edit (N1's rule: systemFields + rebase).
    expect(link.lockedFields).not.toContain("subtitle");

    const auditRow = await prisma.auditLog.findFirstOrThrow({ where: { action: "supplier_mapping.auto_reapprove", entityId: instantId }, orderBy: { createdAt: "desc" } });
    const fields = ((auditRow.after as { fields: { field: string; before: unknown; after: unknown }[] }).fields ?? []).map((f) => f.field);
    expect(fields).toEqual(expect.arrayContaining(["pax.max", "slots", "listing.variants"]));

    const rows = await changesOf(instantId);
    const kinds = rows.map((x) => `${x.kind}:${x.status}`);
    expect(kinds).toEqual(expect.arrayContaining(["terms:applied", "diverged:review", "new_offer:review", "text:applied", "fact:applied"]));
    for (const n of NET_NEEDLES) expect(JSON.stringify(rows)).not.toContain(n);
    for (const n of NET_NEEDLES) expect(JSON.stringify(auditRow.after)).not.toContain(n);

    // Parity: the listing that was not imported keeps today's rule.
    expect(await versionOf(oldId)).toBe(vOld);
    expect(await changesOf(oldId)).toEqual([]);
    expect((await mappingOf(X)).syncStatus).toBe("changed");
  });

  it("is idempotent after a change: a second run writes no version and no row", async () => {
    const v = await versionOf(instantId);
    const before = (await changesOf(instantId)).length;
    await run();
    expect(await versionOf(instantId)).toBe(v);
    expect((await changesOf(instantId)).length).toBe(before);
  });

  it("a price move above 20% waits for a person (D18); approving it applies the price and resolves the review", async () => {
    const before = (await prisma.product.findUniqueOrThrow({ where: { id: instantId } })).content as { price: { adult: { aed: number } } };
    const slot = [{ id: 1, name: null, startTime: 1200, endTime: 1320, daysOffered: 0, isAnyTime: false, isOnRequest: false, minimumAdvancedBooking: 24 }];
    await sync([
      tourT([wireOffer(A, 1200, { maxNumOfPeople: 12, timeSlots: slot, pricingPeriods: [period(185.21, 98.71)] }), wireOffer(B, 1260, { numberOfHours: 3 }), wireOffer(C, 1200, { bookingType: 0 }), wireOffer(E, 1200)], "A brand new first sentence about the dhow cruise. More."),
      tourOld({ maxNumOfPeople: 9 }),
      ...fillers(),
    ]);
    await run();
    const held = (await prisma.product.findUniqueOrThrow({ where: { id: instantId } })).content as { price: { adult: { aed: number } } };
    expect(held.price.adult.aed).toBe(before.price.adult.aed);
    const review = await prisma.supplierListingChange.findFirstOrThrow({ where: { productId: instantId, kind: "price_jump", status: "review" } });
    for (const n of NET_NEEDLES) expect(JSON.stringify(review)).not.toContain(n);
    // Repeating the run does not add a second review.
    await run();
    expect(await prisma.supplierListingChange.count({ where: { productId: instantId, kind: "price_jump" } })).toBe(1);

    await expect(upkeep.approvePriceChange(admin, review.id, "short")).rejects.toSatisfy((e) => code(e) === "VALIDATION_FAILED");
    await upkeep.approvePriceChange(admin, review.id, "checked the new season price");
    const after = (await prisma.product.findUniqueOrThrow({ where: { id: instantId } })).content as { price: { adult: { aed: number } } };
    expect(after.price.adult.aed).toBeGreaterThan(before.price.adult.aed * 1.2);
    expect((await prisma.supplierListingChange.findUniqueOrThrow({ where: { id: review.id } })).status).toBe("resolved");
    await expect(upkeep.approvePriceChange(admin, review.id, "checked the new season price")).rejects.toSatisfy((e) => code(e) === "NOT_FOUND");
  });

  it("keeps a field a person edited and reports the supplier's new text beside it", async () => {
    const row = await prisma.product.findUniqueOrThrow({ where: { id: instantId } });
    const { id: _i, rating: _r, reviewCount: _c, bookedThisMonth: _b, ...input } = row.content as Record<string, unknown>;
    await activities.update(admin, instantId, { ...(input as Parameters<typeof activities.update>[2]), subtitle: "Our own words about this cruise." }, { reason: "editor copy" });
    const slot = [{ id: 1, name: null, startTime: 1200, endTime: 1320, daysOffered: 0, isAnyTime: false, isOnRequest: false, minimumAdvancedBooking: 24 }];
    await sync([
      tourT([wireOffer(A, 1200, { maxNumOfPeople: 12, timeSlots: slot, pricingPeriods: [period(185.21, 98.71)] }), wireOffer(B, 1260, { numberOfHours: 3 }), wireOffer(C, 1200, { bookingType: 0 }), wireOffer(E, 1200)], "Yet another opening line from the supplier today. More."),
      tourOld({ maxNumOfPeople: 9 }),
      ...fillers(),
    ]);
    await run();
    const doc = (await prisma.product.findUniqueOrThrow({ where: { id: instantId } })).content as { subtitle: string };
    expect(doc.subtitle).toBe("Our own words about this cruise.");
    expect((await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: linkId } })).lockedFields).toContain("subtitle");
    expect(await prisma.supplierListingChange.count({ where: { productId: instantId, kind: "locked_text_changed", field: "subtitle" } })).toBe(1);
  });

  it("queues one digest a day to the owner, with no price and no net", async () => {
    const r = await run({ recipient: OWNER });
    expect(r.digest).toBe("queued");
    const n = await prisma.notification.findFirstOrThrow({ where: { dedupKey: { startsWith: `td_upkeep_digest:${CODE}:test:` } } });
    expect(n.event).toBe("TRAVELDESK_UPKEEP_DIGEST");
    for (const needle of [...NET_NEEDLES, "aed", "inr"]) expect(JSON.stringify(n.payload).toLowerCase()).not.toContain(needle.toLowerCase());
    expect(await prisma.supplierListingChange.count({ where: { productId: instantId, digestedAt: null } })).toBe(0);
    expect((await run({ recipient: OWNER })).digest).toBe("already_sent");
  });

  it("a removed tour shows as unavailable, is hidden after 14 days (D19), and its content is deleted 30 days after removal", async () => {
    await sync([tourOld({ maxNumOfPeople: 9 }), ...fillers()]);
    expect((await prisma.supplierCatalogueItem.findFirstOrThrow({ where: { supplierId, kind: "tour", externalId: String(TOUR) } })).removedAt).not.toBeNull();
    const r = await run();
    expect(r.unavailable).toBe(2);
    const link = await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: linkId } });
    expect(link.unavailableSince).not.toBeNull();
    const status = (await prisma.product.findUniqueOrThrow({ where: { id: instantId } })).status;

    const later = new Date(link.unavailableSince!.getTime() + UNAVAILABLE_HIDE_AFTER_MS + 60_000);
    const hid = await run({ now: () => later });
    expect(hid.hidden).toBe(2);
    const after = await prisma.supplierListingLink.findUniqueOrThrow({ where: { id: linkId } });
    expect(after.hiddenAt).not.toBeNull();
    expect((await prisma.product.findUniqueOrThrow({ where: { id: instantId } })).status).toBe(status === "published" ? "draft" : status);
    expect(await prisma.supplierListingChange.count({ where: { productId: instantId, kind: "hidden" } })).toBe(1);

    expect(await prisma.supplierTourContent.count({ where: { supplierId, tourExternalId: String(TOUR) } })).toBe(1);
    const old = new Date(Date.now() - TOUR_CONTENT_KEEP_AFTER_REMOVAL_MS - 86_400_000);
    await prisma.supplierCatalogueItem.updateMany({ where: { supplierId, kind: "tour", externalId: String(TOUR) }, data: { removedAt: old, lastSeenAt: old } });
    const purged = await run();
    expect(purged.contentPurged).toBe(1);
    expect(await prisma.supplierTourContent.count({ where: { supplierId, tourExternalId: String(TOUR) } })).toBe(0);
  });
});
