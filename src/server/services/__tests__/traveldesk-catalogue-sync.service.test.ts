import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import type { Actor } from "../../lib/actor";
import { isAppError } from "../../lib/errors";
import { uuidv7 } from "../../lib/ids";
import type { TravelDeskTourDetail, TravelDeskTourSummary } from "../../suppliers/traveldesk/traveldesk.codec";
import type { TravelDeskConfig } from "../../suppliers/traveldesk/traveldesk.config";
import { readLimits } from "../../suppliers/read-budget";
import { TravelDeskApiError } from "../../suppliers/traveldesk/traveldesk.http";

/**
 * Admin-triggered catalogue sync against the LOCAL test database. Rows live
 * under a run-scoped supplier code (the real `traveldesk` supplier is never
 * touched) and are removed in afterAll. The TravelDesk source is a fake: no
 * network. Audit rows stay (append-only by design).
 */

const enabled = Boolean(process.env.DATABASE_URL);
const RUN = uuidv7().slice(-8);
const CODE = `zz-tds-${RUN}`;
const BASE = 910_000_000 + Math.floor(Math.random() * 80_000_000);

const admin: Actor = { type: "admin", id: uuidv7(), roles: ["admin"], permissions: new Set(["*"]) };
const content: Actor = { type: "admin", id: uuidv7(), roles: ["content"], permissions: new Set(["products.edit"]) };

const config = { environment: "test", agencyId: null } as unknown as TravelDeskConfig;
const accept = async () => null;
const LIMITS = readLimits(10_000);

function tour(id: number): TravelDeskTourDetail {
  return {
    tourId: id,
    name: `zz tour ${id}`,
    categories: [],
    isExternal: false,
    offers: [],
    cancellationPolicy: [],
    hasTermsAndConditions: false,
    hasSalesDescription: false,
    faqCount: 0,
    itineraryCount: 0,
    photoCount: 0,
    warnings: [],
  };
}

function fakeSource(calls: string[], opts: { agencyId?: number; tours?: number[]; tourDelayMs?: number } = {}) {
  const tours = (opts.tours ?? [BASE, BASE + 1]).map(tour);
  return () => ({
    async getBalance() {
      calls.push("balance");
      return { agencyId: opts.agencyId ?? 4242 };
    },
    async listTours(): Promise<TravelDeskTourSummary[]> {
      calls.push("listTours");
      return tours.map((t) => ({ tourId: t.tourId, name: t.name, categories: [] }));
    },
    async getTour(id: number) {
      calls.push(`getTour:${id}`);
      if (opts.tourDelayMs) await new Promise((r) => setTimeout(r, opts.tourDelayMs));
      const t = tours.find((x) => x.tourId === id);
      if (!t) throw new Error("missing");
      return t;
    },
    async getAvailability() {
      calls.push("availability");
      return { rows: [], warnings: [] };
    },
  });
}

describe.skipIf(!enabled)("runTravelDeskCatalogueSync (local DB)", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let run: typeof import("../traveldesk-catalogue-sync.service").runTravelDeskCatalogueSync;
  let leaseKey: typeof import("../traveldesk-catalogue-sync.service").catalogueSyncLeaseKey;
  let LEASE_MS: number;
  let DEADLINE_MS: number;

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    ({ runTravelDeskCatalogueSync: run, catalogueSyncLeaseKey: leaseKey, CATALOGUE_SYNC_LEASE_MS: LEASE_MS, RUN_DEADLINE_MS: DEADLINE_MS } = await import("../traveldesk-catalogue-sync.service"));
  });

  afterAll(async () => {
    if (!prisma) return;
    const sup = await prisma.supplier.findUnique({ where: { code: CODE } });
    if (sup) {
      await prisma.supplierMappingCandidate.deleteMany({ where: { supplierId: sup.id } });
      await prisma.supplierPriceSnapshot.deleteMany({ where: { supplierId: sup.id } });
      await prisma.supplierCatalogueItem.deleteMany({ where: { supplierId: sup.id } });
      await prisma.supplier.delete({ where: { id: sup.id } });
    }
    await prisma.setting.deleteMany({ where: { key: { startsWith: `${CODE}.` } } });
    await prisma.$disconnect();
  });

  const deps = (calls: string[], over: Record<string, unknown> = {}) => ({ config, source: fakeSource(calls), stepUp: accept, supplierCode: CODE, readLimits: LIMITS, ...over });

  it("pulls the catalogue read only, reports the agency id, audits, and releases the lease", async () => {
    const calls: string[] = [];
    const r = await run(admin, "123456", deps(calls));
    expect(r).toMatchObject({ environment: "test", agencyId: "4242", pinnedAgencyId: null, sync: { tours: 2, offers: 0, failedTours: [] }, snapshots: { skipped: "no_offers" } });
    // Only the read calls of the fake: balance, the tour list and each tour.
    expect(calls).toEqual(["balance", "listTours", `getTour:${BASE}`, `getTour:${BASE + 1}`]);
    expect(await prisma.supplierCatalogueItem.count({ where: { supplier: { code: CODE }, environment: "test", kind: "tour" } })).toBe(2);
    const audited = await prisma.auditLog.findFirst({ where: { actorId: admin.id, action: "supplier.catalogue_synced" }, orderBy: { createdAt: "desc" } });
    expect(audited).not.toBeNull();
    const lease = await prisma.setting.findUniqueOrThrow({ where: { key: leaseKey("test", CODE) } });
    expect((lease.value as Record<string, unknown>).holder).toBeUndefined();
    // A second run is allowed once the first released its lease.
    await expect(run(admin, "123456", deps([]))).resolves.toMatchObject({ sync: { tours: 2 } });
  });

  it("needs suppliers.manage", async () => {
    await expect(run(content, "123456", deps([]))).rejects.toSatisfy((e) => isAppError(e) && e.code === "FORBIDDEN");
  });

  it("needs a fresh authenticator code, and calls TravelDesk only after it is accepted", async () => {
    const calls: string[] = [];
    await expect(run(admin, undefined, deps(calls))).rejects.toSatisfy((e) => isAppError(e) && e.code === "VALIDATION_FAILED");
    await expect(run(admin, "123456", deps(calls, { stepUp: async () => "invalid_code" }))).rejects.toSatisfy((e) => isAppError(e) && e.code === "VALIDATION_FAILED");
    expect(calls).toEqual([]);
  });

  it("refuses when TravelDesk is not configured on the deployment", async () => {
    await expect(run(admin, "123456", deps([], { config: null }))).rejects.toSatisfy((e) => isAppError(e) && e.code === "CONFLICT");
  });

  it("refuses a second run while a fresh lease is held, and takes over a stale one", async () => {
    const key = leaseKey("test", CODE);
    await prisma.setting.upsert({ where: { key }, create: { key, value: { holder: "someone-else" } }, update: { value: { holder: "someone-else" } } });
    const calls: string[] = [];
    await expect(run(admin, "123456", deps(calls))).rejects.toSatisfy((e) => isAppError(e) && e.code === "CONFLICT");
    expect(calls).toEqual([]);
    // The other holder's lease is untouched by the refused run.
    expect(((await prisma.setting.findUniqueOrThrow({ where: { key } })).value as Record<string, unknown>).holder).toBe("someone-else");
    // A lease older than the limit belongs to a run the platform killed: it can be taken over.
    await prisma.$executeRaw`UPDATE settings SET updated_at = ${new Date(Date.now() - LEASE_MS - 60_000)} WHERE key = ${key}`;
    await expect(run(admin, "123456", deps([]))).resolves.toMatchObject({ sync: { tours: 2 } });
  });

  it("releases the lease when the pull fails", async () => {
    const failing = () => ({ ...fakeSource([])(), async listTours(): Promise<TravelDeskTourSummary[]> { throw new Error("boom"); } });
    await expect(run(admin, "123456", deps([], { source: failing }))).rejects.toThrow("boom");
    const lease = await prisma.setting.findUniqueOrThrow({ where: { key: leaseKey("test", CODE) } });
    expect((lease.value as Record<string, unknown>).holder).toBeUndefined();
  });

  it("lets exactly one of two overlapping runs through", async () => {
    const slow = deps([], { source: fakeSource([], { tourDelayMs: 300 }) });
    const results = await Promise.allSettled([run(admin, "123456", slow), run(admin, "123456", slow)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(isAppError(refused.reason) && refused.reason.code === "CONFLICT").toBe(true);
  });

  it("stops at its deadline before the next TravelDesk call, reports incomplete and skips removals and suggestions", async () => {
    // The run's deadline lands while the first tour is being read.
    const start = Date.now() - DEADLINE_MS + 1_500;
    const calls: string[] = [];
    const r = await run(admin, "123456", deps(calls, { source: fakeSource(calls, { tourDelayMs: 2_000 }), now: () => start }));
    expect(r.sync).toMatchObject({ tours: 1, incomplete: true, removalsApplied: false, removalsSkipped: "incomplete" });
    expect(r.candidates).toEqual({ skipped: "incomplete" });
    expect(r.snapshots).toEqual({ skipped: "incomplete" });
    expect(calls).toEqual(["balance", "listTours", `getTour:${BASE}`]);
  });

  it("stops on a rejected key instead of reporting an empty catalogue, audits the failure and releases the lease", async () => {
    const rejected = () => ({
      ...fakeSource([])(),
      async getTour(): Promise<TravelDeskTourDetail> {
        throw new TravelDeskApiError("auth", "tours.get", { status: 401 });
      },
    });
    await expect(run(admin, "123456", deps([], { source: rejected }))).rejects.toBeInstanceOf(TravelDeskApiError);
    const audited = await prisma.auditLog.findFirst({ where: { actorId: admin.id, action: "supplier.catalogue_sync_failed" }, orderBy: { createdAt: "desc" } });
    expect(audited).not.toBeNull();
    const lease = await prisma.setting.findUniqueOrThrow({ where: { key: leaseKey("test", CODE) } });
    expect((lease.value as Record<string, unknown>).holder).toBeUndefined();
  });
});
