import { NextResponse, type NextRequest } from "next/server";
import { customerIdentityService } from "@/server/services/customer-identity.service";
import { guestSessionService } from "@/server/services/guest-session.service";
import { clientIp, handle, userAgent } from "@/server/lib/http";
import { setCustomerCookies, ticketAccessFromRequest } from "@/server/lib/customer-session";
import { clearOAuthCookie, decodeOAuthCookie, oauthCookieFromRequest } from "@/server/lib/oauth-cookie";
import { pilotActive } from "@/server/auth/pilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/google/callback?code&state (or ?error) — Google's redirect
 * back to us. The round-trip cookie is read and cleared on every outcome.
 * Success: OUTLYY session cookies and a 303 to the stored `next`. Anything
 * else: a 303 to `/login?e=<short code>`; the provider's text never reaches
 * the page, details stay in the log as codes. The code and the URL are never
 * logged and the page is never cached or referred on.
 */
export const GET = handle(async (req: NextRequest) => {
  const q = req.nextUrl.searchParams;
  const cookie = decodeOAuthCookie(oauthCookieFromRequest(req));
  const guest = await guestSessionService.resolveRequest(req);
  const result = await customerIdentityService.googleCallback({
    query: { code: q.get("code"), state: q.get("state"), error: q.get("error") },
    cookie,
    ip: clientIp(req),
    userAgent: userAgent(req),
    guestSessionId: guest?.guestSessionId ?? null,
    accessCookie: ticketAccessFromRequest(req),
  });
  // Owner-only pilot (review 109 N5): a failed round trip returns to /login with `pilot=1`, so the page still shows
  // the options the owner was using. `pilot=1` is not a secret; the gates are the list checks.
  const target = result.ok ? result.next : `/login?e=${result.notice}${pilotActive() ? "&pilot=1" : ""}`;
  const res = NextResponse.redirect(new URL(target, req.url), 303);
  res.headers.set("cache-control", "no-store");
  res.headers.set("referrer-policy", "no-referrer");
  clearOAuthCookie(res);
  if (result.ok) setCustomerCookies(res, result.outcome.token, result.outcome.expiresAt);
  return res;
});
