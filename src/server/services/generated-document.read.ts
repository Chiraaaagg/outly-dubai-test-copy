import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db";
import { env, type Env } from "../lib/env";
import { uuidv7 } from "../lib/ids";
import { emitEvent } from "../lib/structured-events";
import { sha256Of } from "../documents/pdf";
import { getDocumentStore } from "../documents/store";
import { DOCUMENT_LIMITS } from "./document.service";

/**
 * Reading the files OUTLYY draws itself (Group C, doc 93 §4.4): the owner
 * lookup and the integrity-checked read for the download route, and the
 * attachment lookup for the payment email (O8). Kept apart from the drawing
 * code (`generated-document.service.ts`) so a request route never loads a PDF
 * library or the code decoder.
 */

export const FISCAL_KINDS = ["tax_invoice", "tax_credit_note"] as const;
export const ENTRY_KINDS = ["entry_pdf", "cover_page"] as const;
export type GeneratedKind = (typeof FISCAL_KINDS)[number] | (typeof ENTRY_KINDS)[number];

/** Is this kind switched on in this environment? */
export function generatedKindEnabled(kind: string, e: Pick<Env, "FISCAL_DOCUMENTS_ENABLED" | "BRANDED_ENTRY_PDF_ENABLED"> = env()): boolean {
  if (isFiscalKind(kind)) return e.FISCAL_DOCUMENTS_ENABLED;
  if (isEntryKind(kind)) return e.BRANDED_ENTRY_PDF_ENABLED;
  return false;
}

const isFiscalKind = (k: string): k is (typeof FISCAL_KINDS)[number] => (FISCAL_KINDS as readonly string[]).includes(k);
const isEntryKind = (k: string): k is (typeof ENTRY_KINDS)[number] => (ENTRY_KINDS as readonly string[]).includes(k);

/* ------------------------------------------------------------ serving */

export type ServableGenerated =
  | { kind: "ok"; bytes: Uint8Array; document: { id: string; orderId: string; kind: GeneratedKind; displayNumber: string | null } }
  | { kind: "unavailable"; reason: "not_found" | "not_valid" | "switch_off" | "no_store" | "redrawing" };

/**
 * A generated file for the download route (ownership is the route's job).
 * Only a valid file of a switched-on kind, read under the size cap and checked
 * against its sha256. A missing or changed object sends the row back to be
 * re-drawn (fiscal) or superseded and re-generated (entry).
 */
export async function readServableGenerated(id: string, now: Date = new Date(), e: Env = env()): Promise<ServableGenerated> {
  const row = await prisma.generatedDocument.findUnique({ where: { id }, include: { fiscalDocument: { select: { displayNumber: true } } } });
  if (!row || !(isFiscalKind(row.kind) || isEntryKind(row.kind))) return { kind: "unavailable", reason: "not_found" };
  if (!generatedKindEnabled(row.kind, e)) return { kind: "unavailable", reason: "switch_off" };
  if (row.status !== "valid" || !row.storageKey || !row.sha256) return { kind: "unavailable", reason: "not_valid" };
  if (isEntryKind(row.kind)) {
    const src = row.sourceDocumentId ? await prisma.supplierDocument.findUnique({ where: { id: row.sourceDocumentId }, select: { status: true, customerVisible: true } }) : null;
    if (!src || src.status !== "valid" || !src.customerVisible) return { kind: "unavailable", reason: "not_valid" };
  }
  const store = getDocumentStore();
  if (!store) return { kind: "unavailable", reason: "no_store" };
  let bytes: Uint8Array | null;
  try {
    bytes = await store.get(row.storageKey, { maxBytes: DOCUMENT_LIMITS.maxPdfBytes });
  } catch {
    emitEvent("generated_document.store_error", { generatedDocumentId: row.id, operation: "get" }, "error");
    return { kind: "unavailable", reason: "no_store" };
  }
  if (!bytes || bytes.byteLength !== row.byteSize || sha256Of(bytes) !== row.sha256) {
    const reason = bytes ? "checksum_mismatch" : "object_missing";
    if (isFiscalKind(row.kind)) {
      // Re-drawn from the snapshot under the same number: the old row is superseded, a pending copy takes its place.
      await prisma.$transaction(async (tx) => {
        const n = await tx.generatedDocument.updateMany({ where: { id: row.id, status: "valid" }, data: { status: "superseded", reasonCode: reason } });
        if (n.count === 1) {
          await tx.generatedDocument.create({ data: { id: uuidv7(), kind: row.kind, orderId: row.orderId, fiscalDocumentId: row.fiscalDocumentId, templateVersion: row.templateVersion, snapshot: row.snapshot as Prisma.InputJsonValue, version: row.version + 1, status: "pending" } });
        }
      });
    } else {
      await prisma.generatedDocument.updateMany({ where: { id: row.id, status: "valid" }, data: { status: "superseded", reasonCode: reason } });
    }
    emitEvent("generated_document.integrity", { generatedDocumentId: row.id, reason }, "warn");
    return { kind: "unavailable", reason: "redrawing" };
  }
  return { kind: "ok", bytes, document: { id: row.id, orderId: row.orderId, kind: row.kind as GeneratedKind, displayNumber: row.fiscalDocument?.displayNumber ?? null } };
}

/** The order a generated file belongs to, without reading the file (route ownership check). */
export async function generatedOwner(id: string): Promise<{ order: { id: string; reference: string; customerId: string | null }; kind: string } | null> {
  const row = await prisma.generatedDocument.findUnique({ where: { id }, select: { orderId: true, kind: true } });
  if (!row) return null;
  const order = await prisma.order.findUnique({ where: { id: row.orderId }, select: { id: true, reference: true, customerId: true } });
  return order ? { order, kind: row.kind } : null;
}

/** The valid combined invoice file of an order's capture, for the payment email attachment hook (O8). */
export async function invoiceFileForPayment(paymentId: string, e: Env = env()): Promise<{ generatedDocumentId: string; displayNumber: string } | null> {
  if (!e.FISCAL_DOCUMENTS_ENABLED) return null;
  const doc = await prisma.fiscalDocument.findFirst({ where: { paymentId, docType: "tax_invoice" }, select: { displayNumber: true, files: { where: { status: "valid" }, select: { id: true }, take: 1 } } });
  const file = doc?.files[0];
  return file ? { generatedDocumentId: file.id, displayNumber: doc.displayNumber } : null;
}
