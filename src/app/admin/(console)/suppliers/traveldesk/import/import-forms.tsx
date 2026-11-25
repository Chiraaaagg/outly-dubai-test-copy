"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import {
  applyTravelDeskImportAction,
  copyTravelDeskPhotosAction,
  markListingReviewedAction,
  previewTravelDeskImportAction,
  publishListingsAction,
  restoreReplacedAction,
  rollbackTravelDeskImportAction,
  type BatchActionResult,
  type ImportPreviewResult,
  type PublishListingsResult,
  type ReviewListingResult,
} from "../../../../_actions/traveldesk-import";
import { INPUT_CLASS } from "../../../../_components/ui";

/**
 * Client forms of the TravelDesk import page (doc 30 §3.14). Built from the
 * existing admin pieces (Button, INPUT_CLASS, native inputs). Every write
 * asks for a reason; results are announced in a live region.
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

function ReasonedBatchForm({ batchId, label, verb, act, force }: { batchId: string; label: string; verb: string; act: typeof applyTravelDeskImportAction; force?: boolean }) {
  const [result, action, pending] = useActionState<BatchActionResult | null, FormData>(act, null);
  if (result?.ok) return <p role="status" className="text-2xs font-semibold text-[var(--color-success)]">{result.data.summary}.</p>;
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="batchId" value={batchId} />
      <label htmlFor={`${verb}-${batchId}`} className="sr-only">
        Reason to {label}
      </label>
      <input id={`${verb}-${batchId}`} name="reason" required minLength={8} maxLength={500} placeholder={`Reason to ${label}`} className={`${INPUT_CLASS} min-h-9 w-56 text-sm`} />
      {force && (
        <label className="flex items-center gap-1.5 text-2xs text-ink-800">
          <input type="checkbox" name="force" className="size-4" />
          Include published listings
        </label>
      )}
      <Button type="submit" size="sm" variant={verb === "apply" ? "primary" : "outline"} disabled={pending}>
        {pending ? "Working…" : label}
      </Button>
      <div aria-live="polite" className="basis-full">
        <Outcome result={result} />
      </div>
    </form>
  );
}

export function ApplyBatchForm({ batchId }: { batchId: string }) {
  return <ReasonedBatchForm batchId={batchId} label="Import as drafts" verb="apply" act={applyTravelDeskImportAction} />;
}

export function RollbackBatchForm({ batchId }: { batchId: string }) {
  return <ReasonedBatchForm batchId={batchId} label="Roll back batch" verb="rollback" act={rollbackTravelDeskImportAction} force />;
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
        <label className="flex items-start gap-2 text-xs text-ink-800">
          <input type="checkbox" name="confirmTierAndCategory" className="mt-0.5 size-4" required />
          Tier and category are right (TravelDesk supplies neither)
        </label>
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

/**
 * Bulk publish of reviewed drafts.
 *
 * UI-SLOT(21st.dev): doc 30 §3.14 asks for a table with row selection and a
 * bulk action bar, and a confirm dialog with a result list. Not imported
 * here (owner picks the component from a shortlist with source and licence,
 * decision 23). Until then this is a native checkbox list and submit button.
 */
export function PublishForm({ rows }: { rows: { linkId: string; title: string; slug: string; replaces: string | null }[] }) {
  const [result, action, pending] = useActionState<PublishListingsResult | null, FormData>(publishListingsAction, null);
  return (
    <form action={action} className="space-y-3">
      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-ink-800">Reviewed drafts to publish (at most 50)</legend>
        {rows.length === 0 && <p className="text-sm text-ink-600">No reviewed draft is waiting.</p>}
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.linkId}>
              <label className="flex items-start gap-2 text-sm text-ink-900">
                <input type="checkbox" name="linkIds" value={r.linkId} className="mt-1 size-4" />
                <span>
                  {r.title} <span className="font-mono text-2xs text-ink-500">{r.slug}</span>
                  {r.replaces && <span className="block text-2xs text-ink-600">Retires {r.replaces} with a permanent redirect</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      {rows.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <label htmlFor="publish-reason" className="sr-only">
            Reason to publish
          </label>
          <input id="publish-reason" name="reason" required minLength={8} maxLength={500} placeholder="Reason to publish (owner approval reference)" className={`${INPUT_CLASS} min-h-9 w-80 text-sm`} />
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Publishing…" : "Publish and replace"}
          </Button>
        </div>
      )}
      <div aria-live="polite">
        {result?.ok && (
          <ul className="space-y-1 text-sm">
            {result.data.results.map((r) => (
              <li key={r.linkId} className={r.outcome === "published" ? "text-[var(--color-success)]" : "text-[var(--color-danger)]"}>
                {r.outcome === "published"
                  ? `Published ${r.slug}${r.retired ? `; retired ${r.retired}` : ""}${r.notRetired ? `; old page kept: ${r.notRetired}` : ""}`
                  : `Stopped: ${r.reason}${r.references?.length ? ` (${r.references.join(", ")})` : ""}`}
              </li>
            ))}
          </ul>
        )}
        <Outcome result={result} />
      </div>
    </form>
  );
}
