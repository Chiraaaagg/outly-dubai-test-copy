import type { NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin, clientIp, handle, json, parseJson } from "@/server/lib/http";
import { hashIp } from "@/server/lib/crypto";
import { enforceRateLimit } from "@/server/lib/rate-limit";
import { orderAccessService } from "@/server/services/order-access.service";
import { cancellationService } from "@/server/services/cancellation.service";
import { TICKET_HEADERS } from "@/app/api/tickets/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ reference: string }> };

/** PROVISIONAL budgets (requests are idempotent per item; these only bound abuse). */
const PER_IP = { limit: 20, windowSeconds: 900 };
const PER_ORDER = { limit: 10, windowSeconds: 900 };

const bodySchema = z.strictObject({ orderItemId: z.string().uuid(), kind: z.enum(["cancel", "exception"]) });

function notFound() {
  return json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404, headers: { ...TICKET_HEADERS } });
}

/**
 * POST /api/orders/:reference/cancellation — `{ orderItemId, kind: "cancel" | "exception" }`
 * → 202 `{ status }`, 409 `{ error: { code: "NOT_ELIGIBLE", reason } }`, or the uniform 404
 * (doc 22 §23 B5, F15, F51; cancellation.service.ts).
 *
 * Same-origin JSON only. The caller must be allowed to see the order
 * (order-access.service.ts: the owning customer, the guest session that
 * created the quote, or a live `download_tickets` grant for it; a
 * `view_status` grant only views, R-B5-7); anyone else, an unknown
 * reference and an item of another order get the same 404. Rate-limited per
 * IP and per order in Postgres, failing closed. Idempotent per order item:
 * a repeat returns the open request. Eligibility comes from the stored
 * verified policy only; a supported cancel is an engine cancel (status-4
 * verified) followed by a refund, and an exception request only asks our
 * team.
 */
export const POST = handle<Ctx>(async (req: NextRequest, ctx) => {
  assertSameOrigin(req);
  await enforceRateLimit({ key: `order_cancel:ip:${hashIp(clientIp(req)) ?? "none"}`, ...PER_IP });
  const body = await parseJson(req, bodySchema, { maxBytes: 1024 });
  const access = await orderAccessService.forRequest(req, (await ctx.params).reference ?? "");
  // A view-only grant shows the order but cannot cancel it (R-B5-7); it looks exactly like no access.
  if (!access || !orderAccessService.mayRequestCancellation(access)) return notFound();
  await enforceRateLimit({ key: `order_cancel:order:${access.orderId}`, ...PER_ORDER });
  const result = await cancellationService.request({ orderId: access.orderId, orderItemId: body.orderItemId, kind: body.kind, via: orderAccessService.requestedVia(access) });
  if (!result.ok && result.reason === "not_found") return notFound();
  if (!result.ok && result.reason === "not_eligible") {
    return json({ error: { code: "NOT_ELIGIBLE", reason: result.ineligible, message: "This booking cannot be cancelled online" } }, { status: 409, headers: { ...TICKET_HEADERS } });
  }
  if (!result.ok) return notFound();
  return json({ status: result.status }, { status: 202, headers: { ...TICKET_HEADERS } });
});
