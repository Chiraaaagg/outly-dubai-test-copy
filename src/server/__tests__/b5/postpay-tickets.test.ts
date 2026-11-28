import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiRequest, assertDisposableDb, cleanupPeople, createCustomer, createStaff, dbEnabled, params, runId, syntheticPhone, type CustomerFixture, type StaffFixture } from "../helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, publishedProduct } from "../security/_mercury-fixtures";
import { cleanupCustomerRows, instantOrder, setupCustomerFixtures, type CustomerFixtures, type InstantOrder } from "./customer-fixtures";
import { resetEnvCache } from "@/server/lib/env";
import { uuidv7 } from "@/server/lib/ids";
import { ROLE_PERMISSIONS } from "@/server/lib/permissions";
import type { Actor } from "@/server/lib/actor";
import type { OrderItemTickets } from "@/server/services/document.service";
import type { EmailOutcome, EmailSend, EmailSendOptions } from "@/server/notifications/email.adapter";

/**
 * Post-payment batch A, server half, end to end on the disposable database
 * with synthetic orders only (no provider, no network):
 *
 *  - A2: on a two-item order each item's ticket email keeps its own link; a
 *    new version for one item revokes only that item's older link; a staff
 *    resend sends every item and revokes every older link but not its own
 *    batch's;
 *  - A4: POST /api/orders/:reference/tickets/resend: download access only
 *    (uniform 404 otherwise), same origin, every item, the order's own
 *    email, audited without the address, one per 2 minutes and 3 per 24
 *    hours from the ledger, two at once let exactly one through, 409 with
 *    nothing to send;
 *  - A1/A3: the status route carries the verified, deliverable unlock
 *    channels and the masked delivery view, never the address;
 *  - A8: POST /api/webhooks/resend: closed without a secret, Svix signature
 *    and timestamp checked before anything is stored, idempotent per
 *    `svix-id`, delivered and bounced reach the rows and the projection, a
 *    bounce is never re-sent, and no address is stored.
 *  - Fix round 1: a resend asked through an emailed link keeps that link
 *    working (M1); a stored event whose apply step failed is applied when
 *    Svix redelivers it (M2).
 *  - Fix round 2: a resend through an older link never revokes a newer link
 *    of the same item (N2); the resend route answers 429 before the access
 *    check once the per-IP budget is spent (N1); a redelivery that changes
 *    nothing now is stored as `reapplied` (N3).
 *
 * Ticket documents come from a mocked `documentService.listForOrder`; the
 * email provider is a fake that accepts everything.
 */

const run = runId();
const runOctet = (Number.parseInt(run.slice(-2), 16) % 200) + 20;
let ipSeq = 0;
const nextIp = () => `198.19.${runOctet}.${(ipSeq++ % 250) + 1}`;
const savedEnv = { ...process.env };
const TOKEN_IN_LINK = /\/t#([A-Za-z0-9_-]{43})\b/;
const SECRET = `whsec_${Buffer.from(`zz-postpay-${run}-webhook-signing-key`).toString("base64")}`;

type Prisma = Awaited<ReturnType<typeof db>>;
let prisma: Prisma;
let fx: CustomerFixtures;
let A: CustomerFixture;
let B: CustomerFixture;
let ops: StaffFixture;
let capability: typeof import("@/server/services/capability.service");
let notifications: typeof import("@/server/services/notification.service");
let webhook: typeof import("@/server/notifications/resend-webhook");
const tickets = new Map<string, OrderItemTickets[]>();
const sends: { key: string; msg: EmailSend }[] = [];
const svixIds: string[] = [];

const resendRoute = () => import("@/app/api/orders/[reference]/tickets/resend/route");
const statusRoute = () => import("@/app/api/orders/[reference]/status/route");
const webhookRoute = () => import("@/app/api/webhooks/resend/route");
const exchangeRoute = () => import("@/app/api/tickets/exchange/route");

async function fakeSend(msg: EmailSend, opts?: EmailSendOptions): Promise<EmailOutcome> {
  const key = opts?.idempotencyKey ?? "missing";
  sends.push({ key, msg });
  return { kind: "sent", providerId: `fake-${key}` };
}

function opsActor(): Actor {
  return { type: "admin", id: ops.id, roles: ["ops"], permissions: new Set(ROLE_PERMISSIONS.ops) };
}

const doc = (kind: "tickets_pdf" | "voucher_pdf", version = 1) => ({ id: uuidv7(), kind, version, status: "valid" as const, contentType: "application/pdf", byteSize: 2048, createdAt: new Date().toISOString() });

/** A paid, confirmed instant order owned by `owner`, with a bound verified email and `extraItems` more items. */
async function ticketOrder(label: string, owner: CustomerFixture, extraItems = 0): Promise<InstantOrder & { items: string[]; email: string }> {
  const email = `zz-sec-${run}-${label}@outlyy.test`;
  const o = await instantOrder(prisma, run, fx, {
    label,
    owner: { kind: "customer", customerId: owner.id },
    sagaState: "fulfilled",
    capturedMinor: 45_000n,
    bookingState: "confirmed",
    issuesTicketsAtConfirm: "no",
    orderStatus: "confirmed",
    verified: { channel: "email", contact: email },
  });
  const first = await prisma.orderItem.findUniqueOrThrow({ where: { id: o.itemId } });
  const items = [o.itemId];
  if (extraItems) {
    // An order's items are fixed once it has a payment saga (database guard): lift the saga, add the items, put it back.
    const saga = await prisma.paymentSaga.findUniqueOrThrow({ where: { id: o.sagaId } });
    await prisma.paymentSaga.delete({ where: { id: o.sagaId } });
    for (let i = 0; i < extraItems; i += 1) {
      const id = uuidv7();
      const { id: _id, ...rest } = first;
      await prisma.orderItem.create({ data: { ...rest, id, titleSnapshot: `${first.titleSnapshot} ${i + 2}` } as never });
      items.push(id);
    }
    await prisma.paymentSaga.create({ data: saga as never });
  }
  tickets.set(o.id, items.map((orderItemId, i) => ({ orderItemId, fulfilment: "issued" as const, documents: [doc(i === 0 ? "tickets_pdf" : "voucher_pdf")] })));
  return { ...o, items, email };
}

async function resend(reference: string, opts: { cookie?: string; origin?: string | null } = {}) {
  const { POST } = await resendRoute();
  return POST(apiRequest(`/api/orders/${reference}/tickets/resend`, { method: "POST", cookie: opts.cookie, origin: opts.origin, headers: { "x-real-ip": nextIp() } }), params({ reference }));
}

async function status(reference: string, cookie: string) {
  const { GET } = await statusRoute();
  const res = await GET(apiRequest(`/api/orders/${reference}/status`, { cookie, headers: { "x-real-ip": nextIp() } }), params({ reference }));
  expect(res.status).toBe(200);
  return res;
}

async function postWebhook(body: string, headers: Record<string, string>) {
  const { POST } = await webhookRoute();
  return POST(apiRequest("/api/webhooks/resend", { rawBody: body, origin: null, headers }));
}

function signed(event: Record<string, unknown>, opts: { at?: number; id?: string; secret?: string } = {}) {
  const body = JSON.stringify(event);
  const id = opts.id ?? `msg_${run}_${svixIds.length}`;
  svixIds.push(id);
  const timestamp = opts.at ?? Math.floor(Date.now() / 1000);
  return { body, id, headers: { "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": webhook.signSvixForTests({ body, id, timestamp, secret: opts.secret ?? SECRET }) } };
}

async function rowsFor(orderId: string) {
  return prisma.notification.findMany({ where: { orderId, event: "TICKETS_READY" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
}

/** The access cookie a browser gets by opening `token`'s link (the /t exchange). */
async function exchangeCookie(token: string): Promise<string> {
  const { POST } = await exchangeRoute();
  const ex = await POST(apiRequest("/api/tickets/exchange", { body: { token }, headers: { "x-real-ip": nextIp() } }), params({}));
  expect(ex.status).toBe(200);
  return ex.headers.getSetCookie().find((c) => c.startsWith("outlyy_ticket_access="))!.split(";")[0];
}

async function grantsFor(orderId: string) {
  return prisma.guestCapabilityGrant.findMany({ where: { orderId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
}

describe.skipIf(!dbEnabled)("post-payment batch A: tickets, resend and delivery (server)", () => {
  let two: Awaited<ReturnType<typeof ticketOrder>>;

  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    process.env.TRUST_PROXY_IP_HEADERS = "true";
    process.env.NOTIFICATION_RECIPIENT_ALLOWLIST = "@outlyy.test";
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_WEBHOOK_SECRET;
    resetEnvCache();
    prisma = await db();
    capability = await import("@/server/services/capability.service");
    notifications = await import("@/server/services/notification.service");
    webhook = await import("@/server/notifications/resend-webhook");
    const { emailAdapter } = await import("@/server/notifications/email.adapter");
    vi.spyOn(emailAdapter, "send").mockImplementation(fakeSend as never);
    const { documentService } = await import("@/server/services/document.service");
    vi.spyOn(documentService, "listForOrder").mockImplementation(async (orderId: string) => tickets.get(orderId) ?? []);
    fx = await setupCustomerFixtures(prisma, run, await publishedProduct());
    A = await createCustomer(run, syntheticPhone(run, 71));
    B = await createCustomer(run, syntheticPhone(run, 72));
    ops = await createStaff(run, "postpay-ops", ["ops"]);
    two = await ticketOrder("two", A, 1);
  });

  afterEach(() => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    resetEnvCache();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    resetEnvCache();
    if (!prisma) return;
    await prisma.webhookEvent.deleteMany({ where: { provider: "resend", providerEventId: { in: svixIds } } });
    await cleanupCustomerRows(prisma, fx);
    await cleanupBusinessRows(run);
    await cleanupPeople(run);
  });

  it("A2: each item's ticket email keeps its own link; a new version replaces only that item's", async () => {
    const [itemA, itemB] = two.items;
    await notifications.notificationService.onTicketsReady({ orderId: two.id, orderItemId: itemA, documentVersion: 1 });
    await notifications.notificationService.onTicketsReady({ orderId: two.id, orderItemId: itemB, documentVersion: 1 });
    let grants = await grantsFor(two.id);
    expect(grants.map((g) => [g.issuedFor, g.revokedAt])).toEqual([
      ["ticket_notification", null],
      ["ticket_notification", null],
    ]);
    // Both emailed links work (the second email no longer kills the first, owner decision of 27 Nov 2026).
    const tokens = sends.slice(-2).map((s) => TOKEN_IN_LINK.exec(s.msg.text)![1]);
    for (const t of tokens) expect((await capability.capabilityService.exchange(t)).ok).toBe(true);

    await notifications.notificationService.onTicketsReady({ orderId: two.id, orderItemId: itemA, documentVersion: 2 });
    grants = await grantsFor(two.id);
    expect(grants.map((g) => g.revokeReason)).toEqual(["superseded", null, null]);
    expect((await capability.capabilityService.exchange(tokens[0])).ok).toBe(false);
    expect((await capability.capabilityService.exchange(tokens[1])).ok).toBe(true);
  });

  it("A2/A4: a staff resend sends every item, revokes every older link, never its own batch's; audited without the address", async () => {
    const before = await grantsFor(two.id);
    const result = await notifications.notificationService.resendTickets(opsActor(), { orderId: two.id });
    expect(result.results).toHaveLength(2);
    expect(result.outcome).toBe("sent");
    const after = await grantsFor(two.id);
    const fresh = after.filter((g) => !before.some((b) => b.id === g.id));
    expect(fresh.map((g) => [g.issuedFor, g.revokedAt])).toEqual([
      ["staff_resend", null],
      ["staff_resend", null],
    ]);
    for (const g of after.filter((x) => before.some((b) => b.id === x.id))) expect(g.revokedAt, `older grant ${g.id}`).not.toBeNull();
    const rows = (await rowsFor(two.id)).slice(-2);
    expect(rows.map((r) => (r.payload as { resend?: string }).resend)).toEqual(["staff", "staff"]);
    expect(new Set(rows.map((r) => (r.payload as { orderItemId: string }).orderItemId))).toEqual(new Set(two.items));
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "tickets.resend", entityId: two.id }, orderBy: { createdAt: "desc" } });
    const text = JSON.stringify(audit, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(text).not.toContain(two.email);
    expect((audit.after as { items: unknown[] }).items).toHaveLength(2);
  });

  it("A4: only a viewer who may download can ask; everyone else gets the same 404; cross-origin is refused", async () => {
    const notFound = async (res: Response) => {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    };
    await notFound(await resend(two.reference));
    await notFound(await resend(two.reference, { cookie: B.cookie }));
    await notFound(await resend("OUT-99999999", { cookie: A.cookie }));
    await notFound(await resend("not-a-reference", { cookie: A.cookie }));
    // A view-only grant shows the order but may not resend.
    const g = await capability.capabilityService.mint(prisma, { orderId: two.id, purpose: "view_status", issuedFor: "status_notification" });
    const { POST } = await exchangeRoute();
    const ex = await POST(apiRequest("/api/tickets/exchange", { body: { token: g.token }, headers: { "x-real-ip": nextIp() } }), params({}));
    const viewCookie = ex.headers.getSetCookie().find((c) => c.startsWith("outlyy_ticket_access="))!.split(";")[0];
    await notFound(await resend(two.reference, { cookie: viewCookie }));
    expect((await resend(two.reference, { cookie: A.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect(await prisma.auditLog.count({ where: { action: "tickets.customer_resend", entityId: two.id } })).toBe(0);
  });

  it("A4: the owner's resend sends every item to the order's email, replaces each item's older link, and is audited without the address", async () => {
    const before = await grantsFor(two.id);
    const sentBefore = sends.length;
    const res = await resend(two.reference, { cookie: A.cookie });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Date.parse(body.resendAvailableAt) - Date.now()).toBeGreaterThan(60_000);
    expect(sends.length - sentBefore).toBe(2);
    const rows = (await rowsFor(two.id)).slice(-2);
    expect(rows.map((r) => r.recipient)).toEqual([two.email, two.email]);
    expect(rows.map((r) => (r.payload as { resend?: string }).resend)).toEqual(["customer", "customer"]);
    const after = await grantsFor(two.id);
    const fresh = after.filter((g) => !before.some((b) => b.id === g.id));
    expect(fresh.map((g) => [g.issuedFor, g.revokedAt])).toEqual([
      ["ticket_notification", null],
      ["ticket_notification", null],
    ]);
    // The staff batch's links were for the same two items: both replaced now.
    expect(after.filter((g) => g.issuedFor === "staff_resend").every((g) => g.revokeReason === "superseded")).toBe(true);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "tickets.customer_resend", entityId: two.id } });
    expect(audit.actorType).toBe("customer");
    expect(JSON.stringify(audit, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(two.email);
    expect(audit.after).toMatchObject({ counts: { items: 2 }, codes: { recipientField: "orders.lead_email" } });
  });

  it("A4: a second request inside 2 minutes is 429 with Retry-After and sends nothing", async () => {
    const sentBefore = sends.length;
    const res = await resend(two.reference, { cookie: A.cookie });
    expect(res.status).toBe(429);
    const retry = Number(res.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(120);
    expect((await res.json()).error.code).toBe("RATE_LIMITED");
    expect(sends.length).toBe(sentBefore);
  });

  it("A4: three resends in the last 24 hours block a fourth until the oldest leaves the window", async () => {
    const o = await ticketOrder("day-cap", A);
    const now = Date.now();
    for (const hoursAgo of [23, 10, 5]) {
      await prisma.auditLog.create({ data: { actorType: "customer", action: "tickets.customer_resend", entityType: "order", entityId: o.id, after: { fields: ["notifications"] }, createdAt: new Date(now - hoursAgo * 3600_000) } });
    }
    const res = await resend(o.reference, { cookie: A.cookie });
    expect(res.status).toBe(429);
    const at = Date.parse((await res.json()).error.resendAvailableAt);
    expect(Math.abs(at - (now + 3600_000))).toBeLessThan(60_000);
  });

  it("A4: two requests at once let exactly one through", async () => {
    const o = await ticketOrder("race", A);
    const statuses = (await Promise.all([resend(o.reference, { cookie: A.cookie }), resend(o.reference, { cookie: A.cookie })])).map((r) => r.status).sort();
    expect(statuses).toEqual([202, 429]);
    expect(await prisma.auditLog.count({ where: { action: "tickets.customer_resend", entityId: o.id } })).toBe(1);
  });

  it("A4: nothing to send (no email on the order, or no valid file) is 409", async () => {
    const noEmail = await ticketOrder("no-email", A);
    await prisma.order.update({ where: { id: noEmail.id }, data: { leadEmail: null } });
    const r1 = await resend(noEmail.reference, { cookie: A.cookie });
    expect(r1.status).toBe(409);
    expect((await r1.json()).error.code).toBe("NOTHING_TO_SEND");
    const noFile = await ticketOrder("no-file", A);
    tickets.set(noFile.id, [{ orderItemId: noFile.itemId, fulfilment: "ticket_pending", documents: [] }]);
    expect((await resend(noFile.reference, { cookie: A.cookie })).status).toBe(409);
    // The projection promises no email for the order without one, and shows no delivery view.
    const body = await (await status(noEmail.reference, A.cookie)).json();
    expect(body.delivery).toBeNull();
  });

  it("A1/A3: the status route carries the verified, deliverable channels and the masked delivery view, never the address", async () => {
    const res = await status(two.reference, A.cookie);
    const text = await res.clone().text();
    const body = await res.json();
    // Outside production both channels can deliver; only email was verified for this order.
    expect(body.unlockChannels).toEqual(["email"]);
    expect(body.delivery).toMatchObject({ channel: "email", state: "sent", recipientMasked: "z•••@outlyy.test", canResend: false });
    expect(Date.parse(body.delivery.resendAvailableAt)).toBeGreaterThan(Date.now());
    expect(text).not.toContain(two.email);
    expect(body.steps.tickets.label).toMatch(/^(Tickets|Voucher) ready$/);
  });

  it("A8: closed without a secret; a bad, stale or missing signature is 401 and stores nothing", async () => {
    const row = (await rowsFor(two.id)).at(-1)!;
    const event = { type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: row.providerId, to: [two.email], subject: "Your tickets" } };
    const closed = signed(event);
    expect((await postWebhook(closed.body, closed.headers)).status).toBe(503);

    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    resetEnvCache();
    const wrong = signed(event, { secret: `whsec_${Buffer.from("zz-some-other-signing-key-000").toString("base64")}` });
    expect((await postWebhook(wrong.body, wrong.headers)).status).toBe(401);
    const stale = signed(event, { at: Math.floor(Date.now() / 1000) - 10 * 60 });
    expect((await postWebhook(stale.body, stale.headers)).status).toBe(401);
    const tampered = signed(event);
    expect((await postWebhook(tampered.body.replace("delivered", "bounced"), tampered.headers)).status).toBe(401);
    const missing = signed(event);
    expect((await postWebhook(missing.body, { "svix-id": missing.id, "svix-timestamp": missing.headers["svix-timestamp"] })).status).toBe(401);
    expect(await prisma.webhookEvent.count({ where: { provider: "resend", providerEventId: { in: svixIds } } })).toBe(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("sent");
  });

  it("A8: delivered reaches the row; 'delivered' shows only once every item is delivered; a redelivery changes nothing; no address stored", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    resetEnvCache();
    const [first, second] = (await rowsFor(two.id)).slice(-2);
    const one = signed({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: first.providerId, to: [two.email] } });
    expect((await postWebhook(one.body, one.headers)).status).toBe(200);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("delivered");
    expect((await (await status(two.reference, A.cookie)).json()).delivery.state).toBe("sent");

    const both = signed({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: second.providerId, to: [two.email] } });
    expect((await postWebhook(both.body, both.headers)).status).toBe(200);
    expect((await (await status(two.reference, A.cookie)).json()).delivery.state).toBe("delivered");

    // The same svix-id again: acknowledged, stored once.
    expect((await postWebhook(both.body, both.headers)).status).toBe(200);
    expect(await prisma.webhookEvent.count({ where: { provider: "resend", providerEventId: both.id } })).toBe(1);
    const stored = await prisma.webhookEvent.findMany({ where: { provider: "resend", providerEventId: { in: svixIds } } });
    expect(stored.length).toBeGreaterThan(0);
    for (const e of stored) expect(JSON.stringify(e.payload)).not.toContain("@");
  });

  it("A8: a bounce marks the row bounced for good: the sweep never re-sends it and the page says so", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    resetEnvCache();
    const o = await ticketOrder("bounce", A);
    await notifications.notificationService.onTicketsReady({ orderId: o.id, orderItemId: o.itemId, documentVersion: 1 });
    const row = (await rowsFor(o.id))[0];
    expect(row.status).toBe("sent");
    const ev = signed({ type: "email.bounced", created_at: new Date().toISOString(), data: { email_id: row.providerId, to: [o.email], bounce: { type: "Permanent" } } });
    expect((await postWebhook(ev.body, ev.headers)).status).toBe(200);
    const after = await prisma.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect([after.status, after.providerError]).toEqual(["failed", notifications.BOUNCED_ERROR]);
    // A later "delivered" for the same message never undoes the bounce.
    const late = signed({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: row.providerId } });
    expect((await postWebhook(late.body, late.headers)).status).toBe(200);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("failed");
    const sweep = await notifications.notificationService.retryFailed(10, new Date(), { ids: [row.id] });
    expect(sweep.scanned).toBe(0);
    expect((await (await status(o.reference, A.cookie)).json()).delivery.state).toBe("bounced");
  });
  it("fix round 1 (M1): a resend asked through the emailed link keeps that link working; the item's other older links still go", async () => {
    const o = await ticketOrder("m1-keep", A);
    await notifications.notificationService.onTicketsReady({ orderId: o.id, orderItemId: o.itemId, documentVersion: 1 });
    const [row] = await rowsFor(o.id);
    const token = TOKEN_IN_LINK.exec(sends.at(-1)!.msg.text)![1];
    // The guest opens the ticket email's link: a `ticket_notification` grant in the access cookie, no customer session.
    const cookie = await exchangeCookie(token);
    const [held] = await grantsFor(o.id);
    expect(held.issuedFor).toBe("ticket_notification");
    // Another older link for the same item (say a forwarded copy) that this browser does not hold.
    const other = await capability.capabilityService.mint(prisma, { orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification", notificationId: row.id, supersede: "after_sent" });
    // Older than the held link (fix round 2, N2: a kept grant spares the links newer than itself).
    await prisma.guestCapabilityGrant.update({ where: { id: other.grantId }, data: { createdAt: new Date(held.createdAt.getTime() - 60_000) } });

    const res = await resend(o.reference, { cookie });
    expect(res.status).toBe(202);
    const after = await grantsFor(o.id);
    expect(after.find((g) => g.id === held.id)?.revokedAt).toBeNull();
    expect(after.find((g) => g.id === other.grantId)?.revokeReason).toBe("superseded");
    const fresh = after.filter((g) => g.id !== held.id && g.id !== other.grantId);
    expect(fresh.map((g) => [g.issuedFor, g.revokedAt])).toEqual([["ticket_notification", null]]);
    // The page the guest pressed the button on still loads, with downloads.
    const body = await (await status(o.reference, cookie)).json();
    expect(body.canDownload).toBe(true);
    expect(body.delivery).toMatchObject({ state: "sent", canResend: false });
    // The kept grant id is all the row carries: no contact data.
    const resendRow = (await rowsFor(o.id)).at(-1)!;
    expect(resendRow.payload).toMatchObject({ resend: "customer", keepGrantId: held.id });
  });

  it("fix round 2 (N2): an older leaked link can resend, but the booker's newer link of the same item stays live", async () => {
    const o = await ticketOrder("n2-newer", A);
    await notifications.notificationService.onTicketsReady({ orderId: o.id, orderItemId: o.itemId, documentVersion: 1 });
    const [row] = await rowsFor(o.id);
    const leakedToken = TOKEN_IN_LINK.exec(sends.at(-1)!.msg.text)![1];
    const [leaked] = await grantsFor(o.id);
    const now = Date.now();
    // The emailed link was forwarded or leaked 10 minutes ago; an even older link of the same item is from 20 minutes ago.
    await prisma.guestCapabilityGrant.update({ where: { id: leaked.id }, data: { createdAt: new Date(now - 10 * 60_000) } });
    const ancient = await capability.capabilityService.mint(prisma, { orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification", notificationId: row.id, supersede: "after_sent" }, new Date(now - 20 * 60_000));
    // The booker's newer link for the same item, from 5 minutes ago (after the leaked one, before the resend).
    const booker = await capability.capabilityService.mint(prisma, { orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification", notificationId: row.id, supersede: "after_sent" }, new Date(now - 5 * 60_000));
    // Whoever holds the leaked link opens it and presses "Email my tickets again".
    const cookie = await exchangeCookie(leakedToken);
    const res = await resend(o.reference, { cookie });
    expect(res.status).toBe(202);

    const after = await grantsFor(o.id);
    expect(after.find((g) => g.id === leaked.id)?.revokedAt).toBeNull();
    expect(after.find((g) => g.id === booker.grantId)?.revokedAt).toBeNull();
    expect(after.find((g) => g.id === ancient.grantId)?.revokeReason).toBe("superseded");
    const fresh = after.filter((g) => ![leaked.id, booker.grantId, ancient.grantId].includes(g.id));
    expect(fresh.map((g) => [g.issuedFor, g.revokedAt])).toEqual([["ticket_notification", null]]);
    // The booker's newer link still opens.
    expect(await exchangeCookie(booker.token)).toMatch(/^outlyy_ticket_access=/);
  });

  it("fix round 2 (N1): the resend route answers 429 before the access check once the per-IP budget is spent", async () => {
    const { POST } = await resendRoute();
    const ip = `198.18.${runOctet}.77`;
    const reference = "OUT-99999998";
    const call = () => POST(apiRequest(`/api/orders/${reference}/tickets/resend`, { method: "POST", headers: { "x-real-ip": ip } }), params({ reference }));
    const { orderAccessService } = await import("@/server/services/order-access.service");
    const spy = vi.spyOn(orderAccessService, "forRequest");
    try {
      for (let i = 0; i < 60; i += 1) expect((await call()).status).toBe(404);
      expect(spy).toHaveBeenCalledTimes(60);
      const res = await call();
      expect(res.status).toBe(429);
      expect(spy).toHaveBeenCalledTimes(60);
    } finally {
      spy.mockRestore();
      await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: "tickets_resend_pre:" } } });
    }
  });

  it("fix round 2 (N3): a redelivery of an event already applied is stored as `reapplied`, not `no_change`", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    resetEnvCache();
    const o = await ticketOrder("n3-reapplied", A);
    await notifications.notificationService.onTicketsReady({ orderId: o.id, orderItemId: o.itemId, documentVersion: 1 });
    const [row] = await rowsFor(o.id);
    const { notificationsRepo } = await import("@/server/repositories/notifications.repo");
    // The first attempt applies the status, then fails to mark the event processed.
    const spy = vi.spyOn(notificationsRepo, "markWebhookProcessed").mockRejectedValueOnce(new Error("synthetic transient database error"));
    try {
      const ev = signed({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: row.providerId } });
      expect((await postWebhook(ev.body, ev.headers)).status).toBe(500);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("delivered");
      expect((await postWebhook(ev.body, ev.headers)).status).toBe(200);
      const stored = await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: "resend", providerEventId: ev.id } } });
      expect([stored.processedAt !== null, stored.processingError]).toEqual([true, "reapplied"]);
      // A first delivery that matches no row is still `no_change`.
      const none = signed({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: `re_none_${run}` } });
      expect((await postWebhook(none.body, none.headers)).status).toBe(200);
      expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: "resend", providerEventId: none.id } } })).processingError).toBe("no_change");
    } finally {
      spy.mockRestore();
    }
  });

  it("fix round 1 (M2): an event whose apply step failed is applied when Svix redelivers it", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    resetEnvCache();
    const o = await ticketOrder("m2-redeliver", A);
    await notifications.notificationService.onTicketsReady({ orderId: o.id, orderItemId: o.itemId, documentVersion: 1 });
    const [row] = await rowsFor(o.id);
    expect(row.status).toBe("sent");
    const { notificationsRepo } = await import("@/server/repositories/notifications.repo");
    const spy = vi.spyOn(notificationsRepo, "applyProviderStatus").mockRejectedValueOnce(new Error("synthetic transient database error"));
    try {
      const ev = signed({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: row.providerId } });
      expect((await postWebhook(ev.body, ev.headers)).status).toBe(500);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("sent");
      const stored = await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: "resend", providerEventId: ev.id } } });
      expect(stored.processedAt).toBeNull();

      // Svix redelivers the same svix-id: applied now, stored once, marked processed.
      expect((await postWebhook(ev.body, ev.headers)).status).toBe(200);
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("delivered");
      expect(await prisma.webhookEvent.count({ where: { provider: "resend", providerEventId: ev.id } })).toBe(1);
      expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: stored.id } })).processedAt).not.toBeNull();
      // A third delivery of a processed event changes nothing.
      expect((await postWebhook(ev.body, ev.headers)).status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("fix round 1 (L7): a complaint is stored but never marks a row delivered", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    resetEnvCache();
    const o = await ticketOrder("l7-complaint", A);
    await notifications.notificationService.onTicketsReady({ orderId: o.id, orderItemId: o.itemId, documentVersion: 1 });
    const [row] = await rowsFor(o.id);
    const ev = signed({ type: "email.complained", created_at: new Date().toISOString(), data: { email_id: row.providerId } });
    expect((await postWebhook(ev.body, ev.headers)).status).toBe(200);
    expect(await prisma.webhookEvent.count({ where: { provider: "resend", providerEventId: ev.id } })).toBe(1);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("sent");
  });
  it("fix round 1 (L3): a link whose message payload was cleared is still replaced by the item's next ticket email", async () => {
    const o = await ticketOrder("l3-erased", A);
    await notifications.notificationService.onTicketsReady({ orderId: o.id, orderItemId: o.itemId, documentVersion: 1 });
    const [row] = await rowsFor(o.id);
    const [g1] = await grantsFor(o.id);
    // What an erasure for a contact matched by recipient does to a row of an order that is kept.
    const { Prisma: P } = await import("@prisma/client");
    await prisma.notification.update({ where: { id: row.id }, data: { payload: P.DbNull } });
    await notifications.notificationService.onTicketsReady({ orderId: o.id, orderItemId: o.itemId, documentVersion: 2 });
    const after = await grantsFor(o.id);
    expect(after.find((g) => g.id === g1.id)?.revokeReason).toBe("superseded");
    expect(after.filter((g) => g.revokedAt === null)).toHaveLength(1);
  });

  it("fix round 1 (L5): a staff resend is audited even when a later item throws", async () => {
    const o = await ticketOrder("l5-audit", A, 1);
    const real = prisma.notification.createMany.bind(prisma.notification);
    let calls = 0;
    const spy = vi.spyOn(prisma.notification, "createMany").mockImplementation(((args: never) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error("synthetic insert failure"));
      return real(args);
    }) as never);
    try {
      await expect(notifications.notificationService.resendTickets(opsActor(), { orderId: o.id })).rejects.toThrow("synthetic insert failure");
    } finally {
      spy.mockRestore();
    }
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "tickets.resend", entityId: o.id } });
    const after = audit.after as { outcome: string; notificationId: string | null; items: { outcome: string; notificationId: string | null }[] };
    expect(after.outcome).toBe("error");
    expect(after.items.map((i) => i.outcome)).toEqual(["sent", "error"]);
    expect(after.items[0].notificationId).not.toBeNull();
    expect(after.items[1].notificationId).toBeNull();
    expect(after.notificationId).toBe(after.items[0].notificationId);
  });
  it("fix round 1 (L8): the masked address is the one the newest ticket message went to", async () => {
    const o = await ticketOrder("l8-recipient", A);
    await notifications.notificationService.onTicketsReady({ orderId: o.id, orderItemId: o.itemId, documentVersion: 1 });
    // A later change of the order's email (no such path today) must not make "sent to" name an address that got nothing.
    await prisma.order.update({ where: { id: o.id }, data: { leadEmail: `qq-sec-${run}-changed@outlyy.test` } });
    const res = await status(o.reference, A.cookie);
    const text = await res.clone().text();
    expect((await res.json()).delivery.recipientMasked).toBe("z•••@outlyy.test");
    expect(text).not.toContain(o.email);
  });
});
