import "server-only";
import type { Actor } from "../lib/actor";
import { prisma, type Tx } from "../lib/db";
import { Errors } from "../lib/errors";
import type { OpsIncident } from "./ops-alert.service";

/**
 * Server-side binding of a bulk item write to its run (doc 30 §3.12; review
 * 105 N2-06). The writers that act for a bulk run without a code of their own
 * (`catalogService.setProductModeForBulk`,
 * `supplierCatalogService.recordNoTicketForBulk`) call this inside the
 * transaction of their write. It checks that the run exists, was started by
 * this person, is inside its window, that the listing is an item of the run
 * claimed for execution (`running`), and, for a loosening write, that the
 * run's action allows it and its approval is an applied
 * `instant.activate.bulk` approval.
 *
 * Kept apart from bulk-listing.service.ts so the catalogue services can use it
 * without an import cycle. Also holds the ops incident for a
 * free-cancellation item that disarmed a listing and could not re-arm it.
 */

export type BulkWrite = "inquiry" | "instant" | "no_ticket";

const LOOSENING_ACTIONS: Record<Exclude<BulkWrite, "inquiry">, readonly string[]> = {
  instant: ["arm", "free_cancellation"],
  no_ticket: ["free_cancellation"],
};

export async function assertBulkItemInTx(tx: Tx, actor: Actor, bulkId: string, productId: string, write: BulkWrite, now: Date): Promise<{ approvalId: string | null }> {
  const bulk = await tx.bulkOperation.findUnique({ where: { id: bulkId }, include: { approval: { select: { status: true, operation: true } } } });
  const fail = (why: string) => Errors.conflict(`This bulk write is not allowed: ${why}`, { bulkId, reason: "bulk_guard" });
  if (!bulk) throw fail("the run does not exist");
  if (!actor.id || bulk.requestedBy !== actor.id) throw Errors.forbidden("products.activate_instant");
  if (now.getTime() >= bulk.expiresAt.getTime()) throw fail("the run's window has closed");
  if (write !== "inquiry") {
    if (!LOOSENING_ACTIONS[write].includes(bulk.action)) throw fail("the run's action does not allow it");
    if (!bulk.approvalId || bulk.approval?.status !== "applied" || bulk.approval.operation !== "instant.activate.bulk") throw fail("the run has no applied approval");
  }
  const item = await tx.bulkOperationItem.findUnique({ where: { bulkId_productId: { bulkId, productId } }, select: { state: true } });
  if (!item || item.state !== "running") throw fail("the listing is not a running item of the run");
  return { approvalId: bulk.approvalId };
}

/** Outcome prefix of a free-cancellation item that failed after disarming and could not arm the listing again. */
export const DISARMED_OUTCOME = "failed_after_disarm:";

/** Ops incidents: listings a free-cancellation run left on inquiry after a failure (review N2-04). Ids only. */
export async function bulkDisarmIncidents(since: Date, _now: Date, limit = 100, db: Tx | typeof prisma = prisma): Promise<OpsIncident[]> {
  const rows = await db.bulkOperationItem.findMany({
    where: { state: "failed", outcome: { startsWith: DISARMED_OUTCOME }, finishedAt: { gt: since } },
    select: { id: true, finishedAt: true, productId: true },
    orderBy: { finishedAt: "asc" },
    take: limit,
  });
  return rows.map((r) => ({
    kind: "bulk_item_disarmed" as const,
    entityKind: "bulk_operation_item" as const,
    entityId: r.id,
    reason: "disarmed_not_rearmed",
    raisedAt: r.finishedAt!,
    orderId: null,
    orderReference: null,
    bookingId: null,
    supplierBookingRef: null,
    adminPath: `/admin/activities/${r.productId}`,
  }));
}
