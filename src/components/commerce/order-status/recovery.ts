import { normalisePhone } from "@/lib/phone";
import { isValidReference, normaliseReference } from "@/lib/reference";

/**
 * Pure rules for the booking recovery form (doc 22 §26 F23). Validation
 * only checks shape; whether the details match a booking is the server's
 * business and is never revealed.
 */

export const CODE_LENGTH = 6;
export const RESEND_AFTER_SECONDS = 30;
/**
 * After this long the form says the code may have expired and offers a new
 * one. The recovery contract returns no expiry, so this is the server's
 * default code lifetime (`OTP_TTL_SECONDS`, 300 s); it is a prompt, never a
 * refusal: the server alone decides whether a code still works.
 */
export const CODE_STALE_AFTER_MS = 5 * 60_000;

export type RecoveryChannel = "phone" | "email";

export interface RecoveryInput {
  reference: string;
  channel: RecoveryChannel;
  countryCode: string;
  phone: string;
  email: string;
}

export interface RecoveryErrors {
  reference?: string;
  phone?: string;
  email?: string;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateRecovery(input: RecoveryInput): RecoveryErrors {
  const errors: RecoveryErrors = {};
  const ref = normaliseReference(input.reference);
  if (!ref) errors.reference = "Enter the booking reference. It starts with OUT-.";
  else if (!isValidReference(ref, "OUT")) errors.reference = "Check the reference. It looks like OUT-123456, with no spaces.";
  if (input.channel === "phone") {
    if (!input.phone.trim()) errors.phone = "Enter the phone number you booked with.";
    else {
      const p = normalisePhone(input.phone, input.countryCode);
      if (!p.valid) errors.phone = p.reason ?? "Check the phone number.";
    }
  } else if (!EMAIL.test(input.email.trim())) {
    errors.email = "Enter the email address you booked with.";
  }
  return errors;
}

/** The `POST /api/recovery/start` body for valid input, or null. */
export function recoveryContact(input: RecoveryInput): { reference: string; channel: RecoveryChannel; contact: string } | null {
  if (Object.keys(validateRecovery(input)).length) return null;
  const reference = normaliseReference(input.reference);
  if (input.channel === "phone") return { reference, channel: "phone", contact: normalisePhone(input.phone, input.countryCode).e164 };
  return { reference, channel: "email", contact: input.email.trim().toLowerCase() };
}

/**
 * The channels the form may offer (post-payment A1): only those the server
 * says can deliver a code now, in its order, without repeats. Absent means
 * the caller did not say; the form then offers email only, the one channel
 * that is always live (SMS codes are off in production, owner answer 11).
 */
export function offeredChannels(channels: readonly RecoveryChannel[] | undefined): RecoveryChannel[] {
  if (!channels) return ["email"];
  const out: RecoveryChannel[] = [];
  for (const c of channels) if ((c === "email" || c === "phone") && !out.includes(c)) out.push(c);
  return out;
}

/** The one sentence that names where the code goes, for a form offering these channels. */
export function codeDestinationText(channels: readonly RecoveryChannel[]): string {
  if (channels.length > 1) return "We'll send a 6-digit code to the phone number or email you booked with.";
  return channels[0] === "phone"
    ? "We'll text a 6-digit code to the phone number you booked with."
    : "We'll email a 6-digit code to the address you booked with.";
}
