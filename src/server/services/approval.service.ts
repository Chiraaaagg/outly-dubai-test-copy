import "server-only";
import { Prisma, type PrivilegedApproval as ApprovalRow } from "@prisma/client";
import { prisma, TX_OPTIONS, type Tx } from "../lib/db";
import { Errors } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { openTotpSecret, sha256Hex, verifyTotp } from "../lib/crypto";
import { enforceRateLimit } from "../lib/rate-limit";
import { audit } from "../lib/audit";
import { hasPermission, type Actor } from "../lib/actor";
import type { Permission } from "../lib/permissions";
import { adminRepo } from "../repositories/admin.repo";
import { authService } from "./auth.service";
import type { PrivilegedApproval, PrivilegedOperation } from "../suppliers/booking-port";

/**
 * Step-up and dual approval for privileged operations (SEC-10, PRD-12; doc 22
 * §24.3). Rows live in `privileged_approvals` (migration 20261101110000).
 *
 *  - Every request and every approval needs a fresh TOTP code from the person
 *    acting. Codes share the login replay guard (`admin_totp` keys), so a
 *    code that signed someone in cannot also approve, and the reverse.
 *  - `test`: applied as soon as the requester has stepped up.
 *  - `production`: pending until a different staff member holding the same
 *    permission approves, within 30 minutes. Approval is either
 *    `approvePrivileged` on the approval id, or the second person requesting
 *    the identical payload. The database refuses an approver equal to the
 *    requester and an applied production row without an approver.
 *
 * `applied` means "go ahead": the caller performs the operation. Audit rows
 * carry the payload hash and its field names, never its values.
 */

export const APPROVAL_TTL_MS = 30 * 60_000;

/** The permission each operation needs. A mismatched pair is refused. */
export const OPERATION_PERMISSION: Readonly<Record<PrivilegedOperation, Permission>> = Object.freeze({
  "instant.activate": "products.activate_instant",
  "supplier.resume": "suppliers.resume",
  "supplier.limits.raise": "suppliers.limits.raise",
  "booking.privileged_resolution": "bookings.privileged_resolution",
});

export type ApprovalEnvironment = "test" | "production";

/** JSON values plus bigint (money in minor units). */
export type PrivilegedPayload = Record<string, unknown>;

export interface PrivilegedRequestOptions {
  environment: ApprovalEnvironment;
  totpCode: string;
  /** Test seam for the clock; production callers leave it unset. */
  now?: Date;
}

type StepUpFailure = "invalid_code" | "replayed" | "not_enrolled";

/**
 * Canonical JSON form: object keys sorted, bigint tagged so `5n` and `"5"`
 * hash differently, Dates as ISO strings, undefined object fields dropped.
 */
export function canonicalPayload(value: unknown): unknown {
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalPayload(v)));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalPayload(v);
    }
    return out;
  }
  if (typeof value === "function" || typeof value === "symbol") throw new TypeError("Privileged payload must be plain data");
  return value;
}

/** sha256 hex over the operation, permission, environment and canonical payload. */
export function privilegedPayloadHash(operation: PrivilegedOperation, permission: string, environment: ApprovalEnvironment, payload: PrivilegedPayload): string {
  return sha256Hex(JSON.stringify(canonicalPayload({ operation, permission, environment, payload })));
}

/** What an audit row may say about a request: names and hashes only. */
function describe(operation: string, permission: string, environment: string, payloadHash: string, payload: unknown) {
  const fields = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? Object.keys(payload).sort() : [];
  return { operation, permission, environment, payloadHash, payloadFields: fields };
}

function rowSummary(row: ApprovalRow) {
  return describe(row.operation, row.permission, row.environment, row.payloadHash, row.payload);
}

/** A person: staff actors only, never the system actor or a customer. */
function staffId(actor: Actor): string | null {
  return (actor.type === "admin" || actor.type === "agent") && actor.id ? actor.id : null;
}

/**
 * Verifies a fresh TOTP code for `userId` and burns it. Same rate-limit
 * bucket and replay keys as the login TOTP step (auth.service.ts).
 */
async function stepUp(userId: string, code: string, now: Date): Promise<StepUpFailure | null> {
  await enforceRateLimit({ key: `admin_totp:${userId}`, limit: 8, windowSeconds: 600 });
  const user = await adminRepo.findTotpSecret(userId);
  if (!user || user.deletedAt || user.status !== "active" || !user.totpEnabled || !user.totpSecretEncrypted) return "not_enrolled";
  // Lazy TOTP re-wrap (B4 recheck P3-2): a secret still under the temporary legacy key verifies, then moves to the current key.
  const opened = openTotpSecret(user.totpSecretEncrypted);
  if (!verifyTotp(opened.secret, code, now.getTime())) return "invalid_code";
  const replayKey = `totp:${userId}:${sha256Hex(code.replace(/\s+/g, "")).slice(0, 24)}`;
  try {
    // Outside any transaction: a duplicate-key error would abort it.
    await prisma.idempotencyKey.create({
      data: { key: replayKey, scope: "admin_totp", requestHash: "used", completedAt: new Date(), expiresAt: new Date(Date.now() + 120_000) },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "replayed";
    throw error;
  }
  // Only after the code matched and was burned; the re-wrap is conditional and never throws.
  if (opened.legacy) await authService.rewrapLegacyTotp(userId, user.totpSecretEncrypted, opened.secret);
  return null;
}

/**
 * A fresh TOTP step-up for a staff actor outside the privileged-approval
 * flow (accepting a large FX move, fx-refresh.service.ts). Same rate limit,
 * replay guard and re-wrap as `stepUp`; null means the code was accepted and
 * burned. The system actor and customers are never enrolled.
 */
export async function verifyStepUp(actor: Actor, code: string, now = new Date()): Promise<StepUpFailure | null> {
  const userId = staffId(actor);
  if (!userId) return "not_enrolled";
  return stepUp(userId, code, now);
}

async function refuse(
  actor: Actor,
  entity: { type: string; id: string },
  summary: ReturnType<typeof describe>,
  reason: Extract<PrivilegedApproval, { status: "refused" }>["reason"],
  detail?: StepUpFailure,
  tx: Tx | typeof prisma = prisma,
): Promise<PrivilegedApproval> {
  await audit(actor, "privileged.refused", entity, { after: { ...summary, reason, ...(detail ? { stepUp: detail } : {}) } }, tx);
  return { status: "refused", reason };
}

export const approvalService = {
  /**
   * Ask to perform a privileged operation. Returns `applied` (go ahead),
   * `pending` (production: waiting for a second person) or `refused`.
   */
  async requestPrivileged(
    actor: Actor,
    operation: PrivilegedOperation,
    permission: Permission,
    payload: PrivilegedPayload,
    opts: PrivilegedRequestOptions,
  ): Promise<PrivilegedApproval> {
    const now = opts.now ?? new Date();
    const environment = opts.environment;
    if (environment !== "test" && environment !== "production") throw Errors.validation({ environment: "Must be test or production" });
    const payloadHash = privilegedPayloadHash(operation, permission, environment, payload);
    const summary = describe(operation, permission, environment, payloadHash, payload);
    const entity = { type: "privileged_operation", id: operation };

    const userId = staffId(actor);
    if (!userId || OPERATION_PERMISSION[operation] !== permission || !hasPermission(actor, permission)) {
      return refuse(actor, entity, summary, "forbidden");
    }
    const failed = await stepUp(userId, opts.totpCode, now);
    if (failed) return refuse(actor, entity, summary, "step_up_required", failed);

    const stored = canonicalPayload(payload) as Prisma.InputJsonValue;
    const expiresAt = new Date(now.getTime() + APPROVAL_TTL_MS);

    return prisma.$transaction(async (tx): Promise<PrivilegedApproval> => {
      if (environment === "test") {
        const id = uuidv7();
        await tx.privilegedApproval.create({
          data: { id, operation, permission, payload: stored, payloadHash, environment, status: "applied", requestedBy: userId, requestedAt: now, appliedAt: now, expiresAt },
        });
        await audit(actor, "privileged.applied", { type: "privileged_approval", id }, { after: { ...summary, approvers: [] } }, tx);
        return { status: "applied", approvalId: id };
      }

      await tx.privilegedApproval.updateMany({ where: { payloadHash, status: "pending", expiresAt: { lte: now } }, data: { status: "expired" } });

      // Someone else asked for exactly this: this request is the second approval.
      const other = await tx.privilegedApproval.findFirst({
        where: { payloadHash, environment, permission, status: "pending", expiresAt: { gt: now }, requestedBy: { not: userId } },
        orderBy: { requestedAt: "asc" },
      });
      if (other) {
        const won = await tx.privilegedApproval.updateMany({
          where: { id: other.id, status: "pending", expiresAt: { gt: now }, requestedBy: { not: userId } },
          data: { status: "applied", approvedBy: userId, approvedAt: now, appliedAt: now },
        });
        if (won.count === 1) {
          await audit(actor, "privileged.approved", { type: "privileged_approval", id: other.id }, { after: { ...summary, via: "matching_request" } }, tx);
          await audit(actor, "privileged.applied", { type: "privileged_approval", id: other.id }, { after: { ...summary, approvers: [userId] } }, tx);
          return { status: "applied", approvalId: other.id };
        }
      }

      const own = await tx.privilegedApproval.findFirst({
        where: { payloadHash, environment, status: "pending", expiresAt: { gt: now }, requestedBy: userId },
        orderBy: { requestedAt: "desc" },
      });
      if (own) {
        await audit(actor, "privileged.requested", { type: "privileged_approval", id: own.id }, { after: { ...summary, repeated: true } }, tx);
        return { status: "pending", approvalId: own.id, needs: "second_approver" };
      }

      const id = uuidv7();
      await tx.privilegedApproval.create({
        data: { id, operation, permission, payload: stored, payloadHash, environment, status: "pending", requestedBy: userId, requestedAt: now, expiresAt },
      });
      await audit(actor, "privileged.requested", { type: "privileged_approval", id }, { after: { ...summary, expiresAt: expiresAt.toISOString() } }, tx);
      return { status: "pending", approvalId: id, needs: "second_approver" };
    }, TX_OPTIONS);
  },

  /**
   * Second person approves a pending request. Refused for the requester
   * themself, without the request's permission, without a fresh TOTP code,
   * or after the request expired.
   */
  async approvePrivileged(actor: Actor, approvalId: string, totpCode: string, opts: { now?: Date } = {}): Promise<PrivilegedApproval> {
    const now = opts.now ?? new Date();
    const row = await prisma.privilegedApproval.findUnique({ where: { id: approvalId } });
    if (!row) throw Errors.notFound("Approval request");
    const summary = rowSummary(row);
    const entity = { type: "privileged_approval", id: row.id };

    const userId = staffId(actor);
    if (!userId || !hasPermission(actor, row.permission as Permission)) return refuse(actor, entity, summary, "forbidden");
    if (row.requestedBy === userId) return refuse(actor, entity, summary, "same_person");
    if (row.status === "applied") {
      if (row.approvedBy === userId) return { status: "applied", approvalId: row.id };
      throw Errors.conflict("This request has already been decided");
    }
    if (row.status === "cancelled") throw Errors.conflict("This request was cancelled");
    if (row.status === "expired" || row.expiresAt <= now) {
      await prisma.privilegedApproval.updateMany({ where: { id: row.id, status: "pending" }, data: { status: "expired" } });
      return refuse(actor, entity, summary, "expired");
    }

    const failed = await stepUp(userId, totpCode, now);
    if (failed) return refuse(actor, entity, summary, "step_up_required", failed);

    return prisma.$transaction(async (tx): Promise<PrivilegedApproval> => {
      const won = await tx.privilegedApproval.updateMany({
        where: { id: row.id, status: "pending", expiresAt: { gt: now }, requestedBy: { not: userId } },
        data: { status: "applied", approvedBy: userId, approvedAt: now, appliedAt: now },
      });
      if (won.count !== 1) {
        const current = await tx.privilegedApproval.findUniqueOrThrow({ where: { id: row.id } });
        if (current.status === "applied" && current.approvedBy === userId) return { status: "applied", approvalId: row.id };
        if (current.status === "pending" || current.status === "expired") return refuse(actor, entity, summary, "expired", undefined, tx);
        throw Errors.conflict("This request has already been decided");
      }
      await audit(actor, "privileged.approved", entity, { after: { ...summary, via: "approve" } }, tx);
      await audit(actor, "privileged.applied", entity, { after: { ...summary, approvers: [userId] } }, tx);
      return { status: "applied", approvalId: row.id };
    }, TX_OPTIONS);
  },
};
