import { ApiError } from "@/lib/api/client";

/**
 * Where the checkout sends its verification code.
 *
 * The phone is tried first. The server refuses a phone code with
 * NOT_CONFIGURED when no SMS provider is set up on the deployment; the code
 * then goes to the email address on the same form instead. The server
 * accepts an email verification the same way (it checks the email the
 * traveller pays with against the verified one), so the customer can still
 * pay instead of being sent to the inquiry form.
 */
export type CodeChannel = "phone" | "email";

type Start = (input: { quoteId: string; channel: CodeChannel; contact: string }) => Promise<{ challengeId: string }>;

export function phoneCodesUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.serverCode === "NOT_CONFIGURED";
}

export async function startCheckoutCode(
  start: Start,
  input: { quoteId: string; channel: CodeChannel; phoneE164: string; email: string },
): Promise<{ challengeId: string; channel: CodeChannel }> {
  const email = input.email.trim();
  if (input.channel === "email") {
    const { challengeId } = await start({ quoteId: input.quoteId, channel: "email", contact: email });
    return { challengeId, channel: "email" };
  }
  try {
    const { challengeId } = await start({ quoteId: input.quoteId, channel: "phone", contact: input.phoneE164 });
    return { challengeId, channel: "phone" };
  } catch (error) {
    if (!phoneCodesUnavailable(error) || !email) throw error;
    const { challengeId } = await start({ quoteId: input.quoteId, channel: "email", contact: email });
    return { challengeId, channel: "email" };
  }
}

/**
 * "ja•••@example.com": the first two characters of the local part, the
 * domain in full. One- and two-character local parts show only their first
 * character. For customer copy.
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = trimmed.slice(0, at);
  const shown = local.length > 2 ? local.slice(0, 2) : local.slice(0, 1);
  return `${shown}•••${trimmed.slice(at)}`;
}

/** The verify card's words for each channel. */
export function codeCopy(channel: CodeChannel | undefined, masked: string, codeLength: number, resentAt: string | null) {
  const email = channel === "email";
  return {
    title: email ? "Confirm your email" : "Confirm your mobile number",
    description: resentAt
      ? `We sent a new code at ${resentAt} to ${masked}. The previous code no longer works.`
      : `Enter the ${codeLength}-digit code we sent by ${email ? "email" : "SMS"} to ${masked}.${email ? " Check your spam folder if it isn't there in a minute." : ""}`,
    helpText: email ? "Wrong email?" : "Wrong number?",
  };
}
