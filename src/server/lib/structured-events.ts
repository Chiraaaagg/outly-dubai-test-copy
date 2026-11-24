import "server-only";
import { log } from "./logger";

/**
 * Allowlisted structured events (SEC-18, PRV-6). New B4 code reports what
 * happened through `emitEvent`, never through free-form `log.*` fields:
 *
 *  - only events listed here are written; an unlisted name writes a single
 *    `event.unlisted` warning with the name and nothing else;
 *  - only the keys listed for the event survive;
 *  - a value survives only when it is a finite number, a boolean, null, an
 *    ISO timestamp, or a short code (letters, digits, `_.:-`, at most 80
 *    characters). A key ending in `Id` takes a UUID only. Free text, URLs, e-mail
 *    addresses, phone numbers with `+`, objects and arrays are dropped.
 *
 * So supplier or provider text, ticket codes and capability tokens cannot
 * reach the log drain through these events, whatever a caller passes. The
 * logger's own redaction still runs afterwards.
 *
 * Add an event here (with its keys) in the same change that first emits it.
 */
export const STRUCTURED_EVENTS = {
  // Tickets and documents (TKT-1, TKT-2, F12, F13, F36, F47, F48)
  "keys.rewrapped": ["purpose", "scanned", "rewrapped", "raced", "failed", "reason"],
  "tickets.persisted": ["supplierBookingId", "documentId", "version", "count", "status", "source"],
  "tickets.persist_failed": ["supplierBookingId", "reason"],
  "tickets.pending": ["supplierBookingId", "documentId", "reason", "automatic"],
  "tickets.incomplete": ["supplierBookingId", "documentId", "expectedTotal", "issuedTotal"],
  "document.read": ["supplierBookingId", "documentId", "outcome", "reason"],
  "document.fetched": ["documentId", "kind", "version", "byteSize"],
  "document.quarantined": ["documentId", "kind", "reason"],
  "document.superseded": ["documentId", "kind", "version"],
  "document.refetch_requested": ["documentId", "reason"],
  "document.attention": ["documentId", "supplierBookingId", "reason", "ageMs"],
  "document.served": ["documentId", "accessKind", "grantId", "issuedFor"],
  "document.access_denied": ["reason", "accessKind", "grantId", "issuedFor"],
  "document.store_error": ["documentId", "operation", "reason"],
  // Guest capabilities (TKT-5, F39)
  "capability.minted": ["grantId", "purpose", "issuedFor"],
  "capability.revoked": ["grantId", "reason"],
  "capability.exchanged": ["grantId", "purpose"],
  "capability.refused": ["reason"],
  // Guest same-browser download grant at checkout (checkout redesign batch 3, CO-02)
  "capability.checkout_issued": ["grantId", "reused"],
  "capability.checkout_refused": ["reason"],
  "capability.browser_access_removed": ["revoked", "entries", "guestSession"],
  // Notification outbox (TKT-6, F14)
  "notification.queued": ["notificationId", "event", "channel"],
  "notification.duplicate": ["notificationId", "event"],
  "notification.sent": ["notificationId", "event", "channel", "provider"],
  "notification.failed": ["notificationId", "event", "channel", "httpStatus", "reason"],
  "notification.unknown": ["notificationId", "event", "channel", "reason"],
  "notification.reconciled": ["notificationId", "outcome"],
  "notification.suppressed": ["notificationId", "event", "channel", "reason"],
  "notification.attention": ["notificationId", "event", "reason"],
  // Privacy (PRV-3)
  "privacy.erasure_deferred": ["requestId", "obligations"],
  "privacy.erasure_completed": [
    "requestId",
    "inquiries",
    "orders",
    "guests",
    "customers",
    "notifications",
    "supplierBookings",
    "webhookEvents",
    "codeRowsDeleted",
    "documents",
    "grants",
    "verifications",
    "partial",
  ],
  // Key rings (PRV-5): an existing path degraded because a ring is missing (R-B4-3)
  "keys.unavailable": ["purpose", "path"],
  // Customer order recovery (B5, F23). Never the contact, the code or the order reference.
  "recovery.started": ["challengeId", "channel"],
  "recovery.start_decoy": ["channel"],
  "recovery.start_budget_exhausted": ["scope", "storeUnavailable"],
  "recovery.code_delivery": ["challengeId", "channel", "outcome"],
  "recovery.verify_refused": ["reason"],
  "recovery.verify_daily_cap": ["scope", "storeUnavailable"],
  "recovery.verified": ["challengeId", "grantId", "channel"],
  // Customer cancellation requests (B5, F15, F51)
  "cancellation.requested": ["requestId", "kind", "via"],
  "cancellation.sent": ["requestId"],
  "cancellation.engine_refused": ["requestId", "reason"],
  "cancellation.stuck": ["requestId", "reason"],
  "cancellation.refused": ["requestId"],
  "cancellation.refund_opened": ["requestId", "refundId"],
  "cancellation.refund_refused": ["requestId", "reason"],
  "cancellation.refund_failed": ["requestId"],
  "cancellation.refunded": ["requestId"],
  "cancellation.advance_failed": ["requestId", "reason"],
  // Supplier outage circuit breaker (doc 22 §32.22): a new-sales pause set automatically, and a breaker fault
  "supplier.outage_paused": ["supplierCode", "environment", "account", "failures", "reason", "lastReason"],
  "supplier.outage_breaker_failed": ["reason"],
  // Supplier wallet funds (doc 29 §4.5, D1): a reserve held back by the fail-closed check, the direction guard's verdict, its pause and its faults. Codes only, never an amount.
  "supplier.funds_unverified": ["environment", "account", "reason"],
  "supplier.wallet_direction": ["environment", "account", "verdict"],
  "supplier.wallet_paused": ["supplierCode", "environment", "account", "reason", "verdict"],
  "supplier.wallet_guard_failed": ["reason"],
  // Ops alert emails for instant-path incidents (doc 22 §32.24). Codes and counts only.
  "alerts.claimed": ["alertId", "entityKind", "reason"],
  "alerts.suppressed": ["alertId", "entityKind", "reason"],
  "alerts.digest": ["alertId", "count"],
  "alerts.dispatch_failed": ["alertId", "reason"],
  "alerts.no_recipients": ["pending"],
  "alerts.sweep_failed": ["stage", "reason"],
  // Payments job health (B3 recheck N1)
  "payments.tick_out_of_time": ["pass", "visited", "skipped", "consecutive"],
  "payments.tick_starved": ["pass", "consecutive"],
  // Documents right after a supplier confirm (checkout redesign batch 4, CO-40): best effort, the documents tick is the net.
  "document.after_confirm": ["supplierBookingId", "outcome", "reason", "claimed"],
  // Bitrix24 CRM push (doc 29 §6.4, §6.5; CRM batch C1). Method names, codes, counts and local ids only:
  // never a CRM URL, credential, record content or provider message.
  "crm.call": ["method", "status", "durationMs", "outcome"],
  "crm.enqueue_failed": ["entityType", "entityId", "count", "reason"],
  "crm.enqueue_deferred": ["entityType", "entityId", "kind"],
  "crm.run": ["outcome", "reason", "processed", "pushed", "failed", "dead", "throttled", "breakerOpen", "foreignDue", "durationMs"],
  "crm.row_done": ["outboxId", "entityType", "entityId", "op", "outcome"],
  "crm.row_failed": ["outboxId", "entityType", "entityId", "op", "reason", "attempts"],
  "crm.dead_letter": ["outboxId", "entityType", "entityId", "op", "reason", "attempts"],
  "crm.twin_detected": ["entityType", "entityId", "count"],
  "crm.circuit_open": ["reason", "pausedUntil", "failures"],
  "crm.refused": ["reason"],
  "crm.retention": ["scheduled", "purgedOutbox", "purgedLinks"],
  "crm.probe": ["mode", "ok", "dealId", "created", "notOk", "deleted"],
  "crm.currency_mismatch": ["entityType", "entityId"],
  "crm.erasure_unverified": ["entityType", "entityId", "reason"],
  // Retention purge (doc 26 §2; doc 29 Batch 1c). Counts, a table name and a reason code only.
  "retention.purged": [
    "otpChallenges",
    "customerSessions",
    "adminSessions",
    "grants",
    "contactVerifications",
    "quotes",
    "guestSessions",
    "failed",
    "incomplete",
    "outOfTime",
    "durationMs",
  ],
  "retention.purge_failed": ["table", "reason", "batches"],
  // Request timing (doc 29 §6.6; Batch 1c). A fixed route code, the status and durations only.
  "route.timing": ["route", "status", "totalMs", "supplierMs", "supplierCalls", "dbMs", "dbQueries"],
  // Quote budget alert (review 82; quote-budget-alert.ts). Supplier and environment codes and the episode's refusal count only.
  "supplier.quote_budget_refused": ["supplier", "environment", "refusals", "episodeStart"],
  // Admin re-run of readiness without supplier calls (doc 29 §9.4). Counts only.
  "readiness.rerun": ["candidates", "instant", "inquiry", "durationMs"],
} as const satisfies Record<string, readonly string[]>;

export type StructuredEventName = keyof typeof STRUCTURED_EVENTS;
type Level = "info" | "warn" | "error";

const CODE = /^[A-Za-z0-9_.:-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function safeValue(v: unknown): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v.toISOString();
  if (typeof v === "string") return CODE.test(v) || ISO.test(v) ? v : undefined;
  return undefined;
}

/** The allowlisted part of `fields` for `name`. Exported for tests. */
export function structuredFields(name: string, fields: Record<string, unknown> = {}): Record<string, unknown> | null {
  const keys = (STRUCTURED_EVENTS as Record<string, readonly string[]>)[name];
  if (!keys) return null;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (!(k in fields)) continue;
    // An id key takes a UUID only: a ticket code or token is code-shaped and
    // would otherwise pass as an "id" (TKT-9).
    const raw = fields[k];
    const v = k.endsWith("Id") && raw !== null && !(typeof raw === "string" && UUID.test(raw)) ? undefined : safeValue(raw);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function emitEvent(name: StructuredEventName, fields: Record<string, unknown> = {}, level: Level = "info"): void {
  const safe = structuredFields(name, fields);
  if (!safe) {
    log.warn("event.unlisted", { event: CODE.test(String(name)) ? String(name) : "invalid" });
    return;
  }
  log[level](name, safe);
}
