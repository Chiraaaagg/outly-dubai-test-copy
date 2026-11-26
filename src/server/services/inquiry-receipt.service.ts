import "server-only";
import { hmacCandidates, hmacFor, safeEqual } from "../lib/crypto";
import { log } from "../lib/logger";

/**
 * Inquiry receipt (doc 22 §23 B5 stop condition; review R-B5-5).
 *
 * The inquiry confirmation page used to say "Got it" from the URL and
 * sessionStorage alone. Now `POST /api/inquiries` gives the browser that
 * submitted the inquiry a short-lived, httpOnly receipt cookie naming the
 * inquiry id, and the page shows the received state only after
 * `GET /api/inquiries/receipt?ref=` confirms that receipt against the
 * stored inquiry. Anything else gets a neutral state.
 *
 *  - Value: `v1.<inquiryId>.<exp seconds>.<hmac>`, signed with the
 *    `access_cookie` HMAC ring under its own payload prefix, so it can never
 *    be read as a ticket-access cookie or the reverse. It carries no
 *    reference, phone or name.
 *  - Every key in the ring verifies, so a rotation does not break a receipt.
 *  - The receipt proves only "this browser submitted that inquiry"; it grants
 *    nothing else. Inquiry intake never depends on it: without the ring
 *    (R-B4-3) the cookie is simply not set and the page shows the neutral
 *    state.
 */

export const INQUIRY_RECEIPT_TTL_MS = 24 * 3600_000;

const VERSION = "v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function payload(inquiryId: string, exp: number): string {
  return `inquiry_receipt:${VERSION}:${inquiryId}:${exp}`;
}

export const inquiryReceipt = {
  /** The cookie value and its expiry, or null when the signing ring is unavailable. */
  sign(inquiryId: string, now: Date = new Date()): { value: string; expiresAt: Date } | null {
    if (!UUID.test(inquiryId)) return null;
    const exp = Math.floor((now.getTime() + INQUIRY_RECEIPT_TTL_MS) / 1000);
    try {
      return { value: [VERSION, inquiryId, String(exp), hmacFor("access_cookie", payload(inquiryId, exp))].join("."), expiresAt: new Date(exp * 1000) };
    } catch {
      log.warn("inquiry.receipt_unavailable", { reason: "keys_unavailable" });
      return null;
    }
  },

  /** The inquiry id a valid, unexpired receipt names, or null. */
  verify(value: string | undefined | null, now: Date = new Date()): string | null {
    if (!value || value.length > 200) return null;
    const parts = value.split(".");
    if (parts.length !== 4 || parts[0] !== VERSION) return null;
    const [, inquiryId, expRaw, sig] = parts;
    if (!UUID.test(inquiryId) || !/^\d{1,12}$/.test(expRaw) || !/^[0-9a-f]{64}$/.test(sig)) return null;
    const exp = Number(expRaw);
    if (exp * 1000 <= now.getTime()) return null;
    let candidates: string[];
    try {
      candidates = hmacCandidates("access_cookie", payload(inquiryId, exp));
    } catch {
      return null;
    }
    return candidates.some((c) => safeEqual(c, sig)) ? inquiryId : null;
  },
};
