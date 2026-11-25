import type { DocumentSource, PdfFetchOutcome, TicketReadOutcome } from "../../documents/contracts";
import type { Tristate } from "../booking-port";
import { TravelDeskBookingClient } from "./traveldesk.booking";
import type { TravelDeskConfig } from "./traveldesk.config";
import { isTravelDeskApiError, type TravelDeskHttpOptions } from "./traveldesk.http";

/**
 * TravelDesk behind the document service's `DocumentSource` (B4, TKT-1,
 * SUP-4). This is the only holder of the TravelDesk calls that may issue
 * tickets: get-by-id with `ticketsDetails`, the tickets PDF download
 * (doc 21 §9), and the voucher download, whose PDF includes a live
 * booking's tickets. The booking adapter's transport has neither, so a status read
 * can never reach them.
 *
 * Both calls are built from the configured base URL, a fixed path and the
 * stored integer booking id. No URL from an answer (`downloadTicketsUrl`,
 * `downloadCodeLink`, the voucher link with its Guid) is ever fetched, and
 * redirects are refused (traveldesk.http.ts).
 *
 * Pure: no env, db or logger.
 */

/** The TravelDesk calls the document source makes; `TravelDeskBookingClient` satisfies it (tests pass a fake). */
export type TravelDeskDocumentTransport = Pick<TravelDeskBookingClient, "readTicketsById" | "downloadTickets" | "downloadVoucher">;

export class TravelDeskDocumentSource implements DocumentSource {
  readonly supplierCode = "traveldesk";
  /** Q-T1 is open: whether get-by-id itself issues tickets is unknown, so the read stays one deliberate call. */
  readonly documentReadIssuesTickets: Tristate = "unknown";

  constructor(private readonly t: TravelDeskDocumentTransport) {}

  /**
   * The live source for a configuration. It has its own client, and so its
   * own one-request lane; to share the booking adapter's lane, build one
   * `TravelDeskBookingClient` and pass it to both constructors.
   */
  static fromConfig(config: TravelDeskConfig, opts: TravelDeskHttpOptions = {}): TravelDeskDocumentSource {
    return new TravelDeskDocumentSource(new TravelDeskBookingClient(config, opts));
  }

  /**
   * The deliberate document read: get-by-id with its ticket data. The
   * identity comes from the answer, so the document service can compare it
   * with the stored booking before keeping anything (F13). A 404 is
   * `not_found`; every other error is `failed` with the error kind.
   */
  async readTickets(supplierBookingId: string): Promise<TicketReadOutcome> {
    try {
      const { booking, tickets } = await this.t.readTicketsById(supplierBookingId);
      return {
        kind: "found",
        identity: {
          supplierBookingId: booking.supplierBookingId,
          bookingReference: booking.bookingReference,
          serviceDate: booking.serviceDate,
          offerExternalId: String(booking.offerId),
        },
        evidence: tickets,
      };
    } catch (e) {
      if (isTravelDeskApiError(e) && e.kind === "not_found") return { kind: "not_found" };
      return { kind: "failed", reason: isTravelDeskApiError(e) ? e.kind : "internal" };
    }
  }

  /**
   * The tickets PDF, bounded by `maxBytes` and the read timeout.
   *  - Over the cap: `too_large`.
   *  - 404 or 400: `not_ready`. TravelDesk does not document how it answers
   *    a download for a booking whose tickets are not ready yet; a 404 or a
   *    plain-text 400 (its usual refusal shape) is assumed to mean that, so
   *    the document service retries within its bound instead of giving up.
   *    Unverified in the sandbox.
   *  - An empty body: `failed`, nothing to store.
   * `declaredType` is the supplier's Content-Type as sent; the document
   * service sniffs the bytes, because the spec mislabels binary media types.
   */
  async fetchTicketsPdf(supplierBookingId: string, opts: { maxBytes: number }): Promise<PdfFetchOutcome> {
    return pdfOutcome(() => this.t.downloadTickets(supplierBookingId, { maxBytes: opts.maxBytes }));
  }

  /**
   * The voucher PDF of a live booking, classified like `fetchTicketsPdf`,
   * plus one case: a 502 is `not_ready`. TravelDesk answers 502 while an
   * external supplier's voucher is not ready, and 404 for a missing document
   * (12 Nov 2026, doc 22 §32.32).
   */
  async fetchVoucherPdf(supplierBookingId: string, opts: { maxBytes: number }): Promise<PdfFetchOutcome> {
    return pdfOutcome(() => this.t.downloadVoucher(supplierBookingId, { maxBytes: opts.maxBytes }), { notReadyStatuses: [502] });
  }
}

/** One PDF download as a `PdfFetchOutcome` (see `fetchTicketsPdf`). */
async function pdfOutcome(download: () => Promise<{ bytes: Uint8Array; contentType: string | null }>, opts: { notReadyStatuses?: number[] } = {}): Promise<PdfFetchOutcome> {
  try {
    const { bytes, contentType } = await download();
    if (bytes.byteLength === 0) return { kind: "failed", reason: "empty_body" };
    return { kind: "ok", bytes, declaredType: contentType };
  } catch (e) {
    if (!isTravelDeskApiError(e)) return { kind: "failed", reason: "internal" };
    if (e.kind === "invalid_response" && e.tooLarge) return { kind: "too_large" };
    if (e.kind === "not_found" || e.kind === "bad_request") return { kind: "not_ready" };
    if (e.status !== null && opts.notReadyStatuses?.includes(e.status)) return { kind: "not_ready" };
    return { kind: "failed", reason: e.kind };
  }
}
