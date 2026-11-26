"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { setBookingLimitsAction, setBookingPauseAction, type BookingControlResult } from "../../../_actions/supplier-mappings";
import { INPUT_CLASS } from "../../../_components/ui";

type Environment = "test" | "production";
type Scope = "new_sales" | "all_writes";

/** True when the action recorded the request but a second person must still approve it (SEC-10). */
function awaitingApproval(result: BookingControlResult | null): boolean {
  if (!result?.ok) return false;
  const data = result.data as { status?: string };
  return data.status === "pending";
}

function Feedback({ result, saved }: { result: BookingControlResult | null; saved: string }) {
  if (awaitingApproval(result))
    return (
      <p className="text-2xs font-semibold text-[var(--color-warning)]" role="status">
        Pending second approver. Nothing has changed yet: another administrator must make the same change with their own code within 30 minutes.
      </p>
    );
  if (result?.ok) return <p className="text-2xs font-semibold text-[var(--color-success)]">{saved}</p>;
  if (result && !result.ok)
    return (
      <p className="text-xs font-semibold text-[var(--color-danger)]" role="alert">
        {result.fields?.note ?? result.fields?.totpCode ?? result.message}
      </p>
    );
  return null;
}

function CodeField({ id, required, hint }: { id: string; required: boolean; hint: string }) {
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
 * Kill switch and limits for TravelDesk bookings in one environment, as
 * separate forms so a limits change can never undo a pause. Every change
 * needs a reason, which goes to the audit log; every form posts the
 * environment it acts on (CR-11).
 *
 *  - Pause (`new_sales`) stops new sales only: no new reservations or one-step
 *    bookings. Confirms of reservations already held still go out, so a pause
 *    never strands a customer's hold.
 *  - Emergency stop (`all_writes`) also holds confirms; held reservations then
 *    lapse at TravelDesk.
 *  - Cancels, recovery and status polling always keep running.
 *  - Pausing stays easy (no code). Resuming and raising a limit need a fresh
 *    authenticator code and, in production, a second administrator (SEC-10).
 */
export function BookingControls({
  environment,
  paused,
  scope,
  maxBookingAed,
  minFundsAfterAed,
}: {
  environment: Environment;
  paused: boolean;
  scope: Scope;
  maxBookingAed: number;
  minFundsAfterAed: number;
}) {
  const [pauseResult, pauseAction, pausing] = useActionState<BookingControlResult | null, FormData>(setBookingPauseAction, null);
  const [stopResult, stopAction, stopping] = useActionState<BookingControlResult | null, FormData>(setBookingPauseAction, null);
  const [limitsResult, limitsAction, saving] = useActionState<BookingControlResult | null, FormData>(setBookingLimitsAction, null);
  const dual = environment === "production" ? " In production a second administrator must also approve it." : "";

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-4">
        <form action={pauseAction} className="space-y-2">
          <input type="hidden" name="environment" value={environment} />
          <input type="hidden" name="target" value={paused ? "resume" : "pause"} />
          <p className="text-xs font-semibold text-ink-800">
            {paused ? `Resume ${environment} bookings` : `Pause ${environment} bookings`}
          </p>
          {paused ? (
            <p className="text-2xs text-ink-600">
              Currently {scope === "all_writes" ? "on emergency stop: new sales and confirms are held." : "paused for new sales: confirms of held reservations still go out."}
            </p>
          ) : (
            <fieldset className="space-y-1.5">
              <legend className="text-xs font-semibold text-ink-800">What to stop</legend>
              <label className="flex items-start gap-2 text-xs text-ink-800">
                <input type="radio" name="scope" value="new_sales" defaultChecked className="mt-0.5" />
                <span>
                  <strong>Pause new sales.</strong> No new reservations or bookings are sent. Confirms of reservations already held still go out, so no customer&apos;s
                  hold is stranded.
                </span>
              </label>
              <label className="flex items-start gap-2 text-xs text-ink-800">
                <input type="radio" name="scope" value="all_writes" className="mt-0.5" />
                <span>
                  <strong>Emergency stop.</strong> Also halts confirms. Held reservations will lapse at TravelDesk and need follow-up.
                </span>
              </label>
              <p className="text-2xs text-ink-500">Cancels, recovery and status checks always keep running.</p>
            </fieldset>
          )}
          {!paused && (
            <label className="block text-xs font-semibold text-ink-800">
              Message shown on this page while paused
              <input name="reason" maxLength={300} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
            </label>
          )}
          <label className="block text-xs font-semibold text-ink-800">
            Reason (audit log)
            <input name="note" required minLength={8} maxLength={500} placeholder="Supplier outage / incident / …" className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
          </label>
          {paused && <CodeField id={`resume-code-${environment}`} required hint={`Resuming needs a fresh code.${dual}`} />}
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" variant={paused ? "primary" : "secondary"} loading={pausing} loadingLabel="Saving…">
              {paused ? "Resume bookings" : "Pause"}
            </Button>
            <Feedback
              result={pauseResult}
              saved={pauseResult?.ok ? (pauseResult.data.paused ? `${environment} bookings paused.` : `${environment} bookings running.`) : ""}
            />
          </div>
        </form>

        {paused && scope === "new_sales" && (
          <form action={stopAction} className="space-y-2 border-t border-ink-100 pt-3">
            <input type="hidden" name="environment" value={environment} />
            <input type="hidden" name="target" value="pause" />
            <input type="hidden" name="scope" value="all_writes" />
            <p className="text-xs font-semibold text-ink-800">Escalate to emergency stop</p>
            <p className="text-2xs text-ink-600">Also halts confirms. Held reservations will lapse at TravelDesk.</p>
            <label className="block text-xs font-semibold text-ink-800">
              Reason (audit log)
              <input name="note" required minLength={8} maxLength={500} placeholder="Confirms failing / incident / …" className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
            </label>
            <div className="flex items-center gap-3">
              <Button type="submit" size="sm" variant="secondary" loading={stopping} loadingLabel="Saving…">
                Emergency stop
              </Button>
              <Feedback result={stopResult} saved="Emergency stop on." />
            </div>
          </form>
        )}
      </div>

      <form action={limitsAction} className="space-y-2">
        <input type="hidden" name="environment" value={environment} />
        <p className="text-xs font-semibold text-ink-800">Limits ({environment})</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-xs font-semibold text-ink-800">
            Per-booking cap, AED net
            <input name="maxBookingAed" type="number" min={1} max={100000} step={1} required defaultValue={maxBookingAed} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
          </label>
          <label className="block text-xs font-semibold text-ink-800">
            Keep at least this much after a booking, AED
            <input name="minFundsAfterAed" type="number" min={0} step={1} required defaultValue={minFundsAfterAed} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
          </label>
        </div>
        <label className="block text-xs font-semibold text-ink-800">
          Reason (audit log)
          <input name="note" required minLength={8} maxLength={500} placeholder="Limit review / …" className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
        </label>
        <CodeField id={`limits-code-${environment}`} required={false} hint={`Needed to raise the cap or lower the floor; tightening needs none.${dual}`} />
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" variant="secondary" loading={saving} loadingLabel="Saving…">
            Save limits
          </Button>
          <Feedback result={limitsResult} saved="Limits saved." />
        </div>
      </form>
    </div>
  );
}
