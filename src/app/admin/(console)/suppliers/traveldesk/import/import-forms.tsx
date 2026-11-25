"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
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
import { FormCheckbox } from "../../../../_components/select-box";
import { PublishTable } from "./publish-table";
import { BATCHES_HEADING_ID, type PublishRow } from "./import-ui";
import {
  applyTravelDeskImportAction,
  copyTravelDeskPhotosAction,
  markListingReviewedAction,
  previewTravelDeskImportAction,
  restoreReplacedAction,
  rollbackTravelDeskImportAction,
  type BatchActionResult,
  type ImportPreviewResult,
  type ReviewListingResult,
} from "../../../../_actions/traveldesk-import";
import { INPUT_CLASS } from "../../../../_components/ui";

/**
 * Client forms of the TravelDesk import page (doc 30 §3.14). The publish
 * selection is the adapted "Team Members Data Table" and the import, rollback
 * and publish confirmations are the shadcn Alert Dialog on Base UI (owner's
 * picks, decision 23; THIRD-PARTY-NOTICES.md). Every write asks for a reason;
 * results are announced in a live region. The server actions stay
 * authoritative (review gate, retire checks, the 50 cap).
 */

function Outcome({ result }: { result: { ok: true } | { ok: false; message: string; recovery?: string; fields?: Record<string, string> } | null }) {
  if (!result) return null;
  if (result.ok) return null;
  return (
    <p role="alert" className="text-xs font-semibold text-[var(--color-danger)]">
      {result.message}
      {result.fields ? ` — ${Object.values(result.fields).join("; ")}` : ""}
      {result.recovery ? ` ${result.recovery}` : ""}
    </p>
  );
}

const STEPS = [
  ["S0", "S0 · Fixed start, self arrival"],
  ["S1", "S1 · Hotel pickup"],
  ["S2", "S2 · External suppliers"],
  ["S3", "S3 · Listed start times"],
  ["S4", "S4 · Tickets"],
  ["S5", "S5 · Date only"],
] as const;

export function PreviewForm({ environment }: { environment: string }) {
  const [result, action, pending] = useActionState<ImportPreviewResult | null, FormData>(previewTravelDeskImportAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="environment" value={environment} />
      <div className="space-y-1.5">
        <label htmlFor="td-step" className="block text-sm font-semibold text-ink-800">
          Offer type
        </label>
        <select id="td-step" name="step" className={`${INPUT_CLASS} min-w-64`} defaultValue="S0">
          {STEPS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant="primary" disabled={pending}>
        {pending ? "Building preview…" : "Preview import"}
      </Button>
      <div aria-live="polite" className="basis-full text-sm">
        {result?.ok && (
          <p className="text-[var(--color-success)]">
            Preview stored: {result.data.counts.create ?? 0} to create, {result.data.counts.adopt ?? 0} to adopt, {result.data.counts.skip ?? 0} already imported, {result.data.counts.blocked ?? 0} blocked. Open it below.
          </p>
        )}
        <Outcome result={result} />
      </div>
    </form>
  );
}

/**
 * Import as drafts and roll back a batch, each confirmed in the shadcn Alert
 * Dialog on Base UI (decision 23): a reason, for rollback the "include
 * published listings" choice, then the service's summary under a focused
 * "Result" heading, announced through a status region mounted empty.
 * The services stay authoritative (import.service / traveldesk-import.service).
 */
function BatchDialog({ batchId, label, verb, act, force, help }: { batchId: string; label: string; verb: string; act: typeof applyTravelDeskImportAction; force?: boolean; help: string }) {
  const router = useRouter();
  // A fresh form (and action state) per opening, so an earlier attempt's error is not shown again (review 109 INT-04).
  const [round, setRound] = useState(0);
  const [done, setDone] = useState(false);
  // After a successful apply or rollback the trigger unmounts on refresh: focus goes to the stable batches heading.
  const stable = useRef<HTMLElement | null>(null);
  useEffect(() => {
    stable.current = document.getElementById(BATCHES_HEADING_ID);
  }, []);
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (open) {
          setDone(false);
          setRound((r) => r + 1);
        } else router.refresh();
      }}
    >
      <AlertDialogTrigger
        render={
          <Button type="button" size="sm" variant={verb === "apply" ? "primary" : "outline"}>
            {label}
          </Button>
        }
      />
      <AlertDialogContent finalFocus={done ? stable : undefined}>
        <AlertDialogHeader>
          <AlertDialogTitle>{label}</AlertDialogTitle>
          <AlertDialogDescription>{help}</AlertDialogDescription>
        </AlertDialogHeader>
        <BatchDialogBody key={round} batchId={batchId} label={label} verb={verb} act={act} force={force} onDone={() => setDone(true)} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

function BatchDialogBody({ batchId, label, verb, act, force, onDone }: { batchId: string; label: string; verb: string; act: typeof applyTravelDeskImportAction; force?: boolean; onDone: () => void }) {
  const [result, action, pending] = useActionState<BatchActionResult | null, FormData>(act, null);
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const done = result?.ok ? result.data.summary : null;
  useEffect(() => {
    if (done) {
      onDone();
      heading.current?.focus();
    }
  }, [done, onDone]);
  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {done ? `${done}.` : ""}
      </div>
      {done ? (
        <div className="grid gap-3">
          <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold text-ink-900 outline-none focus-visible:outline-2 focus-visible:outline-ink-900">
            Result
          </h3>
          <Alert tone="success" title={`${done}.`} />
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </div>
      ) : (
        <form action={action} className="grid gap-3">
          <input type="hidden" name="batchId" value={batchId} />
          <label htmlFor={`${id}-reason`} className="block text-xs font-semibold text-ink-800">
            Reason (audit log)
            <input id={`${id}-reason`} name="reason" required minLength={8} maxLength={500} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
          </label>
          {force && (
            <FormCheckbox id={`${id}-force`} name="force">
              Include published listings (they are unpublished and soft-deleted too)
            </FormCheckbox>
          )}
          <Outcome result={result} />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="submit" size="sm" variant={verb === "apply" ? "primary" : "danger"} loading={pending} loadingLabel="Working…">
              {label}
            </Button>
          </AlertDialogFooter>
        </form>
      )}
    </>
  );
}

export function ApplyBatchForm({ batchId }: { batchId: string }) {
  return <BatchDialog batchId={batchId} label="Import as drafts" verb="apply" act={applyTravelDeskImportAction} help="Creates the previewed listings as drafts: inquiry mode, non-refundable, unindexed, with exact TravelDesk links." />;
}

export function RollbackBatchForm({ batchId }: { batchId: string }) {
  return (
    <BatchDialog
      batchId={batchId}
      label="Roll back batch"
      verb="rollback"
      act={rollbackTravelDeskImportAction}
      force
      help="Unpublishes and soft-deletes the batch's listings through the activity service and deactivates their links; link rows are kept. Published listings stay unless you include them."
    />
  );
}

export function CopyPhotosForm({ batchId }: { batchId: string }) {
  const [result, action, pending] = useActionState<BatchActionResult | null, FormData>(copyTravelDeskPhotosAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="batchId" value={batchId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Copying photos…" : "Copy photos (next 5 tours)"}
      </Button>
      <div aria-live="polite" className="basis-full">
        {result?.ok && <p role="status" className="text-2xs text-[var(--color-success)]">{result.data.summary}.</p>}
        <Outcome result={result} />
      </div>
    </form>
  );
}

export function RestoreReplacedForm({ linkId }: { linkId: string }) {
  const [result, action, pending] = useActionState<BatchActionResult | null, FormData>(restoreReplacedAction, null);
  if (result?.ok) return <p role="status" className="text-2xs font-semibold text-[var(--color-success)]">{result.data.summary}.</p>;
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="linkId" value={linkId} />
      <label htmlFor={`restore-${linkId}`} className="sr-only">
        Reason to restore the old page
      </label>
      <input id={`restore-${linkId}`} name="reason" required minLength={8} maxLength={500} placeholder="Reason to restore the old page" className={`${INPUT_CLASS} min-h-9 w-56 text-sm`} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        Restore old page
      </Button>
      <div aria-live="polite" className="basis-full">
        <Outcome result={result} />
      </div>
    </form>
  );
}

export function ReviewForm({
  linkId,
  title,
  suggestions,
  needsConfirm,
}: {
  linkId: string;
  title: string;
  suggestions: { productId: string; slug: string; title: string; score: number }[];
  needsConfirm: boolean;
}) {
  const [result, action, pending] = useActionState<ReviewListingResult | null, FormData>(markListingReviewedAction, null);
  if (result?.ok) return <p role="status" className="text-2xs font-semibold text-[var(--color-success)]">Marked reviewed.</p>;
  return (
    <form action={action} className="space-y-2" aria-label={`Mark ${title} reviewed`}>
      <input type="hidden" name="linkId" value={linkId} />
      <div className="space-y-1">
        <label htmlFor={`replaces-${linkId}`} className="block text-xs font-semibold text-ink-800">
          Replaces old page
        </label>
        <select id={`replaces-${linkId}`} name="replacesProductId" className={`${INPUT_CLASS} min-h-9 text-sm`} defaultValue={suggestions[0]?.productId ?? ""}>
          <option value="">None (a new page)</option>
          {suggestions.map((s) => (
            <option key={s.productId} value={s.productId}>
              {s.title} ({s.slug}, match {s.score})
            </option>
          ))}
        </select>
      </div>
      {needsConfirm && (
        <FormCheckbox id={`confirm-${linkId}`} name="confirmTierAndCategory" required>
          Tier and category are right (TravelDesk supplies neither)
        </FormCheckbox>
      )}
      <label htmlFor={`note-${linkId}`} className="sr-only">
        Review note
      </label>
      <input id={`note-${linkId}`} name="note" required minLength={8} maxLength={500} placeholder="Copy, facts and photos checked…" className={`${INPUT_CLASS} min-h-9 text-sm`} />
      <Button type="submit" size="sm" variant="primary" disabled={pending}>
        Mark reviewed
      </Button>
      <div aria-live="polite">
        <Outcome result={result} />
      </div>
    </form>
  );
}

/** Bulk publish of reviewed drafts: the selection table and confirm dialog (decision 23), publish-table.tsx. */
export function PublishForm({ rows }: { rows: PublishRow[] }) {
  return <PublishTable rows={rows} />;
}
