import { NextResponse, type NextRequest } from "next/server";
import { customerIdentityService } from "@/server/services/customer-identity.service";
import { HOOK_MAX_BYTES, parseBeforeUserCreatedHook, verifyHookSignature } from "@/server/auth/auth-hook";
import { env } from "@/server/lib/env";
import { readBodyText } from "@/server/lib/http";
import { emitEvent } from "@/server/lib/structured-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const hookError = (status: number, message: string) => NextResponse.json({ error: { http_code: status, message } }, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/auth/hooks/before-user-created — Supabase Auth's Before User
 * Created hook (plan 92 §2.1). Lets Supabase create a user only for a Google
 * sign-in or an email with a live intent from our start route; refuses
 * password sign-ups, phone users and junk at creation. 404 while the
 * sign-in is off or the secret is missing.
 */
export async function POST(req: NextRequest) {
  const e = env();
  if (!e.CUSTOMER_SUPABASE_AUTH_ENABLED || !e.SUPABASE_AUTH_BEFORE_USER_CREATED_HOOK_SECRET) return new NextResponse(null, { status: 404 });
  let body: string;
  try {
    body = await readBodyText(req, HOOK_MAX_BYTES);
  } catch {
    return hookError(413, "payload too large");
  }
  const verdict = verifyHookSignature({
    secret: e.SUPABASE_AUTH_BEFORE_USER_CREATED_HOOK_SECRET,
    headers: { id: req.headers.get("webhook-id"), timestamp: req.headers.get("webhook-timestamp"), signature: req.headers.get("webhook-signature") },
    body,
  });
  if (!verdict.ok) {
    emitEvent("customer.identity_hook_refused", { hook: "before_user_created", reason: verdict.reason }, "warn");
    return hookError(401, "invalid signature");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return hookError(400, "malformed body");
  }
  const payload = parseBeforeUserCreatedHook(raw);
  if (!payload) return hookError(400, "malformed body");
  try {
    const verdictUser = await customerIdentityService.handleBeforeUserCreatedHook(payload);
    return verdictUser === "allow" ? NextResponse.json({}, { headers: { "cache-control": "no-store" } }) : hookError(403, "Sign-up is not available this way.");
  } catch {
    return hookError(503, "unavailable");
  }
}
