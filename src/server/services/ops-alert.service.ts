import "server-only";
import { prisma, TX_OPTIONS } from "../lib/db";
import { env } from "../lib/env";
import { uuidv7 } from "../lib/ids";
import { emitEvent } from "../lib/structured-events";
import type { OpsAlertContext, OpsAlertDigestContext, TemplateContext } from "../notifications/templates";
import { notificationService, type DispatchResult } from "./notification.service";
import { urgentAt } from "./document.service";

/**
 * Ops alert emails for instant-path incidents (doc 22 §32.24: alerts by
 * email; §32.23 open point "no external alert channel yet").
 *
 * One email per incident to `env().opsAlertEmails`, through the notification
 * outbox (`notificationService.dispatch`): one `notifications` row per
 * incident and recipient, written before the send, the row id as the
 * provider's idempotency key, rendered from the stored context on every
 * attempt (so a resend is identical), retried by the outbox sweep.
 *
 * After commit by construction. The sweep reads incidents from the state the
 * engine, the saga, the refund driver and the document service already
 * committed (attention flags, states, failed rows, the breaker's pause), so
 * an alert can never break, delay or roll back the transition that raised
 * it, and an incident whose transaction rolled back is never reported. It
 * runs from the scheduled inquiry sweep (every 5 minutes) and never throws.
 *
 * Incidents (`collectOpsIncidents`), each raised within `OPS_ALERT_LOOKBACK_MS`:
 *  - `supplier_outage_paused`: the outage breaker paused new sales (control
 *    row paused with reason `supplier_outage_auto`);
 *  - `supplier_wallet_paused`: the wallet direction guard stopped all
 *    supplier writes (control row paused with reason `wallet_direction_auto`,
 *    doc 29 §4.5);
 *  - `saga_attention`: a payment saga flagged for a human;
 *  - `item_refund_problem`: a multi-item order's item refund refused or
 *    short (`item_*` failed remedy);
 *  - `refund_failed`: a refund that failed, or a cancellation whose refund
 *    failed (still open);
 *  - `booking_attention`: a supplier booking needing staff:
 *    `outcome_unknown` past its first recovery search (or
 *    `not_found_unresolved`), `manual_review`, `charged_amount_mismatch`,
 *    `cancel_refused`, a late acceptance, a reserve held back because the
 *    wallet figures failed the funds check (`funds_unverified`);
 *  - `document_attention`: a ticket document flagged for staff past the
 *    existing F12 thresholds (urgent is its own reason).
 *
 * Dedup and throttle (`ops_alerts`, one row per entity and reason, under one
 * row lock so concurrent sweeps decide one at a time):
 *  - an incident whose raise time the row already handled is skipped;
 *  - at most one email per (entity, reason) per `OPS_ALERT_DEDUP_MS` (6 h):
 *    a repeat inside that window waits, and is sent after it only if it is
 *    still within the lookback;
 *  - at most `OPS_ALERT_HOURLY_CAP` (20) incident emails per rolling hour;
 *    beyond that an incident is marked suppressed (not sent), and one
 *    "N more alerts suppressed" digest goes out at most once per hour.
 *
 * The email (templates.ts `OPS_INCIDENT_ALERT`): subject `[OUTLY ALERT]
 * <incident>`, the order reference, booking id, reason code and an admin
 * link. Never a customer name, phone or email, never a supplier net price
 * or any amount.
 *
 * No recipients configured: logged once (`alerts.no_recipients`), nothing
 * is claimed, and the sweep returns. The boot check already warns.
 */

export const OPS_ALERT_DEDUP_MS = 6 * 3600_000;
export const OPS_ALERT_HOURLY_CAP = 20;
export const OPS_ALERT_DIGEST_EVERY_MS = 3600_000;
/** Incidents raised longer ago than this are not emailed (first deploy, a long cron outage). */
export const OPS_ALERT_LOOKBACK_MS = 72 * 3600_000;
/** Per incident kind, per sweep. */
const COLLECT_LIMIT = 100;
/** Rows handed to the outbox per sweep. */
const DISPATCH_LIMIT = 60;

const DIGEST = { entityKind: "digest", entityId: "hourly", reason: "suppressed" } as const;
const EPOCH = new Date(0);

export type OpsIncidentKind = "supplier_outage_paused" | "supplier_wallet_paused" | "saga_attention" | "item_refund_problem" | "refund_failed" | "booking_attention" | "document_attention";
export type OpsEntityKind = "supplier_account" | "payment_saga" | "order_item" | "supplier_booking" | "supplier_document";

export interface OpsIncident {
  kind: OpsIncidentKind;
  entityKind: OpsEntityKind;
  entityId: string;
  /** A short code; normalised by `reasonCode`. */
  reason: string;
  raisedAt: Date;
  orderId: string | null;
  orderReference: string | null;
  /** Our `supplier_bookings.id`. */
  bookingId: string | null;
  /** The supplier's own booking number. */
  supplierBookingRef: string | null;
  /** Path under the site, e.g. `/admin/bookings/OUT-…`. */
  adminPath: string;
}

export const OPS_INCIDENT_TITLES: Record<OpsIncidentKind, string> = {
  supplier_outage_paused: "Supplier outage: new instant sales paused",
  supplier_wallet_paused: "Supplier wallet check failed: all supplier bookings paused",
  saga_attention: "Payment needs attention",
  item_refund_problem: "Item refund failed or short",
  refund_failed: "Refund failed",
  booking_attention: "Booking needs staff",
  document_attention: "Tickets need staff",
};

/** The stored row payload: what the email says plus its idempotency scope. */
interface StoredPayload {
  event: "OPS_INCIDENT_ALERT" | "OPS_ALERT_DIGEST";
  once: string;
  orderId: string | null;
  context: OpsAlertContext | OpsAlertDigestContext;
}

export function reasonCode(s: string): string {
  const c = s
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .slice(0, 80);
  return c || "unknown";
}

const keyOf = (i: Pick<OpsIncident, "entityKind" | "entityId" | "reason">) => `${i.entityKind}|${i.entityId}|${i.reason}`;

/** One incident per (entity, reason): the latest raise wins (a later one is a new occurrence). */
export function latestPerKey(incidents: OpsIncident[]): OpsIncident[] {
  const by = new Map<string, OpsIncident>();
  for (const raw of incidents) {
    const i = { ...raw, reason: reasonCode(raw.reason) };
    const k = keyOf(i);
    const prior = by.get(k);
    if (!prior || i.raisedAt.getTime() > prior.raisedAt.getTime()) by.set(k, i);
  }
  return [...by.values()].sort((a, b) => a.raisedAt.getTime() - b.raisedAt.getTime() || (keyOf(a) < keyOf(b) ? -1 : 1));
}

function adminUrl(siteUrl: string, path: string): string {
  return `${siteUrl.replace(/\/+$/, "")}${path}`;
}

const bookingPath = (reference: string | null) => (reference ? `/admin/bookings/${encodeURIComponent(reference)}` : "/admin/bookings");

/** The email's context for an incident. Exported for tests (the no-PII check). */
export function incidentContext(i: OpsIncident, siteUrl: string): OpsAlertContext {
  return {
    incident: i.kind,
    title: OPS_INCIDENT_TITLES[i.kind],
    reasonCode: reasonCode(i.reason),
    orderReference: i.orderReference,
    bookingId: i.bookingId,
    supplierBookingRef: i.supplierBookingRef,
    entity: `${i.entityKind}:${i.entityId}`,
    raisedAt: i.raisedAt.toISOString(),
    adminUrl: adminUrl(siteUrl, i.adminPath),
  };
}

/* ---------------------------------------------------------------------------
 * Incidents, from committed state
 * ------------------------------------------------------------------------ */

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));

/** Which booking states and codes need staff (doc 22 §32.24 brief). Null: not an incident. */
export function bookingReason(b: { state: string; errorCode: string | null; attention: boolean; recoverySearches: number }): string | null {
  if ((b.errorCode === "late_acceptance" || b.errorCode === "late_acceptance_duplicate") && b.attention) return "late_acceptance";
  if (b.errorCode === "charged_amount_mismatch" && b.attention) return "charged_amount_mismatch";
  if (b.errorCode === "funds_unverified" && b.attention) return "funds_unverified";
  if (b.state === "manual_review") return "manual_review";
  if (b.state === "cancel_refused") return "cancel_refused";
  // Past its first recovery search: still unknown (or proven not found yet), a human must look.
  if ((b.state === "outcome_unknown" && b.recoverySearches >= 1) || b.state === "not_found_unresolved") return "outcome_unknown";
  return null;
}

export async function collectOpsIncidents(since: Date, now: Date, limit = COLLECT_LIMIT): Promise<OpsIncident[]> {
  const out: OpsIncident[] = [];

  // The automatic pauses, on the control row they wrote (supplier-booking.service.ts): the outage breaker
  // (noteMutationHealth) and the wallet direction guard (pauseForWalletDirection).
  const outages = await prisma.$queryRaw<Row[]>`
    SELECT key, updated_at, value->>'reason' AS reason FROM settings
    WHERE key LIKE 'supplier_bookings.%' AND value->>'reason' IN ('supplier_outage_auto', 'wallet_direction_auto') AND value->>'paused' = 'true'
      AND updated_at >= ${since} AND updated_at <= ${now}
    ORDER BY updated_at DESC LIMIT ${limit}`;
  for (const r of outages) {
    const key = String(r.key);
    const code = key.split(".")[1] ?? "";
    const wallet = r.reason === "wallet_direction_auto";
    out.push({
      kind: wallet ? "supplier_wallet_paused" : "supplier_outage_paused",
      entityKind: "supplier_account",
      entityId: key,
      reason: wallet ? "supplier_wallet_paused" : "supplier_outage_paused",
      raisedAt: date(r.updated_at),
      orderId: null,
      orderReference: null,
      bookingId: null,
      supplierBookingRef: null,
      adminPath: /^[a-z0-9_-]+$/.test(code) ? `/admin/suppliers/${code}` : "/admin",
    });
  }

  const sagas = await prisma.$queryRaw<Row[]>`
    SELECT s.id, s.order_id, o.reference, s.attention_required_at,
      (SELECT b.id FROM supplier_bookings b WHERE b.order_item_id = s.order_item_id ORDER BY b.created_at DESC LIMIT 1) AS booking_id
    FROM payment_sagas s JOIN orders o ON o.id = s.order_id
    WHERE s.attention_required_at >= ${since} AND s.attention_required_at <= ${now}
    ORDER BY s.attention_required_at DESC LIMIT ${limit}`;
  for (const r of sagas) {
    out.push({
      kind: "saga_attention",
      entityKind: "payment_saga",
      entityId: String(r.id),
      reason: "saga_attention",
      raisedAt: date(r.attention_required_at),
      orderId: str(r.order_id),
      orderReference: str(r.reference),
      bookingId: str(r.booking_id),
      supplierBookingRef: null,
      adminPath: bookingPath(str(r.reference)),
    });
  }

  // A multi-item order's item refund refused or short (saga.ts recordItemProblem).
  const itemProblems = await prisma.$queryRaw<Row[]>`
    SELECT r.order_item_id, r.order_id, r.reason, r.created_at, r.supplier_booking_id, o.reference
    FROM customer_remedies r JOIN orders o ON o.id = r.order_id
    WHERE r.kind = 'refund' AND r.status = 'failed' AND r.refund_id IS NULL AND left(r.reason, 5) = 'item_'
      AND r.created_at >= ${since} AND r.created_at <= ${now}
    ORDER BY r.created_at DESC LIMIT ${limit}`;
  for (const r of itemProblems) {
    out.push({
      kind: "item_refund_problem",
      entityKind: "order_item",
      entityId: String(r.order_item_id),
      reason: String(r.reason),
      raisedAt: date(r.created_at),
      orderId: str(r.order_id),
      orderReference: str(r.reference),
      bookingId: str(r.supplier_booking_id),
      supplierBookingRef: null,
      adminPath: bookingPath(str(r.reference)),
    });
  }

  // A refund the provider failed (refunds.ts settle), or a cancellation left `refund_failed` and still open.
  const refunds = await prisma.$queryRaw<Row[]>`
    SELECT f.order_item_id, i.order_id, o.reference, f.updated_at AS raised_at
    FROM refunds f JOIN order_items i ON i.id = f.order_item_id JOIN orders o ON o.id = i.order_id
    WHERE f.status = 'failed' AND f.updated_at >= ${since} AND f.updated_at <= ${now}
    UNION ALL
    SELECT c.order_item_id, c.order_id, o.reference, c.attention_required_at AS raised_at
    FROM cancellation_requests c JOIN orders o ON o.id = c.order_id
    WHERE c.status = 'refund_failed' AND c.closed_at IS NULL
      AND c.attention_required_at >= ${since} AND c.attention_required_at <= ${now}
    ORDER BY raised_at DESC LIMIT ${limit}`;
  for (const r of refunds) {
    out.push({
      kind: "refund_failed",
      entityKind: "order_item",
      entityId: String(r.order_item_id),
      reason: "refund_failed",
      raisedAt: date(r.raised_at),
      orderId: str(r.order_id),
      orderReference: str(r.reference),
      bookingId: null,
      supplierBookingRef: null,
      adminPath: bookingPath(str(r.reference)),
    });
  }

  const bookings = await prisma.$queryRaw<Row[]>`
    SELECT b.id, b.state::text AS state, b.error_code, b.attention_required_at, b.recovery_searches, b.supplier_booking_id,
      b.order_id, o.reference, COALESCE(b.attention_required_at, b.updated_at) AS raised_at
    FROM supplier_bookings b LEFT JOIN orders o ON o.id = b.order_id
    WHERE (
        (b.error_code IN ('late_acceptance', 'late_acceptance_duplicate', 'charged_amount_mismatch', 'funds_unverified') AND b.attention_required_at IS NOT NULL)
        OR b.state IN ('manual_review', 'cancel_refused', 'not_found_unresolved')
        OR (b.state = 'outcome_unknown' AND b.recovery_searches >= 1)
      )
      AND COALESCE(b.attention_required_at, b.updated_at) >= ${since} AND COALESCE(b.attention_required_at, b.updated_at) <= ${now}
    ORDER BY raised_at DESC LIMIT ${limit}`;
  for (const r of bookings) {
    const reason = bookingReason({ state: String(r.state), errorCode: str(r.error_code), attention: r.attention_required_at !== null, recoverySearches: Number(r.recovery_searches) });
    if (!reason) continue;
    out.push({
      kind: "booking_attention",
      entityKind: "supplier_booking",
      entityId: String(r.id),
      reason,
      raisedAt: date(r.raised_at),
      orderId: str(r.order_id),
      orderReference: str(r.reference),
      bookingId: String(r.id),
      supplierBookingRef: str(r.supplier_booking_id),
      adminPath: bookingPath(str(r.reference)),
    });
  }

  // Tickets flagged for staff: the F12 thresholds and the staff-only reads already set `attention_required_at` (document.service.ts).
  const documents = await prisma.$queryRaw<Row[]>`
    SELECT d.id, d.supplier_booking_id, d.attention_required_at, b.confirmed_at, b.service_date, b.start_minutes, b.supplier_booking_id AS supplier_ref,
      b.order_id, o.reference
    FROM supplier_documents d JOIN supplier_bookings b ON b.id = d.supplier_booking_id LEFT JOIN orders o ON o.id = b.order_id
    WHERE d.status IN ('pending', 'incomplete', 'failed', 'quarantined')
      AND d.attention_required_at >= ${since} AND d.attention_required_at <= ${now}
    ORDER BY d.attention_required_at DESC LIMIT ${limit}`;
  for (const r of documents) {
    const raisedAt = date(r.attention_required_at);
    const urgent = urgentAt({ confirmedAt: r.confirmed_at ? date(r.confirmed_at) : null, serviceDate: date(r.service_date), startMinutes: r.start_minutes === null ? null : Number(r.start_minutes) });
    out.push({
      kind: "document_attention",
      entityKind: "supplier_document",
      entityId: String(r.id),
      reason: urgent && raisedAt.getTime() >= urgent.getTime() ? "tickets_missing_urgent" : "tickets_need_staff",
      raisedAt,
      orderId: str(r.order_id),
      orderReference: str(r.reference),
      bookingId: str(r.supplier_booking_id),
      supplierBookingRef: str(r.supplier_ref),
      adminPath: bookingPath(str(r.reference)),
    });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Service
 * ------------------------------------------------------------------------ */

export interface OpsAlertDispatch {
  event: StoredPayload["event"];
  recipient: string;
  orderId: string | null;
  context: StoredPayload["context"];
  /** The incident occurrence: one notification row (and provider key) per recipient. */
  once: string;
}

export interface OpsAlertDeps {
  collect(since: Date, now: Date): Promise<OpsIncident[]>;
  recipients(): string[];
  siteUrl(): string;
  dispatch(input: OpsAlertDispatch): Promise<DispatchResult>;
  now(): Date;
}

export interface OpsAlertSweepSummary {
  skipped?: "no_recipients";
  incidents: number;
  claimed: number;
  deduped: number;
  suppressed: number;
  digests: number;
  dispatched: number;
  dispatchFailed: number;
}

export function createOpsAlertService(deps: OpsAlertDeps) {
  let warnedNoRecipients = false;

  /** Decide every incident under one lock: send, wait (dedup), or suppress (throttle); then the digest. */
  async function claim(incidents: OpsIncident[], now: Date, summary: OpsAlertSweepSummary): Promise<void> {
    const siteUrl = deps.siteUrl();
    await prisma.$transaction(async (tx) => {
      // The digest row doubles as the sweep's lock: concurrent sweeps decide one after the other.
      await tx.$executeRaw`INSERT INTO ops_alerts (id, entity_kind, entity_id, reason, incident_at, handled_at, updated_at)
        VALUES (${uuidv7()}::uuid, ${DIGEST.entityKind}, ${DIGEST.entityId}, ${DIGEST.reason}, ${EPOCH}, ${EPOCH}, ${now})
        ON CONFLICT (entity_kind, entity_id, reason) DO NOTHING`;
      const [digest] = await tx.$queryRaw<{ id: string; last_sent_at: Date | null }[]>`
        SELECT id, last_sent_at FROM ops_alerts WHERE entity_kind = ${DIGEST.entityKind} AND entity_id = ${DIGEST.entityId} AND reason = ${DIGEST.reason} FOR UPDATE`;

      const hourAgo = new Date(now.getTime() - 3600_000);
      let sentThisHour = await tx.opsAlert.count({ where: { entityKind: { not: DIGEST.entityKind }, lastSentAt: { gt: hourAgo, lte: now } } });

      for (const i of incidents) {
        const where = { entityKind_entityId_reason: { entityKind: i.entityKind, entityId: i.entityId, reason: i.reason } };
        const row = await tx.opsAlert.findUnique({ where });
        if (row && i.raisedAt.getTime() <= row.incidentAt.getTime()) continue; // this raise was already handled
        if (row && now.getTime() - row.handledAt.getTime() < OPS_ALERT_DEDUP_MS) {
          summary.deduped++;
          continue;
        }
        const id = row?.id ?? uuidv7();
        if (sentThisHour < OPS_ALERT_HOURLY_CAP) {
          const payload: StoredPayload = {
            event: "OPS_INCIDENT_ALERT",
            once: `ops:${i.entityKind}:${i.entityId}:${i.reason}:${i.raisedAt.toISOString()}`,
            orderId: i.orderId,
            context: incidentContext(i, siteUrl),
          };
          const data = { incidentAt: i.raisedAt, handledAt: now, lastSentAt: now, payload: payload as object, dispatchPending: true };
          await tx.opsAlert.upsert({ where, create: { id, entityKind: i.entityKind, entityId: i.entityId, reason: i.reason, sends: 1, ...data }, update: { ...data, sends: { increment: 1 } } });
          sentThisHour++;
          summary.claimed++;
          emitEvent("alerts.claimed", { alertId: id, entityKind: i.entityKind, reason: i.reason }, "warn");
        } else {
          const data = { incidentAt: i.raisedAt, handledAt: now, lastSuppressedAt: now };
          await tx.opsAlert.upsert({ where, create: { id, entityKind: i.entityKind, entityId: i.entityId, reason: i.reason, suppressed: 1, ...data }, update: { ...data, suppressed: { increment: 1 } } });
          summary.suppressed++;
          emitEvent("alerts.suppressed", { alertId: id, entityKind: i.entityKind, reason: i.reason }, "warn");
        }
      }

      // At most one digest per hour, for what the throttle held back since the last one.
      const lastDigest = digest.last_sent_at;
      if (lastDigest && now.getTime() - lastDigest.getTime() < OPS_ALERT_DIGEST_EVERY_MS) return;
      const since = lastDigest ?? EPOCH;
      const held = await tx.opsAlert.count({ where: { entityKind: { not: DIGEST.entityKind }, lastSuppressedAt: { gt: since, lte: now } } });
      if (held === 0) return;
      const payload: StoredPayload = {
        event: "OPS_ALERT_DIGEST",
        once: `ops:digest:${now.toISOString()}`,
        orderId: null,
        context: { suppressedCount: held, sinceIso: (lastDigest ?? hourAgo).toISOString(), untilIso: now.toISOString(), adminUrl: adminUrl(siteUrl, "/admin/bookings") },
      };
      await tx.opsAlert.update({ where: { id: digest.id }, data: { incidentAt: now, handledAt: now, lastSentAt: now, sends: { increment: 1 }, payload: payload as object, dispatchPending: true } });
      summary.digests++;
      emitEvent("alerts.digest", { alertId: digest.id, count: held }, "warn");
    }, TX_OPTIONS);
  }

  /**
   * After the commit: hand each claimed row to the notification outbox, one
   * dispatch per recipient. The outbox dedups on `once`, so a row left pending
   * by a crash or a failed dispatch is re-handed on the next sweep without a
   * second email. A provider failure is the outbox's to retry; it never
   * reaches the caller.
   */
  async function dispatchPending(recipients: string[], summary: OpsAlertSweepSummary): Promise<void> {
    const rows = await prisma.opsAlert.findMany({ where: { dispatchPending: true }, orderBy: { handledAt: "asc" }, take: DISPATCH_LIMIT });
    for (const row of rows) {
      const p = row.payload as unknown as StoredPayload;
      let handed = true;
      for (const recipient of recipients) {
        try {
          const r = await deps.dispatch({ event: p.event, recipient, orderId: p.orderId ?? null, context: p.context, once: p.once });
          if (r.outcome !== "sent" && r.outcome !== "suppressed") summary.dispatchFailed++;
        } catch {
          handed = false;
          summary.dispatchFailed++;
          emitEvent("alerts.dispatch_failed", { alertId: row.id, reason: "dispatch_threw" }, "error");
        }
      }
      if (!handed) continue;
      await prisma.opsAlert.updateMany({ where: { id: row.id, dispatchPending: true, handledAt: row.handledAt }, data: { dispatchPending: false } });
      summary.dispatched++;
    }
  }

  return {
    /** Never throws: the scheduled sweep that calls it must carry on. */
    async sweep(): Promise<OpsAlertSweepSummary> {
      const summary: OpsAlertSweepSummary = { incidents: 0, claimed: 0, deduped: 0, suppressed: 0, digests: 0, dispatched: 0, dispatchFailed: 0 };
      const now = deps.now();
      const recipients = deps.recipients();
      if (!recipients.length) {
        if (!warnedNoRecipients) {
          warnedNoRecipients = true;
          emitEvent("alerts.no_recipients", { pending: null }, "warn");
        }
        return { ...summary, skipped: "no_recipients" };
      }
      warnedNoRecipients = false;

      let incidents: OpsIncident[] = [];
      try {
        incidents = latestPerKey(await deps.collect(new Date(now.getTime() - OPS_ALERT_LOOKBACK_MS), now));
        summary.incidents = incidents.length;
      } catch {
        emitEvent("alerts.sweep_failed", { stage: "collect", reason: "query_failed" }, "error");
      }
      try {
        await claim(incidents, now, summary);
      } catch {
        emitEvent("alerts.sweep_failed", { stage: "claim", reason: "transaction_failed" }, "error");
      }
      try {
        await dispatchPending(recipients, summary);
      } catch {
        emitEvent("alerts.sweep_failed", { stage: "dispatch", reason: "query_failed" }, "error");
      }
      return summary;
    },
  };
}

export const opsAlertService = createOpsAlertService({
  collect: (since, now) => collectOpsIncidents(since, now),
  recipients: () => env().opsAlertEmails,
  siteUrl: () => env().NEXT_PUBLIC_SITE_URL,
  dispatch: (input) =>
    notificationService.dispatch({
      event: input.event,
      channel: "email",
      recipient: input.recipient,
      orderId: input.orderId ?? undefined,
      // Codes, ids and the order reference only (OpsAlertContext); rendered from this stored context on every attempt.
      context: input.context as unknown as TemplateContext,
      once: input.once,
    }),
  now: () => new Date(),
});
