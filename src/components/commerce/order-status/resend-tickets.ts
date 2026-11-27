import { ORDER_TICKETS_RESEND_PATH } from "@/lib/customer-status";
import { requestableReference } from "@/lib/api/order-status";

/**
 * "Email my tickets again" (post-payment batch A4; contract:
 * `ORDER_TICKETS_RESEND_PATH` in src/lib/customer-status.ts). A same-origin
 * POST with no body: the server sends only to the email already on the order,
 * for every item with valid files, and decides the limits (3 per order per
 * 24 hours, one per 2 minutes, per IP; failing closed).
 *
 * The answer is reduced to what the page can act on, and nothing else:
 *  - `sent`: accepted (202), with the time the next request is allowed;
 *  - `limited`: 429, with the time from `Retry-After` when readable;
 *  - `nothing`: 409, nothing to send (no valid file, or no email on the order);
 *  - `gone`: the uniform 404, the access on this browser has ended;
 *  - `failed`: no usable answer (offline, timeout, server error).
 * No analytics, no reference in any event (PRV-4).
 */
export type ResendOutcome =
  | { kind: "sent"; availableAt: string | null }
  | { kind: "limited"; availableAt: string | null }
  | { kind: "nothing" }
  | { kind: "gone" }
  | { kind: "failed" };

const TIMEOUT_MS = 20_000;

/**
 * `Retry-After` in whole seconds, up to 24 hours (the per-order limit can mean
 * hours; the shared status helper caps at 5 minutes, which would show a wrong
 * time here). Undefined when absent or unreadable.
 */
export function resendRetryAfterMs(header: string | null): number | undefined {
  if (!header || !/^\d{1,6}$/.test(header.trim())) return undefined;
  return Math.min(86_400, Number(header.trim())) * 1000;
}

function isoOrNull(v: unknown): string | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
}

export async function resendTickets(reference: string, now: () => number = Date.now): Promise<ResendOutcome> {
  const ref = requestableReference(reference);
  if (!ref) return { kind: "gone" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ORDER_TICKETS_RESEND_PATH(ref), {
      method: "POST",
      headers: { accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
  } catch {
    return { kind: "failed" };
  } finally {
    clearTimeout(timer);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status === 202 || res.status === 200) {
    return { kind: "sent", availableAt: isoOrNull((body as { resendAvailableAt?: unknown } | null)?.resendAvailableAt) };
  }
  if (res.status === 429) {
    const wait = resendRetryAfterMs(res.headers.get("retry-after"));
    return { kind: "limited", availableAt: wait === undefined ? null : new Date(now() + wait).toISOString() };
  }
  if (res.status === 409) return { kind: "nothing" };
  if (res.status === 404) return { kind: "gone" };
  return { kind: "failed" };
}
