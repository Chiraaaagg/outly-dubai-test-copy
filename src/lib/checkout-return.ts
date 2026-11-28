/**
 * The payment gateway's return hint (checkout redesign batch 3, CO-08).
 *
 * Stripe sends the customer back to `success_url` after a completed payment
 * page and to `cancel_url` when they leave it with its back link. Both point
 * at the same neutral page, `/booking/confirmation`, and differ only in one
 * query parameter: `?result=success` or `?result=cancel`. Nothing else rides
 * on them: no reference, no session id, nothing personal.
 *
 * The hint is NOT evidence and never authorises anything. Anyone can type it.
 * The return page and the status page still show what the server's status
 * projection says; the hint only picks words (for example "You left Stripe's
 * payment page" instead of "If you've just paid…") inside the state the
 * server reports, and is ignored everywhere else.
 */

export const RETURN_RESULT_PARAM = "result";

export type ReturnHint = "success" | "cancel";

const HINTS: readonly ReturnHint[] = ["success", "cancel"];

/** The two gateway return URLs built from one base URL (which keeps any query it already has). */
export function gatewayReturnUrls(base: string | URL): { success: string; cancel: string } {
  const make = (hint: ReturnHint) => {
    const u = new URL(base.toString());
    u.searchParams.set(RETURN_RESULT_PARAM, hint);
    return u.toString();
  };
  return { success: make("success"), cancel: make("cancel") };
}

/** A recognised hint, or null. Arrays (repeated parameters) and anything else read as no hint. */
export function readReturnHint(raw: string | string[] | null | undefined): ReturnHint | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (HINTS as readonly string[]).includes(v) ? (v as ReturnHint) : null;
}

/** `path` with the hint appended (for the redirect to `/booking/<ref>`); unchanged without one. */
export function withReturnHint(path: string, hint: ReturnHint | null): string {
  if (!hint) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${RETURN_RESULT_PARAM}=${hint}`;
}
