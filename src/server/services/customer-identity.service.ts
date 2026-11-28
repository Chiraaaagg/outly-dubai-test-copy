import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma, type Tx } from "../lib/db";
import { env } from "../lib/env";
import { AppError, isAppError } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { emitEvent } from "../lib/structured-events";
import { encryptFor, hashIp, randomToken, sha256Hex } from "../lib/crypto";
import { enforceRateLimit, rateLimit, rateLimitSpan, readRateLimitSpan, releaseRateLimit } from "../lib/rate-limit";
import { audit } from "../lib/audit";
import { customerActor, type Actor } from "../lib/actor";
import { safeNext } from "@/lib/safe-next";
import { EMAIL_CODE_TTL_SECONDS, EMAIL_RESEND_AFTER_SECONDS, normaliseEmail, type SignInReason } from "@/lib/customer-auth-options";
import { normalisePhone } from "../domain/phone";
import { accessCookieGrants, checkoutGrantsEnabled } from "./capability.service";
import { customerAuthService, mintCustomerSession, toCustomerPublic, type CustomerPublic } from "./customer-auth.service";
import { notificationService, type QueuedAccountLinkNotice } from "./notification.service";
import { customerRepo, type CustomerRecord } from "../repositories/customer.repo";
import { customerIdentityRepo, type SignInMethod } from "../repositories/customer-identity.repo";
import { SupabaseAuthError, supabaseAuthClient, supabaseAuthConfig, type SupabaseAuthClient, type SupabaseSession, type SupabaseUser } from "../auth/supabase-auth.client";
import { SupabaseJwtError, verifySupabaseAccessToken } from "../auth/supabase-jwt";
import { exchangeGoogleCode, GoogleOAuthError, googleAuthorizeUrl, googleConfig, googleRedirectUri, newGoogleFlow, verifyGoogleIdToken } from "../auth/google-oauth";
import { turnstileConfigured, verifyTurnstile } from "../auth/turnstile";
import { renderSignInCode } from "../notifications/auth-templates";
import { emailAdapter } from "../notifications/email.adapter";
import { isRecipientAllowed } from "../notifications/allowlist";
import type { OAuthCookieValue } from "../lib/oauth-cookie";
import { decodeEmailStartCookie, EMAIL_START_COOKIE_MAX_AGE_SECONDS, newEmailStartCookie, type EmailStartCookieValue } from "../lib/email-start-cookie";
import { SIGNIN_CODE_BUDGET_BUCKET, SIGNIN_CODE_BUDGET_WINDOW_SECONDS, SIGNIN_CODE_HOURLY_BUCKET, signInCodeDailyBudget } from "../auth/signin-code-budget";
import { CLAIM_MISSING_MARKER_START, CLAIM_MISSING_MARKER_TTL_MS, claimMissingMarkerKey, SIGNUP_CLAIM_MISSING_BUCKET, SIGNUP_CLAIM_MISSING_COUNT_LIMIT, SIGNUP_CLAIM_MISSING_WINDOW_SECONDS } from "../auth/signup-claim-alert";
import { pilotActive, pilotAllowsEmail } from "../auth/pilot";
import { defer } from "../lib/defer";
import type { SendEmailHookPayload, BeforeUserCreatedPayload } from "../auth/auth-hook";
import { SIGN_IN_EMAIL_ACTIONS } from "../auth/auth-hook";
import type { JWTVerifyGetKey } from "jose";

/**
 * Customer sign-in on Supabase Auth (Group B, side-session plan 92 §1–§2;
 * owner answers 91 Q9, Q10, Q12, Q-B1..Q-B6).
 *
 * Supabase Auth proves who the customer is; OUTLYY keeps the account and the
 * session. Every path ends in the same tail (`completeSignIn`):
 *
 *  1. the Supabase access token is verified locally (ES256 against the JWKS,
 *     issuer, audience, expiry) and the user is read back with it;
 *  2. the Supabase session is signed out at once; both tokens are dropped,
 *     never logged, stored or returned;
 *  3. in one transaction (`mintCustomerSession`): the customer is found by
 *     `customer_identities` (never by an email lookup in `customers`), or an
 *     existing phone account is linked when Supabase confirms the same phone
 *     on a `phone` identity and we started that phone sign-in (Q9; only while
 *     CUSTOMER_PHONE_LINK_ENABLED is on, review 103 finding 4), or a
 *     phone-less customer is created; a closed account is refused;
 *     the attach rules run (`attachGuestOrders`); the OUTLYY session row is
 *     written;
 *  4. after commit, before the response, one queued notice row per attached
 *     order; the sends run after the response (`defer`).
 *
 * The attach rules (owner Q10), the only way a guest order joins an account:
 *  (a) the account's email was verified by this sign-in (our email code for
 *      that address, or Google with `email_verified`) and its SHA-256 equals
 *      the `contact_hash` of an email verification bound to the order;
 *  (b) the order's quote belongs to this browser's live guest session, or
 *      this browser holds the order's live checkout grant, and the order has
 *      a bound email verification matching the order's email (the notice
 *      goes there).
 * Never on a typed email (`orders.lead_email` is not matched), never an order
 * linked to another customer, never an order once disputed as "not me", at
 * most 20 per sign-in, counted after the per-order checks (more attaches none
 * and alerts staff).
 *
 * Staff authentication (`authService`, admin cookies) is not referenced here.
 */

export const ATTACH_CAP = 20;
export const DISPUTE_TTL_MS = 30 * 24 * 3600_000;
/** Intents live just long enough for Supabase to call the hook during our own `/otp` request. */
export const INTENT_TTL_MS = 2 * 60_000;
/** Resend ceiling inside the Send Email hook. */
export const SEND_EMAIL_HOOK_RESEND_TIMEOUT_MS = 3_000;

const NO_IP_BUCKET = "none";
const WINDOW_15M = 900;
const WINDOW_1H = 3600;
const WINDOW_1D = 86_400;

/**
 * Sign-in code budget (review 103 finding 3; src/server/auth/signin-code-budget.ts): sign-in codes may use at
 * most 40 % of EMAIL_DAILY_SEND_CAP per UTC day. Staff are alerted at 80 % and when it is spent (account-alerts.ts,
 * re-review 103b N1). Every limit below is a Postgres counter that fails closed.
 */
export { SIGNIN_CODE_DAILY_SHARE_PERCENT, signInCodeDailyBudget } from "../auth/signin-code-budget";
export const EMAIL_START_LIMITS = {
  perAddress15m: 3,
  perIpHour: 10,
  perIpDay: 20,
  /** Much lower than the 300 an hour of the first build while on the Resend free tier. */
  globalHour: 30,
} as const;
/**
 * Verify attempts (finding 8; re-review 103b N2): per email start (for the start cookie's whole life, never reset
 * by a window edge), per IP, and per address as the wider backstop: 20 in 15 minutes is four starts' worth of
 * tries, so a stranger's guesses stay bounded and the owner is not locked out by one caller's few starts.
 */
export const EMAIL_VERIFY_LIMITS = { perStart: 5, perIp15m: 30, perAddress15m: 20 } as const;
/** A Supabase-confirmed phone links an existing account only for a phone sign-in we started this recently (finding 4). */
export const PHONE_LINK_INTENT_WINDOW_MS = EMAIL_CODE_TTL_SECONDS * 1000;

export interface EmailStartLimit {
  key: string;
  max: number;
  windowSeconds: number;
  /** `site`: shared by every customer, so its refusal says so and offers Google (re-review 103b N1, N6). */
  scope: "address" | "ip" | "site";
}

/**
 * The limits a code request passes, in order (pure, exported for tests).
 * The daily windows are aligned to UTC midnight (the limiter's windows start
 * at multiples of their length since the epoch), the same day as
 * `email_send_counters`.
 */
export function emailStartLimits(input: { contactHash: string; ipHash: string | undefined; dailyCap: number }): EmailStartLimit[] {
  const ip = input.ipHash ?? NO_IP_BUCKET;
  return [
    { key: `auth_email_start:email:${input.contactHash.slice(0, 32)}`, max: EMAIL_START_LIMITS.perAddress15m, windowSeconds: WINDOW_15M, scope: "address" },
    { key: `auth_email_start:ip:${ip}`, max: EMAIL_START_LIMITS.perIpHour, windowSeconds: WINDOW_1H, scope: "ip" },
    { key: `auth_email_start:ip_day:${ip}`, max: EMAIL_START_LIMITS.perIpDay, windowSeconds: WINDOW_1D, scope: "ip" },
    { key: SIGNIN_CODE_HOURLY_BUCKET, max: EMAIL_START_LIMITS.globalHour, windowSeconds: WINDOW_1H, scope: "site" },
    { key: SIGNIN_CODE_BUDGET_BUCKET, max: signInCodeDailyBudget(input.dailyCap), windowSeconds: SIGNIN_CODE_BUDGET_WINDOW_SECONDS, scope: "site" },
  ];
}

/**
 * The signup claim our start route sends to Supabase `/otp` for one intent
 * (re-review 103b, finding 7): HMAC-SHA256 of the intent id under a key
 * derived from AUTH_COOKIE_SECRET with its own label. The Before User Created
 * hook allows an email creation only when the new user's `user_metadata`
 * carries the claim of the live intent for that address, once. A direct
 * Supabase `/signup` cannot know it, so it can no longer take the creation
 * that our own start began. Exported for tests.
 */
export function signupClaimFor(intentId: string): string {
  const key = createHmac("sha256", env().AUTH_COOKIE_SECRET).update("outlyy:signup-claim:v1").digest();
  return createHmac("sha256", key).update(intentId).digest("base64url");
}

function sameClaim(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------ test seams */

let client: SupabaseAuthClient = supabaseAuthClient;
let jwtKeys: JWTVerifyGetKey | undefined;
let lastNotices: Promise<void> = Promise.resolve();
let clock: () => Date = () => new Date();

/**
 * Test seam: the clock the email start and verify limits are charged at, so a
 * test that pre-fills a day bucket cannot straddle UTC midnight (re-review
 * 103b). `null` restores the real clock.
 */
export function setIdentityClockForTests(now: (() => Date) | null) {
  clock = now ?? (() => new Date());
}

/** Test seam: resolves when the attach notices of the latest sign-in have been dispatched (they run after the response). */
export function accountNoticesSettledForTests(): Promise<void> {
  return lastNotices;
}

/** Test seam: a fake Auth client and local JWKS. `null` restores the real ones. */
export function setIdentityDepsForTests(deps: { client?: SupabaseAuthClient; keys?: JWTVerifyGetKey } | null) {
  client = deps?.client ?? supabaseAuthClient;
  jwtKeys = deps?.keys;
}

/* ------------------------------------------------------------ errors */

const STATUS: Record<SignInReason, { status: number; code: AppError["code"]; message: string; retryable?: boolean }> = {
  EMAIL_INVALID: { status: 422, code: "VALIDATION_FAILED", message: "Enter a valid email address." },
  CAPTCHA_FAILED: { status: 422, code: "VALIDATION_FAILED", message: "Confirm you are not a robot, then try again." },
  CODE_INVALID: { status: 422, code: "VALIDATION_FAILED", message: "That code didn't work." },
  CODE_EXPIRED: { status: 422, code: "VALIDATION_FAILED", message: "That code has expired." },
  RATE_LIMITED: { status: 429, code: "RATE_LIMITED", message: "Too many requests", retryable: true },
  DELIVERY_FAILED: { status: 503, code: "UNAVAILABLE", message: "We couldn't send the code.", retryable: true },
  ACCOUNT_CONFLICT: { status: 409, code: "CONFLICT", message: "This sign-in belongs to another account." },
  ACCOUNT_CLOSED: { status: 401, code: "UNAUTHORIZED", message: "This account has been closed." },
  NOT_CONFIGURED: { status: 503, code: "NOT_CONFIGURED", message: "Customer sign-in is not configured in this environment" },
  UNAVAILABLE: { status: 503, code: "UNAVAILABLE", message: "This is temporarily unavailable", retryable: true },
};

/**
 * `extra` adds closed hints to `details` (re-review 103b N1, N6): `scope: "site"` when a limit shared by every
 * customer refused, `alternative: "google"` when Google sign-in is on. Never anything about the address.
 */
export function signInError(reason: SignInReason, retryAfterSeconds?: number, extra?: { scope?: "site"; alternative?: "google" }): AppError {
  const s = STATUS[reason];
  return new AppError({ status: s.status, code: s.code, message: s.message, retryable: s.retryable, details: { reason, ...(retryAfterSeconds ? { retryAfterSeconds } : {}), ...(extra ?? {}) } });
}

export function reasonOf(err: unknown): SignInReason | null {
  const r = isAppError(err) ? err.details?.reason : undefined;
  return typeof r === "string" ? (r as SignInReason) : null;
}

/** Postgres limits, failing closed, re-thrown as sign-in reasons. `extra` goes on a RATE_LIMITED answer only. */
async function limit(key: string, max: number, windowSeconds: number, opts: { now?: Date; extra?: Parameters<typeof signInError>[2] } = {}) {
  try {
    await enforceRateLimit({ key, limit: max, windowSeconds, now: opts.now });
  } catch (err) {
    if (isAppError(err) && err.code === "RATE_LIMITED") throw signInError("RATE_LIMITED", Number(err.details?.retryAfterSeconds) || windowSeconds, opts.extra);
    throw signInError("UNAVAILABLE");
  }
}

/** The same for a counter over a fixed span (`rateLimitSpan`), failing closed. */
async function limitSpan(key: string, max: number, windowStart: Date, expiresAt: Date, now: Date) {
  const r = await rateLimitSpan({ key, limit: max, windowStart, expiresAt, now });
  if (r.storeUnavailable) throw signInError("UNAVAILABLE");
  if (!r.allowed) throw signInError("RATE_LIMITED", r.retryAfterSeconds);
}

/** Gives back the site-wide charges of a code request that sent nothing (re-review 103b N1). Never throws. */
async function releaseSiteCharges(charged: readonly EmailStartLimit[], chargedAt: Date): Promise<void> {
  for (const l of charged) await releaseRateLimit({ key: l.key, windowSeconds: l.windowSeconds, chargedAt });
}

/**
 * True only when a failed Supabase `/otp` shows that no code went out
 * (re-review 103c D3; pure, exported for tests): Supabase refused before
 * calling our hook (`rate_limited`, `invalid_request`, `rejected`, missing
 * configuration, any other 4xx), or the hook reported a failed send (a
 * `hook_*` error code other than a timeout). A hook timeout (`hook_timeout`,
 * `hook_timeout_after_retry`), any other 5xx, a transport error and our own
 * timeout are not proof: our hook may already have handed the code to Resend,
 * so the site-wide charges stay.
 */
export function otpSentNothing(err: unknown): boolean {
  if (!(err instanceof SupabaseAuthError)) return false;
  if (err.kind === "not_configured") return true;
  if (err.timedOut || err.httpStatus === null) return false;
  const code = err.errorCode ?? "";
  if (code.startsWith("hook_timeout")) return false;
  if (err.kind === "rate_limited" || err.kind === "invalid_request" || err.kind === "rejected") return true;
  if (code.startsWith("hook_")) return true;
  return err.httpStatus >= 400 && err.httpStatus < 500;
}

function fromSupabase(err: unknown, op: "send" | "verify" | "token"): AppError {
  if (err instanceof SupabaseAuthError) {
    switch (err.kind) {
      case "rate_limited":
        return signInError("RATE_LIMITED", EMAIL_RESEND_AFTER_SECONDS);
      case "invalid_code":
        return signInError("CODE_INVALID");
      case "invalid_request":
        return signInError(op === "send" ? "EMAIL_INVALID" : "CODE_INVALID");
      case "delivery_failed":
        return signInError("DELIVERY_FAILED");
      case "not_configured":
        return signInError("NOT_CONFIGURED");
      default:
        return signInError(op === "send" ? "DELIVERY_FAILED" : "UNAVAILABLE");
    }
  }
  return isAppError(err) ? err : signInError("UNAVAILABLE");
}

/* ------------------------------------------------------------ decisions */

/**
 * The email this sign-in proves, or null (plan 92 §1.4 step 3). Supabase
 * must have confirmed the address, and either this sign-in was our email
 * code for exactly that address, or Google verified it on a Google identity
 * of this user (and, on our own callback, in the ID token we checked). The
 * user-editable `user_metadata` is never read.
 */
export function decideVerifiedEmail(user: SupabaseUser, proof: { method: "email_otp"; email: string } | { method: "google"; email: string }): string | null {
  const email = normaliseEmail(user.email);
  if (!email || !user.emailConfirmedAt) return null;
  if (normaliseEmail(proof.email) !== email) return null;
  if (proof.method === "email_otp") return email;
  const google = user.identities.some((i) => i.provider === "google" && i.identityData.emailVerified && normaliseEmail(i.identityData.email) === email);
  return google ? email : null;
}

/**
 * A phone Supabase confirmed on a `phone` identity of this user, as E.164,
 * or null. Only used to link an existing phone account (Q9), and only while
 * CUSTOMER_PHONE_LINK_ENABLED is on (review 103 finding 4): a phone set on
 * an email or Google user through `PUT /user` has no `phone` identity.
 */
export function confirmedPhone(user: SupabaseUser): string | null {
  if (!user.phone || !user.phoneConfirmedAt) return null;
  if (!user.identities.some((i) => i.provider === "phone")) return null;
  const raw = user.phone.startsWith("+") ? user.phone : `+${user.phone}`;
  const p = normalisePhone(raw);
  return p.valid ? p.e164 : null;
}

/* ------------------------------------------------------------ attach (owner Q10) */

export interface AttachedOrder {
  linkId: string;
  orderId: string;
  reference: string;
  rule: "verified_email" | "guest_session";
  recipient: string;
}

export interface AttachResult {
  attached: AttachedOrder[];
  capped: boolean;
}

/** The browser's live checkout grants, from the signed access cookie, re-read now. Exported for tests. */
export async function checkoutGrantOrders(tx: Tx, accessCookie: string | undefined, now: Date): Promise<string[]> {
  // The checkout-grant release switch applies here as in `liveAccess` (review 103 finding 11).
  if (!checkoutGrantsEnabled()) return [];
  const ids = accessCookieGrants(accessCookie, now)
    .filter((g) => g.checkout)
    .map((g) => g.grantId);
  if (!ids.length) return [];
  const rows = await tx.guestCapabilityGrant.findMany({ where: { id: { in: ids }, issuedFor: "checkout", revokedAt: null, expiresAt: { gt: now } }, select: { orderId: true } });
  return [...new Set(rows.map((r) => r.orderId))];
}

/** Candidates read per sign-in. More than this is itself unusual volume: none attach and staff are told. */
export const ATTACH_SCAN_LIMIT = 200;

/**
 * Which limit stopped the attach (re-review 103c D8): `attached`, more than ATTACH_CAP orders passed the per-order
 * checks; `scanned`, more than ATTACH_SCAN_LIMIT candidates were read.
 */
export type AttachCapCause = "attached" | "scanned";

export interface AttachCandidate {
  id: string;
  reference: string;
  leadEmail: string | null;
  quote: { ownerKind: string; guestSessionId: string | null } | null;
  verifications: { id: string; contactHash: string }[];
}

export interface AttachChoice {
  order: AttachCandidate;
  rule: AttachedOrder["rule"];
  verificationId: string;
  recipient: string;
}

/**
 * The per-order checks of the attach rules (pure, exported for tests). The
 * cap of 20 counts the orders that pass them (review 103 finding 12):
 * loose matches that would not attach never block the ones that would.
 */
export function selectAttachable(
  candidates: readonly AttachCandidate[],
  ctx: { verifiedEmail: string | null; guestSessionId: string | null; grantOrderIds: readonly string[] },
): { chosen: AttachChoice[]; capped: false } | { chosen: AttachChoice[]; capped: true; cappedBy: AttachCapCause } {
  if (candidates.length > ATTACH_SCAN_LIMIT) return { chosen: [], capped: true, cappedBy: "scanned" };
  const emailHash = ctx.verifiedEmail ? sha256Hex(ctx.verifiedEmail) : null;
  const chosen: AttachChoice[] = [];
  for (const o of candidates) {
    const byEmail = emailHash ? o.verifications.find((v) => v.contactHash === emailHash) : undefined;
    if (byEmail && ctx.verifiedEmail) {
      chosen.push({ order: o, rule: "verified_email", verificationId: byEmail.id, recipient: ctx.verifiedEmail });
      continue;
    }
    const quoteSession = Boolean(ctx.guestSessionId && o.quote?.ownerKind === "guest" && o.quote.guestSessionId === ctx.guestSessionId);
    const grant = ctx.grantOrderIds.includes(o.id);
    const lead = normaliseEmail(o.leadEmail);
    const leadVerified = lead ? o.verifications.find((v) => v.contactHash === sha256Hex(lead)) : undefined;
    // The notice must reach a verified address: an order whose email was not the one proven is left alone.
    if ((quoteSession || grant) && lead && leadVerified) chosen.push({ order: o, rule: "guest_session", verificationId: leadVerified.id, recipient: lead });
  }
  return chosen.length > ATTACH_CAP ? { chosen: [], capped: true, cappedBy: "attached" } : { chosen, capped: false };
}

/**
 * Runs inside the sign-in transaction. `guestSessionId` must come from the
 * server-side resolution of this request's guest cookie (live), never from a
 * body; `accessCookie` is the raw ticket-access cookie of this request.
 */
export async function attachGuestOrders(
  tx: Tx,
  input: { customer: CustomerRecord; identityId: string; verifiedEmail: string | null; guestSessionId: string | null; accessCookie: string | undefined; actor: Actor; now: Date },
): Promise<AttachResult> {
  const { customer, verifiedEmail, guestSessionId, now } = input;
  const emailHash = verifiedEmail ? sha256Hex(verifiedEmail) : null;
  const grantOrderIds = await checkoutGrantOrders(tx, input.accessCookie, now);

  const sameBrowser = [
    ...(guestSessionId ? [{ quote: { is: { ownerKind: "guest", guestSessionId } } }] : []),
    ...(grantOrderIds.length ? [{ id: { in: grantOrderIds } }] : []),
  ];
  const rules = [...(emailHash ? [{ verifications: { some: { channel: "email", contactHash: emailHash } } }] : []), ...(sameBrowser.length ? [{ AND: [{ OR: sameBrowser }, { verifications: { some: { channel: "email" } } }] }] : [])];
  if (!rules.length) return { attached: [], capped: false };

  const candidates = await tx.order.findMany({
    // Never an order once disputed, and never one that still has an open link (a manual change could leave
    // `customer_id` NULL with a live link; creating a second would abort the whole sign-in; finding 12).
    where: { customerId: null, accountLinks: { none: { OR: [{ detachReason: "not_me" }, { detachedAt: null }] } }, OR: rules },
    select: {
      id: true,
      reference: true,
      leadEmail: true,
      quote: { select: { ownerKind: true, guestSessionId: true } },
      verifications: { where: { channel: "email" }, select: { id: true, contactHash: true } },
    },
    orderBy: { placedAt: "asc" },
    take: ATTACH_SCAN_LIMIT + 1,
  });
  if (!candidates.length) return { attached: [], capped: false };

  const selection = selectAttachable(candidates, { verifiedEmail, guestSessionId, grantOrderIds });
  if (selection.capped) {
    // Unusual volume is a signal, not a convenience: attach none and tell staff (ops-alert `account_attach_capped`),
    // once per customer per UTC day, not on every later sign-in (finding 12).
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const already = await tx.auditLog.count({ where: { entityType: "customer_attach_cap", entityId: customer.id, createdAt: { gte: dayStart } } });
    // The audit row names the limit that fired (re-review 103c D8).
    const candidatesOver = selection.cappedBy === "scanned" ? `>${ATTACH_SCAN_LIMIT}` : `>${ATTACH_CAP}`;
    if (!already) await audit(input.actor, "customer.order_attach_capped", { type: "customer_attach_cap", id: customer.id }, { after: { candidates: candidatesOver, limit: selection.cappedBy } }, tx);
    emitEvent("customer.identity_attach_capped", { customerId: customer.id }, "warn");
    return { attached: [], capped: true };
  }

  const attached: AttachedOrder[] = [];
  for (const { order: o, rule, verificationId, recipient } of selection.chosen) {
    const token = randomToken(32);
    let ciphertext: string | null = null;
    try {
      ciphertext = encryptFor("capability_tokens", token);
    } catch {
      ciphertext = null;
    }
    if (!ciphertext && rule === "guest_session") {
      // Rule (b) attaches to whoever signs in on this browser, and the notice with its "not me" link is the
      // buyer's only control. Without the key ring that link cannot be sent, so the order stays a guest
      // order (review 103 finding 5). Rule (a) is the buyer's own verified address: it still attaches, and
      // its failed notice raises `account_attach_notice_failed` for staff.
      emitEvent("customer.identity_attach_skipped", { reason: "token_unavailable", rule }, "warn");
      continue;
    }

    // Only an order nobody holds moves; a racing sign-in for the same order loses here.
    const moved = await tx.order.updateMany({ where: { id: o.id, customerId: null }, data: { customerId: customer.id } });
    if (moved.count !== 1) continue;

    const linkId = uuidv7();
    await tx.orderAccountLink.create({
      data: {
        id: linkId,
        orderId: o.id,
        customerId: customer.id,
        identityId: input.identityId,
        rule,
        verificationId,
        guestSessionId: rule === "guest_session" && guestSessionId && o.quote?.guestSessionId === guestSessionId ? guestSessionId : null,
        attachedAt: now,
        disputeTokenHash: sha256Hex(token),
        disputeTokenCiphertext: ciphertext,
        disputeExpiresAt: new Date(now.getTime() + DISPUTE_TTL_MS),
      },
    });
    await audit(
      input.actor,
      "customer.order_attached",
      { type: "order", id: o.id },
      { after: { customerId: customer.id, rule, linkId, verificationId, via: rule === "guest_session" ? (guestSessionId && o.quote?.guestSessionId === guestSessionId ? "quote_session" : "checkout_grant") : "verified_email" } },
      tx,
    );
    attached.push({ linkId, orderId: o.id, reference: o.reference, rule, recipient });
  }
  return { attached, capped: false };
}

/* ------------------------------------------------------------ common tail */

export interface SignInOutcome {
  token: string;
  expiresAt: Date;
  customer: CustomerPublic;
  attachedOrders: number;
}

interface TailInput {
  session: SupabaseSession;
  proof: { method: "email_otp"; email: string } | { method: "google"; email: string };
  ip?: string;
  userAgent?: string;
  guestSessionId: string | null;
  accessCookie: string | undefined;
}

export async function completeSignIn(input: TailInput): Promise<SignInOutcome> {
  const cfg = supabaseAuthConfig();
  if (!cfg) throw signInError("NOT_CONFIGURED");
  const accessToken = input.session.accessToken;

  let user: SupabaseUser;
  try {
    const { sub } = await verifySupabaseAccessToken(accessToken, { baseUrl: cfg.baseUrl, keys: jwtKeys });
    user = await client.getUser(accessToken);
    if (user.id !== sub) throw new SupabaseJwtError();
  } catch (err) {
    emitEvent("customer.identity_token_refused", { reason: err instanceof SupabaseAuthError ? err.kind : "jwt" }, "warn");
    throw signInError("UNAVAILABLE");
  } finally {
    // The Supabase session has done its job: revoke its refresh token now, whatever happens next.
    await client.signOut(accessToken);
  }

  const verifiedEmail = decideVerifiedEmail(user, input.proof);
  // Q9 phone linking is off until the Send SMS hook batch (review 103 finding 4).
  const phone = env().CUSTOMER_PHONE_LINK_ENABLED ? confirmedPhone(user) : null;
  const method: SignInMethod = input.proof.method;
  const now = new Date();
  const ipHash = hashIp(input.ip);
  let identityId = "";

  const minted = await mintCustomerSession<AttachResult>({
    subject: {
      method,
      resolve: async (tx) => {
        const emailHash = verifiedEmail ? sha256Hex(verifiedEmail) : null;
        const known = await customerIdentityRepo.findBySubject(user.id, tx);
        if (known) {
          identityId = known.id;
          const row = await tx.customer.findUnique({ where: { id: known.customerId } });
          if (!row) throw signInError("UNAVAILABLE");
          await customerIdentityRepo.touch(known.id, { email: verifiedEmail, emailHash, emailVerifiedAt: verifiedEmail ? now : null, method, now }, tx);
          return { customer: toRecordLike(row), created: false };
        }
        let customer: CustomerRecord | null = null;
        let created = false;
        if (phone) {
          // Q9: an existing phone account is linked only on Supabase's own confirmation of a `phone` identity,
          // and only for a phone sign-in our own start route began (an intent of ours for that number).
          const existing = await tx.customer.findUnique({ where: { phoneE164: phone } });
          if (existing) {
            const ours = await customerIdentityRepo.hasRecentIntent("phone", sha256Hex(phone), new Date(now.getTime() - PHONE_LINK_INTENT_WINDOW_MS), tx);
            if (!ours) emitEvent("customer.identity_phone_link_refused", { reason: "no_intent" }, "warn");
            else {
              if (await customerIdentityRepo.findByCustomer(existing.id, tx)) throw signInError("ACCOUNT_CONFLICT");
              customer = toRecordLike(existing);
            }
          }
        }
        if (!customer) {
          customer = await customerRepo.createWithoutPhone({ email: verifiedEmail }, tx);
          created = true;
        }
        const identity = await customerIdentityRepo.create({ customerId: customer.id, subject: user.id, email: verifiedEmail, emailHash, emailVerifiedAt: verifiedEmail ? now : null, method, now }, tx);
        identityId = identity.id;
        return { customer, created };
      },
      after: async (tx, customer, actor) => {
        if (verifiedEmail && !customer.email) await tx.customer.update({ where: { id: customer.id }, data: { email: verifiedEmail } });
        return attachGuestOrders(tx, { customer, identityId, verifiedEmail, guestSessionId: input.guestSessionId, accessCookie: input.accessCookie, actor, now });
      },
    },
    now,
    sessionDays: env().AUTH_CUSTOMER_SESSION_DAYS,
    ctx: { ipHash, userAgent: input.userAgent },
  });

  const attach = minted.extra ?? { attached: [], capped: false };
  // After commit (finding 5; re-review 103b N4): the notice rows are written now, before the response, so a send
  // that never runs (the function stopped after the response) is still made by the outbox sweep once the row's
  // claim lapses. Only the sends wait until after the response: up to 20 provider calls cannot time out the
  // request after the session and the attach are committed but before the cookie is set. A failed send never
  // undoes the attach: the sweep retries the row, and a notice that fails for good, ends suppressed, or whose row
  // could not be written, raises `account_attach_notice_failed` for staff (account-alerts.ts).
  if (attach.attached.length) {
    const queued: QueuedAccountLinkNotice[] = [];
    for (const a of attach.attached) {
      const q = await notificationService.queueAccountLinkNotice({ linkId: a.linkId, orderId: a.orderId, recipient: a.recipient });
      if (q && !("duplicate" in q)) queued.push(q);
    }
    if (queued.length) {
      lastNotices = new Promise<void>((resolve) =>
        defer("account_link_notices", async () => {
          try {
            for (const q of queued) await notificationService.sendQueuedAccountLinkNotice(q);
          } finally {
            resolve();
          }
        }),
      );
    }
  }

  emitEvent("customer.identity_login", { sessionId: minted.sessionId, method, attached: attach.attached.length, capped: attach.capped, emailVerified: Boolean(verifiedEmail) });
  const customer = minted.customer.email || !verifiedEmail ? minted.customer : { ...minted.customer, email: verifiedEmail };
  return { token: minted.token, expiresAt: minted.expiresAt, customer: toCustomerPublic(customer), attachedOrders: attach.attached.length };
}

/** A deleted customer row still has to be refused by `mintCustomerSession`, which `findById` hides. */
function toRecordLike(row: { id: string; phoneE164: string | null; email: string | null; fullName: string | null; dietary: string | null; hotel: string | null; locale: string; preferredCurrency: CustomerRecord["preferredCurrency"]; createdAt: Date; updatedAt: Date; lastLoginAt: Date | null; deletedAt: Date | null }): CustomerRecord {
  return {
    id: row.id,
    phoneE164: row.phoneE164,
    email: row.email ?? undefined,
    fullName: row.fullName ?? undefined,
    dietary: (row.dietary as CustomerRecord["dietary"]) ?? undefined,
    hotel: row.hotel ?? undefined,
    locale: row.locale,
    preferredCurrency: row.preferredCurrency,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastLoginAt: row.lastLoginAt ?? undefined,
    deletedAt: row.deletedAt ?? undefined,
  };
}

/* ------------------------------------------------------------ service */

function supabaseEnabled(): boolean {
  return customerAuthService.options().emailCode;
}

function googleEnabled(): boolean {
  return customerAuthService.options().google;
}

export const customerIdentityService = {
  /**
   * POST /api/auth/email/start. Order: availability, address, Turnstile, our
   * limits (failing closed), the intent, then Supabase `/otp`, which calls our
   * Send Email hook within the same request. Uniform answer whether or not
   * the address has an account.
   */
  async startEmailCode(input: { email: unknown; turnstileToken?: unknown; ip?: string }): Promise<{ expiresInSeconds: number; resendAfterSeconds: number; startCookie: EmailStartCookieValue }> {
    if (!supabaseEnabled()) throw signInError("NOT_CONFIGURED");
    const email = normaliseEmail(input.email);
    if (!email) throw signInError("EMAIL_INVALID");

    if (turnstileConfigured()) {
      const t = await verifyTurnstile(input.turnstileToken, input.ip);
      if (t !== "ok") throw signInError(t === "unavailable" ? "UNAVAILABLE" : "CAPTCHA_FAILED");
    } else if (env().isProduction) {
      throw signInError("NOT_CONFIGURED");
    }

    const contactHash = sha256Hex(email);
    const ipHash = hashIp(input.ip);
    // One instant for every charge and its release, so they land in the same windows (re-review 103b).
    const now = clock();
    // A refusal says when a limit shared by every customer is the one that refused, and offers Google when it is on.
    const google = googleEnabled();
    const charged: EmailStartLimit[] = [];
    try {
      for (const l of emailStartLimits({ contactHash, ipHash, dailyCap: env().EMAIL_DAILY_SEND_CAP })) {
        await limit(l.key, l.max, l.windowSeconds, { now, extra: { ...(l.scope === "site" ? { scope: "site" as const } : {}), ...(google ? { alternative: "google" as const } : {}) } });
        if (l.scope === "site") charged.push(l);
      }
    } catch (err) {
      // A later limit refused: nothing is sent, so the site-wide charges already taken are given back.
      await releaseSiteCharges(charged, now);
      throw err;
    }

    const answer = { expiresInSeconds: EMAIL_CODE_TTL_SECONDS, resendAfterSeconds: EMAIL_RESEND_AFTER_SECONDS, startCookie: newEmailStartCookie(contactHash, now) };
    if (!pilotAllowsEmail(email)) {
      // Owner-only pilot (CUSTOMER_AUTH_PILOT_EMAILS): an address outside the list is refused silently, with the
      // same answer as a sent code, so the answer says nothing about the list. No intent, no Supabase call; the
      // per-address and per-IP charges stay as for any request, the site-wide ones are given back (nothing sent).
      await releaseSiteCharges(charged, now);
      emitEvent("customer.identity_pilot_refused", { method: "email_otp" }, "warn");
      return answer;
    }

    const intentId = await customerIdentityRepo.createIntent({ channel: "email", contactHash, ipHash, now, ttlMs: INTENT_TTL_MS });
    try {
      // The signup claim lets our Before User Created hook tell this creation from a direct `/signup` (finding 7).
      await client.sendEmailOtp(email, { signupClaim: signupClaimFor(intentId) });
    } catch (err) {
      if (err instanceof SupabaseAuthError && err.timedOut) {
        // Our own 5-second ceiling, not Supabase's answer: the hook may well have sent the code (finding 13).
        // Answer as sent ("check your inbox"); the customer can ask again after the resend wait. The budget
        // stays charged: the code may have gone out.
        emitEvent("customer.identity_email_start_timeout", {}, "warn");
        return answer;
      }
      // Nothing will use this intent now: retire it so a direct call to Supabase cannot spend it (finding 9).
      await customerIdentityRepo.retireIntent(intentId, new Date()).catch(() => {});
      // Only when Supabase's answer proves no code went out are the site-wide hourly limit and daily budget given
      // back (re-review 103b N1, 103c D3); a hook timeout or a 5xx may come after our hook sent the code. The
      // per-address and per-IP charges always stay, so failing requests still cannot be repeated without bound.
      if (otpSentNothing(err)) await releaseSiteCharges(charged, now);
      emitEvent("customer.identity_email_start_failed", { reason: err instanceof SupabaseAuthError ? err.kind : "error" }, "warn");
      // Re-review 103c D1: did our Before User Created hook refuse this very start for a missing signup claim? Then
      // Supabase did not pass our `/otp` `data` on, and every new address is refused: tell staff, loudly.
      if ((await readRateLimitSpan({ key: claimMissingMarkerKey(intentId), windowStart: CLAIM_MISSING_MARKER_START })) > 0) {
        emitEvent("customer.identity_signup_claim_missing", {}, "error");
        await rateLimit({ key: SIGNUP_CLAIM_MISSING_BUCKET, limit: SIGNUP_CLAIM_MISSING_COUNT_LIMIT, windowSeconds: SIGNUP_CLAIM_MISSING_WINDOW_SECONDS, now });
      }
      throw fromSupabase(err, "send");
    }
    emitEvent("customer.identity_email_code_requested", {});
    return answer;
  },

  /** POST /api/auth/email/verify. Single use and expiry are Supabase's; ours are the attempt limits. */
  async verifyEmailCode(input: { email: unknown; code: unknown; startCookie: string | undefined; ip?: string; userAgent?: string; guestSessionId: string | null; accessCookie: string | undefined }): Promise<SignInOutcome> {
    if (!supabaseEnabled()) throw signInError("NOT_CONFIGURED");
    const email = normaliseEmail(input.email);
    if (!email) throw signInError("EMAIL_INVALID");
    const code = typeof input.code === "string" ? input.code.replace(/\s+/g, "") : "";
    if (!/^\d{6}$/.test(code)) throw signInError("CODE_INVALID");

    const addressHash = sha256Hex(email).slice(0, 32);
    // Only the browser that asked for this address's code may try it (finding 8): without the signed start
    // cookie for this address the code is treated as expired, and nothing is counted against the address.
    const started = decodeEmailStartCookie(input.startCookie);
    if (!started || started.addressHash !== addressHash) throw signInError("CODE_EXPIRED");

    const ipHash = hashIp(input.ip);
    const now = clock();
    await limit(`auth_email_verify:ip:${ipHash ?? NO_IP_BUCKET}`, EMAIL_VERIFY_LIMITS.perIp15m, WINDOW_15M, { now });
    // Per start, over the start cookie's whole life (re-review 103b N2): anchored on its issue time and kept past
    // its expiry (plus the decoder's minute of clock skew), so no window edge gives one start a second allowance.
    const startedAt = new Date(started.issuedAt);
    await limitSpan(`auth_email_verify:start:${started.id}`, EMAIL_VERIFY_LIMITS.perStart, startedAt, new Date(started.issuedAt + (EMAIL_START_COOKIE_MAX_AGE_SECONDS + 120) * 1000), now);
    await limit(`auth_email_verify:email:${addressHash}`, EMAIL_VERIFY_LIMITS.perAddress15m, WINDOW_15M, { now });

    let session: SupabaseSession;
    try {
      session = await client.verifyEmailOtp(email, code);
    } catch (err) {
      throw fromSupabase(err, "verify");
    }
    return completeSignIn({ session, proof: { method: "email_otp", email }, ip: input.ip, userAgent: input.userAgent, guestSessionId: input.guestSessionId, accessCookie: input.accessCookie });
  },

  /** GET /api/auth/google/start: the redirect and the cookie value. */
  googleStart(input: { next: string | null; now?: Date; pilot?: boolean }): { url: string; cookie: OAuthCookieValue } {
    const cfg = googleConfig();
    if (!googleEnabled() || !cfg) throw signInError("NOT_CONFIGURED");
    // Owner-only pilot: Google starts only from `/login?pilot=1`; the real gate is the email check on the callback.
    if (pilotActive() && !input.pilot) {
      emitEvent("customer.identity_pilot_refused", { method: "google_start" }, "warn");
      throw signInError("NOT_CONFIGURED");
    }
    const flow = newGoogleFlow();
    const url = googleAuthorizeUrl({ clientId: cfg.clientId, redirectUri: googleRedirectUri(env().NEXT_PUBLIC_SITE_URL), flow });
    return { url, cookie: { ...flow, next: safeNext(input.next), issuedAt: (input.now ?? new Date()).getTime() } };
  },

  /**
   * GET /api/auth/google/callback. Returns where to send the browser: the
   * stored `next` on success, `/login?e=…` otherwise. Details stay in the log
   * as codes; the provider's text never reaches the page.
   */
  async googleCallback(input: {
    query: { code: string | null; state: string | null; error: string | null };
    cookie: OAuthCookieValue | null;
    ip?: string;
    userAgent?: string;
    guestSessionId: string | null;
    accessCookie: string | undefined;
  }): Promise<{ ok: true; next: string; outcome: SignInOutcome } | { ok: false; notice: "google_cancelled" | "google_failed" | "account_closed" | "not_configured" }> {
    const cfg = googleConfig();
    if (!googleEnabled() || !cfg) return { ok: false, notice: "not_configured" };
    const { code, state, error } = input.query;
    if (error) return { ok: false, notice: error === "access_denied" ? "google_cancelled" : "google_failed" };
    const c = input.cookie;
    if (!c || !code || !state || code.length > 2048 || state !== c.state) {
      emitEvent("customer.identity_google_refused", { reason: !c ? "no_cookie" : "state" }, "warn");
      return { ok: false, notice: "google_failed" };
    }
    try {
      await limit(`auth_google_callback:ip:${hashIp(input.ip) ?? NO_IP_BUCKET}`, 30, WINDOW_15M);
      const redirectUri = googleRedirectUri(env().NEXT_PUBLIC_SITE_URL);
      const idToken = await exchangeGoogleCode({ code, verifier: c.verifier, redirectUri, clientId: cfg.clientId, clientSecret: cfg.clientSecret });
      const google = await verifyGoogleIdToken(idToken, { clientId: cfg.clientId, rawNonce: c.nonce });
      // Owner-only pilot: a Google email outside the list stops here, before Supabase or our tail can create or
      // link anything.
      if (!pilotAllowsEmail(google.email)) {
        emitEvent("customer.identity_pilot_refused", { method: "google" }, "warn");
        return { ok: false, notice: "not_configured" };
      }
      const session = await client.signInWithGoogleIdToken(idToken, c.nonce);
      const outcome = await completeSignIn({ session, proof: { method: "google", email: google.email }, ip: input.ip, userAgent: input.userAgent, guestSessionId: input.guestSessionId, accessCookie: input.accessCookie });
      return { ok: true, next: c.next, outcome };
    } catch (err) {
      const reason = err instanceof GoogleOAuthError ? err.reason : err instanceof SupabaseAuthError ? `supabase_${err.kind}` : (reasonOf(err) ?? "error");
      emitEvent("customer.identity_google_failed", { reason }, "warn");
      if (reasonOf(err) === "ACCOUNT_CLOSED") return { ok: false, notice: "account_closed" };
      return { ok: false, notice: "google_failed" };
    }
  },

  /* ---------------------------------------------------------------- hooks */

  /**
   * Send Email hook (Supabase → us). Sends only a sign-in code, only for an
   * intent our start route wrote for this address (consumed here, single
   * use), through the existing Resend adapter. Returns false when nothing was
   * sent; the route answers Supabase with an error then.
   */
  async handleSendEmailHook(payload: SendEmailHookPayload, webhookId: string): Promise<"sent" | "suppressed" | "refused" | "failed"> {
    if (!SIGN_IN_EMAIL_ACTIONS.includes(payload.actionType)) {
      emitEvent("customer.identity_hook_refused", { hook: "send_email", reason: "action_type", actionType: payload.actionType }, "warn");
      return "refused";
    }
    const email = normaliseEmail(payload.email);
    if (!email) return "refused";
    // Replay of the same delivery: refused before any intent is touched.
    const claim = await rateLimit({ key: `auth_hook:send_email:${sha256Hex(webhookId).slice(0, 32)}`, limit: 1, windowSeconds: 900 });
    if (!claim.allowed) {
      emitEvent("customer.identity_hook_refused", { hook: "send_email", reason: claim.storeUnavailable ? "store_unavailable" : "replay" }, "warn");
      return "refused";
    }
    const now = new Date();
    const intent = await customerIdentityRepo.consumeIntent("email", sha256Hex(email), now);
    if (!intent) {
      emitEvent("customer.identity_hook_refused", { hook: "send_email", reason: "no_intent" }, "warn");
      return "refused";
    }
    const e = env();
    if (e.isNonProduction && emailAdapter.provider() !== "log" && !isRecipientAllowed(email, e.recipientAllowlist)) {
      emitEvent("customer.identity_code_suppressed", { reason: "non_production_allowlist" });
      return "suppressed";
    }
    const msg = renderSignInCode({ code: payload.token, ttlMinutes: EMAIL_CODE_TTL_SECONDS / 60, supportEmail: e.NEXT_PUBLIC_SUPPORT_EMAIL ?? e.EMAIL_REPLY_TO });
    const idempotencyKey = `signin-${sha256Hex(webhookId).slice(0, 40)}`;
    const out = { to: email, subject: msg.subject!, html: msg.html!, text: msg.text };
    // One attempt with a 3-second ceiling: this runs inside Supabase's hook timeout and our own 5-second `/otp`
    // call (finding 13). `unknown` (timeout) counts as sent: Resend may have it, and the customer can ask again.
    const outcome = await emailAdapter.send(out, { idempotencyKey, timeoutMs: SEND_EMAIL_HOOK_RESEND_TIMEOUT_MS });
    if (outcome.kind === "failed") {
      emitEvent("customer.identity_code_failed", { reason: outcome.reason, httpStatus: outcome.httpStatus }, "warn");
      return "failed";
    }
    await customerIdentityRepo.countEmailSend("signin_code", now);
    emitEvent("customer.identity_code_sent", { outcome: outcome.kind, provider: emailAdapter.provider() });
    return "sent";
  },

  /**
   * Before User Created hook (plan 92 §2.1): Supabase may create a user only
   * for a Google sign-in, or for an email address with a recent intent from
   * our own start route whose signup claim the new user carries (re-review
   * 103b, finding 7). Password sign-ups, phone users and junk calls to the
   * public endpoints are refused at creation.
   *
   * Re-review 103c: any unexpired intent of that address created in the last
   * two minutes may match, not only the newest (D2: a second start must not
   * refuse the creation of the first); a refusal says `claim_missing` (no
   * claim at all, and the hook leaves a marker on each recent intent so our
   * own start can raise the staff alert) or `claim_mismatch` (D1). With
   * CUSTOMER_SIGNUP_CLAIM_RELAXED on, the claim is not compared, but a live
   * (unconsumed) intent of ours from the last two minutes is still required
   * and its single creation is still spent.
   */
  async handleBeforeUserCreatedHook(payload: BeforeUserCreatedPayload): Promise<"allow" | "reject"> {
    if (payload.provider === "google" && payload.email) return "allow";
    const provider = payload.provider ?? "none";
    if (payload.provider === "email" || (!payload.provider && payload.email)) {
      const email = normaliseEmail(payload.email);
      const now = new Date();
      const recent = email ? await customerIdentityRepo.findRecentIntents("email", sha256Hex(email), now, new Date(now.getTime() - INTENT_TTL_MS)) : [];
      if (recent.length) {
        // Only the creation our own start route asked for (re-review 103b, finding 7): its `/otp` carried the claim
        // of one of these intents in `user_metadata`. A direct Supabase `/signup` racing our start for the same
        // address does not have it and is refused, whoever arrives first.
        const given = payload.signupClaim;
        const matched = given ? recent.find((i) => sameClaim(given, signupClaimFor(i.id))) : undefined;
        let intentId = matched?.id ?? null;
        if (!intentId) {
          const reason = given ? "claim_mismatch" : "claim_missing";
          const live = env().CUSTOMER_SIGNUP_CLAIM_RELAXED ? recent.find((i) => !i.consumed) : undefined;
          if (!live) {
            if (reason === "claim_missing") {
              // A marker per recent intent: if one of them is our own start's, that start reads it after its `/otp`
              // fails and alerts staff (signup-claim-alert.ts). Best effort; it grants nothing.
              for (const i of recent) await rateLimitSpan({ key: claimMissingMarkerKey(i.id), limit: SIGNUP_CLAIM_MISSING_COUNT_LIMIT, windowStart: CLAIM_MISSING_MARKER_START, expiresAt: new Date(now.getTime() + CLAIM_MISSING_MARKER_TTL_MS), now });
            }
            emitEvent("customer.identity_hook_refused", { hook: "before_user_created", reason, provider }, "warn");
            return "reject";
          }
          emitEvent("customer.identity_signup_claim_relaxed", { reason }, "warn");
          intentId = live.id;
        }
        // And once per intent: a replayed or repeated call is refused. The key is unique to the intent, so it is
        // one span that no window edge resets (re-review 103b), kept well past the intent's two minutes. Fails closed.
        const claim = await rateLimitSpan({ key: `auth_hook:before_create:${intentId}`, limit: 1, windowStart: new Date(0), expiresAt: new Date(now.getTime() + 3_600_000), now });
        if (claim.allowed) return "allow";
        emitEvent("customer.identity_hook_refused", { hook: "before_user_created", reason: claim.storeUnavailable ? "store_unavailable" : "claimed", provider }, "warn");
        return "reject";
      }
    }
    emitEvent("customer.identity_hook_refused", { hook: "before_user_created", reason: "no_intent", provider }, "warn");
    return "reject";
  },

  /* ---------------------------------------------------------------- "not me" */

  /**
   * POST /api/orders/account-link/dispute (owner Q-B4): detach the order
   * from the account it was attached to and alert staff. No sign-out, no
   * closure: staff decide. The answer is the same for a valid, used, expired
   * or unknown token.
   */
  async dispute(input: { token: unknown; ip?: string; userAgent?: string }): Promise<void> {
    const ipHash = hashIp(input.ip);
    await enforceRateLimit({ key: `account_link_dispute:ip:${ipHash ?? NO_IP_BUCKET}`, limit: 10, windowSeconds: WINDOW_15M });
    await enforceRateLimit({ key: "account_link_dispute:global", limit: 300, windowSeconds: WINDOW_1H });
    const token = typeof input.token === "string" ? input.token : "";
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return;
    const now = new Date();
    const hash = sha256Hex(token);
    const actor: Actor = { ...customerActor({ ipHash, userAgent: input.userAgent }) };
    const done = await prisma.$transaction(async (tx) => {
      const link = await tx.orderAccountLink.findUnique({ where: { disputeTokenHash: hash }, select: { id: true, orderId: true, customerId: true, detachedAt: true, disputeExpiresAt: true, rule: true } });
      if (!link || link.detachedAt || !link.disputeExpiresAt || link.disputeExpiresAt.getTime() <= now.getTime()) return false;
      const marked = await tx.orderAccountLink.updateMany({ where: { id: link.id, detachedAt: null }, data: { detachedAt: now, detachReason: "not_me", disputeTokenCiphertext: null } });
      if (marked.count !== 1) return false;
      // Only if it is still that account's: a staff change since then is not undone.
      const cleared = await tx.order.updateMany({ where: { id: link.orderId, customerId: link.customerId }, data: { customerId: null } });
      await audit(actor, "customer.order_detached", { type: "order", id: link.orderId }, { before: { customerId: link.customerId }, after: { reason: "not_me", linkId: link.id, rule: link.rule, cleared: cleared.count === 1 } }, tx);
      return true;
    });
    emitEvent("customer.identity_dispute", { applied: done });
  },
};
