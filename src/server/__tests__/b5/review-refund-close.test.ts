import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import type { Actor } from "../../lib/actor";
import { resetEnvCache } from "@/server/lib/env";
import { uuidv7 } from "../../lib/ids";
import { ROLE_PERMISSIONS } from "../../lib/permissions";
import { assertDisposableDb, cleanupPeople, createCustomer, createStaff, dbEnabled, runId, syntheticPhone, type CustomerFixture, type StaffFixture } from "../helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, publishedProduct } from "../security/_mercury-fixtures";
import { cleanupCustomerRows, instantOrder, setupCustomerFixtures, type CustomerFixtures, type InstantOrder } from "./customer-fixtures";

/**
 * B5 review fixes in b7a8ea0 (doc 27 §2), on the disposable database:
 *
 *  - R-B5-2: the privileged `close_refund_failed` resolution. Owner decision
 *    (doc 22 §32.12): it closes a `refund_failed` request only when the
 *    provider shows the item's money back (a dashboard refund, or an unlinked
 *    succeeded Outly refund); a refund made outside the provider (bank
 *    transfer, credit) has no close path, and the request stays
 *    `refund_failed`.
 *  - R-B5-17: a flag staff cleared is not raised again by the tick for the
 *    same reason; a new reason raises it.
 *  - R-B5-18: the `refund_failed` recheck reads only rows whose refund changed
 *    since the request was last written.
 *
 * Every row is synthetic (customer-fixtures.ts: `zz-sec-<run>` orders, the
 * `zz-b5c-<run>` supplier, made-up AED amounts, no supplier net that means
 * anything). Staff are `zz-sec-<run>-` fixtures with a TOTP secret that exists
 * only for this run; codes go through the services' clock seam.
 */

const run = runId();
const EVIDENCE = `DASH-${run}-refund`;
const PAYABLE = 45_000n;

/** RFC 6238 code for `at` (as in console-ops.test.ts). */
function totpAt(secretB32: string, at: Date): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secretB32.replace(/=+$/, "")) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const h = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

type Prisma = Awaited<ReturnType<typeof db>>;

describe.skipIf(!dbEnabled)("B5 review fixes: refund_failed close, staff clears, recheck window (R-B5-2, 17, 18)", () => {
  let prisma: Prisma;
  let fx: CustomerFixtures;
  let A: CustomerFixture;
  let svc: typeof import("@/server/services/cancellation.service");
  let ops: typeof import("@/server/services/ops-queue.service").opsQueueService;
  const staff: Record<string, StaffFixture> = {};
  const secrets = new Map<string, string>();
  let clock = Date.UTC(2026, 10, 3, 6, 0, 0);
  const tick = () => new Date((clock += 90_000));
  const admin = (label: string): Actor => ({ type: "admin", id: staff[label].id, roles: ["admin"], permissions: new Set(ROLE_PERMISSIONS.admin) });
  const code = (label: string, at: Date) => totpAt(secrets.get(label)!, at);
  const audits = (action: string, entityId: string) => prisma.auditLog.findMany({ where: { action, entityId }, orderBy: { createdAt: "asc" } });
  const reasons = async (entityId: string) => (await audits("booking.privileged_resolution.refused", entityId)).map((r) => (r.after as { codes: { reason: string } }).codes.reason);
  /** Extra order items made by `moreItems`, with their refunds and requests, removed before the fixtures' own cleanup. */
  const extraItems: string[] = [];
  const extraOrders: string[] = [];

  function cancelledOrder(label: string): Promise<InstantOrder> {
    return instantOrder(prisma, run, fx, { label, owner: { kind: "customer", customerId: A.id }, sagaState: "fulfilled", capturedMinor: PAYABLE, bookingState: "cancelled", issuesTicketsAtConfirm: "no" });
  }

  async function refund(o: { paymentId: string; itemId: string }, status: string, over: Record<string, unknown> = {}) {
    const id = uuidv7();
    await prisma.refund.create({
      data: { id, paymentId: o.paymentId, orderItemId: o.itemId, provider: "fake_aed_card", idempotencyKey: `zz-b5r-${run}-${id}`, amountMinor: PAYABLE, currency: "AED", status, reason: "customer_cancellation", ...over },
    });
    return id;
  }

  /**
   * A supported request that ended `refund_failed`, as the cancellation step
   * leaves it: with its failed refund, or (`refundId: null`) refused at open.
   */
  async function failedRequest(o: InstantOrder, opts: { refundId: string | null; reasonCode?: string; attention?: boolean; updatedAt?: Date }) {
    const id = uuidv7();
    await prisma.cancellationRequest.create({
      data: {
        id,
        orderId: o.id,
        orderItemId: o.itemId,
        supplierBookingId: o.bookingId,
        kind: "supported",
        status: "refund_failed",
        requestedVia: "customer",
        refundId: opts.refundId,
        reasonCode: opts.reasonCode ?? (opts.refundId ? "refund_failed" : "refund_refund_cap"),
        attentionRequiredAt: opts.attention === false ? null : new Date(),
        ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
      },
    });
    return id;
  }

  const closeInput = (targetId: string, over: Record<string, unknown> = {}) => ({ action: "close_refund_failed", targetId, outcome: "refunded_at_provider", evidence: EVIDENCE, ...over });

  async function close(label: string, targetId: string, environment: "test" | "production" = "test") {
    const at = tick();
    return ops.requestResolution(admin(label), closeInput(targetId), { environment, totpCode: code(label, at), now: at });
  }

  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    prisma = await db();
    svc = await import("@/server/services/cancellation.service");
    ops = (await import("@/server/services/ops-queue.service")).opsQueueService;
    fx = await setupCustomerFixtures(prisma, run, await publishedProduct());
    A = await createCustomer(run, syntheticPhone(run, 71));
    const { encryptSecret, generateTotpSecret } = await import("@/server/lib/crypto");
    // One admin per concern: a step-up is limited to 8 per user per 10 minutes (approval.service.ts), shared with login.
    for (const label of ["a", "b", "c"]) {
      staff[label] = await createStaff(run, `rc-${label}`, ["admin"]);
      const secret = generateTotpSecret();
      secrets.set(label, secret);
      await prisma.adminUser.update({ where: { id: staff[label].id }, data: { totpSecretEncrypted: encryptSecret(secret) } });
    }
    const { documentService } = await import("@/server/services/document.service");
    vi.spyOn(documentService, "listForOrder").mockImplementation(async () => []);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (!prisma) return;
    const ids = Object.values(staff).map((s) => s.id);
    const approvals = await prisma.privilegedApproval.findMany({ where: { OR: [{ requestedBy: { in: ids } }, { approvedBy: { in: ids } }] }, select: { id: true } });
    await prisma.idempotencyKey.deleteMany({ where: { scope: "privileged_use", key: { in: approvals.map((x) => `privileged_use:${x.id}`) } } });
    await prisma.privilegedApproval.deleteMany({ where: { id: { in: approvals.map((x) => x.id) } } });
    await prisma.idempotencyKey.deleteMany({ where: { scope: "admin_totp", OR: ids.map((id) => ({ key: { startsWith: `totp:${id}:` } })) } });
    await prisma.rateLimitBucket.deleteMany({ where: { key: { in: ids.map((id) => `admin_totp:${id}`) } } }).catch(() => {});
    const orderIds = [...(fx?.orders.map((o) => o.id) ?? []), ...extraOrders];
    await prisma.cancellationRequest.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.customerRemedy.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.refund.deleteMany({ where: { orderItem: { orderId: { in: orderIds } } } });
    await prisma.orderItem.deleteMany({ where: { id: { in: extraItems } } });
    await prisma.payment.deleteMany({ where: { orderId: { in: extraOrders } } });
    await prisma.order.deleteMany({ where: { id: { in: extraOrders } } });
    await cleanupCustomerRows(prisma, fx);
    await cleanupBusinessRows(run);
    await cleanupPeople(run);
  });

  /* ---------------------------------------------------------------- R-B5-2 */

  describe("R-B5-2: close_refund_failed", () => {
    it("refused when the provider shows no refund: a refund made outside the provider (bank transfer, credit) has no close path; audited, nothing changes", async () => {
      const o = await cancelledOrder("rc-none");
      const id = await failedRequest(o, { refundId: await refund(o, "failed") });
      expect(await close("a", id)).toEqual({ status: "refused", reason: "refund_not_shown_at_provider" });
      // A part shown at the provider is not enough either.
      await prisma.payment.update({ where: { id: o.paymentId }, data: { refundedMinor: PAYABLE - 1n } });
      expect(await close("a", id)).toEqual({ status: "refused", reason: "refund_not_shown_at_provider" });
      expect(await reasons(id)).toEqual(["refund_not_shown_at_provider", "refund_not_shown_at_provider"]);
      expect(await prisma.cancellationRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "refund_failed", closedAt: null });
      // The only outcome is the provider's own refund; "handled offline" is not a way to close it.
      await expect(ops.requestResolution(admin("a"), closeInput(id, { outcome: "handled_offline" }), { environment: "test", totpCode: "123456" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("refused on a closed request, on a request that is not refund_failed, and on an exception request", async () => {
      const closed = await cancelledOrder("rc-closed");
      const closedRefund = await refund(closed, "succeeded");
      await prisma.payment.update({ where: { id: closed.paymentId }, data: { refundedMinor: PAYABLE } });
      const closedId = uuidv7();
      await prisma.cancellationRequest.create({
        data: { id: closedId, orderId: closed.id, orderItemId: closed.itemId, supplierBookingId: closed.bookingId, kind: "supported", status: "refunded", requestedVia: "customer", refundId: closedRefund, closedAt: new Date() },
      });
      const pending = await cancelledOrder("rc-pending");
      const pendingId = uuidv7();
      await prisma.cancellationRequest.create({
        data: { id: pendingId, orderId: pending.id, orderItemId: pending.itemId, supplierBookingId: pending.bookingId, kind: "supported", status: "refund_pending", requestedVia: "customer", refundId: await refund(pending, "requested") },
      });
      const exception = await cancelledOrder("rc-exception");
      const exceptionId = uuidv7();
      await prisma.cancellationRequest.create({ data: { id: exceptionId, orderId: exception.id, orderItemId: exception.itemId, kind: "exception", status: "exception_open", requestedVia: "customer", attentionRequiredAt: new Date() } });
      for (const id of [closedId, pendingId, exceptionId]) {
        expect(await close("a", id), id).toEqual({ status: "refused", reason: "not_refund_failed" });
        expect(await reasons(id)).toEqual(["not_refund_failed"]);
      }
      expect((await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: pendingId } })).status).toBe("refund_pending");
    });

    it("applied when the provider shows the item refunded outside Outly: closed refunded, flag off, its refund untouched, no money moved; audited by codes and hashes only", async () => {
      const o = await cancelledOrder("rc-dashboard");
      const refundId = await refund(o, "failed");
      const id = await failedRequest(o, { refundId });
      // A dashboard refund: the provider-synced total moves, Outly's rows do not.
      await prisma.payment.update({ where: { id: o.paymentId }, data: { refundedMinor: PAYABLE } });
      const refundsBefore = await prisma.refund.findMany({ where: { paymentId: o.paymentId }, orderBy: { id: "asc" } });
      // Batch 3 review: the order also has a checkout download grant and an emailed link.
      process.env.GUEST_DOWNLOAD_GRANT_ENABLED = "true";
      resetEnvCache();
      const { capabilityService } = await import("@/server/services/capability.service");
      const checkoutGrant = (await capabilityService.checkoutAccess(prisma, { orderId: o.id, notAfter: new Date(Date.now() + 3600_000) }))!;
      const emailed = await capabilityService.mint(prisma, { orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification", supersede: "after_sent" });
      const r = await close("a", id);
      expect(r.status).toBe("applied");
      // The order is now fully refunded: the staff close ended its checkout grant in the same transaction; the link stays.
      expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: checkoutGrant.grantId } })).revokeReason).toBe("order_cancelled");
      expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: emailed.grantId } })).revokedAt).toBeNull();
      delete process.env.GUEST_DOWNLOAD_GRANT_ENABLED;
      resetEnvCache();
      const approvalId = (r as { approvalId: string }).approvalId;
      const row = await prisma.cancellationRequest.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: "refunded", reasonCode: "resolved_refunded_at_provider", attentionRequiredAt: null, refundId });
      expect(row.closedAt).not.toBeNull();
      expect(await prisma.refund.findMany({ where: { paymentId: o.paymentId }, orderBy: { id: "asc" } })).toEqual(refundsBefore);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: o.paymentId } })).refundedMinor).toBe(PAYABLE);
      const [applied] = await audits("booking.privileged_resolution.applied", id);
      const after = applied.after as { fields: string[]; ids: Record<string, string>; codes: Record<string, string>; hashes: Record<string, string> };
      expect(after.fields).toEqual(["attentionRequiredAt", "closedAt", "reasonCode", "status"]);
      expect(after.ids).toEqual({ orderId: o.id, approvalId });
      expect(after.codes).toEqual({ action: "close_refund_failed", outcome: "refunded_at_provider" });
      expect(after.hashes.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
      const approval = await prisma.privilegedApproval.findUniqueOrThrow({ where: { id: approvalId } });
      expect(Object.keys(approval.payload as object).sort()).toEqual(["action", "evidenceHash", "orderId", "outcome", "status", "target", "targetId", "updatedAt"]);
      const all = await prisma.auditLog.findMany({ where: { OR: [{ entityId: id }, { entityId: approvalId }] } });
      expect(JSON.stringify([all, approval.payload], (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(EVIDENCE);
      // Closed: a second close finds nothing to do.
      expect(await close("a", id)).toEqual({ status: "refused", reason: "not_refund_failed" });
    });

    it("applied on a request refused when its refund was opened (no refund_id), when the provider shows the money back", async () => {
      const o = await cancelledOrder("rc-noref");
      const id = await failedRequest(o, { refundId: null, reasonCode: "refund_refund_cap" });
      expect(await close("a", id)).toEqual({ status: "refused", reason: "refund_not_shown_at_provider" });
      await prisma.payment.update({ where: { id: o.paymentId }, data: { refundedMinor: PAYABLE } });
      expect((await close("a", id)).status).toBe("applied");
      expect(await prisma.cancellationRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "refunded", refundId: null, reasonCode: "resolved_refunded_at_provider" });
    });

    it("an unlinked succeeded Outly refund of the item counts; one another request already names does not", async () => {
      // Staff refunded the item by hand (no request names it), and the provider synced it.
      const manual = await cancelledOrder("rc-manual");
      await refund(manual, "succeeded", { reason: "staff_refund" });
      await prisma.payment.update({ where: { id: manual.paymentId }, data: { refundedMinor: PAYABLE } });
      const manualId = await failedRequest(manual, { refundId: await refund(manual, "failed") });
      expect((await close("a", manualId)).status).toBe("applied");

      // The item's succeeded refund belongs to an earlier, closed request: it is that request's money, not evidence for this one.
      const named = await cancelledOrder("rc-named");
      const earlierRefund = await refund(named, "succeeded");
      await prisma.payment.update({ where: { id: named.paymentId }, data: { refundedMinor: PAYABLE } });
      await prisma.cancellationRequest.create({
        data: { id: uuidv7(), orderId: named.id, orderItemId: named.itemId, supplierBookingId: named.bookingId, kind: "supported", status: "refunded", requestedVia: "customer", refundId: earlierRefund, closedAt: new Date() },
      });
      const namedId = await failedRequest(named, { refundId: await refund(named, "failed") });
      expect(await close("a", namedId)).toEqual({ status: "refused", reason: "refund_not_shown_at_provider" });
    });

    it("production: a second approver applies it; a request written since (stale updatedAt) is not closed", async () => {
      const o = await cancelledOrder("rc-stale");
      const id = await failedRequest(o, { refundId: await refund(o, "failed") });
      await prisma.payment.update({ where: { id: o.paymentId }, data: { refundedMinor: PAYABLE } });
      const r = await close("a", id, "production");
      expect(r.status).toBe("pending");
      expect((await audits("booking.privileged_resolution.pending", id)).length).toBe(1);
      // Any write to the request since the approval was asked (a recheck, a clear) makes it stale.
      await prisma.cancellationRequest.update({ where: { id }, data: { updatedAt: new Date() } });
      const t = tick();
      await expect(ops.approveResolution(admin("b"), (r as { approvalId: string }).approvalId, code("b", t), { now: t })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await prisma.cancellationRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "refund_failed", closedAt: null });
      // The approval was not burned by the failed apply: the transaction rolled back.
      expect(await prisma.idempotencyKey.count({ where: { scope: "privileged_use", key: `privileged_use:${(r as { approvalId: string }).approvalId}` } })).toBe(0);

      // Asked again against the current row, a second admin applies it.
      const again = await close("a", id, "production");
      expect(again.status).toBe("pending");
      const t2 = tick();
      expect(await ops.approveResolution(admin("b"), (again as { approvalId: string }).approvalId, code("b", t2), { now: t2 })).toEqual({ status: "applied", approvalId: (again as { approvalId: string }).approvalId });
      expect((await prisma.cancellationRequest.findUniqueOrThrow({ where: { id } })).status).toBe("refunded");
      const [applied] = await audits("booking.privileged_resolution.applied", id);
      expect(applied.actorId).toBe(staff.b.id);
    });

    it("production: coverage gone by the time of apply closes nothing", async () => {
      const o = await cancelledOrder("rc-gone");
      const id = await failedRequest(o, { refundId: await refund(o, "failed") });
      await prisma.payment.update({ where: { id: o.paymentId }, data: { refundedMinor: PAYABLE } });
      const r = await close("a", id, "production");
      expect(r.status).toBe("pending");
      // The provider's figure is corrected down (the request row itself is untouched, so only the coverage check can stop it).
      await prisma.payment.update({ where: { id: o.paymentId }, data: { refundedMinor: 0n } });
      const t = tick();
      await expect(ops.approveResolution(admin("b"), (r as { approvalId: string }).approvalId, code("b", t), { now: t })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await prisma.cancellationRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "refund_failed", closedAt: null });
      expect(await audits("booking.privileged_resolution.applied", id)).toEqual([]);
    });
  });

  /* ---------------------------------------------------------------- R-B5-17 */

  describe("R-B5-17: a staff clear lasts; a new reason flags again", () => {
    async function staffClear(requestId: string) {
      const at = tick();
      const r = await ops.requestResolution(
        admin("c"),
        { action: "clear_attention", target: "cancellation_request", targetId: requestId, reasonCode: "handled_offline", evidence: EVIDENCE },
        { environment: "test", totpCode: code("c", at), now: at },
      );
      expect(r.status).toBe("applied");
      const row = await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(row.attentionRequiredAt).toBeNull();
      return row;
    }

    async function confirmedRequest(label: string, bookingState = "confirmed") {
      const o = await instantOrder(prisma, run, fx, { label, owner: { kind: "customer", customerId: A.id }, sagaState: "fulfilled", capturedMinor: PAYABLE, bookingState: "confirmed", issuesTicketsAtConfirm: "no" });
      const r = await svc.createCancellationService().request({ orderId: o.id, orderItemId: o.itemId, kind: "cancel", via: "customer" });
      expect(r).toMatchObject({ ok: true, status: "cancelling" });
      if (bookingState !== "confirmed") await prisma.supplierBooking.update({ where: { id: o.bookingId! }, data: { state: bookingState as never } });
      return { o, id: (r as { requestId: string }).requestId };
    }

    const row = (id: string) => prisma.cancellationRequest.findUniqueOrThrow({ where: { id } });

    it("stuck: cleared cancel_stuck is not raised again on the next ticks; near the deadline it is raised with that reason", async () => {
      const { id } = await confirmedRequest("r17-stuck");
      const created = (await row(id)).createdAt.getTime();
      const late = new Date(created + svc.CANCEL_STUCK_AFTER_MS + 60_000);
      await svc.createCancellationService({ now: () => late }).advanceOpen({ max: 500 });
      expect(await row(id)).toMatchObject({ status: "cancelling", reasonCode: "cancel_stuck" });
      expect((await row(id)).attentionRequiredAt).not.toBeNull();
      const cleared = await staffClear(id);
      expect(cleared.reasonCode).toBe("cancel_stuck");
      for (const at of [late, new Date(late.getTime() + 3_600_000)]) {
        await svc.createCancellationService({ now: () => at }).advanceOpen({ max: 500 });
        expect((await row(id)).attentionRequiredAt, at.toISOString()).toBeNull();
      }
      // The free-cancellation deadline (fixture: 2030-01-14T06:00Z) comes close: a new reason.
      const near = new Date(Date.parse("2030-01-14T06:00:00.000Z") - svc.CANCEL_DEADLINE_MARGIN_MS + 60_000);
      await svc.createCancellationService({ now: () => near }).advanceOpen({ max: 500 });
      const again = await row(id);
      expect(again.reasonCode).toBe("cancel_near_deadline");
      expect(again.attentionRequiredAt).not.toBeNull();
    });

    it("outcome unknown: cleared cancel_outcome_unknown is not raised again; growing stuck raises cancel_stuck", async () => {
      const { o, id } = await confirmedRequest("r17-unknown");
      await prisma.supplierBooking.update({ where: { id: o.bookingId! }, data: { state: "outcome_unknown" } });
      await svc.createCancellationService().advanceOpen({ max: 500 });
      expect(await row(id)).toMatchObject({ status: "cancel_unverified", reasonCode: "cancel_outcome_unknown" });
      expect((await row(id)).attentionRequiredAt).not.toBeNull();
      await staffClear(id);
      await svc.createCancellationService().advanceOpen({ max: 500 });
      await svc.createCancellationService().advanceOpen({ max: 500 });
      expect(await row(id)).toMatchObject({ status: "cancel_unverified", reasonCode: "cancel_outcome_unknown", attentionRequiredAt: null });
      const late = new Date((await row(id)).createdAt.getTime() + svc.CANCEL_STUCK_AFTER_MS + 60_000);
      await svc.createCancellationService({ now: () => late }).advanceOpen({ max: 500 });
      const again = await row(id);
      expect(again.reasonCode).toBe("cancel_stuck");
      expect(again.attentionRequiredAt).not.toBeNull();
    });

    it("needs review: cleared cancel_needs_review is not raised again on the next tick", async () => {
      const { o, id } = await confirmedRequest("r17-review");
      await prisma.supplierBooking.update({ where: { id: o.bookingId! }, data: { state: "manual_review" } });
      await svc.createCancellationService().advanceOpen({ max: 500 });
      expect(await row(id)).toMatchObject({ status: "cancelling", reasonCode: "cancel_needs_review" });
      expect((await row(id)).attentionRequiredAt).not.toBeNull();
      await staffClear(id);
      await svc.createCancellationService().advanceOpen({ max: 500 });
      expect(await row(id)).toMatchObject({ status: "cancelling", reasonCode: "cancel_needs_review", attentionRequiredAt: null });
    });

    it("refund_failed: a cleared flag stays cleared when its refund is read again and is still failed", async () => {
      const o = await cancelledOrder("r17-refund");
      const refundId = await refund(o, "failed", { updatedAt: new Date(Date.UTC(2001, 0, 1)) });
      const id = await failedRequest(o, { refundId, updatedAt: new Date(Date.UTC(2001, 0, 2)) });
      await staffClear(id);
      // The refund changes (still failed), so the recheck reads the row again.
      await prisma.refund.update({ where: { id: refundId }, data: { providerRefundId: `zz_re_${run}_r17` } });
      await svc.createCancellationService().advanceOpen({ max: 500 });
      expect(await row(id)).toMatchObject({ status: "refund_failed", reasonCode: "refund_failed", attentionRequiredAt: null, closedAt: null });
    });
  });

  /* ---------------------------------------------------------------- R-B5-18 */

  describe("R-B5-18: the refund_failed recheck reads only rows whose refund changed", () => {
    /** More items on one order, each with its own failed refund and refund_failed request. */
    /**
     * A second order with a captured payment and no saga, holding the extra
     * items: an order with a payment saga takes no new items
     * (`order_items_frozen_under_saga`, migration 20261104090000). The recheck
     * reads every refund_failed request, whatever its order.
     */
    const holders = new Map<string, { orderId: string; paymentId: string }>();
    async function holderFor(o: InstantOrder) {
      const known = holders.get(o.id);
      if (known) return known;
      const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
      const pay = await prisma.payment.findUniqueOrThrow({ where: { id: o.paymentId } });
      const orderId = uuidv7();
      const paymentId = uuidv7();
      await prisma.order.create({ data: { ...order, id: orderId, reference: `${order.reference}H`, customerId: null, idempotencyKey: null, sourceInquiryId: null, createdByAgent: null } as never });
      await prisma.payment.create({
        data: { ...pay, id: paymentId, orderId, idempotencyKey: null, quoteId: null, gatewayPaymentId: `${pay.gatewayPaymentId}_h`, providerOrderId: null, gatewayOrderId: null } as never,
      });
      extraOrders.push(orderId);
      const h = { orderId, paymentId };
      holders.set(o.id, h);
      return h;
    }

    async function moreItems(o: InstantOrder, n: number, dates: { refund: Date; request: Date }) {
      const base = await prisma.orderItem.findUniqueOrThrow({ where: { id: o.itemId } });
      const h = await holderFor(o);
      const out: { itemId: string; refundId: string; requestId: string }[] = [];
      for (let i = 0; i < n; i++) {
        const itemId = uuidv7();
        await prisma.orderItem.create({ data: { ...base, id: itemId, orderId: h.orderId, quoteId: null, pax: base.pax as object, marginSnapshot: base.marginSnapshot as object, cancellationPolicySnapshot: base.cancellationPolicySnapshot as object, addons: base.addons as object } as never });
        extraItems.push(itemId);
        const refundId = await refund({ paymentId: h.paymentId, itemId }, "failed", { updatedAt: dates.refund });
        const requestId = uuidv7();
        await prisma.cancellationRequest.create({
          data: { id: requestId, orderId: h.orderId, orderItemId: itemId, kind: "supported", status: "refund_failed", requestedVia: "customer", refundId, reasonCode: "refund_failed", attentionRequiredAt: dates.request, updatedAt: dates.request },
        });
        out.push({ itemId, refundId, requestId });
      }
      return out;
    }

    it("more than 50 permanently failed rows do not hide a newer row whose refund later succeeds; that request closes refunded", async () => {
      const o = await cancelledOrder("r18-bulk");
      const stale = await moreItems(o, 51, { refund: new Date(Date.UTC(2001, 0, 1)), request: new Date(Date.UTC(2001, 0, 2)) });
      const [fresh] = await moreItems(o, 1, { refund: new Date(Date.UTC(2001, 0, 1)), request: new Date(Date.UTC(2001, 0, 3)) });
      // The provider settles the newest one after all.
      await prisma.refund.update({ where: { id: fresh.refundId }, data: { status: "succeeded" } });
      await svc.createCancellationService().advanceOpen({ max: 50 });
      const done = await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: fresh.requestId } });
      expect(done.status).toBe("refunded");
      expect(done.closedAt).not.toBeNull();
      // The permanently failed ones were not read: not one was written.
      const untouched = await prisma.cancellationRequest.findMany({ where: { id: { in: stale.map((s) => s.requestId) } }, select: { updatedAt: true, status: true } });
      expect(untouched.every((r) => r.status === "refund_failed" && r.updatedAt.getTime() === Date.UTC(2001, 0, 2))).toBe(true);
    }, 120_000);

    it("a failed row is read once per refund change", async () => {
      const o = await cancelledOrder("r18-once");
      const refundId = await refund(o, "failed", { updatedAt: new Date(Date.UTC(2001, 0, 1)) });
      const id = await failedRequest(o, { refundId, updatedAt: new Date(Date.UTC(2001, 0, 2)) });
      const updatedAt = async () => (await prisma.cancellationRequest.findUniqueOrThrow({ where: { id } })).updatedAt.getTime();
      const step = svc.createCancellationService();
      // Not changed since the request was written: not read.
      await step.advanceOpen({ max: 500 });
      expect(await updatedAt()).toBe(Date.UTC(2001, 0, 2));
      // The refund changes (a provider read, still failed): read once, and the write moves the request past it.
      await prisma.refund.update({ where: { id: refundId }, data: { providerRefundId: `zz_re_${run}_${randomBytes(3).toString("hex")}` } });
      await step.advanceOpen({ max: 500 });
      const first = await updatedAt();
      expect(first).toBeGreaterThan(Date.UTC(2001, 0, 2));
      expect((await prisma.refund.findUniqueOrThrow({ where: { id: refundId } })).updatedAt.getTime()).toBeLessThan(first);
      await step.advanceOpen({ max: 500 });
      expect(await updatedAt()).toBe(first);
      // Another change: read once more.
      await new Promise((r) => setTimeout(r, 5));
      await prisma.refund.update({ where: { id: refundId }, data: { providerRefundId: `zz_re_${run}_${randomBytes(3).toString("hex")}` } });
      await step.advanceOpen({ max: 500 });
      expect(await updatedAt()).toBeGreaterThan(first);
      expect((await prisma.cancellationRequest.findUniqueOrThrow({ where: { id } })).status).toBe("refund_failed");
    });
  });
});
