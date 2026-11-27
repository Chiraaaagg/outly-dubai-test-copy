"use client";

import { useActionState, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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
import { BATCHES_HEADING_ID, openWhenValid, reportingAction, type PublishRow } from "./import-ui";
import {
  applyTravelDeskImportAction,
  copyTravelDeskPhotosAction,
  markListingReviewedAction,
  moveToCleanAddressAction,
  previewTravelDeskImportAction,
  restoreReplacedAction,
  retireOldPageAction,
  rollbackTravelDeskImportAction,
  undoCleanAddressAction,
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
  // Stable, so the body's effect runs once per success (review 110 R110-02).
  const markDone = useCallback(() => setDone(true), []);
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
        <BatchDialogBody key={round} batchId={batchId} label={label} verb={verb} act={act} force={force} onDone={markDone} />
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

export function RestoreReplacedForm({ linkId, onDone }: { linkId: string; onDone?: (summary: string) => void }) {
  const [result, action, pending] = useActionState<BatchActionResult | null, FormData>(useReportingAction(restoreReplacedAction, onDone), null);
  if (result?.ok) return onDone ? null : <p role="status" className="text-2xs font-semibold text-[var(--color-success)]">{result.data.summary}.</p>;
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

type RowAction = (prev: BatchActionResult | null, fd: FormData) => Promise<BatchActionResult>;

/**
 * The form's action, reporting a success to the row's outcome region (ReviewActions) from inside the action. The
 * server action's response carries the refreshed page, which unmounts the submitting form in the same commit, so an
 * effect in the form would never run (final review, P3-4); the region outlives the forms.
 */
function useReportingAction(act: RowAction, onDone: ((summary: string) => void) | undefined): RowAction {
  return useMemo(() => reportingAction(act, onDone), [act, onDone]);
}

/**
 * The address and retire actions of one published row, with one outcome region for all of them (review P3-4).
 * A success refreshes the page, which swaps the forms (the move form goes, the undo form comes), so the outcome
 * is announced and focused here, outside them: a status region mounted empty, focused when it gets a message.
 */
export function ReviewActions({
  linkId,
  title,
  slug,
  retireOptions,
  cleanAddress,
  movedFrom,
  canRestore,
  confirm,
}: {
  linkId: string;
  title: string;
  slug: string;
  retireOptions: { productId: string; slug: string; title: string; archived: boolean }[];
  cleanAddress: string | null;
  movedFrom: string | null;
  canRestore: boolean;
  confirm: boolean;
}) {
  const [outcome, setOutcome] = useState<{ text: string; n: number } | null>(null);
  const region = useRef<HTMLParagraphElement>(null);
  const done = useCallback((text: string) => setOutcome((o) => ({ text, n: (o?.n ?? 0) + 1 })), []);
  useEffect(() => {
    if (outcome) region.current?.focus();
  }, [outcome]);
  return (
    <div className="space-y-2">
      <p ref={region} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true" className="text-2xs font-semibold text-[var(--color-success)] outline-none focus-visible:outline-2 focus-visible:outline-ink-900 empty:hidden">
        {outcome ? `${outcome.text}.` : ""}
      </p>
      {retireOptions.length > 0 && <RetireOldPageForm linkId={linkId} title={title} options={retireOptions} confirm={confirm} onDone={done} />}
      {cleanAddress && <CleanAddressForm linkId={linkId} mode="move" from={slug} to={cleanAddress} confirm={confirm} onDone={done} />}
      {movedFrom && <CleanAddressForm linkId={linkId} mode="undo" from={slug} to={movedFrom} confirm={confirm} onDone={done} />}
      {canRestore && <RestoreReplacedForm linkId={linkId} onDone={done} />}
    </div>
  );
}

/** A success line that takes focus when it appears, so a keyboard or screen reader user lands on the outcome. */
function DoneLine({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <p ref={ref} tabIndex={-1} role="status" className="text-2xs font-semibold text-[var(--color-success)] outline-none focus-visible:outline-2 focus-visible:outline-ink-900">
      {text}.
    </p>
  );
}

/**
 * The submit control of a retire or address form. In production it first opens a confirmation in the shadcn Alert
 * Dialog on Base UI (the rollback dialog's components, decision 23) whose confirm button submits the form by id;
 * elsewhere it submits at once. The dialog closes when the action answers.
 */
function ConfirmSubmit({ formId, confirm, label, pending, title, description, result }: { formId: string; confirm: boolean; label: string; pending: boolean; title: string; description: string; result: unknown }) {
  // Open for the result it was opened on: a new answer from the action closes it without an effect.
  const [openFor, setOpenFor] = useState<{ result: unknown } | null>(null);
  const open = openFor !== null && openFor.result === result;
  const setOpen = (next: boolean) => setOpenFor(next ? { result } : null);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!confirm) {
    return (
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        {pending ? "Working…" : label}
      </Button>
    );
  }
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {/* Not a dialog trigger: the confirmation opens only for a form the browser accepts (review P3-3). */}
      <Button ref={trigger} type="button" size="sm" variant="outline" disabled={pending} onClick={() => openWhenValid(document.getElementById(formId) as HTMLFormElement | null) && setOpen(true)}>
        {label}…
      </Button>
      <AlertDialogContent finalFocus={trigger}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button type="submit" form={formId} size="sm" variant="danger" loading={pending} loadingLabel="Working…">
            {label}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Retire the old page of an already published listing (doc 30 §3.9 follow-up). Nothing is pre-selected; the
 * service applies the publish path's retire rules and reports a refusal with its reason.
 */
export function RetireOldPageForm({ linkId, title, options, confirm = false, onDone }: { linkId: string; title: string; options: { productId: string; slug: string; title: string; archived: boolean }[]; confirm?: boolean; onDone?: (summary: string) => void }) {
  const [result, action, pending] = useActionState<BatchActionResult | null, FormData>(useReportingAction(retireOldPageAction, onDone), null);
  const id = useId();
  if (result?.ok) return onDone ? null : <DoneLine text={result.data.summary} />;
  const failed = Boolean(result && !result.ok);
  const invalid = failed ? { "aria-invalid": true, "aria-describedby": `${id}-error` } : {};
  return (
    <form id={`${id}-form`} action={action} className="space-y-2" aria-label={`Retire the old page of ${title}`}>
      <input type="hidden" name="linkId" value={linkId} />
      <div className="space-y-1">
        <label htmlFor={`${id}-old`} className="block text-xs font-semibold text-ink-800">
          Retire old page
        </label>
        <select id={`${id}-old`} name="oldProductId" required defaultValue="" {...invalid} className={`${INPUT_CLASS} min-h-9 text-sm`}>
          <option value="" disabled>
            Choose the page this one replaces
          </option>
          {options.map((o) => (
            <option key={o.productId} value={o.productId}>
              {o.title} ({o.slug}
              {o.archived ? ", already archived: redirect only" : ""})
            </option>
          ))}
        </select>
      </div>
      <label htmlFor={`${id}-reason`} className="sr-only">
        Reason to retire the old page
      </label>
      <input id={`${id}-reason`} name="reason" required minLength={8} maxLength={500} placeholder="Reason to retire the old page" {...invalid} className={`${INPUT_CLASS} min-h-9 w-56 text-sm`} />
      <ConfirmSubmit
        formId={`${id}-form`}
        confirm={confirm}
        label="Retire and redirect"
        pending={pending}
        result={result}
        title={`Retire the old page of ${title}?`}
        description="A live old page is unpublished and soft-deleted; its address redirects here permanently. An archived page only gets the redirect. Restore old page undoes it."
      />
      <div id={`${id}-error`} aria-live="polite">
        <Outcome result={result} />
      </div>
    </form>
  );
}

/** Move a published "<base>-<n>" listing to its clean address, or undo that move (traveldesk-address.ts). */
export function CleanAddressForm({ linkId, mode, from, to, confirm = false, onDone }: { linkId: string; mode: "move" | "undo"; from: string; to: string; confirm?: boolean; onDone?: (summary: string) => void }) {
  const [result, action, pending] = useActionState<BatchActionResult | null, FormData>(useReportingAction(mode === "move" ? moveToCleanAddressAction : undoCleanAddressAction, onDone), null);
  const id = useId();
  if (result?.ok) return onDone ? null : <DoneLine text={result.data.summary} />;
  const failed = Boolean(result && !result.ok);
  const label = mode === "move" ? `Move to ${to}` : `Move back to ${to}`;
  return (
    <form id={`${id}-form`} action={action} className="flex flex-wrap items-end gap-2" aria-label={`${label} (now ${from})`}>
      <input type="hidden" name="linkId" value={linkId} />
      <label htmlFor={`${id}-reason`} className="sr-only">
        Reason to {mode === "move" ? "move to the clean address" : "undo the address move"}
      </label>
      <input
        id={`${id}-reason`}
        name="reason"
        required
        minLength={8}
        maxLength={500}
        placeholder={mode === "move" ? "Reason to move the address" : "Reason to undo the move"}
        aria-invalid={failed || undefined}
        aria-describedby={failed ? `${id}-error` : undefined}
        className={`${INPUT_CLASS} min-h-9 w-56 text-sm`}
      />
      <ConfirmSubmit
        formId={`${id}-form`}
        confirm={confirm}
        label={label}
        pending={pending}
        result={result}
        title={`${label}?`}
        description={`The listing's address changes from /activities/${from} to /activities/${to}; the old address redirects to it permanently. You can move it back.`}
      />
      <div id={`${id}-error`} aria-live="polite" className="basis-full">
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
        {/* No pre-selection (review INT-08): a page is retired only when a person picks it; the suggestions stay listed. */}
        <select id={`replaces-${linkId}`} name="replacesProductId" className={`${INPUT_CLASS} min-h-9 text-sm`} defaultValue="">
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
