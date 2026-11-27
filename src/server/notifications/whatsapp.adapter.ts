import "server-only";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { positionalParameters } from "./whatsapp-templates";

/**
 * WhatsApp Business Platform transport — DEFERRED (§18 §1.4, Phase B).
 *
 * The port is fixed here so the notification service never changes when the
 * BSP arrives. Two adapters:
 *  - `log`       — records the message; returns a `log-` provider id. Default.
 *  - `cloud_api` — Meta Cloud API shape (also what Wati/Interakt/AiSensy
 *                  expose or proxy). Selected by WHATSAPP_PROVIDER=cloud_api
 *                  and refuses to start without credentials.
 *
 * TODO(whatsapp-bsp): once credentials + approved templates exist:
 *   1. Set WHATSAPP_PROVIDER=cloud_api, WHATSAPP_API_BASE_URL, WHATSAPP_API_TOKEN, WHATSAPP_PHONE_NUMBER_ID.
 *   2. Confirm template names in WHATSAPP_TEMPLATE_* match the approved names.
 *   3. Delivery receipts already flow through /api/webhooks/whatsapp →
 *      notifications.delivered_at (see whatsapp-webhook.ts); confirm the BSP
 *      forwards `statuses` unchanged.
 *   4. Record `cost_minor` from the BSP rate card per message (§08.2).
 *   5. Consult wa_conversations.csw_expires_at before choosing template vs
 *      session message (§08.2) — until then every send is a template.
 *
 * Idempotency (doc 22 §32.9, TKT-6). Unlike Resend, the Cloud API's
 * `POST /{phone-number-id}/messages` has no idempotency key that this
 * repository can verify (nothing in the code or docs here documents one), so
 * none is sent and none is invented. Duplicates are bounded instead by:
 *   1. the outbox dedup key: one row per intended message, written before
 *      the send, so a repeated trigger never reaches this adapter;
 *   2. typed outcomes: a send whose result is not known (timeout, network,
 *      5xx, an unreadable 2xx) throws `WhatsAppSendError` with `unknown`,
 *      and the outbox never re-sends an `unknown` (or crashed, still
 *      `queued`) WhatsApp row automatically: it goes to attention for a
 *      human. Only definite failures (nothing was accepted: 429, a 4xx, a
 *      configuration gap) are retried.
 * So at most one automatic send happens per WhatsApp message whose outcome
 * is in doubt. If the chosen BSP documents an idempotency header, add it in
 * `sendViaCloudApi` with the notification row id, as `email.adapter.ts` does.
 */

export interface WhatsAppSend {
  to: string; // E.164
  templateName?: string;
  variables: Record<string, string>;
  text: string;
}

export interface SendResult {
  providerId: string;
  costMinor?: bigint;
}

export type WhatsAppFailureReason = "rate_limited" | "rejected" | "auth" | "not_configured" | "invalid_message";
export type WhatsAppUnknownReason = "timeout" | "network" | "aborted" | "server_error" | "bad_response";

/** Why a send did not end in `sent`. Short codes and the HTTP status only: never the provider's body (PRV-6). */
export type WhatsAppFailure =
  | { kind: "failed"; retryable: boolean; httpStatus: number | null; reason: WhatsAppFailureReason }
  | { kind: "unknown"; httpStatus: number | null; reason: WhatsAppUnknownReason };

/** Thrown by `send` for anything but a sent message. `outcome.kind === "unknown"` means it may have gone out. */
export class WhatsAppSendError extends Error {
  constructor(readonly outcome: WhatsAppFailure) {
    super(`WhatsApp ${outcome.kind}: ${outcome.reason}${outcome.httpStatus ? ` (HTTP ${outcome.httpStatus})` : ""}`);
    this.name = "WhatsAppSendError";
  }
}

/** Client-side ceiling per request. A timeout is `unknown`: the provider may have accepted it. */
export const WHATSAPP_TIMEOUT_MS = 10_000;

/** Maps a Cloud API HTTP status (not 2xx) to an outcome. Exported for tests. */
export function classifyWhatsAppStatus(status: number): WhatsAppFailure {
  if (status === 429) return { kind: "failed", retryable: true, httpStatus: status, reason: "rate_limited" };
  if (status >= 500 || status === 408) return { kind: "unknown", httpStatus: status, reason: "server_error" };
  if (status === 401 || status === 403) return { kind: "failed", retryable: false, httpStatus: status, reason: "auth" };
  return { kind: "failed", retryable: false, httpStatus: status, reason: "rejected" };
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function sendViaCloudApi(msg: WhatsAppSend): Promise<SendResult> {
  const e = env();
  // Nothing was sent: a configuration gap can be fixed and the row retried.
  if (!e.WHATSAPP_API_BASE_URL || !e.WHATSAPP_API_TOKEN || !e.WHATSAPP_PHONE_NUMBER_ID) {
    throw new WhatsAppSendError({ kind: "failed", retryable: true, httpStatus: null, reason: "not_configured" });
  }
  // Session (non-template) messages need an open customer service window, which is not tracked yet.
  if (!msg.templateName) throw new WhatsAppSendError({ kind: "failed", retryable: false, httpStatus: null, reason: "invalid_message" });
  const parameters = positionalParameters(msg.variables);
  if (!parameters.length) throw new WhatsAppSendError({ kind: "failed", retryable: false, httpStatus: null, reason: "invalid_message" });

  const body = {
    messaging_product: "whatsapp",
    to: msg.to.replace(/^\+/, ""),
    type: "template",
    template: {
      name: msg.templateName,
      language: { code: "en" },
      components: [
        {
          type: "body",
          parameters: parameters.map((text) => ({ type: "text", text })),
        },
      ],
    },
  };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, WHATSAPP_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`${e.WHATSAPP_API_BASE_URL.replace(/\/$/, "")}/${e.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${e.WHATSAPP_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new WhatsAppSendError({ kind: "unknown", httpStatus: null, reason: timedOut ? "timeout" : isAbort(error) ? "aborted" : "network" });
    }
    if (!res.ok) {
      // The body is never read into a message or a log line (PRV-6).
      await res.body?.cancel().catch(() => {});
      throw new WhatsAppSendError(classifyWhatsAppStatus(res.status));
    }
    let data: { messages?: { id?: unknown }[] };
    try {
      data = (await res.json()) as { messages?: { id?: unknown }[] };
    } catch {
      // Accepted headers, unreadable body: it may have gone out.
      throw new WhatsAppSendError({ kind: "unknown", httpStatus: res.status, reason: timedOut ? "timeout" : "bad_response" });
    }
    const id = data.messages?.[0]?.id;
    return { providerId: typeof id === "string" && /^[A-Za-z0-9_.:=-]{1,200}$/.test(id) ? id : "whatsapp" };
  } finally {
    clearTimeout(timer);
  }
}

export const whatsappAdapter = {
  provider(): "cloud_api" | "log" {
    return env().WHATSAPP_PROVIDER;
  },
  /** Resolves on `sent`; anything else throws `WhatsAppSendError` with a typed outcome. */
  async send(msg: WhatsAppSend): Promise<SendResult> {
    if (whatsappAdapter.provider() === "cloud_api") return sendViaCloudApi(msg);
    log.info("whatsapp.log_adapter", { template: msg.templateName, variables: Object.keys(msg.variables).length, chars: msg.text.length });
    return { providerId: `log-${Date.now().toString(36)}` };
  },
};
