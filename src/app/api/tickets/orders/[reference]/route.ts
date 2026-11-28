import type { NextRequest } from "next/server";
import { handle, json } from "@/server/lib/http";
import { audit } from "@/server/lib/audit";
import { isValidReference } from "@/server/lib/ids";
import { ticketAccess } from "@/server/services/capability.service";
import { documentService } from "@/server/services/document.service";
import { TICKET_HEADERS, ticketNotFound, ticketReadLimit } from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ reference: string }> };

/**
 * GET /api/tickets/orders/:reference — the order's ticket state per item:
 * `{ reference, items: [{ orderItemId, fulfilment, documents }] }`.
 *
 * Ownership is checked on every request (`ticketAccess.authorize`): the
 * owning customer, a ticket-access cookie for this order, or staff with
 * `tickets.view` (audited, field names only). Anyone else gets 404.
 *
 * Summaries only: no storage key, checksum, code, supplier URL or Guid.
 * Customers and guests see servable (`valid`) documents only; a document is
 * fetched through `/api/tickets/documents/:id`.
 */
export const GET = handle<Ctx>(async (req: NextRequest, ctx) => {
  await ticketReadLimit(req, "list");
  const raw = (await ctx.params).reference ?? "";
  const reference = raw.trim().toUpperCase();
  if (!isValidReference(reference, "OUT")) return ticketNotFound("bad_reference");
  const order = await ticketAccess.orderByReference(reference);
  if (!order) return ticketNotFound("no_order");
  const principal = await ticketAccess.authorize(req, order, "view");
  if (!principal) return ticketNotFound("not_owner");
  if (principal.kind === "staff") {
    await audit(principal.actor, "tickets.view_list", { type: "order", id: order.id }, { after: { fields: ["supplier_documents.kind", "supplier_documents.status", "supplier_documents.version"] } });
  }
  const items = await documentService.listForOrder(order.id);
  const staff = principal.kind === "staff";
  return json(
    {
      reference: order.reference,
      items: items.map((item) => ({
        orderItemId: item.orderItemId,
        fulfilment: item.fulfilment,
        documents: item.documents
          .filter((d) => staff || d.status === "valid")
          .map((d) => ({ id: d.id, kind: d.kind, version: d.version, status: d.status, contentType: d.contentType, byteSize: d.byteSize, createdAt: d.createdAt })),
      })),
    },
    { headers: { ...TICKET_HEADERS } },
  );
});
