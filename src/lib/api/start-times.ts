/**
 * Browser fetcher for `GET /api/catalog/start-times` (doc 29 Batch 2).
 *
 * Separate from `./index.ts` so the activity page's widget pulls in no
 * analytics or mock data for it. Same-origin, no cookies needed (the answer
 * is the same for everyone), abortable by the caller. The query carries the
 * product id, the variant id and the date: nothing typed by a visitor.
 */

export type StartTimeMark = "available" | "limited" | "sold_out" | "unavailable";

export type StartTimesAnswer =
  | { source: "supplier"; checkedAt: string; stale: boolean; times: { time: string; status: StartTimeMark }[] }
  | { source: "stored"; reason: "not_listed" | "busy" | "unavailable" };

const MARKS: readonly StartTimeMark[] = ["available", "limited", "sold_out", "unavailable"];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A shape check, so a malformed body never renders as times. Null for anything else. */
export function parseStartTimes(body: unknown): StartTimesAnswer | null {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return null;
  if (b.source === "stored") {
    return b.reason === "not_listed" || b.reason === "busy" || b.reason === "unavailable" ? { source: "stored", reason: b.reason } : null;
  }
  if (b.source !== "supplier" || typeof b.checkedAt !== "string" || Number.isNaN(Date.parse(b.checkedAt)) || !Array.isArray(b.times)) return null;
  const times: { time: string; status: StartTimeMark }[] = [];
  for (const t of b.times as unknown[]) {
    const x = t as { time?: unknown; status?: unknown } | null;
    if (!x || typeof x.time !== "string" || !TIME.test(x.time) || !MARKS.includes(x.status as StartTimeMark)) return null;
    times.push({ time: x.time, status: x.status as StartTimeMark });
  }
  return { source: "supplier", checkedAt: b.checkedAt, stale: b.stale === true, times };
}

export function startTimesPath(q: { productId: string; variantId: string; date: string }): string {
  const p = new URLSearchParams({ productId: q.productId, variantId: q.variantId, date: q.date });
  return `/api/catalog/start-times?${p.toString()}`;
}

/** Throws on a network error, an abort, a non-200 answer or a malformed body; the widget then keeps its stored times. */
export async function fetchStartTimes(q: { productId: string; variantId: string; date: string }, signal: AbortSignal): Promise<StartTimesAnswer> {
  const res = await fetch(startTimesPath(q), { headers: { accept: "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", signal });
  if (!res.ok) throw new Error(`start times: ${res.status}`);
  const parsed = parseStartTimes(await res.json());
  if (!parsed) throw new Error("start times: malformed answer");
  return parsed;
}
