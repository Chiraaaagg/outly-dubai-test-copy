import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../lib/ids";
import { assertDisposableDb, dbEnabled, runId } from "../helpers/fixtures";
import { assertDisposableDbLive } from "../helpers/target-guard";

/**
 * Migration 20261102120000_b5_cancellation_requests on the disposable
 * database: RLS on and no API-role grants on the new table; the checks
 * (kind, status, kind and status agree, origin, closed exactly at an end
 * state, a refund only after a verified cancel, reason code shape,
 * eligibility is an object); the consistency trigger (the item is the
 * order's, a named booking and refund are the item's, fixed columns, a
 * closed request is frozen, a named refund is fixed); and at most one open
 * request per order item.
 *
 * Every row is synthetic and written inside a transaction that is always
 * rolled back.
 */

type Prisma = typeof import("../../lib/db").prisma;
type Tx = Parameters<Parameters<Prisma["$transaction"]>[0]>[0];

const TABLE = "cancellation_requests";
const API_ROLES = ["anon", "authenticated"];
const ROLLBACK = new Error("ROLLBACK");
const TX = { maxWait: 20_000, timeout: 30_000 } as const;
const check = (name: string) => new RegExp(`cancellation_requests_${name}_check`);
/** Unique violations name the key, not the index: the only unique key on order_item_id is the one-open index. */
const ONE_OPEN = /23505[^]*Key \(order_item_id\)/;

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

/** A savepoint, so an expected error does not abort the outer transaction. */
async function refused(tx: Tx, sql: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await tx.$executeRawUnsafe("SAVEPOINT b5_probe");
  let error: unknown = null;
  try {
    await sql();
  } catch (e) {
    error = e;
  }
  await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT b5_probe");
  expect(String(error)).toMatch(pattern);
}

async function accepted(tx: Tx, sql: () => Promise<unknown>): Promise<void> {
  await tx.$executeRawUnsafe("SAVEPOINT b5_probe");
  await sql();
  await tx.$executeRawUnsafe("RELEASE SAVEPOINT b5_probe");
}

interface Row {
  id?: string;
  orderId: string;
  itemId: string;
  bookingId?: string | null;
  kind?: string;
  status?: string;
  via?: string;
  eligibility?: string;
  reasonCode?: string | null;
  refundId?: string | null;
  closed?: boolean;
}

function insert(tx: Tx, r: Row) {
  const status = r.status ?? "requested";
  const closed = r.closed ?? ["refunded", "refused", "exception_closed"].includes(status);
  return tx.$executeRaw`
    INSERT INTO cancellation_requests (id, order_id, order_item_id, supplier_booking_id, kind, status, requested_via, eligibility, reason_code, refund_id, closed_at)
    VALUES (${r.id ?? uuidv7()}::uuid, ${r.orderId}::uuid, ${r.itemId}::uuid, ${r.bookingId ?? null}::uuid, ${r.kind ?? "supported"}, ${status},
            ${r.via ?? "guest"}, ${r.eligibility ?? "{}"}::jsonb, ${r.reasonCode ?? null}, ${r.refundId ?? null}::uuid,
            ${closed ? new Date() : null}::timestamptz)`;
}

describe.skipIf(!dbEnabled)("migration 20261102120000: B5 cancellation requests", () => {
  let prisma: Prisma;
  const run = runId();

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  /**
   * Two orders, each with an item, a supplier booking for it and a captured
   * payment with a refund for that item. `booking` and `refund` are not Row
   * fields, so spreading an order into a row names neither.
   */
  async function fixture(tx: Tx) {
    const supplierId = uuidv7();
    await tx.supplier.create({ data: { id: supplierId, code: `zz-b5-${run}-${uuidv7().slice(-6)}`, name: "test-b5", source: "api", adapter: "traveldesk" } });
    const order = async () => {
      const guest = await tx.guest.create({ data: { id: uuidv7(), phoneE164: "+910000000000", fullName: "test-b5" } });
      const combo = await tx.combo.create({ data: { id: uuidv7(), slug: `zz-b5-${run}-${uuidv7().slice(-8)}`, name: "test-b5", confirmation: "manual" } });
      const o = await tx.order.create({
        data: { id: uuidv7(), reference: `OUT-TEST${Math.floor(Math.random() * 1e9)}`, rail: "self_serve", guestId: guest.id, currency: "AED", subtotalInr: 0n, subtotalAed: 1000n, totalInr: 0n, totalAed: 1000n, leadName: "test-b5", leadPhone: "+910000000000" },
      });
      const item = await tx.orderItem.create({
        data: {
          id: uuidv7(), orderId: o.id, comboId: combo.id, titleSnapshot: "test-b5", tierSnapshot: "C", slugSnapshot: combo.slug, kindSnapshot: "combo", confirmationSnapshot: "manual",
          fulfilmentModeSnapshot: "inquiry", freeCancellationHoursSnapshot: 24, durationMinutesSnapshot: 60, serviceDate: new Date("2030-01-15"), pax: { adult: 1 }, unitInr: 0n, unitAed: 1000n, totalInr: 0n, totalAed: 1000n,
        },
      });
      const b = await tx.supplierBooking.create({
        data: {
          id: uuidv7(), orderId: o.id, orderItemId: item.id, supplierId, environment: "test", idempotencyKey: `b5-${run}-${uuidv7()}`, clientRef: `OUTTD-B5${uuidv7().slice(-12)}`,
          bookingKind: "live_book", afterReserve: "await_payment", state: "confirmed", tourExternalId: "1", offerExternalId: "1", serviceDate: new Date("2030-01-15"),
          adults: 1, guestName: "test-b5", expectedNetMinor: 1000n, expectedNetUsdMinor: 270n,
        },
      });
      const paymentId = uuidv7();
      await tx.$executeRaw`
        INSERT INTO payments (id, order_id, gateway, gateway_payment_id, amount_minor, currency, status, source,
                              rail, provider, provider_account_id, environment, provider_order_id, idempotency_key,
                              captured_minor, refunded_minor, three_ds, risk)
        VALUES (${paymentId}::uuid, ${o.id}::uuid, 'fake', ${`pay_${run}_${paymentId}`}, 1000, 'AED', 'captured', 'gateway_verified',
                'aed_card', 'fake', 'acct_test', 'test', ${`ord_${run}_${paymentId}`}, ${`idem:${run}:${paymentId}`},
                1000, 0, 'passed', 'normal')`;
      const refundId = uuidv7();
      await tx.$executeRaw`
        INSERT INTO refunds (id, payment_id, order_item_id, provider, idempotency_key, amount_minor, currency, status, reason)
        VALUES (${refundId}::uuid, ${paymentId}::uuid, ${item.id}::uuid, 'fake', ${`refund:${refundId}`}, 500, 'AED'::currency, 'requested', 'test-b5')`;
      return { orderId: o.id, itemId: item.id, booking: b.id, refund: refundId };
    };
    return { a: await order(), b: await order() };
  }

  it("the new table has row level security on and no Supabase API-role privilege", async () => {
    const rows = await prisma.$queryRaw<Array<{ rls: boolean }>>`
      SELECT c.relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ${TABLE}`;
    expect(rows).toEqual([{ rls: true }]);
    const roles = await prisma.$queryRaw<Array<{ rolname: string }>>`SELECT rolname::text AS rolname FROM pg_roles WHERE rolname = ANY(${API_ROLES}::text[]) ORDER BY 1`;
    expect(roles.map((r) => r.rolname)).toEqual(API_ROLES);
    for (const role of API_ROLES) {
      const [row] = await prisma.$queryRaw<Array<{ granted: boolean }>>`
        SELECT has_table_privilege(${role}, ${`public.${TABLE}`}::regclass, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS granted`;
      expect(row.granted, role).toBe(false);
    }
  });

  it("checks: vocabularies, kind and status agree, closed exactly at an end state, reason code and eligibility shape", async () => {
    await rolledBack(prisma, async (tx) => {
      const { a } = await fixture(tx);
      await refused(tx, () => insert(tx, { ...a, kind: "goodwill" }), check("kind"));
      await refused(tx, () => insert(tx, { ...a, status: "approved" }), check("status"));
      await refused(tx, () => insert(tx, { ...a, via: "email" }), check("via"));
      // An exception is only ever open or closed; a supported request never uses those two values.
      await refused(tx, () => insert(tx, { ...a, kind: "exception", status: "requested" }), check("kind_status"));
      await refused(tx, () => insert(tx, { ...a, kind: "supported", status: "exception_open" }), check("kind_status"));
      // Closed exactly when the status is an end state.
      await refused(tx, () => insert(tx, { ...a, status: "refused", closed: false }), check("closed"));
      await refused(tx, () => insert(tx, { ...a, status: "cancelling", closed: true }), check("closed"));
      await refused(tx, () => insert(tx, { ...a, kind: "exception", status: "exception_closed", closed: false }), check("closed"));
      // A short code, never supplier text.
      for (const bad of ["Past deadline", "past-deadline", "x".repeat(65), ""]) await refused(tx, () => insert(tx, { ...a, reasonCode: bad }), check("reason_code"));
      for (const bad of ["[]", '"x"', "1", "null"]) await refused(tx, () => insert(tx, { ...a, eligibility: bad }), check("eligibility_object"));
      // Each accepted row is closed, so the one-open index does not interfere.
      await accepted(tx, () => insert(tx, { ...a, status: "refused", reasonCode: "past_deadline", eligibility: '{"deadlinePassed":true}' }));
      await accepted(tx, () => insert(tx, { ...a, kind: "exception", status: "exception_closed", via: "customer" }));
      await accepted(tx, () => insert(tx, { ...a, status: "refused", via: "staff", reasonCode: "cancel_refused.policy" }));
    });
  });

  it("a refund is named only on a supported request whose cancellation was verified", async () => {
    await rolledBack(prisma, async (tx) => {
      const { a } = await fixture(tx);
      for (const status of ["requested", "cancelling", "cancel_unverified", "refused"]) {
        await refused(tx, () => insert(tx, { ...a, status, refundId: a.refund }), check("refund"));
      }
      await refused(tx, () => insert(tx, { ...a, kind: "exception", status: "exception_open", refundId: a.refund }), check("refund"));
      await accepted(tx, () => insert(tx, { ...a, status: "refund_pending", refundId: a.refund }));
      // One request per refund.
      await accepted(tx, () => tx.$executeRaw`UPDATE cancellation_requests SET status = 'refunded', closed_at = now() WHERE refund_id = ${a.refund}::uuid`);
      await refused(tx, () => insert(tx, { ...a, status: "refund_failed", refundId: a.refund }), /23505[^]*Key \(refund_id\)/);
    });
  });

  it("the trigger: the item is the order's, and a named booking and refund are the item's", async () => {
    await rolledBack(prisma, async (tx) => {
      const { a, b } = await fixture(tx);
      await refused(tx, () => insert(tx, { ...a, itemId: b.itemId }), /is not on order/);
      await refused(tx, () => insert(tx, { ...a, bookingId: b.booking }), /supplier booking .* is not for order item/);
      await refused(tx, () => insert(tx, { ...a, status: "refund_pending", refundId: b.refund }), /refund .* is not for order item/);
      await accepted(tx, () => insert(tx, { ...a, bookingId: a.booking, status: "refund_pending", refundId: a.refund }));
    });
  });

  it("the trigger: order, item, kind, origin and creation time are fixed; a closed request is frozen; a named refund is fixed", async () => {
    await rolledBack(prisma, async (tx) => {
      const { a, b } = await fixture(tx);
      const id = uuidv7();
      await insert(tx, { ...a, id, bookingId: a.booking });
      await refused(tx, () => tx.$executeRaw`UPDATE cancellation_requests SET requested_via = 'staff' WHERE id = ${id}::uuid`, /are fixed/);
      await refused(tx, () => tx.$executeRaw`UPDATE cancellation_requests SET created_at = created_at - interval '1 day' WHERE id = ${id}::uuid`, /are fixed/);
      await refused(tx, () => tx.$executeRaw`UPDATE cancellation_requests SET order_id = ${b.orderId}::uuid, order_item_id = ${b.itemId}::uuid, supplier_booking_id = NULL WHERE id = ${id}::uuid`, /are fixed/);
      // The normal path: cancelling, then verified with a refund, then refunded and closed.
      await accepted(tx, () => tx.$executeRaw`UPDATE cancellation_requests SET status = 'cancelling', updated_at = now() WHERE id = ${id}::uuid`);
      await accepted(tx, () => tx.$executeRaw`UPDATE cancellation_requests SET status = 'refund_pending', refund_id = ${a.refund}::uuid WHERE id = ${id}::uuid`);
      await refused(tx, () => tx.$executeRaw`UPDATE cancellation_requests SET refund_id = NULL WHERE id = ${id}::uuid`, /the refund it names is fixed/);
      await accepted(tx, () => tx.$executeRaw`UPDATE cancellation_requests SET status = 'refunded', closed_at = now() WHERE id = ${id}::uuid`);
      await refused(tx, () => tx.$executeRaw`UPDATE cancellation_requests SET reason_code = 'reopened' WHERE id = ${id}::uuid`, /is closed/);
    });
  });

  it("at most one open request per order item; a closed one does not block a new one", async () => {
    await rolledBack(prisma, async (tx) => {
      const { a, b } = await fixture(tx);
      await accepted(tx, () => insert(tx, { ...a }));
      await refused(tx, () => insert(tx, { ...a }), ONE_OPEN);
      await refused(tx, () => insert(tx, { ...a, kind: "exception", status: "exception_open" }), ONE_OPEN);
      // Another item is independent.
      await accepted(tx, () => insert(tx, { ...b, kind: "exception", status: "exception_open" }));
      // Once the open one ends, a new request may start.
      await accepted(tx, () => tx.$executeRaw`UPDATE cancellation_requests SET status = 'refused', reason_code = 'past_deadline', closed_at = now() WHERE order_item_id = ${a.itemId}::uuid AND closed_at IS NULL`);
      await accepted(tx, () => insert(tx, { ...a, kind: "exception", status: "exception_open" }));
      await accepted(tx, () => insert(tx, { ...a, status: "refused" }));
    });
  });
});
