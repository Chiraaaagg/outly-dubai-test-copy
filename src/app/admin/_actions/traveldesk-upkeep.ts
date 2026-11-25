"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { parseWith } from "@/server/lib/http";
import { authService } from "@/server/services/auth.service";
import { traveldeskUpkeepService } from "@/server/services/traveldesk-upkeep.service";
import { form, runAction, type ActionResult } from "./result";

/**
 * Supplier changes log actions (doc 30 §3.10, build N3): a person approves a
 * price move above 20% (D18) or closes a review item. Permissions are
 * checked here and again in the service; each write states a reason that
 * goes to the audit log. Nothing here calls TravelDesk.
 */

const PATH = "/admin/suppliers/traveldesk/changes";
const note = z.string().trim().min(8, "Give a reason of at least 8 characters").max(500);

export type UpkeepReviewResult = ActionResult<{ changeId: string; summary: string }>;

export async function approvePriceChangeAction(_prev: UpkeepReviewResult | null, fd: FormData): Promise<UpkeepReviewResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("pricing.edit");
    const input = parseWith(z.object({ changeId: z.uuid(), note }).strict(), { changeId: form.str(fd, "changeId"), note: form.str(fd, "note") ?? "" });
    const r = await traveldeskUpkeepService.approvePriceChange(actor, input.changeId, input.note);
    revalidatePath(PATH);
    return { changeId: input.changeId, summary: `Price applied${r.reapproved ? `, ${r.reapproved} supplier link(s) re-approved` : ""}` };
  });
}

export async function dismissReviewAction(_prev: UpkeepReviewResult | null, fd: FormData): Promise<UpkeepReviewResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("products.edit");
    const input = parseWith(z.object({ changeId: z.uuid(), note }).strict(), { changeId: form.str(fd, "changeId"), note: form.str(fd, "note") ?? "" });
    await traveldeskUpkeepService.dismissReview(actor, input.changeId, input.note);
    revalidatePath(PATH);
    return { changeId: input.changeId, summary: "Closed" };
  });
}
