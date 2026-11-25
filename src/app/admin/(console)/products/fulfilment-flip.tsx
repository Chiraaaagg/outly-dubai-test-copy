"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { setFulfilmentModeAction, type SetFulfilmentModeResult } from "../../_actions/products";
import { INPUT_CLASS } from "../../_components/ui";

/**
 * Inline flip form for one SKU. Reason is mandatory (the service refuses
 * without one). Errors from the service (e.g. "needs an API supplier
 * mapping") render inline under the row.
 *
 * Activating instant also asks for a fresh authenticator code
 * (`products.activate_instant`, PRD-12). In production the first
 * administrator's request stays pending until a second administrator switches
 * the same product with their own code; the form says so instead of claiming
 * the switch happened. Switching back to inquiry needs no code.
 */
export function FulfilmentFlip({
  id,
  kind,
  name,
  current,
  canActivate,
  canPublish,
}: {
  id: string;
  kind: "product" | "combo";
  name: string;
  current: "inquiry" | "instant";
  /** Holds `products.activate_instant`. */
  canActivate: boolean;
  /** Holds `products.publish` (switching back to inquiry). */
  canPublish: boolean;
}) {
  const [state, action, pending] = useActionState<SetFulfilmentModeResult | null, FormData>(setFulfilmentModeAction, null);
  const [open, setOpen] = useState(false);
  const target = current === "instant" ? "inquiry" : "instant";
  const allowed = target === "instant" ? canActivate : canPublish;
  const reasonError = state && !state.ok ? state.fields?.reason : undefined;
  const codeError = state && !state.ok ? state.fields?.totpCode : undefined;
  const awaitingSecond = state?.ok && state.data.status === "pending";

  if (!allowed) {
    return <span className="text-2xs text-ink-400">needs {target === "instant" ? "products.activate_instant" : "products.publish"}</span>;
  }

  if (!open) {
    return (
      <div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          Switch to {target}
        </Button>
        {state?.ok && state.data.status === "applied" && <p className="mt-1 text-2xs font-semibold text-[var(--color-success)]">Now {state.data.mode}.</p>}
        {awaitingSecond && (
          <p className="mt-1 text-2xs font-semibold text-[var(--color-warning)]" role="status">
            Pending second approver. Still {state.data.mode} until another administrator switches it with their own code within 30 minutes.
          </p>
        )}
      </div>
    );
  }

  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="mode" value={target} />
      <label htmlFor={`reason-${id}`} className="block text-xs font-semibold text-ink-800">
        Reason for switching {name} to {target}
      </label>
      <input
        id={`reason-${id}`}
        name="reason"
        required
        minLength={8}
        maxLength={500}
        placeholder={target === "instant" ? "Rathin mapping verified on staging, go-live approved by…" : "Supplier API failing since…"}
        aria-invalid={reasonError ? true : undefined}
        className={`${INPUT_CLASS} min-h-10 text-sm`}
        autoFocus
      />
      {target === "instant" && (
        <>
          <label htmlFor={`totp-${id}`} className="block text-xs font-semibold text-ink-800">
            Authenticator code
          </label>
          <input
            id={`totp-${id}`}
            name="totpCode"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            placeholder="123456"
            aria-invalid={codeError ? true : undefined}
            aria-describedby={`totp-help-${id}`}
            className={`${INPUT_CLASS} min-h-10 w-32 font-mono text-sm tracking-widest`}
          />
          <p id={`totp-help-${id}`} className="text-2xs text-ink-500">
            Outside a development deployment a second administrator must also switch this product, with their own code, before customers can book it instantly.
          </p>
        </>
      )}
      {state && !state.ok && (
        <p className="text-xs font-semibold text-[var(--color-danger)]" role="alert">
          {reasonError ?? codeError ?? state.message}
        </p>
      )}
      {awaitingSecond && (
        <p className="text-xs font-semibold text-[var(--color-warning)]" role="status">
          Pending second approver. Nothing has changed yet.
        </p>
      )}
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" variant={target === "instant" ? "primary" : "secondary"} loading={pending} loadingLabel="Switching…">
          Confirm {target}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
