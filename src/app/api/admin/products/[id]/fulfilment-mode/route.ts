import type { NextRequest } from "next/server";
import { z } from "zod";
import { catalogService } from "@/server/services/catalog.service";
import { assertSameOrigin, handle, json, parseJson, parseWith } from "@/server/lib/http";
import { requireAdmin } from "@/server/lib/guards";
import { requirePermission } from "@/server/lib/actor";
import { fulfilmentModeSchema, productIdSchema } from "@/server/schemas/admin.schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The flip body plus the step-up code that activating instant needs (PRD-12). */
const bodySchema = fulfilmentModeSchema.extend({
  totpCode: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app").optional(),
});

/**
 * POST /api/admin/products/:id/fulfilment-mode — THE HINGE (§17 §6.4).
 * Body `{ kind: "product" | "combo", mode, reason, totpCode? }`.
 *
 *  - `mode: "inquiry"` needs `products.publish` and applies at once.
 *  - `mode: "instant"` needs `products.activate_instant` and `totpCode`. In
 *    production the first request answers 202 `{ status: "pending" }` and
 *    nothing changes until a different administrator sends the same
 *    activation with their own code. Instant also requires an active API
 *    supplier mapping and the release switch; the service refuses otherwise.
 */
export const POST = handle<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }) => {
  assertSameOrigin(req);
  // Signed in first, so an anonymous caller learns nothing from validation.
  const { actor } = await requireAdmin(req);
  const id = parseWith(productIdSchema, (await params).id);
  const body = await parseJson(req, bodySchema);
  requirePermission(actor, body.mode === "instant" ? "products.activate_instant" : "products.publish");
  const result = await catalogService.setFulfilmentMode(actor, { kind: body.kind, id }, body.mode, body.reason, { totpCode: body.totpCode });
  return json(
    { id: result.id, kind: body.kind, fulfilmentMode: result.fulfilmentMode, status: result.status, approvalId: result.approvalId },
    { status: result.status === "pending" ? 202 : 200 },
  );
});
