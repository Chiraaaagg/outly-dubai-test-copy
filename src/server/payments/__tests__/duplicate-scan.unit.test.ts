import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review 102c D5: the payments tick's duplicate-payment scan. The page is
 * read oldest first, a provider with no gateway is left out of it (never
 * read, never marked), and a full page is reported. The database is a fake
 * with no sagas, so only the duplicate step does anything. The terminal
 * cases and the alert run against Postgres in saga.db-suite.ts.
 */

interface DupRow {
  id: string;
  provider: string;
  createdAt: Date;
}

const state = {
  dups: [] as DupRow[],
  groupBys: 0,
  findManyArgs: [] as { where: { AND: [unknown, { OR: unknown[] }] }; orderBy: unknown; take: number }[],
  settled: [] as string[],
};

const fakeDb = {
  paymentSaga: {
    findFirst: async () => null,
    findMany: async () => [],
    count: async () => 0,
    findUnique: async () => null,
  },
  payment: {
    groupBy: async () => {
      state.groupBys += 1;
      const by = new Map<string, DupRow[]>();
      for (const d of state.dups) by.set(d.provider, [...(by.get(d.provider) ?? []), d]);
      return [...by].map(([provider, r]) => ({ provider, environment: "test", providerAccountId: ACCOUNT, _count: { _all: r.length }, _max: { createdAt: new Date(Math.max(...r.map((d) => d.createdAt.getTime()))) } }));
    },
    findMany: async (args: { where: { AND: [unknown, { OR: { provider: string }[] }] }; orderBy: unknown; take: number }) => {
      state.findManyArgs.push(args as never);
      const providers = args.where.AND[1].OR.map((a) => a.provider);
      return state.dups.filter((d) => providers.includes(d.provider)).slice(0, args.take);
    },
    // settleDuplicate's first read: no row, so it stops at once (its own cases run in the db suite).
    findUnique: async ({ where }: { where: { id: string } }) => {
      state.settled.push(where.id);
      return null;
    },
  },
  $executeRaw: async () => 1,
  $queryRaw: async () => [{ consecutive: 0 }],
};

vi.mock("../../lib/db", () => ({ prisma: fakeDb, TX_OPTIONS: {} }));

const { createPaymentSaga } = await import("../saga");
const { DUPLICATE_SCAN_PAGE, duplicateScanIncident, duplicateScanIncidents } = await import("../duplicate-scan");

const SERVED = "fake-aed-card";
const ACCOUNT = "fake-account-1";
const forProvider = (p: string) => (p === SERVED ? { account: () => ({ provider: SERVED, environment: "test", accountId: ACCOUNT }) } : null);
const gateways = { forProvider, forRail: () => null } as never;

function saga() {
  return createPaymentSaga({
    gateways,
    engine: {} as never,
    bookings: { current: async () => null },
    now: () => new Date("2030-01-10T08:00:00Z"),
    refunds: { driveOpen: async () => 0 } as never,
    elapsedMs: () => 0,
  });
}

const rows = (provider: string, n: number, createdAt = new Date("2030-01-10T07:00:00Z")) => Array.from({ length: n }, (_, i) => ({ id: `${provider}-${String(i).padStart(4, "0")}`, provider, createdAt }));

let lines: { level: string; msg: string; [k: string]: unknown }[] = [];

beforeEach(() => {
  state.dups = [];
  state.findManyArgs = [];
  state.groupBys = 0;
  state.settled = [];
  lines = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((line: unknown) => {
      lines.push(JSON.parse(String(line)));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const events = (msg: string) => lines.filter((l) => l.msg === msg);

describe("payments tick: duplicate scan (review 102c D5)", () => {
  it("reads the page oldest first, with a stable tie-break", async () => {
    state.dups = rows(SERVED, 3);
    await saga().advanceOpen();
    expect(state.findManyArgs).toHaveLength(1);
    expect(state.findManyArgs[0]).toMatchObject({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: DUPLICATE_SCAN_PAGE });
    expect(state.settled).toEqual(state.dups.map((d) => d.id));
  });

  it("leaves a provider with no gateway out of the page, unread and unmarked, and reports it", async () => {
    // More rows of the unserved provider than a page: before the fix they filled it on every tick.
    state.dups = [...rows("zz-retired", DUPLICATE_SCAN_PAGE + 10), ...rows(SERVED, 2)];
    await saga().advanceOpen();
    expect(state.findManyArgs[0]!.where.AND[1].OR).toEqual([{ provider: SERVED, environment: "test", providerAccountId: ACCOUNT }]);
    expect(state.settled).toEqual([`${SERVED}-0000`, `${SERVED}-0001`]);
    expect(events("payments.duplicate_no_gateway")).toEqual([expect.objectContaining({ level: "warn", provider: "zz-retired", count: DUPLICATE_SCAN_PAGE + 10 })]);
    expect(events("payments.duplicate_scan_full")).toEqual([]);
  });

  it("with only unserved rows, reads nothing at all", async () => {
    state.dups = rows("zz-retired", 5);
    await saga().advanceOpen();
    expect(state.findManyArgs).toEqual([]);
    expect(state.settled).toEqual([]);
  });

  it("reads nothing once the cap says stop", async () => {
    state.dups = rows(SERVED, 3);
    await saga().advanceOpen({ stop: () => true });
    expect(state.groupBys).toBe(0);
    expect(state.findManyArgs).toEqual([]);
    expect(state.settled).toEqual([]);
  });

  it("reports a full page at error level, and not a page one short of it", async () => {
    state.dups = rows(SERVED, DUPLICATE_SCAN_PAGE - 1);
    await saga().advanceOpen();
    expect(events("payments.duplicate_scan_full")).toEqual([]);

    state.dups = rows(SERVED, DUPLICATE_SCAN_PAGE + 5);
    await saga().advanceOpen();
    expect(events("payments.duplicate_scan_full")).toEqual([expect.objectContaining({ level: "error", page: DUPLICATE_SCAN_PAGE })]);
    expect(state.settled).toHaveLength(DUPLICATE_SCAN_PAGE - 1 + DUPLICATE_SCAN_PAGE);
  });
});

describe("duplicate scan ops alerts (review 102c D5)", () => {
  const now = new Date("2030-01-10T08:00:00Z");
  const since = new Date(now.getTime() - 72 * 3_600_000);

  it("raised when the newest row arrived today, else at the start of the UTC day, never in the future", () => {
    const today = duplicateScanIncident("duplicate_scan_full", new Date("2030-01-10T07:00:00Z"), now);
    expect(today).toMatchObject({ kind: "duplicate_scan_full", entityKind: "payment_saga", entityId: "duplicate_scan", reason: "duplicate_scan_full", orderId: null, orderReference: null, bookingId: null });
    expect(today.raisedAt.toISOString()).toBe("2030-01-10T07:00:00.000Z");
    expect(duplicateScanIncident("duplicate_no_gateway", new Date("2029-06-02T07:00:00Z"), now).raisedAt.toISOString()).toBe("2030-01-10T00:00:00.000Z");
    expect(duplicateScanIncident("duplicate_scan_full", new Date("2030-01-10T09:00:00Z"), now).raisedAt.toISOString()).toBe(now.toISOString());
  });

  it("full: only when the served page is full; unserved rows never count towards it", async () => {
    state.dups = [...rows(SERVED, DUPLICATE_SCAN_PAGE - 1), ...rows("zz-retired", 0)];
    expect(await duplicateScanIncidents(since, now, forProvider)).toEqual([]);
    state.dups = rows(SERVED, DUPLICATE_SCAN_PAGE);
    expect((await duplicateScanIncidents(since, now, forProvider)).map((i) => i.kind)).toEqual(["duplicate_scan_full"]);
  });

  it("a process without the composition root raises nothing (every provider would look unserved) and says so", async () => {
    state.dups = rows("zz-retired", 3);
    expect(await duplicateScanIncidents(since, now)).toEqual([]);
    expect(state.groupBys).toBe(0);
    expect(events("payments.duplicate_scan_unwired")).toHaveLength(1);
  });

  it("no gateway: any held row of an unserved provider is raised, apart from the full page", async () => {
    state.dups = [...rows("zz-retired", DUPLICATE_SCAN_PAGE + 10, new Date("2029-06-01T00:00:00Z")), ...rows(SERVED, 2)];
    const incidents = await duplicateScanIncidents(since, now, forProvider);
    expect(incidents.map((i) => [i.kind, i.reason])).toEqual([["duplicate_no_gateway", "duplicate_no_gateway"]]);
    expect(incidents[0]!.raisedAt.toISOString()).toBe("2030-01-10T00:00:00.000Z");
  });
});
