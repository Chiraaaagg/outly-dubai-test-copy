import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * B3 recheck N1 (b3-code-review.md "New findings"): the late-money watch
 * keeps a minimum share of the payments job's time budget, and repeated
 * out-of-time runs raise `payments.tick_starved`. The database is a fake
 * that only knows which saga ids each pass would select; every saga visited
 * costs a fixed amount of the job's clock. The saga's own behaviour runs
 * against Postgres in evidence.test.ts (db project).
 */

interface Pools {
  urgent: string[];
  live: string[];
  watch: string[];
}

const state = {
  pools: { urgent: [], live: [], watch: [] } as Pools,
  checked: [] as string[],
  t: 0,
  costMs: 1_000,
  consecutive: 0,
  healthWrites: 0,
  failHealth: false,
};

function poolOf(where: unknown): keyof Pools {
  const text = JSON.stringify(where);
  if (text.includes('"in":["released","failed"]')) return "watch";
  if (text.includes('"deadlineAt"')) return "urgent";
  return "live";
}

function excluded(where: unknown): Set<string> {
  const w = where as { AND?: [unknown, { id: { notIn: string[] } }] };
  return new Set(w.AND?.[1]?.id?.notIn ?? []);
}

function remaining(where: unknown): string[] {
  const out = excluded(where);
  return state.pools[poolOf(where)].filter((id) => !out.has(id));
}

const fakeDb = {
  paymentSaga: {
    findFirst: async ({ where }: { where: unknown }) => {
      const id = remaining(where)[0];
      return id ? { id } : null;
    },
    findMany: async ({ where, take }: { where: unknown; take: number }) => remaining(where).slice(0, take).map((id) => ({ id })),
    count: async ({ where }: { where: unknown }) => remaining(where).length,
    // `load` and the final state read of `run`: no saga row, so the visit ends at once.
    findUnique: async () => null,
  },
  payment: { findMany: async () => [] },
  // `checked_at` is written once per visited saga, just before it runs: that is where the clock moves.
  $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
    state.checked.push(String(values[1]));
    state.t += state.costMs;
    return 1;
  },
  // The tick health row (job_executions). Values in template order; the tenth is "this run stopped short".
  $queryRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => {
    if (state.failHealth) throw new Error("health row unavailable");
    state.healthWrites += 1;
    state.consecutive = values[9] === true ? state.consecutive + 1 : 0;
    return [{ consecutive: state.consecutive }];
  },
};

vi.mock("../../lib/db", () => ({ prisma: fakeDb, TX_OPTIONS: {} }));

const { createPaymentSaga, starvedAfter, TICK_BUDGET_MS, TICK_STARVED_AFTER, TICK_WATCH_MIN_SHARE } = await import("../saga");

function saga(over: { gateways?: unknown; refunds?: unknown } = {}) {
  return createPaymentSaga({
    gateways: (over.gateways ?? {}) as never,
    engine: {} as never,
    bookings: { current: async () => null },
    now: () => new Date("2030-01-10T08:00:00Z"),
    refunds: (over.refunds ?? { driveOpen: async () => 0 }) as never,
    elapsedMs: () => state.t,
  });
}

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, "0")}`);

let lines: { level: string; msg: string; [k: string]: unknown }[] = [];

beforeEach(() => {
  state.pools = { urgent: [], live: [], watch: [] };
  state.checked = [];
  state.t = 0;
  state.costMs = 1_000;
  state.consecutive = 0;
  state.healthWrites = 0;
  state.failHealth = false;
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

describe("payments tick: late-money watch share (N1)", () => {
  it("keeps the watch's share of the budget when live sagas would fill it", async () => {
    state.pools.live = ids("live", 500);
    state.pools.watch = ids("watch", 5);
    const seen = await saga().advanceOpen();

    const liveSlots = Math.ceil((TICK_BUDGET_MS * (1 - TICK_WATCH_MIN_SHARE)) / state.costMs);
    expect(state.checked.filter((id) => id.startsWith("live"))).toHaveLength(liveSlots);
    // Before N1 the live pass took the whole minute and the watch read nothing.
    expect(state.checked.filter((id) => id.startsWith("watch"))).toEqual(state.pools.watch);
    expect(seen).toBe(liveSlots + 5);
  });

  it("gives the live passes the whole budget when nothing is in the watch", async () => {
    state.pools.live = ids("live", 500);
    expect(await saga().advanceOpen()).toBe(TICK_BUDGET_MS / state.costMs);
  });

  it("urgent sagas still go first, inside the live share", async () => {
    state.pools.urgent = ids("urgent", 3);
    state.pools.live = [...state.pools.urgent, ...ids("live", 500)];
    state.pools.watch = ids("watch", 2);
    await saga().advanceOpen();
    expect(state.checked.slice(0, 3)).toEqual(state.pools.urgent);
    expect(state.checked.slice(-2)).toEqual(state.pools.watch);
  });

  it("a run that finishes its work emits nothing and resets the count", async () => {
    state.pools.live = ids("live", 10);
    state.pools.watch = ids("watch", 10);
    state.consecutive = 2;
    expect(await saga().advanceOpen()).toBe(20);
    expect(state.healthWrites).toBe(1);
    expect(state.consecutive).toBe(0);
    expect(events("payments.tick_out_of_time")).toEqual([]);
    expect(events("payments.tick_starved")).toEqual([]);
  });
});

describe("payments tick: out-of-time alerting (N1)", () => {
  it("reports an out-of-time run through the allowlisted event, with the pass, counts and run streak only", async () => {
    state.pools.live = ids("live", 500);
    state.pools.watch = ids("watch", 5);
    await saga().advanceOpen();
    const [e] = events("payments.tick_out_of_time");
    expect(e).toMatchObject({ level: "warn", pass: "live", visited: 53, skipped: 400 - 48, consecutive: 1 });
    expect(Object.keys(e).sort()).toEqual(["consecutive", "level", "msg", "pass", "skipped", "t", "visited"]);
    // The old free-form warning (with its budgetMs field) is gone.
    expect(lines.some((l) => "budgetMs" in l)).toBe(false);
    expect(events("payments.tick_starved")).toEqual([]);
  });

  it(`raises payments.tick_starved at error level after ${TICK_STARVED_AFTER} out-of-time runs in a row, naming the watch when it was cut`, async () => {
    state.pools.watch = ids("watch", 100);
    const s = saga();
    for (let run = 1; run <= TICK_STARVED_AFTER; run++) {
      state.t = 0;
      state.checked = [];
      await s.advanceOpen({ watchLimit: 100 });
      // Without live work the watch has the whole minute, and 100 sagas at 1 s each do not fit.
      expect(state.checked).toHaveLength(60);
    }
    expect(events("payments.tick_out_of_time").map((e) => e.consecutive)).toEqual([1, 2, 3]);
    const starved = events("payments.tick_starved");
    expect(starved).toHaveLength(1);
    expect(starved[0]).toMatchObject({ level: "error", pass: "watch", consecutive: TICK_STARVED_AFTER });

    // A run that gets through its work ends the streak.
    state.t = 0;
    state.pools.watch = ids("watch", 3);
    await s.advanceOpen();
    expect(state.consecutive).toBe(0);
    expect(events("payments.tick_starved")).toHaveLength(1);
  });

  it("a health row that cannot be written never fails the run; the out-of-time event still goes out, without a streak", async () => {
    state.failHealth = true;
    state.pools.live = ids("live", 100);
    expect(await saga().advanceOpen()).toBe(60);
    expect(events("payments.tick_health_failed")).toHaveLength(1);
    const [e] = events("payments.tick_out_of_time");
    expect(e).toMatchObject({ pass: "live", visited: 60, skipped: 40, consecutive: null });
    expect(events("payments.tick_starved")).toEqual([]);
  });
});

describe("payments tick under the booking tick's cap (checkout redesign batch 4, follow-ups 1 and 4)", () => {
  it("the starvation streak scales with the budget, so the alarm still means about three full budgets in a row", () => {
    expect(starvedAfter(TICK_BUDGET_MS)).toBe(TICK_STARVED_AFTER);
    expect(starvedAfter(45_000)).toBe(4);
    expect(starvedAfter(40_000)).toBe(5);
    expect(starvedAfter(30_000)).toBe(6);
    // A run squeezed to nothing cannot postpone it further; a bigger budget never lowers it below 3.
    expect(starvedAfter(0)).toBe(6);
    expect(starvedAfter(120_000)).toBe(TICK_STARVED_AFTER);
  });

  it("with a 45 s budget the starved alarm fires on the 4th short run in a row, and every short run still reports out of time", async () => {
    state.pools.watch = ids("watch", 100);
    const s = saga();
    for (let run = 1; run <= 4; run++) {
      state.t = 0;
      await s.advanceOpen({ watchLimit: 100, budgetMs: 45_000 });
      expect(events("payments.tick_starved"), `run ${run}`).toHaveLength(run < 4 ? 0 : 1);
    }
    expect(events("payments.tick_out_of_time").map((e) => e.consecutive)).toEqual([1, 2, 3, 4]);
  });

  it("the tail (duplicate settles, refund drives) starts nothing once the cap says stop; without it, both run as before", async () => {
    const driven: Array<{ limit: number; stopped: boolean | undefined }> = [];
    const refunds = { driveOpen: async (limit: number, o: { stop?: () => boolean } = {}) => (driven.push({ limit, stopped: o.stop?.() }), 0) };
    const forProvider = vi.fn(() => null);
    const original = fakeDb.payment.findMany;
    fakeDb.payment.findMany = (async () => [{ id: "dup-1", provider: "p" }, { id: "dup-2", provider: "p" }]) as never;
    try {
      await saga({ refunds, gateways: { forProvider } }).advanceOpen({ stop: () => true });
      expect(forProvider).not.toHaveBeenCalled();
      expect(driven).toEqual([]);
      await saga({ refunds, gateways: { forProvider } }).advanceOpen();
      expect(forProvider).toHaveBeenCalledTimes(2);
      expect(driven).toEqual([{ limit: 50, stopped: undefined }]);
    } finally {
      fakeDb.payment.findMany = original;
    }
  });
});

