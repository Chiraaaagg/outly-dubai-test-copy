import { describe, expect, it } from "vitest";
import { admitRead, BROWSE_READ_SHARE, DEFAULT_READ_BUDGET_PER_MINUTE, QUOTE_READ_SHARE, READ_BUDGET, type ReadClass, readLimits, type ReadWindow } from "../read-budget";

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
    expect(readLimits()).toEqual({ perMinute: 120, quoteCap: 30, browseCap: 0, engineReserve: 90 });
  });

  it("rounds the quote cap down and clamps the share", () => {
    expect(readLimits(10, 0.25)).toEqual({ perMinute: 10, quoteCap: 2, browseCap: 0, engineReserve: 8 });
    expect(readLimits(1, 0.25)).toEqual({ perMinute: 1, quoteCap: 0, browseCap: 0, engineReserve: 1 });
    expect(readLimits(10, -1)).toEqual({ perMinute: 10, quoteCap: 0, browseCap: 0, engineReserve: 10 });
    expect(readLimits(10, 2)).toEqual({ perMinute: 10, quoteCap: 10, browseCap: 0, engineReserve: 0 });
    expect(readLimits(10, Number.NaN)).toEqual({ perMinute: 10, quoteCap: 0, browseCap: 0, engineReserve: 10 });
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

describe("browse read class (doc 29 §6.3, Batch 2)", () => {
  it("the shared budget gives browse its own small share beside an unchanged quote share", () => {
    expect(BROWSE_READ_SHARE).toBe(0.1);
    expect(READ_BUDGET).toEqual({ perMinute: 120, quoteCap: 30, browseCap: 12, engineReserve: 78 });
    expect(readLimits(10, 0.5, 0.9)).toEqual({ perMinute: 10, quoteCap: 5, browseCap: 5, engineReserve: 0 });
    expect(readLimits(10, 0.25, Number.NaN)).toMatchObject({ browseCap: 0 });
    // Limits without a browse cap (built before this class) refuse browse.
    expect(admitRead(FRESH, "browse", { perMinute: 10, quoteCap: 2, engineReserve: 8 })).toBeNull();
  });

  it("browse stops at its cap and counts in the window total", () => {
    const flood = drain(FRESH, "browse", READ_BUDGET);
    expect(flood.n).toBe(12);
    expect(flood.window).toEqual({ used: 12, quoteUsed: 0, browseUsed: 12 });
  });

  it("a browse flood leaves quote and engine reads unaffected", () => {
    const afterFlood = drain(FRESH, "browse", READ_BUDGET).window;
    const quotes = drain(afterFlood, "quote", READ_BUDGET);
    expect(quotes.n).toBe(30);
    const engine = drain(quotes.window, "engine", READ_BUDGET);
    expect(engine.n).toBe(READ_BUDGET.engineReserve);
    // Without the flood the quotes get exactly as many.
    expect(drain(FRESH, "quote", READ_BUDGET).n).toBe(30);
  });

  it("browse never takes a read the quotes' unused share still needs", () => {
    const limits = readLimits(10, 0.3, 0.3); // 3 quote, 3 browse, 4 engine
    // Engine has used 6: 4 left, 3 of which the quotes may still need, so one browse read at most.
    let w: ReadWindow = { used: 6, quoteUsed: 0 };
    const b = drain(w, "browse", limits);
    expect(b.n).toBe(1);
    w = b.window;
    expect(drain(w, "quote", limits).n).toBe(3);
  });

  // Carried over from Batch 3's separate browse module when the two were unified.
  it("with the default budget a busy engine leaves browse only what the quotes do not still need", () => {
    // The engine has used 85: 35 left, 30 of them owed to quotes.
    const b = drain({ used: 85, quoteUsed: 0 }, "browse", READ_BUDGET);
    expect(b.n).toBe(5);
    expect(drain(b.window, "quote", READ_BUDGET).n).toBe(30);
  });

  it("quotes already spent free nothing for browse beyond its own cap", () => {
    expect(drain({ used: 30, quoteUsed: 30 }, "browse", READ_BUDGET).n).toBe(12);
  });

  it("under any interleaving of all three classes, browse never costs a quote or the engine reserve", () => {
    const limits = readLimits(40, 0.25, 0.15);
    let seed = 11;
    for (let run = 0; run < 300; run++) {
      const ops: ReadClass[] = [];
      for (let i = 0; i < 120; i++) {
        seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
        const pick = seed % 5;
        ops.push(pick === 0 ? "engine" : pick === 1 ? "quote" : "browse"); // a browse-heavy flood
      }
      const play = (sequence: ReadClass[]) => {
        let w = FRESH;
        const admitted = { engine: 0, quote: 0, browse: 0 };
        for (const cls of sequence) {
          const next = admitRead(w, cls, limits);
          if (cls === "engine" && !next) {
            expect(w.used).toBe(limits.perMinute);
            expect(admitted.engine).toBeGreaterThanOrEqual(limits.engineReserve);
          }
          if (next) {
            admitted[cls]++;
            w = next;
          }
          expect(w.quoteUsed).toBeLessThanOrEqual(limits.quoteCap);
          expect(w.browseUsed ?? 0).toBeLessThanOrEqual(limits.browseCap!);
          expect(w.used).toBeLessThanOrEqual(limits.perMinute);
        }
        return admitted;
      };
      const withFlood = play(ops);
      const withoutFlood = play(ops.filter((c) => c !== "browse"));
      // The same quote and engine requests, with and without the flood: quotes get at least as many.
      expect(withFlood.quote).toBeGreaterThanOrEqual(withoutFlood.quote);
    }
  });
});
