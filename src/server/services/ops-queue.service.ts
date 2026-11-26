import "server-only";
import type { NotificationStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma, TX_OPTIONS, type Tx } from "../lib/db";
import { Errors } from "../lib/errors";
import { env } from "../lib/env";
import { hmacFor } from "../lib/crypto";
import { auditFieldChanges } from "../lib/audit";
import { hasPermission, requirePermission, type Actor } from "../lib/actor";
import type { Permission } from "../lib/permissions";
import { maskPhone } from "@/lib/phone";
import { getDocumentStore } from "../documents/store";
import { TravelDeskDocumentSource } from "../suppliers/traveldesk/traveldesk.documents";
import { traveldeskConfigFrom } from "../suppliers/traveldesk/traveldesk.config";
import type { PrivilegedOperation } from "../suppliers/booking-port";
import { APPROVAL_TTL_MS, approvalService, OPERATION_PERMISSION, privilegedPayloadHash, type ApprovalEnvironment } from "./approval.service";
import { refundSettledElsewhere, revokeCheckoutAccessIfOrderEnded } from "./cancellation.service";
import { documentService, type DocumentDeps } from "./document.service";
import { ATTENTION_HOLDS_STATES, supplierBookingService } from "./supplier-booking.service";

/**
 * Operations console queues and staff actions for instant bookings (doc 22
 * §23 B5, R-B4-5). Read-only views of stored state, plus three narrow staff
 * actions. Nothing here moves money or sends a supplier mutation.
 *
 * Who sees what (every rule is enforced here, not only in the page):
 *  - The queues and the order detail need `orders.view_all` (OPS_QUEUE_PERMISSION).
 *  - Customer contact (name, phone, email, guest name, notification
 *    recipient) is returned only to holders of `customers.view_pii`;
 *    everyone else gets a masked phone and no name or email.
 *  - Net costs (`expected_net_*`, `charged_net_*`, `net_cost_aed`, margin
 *    snapshots, the supplier wallet ledger, and supplier error messages,
 *    which can quote net figures) are not even selected without
 *    `suppliers.costs.view`.
 *
 * Staff actions:
 *  - `deliberateRead` and `requestRefetch` (tickets, `tickets.resend`) go
 *    through document.service with the documents job's own wiring.
 *  - `requestResolution` / `approveResolution`: the privileged resolution
 *    (`booking.privileged_resolution`, step-up TOTP and, in production, a
 *    second approver). It only clears one attention flag, closes an open
 *    exception cancellation request, or closes a `refund_failed` request
 *    whose money the provider shows refunded another way (R-B5-2; it moves
 *    no money and is refused unless `refundSettledElsewhere` holds, checked
 *    again when applied). The evidence reference is kept only as
 *    a keyed hash: `privileged_approvals.payload` stores the payload as
 *    given, so the text itself never goes into it.
 */

export const OPS_QUEUE_PERMISSION: Permission = "orders.view_all";
const COSTS_PERMISSION: Permission = "suppliers.costs.view";
const PII_PERMISSION: Permission = "customers.view_pii";
const RESOLUTION: PrivilegedOperation = "booking.privileged_resolution";

/** A paid order still not confirmed after this long is queued (saga or awaiting-payment booking). */
export const PAID_UNCONFIRMED_AFTER_MS = 10 * 60_000;
/** A confirm in flight longer than this is long-running (the TravelDesk mutation timeout is at most 150 s). */
export const CONFIRMING_LONG_MS = 5 * 60_000;
export const QUEUE_PAGE_SIZE = 10;
export const QUEUE_MAX_PAGE_SIZE = 25;
/** Merged queues read `page * size` rows from each source, so pages are capped. */
export const QUEUE_MAX_PAGE = 20;

export const QUEUES = ["paid_unconfirmed", "unknown_outcome", "missing_ticket", "refunds", "attention"] as const;
export type QueueKey = (typeof QUEUES)[number];

export type QueueSource = "supplier_booking" | "payment_saga" | "supplier_document" | "notification" | "cancellation_request" | "refund" | "remedy";
export type QueueTone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

export interface QueueContact {
  /** Null when masked. */
  name: string | null;
  /** Masked unless the caller holds `customers.view_pii`. */
  phone: string;
  email: string | null;
  masked: boolean;
}

export interface QueueRow {
  /** `<source>:<id>`, unique across a queue. */
  key: string;
  source: QueueSource;
  id: string;
  orderId: string | null;
  orderReference: string | null;
  orderItemId: string | null;
  itemTitle: string | null;
  /** YYYY-MM-DD, or null when the row has no item. */
  serviceDate: string | null;
  /** UTC ISO instant the row's age counts from. */
  since: string;
  state: string;
  stateLabel: string;
  tone: QueueTone;
  /** A short stored code (error code, document kind, notification event), never free text. */
  detail: string | null;
  attention: boolean;
  contact: QueueContact | null;
  /** The order detail section for this row, or null without an order. */
  href: string | null;
}

export interface QueuePage {
  queue: QueueKey;
  rows: QueueRow[];
  total: number;
  page: number;
  pageSize: number;
}

/* ---------------------------------------------------------------------------
 * Pure helpers (unit-tested)
 * ------------------------------------------------------------------------ */

const LABELS: Record<string, { label: string; tone: QueueTone }> = {
  // supplier bookings
  "supplier_booking:queued": { label: "Waiting to reserve", tone: "info" },
  "supplier_booking:reserving": { label: "Reserving", tone: "info" },
  "supplier_booking:reserved": { label: "Reserved", tone: "info" },
  "supplier_booking:awaiting_payment": { label: "Reserved, waiting for payment", tone: "warning" },
  "supplier_booking:confirming": { label: "Confirming", tone: "warning" },
  "supplier_booking:awaiting_external": { label: "Operator confirming", tone: "info" },
  "supplier_booking:confirmed": { label: "Confirmed", tone: "success" },
  "supplier_booking:outcome_unknown": { label: "Outcome unknown", tone: "danger" },
  "supplier_booking:not_found_unresolved": { label: "Sent, not found yet", tone: "danger" },
  "supplier_booking:cancel_unverified": { label: "Cancel not verified", tone: "danger" },
  "supplier_booking:cancelling": { label: "Cancelling", tone: "warning" },
  "supplier_booking:cancelled": { label: "Cancelled", tone: "neutral" },
  "supplier_booking:cancel_refused": { label: "Cancel refused", tone: "danger" },
  "supplier_booking:manual_review": { label: "Manual review", tone: "danger" },
  "supplier_booking:not_created": { label: "Not created", tone: "neutral" },
  "supplier_booking:rejected": { label: "Rejected", tone: "neutral" },
  "supplier_booking:expired": { label: "Expired", tone: "neutral" },
  // payment sagas
  "payment_saga:captured": { label: "Paid, booking not started", tone: "warning" },
  "payment_saga:reserve_pending": { label: "Paid, reserving", tone: "warning" },
  "payment_saga:reserved": { label: "Paid, reserved", tone: "warning" },
  "payment_saga:confirm_pending": { label: "Paid, confirming", tone: "warning" },
  "payment_saga:capture_unknown": { label: "Capture outcome unknown", tone: "danger" },
  "payment_saga:attention": { label: "Payment needs attention", tone: "danger" },
  "payment_saga:fulfilled": { label: "Fulfilled", tone: "success" },
  "payment_saga:released": { label: "Released", tone: "neutral" },
  "payment_saga:refunded": { label: "Refunded", tone: "neutral" },
  "payment_saga:failed": { label: "Payment failed", tone: "neutral" },
  // documents
  "supplier_document:pending": { label: "Ticket pending", tone: "warning" },
  "supplier_document:incomplete": { label: "Ticket incomplete", tone: "warning" },
  "supplier_document:failed": { label: "Ticket failed", tone: "danger" },
  "supplier_document:quarantined": { label: "Ticket quarantined", tone: "danger" },
  "supplier_document:valid": { label: "Ticket ready", tone: "success" },
  "supplier_document:superseded": { label: "Superseded", tone: "neutral" },
  // notifications
  "notification:unknown": { label: "Send outcome unknown", tone: "danger" },
  "notification:failed": { label: "Send failed", tone: "danger" },
  "notification:queued": { label: "Queued", tone: "info" },
  "notification:sent": { label: "Sent", tone: "success" },
  "notification:delivered": { label: "Delivered", tone: "success" },
  // cancellation requests
  "cancellation_request:requested": { label: "Cancellation requested", tone: "info" },
  "cancellation_request:cancelling": { label: "Cancelling with operator", tone: "info" },
  "cancellation_request:cancel_unverified": { label: "Cancel not verified", tone: "danger" },
  "cancellation_request:refund_pending": { label: "Refund pending", tone: "info" },
  "cancellation_request:refunded": { label: "Refunded", tone: "success" },
  "cancellation_request:refused": { label: "Cancellation refused", tone: "neutral" },
  "cancellation_request:refund_failed": { label: "Refund failed", tone: "danger" },
  "cancellation_request:exception_open": { label: "Exception request open", tone: "accent" },
  "cancellation_request:exception_closed": { label: "Exception request closed", tone: "neutral" },
  // refunds and remedies
  "refund:failed": { label: "Refund failed", tone: "danger" },
  "refund:unknown": { label: "Refund outcome unknown", tone: "danger" },
  "refund:requested": { label: "Refund requested", tone: "info" },
  "refund:accepted": { label: "Refund accepted", tone: "info" },
  "refund:succeeded": { label: "Refunded", tone: "success" },
  "remedy:failed": { label: "Remedy failed", tone: "danger" },
  "remedy:pending": { label: "Remedy pending", tone: "info" },
  "remedy:in_progress": { label: "Remedy in progress", tone: "info" },
  "remedy:completed": { label: "Remedy completed", tone: "success" },
};

/** A state as text plus a tone; never only a colour (a11y criterion 4). Unknown states read as their code. */
export function stateLabel(source: QueueSource, state: string): { label: string; tone: QueueTone } {
  return LABELS[`${source}:${state}`] ?? { label: state.replace(/_/g, " "), tone: "neutral" };
}

/** Page and size from untrusted input, within the queue limits. */
export function pageWindow(page: unknown, pageSize: unknown): { page: number; pageSize: number } {
  const p = Math.trunc(Number(page));
  const s = Math.trunc(Number(pageSize));
  return {
    page: Number.isFinite(p) ? Math.min(Math.max(p, 1), QUEUE_MAX_PAGE) : 1,
    pageSize: Number.isFinite(s) && s > 0 ? Math.min(s, QUEUE_MAX_PAGE_SIZE) : QUEUE_PAGE_SIZE,
  };
}

/**
 * One page of several sources merged oldest first. Each source returns its
 * own rows oldest first; reading `page * size` from each is enough for the
 * merged page to be exact.
 */
export function mergeRows(lists: QueueRow[][], page: number, pageSize: number): QueueRow[] {
  const all = lists.flat().sort((a, b) => a.since.localeCompare(b.since) || a.key.localeCompare(b.key));
  return all.slice((page - 1) * pageSize, page * pageSize);
}

/** Contact for staff without `customers.view_pii`: no name or email, the phone with its last four digits only. */
export function maskedContact(phone: string | null): QueueContact {
  return { name: null, phone: phone ? maskPhone(phone) : "—", email: null, masked: true };
}

/** A notification recipient as staff without `customers.view_pii` may see it. */
export function maskRecipient(recipient: string): string {
  if (recipient.includes("@")) {
    const [user, domain] = recipient.split("@");
    return `${user.slice(0, 1)}•••@${domain ?? ""}`;
  }
  return recipient.startsWith("+") ? maskPhone(recipient) : "•••";
}

/** The order detail section of an item (`/admin/bookings/<reference>#item-<id>`). */
export function detailHref(reference: string | null, orderItemId: string | null): string | null {
  if (!reference) return null;
  const base = `/admin/bookings/${encodeURIComponent(reference)}`;
  return orderItemId ? `${base}#item-${orderItemId}` : base;
}

/* ---- privileged resolution rules ---- */

export const ATTENTION_TARGETS = ["supplier_booking", "payment_saga", "supplier_document", "notification", "cancellation_request"] as const;
export type AttentionTarget = (typeof ATTENTION_TARGETS)[number];

/** Why staff cleared an attention flag. A fixed list: the audit keeps the code, never free text. */
export const CLEAR_REASONS = ["verified_with_operator", "verified_with_provider", "customer_informed", "handled_offline", "raised_in_error", "late_acceptance_resolved"] as const;
export type ClearReason = (typeof CLEAR_REASONS)[number];
export const CLEAR_REASON_LABELS: Record<ClearReason, string> = {
  verified_with_operator: "Checked with the operator",
  verified_with_provider: "Checked with the payment provider",
  customer_informed: "Customer contacted and informed",
  handled_offline: "Handled outside the system",
  raised_in_error: "Raised in error",
  late_acceptance_resolved: "Late acceptance resolved (duplicate settled)",
};
/**
 * R-B5-16: the only reason that lifts the CR-B1-10 hold of a late-accepted
 * booking, and only for a booking, once the engine finds it settled
 * (`supplierBookingService.lateAcceptanceSettled`).
 */
export const LATE_ACCEPTANCE_RESOLVED: ClearReason = "late_acceptance_resolved";

export const EXCEPTION_OUTCOMES = ["declined", "handled_offline"] as const;
export type ExceptionOutcome = (typeof EXCEPTION_OUTCOMES)[number];

/**
 * R-B5-2: how a `refund_failed` request is closed by staff. One outcome: the
 * provider shows the item's money refunded outside this request's refund (for
 * example from the provider dashboard). It ends the request `refunded`. A
 * refund the provider cannot show (bank transfer, credit) has no close path
 * yet; that needs an owner decision.
 */
export const REFUND_FAILED_OUTCOMES = ["refunded_at_provider"] as const;
export type RefundFailedOutcome = (typeof REFUND_FAILED_OUTCOMES)[number];

export const REFETCH_REASONS = ["customer_reported", "content_wrong", "missing_pages", "staff_check"] as const;
export type RefetchReason = (typeof REFETCH_REASONS)[number];

export const EVIDENCE_MAX = 120;

/**
 * Supplier booking states whose attention flag holds an automatic money step
 * (`ATTENTION_HOLDS_STATES`, owned by the booking engine, which also makes the
 * write). Clearing it there would let the console start that step, so it is
 * refused: B5 moves no money from the console.
 */
const BOOKING_STATES_ATTENTION_HOLDS: readonly string[] = ATTENTION_HOLDS_STATES;
/** Saga states where an attention flag no longer gates anything (payments/saga.ts TERMINAL). */
const SAGA_STATES_CLEARABLE = ["fulfilled", "refunded", "released", "failed", "attention"];
/** An unknown or queued notification with its flag cleared would be retried by the sender. */
const NOTIFICATION_STATES_ATTENTION_HOLDS: NotificationStatus[] = ["unknown", "queued"];

/** Whether clearing this row's attention flag is in scope (no money step, no re-send follows). Null when allowed. */
export function clearAttentionRefusal(
  target: AttentionTarget,
  row: { state: string; attentionAt: Date | null; orderId: string | null; closed?: boolean; lateAccepted?: boolean; lateSettled?: boolean },
  reasonCode?: ClearReason,
): string | null {
  if (!row.attentionAt) return "not_flagged";
  if (!row.orderId) return "no_order";
  const lateResolved = reasonCode === LATE_ACCEPTANCE_RESOLVED;
  if (lateResolved && (target !== "supplier_booking" || !row.lateAccepted)) return "reason_not_applicable";
  if (target === "supplier_booking" && BOOKING_STATES_ATTENTION_HOLDS.includes(row.state)) return "holds_money_step";
  // R-B5-6: after a late acceptance the flag is the CR-B1-10 hold, whatever the state. R-B5-16: the dedicated
  // reason lifts it once the booking is settled (a supplier read shows it ended, or it is confirmed and the item's only live attempt).
  if (target === "supplier_booking" && row.lateAccepted && !(lateResolved && row.lateSettled)) return "late_acceptance_hold";
  if (target === "payment_saga" && !SAGA_STATES_CLEARABLE.includes(row.state)) return "holds_money_step";
  if (target === "notification" && (NOTIFICATION_STATES_ATTENTION_HOLDS as string[]).includes(row.state)) return "holds_resend";
  if (target === "cancellation_request" && row.closed) return "closed";
  return null;
}

export const resolutionInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("clear_attention"),
      target: z.enum(ATTENTION_TARGETS),
      targetId: z.uuid(),
      reasonCode: z.enum(CLEAR_REASONS),
      evidence: z.string().trim().min(3, "Give an evidence reference").max(EVIDENCE_MAX, `At most ${EVIDENCE_MAX} characters`),
    })
    .strict(),
  z
    .object({
      action: z.literal("close_exception"),
      targetId: z.uuid(),
      outcome: z.enum(EXCEPTION_OUTCOMES),
      evidence: z.string().trim().min(3, "Give an evidence reference").max(EVIDENCE_MAX, `At most ${EVIDENCE_MAX} characters`),
    })
    .strict(),
  z
    .object({
      action: z.literal("close_refund_failed"),
      targetId: z.uuid(),
      outcome: z.enum(REFUND_FAILED_OUTCOMES),
      evidence: z.string().trim().min(3, "Give an evidence reference").max(EVIDENCE_MAX, `At most ${EVIDENCE_MAX} characters`),
    })
    .strict(),
]);
export type ResolutionInput = z.infer<typeof resolutionInputSchema>;

/** The approval payload: ids, codes, a keyed hash of the evidence and the state it was asked against. */
const payloadSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("clear_attention"),
      target: z.enum(ATTENTION_TARGETS),
      targetId: z.uuid(),
      orderId: z.uuid(),
      reasonCode: z.enum(CLEAR_REASONS),
      evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
      attentionAt: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("close_exception"),
      target: z.literal("cancellation_request"),
      targetId: z.uuid(),
      orderId: z.uuid(),
      outcome: z.enum(EXCEPTION_OUTCOMES),
      evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
      status: z.literal("exception_open"),
    })
    .strict(),
  z
    .object({
      action: z.literal("close_refund_failed"),
      target: z.literal("cancellation_request"),
      targetId: z.uuid(),
      orderId: z.uuid(),
      outcome: z.enum(REFUND_FAILED_OUTCOMES),
      evidenceHash: z.string().regex(/^[0-9a-f]{64}$/),
      status: z.literal("refund_failed"),
      /** The row as it was asked against: any later write (a recheck, a clear) makes the approval stale. */
      updatedAt: z.string().min(1),
    })
    .strict(),
]);
type ResolutionPayload = z.infer<typeof payloadSchema>;

export type ResolutionResult = { status: "applied"; approvalId: string } | { status: "pending"; approvalId: string } | { status: "refused"; reason: string };

/** The documents job's wiring (`/api/jobs/documents-tick`): the TravelDesk source when live and configured, the configured store. */
export function documentDepsFromEnv(): DocumentDeps {
  const config = traveldeskConfigFrom(env());
  return { source: config ? TravelDeskDocumentSource.fromConfig(config) : null, store: getDocumentStore(), now: () => new Date() };
}

/** The approval environment of this deployment. */
export function approvalEnvironment(): ApprovalEnvironment {
  return env().isProduction ? "production" : "test";
}

/* ---------------------------------------------------------------------------
 * Row loading
 * ------------------------------------------------------------------------ */

interface Viewer {
  pii: boolean;
  costs: boolean;
}

function viewer(actor: Actor): Viewer {
  return { pii: hasPermission(actor, PII_PERMISSION), costs: hasPermission(actor, COSTS_PERMISSION) };
}

const ITEM_SELECT = { id: true, titleSnapshot: true, serviceDate: true } satisfies Prisma.OrderItemSelect;

function orderSelect(v: Viewer) {
  return { id: true, reference: true, leadPhone: true, ...(v.pii ? { leadName: true, leadEmail: true } : {}) } satisfies Prisma.OrderSelect;
}

type OrderLite = { id: string; reference: string; leadPhone: string; leadName?: string; leadEmail?: string | null };
type ItemLite = { id: string; titleSnapshot: string; serviceDate: Date };

function contactOf(order: OrderLite | null | undefined, v: Viewer): QueueContact | null {
  if (!order) return null;
  if (!v.pii) return maskedContact(order.leadPhone);
  return { name: order.leadName ?? null, phone: order.leadPhone, email: order.leadEmail ?? null, masked: false };
}

function iso(d: Date): string {
  return d.toISOString();
}

function day(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

function row(
  v: Viewer,
  source: QueueSource,
  r: { id: string; state: string; since: Date; detail?: string | null; attentionAt: Date | null; order?: OrderLite | null; item?: ItemLite | null; serviceDate?: Date | null },
): QueueRow {
  const { label, tone } = stateLabel(source, r.state);
  const reference = r.order?.reference ?? null;
  return {
    key: `${source}:${r.id}`,
    source,
    id: r.id,
    orderId: r.order?.id ?? null,
    orderReference: reference,
    orderItemId: r.item?.id ?? null,
    itemTitle: r.item?.titleSnapshot ?? null,
    serviceDate: day(r.item?.serviceDate ?? r.serviceDate ?? null),
    since: iso(r.since),
    state: r.state,
    stateLabel: label,
    tone,
    detail: r.detail ?? null,
    attention: r.attentionAt !== null,
    contact: contactOf(r.order, v),
    href: detailHref(reference, r.item?.id ?? null),
  };
}

interface Source {
  count(): Promise<number>;
  /** The oldest `take` rows. */
  list(take: number): Promise<QueueRow[]>;
}

function bookingSource(v: Viewer, where: Prisma.SupplierBookingWhereInput, since: "updatedAt" | "attentionRequiredAt" = "updatedAt"): Source {
  return {
    count: () => prisma.supplierBooking.count({ where }),
    list: async (take) => {
      const rows = await prisma.supplierBooking.findMany({
        where,
        orderBy: [{ [since]: "asc" }, { id: "asc" }],
        take,
        // No net figures, no guest name, no supplier text (SEC-11).
        select: { id: true, state: true, errorCode: true, attentionRequiredAt: true, updatedAt: true, serviceDate: true, order: { select: orderSelect(v) }, orderItem: { select: ITEM_SELECT } },
      });
      return rows.map((b) =>
        row(v, "supplier_booking", { id: b.id, state: b.state, since: (since === "attentionRequiredAt" ? b.attentionRequiredAt : null) ?? b.updatedAt, detail: b.errorCode, attentionAt: b.attentionRequiredAt, order: b.order, item: b.orderItem, serviceDate: b.serviceDate }),
      );
    },
  };
}

function sagaSource(v: Viewer, where: Prisma.PaymentSagaWhereInput, since: "createdAt" | "attentionRequiredAt" = "createdAt"): Source {
  return {
    count: () => prisma.paymentSaga.count({ where }),
    list: async (take) => {
      const rows = await prisma.paymentSaga.findMany({
        where,
        orderBy: [{ [since]: "asc" }, { id: "asc" }],
        take,
        select: { id: true, state: true, rail: true, attentionRequiredAt: true, createdAt: true, order: { select: orderSelect(v) }, orderItem: { select: ITEM_SELECT } },
      });
      return rows.map((s) =>
        row(v, "payment_saga", { id: s.id, state: s.state, since: (since === "attentionRequiredAt" ? s.attentionRequiredAt : null) ?? s.createdAt, detail: s.rail, attentionAt: s.attentionRequiredAt, order: s.order, item: s.orderItem }),
      );
    },
  };
}

function documentRows(v: Viewer, ids: string[], since: "createdAt" | "attentionRequiredAt"): Promise<QueueRow[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return prisma.supplierDocument
    .findMany({
      where: { id: { in: ids } },
      // No storage key, checksum or ticket codes.
      select: { id: true, kind: true, status: true, attentionRequiredAt: true, createdAt: true, order: { select: orderSelect(v) }, orderItem: { select: ITEM_SELECT } },
    })
    .then((rows) =>
      rows
        .map((d) => row(v, "supplier_document", { id: d.id, state: d.status, since: (since === "attentionRequiredAt" ? d.attentionRequiredAt : null) ?? d.createdAt, detail: d.kind, attentionAt: d.attentionRequiredAt, order: d.order, item: d.orderItem }))
        .sort((a, b) => a.since.localeCompare(b.since) || a.key.localeCompare(b.key)),
    );
}

function documentSource(v: Viewer, where: Prisma.SupplierDocumentWhereInput, since: "createdAt" | "attentionRequiredAt" = "createdAt"): Source {
  return {
    count: () => prisma.supplierDocument.count({ where }),
    list: async (take) => {
      const ids = await prisma.supplierDocument.findMany({ where, orderBy: [{ [since]: "asc" }, { id: "asc" }], take, select: { id: true } });
      return documentRows(v, ids.map((d) => d.id), since);
    },
  };
}

/**
 * Missing tickets: ticket documents of a confirmed order-item booking that
 * are still pending or incomplete, or whose latest version failed or was
 * quarantined (a newer version supersedes an older failure).
 */
function missingTicketSource(v: Viewer): Source {
  return {
    count: async () => {
      const [r] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM supplier_documents d JOIN supplier_bookings b ON b.id = d.supplier_booking_id
        WHERE b.state = 'confirmed' AND b.order_item_id IS NOT NULL AND d.kind IN ('ticket_codes', 'tickets_pdf', 'voucher_pdf')
          AND (d.status IN ('pending', 'incomplete') OR (d.status IN ('failed', 'quarantined') AND NOT EXISTS (
            SELECT 1 FROM supplier_documents n WHERE n.supplier_booking_id = d.supplier_booking_id AND n.kind = d.kind AND n.version > d.version)))`;
      return r?.n ?? 0;
    },
    list: async (take) => {
      const ids = await prisma.$queryRaw<{ id: string }[]>`
        SELECT d.id FROM supplier_documents d JOIN supplier_bookings b ON b.id = d.supplier_booking_id
        WHERE b.state = 'confirmed' AND b.order_item_id IS NOT NULL AND d.kind IN ('ticket_codes', 'tickets_pdf', 'voucher_pdf')
          AND (d.status IN ('pending', 'incomplete') OR (d.status IN ('failed', 'quarantined') AND NOT EXISTS (
            SELECT 1 FROM supplier_documents n WHERE n.supplier_booking_id = d.supplier_booking_id AND n.kind = d.kind AND n.version > d.version)))
        ORDER BY d.created_at ASC, d.id ASC LIMIT ${take}`;
      return documentRows(v, ids.map((d) => d.id), "createdAt");
    },
  };
}

function notificationSource(v: Viewer, where: Prisma.NotificationWhereInput): Source {
  return {
    count: () => prisma.notification.count({ where }),
    list: async (take) => {
      // The recipient is never selected for a queue row.
      const rows = await prisma.notification.findMany({
        where,
        orderBy: [{ attentionRequiredAt: "asc" }, { id: "asc" }],
        take,
        select: { id: true, event: true, status: true, attentionRequiredAt: true, createdAt: true, order: { select: orderSelect(v) } },
      });
      return rows.map((n) => row(v, "notification", { id: n.id, state: n.status, since: n.attentionRequiredAt ?? n.createdAt, detail: n.event, attentionAt: n.attentionRequiredAt, order: n.order }));
    },
  };
}

function cancellationSource(v: Viewer, where: Prisma.CancellationRequestWhereInput, since: "updatedAt" | "attentionRequiredAt" = "updatedAt"): Source {
  return {
    count: () => prisma.cancellationRequest.count({ where }),
    list: async (take) => {
      const rows = await prisma.cancellationRequest.findMany({
        where,
        orderBy: [{ [since]: "asc" }, { id: "asc" }],
        take,
        select: { id: true, kind: true, status: true, reasonCode: true, attentionRequiredAt: true, updatedAt: true, order: { select: orderSelect(v) }, orderItem: { select: ITEM_SELECT } },
      });
      return rows.map((c) =>
        row(v, "cancellation_request", { id: c.id, state: c.status, since: (since === "attentionRequiredAt" ? c.attentionRequiredAt : null) ?? c.updatedAt, detail: c.reasonCode ?? c.kind, attentionAt: c.attentionRequiredAt, order: c.order, item: c.orderItem }),
      );
    },
  };
}

function refundSource(v: Viewer, where: Prisma.RefundWhereInput): Source {
  return {
    count: () => prisma.refund.count({ where }),
    list: async (take) => {
      const rows = await prisma.refund.findMany({
        where,
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take,
        select: { id: true, status: true, reason: true, updatedAt: true, orderItem: { select: { ...ITEM_SELECT, order: { select: orderSelect(v) } } } },
      });
      return rows.map((r) => row(v, "refund", { id: r.id, state: r.status, since: r.updatedAt, detail: r.reason, attentionAt: null, order: r.orderItem.order, item: r.orderItem }));
    },
  };
}

function remedySource(v: Viewer, where: Prisma.CustomerRemedyWhereInput): Source {
  return {
    count: () => prisma.customerRemedy.count({ where }),
    list: async (take) => {
      const rows = await prisma.customerRemedy.findMany({
        where,
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take,
        select: { id: true, kind: true, status: true, updatedAt: true, order: { select: orderSelect(v) }, orderItem: { select: ITEM_SELECT } },
      });
      return rows.map((r) => row(v, "remedy", { id: r.id, state: r.status, since: r.updatedAt, detail: r.kind, attentionAt: null, order: r.order, item: r.orderItem }));
    },
  };
}

const flagged = { attentionRequiredAt: { not: null } } as const;

function sourcesFor(queue: QueueKey, v: Viewer, now: Date): Source[] {
  const before = (ms: number) => new Date(now.getTime() - ms);
  switch (queue) {
    case "paid_unconfirmed":
      return [
        sagaSource(v, { state: { in: ["captured", "reserve_pending", "reserved", "confirm_pending"] }, createdAt: { lt: before(PAID_UNCONFIRMED_AFTER_MS) } }),
        bookingSource(v, {
          state: "awaiting_payment",
          orderItemId: { not: null },
          updatedAt: { lt: before(PAID_UNCONFIRMED_AFTER_MS) },
          // The order's saga covers every item of the order (multi-item, lead-approved 3 Nov 2026).
          order: { paymentSaga: { is: { payment: { status: { in: ["captured", "partially_refunded"] }, source: "gateway_verified" } } } },
        }),
      ];
    case "unknown_outcome":
      return [
        bookingSource(v, {
          OR: [{ state: { in: ["outcome_unknown", "not_found_unresolved", "cancel_unverified"] } }, { state: "confirming", updatedAt: { lt: before(CONFIRMING_LONG_MS) } }],
        }),
        sagaSource(v, { state: "capture_unknown" }),
      ];
    case "missing_ticket":
      return [missingTicketSource(v)];
    case "refunds":
      return [
        refundSource(v, { status: "failed" }),
        remedySource(v, { status: "failed" }),
        cancellationSource(v, { status: { in: ["refund_failed", "exception_open"] } }),
      ];
    case "attention":
      return [
        bookingSource(v, flagged, "attentionRequiredAt"),
        sagaSource(v, flagged, "attentionRequiredAt"),
        documentSource(v, flagged, "attentionRequiredAt"),
        notificationSource(v, flagged),
        cancellationSource(v, flagged, "attentionRequiredAt"),
      ];
  }
}

/* ---------------------------------------------------------------------------
 * Order detail
 * ------------------------------------------------------------------------ */

function bookingDetailSelect(v: Viewer) {
  return {
    id: true,
    orderItemId: true,
    attempt: true,
    environment: true,
    state: true,
    mode: true,
    afterReserve: true,
    clientRef: true,
    supplierBookingId: true,
    errorCode: true,
    reservationDeadline: true,
    requestSentAt: true,
    reservedAt: true,
    confirmedAt: true,
    cancelledAt: true,
    closedAt: true,
    attentionRequiredAt: true,
    createdAt: true,
    updatedAt: true,
    events: { orderBy: { at: "desc" }, take: 20, select: { id: true, at: true, kind: true, operation: true, fromState: true, toState: true, httpStatus: true } },
    ...(v.pii ? { guestName: true } : {}),
    // Error messages can quote net figures (the cap and funds-floor refusals).
    ...(v.costs ? { expectedNetMinor: true, expectedNetUsdMinor: true, chargedNetMinor: true, chargedNetUsdMinor: true, errorMessage: true } : {}),
  } satisfies Prisma.SupplierBookingSelect;
}

function itemDetailSelect(v: Viewer) {
  return {
    id: true,
    titleSnapshot: true,
    serviceDate: true,
    timeslot: true,
    status: true,
    fulfilmentOrigin: true,
    chargedCurrency: true,
    chargedAmountMinor: true,
    ...(v.costs ? { netCostAed: true, marginSnapshot: true } : {}),
  } satisfies Prisma.OrderItemSelect;
}

function orderDetailSelect(v: Viewer) {
  return {
    id: true,
    reference: true,
    status: true,
    rail: true,
    currency: true,
    totalInr: true,
    totalAed: true,
    placedAt: true,
    paidAt: true,
    confirmedAt: true,
    cancelledAt: true,
    leadPhone: true,
    ...(v.pii ? { leadName: true, leadEmail: true } : {}),
    ...(v.costs ? { netCostAed: true } : {}),
  } satisfies Prisma.OrderSelect;
}

/** Dates to ISO strings and bigints to decimal strings, so the page renders plain data. */
function plain<T>(value: T): Plain<T> {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))) as Plain<T>;
}
type Plain<T> = T extends bigint ? string : T extends Date ? string : T extends (infer U)[] ? Plain<U>[] : T extends object ? { [K in keyof T]: Plain<T[K]> } : T;

async function loadOrderDetail(actor: Actor, reference: string, now: Date) {
  const v = viewer(actor);
  const order = await prisma.order.findUnique({ where: { reference }, select: orderDetailSelect(v) });
  if (!order) return null;
  const [items, bookings, sagas, refunds, remedies, cancellations, documents, notifications, wallet, pending] = await Promise.all([
    prisma.orderItem.findMany({ where: { orderId: order.id }, select: itemDetailSelect(v), orderBy: { serviceDate: "asc" } }),
    prisma.supplierBooking.findMany({ where: { orderId: order.id }, select: bookingDetailSelect(v), orderBy: [{ orderItemId: "asc" }, { attempt: "asc" }] }),
    prisma.paymentSaga.findMany({
      where: { orderId: order.id },
      select: {
        id: true,
        orderItemId: true,
        rail: true,
        state: true,
        deadlineAt: true,
        attentionRequiredAt: true,
        createdAt: true,
        updatedAt: true,
        payment: { select: { id: true, status: true, source: true, provider: true, currency: true, amountMinor: true, capturedMinor: true, refundedMinor: true, capturedAt: true } },
      },
    }),
    prisma.refund.findMany({ where: { orderItem: { orderId: order.id } }, select: { id: true, orderItemId: true, status: true, amountMinor: true, currency: true, reason: true, createdAt: true, updatedAt: true }, orderBy: { createdAt: "asc" } }),
    prisma.customerRemedy.findMany({ where: { orderId: order.id }, select: { id: true, orderItemId: true, kind: true, status: true, amountMinor: true, currency: true, reason: true, createdAt: true, updatedAt: true }, orderBy: { createdAt: "asc" } }),
    prisma.cancellationRequest.findMany({
      where: { orderId: order.id },
      select: { id: true, orderItemId: true, supplierBookingId: true, kind: true, status: true, requestedVia: true, reasonCode: true, attentionRequiredAt: true, createdAt: true, updatedAt: true, closedAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.supplierDocument.findMany({
      where: { orderId: order.id },
      // No storage key, checksum or ticket codes.
      select: { id: true, supplierBookingId: true, orderItemId: true, kind: true, version: true, status: true, source: true, fetchAttempts: true, nextFetchAt: true, quarantineReason: true, attentionRequiredAt: true, createdAt: true, validatedAt: true },
      orderBy: [{ kind: "asc" }, { version: "desc" }],
    }),
    prisma.notification.findMany({
      where: { orderId: order.id },
      select: { id: true, event: true, channel: true, status: true, attempt: true, recipient: true, attentionRequiredAt: true, createdAt: true, sentAt: true },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
    v.costs
      ? prisma.ledgerEntry.findMany({
          where: { orderId: order.id, book: "supplier_wallet" },
          select: { id: true, supplierBookingId: true, kind: true, currency: true, amountMinor: true, occurredAt: true, createdAt: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      : Promise.resolve(null),
    prisma.privilegedApproval.findMany({
      where: { operation: RESOLUTION, status: "pending", expiresAt: { gt: now }, payload: { path: ["orderId"], equals: order.id } },
      select: { id: true, payload: true, requestedBy: true, requestedAt: true, expiresAt: true, requester: { select: { fullName: true } } },
      orderBy: { requestedAt: "asc" },
    }),
  ]);

  const { leadPhone, ...orderRest } = order as typeof order & { leadName?: string; leadEmail?: string | null };
  const contact = v.pii ? { name: (order as { leadName?: string }).leadName ?? null, phone: leadPhone, email: (order as { leadEmail?: string | null }).leadEmail ?? null, masked: false } : maskedContact(leadPhone);
  const { leadName: _n, leadEmail: _e, ...orderPublic } = orderRest as typeof orderRest & { leadName?: string; leadEmail?: string | null };
  void _n;
  void _e;

  return plain({
    viewer: v,
    order: { ...orderPublic, contact },
    items,
    bookings,
    sagas,
    refunds,
    remedies,
    cancellations,
    documents,
    notifications: notifications.map(({ recipient, ...n }) => ({ ...n, recipient: v.pii ? recipient : maskRecipient(recipient) })),
    wallet,
    pendingResolutions: pending.map((p) => {
      const parsed = payloadSchema.safeParse(p.payload);
      const d = parsed.success ? parsed.data : null;
      return {
        id: p.id,
        requestedBy: p.requestedBy,
        requesterName: p.requester.fullName,
        requestedAt: p.requestedAt,
        expiresAt: p.expiresAt,
        action: d?.action ?? null,
        target: d?.target ?? null,
        targetId: d?.targetId ?? null,
        code: d ? (d.action === "clear_attention" ? d.reasonCode : d.outcome) : null,
      };
    }),
  });
}

export type OrderOpsDetail = NonNullable<Awaited<ReturnType<typeof loadOrderDetail>>>;

/* ---------------------------------------------------------------------------
 * Privileged resolution
 * ------------------------------------------------------------------------ */

const RESOLUTION_PERMISSION = OPERATION_PERMISSION[RESOLUTION];

/** The target's current state, as the payload binds it. */
async function loadTarget(
  target: AttentionTarget,
  id: string,
): Promise<{ state: string; attentionAt: Date | null; orderId: string | null; closed?: boolean; kind?: string; lateAccepted?: boolean; lateSettled?: boolean; updatedAt?: Date } | null> {
  switch (target) {
    case "supplier_booking": {
      const r = await prisma.supplierBooking.findUnique({ where: { id }, select: { state: true, attentionRequiredAt: true, orderId: true } });
      if (!r) return null;
      const lateAccepted = await supplierBookingService.wasLateAccepted(id);
      return { state: r.state, attentionAt: r.attentionRequiredAt, orderId: r.orderId, lateAccepted, lateSettled: lateAccepted && (await supplierBookingService.lateAcceptanceSettled(id)) };
    }
    case "payment_saga": {
      const r = await prisma.paymentSaga.findUnique({ where: { id }, select: { state: true, attentionRequiredAt: true, orderId: true } });
      return r && { state: r.state, attentionAt: r.attentionRequiredAt, orderId: r.orderId };
    }
    case "supplier_document": {
      const r = await prisma.supplierDocument.findUnique({ where: { id }, select: { status: true, attentionRequiredAt: true, orderId: true } });
      return r && { state: r.status, attentionAt: r.attentionRequiredAt, orderId: r.orderId };
    }
    case "notification": {
      const r = await prisma.notification.findUnique({ where: { id }, select: { status: true, attentionRequiredAt: true, orderId: true } });
      return r && { state: r.status, attentionAt: r.attentionRequiredAt, orderId: r.orderId };
    }
    case "cancellation_request": {
      const r = await prisma.cancellationRequest.findUnique({ where: { id }, select: { status: true, kind: true, attentionRequiredAt: true, orderId: true, closedAt: true, updatedAt: true } });
      return r && { state: r.status, attentionAt: r.attentionRequiredAt, orderId: r.orderId, closed: r.closedAt !== null, kind: r.kind, updatedAt: r.updatedAt };
    }
  }
}

function evidenceHashOf(evidence: string): string {
  return hmacFor("lookup", `booking_resolution_evidence:${evidence.trim()}`);
}

function auditResolution(actor: Actor, action: string, payload: { target: string; targetId: string; orderId?: string | null }, extra: { approvalId?: string; codes?: Record<string, string>; hashes?: Record<string, string>; fields?: string[] } = {}, tx: Tx | typeof prisma = prisma) {
  return auditFieldChanges(
    actor,
    action,
    { type: payload.target, id: payload.targetId },
    { fields: extra.fields ?? [], ids: { orderId: payload.orderId ?? null, approvalId: extra.approvalId ?? null }, codes: extra.codes, hashes: extra.hashes },
    tx,
  );
}

function codesOf(p: ResolutionPayload): Record<string, string> {
  return p.action === "clear_attention" ? { action: p.action, reasonCode: p.reasonCode } : { action: p.action, outcome: p.outcome };
}

/** Check and burn an applied resolution approval for exactly this payload (one use, within the approval TTL). */
async function useResolutionApproval(tx: Tx, actor: Actor, approvalId: string, payload: ResolutionPayload, now: Date): Promise<string> {
  const row = await tx.privilegedApproval.findUnique({ where: { id: approvalId } });
  const fail = (why: string) => Errors.conflict(`The approval cannot be used: ${why}`, { approvalId });
  if (!row) throw Errors.notFound("Approval request");
  if (row.operation !== RESOLUTION || row.permission !== RESOLUTION_PERMISSION) throw fail("it is for another operation");
  if (row.status !== "applied" || !row.appliedAt) throw fail("it is not approved");
  const hash = privilegedPayloadHash(RESOLUTION, RESOLUTION_PERMISSION, row.environment, payload);
  if (row.payloadHash !== hash) throw fail("it is for a different change");
  if (now.getTime() - row.appliedAt.getTime() > APPROVAL_TTL_MS) throw fail("it has expired");
  if (!hasPermission(actor, RESOLUTION_PERMISSION) || (actor.id !== row.requestedBy && actor.id !== row.approvedBy)) throw Errors.forbidden(RESOLUTION_PERMISSION);
  const used = await tx.idempotencyKey.createMany({
    skipDuplicates: true,
    data: [{ key: `privileged_use:${approvalId}`, scope: "privileged_use", requestHash: row.payloadHash, completedAt: now, expiresAt: new Date(row.appliedAt.getTime() + APPROVAL_TTL_MS + 86_400_000) }],
  });
  if (used.count === 0) throw fail("it was used already");
  return row.payloadHash;
}

/** Perform an approved resolution. The row must still be in the state the approval was asked against. */
async function applyResolution(actor: Actor, approvalId: string, payload: ResolutionPayload, now: Date): Promise<ResolutionResult> {
  return prisma.$transaction(async (tx) => {
    const payloadHash = await useResolutionApproval(tx, actor, approvalId, payload, now);
    const changed = () => Errors.conflict("This row changed since the request; look again and ask again", { approvalId });
    let fields: string[];
    if (payload.action === "close_exception") {
      const r = await tx.cancellationRequest.updateMany({
        where: { id: payload.targetId, orderId: payload.orderId, kind: "exception", status: "exception_open", closedAt: null },
        data: { status: "exception_closed", closedAt: now, reasonCode: payload.outcome, attentionRequiredAt: null },
      });
      if (r.count !== 1) throw changed();
      fields = ["attentionRequiredAt", "closedAt", "reasonCode", "status"];
    } else if (payload.action === "close_refund_failed") {
      // R-B5-2. Locked, still the row the approval was asked against, and the money still verifiably back.
      const [locked] = await tx.$queryRaw<{ status: string; updated_at: Date; closed_at: Date | null }[]>`
        SELECT "status", "updated_at", "closed_at" FROM "cancellation_requests" WHERE "id" = ${payload.targetId}::uuid AND "order_id" = ${payload.orderId}::uuid FOR UPDATE`;
      if (!locked || locked.status !== "refund_failed" || locked.closed_at !== null || locked.updated_at.toISOString() !== payload.updatedAt) throw changed();
      if (!(await refundSettledElsewhere(tx, payload.targetId))) throw Errors.conflict("The provider does not show this item refunded; nothing was closed", { approvalId });
      const r = await tx.cancellationRequest.updateMany({
        where: { id: payload.targetId, orderId: payload.orderId, kind: "supported", status: "refund_failed", closedAt: null },
        data: { status: "refunded", closedAt: now, reasonCode: "resolved_refunded_at_provider", attentionRequiredAt: null },
      });
      if (r.count !== 1) throw changed();
      // Batch 3 review: a fully refunded order ends its checkout download grant, in this transaction.
      await revokeCheckoutAccessIfOrderEnded(tx, payload.orderId, now);
      fields = ["attentionRequiredAt", "closedAt", "reasonCode", "status"];
    } else {
      const where = { id: payload.targetId, orderId: payload.orderId, attentionRequiredAt: new Date(payload.attentionAt) };
      const data = { attentionRequiredAt: null };
      let count = 0;
      switch (payload.target) {
        case "supplier_booking": {
          // The booking engine is the only writer of supplier booking rows (SUP-20), and it re-checks the late-acceptance hold.
          const cleared = await supplierBookingService.clearAttention(tx, payload.targetId, {
            orderId: payload.orderId,
            expectedAttentionAt: where.attentionRequiredAt,
            actorId: actor.id ?? null,
            reasonCode: payload.reasonCode,
            approvalId,
            lateAcceptanceResolved: payload.reasonCode === LATE_ACCEPTANCE_RESOLVED,
          });
          if (cleared === "late_accepted") throw Errors.conflict("This booking was accepted late by the operator; its hold cannot be cleared from the console", { approvalId });
          count = cleared === "cleared" ? 1 : 0;
          break;
        }
        case "payment_saga":
          count = (await tx.paymentSaga.updateMany({ where: { ...where, state: { in: SAGA_STATES_CLEARABLE } }, data })).count;
          break;
        case "supplier_document":
          count = (await tx.supplierDocument.updateMany({ where, data })).count;
          break;
        case "notification":
          count = (await tx.notification.updateMany({ where: { ...where, status: { notIn: NOTIFICATION_STATES_ATTENTION_HOLDS } }, data })).count;
          break;
        case "cancellation_request":
          count = (await tx.cancellationRequest.updateMany({ where: { ...where, closedAt: null }, data })).count;
          break;
      }
      if (count !== 1) throw changed();
      fields = ["attentionRequiredAt"];
    }
    await auditResolution(actor, "booking.privileged_resolution.applied", payload, { approvalId, fields, codes: codesOf(payload), hashes: { evidenceHash: payload.evidenceHash, payloadHash } }, tx);
    return { status: "applied" as const, approvalId };
  }, TX_OPTIONS);
}

/* ---------------------------------------------------------------------------
 * Service
 * ------------------------------------------------------------------------ */

export const opsQueueService = {
  /** One page of a queue, oldest first. */
  async list(actor: Actor, queue: QueueKey, opts: { page?: unknown; pageSize?: unknown; now?: Date } = {}): Promise<QueuePage> {
    requirePermission(actor, OPS_QUEUE_PERMISSION);
    if (!QUEUES.includes(queue)) throw Errors.validation({ queue: "Unknown queue" });
    const { page, pageSize } = pageWindow(opts.page ?? 1, opts.pageSize ?? QUEUE_PAGE_SIZE);
    const sources = sourcesFor(queue, viewer(actor), opts.now ?? new Date());
    const [totals, lists] = await Promise.all([Promise.all(sources.map((s) => s.count())), Promise.all(sources.map((s) => s.list(page * pageSize)))]);
    return { queue, rows: mergeRows(lists, page, pageSize), total: totals.reduce((a, b) => a + b, 0), page, pageSize };
  },

  /** Row counts per queue, for the tabs. */
  async counts(actor: Actor, opts: { now?: Date } = {}): Promise<Record<QueueKey, number>> {
    requirePermission(actor, OPS_QUEUE_PERMISSION);
    const v = viewer(actor);
    const now = opts.now ?? new Date();
    const entries = await Promise.all(QUEUES.map(async (q) => [q, (await Promise.all(sourcesFor(q, v, now).map((s) => s.count()))).reduce((a, b) => a + b, 0)] as const));
    return Object.fromEntries(entries) as Record<QueueKey, number>;
  },

  /** Everything staff may see about one order's instant booking. Null when there is no such order. */
  async orderDetail(actor: Actor, reference: string, opts: { now?: Date } = {}) {
    requirePermission(actor, OPS_QUEUE_PERMISSION);
    if (typeof reference !== "string" || reference.length === 0 || reference.length > 40) return null;
    return loadOrderDetail(actor, reference, opts.now ?? new Date());
  },

  /**
   * The deliberate ticket read (R-B4-5) with the documents job's wiring.
   * document.service checks `tickets.resend` again and audits the read; this
   * also audits the request and its outcome code.
   */
  async deliberateRead(actor: Actor, supplierBookingId: string, deps: DocumentDeps = documentDepsFromEnv()): Promise<{ outcome: string }> {
    requirePermission(actor, "tickets.resend");
    const r = await documentService.deliberateRead(actor, supplierBookingId, deps);
    await auditFieldChanges(actor, "tickets.deliberate_read_requested", { type: "supplier_booking", id: supplierBookingId }, { fields: [], ids: { supplierBookingId }, codes: { outcome: r.outcome } });
    return r;
  },

  /** Ask for a fresh copy of a document (`tickets.resend`), with a reason from a fixed list. Audited by ids and the code. */
  async requestRefetch(actor: Actor, documentId: string, reason: RefetchReason, now: Date = new Date()): Promise<void> {
    requirePermission(actor, "tickets.resend");
    if (!REFETCH_REASONS.includes(reason)) throw Errors.validation({ reason: "Choose a reason" });
    await documentService.requestRefetch(documentId, reason, now);
    await auditFieldChanges(actor, "tickets.refetch_requested", { type: "supplier_document", id: documentId }, { fields: [], ids: { documentId }, codes: { reason } });
  },

  /**
   * Ask for a privileged resolution. `applied` means it was done now (test,
   * or a second person asking for exactly the same thing in production);
   * `pending` waits for a second approver; `refused` says why. Every outcome
   * is audited.
   */
  async requestResolution(actor: Actor, raw: unknown, opts: { environment: ApprovalEnvironment; totpCode: string; now?: Date }): Promise<ResolutionResult> {
    const now = opts.now ?? new Date();
    const parsed = resolutionInputSchema.safeParse(raw);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) fields[String(issue.path[0] ?? "form")] ??= issue.message;
      throw Errors.validation(fields);
    }
    const input = parsed.data;
    const target: AttentionTarget = input.action === "clear_attention" ? input.target : "cancellation_request";
    const subject = { target, targetId: input.targetId };
    if (!hasPermission(actor, RESOLUTION_PERMISSION)) {
      await auditResolution(actor, "booking.privileged_resolution.refused", subject, { codes: { action: input.action, reason: "forbidden" } });
      return { status: "refused", reason: "forbidden" };
    }
    const current = await loadTarget(target, input.targetId);
    if (!current) throw Errors.notFound("Row");
    let refusal: string | null;
    let payload: ResolutionPayload | null = null;
    if (input.action === "clear_attention") {
      refusal = clearAttentionRefusal(target, current, input.reasonCode);
      if (!refusal) {
        payload = { action: "clear_attention", target, targetId: input.targetId, orderId: current.orderId!, reasonCode: input.reasonCode, evidenceHash: evidenceHashOf(input.evidence), attentionAt: current.attentionAt!.toISOString() };
      }
    } else if (input.action === "close_refund_failed") {
      refusal =
        current.kind !== "supported" || current.state !== "refund_failed" || current.closed || !current.updatedAt
          ? "not_refund_failed"
          : !current.orderId
            ? "no_order"
            : !(await refundSettledElsewhere(prisma, input.targetId))
              ? "refund_not_shown_at_provider"
              : null;
      if (!refusal) {
        payload = {
          action: "close_refund_failed",
          target: "cancellation_request",
          targetId: input.targetId,
          orderId: current.orderId!,
          outcome: input.outcome,
          evidenceHash: evidenceHashOf(input.evidence),
          status: "refund_failed",
          updatedAt: current.updatedAt!.toISOString(),
        };
      }
    } else {
      refusal = current.kind !== "exception" || current.state !== "exception_open" || current.closed ? "not_open_exception" : !current.orderId ? "no_order" : null;
      if (!refusal) {
        payload = { action: "close_exception", target: "cancellation_request", targetId: input.targetId, orderId: current.orderId!, outcome: input.outcome, evidenceHash: evidenceHashOf(input.evidence), status: "exception_open" };
      }
    }
    if (refusal || !payload) {
      await auditResolution(actor, "booking.privileged_resolution.refused", { ...subject, orderId: current.orderId }, { codes: { action: input.action, reason: refusal ?? "invalid" } });
      return { status: "refused", reason: refusal ?? "invalid" };
    }

    const r = await approvalService.requestPrivileged(actor, RESOLUTION, RESOLUTION_PERMISSION, payload, { environment: opts.environment, totpCode: opts.totpCode, now });
    if (r.status === "refused") {
      await auditResolution(actor, "booking.privileged_resolution.refused", payload, { codes: { ...codesOf(payload), reason: r.reason } });
      return { status: "refused", reason: r.reason };
    }
    if (r.status === "pending") {
      await auditResolution(actor, "booking.privileged_resolution.pending", payload, { approvalId: r.approvalId, codes: codesOf(payload), hashes: { evidenceHash: payload.evidenceHash } });
      return { status: "pending", approvalId: r.approvalId };
    }
    return applyResolution(actor, r.approvalId, payload, now);
  },

  /** A second staff member approves a pending resolution with their own code; it is then performed. */
  async approveResolution(actor: Actor, approvalId: string, totpCode: string, opts: { now?: Date } = {}): Promise<ResolutionResult> {
    const now = opts.now ?? new Date();
    const row = await prisma.privilegedApproval.findUnique({ where: { id: approvalId } });
    if (!row || row.operation !== RESOLUTION) throw Errors.notFound("Approval request");
    const parsed = payloadSchema.safeParse(row.payload);
    if (!parsed.success) throw Errors.conflict("This approval request is not a booking resolution");
    const payload = parsed.data;
    const r = await approvalService.approvePrivileged(actor, approvalId, totpCode, { now });
    if (r.status === "refused") {
      await auditResolution(actor, "booking.privileged_resolution.refused", payload, { approvalId, codes: { ...codesOf(payload), reason: r.reason } });
      return { status: "refused", reason: r.reason };
    }
    if (r.status === "pending") return { status: "pending", approvalId };
    return applyResolution(actor, approvalId, payload, now);
  },
};
