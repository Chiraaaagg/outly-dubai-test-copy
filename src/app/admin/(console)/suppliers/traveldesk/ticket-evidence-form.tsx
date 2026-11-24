"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { setTicketEvidenceAction, type TicketEvidenceResult } from "../../../_actions/supplier-mappings";
import { INPUT_CLASS } from "../../../_components/ui";

type Answer = "yes" | "no" | "unknown";

const LABEL: Record<Answer, string> = {
  yes: "Issues tickets at confirmation",
  no: "No tickets at confirmation",
  unknown: "Not recorded",
};

/**
 * Whether the mapped TravelDesk offer issues tickets when a booking is
 * confirmed (Q-T1). The answer decides refundability, readiness and whether
 * a live booking completes on its voucher alone. Administrators only, with
 * an authenticator code; `no` is refused while the product is instant.
 */
export function TicketEvidenceForm({
  mappingId,
  current,
  source,
  recordedAt,
  canEdit,
  instant,
}: {
  mappingId: string;
  current: Answer;
  source: string | null;
  recordedAt: string | null;
  canEdit: boolean;
  instant: boolean;
}) {
  const [result, action, pending] = useActionState<TicketEvidenceResult | null, FormData>(setTicketEvidenceAction, null);
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<Answer>(current);
  const error = result && !result.ok ? (result.fields?.source ?? result.fields?.note ?? result.fields?.totpCode ?? result.message) : undefined;

  const summary = (
    <p className="text-2xs text-ink-600">
      <span className="font-semibold text-ink-800">Tickets: {LABEL[current]}</span>
      {source && <span className="block">Source: {source}</span>}
      {recordedAt && <span className="block">Recorded {recordedAt.slice(0, 16).replace("T", " ")} UTC</span>}
    </p>
  );

  if (result?.ok) return <p className="text-2xs font-semibold text-[var(--color-success)]">Saved: {LABEL[result.data.issuesTicketsAtConfirm]}.</p>;
  if (!canEdit) return summary;
  if (!open) {
    return (
      <div className="space-y-1.5">
        {summary}
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Record ticket answer
        </Button>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="mappingId" value={mappingId} />
      <fieldset className="space-y-1">
        <legend className="text-xs font-semibold text-ink-800">Does confirming issue tickets?</legend>
        {(["no", "yes", "unknown"] as const).map((a) => (
          <label key={a} className="flex items-center gap-2 text-xs text-ink-800">
            <input type="radio" name="issuesTicketsAtConfirm" value={a} checked={answer === a} onChange={() => setAnswer(a)} />
            {LABEL[a]}
          </label>
        ))}
      </fieldset>
      {answer === "no" && instant && (
        <p className="text-2xs font-semibold text-[var(--color-warning)]">This product is instant. Switch it to inquiry first; this answer makes bookings refundable.</p>
      )}
      {answer !== "unknown" && (
        <label htmlFor={`source-${mappingId}`} className="block text-xs font-semibold text-ink-800">
          Source
          <input
            id={`source-${mappingId}`}
            name="source"
            required
            minLength={8}
            maxLength={200}
            placeholder="TEST booking #… confirm answer had no ticketsDetails"
            className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`}
          />
        </label>
      )}
      <label htmlFor={`evidence-note-${mappingId}`} className="block text-xs font-semibold text-ink-800">
        Reason
        <input
          id={`evidence-note-${mappingId}`}
          name="note"
          required
          minLength={8}
          maxLength={500}
          placeholder="Pilot product: checked on TravelDesk TEST"
          className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`}
        />
      </label>
      <label htmlFor={`evidence-totp-${mappingId}`} className="block text-xs font-semibold text-ink-800">
        Authenticator code
        <input
          id={`evidence-totp-${mappingId}`}
          name="totpCode"
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          placeholder="123456"
          className={`${INPUT_CLASS} mt-1 min-h-10 w-32 font-mono text-sm font-normal tracking-widest`}
        />
      </label>
      {error && (
        <p className="text-xs font-semibold text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" variant="primary" loading={pending} loadingLabel="Saving…">
          Save answer
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
