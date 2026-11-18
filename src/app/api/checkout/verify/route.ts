import type { NextRequest } from "next/server";
import { assertSameOrigin, clientIp, handle, json, parseJson } from "@/server/lib/http";
import { Errors } from "@/server/lib/errors";
import { contactVerificationService } from "@/server/services/contact-verification.service";
import { CHECKOUT_MAX_BYTES, checkoutSessionEnded, enforceCheckoutIpLimit, resolveCheckoutOwner, verifyCodeSchema } from "../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long a refused caller is told to wait; the verification window is 15 minutes. */
const RETRY_AFTER_SECONDS = 900;

/**
 * POST /api/checkout/verify — `{ challengeId, code }` →
 * `{ verificationId, channel, verifiedAt }` (TKT-4). Proves the caller
 * controls the contact for their own quote; `/api/checkout` then binds the
 * verification to the order. Same-origin; body capped at CHECKOUT_MAX_BYTES.
 *
 * A coarse per-IP limit runs before any session is read
 * (`CHECKOUT_ROUTE_IP_RATE`). The verification service rate-limits (per IP
 * and per owner first, failing closed), compares the code and keeps it
 * single use. Its refusals map to:
 * `invalid` → 422 on `code`, `expired` → 404 (send a new code), and
 * `rate_limited` → 429. The contact's hash never leaves the server.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  const ip = clientIp(req);
  await enforceCheckoutIpLimit("verify", ip);
  const body = await parseJson(req, verifyCodeSchema, { maxBytes: CHECKOUT_MAX_BYTES });
  const owner = await resolveCheckoutOwner(req);
  if (!owner) throw checkoutSessionEnded();
  const result = await contactVerificationService.verify({ ...body, owner, ip: ip ?? null });
  if ("refused" in result) {
    if (result.refused === "rate_limited") throw Errors.rateLimited(RETRY_AFTER_SECONDS);
    if (result.refused === "expired") throw Errors.notFound("Code");
    throw Errors.validation({ code: "That code isn't right. Check it and try again." });
  }
  return json({ verificationId: result.verificationId, channel: result.channel, verifiedAt: result.verifiedAt });
});
