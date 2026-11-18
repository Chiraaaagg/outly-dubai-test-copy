import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activities } from "@/lib/data/activities";
import type { Actor } from "../../lib/actor";
import { isAppError } from "../../lib/errors";
import { uuidv7 } from "../../lib/ids";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";

/**
 * Activity management against the disposable test database (target guard). Every row this suite
 * creates carries the `zz-test-` slug prefix and is removed in afterAll
 * (product_versions / import items cascade). Audit rows stay — they are
 * append-only by design and carry the test actor id.
 *
 * `server-only` is aliased to a no-op in vitest.config.mts so services can be
 * imported here.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const RUN = uuidv7().slice(-8);
const slug = (s: string) => `zz-test-${RUN}-${s}`;

const admin: Actor = { type: "admin", id: uuidv7(), roles: ["admin"], permissions: new Set(["*"]) };
const contentOnly: Actor = { type: "admin", id: uuidv7(), roles: ["content"], permissions: new Set(["products.edit", "categories.edit", "imports.run"]) };
const agent: Actor = { type: "agent", id: uuidv7(), roles: ["agent"], permissions: new Set(["inquiries.view_all"]) };

function fixtureInput(i = 0) {
  const { id: _id, rating: _r, reviewCount: _rc, bookedThisMonth: _b, ...rest } = activities[i];
  return rest;
}

describe.skipIf(!enabled)("activityService", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let activityService: typeof import("../activity.service").activityService;

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    ({ activityService } = await import("../activity.service"));
  });

  async function purge(prefix: string) {
    await prisma.productSupplierMapping.deleteMany({ where: { product: { slug: { startsWith: prefix } } } });
    await prisma.product.deleteMany({ where: { slug: { startsWith: prefix } } });
  }

  afterAll(async () => {
    await purge(`zz-test-${RUN}`);
    await prisma.category.deleteMany({ where: { slug: { startsWith: `zz-test-${RUN}` } } });
    await prisma.$disconnect();
  });

  it("creates a draft with version 1, a history row and a supplier mapping", async () => {
    const row = await activityService.create(admin, { ...fixtureInput(0), slug: slug("create") }, { reason: "test" });
    expect(row.status).toBe("draft");
    expect(row.version).toBe(1);
    const versions = await activityService.listVersions(admin, row.id);
    expect(versions).toHaveLength(1);
    const mapping = await prisma.productSupplierMapping.count({ where: { productId: row.id } });
    expect(mapping).toBe(1);
    const detail = await activityService.get(admin, row.id);
    expect(detail.content.title).toBe(activities[0].title);
    expect(detail.content.fulfilmentMode).toBe("inquiry");
  });

  it("refuses a duplicate slug and an unknown category", async () => {
    await activityService.create(admin, { ...fixtureInput(1), slug: slug("dup") });
    await expect(activityService.create(admin, { ...fixtureInput(1), slug: slug("dup") })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(activityService.create(admin, { ...fixtureInput(1), slug: slug("nocat"), categorySlug: "no-such-category" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("enforces permissions: agents cannot edit, content cannot publish or delete", async () => {
    const row = await activityService.create(contentOnly, { ...fixtureInput(2), slug: slug("perm") });
    await expect(activityService.create(agent, { ...fixtureInput(2), slug: slug("perm-2") })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(activityService.create(contentOnly, { ...fixtureInput(2), slug: slug("perm-3") }, { status: "published" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(activityService.setStatus(contentOnly, row.id, "published")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(activityService.remove(contentOnly, row.id, "because")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(activityService.list(agent)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("updates with optimistic concurrency and keeps the hinge column authoritative", async () => {
    const row = await activityService.create(admin, { ...fixtureInput(3), slug: slug("upd") });
    const v2 = await activityService.update(admin, row.id, { ...fixtureInput(3), slug: slug("upd"), title: "Renamed", fulfilmentMode: "instant", confirmation: "instant" }, { expectedVersion: 1 });
    expect(v2.version).toBe(2);
    expect(v2.title).toBe("Renamed");
    expect(v2.fulfilmentMode).toBe("inquiry"); // form cannot flip the hinge
    await expect(activityService.update(admin, row.id, { ...fixtureInput(3), slug: slug("upd") }, { expectedVersion: 1 })).rejects.toMatchObject({ code: "CONFLICT" });
    const versions = await activityService.listVersions(admin, row.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it("publishes, unpublishes, archives — each a new version and audit row", async () => {
    const row = await activityService.create(admin, { ...fixtureInput(4), slug: slug("status") });
    const pub = await activityService.setStatus(admin, row.id, "published", "go live");
    expect(pub.status).toBe("published");
    expect(pub.publishedAt).not.toBeNull();
    const unpub = await activityService.setStatus(admin, row.id, "draft");
    expect(unpub.status).toBe("draft");
    const arch = await activityService.setStatus(admin, row.id, "archived");
    expect(arch.status).toBe("archived");
    expect(arch.version).toBe(4);
    const audits = await prisma.auditLog.findMany({ where: { entityId: row.id }, select: { action: true } });
    expect(audits.map((a) => a.action).sort()).toEqual(["activity.archive", "activity.create", "activity.publish", "activity.unpublish"]);
  });

  it("duplicates into a draft copy with a fresh slug", async () => {
    const row = await activityService.create(admin, { ...fixtureInput(5), slug: slug("orig") }, { status: "published" });
    const copy = await activityService.duplicate(admin, row.id);
    expect(copy.slug).toBe(slug("orig-copy"));
    expect(copy.status).toBe("draft");
    const copy2 = await activityService.duplicate(admin, row.id);
    expect(copy2.slug).toBe(slug("orig-copy-2"));
  });

  it("soft-deletes (slug stays reserved), restores, and blocks re-use of the slug", async () => {
    const row = await activityService.create(admin, { ...fixtureInput(6), slug: slug("del") });
    await expect(activityService.remove(admin, row.id, "")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const gone = await activityService.remove(admin, row.id, "duplicate listing");
    expect(gone.deletedAt).not.toBeNull();
    expect(gone.status).toBe("archived");
    await expect(activityService.get(admin, row.id)).resolves.toMatchObject({ deletedAt: expect.any(Date) });
    await expect(activityService.create(admin, { ...fixtureInput(6), slug: slug("del") })).rejects.toMatchObject({ code: "CONFLICT" });
    const listed = await activityService.list(admin, { q: slug("del"), status: "deleted" });
    expect(listed.rows.some((r) => r.id === row.id)).toBe(true);
    const back = await activityService.restore(admin, row.id);
    expect(back.deletedAt).toBeNull();
    expect(back.status).toBe("draft");
  });

  it("restores an older version as a new version", async () => {
    const row = await activityService.create(admin, { ...fixtureInput(7), slug: slug("ver"), title: "First" });
    await activityService.update(admin, row.id, { ...fixtureInput(7), slug: slug("ver"), title: "Second" });
    const restored = await activityService.restoreVersion(admin, row.id, 1, "undo");
    expect(restored.version).toBe(3);
    expect(restored.title).toBe("First");
    const detail = await activityService.get(admin, row.id);
    expect(detail.content.title).toBe("First");
    expect(detail.versions).toHaveLength(3);
  });

  it("stores the content document strictly — extra keys are rejected at the service boundary", async () => {
    const bad = { ...fixtureInput(8), slug: slug("strict"), isAdmin: true } as unknown as Parameters<typeof activityService.create>[1];
    let err: unknown;
    try {
      await activityService.create(admin, bad);
    } catch (e) {
      err = e;
    }
    // zod throws a ZodError here (route layer maps it via parseJson); the service never persists it.
    expect(err).toBeTruthy();
    expect(isAppError(err) ? err.code : "zod").toMatch(/VALIDATION_FAILED|zod/);
    expect(await prisma.product.count({ where: { slug: slug("strict") } })).toBe(0);
  });

  it("bulk publishes by id and by filter, and reports what it skipped", async () => {
    const base = slug("bulk");
    const made = [];
    for (let i = 0; i < 3; i++) {
      made.push(await activityService.create(admin, { ...fixtureInput(i), slug: `${base}-${i}`, title: `Bulk ${RUN} ${i}` }));
    }
    expect(made.every((r) => r.status === "draft")).toBe(true);

    // By id: two of the three, with the third left alone.
    const byId = await activityService.bulkSetStatus(admin, { ids: [made[0].id, made[1].id] }, "published", "go live");
    expect(byId.changed).toBe(2);
    const after = await prisma.product.findMany({ where: { slug: { startsWith: base } }, select: { slug: true, status: true, version: true, publishedAt: true }, orderBy: { slug: "asc" } });
    expect(after.map((r) => r.status)).toEqual(["published", "published", "draft"]);
    expect(after[0].version).toBe(2);
    expect(after[0].publishedAt).not.toBeNull();
    expect(await prisma.productVersion.count({ where: { productId: made[0].id, version: 2, status: "published" } })).toBe(1);

    // Running it again changes nothing but is not an error.
    const again = await activityService.bulkSetStatus(admin, { ids: [made[0].id, made[1].id] }, "published");
    expect(again).toMatchObject({ changed: 0, skipped: 2 });

    // By filter: the console's own filters, re-run server-side.
    const byFilter = await activityService.bulkSetStatus(admin, { filters: { q: `Bulk ${RUN}`, status: "draft" } }, "published", "rest of the batch");
    expect(byFilter.changed).toBe(1);
    expect(await prisma.product.count({ where: { slug: { startsWith: base }, status: "published" } })).toBe(3);

    // Publishing is a privilege, not an edit right.
    await expect(activityService.bulkSetStatus(contentOnly, { ids: [made[0].id] }, "draft")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(activityService.bulkSetStatus(admin, { ids: [] }, "draft")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    await purge(base);
  });

  it("manages categories: upsert, refuse delete while in use, delete when empty", async () => {
    const cat = await activityService.upsertCategory(admin, { slug: slug("cat"), name: "Test Cat", shortName: "Test" });
    expect(cat.status).toBe("published");
    await activityService.create(admin, { ...fixtureInput(9), slug: slug("incat"), categorySlug: slug("cat") });
    await expect(activityService.removeCategory(admin, cat.id, "cleanup")).rejects.toMatchObject({ code: "CONFLICT" });
    const updated = await activityService.upsertCategory(admin, { slug: slug("cat"), name: "Test Cat 2", shortName: "Test" });
    expect(updated.id).toBe(cat.id);
    expect(updated.name).toBe("Test Cat 2");
    await purge(slug("incat"));
    const removed = await activityService.removeCategory(admin, cat.id, "cleanup");
    expect(removed.deletedAt).not.toBeNull();
    await expect(activityService.upsertCategory(agent, { slug: slug("cat2"), name: "x", shortName: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

/**
 * B2 readiness triggers (PRD-4, PRD-11). The disposable environment has the
 * instant release switch off and no supplier seam, so a requested-instant
 * product with an instant verdict on record must be demoted to inquiry by
 * every product version write, with a system audit row.
 */
describe.skipIf(!enabled)("activityService: readiness on every product version write", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let activityService: typeof import("../activity.service").activityService;
  const PREFIX = `zz-test-${RUN}-rd`;

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    ({ activityService } = await import("../activity.service"));
  });

  afterAll(async () => {
    await prisma.productSupplierMapping.deleteMany({ where: { product: { slug: { startsWith: PREFIX } } } });
    await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
    await prisma.$disconnect();
  });

  /** A published product that asks for instant and holds an instant verdict (as if it had passed before). */
  async function instantOnRecord(name: string, i = 3) {
    const row = await activityService.create(admin, { ...fixtureInput(i), slug: `${PREFIX}-${name}` }, { status: "published" });
    await prisma.product.update({ where: { id: row.id }, data: { fulfilmentMode: "instant" } });
    await prisma.productEligibility.upsert({
      where: { productId: row.id },
      create: { productId: row.id, effectiveMode: "instant", reasons: [], readinessVersion: 1 },
      update: { effectiveMode: "instant", reasons: [] },
    });
    return row;
  }

  async function expectDemoted(id: string, trigger: string) {
    const v = await prisma.productEligibility.findUnique({ where: { productId: id } });
    expect(v?.effectiveMode).toBe("inquiry");
    expect(v?.reasons).toContain("release_switch_off");
    const a = await prisma.auditLog.findFirst({ where: { entityId: id, action: "product.eligibility" }, orderBy: { createdAt: "desc" } });
    expect(a?.reason).toBe(`readiness: ${trigger}`);
    expect(a?.actorType).toBe("system");
    // The requested mode is the operator's and is kept (PRD-11).
    expect((await prisma.product.findUniqueOrThrow({ where: { id } })).fulfilmentMode).toBe("instant");
  }

  it("editor save", async () => {
    const row = await instantOnRecord("save");
    await activityService.update(admin, row.id, { ...fixtureInput(3), slug: row.slug, title: "Edited title" });
    await expectDemoted(row.id, "editor_save");
  });

  it("restore-version", async () => {
    const row = await instantOnRecord("restore");
    await activityService.update(admin, row.id, { ...fixtureInput(3), slug: row.slug, title: "Second" });
    await prisma.productEligibility.update({ where: { productId: row.id }, data: { effectiveMode: "instant", reasons: [] } });
    await activityService.restoreVersion(admin, row.id, 1, "undo");
    await expectDemoted(row.id, "restore_version");
  });

  it("status change and delete", async () => {
    const a = await instantOnRecord("unpublish");
    await activityService.setStatus(admin, a.id, "draft");
    await expectDemoted(a.id, "status_change");
    const b = await instantOnRecord("delete");
    await activityService.remove(admin, b.id, "retired");
    await expectDemoted(b.id, "delete");
  });

  it("a requested-inquiry product records an inquiry verdict and no eligibility audit", async () => {
    const row = await activityService.create(admin, { ...fixtureInput(4), slug: `${PREFIX}-plain` }, { status: "published" });
    const v = await prisma.productEligibility.findUnique({ where: { productId: row.id } });
    expect(v?.effectiveMode).toBe("inquiry");
    expect(await prisma.auditLog.count({ where: { entityId: row.id, action: "product.eligibility" } })).toBe(0);
  });

  it("typed units round-trip through editor save and restore-version unchanged (PRD-7)", async () => {
    const units = [
      { unitId: "adult", label: "Adult", per: "person" as const, ageMin: 12, ageMax: null, residency: "any" as const, heightMinCm: null, heightMaxCm: null, seatConsuming: true, minQty: 0, maxQty: 9, price: { inr: 5000, aed: 200 }, supplierUnit: "adult" },
      { unitId: "car", label: "Private car", per: "booking" as const, ageMin: null, ageMax: null, residency: "uae_resident" as const, heightMinCm: null, heightMaxCm: 200, seatConsuming: false, minQty: 1, maxQty: 1, price: { inr: 9000, aed: 360 }, supplierUnit: "trip" },
    ];
    const base = fixtureInput(5);
    const variants = [{ id: "shared", name: "Shared", blurb: "", delta: { inr: 0, aed: 0 }, highlights: [], isPrivate: false, units }];
    const row = await activityService.create(admin, { ...base, slug: `${PREFIX}-units`, variants });
    await activityService.update(admin, row.id, { ...base, slug: row.slug, variants, title: "Units v2" });
    await activityService.restoreVersion(admin, row.id, 1);
    const detail = await activityService.get(admin, row.id);
    expect(detail.content.variants[0].units).toEqual(units);
    expect(detail.content.title).toBe(base.title);
  });
});
