import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { assertDisposableDb, cleanupPeople, createStaff, dbEnabled, runId, syntheticPhone, type StaffFixture } from "@/server/__tests__/helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, makeInquiry, makeOrder, publishedProduct, type SeedProduct } from "@/server/__tests__/security/_mercury-fixtures";
import { uuidv7 } from "@/server/lib/ids";
import { resetEnvCache } from "@/server/lib/env";
import { ROLE_PERMISSIONS, type RoleCode } from "@/server/lib/permissions";
import type { Actor } from "@/server/lib/actor";
import type { EmailOutcome, EmailSend, EmailSendOptions } from "@/server/notifications/email.adapter";

/**
 * Notification outbox against the disposable database (TKT-6, doc 22 §26
 * F14): row before send, dedup, the provider idempotency key, crash after
 * send, `unknown` reconciliation and the 24-hour attention cut-off, and
 * ticket messages rendered at send time with a fresh capability.
 *
 * The provider is a fake that behaves like Resend's idempotency: the same
 * key with the same body is one email; the same key with another body is a
 * 409. "Delivered" counts distinct keys the fake accepted.
 */

const run = runId();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TOKEN_IN_LINK = /\/t#([A-Za-z0-9_-]{43})\b/;

type Prisma = Awaited<ReturnType<typeof db>>;
let prisma: Prisma;
let product: SeedProduct;
let notifications: typeof import("@/server/services/notification.service");
let capability: typeof import("@/server/services/capability.service");
let ops: StaffFixture;
let agent: StaffFixture;
const orderIds: string[] = [];
const itemOf = new Map<string, string>();
const savedEnv = { ...process.env };

interface Call {
  key: string;
  msg: EmailSend;
}
const provider = {
  calls: [] as Call[],
  accepted: new Map<string, string>(),
  /** Scripted answers, in order. `deliver`: the provider really accepted it (an `unknown` that went out). */
  script: [] as { outcome: EmailOutcome; deliver?: boolean }[],
  reset() {
    this.calls = [];
    this.accepted.clear();
    this.script = [];
  },
  callsFor(key: string) {
    return this.calls.filter((c) => c.key === key);
  },
};

async function fakeSend(msg: EmailSend, opts?: EmailSendOptions): Promise<EmailOutcome> {
  const key = opts?.idempotencyKey ?? "missing";
  provider.calls.push({ key, msg });
  const body = JSON.stringify(msg);
  const scripted = provider.script.shift();
  if (scripted) {
    if (scripted.deliver && !provider.accepted.has(key)) provider.accepted.set(key, body);
    return scripted.outcome;
  }
  const prior = provider.accepted.get(key);
  if (prior !== undefined && prior !== body) return { kind: "unknown", httpStatus: 409, reason: "conflict" };
  provider.accepted.set(key, body);
  return { kind: "sent", providerId: `fake-${key}` };
}

function actorOf(staff: StaffFixture, role: RoleCode): Actor {
  return { type: "admin", id: staff.id, roles: [role], permissions: new Set(ROLE_PERMISSIONS[role]) };
}

async function ticketOrder(label: string) {
  const o = await makeOrder(run, { leadPhone: syntheticPhone(run, 30 + orderIds.length), label });
  const itemId = uuidv7();
  await prisma.orderItem.create({
    data: {
      id: itemId,
      orderId: o.id,
      productId: product.id,
      titleSnapshot: `zz-sec-${run} Desert Safari`,
      tierSnapshot: product.tier,
      slugSnapshot: product.slug,
      kindSnapshot: "activity",
      confirmationSnapshot: "instant",
      fulfilmentModeSnapshot: "instant",
      freeCancellationHoursSnapshot: 24,
      durationMinutesSnapshot: 60,
      serviceDate: new Date("2030-01-15T00:00:00.000Z"),
      pax: { adult: 2 },
      unitInr: 1_000n,
      unitAed: 45n,
      totalInr: 2_000n,
      totalAed: 90n,
    },
  });
  orderIds.push(o.id);
  itemOf.set(o.id, itemId);
  const lead = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, select: { leadEmail: true, leadName: true, leadPhone: true } });
  return { ...o, itemId, ref: { orderId: o.id, orderItemId: itemId, documentVersion: 1 }, lead };
}

function tokenOf(c: Call): string {
  const m = TOKEN_IN_LINK.exec(c.msg.text);
  if (!m) throw new Error("no ticket link in the message");
  return m[1];
}

describe.skipIf(!dbEnabled)("notification outbox (TKT-6)", () => {
  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    process.env.NOTIFICATION_RECIPIENT_ALLOWLIST = "@outlyy.test";
    delete process.env.RESEND_API_KEY;
    resetEnvCache();
    prisma = await db();
    product = await publishedProduct();
    notifications = await import("@/server/services/notification.service");
    capability = await import("@/server/services/capability.service");
    const { emailAdapter } = await import("@/server/notifications/email.adapter");
    vi.spyOn(emailAdapter, "send").mockImplementation(fakeSend as never);
    const { documentService } = await import("@/server/services/document.service");
    vi.spyOn(documentService, "listForOrder").mockImplementation(async (orderId: string) => [
      {
        orderItemId: itemOf.get(orderId) ?? uuidv7(),
        fulfilment: "issued",
        documents: [
          { id: uuidv7(), kind: "tickets_pdf", version: 1, status: "superseded", contentType: "application/pdf", byteSize: 10, createdAt: new Date().toISOString() },
          { id: uuidv7(), kind: "tickets_pdf", version: 2, status: "valid", contentType: "application/pdf", byteSize: 12, createdAt: new Date().toISOString() },
        ],
      },
    ]);
    ops = await createStaff(run, "outbox-ops", ["ops"]);
    agent = await createStaff(run, "outbox-agent", ["agent"]);
  });

  afterEach(() => {
    provider.reset();
    notifications?.setOutboxFaultForTests(null);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...savedEnv };
    resetEnvCache();
    if (!prisma) return;
    await prisma.guestCapabilityGrant.deleteMany({ where: { orderId: { in: orderIds } } });
    await cleanupBusinessRows(run);
    await cleanupPeople(run);
  });

  it("onTicketsReady: row first, one send keyed by the row id, ids-only payload, token only in the message", async () => {
    const o = await ticketOrder("ready");
    const r = await notifications.notificationService.onTicketsReady(o.ref);
    expect(r?.outcome).toBe("sent");
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: r!.id } });
    expect(row.status).toBe("sent");
    expect(row.event).toBe("TICKETS_READY");
    expect(row.recipient).toBe(o.lead.leadEmail);
    expect(row.payload).toEqual({ kind: "ticket_message", ...o.ref });
    expect(row.dedupKey).not.toContain(o.lead.leadEmail!);
    expect(row.lockedUntil).toBeNull();

    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0];
    expect(call.key).toBe(row.id);
    const token = tokenOf(call);
    expect(call.msg.html).toContain(`/t#${token}`);
    expect(call.msg.text).not.toMatch(/Guid=|downloadcode|supabase|storage/i);

    const grant = await prisma.guestCapabilityGrant.findFirstOrThrow({ where: { notificationId: row.id } });
    expect(grant).toMatchObject({ orderId: o.id, purpose: "download_tickets", issuedFor: "ticket_notification", tokenHash: sha(token) });
    expect(grant.tokenCiphertext, "outcome known: the kept token is dropped").toBeNull();
    // The token is stored nowhere: not in the grant, not in the notification row.
    expect(JSON.stringify(grant)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row.payload)).not.toContain(o.lead.leadName);
    expect(JSON.stringify(row.payload)).not.toContain(o.lead.leadPhone);
    // And it works.
    expect((await capability.capabilityService.exchange(token)).ok).toBe(true);
  });

  it("duplicate dispatch: one row, one send (sequential and concurrent)", async () => {
    const o = await ticketOrder("dup");
    const first = await notifications.notificationService.onTicketsReady(o.ref);
    const again = await notifications.notificationService.onTicketsReady(o.ref);
    expect(again).toMatchObject({ id: first!.id, duplicate: true, outcome: "sent" });
    expect(provider.calls).toHaveLength(1);

    const o2 = await ticketOrder("dup-race");
    const raced = await Promise.all([1, 2, 3].map(() => notifications.notificationService.onTicketsReady(o2.ref)));
    expect(new Set(raced.map((r) => r!.id)).size).toBe(1);
    expect(raced.filter((r) => r!.duplicate)).toHaveLength(2);
    expect(provider.calls.filter((c) => c.key === raced[0]!.id)).toHaveLength(1);
    expect(await prisma.notification.count({ where: { orderId: o2.id } })).toBe(1);

    // A new document version is a new message.
    const v2 = await notifications.notificationService.onTicketsReady({ ...o.ref, documentVersion: 2 });
    expect(v2?.duplicate).toBeUndefined();
    expect(v2?.id).not.toBe(first!.id);
  });

  it("crash after send: the row stays non-final, the retry reuses the key and body, one email in total", async () => {
    const o = await ticketOrder("crash");
    notifications.setOutboxFaultForTests(() => {
      throw new Error("database write failed after send (test)");
    });
    const r = await notifications.notificationService.onTicketsReady(o.ref);
    notifications.setOutboxFaultForTests(null);
    expect(r?.outcome).toBe("queued");
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: r!.id } });
    expect(row.status).toBe("queued");
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    const grant = await prisma.guestCapabilityGrant.findFirstOrThrow({ where: { notificationId: row.id } });
    expect(grant.tokenCiphertext).toMatch(/^v2\.capability_tokens\./);

    // While the claim holds, the sweep leaves it alone.
    expect((await notifications.notificationService.retryFailed(50, new Date(), { ids: [row.id] })).scanned).toBe(0);

    const later = new Date(Date.now() + 3 * 60_000);
    const sweep = await notifications.notificationService.retryFailed(50, later, { ids: [row.id] });
    expect(sweep.retried).toBe(1);
    const calls = provider.callsFor(row.id);
    expect(calls).toHaveLength(2);
    expect(calls[1].msg).toEqual(calls[0].msg);
    expect(tokenOf(calls[1])).toBe(tokenOf(calls[0]));
    expect(provider.accepted.size).toBe(1);
    const after = await prisma.notification.findUniqueOrThrow({ where: { id: row.id } });
    expect(after).toMatchObject({ status: "sent", attempt: 2, lockedUntil: null });
    expect((await prisma.guestCapabilityGrant.findUniqueOrThrow({ where: { id: grant.id } })).tokenCiphertext).toBeNull();
    // Still exactly one grant for the row.
    expect(await prisma.guestCapabilityGrant.count({ where: { notificationId: row.id } })).toBe(1);
  });

  it("unknown within the window: re-sent under the same key with the same body", async () => {
    const o = await ticketOrder("unknown");
    provider.script.push({ outcome: { kind: "unknown", httpStatus: null, reason: "timeout" }, deliver: true });
    const r = await notifications.notificationService.onTicketsReady(o.ref);
    expect(r).toMatchObject({ outcome: "unknown", status: "failed", error: "outcome_unknown" });
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: r!.id } });
    expect(row).toMatchObject({ status: "unknown", providerError: "unknown:timeout", lockedUntil: null });

    const sweep = await notifications.notificationService.retryFailed(50, new Date(), { ids: [row.id] });
    expect(sweep.retried).toBe(1);
    const calls = provider.callsFor(row.id);
    expect(calls).toHaveLength(2);
    expect(calls[1].msg).toEqual(calls[0].msg);
    expect(provider.accepted.size).toBe(1);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("sent");
  });

  it("unknown past 24 hours: attention, no send, the kept token dropped", async () => {
    const o = await ticketOrder("stale");
    provider.script.push({ outcome: { kind: "unknown", httpStatus: 503, reason: "server_error" } });
    const r = await notifications.notificationService.onTicketsReady(o.ref);
    expect(r?.outcome).toBe("unknown");
    await prisma.notification.update({ where: { id: r!.id }, data: { createdAt: new Date(Date.now() - 25 * 3600_000) } });
    const before = provider.calls.length;

    const sweep = await notifications.notificationService.retryFailed(50, new Date(), { ids: [r!.id] });
    expect(sweep).toMatchObject({ attention: 1, retried: 0 });
    expect(provider.calls.length).toBe(before);
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: r!.id } });
    expect(row.status).toBe("unknown");
    expect(row.attentionRequiredAt).not.toBeNull();
    const grant = await prisma.guestCapabilityGrant.findFirstOrThrow({ where: { notificationId: row.id } });
    expect(grant.tokenCiphertext).toBeNull();
    // Flagged rows are not picked up again.
    expect((await notifications.notificationService.retryFailed(50, new Date(), { ids: [row.id] })).scanned).toBe(0);
  });

  it("a stale queued row past the window also goes to attention without a send", async () => {
    const o = await ticketOrder("stale-queued");
    notifications.setOutboxFaultForTests(() => {
      throw new Error("crash (test)");
    });
    const r = await notifications.notificationService.onTicketsReady(o.ref);
    notifications.setOutboxFaultForTests(null);
    await prisma.notification.update({ where: { id: r!.id }, data: { createdAt: new Date(Date.now() - 25 * 3600_000), lockedUntil: new Date(Date.now() - 60_000) } });
    const before = provider.calls.length;
    expect((await notifications.notificationService.retryFailed(50, new Date(), { ids: [r!.id] })).attention).toBe(1);
    expect(provider.calls.length).toBe(before);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: r!.id } })).attentionRequiredAt).not.toBeNull();
  });

  it("429 is retried with the same body; a definite 422 is final and drops the kept token", async () => {
    const o = await ticketOrder("429");
    provider.script.push({ outcome: { kind: "failed", retryable: true, httpStatus: 429, reason: "rate_limited" } });
    const r = await notifications.notificationService.onTicketsReady(o.ref);
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: r!.id } });
    expect(row).toMatchObject({ status: "failed", providerError: "retryable:http_429" });
    expect((await prisma.guestCapabilityGrant.findFirstOrThrow({ where: { notificationId: row.id } })).tokenCiphertext).not.toBeNull();
    expect((await notifications.notificationService.retryFailed(50, new Date(), { ids: [row.id] })).retried).toBe(1);
    const calls = provider.callsFor(row.id);
    expect(calls[1].msg).toEqual(calls[0].msg);

    const o2 = await ticketOrder("422");
    provider.script.push({ outcome: { kind: "failed", retryable: false, httpStatus: 422, reason: "rejected" } });
    const r2 = await notifications.notificationService.onTicketsReady(o2.ref);
    const row2 = await prisma.notification.findUniqueOrThrow({ where: { id: r2!.id } });
    expect(row2).toMatchObject({ status: "failed", providerError: "definite:http_422" });
    expect((await prisma.guestCapabilityGrant.findFirstOrThrow({ where: { notificationId: row2.id } })).tokenCiphertext).toBeNull();
    expect((await notifications.notificationService.retryFailed(50, new Date(), { ids: [row2.id] })).scanned).toBe(0);
  });

  it("staff resend: tickets.resend required; a new row and capability; the previous link is revoked", async () => {
    const o = await ticketOrder("resend");
    const first = await notifications.notificationService.onTicketsReady(o.ref);
    const oldToken = tokenOf(provider.callsFor(first!.id)[0]);

    await expect(notifications.notificationService.resendTickets(actorOf(agent, "agent"), { orderId: o.id })).rejects.toMatchObject({ status: 403 });
    // The generic console resend of a ticket row is routed to the ticket resend, with its permission.
    await expect(notifications.notificationService.resend(actorOf(agent, "agent"), first!.id)).rejects.toMatchObject({ status: 403 });

    const again = await notifications.notificationService.resendTickets(actorOf(ops, "ops"), { orderReference: o.reference });
    expect(again.outcome).toBe("sent");
    expect(again.id).not.toBe(first!.id);
    const row = await prisma.notification.findUniqueOrThrow({ where: { id: again.id } });
    expect(row.dedupKey).toContain("|resend:");
    // A4: the row says who asked for the resend, so its link gets the staff (order-wide) supersede scope.
    expect(row.payload).toEqual({ kind: "ticket_message", orderId: o.id, orderItemId: o.itemId, documentVersion: 2, resend: "staff" });
    const newToken = tokenOf(provider.callsFor(again.id)[0]);
    expect(newToken).not.toBe(oldToken);
    const grants = await prisma.guestCapabilityGrant.findMany({ where: { orderId: o.id }, orderBy: { createdAt: "asc" } });
    expect(grants.map((g) => [g.issuedFor, g.revokeReason])).toEqual([
      ["ticket_notification", "superseded"],
      ["staff_resend", null],
    ]);
    expect((await capability.capabilityService.exchange(oldToken)).ok).toBe(false);
    expect((await capability.capabilityService.exchange(newToken)).ok).toBe(true);

    const auditRow = await prisma.auditLog.findFirstOrThrow({ where: { action: "tickets.resend", entityId: o.id } });
    const auditText = JSON.stringify(auditRow, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(auditText).not.toContain(o.lead.leadEmail!);
    expect(auditText).not.toContain(newToken);
    expect(auditRow.after).toMatchObject({ notificationId: again.id, recipientField: "orders.lead_email" });

    // Through the console resend too: another new row.
    const viaConsole = await notifications.notificationService.resend(actorOf(ops, "ops"), first!.id);
    expect(viaConsole.id).not.toBe(again.id);
  });

  it("no lead email: no message; a recipient off the allowlist: suppressed, no capability, no send", async () => {
    const none = await ticketOrder("no-email");
    await prisma.order.update({ where: { id: none.id }, data: { leadEmail: null } });
    expect(await notifications.notificationService.onTicketsReady(none.ref)).toBeNull();
    expect(await prisma.notification.count({ where: { orderId: none.id } })).toBe(0);
    await expect(notifications.notificationService.resendTickets(actorOf(ops, "ops"), { orderId: none.id })).rejects.toMatchObject({ status: 409 });

    const off = await ticketOrder("off-list");
    await prisma.order.update({ where: { id: off.id }, data: { leadEmail: `zz-sec-${run}@example.com` } });
    const r = await notifications.notificationService.onTicketsReady(off.ref);
    expect(r?.outcome).toBe("suppressed");
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: r!.id } })).suppressedReason).toBe("non_production_allowlist");
    expect(await prisma.guestCapabilityGrant.count({ where: { orderId: off.id } })).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("without the lookup ring an inquiry message still goes out, undeduplicated, with an alert (R-B4-3)", async () => {
    const { setKeyRingsForTests } = await import("@/server/lib/crypto");
    const inquiry = await makeInquiry(run, { leadPhone: syntheticPhone(run, 91), product, label: "outbox-nokey" });
    const { inquiryRepo } = await import("@/server/repositories/inquiry.repo");
    const detail = (await inquiryRepo.findById(inquiry.id))!;
    const context = notifications.buildContext({ inquiry: detail, agent: { id: "team", name: "Team Member", initials: "TM", role: "Specialist", languages: ["English"], shift: "IST" }, deadline: new Date(), deadlineLabel: "5 pm", outOfHours: false });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    setKeyRingsForTests({ lookup: null });
    try {
      const r = await notifications.notificationService.dispatch({ event: "INQUIRY_WON", channel: "email", recipient: detail.leadEmail!, inquiryId: inquiry.id, context, once: "won:nokey" });
      expect(r.outcome).toBe("sent");
      expect((await prisma.notification.findUniqueOrThrow({ where: { id: r.id } })).dedupKey).toBeNull();
      expect(errors.mock.calls.some((c) => String(c[0]).includes("keys.unavailable"))).toBe(true);
    } finally {
      setKeyRingsForTests(null);
      errors.mockRestore();
    }
  });

  it("inquiry triggers: scoped messages dedupe, distinct stages and resends do not", async () => {
    const inquiry = await makeInquiry(run, { leadPhone: syntheticPhone(run, 90), product, label: "outbox-inq" });
    const { inquiryRepo } = await import("@/server/repositories/inquiry.repo");
    const detail = (await inquiryRepo.findById(inquiry.id))!;
    const context = notifications.buildContext({ inquiry: detail, agent: { id: "team", name: "Team Member", initials: "TM", role: "Specialist", languages: ["English"], shift: "IST" }, deadline: new Date(), deadlineLabel: "5 pm", outOfHours: false });
    const recipient = detail.leadEmail!;
    const base = { event: "INQUIRY_WON" as const, channel: "email" as const, recipient, inquiryId: inquiry.id, context };

    const won1 = await notifications.notificationService.dispatch({ ...base, once: "won:OUT-1" });
    const won2 = await notifications.notificationService.dispatch({ ...base, once: "won:OUT-1" });
    expect(won2).toMatchObject({ id: won1.id, duplicate: true });
    const won3 = await notifications.notificationService.dispatch({ ...base, once: "won:OUT-2" });
    expect(won3.duplicate).toBeUndefined();

    // Unscoped dispatches (e.g. the deletion-request alert) are each their own message.
    const a = await notifications.notificationService.dispatch({ ...base });
    const b = await notifications.notificationService.dispatch({ ...base });
    expect(a.id).not.toBe(b.id);

    const f1 = await notifications.notificationService.onFollowupDue({ inquiry: detail, stage: 1 });
    const f2 = await notifications.notificationService.onFollowupDue({ inquiry: detail, stage: 2 });
    const f1Again = await notifications.notificationService.onFollowupDue({ inquiry: detail, stage: 1 });
    expect(f1[0].id).not.toBe(f2[0].id);
    expect(f1Again[0]).toMatchObject({ id: f1[0].id, duplicate: true });
    // The ladder restarts after a contact: stage 1 again is a new message.
    const recontacted = { ...detail, lastContactAt: new Date(Date.now() + 1000).toISOString() };
    const f1New = await notifications.notificationService.onFollowupDue({ inquiry: recontacted, stage: 1 });
    expect(f1New[0].id).not.toBe(f1[0].id);

    const resent = await notifications.notificationService.resend(actorOf(ops, "ops"), won1.id);
    expect(resent.id).not.toBe(won1.id);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: resent.id } })).dedupKey).toContain("|resend:");

    // Every inquiry email went out under its own row id (WhatsApp rows are off the email allowlist).
    const rows = await prisma.notification.findMany({ where: { inquiryId: inquiry.id } });
    for (const row of rows) expect(provider.callsFor(row.id).length).toBe(row.status === "sent" ? 1 : 0);
    expect(rows.filter((r) => r.channel === "email").every((r) => r.status === "sent")).toBe(true);
    expect(rows.filter((r) => r.channel !== "email").every((r) => r.status === "suppressed")).toBe(true);
  });
});
