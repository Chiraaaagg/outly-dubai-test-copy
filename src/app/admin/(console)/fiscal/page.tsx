import { listCbuaeRates } from "@/server/services/fiscal-staff.service";
import { requirePage } from "../../_lib/guard";
import { PageHeader } from "../../_components/ui";
import { FiscalForms, type RateRow } from "./fiscal-forms";

/**
 * /admin/fiscal — staff actions on the fiscal documents (Group C, owner
 * decisions C-P1 and C-P2), for `payments.reconcile`: the CBUAE rates entered
 * for INR-paid invoices, a form to enter one, and the reissue of a simplified
 * invoice as a full tax invoice. Every action needs an authenticator code and
 * is audited.
 */
export const dynamic = "force-dynamic";

export default async function AdminFiscalPage() {
  const { actor } = await requirePage("payments.reconcile");
  const rates: RateRow[] = await listCbuaeRates(actor);
  return (
    <>
      <PageHeader title="Fiscal documents" sub="Exchange rates for INR-paid invoices and full tax invoices on request. Each action needs your authenticator code and is audited." />
      <FiscalForms rates={rates} />
    </>
  );
}
