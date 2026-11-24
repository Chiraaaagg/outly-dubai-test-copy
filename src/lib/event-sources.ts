/**
 * Event names only the server may record (PRD-16).
 *
 * The public collector (`POST /api/events`) refuses these from a browser,
 * whatever the taxonomy in `src/lib/analytics.ts` lists, so a page can never
 * claim that money moved or that a supplier confirmed. Where each one is, or
 * is planned to be, emitted on the server:
 *
 *  - `payment_authorized`, `payment_captured`: the payment saga, after the
 *    commit of a move made on provider-verified evidence
 *    (`src/server/payments/saga.ts`, B5), once per order.
 *  - `supplier_confirmed`, `order_partially_fulfilled`: the payment saga when
 *    the order item's saga reaches `fulfilled` (the engine confirmed it with
 *    verified capture). `order_partially_fulfilled` is unreachable while
 *    multi-item instant orders are deferred (question 1).
 *  - `ticket_ready`: the document service once a complete ticket set and PDF
 *    are stored (`document.service.ts`, B5).
 *  These five go through `analyticsService.emitVerified` and are not
 *  forwarded to Meta, GA4 or PostHog (owner decision pending).
 *  - `booking_confirmed`: the business conversion, meaning "order paid".
 *    Assisted orders: `inquiryService.convertToOrder`. Instant orders:
 *    planned for the payment saga after capture, not emitted yet. The only
 *    browser sender was the mocked instant checkout, so no client copy is
 *    legitimate.
 *  - `inquiry_acknowledged` … `inquiry_sla_breached`: inquiry state
 *    transitions in `inquiry.service.ts` and the inquiry sweep.
 *
 * Plain data, no imports: the collector and its unit test both read it.
 */
export const SERVER_ONLY_EVENT_NAMES: ReadonlySet<string> = new Set([
  "payment_authorized",
  "payment_captured",
  "supplier_confirmed",
  "ticket_ready",
  "order_partially_fulfilled",
  "booking_confirmed",
  "inquiry_acknowledged",
  "inquiry_first_response",
  "inquiry_quoted",
  "inquiry_won",
  "inquiry_lost",
  "inquiry_sla_breached",
]);

export function isServerOnlyEvent(name: string): boolean {
  return SERVER_ONLY_EVENT_NAMES.has(name);
}
