import "server-only";
import { Prisma } from "@prisma/client";
import { prisma, type Tx } from "../lib/db";
import { uuidv7 } from "../lib/ids";

/**
 * Group C erasure (owner answer A13; review 102 finding 22): the personal data
 * the fiscal documents and the files OUTLYY draws carry, for the orders an
 * erasure request erases (never a deferred order). Runs inside the erasure
 * transaction (`eraseSubjectRows`).
 *
 *  - `fiscal_document_parties`: buyer name, email, address and TRN blanked and
 *    `erased_at` set. The fiscal document itself (number, dates, lines, VAT,
 *    totals) is append-only and keeps everything; it never held the buyer.
 *  - A drawn fiscal PDF printed the buyer name: its file row, and a row still
 *    being drawn, is superseded (`erased`) and a pending copy of the same
 *    snapshot is queued, which the documents job draws again without the name
 *    (same number, never renumbered). The old object is deleted after commit
 *    (A13 over the "copy sent" of A14: the re-drawn copy is the one kept for
 *    the 7 years; an accountant sign-off item, review 109c N5).
 *  - Retry (review 109c N2): every row of these orders that still holds an
 *    object is marked `erased`; the caller deletes the objects after commit,
 *    the documents job retries any delete that failed (`sweepErasedObjects`),
 *    and a repeat erasure collects them again.
 *  - Entry files (`entry_pdf`, `cover_page`): the lead guest name and the
 *    pickup hotel are cleared from `generated_documents.snapshot`; a live row
 *    is superseded (`erased`) and every stored object of the order's entry
 *    files is deleted after commit (the supplier's own files are erased by the
 *    caller in the same transaction).
 *
 * Nothing here deletes a row.
 */

export interface GeneratedErasure {
  /** Party rows blanked. */
  fiscalParties: number;
  /** Generated file rows rewritten (snapshot scrubbed, superseded or re-queued). */
  generatedDocuments: number;
  /** Stored objects to delete after commit (then `forgetGeneratedStorageKey`). */
  storageObjects: { generatedDocumentId: string; storageKey: string }[];
}

const ENTRY_KINDS = ["entry_pdf", "cover_page"] as const;

/**
 * An entry file's snapshot (`EntryView`) without the person: `leadGuest` cleared, and `where` cleared when it names
 * the pickup hotel ("Pickup from …"). Null when nothing had to change. Pure.
 */
export function scrubEntrySnapshot(snapshot: unknown): Prisma.InputJsonValue | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const s = snapshot as Record<string, unknown>;
  const hasGuest = s.leadGuest !== undefined && s.leadGuest !== null;
  const hasHotel = typeof s.where === "string" && s.where.startsWith("Pickup from ");
  if (!hasGuest && !hasHotel) return null;
  return { ...s, ...(hasGuest ? { leadGuest: null } : {}), ...(hasHotel ? { where: null } : {}) } as Prisma.InputJsonValue;
}

export async function eraseGeneratedForOrders(tx: Tx, orderIds: readonly string[], now: Date): Promise<GeneratedErasure> {
  const out: GeneratedErasure = { fiscalParties: 0, generatedDocuments: 0, storageObjects: [] };
  if (!orderIds.length) return out;
  const ids = [...orderIds];

  // Fiscal documents of these orders whose party still names someone.
  const named = await tx.$queryRaw<{ id: string }[]>`
    SELECT f.id FROM fiscal_documents f JOIN fiscal_document_parties p ON p.fiscal_document_id = f.id
    WHERE f.order_id = ANY(${ids}::uuid[]) AND p.erased_at IS NULL`;
  const fiscalIds = named.map((r) => r.id);
  if (fiscalIds.length) {
    const parties = await tx.fiscalDocumentParty.updateMany({
      where: { fiscalDocumentId: { in: fiscalIds }, erasedAt: null },
      data: { buyerName: null, buyerEmail: null, buyerAddress: null, buyerTrn: null, erasedAt: now },
    });
    out.fiscalParties = parties.count;
    // Every live file of these documents, drawn (it printed the name) or being drawn (review 109c N3: a draw that read
    // the party before this commit would store the name): superseded under a row lock, and the same snapshot queued
    // once more per document, drawn without the name. A draw in flight then finds no pending row and stores nothing,
    // or stores an object it deletes at once (`storeValid`).
    const live = await tx.generatedDocument.findMany({ where: { fiscalDocumentId: { in: fiscalIds }, status: { in: ["pending", "valid"] } }, orderBy: { version: "desc" } });
    const requeued = new Set<string>();
    for (const row of live) {
      const n = await tx.generatedDocument.updateMany({ where: { id: row.id, status: { in: ["pending", "valid"] } }, data: { status: "superseded", reasonCode: "erased", lockedUntil: null, updatedAt: now } });
      if (n.count !== 1 || !row.fiscalDocumentId || requeued.has(row.fiscalDocumentId)) continue;
      requeued.add(row.fiscalDocumentId);
      const top = await tx.generatedDocument.aggregate({ where: { fiscalDocumentId: row.fiscalDocumentId }, _max: { version: true } });
      await tx.generatedDocument.create({
        data: { id: uuidv7(), kind: row.kind, orderId: row.orderId, fiscalDocumentId: row.fiscalDocumentId, templateVersion: row.templateVersion, snapshot: row.snapshot as Prisma.InputJsonValue, version: (top._max.version ?? row.version) + 1, status: "pending" },
      });
      out.generatedDocuments += 1;
    }
  }
  // Review 109c N2: every stored object of a non-live fiscal file of these orders, whatever the party state, so a
  // repeat erasure collects again what an earlier delete missed. Marked `erased` so the documents job retries the
  // delete as well (`sweepErasedObjects`).
  const oldFiscal = await tx.generatedDocument.findMany({
    where: { orderId: { in: ids }, kind: { in: ["tax_invoice", "tax_credit_note"] }, status: { in: ["superseded", "failed"] }, storageKey: { not: null } },
    select: { id: true, storageKey: true, reasonCode: true },
  });
  for (const r of oldFiscal) {
    if (!r.storageKey) continue;
    if (r.reasonCode !== "erased") await tx.generatedDocument.update({ where: { id: r.id }, data: { reasonCode: "erased", updatedAt: now } });
    out.storageObjects.push({ generatedDocumentId: r.id, storageKey: r.storageKey });
  }

  // Entry files of these orders.
  const entries = await tx.generatedDocument.findMany({ where: { orderId: { in: ids }, kind: { in: [...ENTRY_KINDS] } }, select: { id: true, status: true, snapshot: true, storageKey: true, reasonCode: true } });
  for (const e of entries) {
    const snapshot = scrubEntrySnapshot(e.snapshot);
    const live = e.status === "pending" || e.status === "valid";
    // A row holding an object is marked `erased` too, so a failed delete is retried by the documents job (N2).
    const mark = live || (e.storageKey !== null && e.reasonCode !== "erased");
    if (snapshot || mark) {
      await tx.generatedDocument.update({
        where: { id: e.id },
        data: { ...(snapshot ? { snapshot } : {}), ...(live ? { status: "superseded", lockedUntil: null } : {}), ...(mark ? { reasonCode: "erased" } : {}), updatedAt: now },
      });
      if (snapshot || live) out.generatedDocuments += 1;
    }
    if (e.storageKey) out.storageObjects.push({ generatedDocumentId: e.id, storageKey: e.storageKey });
  }
  return out;
}

/** After the object is gone from private storage, the generated row forgets its key (only a non-live row has one to forget). */
export async function forgetGeneratedStorageKey(generatedDocumentId: string, storageKey: string, db: Tx | typeof prisma = prisma): Promise<void> {
  await db.generatedDocument.updateMany({ where: { id: generatedDocumentId, storageKey, status: { in: ["superseded", "failed"] } }, data: { storageKey: null } });
}
