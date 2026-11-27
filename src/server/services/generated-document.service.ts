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
import { createZxingDecoder, type CodeDecoder } from "../documents/generated/entry/code-decoder";
import { generateEntryDocument, plainEntryLayout, type EntryView } from "../documents/generated/entry/entry-pdf";
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

async function claim(row: Pick<GeneratedDocument, "id" | "attempts">, now: Date): Promise<boolean> {
  const n = await prisma.generatedDocument.updateMany({
    where: { id: row.id, status: "pending", attempts: row.attempts, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
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

async function retryOrFail(row: Pick<GeneratedDocument, "id" | "attempts">, reason: string, now: Date): Promise<"retry" | "failed"> {
  const attempts = row.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await prisma.generatedDocument.updateMany({ where: { id: row.id, status: "pending" }, data: { status: "failed", reasonCode: reason, lockedUntil: null } });
    emitEvent("generated_document.failed", { generatedDocumentId: row.id, reason }, "error");
    return "failed";
  }
  await prisma.generatedDocument.updateMany({ where: { id: row.id, status: "pending" }, data: { reasonCode: reason, lockedUntil: null, nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)) } });
  return "retry";
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
  if (out.replacedChars > 0) emitEvent("generated_document.replaced_chars", { fiscalDocumentId: doc.id, count: out.replacedChars }, "warn");
  return { ok: true, bytes: out.bytes };
}

export interface GeneratedRunSummary {
  skipped?: string;
  drawn: number;
  failed: number;
  retried: number;
}

/** Draws pending fiscal files. Gated by FISCAL_DOCUMENTS_ENABLED. Never throws. */
export async function drawPendingFiscal(opts: { store: DocumentStore | null; now: Date; max: number; e?: Env; fiscalDocumentIds?: readonly string[] }): Promise<GeneratedRunSummary> {
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
    emitEvent("generated_document.sweep_failed", { stage: "fiscal", reason: "query_failed" }, "error");
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

/**
 * Supersedes entry files whose supplier document is no longer the current
 * valid version (a reissue or a quarantine). A file is never served unless its
 * source is valid (also checked at serve time).
 */
export async function supersedeStaleEntries(now: Date): Promise<number> {
  return prisma.$executeRaw`
    UPDATE generated_documents g SET status = 'superseded', reason_code = 'source_not_valid', updated_at = ${now}
    WHERE g.kind IN ('entry_pdf', 'cover_page') AND g.status IN ('pending', 'valid')
      AND NOT EXISTS (SELECT 1 FROM supplier_documents s WHERE s.id = g.source_document_id AND s.status = 'valid' AND s.customer_visible)`;
}

/**
 * Generates entry files for valid supplier PDFs that have none. Gated by
 * BRANDED_ENTRY_PDF_ENABLED and BRANDED_ENTRY_PDF_KINDS. One decoder (one
 * comparison key) per file. Never throws.
 */
export async function generatePendingEntries(opts: {
  store: DocumentStore | null;
  now: Date;
  max: number;
  e?: Env;
  decoder?: () => CodeDecoder;
  /** Limits the run (tests on a shared database). */
  sourceDocumentIds?: readonly string[];
}): Promise<GeneratedRunSummary & { cover: number; none: number }> {
  const e = opts.e ?? env();
  const summary = { drawn: 0, failed: 0, retried: 0, cover: 0, none: 0 } as GeneratedRunSummary & { cover: number; none: number };
  if (!e.BRANDED_ENTRY_PDF_ENABLED) return { ...summary, skipped: "switch_off" };
  if (!opts.store) return { ...summary, skipped: "no_store" };
  try {
    if (!opts.sourceDocumentIds) await supersedeStaleEntries(opts.now);
    const scope = opts.sourceDocumentIds
      ? Prisma.sql`AND s.id IN (${Prisma.join(opts.sourceDocumentIds.length ? opts.sourceDocumentIds.map((id) => Prisma.sql`${id}::uuid`) : [Prisma.sql`NULL::uuid`])})`
      : Prisma.empty;
    const kinds = e.BRANDED_ENTRY_PDF_KINDS;
    if (!kinds.length) return { ...summary, skipped: "no_kinds" };
    const sources = await prisma.$queryRaw<{ id: string }[]>`
      SELECT s.id FROM supplier_documents s
      WHERE s.kind IN (${Prisma.join(kinds)}) AND s.status = 'valid' AND s.customer_visible AND s.storage_key IS NOT NULL
        AND s.order_item_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM generated_documents g WHERE g.source_document_id = s.id)
        ${scope}
      ORDER BY s.validated_at ASC NULLS LAST, s.id ASC
      LIMIT ${opts.max}`;
    for (const s of sources) {
      try {
        await generateEntryFor(s.id, opts.store, opts.now, opts.decoder ?? createZxingDecoder, summary);
      } catch {
        summary.failed++;
        emitEvent("generated_document.failed", { sourceDocumentId: s.id, reason: "error" }, "error");
      }
    }
  } catch {
    emitEvent("generated_document.sweep_failed", { stage: "entry", reason: "query_failed" }, "error");
  }
  return summary;
}

async function generateEntryFor(sourceDocumentId: string, store: DocumentStore, now: Date, makeDecoder: () => CodeDecoder, summary: GeneratedRunSummary & { cover: number; none: number }): Promise<void> {
  const facts = await entryViewFor(sourceDocumentId);
  if (!facts) return;
  const bytes = await store.get(facts.storageKey, { maxBytes: DOCUMENT_LIMITS.maxPdfBytes });
  // The supplier file must be exactly the one validated; a mismatch is the supplier pipeline's to repair (F36).
  if (!bytes || sha256Of(bytes) !== facts.sha256) return;
  // Tickets: the code count must match the units issued (doc 93 §2.2); with no stored count there is nothing to check against.
  const outcome =
    facts.view.kind === "tickets" && facts.expectedUnits === null
      ? ({ kind: "none", reason: "units_unknown" } as const)
      : await generateEntryDocument(bytes, facts.view, makeDecoder(), { date: facts.validatedAt, expectedUnits: facts.expectedUnits, maxBytes: DOCUMENT_LIMITS.maxPdfBytes });
  const base = {
    id: uuidv7(),
    orderId: facts.orderId,
    orderItemId: facts.orderItemId,
    sourceDocumentId,
    sourceSha256: facts.sha256,
    templateVersion: plainEntryLayout.templateVersion,
    snapshot: facts.view as unknown as Prisma.InputJsonValue,
    attempts: 1,
  };
  if (outcome.kind === "none") {
    // Recorded once, so it is not retried in a loop; staff see the reason code. The supplier PDF stays the entry document.
    await prisma.generatedDocument.create({ data: { ...base, kind: "entry_pdf", status: "failed", reasonCode: outcome.reason } });
    summary.none++;
    emitEvent("generated_document.entry_fallback", { sourceDocumentId, reason: outcome.reason }, "warn");
    return;
  }
  const key = newKey();
  await store.put(key, outcome.bytes, "application/pdf");
  try {
    await prisma.generatedDocument.create({
      data: { ...base, kind: outcome.kind, status: "valid", storageKey: key, contentType: "application/pdf", byteSize: outcome.bytes.byteLength, sha256: sha256Of(outcome.bytes), validatedAt: now, reasonCode: outcome.kind === "cover_page" ? outcome.reason : null },
    });
  } catch (err) {
    // A concurrent run won the one-live-row index: drop our object.
    await store.delete(key).catch(() => {});
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
    throw err;
  }
  if (outcome.kind === "cover_page") summary.cover++;
  else summary.drawn++;
}

