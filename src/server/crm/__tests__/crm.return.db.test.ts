import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { assertDisposableDb, dbEnabled, runId } from "@/server/__tests__/helpers/fixtures";
import { db, forbidNetwork } from "@/server/__tests__/security/_mercury-fixtures";
import type { CrmScope } from "@/server/crm/crm.config";

/**
 * The Postgres return path store (CRM batch C3ab; migration 20261126120000)
 * on the disposable database: the new columns and checks, `queuePush`
 * fenced by the link lock and writing the same outbox row as an enqueue,
 * the finding raise rules, twin comments claimed at most once, the sweep's
 * "not visible" and drift reads, the widened timeline checks and the ops
 * alert read. Its own portal host per run; synthetic data only.
 */

type Prisma = Awaited<ReturnType<typeof db>>;
const run = runId();
const HOST = `ret-${run}.bitrix24.test`;
const scope: CrmScope = { environment: "development", portal: HOST };
let prisma: Prisma;

async function link(over: { crmId?: bigint | null; state?: string; lockedBy?: string | null } = {}) {
  const entityId = randomUUID();
  const state = over.state ?? "active";
  return prisma.crmLink.create({
    data: {
      id: randomUUID(),
      environment: "development",
      portal: HOST,
      entityType: "inquiry",
      entityId,
      crmId: over.crmId === undefined ? BigInt(Math.floor(Math.random() * 1e9) + 1) : over.crmId,
      originatorId: "outlyy-development",
      originId: `inq:${entityId}`,
      state,
      localVersion: 1n,
      pushedVersion: 1n,
      pushedHash: "a".repeat(64),
      lockedBy: over.lockedBy ?? null,
      lockedUntil: over.lockedBy ? new Date(Date.now() + 60_000) : null,
      ...(state === "deleted" ? { deletedAt: new Date(), deleteReason: "erasure" } : {}),
    },
  });
}

describe.skipIf(!dbEnabled)("CRM return path store (C3ab)", () => {
  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    prisma = await db();
    const { prismaCrmStore } = await import("@/server/crm/crm.store");
    await prismaCrmStore.ensurePortal(scope, { categoryId: 7, originatorId: "outlyy-development" });
  });

  afterAll(async () => {
    if (!dbEnabled) return;
    await prisma.crmReturnFinding.deleteMany({ where: { portal: HOST } });
    await prisma.crmOutbox.deleteMany({ where: { portal: HOST } });
    const ids = (await prisma.crmLink.findMany({ where: { portal: HOST }, select: { id: true } })).map((l) => l.id);
    await prisma.crmTimelineComment.deleteMany({ where: { linkId: { in: ids } } });
    await prisma.crmLink.deleteMany({ where: { portal: HOST } });
    await prisma.crmPortalState.deleteMany({ where: { portal: HOST } });
  });

  it("portal return columns round-trip; a bad fingerprint state or hash is refused by the schema", async () => {
    const { prismaCrmReturnStore: s } = await import("@/server/crm/crm.return.store");
    const at = new Date();
    await s.setReturnPortal(scope, { reconcileCursor: at, fingerprintHash: "b".repeat(64), fingerprintState: "ok", sweepCursorId: 42 });
    expect(await s.returnPortal(scope)).toMatchObject({ reconcileCursor: at, fingerprintHash: "b".repeat(64), fingerprintState: "ok", sweepCursorId: 42 });
    await expect(prisma.$executeRaw`UPDATE crm_portal_state SET fingerprint_state = 'maybe' WHERE portal = ${HOST}`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE crm_portal_state SET fingerprint_hash = 'not-a-hash' WHERE portal = ${HOST}`).rejects.toThrow();
  });

  it("queuePush is fenced by the link lock, clears the hash on request and writes the enqueue's own row", async () => {
    const { prismaCrmReturnStore: s } = await import("@/server/crm/crm.return.store");
    const l = await link({ lockedBy: "holder-1" });
    expect(await s.queuePush(scope, l.id, "holder-2", { clearHash: true })).toBe(false);
    expect(await s.queuePush(scope, l.id, "holder-1", { clearHash: true })).toBe(true);
    const after = await prisma.crmLink.findUniqueOrThrow({ where: { id: l.id } });
    expect(after).toMatchObject({ localVersion: 2n, pushedHash: null });
    const rows = await prisma.crmOutbox.findMany({ where: { portal: HOST, entityId: l.entityId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "sync", version: 2n, reason: null, status: "queued", dedupeKey: `sync:inquiry:${l.entityId}:2@development/${HOST}` });
    await prisma.crmOutbox.updateMany({ where: { portal: HOST }, data: { nextAttemptAt: new Date(Date.now() + 3_600_000) } });
  });

  it("link return columns round-trip through the lock fence, with their checks", async () => {
    const { prismaCrmReturnStore: s } = await import("@/server/crm/crm.return.store");
    const l = await link({ lockedBy: "holder-3" });
    const now = new Date();
    await s.updateReturnLink(l.id, "holder-3", { crmSeenUpdatedAt: now, crmSeenStageId: "C7:QUOTED", crmSeenOwnerId: 23, revertCount: 2, holdUntil: now });
    await s.updateReturnLink(l.id, "someone-else", { revertCount: 9 });
    const r = await s.returnLinkByCrmId(scope, Number(l.crmId));
    expect(r).toMatchObject({ crmSeenStageId: "C7:QUOTED", crmSeenOwnerId: 23, revertCount: 2 });
    await expect(prisma.$executeRaw`UPDATE crm_links SET crm_seen_stage_id = 'a b' WHERE id = ${l.id}::uuid`).rejects.toThrow();
    await expect(prisma.$executeRaw`UPDATE crm_links SET revert_count = -1 WHERE id = ${l.id}::uuid`).rejects.toThrow();
  });

  it("findings: one row per subject, raised once, re-raised only after 24 hours; alert-on-repeat raises at the second; ids only", async () => {
    const { prismaCrmReturnStore: s } = await import("@/server/crm/crm.return.store");
    const t0 = new Date();
    await s.raiseFinding(scope, { kind: "crm_twin", subjectKey: "deal:901", crmId: 901, detail: "keep=900" }, t0);
    await s.raiseFinding(scope, { kind: "crm_twin", subjectKey: "deal:901", crmId: 901 }, new Date(t0.getTime() + 60_000));
    let f = await prisma.crmReturnFinding.findFirstOrThrow({ where: { portal: HOST, subjectKey: "deal:901" } });
    expect(f).toMatchObject({ occurrences: 2, raisedAt: t0, detail: "keep=900" });
    const later = new Date(t0.getTime() + 25 * 3_600_000 + 60_000);
    await s.raiseFinding(scope, { kind: "crm_twin", subjectKey: "deal:901", crmId: 901 }, later);
    f = await prisma.crmReturnFinding.findFirstOrThrow({ where: { portal: HOST, subjectKey: "deal:901" } });
    expect(f.raisedAt).toEqual(later);

    await s.raiseFinding(scope, { kind: "crm_owner_unmapped", subjectKey: "deal:902", alertOnRepeat: true }, t0);
    expect((await prisma.crmReturnFinding.findFirstOrThrow({ where: { portal: HOST, subjectKey: "deal:902" } })).raisedAt.getTime()).toBe(0);
    const t1 = new Date(t0.getTime() + 60_000);
    await s.raiseFinding(scope, { kind: "crm_owner_unmapped", subjectKey: "deal:902", alertOnRepeat: true }, t1);
    expect((await prisma.crmReturnFinding.findFirstOrThrow({ where: { portal: HOST, subjectKey: "deal:902" } })).raisedAt).toEqual(t1);

    // The schema refuses anything but codes in a finding.
    await expect(s.raiseFinding(scope, { kind: "crm_twin", subjectKey: "deal:903", detail: ["name", "example.invalid"].join("@") }, t0)).rejects.toThrow();
    await expect(s.raiseFinding(scope, { kind: "crm_twin", subjectKey: "Customer Name" }, t0)).rejects.toThrow();
    await expect(s.raiseFinding(scope, { kind: "not_a_kind" as never, subjectKey: "portal" }, t0)).rejects.toThrow();

    const { crmReturnIncidents } = await import("@/server/crm/crm.return.alerts");
    const incidents = (await crmReturnIncidents(new Date(t0.getTime() - 1_000), new Date(later.getTime() + 1_000))).filter((i) => i.entityId === "deal:901" || i.entityId === "deal:902");
    expect([...new Set(incidents.map((i) => `${i.entityId}|${i.reason}`))].sort()).toEqual(["deal:901|crm_twin", "deal:902|crm_owner_unmapped"]);
  });

  it("twin comments: queued once, claimed by one holder, settled by that holder only; a lapsed claim becomes unknown", async () => {
    const { prismaCrmReturnStore: s } = await import("@/server/crm/crm.return.store");
    const now = new Date();
    await s.raiseFinding(scope, { kind: "crm_twin", subjectKey: "deal:911", crmId: 911 }, now);
    const [t] = (await s.twinFindingsSince(scope, new Date(now.getTime() - 1_000))).filter((x) => x.crmId === 911);
    await s.setTwinComment(t.id, 910);
    await s.setTwinComment(t.id, 999); // only when it has none yet
    const claimed = await s.claimTwinComments(scope, "h1", now, { limit: 5, staleBefore: new Date(now.getTime() - 120_000) });
    expect(claimed.filter((c) => c.id === t.id)).toEqual([{ id: t.id, crmId: 911, refCrmId: 910 }]);
    expect((await s.claimTwinComments(scope, "h2", now, { limit: 5, staleBefore: new Date(now.getTime() - 120_000) })).filter((c) => c.id === t.id)).toEqual([]);
    await s.finishTwinComment(t.id, "h2", { status: "posted", crmCommentId: 5, at: now });
    expect((await prisma.crmReturnFinding.findUniqueOrThrow({ where: { id: t.id } })).commentState).toBe("posting");
    await s.claimTwinComments(scope, "h3", new Date(now.getTime() + 300_000), { limit: 5, staleBefore: new Date(now.getTime() + 180_000) });
    expect((await prisma.crmReturnFinding.findUniqueOrThrow({ where: { id: t.id } })).commentState).toBe("unknown");
  });

  it("the sweep: links not seen since the start are missing; seen ones are cleared; drift candidates have no push pending", async () => {
    const { prismaCrmReturnStore: s } = await import("@/server/crm/crm.return.store");
    const seen = await link();
    const missing = await link();
    const tomb = await link({ state: "deleted" });
    const started = new Date(Date.now() + 1_000);
    await new Promise((r) => setTimeout(r, 1_100));
    await s.markSweepSeen([seen.id], new Date());
    // Links created before the sweep only (crm_links.created_at is the database's clock).
    const out = (await s.finishSweep(scope, started, new Date())).map((l) => l.id);
    expect(out).toContain(missing.id);
    expect(out).not.toContain(seen.id);
    expect(out).not.toContain(tomb.id);
    expect((await prisma.crmLink.findUniqueOrThrow({ where: { id: missing.id } })).missingSince).not.toBeNull();
    const drift = (await s.driftCandidates(scope, null, 500)).map((l) => l.id);
    expect(drift).toContain(seen.id);
    expect(drift).not.toContain(tomb.id);
  });

  it("the timeline queue takes the three return path notes, keyed by day, and refuses another key", async () => {
    const { prismaCrmStore } = await import("@/server/crm/crm.store");
    const l = await link();
    const n = await prismaCrmStore.recordTimelineMoments(
      l.id,
      [
        { key: "stage_reverted:20414", kind: "stage_reverted", amountAedMinor: null },
        { key: "move_refused:20414", kind: "move_refused", amountAedMinor: null },
        { key: "owner_unmapped:20414", kind: "owner_unmapped", amountAedMinor: null },
      ],
      new Date(),
    );
    expect(n).toBe(3);
    await expect(prismaCrmStore.recordTimelineMoments(l.id, [{ key: "stage_reverted:x", kind: "stage_reverted", amountAedMinor: null }], new Date())).rejects.toThrow();
  });

  it("crm_return_findings has RLS on", async () => {
    const [r] = await prisma.$queryRaw<{ relrowsecurity: boolean }[]>`SELECT relrowsecurity FROM pg_class WHERE relname = 'crm_return_findings'`;
    expect(r.relrowsecurity).toBe(true);
  });
});
