"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { refreshFxAction, type FxRefreshActionResult } from "../../_actions/fx";
import { FormField, INPUT_CLASS, KeyValueList, Panel } from "../../_components/ui";

export interface FxView {
  inrPerAed: string;
  version: number;
  source: string;
  recordedAt: string;
  expiresAt: string;
  usable: boolean;
}

const REASON_TEXT: Record<string, string> = {
  source_stale: "the ECB date is more than 4 days old",
  source_date_in_future: "the ECB date is in the future",
  out_of_band: "the rate is outside the plausible band",
  jump_too_large: "the rate moved more than 5% from the stored one",
};

const FAILURE_TEXT: Record<string, string> = {
  timeout: "The rate source did not answer within 10 seconds.",
  network: "The rate source could not be reached.",
  redirected: "The rate source redirected; nothing was read.",
  http_status: "The rate source answered with an error.",
  too_large: "The rate source answered with an unexpected body.",
  bad_json: "The rate source answered with something that is not JSON.",
  bad_payload: "The rate source answered in an unexpected shape.",
  band_config_invalid: "The plausible-band configuration is invalid (FX_BAND_MIN/MAX_INR_PER_AED).",
  accepted_rate_mismatch: "The rate changed again since you looked. Refresh and review it again.",
  write_conflict: "Another refresh ran at the same time. Try again.",
};

/**
 * The live INR-per-AED rate (read-only) and, with `pricing.edit`, a manual
 * refresh. A refused jump can be accepted with an authenticator code.
 */
export function FxPanel({ current, canRefresh }: { current: FxView | null; canRefresh: boolean }) {
  const [state, action, pending] = useActionState<FxRefreshActionResult | null, FormData>(refreshFxAction, null);
  const outcome = state?.ok ? state.data : null;
  const fields = state && !state.ok ? state.fields ?? {} : {};
  const jumpOnly = outcome?.status === "refused" && outcome.reasons.length === 1 && outcome.reasons[0] === "jump_too_large";

  return (
    <Panel
      title="Exchange rate (INR per AED)"
      sub="Refreshed twice a day from the ECB reference rate, with the 2% buffer. INR instant quotes fall back to inquiry when it expires."
    >
      {current ? (
        <KeyValueList
          items={[
            { label: "Rate", value: `${current.inrPerAed} (v${current.version})` },
            { label: "Status", value: current.usable ? "Valid" : "Expired: INR instant quotes are refused" },
            { label: "Source", value: current.source },
            { label: "Recorded", value: current.recordedAt },
            { label: "Expires", value: current.expiresAt },
          ]}
        />
      ) : (
        <Alert tone="warning" title="No usable rate stored">
          INR instant quotes are refused until a rate is recorded.
        </Alert>
      )}

      {canRefresh && (
        <div className="mt-4 space-y-3">
          {state && !state.ok && (
            <Alert tone="danger" title={state.message}>
              {state.recovery}
            </Alert>
          )}
          {outcome?.status === "written" && (
            <Alert tone="success" title={`Saved ${outcome.inrPerAed} (v${outcome.version})`}>
              {outcome.changed ? `Was ${outcome.previous ?? "unset"}.` : "Unchanged; expiry extended."}
            </Alert>
          )}
          {outcome?.status === "failed" && (
            <Alert tone="danger" title="Not refreshed">
              {FAILURE_TEXT[outcome.reason] ?? outcome.reason} The stored rate is unchanged.
            </Alert>
          )}
          {outcome?.status === "refused" && (
            <Alert tone="warning" title={`Refused ${outcome.computed} (ECB ${outcome.sourceDate})`}>
              Kept {outcome.previous ?? "nothing"}: {outcome.reasons.map((r) => REASON_TEXT[r] ?? r).join("; ")}
              {outcome.moveBps !== null ? ` (moved ${(outcome.moveBps / 100).toFixed(2)}%)` : ""}.
            </Alert>
          )}

          {jumpOnly && outcome?.status === "refused" ? (
            <form action={action} className="space-y-3">
              <input type="hidden" name="acceptJumpTo" value={outcome.computed} />
              <FormField label="Authenticator code" htmlFor="fx-totp" hint={`Accepts ${outcome.computed} if a fresh fetch gives the same rate`} error={fields.totpCode}>
                <input id="fx-totp" name="totpCode" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} className={`${INPUT_CLASS} max-w-40`} />
              </FormField>
              <div className="flex justify-end">
                <Button type="submit" variant="secondary" loading={pending} loadingLabel="Accepting…">
                  Accept new rate
                </Button>
              </div>
            </form>
          ) : (
            <form action={action} className="flex justify-end">
              <Button type="submit" variant="secondary" loading={pending} loadingLabel="Refreshing…">
                Refresh now
              </Button>
            </form>
          )}
        </div>
      )}
    </Panel>
  );
}
