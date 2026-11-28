"use server";

import { revalidatePath } from "next/cache";
import { authService } from "@/server/services/auth.service";
import { fiscalStaffService } from "@/server/services/fiscal-staff.service";
import { form, runAction, type ActionResult } from "./result";

/**
 * Admin actions on the fiscal documents (Group C, owner decisions C-P1 and
 * C-P2): record the CBUAE rate of a date for INR-paid invoices, and reissue a
 * simplified invoice as a full tax invoice. Both need `payments.reconcile`
 * and a fresh authenticator code; the service checks both again and audits
 * every outcome.
 */

export type CbuaeRateActionResult = ActionResult<{ date: string; aedPerInr: string; replaced: string | null }>;
export type ReissueActionResult = ActionResult<{ cancelled: string; creditNote: string; invoice: string }>;

export async function recordCbuaeRateAction(_prev: CbuaeRateActionResult | null, fd: FormData): Promise<CbuaeRateActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("payments.reconcile");
    const out = await fiscalStaffService.recordCbuaeRate(actor, { date: form.str(fd, "date"), aedPerInr: form.str(fd, "aedPerInr"), totpCode: form.str(fd, "totpCode") });
    revalidatePath("/admin/fiscal");
    return out;
  });
}

export async function reissueFullTaxInvoiceAction(_prev: ReissueActionResult | null, fd: FormData): Promise<ReissueActionResult> {
  return runAction(async () => {
    const { actor } = await authService.requireCookies("payments.reconcile");
    const out = await fiscalStaffService.reissueFullTaxInvoice(actor, {
      displayNumber: form.str(fd, "displayNumber"),
      legalName: form.str(fd, "legalName"),
      trn: form.str(fd, "trn"),
      address: form.str(fd, "address"),
      totpCode: form.str(fd, "totpCode"),
    });
    revalidatePath("/admin/fiscal");
    return { cancelled: out.cancelled.displayNumber, creditNote: out.creditNote.displayNumber, invoice: out.invoice.displayNumber };
  });
}
