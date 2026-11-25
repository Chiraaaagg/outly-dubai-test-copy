import type { NextRequest } from "next/server";
import { assertSameOrigin, handle, json } from "@/server/lib/http";
import { requireAdmin } from "@/server/lib/guards";
import { Errors } from "@/server/lib/errors";
import { isValidReference } from "@/server/lib/ids";
import { notificationService } from "@/server/services/notification.service";
import { TICKET_HEADERS } from "../../../shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ reference: string }> };

/**
 * POST /api/tickets/orders/:reference/resend — staff with `tickets.resend`
 * (§24.3) send the tickets email again. A new outbox row with a fresh
 * capability; the previous link stops working (TKT-6). Audited by the
 * service with field names and ids only. No body.
 */
export const POST = handle<Ctx>(async (req: NextRequest, ctx) => {
  assertSameOrigin(req);
  const { actor } = await requireAdmin(req, "tickets.resend");
  const reference = ((await ctx.params).reference ?? "").trim().toUpperCase();
  if (!isValidReference(reference, "OUT")) throw Errors.notFound("Order");
  const result = await notificationService.resendTickets(actor, { orderReference: reference });
  return json({ id: result.id, outcome: result.outcome, status: result.status, duplicate: Boolean(result.duplicate) }, { headers: { ...TICKET_HEADERS } });
});
