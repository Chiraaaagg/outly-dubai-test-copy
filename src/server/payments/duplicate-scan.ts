import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db";
import type { OpsIncident, OpsIncidentKind } from "../services/ops-alert.service";
import { paymentGateways } from "./registry";

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
 *  - `quarantined_<mismatch>`: the provider's read of the payment no longer
 *    matches the row (the same code `admit` gives a duplicate mismatched from
 *    the start). Only when this deployment's gateway is still the row's own
 *    account: a mismatch of provider, environment or account id is a
 *    configuration state and is not marked;
 *  - `duplicate_no_saga`: the order has no saga, so there is no item to
 *    refund against;
 *  - `duplicate_hold_not_released`: an authorised hold the provider cannot
 *    void, still reported authorised `AUTO_RELEASE_GRACE_MS` after its expiry
 *    (the provider's, or authorisation time plus the method's lifetime), or
 *    with no expiry that can be known;
 *  - `duplicate_refund_failed` (unchanged): the one automatic refund failed.
 * A provider with no configured gateway is not marked either: the rows must
 * be refunded once the gateway is back. They are left out of the page (so
 * they cannot fill it) and reported.
 *
 * Reporting: the tick logs `payments.duplicate_scan_full` (error) when its
 * page comes back full and `payments.duplicate_no_gateway` (warn) per
 * unserved provider; the ops-alert sweep emails staff from the same split
 * (`duplicateScanIncidents`).
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

type ForProvider = (provider: string) => unknown;

/** The providers that have scan rows, split by whether this deployment has a gateway for them. */
export async function duplicateProviders(forProvider: ForProvider): Promise<{ served: string[]; unserved: { provider: string; count: number; newest: Date | null }[] }> {
  const served: string[] = [];
  const unserved: { provider: string; count: number; newest: Date | null }[] = [];
  const groups = await prisma.payment.groupBy({ by: ["provider"], where: DUPLICATE_SCAN_WHERE, _count: { _all: true }, _max: { createdAt: true } });
  for (const g of groups) {
    if (!g.provider) continue;
    if (forProvider(g.provider)) served.push(g.provider);
    else unserved.push({ provider: g.provider, count: g._count?._all ?? 0, newest: g._max?.createdAt ?? null });
  }
  return { served, unserved };
}

/** The scan's page: oldest first, served providers only. */
export function duplicatePage(served: string[]): Promise<{ id: string; provider: string | null; createdAt: Date }[]> {
  return prisma.payment.findMany({ where: { ...DUPLICATE_SCAN_WHERE, provider: { in: served } }, orderBy: DUPLICATE_SCAN_ORDER, take: DUPLICATE_SCAN_PAGE, select: { id: true, provider: true, createdAt: true } });
}

/** Entity of both alerts (no new entity kind, so no migration). */
const ENTITY_ID = "duplicate_scan";

/**
 * An incident about the scan, raised when its newest row arrived, but never
 * before the start of the current UTC day: a state that lasts is mailed
 * again once a day (the ops-alert dedup allows one per 6 h), and an old
 * backlog is not dropped by the 72-hour lookback. Never in the future.
 * Pure, for tests.
 */
export function duplicateScanIncident(kind: Extract<OpsIncidentKind, "duplicate_scan_full" | "duplicate_no_gateway">, newest: Date, now: Date): OpsIncident {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    kind,
    entityKind: "payment_saga",
    entityId: ENTITY_ID,
    reason: kind,
    raisedAt: new Date(Math.min(now.getTime(), Math.max(dayStart, newest.getTime()))),
    orderId: null,
    orderReference: null,
    bookingId: null,
    supplierBookingRef: null,
    adminPath: "/admin",
  };
}

/**
 * Read by the ops-alert sweep (ops-alert.service.ts `collectOpsIncidents`):
 *  - `duplicate_scan_full`: the tick's page (served providers) is full, so a
 *    newer duplicate may wait behind it;
 *  - `duplicate_no_gateway`: duplicates of a provider this deployment has no
 *    gateway for are held and not refunded.
 */
export async function duplicateScanIncidents(since: Date, now: Date, forProvider: ForProvider = (p) => paymentGateways.forProvider(p)): Promise<OpsIncident[]> {
  const out: OpsIncident[] = [];
  const { served, unserved } = await duplicateProviders(forProvider);
  if (served.length) {
    const page = await duplicatePage(served);
    if (page.length >= DUPLICATE_SCAN_PAGE) out.push(duplicateScanIncident("duplicate_scan_full", new Date(Math.max(...page.map((p) => p.createdAt.getTime()))), now));
  }
  const newest = unserved.reduce<number | null>((m, u) => (u.newest && (m === null || u.newest.getTime() > m) ? u.newest.getTime() : m), null);
  if (unserved.length) out.push(duplicateScanIncident("duplicate_no_gateway", new Date(newest ?? now.getTime()), now));
  return out.filter((i) => i.raisedAt.getTime() >= since.getTime());
}
