"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import {
  approveResolutionAction,
  deliberateReadAction,
  requestRefetchAction,
  requestResolutionAction,
  type DeliberateReadResult,
  type RefetchResult,
  type ResolutionActionResult,
} from "../../../_actions/bookings";
import { INPUT_CLASS } from "../../../_components/ui";

/**
 * Staff actions on the order detail (doc 22 §23 B5, R-B4-5), as small forms
 * built on the console's `INPUT_CLASS`, the shared `Button` and the
 * feedback pattern of the TravelDesk booking controls (`booking-controls.tsx`).
 * The server actions check every permission again; these forms only render
 * for staff the page already found allowed.
 */

const OUTCOME_TEXT: Record<string, string> = {
  no_source: "No ticket source is configured on this deployment, so nothing was read.",
  busy: "Another read of this booking is running. Try again in a few minutes.",
};

const REFUSED_TEXT: Record<string, string> = {
  forbidden: "Your role may not do this.",
  same_person: "A second person must approve this.",
  expired: "This request has expired; ask again.",
  step_up_required: "The code was not accepted; wait for a new one.",
  not_flagged: "This row is not flagged any more.",
  holds_money_step: "This flag holds an automatic payment or booking step, so it cannot be cleared from the console.",
  holds_resend: "This flag stops an automatic resend, so it cannot be cleared from the console.",
  late_acceptance_hold: "The operator accepted this booking late; its hold stays until recovery or our team resolves it with the operator.",
  no_order: "This row has no order.",
  closed: "This request is already closed.",
  not_open_exception: "This is not an open exception request.",
};

function Problem({ result }: { result: { ok: false; message: string; fields?: Record<string, string> } }) {
  const field = result.fields ? Object.values(result.fields)[0] : undefined;
  return (
    <p className="text-xs font-semibold text-[var(--color-danger)]" role="alert">
      {field ?? result.message}
    </p>
  );
}

function ResolutionFeedback({ result }: { result: ResolutionActionResult | null }) {
  if (!result) return null;
  if (!result.ok) return <Problem result={result} />;
  const r = result.data;
  if (r.status === "pending")
    return (
      <p className="text-2xs font-semibold text-[var(--color-warning)]" role="status">
        Waiting for a second approver. Nothing has changed yet: another administrator must approve it with their own code within 30 minutes.
      </p>
    );
  if (r.status === "refused")
    return (
      <p className="text-xs font-semibold text-[var(--color-danger)]" role="alert">
        Refused: {REFUSED_TEXT[r.reason] ?? r.reason}
      </p>
    );
  return (
    <p className="text-2xs font-semibold text-[var(--color-success)]" role="status">
      Done. The change is recorded in the audit log.
    </p>
  );
}

function CodeField({ id }: { id: string }) {
  return (
    <label htmlFor={id} className="block text-xs font-semibold text-ink-800">
      Authenticator code
      <input
        id={id}
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
  );
}

function EvidenceField({ id, max }: { id: string; max: number }) {
  return (
    <label htmlFor={id} className="block text-xs font-semibold text-ink-800">
      Evidence reference
      <input id={id} name="evidence" required minLength={3} maxLength={max} placeholder="Ticket or call reference" className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
      <span className="mt-1 block text-2xs font-normal text-ink-500">A reference only, no customer details. Only a keyed hash of it is kept.</span>
    </label>
  );
}

export function DeliberateReadForm({ supplierBookingId, reference }: { supplierBookingId: string; reference: string }) {
  const [result, action, pending] = useActionState<DeliberateReadResult | null, FormData>(deliberateReadAction, null);
  return (
    <form action={action} className="space-y-1.5">
      <input type="hidden" name="supplierBookingId" value={supplierBookingId} />
      <input type="hidden" name="reference" value={reference} />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending ? "Reading…" : "Read tickets from the operator"}
      </Button>
      <p className="text-2xs text-ink-500">One read of this booking&apos;s tickets. Audited.</p>
      {result && !result.ok && <Problem result={result} />}
      {result?.ok && (
        <p className="text-2xs font-semibold text-ink-700" role="status">
          {OUTCOME_TEXT[result.data.outcome] ?? `Read finished: ${result.data.outcome.replace(/_/g, " ")}.`}
        </p>
      )}
    </form>
  );
}

export function RefetchForm({ documentId, reference, reasons }: { documentId: string; reference: string; reasons: { value: string; label: string }[] }) {
  const [result, action, pending] = useActionState<RefetchResult | null, FormData>(requestRefetchAction, null);
  const id = `refetch-${documentId}`;
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="reference" value={reference} />
      <label htmlFor={id} className="text-xs font-semibold text-ink-800">
        Reason
        <select id={id} name="reason" required className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`}>
          {reasons.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending ? "Asking…" : "Request a fresh copy"}
      </Button>
      {result && !result.ok && <Problem result={result} />}
      {result?.ok && (
        <p className="text-2xs font-semibold text-[var(--color-success)]" role="status">
          Requested. The current copy stays available until the new one replaces it.
        </p>
      )}
    </form>
  );
}

export function ClearAttentionForm({
  target,
  targetId,
  reference,
  reasons,
  evidenceMax,
}: {
  target: string;
  targetId: string;
  reference: string;
  reasons: { value: string; label: string }[];
  evidenceMax: number;
}) {
  const [result, action, pending] = useActionState<ResolutionActionResult | null, FormData>(requestResolutionAction, null);
  const id = `clear-${targetId}`;
  return (
    <form action={action} className="space-y-2 rounded-[var(--radius-control)] border border-ink-200 p-3">
      <p className="text-xs font-semibold text-ink-800">Clear this attention flag</p>
      <input type="hidden" name="action" value="clear_attention" />
      <input type="hidden" name="target" value={target} />
      <input type="hidden" name="targetId" value={targetId} />
      <input type="hidden" name="reference" value={reference} />
      <label htmlFor={`${id}-reason`} className="block text-xs font-semibold text-ink-800">
        Reason
        <select id={`${id}-reason`} name="reasonCode" required className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`}>
          {reasons.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <EvidenceField id={`${id}-evidence`} max={evidenceMax} />
      <CodeField id={`${id}-code`} />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending ? "Sending…" : "Clear flag"}
      </Button>
      <ResolutionFeedback result={result} />
    </form>
  );
}

export function CloseExceptionForm({ targetId, reference, evidenceMax }: { targetId: string; reference: string; evidenceMax: number }) {
  const [result, action, pending] = useActionState<ResolutionActionResult | null, FormData>(requestResolutionAction, null);
  const id = `close-${targetId}`;
  return (
    <form action={action} className="space-y-2 rounded-[var(--radius-control)] border border-ink-200 p-3">
      <p className="text-xs font-semibold text-ink-800">Close this exception request</p>
      <p className="text-2xs text-ink-500">No refund is made from here. Closing only records how the request was handled.</p>
      <input type="hidden" name="action" value="close_exception" />
      <input type="hidden" name="targetId" value={targetId} />
      <input type="hidden" name="reference" value={reference} />
      <fieldset className="space-y-1">
        <legend className="text-xs font-semibold text-ink-800">Outcome</legend>
        <label className="flex items-center gap-2 text-xs text-ink-800">
          <input type="radio" name="outcome" value="declined" defaultChecked /> Declined
        </label>
        <label className="flex items-center gap-2 text-xs text-ink-800">
          <input type="radio" name="outcome" value="handled_offline" /> Handled offline
        </label>
      </fieldset>
      <EvidenceField id={`${id}-evidence`} max={evidenceMax} />
      <CodeField id={`${id}-code`} />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending ? "Sending…" : "Close request"}
      </Button>
      <ResolutionFeedback result={result} />
    </form>
  );
}

/** R-B5-2: close a failed refund once the provider shows the item refunded another way. Moves no money. */
export function CloseRefundFailedForm({ targetId, reference, evidenceMax }: { targetId: string; reference: string; evidenceMax: number }) {
  const [result, action, pending] = useActionState<ResolutionActionResult | null, FormData>(requestResolutionAction, null);
  const id = `close-refund-${targetId}`;
  return (
    <form action={action} className="space-y-2 rounded-[var(--radius-control)] border border-ink-200 p-3">
      <p className="text-xs font-semibold text-ink-800">Close this failed refund</p>
      <p className="text-2xs text-ink-500">
        Only when the payment provider already shows this item refunded (for example from its dashboard). No refund is made from here; the request is refused if
        the provider&apos;s refunded total does not cover the item.
      </p>
      <input type="hidden" name="action" value="close_refund_failed" />
      <input type="hidden" name="targetId" value={targetId} />
      <input type="hidden" name="reference" value={reference} />
      <input type="hidden" name="outcome" value="refunded_at_provider" />
      <EvidenceField id={`${id}-evidence`} max={evidenceMax} />
      <CodeField id={`${id}-code`} />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending ? "Sending…" : "Close as refunded at the provider"}
      </Button>
      <ResolutionFeedback result={result} />
    </form>
  );
}

export function ApproveResolutionForm({ approvalId, reference }: { approvalId: string; reference: string }) {
  const [result, action, pending] = useActionState<ResolutionActionResult | null, FormData>(approveResolutionAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="approvalId" value={approvalId} />
      <input type="hidden" name="reference" value={reference} />
      <CodeField id={`approve-${approvalId}`} />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        {pending ? "Approving…" : "Approve"}
      </Button>
      <div className="basis-full">
        <ResolutionFeedback result={result} />
      </div>
    </form>
  );
}
