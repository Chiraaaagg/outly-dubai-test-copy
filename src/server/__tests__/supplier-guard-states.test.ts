import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { B1A_BLOCKING_STATES, GUARD_RELEASING_STATES } from "../suppliers/booking-port";
import { uuidv7 } from "../lib/ids";
import { dbEnabled, runId } from "./helpers/fixtures";
import { assertDisposableDb, assertDisposableDbLive } from "./helpers/target-guard";

/**
 * Duplicate guard for the B1a blocking states (doc 22 §23 B1a).
 *
 * `sb_one_live_per_order_item` lists only the guard-releasing states in its
 * NOT IN predicate, so a state added later blocks a second attempt for the
 * same order item without any change to the index. This proves it in the
 * database for each of `awaiting_payment`, `not_found_unresolved` and
 * `cancel_unverified`, and checks that a releasing state still lets a second
 * attempt through (so the refusal comes from the predicate, not from some
 * other constraint on the synthetic rows).
 *
 * Every row (supplier, guest, combo, order, order item, bookings) is synthetic
 * and created inside a transaction that is always rolled back, so nothing
 * persists. Postgres reports a partial-index violation by key, not by index
 * name, so the refusal is matched on SQLSTATE 23505 for key (order_item_id),
 * and a catalogue check proves `sb_one_live_per_order_item` is the only unique
 * index on supplier_bookings that covers that column.
 */

type Prisma = typeof import("../lib/db").prisma;
type Tx = Parameters<Parameters<Prisma["$transaction"]>[0]>[0];

const ROLLBACK = new Error("ROLLBACK");
const GUARD_VIOLATION = /23505[\s\S]*Key \(order_item_id\)/;

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

/** Synthetic FK targets for one order item; returns the ids the booking rows need. */
async function orderItemFixture(tx: Tx, run: string): Promise<{ supplierId: string; orderId: string; orderItemId: string }> {
  const supplierId = uuidv7();
  await tx.supplier.create({ data: { id: supplierId, code: `zz-guard-${run}`, name: "Guard test supplier", source: "api", adapter: "traveldesk" } });
  const guest = await tx.guest.create({ data: { id: uuidv7(), phoneE164: "+910000000000", fullName: "test-guard" } });
  const combo = await tx.combo.create({ data: { id: uuidv7(), slug: `zz-guard-${run}`, name: "test-guard", confirmation: "manual" } });
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
      leadName: "test-guard",
      leadPhone: "+910000000000",
    },
  });
  const item = await tx.orderItem.create({
    data: {
      id: uuidv7(),
      orderId: order.id,
      comboId: combo.id,
      titleSnapshot: "test-guard",
      tierSnapshot: "C",
      slugSnapshot: `zz-guard-${run}`,
      kindSnapshot: "combo",
      confirmationSnapshot: "manual",
      fulfilmentModeSnapshot: "inquiry",
      freeCancellationHoursSnapshot: 24,
      durationMinutesSnapshot: 60,
      serviceDate: new Date("2030-01-15"),
      pax: { adult: 1, child: 0, infant: 0 },
      unitInr: 1000n,
      unitAed: 45n,
      totalInr: 1000n,
      totalAed: 45n,
    },
  });
  return { supplierId, orderId: order.id, orderItemId: item.id };
}

/** Minimal supplier_bookings row for the order item, in the given state. Synthetic amounts. */
function insertBooking(tx: Tx, ids: { supplierId: string; orderId: string; orderItemId: string }, state: string, attempt: number) {
  const id = uuidv7();
  return tx.$executeRaw`
    INSERT INTO supplier_bookings
      (id, order_id, order_item_id, supplier_id, environment, attempt, idempotency_key, client_ref, booking_kind,
       state, tour_external_id, offer_external_id, service_date, adults, guest_name, expected_net_minor, expected_net_usd_minor)
    VALUES
      (${id}::uuid, ${ids.orderId}::uuid, ${ids.orderItemId}::uuid, ${ids.supplierId}::uuid, 'test', ${attempt},
       ${`order:${ids.orderId}:item:${ids.orderItemId}:try:${attempt}`}, ${`ZZG${id.slice(-12)}`}, 'live_book',
       CAST(${state} AS supplier_booking_state), 'tour-test', 'offer-test', DATE '2030-01-15', 1, 'test-guard', 100, 1)`;
}

describe.skipIf(!dbEnabled)("duplicate guard: B1a blocking states (disposable database)", () => {
  let prisma: Prisma;

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../lib/db"));
    await assertDisposableDbLive(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("sb_one_live_per_order_item is the only unique index on order_item_id", async () => {
    const rows = await prisma.$queryRaw<Array<{ name: string }>>`
      SELECT i.relname::text AS name
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (x.indkey)
      WHERE n.nspname = 'public' AND t.relname = 'supplier_bookings' AND x.indisunique AND a.attname = 'order_item_id'`;
    expect(rows.map((r) => r.name)).toEqual(["sb_one_live_per_order_item"]);
  });

  it("the new states are not guard-releasing", () => {
    for (const s of B1A_BLOCKING_STATES) expect(GUARD_RELEASING_STATES as readonly string[]).not.toContain(s);
  });

  it.each(B1A_BLOCKING_STATES)("a second attempt is refused while the first is %s", async (state) => {
    await rolledBack(prisma, async (tx) => {
      const ids = await orderItemFixture(tx, runId());
      expect(await insertBooking(tx, ids, state, 1)).toBe(1);
      await expect(insertBooking(tx, ids, "queued", 2)).rejects.toThrow(GUARD_VIOLATION);
    });
  });

  it("a second attempt is allowed once the first is in a releasing state (control)", async () => {
    await rolledBack(prisma, async (tx) => {
      const ids = await orderItemFixture(tx, runId());
      expect(await insertBooking(tx, ids, "rejected", 1)).toBe(1);
      expect(await insertBooking(tx, ids, "queued", 2)).toBe(1);
    });
  });
});
