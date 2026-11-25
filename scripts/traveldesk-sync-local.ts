/**
 * TravelDesk catalogue → LOCAL database (docs/backend/21 Stage 1).
 *
 * Pulls the TravelDesk catalogue with GET requests only, stores it in
 * supplier_catalogue_items, runs the matcher to store mapping SUGGESTIONS, and
 * snapshots 7 days of net prices for the suggested offers. Nothing is booked,
 * nothing is approved, no product content or price is changed.
 *
 * Safety:
 *  - Refuses any database but the disposable test instance (target guard,
 *    scripts/lib/target-guard.ts). The guard allows only the TravelDesk TEST
 *    key, so `--production-readonly` is refused until it is re-approved.
 *  - TravelDesk config is validated exactly as the probe does; bookings must be off.
 *
 *   npm run traveldesk:sync:local                 (TravelDesk test API)
 *   npm run traveldesk:sync:local:production      (production catalogue, read-only)
 */
import { traveldeskConfigFrom, traveldeskConfigProblems, traveldeskProductionReadOnlyConfigFrom, type TravelDeskConfig } from "../src/server/suppliers/traveldesk/traveldesk.config";
import { TravelDeskReadClient } from "../src/server/suppliers/traveldesk/traveldesk.client";
import { assertDisposableDbLive, assertDisposableTarget } from "./lib/target-guard";

function fail(message: string): never {
  console.error(`traveldesk-sync-local: ${message}`);
  process.exit(2);
}

const PRODUCTION = process.argv.includes("--production-readonly");

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) fail("DATABASE_URL missing (.env.local)");
let dbHost = "";
try {
  dbHost = new URL(dbUrl).hostname;
} catch {
  fail("DATABASE_URL is not a URL");
}
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(dbHost)) fail(`refusing: DATABASE_URL host "${dbHost}" is not local`);
try {
  // Shared target guard (scripts/lib/target-guard.ts): disposable database only; the TravelDesk TEST key is the one credential allowed.
  assertDisposableTarget({ allowTravelDeskTestKey: true });
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

const env = {
  APP_ENV: "development" as const,
  SUPPLIER_ADAPTER_TRAVELDESK: process.env.SUPPLIER_ADAPTER_TRAVELDESK as "mock" | "live" | undefined,
  TRAVELDESK_ENV: process.env.TRAVELDESK_ENV as "test" | "production" | undefined,
  TRAVELDESK_API_BASE_URL: process.env.TRAVELDESK_API_BASE_URL?.trim() || undefined,
  TRAVELDESK_API_KEY: process.env.TRAVELDESK_API_KEY?.trim() || undefined,
  TRAVELDESK_TIMEOUT_MS: Number(process.env.TRAVELDESK_TIMEOUT_MS ?? 150_000),
  TRAVELDESK_READ_TIMEOUT_MS: Number(process.env.TRAVELDESK_READ_TIMEOUT_MS ?? 30_000),
  TRAVELDESK_BOOKINGS_ENABLED: process.env.TRAVELDESK_BOOKINGS_ENABLED === "true",
};
if (env.SUPPLIER_ADAPTER_TRAVELDESK !== "live") fail("the TravelDesk env file must set SUPPLIER_ADAPTER_TRAVELDESK=live");
if (env.TRAVELDESK_BOOKINGS_ENABLED) fail("TRAVELDESK_BOOKINGS_ENABLED must be false");
let config: TravelDeskConfig;
if (PRODUCTION) {
  const r = traveldeskProductionReadOnlyConfigFrom(env);
  if ("problems" in r) fail(`configuration refused:\n  - ${r.problems.join("\n  - ")}`);
  config = r;
} else {
  const problems = traveldeskConfigProblems(env);
  if (problems.length || env.TRAVELDESK_ENV !== "test") fail(`configuration refused:\n  - ${[...problems, "TRAVELDESK_ENV must be test"].join("\n  - ")}`);
  config = traveldeskConfigFrom(env) as TravelDeskConfig;
}

function dubaiDate(offsetDays: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

async function main() {
  // Imported after the guards so nothing touches the database before they pass.
  const { supplierCatalogService } = await import("../src/server/services/supplier-catalog.service");
  const { prisma } = await import("../src/server/lib/db");
  await assertDisposableDbLive(prisma, { allowTravelDeskTestKey: true });
  const environment = config.environment;
  const client = new TravelDeskReadClient(config, { maxConcurrent: 1 });
  console.log(`TravelDesk ${environment} (read-only) → local DB ${dbHost}`);

  // Shares the supplier lane and read budget with the booking engine (SUP-6).
  const sync = await supplierCatalogService.syncTravelDeskCatalogue(client, environment, { lane: { accountId: config.agencyId ?? null } });
  console.log("sync", sync);
  const gen = await supplierCatalogService.generateCandidates(environment, { onDate: dubaiDate(2) });
  console.log("candidates", gen);

  const supplier = await prisma.supplier.findUniqueOrThrow({ where: { code: "traveldesk" } });
  const candidateOffers = await prisma.supplierMappingCandidate.findMany({
    where: { supplierId: supplier.id, environment, state: { in: ["suggested", "approved"] } },
    select: { offerExternalId: true },
    distinct: ["offerExternalId"],
    take: 40,
  });
  const items = await prisma.supplierCatalogueItem.findMany({
    where: { supplierId: supplier.id, environment, kind: "offer", externalId: { in: candidateOffers.map((c) => c.offerExternalId) }, removedAt: null },
    select: { externalId: true, isExternal: true, bookingKind: true },
  });
  const datable = items.filter((i) => i.bookingKind === "live_book" || i.bookingKind === "on_request");
  const snap = await supplierCatalogService.snapshotAvailability(
    client,
    environment,
    datable.map((i) => ({ offerId: Number(i.externalId), isExternal: i.isExternal })),
    dubaiDate(2),
    dubaiDate(8),
  );
  console.log("snapshots", { offers: datable.length, ...snap });
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(`traveldesk-sync-local: aborted (${e instanceof Error ? `${e.name}: ${e.message}` : "error"})`);
  process.exit(1);
});
