import { unstable_cache } from "next/cache";
import { handle, json } from "@/server/lib/http";
import { CATALOG_TAG } from "@/server/lib/catalog-cache";
import { RATE, publicRateLimit } from "@/server/lib/guards";
import { catalogService } from "@/server/services/catalog.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/catalog/fulfilment-modes — public, cached 60s at the edge.
 *
 * `{ modes: { [slug]: "inquiry" | "instant" }, generatedAt }` for every
 * PUBLISHED product and combo (PRD-25), products at their effective
 * eligibility (PRD-11). A slug that is missing is no longer sold (PRD-26).
 * The cart refreshes its items from this on load and tells the visitor when
 * one changed.
 *
 * The cached value is invalidated with the catalogue tag on every readiness
 * change (PRD-19); the edge may serve the previous answer for up to about a
 * minute. That is acceptable only because the quote re-checks every line on
 * the server (PRD-1): a stale "instant" here can never take a payment.
 */
const cachedModes = unstable_cache(() => catalogService.fulfilmentModes(), ["fulfilment-modes-v1"], { tags: [CATALOG_TAG], revalidate: 60 });

export const GET = handle(async (req) => {
  await publicRateLimit(req, "catalog", RATE.publicRead);
  const modes = await cachedModes();
  return json(
    { modes, generatedAt: new Date().toISOString() },
    { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=30" } },
  );
});
