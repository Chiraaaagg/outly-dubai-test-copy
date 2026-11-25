import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { apiRequest, assertDisposableDb, cleanupPeople, createCustomer, dbEnabled, params, runId, syntheticPhone, type CustomerFixture } from "../helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, makeOrder, publishedProduct } from "../security/_mercury-fixtures";
import { cleanupCustomerRows, forbiddenKeys, guestSession, instantOrder, setupCustomerFixtures, type CustomerFixtures, type InstantOrderOptions } from "./customer-fixtures";
import { resetEnvCache } from "@/server/lib/env";
import { uuidv7 } from "@/server/lib/ids";

/**
 * Customer cancellation (F15, F51) through the real route and the
 * disposable database.
 *
 * The engine boundary: the real `supplierBookingService.requestCancel` runs
 * (it only enqueues a `cancel` job for the worker), and the test then writes
 * the supplier attempt state the engine would reach (`cancelled`,
 * `cancel_refused`, `cancel_unverified`, `outcome_unknown`) instead of running
 * a worker against a fake TravelDesk: the engine's own suites cover the
 * cancel itself (supplier-booking.service.test.ts), and today's scheduled
 * worker sends cancels only under the rule the console owner is adding. The
 * refund driver is a stand-in that settles the refund row as the provider
 * would; the refund row itself is opened by the real `openRefund` under the
 * database cap.
 */

const run = runId();
let ipN = Number.parseInt(run.slice(-4), 16) % 50_000;
const nextIp = () => `198.18.${Math.floor(ipN / 250) % 250}.${(ipN++ % 250) + 1}`;
const savedEnv = { ...process.env };

type Prisma = Awaited<ReturnType<typeof db>>;
let prisma: Prisma;
let fx: CustomerFixtures;
let A: CustomerFixture;
let B: CustomerFixture;
let svc: typeof import("@/server/services/cancellation.service");

const route = () => import("@/app/api/orders/[reference]/cancellation/route");
const statusRoute = () => import("@/app/api/orders/[reference]/status/route");

async function request(reference: string, body: unknown, cookie = A.cookie) {
  const { POST } = await route();
  return POST(apiRequest(`/api/orders/${reference}/cancellation`, { body, cookie, headers: { "x-real-ip": nextIp() } }), params({ reference }));
}

async function status(reference: string) {
  const { GET } = await statusRoute();
  const res = await GET(apiRequest(`/api/orders/${reference}/status`, { cookie: A.cookie, headers: { "x-real-ip": nextIp() } }), params({ reference }));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(forbiddenKeys(body)).toEqual([]);
  return body;
}

function confirmed(label: string, over: Partial<InstantOrderOptions> = {}) {
  return instantOrder(prisma, run, fx, { label, owner: { kind: "customer", customerId: A.id }, sagaState: "fulfilled", capturedMinor: 45_000n, bookingState: "confirmed", issuesTicketsAtConfirm: "no", ...over });
}

async function setBooking(id: string, state: string) {
  await prisma.supplierBooking.update({ where: { id }, data: { state: state as never, ...(state === "cancelled" ? { cancelledAt: new Date(), closedAt: new Date() } : {}) } });
}

/** Settles the refund row as the provider would, without a gateway. */
function settlingDriver(outcome: "succeeded" | "failed") {
  return async (refundId: string) => {
    await prisma.refund.update({ where: { id: refundId }, data: { status: outcome } });
    return outcome;
  };
}

describe.skipIf(!dbEnabled)("customer cancellation (F15, F51)", () => {
  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    process.env.TRUST_PROXY_IP_HEADERS = "true";
    resetEnvCache();
    prisma = await db();
    svc = await import("@/server/services/cancellation.service");
    fx = await setupCustomerFixtures(prisma, run, await publishedProduct());
    A = await createCustomer(run, syntheticPhone(run, 91));
    B = await createCustomer(run, syntheticPhone(run, 92));
    const { documentService } = await import("@/server/services/document.service");
    vi.spyOn(documentService, "listForOrder").mockImplementation(async () => []);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
    resetEnvCache();
    if (!prisma) return;
    await cleanupCustomerRows(prisma, fx);
    await cleanupBusinessRows(run);
    await cleanupPeople(run);
  });

  it("a supported request: cancelling before the engine is asked → engine cancelled → refund opened → refunded", async () => {
    const o = await confirmed("happy");
    expect((await status(o.reference)).items[0].cancellation).toMatchObject({ kind: "eligible", refundMinor: "45000" });
    // Checkout redesign batch 3 review: a checkout download grant (and an emailed link) exist for this order.
    process.env.GUEST_DOWNLOAD_GRANT_ENABLED = "true";
    resetEnvCache();
    const { capabilityService } = await import("@/server/services/capability.service");
    const checkoutGrant = (await capabilityService.checkoutAccess(prisma, { orderId: o.id, notAfter: new Date(Date.now() + 3600_000) }))!;
    const emailedLink = await capabilityService.mint(prisma, { orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification", supersede: "after_sent" });

    const res = await request(o.reference, { orderItemId: o.itemId, kind: "cancel" });
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual({ status: "cancelling" });
    const row = await prisma.cancellationRequest.findFirstOrThrow({ where: { orderItemId: o.itemId } });
    expect(row).toMatchObject({ kind: "supported", status: "cancelling", requestedVia: "customer", supplierBookingId: o.bookingId, refundId: null, closedAt: null });
    // The eligibility snapshot holds policy facts only: no money, no supplier figures or ids.
    expect(Object.keys(row.eligibility as object).sort()).toEqual(["bookingState", "evaluatedAt", "freeCancellationUntilUtc", "issuesTicketsAtConfirm", "nonRefundableAfterConfirm", "outcome", "serviceStartUtc", "ticketsStored"]);
    expect(JSON.stringify(row.eligibility)).not.toMatch(/45000|30000|8000|Minor/);
    expect(await prisma.supplierJob.findUnique({ where: { dedupeKey: `cancel:${o.bookingId}` } })).toMatchObject({ kind: "cancel", status: "queued" });
    expect((await status(o.reference)).state).toBe("cancellation_processing");

    // Still with the operator: nothing moves.
    const step = svc.createCancellationService();
    await step.advanceOpen({ max: 50 });
    expect((await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("cancelling");

    await setBooking(o.bookingId!, "cancelled");
    await step.advanceOpen({ max: 50 });
    const pending = await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(pending.status).toBe("refund_pending");
    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: pending.refundId! } });
    expect(refund).toMatchObject({ paymentId: o.paymentId, orderItemId: o.itemId, amountMinor: 45_000n, currency: "AED", status: "requested", reason: "customer_cancellation", outlyFunded: false });
    expect(await prisma.customerRemedy.findUnique({ where: { refundId: refund.id } })).toMatchObject({ kind: "refund", status: "in_progress", supplierBookingId: o.bookingId });
    expect((await status(o.reference)).state).toBe("refund_processing");

    // A second step never opens a second refund.
    await step.advanceOpen({ max: 50 });
    expect(await prisma.refund.count({ where: { orderItemId: o.itemId } })).toBe(1);

    await svc.createCancellationService({ driveRefund: settlingDriver("succeeded") }).advanceOpen({ max: 50 });
    const done = await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(done.status).toBe("refunded");
    expect(done.closedAt).not.toBeNull();
    // The whole order is cancelled and refunded: its checkout grant ends; the emailed link stays so the refund can be followed.
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: checkoutGrant.grantId } })).revokeReason).toBe("order_cancelled");
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: emailedLink.grantId } })).revokedAt).toBeNull();
    delete process.env.GUEST_DOWNLOAD_GRANT_ENABLED;
    resetEnvCache();
    const body = await status(o.reference);
    expect(body).toMatchObject({ state: "cancelled", steps: { refund: { status: "done" }, booking: { status: "done", label: "Cancelled with the operator" } } });
    expect(body.items[0].cancellation).toMatchObject({ kind: "requested", status: "refunded", requestKind: "supported" });
  });

  it("a failing checkout-grant revoke rolls the refunded close back with it; the next tick closes and revokes together (batch 3 review)", async () => {
    const o = await confirmed("revoke-retry");
    process.env.GUEST_DOWNLOAD_GRANT_ENABLED = "true";
    resetEnvCache();
    const { capabilityService } = await import("@/server/services/capability.service");
    const grant = (await capabilityService.checkoutAccess(prisma, { orderId: o.id, notAfter: new Date(Date.now() + 3600_000) }))!;
    expect((await request(o.reference, { orderItemId: o.itemId, kind: "cancel" })).status).toBe(202);
    const row = await prisma.cancellationRequest.findFirstOrThrow({ where: { orderItemId: o.itemId } });
    await setBooking(o.bookingId!, "cancelled");
    await svc.createCancellationService().advanceOpen({ max: 50 });
    expect((await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("refund_pending");

    // The revoke fails (for this order only) in the tick that sees the refund succeed.
    const original = capabilityService.revokeAllForOrders.bind(capabilityService);
    const spy = vi.spyOn(capabilityService, "revokeAllForOrders").mockImplementation(async (db, ids, ...rest) => {
      if (ids.includes(o.id)) throw new Error("zz injected revoke failure");
      return original(db, ids, ...rest);
    });
    try {
      await svc.createCancellationService({ driveRefund: settlingDriver("succeeded") }).advanceOpen({ max: 50 });
      expect(spy.mock.calls.some(([, ids]) => ids.includes(o.id))).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // Rolled back together: the request is still open (its refund settled at the provider), the grant still live.
    expect((await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("refund_pending");
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: (await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: row.id } })).refundId! } })).status).toBe("succeeded");
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: grant.grantId } })).revokedAt).toBeNull();

    // The next tick redoes both.
    await svc.createCancellationService().advanceOpen({ max: 50 });
    const done = await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: row.id } });
    expect(done.status).toBe("refunded");
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: grant.grantId } })).revokeReason).toBe("order_cancelled");
    expect((await status(o.reference)).state).toBe("cancelled");
    delete process.env.GUEST_DOWNLOAD_GRANT_ENABLED;
    resetEnvCache();
  });

  it("a repeat is idempotent: the open request answers, one row and one engine job", async () => {
    const o = await confirmed("repeat");
    const [r1, r2] = await Promise.all([request(o.reference, { orderItemId: o.itemId, kind: "cancel" }), request(o.reference, { orderItemId: o.itemId, kind: "cancel" })]);
    expect([r1.status, r2.status]).toEqual([202, 202]);
    const again = await request(o.reference, { orderItemId: o.itemId, kind: "exception" });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ status: "cancelling" });
    expect(await prisma.cancellationRequest.count({ where: { orderItemId: o.itemId } })).toBe(1);
    expect(await prisma.supplierJob.count({ where: { supplierBookingId: o.bookingId!, kind: "cancel" } })).toBe(1);
  });

  it("cancel_refused ends the request refused (F51); the customer may then ask our team, which promises nothing", async () => {
    const o = await confirmed("refused");
    expect((await request(o.reference, { orderItemId: o.itemId, kind: "cancel" })).status).toBe(202);
    await setBooking(o.bookingId!, "cancel_refused");
    await svc.createCancellationService().advanceOpen({ max: 50 });
    const row = await prisma.cancellationRequest.findFirstOrThrow({ where: { orderItemId: o.itemId } });
    expect(row).toMatchObject({ status: "refused", reasonCode: "cancel_refused", refundId: null });
    expect(row.closedAt).not.toBeNull();
    const body = await status(o.reference);
    expect(body.state).toBe("confirmed");
    expect(body.items[0].cancellation).toMatchObject({ kind: "requested", status: "refused" });
    expect(await prisma.refund.count({ where: { orderItemId: o.itemId } })).toBe(0);
    // The refused request is closed, so the customer may now ask our team; that opens an exception and moves no money.
    const ask = await request(o.reference, { orderItemId: o.itemId, kind: "exception" });
    expect(ask.status).toBe(202);
    expect(await prisma.cancellationRequest.count({ where: { orderItemId: o.itemId, kind: "exception", status: "exception_open" } })).toBe(1);
    expect(await prisma.refund.count({ where: { orderItemId: o.itemId } })).toBe(0);
  });

  it("an unverified or unknown cancel stays processing for the customer; an unknown one is flagged for staff", async () => {
    const o = await confirmed("unverified");
    await request(o.reference, { orderItemId: o.itemId, kind: "cancel" });
    const step = svc.createCancellationService();
    await setBooking(o.bookingId!, "cancel_unverified");
    await step.advanceOpen({ max: 50 });
    expect(await prisma.cancellationRequest.findFirstOrThrow({ where: { orderItemId: o.itemId } })).toMatchObject({ status: "cancel_unverified", attentionRequiredAt: null });
    await setBooking(o.bookingId!, "outcome_unknown");
    await step.advanceOpen({ max: 50 });
    const row = await prisma.cancellationRequest.findFirstOrThrow({ where: { orderItemId: o.itemId } });
    expect(row.status).toBe("cancel_unverified");
    expect(row.attentionRequiredAt).not.toBeNull();
    expect((await status(o.reference)).state).toBe("cancellation_processing");
  });

  it("a refund the provider refuses ends refund_failed with attention, never refunded", async () => {
    const o = await confirmed("refund-failed");
    await request(o.reference, { orderItemId: o.itemId, kind: "cancel" });
    await setBooking(o.bookingId!, "cancelled");
    await svc.createCancellationService({ driveRefund: settlingDriver("failed") }).advanceOpen({ max: 50 });
    const row = await prisma.cancellationRequest.findFirstOrThrow({ where: { orderItemId: o.itemId } });
    expect(row).toMatchObject({ status: "refund_failed", reasonCode: "refund_failed", closedAt: null });
    expect(row.attentionRequiredAt).not.toBeNull();
    expect((await status(o.reference)).state).toBe("needs_attention");
  });

  it("a refund_failed request whose refund later succeeds is closed refunded; one still failed keeps its attention (R-B5-2)", async () => {
    const late = await confirmed("refund-late");
    const still = await confirmed("refund-still");
    for (const o of [late, still]) {
      await request(o.reference, { orderItemId: o.itemId, kind: "cancel" });
      await setBooking(o.bookingId!, "cancelled");
    }
    await svc.createCancellationService({ driveRefund: settlingDriver("failed") }).advanceOpen({ max: 50 });
    const lateRow = await prisma.cancellationRequest.findFirstOrThrow({ where: { orderItemId: late.itemId } });
    expect(lateRow.status).toBe("refund_failed");
    // The provider settles it after all (its own record, read by the refund driver).
    await prisma.refund.update({ where: { id: lateRow.refundId! }, data: { status: "succeeded" } });
    await svc.createCancellationService().advanceOpen({ max: 50 });
    const closed = await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: lateRow.id } });
    expect(closed.status).toBe("refunded");
    expect(closed.closedAt).not.toBeNull();
    expect((await status(late.reference)).state).toBe("cancelled");
    const open = await prisma.cancellationRequest.findFirstOrThrow({ where: { orderItemId: still.itemId } });
    expect(open).toMatchObject({ status: "refund_failed", closedAt: null });
    expect(open.attentionRequiredAt).not.toBeNull();
  });

  it("a request stuck with the booking still confirmed escalates: no cancel job, too old, or near the deadline (R-B5-1)", async () => {
    const flagged = async (label: string, prepare: (o: Awaited<ReturnType<typeof confirmed>>) => Promise<void>, now: Date | null, reason: string | null) => {
      const o = await confirmed(label);
      await request(o.reference, { orderItemId: o.itemId, kind: "cancel" });
      await prepare(o);
      await svc.createCancellationService(now ? { now: () => now } : {}).advanceOpen({ max: 500 });
      const row = await prisma.cancellationRequest.findFirstOrThrow({ where: { orderItemId: o.itemId } });
      expect(row.status, label).toBe("cancelling");
      if (reason) {
        expect(row.attentionRequiredAt, label).not.toBeNull();
        expect(row.reasonCode, label).toBe(reason);
      } else {
        expect(row.attentionRequiredAt, label).toBeNull();
      }
      return row;
    };
    // A queued job, fresh, deadline far away: nothing to tell anyone.
    await flagged("stuck-none", async () => {}, null, null);
    // The job died (or the worker skipped it): nothing will send the cancel.
    await flagged("stuck-nojob", async (o) => { await prisma.supplierJob.updateMany({ where: { supplierBookingId: o.bookingId! }, data: { status: "dead" } }); }, null, "cancel_job_missing");
    // Older than the age limit, even with a job queued.
    await flagged("stuck-age", async () => {}, new Date(Date.now() + svc.CANCEL_STUCK_AFTER_MS + 60_000), "cancel_stuck");
    // Within the margin of the free-cancellation deadline (fixture: 2030-01-14T06:00Z).
    await flagged("stuck-deadline", async () => {}, new Date(Date.parse("2030-01-14T06:00:00.000Z") - svc.CANCEL_DEADLINE_MARGIN_MS + 60_000), "cancel_near_deadline");
    // The customer still sees processing.
    const o = await prisma.cancellationRequest.findFirstOrThrow({ where: { reasonCode: "cancel_job_missing", order: { leadName: { startsWith: `zz-sec-${run}` } } }, select: { order: { select: { reference: true } } } });
    expect((await status(o.order.reference)).state).toBe("cancellation_processing");
  });

  it("a view_status grant may see the order but not cancel it; a download_tickets grant and the paying guest session may (R-B5-7)", async () => {
    const { capabilityService, addAccessEntry } = await import("@/server/services/capability.service");
    const cookieFor = async (orderId: string, purpose: "view_status" | "download_tickets") => {
      const g = await capabilityService.mint(prisma, { orderId, purpose, issuedFor: "status_notification", supersede: "after_sent" });
      const e = await capabilityService.exchange(g.token);
      if (!e.ok) throw new Error("exchange refused");
      return `outlyy_ticket_access=${addAccessEntry(undefined, e.cookieValue)!.value}`;
    };
    const viewOnly = await confirmed("grant-view");
    const viewCookie = await cookieFor(viewOnly.id, "view_status");
    const refused = await request(viewOnly.reference, { orderItemId: viewOnly.itemId, kind: "cancel" }, viewCookie);
    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe(await (await request("OUT-10000017", { orderItemId: viewOnly.itemId, kind: "cancel" }, viewCookie)).text());
    expect(await prisma.cancellationRequest.count({ where: { orderItemId: viewOnly.itemId } })).toBe(0);

    const dl = await confirmed("grant-download");
    const ok = await request(dl.reference, { orderItemId: dl.itemId, kind: "cancel" }, await cookieFor(dl.id, "download_tickets"));
    expect(ok.status).toBe(202);
    expect(await prisma.cancellationRequest.findFirstOrThrow({ where: { orderItemId: dl.itemId } })).toMatchObject({ requestedVia: "guest" });

    const g = await guestSession(prisma, fx);
    const guestOrder = await confirmed("guest-session", { owner: { kind: "guest", guestSessionId: g.id } });
    expect((await request(guestOrder.reference, { orderItemId: guestOrder.itemId, kind: "cancel" }, g.cookie)).status).toBe(202);
  });

  it("an engine refusal at intake puts the request back to requested with attention, and the step retries it", async () => {
    const o = await confirmed("engine-refuses");
    const refusing = svc.createCancellationService({ requestCancel: async () => { throw new Error("A booking in state confirming cannot be cancelled"); } });
    const r = await refusing.request({ orderId: o.id, orderItemId: o.itemId, kind: "cancel", via: "customer" });
    expect(r).toMatchObject({ ok: true, status: "requested", created: true });
    const row = await prisma.cancellationRequest.findFirstOrThrow({ where: { orderItemId: o.itemId } });
    expect(row).toMatchObject({ status: "requested", reasonCode: "engine_refused" });
    expect(row.attentionRequiredAt).not.toBeNull();
    const calls: string[] = [];
    await svc.createCancellationService({ requestCancel: async (id) => { calls.push(id); } }).advanceOpen({ max: 50 });
    expect(calls).toContain(o.bookingId);
    expect((await prisma.cancellationRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("cancelling");
  });

  it("ineligible items get 409 NOT_ELIGIBLE with their reason, and nothing is written or sent", async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const cases: Array<[string, Partial<InstantOrderOptions>, string]> = [
      ["past", { freeCancellationUntilUtc: past }, "past_deadline"],
      ["nonref", { nonRefundableAfterConfirm: true }, "non_refundable"],
      ["nofree", { freeCancellationUntilUtc: null }, "non_refundable"],
      ["tickets-yes", { issuesTicketsAtConfirm: "yes" }, "tickets_issued"],
      ["tickets-unknown", { issuesTicketsAtConfirm: null }, "tickets_issued"],
      ["started", { serviceDate: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10) }, "activity_started"],
      ["not-confirmed", { sagaState: "confirm_pending", bookingState: "confirming" }, "not_supported"],
      ["uncaptured", { capturedMinor: 0n }, "payment_not_refundable"],
    ];
    for (const [label, over, reason] of cases) {
      const o = await confirmed(`inel-${label}`, over);
      const res = await request(o.reference, { orderItemId: o.itemId, kind: "cancel" });
      expect(res.status, label).toBe(409);
      expect(await res.json(), label).toMatchObject({ error: { code: "NOT_ELIGIBLE", reason } });
      expect(await prisma.cancellationRequest.count({ where: { orderItemId: o.itemId } }), label).toBe(0);
      if (o.bookingId) expect(await prisma.supplierJob.count({ where: { supplierBookingId: o.bookingId } }), label).toBe(0);
    }

    // A dispute on the payment freezes refunds (F56): not refundable, and no exception either.
    const disputed = await confirmed("dispute");
    await prisma.paymentEvent.create({
      data: { id: uuidv7(), provider: "fake_aed_card", providerEventId: `zz-${run}-${randomBytes(4).toString("hex")}`, state: "processed", processedAt: new Date(), type: "dispute.created", providerPaymentId: disputed.gatewayPaymentId, payloadDigest: "a".repeat(64) },
    });
    const frozen = await request(disputed.reference, { orderItemId: disputed.itemId, kind: "cancel" });
    expect(await frozen.json()).toMatchObject({ error: { code: "NOT_ELIGIBLE", reason: "payment_not_refundable" } });
    expect((await request(disputed.reference, { orderItemId: disputed.itemId, kind: "exception" })).status).toBe(409);

    // A historic assisted order is not self-serve.
    const assisted = await makeOrder(run, { leadPhone: syntheticPhone(run, 93), customerId: A.id, label: "assisted" });
    const itemId = uuidv7();
    await prisma.orderItem.create({
      data: {
        id: itemId, orderId: assisted.id, productId: fx.product.id, titleSnapshot: `zz-sec-${run} assisted`, tierSnapshot: fx.product.tier, slugSnapshot: fx.product.slug, kindSnapshot: "activity",
        confirmationSnapshot: "manual", fulfilmentModeSnapshot: "inquiry", freeCancellationHoursSnapshot: 24, durationMinutesSnapshot: 60, serviceDate: new Date("2030-01-15T00:00:00.000Z"),
        pax: { adult: 1 }, unitInr: 777_700n, unitAed: 31_100n, totalInr: 777_700n, totalAed: 31_100n,
      },
    });
    expect(await (await request(assisted.reference, { orderItemId: itemId, kind: "cancel" })).json()).toMatchObject({ error: { code: "NOT_ELIGIBLE", reason: "not_supported" } });
    // …but the customer can ask our team.
    const ex = await request(assisted.reference, { orderItemId: itemId, kind: "exception" });
    expect(ex.status).toBe(202);
    expect(await ex.json()).toEqual({ status: "exception_open" });
    await prisma.cancellationRequest.deleteMany({ where: { orderItemId: itemId } });
  });

  it("an exception request for an item the policy does not cover asks our team only: no engine job, no refund", async () => {
    const o = await confirmed("exception", { issuesTicketsAtConfirm: "yes" });
    const res = await request(o.reference, { orderItemId: o.itemId, kind: "exception" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "exception_open" });
    expect(await prisma.cancellationRequest.findFirstOrThrow({ where: { orderItemId: o.itemId } })).toMatchObject({ kind: "exception", status: "exception_open", reasonCode: "tickets_issued", supplierBookingId: o.bookingId });
    expect(await prisma.supplierJob.count({ where: { supplierBookingId: o.bookingId! } })).toBe(0);
    await svc.createCancellationService().advanceOpen({ max: 50 });
    expect(await prisma.refund.count({ where: { orderItemId: o.itemId } })).toBe(0);
    const body = await status(o.reference);
    expect(body.state).toBe("confirmed");
    expect(body.items[0].cancellation).toMatchObject({ kind: "requested", requestKind: "exception", status: "exception_open" });
  });

  it("someone else's order, another order's item and a bad body are refused before anything is written", async () => {
    const o = await confirmed("access");
    const other = await confirmed("access-other");
    const notFound: string[] = [];
    for (const res of [
      await request(o.reference, { orderItemId: o.itemId, kind: "cancel" }, B.cookie),
      await request(o.reference, { orderItemId: o.itemId, kind: "cancel" }, ""),
      await request(o.reference, { orderItemId: other.itemId, kind: "cancel" }),
      await request("OUT-10000017", { orderItemId: o.itemId, kind: "cancel" }),
    ]) {
      expect(res.status).toBe(404);
      notFound.push(await res.text());
    }
    expect(new Set(notFound).size).toBe(1);
    expect((await request(o.reference, { orderItemId: o.itemId, kind: "refund" })).status).toBe(422);
    const { POST } = await route();
    const crossSite = await POST(apiRequest(`/api/orders/${o.reference}/cancellation`, { body: { orderItemId: o.itemId, kind: "cancel" }, cookie: A.cookie, origin: "https://evil.example", headers: { "x-real-ip": nextIp() } }), params({ reference: o.reference }));
    expect(crossSite.status).toBe(403);
    expect(await prisma.cancellationRequest.count({ where: { orderItemId: { in: [o.itemId, other.itemId] } } })).toBe(0);
  });
});
