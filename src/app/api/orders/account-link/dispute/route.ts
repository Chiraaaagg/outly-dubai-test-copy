import type { NextRequest } from "next/server";
import { customerIdentityService } from "@/server/services/customer-identity.service";
import { assertSameOrigin, clientIp, handle, json, parseJson, userAgent } from "@/server/lib/http";
import { accountLinkDisputeSchema } from "@/server/schemas/customer.schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/orders/account-link/dispute — `{ token }` from the "This was not
 * me" link (owner Q10, Q-B4). Detaches the order and alerts staff when the
 * token is live; the answer is `{ ok: true }` for a valid, used, expired or
 * unknown token alike. Under /api/orders, so never cached or indexed.
 */
export const POST = handle(async (req: NextRequest) => {
  assertSameOrigin(req);
  const body = await parseJson(req, accountLinkDisputeSchema, { maxBytes: 1024 });
  await customerIdentityService.dispute({ token: body.token, ip: clientIp(req), userAgent: userAgent(req) });
  return json({ ok: true });
});
