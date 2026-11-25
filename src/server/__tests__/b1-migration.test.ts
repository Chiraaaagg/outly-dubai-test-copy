import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { uuidv7 } from "../lib/ids";
import { ROLE_PERMISSIONS } from "../lib/permissions";
import { B1_PERMISSIONS } from "../suppliers/booking-port";
import { dbEnabled, ensureRoles, runId } from "./helpers/fixtures";
import { assertDisposableDb, assertDisposableDbLive } from "./helpers/target-guard";

/**
 * Migration 20261101110000_b1_engine_and_provenance on the disposable
 * database: defaults for existing rows, checks, the account-keyed lease and
 * pre-B1 writes against it, the job claim order, and the additive grants.
 *
 * Every row is synthetic and written inside a transaction that is always
 * rolled back, so nothing persists. Amounts are synthetic.
 */

type Prisma = typeof import("../lib/db").prisma;
type Tx = Parameters<Parameters<Prisma["$transaction"]>[0]>[0];

const ROLLBACK = new Error("ROLLBACK");
const CHECK_VIOLATION = /23514|violates check constraint/;

async function rolledBack(prisma: Prisma, fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

/** A savepoint, so an expected constraint error does not abort the outer transaction. */
async function refused(tx: Tx, sql: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await tx.$executeRawUnsafe("SAVEPOINT b1_probe");
  let error: unknown = null;
  try {
    await sql();
  } catch (e) {
    error = e;
  }
  await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT b1_probe");
  expect(String(error)).toMatch(pattern);
}

async function orderFixture(tx: Tx, run: string) {
  const supplierId = uuidv7();
  await tx.supplier.create({ data: { id: supplierId, code: `zz-b1-${run}`, name: "B1 test supplier", source: "api", adapter: "traveldesk" } });
  const guest = await tx.guest.create({ data: { id: uuidv7(), phoneE164: "+910000000000", fullName: "test-b1" } });
  const combo = await tx.combo.create({ data: { id: uuidv7(), slug: `zz-b1-${run}`, name: "test-b1", confirmation: "manual" } });
  const order = await tx.order.create({
    data: {
      id: uuidv7(),
      reference: `OUT-TEST${Math.floor(Math.random() * 1e9)}`,
      rail: "assisted",
      guestId: guest.id,
      currency: "INR",
      subtotalInr: 1000n,
      subtotalAed: 45n,
      totalInr: 1000n,
      totalAed: 45n,
      leadName: "test-b1",
      leadPhone: "+910000000000",
    },
  });
  // Written the pre-B1 way: no fulfilment_origin.
  const itemId = uuidv7();
  await tx.$executeRaw`
    INSERT INTO order_items
      (id, order_id, combo_id, title_snapshot, tier_snapshot, slug_snapshot, kind_snapshot, confirmation_snapshot,
       fulfilment_mode_snapshot, free_cancellation_hours_snapshot, duration_minutes_snapshot, service_date, pax,
       unit_inr, unit_aed, total_inr, total_aed)
    VALUES
      (${itemId}::uuid, ${order.id}::uuid, ${combo.id}::uuid, 'test-b1', 'C', ${`zz-b1-${run}`}, 'combo', 'manual',
       'inquiry', 24, 60, DATE '2030-01-15', '{"adult":1}'::jsonb, 1000, 45, 1000, 45)`;
  return { supplierId, orderId: order.id, itemId };
}

function insertBooking(tx: Tx, supplierId: string, afterReserve: string) {
  const id = uuidv7();
  return tx.$executeRaw`
    INSERT INTO supplier_bookings
      (id, supplier_id, environment, idempotency_key, client_ref, booking_kind, after_reserve,
       tour_external_id, offer_external_id, service_date, adults, guest_name, expected_net_minor, expected_net_usd_minor)
    VALUES
      (${id}::uuid, ${supplierId}::uuid, 'test', ${`drill:${id}`}, ${`ZZB${id.slice(-12)}`}, 'live_book', ${afterReserve},
       'tour-test', 'offer-test', DATE '2030-01-15', 1, 'test-b1', 100, 1)`;
}

describe.skipIf(!dbEnabled)("migration 20261101110000: B1 engine and provenance", () => {
  let prisma: Prisma;

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../lib/db"));
    await assertDisposableDbLive(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("after_reserve accepts await_payment and still refuses unknown values", async () => {
    await rolledBack(prisma, async (tx) => {
      const { supplierId } = await orderFixture(tx, runId());
      expect(await insertBooking(tx, supplierId, "await_payment")).toBe(1);
      await refused(tx, () => insertBooking(tx, supplierId, "auto"), CHECK_VIOLATION);
    });
  });

  it("a pre-B1 booking insert gets account_id 'default' and no request_hash", async () => {
    await rolledBack(prisma, async (tx) => {
      const { supplierId } = await orderFixture(tx, runId());
      await insertBooking(tx, supplierId, "confirm");
      const [row] = await tx.$queryRaw<Array<{ account_id: string; request_hash: string | null }>>`
        SELECT account_id, request_hash FROM supplier_bookings WHERE supplier_id = ${supplierId}::uuid`;
      expect(row).toEqual({ account_id: "default", request_hash: null });
    });
  });

  it("order items default to assisted_conversion; payments to manual; both checks refuse other values", async () => {
    await rolledBack(prisma, async (tx) => {
      const { orderId, itemId } = await orderFixture(tx, runId());
      expect((await tx.orderItem.findUniqueOrThrow({ where: { id: itemId } })).fulfilmentOrigin).toBe("assisted_conversion");
      await refused(tx, () => tx.$executeRaw`UPDATE order_items SET fulfilment_origin = 'drill' WHERE id = ${itemId}::uuid`, CHECK_VIOLATION);
      expect(await tx.$executeRaw`UPDATE order_items SET fulfilment_origin = 'instant_checkout' WHERE id = ${itemId}::uuid`).toBe(1);

      const paymentId = uuidv7();
      await tx.$executeRaw`
        INSERT INTO payments (id, order_id, gateway, amount_minor, currency, status)
        VALUES (${paymentId}::uuid, ${orderId}::uuid, 'manual', 100, 'INR', 'captured')`;
      expect((await tx.payment.findUniqueOrThrow({ where: { id: paymentId } })).source).toBe("manual");
      await refused(tx, () => tx.$executeRaw`UPDATE payments SET source = 'webhook' WHERE id = ${paymentId}::uuid`, CHECK_VIOLATION);
    });
  });

  it("no order item or payment that existed before the B1 migration is anything but the safe default", async () => {
    const [row] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM _prisma_migrations WHERE migration_name = '20261101110000_b1_engine_and_provenance' AND finished_at IS NOT NULL`;
    expect(row.n).toBe(1n);
    // Rows written after B1 may legitimately be instant_checkout / gateway_verified (B3); the backfill
    // guarantee is about the rows that were already there when the migration ran.
    const [r] = await prisma.$queryRaw<Array<{ items: bigint; payments: bigint }>>`
      WITH b1 AS (SELECT finished_at FROM _prisma_migrations WHERE migration_name = '20261101110000_b1_engine_and_provenance')
      SELECT (SELECT count(*) FROM order_items i JOIN orders o ON o.id = i.order_id, b1 WHERE o.placed_at < b1.finished_at AND i.fulfilment_origin <> 'assisted_conversion') AS items,
             (SELECT count(*) FROM payments p, b1 WHERE p.created_at < b1.finished_at AND p.source <> 'manual') AS payments`;
    expect(r).toEqual({ items: 0n, payments: 0n });
  });

  it("the lease key includes the account; pre-B1 lease writes still address one row", async () => {
    const cols = await prisma.$queryRaw<Array<{ col: string }>>`
      SELECT a.attname::text AS col
      FROM pg_index x JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (x.indkey)
      WHERE t.relname = 'supplier_account_leases' AND x.indisprimary ORDER BY a.attname`;
    expect(cols.map((c) => c.col)).toEqual(["account_id", "environment", "supplier_id"]);

    await rolledBack(prisma, async (tx) => {
      const { supplierId } = await orderFixture(tx, runId());
      // The pre-B1 acquire: insert without account, then a conditional update by (supplier, environment).
      await tx.$executeRaw`INSERT INTO supplier_account_leases (supplier_id, environment, lease_until) VALUES (${supplierId}::uuid, 'test', to_timestamp(0)) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO supplier_account_leases (supplier_id, environment, lease_until) VALUES (${supplierId}::uuid, 'test', to_timestamp(0)) ON CONFLICT DO NOTHING`;
      const taken = await tx.$executeRaw`
        UPDATE supplier_account_leases SET holder = 'w1', lease_until = now() + interval '1 minute'
        WHERE supplier_id = ${supplierId}::uuid AND environment = 'test' AND lease_until < now()`;
      expect(taken).toBe(1);
      // A second account is a separate lease.
      await tx.$executeRaw`INSERT INTO supplier_account_leases (supplier_id, environment, account_id, holder, lease_until) VALUES (${supplierId}::uuid, 'test', 'agency-2', 'w2', now() + interval '1 minute')`;
      const rows = await tx.supplierAccountLease.findMany({ where: { supplierId }, orderBy: { accountId: "asc" } });
      expect(rows.map((r) => [r.accountId, r.holder, r.generation])).toEqual([
        ["agency-2", "w2", 0n],
        ["default", "w1", 0n],
      ]);
    });
  });

  it("claim order: release and confirm before reserve; nearest deadline first within a priority", async () => {
    const idx = await prisma.$queryRaw<Array<{ def: string }>>`SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'sj_claim_idx'`;
    expect(idx[0]?.def).toMatch(/\(status, priority DESC, deadline_at, run_after\)/);

    await rolledBack(prisma, async (tx) => {
      const { supplierId } = await orderFixture(tx, runId());
      await insertBooking(tx, supplierId, "confirm");
      const [{ id: bookingId }] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text FROM supplier_bookings WHERE supplier_id = ${supplierId}::uuid`;
      const due = new Date(Date.now() - 60_000);
      const soon = new Date(Date.now() + 5 * 60_000);
      const later = new Date(Date.now() + 60 * 60_000);
      // Inserted worst-first, with the reserve due earliest, so ordering by run_after alone would pick it.
      const jobs: Array<[string, number, Date | null, Date]> = [
        ["reserve-a", 0, null, new Date(due.getTime() - 60_000)],
        ["reserve-b", 0, soon, due],
        ["poll", 10, null, due],
        ["confirm-late", 20, later, due],
        ["confirm-soon", 20, soon, due],
        ["cancel", 30, null, due],
      ];
      for (const [kind, priority, deadline, runAfter] of jobs) {
        await tx.$executeRaw`
          INSERT INTO supplier_jobs (id, kind, supplier_booking_id, dedupe_key, status, priority, deadline_at, run_after)
          VALUES (${uuidv7()}::uuid, ${kind}, ${bookingId}::uuid, ${`${kind}:${bookingId}`}, 'queued', ${priority}, ${deadline}::timestamptz, ${runAfter})`;
      }
      const order = await tx.$queryRaw<Array<{ kind: string }>>`
        SELECT kind FROM supplier_jobs
        WHERE status = 'queued' AND run_after <= now() AND supplier_booking_id = ${bookingId}::uuid
        ORDER BY priority DESC, deadline_at ASC NULLS LAST, run_after ASC, created_at`;
      expect(order.map((o) => o.kind)).toEqual(["cancel", "confirm-soon", "confirm-late", "poll", "reserve-b", "reserve-a"]);
      // A job written the pre-B1 way (no priority) lands at reserve level.
      await tx.$executeRaw`INSERT INTO supplier_jobs (id, kind, supplier_booking_id, dedupe_key) VALUES (${uuidv7()}::uuid, 'reserve', ${bookingId}::uuid, ${`old:${bookingId}`})`;
      const [old] = await tx.$queryRaw<Array<{ priority: number }>>`SELECT priority FROM supplier_jobs WHERE dedupe_key = ${`old:${bookingId}`}`;
      expect(old.priority).toBe(0);
    });
  });

  it("product_eligibility: no row means no record (inquiry); reasons must be an array", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const product = await tx.product.create({ data: { id: uuidv7(), slug: `zz-b1-${run}`, title: "test-b1", tier: "C", categorySlug: "zz-b1", confirmation: "manual" }, select: { id: true } });
      expect(await tx.productEligibility.findUnique({ where: { productId: product.id } })).toBeNull();
      await refused(tx, () => tx.$executeRaw`INSERT INTO product_eligibility (product_id, reasons, readiness_version) VALUES (${product.id}::uuid, '{}'::jsonb, 1)`, CHECK_VIOLATION);
      await tx.$executeRaw`INSERT INTO product_eligibility (product_id, readiness_version) VALUES (${product.id}::uuid, 1)`;
      expect((await tx.productEligibility.findUniqueOrThrow({ where: { productId: product.id } })).effectiveMode).toBe("inquiry");
    });
  });

  it("the grant statement adds exactly the matrix rows for existing roles, and is idempotent", async () => {
    await ensureRoles();
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations/20261101110000_b1_engine_and_provenance/migration.sql"), "utf8");
    const insert = sql.slice(sql.indexOf('INSERT INTO "role_permissions"'), sql.indexOf("ON CONFLICT DO NOTHING") + "ON CONFLICT DO NOTHING".length);
    await rolledBack(prisma, async (tx) => {
      // As on a database that predates B1: no B1 grant anywhere, plus one hand-made grant that must survive.
      await tx.rolePermission.deleteMany({ where: { permission: { in: [...B1_PERMISSIONS] } } });
      const readonly = await tx.role.findUniqueOrThrow({ where: { code: "readonly" } });
      await tx.rolePermission.create({ data: { roleId: readonly.id, permission: "zz.hand_granted" } });
      await tx.$executeRawUnsafe(insert);
      await tx.$executeRawUnsafe(insert);
      const rows = await tx.rolePermission.findMany({ where: { permission: { in: [...B1_PERMISSIONS, "zz.hand_granted"] } }, include: { role: { select: { code: true } } } });
      const held = rows.map((r) => `${r.role.code}:${r.permission}`).sort();
      const expected = Object.entries(ROLE_PERMISSIONS).flatMap(([role, perms]) => B1_PERMISSIONS.filter((p) => (perms as string[]).includes(p)).map((p) => `${role}:${p}`));
      expect(held).toEqual([...expected, "readonly:zz.hand_granted"].sort());
      for (const p of B1_PERMISSIONS) expect(held, p).toContain(`admin:${p}`);
    });
  });
});
