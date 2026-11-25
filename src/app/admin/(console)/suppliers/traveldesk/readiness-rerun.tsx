"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { rerunReadinessAction, type ReadinessRerunActionResult } from "../../../_actions/supplier-mappings";
import { INPUT_CLASS } from "../../../_components/ui";

/**
 * Re-run readiness (doc 29 §9.4): re-checks every product that is or asks to
 * be instant from what this database already holds. No TravelDesk call. The
 * step after a deploy that changes the readiness rules, when the catalogue
 * itself does not need syncing. Needs a fresh authenticator code.
 */
async function rerunOrReport(prev: ReadinessRerunActionResult | null, fd: FormData): Promise<ReadinessRerunActionResult> {
  try {
    return await rerunReadinessAction(prev, fd);
  } catch {
    return { ok: false, code: "request_failed", message: "The re-run did not report back. Reload the page; running it again is safe." };
  }
}

export function ReadinessRerun() {
  const [result, submit, pending] = useActionState<ReadinessRerunActionResult | null, FormData>(rerunOrReport, null);
  const data = result?.ok ? result.data : null;
  return (
    <div className="mt-5 border-t border-ink-200 pt-4">
      <h3 className="text-sm font-bold text-ink-900">Re-run readiness</h3>
      <p className="mb-3 mt-1 text-sm text-ink-700">
        Checks again whether each product that is or asks to be instant can be sold instantly, from the catalogue and mappings already in this database. It does not call
        TravelDesk. Use it after a deploy that changes the readiness rules.
      </p>
      <form action={submit} className="flex flex-wrap items-end gap-3">
        <label htmlFor="readiness-rerun-code" className="block text-xs font-semibold text-ink-800">
          Authenticator code
          <input
            id="readiness-rerun-code"
            name="totpCode"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            placeholder="123456"
            aria-describedby="readiness-rerun-status"
            className={`${INPUT_CLASS} mt-1 min-h-10 w-32 font-mono text-sm font-normal tracking-widest`}
          />
        </label>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Re-running…" : "Re-run readiness"}
        </Button>
      </form>
      <div id="readiness-rerun-status" aria-live="polite" aria-busy={pending} className="mt-3">
        {pending && <p className="text-xs text-ink-600">Re-running readiness.</p>}
        {result && !result.ok && <p className="text-xs font-semibold text-[var(--color-danger)]">{result.fields?.totpCode ?? result.message}</p>}
        {data && (
          <p className="text-xs font-semibold text-[var(--color-success)]">
            Re-checked {data.candidates} product{data.candidates === 1 ? "" : "s"} under rules version {data.rulesVersion}: {data.instant} instant, {data.inquiry} inquiry.
          </p>
        )}
      </div>
    </div>
  );
}
