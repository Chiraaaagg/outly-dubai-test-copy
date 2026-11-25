import type { NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin, handle, json, parseJson } from "@/server/lib/http";
import { publicRateLimit } from "@/server/lib/guards";
import { setTicketAccessCookie, ticketAccessFromRequest } from "@/server/lib/customer-session";
import { addAccessEntry, capabilityService, ticketAccess } from "@/server/services/capability.service";
import { TICKET_EXCHANGE_RATE, TICKET_HEADERS } from "../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({ token: z.string().min(1).max(256) });

/**
 * POST /api/tickets/exchange — `{ token }` → `{ ok, purpose, expiresAt,
 * reference }` and the httpOnly `outlyy_ticket_access` cookie (TKT-5, doc 22
 * §26 F39; `reference` added in B5 so the `/t` page can open the order).
 *
 * The grant is ADDED to the browser's access cookie (R-B4-11): a second
 * order's link no longer replaces the first. `expiresAt` is this grant's
 * access session; the cookie lives as long as its longest entry.
 *
 * The email link is `<site>/t#<token>`: the token sits in the URL fragment,
 * which never reaches the server, its logs or a `Referer`. The `/t` landing
 * page (B5) reads the fragment, removes it from the address bar and POSTs it
 * here. This route has no GET export, so a mail scanner or link preview
 * fetching any URL consumes nothing.
 *
 * Same-origin JSON only; rate-limited per IP; the grant itself is capped.
 * Unknown, expired, revoked and used-up tokens get the same 404.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  await publicRateLimit(req, "tickets.exchange", TICKET_EXCHANGE_RATE);
  const { token } = await parseJson(req, bodySchema, { maxBytes: 2048 });
  const result = await capabilityService.exchange(token);
  if (!result.ok) {
    return json({ error: { code: "NOT_FOUND", message: "This link has expired or is no longer valid" } }, { status: 404, headers: { ...TICKET_HEADERS } });
  }
  const reference = await ticketAccess.referenceOf(result.orderId);
  const cookie = addAccessEntry(ticketAccessFromRequest(req), result.cookieValue);
  if (!reference || !cookie) {
    return json({ error: { code: "NOT_FOUND", message: "This link has expired or is no longer valid" } }, { status: 404, headers: { ...TICKET_HEADERS } });
  }
  const res = json({ ok: true, purpose: result.purpose, expiresAt: result.expiresAt.toISOString(), reference }, { headers: { ...TICKET_HEADERS } });
  setTicketAccessCookie(res, cookie.value, cookie.expiresAt);
  return res;
});
