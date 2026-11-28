/**
 * The missing signup claim alert (Group B, re-review 103c D1). Pure: shared by
 * the Before User Created hook and the email start route
 * (customer-identity.service.ts) and the staff alert that reads the same
 * counter (account-alerts.ts), without either importing the other.
 *
 * Our start route sends a signup claim in Supabase `/otp` `data`; Supabase is
 * expected to hand it to our Before User Created hook as `user_metadata`. If
 * it does not, every first-time email sign-in is refused. The hook cannot tell
 * that from a direct `/signup` (neither carries the claim), so it only leaves
 * a marker on each recent intent of that address (`claimMissingMarkerKey`).
 * Our own start route, whose `/otp` then fails, reads the marker of its own
 * intent: if it is there, Supabase dropped our claim. It emits the error-level
 * event `customer.identity_signup_claim_missing` and counts the day in
 * SIGNUP_CLAIM_MISSING_BUCKET; the ops sweep raises `signup_claim_missing`
 * for staff once per UTC day. The safety valve is
 * CUSTOMER_SIGNUP_CLAIM_RELAXED (env.ts).
 */

/** Limiter bucket counting today's (UTC) first-time email sign-ins refused for a missing claim. */
export const SIGNUP_CLAIM_MISSING_BUCKET = "auth_signup_claim_missing:day";
export const SIGNUP_CLAIM_MISSING_WINDOW_SECONDS = 86_400;
/** No real ceiling: the bucket only counts. */
export const SIGNUP_CLAIM_MISSING_COUNT_LIMIT = 1_000_000;

/** The hook's marker on one intent: a creation for its address arrived without any signup claim. */
export function claimMissingMarkerKey(intentId: string): string {
  return `auth_hook:claim_missing:${intentId}`;
}

/** The marker is one span per intent, anchored on the epoch (a key that is already unique to the intent). */
export const CLAIM_MISSING_MARKER_START = new Date(0);
/** Kept well past the intent's two minutes. */
export const CLAIM_MISSING_MARKER_TTL_MS = 3_600_000;

/** Start of the limiter's day window that holds `now` (UTC midnight). */
export function signupClaimWindowStart(now: Date): Date {
  const ms = SIGNUP_CLAIM_MISSING_WINDOW_SECONDS * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}
