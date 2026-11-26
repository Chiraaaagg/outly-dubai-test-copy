import {
  ORDER_CANCELLATION_PATH,
  ORDER_STATUS_PATH,
  RECOVERY_START_PATH,
  RECOVERY_VERIFY_PATH,
  TICKET_EXCHANGE_PATH,
  TICKET_REMOVE_ACCESS_PATH,
  type CancellationIneligibleReason,
  type CancellationRequestStatus,
  type CustomerOrderStatus,
} from "../customer-status";
import { isValidReference, normaliseReference } from "../reference";

/**
 * Browser fetchers for the B5 customer order routes (contract:
 * src/lib/customer-status.ts).
 *
 * Deliberately separate from `./index.ts`: this module imports no analytics,
 * so the `/t` landing, status, recovery and voucher pages can call it without
 * pulling the event pipeline in (PRV-4, TKT-5). Every call is same-origin
 * JSON with cookies (`credentials: "same-origin"`) and `no-store`.
 *
 * The server answers anything the caller may not see with one uniform 404;
 * these helpers turn that into `null` (or `{ ok: false }`) and never into a
 * message that says whether a reference exists.
 */

const TIMEOUT_MS = 20_000;

export type OrderRequestFailure = "offline" | "timeout" | "rate_limited" | "server";

/** A request that did not produce an answer the page can act on. */
export class OrderRequestError extends Error {
  constructor(
    readonly kind: OrderRequestFailure,
    readonly status?: number,
    /** A 429's `Retry-After`, in milliseconds (whole seconds only, at most 5 minutes); undefined when absent or unreadable. */
    readonly retryAfterMs?: number,
  ) {
    super(`order request failed: ${kind}`);
    this.name = "OrderRequestError";
  }
}

interface Reply {
  status: number;
  body: unknown;
}

async function send(method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new OrderRequestError(e instanceof DOMException && e.name === "AbortError" ? "timeout" : "offline");
  }
  clearTimeout(timer);
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (res.status === 429) throw new OrderRequestError("rate_limited", 429, retryAfterMs(res.headers.get("retry-after")));
  return { status: res.status, body: payload };
}

/** `Retry-After` in whole seconds (the form the server sends), bounded to 5 minutes. */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header || !/^\d{1,6}$/.test(header.trim())) return undefined;
  return Math.min(300, Number(header.trim())) * 1000;
}

function errorCode(body: unknown): string | undefined {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" ? code : undefined;
}

/** Minimal shape check so a malformed body never renders as a status. */
export function isCustomerOrderStatus(v: unknown): v is CustomerOrderStatus {
  const o = v as Partial<CustomerOrderStatus> | null;
  return Boolean(
    o &&
      typeof o === "object" &&
      typeof o.reference === "string" &&
      typeof o.state === "string" &&
      typeof o.headline === "string" &&
      typeof o.nextStep === "string" &&
      o.steps &&
      typeof o.steps === "object" &&
      Array.isArray(o.items),
  );
}

/** A reference the routes will accept, or null (no request is made for a malformed one). */
export function requestableReference(reference: string): string | null {
  const ref = normaliseReference(reference);
  return isValidReference(ref, "OUT") ? ref : null;
}

/** GET /api/orders/[reference]/status → the projection, or null when this browser may not see it. */
export async function fetchOrderStatus(reference: string): Promise<CustomerOrderStatus | null> {
  const ref = requestableReference(reference);
  if (!ref) return null;
  const r = await send("GET", ORDER_STATUS_PATH(ref));
  if (r.status === 404) return null;
  if (r.status !== 200 || !isCustomerOrderStatus(r.body)) throw new OrderRequestError("server", r.status);
  return r.body;
}

export type CancellationReply =
  | { kind: "accepted"; status: CancellationRequestStatus }
  | { kind: "not_eligible"; reason: CancellationIneligibleReason | null }
  | { kind: "not_found" };

/** POST /api/orders/[reference]/cancellation. Idempotent per item on the server. */
export async function requestCancellation(reference: string, orderItemId: string, kind: "cancel" | "exception"): Promise<CancellationReply> {
  const ref = requestableReference(reference);
  if (!ref) return { kind: "not_found" };
  const r = await send("POST", ORDER_CANCELLATION_PATH(ref), { orderItemId, kind });
  if (r.status === 404) return { kind: "not_found" };
  if (r.status === 409 && errorCode(r.body) === "NOT_ELIGIBLE") {
    const reason = (r.body as { error?: { reason?: unknown } }).error?.reason;
    return { kind: "not_eligible", reason: typeof reason === "string" ? (reason as CancellationIneligibleReason) : null };
  }
  const status = (r.body as { status?: unknown } | null)?.status;
  if ((r.status === 202 || r.status === 200) && typeof status === "string") return { kind: "accepted", status: status as CancellationRequestStatus };
  throw new OrderRequestError("server", r.status);
}

/**
 * POST /api/recovery/start. The server answers every well-formed request the
 * same way (a code is sent only on a match), so this resolves a challenge id
 * or throws; it never says whether the details matched.
 */
export async function startRecovery(input: { reference: string; channel: "phone" | "email"; contact: string }): Promise<{ challengeId: string }> {
  const r = await send("POST", RECOVERY_START_PATH, input);
  const challengeId = (r.body as { challengeId?: unknown } | null)?.challengeId;
  if (r.status === 200 && typeof challengeId === "string" && challengeId) return { challengeId };
  throw new OrderRequestError("server", r.status);
}

/** POST /api/recovery/verify → the reference to open, or `{ ok: false }` for any wrong, used or expired code. */
export async function verifyRecovery(input: { challengeId: string; code: string }): Promise<{ ok: true; reference: string } | { ok: false }> {
  const r = await send("POST", RECOVERY_VERIFY_PATH, { challengeId: input.challengeId, code: input.code.replace(/\D/g, "") });
  if (r.status === 200) {
    const reference = (r.body as { reference?: unknown } | null)?.reference;
    if (typeof reference === "string" && requestableReference(reference)) return { ok: true, reference: requestableReference(reference)! };
    throw new OrderRequestError("server", r.status);
  }
  if (r.status === 400 || r.status === 404) return { ok: false };
  throw new OrderRequestError("server", r.status);
}

/**
 * POST /api/tickets/exchange `{ token }`. Only ever called from a deliberate
 * click on `/t`. `reference` is null when the server did not return a usable
 * one (the grant is still set).
 */
export async function exchangeTicketToken(token: string): Promise<{ ok: true; reference: string | null } | { ok: false }> {
  const r = await send("POST", TICKET_EXCHANGE_PATH, { token });
  if (r.status === 200 && (r.body as { ok?: unknown } | null)?.ok === true) {
    const reference = (r.body as { reference?: unknown }).reference;
    return { ok: true, reference: typeof reference === "string" ? requestableReference(reference) : null };
  }
  if (r.status === 404 || r.status === 400) return { ok: false };
  throw new OrderRequestError("server", r.status);
}

/**
 * POST /api/tickets/remove-access: this browser forgets its access to bookings
 * (checkout grant revoked, access cookie and guest session cleared). True once
 * the server confirmed it.
 */
export async function removeBrowserAccess(): Promise<boolean> {
  const r = await send("POST", TICKET_REMOVE_ACCESS_PATH, {});
  if (r.status === 200) return true;
  throw new OrderRequestError(r.status === 429 ? "rate_limited" : "server", r.status);
}
