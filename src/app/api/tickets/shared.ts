import "server-only";
import type { NextRequest } from "next/server";
import { json } from "@/server/lib/http";
import { emitEvent } from "@/server/lib/structured-events";
import { publicRateLimit, RATE, type RateBudget } from "@/server/lib/guards";

/**
 * Shared pieces of the ticket routes (doc 22 §23 B4; TKT-3, TKT-5, F39, F55).
 *
 * Every ticket response is private and unshareable: `Cache-Control:
 * private, no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-
 * Options: nosniff`. No route redirects and none returns a storage URL;
 * documents are only ever streamed through `/api/tickets/documents/[id]`.
 *
 * These are API routes: they emit no analytics events. The `/t` landing
 * page and `/tickets` pages (B5) are excluded from GA4 and attribution in
 * `src/lib/google-tag.ts` and `src/lib/analytics.ts`.
 */

export const TICKET_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

/** Per-IP budget for ticket reads (lists and downloads). */
export const TICKET_READ_RATE: RateBudget = RATE.publicSearch;
/** PROVISIONAL per-IP budget for capability exchanges; each grant is also capped (`CAPABILITY_LIMITS.maxExchanges`). */
export const TICKET_EXCHANGE_RATE: RateBudget = { limit: 20, windowSeconds: 60 };

/**
 * PROVISIONAL per-grant budget for downloads through a checkout grant (checkout
 * redesign batch 3, CO-02): generous for a customer opening their vouchers a
 * few times, too small for a copied cookie to be used as a bulk fetcher.
 * Postgres-backed, failing closed (`enforceRateLimit`).
 */
export const CHECKOUT_GRANT_DOWNLOAD_RATE = { limit: 30, windowSeconds: 3600 } as const;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The one refusal for anything the caller may not see: unknown, not owned
 * or not customer-visible all look the same, so the route is no existence
 * oracle.
 */
export function ticketNotFound(reason: string, accessKind: string = "none", grant: { grantId?: string; issuedFor?: string } = {}) {
  emitEvent("document.access_denied", { reason, accessKind, ...grant });
  return json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404, headers: { ...TICKET_HEADERS } });
}

export async function ticketReadLimit(req: NextRequest, scope: string) {
  await publicRateLimit(req, `tickets.${scope}`, TICKET_READ_RATE);
}
