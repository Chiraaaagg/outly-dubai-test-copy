import "server-only";
import { env } from "../lib/env";
import { normaliseEmail, type CustomerAuthOptions } from "@/lib/customer-auth-options";

/**
 * Owner-only pilot of the Supabase sign-in (owner decision: the production
 * proof is done by the owner alone). CUSTOMER_AUTH_PILOT_EMAILS, a comma
 * list, empty by default.
 *
 * While the list is non-empty:
 *  - the email code start route sends a code only to an address in the list;
 *    any other address gets the same answer as a sent code and nothing is
 *    sent (customer-identity.service.ts `startEmailCode`);
 *  - Google sign-in starts only with `?pilot=1`, and the callback refuses a
 *    Google email outside the list before any account is created or linked;
 *  - /login shows the email and Google options only with `?pilot=1`.
 *
 * Addresses are compared trimmed and lower-cased (`normaliseEmail`). An entry
 * that is not an address matches nothing: the pilot still applies (fails
 * closed). Never logged: the list or the address.
 */

/** The query parameter that shows the pilot options on /login and lets Google start. */
export const PILOT_PARAM = "pilot";

/** True when the pilot list is set (even with entries that are not addresses). */
export function pilotActive(): boolean {
  return env().CUSTOMER_AUTH_PILOT_EMAILS.length > 0;
}

/** The pilot list, normalised. */
export function pilotEmails(): string[] {
  return env()
    .CUSTOMER_AUTH_PILOT_EMAILS.map((e) => normaliseEmail(e))
    .filter((e): e is string => e !== null);
}

/** True when no pilot is set, or when `email` is in the list. */
export function pilotAllowsEmail(email: unknown): boolean {
  if (!pilotActive()) return true;
  const n = normaliseEmail(email);
  return n !== null && pilotEmails().includes(n);
}

/** True for exactly `?pilot=1`. */
export function pilotRequested(value: string | null | undefined): boolean {
  return value === "1";
}

/**
 * The options /login shows for this request: the deployment's own, less the
 * email code and Google while the pilot is set and the page was opened
 * without `?pilot=1`. `pilot` is true when the page carries `?pilot=1` on to
 * the Google start.
 */
export function pilotShownOptions(options: CustomerAuthOptions, pilotParam: string | null | undefined): { options: CustomerAuthOptions; pilot: boolean } {
  if (!pilotActive()) return { options, pilot: false };
  if (pilotRequested(pilotParam)) return { options, pilot: true };
  return { options: { ...options, emailCode: false, google: false, turnstileSiteKey: null }, pilot: false };
}
