import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { apiRequest, assertDisposableDb, cleanupPeople, createCustomer, dbEnabled, params, runId, syntheticPhone, type CustomerFixture } from "../helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, makeOrder, publishedProduct } from "../security/_mercury-fixtures";
import { cleanupCustomerRows, forbiddenKeys, guestSession, instantOrder, setupCustomerFixtures, type CustomerFixtures, type InstantOrder } from "./customer-fixtures";
import { resetEnvCache } from "@/server/lib/env";
import { uuidv7 } from "@/server/lib/ids";
import type { OrderItemTickets } from "@/server/services/document.service";

/**
 * GET /api/orders/[reference]/status end to end through the real handler and
 * the disposable database (doc 22 §23 B5; PRD-17, TKT-4, TKT-5, TKT-8, F39):
 *
 *  - customer A/B and guest A/B: only the owner sees the order; everyone
 *    else, an unknown and a malformed reference get one identical 404;
 *  - the guest session that paid sees the order after the gateway's return,
 *    an expired one does not;
 *  - one browser holds grants for two orders (R-B4-11) and a revoked grant
 *    stops at once;
 *  - headers, a fail-closed rate limit, and no forbidden key anywhere in a
 *    body; projections of stored saga states, including unknown outcomes,
 *    attention and a historic assisted order;
 *  - the server-component loader reads the same cookies.
 *
 * Ticket documents come from a mocked `documentService.listForOrder` (the
 * document service is tested by its owner).
 */

const jar = vi.hoisted(() => ({ cookies: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (jar.cookies.has(name) ? { name, value: jar.cookies.get(name)! } : undefined) }),
}));

const run = runId();
const runOctet = (Number.parseInt(run.slice(-2), 16) % 200) + 20;
let ipSeq = 0;
const nextIp = () => `198.18.${runOctet}.${(ipSeq++ % 250) + 1}`;
const savedEnv = { ...process.env };

type Prisma = Awaited<ReturnType<typeof db>>;
let prisma: Prisma;
let fx: CustomerFixtures;
let A: CustomerFixture;
let B: CustomerFixture;
let capability: typeof import("@/server/services/capability.service");
const tickets = new Map<string, OrderItemTickets[]>();
const DOC = uuidv7();

const statusRoute = () => import("@/app/api/orders/[reference]/status/route");
const exchangeRoute = () => import("@/app/api/tickets/exchange/route");

async function status(reference: string, cookie?: string) {
  const { GET } = await statusRoute();
  return GET(apiRequest(`/api/orders/${reference}/status`, { cookie, headers: { "x-real-ip": nextIp() } }), params({ reference }));
}

async function exchange(token: string, cookie?: string) {
  const { POST } = await exchangeRoute();
  return POST(apiRequest("/api/tickets/exchange", { body: { token }, cookie, headers: { "x-real-ip": nextIp() } }), params({}));
}

function accessCookie(res: Response): string {
  const set = res.headers.getSetCookie().find((c) => c.startsWith("outlyy_ticket_access="));
  if (!set) throw new Error("no access cookie");
  return set.split(";")[0];
}

async function grantCookie(orderId: string, purpose: "view_status" | "download_tickets", cookie?: string) {
  const g = await capability.capabilityService.mint(prisma, { orderId, purpose, issuedFor: "status_notification" });
  const res = await exchange(g.token, cookie);
  expect(res.status).toBe(200);
  return { ...g, res, cookie: accessCookie(res) };
}

const bodies: unknown[] = [];
async function ok(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const body = await res.json();
  bodies.push(body);
  return body;
}

describe.skipIf(!dbEnabled)("customer status route: access, projection and privacy (B5)", () => {
  let orderA: InstantOrder;
  let orderGuest: InstantOrder;
  let guestA: Awaited<ReturnType<typeof guestSession>>;
  let guestB: Awaited<ReturnType<typeof guestSession>>;

  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    process.env.TRUST_PROXY_IP_HEADERS = "true";
    resetEnvCache();
    prisma = await db();
    capability = await import("@/server/services/capability.service");
    fx = await setupCustomerFixtures(prisma, run, await publishedProduct());
    A = await createCustomer(run, syntheticPhone(run, 61));
    B = await createCustomer(run, syntheticPhone(run, 62));
    guestA = await guestSession(prisma, fx);
    guestB = await guestSession(prisma, fx);
    orderA = await instantOrder(prisma, run, fx, { label: "cust-a", owner: { kind: "customer", customerId: A.id }, sagaState: "fulfilled", capturedMinor: 45_000n, bookingState: "confirmed", issuesTicketsAtConfirm: "no" });
    orderGuest = await instantOrder(prisma, run, fx, { label: "guest-a", owner: { kind: "guest", guestSessionId: guestA.id }, sagaState: "reserved", sagaDeadline: new Date(Date.now() + 10 * 60_000), bookingState: "awaiting_payment" });
    tickets.set(orderA.id, [
      {
        orderItemId: orderA.itemId,
        fulfilment: "issued",
        documents: [
          { id: DOC, kind: "tickets_pdf", version: 1, status: "valid", contentType: "application/pdf", byteSize: 1234, createdAt: new Date().toISOString(), ...({ storageKey: "test/0123456789abcdef0123456789abcdef", sha256: "f".repeat(64) } as object) },
        ],
      },
    ]);
    const { documentService } = await import("@/server/services/document.service");
    vi.spyOn(documentService, "listForOrder").mockImplementation(async (orderId: string) => tickets.get(orderId) ?? []);
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

  it("customer A sees A's order; customer B, anonymous callers and unknown or malformed references get one identical 404", async () => {
    const body = await ok(await status(orderA.reference, A.cookie));
    expect(body).toMatchObject({ reference: orderA.reference, state: "confirmed", rail: "self_serve", currency: "AED", totalMinor: "45000" });
    expect(body.items[0].tickets.documents).toEqual([{ id: DOC, kind: "tickets_pdf", version: 1, contentType: "application/pdf", byteSize: 1234, href: `/api/tickets/documents/${DOC}` }]);
    expect(body.items[0].cancellation).toEqual({ kind: "eligible", refundMinor: "45000", currency: "AED", untilUtc: "2030-01-14T06:00:00.000Z" });

    const refusals: string[] = [];
    for (const [reference, cookie] of [
      [orderA.reference, B.cookie],
      [orderA.reference, undefined],
      [orderA.reference, guestA.cookie],
      ["OUT-10000017", A.cookie],
      ["not-a-reference", A.cookie],
      [orderGuest.reference, A.cookie],
    ] as const) {
      const res = await status(reference, cookie);
      expect(res.status, `${reference} with ${cookie ? cookie.split("=")[0] : "no cookie"}`).toBe(404);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      refusals.push(await res.text());
    }
    expect(new Set(refusals).size).toBe(1);
    expect(JSON.parse(refusals[0])).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
  });

  it("the guest session that paid sees the order after the gateway's return; another or an expired session does not", async () => {
    const body = await ok(await status(orderGuest.reference, guestA.cookie));
    // A reserved hold with its deadline: processing, and the automatic release time (TKT-8).
    expect(body).toMatchObject({ state: "booking_processing", tone: "progress", deadlines: { remedyKind: "release" } });
    expect(body.deadlines.remedyAtUtc).toMatch(/Z$/);
    expect(body.pollAfterMs).toBeGreaterThan(0);
    // A guest session can view, never download: no document links.
    expect(body.items[0].tickets.documents).toEqual([]);
    expect((await status(orderGuest.reference, guestB.cookie)).status).toBe(404);
    await prisma.guestSession.update({ where: { id: guestA.id }, data: { revokedAt: new Date() } });
    expect((await status(orderGuest.reference, guestA.cookie)).status).toBe(404);
  });

  it("one browser holds grants for two orders; the exchange answers with the reference; a revoked grant stops at once", async () => {
    const first = await grantCookie(orderA.id, "view_status");
    expect(await first.res.json()).toMatchObject({ ok: true, purpose: "view_status", reference: orderA.reference });
    const second = await grantCookie(orderGuest.id, "download_tickets", first.cookie);
    expect(await second.res.json()).toMatchObject({ reference: orderGuest.reference });
    const both = second.cookie;
    expect(both.split("=")[1].split("~")).toHaveLength(2);

    const a = await ok(await status(orderA.reference, both));
    // view_status lists the state but not the document links.
    expect(a.items[0].tickets).toEqual({ fulfilment: "issued", documents: [] });
    // R-B5-10: without a sent ticket email the page does not claim one; once it is sent, it says so.
    expect(a.nextStep).not.toMatch(/emailed/);
    await prisma.notification.create({
      data: { id: uuidv7(), event: "TICKETS_READY", channel: "email", recipient: `zz-sec-${run}@outlyy.test`, orderId: orderA.id, status: "sent", sentAt: new Date(), payload: { kind: "tickets_ready", orderId: orderA.id, orderItemId: orderA.itemId, documentVersion: 1 } },
    });
    expect((await ok(await status(orderA.reference, both))).nextStep).toMatch(/We've also emailed you a link to it/);
    await ok(await status(orderGuest.reference, both));

    await capability.capabilityService.revoke(prisma, first.grantId, "staff");
    expect((await status(orderA.reference, both)).status, "revoked: denied on the very next request").toBe(404);
    expect((await status(orderGuest.reference, both)).status).toBe(200);

    // A download grant lists the links.
    const dl = await grantCookie(orderA.id, "download_tickets", both);
    const withLinks = await ok(await status(orderA.reference, dl.cookie));
    expect(withLinks.items[0].tickets.documents).toHaveLength(1);
  });

  it("the server-component loader reads the same cookies and answers null when not visible", async () => {
    const { loadCustomerOrderStatusFromCookies } = await import("@/server/services/order-status.service");
    jar.cookies.clear();
    expect(await loadCustomerOrderStatusFromCookies(orderA.reference)).toBeNull();
    jar.cookies.set("outlyy_customer_session", A.token);
    expect(await loadCustomerOrderStatusFromCookies(orderA.reference)).toMatchObject({ reference: orderA.reference, state: "confirmed" });
    expect(await loadCustomerOrderStatusFromCookies(orderGuest.reference)).toBeNull();
    jar.cookies.clear();
  });

  it("stored states project honestly: unknown capture, attention, missing ticket, refund delay, and a historic assisted order", async () => {
    const own = { kind: "customer" as const, customerId: A.id };
    const deadline = new Date(Date.now() + 5 * 60_000);
    const unknown = await instantOrder(prisma, run, fx, { label: "unknown", owner: own, sagaState: "capture_unknown", sagaDeadline: deadline, bookingState: "awaiting_payment" });
    expect(await ok(await status(unknown.reference, A.cookie))).toMatchObject({ state: "payment_processing", deadlines: { remedyAtUtc: deadline.toISOString(), remedyKind: "refund" } });

    const attention = await instantOrder(prisma, run, fx, { label: "attention", owner: own, sagaState: "attention", capturedMinor: 45_000n, bookingState: "outcome_unknown" });
    const att = await ok(await status(attention.reference, A.cookie));
    expect(att).toMatchObject({ state: "needs_attention", tone: "warning", pollAfterMs: null, deadlines: { remedyAtUtc: null } });

    const missing = await instantOrder(prisma, run, fx, { label: "missing", owner: own, sagaState: "fulfilled", capturedMinor: 45_000n, bookingState: "confirmed" });
    tickets.set(missing.id, [{ orderItemId: missing.itemId, fulfilment: "ticket_pending", documents: [] }]);
    expect(await ok(await status(missing.reference, A.cookie))).toMatchObject({ state: "confirmed_ticket_pending", pollAfterMs: 5_000 });

    const delayed = await instantOrder(prisma, run, fx, { label: "delayed", owner: own, sagaState: "refund_pending", capturedMinor: 45_000n, bookingState: "rejected" });
    await prisma.refund.create({
      data: { id: uuidv7(), paymentId: delayed.paymentId, orderItemId: delayed.itemId, provider: "fake_aed_card", idempotencyKey: `refund:${delayed.paymentId}:1`, amountMinor: 45_000n, currency: "AED", status: "unknown", reason: "reserve_rejected" },
    });
    const del = await ok(await status(delayed.reference, A.cookie));
    expect(del).toMatchObject({ state: "refund_processing", steps: { refund: { status: "in_progress" }, booking: { status: "failed" } } });

    const assisted = await makeOrder(run, { leadPhone: syntheticPhone(run, 63), customerId: A.id, label: "assisted" });
    const as = await ok(await status(assisted.reference, A.cookie));
    expect(as).toMatchObject({ state: "paid_confirmed_by_team", rail: "assisted", currency: "INR", totalMinor: "777700", pollAfterMs: null });
  });

  it("the per-IP limit fails closed when its store is down", async () => {
    const spy = vi.spyOn(prisma, "$queryRaw").mockRejectedValue(new Error("simulated limiter store outage (test)"));
    try {
      const res = await status(orderA.reference, A.cookie);
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe("UNAVAILABLE");
    } finally {
      spy.mockRestore();
    }
  });

  it("no body named a forbidden key (net, margin, supplier ids, storage keys, codes, gateway ids, the order id)", () => {
    expect(bodies.length).toBeGreaterThan(8);
    for (const body of bodies) {
      expect(forbiddenKeys(body)).toEqual([]);
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/storageKey|sha256|test\/[0-9a-f]{32}|zz_pay_|fake_aed_card/);
      for (const o of fx.orders) {
        expect(text).not.toContain(o.id);
        expect(text).not.toContain(o.paymentId);
        expect(text).not.toContain(o.mappingId);
      }
    }
  });
});
