import "@/server/wiring";
import type { NextRequest } from "next/server";
import { paymentInbox } from "@/server/payments/inbox";
import { paymentGateways } from "@/server/payments/registry";
import { createPaymentWebhookHandler } from "@/server/payments/webhook-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/payments/[provider] — payment provider events.
 * Verify, store a digest, acknowledge; the payments job processes. See
 * src/server/payments/webhook-handler.ts. `@/server/wiring` configures the
 * registry from env: only `stripe` can answer, and only when
 * `PAYMENTS_STRIPE` is set and valid; every other provider answers 404.
 */
const handle = createPaymentWebhookHandler(paymentInbox, (provider) => paymentGateways.forProvider(provider) !== null);

export async function POST(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  return handle(req, provider);
}
