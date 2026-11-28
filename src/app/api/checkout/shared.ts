import "server-only";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { Errors } from "@/server/lib/errors";
import { hashIp } from "@/server/lib/crypto";
import { enforceRateLimit } from "@/server/lib/rate-limit";
import { normalisePhone } from "@/server/domain/phone";
import { uuidSchema } from "@/server/schemas/inquiry.schemas";
import { customerAuthService } from "@/server/services/customer-auth.service";
import { guestSessionService } from "@/server/services/guest-session.service";
import type { QuoteSnapshot } from "@/server/quotes/contracts";
import { GUEST_NAME_LATIN_MESSAGE, supplierGuestName } from "@/lib/guest-name";

/**
 * Pieces shared by the checkout routes (`/api/checkout`, `/api/checkout/verify`,
 * `/api/checkout/verify/start`). Not a route file.
 */

/** Every checkout body is a few hundred bytes; this leaves room and no more. */
export const CHECKOUT_MAX_BYTES = 4 * 1024;

/**
 * Per IP on every checkout route, before any session is read (Postgres-backed,
 * failing closed). The services keep their own, tighter limits; this one only
 * stops a caller without a session from costing session reads for free.
 */
export const CHECKOUT_ROUTE_IP_RATE = { limit: 60, windowSeconds: 900 } as const;

export async function enforceCheckoutIpLimit(route: "start" | "verify_start" | "verify", ip: string | undefined): Promise<void> {
  await enforceRateLimit({ key: `checkout:${route}:ip:${hashIp(ip) ?? "unknown"}`, ...CHECKOUT_ROUTE_IP_RATE });
}

/**
 * The owner that created the quote: the signed-in customer first, otherwise
 * the browser's guest session, the same order `/api/quotes` resolves them in.
 * Nothing is opened here: without either there is no quote to pay for.
 */
export async function resolveCheckoutOwner(req: NextRequest): Promise<QuoteSnapshot["owner"] | null> {
  const session = await customerAuthService.resolveRequest(req);
  if (session) return { kind: "customer", customerId: session.customer.id };
  const guest = await guestSessionService.resolveRequest(req);
  return guest ? guestSessionService.owner(guest) : null;
}

/** No owner: the guest session ended, or the cookie was never set. Same words whatever the cause. */
export function checkoutSessionEnded() {
  return Errors.conflict("Your checkout has expired. Start again from your trip", { reason: "no_session" });
}

export function ownerKey(owner: QuoteSnapshot["owner"]): string {
  return owner.kind === "customer" ? `customer:${owner.customerId}` : `guest:${owner.guestSessionId}`;
}

export const verifyStartSchema = z
  .object({
    quoteId: uuidSchema,
    channel: z.enum(["phone", "email"]),
    contact: z.string().trim().min(3).max(254),
  })
  .strict();

export const verifyCodeSchema = z
  .object({
    challengeId: uuidSchema,
    code: z.string().trim().min(1).max(12),
  })
  .strict();

/**
 * Methods the instant checkout offers. The gateway's own capabilities decide
 * what each can do. EMI is not offered on instant checkout (owner decision,
 * doc 22 §32.7), so the server refuses it here too; EMI copy on inquiry
 * pages is a separate open question (question 2).
 */
export const CHECKOUT_METHODS = ["upi", "card", "netbanking", "wallet"] as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const checkoutStartSchema = z
  .object({
    quoteId: uuidSchema,
    verificationId: uuidSchema,
    method: z.enum(CHECKOUT_METHODS),
    traveller: z
      .object({
        fullName: z
          .string()
          .trim()
          .min(1, "We need a name for the booking voucher")
          .max(120)
          // The supplier takes Latin letters only (TravelDesk); refused here, before any payment.
          .refine((n) => supplierGuestName(n) !== null, GUEST_NAME_LATIN_MESSAGE),
        phoneE164: z
          .string()
          .trim()
          .max(20)
          .refine((p) => p.startsWith("+") && normalisePhone(p).valid, "Check the number, including the country code")
          .transform((p) => normalisePhone(p).e164)
          .nullable(),
        email: z.string().trim().toLowerCase().max(254).regex(EMAIL, "Check the email address").nullable(),
      })
      .strict()
      .refine((t) => t.phoneE164 !== null || t.email !== null, { message: "Give a phone number or an email", path: ["phoneE164"] }),
  })
  .strict();
