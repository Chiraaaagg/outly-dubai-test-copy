import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Supabase Auth HTTP hooks: Standard Webhooks signature check (Group B,
 * plan 92 §1.3 step 2, §2.1).
 *
 * Supabase signs each hook request the Standard Webhooks way
 * (https://www.standardwebhooks.com): headers `webhook-id`,
 * `webhook-timestamp` (Unix seconds) and `webhook-signature` (space-separated
 * `v1,<base64 HMAC-SHA256>` entries) over `${id}.${timestamp}.${body}`, keyed
 * with the base64 part of the dashboard secret `v1,whsec_<base64>`.
 *
 * Pure (no I/O): the routes add the replay claim on `webhook-id`
 * (`claimHookDelivery`) and the intent gate. Constant-time comparison; a
 * timestamp more than five minutes away from now is refused either way.
 */

export const HOOK_TOLERANCE_SECONDS = 5 * 60;
/** Hook bodies are small JSON; anything larger is refused before parsing. */
export const HOOK_MAX_BYTES = 64 * 1024;

export type HookVerifyFailure = "not_configured" | "missing_headers" | "bad_timestamp" | "stale" | "bad_signature";

export type HookVerifyResult = { ok: true; webhookId: string } | { ok: false; reason: HookVerifyFailure };

/** The key bytes of a `v1,whsec_<base64>` (or bare `whsec_<base64>`) secret, or null when it is not one. */
export function hookSecretKey(secret: string | undefined): Buffer | null {
  if (!secret) return null;
  const m = /^(?:v1,)?whsec_([A-Za-z0-9+/=]+)$/.exec(secret.trim());
  if (!m) return null;
  const key = Buffer.from(m[1], "base64");
  return key.length >= 16 ? key : null;
}

export function signHookPayload(key: Buffer, webhookId: string, timestamp: string, body: string): string {
  return createHmac("sha256", key).update(`${webhookId}.${timestamp}.${body}`).digest("base64");
}

export function verifyHookSignature(input: {
  secret: string | undefined;
  headers: { id: string | null; timestamp: string | null; signature: string | null };
  body: string;
  now?: Date;
}): HookVerifyResult {
  const key = hookSecretKey(input.secret);
  if (!key) return { ok: false, reason: "not_configured" };
  const { id, timestamp, signature } = input.headers;
  if (!id || !timestamp || !signature || id.length > 256 || signature.length > 2048) return { ok: false, reason: "missing_headers" };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "bad_timestamp" };
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > HOOK_TOLERANCE_SECONDS) return { ok: false, reason: "stale" };

  const expected = Buffer.from(signHookPayload(key, id, timestamp, input.body), "base64");
  for (const entry of signature.split(" ")) {
    const [version, sig] = entry.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true, webhookId: id };
  }
  return { ok: false, reason: "bad_signature" };
}

/** Email action types Supabase sends to the Send Email hook for a sign-in code (first-time `signup`, returning `magiclink`). */
export const SIGN_IN_EMAIL_ACTIONS: readonly string[] = ["signup", "magiclink", "email"];

export interface SendEmailHookPayload {
  userId: string;
  email: string;
  token: string;
  actionType: string;
}

/** Reads the Send Email hook body. Null when a field is missing or malformed. */
export function parseSendEmailHook(raw: unknown): SendEmailHookPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { user?: { id?: unknown; email?: unknown }; email_data?: { token?: unknown; email_action_type?: unknown } };
  const userId = r.user?.id;
  const email = r.user?.email;
  const token = r.email_data?.token;
  const actionType = r.email_data?.email_action_type;
  if (typeof userId !== "string" || !userId || userId.length > 128) return null;
  if (typeof email !== "string" || !email || email.length > 254) return null;
  if (typeof token !== "string" || !/^\d{6,10}$/.test(token)) return null;
  if (typeof actionType !== "string" || !/^[a-z_]{1,40}$/.test(actionType)) return null;
  return { userId, email, token, actionType };
}

export interface BeforeUserCreatedPayload {
  email: string | null;
  phone: string | null;
  /** `app_metadata.provider`: `email`, `google`, `phone`, … */
  provider: string | null;
}

/** Reads the Before User Created hook body. Null when malformed. */
export function parseBeforeUserCreatedHook(raw: unknown): BeforeUserCreatedPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const u = (raw as { user?: { email?: unknown; phone?: unknown; app_metadata?: { provider?: unknown } } }).user;
  if (!u || typeof u !== "object") return null;
  const s = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
  return { email: s(u.email, 254), phone: s(u.phone, 32), provider: s(u.app_metadata?.provider, 40) };
}
