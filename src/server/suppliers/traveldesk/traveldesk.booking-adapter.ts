import {
  ANSWERED_UNVERIFIED_REASON,
  type AttemptRequest,
  type BookingCapabilities,
  type CallObserver,
  type MutationOutcome,
  type ReadOutcome,
  type SupplierBookingAdapter,
  type SupplierRef,
  type SupplierSnapshot,
  type SupplierStatus,
  type WindowLister,
} from "../booking-port";
import type { TicketEvidence } from "../../documents/contracts";
import { type TravelDeskBooking, type TravelDeskBookingAnswer, TravelDeskBookingClient } from "./traveldesk.booking";
import type { TravelDeskConfig } from "./traveldesk.config";
import type { SupplierRefundFigure } from "../wallet-ledger";
import { candidateSpendable, type WalletFigures } from "../wallet-funds";
import { confirmationSnapshotFrom } from "./traveldesk.confirmation";
import { isTravelDeskApiError, type TravelDeskCallEvent, type TravelDeskErrorKind, type TravelDeskHttpOptions } from "./traveldesk.http";

/**
 * TravelDesk behind the engine's `SupplierBookingAdapter` (doc 22 §24.2,
 * SUP-19). Everything TravelDesk-specific stops here: numeric statuses, error
 * kinds, the cancel 400 texts and the list paging. The engine sees normalised
 * outcomes and snapshots; the raw status travels only inside the snapshot, for
 * the confirmation predicate.
 *
 * Status reads never use get-by-id (SUP-4): its answer may carry ticket codes
 * and reading it may issue them (doc 21 §9, Q-T1). `readStatus` lists the
 * service date and offer and falls back to the reservation read, which carries
 * no tickets. The transport type below has neither `readTicketsById` nor
 * `downloadTickets`, so the adapter cannot call them by mistake; only
 * `TravelDeskDocumentSource` holds those (traveldesk.documents.ts).
 *
 * Confirm and create answers carry `ticketsDetails` (TKT-1). The adapter
 * returns what they said as `tickets` beside the snapshot, never inside it:
 * the snapshot is stored as `lastResponse` and written to events.
 *
 * Pure: no env, db or logger.
 */

/**
 * The TravelDesk calls the adapter makes; `TravelDeskBookingClient` satisfies
 * it (tests pass a fake). No get-by-id and no document download (SUP-4).
 *
 * `confirm` and `create` may also answer a bare booking: the shape test fakes
 * written before B4 return. The adapter reads a bare booking as an answer
 * without ticket data (`none`). The live client always returns the answer
 * with its ticket evidence.
 */
export type TravelDeskBookingTransport = Pick<TravelDeskBookingClient, "reserve" | "cancel" | "getReservation" | "listBookingsPage" | "getBalance"> & {
  confirm(reservationId: string): Promise<TravelDeskBookingAnswer | TravelDeskBooking>;
  create(body: Record<string, unknown>): Promise<TravelDeskBookingAnswer | TravelDeskBooking>;
};

function answerOf(r: TravelDeskBookingAnswer | TravelDeskBooking): TravelDeskBookingAnswer {
  return "booking" in r ? r : { booking: r, tickets: { kind: "none" } };
}

/**
 * Capabilities as far as the sandbox drills and the documentation show them.
 *  - Holds: 15 minutes in test (Q-B5); production is unverified, so the engine
 *    caps each hold at this length from the send (CR-9).
 *  - "Not found" is never final: TravelDesk completes late (Q-B7).
 *  - Status reads are the list and the reservation read, neither of which
 *    carries ticket data (doc 21 §9).
 */
export const TRAVELDESK_BOOKING_CAPABILITIES: BookingCapabilities = Object.freeze({
  holds: { minutes: 15 },
  oneStep: true,
  clientRefLookup: "list_scan",
  notFoundFinalAfterMs: null,
  readIssuesTickets: "no",
  cancel: "full",
  documents: "none",
}) as BookingCapabilities;

/** Errors raised before the request left this process (traveldesk.http.ts). */
const NEVER_SENT: ReadonlySet<TravelDeskErrorKind> = new Set(["busy", "refused"]);

/**
 * Answers TravelDesk documents as refusing the request before it is processed
 * (SUP-3). Only 401/403: a revoked, missing or other-environment key (HTML
 * §Errors). Every other error after a send is an unknown outcome until
 * TravelDesk documents it (Q-B7).
 */
const DOCUMENTED_DEFINITE: ReadonlySet<TravelDeskErrorKind> = new Set(["auth"]);

/** `unknown` reason for a cancel answered 200 whose result could not be read back (SUP-13). Frozen in booking-port.ts; kept under this name for existing imports. */
export const ANSWERED_UNVERIFIED = ANSWERED_UNVERIFIED_REASON;

/** More pages than this in one listing is reported as incomplete, never thrown away silently (SUP-12). */
const MAX_LIST_PAGES = 50;

/** Normalised status. A final status is only a candidate: the engine's predicate decides (SUP-1). */
export function travelDeskStatus(r: Pick<TravelDeskBooking, "status" | "externalInProgress" | "externalFailed">): SupplierStatus {
  switch (r.status) {
    case 7:
      return "ON_HOLD";
    case 8:
      return "EXPIRED";
    case 4:
      return "CANCELLED";
    case 0:
    case 1:
    case 5:
      return r.externalInProgress === true && r.externalFailed !== true ? "PENDING" : "CONFIRMED";
    default:
      // 2 on-request, 3 payment required, 6 payment failed, codes not in the spec. 6 stays unknown (OpenAPI,
      // 22 Nov 2026: "PaymentFailed", with `paymentErrorMessage`, e.g. balance): the spec does not say the
      // booking holds no seats, was not charged, or cannot still be paid and confirmed (Q-B11 open), and the
      // engine treats no REJECTED as definite yet. Unknown keeps recovery and a human in the loop.
      return "UNKNOWN";
  }
}

function earliest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/**
 * A TravelDesk answer as the engine's snapshot. `holdCapUtc` bounds the hold
 * expiry: TravelDesk's deadline carries no timezone (Q-A2), so the engine
 * never trusts it past `sent + reservationTimeout` (CR-9). `tickets` is what
 * the same answer said about tickets: issued or malformed ticket data both
 * mean the supplier returned tickets, so they count as issued. The snapshot
 * itself never holds ticket data.
 */
export function snapshotFrom(r: TravelDeskBooking, holdCapUtc: string | null = null, tickets?: TicketEvidence): SupplierSnapshot & SupplierRefundFigure {
  const status = travelDeskStatus(r);
  const ticketsReturned = tickets !== undefined && tickets.kind !== "none";
  return {
    ...confirmationSnapshotFrom(r),
    ref: r.supplierBookingId,
    status,
    holdExpiresAtUtc: status === "ON_HOLD" ? earliest(r.reservationDeadline, holdCapUtc) : null,
    ticketsIssued: ticketsReturned || r.hasTickets ? true : null,
    ...(r.ticketsValidUntil ? { ticketsValidUntil: r.ticketsValidUntil } : {}),
    // The supplier wallet book's refund figure (wallet-ledger.ts); absent means TravelDesk did not say.
    refundedNetMinor: r.refundMinor,
  };
}

/** `unknown` reason for a mutation answered with a web server's 5xx error page instead of TravelDesk's own answer (doc 22 §32.22). */
export const SERVER_ERROR_PAGE_REASON = "server_error_page";

/**
 * `unknown` reasons for a mutation answered 2xx whose body was lost (a body
 * read timeout or connection drop, review P3-4). The answer is lost, so the
 * outcome stays unknown and is looked up; but TravelDesk answered, so these
 * are never outage signals.
 */
export const BODY_LOST_REASONS = { timeout: "body_timeout", network: "body_network" } as const;

/**
 * `unknown` reasons that show the supplier side failing, not answering
 * (doc 22 §32.22 finding 1): a 5xx, a wrapped web-server 5xx page, and a
 * timeout or connection failure after the request left Outly. The engine's
 * outage circuit breaker counts these on mutations. A definite refusal
 * (401/403), a 422 (`HotelId`), a plain 400 or a request that never left
 * Outly are answers or local refusals, not outages: they never count.
 */
export const SUPPLIER_OUTAGE_REASONS: ReadonlySet<string> = new Set(["server", SERVER_ERROR_PAGE_REASON, "timeout", "network"]);

/**
 * What a mutation answer says about the supplier's health: `outage` (the
 * outage circuit breaker counts it), `healthy` (TravelDesk processed the
 * request: an accepted answer, or a cancel answered 200 whose re-read failed)
 * or `neutral` (neither). The breaker ignores both of the last two: a
 * success does not reset it (review P2-2), its sliding window does.
 */
export function mutationHealth(o: MutationOutcome): "outage" | "healthy" | "neutral" {
  if (o.kind === "accepted") return "healthy";
  if (o.kind === "unknown" && o.sent && o.reason === ANSWERED_UNVERIFIED_REASON) return "healthy";
  if (o.kind === "unknown" && o.sent && SUPPLIER_OUTAGE_REASONS.has(o.reason)) return "outage";
  return "neutral";
}

function outcomeFromError(e: unknown): MutationOutcome {
  if (isTravelDeskApiError(e)) {
    if (NEVER_SENT.has(e.kind)) return { kind: "unknown", sent: false, reason: e.kind };
    if (DOCUMENTED_DEFINITE.has(e.kind)) return { kind: "rejected", definite: true, code: e.kind };
    if (e.bodyLost && (e.kind === "timeout" || e.kind === "network")) return { kind: "unknown", sent: true, reason: BODY_LOST_REASONS[e.kind] };
    return { kind: "unknown", sent: true, reason: e.serverErrorPage ? SERVER_ERROR_PAGE_REASON : e.kind };
  }
  // Anything else may have happened after the send.
  return { kind: "unknown", sent: true, reason: "internal" };
}

/**
 * Phrases that make a cancel 400 a policy refusal (CR-B1-4). Each one says
 * the cancellation itself is not permitted; a bare "cancel", "cannot" or
 * "allowed" proves nothing ("Invalid cancel request", "Cannot find booking").
 * TravelDesk documents no texts yet: widen this only from sandbox answers.
 */
const CANCEL_POLICY_PHRASES: readonly RegExp[] = [
  /cancell?ation (is )?not (allowed|permitted|possible)/,
  /(cannot|can't|can not) be cancell?ed/,
  /not cancell?able|non[- ]?cancell?able|non[- ]?refundable/,
  /(past|after|beyond|outside) (the )?(free )?cancell?ation (deadline|window|period|policy)/,
  /tickets? (have |has )?(already )?(been )?issued/,
  /too late to cancel/,
  // TravelDesk TEST, 3 Nov 2026 (A5 drill CX-6): "At the moment we can only cancel bookings within the full refund period. …"
  /can only cancel(l?ed)? (bookings? )?within the (full )?refund period/,
];

/**
 * A cancel 400 by its reason text (SUP-13, CR-B1-4). Only an anchored policy
 * phrase is a refusal. "Already cancelled" is no refusal: the adapter re-reads
 * the booking, so only the supplier's status settles it. "Not found" and
 * everything else are incidents the engine keeps open. The text itself never
 * leaves the adapter.
 */
export function classifyCancelRefusal(reason: string | undefined): "refused_policy" | "already_cancelled" | "not_found" | "invalid" {
  const r = (reason ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (/already (been )?cancell?ed/.test(r)) return "already_cancelled";
  if (/not ?found|does not exist|no such booking/.test(r)) return "not_found";
  if (CANCEL_POLICY_PHRASES.some((p) => p.test(r))) return "refused_policy";
  return "invalid";
}

/** `failed` reason of a read the per-request budget refused (CR-B1-9). Nothing was sent. */
export const READ_BUDGET_REASON = "read_budget";

/**
 * Asked before each supplier read the adapter makes (CR-B1-9): every list
 * page, the reservation read and the balance read. False stops a listing,
 * which is then reported incomplete, or fails a single read with
 * `READ_BUDGET_REASON`. The balance read is only counted: it guards a
 * mutation that already holds the lane, and its answer is ignored.
 */
export interface ReadGate {
  take(operation: "bookings.list" | "bookings.reservation" | "balance"): Promise<boolean>;
}

export interface TravelDeskBookingAdapterOptions {
  environment: "test" | "production";
  now?: () => Date;
  /** Page size for status lists. TravelDesk treats less than 100 as 100 and documents no maximum. */
  onPage?: number;
  readGate?: ReadGate;
}

export class TravelDeskBookingAdapter implements SupplierBookingAdapter, CallObserver, WindowLister {
  readonly supplierCode = "traveldesk";
  readonly environment: "test" | "production";
  private readonly now: () => Date;
  private readonly onPage: number;
  private readonly readGate: ReadGate | null;
  private last: { httpStatus: number | null; serverDate: string | null } | null = null;
  /** A gated copy reports its parent's last call: the HTTP events are wired to the parent. */
  private parent: TravelDeskBookingAdapter | null = null;

  constructor(
    private readonly t: TravelDeskBookingTransport,
    opts: TravelDeskBookingAdapterOptions,
  ) {
    this.environment = opts.environment;
    this.now = opts.now ?? (() => new Date());
    this.onPage = opts.onPage ?? 100;
    this.readGate = opts.readGate ?? null;
  }

  /** The same adapter and transport, with every read asking `gate` first (CR-B1-9). One per job. */
  withReadGate(gate: ReadGate): this {
    const copy = new TravelDeskBookingAdapter(this.t, { environment: this.environment, now: this.now, onPage: this.onPage, readGate: gate });
    copy.parent = this.parent ?? this;
    return copy as this;
  }

  private async gate(operation: Parameters<ReadGate["take"]>[0]): Promise<boolean> {
    return this.readGate ? this.readGate.take(operation) : true;
  }

  private async balance() {
    await this.gate("balance");
    return this.t.getBalance();
  }

  /** The live adapter for a configuration, with the HTTP events wired so `lastCall` sees status and `Date` header. */
  static fromConfig(config: TravelDeskConfig, opts: TravelDeskHttpOptions = {}): TravelDeskBookingAdapter {
    let adapter: TravelDeskBookingAdapter | null = null;
    const client = new TravelDeskBookingClient(config, {
      ...opts,
      onEvent: (e) => {
        adapter?.noteCall(e);
        opts.onEvent?.(e);
      },
    });
    adapter = new TravelDeskBookingAdapter(client, { environment: config.environment });
    return adapter;
  }

  /** Records the HTTP status and `Date` header of the last call (SUP-21). */
  noteCall(e: Pick<TravelDeskCallEvent, "status" | "serverDate">) {
    this.last = { httpStatus: e.status, serverDate: e.serverDate };
  }

  /** HTTP status and supplier `Date` header of the last call, for the engine's events. */
  lastCall(): { httpStatus: number | null; serverDate: string | null } | null {
    return this.parent ? this.parent.lastCall() : this.last;
  }

  capabilities(): BookingCapabilities {
    return TRAVELDESK_BOOKING_CAPABILITIES;
  }

  async account() {
    const b = await this.balance();
    return { accountId: String(b.agencyId) };
  }

  /**
   * Spendable funds (doc 29 §4.5, D1): the lower of `payableBalance` and
   * `creditFacility − balance`. A negative balance is prepaid money in the
   * agency's favour, so a prepaid wallet with balance −244.06 and no credit
   * can book 244.06. The raw figures go along as `wallet`: the engine applies
   * the fail-closed cross-check (`walletSpendable`) before any reserve.
   */
  async funds(): Promise<{ spendableMinor: bigint; currency: "AED"; accountId: string; wallet: WalletFigures }> {
    const b = await this.balance();
    const wallet: WalletFigures = { balanceMinor: b.balanceMinor, creditFacilityMinor: b.creditFacilityMinor, payableMinor: b.payableBalanceMinor };
    const spendable = candidateSpendable(wallet);
    if (spendable === null) throw new Error("TravelDesk balance figures are missing");
    return { spendableMinor: spendable, currency: "AED" as const, accountId: String(b.agencyId), wallet };
  }

  async hold(a: AttemptRequest): Promise<MutationOutcome> {
    const sentAt = this.now().getTime();
    try {
      const r = await this.t.reserve(a.body);
      const minutes = r.reservationTimeout ?? (TRAVELDESK_BOOKING_CAPABILITIES.holds ? TRAVELDESK_BOOKING_CAPABILITIES.holds.minutes : 0);
      return { kind: "accepted", snapshot: snapshotFrom(r, new Date(sentAt + minutes * 60_000).toISOString()) };
    } catch (e) {
      return outcomeFromError(e);
    }
  }

  /** One-step create. `tickets` is what the create answer said about admission codes (TKT-1). */
  async book(a: AttemptRequest): Promise<MutationOutcome> {
    try {
      const { booking, tickets } = answerOf(await this.t.create(a.body));
      return { kind: "accepted", snapshot: snapshotFrom(booking, null, tickets), tickets };
    } catch (e) {
      return outcomeFromError(e);
    }
  }

  /** `tickets` is what the confirm answer said about admission codes: confirm is the issuance moment (TKT-1). */
  async confirm(ref: SupplierRef): Promise<MutationOutcome> {
    try {
      const { booking, tickets } = answerOf(await this.t.confirm(ref.supplierBookingId));
      return { kind: "accepted", snapshot: snapshotFrom(booking, null, tickets), tickets };
    } catch (e) {
      return outcomeFromError(e);
    }
  }

  /**
   * `isSuccess` is documented as always true and refusals are a 400, so the
   * answer proves nothing: only a re-read showing the cancelled status does
   * (SUP-3, SUP-13). A 200 whose re-read fails is `unknown` with
   * `ANSWERED_UNVERIFIED`. A 400 saying the booking is already cancelled is
   * treated the same way as a 200: re-read, never taken as a refusal
   * (CR-B1-4).
   *
   * Any other 400 is re-read before it counts as a refusal: TravelDesk says
   * a 400 does not guarantee nothing was processed (12 Nov 2026, doc 22
   * §32.32). A re-read showing the booking cancelled wins; otherwise the
   * refusal stands, including when the re-read itself fails.
   */
  async cancel(ref: SupplierRef): Promise<MutationOutcome> {
    try {
      await this.t.cancel(ref.supplierBookingId);
    } catch (e) {
      if (isTravelDeskApiError(e) && e.kind === "bad_request") {
        const code = classifyCancelRefusal(e.reason);
        if (code !== "already_cancelled") {
          const check = await this.readStatus(ref);
          if (check.kind === "found" && check.snapshot.status === "CANCELLED") return { kind: "accepted", snapshot: check.snapshot };
          return { kind: "rejected", definite: true, code };
        }
      } else return outcomeFromError(e);
    }
    const r = await this.readStatus(ref);
    return r.kind === "found" ? { kind: "accepted", snapshot: r.snapshot } : { kind: "unknown", sent: true, reason: ANSWERED_UNVERIFIED };
  }

  /** List by date and offer; a booking the list does not show may still be a reservation (Q-B2). Never get-by-id. */
  async readStatus(ref: SupplierRef): Promise<ReadOutcome> {
    let listed: { rows: TravelDeskBooking[]; complete: boolean };
    try {
      listed = await this.listStable({ from: ref.serviceDate, to: ref.serviceDate, offerId: Number(ref.offerExternalId) });
    } catch (e) {
      return { kind: "failed", reason: isTravelDeskApiError(e) ? e.kind : "internal" };
    }
    const hit = listed.rows.find((r) => r.supplierBookingId === ref.supplierBookingId);
    if (hit) return { kind: "found", snapshot: snapshotFrom(hit) };
    if (!(await this.gate("bookings.reservation"))) return { kind: "failed", reason: READ_BUDGET_REASON };
    try {
      return { kind: "found", snapshot: snapshotFrom(await this.t.getReservation(ref.supplierBookingId)) };
    } catch (e) {
      // The reservation read answers 400 for anything that is no longer a reservation (sandbox, 30 Oct 2026).
      if (isTravelDeskApiError(e) && (e.kind === "bad_request" || e.kind === "not_found")) {
        return listed.complete ? { kind: "not_found" } : { kind: "failed", reason: "list_incomplete" };
      }
      return { kind: "failed", reason: isTravelDeskApiError(e) ? e.kind : "internal" };
    }
  }

  async findByClientRef(clientRef: string, hint: { serviceDate: string; offerExternalId: string }) {
    const listed = await this.listStable({ from: hint.serviceDate, to: hint.serviceDate, offerId: Number(hint.offerExternalId) });
    return { matches: listed.rows.filter((r) => r.bookingReference === clientRef).map((r) => snapshotFrom(r)), complete: listed.complete };
  }

  /** Every booking with a service date in the window, for reconciliation (`WindowLister`, booking-port.ts). */
  async listWindow(q: { from: string; to: string }) {
    const listed = await this.listStable(q);
    return { snapshots: listed.rows.map((r) => snapshotFrom(r)), complete: listed.complete };
  }

  /**
   * The list has no stable sort or snapshot, so an insert between pages can
   * shift a row out of view (SUP-12). One page is taken as is; more pages are
   * read twice and the two passes are united. The result is incomplete when
   * the passes disagree on the total or the page limit is reached.
   */
  private async listStable(q: { from: string; to: string; offerId?: number }): Promise<{ rows: TravelDeskBooking[]; complete: boolean }> {
    const first = await this.listPass(q);
    if (first.pages <= 1 && first.complete) return { rows: [...first.rows.values()], complete: true };
    const second = await this.listPass(q);
    const rows = new Map(first.rows);
    for (const [id, r] of second.rows) rows.set(id, r);
    return { rows: [...rows.values()], complete: first.complete && second.complete && first.total === second.total };
  }

  private async listPass(q: { from: string; to: string; offerId?: number }) {
    const rows = new Map<string, TravelDeskBooking>();
    let total = 0;
    let seen = 0;
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      // A refused page ends the pass incomplete: what was read stays, and absence proves nothing.
      if (!(await this.gate("bookings.list"))) return { rows, total, pages: page - 1, complete: false };
      const p = await this.t.listBookingsPage(q, page, this.onPage);
      total = p.totalCount;
      seen += p.rows.length;
      for (const r of p.rows) rows.set(r.supplierBookingId, r);
      if (p.rows.length === 0 || seen >= p.totalCount) return { rows, total, pages: page, complete: true };
    }
    return { rows, total, pages: MAX_LIST_PAGES, complete: false };
  }
}
