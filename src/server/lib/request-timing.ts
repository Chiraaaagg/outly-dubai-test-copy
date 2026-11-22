import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request timing (doc 29 §6.6, Batch 1c): how long a customer request
 * spent in total, in supplier calls and in database queries, reported as a
 * `Server-Timing` header and one `route.timing` log line (src/server/lib/http.ts
 * `handle(fn, { timing })`).
 *
 * Durations only. The header names are fixed (`total`, `supplier`, `db`) and
 * carry no description, so nothing about the request, the customer, the
 * order or the supplier reaches the browser beyond three numbers. The route
 * is a fixed code from `TIMING_ROUTES`, never a path (a path can hold an
 * order reference).
 *
 * Pure: no env, no logger, no `server-only`, so the supplier HTTP client
 * (also pure) can report its call durations here. Outside a timed request
 * `recordPhase` does nothing. `supplier` and `db` are sums of call
 * durations: calls that overlap count in full, so either may exceed `total`.
 */

export const TIMING_ROUTES = ["quote", "checkout", "checkout_verify_start", "checkout_verify", "order_status"] as const;
export type TimingRoute = (typeof TIMING_ROUTES)[number];
export type TimingPhase = "supplier" | "db";

interface PhaseTotal {
  ms: number;
  count: number;
}

export interface RequestTiming {
  totalMs: number;
  supplier: PhaseTotal;
  db: PhaseTotal;
}

interface Live {
  supplier: PhaseTotal;
  db: PhaseTotal;
}

const storage = new AsyncLocalStorage<Live>();

/** Adds one call's duration to the current request's phase. A no-op outside a timed request or for a bad value. */
export function recordPhase(phase: TimingPhase, ms: number): void {
  const live = storage.getStore();
  if (!live || typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return;
  live[phase].ms += ms;
  live[phase].count += 1;
}

/** Runs `fn` with a fresh timing context and returns its result with the request's timing. */
export async function withRequestTiming<T>(fn: () => Promise<T>, clock: () => number = () => performance.now()): Promise<{ result: T; timing: RequestTiming }> {
  const live: Live = { supplier: { ms: 0, count: 0 }, db: { ms: 0, count: 0 } };
  const started = clock();
  const result = await storage.run(live, fn);
  return { result, timing: { totalMs: Math.max(0, clock() - started), supplier: { ...live.supplier }, db: { ...live.db } } };
}

const round1 = (ms: number) => Math.round(ms * 10) / 10;

/**
 * The `Server-Timing` value: `supplier;dur=…, db;dur=…, total;dur=…`
 * (W3C Server Timing). A phase with no calls is left out.
 */
export function serverTimingHeader(t: RequestTiming): string {
  const parts: string[] = [];
  if (t.supplier.count) parts.push(`supplier;dur=${round1(t.supplier.ms)}`);
  if (t.db.count) parts.push(`db;dur=${round1(t.db.ms)}`);
  parts.push(`total;dur=${round1(t.totalMs)}`);
  return parts.join(", ");
}

/** The `route.timing` log fields: whole milliseconds and counts. */
export function timingFields(route: TimingRoute, status: number, t: RequestTiming): Record<string, number | string> {
  return {
    route,
    status,
    totalMs: Math.round(t.totalMs),
    supplierMs: Math.round(t.supplier.ms),
    supplierCalls: t.supplier.count,
    dbMs: Math.round(t.db.ms),
    dbQueries: t.db.count,
  };
}
