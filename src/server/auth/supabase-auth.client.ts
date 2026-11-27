import "server-only";
import { env } from "../lib/env";

/**
 * Supabase Auth, server to server (Group B, side-session plan 92 §1.3).
 *
 * Plain `fetch` to `<SUPABASE_URL>/auth/v1/*` with the publishable key in the
 * `apikey` header. No Supabase client library: the six calls below are the
 * whole surface, and the tokens they return never leave the server (the
 * caller verifies the access token, reads the user, signs the Supabase
 * session out and drops both tokens).
 *
 *  - 5-second timeout per call; no retry on any POST (a retried `/otp` would
 *    send a second code, a retried `/verify` would spend the code).
 *  - Every failure becomes one closed `SupabaseAuthErrorKind`; the provider's
 *    message is never passed on, logged or shown.
 *  - `X-Supabase-Api-Version` asks for the dated error format with
 *    `error_code` (Auth API 2024-01-01).
 *
 * The request and response shapes are pinned by the contract test
 * (src/server/auth/__tests__/supabase-auth.contract.test.ts) against the fake
 * Auth server (src/server/auth/__tests__/fake-supabase-auth.ts).
 */

export const SUPABASE_AUTH_TIMEOUT_MS = 5_000;
export const SUPABASE_API_VERSION = "2024-01-01";

export type SupabaseAuthErrorKind =
  /** Supabase's own rate limit (429). */
  | "rate_limited"
  /** The email code was wrong, expired or already used (`otp_expired`: Supabase does not tell them apart). */
  | "invalid_code"
  /** The send failed: our hook refused or could not deliver, or Supabase's mailer failed. */
  | "delivery_failed"
  /** The address or the request was refused as malformed. */
  | "invalid_request"
  /** Supabase refused the identity (an unverified Google email, a token it would not accept, sign-ups closed). */
  | "rejected"
  /** The access token was refused when reading the user. */
  | "unauthorized"
  /** Timeout, network error, 5xx or an unreadable answer. */
  | "unavailable"
  /** URL or key missing. */
  | "not_configured";

export class SupabaseAuthError extends Error {
  readonly kind: SupabaseAuthErrorKind;
  readonly httpStatus: number | null;
  /** Supabase's `error_code` when it sent one: a short identifier, kept for the closed mapping and tests, never shown. */
  readonly errorCode: string | null;
  /** True when our own timeout aborted the call: Supabase may still have done the work (for `/otp`, sent the code). */
  readonly timedOut: boolean;
  constructor(kind: SupabaseAuthErrorKind, httpStatus: number | null, errorCode: string | null, timedOut = false) {
    super(`supabase_auth:${kind}`);
    this.name = "SupabaseAuthError";
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.errorCode = errorCode;
    this.timedOut = timedOut;
  }
}

export interface SupabaseIdentity {
  provider: string;
  identityData: { email: string | null; emailVerified: boolean; sub: string | null };
}

/** The fields OUTLYY reads from `GET /auth/v1/user`. `user_metadata` is user-editable and is never read. */
export interface SupabaseUser {
  id: string;
  email: string | null;
  emailConfirmedAt: string | null;
  phone: string | null;
  phoneConfirmedAt: string | null;
  identities: SupabaseIdentity[];
}

export interface SupabaseSession {
  accessToken: string;
  refreshToken: string | null;
}

interface Config {
  baseUrl: string;
  apiKey: string;
}

export function supabaseAuthConfig(): Config | null {
  const e = env();
  if (!e.SUPABASE_URL || !e.SUPABASE_PUBLISHABLE_KEY) return null;
  return { baseUrl: e.SUPABASE_URL.replace(/\/+$/, ""), apiKey: e.SUPABASE_PUBLISHABLE_KEY };
}

/** The issuer Supabase writes into its access tokens. */
export function supabaseIssuer(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/auth/v1`;
}

const SHORT_CODE = /^[a-z0-9_]{1,64}$/;

/** Maps a non-2xx answer to the closed list. Exported for the mapping test. */
export function classifySupabaseError(op: "otp" | "verify" | "id_token" | "user" | "logout", status: number, errorCode: string | null): SupabaseAuthErrorKind {
  if (status === 429 || errorCode === "over_email_send_rate_limit" || errorCode === "over_request_rate_limit" || errorCode === "over_sms_send_rate_limit") return "rate_limited";
  if (status >= 500) return op === "otp" ? "delivery_failed" : "unavailable";
  if (op === "verify" && (errorCode === "otp_expired" || status === 403 || status === 401)) return "invalid_code";
  if (op === "otp") {
    if (errorCode === "email_address_invalid" || errorCode === "validation_failed" || errorCode === "email_address_not_authorized") return "invalid_request";
    if (errorCode === "signup_disabled") return "rejected";
    // Hook refusals and mailer failures (`hook_*`, `unexpected_failure`, 4xx from our own hook).
    return "delivery_failed";
  }
  if (op === "user" && (status === 401 || status === 403)) return "unauthorized";
  if (op === "id_token") return status === 400 || status === 401 || status === 403 || status === 422 ? "rejected" : "unavailable";
  return status === 400 || status === 422 ? "invalid_request" : "unavailable";
}

async function call(op: Parameters<typeof classifySupabaseError>[0], path: string, init: { method: "GET" | "POST"; body?: unknown; bearer?: string }): Promise<unknown> {
  const cfg = supabaseAuthConfig();
  if (!cfg) throw new SupabaseAuthError("not_configured", null, null);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SUPABASE_AUTH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/auth/v1${path}`, {
      method: init.method,
      headers: {
        apikey: cfg.apiKey,
        "x-supabase-api-version": SUPABASE_API_VERSION,
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new SupabaseAuthError("unavailable", null, null, timedOut);
  } finally {
    clearTimeout(timer);
  }
  let data: unknown = null;
  const text = await res.text().catch(() => "");
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const raw = data && typeof data === "object" ? (data as { error_code?: unknown; code?: unknown }).error_code : undefined;
    const errorCode = typeof raw === "string" && SHORT_CODE.test(raw) ? raw : null;
    throw new SupabaseAuthError(classifySupabaseError(op, res.status, errorCode), res.status, errorCode);
  }
  return data;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Reads a session answer (`/verify`, `/token`). Exported for the contract test. */
export function parseSession(data: unknown): SupabaseSession {
  const d = (data ?? {}) as Record<string, unknown>;
  const accessToken = str(d.access_token);
  if (!accessToken || accessToken.length > 8192) throw new SupabaseAuthError("unavailable", 200, null);
  return { accessToken, refreshToken: str(d.refresh_token) };
}

/** Reads `GET /auth/v1/user`. Exported for the contract test. */
export function parseUser(data: unknown): SupabaseUser {
  const d = (data ?? {}) as Record<string, unknown>;
  const id = str(d.id);
  if (!id || id.length > 128) throw new SupabaseAuthError("unavailable", 200, null);
  const identities = Array.isArray(d.identities) ? d.identities : [];
  return {
    id,
    email: str(d.email),
    emailConfirmedAt: str(d.email_confirmed_at),
    phone: str(d.phone),
    phoneConfirmedAt: str(d.phone_confirmed_at),
    identities: identities.slice(0, 20).map((raw) => {
      const i = (raw ?? {}) as Record<string, unknown>;
      const data = (i.identity_data ?? {}) as Record<string, unknown>;
      return {
        provider: str(i.provider) ?? "",
        identityData: { email: str(data.email), emailVerified: data.email_verified === true, sub: str(data.sub) },
      };
    }),
  };
}

export const supabaseAuthClient = {
  /** Starts an email code. Supabase calls our Send Email hook during this request. Uniform `{}` on success. */
  async sendEmailOtp(email: string): Promise<void> {
    await call("otp", "/otp", { method: "POST", body: { email, create_user: true } });
  },

  /** Checks an email code. Single use and expiry are Supabase's. */
  async verifyEmailOtp(email: string, code: string): Promise<SupabaseSession> {
    return parseSession(await call("verify", "/verify", { method: "POST", body: { type: "email", email, token: code } }));
  },

  /**
   * Signs in with a Google ID token we obtained and checked ourselves on our
   * own callback (owner Q-B1). `nonce` is the raw nonce; Google was given its
   * SHA-256, and Supabase checks the two agree.
   */
  async signInWithGoogleIdToken(idToken: string, rawNonce: string): Promise<SupabaseSession> {
    return parseSession(await call("id_token", "/token?grant_type=id_token", { method: "POST", body: { provider: "google", id_token: idToken, nonce: rawNonce } }));
  },

  /** The authoritative read of the signed-in user. */
  async getUser(accessToken: string): Promise<SupabaseUser> {
    return parseUser(await call("user", "/user", { method: "GET", bearer: accessToken }));
  },

  /** Revokes this Supabase session's refresh token. Best effort; never throws. */
  async signOut(accessToken: string): Promise<boolean> {
    try {
      await call("logout", "/logout?scope=local", { method: "POST", bearer: accessToken });
      return true;
    } catch {
      return false;
    }
  },
};

export type SupabaseAuthClient = typeof supabaseAuthClient;
