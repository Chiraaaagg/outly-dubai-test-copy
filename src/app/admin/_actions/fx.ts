"use server";

import { revalidatePath } from "next/cache";
import { authService } from "@/server/services/auth.service";
import { fxRefreshService, type FxRefreshOutcome } from "@/server/services/fx-refresh.service";
import { form, runAction, type ActionResult } from "./result";

/**
 * Admin "Refresh now" for the live INR-per-AED rate (`pricing.edit`). It runs
 * the same fetch and guards as the cron job; it can never set a rate by hand.
 * With `acceptJumpTo` (the exact rate the admin was shown) and a fresh
 * authenticator code it also accepts a move larger than 5%; the band and
 * source-age guards still apply. The service checks the permission and the
 * code again and audits both outcomes.
 */

export type FxRefreshActionResult = ActionResult<FxRefreshOutcome>;

export async function refreshFxAction(_prev: FxRefreshActionResult | null, fd: FormData): Promise<FxRefreshActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("pricing.edit");
    const outcome = await fxRefreshService.refreshManually(actor, {
      acceptJumpTo: form.str(fd, "acceptJumpTo"),
      totpCode: form.str(fd, "totpCode"),
    });
    revalidatePath("/admin/settings");
    return outcome;
  });
}
