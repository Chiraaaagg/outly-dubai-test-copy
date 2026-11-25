import type { NextRequest } from "next/server";
import { handle, json } from "@/server/lib/http";
import { prisma } from "@/server/lib/db";
import { isValidReference } from "@/server/lib/ids";
import { publicRateLimit, RATE } from "@/server/lib/guards";
import { inquiryReceiptFromRequest } from "@/server/lib/customer-session";
import { inquiryReceipt } from "@/server/services/inquiry-receipt.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } as const;

/**
 * GET /api/inquiries/receipt?ref=INQ-… — did this browser submit that
 * inquiry? (B5 stop condition, review R-B5-5.)
 *
 * 200 `{ received: true, reference }` only when the httpOnly receipt cookie
 * set by `POST /api/inquiries` verifies and names the stored inquiry with
 * that reference. Every other case, including no cookie, a forged or
 * expired one, or another reference, is the same 404, so the route never
 * confirms that a reference exists. No inquiry details are returned: the
 * page already holds what the customer typed, and shows it only after this
 * answer.
 */
export const GET = handle(async (req: NextRequest) => {
  await publicRateLimit(req, "inquiries.receipt", RATE.publicSearch);
  const notFound = () => json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404, headers: { ...HEADERS } });
  const ref = (req.nextUrl.searchParams.get("ref") ?? "").trim().toUpperCase();
  if (!isValidReference(ref, "INQ")) return notFound();
  const inquiryId = inquiryReceipt.verify(inquiryReceiptFromRequest(req));
  if (!inquiryId) return notFound();
  const row = await prisma.inquiry.findUnique({ where: { id: inquiryId }, select: { reference: true } });
  if (!row || row.reference !== ref) return notFound();
  return json({ received: true, reference: row.reference }, { headers: { ...HEADERS } });
});
