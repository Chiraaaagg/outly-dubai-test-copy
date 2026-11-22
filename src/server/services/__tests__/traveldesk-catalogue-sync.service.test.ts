import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
    await prisma.supplierSyncRun.deleteMany({ where: { supplierCode: CODE } });
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
    // Batch 1b: the run is recorded with its trigger, account, counts and a finish time.
    const row = await prisma.supplierSyncRun.findUniqueOrThrow({ where: { id: r.run.id } });
    expect(row).toMatchObject({ supplierCode: CODE, environment: "test", triggeredBy: "admin", status: "complete", tours: 2, resumeAfterTourId: null, resumedFromRunId: null, deadlineHit: false });
    expect(row.finishedAt).not.toBeNull();
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

/**
 * Doc 29 Batch 1b: the scheduled run, run rows, resume after the deadline,
 * the removal cap across a resumed pass, overlapping scheduled runs, and the
 * system actor kept off the admin path. Each test syncs under its own
 * run-scoped supplier code; all of them are removed in afterAll.
 */
describe.skipIf(!enabled)("scheduled catalogue sync and run rows (local DB, doc 29 Batch 1b)", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let svc: typeof import("../traveldesk-catalogue-sync.service");
  let readiness: typeof import("../readiness.service").readinessService;
  const codes: string[] = [];
  const newCode = () => {
    const c = `zz-tdr-${RUN}-${codes.length}`;
    codes.push(c);
    return c;
  };
  const base = () => BASE + 1_000 * (codes.length + 1);

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    svc = await import("../traveldesk-catalogue-sync.service");
    ({ readinessService: readiness } = await import("../readiness.service"));
  });

  afterAll(async () => {
    if (!prisma) return;
    for (const code of codes) {
      const sup = await prisma.supplier.findUnique({ where: { code } });
      if (sup) {
        await prisma.supplierMappingCandidate.deleteMany({ where: { supplierId: sup.id } });
        await prisma.supplierPriceSnapshot.deleteMany({ where: { supplierId: sup.id } });
        await prisma.supplierCatalogueItem.deleteMany({ where: { supplierId: sup.id } });
        await prisma.supplier.delete({ where: { id: sup.id } });
      }
      await prisma.setting.deleteMany({ where: { key: { startsWith: `${code}.` } } });
      await prisma.supplierSyncRun.deleteMany({ where: { supplierCode: code } });
    }
    await prisma.$disconnect();
  });

  const live = async (code: string) =>
    (await prisma.supplierCatalogueItem.findMany({ where: { supplier: { code }, environment: "test", removedAt: null }, select: { externalId: true } })).map((i) => Number(i.externalId)).sort((a, b) => a - b);

  it("runs as the system actor without an authenticator code, records a cron run, and audits it", async () => {
    const code = newCode();
    const b = base();
    const stepUp = vi.fn(async () => "invalid_code" as const);
    const calls: string[] = [];
    // stepUp is passed only to prove the scheduled path never consults it.
    const deps = { config, source: fakeSource(calls, { tours: [b, b + 1] }), stepUp, supplierCode: code, readLimits: LIMITS };
    const out = await svc.runScheduledCatalogueSync(deps);
    expect(out.status).toBe("complete");
    expect(stepUp).not.toHaveBeenCalled();
    expect(calls).toEqual(["balance", "listTours", `getTour:${b}`, `getTour:${b + 1}`]);
    const row = await prisma.supplierSyncRun.findFirstOrThrow({ where: { supplierCode: code } });
    expect(row).toMatchObject({ triggeredBy: "cron", status: "complete", tours: 2 });
    const audited = await prisma.auditLog.findFirst({ where: { action: "supplier.catalogue_synced", entityId: code }, orderBy: { createdAt: "desc" } });
    expect(audited?.actorType).toBe("system");
  });

  it("the admin entry point refuses the system actor even with every permission and an accepted code", async () => {
    const { SYSTEM_ACTOR } = await import("../../lib/actor");
    const code = newCode();
    const calls: string[] = [];
    await expect(svc.runTravelDeskCatalogueSync(SYSTEM_ACTOR, "123456", { config, source: fakeSource(calls), stepUp: accept, supplierCode: code, readLimits: LIMITS })).rejects.toSatisfy(
      (e) => isAppError(e) && e.code === "FORBIDDEN",
    );
    expect(calls).toEqual([]);
    expect(await prisma.supplierSyncRun.count({ where: { supplierCode: code } })).toBe(0);
  });

  it("resumes after the deadline from the cursor, and removes only what the whole pass did not see", async () => {
    const code = newCode();
    const b = base();
    const tours = Array.from({ length: 6 }, (_, i) => b + i);
    // A complete earlier pass that also stored a ghost tour, which TravelDesk no longer lists.
    await svc.runTravelDeskCatalogueSync(admin, "123456", { config, source: fakeSource([], { tours: [...tours, b + 50] }), stepUp: accept, supplierCode: code, readLimits: LIMITS });
    expect(await live(code)).toEqual([...tours, b + 50]);
    // Run 1 below uses a clock 4 minutes back; the ghost was last seen before that, as in a real gap between passes.
    await prisma.supplierCatalogueItem.updateMany({ where: { supplier: { code }, externalId: String(b + 50) }, data: { lastSeenAt: new Date(Date.now() - 3_600_000) } });

    // Run 1 hits its deadline while the first tour is read.
    const start = Date.now() - svc.RUN_DEADLINE_MS + 1_500;
    const first: string[] = [];
    const r1 = await svc.runTravelDeskCatalogueSync(admin, "123456", {
      config,
      source: fakeSource(first, { tours, tourDelayMs: 2_000 }),
      stepUp: accept,
      supplierCode: code,
      readLimits: LIMITS,
      now: () => start,
    });
    expect(r1.run).toMatchObject({ status: "incomplete", resumeAfterTourId: b, resumedFromRunId: null });
    expect(r1.sync).toMatchObject({ incomplete: true, removalsSkipped: "incomplete", removed: 0 });
    expect(first).toEqual(["balance", "listTours", `getTour:${b}`]);
    // Never remove on a partial run: the ghost is still live.
    expect(await live(code)).toEqual([...tours, b + 50]);
    const row1 = await prisma.supplierSyncRun.findUniqueOrThrow({ where: { id: r1.run.id } });
    expect(row1).toMatchObject({ status: "incomplete", resumeAfterTourId: b, deadlineHit: true });

    // Run 2 (the scheduled one) continues after the cursor and completes the pass.
    const second: string[] = [];
    const out = await svc.runScheduledCatalogueSync({ config, source: fakeSource(second, { tours }), supplierCode: code, readLimits: LIMITS });
    expect(out.status).toBe("complete");
    expect(second).toEqual(["balance", "listTours", ...tours.slice(1).map((t) => `getTour:${t}`)]);
    if (out.status !== "complete") throw new Error("unreachable");
    expect(out.result.run).toMatchObject({ status: "complete", resumedFromRunId: r1.run.id, resumeAfterTourId: null });
    // The first tour, read only by run 1, is kept; the ghost, unseen by the whole pass, is removed.
    expect(out.result.sync).toMatchObject({ removalsApplied: true, removed: 1 });
    expect(await live(code)).toEqual(tours);
    const row2 = await prisma.supplierSyncRun.findUniqueOrThrow({ where: { id: out.result.run.id } });
    expect(row2.passStartedAt.getTime()).toBe(row1.passStartedAt.getTime());

    // The next run starts a fresh pass from the first tour.
    const third: string[] = [];
    await svc.runScheduledCatalogueSync({ config, source: fakeSource(third, { tours }), supplierCode: code, readLimits: LIMITS });
    expect(third).toContain(`getTour:${b}`);
  });

  it("does not continue a pass older than the resume limit, nor one the platform stopped", async () => {
    const code = newCode();
    const b = base();
    const tours = [b, b + 1, b + 2];
    const old = new Date(Date.now() - svc.RESUME_MAX_PASS_AGE_MS - 60_000);
    await prisma.supplierSyncRun.create({
      data: { id: uuidv7(), supplierCode: code, environment: "test", accountId: "zz", triggeredBy: "cron", status: "incomplete", startedAt: old, passStartedAt: old, finishedAt: old, resumeAfterTourId: b },
    });
    const calls: string[] = [];
    await svc.runScheduledCatalogueSync({ config, source: fakeSource(calls, { tours }), supplierCode: code, readLimits: LIMITS });
    expect(calls).toContain(`getTour:${b}`);

    // A row left running (the platform stopped the function) is closed as abandoned, and the pass it continued is not picked up again.
    const recent = new Date(Date.now() - 600_000);
    await prisma.supplierSyncRun.create({
      data: { id: uuidv7(), supplierCode: code, environment: "test", accountId: "zz", triggeredBy: "cron", status: "incomplete", startedAt: recent, passStartedAt: recent, finishedAt: recent, resumeAfterTourId: b },
    });
    const stuck = await prisma.supplierSyncRun.create({
      data: { id: uuidv7(), supplierCode: code, environment: "test", accountId: "zz", triggeredBy: "cron", status: "running", startedAt: recent, passStartedAt: recent },
    });
    const again: string[] = [];
    await svc.runScheduledCatalogueSync({ config, source: fakeSource(again, { tours }), supplierCode: code, readLimits: LIMITS });
    expect(again).toContain(`getTour:${b}`);
    expect(await prisma.supplierSyncRun.findUniqueOrThrow({ where: { id: stuck.id } })).toMatchObject({ status: "failed", errorCode: "abandoned" });
  });

  it("removal cap: a pull that would remove more than 20% removes nothing, and a plausible one removes", async () => {
    const code = newCode();
    const b = base();
    const ten = Array.from({ length: 10 }, (_, i) => b + i);
    const run = (tours: number[]) => svc.runScheduledCatalogueSync({ config, source: fakeSource([], { tours }), supplierCode: code, readLimits: LIMITS });
    await run(ten);
    expect(await live(code)).toEqual(ten);

    const half = await run(ten.slice(0, 5));
    if (half.status !== "complete") throw new Error(`expected complete, got ${half.status}`);
    expect(half.result.sync).toMatchObject({ removalsApplied: false, removalsSkipped: "too_many_removals", removed: 0 });
    expect(await live(code)).toEqual(ten);
    expect(await prisma.supplierSyncRun.findUniqueOrThrow({ where: { id: half.result.run.id } })).toMatchObject({ status: "complete", removalsSkipped: "too_many_removals", removed: 0 });

    // An empty tour list is suspicious too, and it read nothing: it does not refresh the catalogue's age for readiness.
    const { lastCompleteSync } = await import("../supplier-catalog.service");
    const before = await lastCompleteSync(code, "test");
    expect(before).not.toBeNull();
    const empty = await run([]);
    if (empty.status !== "complete") throw new Error(`expected complete, got ${empty.status}`);
    expect(empty.result.sync).toMatchObject({ removalsSkipped: "empty_tour_list", removed: 0 });
    expect(await live(code)).toEqual(ten);
    expect(await lastCompleteSync(code, "test")).toEqual(before);

    const one = await run(ten.slice(0, 9));
    if (one.status !== "complete") throw new Error(`expected complete, got ${one.status}`);
    expect(one.result.sync).toMatchObject({ removalsApplied: true, removed: 1 });
    expect(await live(code)).toEqual(ten.slice(0, 9));
  });

  it("overlapping scheduled runs: one syncs, the other is skipped by the lease and writes no run row", async () => {
    const code = newCode();
    const b = base();
    const reevaluate = vi.spyOn(readiness, "reevaluateInstantCandidates").mockResolvedValue();
    try {
      const deps = { config, source: fakeSource([], { tours: [b, b + 1], tourDelayMs: 300 }), supplierCode: code, readLimits: LIMITS };
      const outs = await Promise.all([svc.runScheduledCatalogueSync(deps), svc.runScheduledCatalogueSync(deps)]);
      expect(outs.map((o) => o.status).sort()).toEqual(["complete", "skipped"]);
      expect(outs.find((o) => o.status === "skipped")).toMatchObject({ reason: "lease_held" });
      expect(await prisma.supplierSyncRun.count({ where: { supplierCode: code } })).toBe(1);
      // Neither re-runs readiness here: the complete one did through the sync, the skipped one leaves it to the lease holder.
      expect(reevaluate).not.toHaveBeenCalled();
    } finally {
      reevaluate.mockRestore();
    }
  });

  it("a rejected key fails the scheduled run with a short code and re-checks readiness for the catalogue's age", async () => {
    const code = newCode();
    const reevaluate = vi.spyOn(readiness, "reevaluateInstantCandidates").mockResolvedValue();
    try {
      const rejected = () => ({
        ...fakeSource([])(),
        async getTour(): Promise<TravelDeskTourDetail> {
          throw new TravelDeskApiError("auth", "tours.get", { status: 401 });
        },
      });
      const out = await svc.runScheduledCatalogueSync({ config, source: rejected, supplierCode: code, readLimits: LIMITS });
      expect(out).toEqual({ status: "failed", errorCode: "traveldesk_auth" });
      expect(await prisma.supplierSyncRun.findFirstOrThrow({ where: { supplierCode: code } })).toMatchObject({ status: "failed", errorCode: "traveldesk_auth", resumeAfterTourId: null });
      expect(reevaluate).toHaveBeenCalledWith("catalogue_age");
      const lease = await prisma.setting.findUniqueOrThrow({ where: { key: svc.catalogueSyncLeaseKey("test", code) } });
      expect((lease.value as Record<string, unknown>).holder).toBeUndefined();
    } finally {
      reevaluate.mockRestore();
    }
  });
});
