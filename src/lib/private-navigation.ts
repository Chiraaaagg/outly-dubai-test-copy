import { isPrivateCustomerPath } from "@/lib/customer-status";

/**
 * Whether a move to `href` must be a full document load (PRV-4, reviews 116
 * D4 and 116b N2).
 *
 * The Google tag is configured once per document, and only when that
 * document starts off the private customer paths (`googleTagBootstrap`). A
 * client-side move (`router.push`, `next/link`) into `/booking/<reference>`,
 * `/voucher/<reference>` and the rest would keep the measured page's tag
 * configured, and GA4's history-based page view would send the reference in
 * `page_location`. A new document on a private path never configures it, so
 * callers use `window.location.assign(href)` when this is true.
 */
export function entersPrivatePage(href: string): boolean {
  const path = href.split(/[?#]/, 1)[0] ?? "";
  return isPrivateCustomerPath(path);
}
