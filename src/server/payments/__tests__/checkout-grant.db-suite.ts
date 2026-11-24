import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { dbEnabled, runId } from "../../__tests__/helpers/fixtures";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import { resetEnvCache } from "../../lib/env";
import { checkedOut, cleanupB3, deliver, harness, quoteFixture, sagaState, startInput, TRAVELLER_PHONE } from "./_b3-harness";

/**
 * Checkout redesign batch 3 (CO-02) and its security review, on the B3
 * harness (real checkout.service, saga and inbox; fake gateways and engine):
 *
 *  - the FIRST checkout of an active quote, through the real
 *    `createCheckoutHandler` and the real grant service, creates the order
 *    and issues the browser its checkout download grant;
 *  - the saga's full refund (UPI paid, reserve rejected) revokes that grant
 *    (`order_cancelled`) in its own transaction, and leaves an emailed link.
 *
 * Imported by evidence.test.ts (the payments db suite). Synthetic amounts.
 */

type Prisma = typeof import("../../lib/db").prisma;

describe.skipIf(!dbEnabled)("B3 checkout download grant (disposable database)", () => {
  let prisma: Prisma;
  const run = runId();
  const saved = { ...process.env };

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    await cleanupB3(prisma);
    process.env.INSTANT_RELEASE_ENABLED = "true";
    process.env.GUEST_DOWNLOAD_GRANT_ENABLED = "true";
    process.env.TRUST_PROXY_IP_HEADERS = "true";
    resetEnvCache();
  });

  afterAll(async () => {
    process.env = { ...saved };
    resetEnvCache();
    await cleanupB3(prisma);
  });

  it("the first checkout of an active quote, through the real route handler, creates the order and issues the grant; the saga's full refund revokes it", async () => {
    const h = await harness(prisma);
    const q = await quoteFixture(h, run, "INR");
    // The harness's guest session gets a token this test knows, as the browser's cookie would carry it.
    const token = randomBytes(32).toString("base64url");
    await prisma.guestSession.update({ where: { id: q.guestSessionId }, data: { tokenHash: createHash("sha256").update(token).digest("hex") } });

    const { createCheckoutHandler } = await import("../../../app/api/checkout/handler");
    const { checkoutDownloadGrant } = await import("../../services/checkout-download-grant.service");
    const POST = createCheckoutHandler(
      () => h.checkout,
      () => checkoutDownloadGrant,
    );
    const input = startInput(q, "upi");
    const site = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").origin;
    const res = await POST(
      new NextRequest(new URL("/api/checkout", site), {
        method: "POST",
        headers: { origin: site, "content-type": "application/json", cookie: `outlyy_guest_session=${token}`, "x-real-ip": "198.51.100.77" },
        body: JSON.stringify({ quoteId: input.quoteId, verificationId: input.verificationId, method: "upi", traveller: { fullName: "Zz Btree Traveller", phoneE164: TRAVELLER_PHONE, email: null } }),
      }),
      undefined as never,
    );
    expect(res.status).toBe(201);
    const { orderReference } = (await res.json()) as { orderReference: string };
    const order = await prisma.order.findUniqueOrThrow({ where: { reference: orderReference } });
    // The quote was active: this was the first call, which created the order.
    expect(await prisma.quote.findUniqueOrThrow({ where: { id: q.quoteId } })).toMatchObject({ status: "used", usedByOrderId: order.id });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("outlyy_ticket_access="));
    expect(set).toMatch(/HttpOnly/i);
    const grant = await prisma.guestCapabilityGrant.findFirstOrThrow({ where: { orderId: order.id, issuedFor: "checkout" } });
    expect(set).toContain(grant.id);
    expect(grant).toMatchObject({ purpose: "download_tickets", revokedAt: null });

    // An emailed link exists too; the saga then refunds the whole order (UPI paid, reserve rejected).
    const { capabilityService } = await import("../../services/capability.service");
    const emailed = await capabilityService.mint(prisma, { orderId: order.id, purpose: "download_tickets", issuedFor: "ticket_notification", supersede: "after_sent" });
    const saga = await prisma.paymentSaga.findUniqueOrThrow({ where: { orderId: order.id }, include: { payment: true } });
    const pid = h.inr.pay(saga.payment!.providerOrderId!);
    await deliver(h, h.inr, "payment.captured", pid);
    h.engine.reserve(saga.orderItemId, "rejected");
    await h.saga.notifier.bookingChanged(saga.orderItemId, "rejected");
    expect((await sagaState(h, saga.id)).state).toBe("refunded");
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: grant.id } })).revokeReason).toBe("order_cancelled");
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: emailed.grantId } })).revokedAt).toBeNull();
  });

  it("a saga refund on an order without a checkout grant revokes nothing", async () => {
    const h = await harness(prisma);
    const c = await checkedOut(h, run, "INR", "upi");
    const { capabilityService } = await import("../../services/capability.service");
    const emailed = await capabilityService.mint(prisma, { orderId: c.r.orderId, purpose: "download_tickets", issuedFor: "ticket_notification", supersede: "after_sent" });
    const pid = c.gw.pay(c.providerOrderId);
    await deliver(h, c.gw, "payment.captured", pid);
    h.engine.reserve(c.orderItemId, "rejected");
    await h.saga.notifier.bookingChanged(c.orderItemId, "rejected");
    expect((await sagaState(h, c.sagaId)).state).toBe("refunded");
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: emailed.grantId } })).revokedAt).toBeNull();
  });
});
