"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseWith } from "@/server/lib/http";
import { authService } from "@/server/services/auth.service";
import { traveldeskImportService } from "@/server/services/traveldesk-import.service";
import { traveldeskListingService, type PublishItemResult } from "@/server/services/traveldesk-listing.service";
import { retireSummary } from "@/server/suppliers/traveldesk/clean-address";
import { form, runAction, type ActionResult } from "./result";

/**
 * TravelDesk importer actions (doc 30 §2 steps 2–4, build N1). Permissions
 * are checked here and again inside the services. Every write states a
 * reason that goes to the audit log. Nothing here calls TravelDesk; only
 * apply copies photos, through the configured photo client.
 */

const PATH = "/admin/suppliers/traveldesk/import";
const reason = z.string().trim().min(8, "Give a reason of at least 8 characters").max(500);

export type ImportPreviewResult = ActionResult<{ batchId: string; counts: Record<string, number> }>;

export async function previewTravelDeskImportAction(_prev: ImportPreviewResult | null, fd: FormData): Promise<ImportPreviewResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("imports.run");
    const input = parseWith(z.object({ environment: z.enum(["test", "production"]), step: z.enum(["S0", "S1", "S2", "S3", "S4", "S5"]) }).strict(), { environment: form.str(fd, "environment"), step: form.str(fd, "step") });
    const p = await traveldeskImportService.preview(actor, input.environment, input.step);
    revalidatePath(PATH);
    return { batchId: p.batchId, counts: p.counts };
  });
}

export type BatchActionResult = ActionResult<{ batchId: string; summary: string }>;

export async function applyTravelDeskImportAction(_prev: BatchActionResult | null, fd: FormData): Promise<BatchActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("imports.run");
    const input = parseWith(z.object({ batchId: z.uuid(), reason }).strict(), { batchId: form.str(fd, "batchId"), reason: form.str(fd, "reason") ?? "" });
    const r = await traveldeskImportService.apply(actor, input.batchId, { reason: input.reason });
    revalidatePath(PATH);
    return { batchId: input.batchId, summary: `${r.created.length} drafts created, ${r.adopted.length} adopted` };
  });
}

/** Photos are copied a few tours per click (review 106 N1-12e): the result says how many tours remain. */
export async function copyTravelDeskPhotosAction(_prev: BatchActionResult | null, fd: FormData): Promise<BatchActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("imports.run");
    const input = parseWith(z.object({ batchId: z.uuid() }).strict(), { batchId: form.str(fd, "batchId") });
    const r = await traveldeskImportService.copyPhotos(actor, { batchId: input.batchId, maxTours: 5 });
    revalidatePath(PATH);
    const failed = Object.keys(r.failures).length;
    return { batchId: input.batchId, summary: `${r.listingsUpdated} listings got photos from ${r.toursTried} tours; ${r.remainingTours} tours left${failed ? `; ${failed} tours had photo failures` : ""}` };
  });
}

export async function rollbackTravelDeskImportAction(_prev: BatchActionResult | null, fd: FormData): Promise<BatchActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("imports.run");
    const input = parseWith(z.object({ batchId: z.uuid(), reason, force: z.boolean() }).strict(), { batchId: form.str(fd, "batchId"), reason: form.str(fd, "reason") ?? "", force: form.bool(fd, "force") });
    const r = await traveldeskImportService.rollback(actor, input.batchId, input.reason, { force: input.force });
    revalidatePath(PATH);
    return { batchId: input.batchId, summary: `${r.rolledBack} listings removed, ${r.restored} old pages restored` };
  });
}

export type ReviewListingResult = ActionResult<{ linkId: string }>;

export async function markListingReviewedAction(_prev: ReviewListingResult | null, fd: FormData): Promise<ReviewListingResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("products.edit");
    const input = parseWith(
      z.object({ linkId: z.uuid(), replacesProductId: z.uuid().nullable(), confirmTierAndCategory: z.boolean(), note: reason }).strict(),
      { linkId: form.str(fd, "linkId"), replacesProductId: form.str(fd, "replacesProductId") ?? null, confirmTierAndCategory: form.bool(fd, "confirmTierAndCategory"), note: form.str(fd, "note") ?? "" },
    );
    await traveldeskListingService.markReviewed(actor, input.linkId, input);
    revalidatePath(PATH);
    return { linkId: input.linkId };
  });
}

export type PublishListingsResult = ActionResult<{ results: PublishItemResult[] }>;

export async function publishListingsAction(_prev: PublishListingsResult | null, fd: FormData): Promise<PublishListingsResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("products.publish");
    const input = parseWith(z.object({ linkIds: z.array(z.uuid()).min(1, "Select at least one listing").max(50), reason }).strict(), { linkIds: form.all(fd, "linkIds"), reason: form.str(fd, "reason") ?? "" });
    const results = await traveldeskListingService.publish(actor, input.linkIds, input.reason);
    revalidatePath(PATH);
    return { results };
  });
}

export async function restoreReplacedAction(_prev: BatchActionResult | null, fd: FormData): Promise<BatchActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("products.publish");
    const input = parseWith(z.object({ linkId: z.uuid(), reason }).strict(), { linkId: form.str(fd, "linkId"), reason: form.str(fd, "reason") ?? "" });
    const r = await traveldeskListingService.restoreReplaced(actor, input.linkId, input.reason);
    revalidatePath(PATH);
    return { batchId: input.linkId, summary: r.redirectOnly ? `${r.oldSlug}: redirect removed; the page stays archived` : `${r.oldSlug} restored` };
  });
}

/** Retire the old page of an already published listing (doc 30 §3.9 follow-up): soft delete and redirect, or the redirect only. */
export async function retireOldPageAction(_prev: BatchActionResult | null, fd: FormData): Promise<BatchActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("products.publish");
    const input = parseWith(z.object({ linkId: z.uuid(), oldProductId: z.uuid("Choose the old page"), reason }).strict(), { linkId: form.str(fd, "linkId"), oldProductId: form.str(fd, "oldProductId") ?? "", reason: form.str(fd, "reason") ?? "" });
    const r = await traveldeskListingService.retireOld(actor, input.linkId, input.oldProductId, input.reason);
    revalidatePath(PATH);
    return { batchId: input.linkId, summary: retireSummary(r) };
  });
}

/** Move a published "<base>-<n>" listing to "<base>", and the undo (traveldesk-address.ts). */
export async function moveToCleanAddressAction(_prev: BatchActionResult | null, fd: FormData): Promise<BatchActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("products.publish");
    const input = parseWith(z.object({ linkId: z.uuid(), reason }).strict(), { linkId: form.str(fd, "linkId"), reason: form.str(fd, "reason") ?? "" });
    const r = await traveldeskListingService.moveToCleanAddress(actor, input.linkId, input.reason);
    revalidatePath(PATH);
    return { batchId: input.linkId, summary: `Moved to ${r.to}; ${r.from} redirects to it` };
  });
}

export async function undoCleanAddressAction(_prev: BatchActionResult | null, fd: FormData): Promise<BatchActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("products.publish");
    const input = parseWith(z.object({ linkId: z.uuid(), reason }).strict(), { linkId: form.str(fd, "linkId"), reason: form.str(fd, "reason") ?? "" });
    const r = await traveldeskListingService.undoCleanAddress(actor, input.linkId, input.reason);
    revalidatePath(PATH);
    return { batchId: input.linkId, summary: `Moved back to ${r.to}; ${r.from} redirects to it again` };
  });
}
