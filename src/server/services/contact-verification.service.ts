import "server-only";
import { randomInt } from "node:crypto";
import { prisma, TX_OPTIONS, type Tx } from "../lib/db";
import { env } from "../lib/env";
import { Errors } from "../lib/errors";
import { log } from "../lib/logger";
import { uuidv7 } from "../lib/ids";
import { hashIp, safeEqual, sha256Hex } from "../lib/crypto";
import { enforceRateLimit, rateLimit } from "../lib/rate-limit";
import { normalisePhone } from "../domain/phone";
import {
  evaluateChallenge,
  generateOtpCode,
  hashOtp,
  isValidOtpFormat,
  normaliseOtpInput,
  otpExpiresAt,
} from "../domain/otp";
import { smsAdapter, smsMode } from "../sms/registry";
import { emailAdapter } from "../notifications/email.adapter";
import { isRecipientAllowed } from "../notifications/allowlist";
import { customerRepo } from "../repositories/customer.repo";
import { guestSessionService } from "./guest-session.service";
import type { ContactVerification, ContactVerificationService, QuoteSnapshot } from "../quotes/contracts";

/**
 * Order-bound contact verification (doc 22 §23 B2, TKT-4, F54, F57).
 *
 * Proves that the person checking out controls one phone or email, for one
 * quote and its owner, before any payment. It never creates or reads a
 * customer account; linking an order to an account stays a separate step.
 *
 *  - Challenges reuse `otp_challenges` and the OTP domain rules (six digits,
 *    SHA-256(challenge:code), TTL, attempt cap, single use). The row's
 *    `phone_e164` holds a subject `ocv:v1:<quoteId>:<channel>:<contactHash>`,
 *    never the contact, and customer sign-in refuses any challenge whose
 *    subject is not an E.164 number.
 *  - The verification row stores only the contact's SHA-256; the contact
 *    itself lives on the order. One row per quote and channel; a later
 *    verification on the same quote replaces it until an order is bound.
 *  - `start` always answers `{ challengeId }`. An unknown quote, another
 *    owner's quote or an inactive quote gets a decoy id and nothing is sent.
 *    `verify` answers `invalid` for every mismatch it does not need to name.
 *  - Rate limits fail closed. Per IP and per owner come first, so random
 *    traffic spends its own budget before it can touch the global counters.
 *    Per quote and per contact are charged only for the caller's own live
 *    quote, so a decoy request costs a victim nothing. The per-contact budget
 *    is checkout's own and never spends the sign-in budget for a phone.
 *  - Delivery uses the configured SMS and email adapters (`deliverChallengeCode`,
 *    shared with order recovery). Email takes the adapter's idempotent path
 *    with the challenge id as the provider idempotency key (TKT-6); the code
 *    is never stored in a notification payload. Outside production a real
 *    provider sends only to the recipient allowlist; the log adapters never
 *    deliver. In production a channel without a real provider refuses. A
 *    definite send failure retires the code and the caller offers the
 *    inquiry route (F57); an unknown email outcome keeps it usable.
 *  - `bindToOrder` attaches the verification to the order created from the
 *    quote, in the order's transaction.
 */

type Db = Tx | typeof prisma;
type Owner = QuoteSnapshot["owner"];
type Channel = ContactVerification["channel"];

const SUBJECT_PREFIX = "ocv:v1:";

const START_PER_IP_LIMIT = 20;
const START_PER_OWNER_LIMIT = 10;
const START_GLOBAL_LIMIT = 300;
const START_PER_QUOTE_LIMIT = 5;
const VERIFY_PER_IP_LIMIT = 30;
const VERIFY_PER_OWNER_LIMIT = 30;
const VERIFY_GLOBAL_LIMIT = 1_000;
const VERIFY_PER_QUOTE_LIMIT = 15;
const WINDOW_SECONDS = 900;
/** Callers without a client IP share one bucket, so a missing IP is never unlimited. */
const NO_IP_BUCKET = "none";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** sha256 hex of the normalised contact: E.164 for a phone, trimmed lower case for an email. */
export function contactHash(normalised: string): string {
  return sha256Hex(normalised);
}

export function normaliseContact(channel: Channel, contact: string): string | null {
  const raw = contact.trim();
  if (channel === "phone") {
    if (!raw.startsWith("+")) return null;
    const phone = normalisePhone(raw);
    return phone.valid ? phone.e164 : null;
  }
  const email = raw.toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

function subjectFor(quoteId: string, channel: Channel, hash: string): string {
  return `${SUBJECT_PREFIX}${quoteId.toLowerCase()}:${channel}:${hash}`;
}

function parseSubject(subject: string): { quoteId: string; channel: Channel; contactHash: string } | null {
  if (!subject.startsWith(SUBJECT_PREFIX)) return null;
  const [quoteId, channel, hash] = subject.slice(SUBJECT_PREFIX.length).split(":");
  if (!quoteId || !UUID.test(quoteId) || (channel !== "phone" && channel !== "email") || !/^[0-9a-f]{64}$/.test(hash ?? "")) return null;
  return { quoteId, channel, contactHash: hash };
}

/** True when a customer sign-in challenge row actually belongs to contact verification. */
export function isVerificationChallengeSubject(subject: string): boolean {
  return subject.startsWith(SUBJECT_PREFIX);
}

function ipKey(ip: string | null | undefined): string {
  return hashIp(ip) ?? NO_IP_BUCKET;
}

function ownerKey(owner: Owner): string {
  return owner.kind === "customer" ? `customer:${owner.customerId}` : `guest:${owner.guestSessionId}`;
}

function methodFor(channel: Channel): ContactVerification["method"] {
  return channel === "phone" ? "otp_sms" : "email_code";
}

/** The quote, when it exists, belongs to this owner and is still active. */
async function ownedActiveQuote(quoteId: string, owner: Owner, now: Date, db: Db = prisma) {
  if (!UUID.test(quoteId)) return null;
  const quote = await db.quote.findUnique({
    where: { id: quoteId },
    select: { id: true, ownerKind: true, customerId: true, guestSessionId: true, status: true, expiresAt: true },
  });
  if (!quote) return null;
  const owned =
    owner.kind === "customer"
      ? quote.ownerKind === "customer" && quote.customerId === owner.customerId
      : quote.ownerKind === "guest" && quote.guestSessionId === owner.guestSessionId;
  if (!owned) return null;
  if (owner.kind === "guest" && !(await guestSessionService.isLive(owner.guestSessionId, now, db))) return null;
  return { ...quote, live: quote.status === "active" && quote.expiresAt.getTime() > now.getTime() };
}

/** Whether this channel can deliver a code here: in production only through a real provider. Shared with recovery. */
export function deliveryReady(channel: Channel): boolean {
  if (!env().isProduction) return true;
  return channel === "phone" ? smsMode() === "msg91" : emailAdapter.provider() === "resend";
}

/** Outside production a real provider sends only to the allowlist; the log adapters never deliver. */
function suppressed(channel: Channel, recipient: string): boolean {
  const e = env();
  if (!e.isNonProduction) return false;
  const real = channel === "phone" ? smsAdapter().provider !== "log" : emailAdapter.provider() !== "log";
  return real && !isRecipientAllowed(recipient, e.recipientAllowlist);
}

/**
 * What became of one code's delivery:
 *  - `sent`: the provider accepted it;
 *  - `suppressed`: nothing was sent (a real provider outside production, recipient not allowlisted);
 *  - `unknown`: the email provider may have accepted it (timeout, 5xx); the code stays usable;
 *  - `failed`: definitely not sent; the caller retires the code (F57).
 */
export type ChallengeDelivery = "sent" | "suppressed" | "unknown" | "failed";

/**
 * Delivers one verification code, for checkout (`ocv:`) and order recovery
 * (`rcv:`) alike. Email goes through the adapter's idempotent path with the
 * challenge id as the provider idempotency key, so a retry inside the
 * provider's window can never send a second email; an `unknown` answer is
 * re-sent once under the same key with the identical body. The code is a
 * secret: it is rendered into the message here and never stored in a
 * notification row, an event or a log. SMS keeps the adapter's own send,
 * which throws on failure. Never throws.
 */
export async function deliverChallengeCode(input: { challengeId: string; channel: Channel; recipient: string; code: string; ttlSeconds: number }): Promise<ChallengeDelivery> {
  const { challengeId, channel, recipient, code } = input;
  if (suppressed(channel, recipient)) return "suppressed";
  const ttlMinutes = Math.max(1, Math.round(input.ttlSeconds / 60));
  try {
    if (channel === "phone") {
      await smsAdapter().sendOtp({ to: recipient, code, ttlMinutes });
      return "sent";
    }
    const msg = {
      to: recipient,
      subject: "Your OUTLYY verification code",
      text: `Your OUTLYY verification code is ${code}. It expires in ${ttlMinutes} minutes. If you did not ask for it, ignore this email.`,
      html: `<p>Your OUTLYY verification code is <strong>${code}</strong>.</p><p>It expires in ${ttlMinutes} minutes. If you did not ask for it, ignore this email.</p>`,
    };
    let outcome = await emailAdapter.send(msg, { idempotencyKey: challengeId });
    // Same key and same body: the provider answers the first request, so this can never be a second email.
    if (outcome?.kind === "unknown") outcome = await emailAdapter.send(msg, { idempotencyKey: challengeId });
    if (outcome?.kind === "sent") return "sent";
    if (outcome?.kind === "unknown") {
      log.warn("contact_verification.send_unknown", { challengeId, reason: outcome.reason });
      return "unknown";
    }
    log.warn("contact_verification.send_failed", { challengeId, channel, reason: outcome?.kind === "failed" ? outcome.reason : "bad_outcome" });
    return "failed";
  } catch {
    // The adapter logged the provider failure.
    return "failed";
  }
}

function toContract(row: { id: string; quoteId: string; channel: string; contactHash: string; method: string; verifiedAt: Date }): ContactVerification {
  return {
    verificationId: row.id,
    quoteId: row.quoteId,
    channel: row.channel as Channel,
    contactHash: row.contactHash,
    method: row.method as ContactVerification["method"],
    verifiedAt: row.verifiedAt.toISOString(),
  };
}

/**
 * Retires a challenge whose code was never delivered (F57). The time is never
 * before the row's own `created_at` (otp_challenge_consumed_after_created), even
 * if the clock steps back. One retry covers a transient database error, such
 * as no free pool connection under load; a failure is logged, never swallowed.
 */
export async function retireUnsent(id: string, createdAt: Date): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const at = new Date(Math.max(Date.now(), createdAt.getTime()));
    try {
      // False means the row was already consumed, which is the outcome wanted.
      await customerRepo.consumeChallenge(id, at);
      return;
    } catch (error) {
      if (attempt === 2) log.error("contact_verification.retire_failed", { challengeId: id, error });
    }
  }
}

class RefusedInTx extends Error {
  constructor(readonly refusal: "invalid" | "expired") {
    super(refusal);
  }
}

type StartInput = Parameters<ContactVerificationService["start"]>[0] & { ip: string | null };
type VerifyInput = Parameters<ContactVerificationService["verify"]>[0] & { ip: string | null };

/** The contract's start/verify plus the client IP, which the route must pass (null only when the request has none). */
export const contactVerificationService: Omit<ContactVerificationService, "start" | "verify"> & {
  start(input: StartInput): ReturnType<ContactVerificationService["start"]>;
  verify(input: VerifyInput): ReturnType<ContactVerificationService["verify"]>;
  bindToOrder(tx: Tx, verificationId: string, orderId: string): Promise<void>;
  forQuote(quoteId: string, db?: Db): Promise<ContactVerification[]>;
} = {
  async start({ quoteId, channel, contact, owner, ip }: StartInput) {
    if (channel !== "phone" && channel !== "email") throw Errors.validation({ channel: "Choose phone or email" });
    const normalised = normaliseContact(channel, contact);
    if (!normalised) {
      throw Errors.validation(channel === "phone" ? { contact: "Check the number, including the country code" } : { contact: "Check the email address" });
    }
    if (!deliveryReady(channel)) throw Errors.notConfigured(channel === "phone" ? "Phone verification" : "Email verification");

    const e = env();
    const hash = contactHash(normalised);
    await enforceRateLimit({ key: `ocv_start:ip:${ipKey(ip)}`, limit: START_PER_IP_LIMIT, windowSeconds: WINDOW_SECONDS });
    await enforceRateLimit({ key: `ocv_start:owner:${ownerKey(owner)}`, limit: START_PER_OWNER_LIMIT, windowSeconds: WINDOW_SECONDS });
    await enforceRateLimit({ key: "ocv_start:global", limit: START_GLOBAL_LIMIT, windowSeconds: WINDOW_SECONDS });

    const now = new Date();
    const quote = await ownedActiveQuote(quoteId, owner, now);
    if (!quote?.live) {
      log.info("contact_verification.start_refused", { channel });
      return { challengeId: uuidv7() };
    }

    // Charged only for the caller's own live quote. Checkout's per-contact budget is its own namespace, so it can
    // never lock a phone out of sign-in; the SMS a number can receive is bounded by both budgets together.
    await enforceRateLimit({ key: `ocv_start:quote:${quote.id.toLowerCase()}`, limit: START_PER_QUOTE_LIMIT, windowSeconds: WINDOW_SECONDS });
    await enforceRateLimit({ key: `ocv_start:contact:${channel}:${hash.slice(0, 16)}`, limit: e.OTP_RATE_LIMIT_PER_PHONE_PER_15MIN, windowSeconds: WINDOW_SECONDS });

    const ttlSeconds = e.OTP_TTL_SECONDS || 300;
    const id = uuidv7();
    const code = generateOtpCode(randomInt);
    const subject = subjectFor(quote.id, channel, hash);
    await prisma.otpChallenge.updateMany({
      where: { phoneE164: { startsWith: `${SUBJECT_PREFIX}${quote.id.toLowerCase()}:${channel}:` }, consumedAt: null },
      data: { consumedAt: now },
    });
    const created = await prisma.otpChallenge.create({
      data: { id, phoneE164: subject, codeHash: hashOtp(id, code, sha256Hex), expiresAt: otpExpiresAt(now, ttlSeconds) },
      select: { createdAt: true },
    });

    const delivery = await deliverChallengeCode({ challengeId: id, channel, recipient: normalised, code, ttlSeconds });
    if (delivery === "suppressed") {
      log.info("contact_verification.send_suppressed", { challengeId: id, channel, reason: "recipient_not_allowlisted" });
      return { challengeId: id };
    }
    if (delivery === "failed") {
      // Retire the code; the caller offers the inquiry route (F57).
      await retireUnsent(id, created.createdAt);
      throw Errors.internal("We couldn't send the code right now");
    }
    // `unknown`: the email may have arrived, so the code stays usable; a resend retires it.
    log.info("contact_verification.started", { challengeId: id, channel });
    return { challengeId: id };
  },

  async verify({ challengeId, code: rawCode, owner, ip }: VerifyInput) {
    const code = normaliseOtpInput(rawCode);
    if (!isValidOtpFormat(code) || !UUID.test(challengeId)) return { refused: "invalid" as const };

    for (const [key, limit] of [
      [`ocv_verify:ip:${ipKey(ip)}`, VERIFY_PER_IP_LIMIT],
      [`ocv_verify:owner:${ownerKey(owner)}`, VERIFY_PER_OWNER_LIMIT],
    ] as const) {
      const r = await rateLimit({ key, limit, windowSeconds: WINDOW_SECONDS });
      if (r.storeUnavailable || !r.allowed) return { refused: "rate_limited" as const };
    }
    const global = await rateLimit({ key: "ocv_verify:global", limit: VERIFY_GLOBAL_LIMIT, windowSeconds: WINDOW_SECONDS });
    if (global.storeUnavailable || !global.allowed) return { refused: "rate_limited" as const };

    const challenge = await prisma.otpChallenge.findUnique({ where: { id: challengeId } });
    const subject = challenge ? parseSubject(challenge.phoneE164) : null;
    if (!challenge || !subject) return { refused: "invalid" as const };

    const perQuote = await rateLimit({ key: `ocv_verify:quote:${subject.quoteId}`, limit: VERIFY_PER_QUOTE_LIMIT, windowSeconds: WINDOW_SECONDS });
    if (perQuote.storeUnavailable || !perQuote.allowed) return { refused: "rate_limited" as const };

    const now = new Date();
    const quote = await ownedActiveQuote(subject.quoteId, owner, now);
    if (!quote) return { refused: "invalid" as const };

    const maxAttempts = env().OTP_MAX_ATTEMPTS || 5;
    const verdict = evaluateChallenge(challenge, now, maxAttempts);
    // A spent or retired code is `invalid` whatever became of the quote since, so a replay after the order never reads as `expired`.
    if (verdict === "consumed") return { refused: "invalid" as const };
    if (!quote.live) return { refused: "expired" as const };
    if (verdict === "expired") return { refused: "expired" as const };
    if (verdict === "locked") return { refused: "rate_limited" as const };

    // Count the attempt before comparing so a crash between the two cannot hand out a free guess.
    const attempts = await customerRepo.bumpAttempts(challenge.id);
    if (attempts > maxAttempts) return { refused: "rate_limited" as const };
    if (!safeEqual(hashOtp(challenge.id, code, sha256Hex), challenge.codeHash)) {
      log.info("contact_verification.mismatch", { challengeId: challenge.id });
      return { refused: "invalid" as const };
    }

    try {
      const row = await prisma.$transaction(async (tx) => {
        // Single use: a replay of the same code loses here.
        if (!(await customerRepo.consumeChallenge(challenge.id, now, tx))) throw new RefusedInTx("invalid");
        const current = await tx.quote.findUnique({ where: { id: subject.quoteId }, select: { status: true, expiresAt: true } });
        if (!current || current.status !== "active" || current.expiresAt.getTime() <= now.getTime()) throw new RefusedInTx("expired");

        const existing = await tx.orderContactVerification.findUnique({ where: { quoteId_channel: { quoteId: subject.quoteId, channel: subject.channel } } });
        if (existing?.orderId) throw new RefusedInTx("invalid");
        const data = { contactHash: subject.contactHash, method: methodFor(subject.channel), verifiedAt: now };
        return existing
          ? tx.orderContactVerification.update({ where: { id: existing.id }, data })
          : tx.orderContactVerification.create({ data: { id: uuidv7(), quoteId: subject.quoteId, channel: subject.channel, ...data } });
      }, TX_OPTIONS);
      log.info("contact_verification.verified", { verificationId: row.id, channel: row.channel });
      return toContract(row);
    } catch (error) {
      if (error instanceof RefusedInTx) return { refused: error.refusal };
      throw error;
    }
  },

  /**
   * Attaches a verification to the order created from its quote. Call inside
   * the order's transaction, after the quote is marked used by `orderId`.
   * Idempotent for the same order; any other state is a conflict.
   */
  async bindToOrder(tx: Tx, verificationId: string, orderId: string): Promise<void> {
    const v = await tx.orderContactVerification.findUnique({
      where: { id: verificationId },
      select: { orderId: true, quote: { select: { usedByOrderId: true } } },
    });
    if (!v || v.quote.usedByOrderId !== orderId) throw Errors.conflict("This verification does not belong to that order");
    if (v.orderId === orderId) return;
    if (v.orderId) throw Errors.conflict("This verification is already bound to another order");
    const r = await tx.orderContactVerification.updateMany({ where: { id: verificationId, orderId: null }, data: { orderId } });
    if (r.count !== 1) throw Errors.conflict("This verification is already bound to another order");
  },

  /** Verifications recorded for a quote, for the order step to require before payment. */
  async forQuote(quoteId: string, db: Db = prisma): Promise<ContactVerification[]> {
    if (!UUID.test(quoteId)) return [];
    const rows = await db.orderContactVerification.findMany({ where: { quoteId }, orderBy: { channel: "asc" } });
    return rows.map(toContract);
  },
};

// Still usable wherever the frozen contract is expected.
const _contract: ContactVerificationService = contactVerificationService;
void _contract;
