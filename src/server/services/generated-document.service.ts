import "server-only";
import { randomBytes } from "node:crypto";
import { Prisma, type GeneratedDocument } from "@prisma/client";
import { prisma } from "../lib/db";
import { env, type Env } from "../lib/env";
import { uuidv7 } from "../lib/ids";
import { emitEvent } from "../lib/structured-events";
import type { DocumentStore } from "../documents/contracts";
import { sha256Of, validatePdf } from "../documents/pdf";
import { storageEnvironment } from "../documents/store";
import { renderFiscalPdf } from "../documents/generated/fiscal/render";
import { isFiscalSnapshot, type FiscalSnapshot } from "../documents/generated/fiscal/snapshot";
import { assertDecoderReady, createZxingDecoder, DecoderUnavailableError, decoderWorks, type CodeDecoder } from "../documents/generated/entry/code-decoder";
import { GUARD_RELEASING_STATES } from "../suppliers/booking-port";
import { generateEntryDocument, isWalkTimeout, plainEntryLayout, type EntryView } from "../documents/generated/entry/entry-pdf";
import { DOCUMENT_LIMITS } from "./document.service";
import { paxLabel } from "./order-status.service";
import { siteConfig } from "@/lib/site-config";
import { FISCAL_KINDS } from "./generated-document.read";

/**
 * Files OUTLYY draws itself (doc 93 §2, §4.4): the PDF of each fiscal
 * document, and the branded entry PDF (or its cover-page fallback).
 *
 * Same private store and key rule as the supplier files; no URL is ever made.
 * Every stored file has its sha256 and size checked on each read; a missing
 * or changed fiscal file is re-drawn from its snapshot (never re-numbered),
 * a missing or changed entry file is re-generated from the current valid
 * supplier file.
 *
 * Switches: fiscal files are drawn and served only while
 * FISCAL_DOCUMENTS_ENABLED is on; entry files only while
 * BRANDED_ENTRY_PDF_ENABLED is on and for the supplier document kinds in
 * BRANDED_ENTRY_PDF_KINDS (tickets first, O12). Both default off.
 *
 * Runs in the documents job only, never in a customer request.
 */

const CLAIM_MS = 3 * 60_000;
const MAX_ATTEMPTS = 5;
const backoffMs = (attempts: number) => Math.min(60, 2 ** attempts) * 60_000;

function newKey(): string {
  return `${storageEnvironment()}/${randomBytes(16).toString("hex")}`;
}

async function claim(row: Pick<GeneratedDocument, "id" | "attempts">, now: Date, kinds: readonly string[] = FISCAL_KINDS): Promise<boolean> {
  const n = await prisma.generatedDocument.updateMany({
    where: { id: row.id, kind: { in: [...kinds] }, status: "pending", attempts: row.attempts, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: new Date(now.getTime() + CLAIM_MS), attempts: { increment: 1 } },
  });
  return n.count === 1;
}

async function storeValid(row: Pick<GeneratedDocument, "id">, bytes: Uint8Array, store: DocumentStore, now: Date): Promise<void> {
  const key = newKey();
  await store.put(key, bytes, "application/pdf");
  await prisma.generatedDocument.updateMany({
    where: { id: row.id, status: "pending" },
    data: { status: "valid", storageKey: key, contentType: "application/pdf", byteSize: bytes.byteLength, sha256: sha256Of(bytes), validatedAt: now, lockedUntil: null, reasonCode: null, nextAttemptAt: null },
  });
}

/**
 * `row.attempts` is the count BEFORE the claim that started this attempt (the claim added one).
 * At `maxAttempts` the row is failed for good: a fiscal file then raises a `fiscal_attention` row for staff
 * (`fiscal_file_failed`, review finding 16), an entry file keeps its `fault_…` reason for the ops alert sweep.
 */
async function retryOrFail(row: Pick<GeneratedDocument, "id" | "attempts">, reason: string, now: Date, maxAttempts = MAX_ATTEMPTS): Promise<"retry" | "failed"> {
  const attempts = row.attempts + 1;
  if (attempts >= maxAttempts) {
    const n = await prisma.generatedDocument.updateMany({ where: { id: row.id, status: "pending" }, data: { status: "failed", reasonCode: reason, lockedUntil: null, updatedAt: now } });
    emitEvent("document.generated_failed", { generatedDocumentId: row.id, reason }, "error");
    if (n.count === 1) await raiseFiscalFileAttention(row.id, reason, now);
    return "failed";
  }
  await prisma.generatedDocument.updateMany({ where: { id: row.id, status: "pending" }, data: { reasonCode: reason, lockedUntil: null, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)), updatedAt: now } });
  return "retry";
}

/**
 * A row whose attempts already reached the limit when it comes up again: its last attempt never returned (the
 * function was killed, or a file hung it). It is failed here instead of being claimed again, so it can never loop
 * (re-review N6). Answers whether this call failed it.
 */
async function failExhausted(row: Pick<GeneratedDocument, "id" | "attempts">, now: Date): Promise<boolean> {
  const n = await prisma.generatedDocument.updateMany({
    where: { id: row.id, status: "pending", attempts: row.attempts, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { status: "failed", reasonCode: "fault_timeout", lockedUntil: null, updatedAt: now },
  });
  if (n.count !== 1) return false;
  emitEvent("document.generated_failed", { generatedDocumentId: row.id, reason: "fault_timeout" }, "error");
  await raiseFiscalFileAttention(row.id, "fault_timeout", now);
  return true;
}

/** A fiscal file failed for good: one open `fiscal_attention` row on its ledger entry, alerted by the ops sweep. */
async function raiseFiscalFileAttention(generatedDocumentId: string, reason: string, now: Date): Promise<void> {
  const g = await prisma.generatedDocument.findUnique({ where: { id: generatedDocumentId }, select: { fiscalDocumentId: true, orderId: true } });
  if (!g?.fiscalDocumentId) return;
  const doc = await prisma.fiscalDocument.findUnique({ where: { id: g.fiscalDocumentId }, select: { ledgerEntryId: true } });
  if (!doc) return;
  const { raiseAttention } = await import("./fiscal-document.service");
  await raiseAttention(prisma, { entityKind: "ledger_entry", entityId: doc.ledgerEntryId, orderId: g.orderId, reason: "fiscal_file_failed", detail: { stage: "draw", code: reason.slice(0, 64) } }, now);
}

/**
 * Staff re-queue of a fiscal file that failed for good (review finding 16):
 * a new pending copy of the latest failed row, same snapshot, next version,
 * when the document has no live file. Drawing never renumbers. Answers
 * whether a copy was queued. The caller checks staff permission and audits.
 */
export async function requeueFailedFiscalFile(fiscalDocumentId: string, now: Date = new Date()): Promise<boolean> {
  const queued = await prisma.$transaction(async (tx) => {
    const live = await tx.generatedDocument.count({ where: { fiscalDocumentId, status: { in: ["pending", "valid"] } } });
    if (live) return false;
    const last = await tx.generatedDocument.findFirst({ where: { fiscalDocumentId, status: "failed" }, orderBy: { version: "desc" } });
    if (!last) return false;
    const top = await tx.generatedDocument.aggregate({ where: { fiscalDocumentId }, _max: { version: true } });
    await tx.generatedDocument.create({ data: { id: uuidv7(), kind: last.kind, orderId: last.orderId, fiscalDocumentId, templateVersion: last.templateVersion, snapshot: last.snapshot as Prisma.InputJsonValue, version: (top._max.version ?? last.version) + 1, status: "pending" } });
    return true;
  });
  if (queued) {
    const doc = await prisma.fiscalDocument.findUnique({ where: { id: fiscalDocumentId }, select: { ledgerEntryId: true } });
    if (doc) {
      const { resolveAttention } = await import("./fiscal-document.service");
      await resolveAttention(prisma, "ledger_entry", doc.ledgerEntryId, now, ["fiscal_file_failed"]);
    }
  }
  return queued;
}

/* ------------------------------------------------------------ fiscal files */

/** Draws one fiscal file from its stored snapshot and the current party row. */
export async function drawFiscal(row: Pick<GeneratedDocument, "fiscalDocumentId" | "snapshot">): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; reason: string }> {
  if (!row.fiscalDocumentId || !isFiscalSnapshot(row.snapshot)) return { ok: false, reason: "bad_snapshot" };
  const snap = row.snapshot as FiscalSnapshot;
  const doc = await prisma.fiscalDocument.findUnique({ where: { id: row.fiscalDocumentId }, include: { party: true } });
  if (!doc) return { ok: false, reason: "fiscal_document_missing" };
  // The drawing must say exactly what the immutable row says.
  if (doc.displayNumber !== snap.displayNumber || doc.grossMinor.toString() !== snap.totals.grossMinor || doc.docType !== snap.docType || JSON.stringify(doc.lines) !== JSON.stringify(snap.lines)) {
    return { ok: false, reason: "snapshot_mismatch" };
  }
  const out = await renderFiscalPdf(snap, doc.party ? { buyerName: doc.party.erasedAt ? null : doc.party.buyerName } : null);
  const verdict = validatePdf(out.bytes, { maxBytes: DOCUMENT_LIMITS.maxPdfBytes });
  if (!verdict.ok) return { ok: false, reason: `validator_${verdict.reason}` };
  if (out.replacedChars > 0) emitEvent("document.generated_replaced_chars", { fiscalDocumentId: doc.id, count: out.replacedChars }, "warn");
  return { ok: true, bytes: out.bytes };
}

export interface GeneratedRunSummary {
  skipped?: string;
  drawn: number;
  failed: number;
  retried: number;
}

/** Draws pending fiscal files. Gated by FISCAL_DOCUMENTS_ENABLED. Never throws. */
export async function drawPendingFiscal(opts: { store: DocumentStore | null; now: Date; max: number; e?: Env; fiscalDocumentIds?: readonly string[]; deadline?: number }): Promise<GeneratedRunSummary> {
  const e = opts.e ?? env();
  const summary: GeneratedRunSummary = { drawn: 0, failed: 0, retried: 0 };
  if (!e.FISCAL_DOCUMENTS_ENABLED) return { ...summary, skipped: "switch_off" };
  if (!opts.store) return { ...summary, skipped: "no_store" };
  try {
    const rows = await prisma.generatedDocument.findMany({
      where: {
        kind: { in: [...FISCAL_KINDS] },
        status: "pending",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: opts.now } }],
        // Limits the run (tests on a shared database).
        ...(opts.fiscalDocumentIds ? { fiscalDocumentId: { in: [...opts.fiscalDocumentIds] } } : {}),
      },
      orderBy: { createdAt: "asc" },
      take: opts.max,
    });
    for (const row of rows) {
      if (opts.deadline !== undefined && Date.now() + 3_000 > opts.deadline) break;
      if (row.attempts >= MAX_ATTEMPTS) {
        if (await failExhausted(row, opts.now)) summary.failed++;
        continue;
      }
      if (!(await claim(row, opts.now))) continue;
      try {
        const drawn = await drawFiscal(row);
        if (!drawn.ok) {
          (await retryOrFail(row, drawn.reason, opts.now)) === "failed" ? summary.failed++ : summary.retried++;
          continue;
        }
        await storeValid(row, drawn.bytes, opts.store, opts.now);
        summary.drawn++;
      } catch {
        (await retryOrFail(row, "draw_error", opts.now)) === "failed" ? summary.failed++ : summary.retried++;
      }
    }
  } catch {
    emitEvent("document.generated_sweep_failed", { stage: "fiscal", reason: "query_failed" }, "error");
  }
  return summary;
}

/* ------------------------------------------------------------ entry files */

function fingerprint(sha: string): string {
  return `${sha.slice(0, 8)}…${sha.slice(-8)}`;
}

function minutesLabel(m: number | null): string | null {
  if (typeof m !== "number" || !Number.isInteger(m) || m < 0 || m >= 1440) return null;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** The entry page's facts for one supplier document (doc 93 §2.4). No code, no price, no supplier net. */
export async function entryViewFor(sourceDocumentId: string): Promise<{ view: EntryView; expectedUnits: number | null; orderId: string; orderItemId: string; sha256: string; storageKey: string; validatedAt: Date } | null> {
  const d = await prisma.supplierDocument.findUnique({
    where: { id: sourceDocumentId },
    include: {
      supplierBooking: { select: { id: true, startMinutes: true, adults: true, children: true, infants: true, guestName: true, supplierBookingId: true, pickupTimeMinutes: true, ticketsValidUntil: true } },
      orderItem: { select: { id: true, titleSnapshot: true, variantNameSnapshot: true, serviceDate: true, timeslot: true, pax: true, pickupHotelNameSnapshot: true, product: { select: { content: true, location: true } } } },
      order: { select: { id: true, reference: true } },
    },
  });
  if (!d || !d.order || !d.orderItem || !d.sha256 || !d.storageKey || d.status !== "valid") return null;
  const b = d.supplierBooking;
  const item = d.orderItem;
  const content = (item.product?.content ?? {}) as { meetingPoint?: unknown; importantInfo?: unknown };
  const time = minutesLabel(b.startMinutes) ?? (item.timeslot && /^\d{2}:\d{2}$/.test(item.timeslot) ? item.timeslot : null);
  const pickupAt = minutesLabel(b.pickupTimeMinutes);
  const where = item.pickupHotelNameSnapshot
    ? `Pickup from ${item.pickupHotelNameSnapshot.slice(0, 120)}${pickupAt ? ` at ${pickupAt} Dubai time` : ", time will be confirmed by the operator"}`
    : typeof content.meetingPoint === "string" && content.meetingPoint.trim()
      ? content.meetingPoint.trim().slice(0, 200)
      : item.product?.location ?? null;
  const tickets = d.kind === "tickets_pdf";
  // Units issued: the codes of the booking's latest valid ticket_codes document (TKT-1); unknown for a voucher.
  let expectedUnits: number | null = null;
  if (tickets) {
    const codesDoc = await prisma.supplierDocument.findFirst({ where: { supplierBookingId: b.id, kind: "ticket_codes", status: "valid" }, orderBy: { version: "desc" }, select: { _count: { select: { codes: true } } } });
    expectedUnits = codesDoc ? codesDoc._count.codes : null;
  }
  const guests = paxLabel({ adult: b.adults, child: b.children, infant: b.infants }) || paxLabel(item.pax);
  const validUntil = b.ticketsValidUntil ? b.ticketsValidUntil.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null;
  const view: EntryView = {
    kind: tickets ? "tickets" : "voucher",
    activity: item.titleSnapshot,
    variant: item.variantNameSnapshot,
    dateLabel: item.serviceDate.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }),
    timeLabel: time ? `${time} Dubai time (UTC+4)` : "Any time on the day, within opening hours",
    guestsLabel: guests,
    leadGuest: b.guestName?.trim() || null,
    bookingReference: d.order.reference,
    operatorReference: b.supplierBookingId,
    validity: validUntil ? `Valid until ${validUntil}` : null,
    where,
    goodToKnow: Array.isArray(content.importantInfo) ? content.importantInfo.filter((x): x is string => typeof x === "string").slice(0, 4).map((x) => x.slice(0, 200)) : [],
    nonRefundable: tickets,
    support: [siteConfig.supportEmail, siteConfig.whatsappNumber ? `WhatsApp +${siteConfig.whatsappNumber}` : null].filter(Boolean).join(" · ") || "outlyy.com",
    sourceLine: `version ${d.version} · fingerprint ${fingerprint(d.sha256)}`,
  };
  return { view, expectedUnits: tickets ? expectedUnits : null, orderId: d.order.id, orderItemId: item.id, sha256: d.sha256, storageKey: d.storageKey, validatedAt: d.validatedAt ?? d.createdAt };
}

/** Supplier booking states that void every document of the booking (R-B5-8), as `ticketAccess.documentOwner` reads them. */
const RELEASED_STATES = Prisma.join(GUARD_RELEASING_STATES.map((st) => Prisma.sql`${st}`));

/**
 * Supersedes entry files whose supplier document is no longer the current
 * valid, customer-visible version (a reissue or a quarantine), or whose
 * booking has ended in a state that voids its documents (a verified
 * cancellation, R-B5-8; review finding 3). A file is never served unless its
 * source passes the same test (also checked at serve time).
 */
export async function supersedeStaleEntries(now: Date): Promise<number> {
  return prisma.$executeRaw`
    UPDATE generated_documents g SET status = 'superseded', reason_code = 'source_not_valid', locked_until = NULL, updated_at = ${now}
    WHERE g.kind IN ('entry_pdf', 'cover_page') AND g.status IN ('pending', 'valid')
      AND NOT EXISTS (
        SELECT 1 FROM supplier_documents s JOIN supplier_bookings b ON b.id = s.supplier_booking_id
        WHERE s.id = g.source_document_id AND s.status = 'valid' AND s.customer_visible AND b.state::text NOT IN (${RELEASED_STATES}))`;
}

/** Entry rows whose last attempt was a fault carry a reason starting with this; the ops alert sweep reports them. */
export const ENTRY_FAULT_PREFIX = "fault_";
/** Attempts of one entry file before it is failed for good (a hanging or throwing source never loops, review finding 11). */
export const ENTRY_MAX_ATTEMPTS = 3;
/** Time one entry file may take: two document walks (10 s each at most) plus decode, build and store. */
export const ENTRY_UNIT_MS = 35_000;

type EntrySummary = GeneratedRunSummary & { cover: number; none: number };

/**
 * Generates entry files for valid supplier PDFs. Gated by
 * BRANDED_ENTRY_PDF_ENABLED and BRANDED_ENTRY_PDF_KINDS. One decoder (one
 * comparison key) per file. Never throws.
 *
 * Every file is claimed FIRST (review finding 11): a `pending` row with an
 * attempt count and a lock is written before the supplier PDF is read, so a
 * file that makes the walk, the decoder or pdf-lib hang or throw is retried
 * with a back-off at most `ENTRY_MAX_ATTEMPTS` times, then failed with a
 * `fault_…` reason that the ops alert sweep reports. A decided fallback (no
 * branded file, reason code) is final for that source version and never
 * retried. A source whose earlier file was superseded (a lost object) is
 * picked again with the next version (finding 15).
 *
 * The code reader is checked before any file (finding 13): if it cannot load,
 * nothing is claimed, a structured error is logged, and the sources simply
 * wait; the ops alert sweep reports sources left waiting.
 */
export async function generatePendingEntries(opts: {
  store: DocumentStore | null;
  now: Date;
  max: number;
  e?: Env;
  decoder?: () => CodeDecoder;
  /** Test seam: the reader readiness check (default: load the zxing reader). */
  decoderReady?: () => Promise<void>;
  /** Test seam: the known-good decode after a reader fault (default: `decoderWorks`). */
  decoderWorks?: () => Promise<boolean>;
  /** Limits the run (tests on a shared database). */
  sourceDocumentIds?: readonly string[];
  /** The job's shared deadline (epoch ms, finding 10): no file is started without `ENTRY_UNIT_MS` left. */
  deadline?: number;
}): Promise<EntrySummary> {
  const e = opts.e ?? env();
  const summary = { drawn: 0, failed: 0, retried: 0, cover: 0, none: 0 } as EntrySummary;
  if (!e.BRANDED_ENTRY_PDF_ENABLED) return { ...summary, skipped: "switch_off" };
  if (!opts.store) return { ...summary, skipped: "no_store" };
  const kinds = e.BRANDED_ENTRY_PDF_KINDS;
  if (!kinds.length) return { ...summary, skipped: "no_kinds" };
  if (opts.deadline !== undefined && Date.now() + ENTRY_UNIT_MS > opts.deadline) return { ...summary, skipped: "no_time" };
  try {
    if (!opts.sourceDocumentIds) await supersedeStaleEntries(opts.now);
    const scope = opts.sourceDocumentIds
      ? Prisma.sql`AND s.id IN (${Prisma.join(opts.sourceDocumentIds.length ? opts.sourceDocumentIds.map((id) => Prisma.sql`${id}::uuid`) : [Prisma.sql`NULL::uuid`])})`
      : Prisma.empty;
    const gscope = opts.sourceDocumentIds
      ? Prisma.sql`AND g.source_document_id IN (${Prisma.join(opts.sourceDocumentIds.length ? opts.sourceDocumentIds.map((id) => Prisma.sql`${id}::uuid`) : [Prisma.sql`NULL::uuid`])})`
      : Prisma.empty;
    // Retries first (oldest first), then new sources; together at most `max`.
    const due = await prisma.$queryRaw<{ id: string; attempts: number }[]>`
      SELECT g.id, g.attempts FROM generated_documents g
      WHERE g.kind IN ('entry_pdf', 'cover_page') AND g.status = 'pending'
        AND (g.locked_until IS NULL OR g.locked_until < ${opts.now})
        AND (g.next_attempt_at IS NULL OR g.next_attempt_at <= ${opts.now})
        ${gscope}
      ORDER BY g.created_at ASC
      LIMIT ${opts.max}`;
    const fresh = due.length >= opts.max
      ? []
      : await prisma.$queryRaw<{ id: string; order_id: string; order_item_id: string; sha256: string; next_version: number }[]>`
      SELECT s.id, s.order_id, s.order_item_id, s.sha256,
        COALESCE((SELECT MAX(x.version) FROM generated_documents x WHERE x.source_document_id = s.id), 0)::int + 1 AS next_version
      FROM supplier_documents s JOIN supplier_bookings b ON b.id = s.supplier_booking_id
      WHERE s.kind IN (${Prisma.join(kinds)}) AND s.status = 'valid' AND s.customer_visible AND s.storage_key IS NOT NULL
        AND s.order_item_id IS NOT NULL AND s.order_id IS NOT NULL AND s.sha256 IS NOT NULL
        AND b.state::text NOT IN (${RELEASED_STATES})
        AND NOT EXISTS (SELECT 1 FROM generated_documents g WHERE g.source_document_id = s.id AND g.status IN ('pending', 'valid', 'failed'))
        -- One live entry file per item (index generated_documents_one_live_entry): a second source of the same item waits,
        -- it never takes a place in the run and fails on the index every tick (re-review N8).
        AND NOT EXISTS (SELECT 1 FROM generated_documents g2 WHERE g2.order_item_id = s.order_item_id AND g2.kind IN ('entry_pdf', 'cover_page') AND g2.status IN ('pending', 'valid'))
        ${scope}
      ORDER BY s.validated_at ASC NULLS LAST, s.id ASC
      LIMIT ${opts.max - due.length}`;
    if (!due.length && !fresh.length) return summary;

    // Finding 13: a reader that cannot load is a job fault, never a property of a file.
    try {
      await (opts.decoderReady ?? assertDecoderReady)();
    } catch (err) {
      emitEvent("document.generated_decoder_unavailable", { reason: err instanceof DecoderUnavailableError ? err.reason : "load_failed" }, "error");
      return { ...summary, skipped: "decoder_unavailable" };
    }

    // Fix round 3 (re-review D1): each row is claimed (a retry) or created (a new source) immediately before its file
    // is processed, never all at the start. A file that hangs or gets the function killed then holds only its own
    // claim; the files behind it were never touched and come up again untouched. `attempts` below is the count before
    // this attempt's claim (the retry/fail arithmetic of `retryOrFail`).
    const work: ({ kind: "due"; r: (typeof due)[number] } | { kind: "fresh"; s: (typeof fresh)[number] })[] = [
      ...due.map((r) => ({ kind: "due" as const, r })),
      ...fresh.map((x) => ({ kind: "fresh" as const, s: x })),
    ];
    for (const w of work) {
      if (opts.deadline !== undefined && Date.now() + ENTRY_UNIT_MS > opts.deadline) break;
      let row: Pick<GeneratedDocument, "id" | "attempts">;
      if (w.kind === "due") {
        // Re-review N6: a row whose last attempt never returned (killed or hung) is failed, not claimed again.
        if (w.r.attempts >= ENTRY_MAX_ATTEMPTS) {
          if (await failExhausted(w.r, opts.now)) summary.failed++;
          continue;
        }
        if (!(await claim(w.r, opts.now, ["entry_pdf", "cover_page"]))) continue;
        row = { id: w.r.id, attempts: w.r.attempts };
      } else {
        const id = uuidv7();
        try {
          await prisma.generatedDocument.create({
            data: {
              id,
              kind: "entry_pdf",
              orderId: w.s.order_id,
              orderItemId: w.s.order_item_id,
              sourceDocumentId: w.s.id,
              sourceSha256: w.s.sha256,
              version: w.s.next_version,
              templateVersion: plainEntryLayout.templateVersion,
              status: "pending",
              attempts: 1,
              lockedUntil: new Date(opts.now.getTime() + CLAIM_MS),
            },
          });
        } catch (err) {
          // A concurrent run claimed this source (or the item has another live entry file): leave it.
          if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
          throw err;
        }
        row = { id, attempts: 0 };
      }
      try {
        await generateEntryFor(row, opts.store, opts.now, opts.decoder ?? createZxingDecoder, summary);
      } catch (err) {
        if (err instanceof DecoderUnavailableError) {
          // Re-review N7: is the reader itself down, or does only this file break it? A known-good decode decides.
          if (await (opts.decoderWorks ?? decoderWorks)()) {
            (await retryOrFail(row, `${ENTRY_FAULT_PREFIX}decoder`, opts.now, ENTRY_MAX_ATTEMPTS)) === "failed" ? summary.failed++ : summary.retried++;
            continue;
          }
          // The reader is down: not this file's fault. Give its attempt back and stop (nothing else is claimed).
          await prisma.generatedDocument.updateMany({ where: { id: row.id, status: "pending" }, data: { attempts: row.attempts, lockedUntil: null, nextAttemptAt: new Date(opts.now.getTime() + 5 * 60_000), reasonCode: "decoder_unavailable" } });
          emitEvent("document.generated_decoder_unavailable", { reason: err.reason }, "error");
          summary.retried++;
          break;
        }
        // Re-review N10: a walk that ran out of time is retried like any fault, never a final decision.
        const reason = isWalkTimeout(err) ? `${ENTRY_FAULT_PREFIX}walk_timeout` : `${ENTRY_FAULT_PREFIX}generate_error`;
        (await retryOrFail(row, reason, opts.now, ENTRY_MAX_ATTEMPTS)) === "failed" ? summary.failed++ : summary.retried++;
      }
    }
  } catch {
    emitEvent("document.generated_sweep_failed", { stage: "entry", reason: "query_failed" }, "error");
  }
  return summary;
}

async function generateEntryFor(row: Pick<GeneratedDocument, "id" | "attempts">, store: DocumentStore, now: Date, makeDecoder: () => CodeDecoder, summary: EntrySummary): Promise<void> {
  const current = await prisma.generatedDocument.findUnique({ where: { id: row.id }, select: { sourceDocumentId: true, sourceSha256: true, status: true } });
  if (!current || current.status !== "pending" || !current.sourceDocumentId) return;
  const sourceDocumentId = current.sourceDocumentId;
  const facts = await entryViewFor(sourceDocumentId);
  if (!facts || facts.sha256 !== current.sourceSha256) {
    // The source is no longer the valid file this row was claimed for: nothing to make from it.
    await prisma.generatedDocument.updateMany({ where: { id: row.id, status: "pending" }, data: { status: "superseded", reasonCode: "source_not_valid", lockedUntil: null } });
    return;
  }
  const bytes = await store.get(facts.storageKey, { maxBytes: DOCUMENT_LIMITS.maxPdfBytes });
  // The supplier file must be exactly the one validated; a mismatch is the supplier pipeline's to repair (F36). Retried, then alerted.
  if (!bytes || sha256Of(bytes) !== facts.sha256) {
    (await retryOrFail(row, `${ENTRY_FAULT_PREFIX}source_unreadable`, now, ENTRY_MAX_ATTEMPTS)) === "failed" ? summary.failed++ : summary.retried++;
    return;
  }
  // Tickets: the code count must match the units issued (doc 93 §2.2); with no stored count there is nothing to check against.
  const outcome =
    facts.view.kind === "tickets" && facts.expectedUnits === null
      ? ({ kind: "none", reason: "units_unknown" } as const)
      : await generateEntryDocument(bytes, facts.view, makeDecoder(), { date: facts.validatedAt, expectedUnits: facts.expectedUnits, maxBytes: DOCUMENT_LIMITS.maxPdfBytes });
  const snapshot = facts.view as unknown as Prisma.InputJsonValue;
  if (outcome.kind === "none") {
    // Decided once for this source version, so it is not retried in a loop; staff see the reason code. The supplier PDF stays the entry document.
    await prisma.generatedDocument.updateMany({ where: { id: row.id, status: "pending" }, data: { status: "failed", reasonCode: outcome.reason, snapshot, lockedUntil: null, updatedAt: now } });
    summary.none++;
    emitEvent("document.entry_fallback", { sourceDocumentId, reason: outcome.reason }, "warn");
    return;
  }
  const key = newKey();
  await store.put(key, outcome.bytes, "application/pdf");
  try {
    const n = await prisma.generatedDocument.updateMany({
      where: { id: row.id, status: "pending" },
      data: { kind: outcome.kind, status: "valid", snapshot, storageKey: key, contentType: "application/pdf", byteSize: outcome.bytes.byteLength, sha256: sha256Of(outcome.bytes), validatedAt: now, lockedUntil: null, nextAttemptAt: null, reasonCode: outcome.kind === "cover_page" ? outcome.reason : null },
    });
    if (n.count !== 1) {
      // Superseded or taken over meanwhile: drop our object.
      await store.delete(key).catch(() => {});
      return;
    }
  } catch (err) {
    await store.delete(key).catch(() => {});
    // The item already has a live file of this kind (one-live-row index): this one is not needed. Closed as a decision
    // (failed), so the source is not picked again every tick (re-review N8).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      await prisma.generatedDocument.updateMany({ where: { id: row.id, status: "pending" }, data: { status: "failed", reasonCode: "duplicate_live", lockedUntil: null, updatedAt: now } });
      return;
    }
    throw err;
  }
  if (outcome.kind === "cover_page") summary.cover++;
  else summary.drawn++;
}
