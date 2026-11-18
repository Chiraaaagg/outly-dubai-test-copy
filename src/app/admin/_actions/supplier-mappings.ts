"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Actor } from "@/server/lib/actor";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { parseWith } from "@/server/lib/http";
import { approvalService, OPERATION_PERMISSION } from "@/server/services/approval.service";
import { authService } from "@/server/services/auth.service";
import {
  bookingAccountId,
  bookingControl,
  type ControlChange,
  controlApprovalPayload,
  supplierBookingService,
  TRAVELDESK_SUPPLIER_CODE,
} from "@/server/services/supplier-booking.service";
import { supplierCatalogService } from "@/server/services/supplier-catalog.service";
import { type CatalogueSyncResult, runTravelDeskCatalogueSync } from "@/server/services/traveldesk-catalogue-sync.service";
import { traveldeskConfigFrom } from "@/server/suppliers/traveldesk/traveldesk.config";
import { form, runAction, type ActionResult } from "./result";

/**
 * TravelDesk mapping review (docs/backend/21 §2–§3). Approve writes a supplier
 * mapping; it never changes fulfilment mode or price. `suppliers.manage` is
 * checked here and again inside the service.
 */

const reviewSchema = z
  .object({
    id: z.uuid(),
    decision: z.enum(["approve", "reject", "revoke", "reopen"]),
    note: z.string().trim().min(8, "Give a reason of at least 8 characters").max(500),
  })
  .strict();

export type ReviewCandidateResult = ActionResult<{ id: string; state: "suggested" | "approved" | "rejected" }>;

export async function reviewCandidateAction(_prev: ReviewCandidateResult | null, fd: FormData): Promise<ReviewCandidateResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("suppliers.manage");
    const input = parseWith(reviewSchema, { id: form.str(fd, "id"), decision: form.str(fd, "decision"), note: form.str(fd, "note") ?? "" });
    const after =
      input.decision === "revoke"
        ? await supplierCatalogService.revokeCandidate(actor, input.id, input.note)
        : input.decision === "reopen"
          ? await supplierCatalogService.reopenCandidate(actor, input.id, input.note)
          : await supplierCatalogService.reviewCandidate(actor, input.id, input.decision, input.note);
    revalidatePath("/admin/suppliers/traveldesk");
    return { id: after.id, state: after.state };
  });
}

/**
 * Booking controls (SUP-2, SUP-10; SEC-10 and PRD-12 for who may change them).
 *
 *  - Tightening (pause, emergency stop, a lower cap, a higher floor) needs
 *    `suppliers.pause` and nothing else: stopping must stay easy.
 *  - Loosening (resume, clearing an emergency stop, a higher cap, a lower
 *    floor) goes through approval.service: a fresh TOTP code (`totpCode`), and
 *    in production a second staff member with the same permission
 *    (`suppliers.resume` or `suppliers.limits.raise`). Until then the result is
 *    `pending` with the approval id; the second person approves with
 *    `approveBookingControlAction`, which applies the change.
 *
 * Controls are per environment and supplier account. A form that does not post
 * an environment acts on test. The account is the pinned TravelDesk agency of
 * the configured environment; `default` in test while nothing is pinned.
 */
const environmentField = z.enum(["test", "production"]).default("test");
const totpField = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app").optional();

const pauseSchema = z
  .object({
    target: z.enum(["pause", "resume"]),
    /** new_sales (default) holds intake, reserve and create; all_writes also holds confirm. */
    scope: z.enum(["new_sales", "all_writes"]).default("new_sales"),
    environment: environmentField,
    reason: z.string().trim().max(300).optional(),
    note: z.string().trim().min(8, "Give a reason of at least 8 characters").max(500),
    totpCode: totpField,
  })
  .strict();

const limitsSchema = z
  .object({
    environment: environmentField,
    maxBookingAed: z.coerce.number().int().positive().max(100_000),
    minFundsAfterAed: z.coerce.number().int().min(0).max(10_000_000),
    note: z.string().trim().min(8, "Give a reason of at least 8 characters").max(500),
    totpCode: totpField,
  })
  .strict();

const approveSchema = z
  .object({
    approvalId: z.uuid(),
    note: z.string().trim().min(8, "Give a reason of at least 8 characters").max(500),
    totpCode: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app"),
  })
  .strict();

/** `pending`: waiting for a second approver (production); the change is not made yet. */
export type BookingControlResult = ActionResult<{ paused: boolean; status: "applied" | "pending"; approvalId: string | null }>;

/** The supplier account whose controls an environment uses, or a refusal when production has none pinned here. */
function controlAccount(environment: "test" | "production"): string {
  const config = traveldeskConfigFrom(env());
  const account = bookingAccountId(environment, config?.environment === environment ? config.agencyId : null);
  if (!account) throw Errors.conflict("No TravelDesk account is pinned for this environment on this deployment (TRAVELDESK_AGENCY_ID)");
  return account;
}

async function changeControl(actor: Actor, change: ControlChange, note: string, environment: "test" | "production", totpCode: string | undefined) {
  const accountId = controlAccount(environment);
  const opts = { environment, accountId };
  // The approval is bound to the controls as they are now (CR-B1-1): if they change before it is used, it is withdrawn.
  const { needs, before } = await supplierBookingService.controlRequest(change, opts);
  let approvalId: string | undefined;
  if (needs) {
    if (!totpCode) throw Errors.validation({ totpCode: "This change needs a code from your authenticator app" });
    const r = await approvalService.requestPrivileged(actor, needs, OPERATION_PERMISSION[needs], controlApprovalPayload(TRAVELDESK_SUPPLIER_CODE, environment, accountId, change, before), {
      environment,
      totpCode,
    });
    if (r.status === "refused") {
      if (r.reason === "step_up_required") throw Errors.validation({ totpCode: "The code was not accepted; wait for a new one" });
      throw Errors.forbidden(OPERATION_PERMISSION[needs]);
    }
    if (r.status === "pending") {
      const current = await bookingControl(TRAVELDESK_SUPPLIER_CODE, environment, accountId);
      return { paused: current.paused, status: "pending" as const, approvalId: r.approvalId };
    }
    approvalId = r.approvalId;
  }
  const next = await supplierBookingService.setControl(actor, change, note, { ...opts, approvalId });
  revalidatePath("/admin/suppliers/traveldesk");
  return { paused: next.paused, status: "applied" as const, approvalId: approvalId ?? null };
}

/**
 * Kill switch for TravelDesk bookings (docs/backend/21 §11). The form posts the
 * target state, not the state it loaded, so a stale page cannot flip it back.
 * A pause holds new sales unless the form posts `scope=all_writes`.
 */
export async function setBookingPauseAction(_prev: BookingControlResult | null, fd: FormData): Promise<BookingControlResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("suppliers.pause");
    const input = parseWith(pauseSchema, {
      target: form.str(fd, "target"),
      scope: form.str(fd, "scope"),
      environment: form.str(fd, "environment"),
      reason: form.str(fd, "reason"),
      note: form.str(fd, "note") ?? "",
      totpCode: form.str(fd, "totpCode"),
    });
    return changeControl(actor, { paused: input.target === "pause", scope: input.scope, reason: input.reason }, input.note, input.environment, input.totpCode);
  });
}

/** Per-booking cap and balance floor, in whole AED. Never touches the kill switch. Raising needs approval. */
export async function setBookingLimitsAction(_prev: BookingControlResult | null, fd: FormData): Promise<BookingControlResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("suppliers.pause");
    const input = parseWith(limitsSchema, {
      environment: form.str(fd, "environment"),
      maxBookingAed: form.str(fd, "maxBookingAed"),
      minFundsAfterAed: form.str(fd, "minFundsAfterAed"),
      note: form.str(fd, "note") ?? "",
      totpCode: form.str(fd, "totpCode"),
    });
    return changeControl(actor, { maxBookingNetMinor: input.maxBookingAed * 100, minFundsAfterMinor: input.minFundsAfterAed * 100 }, input.note, input.environment, input.totpCode);
  });
}

/**
 * Second approval of a pending control change (production); applies it when
 * approved. Only a supplier control approval (resume or limits raise) is
 * accepted here, from someone who may also apply it (`suppliers.pause`), and
 * only while the controls are still the ones it was asked against (CR-B1-11,
 * CR-B1-1). A stale request is withdrawn and has to be asked for again.
 */
export async function approveBookingControlAction(_prev: BookingControlResult | null, fd: FormData): Promise<BookingControlResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("suppliers.pause");
    const input = parseWith(approveSchema, { approvalId: form.str(fd, "approvalId"), note: form.str(fd, "note") ?? "", totpCode: form.str(fd, "totpCode") });
    await supplierBookingService.checkControlApproval(actor, input.approvalId);
    const r = await approvalService.approvePrivileged(actor, input.approvalId, input.totpCode);
    if (r.status === "refused") {
      if (r.reason === "step_up_required") throw Errors.validation({ totpCode: "The code was not accepted; wait for a new one" });
      if (r.reason === "same_person") throw Errors.conflict("A second person must approve this change");
      if (r.reason === "expired") throw Errors.conflict("This request has expired; ask again");
      throw Errors.forbidden();
    }
    if (r.status === "pending") return { paused: true, status: "pending" as const, approvalId: r.approvalId };
    const next = await supplierBookingService.applyApprovedControl(actor, input.approvalId, input.note);
    revalidatePath("/admin/suppliers/traveldesk");
    return { paused: next.paused, status: "applied" as const, approvalId: input.approvalId };
  });
}

/**
 * Whether a mapped offer issues tickets at confirmation (Q-T1). Administrators
 * only, with a fresh authenticator code; see `supplierCatalogService.setTicketEvidence`.
 */
const ticketEvidenceSchema = z
  .object({
    mappingId: z.uuid(),
    issuesTicketsAtConfirm: z.enum(["yes", "no", "unknown"]),
    source: z.string().trim().max(200).default(""),
    note: z.string().trim().min(8, "Give a reason of at least 8 characters").max(500),
    totpCode: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app"),
  })
  .strict();

export type TicketEvidenceResult = ActionResult<{ issuesTicketsAtConfirm: "yes" | "no" | "unknown" }>;

export async function setTicketEvidenceAction(_prev: TicketEvidenceResult | null, fd: FormData): Promise<TicketEvidenceResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("products.activate_instant");
    const input = parseWith(ticketEvidenceSchema, {
      mappingId: form.str(fd, "mappingId"),
      issuesTicketsAtConfirm: form.str(fd, "issuesTicketsAtConfirm"),
      source: form.str(fd, "source"),
      note: form.str(fd, "note") ?? "",
      totpCode: form.str(fd, "totpCode"),
    });
    const record = await supplierCatalogService.setTicketEvidence(actor, input.mappingId, input);
    revalidatePath("/admin/suppliers/traveldesk");
    return { issuesTicketsAtConfirm: record?.issuesTicketsAtConfirm ?? "unknown" };
  });
}

const catalogueSyncSchema = z.object({ totpCode: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app") }).strict();

export type CatalogueSyncActionResult = ActionResult<CatalogueSyncResult>;

/**
 * Pull this deployment's TravelDesk catalogue (read only) into its database,
 * then refresh mapping suggestions (traveldesk-catalogue-sync.service.ts).
 * `suppliers.manage` plus a fresh authenticator code.
 */
export async function syncTravelDeskCatalogueAction(_prev: CatalogueSyncActionResult | null, fd: FormData): Promise<CatalogueSyncActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("suppliers.manage");
    const input = parseWith(catalogueSyncSchema, { totpCode: form.str(fd, "totpCode") ?? "" });
    const result = await runTravelDeskCatalogueSync(actor, input.totpCode);
    revalidatePath("/admin/suppliers/traveldesk");
    return result;
  });
}
