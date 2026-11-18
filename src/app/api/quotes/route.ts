import type { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin, clientIp, errorResponse, handle, json, parseJson } from "@/server/lib/http";
import { enforceRateLimit } from "@/server/lib/rate-limit";
import { hashIp } from "@/server/lib/crypto";
import { isAppError } from "@/server/lib/errors";
import { log } from "@/server/lib/logger";
import { setGuestCookie } from "@/server/lib/customer-session";
import { customerAuthService } from "@/server/services/customer-auth.service";
import { guestSessionService } from "@/server/services/guest-session.service";
import { quoteService, toPublicQuote } from "@/server/services/quote.service";
import { QUOTE_MAX_BYTES, quoteRequestSchema } from "@/server/schemas/quote.schemas";
import type { QuoteSnapshot } from "@/server/quotes/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per IP and per owner, Postgres-backed (fails closed): every call makes one supplier check per line. */
const QUOTE_RATE = { limit: 30, windowSeconds: 300 } as const;

/**
 * Per IP per minute, checked with the five-minute IP limit and before the
 * global one (N4). Refused calls count in a window too, so without it two
 * addresses spending their 30 inside one minute could keep `quote:global`
 * full and every other customer would get a 429. At 6 a minute it takes
 * seven busy addresses to fill the global window; the per-IP limits stay the
 * main control and the global one is the ceiling. Provisional ops value.
 */
const QUOTE_IP_MINUTE_RATE = { limit: 6, windowSeconds: 60 } as const;

/**
 * All callers together (CR-B2-3), Postgres-backed and failing closed like the
 * others: any number of IPs cannot spend more of the shared supplier account
 * than this. A quote that reaches the supplier costs one read, or two on a
 * pickup-list cache miss, so 40 a minute stays well inside the account's read
 * budget and leaves room for booking recovery and polling. Provisional ops
 * value; the supplier read budget's own quote share applies as well.
 */
const QUOTE_GLOBAL_RATE = { key: "quote:global", limit: 40, windowSeconds: 60 } as const;

/**
 * POST /api/quotes — a server quote for an instant cart (doc 22 §22.1 item 4).
 * Same-origin only; body capped at QUOTE_MAX_BYTES.
 *
 * Owner: the signed-in customer, otherwise the browser's guest session, which
 * is opened here (httpOnly cookie) when there is none. Rate limits run per IP
 * (five minutes, then one minute), then globally (`QUOTE_GLOBAL_RATE`), then
 * per owner; the IP and global
 * limits pass before any session is read or opened, any quote is written and
 * any supplier is called. A guest session is not an account and never
 * becomes one by quoting.
 *
 * 201 with the public projection of the quote (`toPublicQuote`: id, expiry,
 * currency, total and per line the selection, charged amount, allocations and
 * refund deadline) when every line can be sold instantly; 200 with
 * `{ ok: false, lines: [{ index, reason }] }` when any line cannot — the
 * client then sends the cart to /inquiry (`requires_inquiry` and the other
 * reasons name the lines). The stored snapshot (supplier net, margin,
 * mapping, fingerprint, owner) never leaves the server. No money moves here.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  const ip = hashIp(clientIp(req)) ?? "unknown";
  await enforceRateLimit({ key: `quote:ip:${ip}`, ...QUOTE_RATE });
  await enforceRateLimit({ key: `quote:ipm:${ip}`, ...QUOTE_IP_MINUTE_RATE });
  const body = await parseJson(req, quoteRequestSchema, { maxBytes: QUOTE_MAX_BYTES });
  // After the IP limits, so one address cannot use up everyone's share; after parsing, so a malformed body costs none of it.
  await enforceGlobal();

  // An existing owner passes its own limit before anything is written.
  const session = await customerAuthService.resolveRequest(req);
  const guest = session ? null : await guestSessionService.resolveRequest(req);
  const existing: QuoteSnapshot["owner"] | null = session ? { kind: "customer", customerId: session.customer.id } : guest ? guestSessionService.owner(guest) : null;
  if (existing) {
    await enforceRateLimit({ key: ownerKey(existing), ...QUOTE_RATE });
    const result = toPublicQuote(await quoteService.create(existing, body));
    return json(result, { status: result.ok ? 201 : 200 });
  }

  // A new guest session is opened only after the IP limit has passed, and
  // every response from here on carries its cookie, errors included, so no
  // session row is left without one.
  const created = await guestSessionService.create();
  const owner = guestSessionService.owner(created);
  let res: NextResponse;
  try {
    await enforceRateLimit({ key: ownerKey(owner), ...QUOTE_RATE });
    const result = toPublicQuote(await quoteService.create(owner, body));
    res = json(result, { status: result.ok ? 201 : 200 });
  } catch (error) {
    res = errorResponse(error, req.headers.get("x-request-id")?.slice(0, 64));
  }
  setGuestCookie(res, created.token, created.expiresAt);
  return res;
});

/** The global limit, logged when it refuses: a full window means instant quotes are refused for everyone (N4 alert). */
async function enforceGlobal(): Promise<void> {
  try {
    await enforceRateLimit(QUOTE_GLOBAL_RATE);
  } catch (error) {
    if (isAppError(error) && error.status === 429) log.warn("quote.global_limit_saturated", { limit: QUOTE_GLOBAL_RATE.limit, windowSeconds: QUOTE_GLOBAL_RATE.windowSeconds });
    throw error;
  }
}

function ownerKey(owner: QuoteSnapshot["owner"]): string {
  return `quote:owner:${owner.kind === "customer" ? owner.customerId : owner.guestSessionId}`;
}
