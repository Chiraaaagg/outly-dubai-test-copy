import type { NextRequest } from "next/server";
import { customerIdentityService } from "@/server/services/customer-identity.service";
import { assertSameOrigin, clientIp, handle, json, parseJson } from "@/server/lib/http";
import { emailStartSchema } from "@/server/schemas/customer.schemas";
import { setEmailStartCookie } from "@/server/lib/email-start-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/email/start — `{ email, turnstileToken? }` → `{ expiresInSeconds, resendAfterSeconds }`.
 * The same answer whether or not the address has an account. Errors carry a
 * closed `details.reason` (src/lib/customer-auth-options.ts). Sets the short
 * signed start cookie that the verify route needs (review 103 finding 8).
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  const body = await parseJson(req, emailStartSchema, { maxBytes: 4096 });
  const { startCookie, ...result } = await customerIdentityService.startEmailCode({ email: body.email, turnstileToken: body.turnstileToken, ip: clientIp(req) });
  const res = json(result);
  setEmailStartCookie(res, startCookie);
  return res;
});
