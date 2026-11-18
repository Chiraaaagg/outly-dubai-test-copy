/**
 * B4 contracts: tickets, supplier documents, storage and guest capabilities
 * (doc 22 §23 B4, §24.2 "Shared interfaces frozen": document record, ticket
 * code record, notification dedup key, capability grant).
 *
 * Owned by the lead: change only between batches. A vocabulary, not a
 * service: no "server-only", env, db or logger imports, so the supplier
 * adapters (pure) can use it.
 */

import type { Tristate } from "../suppliers/booking-port";

/* ---------------------------------------------------------------------------
 * Issued tickets: the in-memory carrier for admission codes
 * ------------------------------------------------------------------------ */

/** Admission unit a ticket is for. A supplier value Outly cannot map is `unknown`, which never counts towards completeness. */
export type TicketUnit = "adult" | "child" | "infant" | "unknown";

/** One admission code as the supplier issued it. `code` is a bearer secret. */
export interface IssuedTicket {
  /** Position in the supplier's list, from 0. */
  unitIndex: number;
  ticketFor: TicketUnit;
  ticketTypeId: string | null;
  ticketTypeName: string | null;
  /** Supplier display type (QR, barcode, text). Symbology unconfirmed (Q-T3), so codes are never rendered yet. */
  displayType: number | null;
  /** The admission code. Never logged, never stored in plaintext, never in a DTO. */
  code: string;
  /** UTC instant, when the supplier gives one. */
  validUntil: string | null;
}

/** Where a ticket set was read from. A confirm or create answer is itself evidence that tickets were issued. */
export type TicketSource = "confirm_response" | "create_response" | "document_read";

const SECRET_TICKETS = Symbol("outly.issuedTickets");

/**
 * A set of issued tickets, carried from the supplier codec to the document
 * store in memory only. Serialising it (JSON, `util.inspect`, string
 * concatenation) shows a count, never a code, so an accidental log line,
 * event detail or `lastResponse` cannot carry codes (TKT-1, TKT-9). Read the
 * codes with `tickets()`.
 */
export class IssuedTicketSet {
  private readonly [SECRET_TICKETS]: readonly IssuedTicket[];
  readonly source: TicketSource;
  readonly count: number;

  constructor(tickets: readonly IssuedTicket[], source: TicketSource) {
    this[SECRET_TICKETS] = Object.freeze(tickets.map((t) => Object.freeze({ ...t })));
    this.source = source;
    this.count = tickets.length;
    Object.freeze(this);
  }

  tickets(): readonly IssuedTicket[] {
    return this[SECRET_TICKETS];
  }

  /** Units by kind, for the completeness check (TKT-2). */
  units(): Record<TicketUnit, number> {
    const out: Record<TicketUnit, number> = { adult: 0, child: 0, infant: 0, unknown: 0 };
    for (const t of this[SECRET_TICKETS]) out[t.ticketFor] += 1;
    return out;
  }

  toJSON() {
    return { issuedTickets: this.count, source: this.source };
  }

  toString() {
    return `[IssuedTicketSet ${this.count}]`;
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return this.toString();
  }
}

/**
 * What a supplier answer said about tickets, beside the snapshot:
 *  - `none`: the answer carried no ticket data;
 *  - `issued`: codes parsed;
 *  - `malformed`: the answer carried ticket data Outly could not read. The
 *    tickets count as issued (the supplier returned them), so the booking is
 *    `confirmed_ticket_pending` and a document read may follow.
 */
export type TicketEvidence = { kind: "none" } | { kind: "issued"; set: IssuedTicketSet } | { kind: "malformed"; source: TicketSource; reason: string };

/* ---------------------------------------------------------------------------
 * Supplier documents
 * ------------------------------------------------------------------------ */

/** `ticket_codes`: the code set (no stored object). `tickets_pdf`, `voucher_pdf`: supplier PDFs in private storage. */
export type DocumentKind = "ticket_codes" | "tickets_pdf" | "voucher_pdf";

/**
 * Document version status.
 *  - `pending`: expected, not yet obtained (`confirmed_ticket_pending`).
 *  - `valid`: complete and checked; the only status ever served.
 *  - `incomplete`: issued units differ from ordered units (TKT-2, F48).
 *  - `quarantined`: malformed, oversized, active content or the wrong booking (F13). Never served.
 *  - `superseded`: replaced by a newer version (reissue). Never served.
 *  - `failed`: given up after the attempt limit; a human decides.
 */
export type DocumentStatus = "pending" | "valid" | "incomplete" | "quarantined" | "superseded" | "failed";

export type DocumentSourceKind = "confirm_response" | "create_response" | "document_read" | "pdf_download";

/** Ordered admission units of a booking. */
export interface UnitCounts {
  adult: number;
  child: number;
  infant: number;
}

/**
 * What a customer or staff member may learn about a document. No storage
 * key, no checksum, no supplier URL, no code.
 */
export interface DocumentSummary {
  id: string;
  kind: DocumentKind;
  version: number;
  status: DocumentStatus;
  contentType: string | null;
  byteSize: number | null;
  createdAt: string;
}

/** Order-item ticket state as the customer sees it (server-computed). */
export type TicketFulfilment =
  | "not_applicable" // no confirmed supplier booking
  | "issued" // a valid, complete code set and a valid PDF
  | "ticket_pending" // confirmed; documents still being obtained
  | "attention"; // quarantined, incomplete or failed beyond its bound: staff are told

/* ---------------------------------------------------------------------------
 * Document source: the supplier side of the document step
 * ------------------------------------------------------------------------ */

/** Outcome of the deliberate document read. */
export type TicketReadOutcome =
  | { kind: "found"; identity: DocumentIdentity; evidence: TicketEvidence }
  | { kind: "not_found" }
  | { kind: "failed"; reason: string };

/** Booking identity in a document answer, compared with the stored booking before anything is kept (F13 wrong booking). */
export interface DocumentIdentity {
  supplierBookingId: string;
  bookingReference: string | null;
  serviceDate: string | null;
  offerExternalId: string | null;
}

export type PdfFetchOutcome = { kind: "ok"; bytes: Uint8Array; declaredType: string | null } | { kind: "not_ready" } | { kind: "too_large" } | { kind: "failed"; reason: string };

/**
 * A supplier's document endpoints. Separate from `SupplierBookingAdapter` on
 * purpose: status reads must never reach a read that can issue tickets
 * (SUP-4), so only the document service holds this port.
 *
 * Every call takes the stored supplier booking id; the adapter builds the
 * request from its configured origin and a fixed path. A URL from a response
 * is never fetched, and redirects are refused.
 */
export interface DocumentSource {
  readonly supplierCode: string;
  /** Whether the document read itself may issue tickets (Q-T1). While `unknown`, the read is one deliberate call. */
  readonly documentReadIssuesTickets: Tristate;
  /** The deliberate document read (TravelDesk: get-by-id with `ticketsDetails`). */
  readTickets(supplierBookingId: string): Promise<TicketReadOutcome>;
  /** The tickets PDF, bounded by `maxBytes` and the adapter's timeout. */
  fetchTicketsPdf(supplierBookingId: string, opts: { maxBytes: number }): Promise<PdfFetchOutcome>;
  /** The booking voucher PDF (the customer document of a live booking, tickets included), bounded the same way. */
  fetchVoucherPdf(supplierBookingId: string, opts: { maxBytes: number }): Promise<PdfFetchOutcome>;
}

/* ---------------------------------------------------------------------------
 * Storage port
 * ------------------------------------------------------------------------ */

/**
 * Private object storage for supplier documents (TKT-3). Keys are random ids
 * chosen by the document service and carry no reference, name or code.
 * There is no method that returns a URL: documents are only ever streamed
 * through Outly's ownership-checked route.
 */
export interface DocumentStore {
  readonly kind: "memory" | "supabase_s3";
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Null when the object does not exist. */
  get(key: string, opts: { maxBytes: number }): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

/** Object keys: `<environment>/<random 128-bit hex>`. Nothing else. */
export const OBJECT_KEY = /^(test|production|development)\/[0-9a-f]{32}$/;

/* ---------------------------------------------------------------------------
 * Guest capability grants (TKT-5)
 * ------------------------------------------------------------------------ */

export type CapabilityPurpose = "view_status" | "download_tickets" | "cancel_request";
/**
 * `recovery`: minted by a recovery challenge to the order's verified contact (B5, migration 20261102130000); carried by no message.
 * `checkout`: the guest browser that made the quote and verified the order's contact, at checkout (checkout redesign
 * batch 3, CO-02; migration 20261112120000); one per order, 24 hours, its token discarded at mint, carried by no message.
 */
export type CapabilityIssuedFor = "ticket_notification" | "status_notification" | "staff_resend" | "recovery" | "checkout";

/** A grant as services see it. The token itself exists only in the message that carries it. */
export interface CapabilityGrant {
  id: string;
  orderId: string;
  purpose: CapabilityPurpose;
  expiresAt: Date;
  revokedAt: Date | null;
  exchangedAt: Date | null;
}

/* ---------------------------------------------------------------------------
 * Notification outbox (TKT-6)
 * ------------------------------------------------------------------------ */

/**
 * Dedup key: one row per intended message. Built from the event, order,
 * item, recipient hash and document version; a staff resend adds its own
 * request id, so it is a new message by design.
 */
export interface DedupParts {
  event: string;
  orderId?: string | null;
  orderItemId?: string | null;
  inquiryId?: string | null;
  /** `hmacFor("lookup", normalisedRecipient)`, never the recipient. */
  recipientHash: string;
  documentVersion?: number | null;
  /** Staff resend: a fresh id per request. */
  resendOf?: string | null;
}

export function dedupKeyOf(p: DedupParts): string {
  return [
    p.event,
    `o:${p.orderId ?? "-"}`,
    `i:${p.orderItemId ?? "-"}`,
    `q:${p.inquiryId ?? "-"}`,
    `r:${p.recipientHash}`,
    `v:${p.documentVersion ?? "-"}`,
    ...(p.resendOf ? [`resend:${p.resendOf}`] : []),
  ].join("|");
}

/** Ticket messages store these ids only and render at send time. */
export interface TicketMessageRef {
  kind: "ticket_message";
  orderId: string;
  orderItemId: string;
  documentVersion: number;
}
