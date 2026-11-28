import { afterEach, describe, expect, it, vi } from "vitest";
import type { CancellationFacts } from "../cancellation.service";

/**
 * Post-payment batch A, server half (A1, A3, A4 limit, A7 wording, A8
 * signature), driven with synthetic values. Pure: the database module throws
 * if touched. The loaders, the resend route, the scoped supersede and the
 * webhook route run against the disposable database in
 * src/server/__tests__/b5/postpay-tickets.test.ts.
 */

vi.mock("../../lib/db", () => ({
  prisma: new Proxy({}, { get: () => { throw new Error("no database in this suite"); } }),
  TX_OPTIONS: {},
}));

const { projectCustomerStatus, maskEmail, ticketDelivery } = await import("../order-status.service");
const { customerResendAvailability, ticketRowDeliveryState, CUSTOMER_RESEND_LIMITS, BOUNCED_ERROR } = await import("../notification.service");
const { codeChannelsAvailable, phoneCodesAvailable } = await import("../contact-verification.service");
const webhook = await import("../../notifications/resend-webhook");
const { resetEnvCache } = await import("../../lib/env");
type Snapshot = import("../order-status.service").StatusSnapshot;
type Item = import("../order-status.service").StatusItemSnapshot;
type Message = import("../order-status.service").TicketMessageSnapshot;

const NOW = new Date("2030-01-10T08:00:00.000Z");
const T0 = new Date("2030-01-10T07:00:00.000Z");
const ITEM_A = "01890000-0000-7000-8000-0000000000a1";
const ITEM_B = "01890000-0000-7000-8000-0000000000a2";
const MIN = 60_000;
const HOUR = 3_600_000;

function facts(itemId: string): CancellationFacts {
  return {
    orderItemId: itemId,
    rail: "self_serve",
    fulfilmentOrigin: "instant_checkout",
    serviceDate: "2030-01-15",
    startMinutes: 600,
    booking: { id: "01890000-0000-7000-8000-0000000000b1", state: "confirmed" },
    policy: { freeCancellationUntilUtc: "2030-01-14T06:00:00.000Z", nonRefundableAfterConfirm: false },
    issuesTicketsAtConfirm: "no",
    ticketsStored: false,
    currency: "AED",
    payableMinor: 45_000n,
    payment: { id: "01890000-0000-7000-8000-0000000000c1", captured: true, verified: true, refundableMinor: 45_000n, frozen: false },
    orderPaid: true,
  };
}

const confirmedBooking = { state: "confirmed", startMinutes: 600, confirmedAt: T0, cancelledAt: null, updatedAt: T0 };
const doc = (kind: "tickets_pdf" | "voucher_pdf", status: "valid" | "pending" = "valid", n = 1) => ({
  id: `01890000-0000-7000-8000-0000000000d${n}`,
  kind,
  version: 1,
  status,
  contentType: "application/pdf",
  byteSize: 2048,
  createdAt: T0.toISOString(),
});

function item(id: string, over: Partial<Item> = {}): Item {
  return {
    id,
    title: `Activity ${id.slice(-2)} (synthetic)`,
    serviceDate: "2030-01-15",
    timeslot: null,
    pax: { adult: 2 },
    status: "confirmed",
    booking: confirmedBooking,
    tickets: { fulfilment: "issued", documents: [doc("voucher_pdf")] },
    refunds: [],
    remedies: [],
    request: null,
    cancellation: facts(id),
    instant: true,
    ...over,
  };
}

function snap(items: Item[], over: Partial<Snapshot> = {}): Snapshot {
  return {
    order: { reference: "OUT-10000017", status: "confirmed", rail: "self_serve", currency: "AED", totalMinor: 45_000n, placedAt: T0, updatedAt: T0, paidAt: T0, hasEmail: true, recipientMasked: "j•••@example.test" },
    saga: { orderItemId: items[0].id, state: "fulfilled", deadlineAt: null, attentionRequiredAt: null, updatedAt: T0 },
    payment: { status: "captured", capturedMinor: 45_000n, refundedMinor: 0n, authorizedAt: T0, capturedAt: T0 },
    items,
    canDownload: true,
    ticketMessages: [],
    customerResends: [],
    ...over,
  };
}

function msg(orderItemId: string, status: string, over: Partial<Message> = {}): Message {
  return { orderItemId, documentVersion: 1, status, providerError: null, attentionRequiredAt: null, attempt: 1, createdAt: T0, sentAt: status === "queued" ? null : T0, deliveredAt: null, failedAt: null, ...over };
}

describe("A4: customer resend limit (3 per order in any 24 hours, one per 2 minutes)", () => {
  it("allows the first; then waits the minimum gap", () => {
    expect(customerResendAvailability([], NOW)).toEqual({ allowed: true, availableAt: null });
    const last = new Date(NOW.getTime() - 30_000);
    expect(customerResendAvailability([last], NOW)).toEqual({ allowed: false, availableAt: new Date(last.getTime() + 2 * MIN) });
    expect(customerResendAvailability([new Date(NOW.getTime() - 2 * MIN)], NOW).allowed).toBe(true);
  });

  it("a fourth in 24 hours waits until the oldest of the last three leaves the sliding window", () => {
    const times = [new Date(NOW.getTime() - 20 * HOUR), new Date(NOW.getTime() - 3 * HOUR), new Date(NOW.getTime() - 1 * HOUR)];
    expect(customerResendAvailability(times, NOW)).toEqual({ allowed: false, availableAt: new Date(times[0].getTime() + 24 * HOUR) });
    // Once the oldest is more than 24 hours old, two remain and the gap has passed.
    expect(customerResendAvailability(times, new Date(times[0].getTime() + 24 * HOUR + 1)).allowed).toBe(true);
    expect(CUSTOMER_RESEND_LIMITS).toMatchObject({ perDay: 3, minGapMs: 2 * MIN });
  });

  it("a ledger time slightly after `now` (the database clock, a request that just committed) still counts", () => {
    const later = new Date(NOW.getTime() + 50);
    expect(customerResendAvailability([later], NOW)).toEqual({ allowed: false, availableAt: new Date(later.getTime() + 2 * MIN) });
  });

  it("never a fixed calendar window: three just before midnight still block one just after", () => {
    const night = new Date("2030-01-10T23:55:00.000Z");
    const times = [0, 2, 4].map((m) => new Date(night.getTime() + m * MIN));
    expect(customerResendAvailability(times, new Date("2030-01-11T00:05:00.000Z")).allowed).toBe(false);
  });
});

describe("A3: one ticket message row as a delivery state", () => {
  it("maps every status honestly; delivered only from a receipt; bounced only from the webhook code", () => {
    const row = (status: string, over: Partial<Message> = {}) => ticketRowDeliveryState({ ...msg(ITEM_A, status), ...over }, NOW);
    expect(row("delivered")).toBe("delivered");
    expect(row("read")).toBe("delivered");
    expect(row("sent")).toBe("sent");
    expect(row("queued")).toBe("pending");
    expect(row("unknown")).toBe("pending");
    expect(row("unknown", { attentionRequiredAt: T0 })).toBe("failed");
    expect(row("suppressed")).toBe("failed");
    expect(row("failed", { providerError: "retryable:http_429" })).toBe("pending");
    expect(row("failed", { providerError: "retryable:http_429", attempt: 4 })).toBe("failed");
    expect(row("failed", { providerError: "retryable:http_429", createdAt: new Date(NOW.getTime() - 25 * HOUR) })).toBe("failed");
    expect(row("failed", { providerError: "definite:http_422" })).toBe("failed");
    expect(row("failed", { providerError: BOUNCED_ERROR })).toBe("bounced");
  });
});

describe("A3: maskEmail", () => {
  it("shows the first character and the domain only", () => {
    expect(maskEmail("Jane.Doe@Example.TEST")).toBe("j•••@example.test");
    expect(maskEmail(" a@b.test ")).toBe("a•••@b.test");
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("no-at-sign")).toBeNull();
    expect(maskEmail("@example.test")).toBeNull();
    expect(maskEmail("x@")).toBeNull();
  });
});

describe("A3: order-level delivery view", () => {
  it("null when the order has no email or no item has a ticket file", () => {
    expect(ticketDelivery(snap([item(ITEM_A)], { order: { ...snap([item(ITEM_A)]).order, hasEmail: false } }), NOW)).toBeNull();
    expect(ticketDelivery(snap([item(ITEM_A, { tickets: { fulfilment: "ticket_pending", documents: [doc("voucher_pdf", "pending")] } })]), NOW)).toBeNull();
  });

  it("pending with no message yet; sent once accepted; never delivered without a receipt", () => {
    expect(ticketDelivery(snap([item(ITEM_A)]), NOW)).toMatchObject({ channel: "email", state: "pending", recipientMasked: "j•••@example.test", canResend: true, resendAvailableAt: null });
    const sent = ticketDelivery(snap([item(ITEM_A)], { ticketMessages: [msg(ITEM_A, "sent")] }), NOW);
    expect(sent).toMatchObject({ state: "sent", at: T0.toISOString() });
  });

  it("delivered only when every item's message was delivered; one item merely sent keeps 'sent'", () => {
    const two = [item(ITEM_A), item(ITEM_B)];
    const at = new Date(T0.getTime() + MIN);
    expect(ticketDelivery(snap(two, { ticketMessages: [msg(ITEM_A, "delivered", { deliveredAt: at }), msg(ITEM_B, "sent")] }), NOW)?.state).toBe("sent");
    expect(ticketDelivery(snap(two, { ticketMessages: [msg(ITEM_A, "delivered", { deliveredAt: at }), msg(ITEM_B, "delivered", { deliveredAt: at })] }), NOW)).toMatchObject({ state: "delivered", at: at.toISOString() });
  });

  it("a bounce or a failure on any item is what the order shows; a later successful resend clears a failure", () => {
    const two = [item(ITEM_A), item(ITEM_B)];
    const bounced = msg(ITEM_B, "failed", { providerError: BOUNCED_ERROR, failedAt: T0 });
    expect(ticketDelivery(snap(two, { ticketMessages: [msg(ITEM_A, "sent"), bounced] }), NOW)?.state).toBe("bounced");
    const failed = msg(ITEM_B, "failed", { providerError: "definite:http_422", failedAt: T0 });
    expect(ticketDelivery(snap(two, { ticketMessages: [msg(ITEM_A, "sent"), failed] }), NOW)?.state).toBe("failed");
    const resent = msg(ITEM_B, "sent", { createdAt: new Date(T0.getTime() + MIN), sentAt: new Date(T0.getTime() + MIN) });
    expect(ticketDelivery(snap(two, { ticketMessages: [msg(ITEM_A, "sent"), failed, resent] }), NOW)?.state).toBe("sent");
    // A bounce on the newest message wins over an earlier "sent" for the same item.
    const laterBounce = msg(ITEM_A, "failed", { providerError: BOUNCED_ERROR, createdAt: new Date(T0.getTime() + MIN), failedAt: new Date(T0.getTime() + 2 * MIN) });
    expect(ticketDelivery(snap([item(ITEM_A)], { ticketMessages: [msg(ITEM_A, "sent"), laterBounce] }), NOW)?.state).toBe("bounced");
  });

  it("fix round 1 (L1): the newest message for the current file decides; an older success never hides a newer failure", () => {
    const later = (min: number) => new Date(T0.getTime() + min * MIN);
    const delivered = msg(ITEM_A, "delivered", { deliveredAt: T0 });
    // A customer resend that failed for good after the first email was delivered.
    const failedResend = msg(ITEM_A, "failed", { providerError: "definite:http_422", createdAt: later(1), failedAt: later(1) });
    expect(ticketDelivery(snap([item(ITEM_A)], { ticketMessages: [delivered, failedResend] }), NOW)).toMatchObject({ state: "failed", at: later(1).toISOString() });
    // While the newest is still on its way, the newest settled message of the same version speaks.
    const inFlight = msg(ITEM_A, "queued", { createdAt: later(2) });
    expect(ticketDelivery(snap([item(ITEM_A)], { ticketMessages: [delivered, inFlight] }), NOW)?.state).toBe("delivered");
    expect(ticketDelivery(snap([item(ITEM_A)], { ticketMessages: [inFlight] }), NOW)?.state).toBe("pending");
    // A re-issued file (version 2): the version 1 email no longer speaks for it.
    const v2 = item(ITEM_A, { tickets: { fulfilment: "issued", documents: [doc("voucher_pdf"), { ...doc("voucher_pdf", "valid", 2), version: 2 }] } });
    expect(ticketDelivery(snap([v2], { ticketMessages: [delivered] }), NOW)?.state).toBe("pending");
    const v2Failed = msg(ITEM_A, "failed", { documentVersion: 2, providerError: "definite:http_422", createdAt: later(3), failedAt: later(3) });
    expect(ticketDelivery(snap([v2], { ticketMessages: [delivered, v2Failed] }), NOW)?.state).toBe("failed");
    const v2Sent = msg(ITEM_A, "sent", { documentVersion: 2, createdAt: later(4), sentAt: later(4) });
    expect(ticketDelivery(snap([v2], { ticketMessages: [delivered, v2Failed, v2Sent] }), NOW)).toMatchObject({ state: "sent", at: later(4).toISOString() });
  });

  it("fix round 1 (L2): no delivery view at all for a viewer who may not download", () => {
    expect(ticketDelivery(snap([item(ITEM_A)], { canDownload: false, ticketMessages: [msg(ITEM_A, "sent")] }), NOW)).toBeNull();
    const out = projectCustomerStatus(snap([item(ITEM_A)], { canDownload: false, ticketMessages: [msg(ITEM_A, "sent")] }), NOW);
    expect(out.delivery).toBeNull();
    expect(JSON.stringify(out)).not.toContain("j•••@example.test");
  });

  it("the next allowed time when limited", () => {
    const recent = new Date(NOW.getTime() - MIN);
    expect(ticketDelivery(snap([item(ITEM_A)], { customerResends: [recent] }), NOW)).toMatchObject({ canResend: false, resendAvailableAt: new Date(recent.getTime() + 2 * MIN).toISOString() });
  });

  it("the projection carries the view and never the address", () => {
    const out = projectCustomerStatus(snap([item(ITEM_A)], { ticketMessages: [msg(ITEM_A, "sent")] }), NOW);
    expect(out.delivery?.state).toBe("sent");
    expect(JSON.stringify(out)).not.toMatch(/jane|example\.test"[^,]*@|leadEmail/i);
    expect(JSON.stringify(out)).toContain("j•••@example.test");
  });
});

describe("A1: unlock channels", () => {
  it("are passed through as loaded (verified and deliverable), and default to none", () => {
    expect(projectCustomerStatus(snap([item(ITEM_A)], { unlockChannels: ["email"] }), NOW).unlockChannels).toEqual(["email"]);
    expect(projectCustomerStatus(snap([item(ITEM_A)], { unlockChannels: undefined }), NOW).unlockChannels).toEqual([]);
  });

  describe("deliverable channels", () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
      resetEnvCache();
    });

    it("outside production both channels can deliver (log adapters, allowlist)", () => {
      process.env.APP_ENV = "development";
      resetEnvCache();
      expect(codeChannelsAvailable()).toEqual(["phone", "email"]);
      expect(phoneCodesAvailable()).toBe(true);
    });

    it("in production phone needs the server-owned MSG91 path and email needs Resend", () => {
      process.env.APP_ENV = "production";
      process.env.SMS_PROVIDER = "log";
      // Synthetic placeholder, assembled at runtime so it never looks like a key in source.
      process.env.RESEND_API_KEY = ["re", "unit", "test", "only"].join("_");
      resetEnvCache();
      expect(codeChannelsAvailable()).toEqual(["email"]);
      expect(phoneCodesAvailable()).toBe(false);
      delete process.env.RESEND_API_KEY;
      resetEnvCache();
      expect(codeChannelsAvailable()).toEqual([]);
    });
  });
});

describe("A7: tickets or voucher, by document kind", () => {
  it("a tickets PDF is 'tickets' in the step and the next step", () => {
    const out = projectCustomerStatus(snap([item(ITEM_A, { tickets: { fulfilment: "issued", documents: [doc("tickets_pdf")] } })]), NOW);
    expect(out.steps.tickets.label).toBe("Tickets ready");
    expect(out.nextStep).toBe("Your tickets are ready to download. Show them on your phone or print them for the day.");
    const locked = projectCustomerStatus(snap([item(ITEM_A, { tickets: { fulfilment: "issued", documents: [doc("tickets_pdf")] }, ticketsEmailed: true })], { canDownload: false }), NOW);
    expect(locked.nextStep).toBe("Your tickets are ready. To keep them private, confirm it's you. We've also emailed you a link to them.");
  });

  it("a voucher stays 'voucher'; a mixed order names both", () => {
    expect(projectCustomerStatus(snap([item(ITEM_A)]), NOW).nextStep).toBe("Your voucher is ready to download. Show it on your phone or print it for the day.");
    const mixed = projectCustomerStatus(snap([item(ITEM_A), item(ITEM_B, { tickets: { fulfilment: "issued", documents: [doc("tickets_pdf", "valid", 2)] } })]), NOW);
    expect(mixed.nextStep).toBe("Your tickets and vouchers are ready to download. Show them on your phone or print them for the day.");
  });

  it("before any file: an open-dated ticket item is 'tickets'; the email is promised only when the order has one", () => {
    const ticketFacts = { validUntil: null, validityCopy: null, nonRefundableCopy: "Non-refundable.", types: [], validityConcern: null };
    const pending = item(ITEM_A, { tickets: { fulfilment: "ticket_pending", documents: [] }, ticket: ticketFacts });
    const withEmail = projectCustomerStatus(snap([pending]), NOW);
    expect(withEmail.headline).toBe("Booked. Your tickets are being prepared.");
    expect(withEmail.nextStep).toBe("This page updates by itself when they're ready, and we email them to you too.");
    expect(withEmail.steps.tickets.label).toBe("Tickets being prepared");
    const noEmail = projectCustomerStatus(snap([pending], { order: { ...snap([pending]).order, hasEmail: false, recipientMasked: null } }), NOW);
    expect(noEmail.nextStep).toBe("This page updates by itself when they're ready.");
    expect(noEmail.nextStep).not.toMatch(/email/i);
    const voucher = projectCustomerStatus(snap([item(ITEM_A, { tickets: { fulfilment: "ticket_pending", documents: [doc("voucher_pdf", "pending")] } })]), NOW);
    expect(voucher.nextStep).toBe("This page updates by itself when it's ready, and we email it to you too.");
  });
});

describe("A8: Svix signature (Resend webhooks)", () => {
  const secret = `whsec_${Buffer.from("unit-test-only-webhook-signing-key-0123").toString("base64")}`;
  const body = JSON.stringify({ type: "email.delivered", created_at: "2030-01-10T07:59:00.000Z", data: { email_id: "re_unit_1", to: ["someone@example.test"] } });
  const ts = Math.floor(NOW.getTime() / 1000);
  const id = "msg_unit_1";
  const signature = webhook.signSvixForTests({ body, id, timestamp: ts, secret });
  const verify = (over: Partial<Parameters<typeof webhook.verifySvixSignature>[0]> = {}) =>
    webhook.verifySvixSignature({ body: Buffer.from(body), id, timestamp: String(ts), signature, secret, now: NOW, ...over });

  it("accepts the exact bytes, and any v1 entry during a rotation", () => {
    expect(verify()).toBe("ok");
    expect(verify({ signature: `v1,${Buffer.alloc(32).toString("base64")} ${signature}` })).toBe("ok");
  });

  it("refuses tampering, a wrong secret, a stale or future timestamp, and missing or malformed headers", () => {
    expect(verify({ body: Buffer.from(body.replace("delivered", "bounced")) })).toBe("mismatch");
    expect(verify({ secret: `whsec_${Buffer.from("another-unit-test-only-signing-key").toString("base64")}` })).toBe("mismatch");
    expect(verify({ now: new Date(NOW.getTime() + 6 * MIN) })).toBe("stale");
    expect(verify({ now: new Date(NOW.getTime() - 6 * MIN) })).toBe("stale");
    expect(verify({ now: new Date(NOW.getTime() + 4 * MIN) })).toBe("ok");
    expect(verify({ signature: null })).toBe("missing");
    expect(verify({ id: null })).toBe("missing");
    expect(verify({ timestamp: "soon" })).toBe("malformed");
    expect(verify({ signature: "v2,abc" })).toBe("malformed");
    expect(verify({ id: "bad id with spaces" })).toBe("malformed");
    expect(verify({ secret: "whsec_" })).toBe("secret_invalid");
    expect(verify({ secret: "not base64 !!" })).toBe("secret_invalid");
    // Fix round 1 (L6): the `whsec_` prefix is required, as the route documents.
    expect(verify({ secret: secret.slice("whsec_".length) })).toBe("secret_invalid");
    expect(webhook.isUsableWebhookSecret(secret)).toBe(true);
    expect(webhook.isUsableWebhookSecret(secret.slice("whsec_".length))).toBe(false);
    expect(webhook.isUsableWebhookSecret(undefined)).toBe(false);
  });

  it("parses only what it needs and maps the delivery events", () => {
    expect(webhook.parseResendEvent(JSON.parse(body))).toEqual({ type: "email.delivered", at: new Date("2030-01-10T07:59:00.000Z"), emailId: "re_unit_1", bounceType: null });
    expect(webhook.parseResendEvent({ type: "email.bounced", data: { email_id: "re_2", bounce: { type: "Permanent" } } })).toMatchObject({ emailId: "re_2", bounceType: "Permanent", at: null });
    expect(webhook.parseResendEvent({ type: "email.delivered", data: { email_id: "has spaces" } })?.emailId).toBeNull();
    expect(webhook.parseResendEvent([])).toBeNull();
    expect(webhook.parseResendEvent({ type: 42 })).toBeNull();
    expect(webhook.statusForEvent("email.sent")).toEqual({ status: "sent" });
    expect(webhook.statusForEvent("email.delivery_delayed")).toEqual({ status: "sent" });
    expect(webhook.statusForEvent("email.delivered")).toEqual({ status: "delivered" });
    // Fix round 1 (L7): a complaint is stored, never applied, so it can never make a row "delivered".
    expect(webhook.statusForEvent("email.complained")).toBeNull();
    expect(webhook.statusForEvent("email.bounced")).toEqual({ status: "bounced", error: BOUNCED_ERROR });
    expect(webhook.statusForEvent("email.opened")).toBeNull();
  });

  it("fix round 2 (N3): a redelivery that changes nothing now is `reapplied`, never `no_change`", () => {
    expect(webhook.processingNote(true, false, 0)).toBe("no_change");
    expect(webhook.processingNote(true, true, 0)).toBe("reapplied");
    expect(webhook.processingNote(true, false, 1)).toBeUndefined();
    expect(webhook.processingNote(true, true, 1)).toBeUndefined();
    expect(webhook.processingNote(false, false, 0)).toBeUndefined();
    expect(webhook.processingNote(false, true, 0)).toBeUndefined();
  });
});
