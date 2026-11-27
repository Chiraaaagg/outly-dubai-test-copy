/**
 * Browser pass of the TravelDesk admin screens (doc 30 N0–N4): prepare a
 * disposable test database with synthetic data so the import, changes,
 * capabilities and activities pages have something to show.
 *
 * Writes to the LOCAL disposable database only: the target guard runs first
 * (loopback, an allowlisted test port, an outly_test_* database, the instance
 * marker, no provider credential in the environment). Needs the seeded
 * catalogue (`scripts/db.mjs seed`, run by scripts/test-db/up.sh).
 *
 * Synthetic only, modelled on the DB suites (traveldesk-import.db.test.ts,
 * n2-proofs-bulk.db.test.ts, traveldesk-upkeep.db.test.ts): six invented
 * TravelDesk TEST tours with invented, deliberately odd nets, read through a
 * fake source (no TravelDesk call), then the real services: catalogue sync
 * (one complete run), import of step S0 as drafts, two drafts marked
 * reviewed, a supplier change and one upkeep run (change rows), two class
 * proofs, and one TOTP-enrolled `admin` with a live session.
 *
 * Output: the session cookie header value (`outlyy_admin_session=<token>`)
 * and the TOTP secret (for step-up codes), each to its own file with mode
 * 600 given by ADMIN_UI_COOKIE_FILE and ADMIN_UI_TOTP_FILE. Neither is
 * printed. The console shows ids, slugs and counts only.
 *
 *   OUTLY_TEST_ENV_FILE=.env.test.adminui.local NODE_OPTIONS=--conditions=react-server \
 *     ADMIN_UI_COOKIE_FILE=/path/cookie.txt ADMIN_UI_TOTP_FILE=/path/totp.txt \
 *     node --env-file=.env.test.adminui.local node_modules/tsx/dist/cli.mjs scripts/shop/admin-ui-fixture.ts
 */
import { chmodSync, writeFileSync } from "node:fs";
import { assertDisposableDbLive, assertDisposableTarget } from "../lib/target-guard";

assertDisposableTarget();

const COOKIE_FILE = process.env.ADMIN_UI_COOKIE_FILE;
const TOTP_FILE = process.env.ADMIN_UI_TOTP_FILE;
if (!COOKIE_FILE || !TOTP_FILE) throw new Error("admin-ui fixture: set ADMIN_UI_COOKIE_FILE and ADMIN_UI_TOTP_FILE");

/* ------------------------------------------------------------------ synthetic wire */

const T = { fixed: 900100, listed: 900200, ticket: 900300, onRequest: 900400, ownAges: 900500, noAges: 900600 } as const;

function period(adult: number, child: number) {
  return { id: 1, offerId: 1, currency: "AED", recPricePerAdult: null, recPricePerChild: null, recPricePerTrip: null, pricePerAdult: adult, pricePerChild: child, pricePerTrip: 0, pricePerAdultUsd: 0, pricePerChildUsd: 0, pricePerTripUsd: 0, discountPercent: null, supplierCurrencyCode: null, conversionRate: null, vat: null, dateStart: "2024-01-01T00:00:00", dateEnd: null };
}

const slot = (id: number, start: number, over: Record<string, unknown> = {}) => ({ id, name: null, startTime: start, endTime: start + 120, daysOffered: 0, isAnyTime: false, isOnRequest: false, minimumAdvancedBooking: 12, ...over });

function wireOffer(id: number, over: Record<string, unknown> = {}) {
  return {
    id, name: `zz synthetic offer ${id}`, code: null, daysOffered: 0, numberOfHours: 2, minNumOfPeople: 1, maxNumOfPeople: 20, privateType: 0,
    childrenAllowed: true, childAge: 12, infantsAllowed: true, infantAge: 3, pricingPeriods: [period(123.47, 98.71)], isDirectReporting: true, description: null,
    timeSlots: [slot(1, 1200)], bookingType: 1, isExternal: false, tripUnit: null, ...over,
  };
}

function wireTour(id: number, name: string, category: string, offers: Record<string, unknown>[]) {
  return {
    id, name, language: "English", isExternal: false, cancellationPolicy: [{ hours: 24, percents: 100 }], categories: [{ id: 1, name: category, url: null }],
    termsAndConditions: "<p>Bring photo ID. Synthetic test terms.</p>",
    salesDescription: `<p>${name}: a synthetic listing for the admin browser pass. Nothing here is a real supplier text.</p><p>Inclusions:</p><ul><li>Synthetic inclusion</li></ul>`,
    faqList: [{ question: "Is this real?", answer: "<p>No, synthetic test data.</p>" }],
    itineraries: [{ title: "Start" }],
    photos: [{ id: 7, srcSet: [{ type: "image/webp", sizes: [{ src: "https://media.example.test/zz-7.webp", width: 1280, height: 720 }] }] }],
    videoUrl: null,
    offers,
  };
}

/** Day one: what the import reads. Day two: B removed, own-ages price up about 10%, no-ages price up about 50%. */
function wires(day: 1 | 2) {
  return [
    wireTour(T.fixed, "zz Synthetic Evening Dhow Cruise", "Dhow Cruise", [
      wireOffer(T.fixed + 1),
      ...(day === 1 ? [wireOffer(T.fixed + 2, { numberOfHours: 3 })] : []),
      wireOffer(T.fixed + 3, { bookingType: 0 }),
    ]),
    wireTour(T.listed, "zz Synthetic Desert Safari with Chosen Start", "Desert Safari", [
      wireOffer(T.listed + 1, { numberOfHours: 4, timeSlots: [slot(1, 600, { isAnyTime: true }), slot(2, 840, { isAnyTime: true })] }),
    ]),
    wireTour(T.ticket, "zz Synthetic Observation Deck Ticket", "Attractions", [wireOffer(T.ticket + 1, { bookingType: 2, timeSlots: [] })]),
    wireTour(T.onRequest, "zz Synthetic Private Yacht on Request", "Cruise", [wireOffer(T.onRequest + 1, { bookingType: 0 })]),
    wireTour(T.ownAges, "zz Synthetic Kayak Tour for Young Children", "Kayak", [
      wireOffer(T.ownAges + 1, { childAge: 8, timeSlots: [slot(1, 1080)], pricingPeriods: [day === 1 ? period(123.47, 98.71) : period(135.83, 98.71)] }),
    ]),
    wireTour(T.noAges, "zz Synthetic Aquarium Walk", "Aquarium", [
      wireOffer(T.noAges + 1, { childAge: 0, timeSlots: [slot(1, 960)], pricingPeriods: [day === 1 ? period(123.47, 98.71) : period(185.21, 98.71)] }),
    ]),
  ];
}

async function main() {
  const { prisma } = await import("../../src/server/lib/db");
  await assertDisposableDbLive(prisma);
  const { ROLE_PERMISSIONS } = await import("../../src/server/lib/permissions");
  const { uuidv7 } = await import("../../src/server/lib/ids");
  const { hashPassword, generateTotpSecret, encryptSecret } = await import("../../src/server/lib/crypto");
  const { SESSION_COOKIE } = await import("../../src/server/lib/session");
  const { authService } = await import("../../src/server/services/auth.service");
  const { settingsRepo } = await import("../../src/server/repositories/settings.repo");
  const { readLimits } = await import("../../src/server/suppliers/read-budget");
  const { tourDetailFrom, tourDetailsWire } = await import("../../src/server/suppliers/traveldesk/traveldesk.codec");
  const { runScheduledCatalogueSync } = await import("../../src/server/services/traveldesk-catalogue-sync.service");
  const { traveldeskImportService } = await import("../../src/server/services/traveldesk-import.service");
  const { traveldeskListingService } = await import("../../src/server/services/traveldesk-listing.service");
  const { traveldeskUpkeepService } = await import("../../src/server/services/traveldesk-upkeep.service");
  const { activityService } = await import("../../src/server/services/activity.service");
  const { TRAVELDESK_SUPPLIER_CODE } = await import("../../src/server/services/supplier-catalog.service");
  type Actor = import("../../src/server/lib/actor").Actor;

  if (await prisma.supplierListingLink.count()) throw new Error("admin-ui fixture: imported listings exist already; recreate the database (up.sh --recreate)");

  // Staff: one active, TOTP-enrolled administrator with a live session.
  const role = await prisma.role.findUniqueOrThrow({ where: { code: "admin" } });
  const staffId = uuidv7();
  const secret = generateTotpSecret();
  await prisma.adminUser.create({
    data: {
      id: staffId,
      email: ["zz-admin-ui", "outlyy.test"].join("@"),
      fullName: "Admin UI fixture",
      passwordHash: hashPassword(uuidv7() + uuidv7()),
      totpEnabled: true,
      totpSecretEncrypted: encryptSecret(secret),
      status: "active",
      roles: { create: [{ roleId: role.id }] },
    },
  });
  const actor: Actor = { type: "admin", id: staffId, displayName: "Admin UI fixture", roles: ["admin"], permissions: new Set(ROLE_PERMISSIONS.admin) };

  // Pricing settings, as the import DB test records them (synthetic).
  const now = Date.now();
  await settingsRepo.set("pricing.margin_policy", { version: 1, floorBps: 1500, effectiveFrom: new Date(now - 86_400_000).toISOString() });
  await settingsRepo.set("pricing.margin_cost_inputs", { version: 1, source: "zz synthetic", recordedAt: new Date(now - 86_400_000).toISOString(), lines: [{ name: "gateway", kind: "percent_of_charge", bps: 250 }] });
  await settingsRepo.set("pricing.fx_inr_per_aed", { version: 1, inrPerAed: "24.10", source: "zz synthetic", recordedAt: new Date(now - 86_400_000).toISOString(), expiresAt: new Date(now + 30 * 86_400_000).toISOString() });
  await settingsRepo.set("pricing.listing_rule", { version: 1, targetBps: 1700, recordedAt: new Date(now - 86_400_000).toISOString() });

  // One complete catalogue sync from the fake source (no TravelDesk call).
  const config = { environment: "test", agencyId: null } as never;
  const source = (day: 1 | 2) => {
    const details = wires(day).map((w) => tourDetailFrom(tourDetailsWire.parse(w)));
    return {
      async getBalance() {
        return { agencyId: 1 };
      },
      async listTours() {
        return details.map((t) => ({ tourId: t.tourId, name: t.name, categories: [] }));
      },
      async getTour(id: number) {
        const t = details.find((x) => x.tourId === id);
        if (!t) throw new Error("missing");
        return t;
      },
      async getAvailability() {
        return { rows: [], warnings: [] };
      },
    };
  };
  const sync = async (day: 1 | 2) => {
    const out = await runScheduledCatalogueSync({ config, source: () => source(day) as never, readLimits: readLimits(100_000) });
    if (out.status !== "complete") throw new Error(`admin-ui fixture: sync ${day} ended ${out.status}`);
  };
  await sync(1);

  // Import step S0 as drafts (one applied batch).
  const preview = await traveldeskImportService.preview(actor, "test", "S0");
  const applied = await traveldeskImportService.apply(actor, preview.batchId, { reason: "zz admin UI fixture import" });

  // Two drafts marked reviewed (the publish table's rows): placeholders filled, own copy per page.
  const links = await prisma.supplierListingLink.findMany({ where: { importBatchId: preview.batchId }, include: { product: true }, orderBy: [{ tourExternalId: "asc" }, { kind: "asc" }] });
  const toReview = links.filter((l) => l.kind === "instant" && (l.tourExternalId === String(T.fixed) || l.tourExternalId === String(T.ownAges)));
  for (const l of toReview) {
    const { id: _i, rating: _r, reviewCount: _c, bookedThisMonth: _b, ...input } = l.product.content as Record<string, unknown>;
    await activityService.update(actor, l.productId, { ...input, location: "Dubai (synthetic)", meetingPoint: "Synthetic meeting point", images: ["https://photos.example.test/zz-admin-ui.webp"], subtitle: `Synthetic page ${l.product.slug.slice(0, 40)}.` } as never, { reason: "zz admin UI fixture copy" });
    await traveldeskListingService.markReviewed(actor, l.id, { replacesProductId: null, confirmTierAndCategory: true, note: "zz admin UI fixture review" });
  }

  // A supplier change and one upkeep run: an offer removed, a price within 20%, a price move above 20% (waits).
  await sync(2);
  const upkeep = await traveldeskUpkeepService.run("test", { photos: null, recipient: null });

  // Class proofs (capabilities page, proof dialogs): the seeded fixed-start key on the dhow tour, the ticket key on its attraction.
  const supplier = await prisma.supplier.findUniqueOrThrow({ where: { code: TRAVELDESK_SUPPLIER_CODE } });
  const proof = (classKey: string, tour: number, reference: string) => ({
    id: uuidv7(), supplierId: supplier.id, environment: "test" as const, classKey, basisClassKey: classKey, scopeKind: "tours", scopeProvider: null,
    scopeTourIds: [String(tour)], bookedTourId: String(tour), evidenceKind: "sandbox_drill", reference, recordedBy: staffId,
  });
  await prisma.supplierClassProof.create({ data: proof("live.fixed_slot_single.self.internal.per_person", T.fixed, "zz admin UI drill, fixed start") });
  await prisma.supplierClassProof.create({ data: proof("ticket.open_dated.self.internal.per_person", T.ticket, "zz admin UI drill, ticket") });

  // The session last (8 h), so it is fresh for the pass.
  const { token } = await authService.createSession(staffId, { userAgent: "admin-ui-fixture" });
  writeFileSync(COOKIE_FILE!, `${SESSION_COOKIE}=${token}`, { mode: 0o600 });
  chmodSync(COOKIE_FILE!, 0o600);
  writeFileSync(TOTP_FILE!, secret, { mode: 0o600 });
  chmodSync(TOTP_FILE!, 0o600);

  const changes = await prisma.supplierListingChange.groupBy({ by: ["kind", "status"], _count: true });
  console.log(
    JSON.stringify({
      batchId: preview.batchId,
      created: applied.created.map((c) => c.slug),
      reviewed: toReview.map((l) => l.product.slug),
      upkeep: { links: upkeep.links, changed: upkeep.changed, reviews: upkeep.reviews, skipped: upkeep.skipped.length },
      changes: changes.map((c) => `${c.kind}:${c.status}=${c._count}`),
      proofs: 2,
      staff: { id: staffId, role: "admin", totp: "enrolled" },
    }),
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
