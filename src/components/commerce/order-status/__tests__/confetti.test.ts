import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The celebration (owner decision c; post-payment A5 fix round 2, review 99b
 * and the owner decision of 27 Nov 2026, "celebrate only on fresh
 * confirmation"). Whether a load celebrates is the page's call
 * (`celebratesOnThisLoad`, tested in entrance.test.ts); here: one burst per
 * order per load, kept in memory only (no browser storage), never with
 * prefers-reduced-motion, recorded only when it starts (StrictMode), started
 * only while the tab is visible, and the pieces' own motion. Stubbed window.
 */

function fakeWindow(reduced: boolean) {
  const noStorage = () => {
    throw new Error("the celebration must not touch browser storage");
  };
  return {
    matchMedia: (q: string) => ({ matches: reduced && q.includes("reduce") }),
    get sessionStorage() {
      return noStorage();
    },
    get localStorage() {
      return noStorage();
    },
  };
}

/** A fresh module (a page load); `play(ref)` is what the page does when the first celebrating card comes into view. */
async function load() {
  vi.resetModules();
  const mod = await import("../ticket-confirmation-card");
  const play = (reference: string) => {
    if (!mod.celebrationAllowed(reference)) return false;
    mod.markCelebrated(reference);
    return true;
  };
  return Object.assign(play, mod);
}

const A = "OUT-00000001";
const B = "OUT-00000002";

describe("celebration once per order per load", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("plays once per order within a load, kept in memory without browser storage", async () => {
    vi.stubGlobal("window", fakeWindow(false));
    const play = await load();
    expect(play(A)).toBe(true);
    expect(play(A)).toBe(false);
    // Any storage access would have thrown (fakeWindow).
  });

  it("a second booking in the same load celebrates too (the key is the order)", async () => {
    vi.stubGlobal("window", fakeWindow(false));
    const play = await load();
    expect(play(A)).toBe(true);
    expect(play(B)).toBe(true);
    expect(play(B)).toBe(false);
  });

  it("never plays with prefers-reduced-motion", async () => {
    vi.stubGlobal("window", fakeWindow(true));
    const play = await load();
    expect(play(A)).toBe(false);
  });

  it("never on the server", async () => {
    vi.stubGlobal("window", undefined);
    const play = await load();
    expect(play(A)).toBe(false);
  });

  it("StrictMode's double run: a check that did not start does not use up the order", async () => {
    vi.stubGlobal("window", fakeWindow(false));
    const play = await load();
    expect(play.celebrationAllowed(A)).toBe(true);
    expect(play.celebrationAllowed(A)).toBe(true);
    play.markCelebrated(A);
    expect(play.celebrationAllowed(A)).toBe(false);
  });
});

describe("the confetti starts only in a visible tab", () => {
  function fakeDocument(state: DocumentVisibilityState) {
    const listeners = new Set<() => void>();
    return {
      visibilityState: state,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      change(next: DocumentVisibilityState) {
        this.visibilityState = next;
        for (const fn of [...listeners]) fn();
      },
      listeners,
    };
  }

  it("visible: starts at once", async () => {
    const { whenVisible } = await import("../ticket-confirmation-card");
    const fn = vi.fn();
    whenVisible(fakeDocument("visible") as unknown as Document, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("hidden (a payment return loading in a background tab): waits for the tab to be shown, then starts once", async () => {
    const { whenVisible } = await import("../ticket-confirmation-card");
    const doc = fakeDocument("hidden");
    const fn = vi.fn();
    whenVisible(doc as unknown as Document, fn);
    expect(fn).not.toHaveBeenCalled();
    doc.change("hidden");
    expect(fn).not.toHaveBeenCalled();
    doc.change("visible");
    expect(fn).toHaveBeenCalledTimes(1);
    doc.change("hidden");
    doc.change("visible");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(doc.listeners.size).toBe(0);
  });

  it("a page that goes away while waiting cancels the wait", async () => {
    const { whenVisible } = await import("../ticket-confirmation-card");
    const doc = fakeDocument("hidden");
    const fn = vi.fn();
    const cancel = whenVisible(doc as unknown as Document, fn);
    cancel();
    doc.change("visible");
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("confetti pieces", () => {
  it("lasts until the slowest piece has landed, plus a frame (no piece cut off mid-fall)", async () => {
    const { confettiLifetimeMs, drawConfetti } = await import("../ticket-confirmation-card");
    const slowest = drawConfetti(3, () => 0.9999999);
    expect(confettiLifetimeMs(slowest)).toBeGreaterThanOrEqual(5_600);
    expect(confettiLifetimeMs(slowest)).toBeLessThanOrEqual(5_700);
    expect(confettiLifetimeMs([{ delay: 0.5, duration: 3 }, { delay: 0.6, duration: 4.8 }])).toBe(5_500);
    expect(confettiLifetimeMs([])).toBe(100);
  });

  it("scales the count with the screen: 40 on a 320-360 px phone, 100 from 1200 px", async () => {
    const { confettiCount, drawConfetti } = await import("../ticket-confirmation-card");
    expect(confettiCount(320)).toBe(40);
    expect(confettiCount(360)).toBe(40);
    expect(confettiCount(768)).toBe(64);
    expect(confettiCount(1200)).toBe(100);
    expect(confettiCount(2560)).toBe(100);
    expect(confettiCount(Number.NaN)).toBe(40);
    expect(confettiCount(0)).toBe(40);
    expect(drawConfetti()).toHaveLength(100);
    expect(drawConfetti(confettiCount(360))).toHaveLength(40);
  });

  it("each piece starts above the top edge within 0.6 s, with its own angle, signed spin and drift", async () => {
    const { drawConfetti } = await import("../ticket-confirmation-card");
    const pieces = drawConfetti(400);
    for (const p of pieces) {
      expect(p.delay).toBeGreaterThanOrEqual(0);
      expect(p.delay).toBeLessThan(0.6);
      expect(p.top).toBeGreaterThanOrEqual(0);
      expect(p.top).toBeLessThan(4);
      expect(Math.abs(p.spin)).toBeGreaterThanOrEqual(360);
      expect(Math.abs(p.spin)).toBeLessThanOrEqual(900);
      expect(Math.abs(p.drift)).toBeLessThanOrEqual(15);
    }
    expect(pieces.some((p) => p.spin < 0)).toBe(true);
    expect(pieces.some((p) => p.spin > 0)).toBe(true);
    expect(new Set(pieces.map((p) => Math.round(p.rotate))).size).toBeGreaterThan(100);
    expect(pieces.some((p) => p.tumble)).toBe(true);
    expect(pieces.some((p) => !p.tumble)).toBe(true);
  });
});

describe("ConfettiBurst markup", () => {
  it("variables on each piece, never on the container; token colours; behind the card; never printed", async () => {
    const { ConfettiBurst } = await import("../ticket-confirmation-card");
    const html = renderToStaticMarkup(h(ConfettiBurst, {}));
    const container = html.match(/^<div[^>]*>/)?.[0] ?? "";
    expect(container).toContain('aria-hidden="true"');
    expect(container).toContain("pointer-events-none");
    expect(container).toContain("z-[5]");
    expect(container).toContain("print:hidden");
    expect(container).not.toContain("--");
    const pieces = html.match(/<div class="absolute w-2 h-4" style="[^"]*"/g) ?? [];
    // The server has no width: the smallest burst.
    expect(pieces).toHaveLength(40);
    for (const piece of pieces) {
      expect(piece).toMatch(/--r0:-?[\d.]+deg/);
      expect(piece).toMatch(/--spin:-?[\d.]+deg/);
      expect(piece).toMatch(/--drift:-?[\d.]+vw/);
      expect(piece).toMatch(/--axis:/);
      expect(piece).toContain("background-color:var(--color-");
      expect(piece).toMatch(/animation:confetti-fall [\d.]+s linear [\d.]+s both/);
      // The keyframe owns the transform; an inline one would be dead once the animation starts.
      expect(piece).not.toContain("transform:");
    }
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  });
});

describe("confetti-fall keyframe (globals.css)", () => {
  const css = readFileSync(new URL("../../../../app/globals.css", import.meta.url), "utf8");
  const keyframe = css.slice(css.indexOf("@keyframes confetti-fall"), css.indexOf("@keyframes ticket-enter"));

  it("animates only transform and opacity", () => {
    const props = [...keyframe.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(props.length).toBeGreaterThan(0);
    expect(new Set(props)).toEqual(new Set(["transform", "opacity"]));
  });

  it("holds full opacity to 75% of the fall, then fades", () => {
    expect(keyframe).toMatch(/75%\s*\{\s*opacity:\s*1;\s*\}/);
    expect(keyframe).toMatch(/100%\s*\{[^}]*opacity:\s*0;/);
  });

  it("reads the piece's own start angle, spin, drift and axis", () => {
    for (const v of ["--r0", "--spin", "--drift", "--axis"]) expect(keyframe).toContain(`var(${v}`);
  });
});
