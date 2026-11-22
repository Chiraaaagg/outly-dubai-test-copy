import { beforeAll, describe, expect, it } from "vitest";
import { assertDisposableDb, dbEnabled } from "@/server/__tests__/helpers/fixtures";
import { withRequestTiming } from "../request-timing";

/**
 * The Prisma query extension (src/server/lib/db.ts) on the disposable
 * database: inside a timed request every model query, raw query and
 * interactive-transaction statement adds to the `db` phase; outside one,
 * queries behave exactly as before. Read-only: nothing is written.
 */

describe.skipIf(!dbEnabled)("request timing: database phase", () => {
  let prisma: typeof import("../db").prisma;

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../db"));
  });

  it("counts model, raw and transaction queries of the request it runs in", async () => {
    const { result, timing } = await withRequestTiming(async () => {
      const n = await prisma.setting.count();
      const [{ one }] = await prisma.$queryRaw<{ one: number }[]>`SELECT 1::int AS one`;
      const inTx = await prisma.$transaction(async (tx) => tx.setting.count());
      return { n, one, inTx };
    });
    expect(result.one).toBe(1);
    expect(result.inTx).toBe(result.n);
    expect(timing.db.count).toBeGreaterThanOrEqual(3);
    expect(timing.db.ms).toBeGreaterThanOrEqual(0);
    expect(timing.supplier.count).toBe(0);
  });

  it("leaves queries outside a timed request unchanged", async () => {
    const [{ one }] = await prisma.$queryRaw<{ one: number }[]>`SELECT 1::int AS one`;
    expect(one).toBe(1);
  });
});
