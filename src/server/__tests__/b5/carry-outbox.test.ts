import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { assertDisposableDb, cleanupPeople, createStaff, dbEnabled, runId, syntheticPhone, type StaffFixture } from "@/server/__tests__/helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, makeInquiry, makeOrder, publishedProduct, type SeedProduct } from "@/server/__tests__/security/_mercury-fixtures";
import { uuidv7 } from "@/server/lib/ids";
import { resetEnvCache } from "@/server/lib/env";
import { ROLE_PERMISSIONS } from "@/server/lib/permissions";
import type { Actor } from "@/server/lib/actor";
import type { EmailOutcome, EmailSend, EmailSendOptions } from "@/server/notifications/email.adapter";

/**
 * B4 carry-overs on the notification outbox (doc 22 §32.9), against the
 * disposable database:
 *
 *  - R-B4-4: a ticket message's new link supersedes the order's previous one
 *    only once the new message is `sent`. A rejected or unknown resend
 *    leaves the old link working; the retry that reaches `sent` revokes it.
 *  - R-B4-10: dedup keys stay stable across a `lookup` key rotation: a row
 *    built under an older ring key is the same message.
 *  - WhatsApp: no provider idempotency key, so an ambiguous send is never
 *    re-sent automatically.
 *
 * The email provider is a fake keyed like Resend (same key and body = one
 * email). Synthetic rows only (`zz-sec-<run>`).
 */

const run = runId();
const TOKEN_IN_LINK = /\/t#([A-Za-z0-9_-]{43})\b/;
const ringKey = () => randomBytes(32).toString("base64");

type Prisma = Awaited<ReturnType<typeof db>>;
let prisma: Prisma;
let product: SeedProduct;
let notifications: typeof import("@/server/services/notification.service");
let capability: typeof import("@/server/services/capability.service");
let crypto: typeof import("@/server/lib/crypto");
let whatsapp: typeof import("@/server/notifications/whatsapp.adapter");
let ops: StaffFixture;
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
  script: [] as EmailOutcome[],
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
  const scripted = provider.script.shift();
  if (scripted) return scripted;
  provider.accepted.set(key, JSON.stringify(msg));
  return { kind: "sent", providerId: `fake-${key}` };
}

function tokenOf(c: Call): string {
  const m = TOKEN_IN_LINK.exec(c.msg.text);
  if (!m) throw new Error("no ticket link in the message");
  return m[1];
}

const opsActor = (): Actor => ({ type: "admin", id: ops.id, roles: ["ops"], permissions: new Set(ROLE_PERMISSIONS.ops) });

async function ticketOrder(label: string) {
  const o = await makeOrder(run, { leadPhone: syntheticPhone(run, 40 + orderIds.length), label });
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
  return { ...o, itemId, ref: { orderId: o.id, orderItemId: itemId, documentVersion: 1 } };
}

/** First email, then the token it carried. */
async function firstLink(o: Awaited<ReturnType<typeof ticketOrder>>) {
  const first = await notifications.notificationService.onTicketsReady(o.ref);
  expect(first?.outcome).toBe("sent");
  return { first: first!, token: tokenOf(provider.callsFor(first!.id)[0]) };
}

describe.skipIf(!dbEnabled)("B5 carry-overs: notification outbox (R-B4-4, R-B4-10, WhatsApp)", () => {
  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    process.env.NOTIFICATION_RECIPIENT_ALLOWLIST = "@outlyy.test,+97150";
    delete process.env.RESEND_API_KEY;
    process.env.WHATSAPP_PROVIDER = "log";
    resetEnvCache();
    prisma = await db();
    product = await publishedProduct();
    notifications = await import("@/server/services/notification.service");
    capability = await import("@/server/services/capability.service");
    crypto = await import("@/server/lib/crypto");
    whatsapp = await import("@/server/notifications/whatsapp.adapter");
    const { emailAdapter } = await import("@/server/notifications/email.adapter");
    vi.spyOn(emailAdapter, "send").mockImplementation(fakeSend as never);
    const { documentService } = await import("@/server/services/document.service");
    vi.spyOn(documentService, "listForOrder").mockImplementation(async (orderId: string) => [
      {
        orderItemId: itemOf.get(orderId) ?? uuidv7(),
        fulfilment: "issued",
        documents: [{ id: uuidv7(), kind: "tickets_pdf", version: 1, status: "valid", contentType: "application/pdf", byteSize: 12, createdAt: new Date().toISOString() }],
      },
    ]);
    ops = await createStaff(run, "carry-ops", ["ops"]);
  });

  afterEach(() => {
    provider.reset();
    crypto?.setKeyRingsForTests(null);
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

  describe("R-B4-4: supersede only after sent", () => {
    it("the provider rejects a staff resend: the old link still exchanges, nothing is superseded", async () => {
      const o = await ticketOrder("reject");
      const { token: oldToken } = await firstLink(o);
      provider.script.push({ kind: "failed", retryable: false, httpStatus: 422, reason: "rejected" });
      const resend = await notifications.notificationService.resendTickets(opsActor(), { orderId: o.id });
      expect(resend.outcome).toBe("failed");
      const grants = await prisma.guestCapabilityGrant.findMany({ where: { orderId: o.id }, orderBy: { createdAt: "asc" } });
      expect(grants.map((g) => g.revokedAt)).toEqual([null, null]);
      expect((await capability.capabilityService.exchange(oldToken)).ok).toBe(true);
    });

    it("an unknown resend leaves the old link live; the retry that is sent revokes it", async () => {
      const o = await ticketOrder("unknown");
      const { token: oldToken } = await firstLink(o);
      provider.script.push({ kind: "unknown", httpStatus: null, reason: "timeout" });
      const resend = await notifications.notificationService.resendTickets(opsActor(), { orderId: o.id });
      expect(resend.outcome).toBe("unknown");
      expect((await capability.capabilityService.exchange(oldToken)).ok).toBe(true);

      const sweep = await notifications.notificationService.retryFailed(50, new Date(), { ids: [resend.id] });
      expect(sweep.retried).toBe(1);
      const calls = provider.callsFor(resend.id);
      expect(calls).toHaveLength(2);
      expect(calls[1].msg).toEqual(calls[0].msg);
      const newToken = tokenOf(calls[1]);
      expect((await capability.capabilityService.exchange(oldToken)).ok).toBe(false);
      expect((await capability.capabilityService.exchange(newToken)).ok).toBe(true);
      const grants = await prisma.guestCapabilityGrant.findMany({ where: { orderId: o.id }, orderBy: { createdAt: "asc" } });
      expect(grants.map((g) => [g.issuedFor, g.revokeReason])).toEqual([
        ["ticket_notification", "superseded"],
        ["staff_resend", null],
      ]);
    });

    it("a crash after a sent resend: the old link stays until the sweep records sent, then it is revoked", async () => {
      const o = await ticketOrder("crash");
      const { token: oldToken } = await firstLink(o);
      notifications.setOutboxFaultForTests(() => {
        throw new Error("database write failed after send (test)");
      });
      const resend = await notifications.notificationService.resendTickets(opsActor(), { orderId: o.id });
      notifications.setOutboxFaultForTests(null);
      expect(resend.outcome).toBe("queued");
      expect((await capability.capabilityService.exchange(oldToken)).ok).toBe(true);
      const sweep = await notifications.notificationService.retryFailed(50, new Date(Date.now() + 3 * 60_000), { ids: [resend.id] });
      expect(sweep.retried).toBe(1);
      expect((await capability.capabilityService.exchange(oldToken)).ok).toBe(false);
    });

    it("a sent resend revokes the old link at once", async () => {
      const o = await ticketOrder("sent");
      const { token: oldToken } = await firstLink(o);
      const resend = await notifications.notificationService.resendTickets(opsActor(), { orderId: o.id });
      expect(resend.outcome).toBe("sent");
      expect((await capability.capabilityService.exchange(oldToken)).ok).toBe(false);
      expect((await capability.capabilityService.exchange(tokenOf(provider.callsFor(resend.id)[0]))).ok).toBe(true);
    });
  });

  describe("R-B4-10: dedup across a lookup key rotation", () => {
    it("a ticket message written under the old key is a duplicate under the rotated ring; no second email", async () => {
      const old = `old:${ringKey()}`;
      const o = await ticketOrder("rotate");
      crypto.setKeyRingsForTests({ lookup: old });
      const first = await notifications.notificationService.onTicketsReady(o.ref);
      expect(first?.outcome).toBe("sent");

      crypto.setKeyRingsForTests({ lookup: `new:${ringKey()},${old}` });
      const again = await notifications.notificationService.onTicketsReady(o.ref);
      expect(again).toMatchObject({ id: first!.id, duplicate: true, outcome: "sent" });
      expect(provider.calls).toHaveLength(1);
      expect(await prisma.notification.count({ where: { orderId: o.id } })).toBe(1);

      // A new document version is still a new message, keyed under the new active key.
      const v2 = await notifications.notificationService.onTicketsReady({ ...o.ref, documentVersion: 2 });
      expect(v2?.duplicate).toBeUndefined();
      const row = await prisma.notification.findUniqueOrThrow({ where: { id: v2!.id } });
      expect(row.dedupKey).toContain(`|r:${crypto.hmacFor("lookup", row.recipient.trim().toLowerCase())}|`);
    });

    it("a scoped inquiry message is stable across the rotation too", async () => {
      const old = `old:${ringKey()}`;
      const inquiry = await makeInquiry(run, { leadPhone: syntheticPhone(run, 92), product, label: "carry-rotate" });
      const { inquiryRepo } = await import("@/server/repositories/inquiry.repo");
      const detail = (await inquiryRepo.findById(inquiry.id))!;
      const context = notifications.buildContext({ inquiry: detail, agent: { id: "team", name: "Team Member", initials: "TM", role: "Specialist", languages: ["English"], shift: "IST" }, deadline: new Date(), deadlineLabel: "5 pm", outOfHours: false });
      const base = { event: "INQUIRY_WON" as const, channel: "email" as const, recipient: detail.leadEmail!, inquiryId: inquiry.id, context, once: "won:ROTATE" };
      crypto.setKeyRingsForTests({ lookup: old });
      const first = await notifications.notificationService.dispatch(base);
      crypto.setKeyRingsForTests({ lookup: `new:${ringKey()},${old}` });
      const again = await notifications.notificationService.dispatch(base);
      expect(again).toMatchObject({ id: first.id, duplicate: true });
      expect(provider.callsFor(first.id)).toHaveLength(1);
      // Unscoped messages stay distinct.
      const a = await notifications.notificationService.dispatch({ ...base, once: undefined });
      expect(a.id).not.toBe(first.id);
    });
  });

  describe("WhatsApp: no provider idempotency key", () => {
    async function whatsappInquiry(n: number) {
      const inquiry = await makeInquiry(run, { leadPhone: `+97150${String(n).padStart(7, "0")}`, product, label: `carry-wa-${n}` });
      const { inquiryRepo } = await import("@/server/repositories/inquiry.repo");
      const detail = (await inquiryRepo.findById(inquiry.id))!;
      const context = notifications.buildContext({ inquiry: detail, agent: { id: "team", name: "Team Member", initials: "TM", role: "Specialist", languages: ["English"], shift: "IST" }, deadline: new Date(), deadlineLabel: "5 pm", outOfHours: false });
      return { event: "INQUIRY_ACK" as const, channel: "whatsapp" as const, recipient: detail.leadPhone, inquiryId: inquiry.id, context, once: `wa:${n}` };
    }

    it("an unknown send is recorded as unknown and goes to attention without a second send", async () => {
      const input = await whatsappInquiry(Number.parseInt(run.slice(-4), 16) % 9_000_000);
      const send = vi.spyOn(whatsapp.whatsappAdapter, "send").mockRejectedValue(new whatsapp.WhatsAppSendError({ kind: "unknown", httpStatus: null, reason: "timeout" }));
      try {
        const r = await notifications.notificationService.dispatch(input);
        expect(r.outcome).toBe("unknown");
        expect(await prisma.notification.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: "unknown", providerError: "unknown:timeout" });
        const sweep = await notifications.notificationService.retryFailed(50, new Date(), { ids: [r.id] });
        expect(sweep).toMatchObject({ attention: 1, retried: 0 });
        expect(send).toHaveBeenCalledTimes(1);
        expect((await prisma.notification.findUniqueOrThrow({ where: { id: r.id } })).attentionRequiredAt).not.toBeNull();
      } finally {
        send.mockRestore();
      }
    });

    it("a definite retryable failure (429) is retried in place", async () => {
      const input = await whatsappInquiry((Number.parseInt(run.slice(-4), 16) % 9_000_000) + 1);
      const send = vi
        .spyOn(whatsapp.whatsappAdapter, "send")
        .mockRejectedValueOnce(new whatsapp.WhatsAppSendError({ kind: "failed", retryable: true, httpStatus: 429, reason: "rate_limited" }))
        .mockResolvedValueOnce({ providerId: "wamid.retry" });
      try {
        const r = await notifications.notificationService.dispatch(input);
        expect(r.outcome).toBe("failed");
        expect((await prisma.notification.findUniqueOrThrow({ where: { id: r.id } })).providerError).toBe("retryable:http_429");
        expect((await notifications.notificationService.retryFailed(50, new Date(), { ids: [r.id] })).retried).toBe(1);
        expect(send).toHaveBeenCalledTimes(2);
      } finally {
        send.mockRestore();
      }
    });
  });
});
