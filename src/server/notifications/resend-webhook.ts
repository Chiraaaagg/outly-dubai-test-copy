import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { log } from "../lib/logger";
import { notificationsRepo } from "../repositories/notifications.repo";
import { BOUNCED_ERROR } from "../services/notification.service";

/**
 * Resend delivery webhook (post-payment batch A8; route
 * `src/app/api/webhooks/resend/route.ts`).
 *
 *   (route) secret configured? → bounded raw read → verify the Svix signature
 *     over those exact bytes → (here) parse → store once per `svix-id` → apply
 *
 * Resend signs its webhooks with Svix: headers `svix-id`, `svix-timestamp`
 * (Unix seconds) and `svix-signature` (space-separated `v1,<base64>` entries,
 * several during a secret rotation). The signed content is
 * `<svix-id>.<svix-timestamp>.<raw body>`, HMAC-SHA256 under the secret's
 * bytes (the part after `whsec_`, base64). A timestamp more than five minutes
 * from our clock is refused, so a captured delivery cannot be replayed later.
 *
 * Mapping onto `notifications` rows by provider message id (`data.email_id`,
 * the id Resend returned when the email was accepted), through
 * `notificationsRepo.applyProviderStatus`, which only moves a row forward:
 *
 *   email.sent             → sent (only a row still queued)
 *   email.delivery_delayed → sent (no change for a row already sent)
 *   email.delivered        → delivered
 *   email.bounced          → failed, `definite:bounced` (never retried)
 *   email.failed           → failed, `definite:provider_failed`
 *   email.complained       → stored, not applied: a complaint is not a
 *                            delivery event, so it never makes a row
 *                            "delivered" (fix round 1, L7)
 *   anything else          → stored, not applied
 *
 * A stored event whose apply step failed (or whose process died before it
 * was marked processed) is applied again when Svix redelivers it; applying
 * is idempotent, rows only move forward (fix round 1, M2).
 *
 * Privacy: the stored payload keeps only the event type, its time, the
 * provider message id and the bounce type. Recipient addresses, the sender,
 * the subject and headers are never stored or logged.
 */

/** Hard ceiling for one delivery; Resend events are a few kilobytes. Enforced while streaming by the route. */
export const RESEND_WEBHOOK_MAX_BYTES = 256 * 1024;
/** Svix's own default tolerance. */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export type SignatureVerdict = "ok" | "missing" | "malformed" | "stale" | "mismatch" | "secret_invalid";

const SVIX_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const TIMESTAMP = /^\d{1,12}$/;
const SIGNATURE_ENTRY = /^v1,([A-Za-z0-9+/]+={0,2})$/;
const EMAIL_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_SIGNATURE_HEADER = 4096;

/**
 * The HMAC key of a `whsec_…` secret, or null when it is not one. The prefix
 * is required (fix round 1, L6): Resend always issues it, and a value without
 * it is a misconfiguration the route answers with 503.
 */
function secretKey(secret: string): Buffer | null {
  if (!secret.startsWith("whsec_")) return null;
  const raw = secret.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const key = Buffer.from(raw, "base64");
  return key.length >= 16 ? key : null;
}

/** Whether `secret` is a usable `whsec_…` signing secret (the route checks this before reading any body). */
export function isUsableWebhookSecret(secret: string | null | undefined): secret is string {
  return typeof secret === "string" && secretKey(secret) !== null;
}

/**
 * Verifies a Svix signature over the exact request bytes. Pure apart from the
 * clock you pass. Never throws.
 */
export function verifySvixSignature(input: {
  body: Uint8Array;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  secret: string;
  now: Date;
  toleranceSeconds?: number;
}): SignatureVerdict {
  const key = secretKey(input.secret);
  if (!key) return "secret_invalid";
  if (!input.id || !input.timestamp || !input.signature) return "missing";
  if (!SVIX_ID.test(input.id) || !TIMESTAMP.test(input.timestamp) || input.signature.length > MAX_SIGNATURE_HEADER) return "malformed";
  const ts = Number(input.timestamp);
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(Math.floor(input.now.getTime() / 1000) - ts) > tolerance) return "stale";

  const mac = createHmac("sha256", key);
  mac.update(`${input.id}.${input.timestamp}.`);
  mac.update(input.body);
  const expected = mac.digest();

  const entries = input.signature.split(" ").filter(Boolean);
  let sawV1 = false;
  for (const entry of entries) {
    const m = SIGNATURE_ENTRY.exec(entry);
    if (!m) continue;
    sawV1 = true;
    const given = Buffer.from(m[1], "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return "ok";
  }
  return sawV1 ? "mismatch" : "malformed";
}

/** The signature a sender with `secret` would put on `body` (tests and local tooling only). */
export function signSvixForTests(input: { body: string | Uint8Array; id: string; timestamp: number; secret: string }): string {
  const key = secretKey(input.secret);
  if (!key) throw new Error("not a whsec_ secret");
  const mac = createHmac("sha256", key);
  mac.update(`${input.id}.${input.timestamp}.`);
  mac.update(typeof input.body === "string" ? Buffer.from(input.body, "utf8") : input.body);
  return `v1,${mac.digest("base64")}`;
}

export type ResendStatus = "sent" | "delivered" | "failed" | "bounced";

export interface ResendEvent {
  type: string;
  /** The event's own time, or null when absent or unreadable. */
  at: Date | null;
  emailId: string | null;
  bounceType: string | null;
}

const MAPPING: Record<string, { status: ResendStatus; error?: string }> = {
  "email.sent": { status: "sent" },
  "email.delivery_delayed": { status: "sent" },
  "email.delivered": { status: "delivered" },
  "email.bounced": { status: "bounced", error: BOUNCED_ERROR },
  "email.failed": { status: "failed", error: "definite:provider_failed" },
};

/** The row status an event moves to, or null when the event does not touch rows. */
export function statusForEvent(type: string): { status: ResendStatus; error?: string } | null {
  return MAPPING[type] ?? null;
}

const SHORT_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The parts of a verified event we use. Null when the body is not a Resend event object. */
export function parseResendEvent(raw: unknown): ResendEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as { type?: unknown; created_at?: unknown; data?: unknown };
  if (typeof e.type !== "string" || !SHORT_CODE.test(e.type)) return null;
  const data = e.data && typeof e.data === "object" && !Array.isArray(e.data) ? (e.data as { email_id?: unknown; bounce?: unknown }) : {};
  const at = typeof e.created_at === "string" ? new Date(e.created_at) : null;
  const bounce = data.bounce && typeof data.bounce === "object" ? (data.bounce as { type?: unknown }).type : undefined;
  return {
    type: e.type,
    at: at && Number.isFinite(at.getTime()) ? at : null,
    emailId: typeof data.email_id === "string" && EMAIL_ID.test(data.email_id) ? data.email_id : null,
    bounceType: typeof bounce === "string" && SHORT_CODE.test(bounce) ? bounce : null,
  };
}

export interface ResendIngestResult {
  type: string | null;
  duplicate: boolean;
  /** Rows the event changed. */
  applied: number;
  skipped?: "invalid_json" | "not_an_event";
}

/**
 * What the stored event row records as `processingError` once handled
 * (undefined when the event changed a row, or maps to no status):
 *
 *  - `no_change`: first delivery, and no row carries this message id (a
 *    verification-code email, or a row recorded after the event arrived), or
 *    the row is already at or past this state;
 *  - `reapplied` (fix round 2, N3): a redelivery of a stored, unfinished
 *    event that changed nothing now. An earlier attempt (one that failed
 *    after its update, or a concurrent delivery) may already have applied
 *    it, so this is not labelled `no_change`.
 */
export function processingNote(statusEvent: boolean, redelivery: boolean, applied: number): string | undefined {
  if (!statusEvent || applied > 0) return undefined;
  return redelivery ? "reapplied" : "no_change";
}

/**
 * Processes a delivery whose signature the caller has ALREADY verified over
 * `rawBody`. Stored once per `svixId`. A redelivery of an event already
 * processed is acknowledged and changes nothing. A redelivery of an event
 * that was stored but never marked processed (the apply step threw, or the
 * process died) is applied now: applying is idempotent, so a duplicate that
 * races the first attempt changes nothing either (fix round 1, M2). A
 * database failure throws, so the route answers 500 and Svix redelivers.
 */
export async function ingestVerifiedResendWebhook(rawBody: Uint8Array, svixId: string, now: Date = new Date()): Promise<ResendIngestResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString("utf8"));
  } catch {
    log.warn("resend.webhook.invalid_json", { bytes: rawBody.byteLength });
    return { type: null, duplicate: false, applied: 0, skipped: "invalid_json" };
  }
  const event = parseResendEvent(parsed);
  if (!event) {
    log.warn("resend.webhook.not_an_event", { bytes: rawBody.byteLength });
    return { type: null, duplicate: false, applied: 0, skipped: "not_an_event" };
  }

  const inserted = await notificationsRepo.insertWebhookEvent({
    provider: "resend",
    providerEventId: svixId,
    eventType: event.type,
    // Never the recipient, sender, subject or headers.
    payload: { type: event.type, created_at: event.at?.toISOString() ?? null, email_id: event.emailId, bounce_type: event.bounceType },
    signatureValid: true,
  });
  // A duplicate: finish it when the first attempt never got to the end, else acknowledge it.
  const stored = inserted ?? (await notificationsRepo.findUnprocessedWebhookEvent("resend", svixId));
  if (!stored) return { type: event.type, duplicate: true, applied: 0 };

  const mapped = statusForEvent(event.type);
  let applied = 0;
  if (mapped && event.emailId) {
    // A time from the future (clock skew) is clamped to now.
    const at = event.at && event.at.getTime() <= now.getTime() ? event.at : now;
    applied = await notificationsRepo.applyProviderStatus(event.emailId, mapped.status, at, mapped.error);
  }
  await notificationsRepo.markWebhookProcessed(stored, processingNote(Boolean(mapped && event.emailId), inserted === null, applied));
  return { type: event.type, duplicate: inserted === null, applied };
}
