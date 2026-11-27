import type { NextRequest } from "next/server";
import { assertSameOrigin, clientIp, handle, json, userAgent } from "@/server/lib/http";
import { hashIp } from "@/server/lib/crypto";
import { customerActor } from "@/server/lib/actor";
import { enforceRateLimit } from "@/server/lib/rate-limit";
import { orderAccessService } from "@/server/services/order-access.service";
import { notificationService } from "@/server/services/notification.service";
import { TICKET_HEADERS } from "@/app/api/tickets/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ reference: string }> };

/**
 * PROVISIONAL per-IP budget (owner decision of 27 Nov 2026 asks for one; the
 * number is ours): a household asking for a few orders' tickets fits, a
 * script sending many orders' tickets from one address does not.
 *
 * Fix round 1 (L4): charged only after the access check passes, so a caller
 * without access (who gets the uniform 404 and sends nothing) cannot use up
 * a real customer's budget. When the deployment has no trusted client IP
 * (`clientIp` is undefined: not on Vercel and `TRUST_PROXY_IP_HEADERS` not
 * set), the budget is kept per order instead of one shared "no IP" bucket
 * for the whole site.
 */
const PER_IP = { limit: 10, windowSeconds: 3600 };

/**
 * Fix round 2 (N1): a generous per-IP budget charged before the access check,
 * in the status route's style (same helper, a `none` bucket without a trusted
 * IP), so walking references through this route is bounded as well and each
 * refused request costs one counter write instead of the session, order and
 * grant lookups. A browser never presses the button this often.
 */
const PRE_ACCESS_PER_IP = { limit: 60, windowSeconds: 60 };

function notFound() {
  return json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404, headers: { ...TICKET_HEADERS } });
}

/**
 * POST /api/orders/:reference/tickets/resend — same-origin, no body
 * (post-payment batch A4; contract `ORDER_TICKETS_RESEND_PATH` in
 * src/lib/customer-status.ts).
 *
 * The caller needs the same access as downloading (`canDownload`: the owning
 * customer, or a live `download_tickets` grant for this order, including the
 * checkout grant); anyone else, an unknown reference and a malformed one get
 * the uniform 404. Sends the ticket email again, for every item with a valid
 * file, to the email already on the order only (the request carries no
 * address and none is read). The grant this browser used is never replaced
 * by the new links (fix round 1, M1). Limits fail closed: a generous per-IP
 * budget before the access check (fix round 2, N1; 429 like the status
 * route), the main per-IP budget here (Postgres, after the access check; per
 * order without a trusted IP), and
 * per order in the service (3 in any 24 hours, one per 2 minutes, in the
 * order's row lock). Audited as `tickets.customer_resend` with ids and counts.
 *
 *   202 `{ ok: true, resendAvailableAt }` whatever each send's outcome (the
 *       status page reports delivery from the rows);
 *   429 `{ error: { code: "RATE_LIMITED", resendAvailableAt } }` + Retry-After;
 *   409 `{ error: { code: "NOTHING_TO_SEND" } }` (no valid file, or no email);
 *   404 for anyone without download access.
 */
export const POST = handle<Ctx>(async (req: NextRequest, ctx) => {
  assertSameOrigin(req);
  const ipHash = hashIp(clientIp(req));
  await enforceRateLimit({ key: `tickets_resend_pre:ip:${ipHash ?? "none"}`, ...PRE_ACCESS_PER_IP });
  const access = await orderAccessService.forRequest(req, (await ctx.params).reference ?? "");
  if (!access || !access.canDownload) return notFound();
  await enforceRateLimit({ key: ipHash ? `tickets_resend:ip:${ipHash}` : `tickets_resend:order:${access.orderId}`, ...PER_IP });

  const result = await notificationService.resendTicketsForCustomer({
    orderId: access.orderId,
    actor: customerActor({ ipHash, userAgent: userAgent(req) }),
    // Fix round 1 (M1): the link this browser is using stays live; only the item's other older links are replaced.
    keepGrantId: access.via === "grant" ? access.grantId : null,
  });
  if (result.ok) return json({ ok: true, resendAvailableAt: result.availableAt.toISOString() }, { status: 202, headers: { ...TICKET_HEADERS } });
  if (result.reason === "rate_limited") {
    const retryAfter = Math.max(1, Math.ceil((result.availableAt.getTime() - Date.now()) / 1000));
    return json(
      { error: { code: "RATE_LIMITED", message: "Please wait before asking again", resendAvailableAt: result.availableAt.toISOString() } },
      { status: 429, headers: { ...TICKET_HEADERS, "retry-after": String(retryAfter) } },
    );
  }
  return json({ error: { code: "NOTHING_TO_SEND", message: "There are no tickets to send for this booking yet" } }, { status: 409, headers: { ...TICKET_HEADERS } });
});
