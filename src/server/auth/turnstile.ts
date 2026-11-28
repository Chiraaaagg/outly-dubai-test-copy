import "server-only";
import { env } from "../lib/env";

/**
 * Cloudflare Turnstile, server-side check (Group B; owner Q-B5: at launch).
 *
 * The /login widget produces a single-use token; the email-code start route
 * sends it here with our secret before any intent is written or any code is
 * requested. `success` must be true, the `action` must be exactly ours
 * (present and equal) and, in production, the `hostname` must be exactly
 * the NEXT_PUBLIC_SITE_URL host or its `www.` twin (owner decision: the apex
 * and `www.` both serve /login; `turnstileHostnames`), nothing else, not even
 * another subdomain. Anything else, including a
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

/**
 * The hostnames a production token may name (pure, exported for tests): the
 * NEXT_PUBLIC_SITE_URL host and its `www.` twin, or the apex when the site
 * URL is the `www.` host. Compared exactly.
 */
export function turnstileHostnames(siteUrl: string): string[] {
  const host = new URL(siteUrl).hostname;
  const twin = host.startsWith("www.") ? host.slice("www.".length) : `www.${host}`;
  return twin ? [host, twin] : [host];
}

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
    // Exactly our action (review 103 finding 10): a token from a widget without it, or with another, is refused.
    if (data.action !== TURNSTILE_ACTION) return "refused";
    if (e.isProduction) {
      if (typeof data.hostname !== "string" || !turnstileHostnames(e.NEXT_PUBLIC_SITE_URL).includes(data.hostname)) return "refused";
    }
    return "ok";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}
