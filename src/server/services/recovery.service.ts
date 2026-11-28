import "server-only";
import { randomInt } from "node:crypto";
import { prisma, TX_OPTIONS } from "../lib/db";
import { defer } from "../lib/defer";
import { env } from "../lib/env";
import { uuidv7 } from "../lib/ids";
import { emitEvent } from "../lib/structured-events";
import { hashIp, safeEqual, sha256Hex } from "../lib/crypto";
import { enforceRateLimit, rateLimit } from "../lib/rate-limit";
import { evaluateChallenge, generateOtpCode, hashOtp, isValidOtpFormat, normaliseOtpInput, otpExpiresAt } from "../domain/otp";
import { customerRepo } from "../repositories/customer.repo";
import { capabilityService } from "./capability.service";
import { contactHash, deliverChallengeCode, deliveryReady, normaliseContact, retireUnsent } from "./contact-verification.service";
import { normaliseOrderReference } from "./order-access.service";

/**
 * Order recovery without an account (doc 22 §23 B5, §26 F23; TKT-4, TKT-5).
 *
 * A customer who lost the ticket email (or the browser that paid) proves
 * control of the contact verified at checkout for that order, and gets a
 * ticket-access grant for it in this browser.
 *
 *  - Challenges reuse `otp_challenges` and the OTP domain rules exactly like
 *    contact-verification.service.ts. The row's `phone_e164` holds a subject
 *    `rcv:v1:<orderId>:<channel>:<contactHash>`, never the contact. Customer
 *    sign-in refuses any subject that is not an E.164 number and checkout
 *    verification reads only `ocv:` subjects, so a recovery code is good for
 *    recovery only.
 *  - `start` always answers `{ challengeId }`. A code is created and sent only
 *    when the submitted contact's hash equals a bound verification
 *    (`order_contact_verifications` with that `order_id` and channel) of the
 *    order with that reference. Otherwise the id is a decoy and nothing is
 *    written or sent. The answer comes no sooner than `START_FLOOR_MS` and
 *    the code is delivered after the response, so the two paths take about
 *    the same time.
 *  - Rate limits fail closed. For `start`, the caller's own budgets (per IP
 *    and per contact hash) are charged before the lookup, whatever the
 *    outcome; the shared ones (per order and global) only for a match
 *    (R-B5-3), so decoys cannot exhaust them, and a match over those budgets
 *    is dropped silently (same answer, nothing sent, an alert logged). For
 *    `verify`: per IP and global, then per order and per contact, then a
 *    daily cap per order and per contact (R-B5-9); every refusal is the
 *    same.
 *  - `verify` answers one refusal for every failure (wrong, spent, expired or
 *    unknown code, a rate limit, a contact no longer bound). Success consumes
 *    the code and mints one `download_tickets` grant for the order (which
 *    also covers viewing the status; see below), exchanged at once into an
 *    access entry the route adds to the browser's cookie.
 *
 * Why `download_tickets` and not only `view_status`: the code went to the
 * contact verified for this order at checkout, the same contact the ticket
 * email is sent to, so whoever holds it could already open that email. The
 * point of recovery is to reach the tickets at the gate when the email is
 * lost; a status-only grant would send the customer to staff, which is not
 * the normal path (B5 acceptance). The grant is minted with
 * `supersede: "after_sent"` and never supersedes anything, so recovering in
 * one browser never breaks the emailed link.
 *
 * `issuedFor` is `recovery` (migration 20261102130000). A later ticket
 * message or staff resend does not supersede a recovery grant; staff
 * revocation and erasure still end it.
 *
 * Logs carry ids and short codes only: never the contact, the code or the
 * reference.
 */

type Channel = "phone" | "email";

const SUBJECT_PREFIX = "rcv:v1:";
const WINDOW_SECONDS = 900;
const START_PER_IP_LIMIT = 10;
const START_GLOBAL_LIMIT = 300;
const START_PER_REFERENCE_LIMIT = 5;
const START_PER_CONTACT_LIMIT = 5;
const VERIFY_PER_IP_LIMIT = 30;
const VERIFY_GLOBAL_LIMIT = 1_000;
const VERIFY_PER_ORDER_LIMIT = 15;
const VERIFY_PER_CONTACT_LIMIT = 15;
/**
 * PROVISIONAL (R-B5-9): verifies per order and per contact in one day (a
 * fixed 24-hour window). Over it every verify is the uniform refusal and an
 * alert is logged. Residual risk with these numbers: a guesser who knows a
 * reference and its contact gets at most 30 tries a day at a 6-digit code,
 * about 0.003% a day, and each new code also messages the customer.
 */
const VERIFY_DAILY_LIMIT = 30;
const DAY_SECONDS = 86_400;
/** Callers without a client IP share one bucket, so a missing IP is never unlimited. */
const NO_IP_BUCKET = "none";
/** `start` never answers sooner than this, so a matching and a decoy request look alike. */
export const START_FLOOR_MS = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function subjectFor(orderId: string, channel: Channel, hash: string): string {
  return `${SUBJECT_PREFIX}${orderId.toLowerCase()}:${channel}:${hash}`;
}

function parseSubject(subject: string): { orderId: string; channel: Channel; contactHash: string } | null {
  if (!subject.startsWith(SUBJECT_PREFIX)) return null;
  const [orderId, channel, hash] = subject.slice(SUBJECT_PREFIX.length).split(":");
  if (!orderId || !UUID.test(orderId) || (channel !== "phone" && channel !== "email") || !/^[0-9a-f]{64}$/.test(hash ?? "")) return null;
  return { orderId, channel, contactHash: hash };
}

/** True for a recovery challenge row (customer sign-in and checkout must never accept one). */
export function isRecoveryChallengeSubject(subject: string): boolean {
  return subject.startsWith(SUBJECT_PREFIX);
}

function ipKey(ip: string | null | undefined): string {
  return hashIp(ip) ?? NO_IP_BUCKET;
}

async function floor(startedAt: number): Promise<void> {
  const wait = START_FLOOR_MS + randomInt(40) - (Date.now() - startedAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export type RecoveryVerifyResult = { ok: true; reference: string; cookieValue: string; expiresAt: Date } | { ok: false };

const REFUSED: RecoveryVerifyResult = { ok: false };

function refuse(reason: string): RecoveryVerifyResult {
  emitEvent("recovery.verify_refused", { reason });
  return REFUSED;
}

export const recoveryService = {
  /** `{ challengeId }` always; a code only for the order's bound, verified contact. */
  async start(input: { reference: string; channel: Channel; contact: string; ip: string | null }): Promise<{ challengeId: string }> {
    const startedAt = Date.now();
    const channel: Channel = input.channel === "email" ? "email" : "phone";
    const normalised = normaliseContact(channel, String(input.contact ?? ""));
    const reference = normaliseOrderReference(input.reference);
    const hash = normalised ? contactHash(normalised) : null;

    // The caller's own budgets come first, whatever the outcome: per IP, and per contact (a contact the caller typed).
    await enforceRateLimit({ key: `rcv_start:ip:${ipKey(input.ip)}`, limit: START_PER_IP_LIMIT, windowSeconds: WINDOW_SECONDS });
    await enforceRateLimit({ key: `rcv_start:contact:${channel}:${hash ? hash.slice(0, 16) : "invalid"}`, limit: START_PER_CONTACT_LIMIT, windowSeconds: WINDOW_SECONDS });

    const challengeId = uuidv7();
    const order = reference ? await prisma.order.findUnique({ where: { reference }, select: { id: true } }) : null;
    const bound =
      order && hash
        ? await prisma.orderContactVerification.findFirst({ where: { orderId: order.id, channel, contactHash: hash }, select: { id: true } })
        : null;

    // R-B5-3: the shared budgets (per order and global) are charged only for a match, so decoys cannot use them up and
    // lock real customers out. Over budget, or with the store down, nothing is sent and the answer is unchanged
    // (uniform and floored), so the refusal tells the caller nothing; staff get an alert instead.
    let budget = true;
    if (order && bound) {
      for (const [scope, key, limit] of [
        ["order", `rcv_start:order:${order.id}`, START_PER_REFERENCE_LIMIT],
        ["global", "rcv_start:global", START_GLOBAL_LIMIT],
      ] as const) {
        const r = await rateLimit({ key, limit, windowSeconds: WINDOW_SECONDS });
        if (r.storeUnavailable || !r.allowed) {
          budget = false;
          emitEvent("recovery.start_budget_exhausted", { scope, storeUnavailable: Boolean(r.storeUnavailable) }, "warn");
          break;
        }
      }
    }

    if (order && hash && normalised && bound && budget && deliveryReady(channel)) {
      const now = new Date();
      const ttlSeconds = env().OTP_TTL_SECONDS || 300;
      const code = generateOtpCode(randomInt);
      // One live recovery code per order and channel.
      await prisma.otpChallenge.updateMany({
        where: { phoneE164: { startsWith: `${SUBJECT_PREFIX}${order.id.toLowerCase()}:${channel}:` }, consumedAt: null },
        data: { consumedAt: now },
      });
      const created = await prisma.otpChallenge.create({
        data: { id: challengeId, phoneE164: subjectFor(order.id, channel, hash), codeHash: hashOtp(challengeId, code, sha256Hex), expiresAt: otpExpiresAt(now, ttlSeconds) },
        select: { id: true, createdAt: true },
      });
      const id = created.id;
      // Delivered after the response: the caller is told nothing either way, so a send failure only retires the code (F57).
      defer("recovery.deliver", async () => {
        const delivery = await deliverChallengeCode({ challengeId: id, channel, recipient: normalised, code, ttlSeconds, purpose: "recovery" });
        if (delivery === "failed") await retireUnsent(id, created.createdAt);
        emitEvent("recovery.code_delivery", { challengeId: id, channel, outcome: delivery });
      });
      emitEvent("recovery.started", { challengeId: id, channel });
    } else if (budget) {
      emitEvent("recovery.start_decoy", { channel });
    }
    await floor(startedAt);
    return { challengeId };
  },

  /** One refusal for every failure; success returns the order reference and an access entry for the cookie. */
  async verify(input: { challengeId: string; code: string; ip: string | null }): Promise<RecoveryVerifyResult> {
    const code = normaliseOtpInput(String(input.code ?? ""));
    const challengeId = String(input.challengeId ?? "");
    if (!isValidOtpFormat(code) || !UUID.test(challengeId)) return refuse("malformed");

    // Only the per-IP budget is charged before the lookup. The global budget is charged for a real
    // recovery challenge only, so random ids cannot exhaust it and block every customer (R-B5-3 recheck).
    const ipLimit = await rateLimit({ key: `rcv_verify:ip:${ipKey(input.ip)}`, limit: VERIFY_PER_IP_LIMIT, windowSeconds: WINDOW_SECONDS });
    if (ipLimit.storeUnavailable || !ipLimit.allowed) return refuse("rate_limited");

    const challenge = await prisma.otpChallenge.findUnique({ where: { id: challengeId } });
    const subject = challenge ? parseSubject(challenge.phoneE164) : null;
    if (!challenge || !subject) return refuse("unknown");

    for (const [key, limit] of [
      ["rcv_verify:global", VERIFY_GLOBAL_LIMIT],
      [`rcv_verify:order:${subject.orderId}`, VERIFY_PER_ORDER_LIMIT],
      [`rcv_verify:contact:${subject.channel}:${subject.contactHash.slice(0, 16)}`, VERIFY_PER_CONTACT_LIMIT],
    ] as const) {
      const r = await rateLimit({ key, limit, windowSeconds: WINDOW_SECONDS });
      if (r.storeUnavailable || !r.allowed) return refuse("rate_limited");
    }
    // R-B5-9: a daily cap per order and per contact, failing closed with the same refusal.
    for (const [scope, key] of [
      ["order", `rcv_verify:order_day:${subject.orderId}`],
      ["contact", `rcv_verify:contact_day:${subject.channel}:${subject.contactHash.slice(0, 16)}`],
    ] as const) {
      const r = await rateLimit({ key, limit: VERIFY_DAILY_LIMIT, windowSeconds: DAY_SECONDS });
      if (r.storeUnavailable || !r.allowed) {
        emitEvent("recovery.verify_daily_cap", { scope, storeUnavailable: Boolean(r.storeUnavailable) }, "warn");
        return refuse("rate_limited");
      }
    }

    const now = new Date();
    const maxAttempts = env().OTP_MAX_ATTEMPTS || 5;
    const verdict = evaluateChallenge(challenge, now, maxAttempts);
    if (verdict !== "ok") return refuse(verdict);
    // Count the attempt before comparing so a crash between the two cannot hand out a free guess.
    const attempts = await customerRepo.bumpAttempts(challenge.id);
    if (attempts > maxAttempts) return refuse("locked");
    if (!safeEqual(hashOtp(challenge.id, code, sha256Hex), challenge.codeHash)) return refuse("mismatch");

    const minted = await prisma.$transaction(async (tx) => {
      // Single use: a replay of the same code loses here.
      if (!(await customerRepo.consumeChallenge(challenge.id, now, tx))) return null;
      // The contact must still be the order's bound, verified one (an erasure or a change since start refuses).
      const bound = await tx.orderContactVerification.findFirst({ where: { orderId: subject.orderId, channel: subject.channel, contactHash: subject.contactHash }, select: { id: true } });
      const order = await tx.order.findUnique({ where: { id: subject.orderId }, select: { id: true, reference: true } });
      if (!bound || !order) return null;
      const grant = await capabilityService.mint(tx, { orderId: order.id, purpose: "download_tickets", issuedFor: "recovery", supersede: "after_sent" }, now);
      return { reference: order.reference, token: grant.token, grantId: grant.grantId };
    }, TX_OPTIONS);
    if (!minted) return refuse("consumed_or_unbound");

    const exchanged = await capabilityService.exchange(minted.token, now);
    if (!exchanged.ok) return refuse("exchange_failed");
    emitEvent("recovery.verified", { challengeId: challenge.id, grantId: minted.grantId, channel: subject.channel });
    return { ok: true, reference: minted.reference, cookieValue: exchanged.cookieValue, expiresAt: exchanged.expiresAt };
  },
};
