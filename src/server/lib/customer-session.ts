import "server-only";
import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";
import { env } from "./env";

/**
 * Customer session cookies (impl/customer-auth-contract.md §1). Mirrors
 * `session.ts` naming for the admin cookies.
 *
 *  - `outlyy_customer_session` — the opaque bearer token whose SHA-256 is the
 *    `customer_sessions.token_hash`. httpOnly + Secure (outside dev) +
 *    SameSite=Lax + path=/. The token is random; nothing is encoded in it.
 *  - `outlyy_customer` — a `1` hint, NOT httpOnly and carrying no data, so the
 *    header can choose "Sign in" vs "Account" from `document.cookie` without
 *    an API call. It grants nothing: every request re-resolves the httpOnly
 *    cookie against the database.
 *
 * Both cookies share one expiry so the hint never outlives the session.
 */

export const CUSTOMER_COOKIE = "outlyy_customer_session";
export const CUSTOMER_HINT_COOKIE = "outlyy_customer";

const base = () => ({
  sameSite: "lax" as const,
  // Secure outside development, and always in a production build even if
  // APP_ENV was left at its default (same rule as the admin cookies).
  secure: env().APP_ENV !== "development" || process.env.NODE_ENV === "production",
  path: "/",
});

/**
 * `__Host-` names for the guest-session and ticket-access cookies in deployed
 * environments (APP_ENV staging or production; checkout redesign batch 3
 * review). The prefix makes the browser refuse the cookie unless it is
 * Secure, Path=/ and has no Domain, so a sibling subdomain or a plain-http
 * page cannot set or shadow it. Local development and the test suites run on
 * http://localhost with APP_ENV=development and keep the plain names.
 *
 * The old plain names are not read as a fallback in deployed environments:
 * instant checkout has not been released in production (INSTANT_RELEASE_ENABLED
 * is off, doc 22), so no production browser holds a guest session that owns a
 * paid order. A guest caught mid-checkout on staging at deploy time re-quotes
 * ("Your checkout has expired"), and an emailed-link holder re-opens the link
 * (it allows several exchanges). Reading both names would keep the weaker
 * cookie alive for no customer benefit.
 */
function hostPrefixed(): boolean {
  return env().APP_ENV !== "development";
}

export function setCustomerCookies(res: NextResponse, token: string, expiresAt: Date) {
  res.cookies.set(CUSTOMER_COOKIE, token, { ...base(), httpOnly: true, expires: expiresAt });
  res.cookies.set(CUSTOMER_HINT_COOKIE, "1", { ...base(), httpOnly: false, expires: expiresAt });
}

export function clearCustomerCookies(res: NextResponse) {
  res.cookies.set(CUSTOMER_COOKIE, "", { ...base(), httpOnly: true, maxAge: 0 });
  res.cookies.set(CUSTOMER_HINT_COOKIE, "", { ...base(), httpOnly: false, maxAge: 0 });
}

export function customerTokenFromRequest(req: NextRequest): string | undefined {
  return req.cookies.get(CUSTOMER_COOKIE)?.value || undefined;
}

/** Server Components / Server Actions. */
export async function customerTokenFromCookies(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(CUSTOMER_COOKIE)?.value || undefined;
}

/* ---------------------------------------------------------------------------
 * Guest checkout session (B2, src/server/services/guest-session.service.ts)
 *
 *  - `outlyy_guest_session` — opaque bearer token whose SHA-256 is
 *    `guest_sessions.token_hash`. httpOnly + Secure (outside dev) +
 *    SameSite=Lax + path=/, fixed expiry. No hint cookie: a guest session is
 *    not an account and the header never shows it.
 * ------------------------------------------------------------------------ */

export const GUEST_COOKIE = "outlyy_guest_session";

/** `__Host-outlyy_guest_session` in deployed environments, `outlyy_guest_session` locally (`hostPrefixed`). */
export function guestCookieName(): string {
  return hostPrefixed() ? `__Host-${GUEST_COOKIE}` : GUEST_COOKIE;
}

export function setGuestCookie(res: NextResponse, token: string, expiresAt: Date) {
  res.cookies.set(guestCookieName(), token, { ...base(), httpOnly: true, expires: expiresAt });
}

export function clearGuestCookie(res: NextResponse) {
  res.cookies.set(guestCookieName(), "", { ...base(), httpOnly: true, maxAge: 0 });
}

export function guestTokenFromRequest(req: NextRequest): string | undefined {
  return req.cookies.get(guestCookieName())?.value || undefined;
}

/** Server Components / Server Actions. */
export async function guestTokenFromCookies(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(guestCookieName())?.value || undefined;
}

/* ---------------------------------------------------------------------------
 * Ticket access session (B4, TKT-5; src/server/services/capability.service.ts)
 *
 *  - `outlyy_ticket_access` — signed entries from capability exchanges and
 *    recovery, one per grant, joined with `~` (each `v1.<grantId>.<exp>.<hmac>`;
 *    no token, no order id, no purpose). One browser can hold grants for
 *    several orders (R-B4-11): `addAccessEntry` in capability.service.ts adds
 *    one, drops expired and forged entries and keeps the 8 newest (about
 *    1 KB). httpOnly + Secure (outside dev) + SameSite=Strict + path=/,
 *    expiring with its longest entry (each entry: at most 12 hours, never
 *    after its grant). Strict: it is only ever needed by same-site requests
 *    from the ticket and status pages. Every request re-reads the grants, so
 *    a revocation applies at once.
 * ------------------------------------------------------------------------ */

export const TICKET_ACCESS_COOKIE = "outlyy_ticket_access";

/** `__Host-outlyy_ticket_access` in deployed environments, `outlyy_ticket_access` locally (`hostPrefixed`). */
export function ticketAccessCookieName(): string {
  return hostPrefixed() ? `__Host-${TICKET_ACCESS_COOKIE}` : TICKET_ACCESS_COOKIE;
}

export function setTicketAccessCookie(res: NextResponse, value: string, expiresAt: Date) {
  res.cookies.set(ticketAccessCookieName(), value, { ...base(), sameSite: "strict", httpOnly: true, expires: expiresAt });
}

export function clearTicketAccessCookie(res: NextResponse) {
  res.cookies.set(ticketAccessCookieName(), "", { ...base(), sameSite: "strict", httpOnly: true, maxAge: 0 });
}

export function ticketAccessFromRequest(req: NextRequest): string | undefined {
  return req.cookies.get(ticketAccessCookieName())?.value || undefined;
}

/** Server Components / Server Actions. */
export async function ticketAccessFromCookies(): Promise<string | undefined> {
  const jar = await cookies();
  return jar.get(ticketAccessCookieName())?.value || undefined;
}

/* ---------------------------------------------------------------------------
 * Inquiry receipt (B5, R-B5-5; src/server/services/inquiry-receipt.service.ts)
 *
 *  - `outlyy_inquiry_receipt` — the signed id of the inquiry this browser
 *    just submitted, so the confirmation page can ask the server whether it
 *    was received instead of trusting the URL. httpOnly + Secure (outside
 *    dev) + SameSite=Strict + path=/, 24 hours. Grants nothing else.
 * ------------------------------------------------------------------------ */

export const INQUIRY_RECEIPT_COOKIE = "outlyy_inquiry_receipt";

export function setInquiryReceiptCookie(res: NextResponse, value: string, expiresAt: Date) {
  res.cookies.set(INQUIRY_RECEIPT_COOKIE, value, { ...base(), sameSite: "strict", httpOnly: true, expires: expiresAt });
}

export function inquiryReceiptFromRequest(req: NextRequest): string | undefined {
  return req.cookies.get(INQUIRY_RECEIPT_COOKIE)?.value || undefined;
}
