import "server-only";
import { Prisma, type Notification } from "@prisma/client";
import { prisma } from "../lib/db";
import { env } from "../lib/env";
import { uuidv7 } from "../lib/ids";
import type { Actor } from "../lib/actor";
import { hasPermission, requirePermission } from "../lib/actor";
import { audit } from "../lib/audit";
import { Errors } from "../lib/errors";
import { hmacCandidates, KeyUnavailableError } from "../lib/crypto";
import { emitEvent } from "../lib/structured-events";
import { analyticsService } from "./analytics.service";
import { capabilityService } from "./capability.service";
import { documentService } from "./document.service";
import { ticketFactsForOrder } from "./ticket-facts.service";
import { ticketTypeLine } from "@/lib/ticket-validity";
import type { AgentPublic, InquiryDetail } from "./inquiry.types";
import { dedupKeyOf, type CapabilityIssuedFor, type TicketMessageRef } from "../documents/contracts";
import {
  renderTemplate,
  renderTicketsReady,
  supportsChannel,
  ticketLink,
  type NotificationEvent,
  type Rendered,
  type TemplateContext,
  type TicketNotificationEvent,
} from "../notifications/templates";
import { emailAdapter, type EmailOutcome } from "../notifications/email.adapter";
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

type SuppressedReason = "non_production_allowlist" | "opted_out" | "no_consent" | "unsupported_channel";

/** Outcome of one attempt, before it is recorded. `code` is a short machine code, never provider text. */
type Outcome =
  | { status: "sent"; template?: string; providerId: string; costMinor?: bigint }
  | { status: "failed"; template?: string; retryable: boolean; code: string; httpStatus?: number | null }
  | { status: "unknown"; template?: string; code: string }
  | { status: "suppressed"; template?: string; reason: SuppressedReason };

const TICKETS_READY: TicketNotificationEvent = "TICKETS_READY";

/** Attempts per row for retryable failures and for ambiguous (`unknown`, stale `queued`) rows. */
const MAX_ATTEMPTS = 4;
/** Retryable failures are retried for this long after the row was created. */
const RETRY_WINDOW_MS = 24 * 3600_000;
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

function parseTicketRef(payload: unknown): TicketMessageRef | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const uuid = /^[0-9a-f-]{36}$/;
  if (p.kind !== "ticket_message" || typeof p.orderId !== "string" || typeof p.orderItemId !== "string" || typeof p.documentVersion !== "number") return null;
  if (!uuid.test(p.orderId) || !uuid.test(p.orderItemId) || !Number.isInteger(p.documentVersion) || p.documentVersion < 1) return null;
  return { kind: "ticket_message", orderId: p.orderId, orderItemId: p.orderItemId, documentVersion: p.documentVersion };
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

type Prepared = { ok: true; rendered: Rendered; grantId?: string } | { ok: false; outcome: Outcome };

/** Ticket message, rendered at send time from ids (TKT-6). Mints the row's capability on the first attempt. */
async function prepareTicketMessage(row: Notification, ref: TicketMessageRef, now: Date): Promise<Prepared> {
  const order = await prisma.order.findUnique({
    where: { id: ref.orderId },
    select: { reference: true, leadName: true, items: { where: { id: ref.orderItemId }, select: { titleSnapshot: true, serviceDate: true } } },
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
    const issuedFor: CapabilityIssuedFor = row.dedupKey?.includes("|resend:") ? "staff_resend" : "ticket_notification";
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
      return { title: i.titleSnapshot, dateLabel: dateLabel(i.serviceDate), ...(t ? { ticket: { validityCopy: t.validityCopy, types: t.types.map(ticketTypeLine) } } : {}) };
    }),
    link: ticketLink(e.NEXT_PUBLIC_SITE_URL, token),
    expiresLabel: dateLabel(expiresAt),
    supportEmail: e.NEXT_PUBLIC_SUPPORT_EMAIL ?? e.EMAIL_REPLY_TO,
  });
  return { ok: true, rendered, grantId };
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
  if (!isTicket && !supportsChannel(row.event as NotificationEvent, channel)) return { outcome: { status: "suppressed", reason: "unsupported_channel" } };

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
    else prepared = { ok: true, rendered: renderTemplate(row.event as NotificationEvent, channel, (row.payload as unknown as TemplateContext) ?? ({} as TemplateContext)) };
  } catch {
    return { outcome: { status: "failed", retryable: true, code: "render" } };
  }
  if (!prepared.ok) return { outcome: prepared.outcome };
  const { rendered, grantId } = prepared;
  const template = rendered.templateName;

  // 4. Send.
  if (channel === "email") {
    if (!rendered.subject || !rendered.html) return { outcome: { status: "failed", template, retryable: false, code: "no_email_template" }, grantId };
    const r = await emailAdapter.send({ to: row.recipient, subject: rendered.subject, html: rendered.html, text: rendered.text }, { idempotencyKey: row.id });
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

async function sendTicketMessage(input: { ref: TicketMessageRef; recipient: string; resendOf?: string | null }, now: Date): Promise<DispatchResult> {
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
      payload: { kind: ref.kind, orderId: ref.orderId, orderItemId: ref.orderItemId, documentVersion: ref.documentVersion },
      dedupKey,
    },
    now,
    olderKeys,
  );
  if ("duplicate" in inserted) return resultOf(inserted.duplicate.id, rowOutcome(inserted.duplicate), { duplicate: true, providerId: inserted.duplicate.providerId });
  return attemptAndRecord(inserted.row, now, inserted.claimUntil);
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
  async resendTickets(actor: Actor, input: { orderId?: string; orderReference?: string; orderItemId?: string }): Promise<DispatchResult> {
    requirePermission(actor, "tickets.resend");
    const where = input.orderId ? { id: input.orderId } : input.orderReference ? { reference: input.orderReference } : null;
    if (!where) throw Errors.notFound("Order");
    const order = await prisma.order.findUnique({ where, select: { id: true, leadEmail: true } });
    if (!order) throw Errors.notFound("Order");
    const recipient = order.leadEmail?.trim();
    if (!recipient) throw Errors.conflict("This order has no email address to send tickets to");

    const items = await documentService.listForOrder(order.id);
    let ref: TicketMessageRef | null = null;
    for (const item of items) {
      if (input.orderItemId && item.orderItemId !== input.orderItemId) continue;
      const valid = item.documents.filter((d) => d.status === "valid");
      if (!valid.length) continue;
      const version = Math.max(...valid.map((d) => d.version));
      ref = { kind: "ticket_message", orderId: order.id, orderItemId: item.orderItemId, documentVersion: version };
      break;
    }
    if (!ref) throw Errors.conflict("No tickets are ready to send for this order");

    const result = await sendTicketMessage({ ref, recipient, resendOf: uuidv7() }, new Date());
    // Field names and ids only: the audit row never holds the address (PRV-2).
    await audit(actor, "tickets.resend", { type: "order", id: order.id }, {
      after: { notificationId: result.id, outcome: result.outcome, orderItemId: ref.orderItemId, documentVersion: ref.documentVersion, recipientField: "orders.lead_email" },
    });
    return result;
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
