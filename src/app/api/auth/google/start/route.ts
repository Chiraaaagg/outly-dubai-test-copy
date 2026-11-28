import { NextResponse, type NextRequest } from "next/server";
import { customerIdentityService, reasonOf } from "@/server/services/customer-identity.service";
import { handle } from "@/server/lib/http";
import { setOAuthCookie } from "@/server/lib/oauth-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/google/start?next=/path — sets the signed round-trip cookie
 * and redirects to Google (owner Q-B1: our own callback, so Google names
 * this site). A top-level navigation from the "Continue with Google" link;
 * it changes no state but the short cookie. `next` is sanitised and kept in
 * the cookie, never sent to Google.
 */
export const GET = handle(async (req: NextRequest) => {
  try {
    const { url, cookie } = customerIdentityService.googleStart({ next: req.nextUrl.searchParams.get("next") });
    const res = NextResponse.redirect(url, 303);
    res.headers.set("cache-control", "no-store");
    res.headers.set("referrer-policy", "no-referrer");
    setOAuthCookie(res, cookie);
    return res;
  } catch (err) {
    if (reasonOf(err) === "NOT_CONFIGURED") return NextResponse.redirect(new URL("/login?e=not_configured", req.url), 303);
    throw err;
  }
});
