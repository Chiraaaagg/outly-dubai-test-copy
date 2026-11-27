/**
 * Customer sign-in contract shared by the server and the /login page
 * (Group B, side-session plan 92 §5.1, §6).
 *
 * The server decides which options work (`customerAuthService.options()`) and
 * the page renders exactly those: no disabled buttons, no "coming soon".
 * Errors cross the boundary as one closed code in `error.details.reason`; the
 * page owns the words. Nothing here reveals whether an address has an account.
 */

export interface CustomerAuthOptions {
  /** Email one-time code through Supabase Auth and our Send Email hook. */
  emailCode: boolean;
  /** "Continue with Google" through our own callback on this site (owner Q-B1). */
  google: boolean;
  /** The existing phone code path. Hidden while SMS cannot deliver (owner Q11). */
  phone: boolean;
  /** Cloudflare Turnstile site key when the widget must be solved before an email code is sent (owner Q-B5). */
  turnstileSiteKey: string | null;
}

export const NO_SIGN_IN_OPTIONS: CustomerAuthOptions = Object.freeze({ emailCode: false, google: false, phone: false, turnstileSiteKey: null });

export function hasAnySignInOption(o: CustomerAuthOptions): boolean {
  return o.emailCode || o.google || o.phone;
}

/** Closed reasons a sign-in route answers with (`error.details.reason`). */
export const SIGN_IN_REASONS = [
  "EMAIL_INVALID",
  "CAPTCHA_FAILED",
  "CODE_INVALID",
  "CODE_EXPIRED",
  "RATE_LIMITED",
  "DELIVERY_FAILED",
  "ACCOUNT_CONFLICT",
  "ACCOUNT_CLOSED",
  "NOT_CONFIGURED",
  "UNAVAILABLE",
] as const;
export type SignInReason = (typeof SIGN_IN_REASONS)[number];

export function isSignInReason(v: unknown): v is SignInReason {
  return typeof v === "string" && (SIGN_IN_REASONS as readonly string[]).includes(v);
}

/** Short values the Google callback puts on `/login?e=` (never provider text). */
export const LOGIN_NOTICES = ["google_cancelled", "google_failed", "account_closed", "not_configured"] as const;
export type LoginNotice = (typeof LOGIN_NOTICES)[number];

export function parseLoginNotice(v: string | null | undefined): LoginNotice | null {
  return typeof v === "string" && (LOGIN_NOTICES as readonly string[]).includes(v) ? (v as LoginNotice) : null;
}

/** Supabase's per-address minimum between two email codes. */
export const EMAIL_RESEND_AFTER_SECONDS = 60;
/** Email OTP expiry configured in the Supabase dashboard (plan 92 §2.3). */
export const EMAIL_CODE_TTL_SECONDS = 600;
export const EMAIL_CODE_LENGTH = 6;
/** RFC 5321 path limit; also the database check on `customer_identities.email`. */
export const EMAIL_MAX_LENGTH = 254;

/** Trimmed lower case, or null when it is not a plausible address. Exact: no dot or plus folding. */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > EMAIL_MAX_LENGTH) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** `j•••@example.com` style mask for the "code sent" line. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local[0]}•••@${domain}`;
}
