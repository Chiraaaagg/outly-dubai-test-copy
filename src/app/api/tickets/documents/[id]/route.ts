import type { NextRequest } from "next/server";
import { handle, json } from "@/server/lib/http";
import { audit } from "@/server/lib/audit";
import { enforceRateLimit } from "@/server/lib/rate-limit";
import { emitEvent } from "@/server/lib/structured-events";
import { attachmentDisposition, documentDownloadName } from "@/server/documents/download-name";
import { ticketAccess } from "@/server/services/capability.service";
import { documentService } from "@/server/services/document.service";
import { CHECKOUT_GRANT_DOWNLOAD_RATE, TICKET_HEADERS, UUID, ticketNotFound, ticketReadLimit } from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** How long a caller is told to wait while a document is being (re)fetched. */
const PREPARING_RETRY_AFTER_SECONDS = 300;

/**
 * GET /api/tickets/documents/:id — streams a ticket PDF (TKT-3).
 *
 * Ownership is checked on EVERY request, before any byte is read: the
 * owning customer, a ticket-access cookie whose grant is for this
 * document's order with purpose `download_tickets`, or staff with
 * `tickets.view` (audited as a PII access, field names and ids only).
 * Not owned, unknown or not customer-visible → 404, so existence never
 * leaks. Not servable yet → 503 `{ status: "preparing" }` with
 * `Retry-After`.
 *
 * Never a redirect and never a signed storage URL: signed URLs cannot be
 * revoked (TKT-3). The bytes come from `documentService.readServable`.
 *
 * Checkout redesign batch 3: a checkout grant (the guest browser that paid,
 * 24 hours, CO-02) is one more `download_tickets` grant here, with its own
 * Postgres-backed budget per grant on top of the per-IP one, failing closed.
 * The file is named `OUTLYY-voucher-<REF>.pdf` (`OUTLYY-tickets-<REF>.pdf` for
 * a TicketOnly booking's tickets), CO-22.
 */
export const GET = handle<Ctx>(async (req: NextRequest, ctx) => {
  await ticketReadLimit(req, "document");
  const id = ((await ctx.params).id ?? "").toLowerCase();
  if (!UUID.test(id)) return ticketNotFound("bad_id");
  const owner = await ticketAccess.documentOwner(id);
  if (!owner) return ticketNotFound("no_document");
  const principal = await ticketAccess.authorize(req, owner.order, "download");
  if (!principal) return ticketNotFound("not_owner");
  const grant = principal.kind === "guest" ? { grantId: principal.grantId, issuedFor: principal.issuedFor } : {};
  if (principal.kind !== "staff" && !owner.customerVisible) return ticketNotFound("not_customer_visible", principal.kind, grant);
  if (principal.kind === "guest" && principal.issuedFor === "checkout") {
    await enforceRateLimit({ key: `tickets.document:checkout_grant:${principal.grantId}`, ...CHECKOUT_GRANT_DOWNLOAD_RATE });
  }
  if (principal.kind === "staff") {
    // Fail closed: no audit row, no bytes.
    await audit(principal.actor, "tickets.view_document", { type: "supplier_document", id }, { after: { orderId: owner.order.id, fields: ["supplier_documents.content"] } });
  }

  const served = await documentService.readServable(id);
  if (served.kind === "unavailable") {
    if (served.reason === "not_found") return ticketNotFound("not_servable", principal.kind, grant);
    return json({ status: "preparing" }, { status: 503, headers: { ...TICKET_HEADERS, "retry-after": String(PREPARING_RETRY_AFTER_SECONDS) } });
  }
  // Defence in depth: the bytes must belong to the order that was authorised.
  if (served.document.orderId !== owner.order.id) return ticketNotFound("order_mismatch", principal.kind, grant);

  emitEvent("document.served", { documentId: id, accessKind: principal.kind, ...grant });
  const body = new Uint8Array(served.bytes);
  return new Response(body, {
    status: 200,
    headers: {
      ...TICKET_HEADERS,
      "content-type": "application/pdf",
      "content-length": String(body.byteLength),
      "content-disposition": attachmentDisposition(documentDownloadName(served.document.kind, owner.order.reference)),
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
      "x-frame-options": "DENY",
    },
  });
});
