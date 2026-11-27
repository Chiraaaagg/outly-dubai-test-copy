import type { NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin, clientIp, handle, json, parseJson } from "@/server/lib/http";
import { isAppError } from "@/server/lib/errors";
import { setTicketAccessCookie, ticketAccessFromRequest } from "@/server/lib/customer-session";
import { addAccessEntry } from "@/server/services/capability.service";
import { recoveryService } from "@/server/services/recovery.service";
import { TICKET_HEADERS } from "@/app/api/tickets/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({ challengeId: z.string().min(1).max(64), code: z.string().min(1).max(16) });

function invalid() {
  return json({ error: { code: "CODE_INVALID", message: "That code is not valid. Check it, or ask for a new one." } }, { status: 400, headers: { ...TICKET_HEADERS } });
}

/**
 * POST /api/recovery/verify — `{ challengeId, code }` → 200 `{ reference }`
 * and a ticket-access grant for that order ADDED to the browser's
 * `outlyy_ticket_access` cookie (R-B4-11); every failure, including a rate
 * limit, is the same 400 `{ error: { code: "CODE_INVALID" } }` (doc 22 §26
 * F23; recovery.service.ts). Same-origin JSON only.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  let body: z.infer<typeof bodySchema>;
  try {
    body = await parseJson(req, bodySchema, { maxBytes: 512 });
  } catch (e) {
    // A wrong-shaped body is one more invalid code; a non-JSON or oversized body keeps its transport error.
    if (isAppError(e) && e.code === "VALIDATION_FAILED") return invalid();
    throw e;
  }
  const result = await recoveryService.verify({ ...body, ip: clientIp(req) ?? null });
  if (!result.ok) return invalid();
  const cookie = addAccessEntry(ticketAccessFromRequest(req), result.cookieValue);
  if (!cookie) return invalid();
  const res = json({ reference: result.reference }, { headers: { ...TICKET_HEADERS } });
  setTicketAccessCookie(res, cookie.value, cookie.expiresAt);
  return res;
});
