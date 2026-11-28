import type { SignInReason } from "@/lib/customer-auth-options";

/**
 * The words of the email code form (Group B, plan 92 §6), kept apart from the
 * component so the unit suite can check them. The server answers with one
 * closed reason plus closed hints; the words live here.
 */

/** The longest wait stated in minutes; a longer one reads "later" (re-review 103b N6: never "1380 minutes"). */
export const MAX_STATED_WAIT_SECONDS = 3600;

/** Hints a refusal may carry (`details.scope`, `details.alternative`). */
export interface EmailStepHints {
  /** A limit shared by every customer refused, not something this customer did. */
  scope?: "site";
  /** Google sign-in is on, so the page offers it. */
  alternative?: "google";
}

export function minutes(seconds: number): string {
  const m = Math.ceil(seconds / 60);
  return m === 1 ? "1 minute" : `${m} minutes`;
}

/** "in 15 minutes", or "later" for anything longer than an hour. */
export function waitWords(retryAfterSeconds?: number): string {
  const s = Math.max(60, retryAfterSeconds ?? 900);
  return s > MAX_STATED_WAIT_SECONDS ? "later" : `in ${minutes(s)}`;
}

/** Words for a refusal at the address step (or of a resend). */
export function emailStepMessage(reason: SignInReason, retryAfterSeconds?: number, hints: EmailStepHints = {}): string {
  switch (reason) {
    case "EMAIL_INVALID":
      return "Enter a full email address, like name@example.com.";
    case "CAPTCHA_FAILED":
      return "We couldn't confirm you're not a robot. Try again in a moment.";
    case "RATE_LIMITED": {
      const orGoogle = hints.alternative === "google" ? ", or continue with Google" : "";
      // A site-wide limit is not the customer's doing: say so, and never blame them for it.
      if (hints.scope === "site") return `We can't send more email codes right now. Try again ${waitWords(retryAfterSeconds)}${orGoogle}.`;
      return `Too many codes requested. Try again ${waitWords(retryAfterSeconds)}${orGoogle}.`;
    }
    case "DELIVERY_FAILED":
      return "We couldn't send the code. Try again in a moment.";
    case "ACCOUNT_CLOSED":
      return "This account has been closed.";
    default:
      return "Sign-in isn't working right now. Try again in a moment.";
  }
}

/** The 10 minutes ran out on this page (the form's own timer). */
export const CODE_TIMED_OUT_MESSAGE = "That code has expired. Send a new one.";

/** Words for a refusal at the code step. */
export function codeStepMessage(reason: SignInReason): string {
  switch (reason) {
    case "CODE_INVALID":
      return "That code didn't work. Check the latest email and try again.";
    case "CODE_EXPIRED":
      // From the server: expired, or this browser no longer holds the start cookie (another browser, cookies
      // cleared, a second tab for another address). The same action fixes all of them (re-review 103b).
      return "That code can't be used here any more. Send a new one.";
    case "RATE_LIMITED":
      return "Too many attempts. Wait a few minutes, then request a new code.";
    case "ACCOUNT_CLOSED":
      return "This account has been closed.";
    case "ACCOUNT_CONFLICT":
      return "This sign-in belongs to another account, so nothing was changed.";
    default:
      return "We couldn't check that code. Try again in a moment.";
  }
}

/** After this many server CODE_EXPIRED answers in a row, the form says the browser is not keeping its cookie. */
export const EXPIRED_IN_A_ROW_MEANS_NO_COOKIE = 2;

/** Cookies are blocked (or dropped every time): a new code would fail the same way, so say what will work. */
export function cookieBlockedMessage(googleAvailable: boolean): string {
  return `This browser isn't keeping our sign-in cookie, so a code can't be checked here. Allow cookies for this site, then send a new code${googleAvailable ? ", or continue with Google" : ""}.`;
}
