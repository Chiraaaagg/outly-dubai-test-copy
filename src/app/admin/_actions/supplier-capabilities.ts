"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { parseWith } from "@/server/lib/http";
import { approvalService, OPERATION_PERMISSION } from "@/server/services/approval.service";
import { authService } from "@/server/services/auth.service";
import { CAPABILITY_OPERATION, EVIDENCE_KINDS, flagApprovalPayload, PROOF_EVIDENCE_KINDS, supplierCapabilityService } from "@/server/services/supplier-capability.service";
import { CAPABILITY_ADAPTER } from "@/server/suppliers/capability-gate";
import { form, runAction, type ActionResult } from "./result";

/**
 * Capability-class flags and per-offer evidence (doc 29 §3.3, Batch 1a).
 * `suppliers.manage` is checked here and again inside the service.
 *
 *  - Off is tightening: a reason only.
 *  - On, and recording evidence, go through approval.service: a fresh code
 *    (`totpCode`), and in production a second staff member holding
 *    `products.activate_instant` making the same change with their own code
 *    within 30 minutes. Until then the result is `pending`. Doc 30 N2: in
 *    production an administrator with full rights is applied at once, with
 *    an owner alert, once the owner alert recipient is configured.
 *  - Class proofs (doc 30 §3.12): recorded under the same approval;
 *    narrowing (a scope an active proof already covers) and revoking need
 *    no code.
 */

const PATH = "/admin/suppliers/traveldesk/capabilities";
const environmentField = z.enum(["test", "production"]);
const totpField = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app").optional();
const noteField = z.string().trim().min(8, "Give a reason of at least 8 characters").max(500);
const classKeyField = z.string().trim().regex(/^[a-z_]+(\.[a-z_]+){4}$/, "Not a capability class key");

const flagSchema = z
  .object({ environment: environmentField, classKey: classKeyField, target: z.enum(["on", "off"]), note: noteField, totpCode: totpField })
  .strict();

const evidenceSchema = z
  .object({
    environment: environmentField,
    classKey: classKeyField,
    offerExternalId: z.string().trim().regex(/^[1-9][0-9]{0,9}$/, "Enter the TravelDesk offer id"),
    evidenceKind: z.enum(EVIDENCE_KINDS),
    reference: z.string().trim().min(3, "Give a reference of 3 to 200 characters").max(200),
    note: noteField,
    totpCode: totpField,
  })
  .strict();

const revokeSchema = z.object({ evidenceId: z.uuid(), note: noteField }).strict();

const proofSchema = z
  .object({
    environment: environmentField,
    classKey: classKeyField,
    basisClassKey: classKeyField,
    scopeKind: z.enum(["all", "provider", "tours"]),
    scopeProvider: z.string().trim().min(1).max(120).optional(),
    scopeTourIds: z.array(z.string().trim().regex(/^[1-9][0-9]{0,9}$/, "Tour ids are TravelDesk numbers")).max(200).optional(),
    evidenceKind: z.enum(PROOF_EVIDENCE_KINDS),
    reference: z.string().trim().min(3, "Give a reference of 3 to 200 characters").max(200),
    widensProofId: z.uuid().optional(),
    note: noteField,
    totpCode: totpField,
  })
  .strict();

const revokeProofSchema = z.object({ proofId: z.uuid(), note: noteField }).strict();

/** `pending`: waiting for a second approver (production); nothing has changed yet. */
export type CapabilityActionResult = ActionResult<{ status: "applied" | "pending" | "unchanged"; approvalId: string | null }>;

function refusedApproval(reason: string): never {
  if (reason === "step_up_required") throw Errors.validation({ totpCode: "The code was not accepted; wait for a new one" });
  throw Errors.forbidden(OPERATION_PERMISSION[CAPABILITY_OPERATION]);
}

export async function setCapabilityFlagAction(_prev: CapabilityActionResult | null, fd: FormData): Promise<CapabilityActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("suppliers.manage");
    const input = parseWith(flagSchema, {
      environment: form.str(fd, "environment"),
      classKey: form.str(fd, "classKey"),
      target: form.str(fd, "target"),
      note: form.str(fd, "note") ?? "",
      totpCode: form.str(fd, "totpCode"),
    });
    const enabled = input.target === "on";
    // The approval is bound to the flag as it is now: if it changes before use, the approval no longer matches.
    const { needs, before } = await supplierCapabilityService.flagRequest(input.environment, input.classKey, enabled);
    let approvalId: string | undefined;
    if (needs) {
      if (!input.totpCode) throw Errors.validation({ totpCode: "Switching a class on needs a code from your authenticator app" });
      const r = await approvalService.requestPrivileged(actor, needs, OPERATION_PERMISSION[needs], flagApprovalPayload(CAPABILITY_ADAPTER, input.environment, input.classKey, true, before), {
        environment: input.environment,
        totpCode: input.totpCode,
      });
      if (r.status === "refused") refusedApproval(r.reason);
      if (r.status === "pending") return { status: "pending" as const, approvalId: r.approvalId };
      approvalId = r.approvalId;
    }
    const done = await supplierCapabilityService.setFlag(actor, { environment: input.environment, classKey: input.classKey, enabled, reason: input.note }, { approvalId });
    revalidatePath(PATH);
    return { status: done.changed ? ("applied" as const) : ("unchanged" as const), approvalId: approvalId ?? null };
  });
}

export async function recordOfferEvidenceAction(_prev: CapabilityActionResult | null, fd: FormData): Promise<CapabilityActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("suppliers.manage");
    const input = parseWith(evidenceSchema, {
      environment: form.str(fd, "environment"),
      classKey: form.str(fd, "classKey"),
      offerExternalId: form.str(fd, "offerExternalId"),
      evidenceKind: form.str(fd, "evidenceKind"),
      reference: form.str(fd, "reference") ?? "",
      note: form.str(fd, "note") ?? "",
      totpCode: form.str(fd, "totpCode"),
    });
    if (!input.totpCode) throw Errors.validation({ totpCode: "Recording evidence needs a code from your authenticator app" });
    const req = await supplierCapabilityService.evidenceRequest(input);
    const r = await approvalService.requestPrivileged(actor, CAPABILITY_OPERATION, OPERATION_PERMISSION[CAPABILITY_OPERATION], req.payload, {
      environment: input.environment,
      totpCode: input.totpCode,
    });
    if (r.status === "refused") refusedApproval(r.reason);
    if (r.status === "pending") return { status: "pending" as const, approvalId: r.approvalId };
    await supplierCapabilityService.recordEvidence(actor, input, { approvalId: r.approvalId });
    revalidatePath(PATH);
    return { status: "applied" as const, approvalId: r.approvalId };
  });
}

export async function revokeOfferEvidenceAction(_prev: CapabilityActionResult | null, fd: FormData): Promise<CapabilityActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("suppliers.manage");
    const input = parseWith(revokeSchema, { evidenceId: form.str(fd, "evidenceId"), note: form.str(fd, "note") ?? "" });
    const done = await supplierCapabilityService.revokeEvidence(actor, input.evidenceId, input.note);
    revalidatePath(PATH);
    return { status: done.revoked ? ("applied" as const) : ("unchanged" as const), approvalId: null };
  });
}

/** Record a class proof with its scope (doc 30 §3.12). Loosening unless an active proof already covers the scope. */
export async function recordClassProofAction(_prev: CapabilityActionResult | null, fd: FormData): Promise<CapabilityActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("suppliers.manage");
    const tours = form.str(fd, "scopeTourIds");
    const input = parseWith(proofSchema, {
      environment: form.str(fd, "environment"),
      classKey: form.str(fd, "classKey"),
      basisClassKey: form.str(fd, "basisClassKey") ?? form.str(fd, "classKey"),
      scopeKind: form.str(fd, "scopeKind"),
      scopeProvider: form.str(fd, "scopeProvider"),
      scopeTourIds: tours ? tours.split(/[\s,]+/).filter(Boolean) : undefined,
      evidenceKind: form.str(fd, "evidenceKind"),
      reference: form.str(fd, "reference") ?? "",
      widensProofId: form.str(fd, "widensProofId"),
      note: form.str(fd, "note") ?? "",
      totpCode: form.str(fd, "totpCode"),
    });
    const req = await supplierCapabilityService.classProofRequest(input);
    let approvalId: string | undefined;
    if (req.needs) {
      if (!input.totpCode) throw Errors.validation({ totpCode: "Recording a proof needs a code from your authenticator app" });
      const r = await approvalService.requestPrivileged(actor, req.needs, OPERATION_PERMISSION[req.needs], req.payload, { environment: input.environment, totpCode: input.totpCode });
      if (r.status === "refused") refusedApproval(r.reason);
      if (r.status === "pending") return { status: "pending" as const, approvalId: r.approvalId };
      approvalId = r.approvalId;
    }
    await supplierCapabilityService.recordClassProof(actor, input, { approvalId });
    revalidatePath(PATH);
    return { status: "applied" as const, approvalId: approvalId ?? null };
  });
}

/** Withdraw a class proof (tightening: a reason only). */
export async function revokeClassProofAction(_prev: CapabilityActionResult | null, fd: FormData): Promise<CapabilityActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("suppliers.manage");
    const input = parseWith(revokeProofSchema, { proofId: form.str(fd, "proofId"), note: form.str(fd, "note") ?? "" });
    const done = await supplierCapabilityService.revokeClassProof(actor, input.proofId, input.note);
    revalidatePath(PATH);
    return { status: done.revoked ? ("applied" as const) : ("unchanged" as const), approvalId: null };
  });
}
