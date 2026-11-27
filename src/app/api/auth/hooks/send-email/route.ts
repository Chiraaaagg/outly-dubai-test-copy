import { NextResponse, type NextRequest } from "next/server";
import { customerIdentityService } from "@/server/services/customer-identity.service";
import { customerAuthService } from "@/server/services/customer-auth.service";
import { HOOK_MAX_BYTES, parseSendEmailHook, verifyHookSignature } from "@/server/auth/auth-hook";
import { env } from "@/server/lib/env";
import { readBodyText } from "@/server/lib/http";
import { emitEvent } from "@/server/lib/structured-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const hookError = (status: number, message: string) => NextResponse.json({ error: { http_code: status, message } }, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/auth/hooks/send-email — Supabase Auth's Send Email hook (plan 92
 * §1.3 step 2). Called by Supabase, server to server, never by a browser.
 * 404 while the sign-in is off or the secret is missing. Signature (Standard
 * Webhooks, 5-minute tolerance), then the service: sign-in action types only,
 * one live intent consumed, the code sent through the Resend adapter. Every
 * refusal is the same short error to Supabase, which then fails the `/otp`
 * call; the code, the address and the body are never logged.
 */
export async function POST(req: NextRequest) {
  const e = env();
  if (!e.CUSTOMER_SUPABASE_AUTH_ENABLED || !e.SUPABASE_AUTH_SEND_EMAIL_HOOK_SECRET || !customerAuthService.options().emailCode) return new NextResponse(null, { status: 404 });
  let body: string;
  try {
    body = await readBodyText(req, HOOK_MAX_BYTES);
  } catch {
    return hookError(413, "payload too large");
  }
  const verdict = verifyHookSignature({
    secret: e.SUPABASE_AUTH_SEND_EMAIL_HOOK_SECRET,
    headers: { id: req.headers.get("webhook-id"), timestamp: req.headers.get("webhook-timestamp"), signature: req.headers.get("webhook-signature") },
    body,
  });
  if (!verdict.ok) {
    emitEvent("customer.identity_hook_refused", { hook: "send_email", reason: verdict.reason }, "warn");
    return hookError(401, "invalid signature");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return hookError(400, "malformed body");
  }
  const payload = parseSendEmailHook(raw);
  if (!payload) return hookError(400, "malformed body");
  try {
    const result = await customerIdentityService.handleSendEmailHook(payload, verdict.webhookId);
    if (result === "sent" || result === "suppressed") return NextResponse.json({}, { headers: { "cache-control": "no-store" } });
    return result === "failed" ? hookError(503, "delivery failed") : hookError(403, "not allowed");
  } catch {
    emitEvent("customer.identity_hook_failed", { hook: "send_email" }, "error");
    return hookError(503, "delivery failed");
  }
}
