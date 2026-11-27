import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { uuidv7 } from "../lib/ids";
import { MARGIN_POLICY_SETTING_KEY, type MarginPolicy } from "../quotes/contracts";
import { dbEnabled, runId } from "./helpers/fixtures";
import { assertDisposableDb, assertDisposableDbLive } from "./helpers/target-guard";

/**
 * Migration 20261101120000_b2_quotes_verification_margin on the disposable
 * database: RLS and no API-role grants on the three new tables, the quote
 * owner, status and fingerprint rules, the verification channel rules, the
 * per-item allocation checks, and the margin policy settings row.
 *
 * Every row is synthetic and written inside a transaction that is always
 * rolled back, so nothing persists. Amounts are synthetic.
 */

type Prisma = typeof import("../lib/db").prisma;
type Tx = Parameters<Parameters<Prisma["$transaction"]>[0]>[0];

const NEW_TABLES = ["guest_sessions", "quotes", "order_contact_verifications"];
const API_ROLES = ["anon", "authenticated"];
const ROLLBACK = new Error("ROLLBACK");
const CHECK_VIOLATION = /23514|violates check constraint/;
const UNIQUE_VIOLATION = /23505|Unique constraint|duplicate key/;
const FK_VIOLATION = /23503|Foreign key constraint|violates foreign key/;

const hex = (s: string) => createHash("sha256").update(s).digest("hex");

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
  await tx.$executeRawUnsafe("SAVEPOINT b2_probe");
  let error: unknown = null;
  try {
    await sql();
  } catch (e) {
    error = e;
  }
  await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT b2_probe");
  expect(String(error)).toMatch(pattern);
}

async function guestSession(tx: Tx, run: string): Promise<string> {
  const id = uuidv7();
  await tx.guestSession.create({ data: { id, tokenHash: hex(`gs:${run}:${id}`), expiresAt: new Date(Date.now() + 3_600_000) } });
  return id;
}

function insertQuote(tx: Tx, q: { id?: string; fingerprint: string; ownerKind: string; customerId?: string | null; guestSessionId?: string | null; status?: string; usedByOrderId?: string | null; totalMinor?: bigint }) {
  return tx.$executeRaw`
    INSERT INTO quotes (id, fingerprint, owner_kind, customer_id, guest_session_id, currency, total_minor, lines, request, status, expires_at, used_by_order_id)
    VALUES (${q.id ?? uuidv7()}::uuid, ${q.fingerprint}, ${q.ownerKind}, ${q.customerId ?? null}::uuid, ${q.guestSessionId ?? null}::uuid, 'AED',
            ${q.totalMinor ?? 10000n}, '[]'::jsonb, '{"lines":[]}'::jsonb, ${q.status ?? "active"}, now() + interval '10 minutes', ${q.usedByOrderId ?? null}::uuid)`;
}

async function orderFixture(tx: Tx, run: string) {
  const guest = await tx.guest.create({ data: { id: uuidv7(), phoneE164: "+910000000000", fullName: "test-b2" } });
  const combo = await tx.combo.create({ data: { id: uuidv7(), slug: `zz-b2-${run}`, name: "test-b2", confirmation: "manual" } });
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
      leadName: "test-b2",
      leadPhone: "+910000000000",
    },
  });
  // Written the pre-B2 way: none of the new columns.
  const itemId = uuidv7();
  await tx.$executeRaw`
    INSERT INTO order_items
      (id, order_id, combo_id, title_snapshot, tier_snapshot, slug_snapshot, kind_snapshot, confirmation_snapshot,
       fulfilment_mode_snapshot, free_cancellation_hours_snapshot, duration_minutes_snapshot, service_date, pax,
       unit_inr, unit_aed, total_inr, total_aed)
    VALUES
      (${itemId}::uuid, ${order.id}::uuid, ${combo.id}::uuid, 'test-b2', 'C', ${`zz-b2-${run}`}, 'combo', 'manual',
       'inquiry', 24, 60, DATE '2030-01-15', '{"adult":1}'::jsonb, 1000, 45, 1000, 45)`;
  return { orderId: order.id, itemId };
}

describe.skipIf(!dbEnabled)("migration 20261101120000: B2 quotes, verification and margin inputs", () => {
  let prisma: Prisma;

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../lib/db"));
    await assertDisposableDbLive(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("the new tables have row level security on and no Supabase API-role privilege", async () => {
    const rows = await prisma.$queryRaw<Array<{ name: string; rls: boolean }>>`
      SELECT c.relname::text AS name, c.relrowsecurity AS rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY(${NEW_TABLES}::text[]) ORDER BY 1`;
    expect(rows).toEqual([...NEW_TABLES].sort().map((name) => ({ name, rls: true })));

    const roles = await prisma.$queryRaw<Array<{ rolname: string }>>`SELECT rolname::text AS rolname FROM pg_roles WHERE rolname = ANY(${API_ROLES}::text[]) ORDER BY 1`;
    expect(roles.map((r) => r.rolname)).toEqual(API_ROLES);
    for (const role of API_ROLES) {
      const granted = await prisma.$queryRaw<Array<{ name: string }>>`
        SELECT t AS name FROM unnest(${NEW_TABLES}::text[]) AS t
        WHERE has_table_privilege(${role}, ('public.' || t)::regclass, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')`;
      expect(granted, role).toEqual([]);
    }
  });

  it("a quote has exactly one owner that matches owner_kind", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const gs = await guestSession(tx, run);
      expect(await insertQuote(tx, { fingerprint: hex(`a:${run}`), ownerKind: "guest", guestSessionId: gs })).toBe(1);
      await refused(tx, () => insertQuote(tx, { fingerprint: hex(`b:${run}`), ownerKind: "customer", guestSessionId: gs }), CHECK_VIOLATION);
      await refused(tx, () => insertQuote(tx, { fingerprint: hex(`c:${run}`), ownerKind: "guest" }), CHECK_VIOLATION);
      await refused(tx, () => insertQuote(tx, { fingerprint: hex(`d:${run}`), ownerKind: "staff", guestSessionId: gs }), CHECK_VIOLATION);
    });
  });

  it("refuses a negative total, a non-hex fingerprint, an unknown status and used without an order", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const gs = await guestSession(tx, run);
      await refused(tx, () => insertQuote(tx, { fingerprint: hex(`n:${run}`), ownerKind: "guest", guestSessionId: gs, totalMinor: -1n }), CHECK_VIOLATION);
      await refused(tx, () => insertQuote(tx, { fingerprint: "not-a-hash", ownerKind: "guest", guestSessionId: gs }), CHECK_VIOLATION);
      await refused(tx, () => insertQuote(tx, { fingerprint: hex(`s:${run}`), ownerKind: "guest", guestSessionId: gs, status: "paid" }), CHECK_VIOLATION);
      await refused(tx, () => insertQuote(tx, { fingerprint: hex(`u:${run}`), ownerKind: "guest", guestSessionId: gs, status: "used" }), CHECK_VIOLATION);
    });
  });

  it("fingerprint is unique per owner among active quotes; re-quoting after supersede, or for another owner, is allowed", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const [a, b] = [await guestSession(tx, run), await guestSession(tx, run)];
      const fp = hex(`fp:${run}`);
      const first = uuidv7();
      await insertQuote(tx, { id: first, fingerprint: fp, ownerKind: "guest", guestSessionId: a });
      await refused(tx, () => insertQuote(tx, { fingerprint: fp, ownerKind: "guest", guestSessionId: a }), UNIQUE_VIOLATION);
      expect(await insertQuote(tx, { fingerprint: fp, ownerKind: "guest", guestSessionId: b })).toBe(1);
      await tx.$executeRaw`UPDATE quotes SET status = 'superseded' WHERE id = ${first}::uuid`;
      expect(await insertQuote(tx, { fingerprint: fp, ownerKind: "guest", guestSessionId: a })).toBe(1);
    });
  });

  it("one order consumes at most one quote, and the order must exist", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const gs = await guestSession(tx, run);
      const { orderId } = await orderFixture(tx, run);
      expect(await insertQuote(tx, { fingerprint: hex(`o1:${run}`), ownerKind: "guest", guestSessionId: gs, status: "used", usedByOrderId: orderId })).toBe(1);
      await refused(tx, () => insertQuote(tx, { fingerprint: hex(`o2:${run}`), ownerKind: "guest", guestSessionId: gs, status: "used", usedByOrderId: orderId }), UNIQUE_VIOLATION);
      await refused(tx, () => insertQuote(tx, { fingerprint: hex(`o3:${run}`), ownerKind: "guest", guestSessionId: gs, status: "used", usedByOrderId: uuidv7() }), FK_VIOLATION);
    });
  });

  it("verification: one per quote and channel; the method must prove its own channel; the hash is sha256 hex", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const gs = await guestSession(tx, run);
      const quoteId = uuidv7();
      await insertQuote(tx, { id: quoteId, fingerprint: hex(`v:${run}`), ownerKind: "guest", guestSessionId: gs });
      const verify = (channel: string, method: string, contactHash = hex(`${channel}:${run}`)) => tx.$executeRaw`
        INSERT INTO order_contact_verifications (id, quote_id, channel, contact_hash, method, verified_at)
        VALUES (${uuidv7()}::uuid, ${quoteId}::uuid, ${channel}, ${contactHash}, ${method}, now())`;
      expect(await verify("phone", "otp_whatsapp")).toBe(1);
      await refused(tx, () => verify("phone", "otp_sms"), UNIQUE_VIOLATION);
      await refused(tx, () => verify("email", "otp_sms"), CHECK_VIOLATION);
      await refused(tx, () => verify("email", "email_code", "+910000000000"), CHECK_VIOLATION);
      await refused(tx, () => verify("postal", "email_code"), CHECK_VIOLATION);
      expect(await verify("email", "email_code")).toBe(1);
      const rows = await tx.orderContactVerification.findMany({ where: { quoteId } });
      expect(rows.map((r) => r.orderId)).toEqual([null, null]);
    });
  });

  it("order items written the pre-B2 way keep every new column null; allocation checks hold", async () => {
    await rolledBack(prisma, async (tx) => {
      const { itemId } = await orderFixture(tx, runId());
      const item = await tx.orderItem.findUniqueOrThrow({ where: { id: itemId } });
      expect([item.chargedCurrency, item.chargedAmountMinor, item.discountAllocMinor, item.taxAllocMinor, item.quoteId, item.marginSnapshot]).toEqual([null, null, null, null, null, null]);

      const set = (sql: string) => tx.$executeRawUnsafe(`UPDATE order_items SET ${sql} WHERE id = $1::uuid`, itemId);
      await refused(tx, () => set(`charged_amount_minor = 100`), CHECK_VIOLATION);
      await refused(tx, () => set(`charged_currency = 'AED'`), CHECK_VIOLATION);
      await refused(tx, () => set(`charged_currency = 'AED', charged_amount_minor = -1`), CHECK_VIOLATION);
      await refused(tx, () => set(`discount_alloc_minor = 5`), CHECK_VIOLATION);
      await refused(tx, () => set(`charged_currency = 'AED', charged_amount_minor = 100, tax_alloc_minor = -1`), CHECK_VIOLATION);
      await refused(tx, () => set(`margin_snapshot = '[]'::jsonb`), CHECK_VIOLATION);
      await refused(tx, () => set(`quote_id = '${uuidv7()}'::uuid`), FK_VIOLATION);
      expect(await set(`charged_currency = 'AED', charged_amount_minor = 100, discount_alloc_minor = 10, tax_alloc_minor = 5, margin_snapshot = '{"policyVersion":1}'::jsonb`)).toBe(1);
    });
  });

  it("no existing order item has a charged amount; mappings have the nullable approved_offer_hash", async () => {
    const [r] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM order_items WHERE charged_amount_minor IS NOT NULL AND quote_id IS NULL`;
    expect(r.n).toBe(0n);
    const [col] = await prisma.$queryRaw<Array<{ is_nullable: string; data_type: string }>>`
      SELECT is_nullable::text, data_type::text FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'product_supplier_mappings' AND column_name = 'approved_offer_hash'`;
    expect(col).toEqual({ is_nullable: "YES", data_type: "text" });
  });

  it("the margin policy settings row exists with version 1 and the provisional 1,500 bps floor", async () => {
    const row = await prisma.setting.findUnique({ where: { key: MARGIN_POLICY_SETTING_KEY } });
    const policy = row?.value as unknown as MarginPolicy;
    expect(policy.version).toBe(1);
    expect(policy.floorBps).toBe(1500);
    expect(Number.isNaN(Date.parse(policy.effectiveFrom))).toBe(false);
    expect(policy.effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
