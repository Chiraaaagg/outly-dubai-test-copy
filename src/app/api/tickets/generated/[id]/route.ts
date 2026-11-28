import type { NextRequest } from "next/server";
import { handle, json } from "@/server/lib/http";
import { audit } from "@/server/lib/audit";
import { enforceRateLimit } from "@/server/lib/rate-limit";
import { emitEvent } from "@/server/lib/structured-events";
import { attachmentDisposition, generatedDownloadName } from "@/server/documents/download-name";
import { ticketAccess } from "@/server/services/capability.service";
import { generatedKindEnabled, generatedOwner, isGeneratedEntryKind, readServableGenerated } from "@/server/services/generated-document.read";
import { CHECKOUT_GRANT_DOWNLOAD_RATE, TICKET_HEADERS, UUID, ticketNotFound, ticketReadLimit } from "../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** How long a caller is told to wait while a file is being (re)drawn. */
const PREPARING_RETRY_AFTER_SECONDS = 120;

/**
 * GET /api/tickets/generated/:id — streams a file OUTLYY drew itself (Group C,
 * doc 93 §4.4): the combined "Tax invoice / Receipt", a credit note, or the
 * branded entry PDF. Sibling of `/api/tickets/documents/[id]` with the same
 * rules:
 *
 *  - ownership checked on EVERY request, before any byte is read: the owning
 *    customer, a `download_tickets` grant for this order, or staff with
 *    `tickets.view` (audited, field names and ids only);
 *  - anything not owned, unknown, of a kind whose switch is off
 *    (FISCAL_DOCUMENTS_ENABLED, BRANDED_ENTRY_PDF_ENABLED), or not valid
 *    → 404, so existence never leaks; a file being re-drawn → 503
 *    `{ status: "preparing" }` with `Retry-After`;
 *  - never a redirect, never a storage URL; the bytes are checked against
 *    their stored sha256 (`readServableGenerated`);
 *  - an entry file (branded entry PDF or its cover page) is exactly as
 *    visible as the operator's file it was made from: its source is resolved
 *    through `ticketAccess.documentOwner`, so after a verified cancellation or
 *    any other voiding end of the booking (R-B5-8) customers and guests get
 *    404 like they do for the operator's original (review finding 3).
 */
export const GET = handle<Ctx>(async (req: NextRequest, ctx) => {
  await ticketReadLimit(req, "generated");
  const id = ((await ctx.params).id ?? "").toLowerCase();
  if (!UUID.test(id)) return ticketNotFound("bad_id");
  const owner = await generatedOwner(id);
  // A switched-off kind is answered exactly like an unknown id, before any authorisation work.
  if (!owner || !generatedKindEnabled(owner.kind)) return ticketNotFound("no_document");
  // Entry files: the source's own visibility (documentOwner), and the source must belong to the same order.
  let sourceVisible = true;
  if (isGeneratedEntryKind(owner.kind)) {
    const source = owner.sourceDocumentId ? await ticketAccess.documentOwner(owner.sourceDocumentId) : null;
    if (!source || source.order.id !== owner.order.id) return ticketNotFound("no_document");
    sourceVisible = source.customerVisible;
  }
  const principal = await ticketAccess.authorize(req, owner.order, "download");
  if (!principal) return ticketNotFound("not_owner");
  const grant = principal.kind === "guest" ? { grantId: principal.grantId, issuedFor: principal.issuedFor } : {};
  if (principal.kind !== "staff" && !sourceVisible) return ticketNotFound("not_customer_visible", principal.kind, grant);
  if (principal.kind === "guest" && principal.issuedFor === "checkout") {
    await enforceRateLimit({ key: `tickets.generated:checkout_grant:${principal.grantId}`, ...CHECKOUT_GRANT_DOWNLOAD_RATE });
  }
  if (principal.kind === "staff") {
    // Fail closed: no audit row, no bytes.
    await audit(principal.actor, "tickets.view_generated_document", { type: "generated_document", id }, { after: { orderId: owner.order.id, fields: ["generated_documents.content"] } });
  }

  const served = await readServableGenerated(id);
  if (served.kind === "unavailable") {
    if (served.reason === "redrawing" || served.reason === "no_store") {
      return json({ status: "preparing" }, { status: 503, headers: { ...TICKET_HEADERS, "retry-after": String(PREPARING_RETRY_AFTER_SECONDS) } });
    }
    return ticketNotFound("not_servable", principal.kind, grant);
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
      "content-disposition": attachmentDisposition(generatedDownloadName(served.document.kind, owner.order.reference, served.document.displayNumber)),
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
      "x-frame-options": "DENY",
    },
  });
});
