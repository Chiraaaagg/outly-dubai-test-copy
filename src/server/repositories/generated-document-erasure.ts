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
 *  - A drawn fiscal PDF printed the buyer name: its file row is superseded
 *    (`erased`) and a pending copy of the same snapshot is queued, which the
 *    documents job draws again without the name (same number, never
 *    renumbered). The old object is deleted after commit (A13 over the "copy
 *    sent" of A14: the re-drawn copy is the one kept for the 7 years).
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
    // A drawn file printed the name: superseded, and the same snapshot queued again (drawn without it).
    const drawn = await tx.generatedDocument.findMany({ where: { fiscalDocumentId: { in: fiscalIds }, status: "valid" } });
    for (const row of drawn) {
      const n = await tx.generatedDocument.updateMany({ where: { id: row.id, status: "valid" }, data: { status: "superseded", reasonCode: "erased", updatedAt: now } });
      if (n.count !== 1) continue;
      const top = await tx.generatedDocument.aggregate({ where: { fiscalDocumentId: row.fiscalDocumentId }, _max: { version: true } });
      await tx.generatedDocument.create({
        data: { id: uuidv7(), kind: row.kind, orderId: row.orderId, fiscalDocumentId: row.fiscalDocumentId, templateVersion: row.templateVersion, snapshot: row.snapshot as Prisma.InputJsonValue, version: (top._max.version ?? row.version) + 1, status: "pending" },
      });
      out.generatedDocuments += 1;
    }
    const oldFiscal = await tx.generatedDocument.findMany({ where: { fiscalDocumentId: { in: fiscalIds }, status: { in: ["superseded", "failed"] }, storageKey: { not: null } }, select: { id: true, storageKey: true } });
    for (const r of oldFiscal) if (r.storageKey) out.storageObjects.push({ generatedDocumentId: r.id, storageKey: r.storageKey });
  }

  // Entry files of these orders.
  const entries = await tx.generatedDocument.findMany({ where: { orderId: { in: ids }, kind: { in: [...ENTRY_KINDS] } }, select: { id: true, status: true, snapshot: true, storageKey: true } });
  for (const e of entries) {
    const snapshot = scrubEntrySnapshot(e.snapshot);
    const live = e.status === "pending" || e.status === "valid";
    if (snapshot || live) {
      await tx.generatedDocument.update({
        where: { id: e.id },
        data: { ...(snapshot ? { snapshot } : {}), ...(live ? { status: "superseded", reasonCode: "erased", lockedUntil: null } : {}), updatedAt: now },
      });
      out.generatedDocuments += 1;
    }
    if (e.storageKey) out.storageObjects.push({ generatedDocumentId: e.id, storageKey: e.storageKey });
  }
  return out;
}

/** After the object is gone from private storage, the generated row forgets its key (only a non-live row has one to forget). */
export async function forgetGeneratedStorageKey(generatedDocumentId: string, storageKey: string, db: Tx | typeof prisma = prisma): Promise<void> {
  await db.generatedDocument.updateMany({ where: { id: generatedDocumentId, storageKey, status: { in: ["superseded", "failed"] } }, data: { storageKey: null } });
}
