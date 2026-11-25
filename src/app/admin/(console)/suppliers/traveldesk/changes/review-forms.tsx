"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { approvePriceChangeAction, dismissReviewAction, type UpkeepReviewResult } from "../../../../_actions/traveldesk-upkeep";
import { INPUT_CLASS } from "../../../../_components/ui";

/**
 * Client forms of the supplier changes log (doc 30 §3.10, N3). Built from the
 * existing admin pieces (Button, INPUT_CLASS, native inputs): no new
 * component. Every write asks for a reason; results are announced.
 */

function Outcome({ result }: { result: UpkeepReviewResult | null }) {
  if (!result) return null;
  if (result.ok) return <p role="status" className="text-2xs font-semibold text-[var(--color-success)]">{result.data.summary}.</p>;
  return (
    <p role="alert" className="text-2xs font-semibold text-[var(--color-danger)]">
      {result.message}
      {result.fields ? ` — ${Object.values(result.fields).join("; ")}` : ""}
    </p>
  );
}

export function ReviewActions({ changeId, kind, canApprovePrice }: { changeId: string; kind: string; canApprovePrice: boolean }) {
  const [approved, approve, approving] = useActionState<UpkeepReviewResult | null, FormData>(approvePriceChangeAction, null);
  const [closed, close, closing] = useActionState<UpkeepReviewResult | null, FormData>(dismissReviewAction, null);
  if (approved?.ok || closed?.ok) return <Outcome result={approved?.ok ? approved : closed} />;
  const id = `note-${changeId}`;
  return (
    <form className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="changeId" value={changeId} />
      <label htmlFor={id} className="sr-only">
        Reason (goes to the audit log)
      </label>
      <input id={id} name="note" required minLength={8} maxLength={500} placeholder="Reason (audit log)" className={`${INPUT_CLASS} min-h-9 w-52 text-sm`} />
      {kind === "price_jump" && canApprovePrice && (
        <Button type="submit" size="sm" variant="primary" formAction={approve} disabled={approving || closing}>
          Apply new price
        </Button>
      )}
      <Button type="submit" size="sm" variant="outline" formAction={close} disabled={approving || closing}>
        Close
      </Button>
      <div aria-live="polite" className="basis-full">
        <Outcome result={approved ?? closed} />
      </div>
    </form>
  );
}
