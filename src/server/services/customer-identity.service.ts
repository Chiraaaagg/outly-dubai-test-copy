import "server-only";
import { prisma, type Tx } from "../lib/db";
import { env } from "../lib/env";
import { AppError, isAppError } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { emitEvent } from "../lib/structured-events";
import { encryptFor, hashIp, randomToken, sha256Hex } from "../lib/crypto";
import { enforceRateLimit, rateLimit } from "../lib/rate-limit";
import { audit } from "../lib/audit";
import { customerActor, type Actor } from "../lib/actor";
import { safeNext } from "@/lib/safe-next";
import { EMAIL_CODE_TTL_SECONDS, EMAIL_RESEND_AFTER_SECONDS, normaliseEmail, type SignInReason } from "@/lib/customer-auth-options";
import { normalisePhone } from "../domain/phone";
import { accessCookieGrants } from "./capability.service";
import { customerAuthService, mintCustomerSession, toCustomerPublic, type CustomerPublic } from "./customer-auth.service";
import { notificationService } from "./notification.service";
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
 *     (Q9), or a phone-less customer is created; a closed account is refused;
 *     the attach rules run (`attachGuestOrders`); the OUTLYY session row is
 *     written;
 *  4. after commit, one notice email per attached order.
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
 * most 20 per sign-in (more attaches none and alerts staff).
 *
 * Staff authentication (`authService`, admin cookies) is not referenced here.
 */

export const ATTACH_CAP = 20;
export const DISPUTE_TTL_MS = 30 * 24 * 3600_000;
/** Intents live just long enough for Supabase to call the hook during our own `/otp` request. */
export const INTENT_TTL_MS = 2 * 60_000;

const NO_IP_BUCKET = "none";
const WINDOW_15M = 900;
const WINDOW_1H = 3600;

/* ------------------------------------------------------------ test seams */

let client: SupabaseAuthClient = supabaseAuthClient;
let jwtKeys: JWTVerifyGetKey | undefined;

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

export function signInError(reason: SignInReason, retryAfterSeconds?: number): AppError {
  const s = STATUS[reason];
  return new AppError({ status: s.status, code: s.code, message: s.message, retryable: s.retryable, details: { reason, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) } });
}

export function reasonOf(err: unknown): SignInReason | null {
  const r = isAppError(err) ? err.details?.reason : undefined;
  return typeof r === "string" ? (r as SignInReason) : null;
}

/** Postgres limits, failing closed, re-thrown as sign-in reasons. */
async function limit(key: string, max: number, windowSeconds: number) {
  try {
    await enforceRateLimit({ key, limit: max, windowSeconds });
  } catch (err) {
    if (isAppError(err) && err.code === "RATE_LIMITED") throw signInError("RATE_LIMITED", Number(err.details?.retryAfterSeconds) || windowSeconds);
    throw signInError("UNAVAILABLE");
  }
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

/** A phone Supabase confirmed, as E.164, or null. Only used to link an existing phone account (Q9). */
export function confirmedPhone(user: SupabaseUser): string | null {
  if (!user.phone || !user.phoneConfirmedAt) return null;
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

/** The browser's live checkout grants, from the signed access cookie, re-read now. */
async function checkoutGrantOrders(tx: Tx, accessCookie: string | undefined, now: Date): Promise<string[]> {
  const ids = accessCookieGrants(accessCookie, now)
    .filter((g) => g.checkout)
    .map((g) => g.grantId);
  if (!ids.length) return [];
  const rows = await tx.guestCapabilityGrant.findMany({ where: { id: { in: ids }, issuedFor: "checkout", revokedAt: null, expiresAt: { gt: now } }, select: { orderId: true } });
  return [...new Set(rows.map((r) => r.orderId))];
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
    where: { customerId: null, accountLinks: { none: { detachReason: "not_me" } }, OR: rules },
    select: {
      id: true,
      reference: true,
      leadEmail: true,
      quote: { select: { ownerKind: true, guestSessionId: true } },
      verifications: { where: { channel: "email" }, select: { id: true, contactHash: true } },
    },
    orderBy: { placedAt: "asc" },
    take: ATTACH_CAP + 1,
  });
  if (!candidates.length) return { attached: [], capped: false };

  if (candidates.length > ATTACH_CAP) {
    // Unusual volume is a signal, not a convenience: attach none and tell staff (ops-alert `account_attach_capped`).
    await audit(input.actor, "customer.order_attach_capped", { type: "customer_attach_cap", id: customer.id }, { after: { candidates: `>${ATTACH_CAP}` } }, tx);
    emitEvent("customer_identity.attach_capped", { customerId: customer.id }, "warn");
    return { attached: [], capped: true };
  }

  const attached: AttachedOrder[] = [];
  for (const o of candidates) {
    let rule: AttachedOrder["rule"] | null = null;
    let verificationId: string | null = null;
    let recipient: string | null = null;

    const byEmail = emailHash ? o.verifications.find((v) => v.contactHash === emailHash) : undefined;
    if (byEmail && verifiedEmail) {
      rule = "verified_email";
      verificationId = byEmail.id;
      recipient = verifiedEmail;
    } else {
      const quoteSession = Boolean(guestSessionId && o.quote?.ownerKind === "guest" && o.quote.guestSessionId === guestSessionId);
      const grant = grantOrderIds.includes(o.id);
      const lead = normaliseEmail(o.leadEmail);
      const leadVerified = lead ? o.verifications.find((v) => v.contactHash === sha256Hex(lead)) : undefined;
      // The notice must reach a verified address: an order whose email was not the one proven is left alone.
      if ((quoteSession || grant) && lead && leadVerified) {
        rule = "guest_session";
        verificationId = leadVerified.id;
        recipient = lead;
      }
    }
    if (!rule || !recipient) continue;

    // Only an order nobody holds moves; a racing sign-in for the same order loses here.
    const moved = await tx.order.updateMany({ where: { id: o.id, customerId: null }, data: { customerId: customer.id } });
    if (moved.count !== 1) continue;

    const token = randomToken(32);
    let ciphertext: string | null = null;
    try {
      ciphertext = encryptFor("capability_tokens", token);
    } catch {
      // No key ring here: the notice cannot carry a working link and fails definitely; the attach and the audit stand.
      ciphertext = null;
    }
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
    emitEvent("customer_identity.token_refused", { reason: err instanceof SupabaseAuthError ? err.kind : "jwt" }, "warn");
    throw signInError("UNAVAILABLE");
  } finally {
    // The Supabase session has done its job: revoke its refresh token now, whatever happens next.
    await client.signOut(accessToken);
  }

  const verifiedEmail = decideVerifiedEmail(user, input.proof);
  const phone = confirmedPhone(user);
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
          // Q9: an existing phone account is linked only on Supabase's own phone confirmation.
          const existing = await tx.customer.findUnique({ where: { phoneE164: phone } });
          if (existing) {
            if (await customerIdentityRepo.findByCustomer(existing.id, tx)) throw signInError("ACCOUNT_CONFLICT");
            customer = toRecordLike(existing);
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
  // After commit: one notice per attach. A failed send never undoes the attach (the sweep retries the row).
  for (const a of attach.attached) await notificationService.sendAccountLinkNotice({ linkId: a.linkId, orderId: a.orderId, recipient: a.recipient });

  emitEvent("customer_identity.login", { sessionId: minted.sessionId, method, attached: attach.attached.length, capped: attach.capped, emailVerified: Boolean(verifiedEmail) });
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
  async startEmailCode(input: { email: unknown; turnstileToken?: unknown; ip?: string }): Promise<{ expiresInSeconds: number; resendAfterSeconds: number }> {
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
    await limit(`auth_email_start:email:${contactHash.slice(0, 32)}`, 3, WINDOW_15M);
    await limit(`auth_email_start:ip:${ipHash ?? NO_IP_BUCKET}`, 10, WINDOW_1H);
    await limit("auth_email_start:global", 300, WINDOW_1H);

    await customerIdentityRepo.createIntent({ channel: "email", contactHash, ipHash, now: new Date(), ttlMs: INTENT_TTL_MS });
    try {
      await client.sendEmailOtp(email);
    } catch (err) {
      emitEvent("customer_identity.email_start_failed", { reason: err instanceof SupabaseAuthError ? err.kind : "error" }, "warn");
      throw fromSupabase(err, "send");
    }
    emitEvent("customer_identity.email_code_requested", {});
    return { expiresInSeconds: EMAIL_CODE_TTL_SECONDS, resendAfterSeconds: EMAIL_RESEND_AFTER_SECONDS };
  },

  /** POST /api/auth/email/verify. Single use and expiry are Supabase's; ours are the attempt limits. */
  async verifyEmailCode(input: { email: unknown; code: unknown; ip?: string; userAgent?: string; guestSessionId: string | null; accessCookie: string | undefined }): Promise<SignInOutcome> {
    if (!supabaseEnabled()) throw signInError("NOT_CONFIGURED");
    const email = normaliseEmail(input.email);
    if (!email) throw signInError("EMAIL_INVALID");
    const code = typeof input.code === "string" ? input.code.replace(/\s+/g, "") : "";
    if (!/^\d{6}$/.test(code)) throw signInError("CODE_INVALID");

    const ipHash = hashIp(input.ip);
    await limit(`auth_email_verify:ip:${ipHash ?? NO_IP_BUCKET}`, 30, WINDOW_15M);
    await limit(`auth_email_verify:email:${sha256Hex(email).slice(0, 32)}`, 10, WINDOW_15M);

    let session: SupabaseSession;
    try {
      session = await client.verifyEmailOtp(email, code);
    } catch (err) {
      throw fromSupabase(err, "verify");
    }
    return completeSignIn({ session, proof: { method: "email_otp", email }, ip: input.ip, userAgent: input.userAgent, guestSessionId: input.guestSessionId, accessCookie: input.accessCookie });
  },

  /** GET /api/auth/google/start: the redirect and the cookie value. */
  googleStart(input: { next: string | null; now?: Date }): { url: string; cookie: OAuthCookieValue } {
    const cfg = googleConfig();
    if (!googleEnabled() || !cfg) throw signInError("NOT_CONFIGURED");
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
      emitEvent("customer_identity.google_refused", { reason: !c ? "no_cookie" : "state" }, "warn");
      return { ok: false, notice: "google_failed" };
    }
    try {
      await limit(`auth_google_callback:ip:${hashIp(input.ip) ?? NO_IP_BUCKET}`, 30, WINDOW_15M);
      const redirectUri = googleRedirectUri(env().NEXT_PUBLIC_SITE_URL);
      const idToken = await exchangeGoogleCode({ code, verifier: c.verifier, redirectUri, clientId: cfg.clientId, clientSecret: cfg.clientSecret });
      const google = await verifyGoogleIdToken(idToken, { clientId: cfg.clientId, rawNonce: c.nonce });
      const session = await client.signInWithGoogleIdToken(idToken, c.nonce);
      const outcome = await completeSignIn({ session, proof: { method: "google", email: google.email }, ip: input.ip, userAgent: input.userAgent, guestSessionId: input.guestSessionId, accessCookie: input.accessCookie });
      return { ok: true, next: c.next, outcome };
    } catch (err) {
      const reason = err instanceof GoogleOAuthError ? err.reason : err instanceof SupabaseAuthError ? `supabase_${err.kind}` : (reasonOf(err) ?? "error");
      emitEvent("customer_identity.google_failed", { reason }, "warn");
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
      emitEvent("customer_identity.hook_refused", { hook: "send_email", reason: "action_type", actionType: payload.actionType }, "warn");
      return "refused";
    }
    const email = normaliseEmail(payload.email);
    if (!email) return "refused";
    // Replay of the same delivery: refused before any intent is touched.
    const claim = await rateLimit({ key: `auth_hook:send_email:${sha256Hex(webhookId).slice(0, 32)}`, limit: 1, windowSeconds: 900 });
    if (!claim.allowed) {
      emitEvent("customer_identity.hook_refused", { hook: "send_email", reason: claim.storeUnavailable ? "store_unavailable" : "replay" }, "warn");
      return "refused";
    }
    const now = new Date();
    const intent = await customerIdentityRepo.consumeIntent("email", sha256Hex(email), now);
    if (!intent) {
      emitEvent("customer_identity.hook_refused", { hook: "send_email", reason: "no_intent" }, "warn");
      return "refused";
    }
    const e = env();
    if (e.isNonProduction && emailAdapter.provider() !== "log" && !isRecipientAllowed(email, e.recipientAllowlist)) {
      emitEvent("customer_identity.code_suppressed", { reason: "non_production_allowlist" });
      return "suppressed";
    }
    const msg = renderSignInCode({ code: payload.token, ttlMinutes: EMAIL_CODE_TTL_SECONDS / 60, supportEmail: e.NEXT_PUBLIC_SUPPORT_EMAIL ?? e.EMAIL_REPLY_TO });
    const idempotencyKey = `signin-${sha256Hex(webhookId).slice(0, 40)}`;
    const out = { to: email, subject: msg.subject!, html: msg.html!, text: msg.text };
    let outcome = await emailAdapter.send(out, { idempotencyKey });
    if (outcome.kind === "unknown") outcome = await emailAdapter.send(out, { idempotencyKey });
    if (outcome.kind === "failed") {
      emitEvent("customer_identity.code_failed", { reason: outcome.reason, httpStatus: outcome.httpStatus }, "warn");
      return "failed";
    }
    await customerIdentityRepo.countEmailSend("signin_code", now);
    emitEvent("customer_identity.code_sent", { outcome: outcome.kind, provider: emailAdapter.provider() });
    return "sent";
  },

  /**
   * Before User Created hook (plan 92 §2.1): Supabase may create a user only
   * for a Google sign-in, or for an email address with a live intent from our
   * own start route. Password sign-ups, phone users and junk calls to the
   * public endpoints are refused at creation.
   */
  async handleBeforeUserCreatedHook(payload: BeforeUserCreatedPayload): Promise<"allow" | "reject"> {
    if (payload.provider === "google" && payload.email) return "allow";
    if (payload.provider === "email" || (!payload.provider && payload.email)) {
      const email = normaliseEmail(payload.email);
      if (email && (await customerIdentityRepo.hasLiveIntent("email", sha256Hex(email), new Date()))) return "allow";
    }
    emitEvent("customer_identity.hook_refused", { hook: "before_user_created", reason: "no_intent", provider: payload.provider ?? "none" }, "warn");
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
    emitEvent("customer_identity.dispute", { applied: done });
  },
};
