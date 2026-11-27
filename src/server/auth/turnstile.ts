import "server-only";
import { env } from "../lib/env";

/**
 * Cloudflare Turnstile, server-side check (Group B; owner Q-B5: at launch).
 *
 * The /login widget produces a single-use token; the email-code start route
 * sends it here with our secret before any intent is written or any code is
 * requested. `success` must be true, the `action` must be ours and, in
 * production, the `hostname` must be the site's. Anything else, including a
 * Cloudflare outage, refuses the send (fail closed): Google sign-in stays
 * available on the same page.
 *
 * Required when both keys are set; in production the email option is not
 * offered at all without them (`customerAuthConfigProblems`). Never logged:
 * the token, the secret, the client IP.
 */

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_ACTION = "login_email";
const TIMEOUT_MS = 5_000;

let verifyUrl = TURNSTILE_VERIFY_URL;
/** Test seam: the fake siteverify endpoint. `null` restores Cloudflare's. */
export function setTurnstileUrlForTests(url: string | null) {
  verifyUrl = url ?? TURNSTILE_VERIFY_URL;
}

export function turnstileConfigured(): boolean {
  const e = env();
  return Boolean(e.TURNSTILE_SECRET_KEY && e.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
}

export type TurnstileResult = "ok" | "missing" | "refused" | "unavailable";

export async function verifyTurnstile(token: unknown, remoteIp: string | undefined): Promise<TurnstileResult> {
  const e = env();
  if (!e.TURNSTILE_SECRET_KEY) return "unavailable";
  if (typeof token !== "string" || token.length < 10 || token.length > 2048) return "missing";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const body = new URLSearchParams({ secret: e.TURNSTILE_SECRET_KEY, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);
    const res = await fetch(verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return "unavailable";
    }
    const data = (await res.json().catch(() => null)) as { success?: unknown; action?: unknown; hostname?: unknown } | null;
    if (!data || data.success !== true) return "refused";
    if (data.action !== undefined && data.action !== TURNSTILE_ACTION) return "refused";
    if (e.isProduction) {
      const host = new URL(e.NEXT_PUBLIC_SITE_URL).hostname;
      if (data.hostname !== host) return "refused";
    }
    return "ok";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}
