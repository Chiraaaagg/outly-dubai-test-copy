import type { NextRequest } from "next/server";
import { addDays, dubaiToday } from "@/lib/utils";
import { handle, json, parseQuery } from "@/server/lib/http";
import { publicRateLimit } from "@/server/lib/guards";
import { enforceMemoryRateLimit } from "@/server/lib/rate-limit";
import { START_TIMES_MAX_DAYS_AHEAD, startTimesQuerySchema } from "@/server/schemas/start-times.schemas";
import { startTimesService } from "@/server/services/start-times.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per IP per minute: a visitor stepping through the date strip makes a handful. Provisional ops value. */
const START_TIMES_IP_RATE = { limit: 30, windowSeconds: 60 } as const;
/** All callers on this instance per minute; the browse share of the supplier read budget is the real ceiling. */
const START_TIMES_GLOBAL_RATE = { key: "pub:start-times:global", limit: 600, windowSeconds: 60 } as const;

/** A short shared cache: the answer carries no personal data and the server holds a one-minute copy anyway. */
const CACHE = { "cache-control": "public, max-age=0, s-maxage=30, stale-while-revalidate=30" } as const;

/**
 * GET /api/catalog/start-times?productId=&variantId=&date= — the listed start
 * times of an instant product's offer on one date (doc 29 Batch 2).
 *
 * Public and unauthenticated, rate-limited per IP and per instance, Zod-
 * validated. The answer holds times and availability marks only (no price,
 * no seat count, no supplier id); `source: "stored"` tells the page to keep
 * the start times it already shows. Supplier reads come only from the
 * separate browse share of the read budget and are cached per offer, date
 * and environment for a minute (supplier-quote.service.ts `startTimes`), so
 * this route cannot starve quotes or booking recovery. The quote re-checks
 * the chosen time; nothing here is a promise.
 */
export const GET = handle(async (req: NextRequest) => {
  await publicRateLimit(req, "start-times", START_TIMES_IP_RATE);
  enforceMemoryRateLimit(START_TIMES_GLOBAL_RATE);
  const q = parseQuery(req, startTimesQuerySchema);
  if (q.date > addDays(dubaiToday(), START_TIMES_MAX_DAYS_AHEAD)) return json({ source: "stored", reason: "unavailable" }, { headers: CACHE });
  const answer = await startTimesService.startTimes({ productId: q.productId.toLowerCase(), variantId: q.variantId, serviceDate: q.date });
  return json(answer, { headers: CACHE });
}, { timing: "catalog_start_times" });
