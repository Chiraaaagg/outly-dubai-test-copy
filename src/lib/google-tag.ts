/**
 * The Google tag, as it appears in the document head.
 *
 * Google's setup instructions say to paste gtag.js immediately after `<head>`
 * on every page, and their verifier checks the served HTML for exactly that.
 * An earlier version of this site loaded the tag from a client component after
 * hydration, and only once measurement consent existed — correct for privacy,
 * invisible to the verifier, which sees a fresh visit with no consent cookie
 * and therefore no tag at all. Hence "Google tag not detected".
 *
 * So the tag now ships in the head of every page, and the consent gate moves
 * into Consent Mode v2 instead of into whether the script exists:
 *
 *   - `consent: default` with all four signals denied is queued on `dataLayer`
 *     **before** the loader tag, so the first thing gtag.js ever sees is
 *     "denied". No `_ga` cookie, no identifiers, no ad signals.
 *   - `wait_for_update` gives the banner 500ms to say otherwise before
 *     anything is sent, so a returning visitor who already agreed is not
 *     measured as if they had not.
 *   - `src/components/analytics/google-analytics.tsx` pushes `consent: update`
 *     once the stored decision is read, and again whenever it changes.
 *
 * This is a deliberate change of posture, not an oversight: previously the
 * library was never fetched without consent, now it is fetched but starts
 * denied and sends only cookieless pings until the visitor agrees. That is the
 * mechanism Google designed for this and what /cookies describes.
 *
 * `config` is skipped under /admin. Staff screens carry customer PII in the URL
 * and the DOM, and without a `config` call gtag.js opens no measurement stream
 * and sets no cookies there. It is skipped on every private customer route
 * too (`PRIVATE_CUSTOMER_ROUTE_PREFIXES` in `src/lib/customer-status.ts`:
 * `/t`, `/booking`, `/manage-booking`, `/voucher` and their APIs) and on
 * `/tickets` (doc 22 §23 B4/B5, TKT-5, PRV-4): they carry booking
 * references and, on `/t`, a bearer token in the URL fragment, and no
 * third-party measurement may run beside either. The check is inline rather than server-side
 * because reading the path on the server would make the root layout dynamic
 * and cost the whole statically prerendered catalogue.
 */

import { serializeJsonLd } from "@/lib/json-ld";
import { PRIVATE_CUSTOMER_ROUTE_PREFIXES } from "@/lib/customer-status";

/** The same list as `UNMEASURED_PATH_PREFIXES` in `src/lib/analytics.ts`, kept free of browser modules for the root layout. */
const UNMEASURED_PATH_PREFIXES: readonly string[] = [...new Set([...PRIVATE_CUSTOMER_ROUTE_PREFIXES, "/tickets"])];

const escapeForRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Paths where GA4 is never configured. `/admin` is a prefix (any path that
 * starts with it, as before); every unmeasured path (the private customer
 * routes plus `/tickets`) matches the segment exactly (`/t`, `/t/...`, but
 * not `/tours`; `/booking/...`, but not `/bookings`). Built from constants,
 * every `/` escaped, so its source is safe to inline into the head script.
 */
const GA_EXCLUDED = new RegExp(`^(?:\\/admin|(?:${UNMEASURED_PATH_PREFIXES.map(escapeForRegExp).join("|")})(?:\\/|$))`);

/** Whether the Google tag stays unconfigured on this pathname. Mirrors the inline check below. */
export function isGoogleTagExcludedPath(pathname: string): boolean {
  return GA_EXCLUDED.test(pathname);
}

/** Queued before the loader, so the first GA call is already "denied". */
export function googleTagBootstrap(measurementId: string): string {
  // The id comes from deployment config, not from visitors, but it is still
  // data written into an executable script: emit it as an escaped JS string
  // literal rather than splicing it between quotes, so a malformed value can
  // only break analytics, never the page.
  const id = serializeJsonLd(measurementId);
  return [
    `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}`,
    `gtag('consent','default',{'analytics_storage':'denied','ad_storage':'denied','ad_user_data':'denied','ad_personalization':'denied','wait_for_update':500});`,
    `gtag('js',new Date());`,
    // Storefront only. Under /admin and on private customer pages the library loads but is never configured.
    `if(!${GA_EXCLUDED.toString()}.test(location.pathname)){gtag('config',${id},{'anonymize_ip':true});}`,
  ].join("");
}

export function googleTagSrc(measurementId: string): string {
  return `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
}
