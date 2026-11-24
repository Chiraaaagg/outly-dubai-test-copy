/**
 * Small in-process TTL cache with in-flight coalescing and stale-on-error.
 *
 * For supplier READS only (catalogue, availability). It keeps one slow or
 * failing supplier from slowing the site: concurrent callers for the same key
 * share one request, fresh entries are served without a call, and when a
 * refresh fails a recent stale entry is returned with its original timestamp
 * so the UI can say "as of HH:MM" (port.ts `checkedAt`).
 *
 * Per instance, not shared: a durable snapshot table replaces it for the
 * storefront path (plan §12.2 `supplier_price_snapshots`). Never cache a
 * booking mutation.
 *
 * Pure: the clock is injected.
 */

export interface CachedValue<T> {
  value: T;
  fetchedAt: number;
  stale: boolean;
}

interface Entry<T> {
  value: T;
  fetchedAt: number;
}

export interface TtlCacheOptions {
  ttlMs: number;
  /** How long past expiry an entry may still be served when the refresh fails. */
  staleIfErrorMs: number;
  maxEntries?: number;
  now?: () => number;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<CachedValue<T>>>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(private readonly opts: TtlCacheOptions) {
    this.now = opts.now ?? Date.now;
    this.maxEntries = opts.maxEntries ?? 500;
  }

  /**
   * Fresh hit → cached value. Otherwise load (shared by concurrent callers).
   * `fresh: true` skips the fresh hit (pre-payment re-check) but still
   * coalesces and still falls back to stale data only if `allowStale` is set.
   */
  async get(key: string, load: () => Promise<T>, opts: { fresh?: boolean; allowStale?: boolean } = {}): Promise<CachedValue<T>> {
    const hit = this.entries.get(key);
    const now = this.now();
    if (!opts.fresh && hit && now - hit.fetchedAt < this.opts.ttlMs) return { value: hit.value, fetchedAt: hit.fetchedAt, stale: false };

    // A fresh caller never joins a browse load: that load may legitimately
    // answer with stale data, which a pre-payment re-check must not accept.
    const lane = opts.fresh ? `${key}\u0000fresh` : key;
    const running = this.inflight.get(lane);
    if (running) return running;

    const allowStale = opts.allowStale ?? !opts.fresh;
    const p = (async (): Promise<CachedValue<T>> => {
      try {
        // Defer the call so a synchronous throw still runs `finally` after `inflight.set`.
        const value = await Promise.resolve().then(load);
        const fetchedAt = this.now();
        this.set(key, { value, fetchedAt });
        return { value, fetchedAt, stale: false };
      } catch (e) {
        const old = this.entries.get(key);
        if (allowStale && old && this.now() - old.fetchedAt < this.opts.ttlMs + this.opts.staleIfErrorMs) {
          return { value: old.value, fetchedAt: old.fetchedAt, stale: true };
        }
        throw e;
      } finally {
        this.inflight.delete(lane);
      }
    })();
    this.inflight.set(lane, p);
    return p;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }

  private set(key: string, entry: Entry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
