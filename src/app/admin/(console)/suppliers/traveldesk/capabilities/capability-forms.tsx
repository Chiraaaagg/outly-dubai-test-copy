"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import {
  recordClassProofAction,
  recordOfferEvidenceAction,
  revokeClassProofAction,
  revokeOfferEvidenceAction,
  setCapabilityFlagAction,
  type CapabilityActionResult,
} from "../../../../_actions/supplier-capabilities";
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
        {result.fields?.note ??
          result.fields?.totpCode ??
          result.fields?.reference ??
          result.fields?.offerExternalId ??
          result.fields?.scopeTourIds ??
          result.fields?.scopeProvider ??
          result.fields?.basisClassKey ??
          result.message}
      </p>
    );
  return null;
}

/** The capability forms' authenticator code field (reused by the bulk listing form, doc 30 N2). */
export function CodeField({ id, hint, required = true }: { id: string; hint: string; required?: boolean }) {
  return (
    <label htmlFor={id} className="block text-xs font-semibold text-ink-800">
      Authenticator code
      <input
        id={id}
        name="totpCode"
        required={required}
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
export function FlagForm({
  environment,
  classKey,
  enabled,
  canEnable,
  oneStep = false,
}: {
  environment: Environment;
  classKey: string;
  enabled: boolean;
  canEnable: boolean;
  /** Doc 30 N2: the one-person path applies to this administrator (full rights, owner alert configured). */
  oneStep?: boolean;
}) {
  const [result, action, pending] = useActionState<CapabilityActionResult | null, FormData>(setCapabilityFlagAction, null);
  const slug = classKey.replace(/[^a-z0-9]+/g, "-");
  const dual = environment !== "production" ? "" : oneStep ? " It applies at once and the owner is emailed." : " In production a second administrator must also switch it on.";
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
export function EvidenceForm({ environment, classKeys, oneStep = false }: { environment: Environment; classKeys: string[]; oneStep?: boolean }) {
  const [result, action, pending] = useActionState<CapabilityActionResult | null, FormData>(recordOfferEvidenceAction, null);
  const dual = environment !== "production" ? "" : oneStep ? " It applies at once and the owner is emailed." : " In production a second administrator must also record it.";
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

/**
 * Record a class proof with its scope (doc 30 §3.12, D14). Loosening: a code
 * (one administrator with full rights in production once the owner alert is
 * configured, otherwise a second administrator). A scope an active proof
 * already covers needs no code. Fixed once recorded: widen with a new proof.
 *
 * TODO(doc 30 decision 23): the confirm dialog with code field and result
 * list is chosen by the owner; this form uses existing controls only.
 */
export function ProofForm({ environment, classKeys, oneStep = false }: { environment: Environment; classKeys: string[]; oneStep?: boolean }) {
  const [result, action, pending] = useActionState<CapabilityActionResult | null, FormData>(recordClassProofAction, null);
  const dual = environment !== "production" ? "" : oneStep ? " It applies at once and the owner is emailed." : " In production a second administrator must also record it.";
  if (classKeys.length === 0) return <p className="text-sm text-ink-600">No class in this environment can take a proof yet.</p>;
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="environment" value={environment} />
      <label htmlFor="pf-class" className="block text-xs font-semibold text-ink-800">
        Class key proven
        <select id="pf-class" name="classKey" required className={`${INPUT_CLASS} mt-1 min-h-10 font-mono text-xs font-normal`}>
          {classKeys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor="pf-basis" className="block text-xs font-semibold text-ink-800">
        Key the booking was made on
        <select id="pf-basis" name="basisClassKey" className={`${INPUT_CLASS} mt-1 min-h-10 font-mono text-xs font-normal`} defaultValue="">
          <option value="">The same key</option>
          {classKeys.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-2xs font-normal text-ink-500">Another key only when it differs in time shape alone (decision 22).</span>
      </label>
      <fieldset className="sm:col-span-2">
        <legend className="text-xs font-semibold text-ink-800">Scope</legend>
        <div className="mt-1 flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" name="scopeKind" value="tours" defaultChecked required /> Named tours
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="scopeKind" value="all" /> Every offer of the key
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="scopeKind" value="provider" /> One external provider
          </label>
        </div>
        <span className="mt-1 block text-2xs text-ink-500">External keys: the booked provider only (D21). Tickets: the booked attraction first (D24).</span>
      </fieldset>
      <label htmlFor="pf-tours" className="block text-xs font-semibold text-ink-800">
        TravelDesk tour ids (named tours)
        <input id="pf-tours" name="scopeTourIds" inputMode="numeric" placeholder="3001, 3002" className={`${INPUT_CLASS} mt-1 min-h-10 font-mono text-sm font-normal`} />
      </label>
      <label htmlFor="pf-provider" className="block text-xs font-semibold text-ink-800">
        Provider (one external provider)
        <input id="pf-provider" name="scopeProvider" maxLength={120} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
        <span className="mt-1 block text-2xs font-normal text-ink-500">Only where TravelDesk&apos;s offer data names the provider.</span>
      </label>
      <label htmlFor="pf-kind" className="block text-xs font-semibold text-ink-800">
        Proof
        <select id="pf-kind" name="evidenceKind" required className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`}>
          <option value="production_booking">Supervised production booking</option>
          <option value="sandbox_drill">Sandbox drill</option>
        </select>
      </label>
      <label htmlFor="pf-ref" className="block text-xs font-semibold text-ink-800">
        Booking reference
        <input id="pf-ref" name="reference" required minLength={3} maxLength={200} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
        <span className="mt-1 block text-2xs font-normal text-ink-500">Never an email, phone number or price.</span>
      </label>
      <label htmlFor="pf-widens" className="block text-xs font-semibold text-ink-800">
        Widens proof (optional)
        <input id="pf-widens" name="widensProofId" className={`${INPUT_CLASS} mt-1 min-h-10 font-mono text-xs font-normal`} placeholder="proof id" />
      </label>
      <label htmlFor="pf-note" className="block text-xs font-semibold text-ink-800">
        Reason (audit log)
        <input id="pf-note" name="note" required minLength={8} maxLength={500} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
      </label>
      <CodeField id="pf-code" required={false} hint={`Recording or widening a proof needs a fresh code.${dual} A narrower scope than an active proof needs none.`} />
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" size="sm" variant="secondary" loading={pending} loadingLabel="Saving…">
          Record proof
        </Button>
        <Feedback result={result} saved="Proof recorded." />
      </div>
    </form>
  );
}

/** Withdraw one class proof (tightening: a reason only). The seeded exception does not come back. */
export function RevokeProofForm({ proofId }: { proofId: string }) {
  const [result, action, pending] = useActionState<CapabilityActionResult | null, FormData>(revokeClassProofAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="proofId" value={proofId} />
      <label htmlFor={`rp-${proofId}`} className="block text-2xs font-semibold text-ink-800">
        Reason
        <input id={`rp-${proofId}`} name="note" required minLength={8} maxLength={500} className={`${INPUT_CLASS} mt-1 min-h-9 w-48 text-xs font-normal`} />
      </label>
      <Button type="submit" size="sm" variant="secondary" loading={pending} loadingLabel="Saving…">
        Revoke
      </Button>
      <Feedback result={result} saved="Revoked." />
    </form>
  );
}
