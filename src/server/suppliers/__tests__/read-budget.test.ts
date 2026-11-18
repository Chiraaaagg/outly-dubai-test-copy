import { describe, expect, it } from "vitest";
import { admitRead, DEFAULT_READ_BUDGET_PER_MINUTE, QUOTE_READ_SHARE, type ReadClass, readLimits, type ReadWindow } from "../read-budget";

/**
 * The read-class rule of the per-account read budget (CR-B2-3): quote reads
 * may use only their share of a window, and engine reads keep their reserve
 * whatever quotes have used. `takeReadToken` applies the same rule in SQL;
 * the db suite covers that statement.
 */

const FRESH: ReadWindow = { used: 0, quoteUsed: 0 };

/** Takes reads of `cls` until one is refused; returns how many were admitted and the window. */
function drain(window: ReadWindow, cls: ReadClass, limits: ReturnType<typeof readLimits>, max = 10_000) {
  let w = window;
  let n = 0;
  for (; n < max; n++) {
    const next = admitRead(w, cls, limits);
    if (!next) break;
    w = next;
  }
  return { n, window: w };
}

describe("read budget classes (CR-B2-3)", () => {
  it("the default limits give quotes a quarter and reserve the rest for the engine", () => {
    expect(DEFAULT_READ_BUDGET_PER_MINUTE).toBe(120);
    expect(QUOTE_READ_SHARE).toBe(0.25);
    expect(readLimits()).toEqual({ perMinute: 120, quoteCap: 30, engineReserve: 90 });
  });

  it("rounds the quote cap down and clamps the share", () => {
    expect(readLimits(10, 0.25)).toEqual({ perMinute: 10, quoteCap: 2, engineReserve: 8 });
    expect(readLimits(1, 0.25)).toEqual({ perMinute: 1, quoteCap: 0, engineReserve: 1 });
    expect(readLimits(10, -1)).toEqual({ perMinute: 10, quoteCap: 0, engineReserve: 10 });
    expect(readLimits(10, 2)).toEqual({ perMinute: 10, quoteCap: 10, engineReserve: 0 });
    expect(readLimits(10, Number.NaN)).toEqual({ perMinute: 10, quoteCap: 0, engineReserve: 10 });
  });

  it("quotes stop at their cap; engine reads then still get the whole reserve", () => {
    const limits = readLimits(120, 0.25);
    const quotes = drain(FRESH, "quote", limits);
    expect(quotes.n).toBe(30);
    expect(admitRead(quotes.window, "quote", limits)).toBeNull();
    const engine = drain(quotes.window, "engine", limits);
    expect(engine.n).toBe(90);
    expect(engine.window).toEqual({ used: 120, quoteUsed: 30 });
  });

  it("engine reads may use the whole window when quotes are idle, which then refuses quotes", () => {
    const limits = readLimits(120, 0.25);
    const engine = drain(FRESH, "engine", limits);
    expect(engine.n).toBe(120);
    expect(admitRead(engine.window, "quote", limits)).toBeNull();
  });

  it("an engine read is never refused by quote usage: under any interleaving the engine gets at least its reserve", () => {
    const limits = readLimits(40, 0.3);
    // 200 pseudo-random interleavings of 200 attempts, two quotes to each engine read, from a fixed seed.
    let seed = 7;
    for (let run = 0; run < 200; run++) {
      let w = FRESH;
      let engineAdmitted = 0;
      for (let i = 0; i < 200; i++) {
        seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
        const cls: ReadClass = seed % 3 === 0 ? "engine" : "quote";
        const next = admitRead(w, cls, limits);
        if (cls === "engine" && !next) {
          // Refused only once the window is spent, and only after the engine had its reserve.
          expect(w.used).toBe(limits.perMinute);
          expect(engineAdmitted).toBeGreaterThanOrEqual(limits.engineReserve);
        }
        if (next) {
          if (cls === "engine") engineAdmitted++;
          w = next;
        }
        expect(w.quoteUsed).toBeLessThanOrEqual(limits.quoteCap);
        expect(w.used).toBeLessThanOrEqual(limits.perMinute);
      }
    }
  });

  it("with quotes at their cap, an engine read is admitted while the window has room", () => {
    const limits = readLimits(10, 0.5);
    for (let engineUsed = 0; engineUsed < limits.engineReserve; engineUsed++) {
      const w = { used: limits.quoteCap + engineUsed, quoteUsed: limits.quoteCap };
      expect(admitRead(w, "quote", limits)).toBeNull();
      expect(admitRead(w, "engine", limits)).toEqual({ used: w.used + 1, quoteUsed: limits.quoteCap });
    }
  });
});
