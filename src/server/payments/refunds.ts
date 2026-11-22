import "server-only";
import { Prisma } from "@prisma/client";
import { prisma, TX_OPTIONS, type Tx } from "../lib/db";
import { uuidv7 } from "../lib/ids";
import { log } from "../lib/logger";
import { appendOnce, lockPayment } from "./ledger";
import type { RemedyRequest } from "./contracts";
import type { GatewayRegistry } from "./registry";
import { enqueueCrmSyncForOrders } from "../crm/crm.outbox";

/**
 * Refunds and customer remedies (F5, F16, F45, F46, F56; SUP-20, TKT-8).
 *
 *  - A refund is opened as a `refunds` row (status `requested`) together with
 *    its `customer_remedies` row, in the caller's transaction, before the
 *    provider is asked. The database refuses a non-failed total above the
 *    payment's captured amount (trigger `refunds_enforce_cap`); `open` checks
 *    first so the caller gets a typed refusal.
 *  - `drive` sends it with the row's own idempotency key and tracks it:
 *    `requested`/`unknown` → `accepted` → `succeeded` | `failed`. An unknown
 *    answer is re-sent with the same key (the provider answers the first
 *    request), never with a new one. Success books −amount in the
 *    customer-money ledger and raises the payment's `refunded_minor`. A
 *    definite refusal of the re-send of an `unknown` refund is settled by the
 *    provider's own record of that refund, found by its reference (the
 *    idempotency key) and read by its provider refund id, never by the
 *    refusal alone or the payment's refunded total (CR-B3-15).
 *  - A dispute or chargeback on the payment freezes refunds (F56): `open`
 *    refuses and `drive` sends nothing new while one is recorded. A refund
 *    already sent is still tracked. No dispute automation exists.
 *  - A release of an uncaptured hold is a `release_authorization` remedy with
 *    no refund row; the saga voids the hold (or waits for the provider's
 *    automatic release) and closes the remedy.
 *
 * Nothing here reads or writes `supplier_bookings`: a remedy only names the
 * attempt it compensates (SUP-20).
 */

export type RefundRefusal = "refunds_frozen" | "refund_cap" | "nothing_to_refund" | "payment_not_refundable";

export class RefundRefused extends Error {
  constructor(readonly reason: RefundRefusal) {
    super(`Refund refused: ${reason}`);
    this.name = "RefundRefused";
  }
}

const OPEN_REFUND = ["requested", "accepted", "unknown"] as const;
const DISPUTE_PREFIXES = ["dispute.", "chargeback."];

type Db = Tx | typeof prisma;

/** Whether a verified dispute or chargeback event names this provider payment. */
export async function refundsFrozen(db: Db, provider: string, providerPaymentId: string | null): Promise<boolean> {
  if (!providerPaymentId) return false;
  const n = await db.paymentEvent.count({
    where: { provider, providerPaymentId, OR: DISPUTE_PREFIXES.map((p) => ({ type: { startsWith: p } })) },
  });
  return n > 0;
}

export function isDisputeType(type: string): boolean {
  return DISPUTE_PREFIXES.some((p) => type.startsWith(p));
}

/**
 * Money committed to refunds on one payment (migration
 * 20261101140000_refund_cap_counts_provider_refunds): with R = `refunded_minor`
 * (the provider-confirmed total, which includes refunds made outside Outly),
 * S = Outly's succeeded refunds (already inside R once synced) and O = its
 * open ones (requested, accepted, unknown), it is GREATEST(R, S) + O. The
 * same rule as the database cap.
 */
export function committedRefundMinor(r: { refunded: bigint; succeeded: bigint; open: bigint }): bigint {
  return (r.refunded > r.succeeded ? r.refunded : r.succeeded) + r.open;
}

/**
 * `refunded_minor` after a refund settles: a max-merge of what is recorded,
 * Outly's succeeded total including this refund, and the provider's own
 * total when it was read. A refund a provider sync already counted is never
 * added again. Never above captured (the payments check).
 */
export function mergedRefundedMinor(current: bigint, succeededAfter: bigint, providerReported: bigint | null, captured: bigint): bigint {
  let r = current > succeededAfter ? current : succeededAfter;
  if (providerReported !== null && providerReported > r) r = providerReported;
  return r > captured ? captured : r;
}

async function refundSums(db: Db, paymentId: string): Promise<{ succeeded: bigint; open: bigint }> {
  const [succeeded, open] = await Promise.all([
    db.refund.aggregate({ where: { paymentId, status: "succeeded" }, _sum: { amountMinor: true } }),
    db.refund.aggregate({ where: { paymentId, status: { in: [...OPEN_REFUND] } }, _sum: { amountMinor: true } }),
  ]);
  return { succeeded: succeeded._sum.amountMinor ?? 0n, open: open._sum.amountMinor ?? 0n };
}

/** What may still be refunded: captured − (GREATEST(R, S) + O). Never below zero. */
export async function refundableMinor(db: Db, paymentId: string): Promise<bigint> {
  const p = await db.payment.findUnique({ where: { id: paymentId }, select: { capturedMinor: true, refundedMinor: true } });
  if (!p) return 0n;
  const left = p.capturedMinor - committedRefundMinor({ refunded: p.refundedMinor, ...(await refundSums(db, paymentId)) });
  return left > 0n ? left : 0n;
}

/**
 * What the provider reports refunded beyond every Outly refund, settled or
 * open: R − (S + O), never below zero. Above zero, someone refunded outside
 * Outly (the provider's dashboard).
 */
export async function refundedOutsideOutlyMinor(db: Db, paymentId: string): Promise<bigint> {
  const p = await db.payment.findUnique({ where: { id: paymentId }, select: { refundedMinor: true } });
  if (!p) return 0n;
  const { succeeded, open } = await refundSums(db, paymentId);
  const outside = p.refundedMinor - succeeded - open;
  return outside > 0n ? outside : 0n;
}

function isCapViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /refunds: (non-failed refunds would total|currency)/.test(msg);
}

export interface OpenRefundInput extends RemedyRequest {
  paymentId: string;
  /** Staff member for a manual refund; null for the saga. */
  requestedBy?: string | null;
}

/**
 * Open a refund and its remedy in the caller's transaction (READ COMMITTED,
 * Prisma's default). Locks the payment row first, like the cap trigger.
 * `remedyId` names a refund remedy recorded earlier with no refund yet
 * (`openPendingRefund`); it gets this refund instead of a new remedy row.
 */
export async function openRefund(tx: Tx, input: OpenRefundInput, opts: { remedyId?: string } = {}): Promise<{ refundId: string; remedyId: string }> {
  await lockPayment(tx, input.paymentId);
  const p = await tx.payment.findUnique({
    where: { id: input.paymentId },
    select: { id: true, provider: true, gatewayPaymentId: true, source: true, currency: true, capturedMinor: true },
  });
  if (!p || p.source !== "gateway_verified" || !p.provider || !p.gatewayPaymentId) throw new RefundRefused("payment_not_refundable");
  if (await refundsFrozen(tx, p.provider, p.gatewayPaymentId)) throw new RefundRefused("refunds_frozen");
  if (input.amountMinor <= 0n) throw new RefundRefused("nothing_to_refund");
  if (input.currency !== p.currency || input.amountMinor > (await refundableMinor(tx, p.id))) throw new RefundRefused("refund_cap");
  const n = await tx.refund.count({ where: { paymentId: p.id } });
  const refundId = uuidv7();
  try {
    await tx.refund.create({
      data: {
        id: refundId,
        paymentId: p.id,
        orderItemId: input.orderItemId,
        provider: p.provider,
        idempotencyKey: `refund:${p.id}:${n + 1}`,
        amountMinor: input.amountMinor,
        currency: input.currency,
        reason: input.reason,
        outlyFunded: input.outlyFunded,
        requestedBy: input.requestedBy ?? null,
      },
    });
  } catch (e) {
    if (isCapViolation(e)) throw new RefundRefused("refund_cap");
    throw e;
  }
  if (opts.remedyId) {
    const attached = await tx.customerRemedy.updateMany({
      where: { id: opts.remedyId, kind: "refund", refundId: null, status: "pending", orderItemId: input.orderItemId },
      data: { refundId, status: "in_progress", amountMinor: input.amountMinor },
    });
    if (attached.count === 1) return { refundId, remedyId: opts.remedyId };
  }
  const remedyId = uuidv7();
  await tx.customerRemedy.create({
    data: {
      id: remedyId,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      supplierBookingId: input.supplierBookingId,
      kind: "refund",
      reason: input.reason,
      amountMinor: input.amountMinor,
      currency: input.currency,
      outlyFunded: input.outlyFunded,
      status: "in_progress",
      refundId,
    },
  });
  return { refundId, remedyId };
}

/** Record that an uncaptured authorization is being released (void or provider auto-release). */
export async function openRelease(tx: Tx, input: RemedyRequest): Promise<string> {
  const open = await tx.customerRemedy.findFirst({
    where: { orderItemId: input.orderItemId, kind: "release_authorization", status: { in: ["pending", "in_progress"] } },
    select: { id: true },
  });
  if (open) return open.id;
  const id = uuidv7();
  await tx.customerRemedy.create({
    data: {
      id,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      supplierBookingId: input.supplierBookingId,
      kind: "release_authorization",
      reason: input.reason,
      amountMinor: input.amountMinor,
      currency: input.currency,
      outlyFunded: false,
      status: "in_progress",
    },
  });
  return id;
}

export async function closeRelease(tx: Tx, orderItemId: string, status: "completed" | "failed" | "cancelled"): Promise<void> {
  await tx.customerRemedy.updateMany({ where: { orderItemId, kind: "release_authorization", status: { in: ["pending", "in_progress"] } }, data: { status } });
}

/**
 * Record a refund that waits for the supplier hold to be released first
 * (CR-B3-1): a `refund` remedy, `pending`, with no refund row, so nothing is
 * sent to the provider yet. One per order item at a time.
 */
export async function openPendingRefund(tx: Tx, input: RemedyRequest): Promise<string> {
  const open = await tx.customerRemedy.findFirst({ where: { orderItemId: input.orderItemId, kind: "refund", refundId: null, status: "pending" }, select: { id: true } });
  if (open) return open.id;
  const id = uuidv7();
  await tx.customerRemedy.create({
    data: {
      id,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      supplierBookingId: input.supplierBookingId,
      kind: "refund",
      reason: input.reason,
      amountMinor: input.amountMinor,
      currency: input.currency,
      outlyFunded: input.outlyFunded,
      status: "pending",
    },
  });
  return id;
}

/** Close the remedies an order item was waiting to carry out (a release, or a refund not sent yet). */
export async function closeWaitingRemedies(tx: Tx, orderItemId: string, status: "completed" | "cancelled"): Promise<void> {
  await closeRelease(tx, orderItemId, status);
  await tx.customerRemedy.updateMany({ where: { orderItemId, kind: "refund", refundId: null, status: "pending" }, data: { status } });
}

type Gateway = NonNullable<ReturnType<GatewayRegistry["forProvider"]>>;

export function createRefundDriver(deps: { gateways: GatewayRegistry; now: () => Date; db?: typeof prisma }) {
  const db = deps.db ?? prisma;

  /** `providerRefunded`: the provider's refunded total from a read of the payment, merged into `refunded_minor`. */
  async function settle(refundId: string, outcome: "succeeded" | "failed", at: Date, providerRefunded: bigint | null = null) {
    await db.$transaction(async (tx) => {
      const r = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, include: { payment: true } });
      await lockPayment(tx, r.paymentId);
      const moved = await tx.refund.updateMany({ where: { id: refundId, status: { in: [...OPEN_REFUND] } }, data: { status: outcome } });
      if (!moved.count) return;
      await tx.customerRemedy.updateMany({ where: { refundId }, data: { status: outcome === "succeeded" ? "completed" : "failed" } });
      if (outcome === "failed") {
        log.error("payments.refund_failed", { refundId, paymentId: r.paymentId });
        return;
      }
      const p = await tx.payment.findUniqueOrThrow({ where: { id: r.paymentId }, select: { capturedMinor: true, refundedMinor: true } });
      // Max-merge, never an addition: a provider sync may already have counted this refund.
      const { succeeded } = await refundSums(tx, r.paymentId);
      const refunded = mergedRefundedMinor(p.refundedMinor, succeeded, providerRefunded, p.capturedMinor);
      await tx.payment.update({ where: { id: r.paymentId }, data: { refundedMinor: refunded, status: refunded >= p.capturedMinor ? "refunded" : "partially_refunded" } });
      await appendOnce(tx, {
        book: "customer_money",
        orderId: r.payment.orderId,
        supplierBookingId: null,
        paymentId: r.paymentId,
        currency: r.currency,
        amountMinor: -r.amountMinor,
        kind: "refund",
        // No environment column on ledger_entries: the evidence ref carries it.
        evidenceRef: `refund:${r.payment.environment ?? "unknown"}:${r.provider}:${r.providerRefundId ?? r.idempotencyKey}`,
        occurredAt: at.toISOString(),
      });
      // CRM outbox: a verified refund lowers the deal's opportunity (doc 29 §5.4).
      await enqueueCrmSyncForOrders(tx, [r.payment.orderId]);
    }, TX_OPTIONS);
  }

  /**
   * This refund at the provider, found by the reference it was sent with (its
   * idempotency key), never inferred from the payment's refunded total: a
   * dashboard refund in between would make a refund that never landed look
   * landed (CR-B3-15). `absent`: the provider's complete list has no refund
   * with that reference; null when the list cannot be read or does not match.
   */
  async function findAtProvider(r: { id: string; idempotencyKey: string; amountMinor: bigint }, providerPaymentId: string, gw: Gateway): Promise<{ providerRefundId: string } | "absent" | null> {
    const list = await gw.listRefunds(providerPaymentId);
    if (!list.ok) return null;
    const found = list.refunds.filter((x) => x.reference === r.idempotencyKey);
    if (!found.length) return "absent";
    if (found.length > 1 || found[0].amountMinor !== r.amountMinor) {
      log.error("payments.refund_reference_mismatch", { refundId: r.id, matches: found.length });
      return null;
    }
    return { providerRefundId: found[0].providerRefundId };
  }

  /** The provider's refunded total for the payment, or null when it cannot be read. */
  async function providerRefundedMinor(providerPaymentId: string, gw: Gateway): Promise<bigint | null> {
    const o = await gw.getPayment(providerPaymentId);
    return o.kind === "ok" ? o.payment.refundedMinor : null;
  }

  /**
   * Move one refund as far as the provider allows now. Returns its status
   * afterwards. Never throws for a provider answer; a database fault throws.
   */
  async function drive(refundId: string): Promise<string> {
    const r = await db.refund.findUnique({ where: { id: refundId }, include: { payment: { select: { provider: true, gatewayPaymentId: true } } } });
    if (!r) return "missing";
    if (r.status === "succeeded" || r.status === "failed") return r.status;
    const gw = deps.gateways.forProvider(r.provider);
    if (!gw || !r.payment.gatewayPaymentId) return r.status;

    let status = r.status;
    let providerRefundId = r.providerRefundId;
    if (status === "requested" || status === "unknown") {
      if (status === "requested" && (await refundsFrozen(db, r.provider, r.payment.gatewayPaymentId))) return status;
      let sent = await gw.refund(r.payment.gatewayPaymentId, r.amountMinor, r.idempotencyKey);
      if (sent.kind === "failed" && status === "unknown") {
        // The first request may have landed (an expired key, a provider that forgot it): find that refund and track it by its own id.
        const found = await findAtProvider(r, r.payment.gatewayPaymentId, gw);
        if (found === null) {
          log.warn("payments.refund_unresolved", { refundId: r.id });
          return "unknown";
        }
        if (found === "absent") {
          await settle(r.id, "failed", deps.now());
          return "failed";
        }
        sent = { kind: "accepted", providerRefundId: found.providerRefundId };
      }
      if (sent.kind === "failed") {
        await settle(r.id, "failed", deps.now());
        return "failed";
      }
      if (sent.kind === "unknown") {
        // Never sent: still `requested`. Possibly sent: `unknown`, re-sent later with the same key.
        if (sent.sent) await db.refund.updateMany({ where: { id: r.id, status: { in: ["requested", "unknown"] } }, data: { status: "unknown" } });
        return sent.sent ? "unknown" : status;
      }
      providerRefundId = sent.providerRefundId;
      try {
        await db.refund.updateMany({ where: { id: r.id, status: { in: ["requested", "unknown"] } }, data: { status: "accepted", providerRefundId } });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return "unknown";
        throw e;
      }
      status = "accepted";
    }
    if (status === "accepted" && providerRefundId) {
      const read = await gw.getRefund(providerRefundId);
      if (read.status === "failed") {
        await settle(r.id, "failed", deps.now());
        return "failed";
      }
      if (read.status === "succeeded") {
        // Settled with the provider's own total, so a refund a sync already counted is not added again; unreadable: stays open (counted in O).
        const providerRefunded = await providerRefundedMinor(r.payment.gatewayPaymentId, gw);
        if (providerRefunded === null) return status;
        await settle(r.id, "succeeded", deps.now(), providerRefunded);
        return "succeeded";
      }
    }
    return status;
  }

  /** `stop` (a caller's time cap): asked before each refund is started; the rest stay open for the next run. Returns how many were started. */
  async function driveOpen(limit = 50, opts: { stop?: () => boolean } = {}): Promise<number> {
    const open = await db.refund.findMany({ where: { status: { in: [...OPEN_REFUND] } }, orderBy: { createdAt: "asc" }, take: limit, select: { id: true } });
    let started = 0;
    for (const r of open) {
      if (opts.stop?.()) break;
      started++;
      try {
        await drive(r.id);
      } catch (error) {
        log.error("payments.refund_drive_failed", { refundId: r.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return started;
  }

  return { drive, driveOpen };
}

export type RefundDriver = ReturnType<typeof createRefundDriver>;
