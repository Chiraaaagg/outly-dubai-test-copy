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
}

const state = {
  dups: [] as DupRow[],
  findManyArgs: [] as { where: Record<string, unknown>; orderBy: unknown; take: number }[],
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
      const by = new Map<string, number>();
      for (const d of state.dups) by.set(d.provider, (by.get(d.provider) ?? 0) + 1);
      return [...by].map(([provider, n]) => ({ provider, _count: { _all: n } }));
    },
    findMany: async (args: { where: { provider: { in: string[] } }; orderBy: unknown; take: number }) => {
      state.findManyArgs.push(args as never);
      return state.dups.filter((d) => args.where.provider.in.includes(d.provider)).slice(0, args.take);
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
const { DUPLICATE_SCAN_PAGE, duplicateScanIncident } = await import("../duplicate-scan");

const SERVED = "fake-aed-card";
const gateways = { forProvider: (p: string) => (p === SERVED ? ({ account: () => ({ provider: SERVED }) } as never) : null), forRail: () => null } as never;

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

const rows = (provider: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${provider}-${String(i).padStart(4, "0")}`, provider }));

let lines: { level: string; msg: string; [k: string]: unknown }[] = [];

beforeEach(() => {
  state.dups = [];
  state.findManyArgs = [];
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
    expect(state.findManyArgs[0]!.where.provider).toEqual({ in: [SERVED] });
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

describe("duplicate scan ops alert (review 102c D5)", () => {
  const now = new Date("2030-01-10T08:00:00Z");
  const page = (newest: Date, n = DUPLICATE_SCAN_PAGE) => Array.from({ length: n }, (_, i) => ({ createdAt: i === n - 1 ? newest : new Date("2029-06-01T00:00:00Z") }));

  it("no incident unless the page is full", () => {
    expect(duplicateScanIncident(page(new Date("2030-01-10T07:00:00Z"), DUPLICATE_SCAN_PAGE - 1), now)).toBeNull();
    expect(duplicateScanIncident([], now)).toBeNull();
  });

  it("a page that filled today is raised when its newest row arrived", () => {
    const i = duplicateScanIncident(page(new Date("2030-01-10T07:00:00Z")), now)!;
    expect(i).toMatchObject({ kind: "duplicate_scan_full", entityKind: "payment_saga", entityId: "duplicate_scan", reason: "duplicate_scan_full", orderId: null, orderReference: null });
    expect(i.raisedAt.toISOString()).toBe("2030-01-10T07:00:00.000Z");
  });

  it("an old backlog is raised again at the start of each UTC day, never in the future", () => {
    expect(duplicateScanIncident(page(new Date("2030-01-02T07:00:00Z")), now)!.raisedAt.toISOString()).toBe("2030-01-10T00:00:00.000Z");
    expect(duplicateScanIncident(page(new Date("2030-01-10T09:00:00Z")), now)!.raisedAt.toISOString()).toBe(now.toISOString());
  });
});
