import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableDb, createStaff, dbEnabled, runId, syntheticPhone, type StaffFixture } from "@/server/__tests__/helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, makeInquiry, publishedProduct, type SeedProduct } from "@/server/__tests__/security/_mercury-fixtures";
import { resetEnvCache } from "@/server/lib/env";
import { ROLE_PERMISSIONS } from "@/server/lib/permissions";
import type { Actor } from "@/server/lib/actor";
import type { CrmScope } from "@/server/crm/crm.config";
import { FakeBitrix24 } from "./_bitrix-fake";
import { FAKE_SECRET, FAKE_USER, fakeConfig } from "./_memory-store";

/**
 * CRM batch C1 on the disposable database (doc 29 §6.4, §6.5, §7.4): the
 * outbox written inside the domain transaction, versions in commit order, a
 * failing enqueue that never fails the domain write, the Postgres store's
 * claim and link lock, an end-to-end push to the fake portal with no
 * personal data, erasure propagation and the 2-year retention path.
 *
 * Each run uses its own portal host (`crm-<run>.bitrix24.test`), so its rows
 * never meet another run's. All data is synthetic; the fake portal is in
 * process and any real network call fails the suite.
 */

type Prisma = Awaited<ReturnType<typeof db>>;
const run = runId();
const HOST = `crm-${run}.bitrix24.test`;
let prisma: Prisma;
let product: SeedProduct;
let ops: StaffFixture;
let scope: CrmScope;
const saved = { ...process.env };

function actorOf(staff: StaffFixture): Actor {
  return { type: "admin", id: staff.id, roles: ["ops"], permissions: new Set(ROLE_PERMISSIONS.ops) };
}

async function rowsFor(entityId: string) {
  return prisma.crmOutbox.findMany({ where: { portal: HOST, entityId }, orderBy: { version: "asc" } });
}

describe.skipIf(!dbEnabled)("CRM outbox, links and worker (C1)", () => {
  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    process.env.APP_ENV = "development";
    process.env.CRM_BITRIX_ENV = "test";
    process.env.CRM_BITRIX_PORTAL_HOST = HOST;
    process.env.CRM_SYNC_ENABLED = "false";
    resetEnvCache();
    prisma = await db();
    product = await publishedProduct();
    ops = await createStaff(run, "crm-ops", ["ops"]);
    scope = { environment: "development", portal: HOST };
  });

  afterAll(async () => {
    if (!dbEnabled) return;
    await prisma.crmOutbox.deleteMany({ where: { portal: { in: [HOST, `other-${HOST}`] } } });
    await prisma.crmLink.deleteMany({ where: { portal: { in: [HOST, `other-${HOST}`] } } });
    await prisma.crmPortalState.deleteMany({ where: { portal: HOST } });
    await cleanupBusinessRows(run);
    process.env = saved;
    resetEnvCache();
  });

  it("with no portal configured, a domain transaction writes no CRM row", async () => {
    const { enqueueCrmSync } = await import("@/server/crm/crm.outbox");
    const q = await makeInquiry(run, { leadPhone: syntheticPhone(run, 1), product });
    process.env.CRM_BITRIX_PORTAL_HOST = "";
    resetEnvCache();
    try {
      expect(await prisma.$transaction((tx) => enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }]))).toBe(0);
    } finally {
      process.env.CRM_BITRIX_PORTAL_HOST = HOST;
      resetEnvCache();
    }
    expect(await prisma.crmOutbox.count({ where: { entityId: q.id } })).toBe(0);
    expect(await prisma.crmLink.count({ where: { entityId: q.id } })).toBe(0);
  });

  it("a rolled-back domain transaction leaves neither a link nor a row", async () => {
    const { enqueueCrmSync } = await import("@/server/crm/crm.outbox");
    const q = await makeInquiry(run, { leadPhone: syntheticPhone(run, 2), product });
    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }]);
        throw new Error("synthetic rollback");
      }),
    ).rejects.toThrow("synthetic rollback");
    expect(await rowsFor(q.id)).toHaveLength(0);
    expect(await prisma.crmLink.count({ where: { portal: HOST, entityId: q.id } })).toBe(0);
  });

  it("versions follow commit order: a second writer waits on the link row and gets the next version", async () => {
    const { enqueueCrmSync } = await import("@/server/crm/crm.outbox");
    const q = await makeInquiry(run, { leadPhone: syntheticPhone(run, 3), product });
    await prisma.$transaction((tx) => enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }]));
    let firstCommitted = 0;
    const first = prisma.$transaction(async (tx) => {
      await enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }]);
      await new Promise((r) => setTimeout(r, 400));
      firstCommitted = Date.now();
    });
    await new Promise((r) => setTimeout(r, 100));
    let secondDone = 0;
    const second = prisma.$transaction(async (tx) => {
      await enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }]);
      secondDone = Date.now();
    });
    await Promise.all([first, second]);
    expect(secondDone).toBeGreaterThanOrEqual(firstCommitted);
    expect((await rowsFor(q.id)).map((r) => r.version)).toEqual([1n, 2n, 3n]);
    expect(await prisma.crmLink.findFirstOrThrow({ where: { portal: HOST, entityId: q.id } })).toMatchObject({ localVersion: 3n, state: "pending", originId: `inq:${q.id}` });
  });

  it("a failing enqueue rolls back to its savepoint; the domain change still commits", async () => {
    const { enqueueCrmSync } = await import("@/server/crm/crm.outbox");
    const q = await makeInquiry(run, { leadPhone: syntheticPhone(run, 4), product });
    const bad: CrmScope = { environment: "development", portal: "NOT A HOST" };
    await prisma.$transaction(async (tx) => {
      await tx.inquiry.update({ where: { id: q.id }, data: { budgetBand: "zz-crm" } });
      expect(await enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }], bad)).toBe(0);
    });
    expect((await prisma.inquiry.findUniqueOrThrow({ where: { id: q.id } })).budgetBand).toBe("zz-crm");
    expect(await prisma.crmOutbox.count({ where: { entityId: q.id } })).toBe(0);
  });

  it("an inquiry transition writes its outbox row in the same transaction", async () => {
    const { inquiryService } = await import("@/server/services/inquiry.service");
    const q = await makeInquiry(run, { leadPhone: syntheticPhone(run, 5), product, status: "new" });
    await inquiryService.transition(actorOf(ops), q.id, "contacted");
    const rows = await rowsFor(q.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "sync", status: "queued", environment: "development", portal: HOST, entityType: "inquiry", version: 1n });
  });

  it("the store claims only this scope's due rows, skips locked ones, and fences the link lock", async () => {
    const { prismaCrmStore: store } = await import("@/server/crm/crm.store");
    const { enqueueCrmSync } = await import("@/server/crm/crm.outbox");
    const a = await makeInquiry(run, { leadPhone: syntheticPhone(run, 6), product });
    const b = await makeInquiry(run, { leadPhone: syntheticPhone(run, 7), product });
    const other: CrmScope = { environment: "development", portal: `other-${HOST}` };
    await prisma.$transaction((tx) => enqueueCrmSync(tx, [{ type: "inquiry", id: a.id }], other));
    await prisma.$transaction((tx) => enqueueCrmSync(tx, [{ type: "inquiry", id: b.id }]));
    const now = new Date();
    const later = new Date(now.getTime() + 60_000);
    const claimed = [];
    for (let r = await store.claimNext(scope, "h1", now, later); r; r = await store.claimNext(scope, "h1", now, later)) claimed.push(r);
    expect(claimed.map((r) => r.entityId)).not.toContain(a.id);
    expect(claimed.map((r) => r.entityId)).toContain(b.id);
    expect(await store.countForeignDue(scope, now)).toBeGreaterThanOrEqual(1);
    expect(await store.claimNext(scope, "h2", now, later)).toBeNull();
    const lock1 = await store.lockLink(scope, { type: "inquiry", id: b.id }, "h1", now, later);
    expect(lock1.kind).toBe("locked");
    expect((await store.lockLink(scope, { type: "inquiry", id: b.id }, "h2", now, later)).kind).toBe("busy");
    if (lock1.kind === "locked") {
      await store.updateLink(lock1.link.id, "h2", { state: "deleted", deletedAt: now, deleteReason: "erasure" });
      expect((await prisma.crmLink.findUniqueOrThrow({ where: { id: lock1.link.id } })).state).toBe("pending");
      await store.unlockLink(lock1.link.id, "h1");
    }
    for (const r of claimed) await store.deferRow(r.id, "h1", { nextAttemptAt: new Date(now.getTime() + 3_600_000), code: "test" });
  });

  it("pushes a deal to the fake portal with no personal data, then erasure deletes it and tombstones the link", async () => {
    const { prismaCrmStore: store } = await import("@/server/crm/crm.store");
    const { loadSubjectState } = await import("@/server/crm/crm.snapshot");
    const { runCrmWorker, pacedLimiter } = await import("@/server/crm/crm.worker");
    const { BitrixRestClient } = await import("@/server/crm/bitrix.client");
    const { privacyService } = await import("@/server/services/privacy.service");
    const { enqueueCrmSync } = await import("@/server/crm/crm.outbox");
    const leadPhone = syntheticPhone(run, 8);
    const q = await makeInquiry(run, { leadPhone, product, status: "quoted" });
    await prisma.$transaction((tx) => enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }]));

    const config = { ...fakeConfig({ APP_ENV: "development", CRM_BITRIX_PORTAL_HOST: HOST }) };
    const fake = new FakeBitrix24({ host: HOST, userId: FAKE_USER, secret: FAKE_SECRET, now: Date.now });
    const port = new BitrixRestClient(config, { fetchImpl: fake.fetch });
    const deps = () => ({
      config,
      store,
      port,
      loadState: loadSubjectState,
      limiter: pacedLimiter({ minIntervalMs: 0, maxPerRun: 50, now: Date.now, sleep: async () => {} }),
      now: () => new Date(),
    });
    // Rows of earlier tests in this scope are not due (deferred an hour) or already pushed.
    let summary = await runCrmWorker(deps(), { budgetMs: 20_000 });
    expect(summary.outcome).toBe("ran");
    const deal = fake.dealsFor(`inq:${q.id}`);
    expect(deal).toHaveLength(1);
    expect(deal[0]).toMatchObject({ title: `OUTLYY ${q.reference}`, stageId: "C7:QUOTED", categoryId: 7, opportunity: 0 });
    const sent = JSON.stringify([...fake.deals.values()]);
    expect(sent).not.toContain(leadPhone);
    expect(sent).not.toContain("@outlyy.test");
    expect(sent).not.toContain(`zz-sec-${run}`);
    expect(await prisma.crmLink.findFirstOrThrow({ where: { portal: HOST, entityId: q.id } })).toMatchObject({ state: "active", crmId: BigInt(deal[0].id), pushedVersion: 1n });

    const erasure = await privacyService.eraseContact({ type: "admin", id: ops.id, roles: ["admin"], permissions: new Set(["privacy.anonymise"]) }, { phoneE164: leadPhone });
    expect(erasure.status).toBe("completed");
    expect((await rowsFor(q.id)).map((r) => [r.kind, r.reason])).toContainEqual(["delete", "erasure"]);
    summary = await runCrmWorker(deps(), { budgetMs: 20_000 });
    expect(fake.dealsFor(`inq:${q.id}`)).toHaveLength(0);
    expect(await prisma.crmLink.findFirstOrThrow({ where: { portal: HOST, entityId: q.id } })).toMatchObject({ state: "deleted", deleteReason: "erasure" });
    // A later change of the erased inquiry takes no row and never re-creates the deal.
    expect(await prisma.$transaction((tx) => enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }]))).toBe(0);
  });

  it("retention: a copy last pushed over two years ago gets a delete; old finished rows are purged", async () => {
    const { runCrmRetention } = await import("@/server/crm/crm.store");
    const { enqueueCrmSync } = await import("@/server/crm/crm.outbox");
    const q = await makeInquiry(run, { leadPhone: syntheticPhone(run, 9), product });
    await prisma.$transaction((tx) => enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }]));
    const threeYears = new Date(Date.now() - 3 * 365 * 86_400_000);
    await prisma.crmLink.updateMany({ where: { portal: HOST, entityId: q.id }, data: { state: "active", crmId: 999_001n, pushedVersion: 1n, pushedAt: threeYears } });
    await prisma.crmOutbox.updateMany({ where: { portal: HOST, entityId: q.id }, data: { status: "done", outcome: "pushed", updatedAt: threeYears } });
    const r = await runCrmRetention(scope, new Date());
    expect(r.scheduled).toBeGreaterThanOrEqual(1);
    expect(r.purgedOutbox).toBeGreaterThanOrEqual(1);
    const rows = await rowsFor(q.id);
    expect(rows.map((x) => [x.kind, x.reason, x.status])).toEqual([["delete", "retention", "queued"]]);
    // Run again: a pending delete is not doubled.
    expect((await runCrmRetention(scope, new Date())).scheduled).toBe(0);
  });

  it("the schema refuses funnel 0, a foreign originator and a non-deal record type", async () => {
    await expect(prisma.$executeRaw`INSERT INTO crm_portal_state (environment, portal, category_id, originator_id) VALUES ('development', ${`x-${HOST}`}, 0, 'outlyy-development')`).rejects.toThrow();
    await expect(
      prisma.$executeRaw`INSERT INTO crm_links (id, environment, portal, entity_type, entity_id, originator_id, origin_id) VALUES (gen_random_uuid(), 'development', ${HOST}, 'inquiry', gen_random_uuid(), 'someone', 'inq:x')`,
    ).rejects.toThrow();
  });
});
