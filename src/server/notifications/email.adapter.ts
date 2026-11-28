import "server-only";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "../lib/crypto";

/**
 * Email transport — Resend REST API via fetch (no SDK). ACTIVE when
 * RESEND_API_KEY is set; otherwise the log adapter records the message and
 * returns a synthetic provider id prefixed `log-` so the notifications table
 * still shows what would have gone out.
 *
 * Outbox contract (TKT-6, doc 22 §26 F14):
 *  - every send carries an idempotency key (the notification row id), sent to
 *    Resend as the `Idempotency-Key` header. Resend keeps keys for 24 hours
 *    (https://resend.com/docs/dashboard/emails/idempotency-keys), so a retry
 *    with the same key and an identical body inside that window cannot
 *    produce a second email;
 *  - the result is a typed outcome, never a throw: `sent`, `failed` (the
 *    provider definitely did not accept it; `retryable` for 429 and for
 *    local configuration gaps) or `unknown` (timeout, network error, abort,
 *    5xx, or 409 — an idempotent request still in flight or a key reused
 *    with another body). An `unknown` send may have gone out;
 *  - errors and logs carry the HTTP status and a short reason code only,
 *    never the provider's response body (PRV-6).
 */

export interface EmailSend {
  to: string;
  subject: string;
  html: string;
  /** Plain-text part — always present so text-only clients and previews work. */
  text: string;
  /**
   * Group C (owner answer O8): files sent with the message. The payment and
   * invoice emails attach the combined "Tax Invoice / Receipt" PDF while
   * FISCAL_DOCUMENTS_ENABLED is on; the monthly accountant export (C-P4)
   * attaches its CSV. The same row always carries the same bytes, so a retry
   * under the same idempotency key is identical.
   */
  attachments?: { filename: string; content: Uint8Array; contentType: "application/pdf" | "text/csv" }[];
}

export interface EmailSendOptions {
  /** The notification row id. Same key + same body = one email at the provider. */
  idempotencyKey: string;
  /**
   * A shorter client-side ceiling than EMAIL_TIMEOUT_MS, for a caller that is
   * itself inside someone else's deadline (the Supabase Send Email hook,
   * review 103 finding 13). Clamped to 1–10 s. A timeout is still `unknown`.
   */
  timeoutMs?: number;
}

export type EmailFailureReason = "rate_limited" | "rejected" | "auth" | "not_configured" | "invalid_message";
export type EmailUnknownReason = "timeout" | "network" | "aborted" | "server_error" | "conflict" | "bad_response";

export type EmailOutcome =
  | { kind: "sent"; providerId: string; costMinor?: bigint }
  | { kind: "failed"; retryable: boolean; httpStatus: number | null; reason: EmailFailureReason }
  | { kind: "unknown"; httpStatus: number | null; reason: EmailUnknownReason };

/** Client-side ceiling per request. A timeout is `unknown`, never `failed`: the provider may have accepted it. */
export const EMAIL_TIMEOUT_MS = 10_000;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{1,256}$/;

/** Maps a Resend HTTP status (not 2xx) to an outcome. Exported for tests. */
export function classifyResendStatus(status: number): EmailOutcome {
  if (status === 429) return { kind: "failed", retryable: true, httpStatus: status, reason: "rate_limited" };
  // 409: the same key is still being processed, or was used with another body. Either way the
  // first request may have been accepted, so the outcome is not known.
  if (status === 409) return { kind: "unknown", httpStatus: status, reason: "conflict" };
  if (status >= 500) return { kind: "unknown", httpStatus: status, reason: "server_error" };
  if (status === 401 || status === 403) return { kind: "failed", retryable: false, httpStatus: status, reason: "auth" };
  return { kind: "failed", retryable: false, httpStatus: status, reason: "rejected" };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function sendViaResend(msg: EmailSend, opts: EmailSendOptions): Promise<EmailOutcome> {
  const e = env();
  const from = e.EMAIL_FROM_TRANSACTIONAL;
  // Nothing was sent: a configuration gap can be fixed and the row retried.
  if (!from) return { kind: "failed", retryable: true, httpStatus: null, reason: "not_configured" };
  const to = e.EMAIL_CATCH_ALL && e.isNonProduction ? e.EMAIL_CATCH_ALL : msg.to;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.min(EMAIL_TIMEOUT_MS, Math.max(1_000, opts.timeoutMs ?? EMAIL_TIMEOUT_MS)));
  try {
    let res: Response;
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${e.RESEND_API_KEY}`,
          "content-type": "application/json",
          "idempotency-key": opts.idempotencyKey,
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          reply_to: e.EMAIL_REPLY_TO,
          ...(msg.attachments?.length
            ? { attachments: msg.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString("base64"), content_type: a.contentType })) }
            : {}),
        }),
        signal: controller.signal,
        redirect: "error",
      });
    } catch (error) {
      if (timedOut) return { kind: "unknown", httpStatus: null, reason: "timeout" };
      return { kind: "unknown", httpStatus: null, reason: isAbort(error) ? "aborted" : "network" };
    }
    if (!res.ok) {
      // The body is never read into a message or a log line (PRV-6).
      await res.body?.cancel().catch(() => {});
      return classifyResendStatus(res.status);
    }
    let data: { id?: unknown } | null = null;
    try {
      data = (await res.json()) as { id?: unknown };
    } catch {
      data = null;
    }
    // 2xx means accepted; without an id the provider still has it, so it counts as sent.
    const id = data && typeof data.id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(data.id) ? data.id : null;
    return { kind: "sent", providerId: id ?? `resend-${opts.idempotencyKey}` };
  } catch (error) {
    // Reading the response failed after the provider answered 2xx headers: treat as unknown.
    if (timedOut) return { kind: "unknown", httpStatus: null, reason: "timeout" };
    return { kind: "unknown", httpStatus: null, reason: isAbort(error) ? "aborted" : "bad_response" };
  } finally {
    clearTimeout(timer);
  }
}

/** Legacy result of the one-argument form. */
export interface SendResult {
  providerId: string;
  costMinor?: bigint;
}

async function deliver(msg: EmailSend, opts: EmailSendOptions): Promise<EmailOutcome> {
  if (!IDEMPOTENCY_KEY.test(opts.idempotencyKey)) return { kind: "failed", retryable: false, httpStatus: null, reason: "invalid_message" };
  if (!msg.html || !msg.subject) return { kind: "failed", retryable: false, httpStatus: null, reason: "invalid_message" };
  if (emailAdapter.provider() === "resend") return sendViaResend(msg, opts);
  // Deterministic: the same key always yields the same provider id, as the real provider would.
  // Only the size is logged: subjects and bodies can carry names and links.
  log.info("email.log_adapter", { bytes: msg.html.length });
  return { kind: "sent", providerId: `log-${sha256Hex(opts.idempotencyKey).slice(0, 20)}` };
}

/**
 * `send(msg, { idempotencyKey })` returns the typed outcome (the outbox path).
 *
 * `send(msg)` is the older form, kept for callers outside the outbox (the
 * checkout verification code): it sends under a fresh random key and throws
 * on anything but `sent`. The error names the outcome and HTTP status only.
 */
function send(msg: EmailSend, opts: EmailSendOptions): Promise<EmailOutcome>;
function send(msg: EmailSend): Promise<SendResult>;
async function send(msg: EmailSend, opts?: EmailSendOptions): Promise<EmailOutcome | SendResult> {
  if (opts) return deliver(msg, opts);
  const outcome = await deliver(msg, { idempotencyKey: randomUUID() });
  if (outcome.kind === "sent") return { providerId: outcome.providerId, costMinor: outcome.costMinor };
  throw new Error(`Email ${outcome.kind}: ${outcome.reason}${outcome.httpStatus ? ` (HTTP ${outcome.httpStatus})` : ""}`);
}

export const emailAdapter = {
  provider(): "resend" | "log" {
    return env().RESEND_API_KEY ? "resend" : "log";
  },
  send,
};
