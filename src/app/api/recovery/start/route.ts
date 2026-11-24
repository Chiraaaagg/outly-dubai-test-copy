import type { NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin, clientIp, handle, json, parseJson } from "@/server/lib/http";
import { recoveryService } from "@/server/services/recovery.service";
import { TICKET_HEADERS } from "@/app/api/tickets/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({
  reference: z.string().min(1).max(32),
  channel: z.enum(["phone", "email"]),
  contact: z.string().min(1).max(254),
});

/**
 * POST /api/recovery/start — `{ reference, channel, contact }` → 200
 * `{ challengeId }` always (doc 22 §26 F23; recovery.service.ts).
 *
 * A code is sent only when the contact matches the order's bound, verified
 * contact; otherwise the id is a decoy and nothing is sent, with the same
 * answer and about the same timing. Same-origin JSON only. Rate limits per
 * IP, per reference, per contact and global are Postgres-backed and fail
 * closed. No analytics event; the logs carry no contact or code.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  const body = await parseJson(req, bodySchema, { maxBytes: 1024 });
  const { challengeId } = await recoveryService.start({ ...body, ip: clientIp(req) ?? null });
  return json({ challengeId }, { headers: { ...TICKET_HEADERS } });
});
