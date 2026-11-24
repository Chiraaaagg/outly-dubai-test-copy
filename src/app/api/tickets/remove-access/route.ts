import type { NextRequest } from "next/server";
import { assertSameOrigin, clientIp, handle, json } from "@/server/lib/http";
import { hashIp } from "@/server/lib/crypto";
import { prisma } from "@/server/lib/db";
import { enforceRateLimit } from "@/server/lib/rate-limit";
import { emitEvent } from "@/server/lib/structured-events";
import { clearGuestCookie, clearTicketAccessCookie, guestTokenFromRequest, ticketAccessFromRequest } from "@/server/lib/customer-session";
import { accessCookieGrants, capabilityService } from "@/server/services/capability.service";
import { guestSessionService } from "@/server/services/guest-session.service";
import { TICKET_EXCHANGE_RATE, TICKET_HEADERS } from "../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tickets/remove-access — "On a shared computer? Remove access on
 * this browser." (checkout redesign batch 3 security review). Same-origin
 * only, per-IP limited (Postgres, failing closed), no body, always
 * `200 { ok: true }` (idempotent):
 *
 *  - every checkout grant named by this browser's access cookie is revoked
 *    (`customer`): it belonged to this browser only, so nobody loses a link;
 *  - the whole access cookie is cleared on this browser; emailed-link and
 *    recovery grants are NOT revoked (the link must keep working from the
 *    email, on any device), only forgotten here;
 *  - the guest checkout session that sent the cookie is revoked and its
 *    cookie cleared, so this browser stops showing the order's status too.
 *
 * A signed-in customer's session is not touched (they sign out instead).
 * Audited as `capability.browser_access_removed` (counts only) plus one
 * `capability.revoked` per grant.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  await enforceRateLimit({ key: `tickets.remove_access:ip:${hashIp(clientIp(req)) ?? "unknown"}`, ...TICKET_EXCHANGE_RATE });
  const now = new Date();
  const cookie = ticketAccessFromRequest(req);
  const entries = accessCookieGrants(cookie, now).length;
  const revoked = await capabilityService.revokeBrowserCheckoutGrants(prisma, cookie, now);
  const guestToken = guestTokenFromRequest(req);
  const guestSession = guestToken ? await guestSessionService.revoke(guestToken, now) : false;
  emitEvent("capability.browser_access_removed", { revoked, entries, guestSession });
  const res = json({ ok: true }, { headers: { ...TICKET_HEADERS } });
  clearTicketAccessCookie(res);
  clearGuestCookie(res);
  return res;
});
