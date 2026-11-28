import "server-only";
import { Prisma, type Notification } from "@prisma/client";
import { prisma, TX_OPTIONS, type Tx } from "../lib/db";
import { env } from "../lib/env";
import { uuidv7 } from "../lib/ids";
import type { Actor } from "../lib/actor";
import { customerActor, hasPermission, requirePermission } from "../lib/actor";
import { audit, auditFieldChanges } from "../lib/audit";
import { log } from "../lib/logger";
import { Errors } from "../lib/errors";
import { decryptFor, hmacCandidates, KeyUnavailableError, safeEqual, sha256Hex } from "../lib/crypto";
import { emitEvent } from "../lib/structured-events";
import { analyticsService } from "./analytics.service";
import { capabilityService } from "./capability.service";
import { documentService } from "./document.service";
import { ticketFactsForOrder } from "./ticket-facts.service";
import { ticketTypeLine } from "@/lib/ticket-validity";
import type { AgentPublic, InquiryDetail } from "./inquiry.types";
import { dedupKeyOf, type CapabilityIssuedFor, type TicketMessageRef } from "../documents/contracts";
import {
  renderInvoiceIssued,
  renderPaymentReceived,
  renderTemplate,
  renderTicketsReady,
  supportsChannel,
  ticketLink,
  type InvoiceNotificationEvent,
  type NotificationEvent,
  type PaymentNotificationEvent,
  type Rendered,
  type TemplateContext,
  type TicketNotificationEvent,
} from "../notifications/templates";
import { emailAdapter, type EmailOutcome, type EmailSend } from "../notifications/email.adapter";
import { ACCOUNT_LINK_NOTICE_EVENT, notMeLink, renderAccountLinkNotice, type AttachRule } from "../notifications/auth-templates";
import { whatsappAdapter, WhatsAppSendError } from "../notifications/whatsapp.adapter";
import { isRecipientAllowed } from "../notifications/allowlist";
import { latestConsent } from "../repositories/consent.repo";

/**
 * Notification service — channel-agnostic dispatch and the notification
 * outbox (§04.6.3, §17 §7.2 steps 6–8; doc 22 §23 B4, TKT-6, §26 F14).
 *
 * A caller says *what happened* (`onInquirySubmitted`, `onTicketsReady`);
 * this decides who is told, on which channel, with which template, and
 * records every intended message in `notifications`. Rules that live here
 * and nowhere else:
 *
 *  - Non-production recipient allowlist (§14.1 non-negotiable #3): outside
 *    production a message to a recipient not on the allowlist is recorded as
 *    `suppressed`, never sent. An empty allowlist suppresses everything.
 *  - Consent is re-checked at send time, not schedule time (§08.7). An
 *    explicit `granted=false` row (STOP keyword, profile toggle) suppresses
 *    transactional and marketing alike; marketing additionally needs a
 *    positive grant.
 *  - A notification failure never fails the caller's business action.
 *
 * Outbox (TKT-6). One row per intended message, written BEFORE any send:
 *
 *  1. Insert `queued` with a unique `dedup_key` (`dedupKeyOf`: event,
 *     order, item, inquiry, recipient hash, document version, resend id) and
 *     a short claim (`locked_until`). A unique conflict means the message
 *     already exists: no send, `notification.duplicate`.
 *  2. Render, check guards, send with the provider idempotency key = row id.
 *  3. Record `sent`, `failed` (definite, or retryable: `provider_error`
 *     starts with `definite:` or `retryable:`), `unknown` (timeout,
 *     network, 5xx, 409: it may have gone out) or `suppressed`.
 *
 * A crash between 2 and 3 leaves the row `queued` with an expired claim; the
 * sweep (`retryFailed`) treats it like `unknown`. Ambiguous rows are re-sent
 * under the SAME idempotency key with an identical body while the provider
 * still remembers the key (Resend keeps keys 24 hours; we stop earlier, see
 * `IDEMPOTENCY_WINDOW_MS`). After that the row gets `attention_required_at`
 * and `notification.attention`, and is never re-sent automatically: a
 * duplicate email past the provider window is possible, so a human decides
 * (TKT-6 accepts and documents that residual risk).
 *
 * Ticket messages (event `TICKETS_READY`, email only). The row's payload is
 * a `TicketMessageRef` (ids and the document version): never contact data,
 * never a token. The message is rendered at send time: a `download_tickets`
 * capability is minted for the row (kept encrypted until the outcome is
 * known, so an `unknown` send re-renders identically) and the link carries
 * the token in the URL fragment. A staff resend is a new row (`resendOf`)
 * with a fresh capability. The new capability supersedes the order's
 * previous link only once its own message is `sent` (R-B4-4): a `failed` or
 * `unknown` send, or a provider that rejects a resend, leaves the link the
 * customer already has working.
 *
 * Dedup across a `lookup` key rotation (R-B4-10). The recipient part of a
 * dedup key is a keyed hash. While the ring holds an older key, a row whose
 * key was built from ANY ring key is the same message: it is looked up
 * before the insert, so a rotation never re-sends what already exists.
 *
 * WhatsApp has no provider idempotency key (see `whatsapp.adapter.ts`): an
 * ambiguous WhatsApp row (`unknown`, or `queued` after a crash) is never
 * re-sent automatically; it goes straight to attention.
 *
 * Logging goes through `emitEvent` only: no recipient, token, rendered body
 * or provider response ever reaches the log drain (PRV-6, SEC-18).
 */

export interface DispatchInput {
  event: NotificationEvent;
  channel: "whatsapp" | "email";
  recipient: string;
  inquiryId?: string;
  orderId?: string;
  context: TemplateContext;
  /** transactional (default) or marketing — marketing requires explicit consent */
  purpose?: "transactional" | "marketing";
  scheduledFor?: Date;
  /**
   * Dedup scope. The same event, channel, ids, recipient and `once` value is
   * one message: a second dispatch is a duplicate and sends nothing. Omitted
   * means every call is a distinct message (no deduplication).
   */
  once?: string;
  /** A human resend: a fresh id, so the resend is a new message by design. */
  resendOf?: string;
}

/** Row states a dispatch can end in. `queued`: the outcome could not be recorded; the sweep resolves it. */
export type OutboxOutcome = "sent" | "failed" | "unknown" | "suppressed" | "queued";

/** An attach notice row written in the sign-in request; its send runs after the response (re-review 103b N4). */
export interface QueuedAccountLinkNotice {
  row: Notification;
  claimUntil: Date;
}

export interface DispatchResult {
  id: string;
  /** Coarse status kept for existing callers: `unknown` and `queued` read as `failed` with an `error` code. */
  status: "sent" | "failed" | "suppressed";
  outcome: OutboxOutcome;
  /** True when the message already existed and nothing was sent. */
  duplicate?: boolean;
  providerId?: string;
  error?: string;
}

type SuppressedReason = "non_production_allowlist" | "opted_out" | "no_consent" | "unsupported_channel" | "switch_off";

/** Outcome of one attempt, before it is recorded. `code` is a short machine code, never provider text. */
type Outcome =
  | { status: "sent"; template?: string; providerId: string; costMinor?: bigint }
  | { status: "failed"; template?: string; retryable: boolean; code: string; httpStatus?: number | null }
  | { status: "unknown"; template?: string; code: string }
  | { status: "suppressed"; template?: string; reason: SuppressedReason };

const TICKETS_READY: TicketNotificationEvent = "TICKETS_READY";
/** Group C (C2): one payment confirmation per order, rendered at send time from ids (doc 93 §3.1). */
const PAYMENT_RECEIVED: PaymentNotificationEvent = "PAYMENT_RECEIVED";
/** Captures older than this are never announced by the sweep (first deploy, a long job outage). */
export const PAYMENT_RECEIVED_WINDOW_MS = 30 * 60_000;

/** Group C (review 102 finding 14, O8): the follow-up email that carries the combined invoice once it exists. */
const INVOICE_ISSUED: InvoiceNotificationEvent = "INVOICE_ISSUED";
/**
 * Invoices of captures booked longer ago than this are never mailed by the sweep (a long job outage; re-review N5).
 * Owner answer D4 (28 Nov 2026): seven days from the capture. The one place to change it.
 */
export const INVOICE_ISSUED_WINDOW_MS = 7 * 24 * 3600_000;
/** Order states in which the money is still held for the booking: the payment email is sent only in these (finding 9). */
const PAYMENT_EMAIL_ORDER_STATES = ["paid", "supplier_pending", "confirmed", "partially_confirmed", "completed"] as const;
/**
 * Review 109c N9: every character `String.prototype.trim()` removes (ECMAScript WhiteSpace and LineTerminator), passed
 * to `btrim` as a parameter so the database trims exactly what the send-time `trim()` does.
 */
const JS_TRIM_CHARS = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]
  .map((c) => String.fromCharCode(c))
  .join("");
/** Time one payment or invoice email send may take (the email provider's timeout plus the writes). */
export const EMAIL_SEND_UNIT_MS = 12_000;

/** The row payload of a follow-up invoice email: ids only. */
interface InvoiceMessageRef {
  kind: "invoice_message";
  orderId: string;
  fiscalDocumentId: string;
  generatedDocumentId: string;
}

/** The row payload of a payment confirmation: ids only, plus the attachment decided at insert (O8). */
interface PaymentMessageRef {
  kind: "payment_message";
  orderId: string;
  paymentId: string;
  /** A valid generated `tax_invoice` file id, or null. Fixed when the row is written so a retry is identical. */
  attachGeneratedDocumentId: string | null;
}

/** Attempts per row for retryable failures and for ambiguous (`unknown`, stale `queued`) rows. */
export const MAX_ATTEMPTS = 4;
/** Retryable failures are retried for this long after the row was created. */
export const RETRY_WINDOW_MS = 24 * 3600_000;
/**
 * Ambiguous rows are re-sent under the same idempotency key only while the
 * provider still remembers it. Resend keeps keys 24 hours; we stop 30
 * minutes earlier as a margin for clock skew and a slow sweep.
 */
export const IDEMPOTENCY_WINDOW_MS = 24 * 3600_000 - 30 * 60_000;
/** How long one sender holds a row. Longer than the email timeout (10 s) and the WhatsApp adapter's. */
const SEND_LOCK_MS = 2 * 60_000;

/* ------------------------------------------------------------ test seam */

let faultAfterSend: ((notificationId: string) => Promise<void> | void) | null = null;

/**
 * Test seam: runs after a send returned and before its outcome is written,
 * so a test can simulate the process dying or the database failing at that
 * exact point (TKT-6 "crash after send"). `null` removes it.
 */
export function setOutboxFaultForTests(fn: ((notificationId: string) => Promise<void> | void) | null) {
  faultAfterSend = fn;
}

/* ------------------------------------------------------------ helpers */

function normaliseRecipient(recipient: string): string {
  return recipient.trim().toLowerCase().replace(/\s+/g, "");
}

/** The recipient's hash under every `lookup` ring key, active first (R-B4-10). */
function recipientHashes(recipient: string): string[] {
  return hmacCandidates("lookup", normaliseRecipient(recipient));
}

/** Dedup keys of one message under every recipient hash, active first: any of them is the same message. */
function dedupKeysFor(parts: Omit<Parameters<typeof dedupKeyOf>[0], "recipientHash">, hashes: readonly string[]): string[] {
  return hashes.map((recipientHash) => dedupKeyOf({ ...parts, recipientHash }));
}

function serialisableContext(ctx: TemplateContext): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(ctx)) as Prisma.InputJsonValue;
}

/** Who asked for a ticket resend, stored on the row (`payload.resend`) so the minted link gets the right supersede scope (A2, A4). */
type ResendBy = "staff" | "customer";

function resendByOf(payload: unknown): ResendBy | null {
  const r = payload && typeof payload === "object" ? (payload as { resend?: unknown }).resend : undefined;
  return r === "staff" || r === "customer" ? r : null;
}

function parseTicketRef(payload: unknown): TicketMessageRef | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const uuid = /^[0-9a-f-]{36}$/;
  if (p.kind !== "ticket_message" || typeof p.orderId !== "string" || typeof p.orderItemId !== "string" || typeof p.documentVersion !== "number") return null;
  if (!uuid.test(p.orderId) || !uuid.test(p.orderItemId) || !Number.isInteger(p.documentVersion) || p.documentVersion < 1) return null;
  return { kind: "ticket_message", orderId: p.orderId, orderItemId: p.orderItemId, documentVersion: p.documentVersion };
}

function parsePaymentRef(payload: unknown): PaymentMessageRef | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const uuid = /^[0-9a-f-]{36}$/;
  if (p.kind !== "payment_message" || typeof p.orderId !== "string" || typeof p.paymentId !== "string" || !uuid.test(p.orderId) || !uuid.test(p.paymentId)) return null;
  const attach = typeof p.attachGeneratedDocumentId === "string" && uuid.test(p.attachGeneratedDocumentId) ? p.attachGeneratedDocumentId : null;
  return { kind: "payment_message", orderId: p.orderId, paymentId: p.paymentId, attachGeneratedDocumentId: attach };
}

function parseInvoiceRef(payload: unknown): InvoiceMessageRef | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const uuid = /^[0-9a-f-]{36}$/;
  if (p.kind !== "invoice_message" || typeof p.orderId !== "string" || typeof p.fiscalDocumentId !== "string" || typeof p.generatedDocumentId !== "string") return null;
  if (!uuid.test(p.orderId) || !uuid.test(p.fiscalDocumentId) || !uuid.test(p.generatedDocumentId)) return null;
  return { kind: "invoice_message", orderId: p.orderId, fiscalDocumentId: p.fiscalDocumentId, generatedDocumentId: p.generatedDocumentId };
}

/**
 * Is the payment email still right for this order (review finding 9)? The money is still held for the booking: the
 * order is in a paid state, nothing was refunded on the payment, no refund row is open or done, and no refund remedy
 * is pending, running or done. An order the saga is refunding (supplier failed after capture) gets no "we have
 * received your payment" email.
 */
async function paymentEmailStillRight(orderId: string, paymentId: string): Promise<boolean> {
  const [row] = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT (
      EXISTS (SELECT 1 FROM orders o WHERE o.id = ${orderId}::uuid AND o.status::text IN (${Prisma.join([...PAYMENT_EMAIL_ORDER_STATES])}))
      AND EXISTS (SELECT 1 FROM payments p WHERE p.id = ${paymentId}::uuid AND p.order_id = ${orderId}::uuid AND p.captured_minor > 0 AND p.refunded_minor = 0)
      AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = ${paymentId}::uuid AND r.status <> 'failed')
      AND NOT EXISTS (SELECT 1 FROM customer_remedies cr WHERE cr.order_id = ${orderId}::uuid AND cr.kind = 'refund' AND cr.status IN ('pending', 'in_progress', 'completed'))
    ) AS ok`;
  return row?.ok === true;
}

function errorCodeOf(o: Outcome): string | undefined {
  if (o.status === "failed") return `${o.retryable ? "retryable" : "definite"}:${o.code}`;
  if (o.status === "unknown") return `unknown:${o.code}`;
  return undefined;
}

function columnsFor(o: Outcome, now: Date): Prisma.NotificationUpdateManyMutationInput {
  const base = { lockedUntil: null, template: o.template ?? null };
  switch (o.status) {
    case "sent":
      return { ...base, status: "sent", sentAt: now, providerId: o.providerId, costMinor: o.costMinor ?? null, providerError: null, failedAt: null, suppressedReason: null, attentionRequiredAt: null };
    case "failed":
      return { ...base, status: "failed", failedAt: now, providerError: errorCodeOf(o) };
    case "unknown":
      return { ...base, status: "unknown", providerError: errorCodeOf(o) };
    case "suppressed":
      return { ...base, status: "suppressed", suppressedReason: o.reason };
  }
}

function legacyStatus(outcome: OutboxOutcome): DispatchResult["status"] {
  return outcome === "sent" || outcome === "suppressed" ? outcome : "failed";
}

function resultOf(id: string, outcome: OutboxOutcome, extra: { providerId?: string | null; error?: string | null; duplicate?: boolean } = {}): DispatchResult {
  const error = extra.error ?? (outcome === "unknown" ? "outcome_unknown" : outcome === "queued" ? "pending" : undefined);
  return {
    id,
    status: legacyStatus(outcome),
    outcome,
    ...(extra.duplicate ? { duplicate: true } : {}),
    ...(extra.providerId ? { providerId: extra.providerId } : {}),
    ...(outcome === "failed" || outcome === "unknown" || outcome === "queued" ? { error: error ?? undefined } : {}),
  };
}

function rowOutcome(row: Pick<Notification, "status">): OutboxOutcome {
  const s = row.status;
  if (s === "sent" || s === "delivered" || s === "read") return "sent";
  if (s === "failed" || s === "unknown" || s === "suppressed" || s === "queued") return s;
  return "queued";
}

function emailOutcome(r: EmailOutcome, template?: string): Outcome {
  if (r.kind === "sent") return { status: "sent", template, providerId: r.providerId, costMinor: r.costMinor };
  if (r.kind === "failed") return { status: "failed", template, retryable: r.retryable, code: r.httpStatus ? `http_${r.httpStatus}` : r.reason, httpStatus: r.httpStatus };
  return { status: "unknown", template, code: r.httpStatus ? `http_${r.httpStatus}` : r.reason };
}

const dateLabel = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/* ------------------------------------------------------------ render */

const dubaiDateTime = (d: Date) =>
  `${d.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Dubai" })} Dubai time`;

function parseAccountLinkRef(payload: unknown): { linkId: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  return p.kind === "account_link_notice" && typeof p.linkId === "string" && /^[0-9a-f-]{36}$/.test(p.linkId) ? { linkId: p.linkId } : null;
}

/**
 * Group B (owner Q10): the "booking added to an account" notice, rendered at
 * send time from the link row. The "not me" token is kept encrypted on the
 * row until this message's outcome is known, so a retry re-renders the same
 * body under the same idempotency key; it is never in the payload.
 */
async function prepareAccountLinkNotice(ref: { linkId: string }): Promise<Prepared> {
  const link = await prisma.orderAccountLink.findUnique({
    where: { id: ref.linkId },
    select: { rule: true, attachedAt: true, detachedAt: true, disputeTokenHash: true, disputeTokenCiphertext: true, disputeExpiresAt: true, order: { select: { reference: true } } },
  });
  if (!link || (link.rule !== "verified_email" && link.rule !== "guest_session")) return { ok: false, outcome: { status: "failed", retryable: false, code: "link_missing" } };
  // Already detached (the customer used the link, or staff did): nothing left to tell.
  if (link.detachedAt) return { ok: false, outcome: { status: "failed", retryable: false, code: "link_detached" } };
  if (!link.disputeTokenCiphertext || !link.disputeTokenHash || !link.disputeExpiresAt) return { ok: false, outcome: { status: "failed", retryable: false, code: "token_unavailable" } };
  const token = decryptFor("capability_tokens", link.disputeTokenCiphertext);
  if (!safeEqual(sha256Hex(token), link.disputeTokenHash)) return { ok: false, outcome: { status: "failed", retryable: false, code: "token_unavailable" } };
  const e = env();
  const rendered = renderAccountLinkNotice({
    orderReference: link.order.reference,
    rule: link.rule as AttachRule,
    attachedLabel: dubaiDateTime(link.attachedAt),
    notMeLink: notMeLink(e.NEXT_PUBLIC_SITE_URL, token),
    expiresLabel: dateLabel(link.disputeExpiresAt),
    supportEmail: e.NEXT_PUBLIC_SUPPORT_EMAIL ?? e.EMAIL_REPLY_TO,
  });
  return { ok: true, rendered };
}

type Prepared = { ok: true; rendered: Rendered; grantId?: string; attachments?: EmailSend["attachments"] } | { ok: false; outcome: Outcome };

/** Ticket message, rendered at send time from ids (TKT-6). Mints the row's capability on the first attempt. */
/** "Pickup at 08:15 Dubai time from Example Hotel" for the tickets email (doc 29 §8.7); null without a usable time. */
export function pickupLine(minutes: number | null, hotel: string | null | undefined): string | null {
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60) return null;
  const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const where = typeof hotel === "string" && hotel.trim() ? ` from ${hotel.trim().slice(0, 120)}` : "";
  return `Pickup at ${time} Dubai time${where}`;
}

async function prepareTicketMessage(row: Notification, ref: TicketMessageRef, now: Date): Promise<Prepared> {
  const order = await prisma.order.findUnique({
    where: { id: ref.orderId },
    select: {
      reference: true,
      leadName: true,
      items: { where: { id: ref.orderItemId }, select: { titleSnapshot: true, serviceDate: true, pickupHotelNameSnapshot: true } },
      // Doc 29 §8.7: the pickup time the supplier returned, from the item's confirmed attempt.
      supplierBookings: { where: { orderItemId: ref.orderItemId, state: "confirmed" }, select: { pickupTimeMinutes: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 },
    },
  });
  if (!order) return { ok: false, outcome: { status: "failed", retryable: false, code: "order_missing" } };

  const existing = await capabilityService.findForNotification(row.id);
  let token: string;
  let grantId: string;
  let expiresAt: Date;
  if (existing) {
    // A retry: the same token, so the body (and the provider's idempotency check) is identical.
    const kept = await capabilityService.tokenForRetry(existing.id, now);
    if (!kept) {
      // A newer message superseded this link, or it was revoked: re-sending it would deliver a dead link.
      return { ok: false, outcome: { status: "failed", retryable: false, code: existing.revokeReason === "superseded" ? "superseded" : "capability_unavailable" } };
    }
    token = kept;
    grantId = existing.id;
    expiresAt = existing.expiresAt;
  } else {
    // A customer's own resend (A4) is a ticket message like the first one: its link replaces only the same item's
    // older links (A2). A staff resend (rows before A4 carry no marker) keeps the order-wide rule.
    const by = resendByOf(row.payload);
    const issuedFor: CapabilityIssuedFor = by === "customer" ? "ticket_notification" : by === "staff" || row.dedupKey?.includes("|resend:") ? "staff_resend" : "ticket_notification";
    // The previous link stays live until this message is known to be sent (R-B4-4): `supersedePrevious` below.
    const minted = await capabilityService.mint(prisma, { orderId: ref.orderId, purpose: "download_tickets", issuedFor, notificationId: row.id, keepForRetry: true, supersede: "after_sent" }, now);
    token = minted.token;
    grantId = minted.grantId;
    expiresAt = minted.expiresAt;
  }

  const e = env();
  const firstName = order.leadName.trim().split(/\s+/)[0] || undefined;
  // Doc 29 Batch 5: an open-dated ticket item adds its validity and ticket types (never a code).
  const tickets = await ticketFactsForOrder(ref.orderId, { orderItemIds: [ref.orderItemId] });
  const rendered = renderTicketsReady({
    firstName,
    orderReference: order.reference,
    items: order.items.map((i) => {
      const t = tickets.get(ref.orderItemId);
      const pickup = pickupLine(order.supplierBookings[0]?.pickupTimeMinutes ?? null, i.pickupHotelNameSnapshot);
      return {
        title: i.titleSnapshot,
        dateLabel: dateLabel(i.serviceDate),
        ...(pickup ? { pickup } : {}),
        ...(t ? { ticket: { validityCopy: t.validityCopy, validityConcern: t.validityConcern, types: t.types.map(ticketTypeLine) } } : {}),
      };
    }),
    link: ticketLink(e.NEXT_PUBLIC_SITE_URL, token),
    expiresLabel: dateLabel(expiresAt),
    supportEmail: e.NEXT_PUBLIC_SUPPORT_EMAIL ?? e.EMAIL_REPLY_TO,
  });
  return { ok: true, rendered, grantId };
}

const amountLabel = (currency: string, minor: bigint) => `${currency} ${(Number(minor) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Payment confirmation, rendered at send time from ids (doc 93 §3.1). The
 * attachment (O8) is the one named in the row: read through the integrity
 * check, and if it can no longer be read the message is not sent without it
 * (a retry must be identical), it fails retryably.
 */
async function preparePaymentMessage(ref: PaymentMessageRef): Promise<Prepared> {
  const order = await prisma.order.findUnique({
    where: { id: ref.orderId },
    select: {
      reference: true,
      leadName: true,
      // Only the items the capture paid for (finding 9): an item rejected or cancelled before a partial capture is not listed.
      items: {
        where: { chargedAmountMinor: { not: null }, status: { notIn: ["rejected", "cancelled"] } },
        select: { titleSnapshot: true, serviceDate: true, pax: true, quoteLineIndex: true, id: true },
        orderBy: [{ quoteLineIndex: "asc" }, { id: "asc" }],
      },
    },
  });
  const payment = await prisma.payment.findUnique({ where: { id: ref.paymentId }, select: { orderId: true, currency: true, capturedMinor: true, capturedAt: true, rail: true, method: true } });
  if (!order || !payment || payment.orderId !== ref.orderId || payment.capturedMinor <= 0n) return { ok: false, outcome: { status: "failed", retryable: false, code: "order_missing" } };
  // Re-checked at send time (finding 9): a refund that started after the row was written stops the email for good.
  if (!(await paymentEmailStillRight(ref.orderId, ref.paymentId))) return { ok: false, outcome: { status: "failed", retryable: false, code: "order_refunding" } };
  const { paxLabel } = await import("./order-status.service");
  let attachments: EmailSend["attachments"];
  let invoice: { displayNumber: string } | null = null;
  if (ref.attachGeneratedDocumentId) {
    const { readServableGenerated } = await import("./generated-document.read");
    const file = await readServableGenerated(ref.attachGeneratedDocumentId);
    if (file.kind === "unavailable" && file.reason === "switch_off") {
      // Finding 19: the fiscal switch was turned off after the row was written: the email goes without the invoice line.
      // The follow-up invoice email (INVOICE_ISSUED) sends the file once the switch is on again.
    } else if (file.kind !== "ok" || file.document.orderId !== ref.orderId || file.document.kind !== "tax_invoice" || !file.document.displayNumber) {
      return { ok: false, outcome: { status: "failed", retryable: true, code: "attachment_unavailable" } };
    } else {
      const { generatedDownloadName } = await import("../documents/download-name");
      invoice = { displayNumber: file.document.displayNumber };
      attachments = [{ filename: generatedDownloadName("tax_invoice", order.reference, file.document.displayNumber), content: file.bytes, contentType: "application/pdf" }];
    }
  }
  const e = env();
  const rendered = renderPaymentReceived({
    firstName: order.leadName.trim().split(/\s+/)[0] || undefined,
    orderReference: order.reference,
    amountLabel: amountLabel(payment.currency, payment.capturedMinor),
    paidOnLabel: (payment.capturedAt ?? new Date()).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" }),
    methodLabel: payment.rail === "aed_card" || (payment.method ?? "").toLowerCase().includes("card") ? "card" : "online payment",
    items: order.items.map((i) => ({ title: i.titleSnapshot, dateLabel: dateLabel(i.serviceDate), guests: paxLabel(i.pax) || undefined })),
    invoice,
    supportEmail: e.NEXT_PUBLIC_SUPPORT_EMAIL ?? e.EMAIL_REPLY_TO,
  });
  return { ok: true, rendered, attachments };
}

/**
 * The follow-up invoice email (finding 14), rendered at send time from ids. Suppressed while either switch is off;
 * fails definitely when the invoice is missing or not this order's (`invoice_missing`) or the order no longer holds the
 * money (`order_refunding`); fails retryably when the named file cannot be read and checked (it may be re-drawn).
 */
async function prepareInvoiceMessage(ref: InvoiceMessageRef): Promise<Prepared> {
  const e = env();
  // Both switches (re-review N5): the fiscal switch alone never starts customer email.
  if (!e.FISCAL_DOCUMENTS_ENABLED || !e.PAYMENT_RECEIVED_EMAIL_ENABLED) return { ok: false, outcome: { status: "suppressed", reason: "switch_off" } };
  const order = await prisma.order.findUnique({ where: { id: ref.orderId }, select: { reference: true, leadName: true } });
  if (!order) return { ok: false, outcome: { status: "failed", retryable: false, code: "order_missing" } };
  // Not for an order that is cancelled or being refunded (re-review N5), checked again at send time.
  const invoiceDoc = await prisma.fiscalDocument.findUnique({ where: { id: ref.fiscalDocumentId }, select: { paymentId: true, orderId: true } });
  // Re-review D9: a missing or foreign invoice is its own code, not "refunding".
  if (!invoiceDoc || invoiceDoc.orderId !== ref.orderId) return { ok: false, outcome: { status: "failed", retryable: false, code: "invoice_missing" } };
  if (!(await paymentEmailStillRight(ref.orderId, invoiceDoc.paymentId))) return { ok: false, outcome: { status: "failed", retryable: false, code: "order_refunding" } };
  const { readServableGenerated } = await import("./generated-document.read");
  const file = await readServableGenerated(ref.generatedDocumentId);
  if (file.kind !== "ok" || file.document.orderId !== ref.orderId || file.document.kind !== "tax_invoice" || !file.document.displayNumber) {
    return { ok: false, outcome: { status: "failed", retryable: true, code: "attachment_unavailable" } };
  }
  const { generatedDownloadName } = await import("../documents/download-name");
  const rendered = renderInvoiceIssued({
    firstName: order.leadName.trim().split(/\s+/)[0] || undefined,
    orderReference: order.reference,
    displayNumber: file.document.displayNumber,
    supportEmail: e.NEXT_PUBLIC_SUPPORT_EMAIL ?? e.EMAIL_REPLY_TO,
  });
  return { ok: true, rendered, attachments: [{ filename: generatedDownloadName("tax_invoice", order.reference, file.document.displayNumber), content: file.bytes, contentType: "application/pdf" }] };
}

/**
 * Guards → render → send for one claimed row. Writes nothing to the
 * notifications table; the caller records the outcome.
 */
async function attempt(row: Notification, now: Date): Promise<{ outcome: Outcome; grantId?: string }> {
  const e = env();
  const channel = row.channel;
  if (channel !== "email" && channel !== "whatsapp") return { outcome: { status: "suppressed", reason: "unsupported_channel" } };
  const isTicket = row.event === TICKETS_READY;
  const ref = isTicket ? parseTicketRef(row.payload) : null;
  if (isTicket && (!ref || channel !== "email")) return { outcome: { status: "failed", retryable: false, code: "bad_payload" } };
  const isPayment = row.event === PAYMENT_RECEIVED;
  const paymentRef = isPayment ? parsePaymentRef(row.payload) : null;
  if (isPayment && (!paymentRef || channel !== "email")) return { outcome: { status: "failed", retryable: false, code: "bad_payload" } };
  // Kill switch, checked before any send, retries included (PAYMENT_RECEIVED_EMAIL_ENABLED, default off).
  if (isPayment && !e.PAYMENT_RECEIVED_EMAIL_ENABLED) return { outcome: { status: "suppressed", reason: "switch_off" } };
  const isInvoice = row.event === INVOICE_ISSUED;
  const invoiceRef = isInvoice ? parseInvoiceRef(row.payload) : null;
  if (isInvoice && (!invoiceRef || channel !== "email")) return { outcome: { status: "failed", retryable: false, code: "bad_payload" } };
  const isAccountLink = row.event === ACCOUNT_LINK_NOTICE_EVENT;
  const linkRef = isAccountLink ? parseAccountLinkRef(row.payload) : null;
  if (isAccountLink && (!linkRef || channel !== "email")) return { outcome: { status: "failed", retryable: false, code: "bad_payload" } };
  if (!isTicket && !isPayment && !isInvoice && !isAccountLink && !supportsChannel(row.event as NotificationEvent, channel)) return { outcome: { status: "suppressed", reason: "unsupported_channel" } };

  // 1. Environment guard — staging can never message a real customer. Checked before any
  //    capability is minted, so a suppressed message creates no grant.
  if (e.isNonProduction && !isRecipientAllowed(row.recipient, e.recipientAllowlist)) {
    return { outcome: { status: "suppressed", reason: "non_production_allowlist" } };
  }

  // 2. Consent — transactional messages are legitimate; marketing needs an explicit grant.
  //    Only inquiry rows can be marketing; their purpose is not stored, so rows count as transactional.
  const consent = await latestConsent({ recipient: row.recipient, channel, purpose: "transactional" });
  if (consent && consent.granted === false) return { outcome: { status: "suppressed", reason: "opted_out" } };

  // 3. Render.
  let prepared: Prepared;
  try {
    if (ref) prepared = await prepareTicketMessage(row, ref, now);
    else if (paymentRef) prepared = await preparePaymentMessage(paymentRef);
    else if (invoiceRef) prepared = await prepareInvoiceMessage(invoiceRef);
    else if (linkRef) prepared = await prepareAccountLinkNotice(linkRef);
    else prepared = { ok: true, rendered: renderTemplate(row.event as NotificationEvent, channel, (row.payload as unknown as TemplateContext) ?? ({} as TemplateContext)) };
  } catch {
    return { outcome: { status: "failed", retryable: true, code: "render" } };
  }
  if (!prepared.ok) return { outcome: prepared.outcome };
  const { rendered, grantId, attachments } = prepared;
  const template = rendered.templateName;

  // 4. Send.
  if (channel === "email") {
    if (!rendered.subject || !rendered.html) return { outcome: { status: "failed", template, retryable: false, code: "no_email_template" }, grantId };
    const r = await emailAdapter.send({ to: row.recipient, subject: rendered.subject, html: rendered.html, text: rendered.text, ...(attachments?.length ? { attachments } : {}) }, { idempotencyKey: row.id });
    return { outcome: emailOutcome(r, template), grantId };
  }
  try {
    const r = await whatsappAdapter.send({ to: row.recipient, templateName: rendered.templateName, text: rendered.text, variables: rendered.variables ?? {} });
    return { outcome: { status: "sent", template, providerId: r.providerId, costMinor: r.costMinor } };
  } catch (error) {
    if (error instanceof WhatsAppSendError) {
      const o = error.outcome;
      const code = o.httpStatus ? `http_${o.httpStatus}` : o.reason;
      if (o.kind === "unknown") return { outcome: { status: "unknown", template, code } };
      return { outcome: { status: "failed", template, retryable: o.retryable, code, httpStatus: o.httpStatus } };
    }
    // Anything else threw before a request was made: retried in place, as before.
    return { outcome: { status: "failed", template, retryable: true, code: "provider_error" } };
  }
}

/**
 * Attempts a claimed row and records the outcome, conditional on still
 * holding the claim. A failure to record leaves the row claimed; the sweep
 * treats it as ambiguous once the claim expires.
 */
async function attemptAndRecord(row: Notification, now: Date, claimUntil: Date): Promise<DispatchResult> {
  const { outcome, grantId } = await attempt(row, now);
  try {
    if (faultAfterSend) await faultAfterSend(row.id);
    const written = await prisma.notification.updateMany({ where: { id: row.id, lockedUntil: claimUntil }, data: columnsFor(outcome, now) });
    if (written.count !== 1) {
      emitEvent("notification.unknown", { notificationId: row.id, event: row.event, channel: row.channel, reason: "claim_lost" }, "warn");
      return resultOf(row.id, "queued");
    }
  } catch {
    emitEvent("notification.unknown", { notificationId: row.id, event: row.event, channel: row.channel, reason: "record_failed" }, "error");
    return resultOf(row.id, "queued");
  }

  // The outcome is known (sent, suppressed, or definitely not sent): the kept token is no longer needed.
  const final = outcome.status === "sent" || outcome.status === "suppressed" || (outcome.status === "failed" && !outcome.retryable);
  if (final && row.event === TICKETS_READY) {
    const id = grantId ?? (await capabilityService.findForNotification(row.id).catch(() => null))?.id;
    // Sent (first attempt, or a retry of a failed, unknown or crashed one): only now does the new link replace the old (R-B4-4).
    if (id && outcome.status === "sent") await supersedeAfterSent(row, id, now);
    if (id) await capabilityService.clearCiphertext(id).catch(() => {});
  }
  const linkRef = final && row.event === ACCOUNT_LINK_NOTICE_EVENT ? parseAccountLinkRef(row.payload) : null;
  // The notice's outcome is known: the kept "not me" token is no longer needed (its hash stays for the link).
  if (linkRef) await prisma.orderAccountLink.updateMany({ where: { id: linkRef.linkId }, data: { disputeTokenCiphertext: null } }).catch(() => {});

  const base = { notificationId: row.id, event: row.event, channel: row.channel };
  switch (outcome.status) {
    case "sent":
      emitEvent("notification.sent", { ...base, provider: row.channel === "email" ? emailAdapter.provider() : "whatsapp" });
      return resultOf(row.id, "sent", { providerId: outcome.providerId });
    case "failed":
      emitEvent("notification.failed", { ...base, httpStatus: outcome.httpStatus ?? null, reason: errorCodeOf(outcome) }, "warn");
      return resultOf(row.id, "failed", { error: errorCodeOf(outcome) });
    case "unknown":
      emitEvent("notification.unknown", { ...base, reason: outcome.code }, "warn");
      return resultOf(row.id, "unknown");
    case "suppressed":
      emitEvent("notification.suppressed", { ...base, reason: outcome.reason });
      return resultOf(row.id, "suppressed");
  }
}

/**
 * The message carrying `grantId` was sent: revoke the order's older links of
 * the same purpose. Best effort: a failure leaves the older link live (the
 * same customer's, and expiring), never the new one dead.
 */
async function supersedeAfterSent(row: Notification, grantId: string, now: Date): Promise<void> {
  try {
    await capabilityService.supersedePrevious(prisma, grantId, now);
  } catch {
    emitEvent("notification.failed", { notificationId: row.id, event: row.event, channel: row.channel, reason: "supersede_failed" }, "error");
  }
}

/**
 * Step 1 of the outbox: the row, before any send. Returns the existing row
 * on a dedup conflict. `olderKeys` are the same message's dedup keys under
 * older `lookup` ring keys (R-B4-10): a row under any of them is that message.
 */
async function insertQueued(
  data: Omit<Prisma.NotificationUncheckedCreateInput, "status" | "lockedUntil" | "attempt" | "createdAt">,
  now: Date,
  olderKeys: readonly string[] = [],
): Promise<{ row: Notification; claimUntil: Date } | { duplicate: Notification }> {
  if (olderKeys.length) {
    const earlier = await prisma.notification.findFirst({ where: { dedupKey: { in: [...olderKeys] } }, orderBy: { createdAt: "asc" } });
    if (earlier) {
      emitEvent("notification.duplicate", { notificationId: earlier.id, event: earlier.event });
      return { duplicate: earlier };
    }
  }
  const claimUntil = new Date(now.getTime() + SEND_LOCK_MS);
  const id = data.id ?? uuidv7();
  // ON CONFLICT DO NOTHING on the dedup key: a duplicate is an answer, not an error.
  const inserted = await prisma.notification.createMany({ data: [{ ...data, id, status: "queued", attempt: 1, lockedUntil: claimUntil, createdAt: now }], skipDuplicates: true });
  if (inserted.count === 1) {
    const row = await prisma.notification.findUniqueOrThrow({ where: { id } });
    emitEvent("notification.queued", { notificationId: row.id, event: row.event, channel: row.channel });
    return { row, claimUntil };
  }
  const existing = data.dedupKey ? await prisma.notification.findUnique({ where: { dedupKey: data.dedupKey } }) : null;
  if (!existing) throw new Error("notification insert skipped without a matching dedup key");
  emitEvent("notification.duplicate", { notificationId: existing.id, event: existing.event });
  return { duplicate: existing };
}

async function sendTicketMessage(
  input: { ref: TicketMessageRef; recipient: string; resendOf?: string | null; resendBy?: ResendBy; keepGrantId?: string | null },
  now: Date,
): Promise<DispatchResult> {
  const { ref } = input;
  const [dedupKey, ...olderKeys] = dedupKeysFor(
    {
      event: `${TICKETS_READY}:email`,
      orderId: ref.orderId,
      orderItemId: ref.orderItemId,
      documentVersion: ref.documentVersion,
      resendOf: input.resendOf ?? null,
    },
    recipientHashes(input.recipient),
  );
  const inserted = await insertQueued(
    {
      id: uuidv7(),
      event: TICKETS_READY,
      channel: "email",
      recipient: input.recipient,
      orderId: ref.orderId,
      // Ids and the document version only: never contact data, never a token (TKT-6).
      payload: {
        kind: ref.kind,
        orderId: ref.orderId,
        orderItemId: ref.orderItemId,
        documentVersion: ref.documentVersion,
        ...(input.resendOf ? { resend: input.resendBy ?? "staff" } : {}),
        // Fix round 1 (M1): the grant the asking browser used, which this message's link must not supersede.
        // A grant id only (no contact data); read by `supersedeScope`, also on a sweep retry of this row.
        ...(input.resendOf && input.resendBy === "customer" && input.keepGrantId ? { keepGrantId: input.keepGrantId } : {}),
      },
      dedupKey,
    },
    now,
    olderKeys,
  );
  if ("duplicate" in inserted) return resultOf(inserted.duplicate.id, rowOutcome(inserted.duplicate), { duplicate: true, providerId: inserted.duplicate.providerId });
  return attemptAndRecord(inserted.row, now, inserted.claimUntil);
}

/**
 * One payment confirmation per order and recipient (doc 93 §3.1): the dedup
 * key is the event, the order and the recipient hash, so a repeated trigger
 * is a duplicate and sends nothing.
 */
async function sendPaymentMessage(input: { orderId: string; paymentId: string; recipient: string; attachGeneratedDocumentId: string | null }, now: Date): Promise<DispatchResult> {
  const [dedupKey, ...olderKeys] = dedupKeysFor({ event: `${PAYMENT_RECEIVED}:email`, orderId: input.orderId }, recipientHashes(input.recipient));
  const payload: PaymentMessageRef = { kind: "payment_message", orderId: input.orderId, paymentId: input.paymentId, attachGeneratedDocumentId: input.attachGeneratedDocumentId };
  const inserted = await insertQueued(
    { id: uuidv7(), event: PAYMENT_RECEIVED, channel: "email", recipient: input.recipient, orderId: input.orderId, payload: payload as unknown as Prisma.InputJsonValue, dedupKey },
    now,
    olderKeys,
  );
  if ("duplicate" in inserted) return resultOf(inserted.duplicate.id, rowOutcome(inserted.duplicate), { duplicate: true, providerId: inserted.duplicate.providerId });
  return attemptAndRecord(inserted.row, now, inserted.claimUntil);
}

/** One follow-up invoice email per invoice and recipient (finding 14): the dedup key names the fiscal document. */
async function sendInvoiceMessage(input: { ref: InvoiceMessageRef; recipient: string }, now: Date): Promise<DispatchResult> {
  const [dedupKey, ...olderKeys] = dedupKeysFor({ event: `${INVOICE_ISSUED}:email:${input.ref.fiscalDocumentId}`, orderId: input.ref.orderId }, recipientHashes(input.recipient));
  const inserted = await insertQueued(
    { id: uuidv7(), event: INVOICE_ISSUED, channel: "email", recipient: input.recipient, orderId: input.ref.orderId, payload: input.ref as unknown as Prisma.InputJsonValue, dedupKey },
    now,
    olderKeys,
  );
  if ("duplicate" in inserted) return resultOf(inserted.duplicate.id, rowOutcome(inserted.duplicate), { duplicate: true, providerId: inserted.duplicate.providerId });
  return attemptAndRecord(inserted.row, now, inserted.claimUntil);
}

/* ------------------------------------------------- ticket resends (A4) */

/**
 * The ticket message of every item that has a valid, customer-visible
 * tickets or voucher file, at its latest valid version (post-payment batch
 * A4: every item, not only the first). In the order `documentService`
 * lists the items.
 */
async function ticketRefsForOrder(orderId: string): Promise<TicketMessageRef[]> {
  const items = await documentService.listForOrder(orderId);
  const refs: TicketMessageRef[] = [];
  for (const item of items) {
    const valid = item.documents.filter((d) => d.status === "valid" && (d.kind === "tickets_pdf" || d.kind === "voucher_pdf"));
    if (!valid.length) continue;
    refs.push({ kind: "ticket_message", orderId, orderItemId: item.orderItemId, documentVersion: Math.max(...valid.map((d) => d.version)) });
  }
  return refs;
}

const OUTCOME_RANK: Record<OutboxOutcome, number> = { sent: 0, suppressed: 1, queued: 2, unknown: 3, failed: 4 };

/** The least good outcome of a batch (a staff resend of several items reports its weakest send). */
function worstOutcome(results: readonly DispatchResult[]): OutboxOutcome {
  return results.reduce<OutboxOutcome>((w, r) => (OUTCOME_RANK[r.outcome] > OUTCOME_RANK[w] ? r.outcome : w), "sent");
}

/** Owner decision of 27 Nov 2026: a customer may ask for the ticket email again at most 3 times per order in any 24 hours, and once per 2 minutes. */
export const CUSTOMER_RESEND_LIMITS = Object.freeze({ perDay: 3, windowMs: 24 * 3600_000, minGapMs: 2 * 60_000 });

/** The audit action that is also the customer-resend ledger (append-only, so the limit cannot be reset by deleting rows). */
export const CUSTOMER_RESEND_ACTION = "tickets.customer_resend";

export type CustomerResendResult =
  | { ok: true; availableAt: Date }
  | { ok: false; reason: "rate_limited"; availableAt: Date }
  | { ok: false; reason: "nothing_to_send" };

/**
 * Whether one more customer resend is allowed at `now`, given the times of
 * the accepted ones (any order), and when the next one is allowed. A sliding
 * 24-hour window and a minimum gap, never a fixed calendar window. Pure.
 */
export function customerResendAvailability(times: readonly Date[], now: Date): { allowed: boolean; availableAt: Date | null } {
  const L = CUSTOMER_RESEND_LIMITS;
  const t = now.getTime();
  // A ledger time a little after `now` (the database clock, or a request that committed while this one started) counts as recent.
  const recent = times.map((d) => d.getTime()).filter((x) => x > t - L.windowMs).sort((a, b) => b - a);
  let next = t;
  if (recent.length) next = Math.max(next, recent[0] + L.minGapMs);
  // With perDay accepted inside the window, the next one waits until the oldest of the newest perDay leaves it.
  if (recent.length >= L.perDay) next = Math.max(next, recent[L.perDay - 1] + L.windowMs);
  return next <= t ? { allowed: true, availableAt: null } : { allowed: false, availableAt: new Date(next) };
}

/** The times of this order's accepted customer resends in the last 24 hours, from the audit ledger. */
export async function customerResendTimes(orderId: string, now: Date = new Date(), db: Tx | typeof prisma = prisma): Promise<Date[]> {
  const rows = await db.auditLog.findMany({
    where: { entityType: "order", entityId: orderId, action: CUSTOMER_RESEND_ACTION, createdAt: { gt: new Date(now.getTime() - CUSTOMER_RESEND_LIMITS.windowMs) } },
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  return rows.map((r) => r.createdAt);
}

/* ------------------------------------------- ticket delivery state (A3) */

/** What one ticket message row says about delivery, in the words of the status contract (`TicketDeliveryState`). */
export type TicketRowDelivery = "pending" | "sent" | "delivered" | "failed" | "bounced";

/** The provider error code a verified Resend bounce writes (A8): a definite failure, never retried. */
export const BOUNCED_ERROR = "definite:bounced";

/**
 * One `TICKETS_READY` row, read as a delivery state (A3). Pure.
 *  - `delivered`/`read`: only the signed delivery webhook writes these;
 *  - `sent`: the provider accepted it (never "arrived");
 *  - `bounced`: the webhook recorded a bounce;
 *  - `failed`: definitely not sent, suppressed, or handed to our team
 *    (attention, or retries used up);
 *  - `pending`: queued, ambiguous or a retryable failure the sweep still retries.
 */
export function ticketRowDeliveryState(
  row: { status: string; providerError: string | null; attentionRequiredAt: Date | null; attempt: number; createdAt: Date },
  now: Date,
): TicketRowDelivery {
  switch (row.status) {
    case "delivered":
    case "read":
      return "delivered";
    case "sent":
      return "sent";
    case "suppressed":
      return "failed";
    case "failed": {
      if (row.providerError === BOUNCED_ERROR) return "bounced";
      const retrying = !row.providerError?.startsWith("definite:") && row.attempt < MAX_ATTEMPTS && now.getTime() - row.createdAt.getTime() < RETRY_WINDOW_MS;
      return retrying ? "pending" : "failed";
    }
    default:
      // queued or unknown: still being resolved by the sweep, unless a human now owns it.
      return row.attentionRequiredAt ? "failed" : "pending";
  }
}

/* ------------------------------------------------------------ service */

/**
 * The recipient hash for an existing (pre-B4) message, or null when the
 * `lookup` ring is missing (R-B4-3): inquiry and ops messages must keep
 * flowing on a deployment that has not set the B4 rings yet, so they lose
 * deduplication and an alert is raised instead. Ticket messages never take
 * this path; they fail closed.
 */
function recipientHashesOrNull(recipient: string): string[] | null {
  try {
    return recipientHashes(recipient);
  } catch (e) {
    if (!(e instanceof KeyUnavailableError)) throw e;
    emitEvent("keys.unavailable", { purpose: "lookup", path: "notification_dedup" }, "error");
    return null;
  }
}

/**
 * Step 1 of the attach notice (re-review 103b N4): writes the queued outbox
 * row and links it to the attach, inside the sign-in request, before the
 * response. Once the row exists, a send that never runs (the function was
 * stopped after the response) is still sent by the outbox sweep when the
 * row's claim lapses. Never throws: null when the row could not be written
 * (the link then has no row and raises `attach_notice_missing` for staff).
 */
async function queueAccountLinkNotice(input: { linkId: string; orderId: string; recipient: string }): Promise<QueuedAccountLinkNotice | { duplicate: DispatchResult } | null> {
  try {
    const now = new Date();
    const hashes = recipientHashesOrNull(input.recipient);
    const [dedupKey = null, ...olderKeys] = hashes
      ? dedupKeysFor({ event: `${ACCOUNT_LINK_NOTICE_EVENT}:email:${input.linkId}`, orderId: input.orderId, inquiryId: null, resendOf: null }, hashes)
      : [];
    const id = uuidv7();
    const inserted = await insertQueued(
      { id, event: ACCOUNT_LINK_NOTICE_EVENT, channel: "email", recipient: input.recipient, orderId: input.orderId, payload: { kind: "account_link_notice", linkId: input.linkId }, dedupKey },
      now,
      olderKeys,
    );
    if ("duplicate" in inserted) return { duplicate: resultOf(inserted.duplicate.id, rowOutcome(inserted.duplicate), { duplicate: true }) };
    await prisma.orderAccountLink.updateMany({ where: { id: input.linkId, notificationId: null }, data: { notificationId: inserted.row.id } });
    return { row: inserted.row, claimUntil: inserted.claimUntil };
  } catch {
    emitEvent("notification.failed", { event: ACCOUNT_LINK_NOTICE_EVENT, channel: "email", reason: "dispatch_failed" }, "error");
    return null;
  }
}

/** Step 2 of the attach notice: the send of a queued row, deferred until after the response. Never throws. */
async function sendQueuedAccountLinkNotice(queued: QueuedAccountLinkNotice): Promise<DispatchResult | null> {
  try {
    return await attemptAndRecord(queued.row, new Date(), queued.claimUntil);
  } catch {
    emitEvent("notification.failed", { event: ACCOUNT_LINK_NOTICE_EVENT, channel: "email", reason: "dispatch_failed" }, "error");
    return null;
  }
}

export const notificationService = {
  async dispatch(input: DispatchInput): Promise<DispatchResult> {
    const now = new Date();
    const hashes = recipientHashesOrNull(input.recipient);
    const [dedupKey = null, ...olderKeys] = hashes
      ? dedupKeysFor(
          {
            // The channel is part of the message identity; `once` scopes repeatable events.
            event: `${input.event}:${input.channel}:${input.once ?? uuidv7()}`,
            orderId: input.orderId ?? null,
            inquiryId: input.inquiryId ?? null,
            resendOf: input.resendOf ?? null,
          },
          hashes,
        )
      : [];
    const inserted = await insertQueued(
      {
        id: uuidv7(),
        event: input.event,
        channel: input.channel,
        recipient: input.recipient,
        inquiryId: input.inquiryId,
        orderId: input.orderId,
        payload: serialisableContext(input.context),
        scheduledFor: input.scheduledFor,
        dedupKey,
      },
      now,
      // Unscoped dispatches are distinct by construction: no earlier row can match.
      input.once ? olderKeys : [],
    );
    if ("duplicate" in inserted) return resultOf(inserted.duplicate.id, rowOutcome(inserted.duplicate), { duplicate: true, providerId: inserted.duplicate.providerId });
    if (input.purpose === "marketing") {
      // Marketing needs a positive grant; checked here because rows do not store the purpose.
      const consent = await latestConsent({ recipient: input.recipient, channel: input.channel, purpose: "marketing" });
      if (!consent?.granted) {
        await prisma.notification.updateMany({ where: { id: inserted.row.id, lockedUntil: inserted.claimUntil }, data: columnsFor({ status: "suppressed", reason: "no_consent" }, now) });
        emitEvent("notification.suppressed", { notificationId: inserted.row.id, event: input.event, channel: input.channel, reason: "no_consent" });
        return resultOf(inserted.row.id, "suppressed");
      }
    }
    return attemptAndRecord(inserted.row, now, inserted.claimUntil);
  },

  /**
   * Group B (owner Q10): one notice per automatic attach, to the order's
   * verified email, through the outbox (one row per link; a second call for
   * the same link is a duplicate and sends nothing). Never throws: a failed
   * notice leaves the attach in place and the row for the retry sweep.
   * The same as `queueAccountLinkNotice` then `sendQueuedAccountLinkNotice`.
   */
  async sendAccountLinkNotice(input: { linkId: string; orderId: string; recipient: string }): Promise<DispatchResult | null> {
    const queued = await queueAccountLinkNotice(input);
    if (!queued) return null;
    if ("duplicate" in queued) return queued.duplicate;
    return sendQueuedAccountLinkNotice(queued);
  },

  queueAccountLinkNotice,
  sendQueuedAccountLinkNotice,

  /* -------------------------------------------------- inquiry triggers */

  /** T+0: ack to the customer (WhatsApp + email fallback) and the ops alert (§17 §7.2 steps 6–8). */
  async onInquirySubmitted(ctx: { inquiry: InquiryDetail; agent: AgentPublic; deadline: Date; deadlineLabel: string; outOfHours: boolean }) {
    const e = env();
    // Each of these is sent once per inquiry and recipient: a repeated trigger is a duplicate.
    const base = { inquiryId: ctx.inquiry.id, context: buildContext(ctx), once: "submitted" };
    const customerAcks: DispatchResult[] = [];
    const internal: DispatchResult[] = [];

    if (ctx.inquiry.whatsappConsent) {
      customerAcks.push(await notificationService.dispatch({ ...base, event: "INQUIRY_ACK", channel: "whatsapp", recipient: ctx.inquiry.leadPhone }));
    }
    if (ctx.inquiry.leadEmail) {
      customerAcks.push(await notificationService.dispatch({ ...base, event: "INQUIRY_ACK", channel: "email", recipient: ctx.inquiry.leadEmail }));
    }
    for (const to of e.opsAlertEmails) {
      internal.push(await notificationService.dispatch({ ...base, event: "INQUIRY_OPS_ALERT", channel: "email", recipient: to }));
    }
    if (e.WHATSAPP_OPS_ALERT_NUMBER) {
      internal.push(await notificationService.dispatch({ ...base, event: "INQUIRY_OPS_ALERT", channel: "whatsapp", recipient: e.WHATSAPP_OPS_ALERT_NUMBER }));
    }
    if (ctx.agent.email) {
      internal.push(await notificationService.dispatch({ ...base, event: "INQUIRY_ASSIGNED", channel: "email", recipient: ctx.agent.email }));
    }

    // ack_sent_at means "the customer was acknowledged", not "some email went out".
    if (customerAcks.some((r) => r.status === "sent" && !r.duplicate)) {
      await prisma.inquiry.update({ where: { id: ctx.inquiry.id }, data: { ackSentAt: new Date() } }).catch(() => {});
      await analyticsService.emit({ name: "inquiry_acknowledged", inquiryId: ctx.inquiry.id, rail: "assisted", props: { inquiry_reference: ctx.inquiry.reference, out_of_hours: ctx.outOfHours } });
    }
    return [...customerAcks, ...internal];
  },

  /** An (re)assignment is a human action; each one is its own message, so no dedup scope. */
  async onInquiryAssigned(ctx: { inquiry: InquiryDetail; agent: AgentPublic; deadline: Date; deadlineLabel: string; outOfHours: boolean; reassigned: boolean }) {
    if (!ctx.agent.email) return [];
    return [
      await notificationService.dispatch({
        event: "INQUIRY_ASSIGNED",
        channel: "email",
        recipient: ctx.agent.email,
        inquiryId: ctx.inquiry.id,
        context: { ...buildContext(ctx), reassigned: ctx.reassigned },
      }),
    ];
  },

  /**
   * SLA breach: escalate to ops + a proactive "still checking" to the
   * customer — never silence (§17 §7.5). One breach per deadline: a later
   * deadline (after a reset) is a new message.
   */
  async onSlaBreach(ctx: { inquiry: InquiryDetail; agent?: AgentPublic; deadline: Date; deadlineLabel: string; outOfHours: boolean }) {
    const e = env();
    const context = buildContext({ ...ctx, agent: ctx.agent ?? fallbackAgent() });
    const once = `breach:${ctx.deadline.toISOString()}`;
    const results: DispatchResult[] = [];
    for (const to of e.opsAlertEmails) {
      results.push(await notificationService.dispatch({ event: "INQUIRY_SLA_BREACH", channel: "email", recipient: to, inquiryId: ctx.inquiry.id, context, once }));
    }
    if (ctx.inquiry.whatsappConsent) {
      results.push(await notificationService.dispatch({ event: "INQUIRY_STILL_CHECKING", channel: "whatsapp", recipient: ctx.inquiry.leadPhone, inquiryId: ctx.inquiry.id, context, once }));
    } else if (ctx.inquiry.leadEmail) {
      results.push(await notificationService.dispatch({ event: "INQUIRY_STILL_CHECKING", channel: "email", recipient: ctx.inquiry.leadEmail, inquiryId: ctx.inquiry.id, context, once }));
    }
    return results;
  },

  /**
   * Follow-up ladder rung (§17 §7.2). Consent-gated at send time. A rung is
   * one message per stage and contact anchor: the ladder restarts at stage 1
   * after every agent contact, and that new rung is a different message.
   */
  async onFollowupDue(ctx: { inquiry: InquiryDetail; agent?: AgentPublic; stage: number }) {
    const context = { ...buildContext({ ...ctx, agent: ctx.agent ?? fallbackAgent(), deadline: new Date(), deadlineLabel: "", outOfHours: false }), stage: ctx.stage };
    const once = `stage:${ctx.stage}:${ctx.inquiry.lastContactAt ?? ctx.inquiry.createdAt}`;
    const results: DispatchResult[] = [];
    if (ctx.inquiry.whatsappConsent) {
      results.push(await notificationService.dispatch({ event: "INQUIRY_FOLLOWUP", channel: "whatsapp", recipient: ctx.inquiry.leadPhone, inquiryId: ctx.inquiry.id, context, once }));
    } else if (ctx.inquiry.leadEmail) {
      results.push(await notificationService.dispatch({ event: "INQUIRY_FOLLOWUP", channel: "email", recipient: ctx.inquiry.leadEmail, inquiryId: ctx.inquiry.id, context, once }));
    }
    return results;
  },

  /** One confirmation per inquiry and booking reference. */
  async onInquiryWon(ctx: { inquiry: InquiryDetail; agent?: AgentPublic; orderReference: string }) {
    const context = { ...buildContext({ ...ctx, agent: ctx.agent ?? fallbackAgent(), deadline: new Date(), deadlineLabel: "", outOfHours: false }), orderReference: ctx.orderReference };
    const results: DispatchResult[] = [];
    if (ctx.inquiry.leadEmail) {
      results.push(await notificationService.dispatch({ event: "INQUIRY_WON", channel: "email", recipient: ctx.inquiry.leadEmail, inquiryId: ctx.inquiry.id, context, once: `won:${ctx.orderReference}` }));
    }
    return results;
  },

  /* -------------------------------------------------- payment trigger (Group C, C2) */

  /**
   * The order's payment was captured. One email to the order's lead email
   * per order (dedup), none when the order has no email. Not sent for a hold
   * that is released (no capture), nor for an order whose money is being
   * refunded (finding 9). The combined invoice is attached only when
   * FISCAL_DOCUMENTS_ENABLED is on and its file already exists (O8);
   * otherwise the email goes without it and the follow-up invoice email
   * carries the file later. Kill switch: nothing is written or sent while
   * PAYMENT_RECEIVED_EMAIL_ENABLED is not "true". Never throws.
   */
  async onPaymentCaptured(input: { orderId: string; paymentId: string }, now: Date = new Date()): Promise<DispatchResult | null> {
    if (!env().PAYMENT_RECEIVED_EMAIL_ENABLED) return null;
    try {
      const order = await prisma.order.findUnique({ where: { id: input.orderId }, select: { leadEmail: true } });
      const recipient = order?.leadEmail?.trim();
      if (!recipient) return null;
      if (!(await paymentEmailStillRight(input.orderId, input.paymentId))) return null;
      const { invoiceFileForPayment } = await import("./generated-document.read");
      const invoice = await invoiceFileForPayment(input.paymentId).catch(() => null);
      return await sendPaymentMessage({ ...input, recipient, attachGeneratedDocumentId: invoice?.generatedDocumentId ?? null }, now);
    } catch {
      emitEvent("notification.failed", { event: PAYMENT_RECEIVED, channel: "email", reason: "dispatch_error" }, "error");
      return null;
    }
  },

  /**
   * The documents-job step: every capture booked in the last
   * `PAYMENT_RECEIVED_WINDOW_MS` whose order has no payment confirmation yet,
   * and whose money is still held for the booking (finding 9), gets one. The
   * window keeps a first deploy from writing to old orders. At most `max`
   * orders and no send started after `budget.startBy` (finding 10: an email-provider
   * outage cannot eat the job's time). Kill switch:
   * PAYMENT_RECEIVED_EMAIL_ENABLED. Never throws.
   */
  async sweepPaymentReceived(
    now: Date = new Date(),
    max = 5,
    scope: { orderIds?: readonly string[] } = {},
    budget: { startBy?: number } = {},
  ): Promise<{ skipped?: "switch_off"; scanned: number; sent: number; failed: number }> {
    const summary = { scanned: 0, sent: 0, failed: 0 };
    if (!env().PAYMENT_RECEIVED_EMAIL_ENABLED) return { ...summary, skipped: "switch_off" };
    // `scope.orderIds` limits the sweep (tests on a shared database).
    const only = scope.orderIds
      ? Prisma.sql`AND l.order_id IN (${Prisma.join(scope.orderIds.length ? scope.orderIds.map((id) => Prisma.sql`${id}::uuid`) : [Prisma.sql`NULL::uuid`])})`
      : Prisma.empty;
    try {
      const since = new Date(now.getTime() - PAYMENT_RECEIVED_WINDOW_MS);
      const rows = await prisma.$queryRaw<{ order_id: string; payment_id: string }[]>`
        SELECT DISTINCT ON (l.order_id) l.order_id, l.payment_id FROM ledger_entries l
        WHERE l.book = 'customer_money' AND l.kind = 'capture' AND l.payment_id IS NOT NULL AND l.order_id IS NOT NULL
          AND l.occurred_at >= ${since} AND l.occurred_at <= ${now}
          AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.order_id = l.order_id AND n.event = ${PAYMENT_RECEIVED})
          -- Same trim as the send (re-review E2): an order with no usable lead email writes no row, so it must not be
          -- selected again every tick and hold a place.
          AND EXISTS (SELECT 1 FROM orders o WHERE o.id = l.order_id
            AND NULLIF(btrim(o.lead_email, ${JS_TRIM_CHARS}), '') IS NOT NULL)
          ${only}
        ORDER BY l.order_id, l.occurred_at ASC
        LIMIT ${max}`;
      for (const r of rows) {
        // No send starts after `startBy` (the caller leaves one send's worst case after it, finding 10).
        if (budget.startBy !== undefined && Date.now() >= budget.startBy) break;
        summary.scanned++;
        const out = await notificationService.onPaymentCaptured({ orderId: r.order_id, paymentId: r.payment_id }, now);
        if (out?.outcome === "sent") summary.sent++;
        else if (out && out.outcome !== "suppressed") summary.failed++;
      }
    } catch {
      emitEvent("notification.failed", { event: PAYMENT_RECEIVED, channel: "email", reason: "sweep_error" }, "error");
    }
    return summary;
  },

  /**
   * The documents-job step for the follow-up invoice email (finding 14; O8):
   * every valid combined invoice file whose CAPTURE was booked in the last
   * `INVOICE_ISSUED_WINDOW_MS` (re-review N5: not the numbering time, so a
   * first switch-on never mails old payments), that no payment email carried,
   * whose order still holds the money (not cancelled or refunding), and that
   * has no invoice email yet gets one, to the order's lead email. Only while
   * FISCAL_DOCUMENTS_ENABLED and PAYMENT_RECEIVED_EMAIL_ENABLED are both on. At most `max`, no send started after
   * `budget.startBy`. Never throws.
   */
  async sweepInvoiceIssued(
    now: Date = new Date(),
    max = 5,
    scope: { orderIds?: readonly string[] } = {},
    budget: { startBy?: number } = {},
  ): Promise<{ skipped?: "switch_off"; scanned: number; sent: number; failed: number }> {
    const summary = { scanned: 0, sent: 0, failed: 0 };
    const e = env();
    if (!e.FISCAL_DOCUMENTS_ENABLED || !e.PAYMENT_RECEIVED_EMAIL_ENABLED) return { ...summary, skipped: "switch_off" };
    const only = scope.orderIds
      ? Prisma.sql`AND f.order_id IN (${Prisma.join(scope.orderIds.length ? scope.orderIds.map((id) => Prisma.sql`${id}::uuid`) : [Prisma.sql`NULL::uuid`])})`
      : Prisma.empty;
    try {
      const since = new Date(now.getTime() - INVOICE_ISSUED_WINDOW_MS);
      const rows = await prisma.$queryRaw<{ order_id: string; payment_id: string; fiscal_document_id: string; generated_document_id: string; lead_email: string | null }[]>`
        SELECT f.order_id, f.payment_id, f.id AS fiscal_document_id, g.id AS generated_document_id, o.lead_email
        FROM fiscal_documents f
        JOIN generated_documents g ON g.fiscal_document_id = f.id AND g.status = 'valid'
        JOIN orders o ON o.id = f.order_id
        JOIN payments p ON p.id = f.payment_id
        JOIN ledger_entries l ON l.id = f.ledger_entry_id
        WHERE f.doc_type = 'tax_invoice' AND f.issue_reason = 'money' AND l.occurred_at >= ${since} AND l.occurred_at <= ${now}
          -- C-P2: a simplified invoice staff reissued as a full tax invoice is not mailed; staff send the full one.
          AND NOT EXISTS (SELECT 1 FROM fiscal_documents rf WHERE rf.replaces_id = f.id)
          -- Re-review D2: the skip conditions are part of the selection, so skipped orders never hold the run's places.
          -- Same test as paymentEmailStillRight (kept at send time): a lead email, a paid order, nothing refunded or refunding.
          -- Re-review E2 / review 109c N9: trims exactly the whitespace of the JS trim() used at send time (JS_TRIM_CHARS),
          -- so a whitespace-only address is never selected and then skipped while holding a place.
          AND NULLIF(btrim(o.lead_email, ${JS_TRIM_CHARS}), '') IS NOT NULL
          AND o.status::text IN (${Prisma.join([...PAYMENT_EMAIL_ORDER_STATES])})
          AND p.order_id = f.order_id AND p.captured_minor > 0 AND p.refunded_minor = 0
          AND NOT EXISTS (SELECT 1 FROM refunds r WHERE r.payment_id = f.payment_id AND r.status <> 'failed')
          AND NOT EXISTS (SELECT 1 FROM customer_remedies cr WHERE cr.order_id = f.order_id AND cr.kind = 'refund' AND cr.status IN ('pending', 'in_progress', 'completed'))
          AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.order_id = f.order_id AND n.event = ${INVOICE_ISSUED} AND n.payload->>'fiscalDocumentId' = f.id::text)
          AND NOT EXISTS (
            SELECT 1 FROM notifications n JOIN generated_documents g2 ON g2.id::text = n.payload->>'attachGeneratedDocumentId'
            WHERE n.order_id = f.order_id AND n.event = ${PAYMENT_RECEIVED} AND n.status::text NOT IN ('failed', 'suppressed') AND g2.fiscal_document_id = f.id)
          ${only}
        ORDER BY f.issued_at ASC, f.id ASC
        LIMIT ${max}`;
      for (const r of rows) {
        // No send starts after `startBy` (the caller leaves one send's worst case after it, finding 10).
        if (budget.startBy !== undefined && Date.now() >= budget.startBy) break;
        const recipient = r.lead_email?.trim();
        if (!recipient) continue;
        summary.scanned++;
        try {
          const out = await sendInvoiceMessage({ ref: { kind: "invoice_message", orderId: r.order_id, fiscalDocumentId: r.fiscal_document_id, generatedDocumentId: r.generated_document_id }, recipient }, now);
          if (out.outcome === "sent") summary.sent++;
          else if (out.outcome !== "suppressed") summary.failed++;
        } catch {
          summary.failed++;
          emitEvent("notification.failed", { event: INVOICE_ISSUED, channel: "email", reason: "dispatch_error" }, "error");
        }
      }
    } catch {
      emitEvent("notification.failed", { event: INVOICE_ISSUED, channel: "email", reason: "sweep_error" }, "error");
    }
    return summary;
  },

  /* -------------------------------------------------- ticket triggers */

  /**
   * A valid ticket document exists (called by the document service). One
   * email to the order's lead email per (order, item, document version);
   * none when the order has no email (self-service download still works,
   * F14). Never throws: a delivery problem must not undo the tickets.
   */
  async onTicketsReady(input: { orderId: string; orderItemId: string; documentVersion: number }): Promise<DispatchResult | null> {
    try {
      const order = await prisma.order.findUnique({ where: { id: input.orderId }, select: { leadEmail: true } });
      const recipient = order?.leadEmail?.trim();
      if (!recipient) return null;
      return await sendTicketMessage({ ref: { kind: "ticket_message", ...input }, recipient }, new Date());
    } catch {
      emitEvent("notification.failed", { event: TICKETS_READY, channel: "email", reason: "dispatch_error" }, "error");
      return null;
    }
  },

  /**
   * Staff resend of the tickets email (`tickets.resend`, §24.3). A new row
   * with a fresh `resendOf`, so a fresh capability is minted; the previous
   * one is revoked once the resend is `sent` (R-B4-4), so a resend the
   * provider rejects leaves the customer's current link working. Picks the
   * item's latest valid document; refuses when the order has no valid ticket
   * document or no email.
   */
  async resendTickets(actor: Actor, input: { orderId?: string; orderReference?: string; orderItemId?: string }): Promise<DispatchResult & { results: DispatchResult[] }> {
    requirePermission(actor, "tickets.resend");
    const where = input.orderId ? { id: input.orderId } : input.orderReference ? { reference: input.orderReference } : null;
    if (!where) throw Errors.notFound("Order");
    const order = await prisma.order.findUnique({ where, select: { id: true, leadEmail: true } });
    if (!order) throw Errors.notFound("Order");
    const recipient = order.leadEmail?.trim();
    if (!recipient) throw Errors.conflict("This order has no email address to send tickets to");

    // Post-payment batch A4: every item with a valid file, not only the first (a console resend of one message names its item).
    const refs = (await ticketRefsForOrder(order.id)).filter((r) => !input.orderItemId || r.orderItemId === input.orderItemId);
    if (!refs.length) throw Errors.conflict("No tickets are ready to send for this order");

    // One batch id for every item: the batch's links never supersede each other, only older links (A2).
    const batch = uuidv7();
    const now = new Date();
    // Fix round 1 (L5): each item is tried on its own, and the audit row is written whatever happened, so a
    // resend whose first message already replaced links is recorded even when a later item throws.
    const attempts: ({ ok: true; result: DispatchResult } | { ok: false; error: unknown })[] = [];
    for (const ref of refs) {
      try {
        attempts.push({ ok: true, result: await sendTicketMessage({ ref, recipient, resendOf: batch, resendBy: "staff" }, now) });
      } catch (error) {
        attempts.push({ ok: false, error });
      }
    }
    const results = attempts.flatMap((a) => (a.ok ? [a.result] : []));
    const firstOk = attempts.findIndex((a) => a.ok);
    // Field names and ids only: the audit row never holds the address (PRV-2).
    await audit(actor, "tickets.resend", { type: "order", id: order.id }, {
      after: {
        notificationId: firstOk >= 0 ? (attempts[firstOk] as { result: DispatchResult }).result.id : null,
        outcome: attempts.some((a) => !a.ok) ? "error" : worstOutcome(results),
        orderItemId: refs[0].orderItemId,
        documentVersion: refs[0].documentVersion,
        resendBatch: batch,
        items: refs.map((r, i) => {
          const a = attempts[i];
          return { notificationId: a.ok ? a.result.id : null, outcome: a.ok ? a.result.outcome : "error", orderItemId: r.orderItemId, documentVersion: r.documentVersion };
        }),
        recipientField: "orders.lead_email",
      },
    });
    // The staff route reports a failure as before; the audit row above already says which items went out.
    const thrown = attempts.find((a) => !a.ok);
    if (thrown) throw (thrown as { error: unknown }).error;
    const worst = worstOutcome(results);
    return { ...results[0], status: legacyStatus(worst), outcome: worst, results };
  },

  /**
   * Post-payment batch A4: the customer's own "send my tickets again". The
   * caller (the resend route) has already decided that this viewer may
   * download the order's tickets. Sends the ticket email again, for every
   * item with a valid file, to `orders.lead_email` only (never an address
   * from the request). Owner limit of 27 Nov 2026: at most
   * `CUSTOMER_RESEND_LIMITS.perDay` per order in any 24 hours and one per
   * `minGapMs`, decided in the order's row lock against the audit ledger so
   * two requests at once cannot both pass; the route adds a per-IP limit.
   * Any database failure throws (the route answers 5xx): the limit fails
   * closed. Each accepted request is audited (`tickets.customer_resend`) with
   * ids and counts only. The send outcomes are not returned: the route gives
   * one uniform answer, and the status page reads them from the rows.
   *
   * `keepGrantId` (fix round 1, M1): the grant the asking browser used. The
   * new links replace the item's older links as usual (A2), except that one,
   * so the asker keeps the page they asked from.
   */
  async resendTicketsForCustomer(input: { orderId: string; actor?: Actor; keepGrantId?: string | null }, now: Date = new Date()): Promise<CustomerResendResult> {
    const order = await prisma.order.findUnique({ where: { id: input.orderId }, select: { id: true, leadEmail: true } });
    const recipient = order?.leadEmail?.trim();
    if (!order || !recipient) return { ok: false, reason: "nothing_to_send" };
    const refs = await ticketRefsForOrder(order.id);
    if (!refs.length) return { ok: false, reason: "nothing_to_send" };

    const batch = uuidv7();
    const actor = input.actor ?? customerActor();
    const decision = await prisma.$transaction(async (tx) => {
      // The order row is the lock: concurrent resends for one order queue here and see each other's ledger rows.
      await tx.$queryRaw`SELECT 1 FROM orders WHERE id = ${order.id}::uuid FOR UPDATE`;
      const times = await customerResendTimes(order.id, now, tx);
      const window = customerResendAvailability(times, now);
      if (!window.allowed) return { allowed: false as const, availableAt: window.availableAt };
      await auditFieldChanges(actor, CUSTOMER_RESEND_ACTION, { type: "order", id: order.id }, {
        fields: ["notifications"],
        ids: { resendBatch: batch },
        counts: { items: refs.length },
        codes: { recipientField: "orders.lead_email" },
      }, tx);
      // This one now counts: the next is at least the minimum gap away.
      const next = customerResendAvailability([...times, now], now).availableAt ?? new Date(now.getTime() + CUSTOMER_RESEND_LIMITS.minGapMs);
      return { allowed: true as const, availableAt: next };
    }, TX_OPTIONS);
    if (!decision.allowed) {
      // Ids stay out of the log: the limit is visible in the ledger (audit rows) and the route's 429.
      log.info("tickets.customer_resend_limited", { scope: "order" });
      return { ok: false, reason: "rate_limited", availableAt: decision.availableAt ?? new Date(now.getTime() + CUSTOMER_RESEND_LIMITS.minGapMs) };
    }

    const outcomes: OutboxOutcome[] = [];
    for (const ref of refs) {
      try {
        outcomes.push((await sendTicketMessage({ ref, recipient, resendOf: batch, resendBy: "customer", keepGrantId: input.keepGrantId ?? null }, now)).outcome);
      } catch {
        // A row that could not be written or sent is the sweep's to resolve; the customer's answer does not change.
        outcomes.push("queued");
        emitEvent("notification.failed", { event: TICKETS_READY, channel: "email", reason: "customer_resend_error" }, "error");
      }
    }
    // Each message already reported itself (`notification.*`); this line carries counts only.
    log.info("tickets.customer_resend", { items: refs.length, sent: outcomes.filter((o) => o === "sent").length });
    return { ok: true, availableAt: decision.availableAt };
  },

  /* ------------------------------------------------------------ console */

  /** Manual resend from the console. A new decision, so a new row + audit entry. */
  async resend(actor: Actor, notificationId: string) {
    const n = await prisma.notification.findUnique({ where: { id: notificationId } });
    if (!n) {
      requirePermission(actor, "notifications.resend");
      throw Errors.notFound("Notification");
    }
    if (n.event === TICKETS_READY) {
      // Never replays a stored message: a ticket resend mints a fresh capability (TKT-6).
      const ref = parseTicketRef(n.payload);
      if (!ref) throw Errors.conflict("This ticket message cannot be resent");
      return notificationService.resendTickets(actor, { orderId: ref.orderId, orderItemId: ref.orderItemId });
    }
    requirePermission(actor, "notifications.resend");
    // A payment confirmation is rendered from ids and sent once per order; it is not replayed from the console.
    if (n.event === PAYMENT_RECEIVED || n.event === INVOICE_ISSUED) throw Errors.conflict("A payment confirmation cannot be resent");
    // Ownership mirrors the inquiry *update* rule (§13.3): resending messages a
    // customer, so reading every inquiry (`view_all`, which every agent holds)
    // is not enough. Leads/ops (`inquiries.assign`) may resend anything; an
    // agent only on inquiries assigned to them. Messages with no inquiry
    // (order or ops alerts) are lead/ops only.
    if (!hasPermission(actor, "inquiries.assign")) {
      const owner = n.inquiryId ? await prisma.inquiry.findUnique({ where: { id: n.inquiryId }, select: { assignedAgentId: true } }) : null;
      if (!owner || !actor.id || owner.assignedAgentId !== actor.id) throw Errors.forbidden("inquiries.assign");
    }
    if (n.channel !== "email" && n.channel !== "whatsapp") throw Errors.conflict("Only email and WhatsApp can be resent");
    const result = await notificationService.dispatch({
      event: n.event as NotificationEvent,
      channel: n.channel,
      recipient: n.recipient,
      inquiryId: n.inquiryId ?? undefined,
      orderId: n.orderId ?? undefined,
      context: (n.payload as unknown as TemplateContext) ?? {},
      resendOf: uuidv7(),
      once: "resend",
    });
    await audit(actor, "notification.resend", { type: "notification", id: notificationId }, { after: { newId: result.id, status: result.status } });
    return result;
  },

  /**
   * The outbox sweep, called by the inquiry sweep job.
   *
   *  - `failed` rows that are retryable (`provider_error` not `definite:`),
   *    younger than 24 h and under MAX_ATTEMPTS: re-attempted in place.
   *  - `unknown` rows, and `queued` rows whose claim expired (a crash between
   *    send and record): re-sent under the same idempotency key with an
   *    identical body while inside IDEMPOTENCY_WINDOW_MS and under
   *    MAX_ATTEMPTS; otherwise flagged `attention_required_at` and never
   *    re-sent automatically. WhatsApp rows have no provider key, so an
   *    ambiguous one is flagged at once.
   *
   * Idempotent under concurrent sweeps: each row is claimed with a
   * conditional update (status, attempt and an expired claim), so two
   * overlapping runs cannot both send it. `scope.ids` limits the sweep to
   * those rows (a console "retry this message", and tests on a shared database).
   */
  async retryFailed(limit = 50, now: Date = new Date(), scope: { ids?: readonly string[] } = {}) {
    const unlocked = { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] };
    const rows = await prisma.notification.findMany({
      where: {
        AND: [
          unlocked,
          ...(scope.ids ? [{ id: { in: [...scope.ids] } }] : []),
          {
            OR: [
              {
                status: "failed",
                attempt: { lt: MAX_ATTEMPTS },
                createdAt: { gt: new Date(now.getTime() - RETRY_WINDOW_MS) },
                OR: [{ providerError: null }, { NOT: { providerError: { startsWith: "definite:" } } }],
              },
              { status: "unknown", attentionRequiredAt: null },
              { status: "queued", attentionRequiredAt: null, OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }] },
            ],
          },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    let retried = 0;
    let stillFailing = 0;
    let unknown = 0;
    let attention = 0;
    for (const n of rows) {
      const ambiguous = n.status === "unknown" || n.status === "queued";
      const claimWhere = { id: n.id, status: n.status, attempt: n.attempt, ...unlocked };

      // WhatsApp has no provider idempotency key: any re-send of an ambiguous row could be a second message.
      const noProviderKey = n.channel === "whatsapp";
      if (ambiguous && (noProviderKey || now.getTime() - n.createdAt.getTime() > IDEMPOTENCY_WINDOW_MS || n.attempt >= MAX_ATTEMPTS)) {
        // Past the provider's memory of the key (or none exists): a re-send could be a second message. A human decides.
        const flagged = await prisma.notification.updateMany({
          where: claimWhere,
          data: { status: "unknown", attentionRequiredAt: now, lockedUntil: null, providerError: n.providerError ?? "unknown:unrecorded" },
        });
        if (flagged.count === 1) {
          attention++;
          const reason = noProviderKey ? "no_provider_idempotency" : n.attempt >= MAX_ATTEMPTS ? "attempts_exhausted" : "idempotency_window_passed";
          emitEvent("notification.attention", { notificationId: n.id, event: n.event, reason }, "warn");
          if (n.event === TICKETS_READY) {
            const grant = await capabilityService.findForNotification(n.id);
            if (grant) await capabilityService.clearCiphertext(grant.id).catch(() => {});
          }
        }
        continue;
      }

      const claimUntil = new Date(now.getTime() + SEND_LOCK_MS);
      const claim = await prisma.notification.updateMany({ where: claimWhere, data: { attempt: { increment: 1 }, lockedUntil: claimUntil } });
      if (claim.count === 0) continue; // another sweep got here first

      const result = await attemptAndRecord({ ...n, attempt: n.attempt + 1, lockedUntil: claimUntil }, now, claimUntil);
      if (ambiguous && result.outcome === "sent") emitEvent("notification.reconciled", { notificationId: n.id, outcome: "sent" });
      if (result.outcome === "sent") retried++;
      else if (result.outcome === "failed") stillFailing++;
      else if (result.outcome === "unknown" || result.outcome === "queued") unknown++;
    }
    return { scanned: rows.length, retried, stillFailing, unknown, attention };
  },
};

function fallbackAgent(): AgentPublic {
  return { id: "team", name: "The OUTLYY team", initials: "OT", role: "Dubai trip specialists", languages: ["English", "Hindi"], shift: "IST" };
}

export function buildContext(ctx: { inquiry: InquiryDetail; agent: AgentPublic; deadline: Date; deadlineLabel: string; outOfHours: boolean }): TemplateContext {
  const e = env();
  const i = ctx.inquiry;
  return {
    reference: i.reference,
    leadName: i.leadName,
    leadFirstName: i.leadName.trim().split(/\s+/)[0] || i.leadName,
    leadPhone: i.leadPhone,
    leadEmail: i.leadEmail,
    agentName: ctx.agent.name,
    agentFirstName: ctx.agent.name.trim().split(/\s+/)[0] || ctx.agent.name,
    agentRole: ctx.agent.role,
    deadlineIso: ctx.deadline.toISOString(),
    deadlineLabel: ctx.deadlineLabel,
    outOfHours: ctx.outOfHours,
    items: i.items.map((it) => ({ title: it.title, date: it.date, time: it.time, pax: it.pax, indicativeTotalInr: it.indicativeTotal.inr })),
    itemCount: i.items.length,
    travelDateFrom: i.travelDateFrom,
    datesFlexible: i.datesFlexible,
    guests: i.guests,
    dietary: i.dietary,
    hotel: i.hotel,
    specialRequests: i.specialRequests,
    budgetBand: i.budgetBand,
    indicativeTotalInr: i.indicativeTotal.inr,
    currency: i.currency,
    source: i.source,
    siteUrl: e.NEXT_PUBLIC_SITE_URL,
    consoleUrl: `${e.NEXT_PUBLIC_SITE_URL}/admin/inquiries/${i.id}`,
    whatsappNumber: e.NEXT_PUBLIC_WHATSAPP_NUMBER,
    supportEmail: e.NEXT_PUBLIC_SUPPORT_EMAIL ?? e.EMAIL_REPLY_TO,
  };
}
