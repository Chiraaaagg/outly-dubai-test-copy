import { describe, expect, it, vi } from "vitest";

/**
 * The booking tick's cap on its payments step (checkout redesign batch 4,
 * review fix 1): once the deadline passes no inbox row and no saga is
 * started; a row in hand finishes. Without a deadline nothing changes (the
 * payments-tick route). The database is a fake: three due inbox rows that
 * another worker already holds (claims answer 0).
 */

const db = vi.hoisted(() => ({ claims: 0 }));
vi.mock("../../lib/db", () => ({
  prisma: {
    paymentEvent: {
      findMany: async () => [{ id: "e1" }, { id: "e2" }, { id: "e3" }],
      updateMany: async () => {
        db.claims++;
        return { count: 0 };
      },
    },
  },
  TX_OPTIONS: {},
}));

const { createPaymentInbox, runPaymentsTick } = await import("../inbox");
const { TICK_BUDGET_MS } = await import("../saga");

function fakeSaga() {
  const budgets: Array<number | undefined> = [];
  return { budgets, saga: { advanceOpen: vi.fn(async (o: { budgetMs?: number } = {}) => (budgets.push(o.budgetMs), 0)) } as never };
}

describe("payments step cap", () => {
  const inbox = createPaymentInbox({ gateways: { forProvider: () => null } as never, saga: {} as never, now: () => new Date("2030-01-01T00:00:00Z") });

  it("no deadline: every due row is tried and the sagas get their own budget (payments-tick, unchanged)", async () => {
    db.claims = 0;
    const { budgets, saga } = fakeSaga();
    await runPaymentsTick(inbox, saga);
    expect(db.claims).toBe(3);
    expect(budgets).toEqual([undefined]);
  });

  it("a deadline already passed: no row is started and the sagas get a zero budget", async () => {
    db.claims = 0;
    const { budgets, saga } = fakeSaga();
    await runPaymentsTick(inbox, saga, { deadline: 1_000, clock: () => 1_000 });
    expect(db.claims).toBe(0);
    expect(budgets).toEqual([0]);
  });

  it("a deadline reached mid-way stops before the next row; the sagas get what is left, never more than their own budget", async () => {
    db.claims = 0;
    let t = 0;
    const { budgets, saga } = fakeSaga();
    // Each check of the clock moves time on by 10 s; the deadline is 15 s.
    await runPaymentsTick(inbox, saga, { deadline: 15_000, clock: () => (t += 10_000) - 10_000 });
    expect(db.claims).toBe(2);
    expect(budgets[0]).toBeLessThanOrEqual(TICK_BUDGET_MS);
    expect(budgets[0]).toBe(0);
    const roomy = fakeSaga();
    await runPaymentsTick(inbox, roomy.saga, { deadline: 10 * TICK_BUDGET_MS, clock: () => 0 });
    expect(roomy.budgets).toEqual([TICK_BUDGET_MS]);
  });
});
