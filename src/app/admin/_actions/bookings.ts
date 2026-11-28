"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { parseWith } from "@/server/lib/http";
import { authService } from "@/server/services/auth.service";
import { approvalEnvironment, opsQueueService, REFETCH_REASONS, type ResolutionResult } from "@/server/services/ops-queue.service";
import { form, runAction, type ActionResult } from "./result";

/**
 * Operations console actions for instant bookings (doc 22 §23 B5, R-B4-5).
 * Each one resolves the session with the permission the page already
 * checked, calls one ops-queue.service method (which checks the permission
 * again and audits by ids and codes only), and returns the shared
 * `ActionResult`. None of them moves money or sends a supplier mutation.
 *
 *  - `deliberateReadAction` and `requestRefetchAction` need `tickets.resend`.
 *  - `requestResolutionAction` and `approveResolutionAction` need
 *    `bookings.privileged_resolution`, a fresh authenticator code and, in
 *    production, a second approver (approval.service).
 */

const totp = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app");

function refreshPaths(reference: string | undefined) {
  revalidatePath("/admin/bookings");
  if (reference) revalidatePath(`/admin/bookings/${encodeURIComponent(reference)}`);
}

/** Optional, only used to refresh the detail page. */
const referenceField = z.string().trim().max(40).optional();

export type DeliberateReadResult = ActionResult<{ outcome: string }>;

export async function deliberateReadAction(_prev: DeliberateReadResult | null, fd: FormData): Promise<DeliberateReadResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("tickets.resend");
    const input = parseWith(z.object({ supplierBookingId: z.uuid(), reference: referenceField }).strict(), {
      supplierBookingId: form.str(fd, "supplierBookingId"),
      reference: form.str(fd, "reference"),
    });
    const r = await opsQueueService.deliberateRead(actor, input.supplierBookingId);
    refreshPaths(input.reference);
    return r;
  });
}

export type RefetchResult = ActionResult<{ documentId: string }>;

export async function requestRefetchAction(_prev: RefetchResult | null, fd: FormData): Promise<RefetchResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("tickets.resend");
    const input = parseWith(z.object({ documentId: z.uuid(), reason: z.enum(REFETCH_REASONS), reference: referenceField }).strict(), {
      documentId: form.str(fd, "documentId"),
      reason: form.str(fd, "reason"),
      reference: form.str(fd, "reference"),
    });
    await opsQueueService.requestRefetch(actor, input.documentId, input.reason);
    refreshPaths(input.reference);
    return { documentId: input.documentId };
  });
}

export type ResolutionActionResult = ActionResult<ResolutionResult>;

/** Refusals a form can act on are field errors; the rest are the result's `refused` reason. */
function stepUpField(r: ResolutionResult): ResolutionResult {
  if (r.status === "refused" && r.reason === "step_up_required") throw Errors.validation({ totpCode: "The code was not accepted; wait for a new one" });
  return r;
}

export async function requestResolutionAction(_prev: ResolutionActionResult | null, fd: FormData): Promise<ResolutionActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("bookings.privileged_resolution");
    const totpCode = parseWith(z.object({ totpCode: totp }), { totpCode: form.str(fd, "totpCode") ?? "" }).totpCode;
    const action = form.str(fd, "action");
    const raw =
      action === "close_exception" || action === "close_refund_failed"
        ? { action, targetId: form.str(fd, "targetId"), outcome: form.str(fd, "outcome"), evidence: form.str(fd, "evidence") ?? "" }
        : { action, target: form.str(fd, "target"), targetId: form.str(fd, "targetId"), reasonCode: form.str(fd, "reasonCode"), evidence: form.str(fd, "evidence") ?? "" };
    const r = stepUpField(await opsQueueService.requestResolution(actor, raw, { environment: approvalEnvironment(), totpCode }));
    refreshPaths(form.str(fd, "reference"));
    return r;
  });
}

export async function approveResolutionAction(_prev: ResolutionActionResult | null, fd: FormData): Promise<ResolutionActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("bookings.privileged_resolution");
    const input = parseWith(z.object({ approvalId: z.uuid(), totpCode: totp, reference: referenceField }).strict(), {
      approvalId: form.str(fd, "approvalId"),
      totpCode: form.str(fd, "totpCode") ?? "",
      reference: form.str(fd, "reference"),
    });
    const r = stepUpField(await opsQueueService.approveResolution(actor, input.approvalId, input.totpCode));
    refreshPaths(input.reference);
    return r;
  });
}
