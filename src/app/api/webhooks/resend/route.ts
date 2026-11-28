import type { NextRequest } from "next/server";
import { env } from "@/server/lib/env";
import { json, readBodyBytes } from "@/server/lib/http";
import { isAppError } from "@/server/lib/errors";
import { log } from "@/server/lib/logger";
import { RESEND_WEBHOOK_MAX_BYTES, ingestVerifiedResendWebhook, isUsableWebhookSecret, verifySvixSignature, type SignatureVerdict } from "@/server/notifications/resend-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/resend — Resend delivery events (post-payment batch A8).
 *
 * Server-to-server: authenticated by Resend's Svix signature
 * (`svix-id`, `svix-timestamp`, `svix-signature`), not by Origin or
 * cookies, so `assertSameOrigin` deliberately does not apply.
 *
 *   1. No `RESEND_WEBHOOK_SECRET` (or one that is not a `whsec_` secret)
 *      → 503, nothing read or stored. Svix retries until the deployment is
 *      configured instead of losing the event.
 *   2. Body read with a streamed 256 KB ceiling (413 over it; 400 if the
 *      client aborts mid-body).
 *   3. Signature verified over exactly those bytes; a timestamp more than
 *      five minutes away is refused. Missing, malformed, stale or wrong → 401
 *      and nothing stored.
 *   4. Only then parsed, stored once per `svix-id` and applied to the
 *      matching notification rows → 200. A redelivery of a processed event
 *      is a 200 that changes nothing; a redelivery of one whose apply step
 *      failed applies it now.
 *
 * Logs carry the rejection reason and counts only: never an address, a
 * subject, a header value or the body. An unexpected failure while storing a
 * verified event answers 500 so Svix redelivers; the redelivery finishes
 * the stored event (apply is idempotent), so the retry is both safe and
 * effective.
 */
export async function POST(req: NextRequest) {
  let secret: string | undefined;
  try {
    secret = env().RESEND_WEBHOOK_SECRET;
  } catch {
    secret = undefined;
  }
  if (!secret) {
    rejected("secret_not_configured");
    return plain("Webhook not configured", 503, { "retry-after": "300" });
  }
  // A secret without the `whsec_` prefix, or not base64, or too short: misconfigured, so closed before any read.
  if (!isUsableWebhookSecret(secret)) {
    rejected("secret_invalid");
    return plain("Webhook not configured", 503, { "retry-after": "300" });
  }

  let body: Uint8Array;
  try {
    body = await readBodyBytes(req, RESEND_WEBHOOK_MAX_BYTES);
  } catch (error) {
    const tooLarge = isAppError(error) && error.status === 413;
    rejected(tooLarge ? "body_too_large" : "body_unreadable");
    return plain(tooLarge ? "Payload too large" : "Bad request", tooLarge ? 413 : 400);
  }

  const id = req.headers.get("svix-id");
  const verdict = verifySvixSignature({ body, id, timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature"), secret, now: new Date() });
  if (verdict === "secret_invalid") {
    rejected(verdict);
    return plain("Webhook not configured", 503, { "retry-after": "300" });
  }
  if (verdict !== "ok" || !id) {
    rejected(verdict);
    return plain("Invalid signature", 401);
  }

  try {
    const result = await ingestVerifiedResendWebhook(body, id);
    log.info("resend.webhook.received", { type: result.type, duplicate: result.duplicate, applied: result.applied, skipped: result.skipped ?? null });
  } catch (error) {
    log.error("resend.webhook.failed", { error: error instanceof Error ? error.name : "unknown" });
    return json({ received: false }, { status: 500, headers: { "cache-control": "no-store" } });
  }
  return json({ received: true }, { headers: { "cache-control": "no-store" } });
}

let rejections = 0;

/** One line for the first rejection and every hundredth after it, per instance: reason only, so a flood cannot fill the log drain. */
function rejected(reason: SignatureVerdict | "secret_not_configured" | "body_too_large" | "body_unreadable"): void {
  rejections += 1;
  if (rejections === 1 || rejections % 100 === 0) log.warn("resend.webhook.rejected", { reason, count: rejections });
}

function plain(text: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });
}
