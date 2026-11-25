"use client";

import { useActionState, useEffect, useId, useRef } from "react";
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
  AlertDialogTrigger,
} from "@/components/ui/shadcn/alert-dialog";
import { startApprovedBulkAction, type BulkListingResult } from "../../_actions/bulk-listings";
import { INPUT_CLASS, StatusPill, fmtDateTime } from "../../_components/ui";
import { BULK_ACTION_META, ResultList } from "./bulk-action-dialog";

/**
 * "Your bulk approvals" (re-review N2-21): the runs this administrator asked
 * for that no run has used yet. A run waiting for a second administrator is
 * listed so it is not lost when the dialog closes; once approved, "Start"
 * runs it over exactly the approved listings (read from the approval on the
 * server). Each start is the shadcn Alert Dialog with the result list.
 */

export interface OpenApprovalRow {
  approvalId: string;
  action: "arm" | "inquiry" | "free_cancellation";
  itemCount: number;
  state: "pending" | "approved";
  until: string;
}

function StartBody({ row }: { row: OpenApprovalRow }) {
  const [state, submit, pending] = useActionState<BulkListingResult | null, FormData>(startApprovedBulkAction, null);
  const id = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const result = state?.ok ? state.data.result : null;
  useEffect(() => {
    if (result) title.current?.focus();
  }, [result]);
  const message = result ? `${result.applied.length} applied, ${result.skipped.length} skipped, ${result.failed.length} failed` : "";
  return (
    <div className="grid gap-3">
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </div>
      {result ? (
        <>
          <h3 ref={title} tabIndex={-1} className="text-sm font-semibold text-ink-900 outline-none focus-visible:outline-2 focus-visible:outline-ink-900">
            Result
          </h3>
          <Alert tone={result.failed.length ? "warning" : "success"} title={message} />
          <ResultList data={result} />
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </>
      ) : (
        <form action={submit} className="grid gap-3">
          <input type="hidden" name="approvalId" value={row.approvalId} />
          <label htmlFor={`${id}-reason`} className="block text-xs font-semibold text-ink-800">
            Reason (audit log)
            <input id={`${id}-reason`} name="reason" required minLength={8} maxLength={500} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
          </label>
          {row.action === "free_cancellation" && (
            <label htmlFor={`${id}-source`} className="block text-xs font-semibold text-ink-800">
              TravelDesk&apos;s written answer
              <input id={`${id}-source`} name="source" required minLength={8} maxLength={200} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
            </label>
          )}
          {state && !state.ok && (
            <Alert tone="danger" title={state.message} role="alert">
              {state.fields?.reason ?? state.fields?.source ?? state.recovery}
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="submit" size="sm" variant="primary" loading={pending} loadingLabel="Running…">
              Start the run
            </Button>
          </AlertDialogFooter>
        </form>
      )}
    </div>
  );
}

export function OpenApprovals({ rows }: { rows: OpenApprovalRow[] }) {
  const router = useRouter();
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="open-approvals-title" className="mb-3 rounded-[var(--radius-card)] border border-ink-200 bg-paper p-3">
      <h2 id="open-approvals-title" className="text-sm font-semibold text-ink-900">
        Your bulk approvals
      </h2>
      <ul className="mt-2 grid gap-2">
        {rows.map((r) => {
          const label = `${BULK_ACTION_META[r.action].label}, ${r.itemCount} listing${r.itemCount === 1 ? "" : "s"}`;
          return (
            <li key={r.approvalId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold text-ink-800">{label}</span>
              <StatusPill tone={r.state === "approved" ? "success" : "warning"}>{r.state === "approved" ? "approved" : "waiting for a second administrator"}</StatusPill>
              <span className="text-xs text-ink-500">until {fmtDateTime(new Date(r.until))}</span>
              {r.state === "approved" && (
                <AlertDialog onOpenChange={(open) => !open && router.refresh()}>
                  <AlertDialogTrigger
                    render={
                      <Button type="button" size="sm" variant="secondary">
                        Start<span className="sr-only"> {label}</span>
                      </Button>
                    }
                  />
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Start: {label}</AlertDialogTitle>
                      <AlertDialogDescription>Runs over exactly the listings that were approved. No new code is needed: the approval carries it.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <StartBody row={r} />
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
