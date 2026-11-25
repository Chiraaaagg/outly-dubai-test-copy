import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { uuidv7 } from "../lib/ids";
import { dbEnabled, runId } from "./helpers/fixtures";
import { assertDisposableDb, assertDisposableDbLive } from "./helpers/target-guard";

/**
 * Migration 20261101130000_b3_payments_saga_ledgers on the disposable
 * database: RLS and no API-role grants on the six new tables, the new
 * payment_status values and payments checks, the refund cap trigger (in
 * sequence and under concurrent writers), the append-only ledger, and the
 * inbox, saga and remedy checks.
 *
 * Then 20261101140000_refund_cap_counts_provider_refunds: the cap counts
 * provider-reported refunds (`refunded_minor`) that no succeeded refund row
 * stands behind, as GREATEST(refunded_minor, succeeded) + open <= captured.
 *
 * Every row is synthetic. All but the concurrency tests write inside a
 * transaction that is always rolled back; the concurrency tests need
 * committed rows in separate transactions and delete them in `finally`.
 * Amounts are synthetic.
 */

type Prisma = typeof import("../lib/db").prisma;
type Tx = Parameters<Parameters<Prisma["$transaction"]>[0]>[0];

const NEW_TABLES = ["payment_sagas", "payment_events", "refunds", "customer_remedies", "ledger_entries", "settlements"];
const API_ROLES = ["anon", "authenticated"];
const ROLLBACK = new Error("ROLLBACK");
const CHECK_VIOLATION = /23514|violates check constraint|check_violation|refunds: |payments: /;
const UNIQUE_VIOLATION = /23505|Unique constraint|duplicate key/;
const APPEND_ONLY = /append-only/;
const TX = { maxWait: 20_000, timeout: 30_000 } as const;

const hex = (s: string) => createHash("sha256").update(s).digest("hex");

async function rolledBack(prisma: Prisma, fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    }, TX);
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
}

/** A savepoint, so an expected constraint error does not abort the outer transaction. */
async function refused(tx: Tx, sql: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await tx.$executeRawUnsafe("SAVEPOINT b3_probe");
  let error: unknown = null;
  try {
    await sql();
  } catch (e) {
    error = e;
  }
  await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT b3_probe");
  expect(String(error)).toMatch(pattern);
}

async function orderFixture(tx: Tx | Prisma, run: string) {
  const guest = await tx.guest.create({ data: { id: uuidv7(), phoneE164: "+910000000000", fullName: "test-b3" } });
  const combo = await tx.combo.create({ data: { id: uuidv7(), slug: `zz-b3-${run}`, name: "test-b3", confirmation: "manual" } });
  const order = await tx.order.create({
    data: {
      id: uuidv7(),
      reference: `OUT-TEST${Math.floor(Math.random() * 1e9)}`,
      rail: "self_serve",
      guestId: guest.id,
      currency: "AED",
      subtotalInr: 0n,
      subtotalAed: 1000n,
      totalInr: 0n,
      totalAed: 1000n,
      leadName: "test-b3",
      leadPhone: "+910000000000",
    },
  });
  const itemId = uuidv7();
  await tx.$executeRaw`
    INSERT INTO order_items
      (id, order_id, combo_id, title_snapshot, tier_snapshot, slug_snapshot, kind_snapshot, confirmation_snapshot,
       fulfilment_mode_snapshot, free_cancellation_hours_snapshot, duration_minutes_snapshot, service_date, pax,
       unit_inr, unit_aed, total_inr, total_aed)
    VALUES
      (${itemId}::uuid, ${order.id}::uuid, ${combo.id}::uuid, 'test-b3', 'C', ${`zz-b3-${run}`}, 'combo', 'manual',
       'inquiry', 24, 60, DATE '2030-01-15', '{"adult":1}'::jsonb, 0, 1000, 0, 1000)`;
  return { orderId: order.id, itemId, guestId: guest.id, comboId: combo.id };
}

/** A gateway payment with the full account binding. */
async function gatewayPayment(tx: Tx | Prisma, orderId: string, run: string, p: { amount?: bigint; captured?: bigint; refunded?: bigint } = {}): Promise<string> {
  const id = uuidv7();
  await tx.$executeRaw`
    INSERT INTO payments (id, order_id, gateway, gateway_payment_id, amount_minor, currency, status, source,
                          rail, provider, provider_account_id, environment, provider_order_id, idempotency_key,
                          captured_minor, refunded_minor, three_ds, risk)
    VALUES (${id}::uuid, ${orderId}::uuid, 'fake', ${`pay_${run}_${id}`}, ${p.amount ?? 1000n}, 'AED', 'captured', 'gateway_verified',
            'aed_card', 'fake', 'acct_test', 'test', ${`ord_${run}_${id}`}, ${`idem:${run}:${id}`},
            ${p.captured ?? 1000n}, ${p.refunded ?? 0n}, 'passed', 'normal')`;
  return id;
}

function insertRefund(tx: Tx | Prisma, r: { paymentId: string; itemId: string; amount: bigint; status?: string; currency?: string; id?: string }) {
  const id = r.id ?? uuidv7();
  return tx.$executeRaw`
    INSERT INTO refunds (id, payment_id, order_item_id, provider, idempotency_key, amount_minor, currency, status, reason)
    VALUES (${id}::uuid, ${r.paymentId}::uuid, ${r.itemId}::uuid, 'fake', ${`refund:${id}`}, ${r.amount},
            ${r.currency ?? "AED"}::currency, ${r.status ?? "requested"}, 'test-b3')`;
}

describe.skipIf(!dbEnabled)("migration 20261101130000: B3 payments, saga, refunds and ledgers", () => {
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

  it("payment_status has the four new values after the original six", async () => {
    const rows = await prisma.$queryRaw<Array<{ v: string }>>`SELECT unnest(enum_range(NULL::payment_status))::text AS v`;
    expect(rows.map((r) => r.v)).toEqual([
      "created", "authorized", "captured", "failed", "refunded", "partially_refunded",
      "requires_action", "voided", "expired", "capture_unknown",
    ]);
  });

  it("a payment written the manual way keeps every gateway column null and both totals 0", async () => {
    await rolledBack(prisma, async (tx) => {
      const { orderId } = await orderFixture(tx, runId());
      const id = uuidv7();
      await tx.$executeRaw`
        INSERT INTO payments (id, order_id, gateway, amount_minor, currency, status)
        VALUES (${id}::uuid, ${orderId}::uuid, 'razorpay', 1000, 'AED', 'captured')`;
      const p = await tx.payment.findUniqueOrThrow({ where: { id } });
      expect(p).toMatchObject({ source: "manual", rail: null, provider: null, idempotencyKey: null, quoteId: null, capturedMinor: 0n, refundedMinor: 0n });
    });
  });

  it("payments: refunded <= captured <= amount, the whole account binding, known 3DS/risk values, unique keys", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const { orderId } = await orderFixture(tx, run);
      const id = await gatewayPayment(tx, orderId, run, { amount: 1000n, captured: 600n, refunded: 600n });
      await refused(tx, () => tx.$executeRaw`UPDATE payments SET captured_minor = 1001 WHERE id = ${id}::uuid`, CHECK_VIOLATION);
      await refused(tx, () => tx.$executeRaw`UPDATE payments SET refunded_minor = 601 WHERE id = ${id}::uuid`, CHECK_VIOLATION);
      await refused(tx, () => tx.$executeRaw`UPDATE payments SET refunded_minor = -1 WHERE id = ${id}::uuid`, CHECK_VIOLATION);
      await refused(tx, () => tx.$executeRaw`UPDATE payments SET provider_account_id = NULL WHERE id = ${id}::uuid`, CHECK_VIOLATION);
      await refused(tx, () => tx.$executeRaw`UPDATE payments SET rail = 'usd_card' WHERE id = ${id}::uuid`, CHECK_VIOLATION);
      await refused(tx, () => tx.$executeRaw`UPDATE payments SET three_ds = 'maybe' WHERE id = ${id}::uuid`, CHECK_VIOLATION);
      await refused(tx, () => tx.$executeRaw`UPDATE payments SET risk = 'low' WHERE id = ${id}::uuid`, CHECK_VIOLATION);

      const other = await gatewayPayment(tx, orderId, run);
      const p = await tx.payment.findUniqueOrThrow({ where: { id } });
      await refused(tx, () => tx.$executeRaw`UPDATE payments SET idempotency_key = ${p.idempotencyKey} WHERE id = ${other}::uuid`, UNIQUE_VIOLATION);
      await refused(tx, () => tx.$executeRaw`UPDATE payments SET provider_order_id = ${p.providerOrderId} WHERE id = ${other}::uuid`, UNIQUE_VIOLATION);
    });
  });

  it("refund cap: non-failed refunds never total more than captured, in the payment's currency", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const { orderId, itemId } = await orderFixture(tx, run);
      const paymentId = await gatewayPayment(tx, orderId, run, { amount: 1000n, captured: 1000n });

      expect(await insertRefund(tx, { paymentId, itemId, amount: 600n })).toBe(1);
      await refused(tx, () => insertRefund(tx, { paymentId, itemId, amount: 401n }), CHECK_VIOLATION);
      await refused(tx, () => insertRefund(tx, { paymentId, itemId, amount: 401n, status: "unknown" }), CHECK_VIOLATION);
      // A failed refund does not count, and may exceed the remainder.
      const failedId = uuidv7();
      expect(await insertRefund(tx, { paymentId, itemId, amount: 900n, status: "failed", id: failedId })).toBe(1);
      expect(await insertRefund(tx, { paymentId, itemId, amount: 400n, status: "succeeded" })).toBe(1);
      // Reviving the failed one would exceed the cap.
      await refused(tx, () => tx.$executeRaw`UPDATE refunds SET status = 'accepted' WHERE id = ${failedId}::uuid`, CHECK_VIOLATION);
      // Captured cannot drop below the non-failed refunds (1,000).
      await refused(tx, () => tx.$executeRaw`UPDATE payments SET captured_minor = 999 WHERE id = ${paymentId}::uuid`, CHECK_VIOLATION);

      const other = await gatewayPayment(tx, orderId, run, { captured: 1000n });
      await refused(tx, () => insertRefund(tx, { paymentId: other, itemId, amount: 100n, currency: "INR" }), CHECK_VIOLATION);
      await refused(tx, () => insertRefund(tx, { paymentId: other, itemId, amount: 0n }), CHECK_VIOLATION);
      await refused(tx, () => insertRefund(tx, { paymentId: other, itemId, amount: 100n, status: "pending" }), CHECK_VIOLATION);

      // A manual payment has captured 0, so it takes no refund row.
      const manual = uuidv7();
      await tx.$executeRaw`
        INSERT INTO payments (id, order_id, gateway, amount_minor, currency, status)
        VALUES (${manual}::uuid, ${orderId}::uuid, 'razorpay', 1000, 'AED', 'captured')`;
      await refused(tx, () => insertRefund(tx, { paymentId: manual, itemId, amount: 1n }), CHECK_VIOLATION);
    });
  });

  it("refund cap refuses REPEATABLE READ, where its sum could miss a concurrent refund", async () => {
    const run = runId();
    const f = await orderFixture(prisma, run);
    const paymentId = await gatewayPayment(prisma, f.orderId, run);
    try {
      let error: unknown = null;
      try {
        await prisma.$transaction(async (tx) => {
          await insertRefund(tx, { paymentId, itemId: f.itemId, amount: 1n });
        }, { ...TX, isolationLevel: "RepeatableRead" });
      } catch (e) {
        error = e;
      }
      expect(String(error)).toMatch(/READ COMMITTED or SERIALIZABLE/);
    } finally {
      await cleanup(prisma, f, [paymentId]);
    }
  });

  it("concurrent refund writers cannot exceed captured: the payment row lock serialises them", async () => {
    const run = runId();
    const f = await orderFixture(prisma, run);
    const paymentId = await gatewayPayment(prisma, f.orderId, run, { amount: 1000n, captured: 1000n });
    try {
      // Five writers of 400 against 1,000 captured, each holding its
      // transaction open after the insert so they overlap. Each records its
      // backend, to show the writers really ran on separate connections.
      const backends = new Set<number>();
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          prisma.$transaction(async (tx) => {
            const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            backends.add(pid);
            await insertRefund(tx, { paymentId, itemId: f.itemId, amount: 400n });
            await tx.$executeRaw`SELECT pg_sleep(0.2)`;
          }, TX),
        ),
      );
      expect(backends.size).toBeGreaterThan(1);
      const ok = results.filter((r) => r.status === "fulfilled").length;
      expect(ok).toBe(2);
      for (const r of results) if (r.status === "rejected") expect(String(r.reason)).toMatch(CHECK_VIOLATION);

      const [{ total }] = await prisma.$queryRaw<Array<{ total: bigint }>>`
        SELECT COALESCE(SUM(amount_minor), 0)::bigint AS total FROM refunds WHERE payment_id = ${paymentId}::uuid AND status <> 'failed'`;
      expect(total).toBe(800n);

      // Same under SERIALIZABLE: one of two overlapping writers that would
      // together exceed the remaining 200 fails.
      const serial = await Promise.allSettled(
        Array.from({ length: 2 }, () =>
          prisma.$transaction(async (tx) => {
            await insertRefund(tx, { paymentId, itemId: f.itemId, amount: 150n });
            await tx.$executeRaw`SELECT pg_sleep(0.2)`;
          }, { ...TX, isolationLevel: "Serializable" }),
        ),
      );
      expect(serial.filter((r) => r.status === "fulfilled").length).toBe(1);
      const [{ after }] = await prisma.$queryRaw<Array<{ after: bigint }>>`
        SELECT COALESCE(SUM(amount_minor), 0)::bigint AS after FROM refunds WHERE payment_id = ${paymentId}::uuid AND status <> 'failed'`;
      expect(after).toBe(950n);
    } finally {
      await cleanup(prisma, f, [paymentId]);
    }
  });

  it("ledger entries are append-only, in one of three books, never zero and always with evidence", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const { orderId } = await orderFixture(tx, run);
      const paymentId = await gatewayPayment(tx, orderId, run);
      const id = uuidv7();
      const insert = (o: { id?: string; book?: string; amount?: bigint; evidence?: string } = {}) => tx.$executeRaw`
        INSERT INTO ledger_entries (id, book, order_id, payment_id, currency, amount_minor, kind, evidence_ref, occurred_at)
        VALUES (${o.id ?? uuidv7()}::uuid, ${o.book ?? "customer_money"}, ${orderId}::uuid, ${paymentId}::uuid, 'AED',
                ${o.amount ?? 1000n}, 'capture', ${o.evidence ?? `pay_${run}`}, now())`;
      expect(await insert({ id })).toBe(1);
      await refused(tx, () => tx.$executeRaw`UPDATE ledger_entries SET amount_minor = 1 WHERE id = ${id}::uuid`, APPEND_ONLY);
      await refused(tx, () => tx.$executeRaw`DELETE FROM ledger_entries WHERE id = ${id}::uuid`, APPEND_ONLY);
      await refused(tx, () => insert({ book: "general" }), CHECK_VIOLATION);
      await refused(tx, () => insert({ amount: 0n }), CHECK_VIOLATION);
      await refused(tx, () => insert({ evidence: "" }), CHECK_VIOLATION);
      expect(await insert({ book: "gateway_settlement", amount: -25n })).toBe(1);
    });
  });

  it("inbox: one row per provider event, sha256 digest only, processed_at exactly when processed", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const insert = (o: { eventId?: string; digest?: string; state?: string; processedAt?: Date | null; errorCode?: string | null }) => tx.$executeRaw`
        INSERT INTO payment_events (id, provider, provider_event_id, state, type, payload_digest, processed_at, last_error_code)
        VALUES (${uuidv7()}::uuid, 'fake', ${o.eventId ?? `evt_${run}_${uuidv7()}`}, ${o.state ?? "verified"}, 'payment.captured',
                ${o.digest ?? hex(run)}, ${o.processedAt ?? null}::timestamptz, ${o.errorCode ?? null})`;
      expect(await insert({ eventId: `evt_${run}` })).toBe(1);
      await refused(tx, () => insert({ eventId: `evt_${run}` }), UNIQUE_VIOLATION);
      await refused(tx, () => insert({ digest: '{"email":"a@example.com"}' }), CHECK_VIOLATION);
      await refused(tx, () => insert({ state: "done" }), CHECK_VIOLATION);
      await refused(tx, () => insert({ state: "processed" }), CHECK_VIOLATION);
      await refused(tx, () => insert({ state: "verified", processedAt: new Date() }), CHECK_VIOLATION);
      await refused(tx, () => insert({ state: "processing_failed", errorCode: "x".repeat(65) }), CHECK_VIOLATION);
      expect(await insert({ state: "processed", processedAt: new Date() })).toBe(1);
    });
  });

  it("saga: one per order, known states only; a remedy points at a refund only when it is a refund", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const { orderId, itemId } = await orderFixture(tx, run);
      const saga = (state: string) => tx.$executeRaw`
        INSERT INTO payment_sagas (id, order_id, order_item_id, rail, state) VALUES (${uuidv7()}::uuid, ${orderId}::uuid, ${itemId}::uuid, 'aed_card', ${state})`;
      await refused(tx, () => saga("paid"), CHECK_VIOLATION);
      expect(await saga("session_created")).toBe(1);
      await refused(tx, () => saga("authorized"), UNIQUE_VIOLATION);

      const paymentId = await gatewayPayment(tx, orderId, run);
      const refundId = uuidv7();
      await insertRefund(tx, { paymentId, itemId, amount: 100n, id: refundId });
      const remedy = (kind: string, refund: string | null) => tx.$executeRaw`
        INSERT INTO customer_remedies (id, order_id, order_item_id, kind, reason, amount_minor, currency, refund_id)
        VALUES (${uuidv7()}::uuid, ${orderId}::uuid, ${itemId}::uuid, ${kind}, 'test-b3', 100, 'AED', ${refund}::uuid)`;
      await refused(tx, () => remedy("alternative_offered", refundId), CHECK_VIOLATION);
      await refused(tx, () => remedy("voucher", null), CHECK_VIOLATION);
      expect(await remedy("refund", refundId)).toBe(1);
      expect(await remedy("alternative_offered", null)).toBe(1);
    });
  });
});

describe.skipIf(!dbEnabled)("migration 20261101140000: the refund cap counts provider-reported refunds", () => {
  let prisma: Prisma;

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../lib/db"));
    await assertDisposableDbLive(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const setRefunded = (tx: Tx | Prisma, paymentId: string, minor: bigint) =>
    tx.$executeRaw`UPDATE payments SET refunded_minor = ${minor} WHERE id = ${paymentId}::uuid`;
  const setStatus = (tx: Tx | Prisma, refundId: string, status: string) =>
    tx.$executeRaw`UPDATE refunds SET status = ${status} WHERE id = ${refundId}::uuid`;

  it("a refund made outside Outly leaves only the rest refundable", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const { orderId, itemId } = await orderFixture(tx, run);
      // 300 refunded in the provider's dashboard, no refund row.
      const paymentId = await gatewayPayment(tx, orderId, run, { amount: 1000n, captured: 1000n, refunded: 300n });
      await refused(tx, () => insertRefund(tx, { paymentId, itemId, amount: 701n }), CHECK_VIOLATION);
      // A row written as succeeded is not in refunded_minor yet either.
      await refused(tx, () => insertRefund(tx, { paymentId, itemId, amount: 701n, status: "succeeded" }), CHECK_VIOLATION);
      expect(await insertRefund(tx, { paymentId, itemId, amount: 700n })).toBe(1);
      await refused(tx, () => insertRefund(tx, { paymentId, itemId, amount: 1n, status: "unknown" }), CHECK_VIOLATION);
    });
  });

  it("an Outly refund the provider confirmed is counted once, not again through refunded_minor", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const { orderId, itemId } = await orderFixture(tx, run);
      const paymentId = await gatewayPayment(tx, orderId, run, { amount: 1000n, captured: 1000n });
      const id = uuidv7();
      expect(await insertRefund(tx, { paymentId, itemId, amount: 600n, id })).toBe(1);
      // What the refund driver does on success: the row settles and refunded_minor rises by it.
      expect(await setStatus(tx, id, "succeeded")).toBe(1);
      expect(await setRefunded(tx, paymentId, 600n)).toBe(1);
      await refused(tx, () => insertRefund(tx, { paymentId, itemId, amount: 401n }), CHECK_VIOLATION);
      expect(await insertRefund(tx, { paymentId, itemId, amount: 400n })).toBe(1);
    });
  });

  it("an open Outly refund and a dashboard refund both count (the larger of the two alone would not do)", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const { orderId, itemId } = await orderFixture(tx, run);
      const paymentId = await gatewayPayment(tx, orderId, run, { amount: 1000n, captured: 1000n });
      expect(await insertRefund(tx, { paymentId, itemId, amount: 500n })).toBe(1);
      expect(await setRefunded(tx, paymentId, 500n)).toBe(1);
      // GREATEST(500, 0) + 500 open = 1,000: nothing is left.
      await refused(tx, () => insertRefund(tx, { paymentId, itemId, amount: 1n }), CHECK_VIOLATION);
    });
  });

  it("recording a provider outcome is never refused; claiming more of the payment is", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const { orderId, itemId } = await orderFixture(tx, run);
      const paymentId = await gatewayPayment(tx, orderId, run, { amount: 1000n, captured: 1000n });
      const a = uuidv7();
      const b = uuidv7();
      expect(await insertRefund(tx, { paymentId, itemId, amount: 600n, id: a })).toBe(1);
      expect(await insertRefund(tx, { paymentId, itemId, amount: 400n, id: b })).toBe(1);
      // A provider read shows refund a landed before its row settled: counted
      // twice for now (600 + 1,000 open), so no new refund is let in...
      expect(await setRefunded(tx, paymentId, 600n)).toBe(1);
      await refused(tx, () => insertRefund(tx, { paymentId, itemId, amount: 1n }), CHECK_VIOLATION);
      // ...but the driver can still record what the provider says.
      expect(await tx.$executeRaw`UPDATE refunds SET amount_minor = 599 WHERE id = ${a}::uuid`).toBe(1);
      expect(await setStatus(tx, a, "accepted")).toBe(1);
      expect(await setStatus(tx, a, "succeeded")).toBe(1);
      expect(await setStatus(tx, b, "failed")).toBe(1);
      // A larger amount is a new claim on top of refunded_minor: 600 + 600.
      await refused(tx, () => tx.$executeRaw`UPDATE refunds SET amount_minor = 600 WHERE id = ${a}::uuid`, CHECK_VIOLATION);

      // 400 more refunded in the dashboard: 1,000 now gone at the provider.
      expect(await setRefunded(tx, paymentId, 1000n)).toBe(1);
      await refused(tx, () => setStatus(tx, b, "accepted"), CHECK_VIOLATION);
      await refused(tx, () => setStatus(tx, a, "requested"), CHECK_VIOLATION);
      await refused(tx, () => insertRefund(tx, { paymentId, itemId, amount: 1n }), CHECK_VIOLATION);
      // A failed refund still does not count.
      expect(await insertRefund(tx, { paymentId, itemId, amount: 1n, status: "failed" })).toBe(1);
    });
  });

  it("captured cannot drop below GREATEST(refunded_minor, succeeded) + open", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const { orderId, itemId } = await orderFixture(tx, run);
      const paymentId = await gatewayPayment(tx, orderId, run, { amount: 1000n, captured: 1000n, refunded: 300n });
      expect(await insertRefund(tx, { paymentId, itemId, amount: 500n })).toBe(1);
      await refused(tx, () => tx.$executeRaw`UPDATE payments SET captured_minor = 799 WHERE id = ${paymentId}::uuid`, CHECK_VIOLATION);
      expect(await tx.$executeRaw`UPDATE payments SET captured_minor = 800 WHERE id = ${paymentId}::uuid`).toBe(1);
    });
  });

  it("a refund writer waits for a concurrent provider sync and sees its refunded_minor", async () => {
    const run = runId();
    const f = await orderFixture(prisma, run);
    const paymentId = await gatewayPayment(prisma, f.orderId, run, { amount: 1000n, captured: 1000n });
    try {
      // The sync holds the payment row lock from its update until it commits.
      let locked!: () => void;
      const held = new Promise<void>((resolve) => (locked = resolve));
      const sync = prisma.$transaction(async (tx) => {
        await setRefunded(tx, paymentId, 600n);
        locked();
        await tx.$executeRaw`SELECT pg_sleep(0.3)`;
      }, TX);
      await held;
      let error: unknown = null;
      try {
        await prisma.$transaction(async (tx) => {
          await insertRefund(tx, { paymentId, itemId: f.itemId, amount: 500n });
        }, TX);
      } catch (e) {
        error = e;
      }
      await sync;
      expect(String(error)).toMatch(CHECK_VIOLATION);
      const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*)::bigint AS n FROM refunds WHERE payment_id = ${paymentId}::uuid`;
      expect(n).toBe(0n);
    } finally {
      await cleanup(prisma, f, [paymentId]);
    }
  });

  it("still refuses REPEATABLE READ", async () => {
    const run = runId();
    const f = await orderFixture(prisma, run);
    const paymentId = await gatewayPayment(prisma, f.orderId, run, { refunded: 100n });
    try {
      let error: unknown = null;
      try {
        await prisma.$transaction(async (tx) => {
          await insertRefund(tx, { paymentId, itemId: f.itemId, amount: 1n });
        }, { ...TX, isolationLevel: "RepeatableRead" });
      } catch (e) {
        error = e;
      }
      expect(String(error)).toMatch(/READ COMMITTED or SERIALIZABLE/);
    } finally {
      await cleanup(prisma, f, [paymentId]);
    }
  });
});

describe.skipIf(!dbEnabled)("migrations 20261102090000 and 20261102100000: the B3 recheck", () => {
  let prisma: Prisma;

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../lib/db"));
    await assertDisposableDbLive(prisma);
  });

  it("payment_sagas.checked_at is a nullable timestamp with no default (CR-B3-14)", async () => {
    const cols = await prisma.$queryRaw<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payment_sagas' AND column_name = 'checked_at'`;
    expect(cols).toEqual([{ data_type: "timestamp with time zone", is_nullable: "YES", column_default: null }]);
  });

  it("settlements are append-only (CR-B3-12)", async () => {
    await rolledBack(prisma, async (tx) => {
      const id = uuidv7();
      expect(
        await tx.$executeRaw`
          INSERT INTO settlements (id, provider, provider_settlement_id, currency, gross_minor, fee_minor, net_minor, settled_at, raw_digest)
          VALUES (${id}::uuid, 'fake', ${`stl_${runId()}`}, 'AED', 1000, 20, 980, now(), ${hex(id)})`,
      ).toBe(1);
      await refused(tx, () => tx.$executeRaw`UPDATE settlements SET fee_minor = 0 WHERE id = ${id}::uuid`, APPEND_ONLY);
      await refused(tx, () => tx.$executeRaw`DELETE FROM settlements WHERE id = ${id}::uuid`, APPEND_ONLY);
    });
  });

  it("a refund names an order item of the order its payment paid for (CR-B3-12)", async () => {
    await rolledBack(prisma, async (tx) => {
      const run = runId();
      const mine = await orderFixture(tx, run);
      const other = await orderFixture(tx, `${run}-other`);
      const paymentId = await gatewayPayment(tx, mine.orderId, run);
      await refused(tx, () => insertRefund(tx, { paymentId, itemId: other.itemId, amount: 100n }), /is not on the order of payment/);
      const id = uuidv7();
      expect(await insertRefund(tx, { id, paymentId, itemId: mine.itemId, amount: 100n })).toBe(1);
      await refused(tx, () => tx.$executeRaw`UPDATE refunds SET order_item_id = ${other.itemId}::uuid WHERE id = ${id}::uuid`, /is not on the order of payment/);
      // The refund driver's status updates are unaffected.
      expect(await tx.$executeRaw`UPDATE refunds SET status = 'accepted' WHERE id = ${id}::uuid`).toBe(1);
    });
  });
});

/** Deletes the committed rows of the committed-row tests (refunds first; nothing else references them). */
async function cleanup(prisma: Prisma, f: { orderId: string; itemId: string; guestId: string; comboId: string }, paymentIds: string[]): Promise<void> {
  await prisma.$executeRaw`DELETE FROM refunds WHERE payment_id = ANY(${paymentIds}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM payments WHERE id = ANY(${paymentIds}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM order_items WHERE id = ${f.itemId}::uuid`;
  await prisma.$executeRaw`DELETE FROM orders WHERE id = ${f.orderId}::uuid`;
  await prisma.$executeRaw`DELETE FROM guests WHERE id = ${f.guestId}::uuid`;
  await prisma.$executeRaw`DELETE FROM combos WHERE id = ${f.comboId}::uuid`;
}
