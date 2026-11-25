"use client";

import { useActionState, useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/shadcn/alert-dialog";
import { narrowClassProofAction, proofDemotionsAction, revokeClassProofAction, type CapabilityActionResult } from "../../../../_actions/supplier-capabilities";
import { INPUT_CLASS } from "../../../../_components/ui";
import { Feedback, ProofForm, type ProofPreset } from "./capability-forms";

/**
 * Class proof actions in the confirm dialog (doc 30 §3.12, decision 23:
 * shadcn "Alert Dialog" on Base UI). Record and widen ask for the existing
 * authenticator code; narrow (one atomic replace, review N2-01) and revoke
 * ask for a reason. Narrow and revoke show, before anything changes, how many
 * listings selling instantly today would go to inquiry, and need that number
 * typed to go ahead (review N2-05). The page refreshes when a dialog closes.
 */

type Environment = "test" | "production";

export interface ProofDialogRow extends ProofPreset {
  id: string;
}

function scopeText(p: { scopeKind: string; scopeTourIds: string[] }) {
  return p.scopeKind === "tours" ? `tours ${p.scopeTourIds.join(", ")}` : p.scopeKind === "all" ? "every offer of the key" : "one provider";
}

function useRefreshOnClose(): (open: boolean) => void {
  const router = useRouter();
  return (open) => {
    if (!open) router.refresh();
  };
}

/** The demotion count of a revoke or narrowing, read when asked. */
function useDemotions(proofId: string) {
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, start] = useTransition();
  const check = (change: { kind: "revoke" } | { kind: "narrow"; scopeTourIds: string[] }) =>
    start(async () => {
      const r = await proofDemotionsAction(proofId, change);
      if (r.ok) {
        setCount(r.data.count);
        setError(null);
      } else {
        setCount(null);
        setError(r.message);
      }
    });
  return { count, error, checking, check };
}

function demotionMessage(count: number | null, checking: boolean): string {
  if (checking) return "Checking which listings this changes.";
  if (count === null) return "";
  if (count === 0) return "No listing selling instantly today changes.";
  return `${count} listing${count === 1 ? "" : "s"} selling instantly today would go to inquiry. Type ${count} to confirm.`;
}

/**
 * The demotion count. Review N2-19: the live region is mounted empty with the
 * dialog and only its text changes, so the count is announced; errors use
 * role="alert".
 */
function DemotionNotice({ count, error, checking, inputId }: { count: number | null; error: string | null; checking: boolean; inputId: string }) {
  const message = error ? "" : demotionMessage(count, checking);
  return (
    <>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </div>
      {error && (
        <p className="text-xs font-semibold text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      )}
      {!error && (checking || count === 0) && <p className="text-xs text-ink-600">{message}</p>}
      {!error && !checking && count !== null && count > 0 && (
        <label htmlFor={inputId} className="block text-xs font-semibold text-[var(--color-danger)]">
          {message}
          <input id={inputId} name="confirmDemotions" required inputMode="numeric" pattern={String(count)} className={`${INPUT_CLASS} mt-1 min-h-10 w-32 font-mono text-sm font-normal`} />
        </label>
      )}
    </>
  );
}

function RevokeBody({ proof, label }: { proof: ProofDialogRow; label: string }) {
  const [result, action, pending] = useActionState<CapabilityActionResult | null, FormData>(revokeClassProofAction, null);
  const d = useDemotions(proof.id);
  const id = useId();
  const { check } = d;
  useEffect(() => {
    check({ kind: "revoke" });
    // Read once when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="proofId" value={proof.id} />
      <label htmlFor={`${id}-note`} className="block text-xs font-semibold text-ink-800">
        Reason (audit log)
        <input id={`${id}-note`} name="note" required minLength={8} maxLength={500} data-autofocus className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
      </label>
      <DemotionNotice {...d} inputId={`${id}-confirm`} />
      <p className="text-xs text-ink-500">Revoking never brings a seeded key&apos;s no-evidence exception back.</p>
      <Feedback result={result} saved="Proof revoked." />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <AlertDialogCancel>{result?.ok ? "Close" : "Cancel"}</AlertDialogCancel>
        {!result?.ok && (
          <Button type="submit" size="sm" variant="danger" loading={pending} loadingLabel="Revoking…" disabled={d.checking} aria-label={label}>
            Revoke proof
          </Button>
        )}
      </div>
    </form>
  );
}

function NarrowBody({ proof }: { proof: ProofDialogRow }) {
  const [result, action, pending] = useActionState<CapabilityActionResult | null, FormData>(narrowClassProofAction, null);
  const d = useDemotions(proof.id);
  const id = useId();
  const [tours, setTours] = useState(proof.scopeTourIds.join(", "));
  const list = tours.split(/[\s,]+/).filter(Boolean);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="proofId" value={proof.id} />
      <label htmlFor={`${id}-tours`} className="block text-xs font-semibold text-ink-800">
        Tours to keep
        <input
          id={`${id}-tours`}
          name="scopeTourIds"
          required
          value={tours}
          onChange={(e) => setTours(e.target.value)}
          onBlur={() => d.check({ kind: "narrow", scopeTourIds: list })}
          inputMode="numeric"
          data-autofocus
          className={`${INPUT_CLASS} mt-1 min-h-10 font-mono text-sm font-normal`}
        />
        <span className="mt-1 block text-2xs font-normal text-ink-500">
          A strict subset of {scopeText(proof)}{proof.bookedTourId ? `; the booked tour ${proof.bookedTourId} stays` : ""}. The old proof is revoked in the same step.
        </span>
      </label>
      <label htmlFor={`${id}-note`} className="block text-xs font-semibold text-ink-800">
        Reason (audit log)
        <input id={`${id}-note`} name="note" required minLength={8} maxLength={500} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
      </label>
      <DemotionNotice {...d} inputId={`${id}-confirm`} />
      <Feedback result={result} saved="Proof narrowed." />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <AlertDialogCancel>{result?.ok ? "Close" : "Cancel"}</AlertDialogCancel>
        {!result?.ok && (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => d.check({ kind: "narrow", scopeTourIds: list })} loading={d.checking} loadingLabel="Checking…">
              Check effect
            </Button>
            <Button type="submit" size="sm" variant="secondary" loading={pending} loadingLabel="Saving…" disabled={d.count === null || d.checking}>
              Narrow proof
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

/** Widen, narrow and revoke for one proof row, each in the confirm dialog. */
export function ProofActions({ proof, environment, classKeys, oneStep }: { proof: ProofDialogRow; environment: Environment; classKeys: string[]; oneStep: boolean }) {
  const onOpenChange = useRefreshOnClose();
  const label = `${proof.classKey}, ${scopeText(proof)}`;
  const trigger = (text: string, aria: string) => (
    <AlertDialogTrigger
      render={
        <Button type="button" size="sm" variant="ghost" aria-label={aria}>
          {text}
        </Button>
      }
    />
  );
  return (
    <div className="flex flex-wrap gap-1">
      {classKeys.length > 0 && (
        <AlertDialog onOpenChange={onOpenChange}>
          {trigger("Widen", `Widen proof ${label}`)}
          <AlertDialogContent className="max-w-2xl">
            <AlertDialogHeader>
              <AlertDialogTitle>Widen proof</AlertDialogTitle>
              <AlertDialogDescription>{label}. A wider scope is a new proof with its own code.</AlertDialogDescription>
            </AlertDialogHeader>
            <ProofForm environment={environment} classKeys={classKeys} oneStep={oneStep} preset={proof} idPrefix={`wd-${proof.id.slice(-8)}`} footer={<AlertDialogCancel>Close</AlertDialogCancel>} />
          </AlertDialogContent>
        </AlertDialog>
      )}
      {proof.scopeKind === "tours" && proof.scopeTourIds.length > 1 && (
        <AlertDialog onOpenChange={onOpenChange}>
          {trigger("Narrow", `Narrow proof ${label}`)}
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Narrow proof</AlertDialogTitle>
              <AlertDialogDescription>{label}. No code is needed: it only tightens.</AlertDialogDescription>
            </AlertDialogHeader>
            <NarrowBody proof={proof} />
          </AlertDialogContent>
        </AlertDialog>
      )}
      <AlertDialog onOpenChange={onOpenChange}>
        {trigger("Revoke", `Revoke proof ${label}`)}
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke proof</AlertDialogTitle>
            <AlertDialogDescription>{label}. Offers it covered need another proof or per-offer evidence to sell instantly.</AlertDialogDescription>
          </AlertDialogHeader>
          <RevokeBody proof={proof} label={`Revoke proof ${label}`} />
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** "Record a proof" in the confirm dialog. */
export function RecordProofDialog({ environment, classKeys, oneStep }: { environment: Environment; classKeys: string[]; oneStep: boolean }) {
  const onOpenChange = useRefreshOnClose();
  return (
    <AlertDialog onOpenChange={onOpenChange}>
      <AlertDialogTrigger
        render={
          <Button type="button" size="sm" variant="secondary">
            Record a proof
          </Button>
        }
      />
      <AlertDialogContent className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Record a class proof</AlertDialogTitle>
          <AlertDialogDescription>One proof per offer type, scoped to the booked tour. A first proof on a seeded key ends its no-evidence exception.</AlertDialogDescription>
        </AlertDialogHeader>
        <ProofForm environment={environment} classKeys={classKeys} oneStep={oneStep} idPrefix="rp" footer={<AlertDialogCancel>Close</AlertDialogCancel>} />
      </AlertDialogContent>
    </AlertDialog>
  );
}
