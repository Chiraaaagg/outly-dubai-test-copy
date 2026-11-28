import "server-only";
import { isAppError } from "../lib/errors";
import { readBodyBytes } from "../lib/http";
import { log } from "../lib/logger";
import type { PaymentInbox } from "./inbox";

/**
 * POST /api/webhooks/payments/[provider] (PAY-13, F2). Server to server:
 * authenticated by the provider's signature over the raw body, not by
 * Origin or cookies.
 *
 *  1. The provider segment must name a configured gateway: 404 otherwise,
 *     nothing read.
 *  2. The body is read with a streamed `MAX_PAYMENT_WEBHOOK_BYTES` ceiling
 *     (413 over it, 400 if the client aborts).
 *  3. The inbox verifies the signature over exactly those bytes and stores
 *     the event id, type and body digest: 401 and nothing stored when it is
 *     not authentic, 200 when stored or already seen (the provider stops
 *     retrying), 500 on a database fault (the provider retries; the event-id
 *     uniqueness makes that safe).
 *
 * Processing happens in the payments job, not here, so a slow saga step never
 * times a webhook out. Responses carry no detail.
 */

export const MAX_PAYMENT_WEBHOOK_BYTES = 256 * 1024;

function plain(text: string, status: number): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

export function createPaymentWebhookHandler(inbox: Pick<PaymentInbox, "receive">, gatewayKnown: (provider: string) => boolean) {
  return async function handle(req: Request, provider: string): Promise<Response> {
    if (!/^[a-z0-9-]{1,40}$/.test(provider) || !gatewayKnown(provider)) return plain("Not found", 404);
    let body: Uint8Array;
    try {
      body = await readBodyBytes(req, MAX_PAYMENT_WEBHOOK_BYTES);
    } catch (error) {
      const tooLarge = isAppError(error) && error.status === 413;
      log.warn("payments.webhook_body_refused", { provider, tooLarge });
      return plain(tooLarge ? "Payload too large" : "Bad request", tooLarge ? 413 : 400);
    }
    try {
      const r = await inbox.receive(provider, body, req.headers);
      if (r.result === "not_found") return plain("Not found", 404);
      if (r.result === "rejected") {
        log.warn("payments.webhook_rejected", { provider, bytes: body.byteLength });
        return plain("Invalid signature", 401);
      }
      return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (error) {
      log.error("payments.webhook_store_failed", { provider, error: error instanceof Error ? error.message : String(error) });
      return plain("Retry later", 500);
    }
  };
}
