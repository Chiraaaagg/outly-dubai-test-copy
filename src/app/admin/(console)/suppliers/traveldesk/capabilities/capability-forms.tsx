"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { recordOfferEvidenceAction, revokeOfferEvidenceAction, setCapabilityFlagAction, type CapabilityActionResult } from "../../../../_actions/supplier-capabilities";
import { INPUT_CLASS } from "../../../../_components/ui";

type Environment = "test" | "production";

function Feedback({ result, saved }: { result: CapabilityActionResult | null; saved: string }) {
  if (result?.ok && result.data.status === "pending")
    return (
      <p className="text-2xs font-semibold text-[var(--color-warning)]" role="status">
        Pending second approver. Nothing has changed yet: another administrator must make the same change with their own code within 30 minutes.
      </p>
    );
  if (result?.ok && result.data.status === "unchanged")
    return (
      <p className="text-2xs font-semibold text-ink-600" role="status">
        Already in that state; nothing changed.
      </p>
    );
  if (result?.ok)
    return (
      <p className="text-2xs font-semibold text-[var(--color-success)]" role="status">
        {saved}
      </p>
    );
  if (result && !result.ok)
    return (
      <p className="text-xs font-semibold text-[var(--color-danger)]" role="alert">
        {result.fields?.note ?? result.fields?.totpCode ?? result.fields?.reference ?? result.fields?.offerExternalId ?? result.message}
      </p>
    );
  return null;
}

function CodeField({ id, hint }: { id: string; hint: string }) {
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
      <span className="mt-1 block text-2xs font-normal text-ink-500">{hint}</span>
    </label>
  );
}

/**
 * Switch one class key on or off. Off stays easy: a reason only. On needs a
 * fresh code and, in production, a second administrator making the same
 * change (doc 29 §3.3). The form posts the target state, not the state it
 * loaded, so a stale page cannot flip a flag back.
 */
export function FlagForm({ environment, classKey, enabled, canEnable }: { environment: Environment; classKey: string; enabled: boolean; canEnable: boolean }) {
  const [result, action, pending] = useActionState<CapabilityActionResult | null, FormData>(setCapabilityFlagAction, null);
  const slug = classKey.replace(/[^a-z0-9]+/g, "-");
  const dual = environment === "production" ? " In production a second administrator must also switch it on." : "";
  if (!enabled && !canEnable) return null;
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="environment" value={environment} />
      <input type="hidden" name="classKey" value={classKey} />
      <input type="hidden" name="target" value={enabled ? "off" : "on"} />
      <label htmlFor={`note-${slug}`} className="block text-xs font-semibold text-ink-800">
        Reason (audit log)
        <input
          id={`note-${slug}`}
          name="note"
          required
          minLength={8}
          maxLength={500}
          placeholder={enabled ? "Incident / unproven shape / …" : "Proof reference / owner approval / …"}
          className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`}
        />
      </label>
      {!enabled && <CodeField id={`code-${slug}`} hint={`Switching on needs a fresh code.${dual}`} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" variant={enabled ? "secondary" : "primary"} loading={pending} loadingLabel="Saving…">
          {enabled ? "Switch off" : "Switch on"}
        </Button>
        <Feedback result={result} saved={enabled ? "Switched off: these offers sell as inquiry." : "Switched on."} />
      </div>
    </form>
  );
}

/** Record per-offer evidence for one class key (loosening: a code, and a second person in production). */
export function EvidenceForm({ environment, classKeys }: { environment: Environment; classKeys: string[] }) {
  const [result, action, pending] = useActionState<CapabilityActionResult | null, FormData>(recordOfferEvidenceAction, null);
  const dual = environment === "production" ? " In production a second administrator must also record it." : "";
  if (classKeys.length === 0) return <p className="text-sm text-ink-600">No class in this environment can take evidence yet.</p>;
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="environment" value={environment} />
      <label htmlFor="ev-class" className="block text-xs font-semibold text-ink-800">
        Class key
        <select id="ev-class" name="classKey" required className={`${INPUT_CLASS} mt-1 min-h-10 font-mono text-xs font-normal`}>
          {classKeys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor="ev-offer" className="block text-xs font-semibold text-ink-800">
        TravelDesk offer id
        <input id="ev-offer" name="offerExternalId" required inputMode="numeric" pattern="[1-9][0-9]{0,9}" className={`${INPUT_CLASS} mt-1 min-h-10 font-mono text-sm font-normal`} />
      </label>
      <label htmlFor="ev-kind" className="block text-xs font-semibold text-ink-800">
        Evidence
        <select id="ev-kind" name="evidenceKind" required className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`}>
          <option value="contract_test">Contract test</option>
          <option value="sandbox_drill">Sandbox drill</option>
          <option value="production_booking">Supervised production booking</option>
          <option value="neighbour_proof">Proof by neighbour (time shape only)</option>
        </select>
      </label>
      <label htmlFor="ev-ref" className="block text-xs font-semibold text-ink-800">
        Reference
        <input
          id="ev-ref"
          name="reference"
          required
          minLength={3}
          maxLength={200}
          placeholder="Test name, drill or booking reference"
          className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`}
        />
        <span className="mt-1 block text-2xs font-normal text-ink-500">Never an email, phone number or price.</span>
      </label>
      <label htmlFor="ev-note" className="block text-xs font-semibold text-ink-800 sm:col-span-2">
        Reason (audit log)
        <input id="ev-note" name="note" required minLength={8} maxLength={500} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
      </label>
      <CodeField id="ev-code" hint={`Recording evidence needs a fresh code.${dual}`} />
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" size="sm" variant="secondary" loading={pending} loadingLabel="Saving…">
          Record evidence
        </Button>
        <Feedback result={result} saved="Evidence recorded." />
      </div>
    </form>
  );
}

/** Withdraw one evidence row (tightening: a reason only). */
export function RevokeEvidenceForm({ evidenceId }: { evidenceId: string }) {
  const [result, action, pending] = useActionState<CapabilityActionResult | null, FormData>(revokeOfferEvidenceAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="evidenceId" value={evidenceId} />
      <label htmlFor={`rv-${evidenceId}`} className="block text-2xs font-semibold text-ink-800">
        Reason
        <input id={`rv-${evidenceId}`} name="note" required minLength={8} maxLength={500} className={`${INPUT_CLASS} mt-1 min-h-9 w-48 text-xs font-normal`} />
      </label>
      <Button type="submit" size="sm" variant="secondary" loading={pending} loadingLabel="Saving…">
        Revoke
      </Button>
      <Feedback result={result} saved="Revoked." />
    </form>
  );
}
