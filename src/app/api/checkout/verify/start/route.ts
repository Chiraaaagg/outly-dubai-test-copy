import type { NextRequest } from "next/server";
import { assertSameOrigin, clientIp, handle, json, parseJson } from "@/server/lib/http";
import { contactVerificationService } from "@/server/services/contact-verification.service";
import { CHECKOUT_MAX_BYTES, checkoutSessionEnded, enforceCheckoutIpLimit, resolveCheckoutOwner, verifyStartSchema } from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/checkout/verify/start — `{ quoteId, channel, contact }` →
 * `{ challengeId }` (TKT-4). Sends a code to the phone or email that will be
 * on the order, bound to the caller's own active quote. Same-origin; body
 * capped at CHECKOUT_MAX_BYTES.
 *
 * The verification service owns every rule: rate limits per IP and per
 * owner first (Postgres-backed, failing closed), then global, then per quote
 * and per contact only for the caller's own live quote; a decoy id for a
 * quote that is not theirs, not active or unknown; delivery through the
 * configured adapters. The route adds only a coarse per-IP limit before any
 * session is read (`CHECKOUT_ROUTE_IP_RATE`), then passes the client IP and
 * the owner. It never creates or reads a customer account, and never
 * opens a guest session: without the session that made the quote there is
 * nothing to verify for.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  const ip = clientIp(req);
  await enforceCheckoutIpLimit("verify_start", ip);
  const body = await parseJson(req, verifyStartSchema, { maxBytes: CHECKOUT_MAX_BYTES });
  const owner = await resolveCheckoutOwner(req);
  if (!owner) throw checkoutSessionEnded();
  const { challengeId } = await contactVerificationService.start({ ...body, owner, ip: ip ?? null });
  return json({ challengeId });
}, { timing: "checkout_verify_start" });
