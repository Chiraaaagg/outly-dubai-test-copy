import type { NextRequest } from "next/server";
import { customerIdentityService } from "@/server/services/customer-identity.service";
import { guestSessionService } from "@/server/services/guest-session.service";
import { assertSameOrigin, clientIp, handle, json, parseJson, userAgent } from "@/server/lib/http";
import { setCustomerCookies, ticketAccessFromRequest } from "@/server/lib/customer-session";
import { emailVerifySchema } from "@/server/schemas/customer.schemas";
import { clearEmailStartCookie, emailStartCookieFromRequest } from "@/server/lib/email-start-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/email/verify — `{ email, code }` → sets the OUTLYY session
 * cookies → `{ customer, attachedOrders }`. No Supabase token ever reaches
 * the browser. The guest session and the ticket-access cookie are read here,
 * server-side, for the same-browser attach rule (owner Q10 b). Needs the
 * signed start cookie for the same address (review 103 finding 8).
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  const body = await parseJson(req, emailVerifySchema, { maxBytes: 4096 });
  const guest = await guestSessionService.resolveRequest(req);
  const { token, expiresAt, customer, attachedOrders } = await customerIdentityService.verifyEmailCode({
    email: body.email,
    code: body.code,
    startCookie: emailStartCookieFromRequest(req),
    ip: clientIp(req),
    userAgent: userAgent(req),
    guestSessionId: guest?.guestSessionId ?? null,
    accessCookie: ticketAccessFromRequest(req),
  });
  const res = json({ customer, attachedOrders });
  setCustomerCookies(res, token, expiresAt);
  clearEmailStartCookie(res);
  return res;
});
