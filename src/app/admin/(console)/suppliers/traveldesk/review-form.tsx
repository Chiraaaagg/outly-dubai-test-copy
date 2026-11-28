"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { reviewCandidateAction, type ReviewCandidateResult } from "../../../_actions/supplier-mappings";
import { INPUT_CLASS } from "../../../_components/ui";

/**
 * Approve / reject (suggested), revoke (approved) or reopen (rejected) one mapping candidate. The
 * reason is mandatory and goes to the audit log. Approval records a supplier
 * mapping only; it never makes a product instant.
 */
export function ReviewForm({ id, state, label }: { id: string; state: "suggested" | "approved" | "rejected"; label: string }) {
  const [result, action, pending] = useActionState<ReviewCandidateResult | null, FormData>(reviewCandidateAction, null);
  const [decision, setDecision] = useState<"approve" | "reject" | "revoke" | "reopen" | null>(null);
  const noteError = result && !result.ok ? result.fields?.note : undefined;

  if (result?.ok) return <p className="text-2xs font-semibold text-[var(--color-success)]">Saved: {result.data.state}.</p>;

  if (!decision) {
    if (state === "rejected") {
      return (
        <Button variant="outline" size="sm" onClick={() => setDecision("reopen")}>
          Reopen
        </Button>
      );
    }
    return state === "approved" ? (
      <Button variant="outline" size="sm" onClick={() => setDecision("revoke")}>
        Revoke
      </Button>
    ) : (
      <div className="flex gap-1.5">
        <Button variant="primary" size="sm" onClick={() => setDecision("approve")}>
          Approve
        </Button>
        <Button variant="outline" size="sm" onClick={() => setDecision("reject")}>
          Reject
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="decision" value={decision} />
      <label htmlFor={`note-${id}`} className="block text-xs font-semibold text-ink-800">
        Reason to {decision} {label}
      </label>
      <input
        id={`note-${id}`}
        name="note"
        required
        minLength={8}
        maxLength={500}
        placeholder={decision === "approve" ? "Same product: slots, inclusions and pax rules checked…" : "Different product / price basis / …"}
        aria-invalid={noteError ? true : undefined}
        className={`${INPUT_CLASS} min-h-10 text-sm`}
        autoFocus
      />
      {result && !result.ok && (
        <p className="text-xs font-semibold text-[var(--color-danger)]" role="alert">
          {noteError ?? result.message}
        </p>
      )}
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" variant={decision === "approve" ? "primary" : "secondary"} loading={pending} loadingLabel="Saving…">
          Confirm {decision}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setDecision(null)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
