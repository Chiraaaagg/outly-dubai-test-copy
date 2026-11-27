import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableDb, createStaff, dbEnabled, runId, syntheticPhone, type StaffFixture } from "@/server/__tests__/helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, makeInquiry, publishedProduct, type SeedProduct } from "@/server/__tests__/security/_mercury-fixtures";
import { resetEnvCache } from "@/server/lib/env";
import { ROLE_PERMISSIONS } from "@/server/lib/permissions";
import type { Actor } from "@/server/lib/actor";
import type { CrmScope } from "@/server/crm/crm.config";
import { FakeBitrix24 } from "./_bitrix-fake";
import { FAKE_SECRET, FAKE_USER, fakeConfig, fakeEnv, fieldCode } from "./_memory-store";

/**
 * CRM batches C1 and C2a on the disposable database (doc 29 §6.4, §6.5,
 * §7.4): the outbox written inside the domain transaction, versions in
 * commit order, a failing enqueue that never fails the domain write, no new
 * link while the sync is off (no backfill), the Postgres store's claim and
 * link lock, an end-to-end push to the fake portal with the customer's
 * details in their own deal fields only, erasure propagation and the 2-year
 * retention path.
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
    // On and fully configured (synthetic values), so enqueues link new subjects: since C2a, while off or not
    // deliverable only linked subjects queue (review C2A-04). The worker is run directly below with its own
    // config; the job route is not called here.
    for (const [k, v] of Object.entries(fakeEnv({ APP_ENV: "development", CRM_BITRIX_PORTAL_HOST: HOST }))) if (v !== undefined) process.env[k] = String(v);
    process.env.CRM_SYNC_ENABLED = "true";
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
    await prisma.crmPortalState.deleteMany({ where: { portal: { in: [HOST, `r03-${HOST}`] } } });
    await prisma.crmLink.deleteMany({ where: { portal: `r03-${HOST}` } });
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

  it("sync off: a new subject gets no link and no row (no backfill); a linked one keeps queueing", async () => {
    const { enqueueCrmSync } = await import("@/server/crm/crm.outbox");
    const q = await makeInquiry(run, { leadPhone: syntheticPhone(run, 12), product });
    process.env.CRM_SYNC_ENABLED = "false";
    resetEnvCache();
    try {
      expect(await prisma.$transaction((tx) => enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }]))).toBe(0);
      expect(await prisma.crmLink.count({ where: { portal: HOST, entityId: q.id } })).toBe(0);
      expect(await rowsFor(q.id)).toHaveLength(0);
      // Linked while on: later changes queue while off, and wait.
      expect(await prisma.$transaction((tx) => enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }], scope, true))).toBe(1);
      expect(await prisma.$transaction((tx) => enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }]))).toBe(1);
      expect((await rowsFor(q.id)).map((r) => r.version)).toEqual([1n, 2n]);
    } finally {
      process.env.CRM_SYNC_ENABLED = "true";
      resetEnvCache();
    }
    await prisma.crmOutbox.updateMany({ where: { portal: HOST, entityId: q.id }, data: { nextAttemptAt: new Date(Date.now() + 3_600_000) } });
  });

  it("a WhatsApp STOP re-pushes the linked deal, and the snapshot shows the withdrawal with its time (C2A-02)", async () => {
    const { enqueueCrmSync } = await import("@/server/crm/crm.outbox");
    const { recordConsent } = await import("@/server/repositories/consent.repo");
    const { loadSubjectState } = await import("@/server/crm/crm.snapshot");
    const leadPhone = syntheticPhone(run, 13);
    const q = await makeInquiry(run, { leadPhone, product });
    await prisma.$transaction((tx) => enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }]));
    await recordConsent({ phoneE164: leadPhone, channel: "whatsapp", purpose: "marketing", granted: true, source: "profile" });
    await recordConsent({ phoneE164: leadPhone, channel: "whatsapp", purpose: "marketing", granted: false, source: "stop_keyword" });
    expect((await rowsFor(q.id)).map((r) => r.version)).toEqual([1n, 2n, 3n]);
    const state = await loadSubjectState({ type: "inquiry", id: q.id });
    expect(state.consent?.marketingWhatsapp).toMatchObject({ granted: false, at: expect.stringMatching(/\+00:00$/) });
    // A transactional consent does not touch the CRM.
    await recordConsent({ phoneE164: leadPhone, channel: "whatsapp", purpose: "transactional", granted: false, source: "stop_keyword" });
    expect(await rowsFor(q.id)).toHaveLength(3);
    await prisma.crmOutbox.updateMany({ where: { portal: HOST, entityId: q.id }, data: { nextAttemptAt: new Date(Date.now() + 3_600_000) } });
  });

  it("the switch-on time is the earlier of the first worker run and the first link (R-03)", async () => {
    const { prismaCrmStore: store } = await import("@/server/crm/crm.store");
    const { enqueueCrmSync } = await import("@/server/crm/crm.outbox");
    const q = await makeInquiry(run, { leadPhone: syntheticPhone(run, 15), product });
    const late: CrmScope = { environment: "development", portal: `r03-${HOST}` };
    await prisma.$transaction((tx) => enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }], late, true));
    const linkedAt = new Date(Date.now() - 45 * 60_000);
    await prisma.crmLink.updateMany({ where: { portal: late.portal, entityId: q.id }, data: { createdAt: linkedAt } });
    const portal = await store.ensurePortal(late, { categoryId: 7, originatorId: "outlyy-development" });
    expect(portal.createdAt.getTime()).toBe(linkedAt.getTime());
    // Later runs keep it.
    expect((await store.ensurePortal(late, { categoryId: 7, originatorId: "outlyy-development" })).createdAt.getTime()).toBe(linkedAt.getTime());
    await prisma.crmOutbox.deleteMany({ where: { portal: late.portal } });
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

  it("a writer that cannot get the link lock in time never waits out its transaction: it writes a deferred row (review R12)", async () => {
    const { enqueueCrmSync, CRM_DEFERRED_VERSION } = await import("@/server/crm/crm.outbox");
    const q = await makeInquiry(run, { leadPhone: syntheticPhone(run, 10), product });
    await prisma.$transaction((tx) => enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }]));
    let firstCommitted = 0;
    const first = prisma.$transaction(
      async (tx) => {
        await enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }]);
        await new Promise((r) => setTimeout(r, 3_000));
        firstCommitted = Date.now();
      },
      { timeout: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 200));
    let secondDone = 0;
    let after = "";
    const second = prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '7s'");
        expect(await enqueueCrmSync(tx, [{ type: "inquiry", id: q.id }])).toBe(1);
        after = (await tx.$queryRaw<{ v: string }[]>`SELECT current_setting('lock_timeout') AS v`)[0].v;
        secondDone = Date.now();
      },
      { timeout: 10_000 },
    );
    await Promise.all([first, second]);
    // The second writer gave up on the lock after about a second, well before the first committed.
    expect(secondDone).toBeLessThan(firstCommitted);
    expect(after).toBe("7s");
    const rows = await rowsFor(q.id);
    expect(rows.map((r) => r.version)).toEqual([1n, 2n, CRM_DEFERRED_VERSION]);
    expect(rows[2].dedupeKey).toContain(":deferred-");
    expect(rows[2].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(await prisma.crmLink.findFirstOrThrow({ where: { portal: HOST, entityId: q.id } })).toMatchObject({ localVersion: 2n });
    // Keep it out of the end-to-end push below.
    await prisma.crmOutbox.updateMany({ where: { portal: HOST, entityId: q.id }, data: { nextAttemptAt: new Date(Date.now() + 3_600_000) } });
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

  it("pushes a deal to the fake portal with the customer's details in their own fields only, then erasure deletes it and tombstones the link", async () => {
    const { prismaCrmStore: store } = await import("@/server/crm/crm.store");
    const { loadSubjectState } = await import("@/server/crm/crm.snapshot");
    const { runCrmWorker, pacedLimiter } = await import("@/server/crm/crm.worker");
    const { BitrixRestClient } = await import("@/server/crm/bitrix.client");
    const { privacyService } = await import("@/server/services/privacy.service");
    const { enqueueCrmSync } = await import("@/server/crm/crm.outbox");
    const leadPhone = syntheticPhone(run, 8);
    const q = await makeInquiry(run, { leadPhone, product, status: "quoted" });
    // An agent typed the customer's name into a line title (review R14): the deal shows the catalogue's title instead.
    const lead = (await prisma.inquiry.findUniqueOrThrow({ where: { id: q.id } })).leadName;
    await prisma.inquiryItem.update({ where: { id: q.itemIds[0] }, data: { titleSnapshot: `Pickup for ${lead}` } });
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
    expect(deal[0].productRows.map((r) => r.productName)).toEqual([`${product.title} (2027-01-15)`, `${product.title} (2027-01-15)`]);
    // C2a (decision C2-4): name, phone and email on the deal's own fields; nowhere else; no Contact record.
    const leadEmail = (await prisma.inquiry.findUniqueOrThrow({ where: { id: q.id } })).leadEmail;
    expect(deal[0]).toMatchObject({ [fieldCode("customer_name")]: lead, [fieldCode("customer_phone")]: leadPhone, [fieldCode("customer_email")]: leadEmail, [fieldCode("environment")]: "development" });
    const rest = JSON.stringify(
      [...fake.deals.values()].map((d) =>
        Object.fromEntries(Object.entries(d).filter(([k]) => ![fieldCode("customer_name"), fieldCode("customer_phone"), fieldCode("customer_email")].includes(k as never))),
      ),
    );
    expect(rest).not.toContain(leadPhone);
    expect(rest).not.toContain("@outlyy.test");
    expect(rest).not.toContain(`zz-sec-${run}`);
    // Never sent: the hotel, the special requests, the attribution.
    const sent = JSON.stringify([...fake.deals.values()]);
    expect(sent).not.toContain("Hotel lead");
    expect(sent).not.toContain("requests lead");
    expect(sent).not.toContain(`fb-${run}`);
    expect(fake.refusedMethods).toEqual([]);
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

  it("erasure deletes the deal of an order kept for an obligation too (C2A-07)", async () => {
    const { makeOrder } = await import("@/server/__tests__/security/_mercury-fixtures");
    const { enqueueCrmSync } = await import("@/server/crm/crm.outbox");
    const { privacyService } = await import("@/server/services/privacy.service");
    const leadPhone = syntheticPhone(run, 14);
    // Captured just now: inside the dispute window, so the order is deferred, not erased.
    const o = await makeOrder(run, { leadPhone, label: "deferred" });
    await prisma.$transaction((tx) => enqueueCrmSync(tx, [{ type: "order", id: o.id }]));
    const erasure = await privacyService.eraseContact({ type: "admin", id: ops.id, roles: ["admin"], permissions: new Set(["privacy.anonymise"]) }, { phoneE164: leadPhone });
    expect(erasure.status).not.toBe("completed");
    expect((await rowsFor(o.id)).map((r) => [r.kind, r.reason])).toContainEqual(["delete", "erasure"]);
    await prisma.crmOutbox.updateMany({ where: { portal: HOST, entityId: o.id }, data: { nextAttemptAt: new Date(Date.now() + 3_600_000) } });
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

  it("a dead-lettered CRM delete raises an ops-alert incident, ids only, that ops_alerts can store (review R13)", async () => {
    const { crmDeleteIncidents } = await import("@/server/services/ops-alert.service");
    const { uuidv7 } = await import("@/server/lib/ids");
    const q = await makeInquiry(run, { leadPhone: syntheticPhone(run, 11), product });
    const id = uuidv7();
    await prisma.crmOutbox.create({
      data: { id, environment: "development", portal: HOST, entityType: "inquiry", entityId: q.id, kind: "delete", version: 1n, dedupeKey: `delete:inquiry:${q.id}:dead@${HOST}`, reason: "erasure", status: "dead", attempts: 8, outcome: "dead", lastErrorCode: "unavailable" },
    });
    const since = new Date(Date.now() - 3_600_000);
    const found = (await crmDeleteIncidents(since, new Date(Date.now() + 60_000))).filter((i) => i.entityId === `inquiry:${q.id}`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "crm_delete_failed", entityKind: "crm_subject", reason: "crm_erasure_delete_dead", orderReference: null, adminPath: "/admin" });
    expect(JSON.stringify(found[0])).not.toContain(q.leadPhone);
    // Migration 20261122140000 lets ops_alerts key the incident.
    const alertId = uuidv7();
    await prisma.$executeRaw`INSERT INTO ops_alerts (id, entity_kind, entity_id, reason, incident_at, handled_at, updated_at) VALUES (${alertId}::uuid, 'crm_subject', ${found[0].entityId}, ${found[0].reason}, now(), now(), now())`;
    await prisma.$executeRaw`DELETE FROM ops_alerts WHERE id = ${alertId}::uuid`;
    // C2A-08: a delete whose linked deal was not visible is its own reason, so an administrator checks other funnels.
    await prisma.crmOutbox.update({ where: { id }, data: { lastErrorCode: "refused:linked_deal_not_visible" } });
    const unverified = (await crmDeleteIncidents(since, new Date(Date.now() + 60_000))).filter((i) => i.entityId === `inquiry:${q.id}`);
    expect(unverified.map((i) => i.reason)).toEqual(["crm_erasure_deal_not_visible"]);
        // A sync row that died, or a delete still queued, is not this incident.
    await prisma.crmOutbox.update({ where: { id }, data: { status: "queued" } });
    expect((await crmDeleteIncidents(since, new Date(Date.now() + 60_000))).filter((i) => i.entityId === `inquiry:${q.id}`)).toHaveLength(0);
    await prisma.crmOutbox.update({ where: { id }, data: { nextAttemptAt: new Date(Date.now() + 3_600_000) } });
  });

  it("C2b timeline: moments are unique per deal, claimed after the quiet period, settled once; stale claims become unknown", async () => {
    const { prismaCrmStore: store } = await import("@/server/crm/crm.store");
    const { uuidv7 } = await import("@/server/lib/ids");
    const q = await makeInquiry(run, { leadPhone: syntheticPhone(run, 15), product });
    const linkId = uuidv7();
    await prisma.crmLink.create({
      data: { id: linkId, environment: "development", portal: HOST, entityType: "inquiry", entityId: q.id, crmId: 777_001n, originatorId: "outlyy-development", originId: `inq:${q.id}`, state: "active", localVersion: 1n, pushedVersion: 1n },
    });
    const t0 = new Date(Date.now() - 10 * 60_000);
    const moments = [
      { key: "paid", kind: "paid" as const, amountAedMinor: 25_000n },
      { key: "refund:500", kind: "refund" as const, amountAedMinor: 500n },
    ];
    expect(await store.recordTimelineMoments(linkId, moments, t0)).toBe(2);
    // Recorded again (a re-push, a retry): nothing new.
    expect(await store.recordTimelineMoments(linkId, moments, new Date())).toBe(0);
    const now = new Date();
    const optsAt = (quietMs: number) => ({ quietBefore: new Date(now.getTime() - quietMs), maxWaitBefore: new Date(now.getTime() - 60 * 60_000), staleBefore: new Date(now.getTime() - 120_000), limit: 3, perLink: 10 });
    // Noticed 10 minutes ago: not quiet enough for a 20-minute window, quiet enough for 3 minutes.
    expect((await store.claimTimeline(scope, "h1", now, optsAt(20 * 60_000))).filter((g) => g.linkId === linkId)).toEqual([]);
    const [g] = (await store.claimTimeline(scope, "h1", now, optsAt(3 * 60_000))).filter((x) => x.linkId === linkId);
    expect(g).toMatchObject({ linkId, crmId: 777_001, attempts: 0 });
    expect(g.entries.map((e) => [e.kind, e.amountAedMinor])).toEqual(expect.arrayContaining([["paid", 25_000n], ["refund", 500n]]));
    // Claimed: another holder gets nothing; a foreign holder cannot settle them.
    expect((await store.claimTimeline(scope, "h2", now, optsAt(3 * 60_000))).filter((x) => x.linkId === linkId)).toEqual([]);
    await store.finishTimeline(g.entries.map((e) => e.id), "h2", { status: "posted", crmCommentId: 1, at: now });
    expect(await prisma.crmTimelineComment.count({ where: { linkId, status: "posting" } })).toBe(2);
    await store.finishTimeline([g.entries[0].id], "h1", { status: "posted", crmCommentId: 9_001, at: now });
    expect(await prisma.crmTimelineComment.findUniqueOrThrow({ where: { id: g.entries[0].id } })).toMatchObject({ status: "posted", crmCommentId: 9_001n, postingBy: null });
    // The other stays posting past the stale limit: the next claim settles it unknown, never re-posted.
    const later = new Date(now.getTime() + 10 * 60_000);
    await store.claimTimeline(scope, "h3", later, { quietBefore: later, maxWaitBefore: later, staleBefore: new Date(later.getTime() - 120_000), limit: 3, perLink: 10 });
    expect(await prisma.crmTimelineComment.findUniqueOrThrow({ where: { id: g.entries[1].id } })).toMatchObject({ status: "unknown", lastErrorCode: "posting_lapsed" });
    // A deleted link drops its pending moments.
    expect(await store.recordTimelineMoments(linkId, [{ key: "confirmed", kind: "confirmed", amountAedMinor: null }], t0)).toBe(1);
    await prisma.crmLink.update({ where: { id: linkId }, data: { state: "deleted", deletedAt: new Date(), deleteReason: "erasure" } });
    expect((await store.claimTimeline(scope, "h4", later, optsAt(0))).filter((x) => x.linkId === linkId)).toEqual([]);
    expect(await prisma.crmTimelineComment.findFirstOrThrow({ where: { linkId, momentKey: "confirmed" } })).toMatchObject({ status: "dropped", lastErrorCode: "link_deleted" });
    // The schema refuses a kind or key outside the list, and an amount that is not positive.
    await expect(prisma.crmTimelineComment.create({ data: { id: uuidv7(), linkId, momentKey: "note", kind: "note", noticedAt: now } })).rejects.toThrow();
    await expect(prisma.crmTimelineComment.create({ data: { id: uuidv7(), linkId, momentKey: "refund:abc", kind: "refund", noticedAt: now } })).rejects.toThrow();
    await expect(prisma.crmTimelineComment.create({ data: { id: uuidv7(), linkId, momentKey: "paid2", kind: "paid", noticedAt: now } })).rejects.toThrow();
    await expect(prisma.crmTimelineComment.create({ data: { id: uuidv7(), linkId, momentKey: "tickets_sent", kind: "tickets_sent", amountAedMinor: 0n, noticedAt: now } })).rejects.toThrow();
    // Retention purges a purged tombstone's timeline record with it.
    const { runCrmRetention } = await import("@/server/crm/crm.store");
    await prisma.crmLink.update({ where: { id: linkId }, data: { deletedAt: new Date(Date.now() - 3 * 365 * 86_400_000) } });
    const r = await runCrmRetention(scope, new Date());
    expect(r.purgedLinks).toBeGreaterThanOrEqual(1);
    expect(await prisma.crmTimelineComment.count({ where: { linkId } })).toBe(0);
  });

  it("C2b alerts (G11): a dead sync row and an open circuit raise incidents that ops_alerts can store, ids and codes only", async () => {
    const { crmSyncDeadIncidents, crmPortalIncidents, crmDeleteIncidents } = await import("@/server/services/ops-alert.service");
    const { AUTH_PAUSE_MS } = await import("@/server/crm/crm.worker");
    const { uuidv7 } = await import("@/server/lib/ids");
    const q = await makeInquiry(run, { leadPhone: syntheticPhone(run, 16), product });
    const id = uuidv7();
    await prisma.crmOutbox.create({
      data: { id, environment: "development", portal: HOST, entityType: "inquiry", entityId: q.id, kind: "sync", version: 1n, dedupeKey: `sync:inquiry:${q.id}:dead@${HOST}`, status: "dead", attempts: 8, outcome: "dead", lastErrorCode: "unavailable:timeout" },
    });
    const since = new Date(Date.now() - 3_600_000);
    const until = new Date(Date.now() + 60_000);
    const dead = (await crmSyncDeadIncidents(since, until)).filter((i) => i.entityId === `inquiry:${q.id}`);
    expect(dead).toEqual([
      expect.objectContaining({ kind: "crm_sync_dead", entityKind: "crm_subject", reason: "crm_sync_dead_unavailable", orderId: null, orderReference: null, adminPath: `/admin/inquiries/${q.id}` }),
    ]);
    expect(JSON.stringify(dead)).not.toContain(q.leadPhone);
    // An erased subject's sync row that could not see its deal is the delete incident instead (C2A-08).
    await prisma.crmOutbox.update({ where: { id }, data: { lastErrorCode: "refused:linked_deal_not_visible" } });
    expect((await crmSyncDeadIncidents(since, until)).filter((i) => i.entityId === `inquiry:${q.id}`)).toEqual([]);
    expect((await crmDeleteIncidents(since, until)).filter((i) => i.entityId === `inquiry:${q.id}`).map((i) => i.reason)).toEqual(["crm_erasure_deal_not_visible"]);
    // C2B-05: the same for a sync row that died on another delete code (an unknown delete answer).
    await prisma.crmOutbox.update({ where: { id }, data: { lastErrorCode: "invalid_response:delete_result_object" } });
    expect((await crmSyncDeadIncidents(since, until)).filter((i) => i.entityId === `inquiry:${q.id}`)).toEqual([]);
    expect((await crmDeleteIncidents(since, until)).filter((i) => i.entityId === `inquiry:${q.id}`).map((i) => i.reason)).toEqual(["crm_erasure_delete_dead"]);
    await prisma.crmOutbox.update({ where: { id }, data: { status: "queued", nextAttemptAt: new Date(Date.now() + 3_600_000) } });

    const portal = `g11-${HOST}`;
    const openedAt = new Date(Date.now() - 5 * 60_000);
    await prisma.crmPortalState.create({ data: { environment: "development", portal, categoryId: 7, originatorId: "outlyy-development", pauseReason: "auth", pausedUntil: new Date(openedAt.getTime() + AUTH_PAUSE_MS) } });
    try {
      const paused = (await crmPortalIncidents(since, until)).filter((i) => i.reason === "crm_auth_refused" && i.raisedAt.getTime() === openedAt.getTime());
      expect(paused).toEqual([expect.objectContaining({ kind: "crm_sync_paused", entityKind: "crm_subject", entityId: "portal:development" })]);
      const alertId = uuidv7();
      await prisma.$executeRaw`INSERT INTO ops_alerts (id, entity_kind, entity_id, reason, incident_at, handled_at, updated_at) VALUES (${alertId}::uuid, 'crm_subject', ${paused[0].entityId}, ${paused[0].reason}, now(), now(), now())`;
      await prisma.$executeRaw`DELETE FROM ops_alerts WHERE id = ${alertId}::uuid`;
    } finally {
      await prisma.crmPortalState.deleteMany({ where: { portal } });
    }
  });

  it("C2B-03: a staff flag on a linked paid order is the handed-to-team moment, once, from the flag alone", async () => {
    const { prismaCrmStore: store } = await import("@/server/crm/crm.store");
    const { loadSubjectState } = await import("@/server/crm/crm.snapshot");
    const { uuidv7 } = await import("@/server/lib/ids");
    const supplier = await prisma.supplier.findFirstOrThrow({ select: { id: true } });
    const phone = syntheticPhone(run, 17);
    const guest = await prisma.guest.create({ data: { id: uuidv7(), phoneE164: phone, fullName: `zz-c2b-${run}` } });
    const combo = await prisma.combo.create({ data: { id: uuidv7(), slug: `zz-c2b-${run}-${uuidv7().slice(-8)}`, name: "zz-c2b", confirmation: "manual" } });
    const o = await prisma.order.create({
      data: { id: uuidv7(), reference: `OUT-${String(Math.floor(Math.random() * 9e9) + 1e9)}`, rail: "assisted", guestId: guest.id, currency: "AED", subtotalInr: 0n, subtotalAed: 1000n, totalInr: 0n, totalAed: 1000n, leadName: `zz-c2b-${run}`, leadPhone: phone },
    });
    const item = await prisma.orderItem.create({
      data: {
        id: uuidv7(), orderId: o.id, comboId: combo.id, titleSnapshot: "zz-c2b", tierSnapshot: "C", slugSnapshot: combo.slug, kindSnapshot: "combo", confirmationSnapshot: "manual",
        fulfilmentModeSnapshot: "inquiry", freeCancellationHoursSnapshot: 24, durationMinutesSnapshot: 60, serviceDate: new Date("2030-01-15"), pax: { adult: 1 }, unitInr: 0n, unitAed: 1000n, totalInr: 0n, totalAed: 1000n,
      },
    });
    const booking = await prisma.supplierBooking.create({
      data: {
        id: uuidv7(), orderId: o.id, orderItemId: item.id, supplierId: supplier.id, environment: "test", idempotencyKey: `c2b-${run}-${uuidv7()}`, clientRef: `OUTTD-C2B${uuidv7().slice(-12)}`,
        bookingKind: "live_book", afterReserve: "await_payment", state: "awaiting_external", tourExternalId: "1", offerExternalId: "1", serviceDate: new Date("2030-01-15"),
        adults: 1, guestName: "zz-c2b", expectedNetMinor: 1000n, expectedNetUsdMinor: 270n,
      },
    });
    const linkId = uuidv7();
    await prisma.crmLink.create({ data: { id: linkId, environment: "development", portal: HOST, entityType: "order", entityId: o.id, crmId: 777_002n, originatorId: "outlyy-development", originId: `ord:${o.id}`, state: "active", localVersion: 1n, pushedVersion: 1n } });
    const now = new Date();
    let sagaId: string | null = null;
    try {
      // Not flagged yet; then a hand-off but no paid moment: nothing.
      expect(await store.recordHandoffMoments!(scope, now)).toBe(0);
      expect((await loadSubjectState({ type: "order", id: o.id })).order?.handedToTeam).toBe(false);
      await prisma.supplierBooking.update({ where: { id: booking.id }, data: { attentionRequiredAt: now, errorCode: "external_confirmation_handoff" } });
      expect(await store.recordHandoffMoments!(scope, now)).toBe(0);
      await store.recordTimelineMoments(linkId, [{ key: "paid", kind: "paid", amountAedMinor: 1000n }], now);
      // R-01: staff flags that are not a supplier-confirmation hand-off never count (snapshot and sweep alike).
      for (const errorCode of ["account_mismatch", "late_acceptance", "late_acceptance_duplicate", "funds_unverified", "charged_amount_mismatch", "external_booking_failed"]) {
        await prisma.supplierBooking.update({ where: { id: booking.id }, data: { attentionRequiredAt: now, errorCode } });
        expect((await loadSubjectState({ type: "order", id: o.id })).order?.handedToTeam, errorCode).toBe(false);
        expect(await store.recordHandoffMoments!(scope, now), errorCode).toBe(0);
      }
      // A payment-saga flag (refund failed, gateway mismatch or error) is never a hand-off.
      await prisma.supplierBooking.update({ where: { id: booking.id }, data: { attentionRequiredAt: null, errorCode: null } });
      sagaId = uuidv7();
      await prisma.paymentSaga.create({ data: { id: sagaId, orderId: o.id, orderItemId: item.id, rail: "aed_card", state: "attention", attentionRequiredAt: now } });
      expect((await loadSubjectState({ type: "order", id: o.id })).order?.handedToTeam).toBe(false);
      expect(await store.recordHandoffMoments!(scope, now)).toBe(0);
      await prisma.supplierBooking.update({ where: { id: booking.id }, data: { attentionRequiredAt: now, errorCode: "external_confirmation_handoff" } });
      expect((await loadSubjectState({ type: "order", id: o.id })).order?.handedToTeam).toBe(true);
      expect(await store.recordHandoffMoments!(scope, now)).toBe(1);
      expect(await store.recordHandoffMoments!(scope, now)).toBe(0);
      expect(await prisma.crmTimelineComment.findFirstOrThrow({ where: { linkId, momentKey: "handed_to_team" } })).toMatchObject({ kind: "handed_to_team", status: "pending", amountAedMinor: null });
    } finally {
      await prisma.crmTimelineComment.deleteMany({ where: { linkId } });
      await prisma.crmLink.deleteMany({ where: { id: linkId } });
      if (sagaId) await prisma.paymentSaga.deleteMany({ where: { id: sagaId } });
      await prisma.supplierBooking.deleteMany({ where: { id: booking.id } });
      await prisma.orderItem.deleteMany({ where: { id: item.id } });
      await prisma.order.deleteMany({ where: { id: o.id } });
      await prisma.combo.deleteMany({ where: { id: combo.id } });
      await prisma.guest.deleteMany({ where: { id: guest.id } });
    }
  });

  it("the schema refuses funnel 0, a foreign originator and a non-deal record type", async () => {
    await expect(prisma.$executeRaw`INSERT INTO crm_portal_state (environment, portal, category_id, originator_id) VALUES ('development', ${`x-${HOST}`}, 0, 'outlyy-development')`).rejects.toThrow();
    await expect(
      prisma.$executeRaw`INSERT INTO crm_links (id, environment, portal, entity_type, entity_id, originator_id, origin_id) VALUES (gen_random_uuid(), 'development', ${HOST}, 'inquiry', gen_random_uuid(), 'someone', 'inq:x')`,
    ).rejects.toThrow();
  });
});
