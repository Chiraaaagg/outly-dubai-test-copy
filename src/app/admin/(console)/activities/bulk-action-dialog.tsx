"use client";

import { useActionState, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/shadcn/alert-dialog";
import { bulkSetActivityStatusAction, type BulkResult } from "../../_actions/activities";
import { bulkListingAction, resumeBulkAction, startApprovedBulkAction, type BulkListingResult } from "../../_actions/bulk-listings";
import { INPUT_CLASS } from "../../_components/ui";
import { CodeField } from "../suppliers/traveldesk/capabilities/capability-forms";
import type { TableFilters } from "./activities-table";

/**
 * The confirm dialog of the activities bulk bar (doc 30 §3.12, decision 23:
 * shadcn "Alert Dialog" on Base UI, see components/ui/shadcn/alert-dialog.tsx).
 *
 * One dialog per run: it names the action and how many listings it covers,
 * summarises them (titles, or "all N matching these filters"), asks for the
 * reason, TravelDesk's written answer for "free cancellation confirmed" and,
 * for the loosening actions, the existing authenticator code field. After the
 * run it shows the result list in place (applied, skipped, failed with
 * reasons), announced to screen readers, with "Run again" when the 30-minute
 * window closed before every item ran, and the two-person states (waiting
 * for a second administrator; approved, the requester starts it).
 */

export type BulkActionKind = "published" | "draft" | "archived" | "arm" | "inquiry" | "free_cancellation";

export const BULK_ACTION_META: Record<BulkActionKind, { label: string; verb: string; needsCode: boolean; danger?: boolean; help: string }> = {
  published: { label: "Publish", verb: "Publish", needsCode: false, help: "The listings go live on the site." },
  draft: { label: "Unpublish", verb: "Unpublish", needsCode: false, help: "The listings leave the site and stay as drafts." },
  archived: { label: "Archive", verb: "Archive", needsCode: false, help: "The listings leave the site and are archived." },
  arm: {
    label: "Arm / make instant",
    verb: "Arm",
    needsCode: true,
    help: "Requested mode becomes instant. Readiness still decides each listing: an armed listing sells as inquiry until every check passes. At most 50 per run.",
  },
  inquiry: { label: "Back to inquiry", verb: "Send back to inquiry", needsCode: false, help: "The listings stop selling instantly at once. No code is needed." },
  free_cancellation: {
    label: "Free cancellation confirmed",
    verb: "Confirm free cancellation",
    needsCode: true,
    help: "Only on TravelDesk's written answer that no ticket is issued at confirmation. Tickets and listings with a recorded ticket answer are skipped.",
  },
};

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
  supplier_policy_unknown: "supplier refund window unknown",
  ticket_never_refundable: "ticket offer: stays non-refundable",
  ticket_issued_recorded: "a ticket is recorded as issued at confirmation",
  no_traveldesk_link: "no TravelDesk link",
  link_inactive: "a TravelDesk link is inactive",
  link_unreadable: "a TravelDesk link cannot be read",
  content_invalid: "the listing's content needs fixing first",
  mixed_date_only_options: "options mix date-only and timed starts",
};

function outcomeLabel(code: string | null): string {
  if (!code) return "";
  if (OUTCOME_LABEL[code]) return OUTCOME_LABEL[code];
  if (code.startsWith("failed_after_disarm_rearmed:")) return `failed and armed again (${code.split(":").slice(1).join(":")})`;
  if (code.startsWith("failed_after_disarm:")) return `failed and left on inquiry; ops were alerted (${code.split(":").slice(1).join(":")})`;
  return code.replace(/_/g, " ");
}

export interface BulkSelection {
  ids: string[];
  allMatching: boolean;
  filters: TableFilters;
  count: number;
  /** Titles of the selected rows on this page, for the summary. */
  titles: Map<string, string>;
}

function SelectionFields({ selection }: { selection: BulkSelection }) {
  return (
    <>
      <input type="hidden" name="scope" value={selection.allMatching ? "filter" : "ids"} />
      <input type="hidden" name="filters" value={JSON.stringify(selection.filters)} />
      {!selection.allMatching && selection.ids.map((id) => <input key={id} type="hidden" name="ids" value={id} />)}
    </>
  );
}

function Summary({ selection }: { selection: BulkSelection }) {
  if (selection.allMatching) return <p className="text-sm text-ink-700">All {selection.count.toLocaleString("en-IN")} listings matching these filters (recounted on the server).</p>;
  const names = selection.ids.map((id) => selection.titles.get(id) ?? id.slice(-8));
  const shown = names.slice(0, 6);
  return (
    <div className="text-sm text-ink-700">
      <ul className="list-disc space-y-0.5 pl-5">
        {shown.map((n, i) => (
          <li key={`${n}-${i}`} className="break-words">
            {n}
          </li>
        ))}
      </ul>
      {names.length > shown.length && <p className="mt-1 text-xs text-ink-500">and {names.length - shown.length} more</p>}
    </div>
  );
}

function ResultList({ data }: { data: NonNullable<Extract<BulkListingResult, { ok: true }>["data"]["result"]> }) {
  const rows = [...data.failed, ...data.skipped, ...data.applied];
  return (
    <div className="grid gap-2">
      <ul className="max-h-60 space-y-1 overflow-y-auto rounded-[var(--radius-control)] border border-ink-200 p-2 text-xs text-ink-700">
        {rows.map((i) => (
          <li key={i.productId} className="flex flex-wrap gap-x-2">
            <span className={i.state === "failed" ? "font-semibold text-[var(--color-danger)]" : i.state === "applied" ? "font-semibold text-[var(--color-success)]" : "font-semibold text-ink-600"}>{i.state}</span>
            <span className="font-mono text-2xs text-ink-500">{i.productId.slice(-8)}</span>
            <span>{outcomeLabel(i.outcome)}</span>
          </li>
        ))}
        {data.remaining.map((id) => (
          <li key={id} className="flex flex-wrap gap-x-2">
            <span className="font-semibold text-[var(--color-warning)]">not run</span>
            <span className="font-mono text-2xs text-ink-500">{id.slice(-8)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Instant actions: arm, back to inquiry, free cancellation confirmed. */
function InstantRun({ kind, selection, onFinished }: { kind: "arm" | "inquiry" | "free_cancellation"; selection: BulkSelection; onFinished: () => void }) {
  const meta = BULK_ACTION_META[kind];
  const [state, submit, pending] = useActionState<BulkListingResult | null, FormData>(bulkListingAction, null);
  const [resumed, resume, resuming] = useActionState<BulkListingResult | null, FormData>(resumeBulkAction, null);
  const [started, start, starting] = useActionState<BulkListingResult | null, FormData>(startApprovedBulkAction, null);
  const [reason, setReason] = useState("");
  const [source, setSource] = useState("");
  const id = useId();
  const latest = started ?? resumed ?? state;
  useEffect(() => {
    if (latest?.ok && latest.data.result) onFinished();
  }, [latest, onFinished]);

  const ran = latest?.ok && latest.data.result ? latest.data : null;
  const counts = ran?.result
    ? `${ran.result.applied.length} applied, ${ran.result.skipped.length} skipped, ${ran.result.failed.length} failed${ran.result.remaining.length ? `, ${ran.result.remaining.length} not run` : ""}`
    : null;

  return (
    <>
      {!ran && (
        <form action={submit} className="grid gap-3" aria-describedby={`${id}-help`}>
          <SelectionFields selection={selection} />
          <input type="hidden" name="action" value={kind} />
          <p id={`${id}-help`} className="text-xs text-ink-500">
            {meta.help}
          </p>
          <label htmlFor={`${id}-reason`} className="block text-xs font-semibold text-ink-800">
            Reason (audit log)
            <input value={reason} onChange={(e) => setReason(e.target.value)} id={`${id}-reason`} name="reason" required minLength={8} maxLength={500} data-autofocus className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
          </label>
          {kind === "free_cancellation" && (
            <label htmlFor={`${id}-source`} className="block text-xs font-semibold text-ink-800">
              TravelDesk&apos;s written answer
              <input value={source} onChange={(e) => setSource(e.target.value)} id={`${id}-source`} name="source" required minLength={8} maxLength={200} placeholder="Message date and subject" className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
            </label>
          )}
          {meta.needsCode && <CodeField id={`${id}-code`} hint="One fresh code for the whole run. In production the owner is emailed, or a second administrator must ask for the same run." />}
          {state && !state.ok && (
            <Alert tone="danger" title={state.message} role="alert">
              {state.fields?.ids ?? state.fields?.totpCode ?? state.fields?.reason ?? state.fields?.source ?? state.recovery}
            </Alert>
          )}
          {state?.ok && state.data.status === "pending" && (
            <Alert tone="warning" title="Waiting for a second administrator" role="status">
              Nothing has changed yet. Another administrator must ask for the same run on the same listings with their own code within 30 minutes. Then start it here.
            </Alert>
          )}
          {state?.ok && state.data.status === "approved" && (
            <Alert tone="success" title="Approved" role="status">
              Your request approved another administrator&apos;s run. They start it from their own dialog.
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {!(state?.ok && state.data.status !== "applied") && (
              <Button type="submit" size="sm" variant={kind === "inquiry" ? "outline" : "primary"} loading={pending} loadingLabel="Running…" disabled={selection.count === 0}>
                {meta.verb} {selection.count.toLocaleString("en-IN")} listing{selection.count === 1 ? "" : "s"}
              </Button>
            )}
          </AlertDialogFooter>
        </form>
      )}

      {state?.ok && state.data.status === "pending" && !ran && (
        <form action={start} className="grid gap-2">
          <input type="hidden" name="approvalId" value={state.data.approvalId ?? ""} />
          <input type="hidden" name="action" value={kind} />
          <input type="hidden" name="reason" value={reason} />
          {kind === "free_cancellation" && <input type="hidden" name="source" value={source} />}
          {state.data.ids.map((i) => (
            <input key={i} type="hidden" name="ids" value={i} />
          ))}
          {started && !started.ok && (
            <Alert tone="danger" title={started.message} role="alert">
              {started.recovery}
            </Alert>
          )}
          <Button type="submit" size="sm" variant="secondary" loading={starting} loadingLabel="Starting…">
            Start the approved run
          </Button>
        </form>
      )}

      {ran?.result && (
        <div className="grid gap-3">
          <div role="status" aria-live="polite">
            <Alert tone={ran.result.failed.length ? "warning" : "success"} title={`${meta.label}: ${counts}`} />
          </div>
          <ResultList data={ran.result} />
          {ran.result.expired && ran.result.remaining.length > 0 && ran.bulkId && (
            <form action={resume} className="grid gap-2">
              <input type="hidden" name="bulkId" value={ran.bulkId} />
              {kind === "free_cancellation" && <input type="hidden" name="source" value={source} />}
              <p className="text-xs text-ink-600">The run&apos;s 30-minute window closed, or another run held some items. Run again picks up what is left while the window is open; after it closed, select them and start a new run.</p>
              {resumed && !resumed.ok && (
                <Alert tone="danger" title={resumed.message} role="alert">
                  {resumed.recovery}
                </Alert>
              )}
              <Button type="submit" size="sm" variant="outline" loading={resuming} loadingLabel="Running…">
                Run again
              </Button>
            </form>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </div>
      )}
    </>
  );
}

/** Publish, unpublish, archive: the existing bulk status action. */
function StatusRun({ kind, selection, onFinished }: { kind: "published" | "draft" | "archived"; selection: BulkSelection; onFinished: () => void }) {
  const meta = BULK_ACTION_META[kind];
  const [state, submit, pending] = useActionState<BulkResult | null, FormData>(bulkSetActivityStatusAction, null);
  const id = useId();
  useEffect(() => {
    if (state?.ok) onFinished();
  }, [state, onFinished]);
  if (state?.ok) {
    const d = state.data;
    const parts = [`${d.changed} changed`];
    if (d.skipped) parts.push(`${d.skipped} already there`);
    if (d.invalid) parts.push(`${d.invalid} skipped, content needs fixing`);
    if (d.remaining) parts.push(`${d.remaining} still matching, run it again`);
    return (
      <div className="grid gap-3">
        <div role="status" aria-live="polite">
          <Alert tone={d.changed > 0 ? "success" : "info"} title={`${meta.label}: ${parts.join(", ")}`} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Close</AlertDialogCancel>
        </AlertDialogFooter>
      </div>
    );
  }
  return (
    <form action={submit} className="grid gap-3">
      <SelectionFields selection={selection} />
      <input type="hidden" name="status" value={kind} />
      <p className="text-xs text-ink-500">{meta.help}</p>
      <label htmlFor={`${id}-reason`} className="block text-xs font-semibold text-ink-800">
        Reason (optional, audit log)
        <input id={`${id}-reason`} name="reason" maxLength={300} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
      </label>
      {state && !state.ok && (
        <Alert tone="danger" title={state.message} role="alert">
          {state.fields?.ids ?? state.recovery}
        </Alert>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <Button type="submit" size="sm" variant={kind === "published" ? "primary" : "outline"} loading={pending} loadingLabel="Saving…">
          {meta.verb} {selection.count.toLocaleString("en-IN")} listing{selection.count === 1 ? "" : "s"}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

export function BulkActionDialog({
  kind,
  selection,
  open,
  onOpenChange,
  onFinished,
}: {
  kind: BulkActionKind | null;
  selection: BulkSelection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once a run finished (clear the selection after the dialog closes). */
  onFinished: () => void;
}) {
  const router = useRouter();
  const meta = kind ? BULK_ACTION_META[kind] : null;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) router.refresh();
      }}
    >
      {kind && meta && (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {meta.label}: {selection.count.toLocaleString("en-IN")} listing{selection.count === 1 ? "" : "s"}
            </AlertDialogTitle>
            <AlertDialogDescription render={<div />}>
              <Summary selection={selection} />
            </AlertDialogDescription>
          </AlertDialogHeader>
          {kind === "arm" || kind === "inquiry" || kind === "free_cancellation" ? (
            <InstantRun key={kind} kind={kind} selection={selection} onFinished={onFinished} />
          ) : (
            <StatusRun key={kind} kind={kind} selection={selection} onFinished={onFinished} />
          )}
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
