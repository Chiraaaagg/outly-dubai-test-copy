/**
 * Browser duration marks (doc 29 §6.6, Batch 1c): "perceived time" for a
 * step, sent as a coarse bucket on an existing analytics event, never as a
 * raw number and never as an event of its own.
 *
 *   const done = startMark("quote");
 *   … await the quote …
 *   track("checkout_started", { duration_bucket: done() ?? undefined });
 *
 * `track` (src/lib/analytics.ts) already applies the measurement-consent gate
 * and skips private customer pages, so a bucket goes nowhere a visit would
 * not. The mark also appears in the browser's performance timeline
 * (`performance.measure("outlyy:<name>")`) for local inspection. No new
 * dependency; safe on the server (returns null) and in old browsers.
 */

/** Upper bounds of the buckets, in milliseconds, matched to the budgets in doc 29 §6.6. */
const BUCKETS: readonly [number, string][] = [
  [100, "lt_100ms"],
  [300, "lt_300ms"],
  [1_000, "lt_1s"],
  [2_500, "lt_2_5s"],
  [5_000, "lt_5s"],
  [8_000, "lt_8s"],
  [15_000, "lt_15s"],
];

export type DurationBucket = "lt_100ms" | "lt_300ms" | "lt_1s" | "lt_2_5s" | "lt_5s" | "lt_8s" | "lt_15s" | "ge_15s";

/** The bucket for a duration; null for a value that is not a finite, non-negative number. */
export function durationBucket(ms: number): DurationBucket | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  for (const [limit, name] of BUCKETS) if (ms < limit) return name as DurationBucket;
  return "ge_15s";
}

/** Fixed step names only, so nothing typed or chosen by a visitor reaches the timeline or the event. */
export type MarkName = "times_for_date" | "hotel_list" | "quote" | "code_send" | "payment_session" | "status_first";

/**
 * Starts a mark; the returned function ends it and returns its bucket (null
 * when the clock is unavailable). Ending twice returns the first bucket.
 */
export function startMark(name: MarkName, clock: () => number = defaultClock): () => DurationBucket | null {
  const started = clock();
  let bucket: DurationBucket | null | undefined;
  return () => {
    if (bucket !== undefined) return bucket;
    const ended = clock();
    bucket = Number.isFinite(started) && Number.isFinite(ended) ? durationBucket(ended - started) : null;
    try {
      if (typeof performance !== "undefined" && typeof performance.measure === "function" && Number.isFinite(started)) {
        performance.measure(`outlyy:${name}`, { start: started, end: ended });
      }
    } catch {
      // A browser without the options form of measure: the bucket is still returned.
    }
    return bucket;
  };
}

function defaultClock(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Number.NaN;
}
