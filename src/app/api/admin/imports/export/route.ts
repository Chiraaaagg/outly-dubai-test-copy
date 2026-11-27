import { NextResponse, type NextRequest } from "next/server";
import { importService } from "@/server/services/import.service";
import { traveldeskListingService } from "@/server/services/traveldesk-listing.service";
import { handle } from "@/server/lib/http";
import { RATE, requireAdmin } from "@/server/lib/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/imports/export — every activity as an import-compatible CSV
 * (`products.edit`, 20/hour). `?template=blank` returns the header row only:
 * the blank template. Both use the canonical column list, so either file
 * re-imports without remapping. `x-outlyy-export-skipped` counts listings
 * whose stored document no longer validates (fix them in the editor).
 * `?source=traveldesk` (optionally `&batch=<id>`) exports only the imported
 * TravelDesk listings: the spreadsheet round trip of doc 30 §3.7 (D13).
 */
export const GET = handle(async (req: NextRequest) => {
  const { actor } = await requireAdmin(req, "products.edit", RATE.adminHeavy);
  const blank = req.nextUrl.searchParams.get("template") === "blank";
  const traveldesk = req.nextUrl.searchParams.get("source") === "traveldesk";
  const batch = req.nextUrl.searchParams.get("batch");
  const batchId = batch && /^[0-9a-f-]{36}$/i.test(batch) ? batch : undefined;
  const { csv, skipped } = traveldesk ? await traveldeskListingService.exportCsv(actor, { batchId }) : await importService.exportCsv(actor, { blank });
  const day = new Date().toISOString().slice(0, 10);
  const name = blank ? "outlyy-activity-template.csv" : traveldesk ? `outlyy-traveldesk-listings-${day}.csv` : `outlyy-activities-${day}.csv`;
  return new NextResponse(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
      "x-outlyy-export-skipped": String(skipped.length),
    },
  });
});
