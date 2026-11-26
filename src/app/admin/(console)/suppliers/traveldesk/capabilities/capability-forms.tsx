"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  recordClassProofAction,
  recordOfferEvidenceAction,
  revokeOfferEvidenceAction,
  setCapabilityFlagAction,
  type CapabilityActionResult,
} from "../../../../_actions/supplier-capabilities";
import { INPUT_CLASS } from "../../../../_components/ui";

type Environment = "test" | "production";

export function Feedback({ result, saved }: { result: CapabilityActionResult | null; saved: string }) {
  // Review N2-19: the status region is always mounted; only its text changes. Errors use role="alert".
  let message = "";
  let tone = "text-[var(--color-success)]";
  if (result?.ok && result.data.status === "pending") {
    message = "Pending second approver. Nothing has changed yet: another administrator must make the same change with their own code within 30 minutes.";
    tone = "text-[var(--color-warning)]";
  } else if (result?.ok && result.data.status === "unchanged") {
    message = "Already in that state; nothing changed.";
    tone = "text-ink-600";
  } else if (result?.ok) {
    message = saved;
  }
  return (
    <>
      <p className={`text-2xs font-semibold ${tone}`} role="status" aria-live="polite" aria-atomic="true">
        {message}
      </p>
      {result && !result.ok && (
        <p className="text-xs font-semibold text-[var(--color-danger)]" role="alert">
          {result.fields?.note ??
            result.fields?.totpCode ??
            result.fields?.reference ??
            result.fields?.offerExternalId ??
            result.fields?.scopeTourIds ??
            result.fields?.scopeProvider ??
            result.fields?.basisClassKey ??
            result.fields?.bookedTourId ??
            result.fields?.confirmDemotions ??
            result.message}
        </p>
      )}
    </>
  );
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
export function RevokeEvidenceForm({ evidenceId, label }: { evidenceId: string; label: string }) {
  const [result, action, pending] = useActionState<CapabilityActionResult | null, FormData>(revokeOfferEvidenceAction, null);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="evidenceId" value={evidenceId} />
      <label htmlFor={`rv-${evidenceId}`} className="block text-2xs font-semibold text-ink-800">
        Reason
        <input id={`rv-${evidenceId}`} name="note" required minLength={8} maxLength={500} className={`${INPUT_CLASS} mt-1 min-h-9 w-48 text-xs font-normal`} />
      </label>
      <Button type="submit" size="sm" variant="secondary" loading={pending} loadingLabel="Saving…" aria-label={label}>
        Revoke
      </Button>
      <Feedback result={result} saved="Revoked." />
    </form>
  );
}

/** What a widening starts from: the proof it widens. */
export interface ProofPreset {
  widensProofId: string;
  classKey: string;
  basisClassKey: string;
  scopeKind: string;
  scopeTourIds: string[];
  bookedTourId: string | null;
  evidenceKind: string;
  reference: string;
}

/**
 * Record or widen a class proof with its scope (doc 30 §3.12, D14). Always a
 * loosening: a fresh code (one administrator with full rights in production
 * once the owner alert is configured, otherwise a second administrator), and
 * the count of listings it would send to inquiry when there are any. Fixed
 * once recorded: widen with a new proof, narrow or revoke from the proof's
 * own dialog. Shown inside the confirm dialog (proof-dialogs.tsx).
 */
export function ProofForm({
  environment,
  classKeys,
  oneStep = false,
  preset,
  idPrefix = "pf",
  footer,
}: {
  environment: Environment;
  classKeys: string[];
  oneStep?: boolean;
  preset?: ProofPreset;
  idPrefix?: string;
  /** The dialog's cancel control, placed beside the submit button. */
  footer?: ReactNode;
}) {
  const [result, action, pending] = useActionState<CapabilityActionResult | null, FormData>(recordClassProofAction, null);
  const dual = environment !== "production" ? "" : oneStep ? " It applies at once and the owner is emailed." : " In production a second administrator must also record it.";
  if (classKeys.length === 0 && !preset) return <p className="text-sm text-ink-600">No class in this environment can take a proof yet.</p>;
  const id = (k: string) => `${idPrefix}-${k}`;
  const needsCount = Boolean(result && !result.ok && result.fields?.confirmDemotions);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="environment" value={environment} />
      {preset ? (
        <>
          <input type="hidden" name="classKey" value={preset.classKey} />
          <input type="hidden" name="widensProofId" value={preset.widensProofId} />
          <p className="text-xs text-ink-700 sm:col-span-2">
            Widens the proof for <span className="break-all font-mono">{preset.classKey}</span>. The new row stands alone; the old one stays until you revoke it.
          </p>
        </>
      ) : (
        <label htmlFor={id("class")} className="block text-xs font-semibold text-ink-800">
          Class key proven
          <select id={id("class")} name="classKey" required className={`${INPUT_CLASS} mt-1 min-h-10 font-mono text-xs font-normal`}>
            {classKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      )}
      <label htmlFor={id("basis")} className="block text-xs font-semibold text-ink-800">
        Key the booking was made on
        <select id={id("basis")} name="basisClassKey" className={`${INPUT_CLASS} mt-1 min-h-10 font-mono text-xs font-normal`} defaultValue={preset && preset.basisClassKey !== preset.classKey ? preset.basisClassKey : ""}>
          <option value="">The same key</option>
          {[...new Set([...classKeys, ...(preset ? [preset.basisClassKey] : [])])].map((k) => (
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
            <input type="radio" name="scopeKind" value="tours" defaultChecked={!preset || preset.scopeKind === "tours"} required /> Named tours
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="scopeKind" value="all" defaultChecked={preset?.scopeKind === "all"} /> Every offer of the key
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="scopeKind" value="provider" /> One external provider
          </label>
        </div>
        <span className="mt-1 block text-2xs text-ink-500">External keys: the booked tour only, one more per widening (D21). Tickets: the booked attraction first (D24).</span>
      </fieldset>
      <label htmlFor={id("booked")} className="block text-xs font-semibold text-ink-800">
        Booked tour (TravelDesk tour id)
        <input
          id={id("booked")}
          name="bookedTourId"
          required
          inputMode="numeric"
          pattern="[1-9][0-9]{0,9}"
          defaultValue={preset?.bookedTourId ?? ""}
          className={`${INPUT_CLASS} mt-1 min-h-10 font-mono text-sm font-normal`}
        />
        <span className="mt-1 block text-2xs font-normal text-ink-500">The tour the supervised booking was made on. Named tours must include it.</span>
      </label>
      <label htmlFor={id("tours")} className="block text-xs font-semibold text-ink-800">
        TravelDesk tour ids (named tours)
        <input
          id={id("tours")}
          name="scopeTourIds"
          inputMode="numeric"
          placeholder="3001, 3002"
          defaultValue={preset?.scopeTourIds.join(", ") ?? ""}
          className={`${INPUT_CLASS} mt-1 min-h-10 font-mono text-sm font-normal`}
        />
      </label>
      <label htmlFor={id("provider")} className="block text-xs font-semibold text-ink-800">
        Provider (one external provider)
        <input id={id("provider")} name="scopeProvider" maxLength={120} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
        <span className="mt-1 block text-2xs font-normal text-ink-500">Only where TravelDesk&apos;s offer data names the provider.</span>
      </label>
      <label htmlFor={id("kind")} className="block text-xs font-semibold text-ink-800">
        Proof
        <select id={id("kind")} name="evidenceKind" required defaultValue={preset?.evidenceKind ?? "production_booking"} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`}>
          <option value="production_booking">Supervised production booking</option>
          <option value="sandbox_drill">Sandbox drill</option>
        </select>
      </label>
      <label htmlFor={id("ref")} className="block text-xs font-semibold text-ink-800">
        Booking reference
        <input id={id("ref")} name="reference" required minLength={3} maxLength={200} defaultValue={preset?.reference ?? ""} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
        <span className="mt-1 block text-2xs font-normal text-ink-500">Never an email, phone number or price.</span>
      </label>
      <label htmlFor={id("note")} className="block text-xs font-semibold text-ink-800">
        Reason (audit log)
        <input id={id("note")} name="note" required minLength={8} maxLength={500} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
      </label>
      {needsCount && (
        <label htmlFor={id("confirm")} className="block text-xs font-semibold text-[var(--color-danger)] sm:col-span-2">
          Listings sent to inquiry: type the number to confirm
          <input id={id("confirm")} name="confirmDemotions" required inputMode="numeric" pattern="[0-9]{1,6}" className={`${INPUT_CLASS} mt-1 min-h-10 w-32 font-mono text-sm font-normal`} />
        </label>
      )}
      <CodeField id={id("code")} hint={`Recording or widening a proof needs a fresh code.${dual}`} />
      <div className="grid gap-2 sm:col-span-2">
        <Feedback result={result} saved="Proof recorded." />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {footer}
          <Button type="submit" size="sm" variant="secondary" loading={pending} loadingLabel="Saving…">
            {preset ? "Record wider proof" : "Record proof"}
          </Button>
        </div>
      </div>
    </form>
  );
}
