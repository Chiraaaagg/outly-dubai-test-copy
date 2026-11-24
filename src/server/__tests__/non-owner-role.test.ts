import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { dbEnabled, runId } from "./helpers/fixtures";
import { assertDisposableDb, assertDisposableDbLive } from "./helpers/target-guard";

/**
 * SEC-14 preparation (doc 22 §23 B1): a non-owner runtime role with explicit
 * `USING (true)` policies works through Prisma, and cannot switch off the
 * append-only triggers. Disposable database only; no production role exists
 * or changes. Creating `outly_app` in a migration that reaches production is
 * A13.
 *
 * The role `zz_app_<run>` is LOGIN, NOBYPASSRLS, not superuser, owns nothing,
 * and gets DML (no TRUNCATE) plus a policy on a sample of tables. `roles` is
 * granted SELECT without a policy, to show the trap SEC-14 describes: with RLS
 * on and no policy, a non-owner sees zero rows. The role, its grants and its
 * policies are removed in afterAll.
 */

const RUN = runId();
const ROLE = `zz_app_${RUN}`;
/** Tables the role gets DML and a policy on. */
const POLICY_TABLES = ["settings", "products", "audit_logs", "supplier_booking_events"];
/** Append-only tables: INSERT and SELECT only. */
const APPEND_ONLY = new Set(["audit_logs", "supplier_booking_events"]);

describe.skipIf(!dbEnabled)("SEC-14: non-owner runtime role with explicit policies (disposable database)", () => {
  let owner: typeof import("../lib/db").prisma;
  let app: PrismaClient;
  let instanceId: string;

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma: owner } = await import("../lib/db"));
    instanceId = (await assertDisposableDbLive(owner)).instanceId;

    const password = randomBytes(18).toString("hex");
    await owner.$executeRawUnsafe(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}'`);
    await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    for (const t of POLICY_TABLES) {
      await owner.$executeRawUnsafe(`GRANT ${APPEND_ONLY.has(t) ? "SELECT, INSERT" : "SELECT, INSERT, UPDATE, DELETE"} ON "${t}" TO ${ROLE}`);
      await owner.$executeRawUnsafe(`CREATE POLICY ${ROLE}_all ON "${t}" AS PERMISSIVE FOR ALL TO ${ROLE} USING (true) WITH CHECK (true)`);
    }
    await owner.$executeRawUnsafe(`GRANT USAGE ON SEQUENCE audit_logs_id_seq TO ${ROLE}`);
    await owner.$executeRawUnsafe(`GRANT SELECT ON "roles" TO ${ROLE}`);
    // So the test can prove it reached the same disposable instance.
    await owner.$executeRawUnsafe(`GRANT USAGE ON SCHEMA zz_disposable TO ${ROLE}`);
    await owner.$executeRawUnsafe(`GRANT SELECT ON zz_disposable.zz_disposable_instance TO ${ROLE}`);

    const url = new URL(process.env.DATABASE_URL!);
    url.username = ROLE;
    url.password = password;
    app = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  });

  afterAll(async () => {
    await app?.$disconnect();
    if (!owner) return;
    for (const t of POLICY_TABLES) await owner.$executeRawUnsafe(`DROP POLICY IF EXISTS ${ROLE}_all ON "${t}"`).catch(() => {});
    // Revoke explicitly: on a Supabase stack DROP OWNED is refused for grants on
    // objects the test role does not own, which then blocks DROP ROLE.
    await owner.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ROLE}`).catch(() => {});
    await owner.$executeRawUnsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${ROLE}`).catch(() => {});
    await owner.$executeRawUnsafe(`REVOKE ALL ON SCHEMA public FROM ${ROLE}`).catch(() => {});
    await owner.$executeRawUnsafe(`REVOKE ALL ON SCHEMA zz_disposable FROM ${ROLE}`).catch(() => {});
    await owner.$executeRawUnsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA zz_disposable FROM ${ROLE}`).catch(() => {});
    await owner.$executeRawUnsafe(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${ROLE}`);
    await owner.setting.deleteMany({ where: { key: { startsWith: `zz-sec14-${RUN}` } } });
  });

  it("connects as the non-owner role to the same disposable instance", async () => {
    const [who] = await app.$queryRaw<Array<{ user: string; bypass: boolean; superuser: boolean }>>`
      SELECT current_user::text AS user, r.rolbypassrls AS bypass, r.rolsuper AS superuser FROM pg_roles r WHERE r.rolname = current_user`;
    expect(who).toEqual({ user: ROLE, bypass: false, superuser: false });
    const [m] = await app.$queryRaw<Array<{ id: string }>>`SELECT instance_id::text AS id FROM zz_disposable.zz_disposable_instance`;
    expect(m.id).toBe(instanceId);
    const owned = await app.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`;
    expect(owned[0].n).toBe(0n);
  });

  it("Prisma reads see every row where a policy exists", async () => {
    expect(await app.product.count()).toBe(await owner.product.count());
    const one = await owner.product.findFirst({ select: { id: true, slug: true } });
    if (one) expect(await app.product.findUnique({ where: { id: one.id }, select: { slug: true } })).toEqual({ slug: one.slug });
  });

  it("without a policy the role sees nothing (the SEC-14 trap)", async () => {
    expect(await owner.role.count()).toBeGreaterThan(0);
    expect(await app.role.count()).toBe(0);
  });

  it("Prisma writes work: create, upsert, update, delete", async () => {
    const key = `zz-sec14-${RUN}`;
    await app.setting.create({ data: { key, value: { v: 1 } } });
    await app.setting.upsert({ where: { key }, create: { key, value: { v: 0 } }, update: { value: { v: 2 } } });
    expect((await app.setting.findUniqueOrThrow({ where: { key } })).value).toEqual({ v: 2 });
    await app.setting.delete({ where: { key } });
    expect(await owner.setting.findUnique({ where: { key } })).toBeNull();
    const row = await app.auditLog.create({ data: { actorType: "system", action: "zz.sec14", entityType: "test", entityId: RUN } });
    expect(row.id).toBeGreaterThan(0n);
  });

  it("cannot disable the append-only triggers, drop their function, truncate or rewrite history", async () => {
    await expect(app.$executeRawUnsafe(`ALTER TABLE "audit_logs" DISABLE TRIGGER audit_logs_immutable`)).rejects.toThrow(/must be owner|42501/);
    await expect(app.$executeRawUnsafe(`ALTER TABLE "supplier_booking_events" DISABLE TRIGGER ALL`)).rejects.toThrow(/must be owner|42501/);
    await expect(app.$executeRawUnsafe(`DROP FUNCTION outly_raise_immutable() CASCADE`)).rejects.toThrow(/must be owner|42501/);
    await expect(app.$executeRawUnsafe(`ALTER TABLE "audit_logs" DISABLE ROW LEVEL SECURITY`)).rejects.toThrow(/must be owner|42501/);
    await expect(app.$executeRawUnsafe(`TRUNCATE "settings"`)).rejects.toThrow(/permission denied|42501/);
    await expect(app.$executeRawUnsafe(`UPDATE "audit_logs" SET action = 'x' WHERE entity_id = '${RUN}'`)).rejects.toThrow(/permission denied|42501/);
    await expect(app.$executeRawUnsafe(`DELETE FROM "supplier_booking_events" WHERE false`)).rejects.toThrow(/permission denied|42501/);
  });
});
