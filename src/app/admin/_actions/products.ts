"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authService } from "@/server/services/auth.service";
import { catalogService } from "@/server/services/catalog.service";
import { parseWith } from "@/server/lib/http";
import { fulfilmentModeSchema, productIdSchema } from "@/server/schemas/admin.schemas";
import { form, runAction, type ActionResult } from "./result";

/**
 * THE HINGE (§17 §6.4): per-SKU fulfilment mode flip, audited with a reason.
 * Back to inquiry needs `products.publish`; activating instant needs
 * `products.activate_instant` and a fresh authenticator code, and in
 * production a second administrator (PRD-12). Both are checked here and again
 * inside the service.
 */

const totpCodeField = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app")
  .optional();

export type SetFulfilmentModeResult = ActionResult<{
  id: string;
  mode: "inquiry" | "instant";
  /** `pending`: waiting for a second administrator; the mode has not changed yet. */
  status: "applied" | "pending";
}>;

export async function setFulfilmentModeAction(_prev: SetFulfilmentModeResult | null, fd: FormData): Promise<SetFulfilmentModeResult> {
  return runAction(async () => {
    const mode = form.str(fd, "mode");
    const { actor } = await authService.requireCookies(mode === "instant" ? "products.activate_instant" : "products.publish");
    const id = parseWith(productIdSchema, form.str(fd, "id"));
    const input = parseWith(fulfilmentModeSchema, {
      kind: form.str(fd, "kind"),
      mode,
      reason: form.str(fd, "reason") ?? "",
    });
    const totpCode = input.mode === "instant" ? parseWith(totpCodeField, form.str(fd, "totpCode")) : undefined;
    const result = await catalogService.setFulfilmentMode(actor, { kind: input.kind, id }, input.mode, input.reason, { totpCode });
    revalidatePath("/admin/products");
    return { id, mode: result.fulfilmentMode, status: result.status };
  });
}
