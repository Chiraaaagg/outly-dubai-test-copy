"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { syncTravelDeskCatalogueAction, type CatalogueSyncActionResult } from "../../../_actions/supplier-mappings";
import { INPUT_CLASS } from "../../../_components/ui";

/**
 * Catalogue sync for this deployment's TravelDesk environment: read only
 * towards TravelDesk, writes the catalogue tables and refreshes suggestions.
 * Needs a fresh authenticator code. It can take a few minutes; the button
 * stays disabled while it runs.
 */
/**
 * The action never throws for its own errors, but the request itself can fail
 * (the platform time limit, a dropped connection). Show that instead of the
 * error page: part of the catalogue may have been written.
 */
async function syncOrReport(prev: CatalogueSyncActionResult | null, fd: FormData): Promise<CatalogueSyncActionResult> {
  try {
    return await syncTravelDeskCatalogueAction(prev, fd);
  } catch {
    return {
      ok: false,
      code: "request_failed",
      message: "The sync did not report back. It may have finished in part: reload the page and check the tour and offer counts before syncing again.",
    };
  }
}

export function CatalogueSync({ environment }: { environment: "test" | "production" | null }) {
  const [result, submit, pending] = useActionState<CatalogueSyncActionResult | null, FormData>(syncOrReport, null);

  if (!environment) {
    return (
      <p className="text-sm text-ink-600">
        TravelDesk is not configured on this deployment. Set <code>SUPPLIER_ADAPTER_TRAVELDESK=live</code>, <code>TRAVELDESK_ENV</code> and <code>TRAVELDESK_API_KEY</code>, then
        redeploy.
      </p>
    );
  }

  const data = result?.ok ? result.data : null;
  return (
    <div>
      <p className="mb-3 text-sm text-ink-700">
        Pulls the <strong>{environment}</strong> TravelDesk catalogue into this database and refreshes the mapping suggestions. It only reads from TravelDesk: nothing is
        booked or charged. It can take a few minutes.
      </p>
      <form action={submit} className="flex flex-wrap items-end gap-3">
        <label htmlFor="catalogue-sync-code" className="block text-xs font-semibold text-ink-800">
          Authenticator code
          <input
            id="catalogue-sync-code"
            name="totpCode"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            placeholder="123456"
            aria-describedby="catalogue-sync-status"
            className={`${INPUT_CLASS} mt-1 min-h-10 w-32 font-mono text-sm font-normal tracking-widest`}
          />
        </label>
        <Button type="submit" disabled={pending}>
          {pending ? "Syncing…" : `Sync ${environment} catalogue`}
        </Button>
      </form>
      <div id="catalogue-sync-status" aria-live="polite" aria-busy={pending} className="mt-3">
        {pending && <p className="text-xs text-ink-600">Syncing. Keep this page open; this can take a few minutes.</p>}
        {result && !result.ok && <p className="text-xs font-semibold text-[var(--color-danger)]">{result.fields?.totpCode ?? result.message}</p>}
        {data && (
          <div className="text-xs text-ink-700">
            {data.sync.tours === 0 ? (
              <p className="font-semibold text-[var(--color-danger)]">No tours loaded. Check the TravelDesk key and the failed tours below, then sync again.</p>
            ) : data.sync.incomplete ? (
              <p className="font-semibold text-[var(--color-warning)]">
                Stopped at the time limit after {data.sync.tours} tours and {data.sync.offers} offers. Sync again to continue from where it stopped; suggestions refresh after a
                complete run.
              </p>
            ) : (
              <p className="font-semibold text-[var(--color-success)]">
                Synced {data.sync.tours} tours and {data.sync.offers} offers in {Math.round(data.durationMs / 1000)} s.
              </p>
            )}
            <ul className="mt-1 list-disc pl-4">
              <li>
                Added {data.sync.added}, changed {data.sync.changed}, removed {data.sync.removed}, revived {data.sync.revived}.
                {data.sync.failedTours.length > 0 && ` ${data.sync.failedTours.length} tour(s) failed to load and kept their items; sync again later.`}
                {!data.sync.removalsApplied && data.sync.removalsSkipped && ` Removals skipped (${data.sync.removalsSkipped.replace(/_/g, " ")}).`}
              </li>
              {data.sync.mappingsChanged > 0 && <li>{data.sync.mappingsChanged} approved mapping(s) changed terms and need review.</li>}
              <li>
                Price snapshots:{" "}
                {"skipped" in data.snapshots
                  ? data.snapshots.skipped === "no_offers"
                    ? "none needed."
                    : "skipped to stay within the time limit; sync again to fill them."
                  : `${data.snapshots.rows} rows for ${data.snapshots.offers} offers${data.snapshots.failed ? `, ${data.snapshots.failed} failed` : ""}${data.snapshots.incomplete ? " (stopped at the time limit)" : ""}.`}
              </li>
              <li>
                TravelDesk agency id: <code>{data.agencyId}</code>
                {data.pinnedAgencyId === null
                  ? ". Set TRAVELDESK_AGENCY_ID to this value in this deployment's Vercel environment and redeploy before resuming bookings."
                  : data.pinnedAgencyId === data.agencyId
                    ? " (matches TRAVELDESK_AGENCY_ID)."
                    : `. It does not match TRAVELDESK_AGENCY_ID (${data.pinnedAgencyId}): fix this before resuming bookings.`}
              </li>
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
