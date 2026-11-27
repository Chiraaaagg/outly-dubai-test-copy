import "server-only";
import type { UnlockChannel } from "@/lib/customer-status";
import { codeChannelsAvailable } from "@/server/services/contact-verification.service";

/**
 * Post-payment batch A1: which channels Find my booking may offer. Only the
 * channels that can deliver a code right now, preferred first (phone only
 * once the SMS path is ready; email only in production today, owner answer
 * 11 of 27 Nov 2026).
 */
export async function recoveryCodeChannels(): Promise<UnlockChannel[]> {
  return codeChannelsAvailable();
}
