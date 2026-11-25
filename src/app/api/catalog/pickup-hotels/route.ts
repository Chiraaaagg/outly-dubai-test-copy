import type { NextRequest } from "next/server";
import { z } from "zod";
import { handle, json, parseQuery } from "@/server/lib/http";
import { publicRateLimit } from "@/server/lib/guards";
import { uuidSchema } from "@/server/schemas/inquiry.schemas";
import { pickupHotelsService } from "@/server/services/pickup-hotels.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per IP per minute, in memory. A cart has at most a few pickup activities;
 * every list is cached per offer on the server and at the edge, and each
 * supplier read also needs a token from the browse share of the read budget
 * (`takeBrowseReadToken`, suppliers/read-budget.ts; shared with the start-times
 * route), which is the real ceiling across all callers.
 * Provisional ops value.
 */
const PICKUP_HOTELS_RATE = { limit: 30, windowSeconds: 60 } as const;

const querySchema = z
  .object({
    productId: uuidSchema,
    variantId: z.string().trim().min(1).max(60).regex(/^[a-z0-9-]+$/, "Invalid id"),
  })
  .strict();

/**
 * GET /api/catalog/pickup-hotels?productId=<uuid>&variantId=<id> — public
 * (doc 29 §7.3 Batch 3).
 *
 * The hotels the operator collects from for that product variant:
 * `{ ok: true, hotels: [{ id, name, area }], asOf }`, or `{ ok: false,
 * reason }` with `not_offered` (no instant pickup sale for that variant) or
 * `unavailable` (the list could not be read now). Both answers are 200 so the
 * page can offer the inquiry; only a malformed query is an error (422). Only ids,
 * names and areas: no personal data, no price, nothing typed by the visitor
 * (the page filters the list itself). The quote re-checks the chosen hotel
 * against the supplier on its own read, so a cached list can never sell a
 * pickup the operator no longer offers.
 */
export const GET = handle(async (req: NextRequest) => {
  await publicRateLimit(req, "pickup-hotels", PICKUP_HOTELS_RATE);
  const { productId, variantId } = parseQuery(req, querySchema);
  const result = await pickupHotelsService.list(productId, variantId);
  return json(result, {
    headers: {
      // A list is the same for every visitor; a refusal is not kept, so the next try reads again.
      "cache-control": result.ok ? "public, s-maxage=120, stale-while-revalidate=60" : "no-store",
    },
  });
}, { timing: "pickup_hotels" });
