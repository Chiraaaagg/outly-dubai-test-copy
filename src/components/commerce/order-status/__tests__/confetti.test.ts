import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Owner decision c: confetti once per page session, never with
 * prefers-reduced-motion (review fix 13). The card checks `confettiAllowed`
 * in its mount effect and records `markConfettiPlayed` only when the confetti
 * starts (follow-up D, StrictMode); here both are called with a stubbed window.
 */

function fakeWindow(reduced: boolean, store: Map<string, string>, storageThrows = false) {
  return {
    matchMedia: (q: string) => ({ matches: reduced && q.includes("reduce") }),
    sessionStorage: {
      getItem: (k: string) => {
        if (storageThrows) throw new Error("blocked");
        return store.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (storageThrows) throw new Error("blocked");
        store.set(k, v);
      },
    },
  };
}

/** A fresh module (a page load); `play()` is what the mount effect and its timer do together. */
async function load() {
  vi.resetModules();
  const { confettiAllowed, markConfettiPlayed } = await import("../ticket-confirmation-card");
  return Object.assign(
    () => {
      if (!confettiAllowed()) return false;
      markConfettiPlayed();
      return true;
    },
    { confettiAllowed, markConfettiPlayed },
  );
}

describe("confetti once per session", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("plays once per session: not again on a re-render or after a reload in the same tab", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", fakeWindow(false, store));
    let play = await load();
    expect(play()).toBe(true);
    expect(play()).toBe(false);
    // A reload: a fresh module, the same session storage.
    play = await load();
    expect(play()).toBe(false);
  });

  it("never plays with prefers-reduced-motion", async () => {
    vi.stubGlobal("window", fakeWindow(true, new Map()));
    const play = await load();
    expect(play()).toBe(false);
  });

  it("with storage blocked, still only once per page load", async () => {
    vi.stubGlobal("window", fakeWindow(false, new Map(), true));
    const play = await load();
    expect(play()).toBe(true);
    expect(play()).toBe(false);
  });

  it("never on the server", async () => {
    vi.stubGlobal("window", undefined);
    const play = await load();
    expect(play()).toBe(false);
  });

  it("StrictMode's double mount: a check whose timer was cancelled does not use up the session", async () => {
    vi.stubGlobal("window", fakeWindow(false, new Map()));
    const play = await load();
    // First effect run: allowed, but its timer is cleared before it fires, so nothing is recorded.
    expect(play.confettiAllowed()).toBe(true);
    // Second effect run: still allowed, and this one starts.
    expect(play.confettiAllowed()).toBe(true);
    play.markConfettiPlayed();
    expect(play.confettiAllowed()).toBe(false);
  });
});
