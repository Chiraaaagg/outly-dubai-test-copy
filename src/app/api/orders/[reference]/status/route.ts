import type { NextRequest } from "next/server";
import { clientIp, handle, json } from "@/server/lib/http";
import { hashIp } from "@/server/lib/crypto";
import { enforceRateLimit } from "@/server/lib/rate-limit";
import { loadCustomerOrderStatusForRequest } from "@/server/services/order-status.service";
import { TICKET_HEADERS } from "@/app/api/tickets/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ reference: string }> };

/** PROVISIONAL per-IP budget: a status page polls every 5 to 60 seconds; this leaves room for a few tabs. */
const STATUS_PER_IP = { limit: 120, windowSeconds: 60 };

/**
 * GET /api/orders/:reference/status — the customer status projection
 * (`CustomerOrderStatus`, src/lib/customer-status.ts; doc 22 §23 B5).
 *
 * Access is decided on every request (order-access.service.ts): the owning
 * customer session, the guest session that created the order's quote, or a
 * live ticket-access grant for this order. Anyone else, an unknown reference
 * and a malformed one get the same 404. Rate-limited per IP in Postgres,
 * failing closed. `private, no-store`, `no-referrer`, `nosniff`. No analytics
 * event is emitted here.
 */
export const GET = handle<Ctx>(async (req: NextRequest, ctx) => {
  await enforceRateLimit({ key: `order_status:ip:${hashIp(clientIp(req)) ?? "none"}`, ...STATUS_PER_IP });
  const reference = (await ctx.params).reference ?? "";
  const status = await loadCustomerOrderStatusForRequest(req, reference);
  if (!status) return json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404, headers: { ...TICKET_HEADERS } });
  return json(status, { headers: { ...TICKET_HEADERS } });
});
