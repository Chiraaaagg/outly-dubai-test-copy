import { describe, expect, it } from "vitest";
import { TtlCache } from "../cache";

function setup(opts: { ttlMs?: number; staleIfErrorMs?: number; maxEntries?: number } = {}) {
  const clock = { now: 1_000_000 };
  const cache = new TtlCache<string>({ ttlMs: opts.ttlMs ?? 1_000, staleIfErrorMs: opts.staleIfErrorMs ?? 5_000, maxEntries: opts.maxEntries, now: () => clock.now });
  return { cache, clock };
}

function counter(value = "v") {
  let calls = 0;
  const load = async () => {
    calls += 1;
    return `${value}${calls}`;
  };
  return { load, calls: () => calls };
}

const boom = async (): Promise<string> => {
  throw new Error("boom");
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TtlCache", () => {
  it("serves a fresh hit without loading", async () => {
    const { cache, clock } = setup();
    const c = counter();
    expect(await cache.get("k", c.load)).toEqual({ value: "v1", fetchedAt: 1_000_000, stale: false });
    clock.now += 999;
    expect(await cache.get("k", c.load)).toEqual({ value: "v1", fetchedAt: 1_000_000, stale: false });
    expect(c.calls()).toBe(1);
  });

  it("reloads once the TTL has passed", async () => {
    const { cache, clock } = setup();
    const c = counter();
    await cache.get("k", c.load);
    clock.now += 1_000;
    expect(await cache.get("k", c.load)).toEqual({ value: "v2", fetchedAt: 1_001_000, stale: false });
    expect(c.calls()).toBe(2);
  });

  it("coalesces concurrent gets into one load", async () => {
    const { cache } = setup();
    const d = deferred<string>();
    let calls = 0;
    const load = () => {
      calls += 1;
      return d.promise;
    };
    const a = cache.get("k", load);
    const b = cache.get("k", load);
    d.resolve("shared");
    expect(await Promise.all([a, b])).toEqual([
      { value: "shared", fetchedAt: 1_000_000, stale: false },
      { value: "shared", fetchedAt: 1_000_000, stale: false },
    ]);
    expect(calls).toBe(1);
  });

  it("a fresh caller never joins a browse load (which may answer stale)", async () => {
    const { cache } = setup();
    const browse = deferred<string>();
    const live = deferred<string>();
    let calls = 0;
    const a = cache.get("k", () => {
      calls += 1;
      return browse.promise;
    });
    const fresh = cache.get("k", () => {
      calls += 1;
      return live.promise;
    }, { fresh: true });
    browse.resolve("browse");
    live.resolve("live");
    expect((await a).value).toBe("browse");
    expect((await fresh).value).toBe("live");
    expect(calls).toBe(2);
  });

  it("a load that throws synchronously does not poison the key", async () => {
    const { cache } = setup();
    await expect(
      cache.get("k", () => {
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");
    await expect(cache.get("k", async () => "ok")).resolves.toMatchObject({ value: "ok" });
  });

  it("coalesced callers all see a load failure", async () => {
    const { cache } = setup();
    const d = deferred<string>();
    const a = cache.get("k", () => d.promise);
    const b = cache.get("k", () => d.promise);
    d.reject(new Error("down"));
    await expect(a).rejects.toThrow("down");
    await expect(b).rejects.toThrow("down");
    // The in-flight entry is cleared, so the next call loads again.
    await expect(cache.get("k", async () => "ok")).resolves.toMatchObject({ value: "ok" });
  });

  it("different keys load independently", async () => {
    const { cache } = setup();
    const c = counter();
    await cache.get("a", c.load);
    await cache.get("b", c.load);
    expect(c.calls()).toBe(2);
  });

  it("fresh: true bypasses a fresh hit and stores the new value", async () => {
    const { cache, clock } = setup();
    const c = counter();
    await cache.get("k", c.load);
    clock.now += 10;
    expect(await cache.get("k", c.load, { fresh: true })).toEqual({ value: "v2", fetchedAt: 1_000_010, stale: false });
    expect(await cache.get("k", c.load)).toEqual({ value: "v2", fetchedAt: 1_000_010, stale: false });
    expect(c.calls()).toBe(2);
  });

  it("serves stale data with its original timestamp when a refresh fails within the window", async () => {
    const { cache, clock } = setup();
    await cache.get("k", async () => "old");
    clock.now += 1_000 + 4_999; // TTL + staleIfError − 1
    expect(await cache.get("k", boom)).toEqual({ value: "old", fetchedAt: 1_000_000, stale: true });
    // The stale serve does not refresh the entry.
    expect(await cache.get("k", boom)).toEqual({ value: "old", fetchedAt: 1_000_000, stale: true });
  });

  it("rethrows once the entry is beyond the stale window", async () => {
    const { cache, clock } = setup();
    await cache.get("k", async () => "old");
    clock.now += 1_000 + 5_000;
    await expect(cache.get("k", boom)).rejects.toThrow("boom");
  });

  it("rethrows when there is nothing cached", async () => {
    const { cache } = setup();
    await expect(cache.get("k", boom)).rejects.toThrow("boom");
  });

  it("fresh: true does not serve stale data on error by default", async () => {
    const { cache, clock } = setup();
    await cache.get("k", async () => "old");
    clock.now += 10;
    await expect(cache.get("k", boom, { fresh: true })).rejects.toThrow("boom");
    // … unless the caller opts in.
    expect(await cache.get("k", boom, { fresh: true, allowStale: true })).toEqual({ value: "old", fetchedAt: 1_000_000, stale: true });
  });

  it("allowStale: false refuses stale data on a normal get", async () => {
    const { cache, clock } = setup();
    await cache.get("k", async () => "old");
    clock.now += 2_000;
    await expect(cache.get("k", boom, { allowStale: false })).rejects.toThrow("boom");
  });

  it("evicts the least recently stored entry beyond maxEntries", async () => {
    const { cache } = setup({ maxEntries: 2 });
    const c = counter();
    await cache.get("a", c.load); // a = v1
    await cache.get("b", c.load); // b = v2
    await cache.get("c", c.load); // c = v3 → evicts a
    expect(c.calls()).toBe(3);
    expect((await cache.get("b", c.load)).value).toBe("v2");
    expect((await cache.get("c", c.load)).value).toBe("v3");
    expect(c.calls()).toBe(3);
    expect((await cache.get("a", c.load)).value).toBe("v4"); // reloaded, evicts b
    expect((await cache.get("b", c.load)).value).toBe("v5");
  });

  it("a refreshed key moves to the back of the eviction order", async () => {
    const { cache } = setup({ maxEntries: 2 });
    const c = counter();
    await cache.get("a", c.load); // v1
    await cache.get("b", c.load); // v2
    await cache.get("a", c.load, { fresh: true }); // v3, a now newest
    await cache.get("c", c.load); // v4 → evicts b
    expect((await cache.get("a", c.load)).value).toBe("v3");
    expect((await cache.get("b", c.load)).value).toBe("v5");
  });

  it("invalidate drops the entry, including its stale fallback", async () => {
    const { cache } = setup();
    const c = counter();
    await cache.get("k", c.load);
    cache.invalidate("k");
    expect((await cache.get("k", c.load)).value).toBe("v2");
    cache.invalidate("k");
    await expect(cache.get("k", boom)).rejects.toThrow("boom");
    cache.invalidate("missing"); // no-op
  });
});
