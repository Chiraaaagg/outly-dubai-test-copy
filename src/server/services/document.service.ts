import "server-only";
import { randomBytes } from "node:crypto";
import type { Prisma, SupplierBooking, SupplierDocument } from "@prisma/client";
import { type Actor, requirePermission } from "../lib/actor";
import { audit } from "../lib/audit";
import { ciphertextKeyId, encryptFor, hmacCandidates, hmacFor } from "../lib/crypto";
import { prisma, TX_OPTIONS, type Tx } from "../lib/db";
import { Errors } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import { emitEvent } from "../lib/structured-events";
import { enqueueCrmSyncForOrders } from "../crm/crm.outbox";
import { analyticsService } from "./analytics.service";
import type { Tristate } from "../suppliers/booking-port";
import { travelDeskExternalRefSchema } from "../suppliers/traveldesk/traveldesk.adapter";
import type {
  DocumentIdentity,
  DocumentKind,
  DocumentSource,
  DocumentStatus,
  DocumentStore,
  DocumentSummary,
  IssuedTicketSet,
  TicketFulfilment,
  TicketReadOutcome,
  TicketSource,
  UnitCounts,
} from "../documents/contracts";
import { validatePdf, sha256Of } from "../documents/pdf";
import { isCompleteTicketSet } from "../documents/ticket-completeness";
import { getDocumentStore, storageEnvironment } from "../documents/store";

/**
 * Supplier documents: ticket codes, ticket PDFs and their delivery state
 * (doc 22 §23 B4; TKT-1, TKT-2, TKT-3, SUP-4, SEC-13; F12, F13, F36, F47, F48).
 *
 * Rows (`supplier_documents`, one per version and kind):
 *  - `ticket_codes`: the admission codes of a booking, encrypted per code
 *    (`supplier_ticket_codes`, PRV-5). Never served, never in a DTO.
 *  - `tickets_pdf`: the supplier's PDF in private storage under a random key
 *    (`<env>/<32 hex>`). Streamed only through the ownership-checked route.
 *    Only TicketOnly bookings have one.
 *  - `voucher_pdf`: the same for a live booking's voucher, which includes its
 *    tickets (`pdfKindFor`). TravelDesk has no separate tickets PDF for a
 *    live booking.
 *
 * Lifecycle:
 *  - The engine persists codes from a confirm or create answer in the same
 *    transaction that records `confirmed` (`persistIssuedTickets`). When that
 *    fails, or the answer had no readable codes, the booking is
 *    `confirmed_ticket_pending`: a `pending` codes row (`markTicketsPending`).
 *  - `runDue` (the documents-tick job) reads pending codes from the supplier,
 *    downloads PDFs, raises F12 attention and repairs a confirmed booking
 *    with no codes row at all (F47 detection).
 *  - Only order-item bookings get rows. Drill bookings have none.
 *
 * Decisions:
 *  - Completeness (TKT-2, F48): issued adult, child and infant counts must
 *    equal the ordered counts. `unknown` units never count either way, so an
 *    extra `unknown` ticket neither completes nor spoils a set. Anything else
 *    is `incomplete`: kept (never served), with attention and an automatic
 *    refetch, because issuance is evidenced.
 *  - Identical re-delivery: a code set whose codes hash to the same multiset
 *    as the newest stored set (valid or incomplete) creates no new version
 *    and changes nothing; pending rows it answers are closed as superseded.
 *    A different set is a reissue: every older live codes row is superseded
 *    (`invalidatedAt`) first, and so is the valid PDF, which shows the old
 *    codes. The superseded PDF object is kept and never served again; it is
 *    deleted only when retention allows (not in this batch).
 *  - Automatic document reads (SUP-4, Q-T1): only when issuance is evidenced
 *    (codes seen in a confirm or create answer, malformed or not), or the
 *    offer's evidence says confirm issues tickets, or the source says its
 *    document read never issues them. Otherwise attention is raised at once
 *    and the document step is one deliberate staff read (`deliberateRead`).
 *  - A rejected answer (wrong booking, malformed, oversized, active content)
 *    is recorded as its own `quarantined` version, with no codes and no
 *    object, and the row waiting for documents backs off with attention.
 *  - Live bookings: the voucher row is made at confirmation (or by the
 *    sweep) and downloaded automatically. TravelDesk sends no codes for them,
 *    so unless codes were seen no codes row is made.
 *  - Fulfilment as the customer sees it (`listForOrder`): `issued` with a
 *    valid complete code set AND a valid tickets PDF, or with a valid voucher
 *    and no incomplete code set; `attention` when a waiting
 *    row carries attention or a kind failed with nothing valid; otherwise
 *    `ticket_pending`; `not_applicable` without a confirmed booking.
 *
 * Logging: `emitEvent` only (SEC-18). No code, supplier text or storage key
 * ever reaches an event, an audit row or a DTO.
 */

export const DOCUMENT_LIMITS = Object.freeze({
  /** Largest supplier PDF accepted. */
  maxPdfBytes: 10 * 1024 * 1024,
});

/** F12 and retry timing. Times are measured from the booking's `confirmedAt`. */
export const TICKET_TIMING = Object.freeze({
  /** A ticket still missing this long after confirmation raises attention (F12: 2 minutes). */
  attentionAfterMs: 2 * 60_000,
  /** ...and becomes urgent at this age (F12: 5 minutes). */
  urgentAfterMs: 5 * 60_000,
  /** When the activity starts within this window, a missing ticket is urgent already at `attentionAfterMs` ("earlier near start"). */
  startsSoonMs: 6 * 60 * 60_000,
  /** Wait before the n-th retry of a read or download (bounded; the last value repeats). */
  backoffMs: Object.freeze([1, 2, 5, 15, 30, 60].map((m) => m * 60_000)),
  /** Reads or downloads per waiting row before it is `failed` and a human decides. */
  maxAttempts: 8,
  /**
   * A claimed row stays locked at least this long, so a crashed run's rows
   * come back. Longer than the documents tick's `maxDuration` (120 s): the
   * platform kills a run before its locks lapse, so no second run can claim a
   * row the first is still working. `runDue` stretches it to its budget plus
   * `rowAllowanceMs` when a caller passes a longer budget.
   */
  claimLockMs: 5 * 60_000,
  /** The slowest single row: a supplier read at the largest TravelDesk read timeout (120 s), a store put (20 s default) and the writes. */
  rowAllowanceMs: 3 * 60_000,
  /** The F47 sweep leaves a just-confirmed booking to the engine's own call this long. */
  sweepGraceMs: 60_000,
});

/**
 * Doc 29 §4.4a, Batch 5 (review 86 B5-02): the ticket-class deadline before
 * the visit. An open-dated ticket can be bought weeks ahead, so F12 (measured
 * from `confirmedAt`) and the bounded retries are long over by the visit. A
 * ticket document still not valid this long before the activity starts
 * (Asia/Dubai) raises attention again, even after `failed`, and again as
 * urgent closer in. The same sweep flags issued tickets whose earliest
 * `validUntil` day is before the visit date.
 */
export const TICKET_VISIT_DEADLINE = Object.freeze({
  /** Attention when the tickets are not valid 24 hours before the visit starts. */
  attentionBeforeMs: 24 * 60 * 60_000,
  /** Urgent at 6 hours before. */
  urgentBeforeMs: 6 * 60 * 60_000,
});

/** The visit-deadline level a document has reached at `now`, with the instant it began; null before the first. */
export function visitDeadlineLevel(b: Pick<SupplierBooking, "serviceDate" | "startMinutes">, now: Date): { level: "attention" | "urgent"; at: Date } | null {
  const start = activityStart(b).getTime();
  const urgent = start - TICKET_VISIT_DEADLINE.urgentBeforeMs;
  const attention = start - TICKET_VISIT_DEADLINE.attentionBeforeMs;
  if (now.getTime() >= urgent) return { level: "urgent", at: new Date(urgent) };
  if (now.getTime() >= attention) return { level: "attention", at: new Date(attention) };
  return null;
}

/** Asia/Dubai is UTC+4 all year; service dates and slot minutes are local. */
const DUBAI_OFFSET_MS = 4 * 60 * 60_000;

export interface DocumentDeps {
  source: DocumentSource | null;
  store: DocumentStore | null;
  now: () => Date;
  /** Per-offer `issuesTicketsAtConfirm` (mapping ticket evidence); default reads the booking's mapping. */
  issuesTicketsAtConfirm?: (b: SupplierBooking) => Promise<Tristate>;
  /** Told after a PDF becomes valid. Default `notificationService.onTicketsReady`. Best effort. */
  notifyTicketsReady?: (ref: { orderId: string; orderItemId: string; documentVersion: number }) => Promise<unknown>;
}

export type ServableDocument =
  | { kind: "ok"; bytes: Uint8Array; contentType: "application/pdf"; document: { id: string; orderId: string; orderItemId: string; kind: string; version: number } }
  | { kind: "unavailable"; reason: "not_found" | "not_valid" | "refetching" | "no_store" };

export interface OrderItemTickets {
  orderItemId: string;
  fulfilment: TicketFulfilment;
  documents: DocumentSummary[];
}

export interface PersistResult {
  documentId: string;
  version: number;
  status: "valid" | "incomplete";
  /** True when the set was an identical re-delivery: nothing new was written. */
  unchanged?: boolean;
  count?: number;
  source?: TicketSource;
  expected?: UnitCounts;
  issued?: Record<"adult" | "child" | "infant" | "unknown", number>;
  superseded?: { id: string; kind: string; version: number }[];
}

export interface RunDueResult {
  swept: number;
  attention: number;
  claimed: number;
  processed: { documentId: string; kind: string; outcome: string }[];
  outOfTime: boolean;
  /** The SEC-13 stored-object audit of this run (`auditMax`). */
  audited: { checked: number; refetching: number };
}

type Db = Tx | typeof prisma;
type BookingRef = Pick<SupplierBooking, "id" | "orderId" | "orderItemId">;
type WaitingRow = Pick<SupplierDocument, "id" | "kind" | "status" | "version" | "fetchAttempts" | "attentionRequiredAt" | "issuedEvidence">;

const LIVE_CODES: DocumentStatus[] = ["pending", "incomplete", "valid"];
const PDF_KINDS: DocumentKind[] = ["tickets_pdf", "voucher_pdf"];

/**
 * The PDF a booking's customer receives. A TicketOnly booking gets the
 * tickets PDF. Any other booking (live) gets the voucher, which includes its
 * tickets: TravelDesk serves a separate tickets PDF only for TicketOnly
 * bookings with allocated stock (OpenAPI `downloadTicketsUrl`).
 */
export function pdfKindFor(b: Pick<SupplierBooking, "bookingKind">): "tickets_pdf" | "voucher_pdf" {
  return b.bookingKind === "ticket_only" ? "tickets_pdf" : "voucher_pdf";
}

function isRoot(db: Db): db is typeof prisma {
  return typeof (db as { $transaction?: unknown }).$transaction === "function";
}

/** Run `fn` in `db` when it is a transaction, else in a new one. */
async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return isRoot(db) ? db.$transaction(fn, TX_OPTIONS) : fn(db);
}

/** Serialises document writes of one booking (version numbers, the one-valid index). */
async function lockBooking(tx: Tx, bookingId: string) {
  await tx.$queryRaw`SELECT id FROM supplier_bookings WHERE id = ${bookingId}::uuid FOR UPDATE`;
}

async function nextVersion(tx: Tx, bookingId: string, kind: DocumentKind): Promise<number> {
  const r = await tx.supplierDocument.aggregate({ where: { supplierBookingId: bookingId, kind }, _max: { version: true } });
  return (r._max.version ?? 0) + 1;
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function unitsOf(b: Pick<SupplierBooking, "adults" | "children" | "infants">): UnitCounts {
  return { adult: b.adults, child: b.children, infant: b.infants };
}

function after(now: Date, ms: number) {
  return new Date(now.getTime() + ms);
}

function backoffFor(attempts: number): number {
  const s = TICKET_TIMING.backoffMs;
  return s[Math.min(Math.max(attempts, 1), s.length) - 1];
}

/** The activity's start instant: service date plus slot start (midnight when unknown), Asia/Dubai. */
export function activityStart(b: Pick<SupplierBooking, "serviceDate" | "startMinutes">): Date {
  return new Date(Date.parse(`${isoDate(b.serviceDate)}T00:00:00Z`) + (b.startMinutes ?? 0) * 60_000 - DUBAI_OFFSET_MS);
}

/** When a missing ticket of this booking becomes urgent (F12). */
export function urgentAt(b: Pick<SupplierBooking, "confirmedAt" | "serviceDate" | "startMinutes">): Date | null {
  if (!b.confirmedAt) return null;
  const soon = activityStart(b).getTime() - b.confirmedAt.getTime() <= TICKET_TIMING.startsSoonMs;
  return after(b.confirmedAt, soon ? TICKET_TIMING.attentionAfterMs : TICKET_TIMING.urgentAfterMs);
}

/** Whether a document answer is about this booking (F13). Exact match: an absent field is a mismatch. */
export function sameIdentity(b: Pick<SupplierBooking, "supplierBookingId" | "clientRef" | "serviceDate" | "offerExternalId">, id: DocumentIdentity): boolean {
  return (
    b.supplierBookingId !== null &&
    id.supplierBookingId === b.supplierBookingId &&
    id.bookingReference === b.clientRef &&
    id.serviceDate === isoDate(b.serviceDate) &&
    id.offerExternalId === b.offerExternalId
  );
}

/** Whether `set` hashes to exactly the stored multiset (any ring key, so a rotation does not look like a reissue). */
function sameCodes(stored: string[], set: IssuedTicketSet): boolean {
  if (stored.length !== set.count) return false;
  const left = [...stored];
  for (const t of set.tickets()) {
    const candidates = hmacCandidates("ticket_code_hash", t.code);
    const i = left.findIndex((h) => candidates.includes(h));
    if (i < 0) return false;
    left.splice(i, 1);
  }
  return left.length === 0;
}

function validUntil(s: string | null): Date | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Default Q-T1 resolver: the booking's mapping ticket evidence, read like the quote and catalogue services. */
async function mappingIssuesTicketsAtConfirm(db: Db, b: Pick<SupplierBooking, "mappingId">): Promise<Tristate> {
  if (!b.mappingId) return "unknown";
  const m = await db.productSupplierMapping.findUnique({ where: { id: b.mappingId }, select: { externalRef: true } });
  const ref = travelDeskExternalRefSchema.safeParse(m?.externalRef);
  return ref.success ? (ref.data.ticketEvidence?.issuesTicketsAtConfirm ?? "unknown") : "unknown";
}

async function defaultNotify(ref: { orderId: string; orderItemId: string; documentVersion: number }) {
  // Imported late: the notification service pulls in templates and channel adapters the engine does not need.
  const { notificationService } = await import("./notification.service");
  return notificationService.onTicketsReady(ref);
}

/**
 * `ticket_ready` (PRD-16) once the item's tickets are `issued` (valid codes
 * and a valid PDF), after the commit that made them so. Once per order item
 * (`emitVerified` dedups); never throws, never forwarded.
 */
async function recordTicketReady(supplierBookingId: string, orderId: string, orderItemId: string, documentVersion: number): Promise<void> {
  try {
    const docs = await prisma.supplierDocument.findMany({ where: { supplierBookingId } });
    if (fulfilmentOf(docs) !== "issued") return;
    await analyticsService.emitVerified({ name: "ticket_ready", orderId, orderItemId, props: { document_version: documentVersion } });
  } catch {
    // Analytics never affects the documents.
  }
}

function summary(d: SupplierDocument): DocumentSummary {
  return { id: d.id, kind: d.kind as DocumentKind, version: d.version, status: d.status as DocumentStatus, contentType: d.contentType, byteSize: d.byteSize, createdAt: d.createdAt.toISOString() };
}

/** Emits what a committed `persistIssuedTickets` did. Call only after the commit. */
export function reportPersisted(supplierBookingId: string, r: PersistResult) {
  // An identical re-delivery wrote nothing; the read that found it reports `unchanged`.
  if (r.unchanged) return;
  for (const s of r.superseded ?? []) emitEvent("document.superseded", { documentId: s.id, kind: s.kind, version: s.version });
  emitEvent("tickets.persisted", { supplierBookingId, documentId: r.documentId, version: r.version, count: r.count, status: r.status, source: r.source });
  if (r.status === "incomplete") {
    const e = r.expected ?? { adult: 0, child: 0, infant: 0 };
    const i = r.issued ?? { adult: 0, child: 0, infant: 0, unknown: 0 };
    emitEvent("tickets.incomplete", { supplierBookingId, documentId: r.documentId, expectedTotal: e.adult + e.child + e.infant, issuedTotal: i.adult + i.child + i.infant }, "warn");
    emitEvent("document.attention", { documentId: r.documentId, supplierBookingId, reason: "incomplete_set", ageMs: 0 }, "warn");
  }
}

export const documentService = {
  /**
   * Persist an issued code set (TKT-1, TKT-2) inside the caller's
   * transaction; throws on any failure so the caller's transaction rolls
   * back (the engine then marks the booking ticket-pending, F47). Encrypts
   * and hashes every code before the first write, so a missing key writes
   * nothing. Emits nothing: call `reportPersisted` after the commit.
   */
  async persistIssuedTickets(tx: Tx, booking: SupplierBooking, set: IssuedTicketSet, now: Date): Promise<PersistResult> {
    if (!booking.orderItemId) throw new Error("document.service: drill bookings have no document rows");
    if (set.count === 0) throw new Error("document.service: an empty ticket set is not an issued set");
    const sealed = set.tickets().map((t) => {
      const codeCiphertext = encryptFor("ticket_codes", t.code);
      return { t, codeCiphertext, codeKeyId: ciphertextKeyId(codeCiphertext), codeHash: hmacFor("ticket_code_hash", t.code) };
    });

    await lockBooking(tx, booking.id);
    const docs = await tx.supplierDocument.findMany({
      where: { supplierBookingId: booking.id, kind: "ticket_codes" },
      orderBy: { version: "desc" },
      include: { codes: { select: { codeHash: true } } },
    });
    const withCodes = docs.filter((d) => (d.status === "valid" || d.status === "incomplete") && d.codes.length > 0);
    const newest = withCodes[0];
    if (newest && sameCodes(newest.codes.map((c) => c.codeHash), set)) {
      // Identical re-delivery: no new version. Pending rows it answers are closed.
      if (newest.status === "valid") {
        await tx.supplierDocument.updateMany({ where: { supplierBookingId: booking.id, kind: "ticket_codes", status: "pending" }, data: { status: "superseded", invalidatedAt: now, nextFetchAt: null, lockedUntil: null } });
      }
      return { documentId: newest.id, version: newest.version, status: newest.status as "valid" | "incomplete", unchanged: true };
    }

    const expected = unitsOf(booking);
    const issued = set.units();
    // Per ticket type: a combined-admission offer issues one code per guest for each type (doc 29 §8.6).
    const complete = isCompleteTicketSet(expected, set.tickets());
    const status = complete ? "valid" : "incomplete";
    const target = docs.find((d) => d.status === "pending" && d.codes.length === 0) ?? null;
    const reissue = withCodes.length > 0;

    // Supersede first: at most one valid row per booking and kind.
    const superseded: { id: string; kind: string; version: number }[] = [];
    for (const d of docs) {
      if (d.id === target?.id || !LIVE_CODES.includes(d.status as DocumentStatus)) continue;
      await tx.supplierDocument.update({ where: { id: d.id }, data: { status: "superseded", invalidatedAt: now, nextFetchAt: null, lockedUntil: null } });
      superseded.push({ id: d.id, kind: d.kind, version: d.version });
    }
    const pdfKind = pdfKindFor(booking);
    const pdfs = await tx.supplierDocument.findMany({ where: { supplierBookingId: booking.id, kind: pdfKind }, orderBy: { version: "desc" } });
    if (reissue) {
      // The valid PDF shows the old codes. Its object is kept (retention), never served again.
      for (const p of pdfs.filter((p) => p.status === "valid")) {
        await tx.supplierDocument.update({ where: { id: p.id }, data: { status: "superseded", invalidatedAt: now } });
        superseded.push({ id: p.id, kind: p.kind, version: p.version });
      }
    }

    const data = {
      status,
      source: set.source,
      unitsExpected: expected as unknown as Prisma.InputJsonValue,
      unitsIssued: issued as unknown as Prisma.InputJsonValue,
      issuedEvidence: set.source,
      validatedAt: complete ? now : null,
      nextFetchAt: complete ? null : after(now, backoffFor(1)),
      attentionRequiredAt: complete ? null : now,
      lockedUntil: null,
      quarantineReason: null,
    };
    let doc: { id: string; version: number };
    if (target) doc = await tx.supplierDocument.update({ where: { id: target.id }, data, select: { id: true, version: true } });
    else {
      const version = (docs[0]?.version ?? 0) + 1;
      doc = await tx.supplierDocument.create({
        data: { id: uuidv7(), supplierBookingId: booking.id, orderId: booking.orderId, orderItemId: booking.orderItemId, kind: "ticket_codes", version, ...data },
        select: { id: true, version: true },
      });
    }
    await tx.supplierTicketCode.createMany({
      data: sealed.map(({ t, codeCiphertext, codeKeyId, codeHash }) => ({
        id: uuidv7(),
        documentId: doc.id,
        supplierBookingId: booking.id,
        unitIndex: t.unitIndex,
        ticketFor: t.ticketFor,
        ticketTypeId: t.ticketTypeId,
        ticketTypeName: t.ticketTypeName,
        displayType: t.displayType,
        codeCiphertext,
        codeKeyId,
        codeHash,
        validUntil: validUntil(t.validUntil),
      })),
    });

    // Complete codes: the confirm already issued tickets, so downloading the PDF is safe to automate.
    // A live booking's voucher is its document whatever the codes say; one copy is enough until a reissue.
    const voucherLive = pdfKind === "voucher_pdf" && !reissue && pdfs.some((p) => p.status === "valid");
    if ((complete || pdfKind === "voucher_pdf") && !voucherLive && !pdfs.some((p) => p.status === "pending")) {
      await tx.supplierDocument.create({
        data: {
          id: uuidv7(),
          supplierBookingId: booking.id,
          orderId: booking.orderId,
          orderItemId: booking.orderItemId,
          kind: pdfKind,
          version: (pdfs[0]?.version ?? 0) + 1,
          status: "pending",
          source: "pdf_download",
          issuedEvidence: set.source,
          nextFetchAt: now,
        },
      });
    }
    // The deal's ticket status and the Fulfilled stage read document readiness (review C2A-03). Last, same transaction.
    if (booking.orderId) await enqueueCrmSyncForOrders(tx, [booking.orderId]);
    return { documentId: doc.id, version: doc.version, status, count: set.count, source: set.source, expected, issued, superseded };
  },

  /**
   * The booking is `confirmed_ticket_pending` (F47): a `pending` codes row,
   * idempotent. An existing live codes row is returned as it is, except that
   * evidence of issuance upgrades a waiting row to automatic reads.
   * `deps.source` and `deps.issuesTicketsAtConfirm` decide whether a read
   * without evidence may be automatic (SUP-4); without them it may not.
   *
   * A live booking also gets its pending voucher row (`ensureVoucherPending`).
   * TravelDesk returns no ticket codes for live bookings, only the voucher
   * (12 Nov 2026, doc 22 §32.32), so when none were seen no codes row is made
   * and the voucher row is returned. Codes that did arrive (`evidence`), even
   * malformed, keep their codes row. `force` (the deliberate staff read)
   * always makes the codes row.
   */
  async markTicketsPending(
    db: Db,
    booking: BookingRef,
    opts: { reason: "persist_failed" | "malformed" | "no_codes"; evidence: TicketSource | null; force?: boolean },
    now: Date,
    deps?: Pick<DocumentDeps, "source" | "issuesTicketsAtConfirm">,
  ): Promise<{ documentId: string; automatic: boolean; kind: "ticket_codes" | "voucher_pdf" }> {
    if (!booking.orderItemId) throw new Error("document.service: drill bookings have no document rows");
    const full = await db.supplierBooking.findUniqueOrThrow({ where: { id: booking.id } });
    let atConfirm: Tristate | undefined;
    const issuesAtConfirm = async () => (atConfirm ??= deps?.issuesTicketsAtConfirm ? await deps.issuesTicketsAtConfirm(full) : await mappingIssuesTicketsAtConfirm(db, full));
    if (pdfKindFor(full) === "voucher_pdf") {
      const voucherId = await this.ensureVoucherPending(db, full, now);
      if (!opts.force && opts.evidence === null) return { documentId: voucherId, automatic: true, kind: "voucher_pdf" };
    }
    let automatic = opts.evidence !== null || deps?.source?.documentReadIssuesTickets === "no";
    if (!automatic) automatic = (await issuesAtConfirm()) === "yes";
    const r = await inTx(db, async (tx) => {
      await lockBooking(tx, booking.id);
      const live = await tx.supplierDocument.findFirst({ where: { supplierBookingId: booking.id, kind: "ticket_codes", status: { in: LIVE_CODES } }, orderBy: { version: "desc" } });
      if (live) {
        if (live.status === "pending" && live.nextFetchAt === null && automatic) {
          await tx.supplierDocument.update({ where: { id: live.id }, data: { issuedEvidence: live.issuedEvidence ?? opts.evidence, nextFetchAt: now } });
          return { documentId: live.id, automatic: true, created: false };
        }
        if (live.status === "pending" && !live.issuedEvidence && opts.evidence) await tx.supplierDocument.update({ where: { id: live.id }, data: { issuedEvidence: opts.evidence } });
        return { documentId: live.id, automatic: live.nextFetchAt !== null, created: false };
      }
      const doc = await tx.supplierDocument.create({
        data: {
          id: uuidv7(),
          supplierBookingId: booking.id,
          orderId: booking.orderId,
          orderItemId: booking.orderItemId,
          kind: "ticket_codes",
          version: await nextVersion(tx, booking.id, "ticket_codes"),
          status: "pending",
          source: "document_read",
          issuedEvidence: opts.evidence,
          nextFetchAt: automatic ? now : null,
          attentionRequiredAt: automatic ? null : now,
        },
        select: { id: true },
      });
      return { documentId: doc.id, automatic, created: true };
    });
    if (r.created) {
      emitEvent("tickets.pending", { supplierBookingId: booking.id, documentId: r.documentId, reason: opts.reason, automatic: r.automatic }, "warn");
      // F47, SUP-4: without evidence the read waits for staff, so they are told now.
      if (!r.automatic) emitEvent("document.attention", { documentId: r.documentId, supplierBookingId: booking.id, reason: "ticket_read_needs_staff", ageMs: 0 }, "warn");
    }
    return { documentId: r.documentId, automatic: r.automatic, kind: "ticket_codes" };
  },

  /**
   * A live booking's voucher row, idempotent: the pending or valid voucher
   * when there is one, otherwise a new pending row due now. Downloading it is
   * automatic: for an offer whose confirm issues no tickets there is nothing
   * to issue, and for one that does the confirm already issued them.
   */
  async ensureVoucherPending(db: Db, booking: Pick<SupplierBooking, "id" | "orderId" | "orderItemId" | "bookingKind">, now: Date): Promise<string> {
    if (!booking.orderItemId) throw new Error("document.service: drill bookings have no document rows");
    if (pdfKindFor(booking) !== "voucher_pdf") throw new Error("document.service: only live bookings have a voucher row");
    return inTx(db, async (tx) => {
      await lockBooking(tx, booking.id);
      const live = await tx.supplierDocument.findFirst({
        where: { supplierBookingId: booking.id, kind: "voucher_pdf", status: { in: ["pending", "valid"] } },
        orderBy: { version: "desc" },
        select: { id: true },
      });
      if (live) return live.id;
      const doc = await tx.supplierDocument.create({
        data: {
          id: uuidv7(),
          supplierBookingId: booking.id,
          orderId: booking.orderId,
          orderItemId: booking.orderItemId,
          kind: "voucher_pdf",
          version: await nextVersion(tx, booking.id, "voucher_pdf"),
          status: "pending",
          source: "pdf_download",
          nextFetchAt: now,
        },
        select: { id: true },
      });
      return doc.id;
    });
  },

  /**
   * One run of the document job: the F47 sweep, F12 attention, then due
   * reads and downloads, claimed with `locked_until` and `SKIP LOCKED` so
   * two runs never work the same row. Scoped to the source's supplier (or
   * `opts.supplierCode`). Without a source nothing is read; without a store
   * PDFs stay pending. No row is started after `budgetMs`; the lock outlasts
   * the budget plus the slowest row (`TICKET_TIMING`). With `auditMax` and
   * time left, the run then re-reads that many stored objects (SEC-13,
   * `auditStoredObjects`, random sample).
   */
  async runDue(deps: DocumentDeps, opts: { budgetMs: number; max: number; supplierCode?: string; auditMax?: number }): Promise<RunDueResult> {
    const started = Date.now();
    const out: RunDueResult = { swept: 0, attention: 0, claimed: 0, processed: [], outOfTime: false, audited: { checked: 0, refetching: 0 } };
    const code = deps.source?.supplierCode ?? opts.supplierCode ?? null;
    out.swept = await this.sweepMissing(deps, { max: opts.max, supplierCode: code });
    out.attention = await this.raiseAttention(deps, { max: opts.max, supplierCode: code });
    out.attention += await this.raiseVisitDeadline(deps, { max: opts.max, supplierCode: code });
    if (deps.source) await this.workClaimed(deps, deps.source, opts, started, out);
    if (deps.store && (opts.auditMax ?? 0) > 0 && !out.outOfTime && Date.now() - started <= opts.budgetMs) {
      const a = await this.auditStoredObjects(deps, { max: opts.auditMax!, sample: true, supplierCode: code, deadline: started + opts.budgetMs });
      out.audited = { checked: a.checked, refetching: a.refetching };
    }
    return out;
  },

  /**
   * The document step for one booking, right after the engine committed its
   * confirmation (checkout redesign batch 4, CO-40; `afterConfirmed` in the
   * supplier worker). Only that booking's due PDF rows (the voucher of a live
   * booking, a TicketOnly booking's tickets PDF), at most `max`, none started
   * after `budgetMs`: the same claim (`locked_until`, `SKIP LOCKED`, due
   * `next_fetch_at`), download, validation, quarantine and back-off as the
   * documents tick, so it is idempotent with it and with itself. TravelDesk's
   * "voucher not ready" (502) is `not_ready` and backs off like any run.
   * Ticket-code reads (a get-by-id of the booking) stay with the tick, so no
   * booking read follows the confirm call within seconds. Without a source
   * or a store it does nothing.
   */
  async runForBooking(deps: DocumentDeps, supplierBookingId: string, opts: { budgetMs: number; max: number }): Promise<RunDueResult> {
    const out: RunDueResult = { swept: 0, attention: 0, claimed: 0, processed: [], outOfTime: false, audited: { checked: 0, refetching: 0 } };
    if (!deps.source || !deps.store) return out;
    await this.workClaimed(deps, deps.source, { ...opts, supplierBookingId, pdfOnly: true }, Date.now(), out);
    return out;
  },

  /** `runDue`'s reads and downloads: claim due rows, then work them one by one within the budget. `supplierBookingId` and `pdfOnly` narrow the claim (`runForBooking`). */
  async workClaimed(
    deps: DocumentDeps,
    source: DocumentSource,
    opts: { budgetMs: number; max: number; supplierBookingId?: string; pdfOnly?: boolean },
    started: number,
    out: RunDueResult,
  ): Promise<void> {
    const now = deps.now();
    const lockUntil = after(now, Math.max(TICKET_TIMING.claimLockMs, opts.budgetMs + TICKET_TIMING.rowAllowanceMs));
    const noIssue = source.documentReadIssuesTickets === "no";
    const onlyBooking = opts.supplierBookingId ?? null;
    const pdfOnly = opts.pdfOnly === true;
    const claimed = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE supplier_documents d SET locked_until = ${lockUntil}, updated_at = now()
      FROM (
        SELECT d2.id FROM supplier_documents d2
        JOIN supplier_bookings b ON b.id = d2.supplier_booking_id
        JOIN suppliers s ON s.id = b.supplier_id
        WHERE d2.status IN ('pending', 'incomplete')
          AND (d2.locked_until IS NULL OR d2.locked_until <= ${now})
          AND b.state = 'confirmed' AND b.order_item_id IS NOT NULL AND s.code = ${source.supplierCode}
          AND (${onlyBooking}::uuid IS NULL OR d2.supplier_booking_id = ${onlyBooking}::uuid)
          AND (
            (d2.kind = 'ticket_codes' AND NOT ${pdfOnly} AND (d2.next_fetch_at <= ${now} OR (${noIssue} AND d2.status = 'pending' AND d2.next_fetch_at IS NULL)))
            OR (d2.kind IN ('tickets_pdf', 'voucher_pdf') AND ${deps.store !== null} AND d2.status = 'pending' AND d2.next_fetch_at <= ${now})
          )
        ORDER BY d2.next_fetch_at NULLS FIRST, d2.created_at
        LIMIT ${opts.max}
        FOR UPDATE OF d2 SKIP LOCKED
      ) due
      WHERE d.id = due.id
      RETURNING d.id`;
    out.claimed = claimed.length;
    for (const { id } of claimed) {
      if (Date.now() - started > opts.budgetMs) {
        out.outOfTime = true;
        await prisma.supplierDocument.updateMany({ where: { id, lockedUntil: lockUntil }, data: { lockedUntil: null } });
        continue;
      }
      const row = await prisma.supplierDocument.findUniqueOrThrow({ where: { id }, include: { supplierBooking: true } });
      const outcome = row.kind === "ticket_codes" ? await this.readCodes(row, row.supplierBooking, deps, "automatic") : await this.downloadPdf(row, row.supplierBooking, deps);
      out.processed.push({ documentId: id, kind: row.kind, outcome });
    }
  },

  /** F47 detection: a confirmed order-item booking missing its document rows gets them (`markTicketsPending`). */
  async sweepMissing(deps: DocumentDeps, opts: { max: number; supplierCode: string | null }): Promise<number> {
    const now = deps.now();
    const missing = await prisma.supplierBooking.findMany({
      where: {
        state: "confirmed",
        orderItemId: { not: null },
        confirmedAt: { lte: after(now, -TICKET_TIMING.sweepGraceMs) },
        // A TicketOnly booking without a codes row; a live booking without a voucher row (its codes row, if any, comes with it).
        OR: [
          { bookingKind: "ticket_only", documents: { none: { kind: "ticket_codes" } } },
          { bookingKind: { not: "ticket_only" }, documents: { none: { kind: "voucher_pdf" } } },
        ],
        ...(opts.supplierCode ? { supplier: { code: opts.supplierCode } } : {}),
      },
      select: { id: true, orderId: true, orderItemId: true, supplier: { select: { code: true } } },
      take: opts.max,
    });
    for (const b of missing) {
      const source = deps.source && deps.source.supplierCode === b.supplier.code ? deps.source : null;
      await this.markTicketsPending(prisma, b, { reason: "no_codes", evidence: null }, now, { source, issuesTicketsAtConfirm: deps.issuesTicketsAtConfirm });
    }
    return missing.length;
  },

  /**
   * F12: a ticket still missing `attentionAfterMs` after confirmation raises
   * attention; at `urgentAt` it is raised again as urgent. Each level is
   * reported once: the urgent report re-stamps `attentionRequiredAt` past
   * the urgent instant.
   */
  async raiseAttention(deps: Pick<DocumentDeps, "now">, opts: { max: number; supplierCode: string | null }): Promise<number> {
    const now = deps.now();
    const rows = await prisma.$queryRaw<{ id: string; supplier_booking_id: string; attention_required_at: Date | null; confirmed_at: Date; service_date: Date; start_minutes: number | null }[]>`
      SELECT d.id, d.supplier_booking_id, d.attention_required_at, b.confirmed_at, b.service_date, b.start_minutes
      FROM supplier_documents d
      JOIN supplier_bookings b ON b.id = d.supplier_booking_id
      JOIN suppliers s ON s.id = b.supplier_id
      WHERE d.status IN ('pending', 'incomplete') AND d.kind IN ('ticket_codes', 'tickets_pdf', 'voucher_pdf')
        AND b.state = 'confirmed' AND b.confirmed_at IS NOT NULL
        AND b.confirmed_at <= ${after(now, -TICKET_TIMING.attentionAfterMs)}
        AND (d.attention_required_at IS NULL OR d.attention_required_at < b.confirmed_at + make_interval(secs => ${TICKET_TIMING.urgentAfterMs / 1000}::double precision))
        AND (${opts.supplierCode}::text IS NULL OR s.code = ${opts.supplierCode})
      ORDER BY b.confirmed_at
      LIMIT ${opts.max}`;
    let raised = 0;
    for (const r of rows) {
      const urgent = urgentAt({ confirmedAt: r.confirmed_at, serviceDate: r.service_date, startMinutes: r.start_minutes })!;
      const ageMs = now.getTime() - r.confirmed_at.getTime();
      const isUrgent = now.getTime() >= urgent.getTime();
      if (r.attention_required_at === null) {
        const n = await prisma.supplierDocument.updateMany({ where: { id: r.id, attentionRequiredAt: null }, data: { attentionRequiredAt: now } });
        if (n.count === 0) continue;
      } else {
        if (!isUrgent || r.attention_required_at.getTime() >= urgent.getTime()) continue;
        const n = await prisma.supplierDocument.updateMany({ where: { id: r.id, attentionRequiredAt: r.attention_required_at }, data: { attentionRequiredAt: now } });
        if (n.count === 0) continue;
      }
      raised++;
      emitEvent("document.attention", { documentId: r.id, supplierBookingId: r.supplier_booking_id, reason: isUrgent ? "ticket_missing_urgent" : "ticket_missing", ageMs }, isUrgent ? "error" : "warn");
    }
    return raised;
  },

  /**
   * The ticket-class deadline before the visit (`TICKET_VISIT_DEADLINE`,
   * review 86 B5-02), for confirmed TicketOnly bookings:
   *  - a ticket document (codes or PDF) that is still pending, incomplete or
   *    failed, with no valid one of its kind for the booking, raises attention
   *    at visit start minus 24 hours and again as urgent at minus 6 hours
   *    (Asia/Dubai), whatever F12 and the retries did before. A booking
   *    confirmed inside that window is first given F12's own grace
   *    (`TICKET_TIMING.attentionAfterMs`): codes normally arrive within it,
   *    and F12 already raises a near-start ticket as urgent at that age;
   *  - a valid or incomplete code set whose earliest ticket `validUntil` day
   *    (the UTC day the supplier wrote, `validityDayOf`) is before the visit
   *    date raises attention on that document once.
   * Each level is reported once: the report stamps `attentionRequiredAt` at
   * or after the level's instant. Codes are never read here.
   */
  async raiseVisitDeadline(deps: Pick<DocumentDeps, "now">, opts: { max: number; supplierCode: string | null }): Promise<number> {
    const now = deps.now();
    // Visits from yesterday (Dubai) to two days ahead: wide enough for every level, narrow enough to stay cheap.
    const day = (ms: number) => new Date(Date.parse(new Date(now.getTime() + DUBAI_OFFSET_MS + ms).toISOString().slice(0, 10)));
    const from = day(-24 * 60 * 60_000);
    const to = day(2 * 24 * 60 * 60_000);
    const missing = await prisma.$queryRaw<{ id: string; supplier_booking_id: string; attention_required_at: Date | null; service_date: Date; start_minutes: number | null }[]>`
      SELECT d.id, d.supplier_booking_id, d.attention_required_at, b.service_date, b.start_minutes
      FROM supplier_documents d
      JOIN supplier_bookings b ON b.id = d.supplier_booking_id
      JOIN suppliers s ON s.id = b.supplier_id
      WHERE d.status IN ('pending', 'incomplete', 'failed') AND d.kind IN ('ticket_codes', 'tickets_pdf') AND d.invalidated_at IS NULL
        AND b.state = 'confirmed' AND b.booking_kind = 'ticket_only'
        AND b.confirmed_at IS NOT NULL AND b.confirmed_at <= ${after(now, -TICKET_TIMING.attentionAfterMs)}
        AND b.service_date >= ${from} AND b.service_date <= ${to}
        AND NOT EXISTS (
          SELECT 1 FROM supplier_documents v
          WHERE v.supplier_booking_id = d.supplier_booking_id AND v.kind = d.kind AND v.status = 'valid' AND v.invalidated_at IS NULL)
        AND (${opts.supplierCode}::text IS NULL OR s.code = ${opts.supplierCode})
      ORDER BY b.service_date, d.id
      LIMIT ${opts.max}`;
    let raised = 0;
    for (const r of missing) {
      const level = visitDeadlineLevel({ serviceDate: r.service_date, startMinutes: r.start_minutes }, now);
      if (!level || (r.attention_required_at && r.attention_required_at.getTime() >= level.at.getTime())) continue;
      const n = await prisma.supplierDocument.updateMany({ where: { id: r.id, attentionRequiredAt: r.attention_required_at }, data: { attentionRequiredAt: now } });
      if (n.count === 0) continue;
      raised++;
      const reason = level.level === "urgent" ? "ticket_missing_before_visit_urgent" : "ticket_missing_before_visit";
      emitEvent("document.attention", { documentId: r.id, supplierBookingId: r.supplier_booking_id, reason }, level.level === "urgent" ? "error" : "warn");
    }

    // Issued tickets that stop being valid before the visit: flagged once (a reissue makes a new document).
    const short = await prisma.$queryRaw<{ id: string; supplier_booking_id: string }[]>`
      SELECT d.id, d.supplier_booking_id
      FROM supplier_documents d
      JOIN supplier_bookings b ON b.id = d.supplier_booking_id
      JOIN suppliers s ON s.id = b.supplier_id
      WHERE d.kind = 'ticket_codes' AND d.status IN ('valid', 'incomplete') AND d.invalidated_at IS NULL AND d.attention_required_at IS NULL
        AND b.state = 'confirmed' AND b.booking_kind = 'ticket_only' AND b.service_date >= ${from}
        AND (SELECT min((t.valid_until AT TIME ZONE 'UTC')::date) FROM supplier_ticket_codes t WHERE t.document_id = d.id) < b.service_date
        AND (${opts.supplierCode}::text IS NULL OR s.code = ${opts.supplierCode})
      ORDER BY d.id
      LIMIT ${opts.max}`;
    for (const r of short) {
      const n = await prisma.supplierDocument.updateMany({ where: { id: r.id, attentionRequiredAt: null }, data: { attentionRequiredAt: now } });
      if (n.count === 0) continue;
      raised++;
      emitEvent("document.attention", { documentId: r.id, supplierBookingId: r.supplier_booking_id, reason: "ticket_validity_before_visit" }, "error");
    }
    return raised;
  },

  /** One document read for a claimed codes row (SUP-4: exactly one call), then its outcome. */
  async readCodes(row: WaitingRow, booking: SupplierBooking, deps: DocumentDeps, mode: "automatic" | "deliberate"): Promise<string> {
    let outcome: TicketReadOutcome;
    if (!deps.source || !booking.supplierBookingId) outcome = { kind: "failed", reason: "no_source" };
    else {
      try {
        outcome = await deps.source.readTickets(booking.supplierBookingId);
      } catch {
        outcome = { kind: "failed", reason: "read_threw" };
      }
    }
    const result = await this.applyTicketRead(row, booking, outcome, deps, mode);
    emitEvent("document.read", { supplierBookingId: booking.id, documentId: row.id, outcome: result, reason: outcome.kind === "failed" ? outcome.reason : undefined });
    return result;
  },

  async applyTicketRead(row: WaitingRow, booking: SupplierBooking, outcome: TicketReadOutcome, deps: DocumentDeps, mode: "automatic" | "deliberate"): Promise<string> {
    const now = deps.now();
    const waiting = row.status === "pending" || row.status === "incomplete";
    const attempts = row.fetchAttempts + (mode === "automatic" && waiting ? 1 : 0);
    const settle = async (result: string, attention = false) => {
      if (mode === "automatic" && waiting) return (await this.backoff(row, booking.id, attempts, now, attention)) === "failed" ? "failed" : result;
      await prisma.supplierDocument.updateMany({ where: { id: row.id }, data: { lockedUntil: null, ...(attention && waiting ? { attentionRequiredAt: row.attentionRequiredAt ?? now } : {}) } });
      return result;
    };
    if (outcome.kind !== "found") return settle(outcome.kind);
    if (!sameIdentity(booking, outcome.identity)) {
      await this.recordQuarantine(booking, "ticket_codes", "wrong_booking", now);
      return settle("wrong_booking", true);
    }
    const ev = outcome.evidence;
    if (ev.kind === "malformed") {
      await this.recordQuarantine(booking, "ticket_codes", "malformed", now);
      return settle("malformed", true);
    }
    if (ev.kind === "none" || ev.set.count === 0) return settle("not_ready");

    let r: PersistResult;
    try {
      r = await prisma.$transaction((tx) => this.persistIssuedTickets(tx, booking, ev.set, now), TX_OPTIONS);
    } catch (e) {
      emitEvent("tickets.persist_failed", { supplierBookingId: booking.id, reason: e instanceof Error ? e.name : "error" }, "error");
      return settle("persist_failed", true);
    }
    reportPersisted(booking.id, r);
    if (r.status === "valid") {
      if (!r.unchanged && r.documentId === row.id) await prisma.supplierDocument.updateMany({ where: { id: r.documentId }, data: { fetchAttempts: attempts } });
      await prisma.supplierDocument.updateMany({ where: { id: row.id, lockedUntil: { not: null } }, data: { lockedUntil: null } });
      return r.unchanged ? "unchanged" : "persisted";
    }
    // Incomplete (F48): keep refetching within the bound.
    const incomplete = await prisma.supplierDocument.findUniqueOrThrow({ where: { id: r.documentId } });
    await prisma.supplierDocument.updateMany({ where: { id: row.id, lockedUntil: { not: null } }, data: { lockedUntil: null } });
    if (mode === "automatic" && (await this.backoff(incomplete, booking.id, attempts, now, true)) === "failed") return "failed";
    return "incomplete";
  },

  /** Download, validate and store a claimed PDF row (F13, TKT-3). */
  async downloadPdf(row: SupplierDocument, booking: SupplierBooking, deps: DocumentDeps): Promise<string> {
    const now = deps.now();
    const attempts = row.fetchAttempts + 1;
    const store = deps.store;
    if (!store || !deps.source || !booking.supplierBookingId) {
      await prisma.supplierDocument.updateMany({ where: { id: row.id }, data: { lockedUntil: null } });
      return "no_store";
    }
    const kind: "tickets_pdf" | "voucher_pdf" = row.kind === "voucher_pdf" ? "voucher_pdf" : "tickets_pdf";
    let got: Awaited<ReturnType<DocumentSource["fetchTicketsPdf"]>>;
    try {
      const fetch = kind === "voucher_pdf" ? deps.source.fetchVoucherPdf : deps.source.fetchTicketsPdf;
      got = await fetch.call(deps.source, booking.supplierBookingId, { maxBytes: DOCUMENT_LIMITS.maxPdfBytes });
    } catch {
      got = { kind: "failed", reason: "fetch_threw" };
    }
    if (got.kind === "not_ready" || got.kind === "failed") return (await this.backoff(row, booking.id, attempts, now, false)) === "failed" ? "failed" : got.kind;
    if (got.kind === "too_large") {
      await this.recordQuarantine(booking, kind, "too_large", now);
      return (await this.backoff(row, booking.id, attempts, now, true)) === "failed" ? "failed" : "too_large";
    }
    const verdict = validatePdf(got.bytes, { maxBytes: DOCUMENT_LIMITS.maxPdfBytes });
    if (!verdict.ok) {
      await this.recordQuarantine(booking, kind, verdict.reason, now, { sha256: got.bytes.byteLength ? sha256Of(got.bytes) : null, byteSize: got.bytes.byteLength });
      return (await this.backoff(row, booking.id, attempts, now, true)) === "failed" ? "failed" : verdict.reason;
    }
    // No orphaned objects: the key is recorded on the pending row before the
    // put, so a run killed between the put and the commit leaves the key in
    // the database. The next attempt deletes that object before it records a
    // new key; a row given up as `failed` keeps it for retention and erasure,
    // which delete by `storage_key` whatever the status.
    if (row.storageKey) {
      try {
        await store.delete(row.storageKey);
      } catch {
        emitEvent("document.store_error", { documentId: row.id, operation: "delete", reason: "stale_delete_failed" }, "error");
        return (await this.backoff(row, booking.id, attempts, now, false)) === "failed" ? "failed" : "store_error";
      }
    }
    // The key is random and carries nothing else (TKT-3, OBJECT_KEY).
    const key = `${storageEnvironment()}/${randomBytes(16).toString("hex")}`;
    const recorded = await prisma.supplierDocument.updateMany({ where: { id: row.id, status: "pending", storageKey: row.storageKey }, data: { storageKey: key } });
    if (recorded.count === 0) {
      await prisma.supplierDocument.updateMany({ where: { id: row.id, status: "pending" }, data: { lockedUntil: null } });
      return "lost_race";
    }
    try {
      await store.put(key, got.bytes, "application/pdf");
    } catch {
      emitEvent("document.store_error", { documentId: row.id, operation: "put", reason: "put_failed" }, "error");
      // The put may still have landed (a timeout after the upload). The key stays recorded until its object is gone.
      try {
        await store.delete(key);
        await prisma.supplierDocument.updateMany({ where: { id: row.id, storageKey: key }, data: { storageKey: null } });
      } catch {
        emitEvent("document.store_error", { documentId: row.id, operation: "delete", reason: "orphan_delete_failed" }, "error");
      }
      return (await this.backoff(row, booking.id, attempts, now, false)) === "failed" ? "failed" : "store_error";
    }
    let superseded: { id: string; version: number }[] = [];
    let won = false;
    try {
      won = await prisma.$transaction(async (tx) => {
        await lockBooking(tx, booking.id);
        const old = await tx.supplierDocument.findMany({ where: { supplierBookingId: booking.id, kind, status: "valid" }, select: { id: true, version: true } });
        // Superseded objects are kept (retention) and never served.
        for (const o of old) await tx.supplierDocument.update({ where: { id: o.id }, data: { status: "superseded", invalidatedAt: now } });
        superseded = old;
        const n = await tx.supplierDocument.updateMany({
          where: { id: row.id, status: "pending", storageKey: key },
          data: {
            status: "valid",
            storageKey: key,
            sha256: verdict.sha256,
            byteSize: verdict.byteSize,
            contentType: "application/pdf",
            source: "pdf_download",
            validatedAt: now,
            nextFetchAt: null,
            lockedUntil: null,
            attentionRequiredAt: null,
            quarantineReason: null,
            fetchAttempts: attempts,
          },
        });
        if (n.count === 0) throw new Error("row_moved");
        // A valid PDF can move the deal to Fulfilled / tickets issued (review C2A-03).
        if (booking.orderId) await enqueueCrmSyncForOrders(tx, [booking.orderId]);
        return true;
      }, TX_OPTIONS);
    } catch {
      won = false;
    }
    if (!won) {
      let deleted = true;
      await store.delete(key).catch(() => {
        deleted = false;
        emitEvent("document.store_error", { documentId: row.id, operation: "delete", reason: "orphan_delete_failed" }, "error");
      });
      // Forget the key only once its object is gone; otherwise it stays recorded for the next attempt or retention.
      if (deleted) await prisma.supplierDocument.updateMany({ where: { id: row.id, storageKey: key }, data: { storageKey: null } });
      await prisma.supplierDocument.updateMany({ where: { id: row.id, status: "pending" }, data: { lockedUntil: null } });
      return "lost_race";
    }
    for (const s of superseded) emitEvent("document.superseded", { documentId: s.id, kind, version: s.version });
    emitEvent("document.fetched", { documentId: row.id, kind: row.kind, version: row.version, byteSize: verdict.byteSize });
    // After the commit and best effort: the outbox's own dedup key makes a repeat harmless (TKT-6).
    if (booking.orderId && booking.orderItemId) {
      try {
        await (deps.notifyTicketsReady ?? defaultNotify)({ orderId: booking.orderId, orderItemId: booking.orderItemId, documentVersion: row.version });
      } catch {
        // The status page and download work without the message (F14).
      }
      await recordTicketReady(booking.id, booking.orderId, booking.orderItemId, row.version);
    }
    return "stored";
  },

  /** Retry later within the bound, or give up to a human (`failed` + attention). */
  async backoff(row: WaitingRow, bookingId: string, attempts: number, now: Date, attention: boolean): Promise<"retry" | "failed"> {
    if (attempts >= TICKET_TIMING.maxAttempts) {
      await prisma.supplierDocument.updateMany({
        where: { id: row.id, status: row.status },
        data: { status: "failed", fetchAttempts: attempts, nextFetchAt: null, lockedUntil: null, attentionRequiredAt: now },
      });
      emitEvent("document.attention", { documentId: row.id, supplierBookingId: bookingId, reason: "attempts_exhausted" }, "error");
      return "failed";
    }
    await prisma.supplierDocument.updateMany({
      where: { id: row.id, status: row.status },
      data: { fetchAttempts: attempts, nextFetchAt: after(now, backoffFor(attempts)), lockedUntil: null, ...(attention ? { attentionRequiredAt: row.attentionRequiredAt ?? now } : {}) },
    });
    return "retry";
  },

  /** A rejected supplier answer as its own `quarantined` version: no codes, no object, never served (F13). */
  async recordQuarantine(booking: BookingRef, kind: DocumentKind, reason: string, now: Date, extra: { sha256?: string | null; byteSize?: number | null } = {}): Promise<string> {
    const id = await prisma.$transaction(async (tx) => {
      await lockBooking(tx, booking.id);
      const doc = await tx.supplierDocument.create({
        data: {
          id: uuidv7(),
          supplierBookingId: booking.id,
          orderId: booking.orderId,
          orderItemId: booking.orderItemId,
          kind,
          version: await nextVersion(tx, booking.id, kind),
          status: "quarantined",
          source: kind === "ticket_codes" ? "document_read" : "pdf_download",
          quarantineReason: reason,
          sha256: extra.sha256 ?? null,
          byteSize: extra.byteSize ?? null,
          attentionRequiredAt: now,
          invalidatedAt: now,
        },
        select: { id: true },
      });
      return doc.id;
    }, TX_OPTIONS);
    emitEvent("document.quarantined", { documentId: id, kind, reason }, "warn");
    emitEvent("document.attention", { documentId: id, supplierBookingId: booking.id, reason }, "warn");
    return id;
  },

  /**
   * A PDF for the download route (ownership is the route's job). Only a
   * valid, customer-visible `tickets_pdf` or `voucher_pdf` is ever returned,
   * read under the size cap and checked against its sha256. A missing or
   * changed object is quarantined and refetched from the supplier (SEC-13:
   * Storage objects are not in database backups; F36). A store that cannot
   * be reached answers `no_store`: nothing is quarantined for a transient fault.
   */
  async readServable(documentId: string, now: Date = new Date()): Promise<ServableDocument> {
    const doc = await prisma.supplierDocument.findUnique({ where: { id: documentId } });
    if (!doc || !PDF_KINDS.includes(doc.kind as DocumentKind)) return { kind: "unavailable", reason: "not_found" };
    if (doc.status !== "valid" || !doc.customerVisible || !doc.storageKey || !doc.sha256 || !doc.orderId || !doc.orderItemId) return { kind: "unavailable", reason: "not_valid" };
    const store = getDocumentStore();
    if (!store) return { kind: "unavailable", reason: "no_store" };
    const checked = await this.checkObject(doc, store, now);
    if (checked.kind !== "ok") return checked.kind === "refetching" ? { kind: "unavailable", reason: "refetching" } : { kind: "unavailable", reason: "no_store" };
    return { kind: "ok", bytes: checked.bytes, contentType: "application/pdf", document: { id: doc.id, orderId: doc.orderId, orderItemId: doc.orderItemId, kind: doc.kind, version: doc.version } };
  },

  /** Read a valid object and compare it with its row; on a miss or mismatch, quarantine and refetch (F36). */
  async checkObject(doc: SupplierDocument, store: DocumentStore, now: Date): Promise<{ kind: "ok"; bytes: Uint8Array } | { kind: "refetching" } | { kind: "store_error" }> {
    let bytes: Uint8Array | null;
    try {
      bytes = await store.get(doc.storageKey!, { maxBytes: DOCUMENT_LIMITS.maxPdfBytes });
    } catch {
      emitEvent("document.store_error", { documentId: doc.id, operation: "get", reason: "get_failed" }, "error");
      return { kind: "store_error" };
    }
    const reason = bytes === null ? "object_missing" : bytes.byteLength !== doc.byteSize || sha256Of(bytes) !== doc.sha256 ? "checksum_mismatch" : null;
    if (reason === null) return { kind: "ok", bytes: bytes! };
    const replacement = await prisma.$transaction(async (tx) => {
      await lockBooking(tx, doc.supplierBookingId);
      const n = await tx.supplierDocument.updateMany({ where: { id: doc.id, status: "valid" }, data: { status: "quarantined", quarantineReason: reason, invalidatedAt: now, attentionRequiredAt: now } });
      if (n.count === 0) return null;
      // The document is no longer valid: the deal's ticket status goes back (review C2A-03).
      if (doc.orderId) await enqueueCrmSyncForOrders(tx, [doc.orderId]);
      const pending = await tx.supplierDocument.findFirst({ where: { supplierBookingId: doc.supplierBookingId, kind: doc.kind, status: "pending" }, select: { id: true } });
      if (pending) {
        // Only the due time: a run that holds the row keeps its lock and finishes (no second get-by-id).
        await tx.supplierDocument.update({ where: { id: pending.id }, data: { nextFetchAt: now } });
        return pending.id;
      }
      const created = await tx.supplierDocument.create({
        data: {
          id: uuidv7(),
          supplierBookingId: doc.supplierBookingId,
          orderId: doc.orderId,
          orderItemId: doc.orderItemId,
          kind: doc.kind,
          version: await nextVersion(tx, doc.supplierBookingId, doc.kind as DocumentKind),
          status: "pending",
          source: "pdf_download",
          issuedEvidence: doc.issuedEvidence,
          customerVisible: doc.customerVisible,
          nextFetchAt: now,
          attentionRequiredAt: now,
        },
        select: { id: true },
      });
      return created.id;
    }, TX_OPTIONS);
    if (replacement) {
      emitEvent("document.quarantined", { documentId: doc.id, kind: doc.kind, reason }, "warn");
      emitEvent("document.refetch_requested", { documentId: replacement, reason });
      emitEvent("document.attention", { documentId: doc.id, supplierBookingId: doc.supplierBookingId, reason }, "warn");
    }
    return { kind: "refetching" };
  },

  /**
   * SEC-13 audit: re-read up to `max` valid PDFs and refetch any whose object
   * is missing or changed. By id cursor (`afterId`), or with `sample` a
   * uniform random sample, which needs no cursor state: the documents tick
   * checks a few objects per run, so each one is re-read about every
   * (valid PDFs / `max`) runs on average. `supplierCode` limits it to one
   * supplier's bookings; no object is started after `deadline` (epoch ms).
   */
  async auditStoredObjects(
    deps: Pick<DocumentDeps, "store" | "now">,
    opts: { max: number; afterId?: string; sample?: boolean; supplierCode?: string | null; deadline?: number },
  ): Promise<{ checked: number; refetching: number; lastId: string | null }> {
    if (!deps.store || opts.max <= 0) return { checked: 0, refetching: 0, lastId: null };
    const supplier = opts.supplierCode ? { supplierBooking: { supplier: { code: opts.supplierCode } } } : {};
    let docs: SupplierDocument[];
    if (opts.sample) {
      const ids = await prisma.$queryRaw<{ id: string }[]>`
        SELECT d.id FROM supplier_documents d
        JOIN supplier_bookings b ON b.id = d.supplier_booking_id
        JOIN suppliers s ON s.id = b.supplier_id
        WHERE d.kind IN ('tickets_pdf', 'voucher_pdf') AND d.status = 'valid'
          AND (${opts.supplierCode ?? null}::text IS NULL OR s.code = ${opts.supplierCode ?? null})
        ORDER BY random()
        LIMIT ${opts.max}`;
      docs = ids.length ? await prisma.supplierDocument.findMany({ where: { id: { in: ids.map((r) => r.id) }, status: "valid" } }) : [];
    } else {
      docs = await prisma.supplierDocument.findMany({
        where: { kind: { in: PDF_KINDS }, status: "valid", ...supplier, ...(opts.afterId ? { id: { gt: opts.afterId } } : {}) },
        orderBy: { id: "asc" },
        take: opts.max,
      });
    }
    let checked = 0;
    let refetching = 0;
    for (const d of docs) {
      if (opts.deadline !== undefined && Date.now() > opts.deadline) break;
      checked++;
      if ((await this.checkObject(d, deps.store, deps.now())).kind === "refetching") refetching++;
    }
    return { checked, refetching, lastId: docs[checked - 1]?.id ?? null };
  },

  /**
   * Per order item: what the customer may see (summaries of customer-visible
   * PDFs that are valid or still pending; never a storage key, checksum or
   * code) and the fulfilment state (rule in the header comment).
   */
  async listForOrder(orderId: string): Promise<OrderItemTickets[]> {
    const [items, bookings] = await Promise.all([
      prisma.orderItem.findMany({ where: { orderId }, select: { id: true }, orderBy: { id: "asc" } }),
      prisma.supplierBooking.findMany({ where: { orderId, state: "confirmed", orderItemId: { not: null } }, select: { id: true, orderItemId: true } }),
    ]);
    const docs = bookings.length
      ? await prisma.supplierDocument.findMany({ where: { supplierBookingId: { in: bookings.map((b) => b.id) } }, orderBy: [{ kind: "asc" }, { version: "desc" }] })
      : [];
    return items.map((item) => {
      const booking = bookings.find((b) => b.orderItemId === item.id);
      if (!booking) return { orderItemId: item.id, fulfilment: "not_applicable" as const, documents: [] };
      const mine = docs.filter((d) => d.supplierBookingId === booking.id);
      const visible = mine.filter((d) => PDF_KINDS.includes(d.kind as DocumentKind) && d.customerVisible && (d.status === "valid" || d.status === "pending"));
      return { orderItemId: item.id, fulfilment: fulfilmentOf(mine), documents: visible.map(summary) };
    });
  },

  /**
   * Ask for a fresh copy of a document's kind (staff, or the customer's
   * "something is wrong" path). The current valid version stays served until
   * the new one replaces it. A codes read is automatic only when issuance is
   * evidenced; otherwise it waits for `deliberateRead`.
   */
  async requestRefetch(documentId: string, reason: string, now: Date = new Date()): Promise<void> {
    const doc = await prisma.supplierDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw Errors.notFound("Document");
    const target = await prisma.$transaction(async (tx) => {
      await lockBooking(tx, doc.supplierBookingId);
      const waiting = await tx.supplierDocument.findFirst({
        where: { supplierBookingId: doc.supplierBookingId, kind: doc.kind, status: { in: doc.kind === "ticket_codes" ? ["pending", "incomplete"] : ["pending"] } },
        orderBy: { version: "desc" },
      });
      const evidence = waiting?.issuedEvidence ?? doc.issuedEvidence ?? (doc.status === "valid" || doc.status === "superseded" ? doc.source : null);
      const automatic = doc.kind !== "ticket_codes" || evidence !== null;
      if (waiting) {
        // The lock is left alone: a run holding the row finishes its one read; the next run picks the row up.
        await tx.supplierDocument.update({ where: { id: waiting.id }, data: { issuedEvidence: evidence, nextFetchAt: automatic ? now : waiting.nextFetchAt, fetchAttempts: 0 } });
        return waiting.id;
      }
      const created = await tx.supplierDocument.create({
        data: {
          id: uuidv7(),
          supplierBookingId: doc.supplierBookingId,
          orderId: doc.orderId,
          orderItemId: doc.orderItemId,
          kind: doc.kind,
          version: await nextVersion(tx, doc.supplierBookingId, doc.kind as DocumentKind),
          status: "pending",
          source: doc.kind === "ticket_codes" ? "document_read" : "pdf_download",
          issuedEvidence: evidence,
          customerVisible: doc.customerVisible,
          nextFetchAt: automatic ? now : null,
          attentionRequiredAt: automatic ? null : now,
        },
        select: { id: true },
      });
      return created.id;
    }, TX_OPTIONS);
    emitEvent("document.refetch_requested", { documentId: target, reason });
  },

  /**
   * The deliberate document read (SUP-4 document step, Q-T1): staff with
   * `tickets.resend` ask the supplier once for this booking's tickets.
   * Audited with ids and the outcome code only.
   */
  async deliberateRead(actor: Actor, supplierBookingId: string, deps: DocumentDeps): Promise<{ outcome: string }> {
    requirePermission(actor, "tickets.resend");
    const booking = await prisma.supplierBooking.findUnique({ where: { id: supplierBookingId }, include: { supplier: { select: { code: true } } } });
    if (!booking) throw Errors.notFound("Supplier booking");
    if (booking.state !== "confirmed" || !booking.orderItemId || !booking.supplierBookingId) throw Errors.conflict("Tickets are read only for a confirmed order-item booking");
    if (!deps.source || deps.source.supplierCode !== booking.supplier.code) return { outcome: "no_source" };
    const now = deps.now();
    const { documentId } = await this.markTicketsPending(prisma, booking, { reason: "no_codes", evidence: null, force: true }, now, deps);
    const claimed = await prisma.supplierDocument.updateMany({
      where: { id: documentId, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
      data: { lockedUntil: after(now, TICKET_TIMING.claimLockMs) },
    });
    if (claimed.count === 0) return { outcome: "busy" };
    const row = await prisma.supplierDocument.findUniqueOrThrow({ where: { id: documentId } });
    const outcome = await this.readCodes(row, booking, deps, "deliberate");
    await audit(actor, "tickets.deliberate_read", { type: "supplier_booking", id: booking.id }, { after: { documentId, outcome } });
    return { outcome };
  },
};

/** The fulfilment rule (see the header comment). */
function fulfilmentOf(docs: SupplierDocument[]): TicketFulfilment {
  const of = (kind: DocumentKind) => docs.filter((d) => d.kind === kind);
  const valid = (kind: DocumentKind) => of(kind).some((d) => d.status === "valid");
  if (valid("ticket_codes") && valid("tickets_pdf")) return "issued";
  // A live booking: its voucher includes the tickets. A code set short of the order (TKT-2) still holds it back.
  if (valid("voucher_pdf") && !of("ticket_codes").some((d) => d.status === "incomplete")) return "issued";
  const waitingWithAttention = docs.some((d) => (d.status === "pending" || d.status === "incomplete") && d.attentionRequiredAt !== null);
  const givenUp = (["ticket_codes", "tickets_pdf", "voucher_pdf"] as DocumentKind[]).some(
    (k) => !valid(k) && of(k).some((d) => d.status === "failed") && !of(k).some((d) => d.status === "pending" || d.status === "incomplete"),
  );
  return waitingWithAttention || givenUp ? "attention" : "ticket_pending";
}
