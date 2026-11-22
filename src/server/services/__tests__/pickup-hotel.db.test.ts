import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableDb, dbEnabled, runId, syntheticPhone } from "@/server/__tests__/helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, makeOrder } from "@/server/__tests__/security/_mercury-fixtures";
import { uuidv7 } from "@/server/lib/ids";
import { readLimits } from "@/server/suppliers/read-budget";

/**
 * Hotel pickup, Batch 3 (doc 29 §3.4, §6.3, §7.3), on the disposable database:
 *  - the browse read class (`takeBrowseReadToken`, shared with the
 *    start-times route) in the shared budget row: its own cap, never a
 *    read the quote share still has unused, and engine and quote takers keep
 *    working on a row that carries `browseUsed`;
 *  - the two nullable order item columns: written with the item, null when
 *    not given (as every row written before this batch).
 * Synthetic ids, names and phones only; global fetch is blocked.
 */

const RUN = runId();
const CODE = "traveldesk";

type Prisma = Awaited<ReturnType<typeof db>>;

describe.skipIf(!dbEnabled)("hotel pickup on the database (Batch 3)", () => {
  let prisma: Prisma;
  let engine: typeof import("../supplier-booking.service");

  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    prisma = await db();
    engine = await import("../supplier-booking.service");
  });

  afterAll(async () => {
    await prisma.setting.deleteMany({ where: { key: { startsWith: `supplier_budget.${CODE}.test.browse-${RUN}` } } });
    await cleanupBusinessRows(RUN);
  });

  it("browse reads take only their share and never a read the quote share still needs; quotes and the engine are unaffected", async () => {
    const account = `browse-${RUN}`;
    const key = engine.requestBudgetKey(CODE, "test", account);
    await prisma.setting.deleteMany({ where: { key } });
    // 20 a minute: quotes 5, browse 2, the engine at least 13.
    const limits = readLimits(20, 0.25, 0.1);
    expect(limits).toEqual({ perMinute: 20, quoteCap: 5, browseCap: 2, engineReserve: 13 });
    const take = () => engine.takeBrowseReadToken(CODE, "test", account, { limits });
    const quote = () => engine.takeQuoteReadToken(CODE, "test", account, { limits });
    const read = () => engine.takeReadToken(CODE, "test", account, limits);

    // A browse flood: two pass, the rest are refused.
    expect([await take(), await take(), await take(), await take()]).toEqual([true, true, false, false]);
    expect((await prisma.setting.findUniqueOrThrow({ where: { key } })).value).toMatchObject({ used: 2, quoteUsed: 0, browseUsed: 2 });
    // Every quote read is still there, and the engine keeps its floor.
    for (let i = 0; i < 5; i++) expect(await quote()).toBe(true);
    expect(await quote()).toBe(false);
    for (let i = 0; i < 13; i++) expect(await read()).toBe(true);
    expect(await read()).toBe(false);
    expect((await prisma.setting.findUniqueOrThrow({ where: { key } })).value).toMatchObject({ used: 20, quoteUsed: 5, browseUsed: 2 });

    // A busy engine: browse stops while what is left is owed to quotes.
    await prisma.setting.deleteMany({ where: { key } });
    for (let i = 0; i < 14; i++) expect(await read()).toBe(true);
    expect(await take()).toBe(true); // 15 + 5 owed = 20
    expect(await take()).toBe(false);
    for (let i = 0; i < 5; i++) expect(await quote()).toBe(true);

    // An expired window starts afresh for browse, and an engine reset drops the browse count.
    await prisma.setting.update({ where: { key }, data: { value: { windowStart: new Date(Date.now() - 120_000).toISOString(), used: 20, quoteUsed: 5, browseUsed: 2 } } });
    expect(await take()).toBe(true);
    expect((await prisma.setting.findUniqueOrThrow({ where: { key } })).value).toMatchObject({ used: 1, quoteUsed: 0, browseUsed: 1 });

    // Concurrent browse takers never pass the cap.
    await prisma.setting.deleteMany({ where: { key } });
    const results = await Promise.all(Array.from({ length: 8 }, take));
    expect(results.filter(Boolean)).toHaveLength(2);
    await prisma.setting.deleteMany({ where: { key } });
  });

  it("an order item keeps the accepted pickup hotel id and name; an item without pickup keeps both null", async () => {
    const order = await makeOrder(RUN, { leadPhone: syntheticPhone(RUN, 31), label: "pickup" });
    const base = {
      orderId: order.id,
      titleSnapshot: "zz pickup item",
      tierSnapshot: "C",
      slugSnapshot: `zz-pickup-${RUN}`,
      kindSnapshot: "activity",
      confirmationSnapshot: "manual" as const,
      fulfilmentModeSnapshot: "inquiry" as const,
      freeCancellationHoursSnapshot: 0,
      durationMinutesSnapshot: 60,
      serviceDate: new Date("2030-02-10T00:00:00Z"),
      pax: { adult: 2 },
      unitInr: 0n,
      unitAed: 10_000n,
      totalInr: 0n,
      totalAed: 10_000n,
    };
    const withPickup = await prisma.orderItem.create({ data: { id: uuidv7(), ...base, pickupHotelId: "42", pickupHotelNameSnapshot: "zz Example Marina Hotel" } });
    const without = await prisma.orderItem.create({ data: { id: uuidv7(), ...base } });
    expect(await prisma.orderItem.findUniqueOrThrow({ where: { id: withPickup.id }, select: { pickupHotelId: true, pickupHotelNameSnapshot: true } })).toEqual({
      pickupHotelId: "42",
      pickupHotelNameSnapshot: "zz Example Marina Hotel",
    });
    expect(await prisma.orderItem.findUniqueOrThrow({ where: { id: without.id }, select: { pickupHotelId: true, pickupHotelNameSnapshot: true } })).toEqual({
      pickupHotelId: null,
      pickupHotelNameSnapshot: null,
    });
    // Columns are nullable with no default (migration 20261123150000).
    const cols = await prisma.$queryRaw<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
      SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'order_items' AND column_name IN ('pickup_hotel_id', 'pickup_hotel_name_snapshot') ORDER BY column_name`;
    expect(cols).toEqual([
      { column_name: "pickup_hotel_id", is_nullable: "YES", column_default: null },
      { column_name: "pickup_hotel_name_snapshot", is_nullable: "YES", column_default: null },
    ]);
  });
});
