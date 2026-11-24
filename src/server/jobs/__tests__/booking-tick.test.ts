import { afterEach, describe, expect, it, vi } from "vitest";
import { Errors } from "@/server/lib/errors";
import { runBookingTick, type BookingTickOptions, type SupplierStepBudget } from "../booking-tick";

/**
 * The ordered booking tick (checkout redesign batch 4, CO-38, review fixes 1
 * and 3): payments first under its cap, then the supplier worker with a loop
 * budget and a mutation window that a slow payments step cannot eat; a step
 * that throws never stops the other and is logged with its error. Pure: both
 * steps are fakes and the clock is scripted.
 */

afterEach(() => vi.restoreAllMocks());

/** The route's numbers: maxDuration 300 s, 30 s spare, payments cap 45 s, the latest mutation ends 15 s before the kill. */
function opts(clock?: () => number): BookingTickOptions {
  return { budgetMs: 270_000, mutationWindowMs: 270_000, killMs: 300_000, paymentsCapMs: 45_000, mutationEndBeforeKillMs: 15_000, mutationStartMarginMs: 30_000, ...(clock ? { clock } : {}) };
}

function clockFrom(times: number[]) {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
}

/** The engine's rule: a mutation starts only with its timeout (150 s) plus 30 s of the mutation window left. */
const MUTATION_START_NEEDS_MS = 180_000;

describe("runBookingTick", () => {
  it("runs the payments step (with its cap) before the supplier step, once each, and gives the supplier what is left", async () => {
    const order: string[] = [];
    const out = await runBookingTick(
      {
        payments: async (capMs) => {
          order.push(`payments:${capMs}`);
          return { processed: 1, failed: 0 };
        },
        supplier: async (budget) => {
          order.push(`supplier:${budget.budgetMs}:${budget.mutationBudgetMs}`);
          return { processed: [] };
        },
      },
      opts(clockFrom([1_000, 4_500])),
    );
    expect(order).toEqual(["payments:45000", "supplier:266500:270000"]);
    expect(out).toMatchObject({ ok: true, payments: { ok: true, processed: 1 }, supplier: { ok: true }, supplierBudget: { budgetMs: 266_500, mutationBudgetMs: 270_000 } });
  });

  it("a slow (not throwing) payments step at its 45 s cap leaves the supplier its whole mutation window, ending 15 s before the kill", async () => {
    const seen: SupplierStepBudget[] = [];
    await runBookingTick({ payments: async () => ({}), supplier: async (b) => (seen.push(b), {}) }, opts(clockFrom([0, 45_000])));
    const [b] = seen;
    // The standalone worker's window: 270 s - 180 s = 90 s in which a mutation may start.
    expect(b.mutationBudgetMs - MUTATION_START_NEEDS_MS).toBe(90_000);
    // 45 s + 90 s + a 150 s mutation = 285 s: 15 s inside maxDuration.
    expect(45_000 + (b.mutationBudgetMs - MUTATION_START_NEEDS_MS) + 150_000).toBe(285_000);
    expect(b.budgetMs).toBe(225_000);
  });

  it("a payments step that overran its cap (a provider call in hand) shortens the window just enough to keep every mutation inside maxDuration", async () => {
    for (const elapsed of [50_000, 80_000, 120_000, 299_000]) {
      const seen: SupplierStepBudget[] = [];
      await runBookingTick({ payments: async () => ({}), supplier: async (b) => (seen.push(b), {}) }, opts(clockFrom([0, elapsed])));
      const window = Math.max(0, seen[0].mutationBudgetMs - MUTATION_START_NEEDS_MS);
      if (window > 0) expect(elapsed + window + 150_000, String(elapsed)).toBeLessThanOrEqual(285_000);
      expect(seen[0].budgetMs).toBe(Math.max(0, 270_000 - elapsed));
    }
  });

  it("an app error is logged with its message (redacted), as the old routes' 5xx log did", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((l: unknown) => void lines.push(String(l)));
    await runBookingTick(
      {
        payments: async () => {
          throw Errors.notConfigured("STRIPE_SECRET_KEY");
        },
        supplier: async () => ({}),
      },
      opts(),
    );
    const line = lines.find((l) => l.includes("jobs.tick_step_failed")) ?? "";
    expect(line).toContain('"errorCode":"NOT_CONFIGURED"');
    expect(line).toContain("STRIPE_SECRET_KEY is not configured");
  });

  it("a payments step that throws still runs the supplier step, logs the redacted error, and answers ok: false with the code only", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((l: unknown) => void lines.push(String(l)));
    const supplier = vi.fn(async (b: SupplierStepBudget) => ({ budgetMs: b.budgetMs }));
    const out = await runBookingTick(
      {
        payments: async () => {
          throw new Error("database gone for +971 50 123 4567");
        },
        supplier,
      },
      opts(clockFrom([0, 2_000])),
    );
    expect(supplier).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: false, payments: { ok: false, error: "internal" }, supplier: { ok: true, budgetMs: 268_000 } });
    expect(JSON.stringify(out)).not.toContain("database gone");
    // Review fix 3: as the old routes' errorResponse, the error itself reaches the log, redacted.
    const line = lines.find((l) => l.includes("jobs.tick_step_failed")) ?? "";
    expect(line).toContain('"step":"payments"');
    expect(line).toContain('"errorCode":"internal"');
    expect(line).toContain("database gone");
    expect(line).not.toContain("123 4567");
  });

  it("a supplier step that throws keeps the payments result; an app error reports its own code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await runBookingTick(
      {
        payments: async () => ({ processed: 2, failed: 0 }),
        supplier: async () => {
          throw Errors.notConfigured("SUPPLIER_JOB_SECRET");
        },
      },
      opts(),
    );
    expect(out.ok).toBe(false);
    expect(out.payments).toMatchObject({ ok: true, processed: 2 });
    expect(out.supplier).toEqual({ ok: false, error: "NOT_CONFIGURED" });
  });
});
