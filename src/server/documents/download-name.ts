/**
 * The file name a customer's browser saves a ticket document under (checkout
 * redesign batch 3, CO-22), and its `Content-Disposition` header.
 *
 *  - `OUTLYY-voucher-<REF>.pdf` for a voucher (LiveBook and on-request
 *    bookings), `OUTLYY-tickets-<REF>.pdf` for a TicketOnly booking's
 *    `tickets_pdf` (document.service.ts `customerPdfKind`).
 *  - The reference is re-sanitised here even though callers pass a validated
 *    `OUT-…` reference: upper case, `[A-Z0-9-]` only, at most 32 characters,
 *    so no quote, semicolon, CR/LF, slash or non-ASCII character can reach the
 *    header. An empty result falls back to `booking`.
 *  - The header carries both a quoted ASCII `filename` and an RFC 5987
 *    `filename*` with the same value.
 *
 * Pure: no server state, unit-tested.
 */

const MAX_REFERENCE = 32;

export function documentDownloadName(kind: string, reference: string): string {
  const ref =
    String(reference ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "")
      .slice(0, MAX_REFERENCE) || "booking";
  return `OUTLYY-${kind === "tickets_pdf" ? "tickets" : "voucher"}-${ref}.pdf`;
}

/**
 * Group C (doc 93 §4.4): the names of the files OUTLYY draws itself.
 * `OUTLYY-entry-<REF>.pdf` (branded entry PDF and its cover-page fallback),
 * `OUTLYY-tax-invoice-<NUMBER>.pdf` (the combined "Tax invoice / Receipt", O1),
 * `OUTLYY-credit-note-<NUMBER>.pdf`. Reference and number are sanitised the
 * same way as above.
 */
export function generatedDownloadName(kind: string, reference: string, displayNumber: string | null): string {
  const clean = (v: string | null) =>
    String(v ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "")
      .slice(0, MAX_REFERENCE);
  if (kind === "tax_invoice") return `OUTLYY-tax-invoice-${clean(displayNumber) || clean(reference) || "booking"}.pdf`;
  if (kind === "tax_credit_note") return `OUTLYY-credit-note-${clean(displayNumber) || clean(reference) || "booking"}.pdf`;
  return `OUTLYY-entry-${clean(reference) || "booking"}.pdf`;
}

/** RFC 5987 `attr-char` encoding (encodeURIComponent leaves `'()*!` alone; they are not attr-chars). */
function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^A-Za-z0-9._-]/g, "_") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(filename)}`;
}
