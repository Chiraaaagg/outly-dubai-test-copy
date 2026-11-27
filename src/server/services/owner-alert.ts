import "server-only";
import type { Prisma } from "@prisma/client";
import type { Actor } from "../lib/actor";
import { prisma, type Tx } from "../lib/db";
import { env } from "../lib/env";
import { uuidv7 } from "../lib/ids";
import { emitEvent } from "../lib/structured-events";
import type { OwnerAlertContext } from "../notifications/templates";
import type { PrivilegedOperation } from "../suppliers/booking-port";
import type { OpsIncident } from "./ops-alert.service";

/**
 * The owner alert of the one-person approval path (doc 30 §3.11, N2; owner
 * decisions D15, D16, D25; review P30-07).
 *
 *  - Recipient: `OWNER_ALERT_EMAIL`, an environment value. The acting
 *    administrator cannot change it from the console. Unset (or not an email
 *    address) means the one-person path is off: approval.service keeps the
 *    two-person rule.
 *  - Queued in the approval's own transaction (`queueOwnerAlertInTx`): one
 *    `notifications` row, status `queued`, no claim. If the insert fails the
 *    approval rolls back with it, so an action never applies without its
 *    alert queued.
 *  - Sent after the commit (`sendOwnerAlert`, best effort) and otherwise by
 *    the outbox sweep (`notificationService.retryFailed`), which picks up
 *    unclaimed `queued` rows. A failed or ambiguous delivery never undoes the
 *    action: `ownerAlertIncidents` turns it into an ops alert
 *    (ops-alert.service.ts), sent to the ops recipients.
 *
 * The row holds ids, codes and short facts only (`OwnerAlertContext`).
 */

export const OWNER_ALERT_EVENT = "OWNER_ACTION_ALERT";
/** A queued owner alert not sent after this long is reported as an ops incident. */
export const OWNER_ALERT_LATE_MS = 30 * 60_000;

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** The owner alert address, or null when the one-person path is off. */
export function ownerAlertRecipient(raw: string | undefined = env().OWNER_ALERT_EMAIL): string | null {
  const v = raw?.trim();
  return v && v.length <= 254 && EMAIL.test(v) ? v : null;
}

const TITLES: Record<string, string> = {
  "instant.activate": "Instant selling switched on for one listing",
  "instant.activate.bulk": "Bulk run on instant listings started",
  "supplier.capability.enable": "Offer class switched on or proof recorded",
};

/** Payload fields an alert may repeat, and the shape each must have. Anything else is left out. */
const SAFE_FACTS: Record<string, RegExp> = {
  kind: /^[a-z_]{1,40}$/,
  action: /^[a-z_]{1,40}$/,
  productId: /^[0-9a-f-]{36}$/,
  classKey: /^[a-z_]+(\.[a-z_]+){4}$/,
  environment: /^(test|production)$/,
  scopeKind: /^(all|provider|tours)$/,
  offerExternalId: /^[1-9][0-9]{0,9}$/,
  itemsHash: /^[0-9a-f]{64}$/,
};

/** Numeric payload fields an alert may repeat. */
const SAFE_COUNTS = ["itemCount"] as const;

/** Short `key: value` lines from a privileged payload, whitelisted (never a reference, reason or free text). */
export function alertFacts(payload: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, shape] of Object.entries(SAFE_FACTS)) {
    const v = payload[key];
    if (typeof v === "string" && shape.test(v)) out.push(`${key}: ${v}`);
  }
  if (typeof payload.enabled === "boolean") out.push(`enabled: ${payload.enabled}`);
  for (const key of SAFE_COUNTS) {
    const v = payload[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1000) out.push(`${key}: ${v}`);
  }
  return out;
}

export interface OwnerAlertInput {
  approvalId: string;
  operation: PrivilegedOperation;
  environment: string;
  actor: Actor;
  itemCount: number;
  payload: Record<string, unknown>;
  at: Date;
}

/** The stored context. Pure, for tests (the no-secret check). */
export function ownerAlertContext(input: OwnerAlertInput, siteUrl: string): OwnerAlertContext {
  return {
    operation: input.operation,
    title: TITLES[input.operation] ?? "Privileged action applied by one administrator",
    environment: input.environment,
    approvalId: input.approvalId,
    actorName: (input.actor.displayName ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "An administrator",
    actorId: input.actor.id ?? "unknown",
    itemCount: input.itemCount,
    facts: alertFacts(input.payload),
    appliedAt: input.at.toISOString(),
    adminUrl: `${siteUrl.replace(/\/+$/, "")}/admin/audit`,
  };
}

/**
 * Queue the owner alert inside the approval's transaction. Throws when no
 * recipient is configured: the caller checks `ownerAlertRecipient` first and
 * never reaches here without one. Returns the notification id.
 */
export async function queueOwnerAlertInTx(tx: Tx, input: OwnerAlertInput): Promise<string> {
  const recipient = ownerAlertRecipient();
  if (!recipient) throw new Error("owner alert recipient is not configured");
  const id = uuidv7();
  const context = ownerAlertContext(input, env().NEXT_PUBLIC_SITE_URL);
  await tx.notification.create({
    data: {
      id,
      event: OWNER_ALERT_EVENT,
      channel: "email",
      recipient,
      payload: context as unknown as Prisma.InputJsonValue,
      status: "queued",
      attempt: 1,
      lockedUntil: null,
      // One alert per approval: a retried transaction can never queue a second one.
      dedupKey: `owner_alert:${input.approvalId}`,
      createdAt: input.at,
    },
  });
  return id;
}

/**
 * After the commit: try the queued alert once now. Never throws; the outbox
 * sweep retries, and a failure becomes an ops alert (`ownerAlertIncidents`).
 */
export async function sendOwnerAlert(notificationId: string, now: Date = new Date()): Promise<void> {
  try {
    const { notificationService } = await import("./notification.service");
    await notificationService.retryFailed(1, now, { ids: [notificationId] });
  } catch {
    emitEvent("notification.failed", { notificationId, event: OWNER_ALERT_EVENT, channel: "email", reason: "owner_alert_send_threw" }, "error");
  }
}

interface AlertRow {
  id: string;
  status: string;
  attempt: number;
  providerError: string | null;
  failedAt: Date | null;
  attentionRequiredAt: Date | null;
  createdAt: Date;
  payload: unknown;
}

/** Why a stored owner alert needs ops, and since when; null while it may still go out. Pure, for tests. */
export function ownerAlertProblem(row: AlertRow, now: Date): { reason: string; raisedAt: Date } | null {
  if (row.status === "sent" || row.status === "delivered" || row.status === "read") return null;
  if (row.attentionRequiredAt) return { reason: "owner_alert_attention", raisedAt: row.attentionRequiredAt };
  if (row.status === "suppressed") return { reason: "owner_alert_suppressed", raisedAt: row.createdAt };
  if (row.status === "failed" && (row.providerError?.startsWith("definite:") || row.attempt >= 4)) {
    return { reason: "owner_alert_failed", raisedAt: row.failedAt ?? row.createdAt };
  }
  const late = new Date(row.createdAt.getTime() + OWNER_ALERT_LATE_MS);
  if (now.getTime() >= late.getTime()) return { reason: "owner_alert_late", raisedAt: late };
  return null;
}

function approvalIdOf(payload: unknown): string | null {
  const v = payload && typeof payload === "object" ? (payload as Record<string, unknown>).approvalId : null;
  return typeof v === "string" && /^[0-9a-f-]{36}$/.test(v) ? v : null;
}

/** Ops incidents for owner alerts that failed, need a human, were suppressed, or are late. Ids only. */
export async function ownerAlertIncidents(since: Date, now: Date, limit = 100): Promise<OpsIncident[]> {
  const rows = await prisma.notification.findMany({
    where: { event: OWNER_ALERT_EVENT, createdAt: { gt: new Date(since.getTime() - OWNER_ALERT_LATE_MS) }, status: { notIn: ["sent", "delivered", "read"] } },
    select: { id: true, status: true, attempt: true, providerError: true, failedAt: true, attentionRequiredAt: true, createdAt: true, payload: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  const out: OpsIncident[] = [];
  for (const r of rows) {
    const problem = ownerAlertProblem(r, now);
    if (!problem || problem.raisedAt.getTime() < since.getTime()) continue;
    out.push({
      kind: "owner_alert_failed",
      entityKind: "privileged_approval",
      entityId: approvalIdOf(r.payload) ?? r.id,
      reason: problem.reason,
      raisedAt: problem.raisedAt,
      orderId: null,
      orderReference: null,
      bookingId: null,
      supplierBookingRef: null,
      adminPath: "/admin/audit",
    });
  }
  return out;
}
