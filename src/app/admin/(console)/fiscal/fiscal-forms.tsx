"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { recordCbuaeRateAction, reissueFullTaxInvoiceAction, type CbuaeRateActionResult, type ReissueActionResult } from "../../_actions/fiscal";
import { FormField, INPUT_CLASS, KeyValueList, Panel } from "../../_components/ui";

export interface RateRow {
  date: string;
  aedPerInr: string;
}

/** Plain admin forms built from the console's own primitives (no new component). Labels, hints and errors are wired by FormField. */
export function FiscalForms({ rates }: { rates: RateRow[] }) {
  const [rateState, rateAction, ratePending] = useActionState<CbuaeRateActionResult | null, FormData>(recordCbuaeRateAction, null);
  const [reissueState, reissueAction, reissuePending] = useActionState<ReissueActionResult | null, FormData>(reissueFullTaxInvoiceAction, null);
  const rateFields = rateState && !rateState.ok ? rateState.fields ?? {} : {};
  const reissueFields = reissueState && !reissueState.ok ? reissueState.fields ?? {} : {};

  return (
    <div className="space-y-4">
      <Panel
        title="CBUAE rate for INR-paid invoices"
        sub="An INR-paid capture is invoiced in AED at the UAE Central Bank rate of its capture date. Enter the rate the Central Bank published for that date; the invoice waits until it exists. A rate a document already used cannot be changed."
      >
        {rates.length ? (
          <KeyValueList items={rates.map((r) => ({ label: r.date, value: `${r.aedPerInr} AED per INR` }))} />
        ) : (
          <p className="text-sm text-ink-600">No rate entered yet.</p>
        )}
        <form action={rateAction} className="mt-4 grid gap-3 sm:grid-cols-3">
          {rateState && !rateState.ok && (
            <Alert tone="danger" title={rateState.message} className="sm:col-span-3">
              {rateState.recovery}
            </Alert>
          )}
          {rateState?.ok && (
            <Alert tone="success" title={`Saved ${rateState.data.aedPerInr} for ${rateState.data.date}`} className="sm:col-span-3">
              {rateState.data.replaced ? `Was ${rateState.data.replaced}.` : "Held INR invoices of that date are issued at the next run."}
            </Alert>
          )}
          <FormField label="Date (Dubai)" htmlFor="rate-date" hint="YYYY-MM-DD" error={rateFields.date} required>
            <input id="rate-date" name="date" type="date" required aria-invalid={!!rateFields.date} aria-describedby={rateFields.date ? "rate-date-error" : "rate-date-hint"} className={INPUT_CLASS} />
          </FormField>
          <FormField label="AED per 1 INR" htmlFor="rate-value" hint="For example 0.04350" error={rateFields.aedPerInr} required>
            <input id="rate-value" name="aedPerInr" inputMode="decimal" required aria-invalid={!!rateFields.aedPerInr} aria-describedby={rateFields.aedPerInr ? "rate-value-error" : "rate-value-hint"} className={INPUT_CLASS} />
          </FormField>
          <FormField label="Authenticator code" htmlFor="rate-totp" hint="6 digits" error={rateFields.totpCode} required>
            <input id="rate-totp" name="totpCode" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required aria-invalid={!!rateFields.totpCode} aria-describedby={rateFields.totpCode ? "rate-totp-error" : "rate-totp-hint"} className={INPUT_CLASS} />
          </FormField>
          <div className="flex justify-end sm:col-span-3">
            <Button type="submit" variant="secondary" loading={ratePending} loadingLabel="Saving…">
              Save rate
            </Button>
          </div>
        </form>
      </Panel>

      <Panel
        title="Full tax invoice for a VAT-registered buyer"
        sub="Cancels the simplified invoice with a credit note and issues a full tax invoice under the next number, with the buyer's legal name, address and TRN. Invoices with a refund are reissued by hand with the accountant."
      >
        <form action={reissueAction} className="grid gap-3 sm:grid-cols-2">
          {reissueState && !reissueState.ok && (
            <Alert tone="danger" title={reissueState.message} className="sm:col-span-2">
              {reissueState.recovery}
            </Alert>
          )}
          {reissueState?.ok && (
            <Alert tone="success" title={`Issued ${reissueState.data.invoice}`} className="sm:col-span-2">
              {`${reissueState.data.cancelled} is cancelled by credit note ${reissueState.data.creditNote}. Both files are drawn at the next run.`}
            </Alert>
          )}
          <FormField label="Simplified invoice number" htmlFor="ri-number" hint="For example INV-000123" error={reissueFields.displayNumber} required>
            <input id="ri-number" name="displayNumber" required autoComplete="off" aria-invalid={!!reissueFields.displayNumber} aria-describedby={reissueFields.displayNumber ? "ri-number-error" : "ri-number-hint"} className={INPUT_CLASS} />
          </FormField>
          <FormField label="Buyer TRN" htmlFor="ri-trn" hint="15 digits, from the buyer's VAT certificate" error={reissueFields.trn} required>
            <input id="ri-trn" name="trn" inputMode="numeric" required autoComplete="off" maxLength={20} aria-invalid={!!reissueFields.trn} aria-describedby={reissueFields.trn ? "ri-trn-error" : "ri-trn-hint"} className={INPUT_CLASS} />
          </FormField>
          <FormField label="Buyer legal name" htmlFor="ri-name" hint="As on the VAT certificate" error={reissueFields.legalName} required className="sm:col-span-2">
            <input id="ri-name" name="legalName" required autoComplete="off" maxLength={200} aria-invalid={!!reissueFields.legalName} aria-describedby={reissueFields.legalName ? "ri-name-error" : "ri-name-hint"} className={INPUT_CLASS} />
          </FormField>
          <FormField label="Buyer address" htmlFor="ri-address" hint="Registered address" error={reissueFields.address} required className="sm:col-span-2">
            <textarea id="ri-address" name="address" required rows={3} maxLength={500} aria-invalid={!!reissueFields.address} aria-describedby={reissueFields.address ? "ri-address-error" : "ri-address-hint"} className={`${INPUT_CLASS} py-2`} />
          </FormField>
          <FormField label="Authenticator code" htmlFor="ri-totp" hint="6 digits" error={reissueFields.totpCode} required>
            <input id="ri-totp" name="totpCode" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required aria-invalid={!!reissueFields.totpCode} aria-describedby={reissueFields.totpCode ? "ri-totp-error" : "ri-totp-hint"} className={INPUT_CLASS} />
          </FormField>
          <div className="flex items-end justify-end">
            <Button type="submit" loading={reissuePending} loadingLabel="Issuing…">
              Reissue as full tax invoice
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
