"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { parseWith } from "@/server/lib/http";
import { idSchema } from "@/server/schemas/catalog.schemas";
import { approvalService, OPERATION_PERMISSION } from "@/server/services/approval.service";
import { authService } from "@/server/services/auth.service";
import { BULK_ACTIONS, BULK_RUN_MAX, bulkApprovalPayload, bulkListingService, type BulkAction, type BulkRunResult } from "@/server/services/bulk-listing.service";
import { approvalEnvironmentFor } from "@/server/services/catalog.service";
import { form, runAction, type ActionResult } from "./result";

/**
 * Bulk listing actions (doc 30 §3.12, build N2): arm / make instant, back to
 * inquiry, "free cancellation confirmed". Permissions are checked here and
 * again in the services.
 *
 *  - Back to inquiry: a reason only (tightening).
 *  - Arm and free cancellation: one fresh code for the whole run. In
 *    production an administrator with full rights is applied at once with an
 *    owner alert (D15, D16). Otherwise the run waits for a second
 *    administrator asking for the identical run (same action and items): that
 *    request only approves it (`approved`), and the administrator who asked
 *    starts and runs it with `startApprovedBulkAction` (review N2-10).
 *  - Every run reports applied, skipped and failed listings with reasons.
 */

export type BulkListingResult = ActionResult<{
  /** `pending`: waiting for a second administrator; `approved`: this request approved someone else's run, which they start. */
  status: "applied" | "pending" | "approved";
  approvalId: string | null;
  bulkId: string | null;
  result: BulkRunResult | null;
  action: BulkAction;
  /** The frozen item list the approval covers (for the requester's start). */
  ids: string[];
}>;

const PATH = "/admin/activities";
const totpField = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app").optional();
const reasonField = z.string().trim().min(8, "Give a reason of at least 8 characters").max(500);
const sourceField = z.string().trim().min(8, "Name TravelDesk's written answer (8 to 200 characters)").max(200).optional();
const filtersSchema = z
  .object({
    q: z.string().trim().max(80).optional(),
    status: z.enum(["draft", "published", "archived"]).optional(),
    tier: z.string().regex(/^[A-E]$/).optional(),
    category: z.string().max(80).optional(),
  })
  .strict();

const requestSchema = z
  .object({
    action: z.enum(BULK_ACTIONS),
    reason: reasonField,
    source: sourceField,
    totpCode: totpField,
  })
  .strict();

function json(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _: "invalid" };
  }
}

function environment() {
  return approvalEnvironmentFor({ APP_ENV: process.env.APP_ENV, VERCEL_ENV: process.env.VERCEL_ENV });
}

function refused(reason: string): never {
  if (reason === "step_up_required") throw Errors.validation({ totpCode: "The code was not accepted; wait for a new one" });
  if (reason === "item_cap") throw Errors.conflict("You have reached the limit of 100 listings made instant in one hour. Try again later.");
  throw Errors.forbidden(OPERATION_PERMISSION["instant.activate.bulk"]);
}

function selectionOf(fd: FormData) {
  if (form.str(fd, "scope") === "filter") return { filters: parseWith(filtersSchema, json(form.str(fd, "filters"))) };
  return { ids: parseWith(z.array(idSchema).min(1, "Select at least one listing").max(BULK_RUN_MAX, `One run takes at most ${BULK_RUN_MAX} listings`), form.all(fd, "ids")) };
}

/** Ask for a run and, when it applies at once, start and run it. */
export async function bulkListingAction(_prev: BulkListingResult | null, fd: FormData): Promise<BulkListingResult> {
  return runAction(async () => {
    const actionRaw = form.str(fd, "action");
    const { actor } = await authService.requireCookies(actionRaw === "inquiry" ? "products.publish" : "products.activate_instant");
    const input = parseWith(requestSchema, {
      action: actionRaw,
      reason: form.str(fd, "reason") ?? "",
      source: form.str(fd, "source"),
      totpCode: form.str(fd, "totpCode"),
    });
    if (input.action === "free_cancellation" && !input.source) throw Errors.validation({ source: "Name TravelDesk's written answer first" });
    const ids = await bulkListingService.resolveSelection(actor, selectionOf(fd));
    const env = environment();

    let approvalId: string | null = null;
    // Review N2-21: an approved, unused approval of this person for exactly this run is started, never asked for again.
    const ready = input.action !== "inquiry" ? await bulkListingService.readyApproval(actor, input.action, env, ids) : null;
    if (ready) approvalId = ready;
    if (input.action !== "inquiry" && !ready) {
      if (!input.totpCode) throw Errors.validation({ totpCode: "This run needs a code from your authenticator app" });
      const r = await approvalService.requestPrivileged(actor, "instant.activate.bulk", OPERATION_PERMISSION["instant.activate.bulk"], bulkApprovalPayload(input.action, env, ids), {
        environment: env,
        totpCode: input.totpCode,
        itemCount: ids.length,
      });
      if (r.status === "refused") refused(r.reason);
      if (r.status === "pending") return { status: "pending" as const, approvalId: r.approvalId, bulkId: null, result: null, action: input.action, ids };
      approvalId = r.approvalId;
      // A second administrator's identical request approves the first one's run; the first one starts it.
      if (!(await bulkListingService.isRequester(actor, approvalId))) return { status: "approved" as const, approvalId, bulkId: null, result: null, action: input.action, ids };
    }
    const started = await bulkListingService.start(actor, { action: input.action, productIds: ids, reason: input.reason, source: input.source }, { environment: env, approvalId });
    const result = await bulkListingService.run(actor, started.bulkId, { source: input.source });
    revalidatePath(PATH);
    return { status: "applied" as const, approvalId, bulkId: started.bulkId, result, action: input.action, ids };
  });
}

/** Start a run whose approval a second administrator has given (two-person rule): the requester, over exactly the approved items. */
export async function startApprovedBulkAction(_prev: BulkListingResult | null, fd: FormData): Promise<BulkListingResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("products.activate_instant");
    const approvalId = parseWith(z.uuid(), form.str(fd, "approvalId"));
    const reason = parseWith(reasonField, form.str(fd, "reason") ?? "");
    const source = parseWith(sourceField, form.str(fd, "source"));
    // The approved list comes from the approval itself (review N2-21), never from the page.
    const { action, items } = await bulkListingService.approvalItems(actor, approvalId);
    if (action === "inquiry") throw Errors.validation({ action: "Back to inquiry needs no approval" });
    if (action === "free_cancellation" && !source) throw Errors.validation({ source: "Name TravelDesk's written answer first" });
    const ids = await bulkListingService.resolveSelection(actor, { ids: items });
    const started = await bulkListingService.start(actor, { action, productIds: ids, reason, source }, { environment: environment(), approvalId });
    const result = await bulkListingService.run(actor, started.bulkId, { source });
    revalidatePath(PATH);
    return { status: "applied" as const, approvalId, bulkId: started.bulkId, result, action, ids };
  });
}

/** Run the pending items of a started run again (same person, inside its 30-minute window). Finished items are skipped. */
export async function resumeBulkAction(_prev: BulkListingResult | null, fd: FormData): Promise<BulkListingResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("products.edit");
    const bulkId = parseWith(z.uuid(), form.str(fd, "bulkId"));
    const result = await bulkListingService.run(actor, bulkId, { source: parseWith(sourceField, form.str(fd, "source")) });
    revalidatePath(PATH);
    return { status: "applied" as const, approvalId: null, bulkId, result, action: result.action, ids: [...result.applied, ...result.skipped, ...result.failed].map((i) => i.productId).concat(result.remaining) };
  });
}
