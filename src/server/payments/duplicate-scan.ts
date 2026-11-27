import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db";
import type { OpsIncident } from "../services/ops-alert.service";

/**
 * The duplicate-payment scan of the payments tick (saga.ts `advanceOpen`,
 * F45; review 102c D5).
 *
 * In production a gateway-verified payment with no saga is created in one
 * place only: the duplicate branch of `admit` (a second successful payment
 * on an order already paid). Every tick reads up to `DUPLICATE_SCAN_PAGE`
 * of them that still hold money and are not left for finance, oldest first,
 * and settles each one (refund, or void a hold). A duplicate that can never
 * be settled automatically gets a `failure_code` and leaves the scan, so it
 * cannot hold a place in the page for ever:
 *  - `quarantined_<mismatch>`: the provider's read no longer matches the row
 *    (the same code `admit` gives a duplicate mismatched from the start);
 *  - `duplicate_no_saga`: the order has no saga, so there is no item to
 *    refund against;
 *  - `duplicate_hold_not_released`: an authorised hold the provider cannot
 *    void, still reported authorised `AUTO_RELEASE_GRACE_MS` after its
 *    expiry, or with no expiry at all;
 *  - `duplicate_refund_failed` (unchanged): the one automatic refund failed.
 * A provider with no configured gateway is not marked: that is a
 * configuration state, not a property of the payment, and the rows must be
 * refunded once the gateway is back. They are left out of the page (so they
 * cannot fill it) and reported on every tick (`payments.duplicate_no_gateway`).
 *
 * A page that comes back full means duplicates may be waiting behind it.
 * The tick reports it (`payments.duplicate_scan_full`, error level) and the
 * ops-alert sweep emails staff (`duplicateScanIncidents`).
 */

/** Duplicates one tick reads at most. */
export const DUPLICATE_SCAN_PAGE = 50;

/** Duplicates still holding money and not left for finance. */
export const DUPLICATE_SCAN_WHERE: Prisma.PaymentWhereInput = {
  source: "gateway_verified",
  saga: null,
  failureCode: null,
  status: { in: ["authorized", "captured"] },
  provider: { not: null },
};

/** Oldest first, so the page is the same rows in the same order on every tick until they settle. */
export const DUPLICATE_SCAN_ORDER: Prisma.PaymentOrderByWithRelationInput[] = [{ createdAt: "asc" }, { id: "asc" }];

/** Entity of the ops alert (no new entity kind, so no migration). */
const ENTITY_ID = "duplicate_scan";

/**
 * The incident for one read of the scan's first page (oldest first): none
 * unless the page is full. Raised when the page's newest row arrived, but
 * never before the start of the current UTC day, so a backlog that stays
 * full is mailed again once a day (the ops-alert dedup allows one per 6 h),
 * and an old backlog is not dropped by the 72-hour lookback. Pure, for tests.
 */
export function duplicateScanIncident(page: { createdAt: Date }[], now: Date): OpsIncident | null {
  if (page.length < DUPLICATE_SCAN_PAGE) return null;
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const newest = Math.max(...page.map((p) => p.createdAt.getTime()));
  const raisedAt = new Date(Math.min(now.getTime(), Math.max(dayStart, newest)));
  return {
    kind: "duplicate_scan_full",
    entityKind: "payment_saga",
    entityId: ENTITY_ID,
    reason: "duplicate_scan_full",
    raisedAt,
    orderId: null,
    orderReference: null,
    bookingId: null,
    supplierBookingRef: null,
    adminPath: "/admin",
  };
}

/** Read by the ops-alert sweep (ops-alert.service.ts `collectOpsIncidents`). */
export async function duplicateScanIncidents(since: Date, now: Date): Promise<OpsIncident[]> {
  const page = await prisma.payment.findMany({ where: DUPLICATE_SCAN_WHERE, orderBy: DUPLICATE_SCAN_ORDER, take: DUPLICATE_SCAN_PAGE, select: { createdAt: true } });
  const incident = duplicateScanIncident(page, now);
  return incident && incident.raisedAt.getTime() >= since.getTime() ? [incident] : [];
}
