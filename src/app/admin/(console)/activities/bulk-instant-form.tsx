"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { bulkListingAction, type BulkListingResult } from "../../_actions/bulk-listings";
import { INPUT_CLASS } from "../../_components/ui";
import { CodeField } from "../suppliers/traveldesk/capabilities/capability-forms";
import type { TableFilters } from "./activities-table";

/**
 * Bulk instant actions on the selected listings (doc 30 §3.12, build N2):
 * arm / make instant, back to inquiry, "free cancellation confirmed".
 *
 * Minimal wiring with existing controls only (Button, Alert, the capability
 * forms' code field). The selection comes from the activities table.
 *
 * TODO(doc 30 decision 23): replace with the owner-picked components:
 *  1. the table with row selection and a bulk action bar (one bar for
 *     publish and these actions), and
 *  2. the confirm dialog with the code field and the result list (applied,
 *     skipped, failed with reasons; "run again" for an expired window).
 * No 21st.dev component is imported until the owner has chosen them.
 */

const ACTIONS = [
  { value: "arm", label: "Arm / make instant", needsCode: true },
  { value: "inquiry", label: "Back to inquiry", needsCode: false },
  { value: "free_cancellation", label: "Free cancellation confirmed", needsCode: true },
] as const;

const OUTCOME_LABEL: Record<string, string> = {
  armed_instant: "armed, now instant",
  armed_inquiry_until_ready: "armed, sells as inquiry until every check passes",
  already_instant: "already armed",
  already_inquiry: "already inquiry",
  inquiry: "back to inquiry",
  changed_concurrently: "changed by someone else meanwhile",
  confirmed: "free cancellation recorded",
  confirmed_rearmed_instant: "free cancellation recorded, armed again, instant",
  confirmed_rearmed_inquiry_until_ready: "free cancellation recorded, armed again, inquiry until ready",
  already_confirmed: "already confirmed",
  supplier_non_refundable: "supplier does not refund",
  supplier_policy_unknown: "supplier policy unknown",
  ticket_never_refundable: "tickets stay non-refundable",
  no_traveldesk_link: "no TravelDesk link",
};

export function BulkInstantForm({
  ids,
  allMatching,
  filters,
  count,
  canActivate,
}: {
  ids: string[];
  allMatching: boolean;
  filters: TableFilters;
  count: number;
  /** `products.activate_instant`: arm and free cancellation. Back to inquiry needs `products.publish` only. */
  canActivate: boolean;
}) {
  const [state, submit, pending] = useActionState<BulkListingResult | null, FormData>(bulkListingAction, null);
  const [action, setAction] = useState<(typeof ACTIONS)[number]["value"]>(canActivate ? "arm" : "inquiry");
  const needsCode = ACTIONS.find((a) => a.value === action)?.needsCode ?? false;
  const available = ACTIONS.filter((a) => canActivate || !a.needsCode);

  return (
    <form action={submit} className="mb-3 rounded-[var(--radius-card)] border border-ink-200 bg-paper p-3" aria-labelledby="bulk-instant-title">
      <h2 id="bulk-instant-title" className="text-sm font-semibold text-ink-800">
        Instant selling in bulk {count > 0 ? `· ${count.toLocaleString("en-IN")} selected` : ""}
      </h2>
      <p className="mt-1 text-2xs text-ink-500">At most 50 listings per run. Readiness still decides each listing: an armed listing sells as inquiry until every check passes.</p>
      <input type="hidden" name="scope" value={allMatching ? "filter" : "ids"} />
      <input type="hidden" name="filters" value={JSON.stringify(filters)} />
      {!allMatching && ids.map((id) => <input key={id} type="hidden" name="ids" value={id} />)}

      <div className="mt-2 grid gap-2 sm:grid-cols-[14rem_minmax(0,1fr)]">
        <label htmlFor="bulk-action" className="block text-xs font-semibold text-ink-800">
          Action
          <select
            id="bulk-action"
            name="action"
            value={action}
            onChange={(e) => setAction(e.target.value as typeof action)}
            className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`}
          >
            {available.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="bulk-reason" className="block text-xs font-semibold text-ink-800">
          Reason (audit log)
          <input id="bulk-reason" name="reason" required minLength={8} maxLength={500} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
        </label>
        {action === "free_cancellation" && (
          <label htmlFor="bulk-source" className="block text-xs font-semibold text-ink-800 sm:col-span-2">
            TravelDesk&apos;s written answer
            <input
              id="bulk-source"
              name="source"
              required
              minLength={8}
              maxLength={200}
              placeholder="Message date and subject"
              className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`}
            />
            <span className="mt-1 block text-2xs font-normal text-ink-500">Run only on TravelDesk&apos;s written answer that no ticket is issued at confirmation.</span>
          </label>
        )}
        {needsCode && <CodeField id="bulk-code" hint="One fresh code for the whole run. In production the owner is emailed, or a second administrator must ask for the same run." />}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" variant={action === "inquiry" ? "outline" : "primary"} disabled={count === 0 || pending} loading={pending} loadingLabel="Running…">
          Run on {count.toLocaleString("en-IN")} listing{count === 1 ? "" : "s"}
        </Button>
      </div>

      {state && !state.ok && (
        <Alert tone="danger" title={state.message} className="mt-3">
          {state.fields?.ids ?? state.fields?.totpCode ?? state.fields?.reason ?? state.fields?.source ?? state.recovery}
        </Alert>
      )}
      {state?.ok && state.data.status === "pending" && (
        <Alert tone="warning" title="Waiting for a second administrator" className="mt-3">
          Nothing has changed yet. Another administrator must ask for the same run, on the same listings, with their own code within 30 minutes.
        </Alert>
      )}
      {state?.ok && state.data.result && (
        <div className="mt-3" role="status">
          <Alert
            tone={state.data.result.failed.length ? "warning" : "success"}
            title={`${state.data.result.applied.length} applied · ${state.data.result.skipped.length} skipped · ${state.data.result.failed.length} failed${state.data.result.remaining.length ? ` · ${state.data.result.remaining.length} not run` : ""}`}
          />
          {/* TODO(doc 30 decision 23): the result list belongs in the owner-picked confirm dialog. */}
          <ul className="mt-2 space-y-1 text-xs text-ink-700">
            {[...state.data.result.failed, ...state.data.result.skipped, ...state.data.result.applied].map((i) => (
              <li key={i.productId}>
                <span className="font-mono text-2xs text-ink-500">{i.productId.slice(-8)}</span> {i.state}: {OUTCOME_LABEL[i.outcome ?? ""] ?? i.outcome ?? ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </form>
  );
}
