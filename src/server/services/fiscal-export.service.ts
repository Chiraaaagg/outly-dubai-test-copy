import "server-only";
import { prisma } from "../lib/db";
import { env as readEnv, type Env } from "../lib/env";
import { uuidv7 } from "../lib/ids";
import { emitEvent } from "../lib/structured-events";
import { emailAdapter, type EmailOutcome, type EmailSend, type EmailSendOptions } from "../notifications/email.adapter";
import { isRecipientAllowed } from "../notifications/allowlist";
import { dubaiPeriodOf, exportCsv, periodBounds, periodLabel, previousPeriod, type ExportDocument } from "../domain/fiscal-export-csv";
import { dubaiIsoDate, type FiscalLine } from "../documents/generated/fiscal/snapshot";
import { raiseAttention, resolveAttention } from "./fiscal-document.service";

/**
 * Monthly CSV export of the fiscal documents to the accountant (owner
 * decision C-P4, 28 Nov 2026), run by the documents job.
 *
 * On (and from) the 1st of each month, Dubai calendar, the previous month's
 * documents go once to `FISCAL_ACCOUNTANT_EMAIL` with the CSV attached
 * (`fiscal-export-csv.ts`), through the same email adapter as every other
 * email. Off while that variable is empty or while `FISCAL_DOCUMENTS_START_AT`
 * is unset; a month that ended before the start is not exported. A month with
 * no document still sends an empty CSV, so the accountant knows it is empty.
 *
 * Once per month: a `fiscal_exports` row per (environment, period) is
 * claimed with a lock before anything is sent; a sent row is never sent
 * again. A definite failure is retried with a back-off up to
 * `EXPORT_MAX_ATTEMPTS`; an unknown outcome (the provider may have sent it) is
 * never re-sent blindly. Every failure and every unknown outcome raises a
 * staff alert (`fiscal_attention`, entity `fiscal_export`, through the ops
 * alert email); a later success closes it.
 *
 * Non-production sends only to an allowlisted address (as every email).
 */

export const EXPORT_MAX_ATTEMPTS = 5;
const EXPORT_LOCK_MS = 2 * 60_000;
/** Time one export may take: the query, the CSV and one email send. */
export const EXPORT_UNIT_MS = 15_000;
/** A month's documents are bounded; a larger month is a fault to look at, not a silent truncation. */
const MAX_DOCUMENTS = 20_000;

export type ExportSend = (msg: EmailSend, opts: EmailSendOptions) => Promise<EmailOutcome>;

export interface ExportRunResult {
  skipped?: "off" | "start_at_missing" | "before_start" | "allowlist" | "not_due" | "no_time";
  period?: string;
  status?: "sent" | "failed" | "unknown";
  documents?: number;
  lines?: number;
}

/** The month's documents of one environment, in number order (invoices, then credit notes). */
export async function exportDocuments(environment: "production" | "test", period: string): Promise<ExportDocument[]> {
  const { from, to } = periodBounds(period);
  const rows = await prisma.$queryRaw<
    { display_number: string; doc_type: string; issue_reason: string; issued_at: Date; supply_date: Date; reference: string; buyer_name: string | null; erased_at: Date | null; lines: unknown }[]
  >`
    SELECT f.display_number, f.doc_type, f.issue_reason, f.issued_at, f.supply_date, o.reference, pa.buyer_name, pa.erased_at, f.lines
    FROM fiscal_documents f
    JOIN orders o ON o.id = f.order_id
    LEFT JOIN fiscal_document_parties pa ON pa.fiscal_document_id = f.id
    WHERE f.environment = ${environment} AND f.issued_at >= ${from} AND f.issued_at < ${to}
    ORDER BY f.doc_type DESC, f.number ASC
    LIMIT ${MAX_DOCUMENTS + 1}`;
  if (rows.length > MAX_DOCUMENTS) throw new Error("export_too_large");
  return rows.map((r) => ({
    displayNumber: r.display_number,
    docType: r.doc_type === "tax_credit_note" ? "tax_credit_note" : "tax_invoice",
    issueReason: r.issue_reason,
    issueDate: dubaiIsoDate(r.issued_at),
    supplyDate: r.supply_date.toISOString().slice(0, 10),
    orderReference: r.reference,
    buyerName: r.erased_at ? null : r.buyer_name,
    lines: (Array.isArray(r.lines) ? (r.lines as FiscalLine[]) : []).map((l) => ({ description: l.description, variant: l.variant, vatCategory: l.vatCategory, netMinor: l.netMinor, vatMinor: l.vatMinor, grossMinor: l.grossMinor })),
  }));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function runMonthlyExport(now: Date, opts: { e?: Env; send?: ExportSend; deadline?: number } = {}): Promise<ExportRunResult> {
  const e = opts.e ?? readEnv();
  const recipient = e.FISCAL_ACCOUNTANT_EMAIL;
  if (!recipient) return { skipped: "off" };
  const startAt = e.FISCAL_DOCUMENTS_START_AT;
  if (!startAt) return { skipped: "start_at_missing" };
  const period = previousPeriod(dubaiPeriodOf(now));
  if (periodBounds(period).to.getTime() <= startAt.getTime()) return { skipped: "before_start", period };
  if (e.isNonProduction && !isRecipientAllowed(recipient, e.recipientAllowlist)) return { skipped: "allowlist", period };
  if (opts.deadline !== undefined && Date.now() + EXPORT_UNIT_MS > opts.deadline) return { skipped: "no_time", period };
  const environment = e.isProduction ? "production" : "test";

  await prisma.$executeRaw`
    INSERT INTO fiscal_exports (id, period, environment, status, attempts, created_at, updated_at)
    VALUES (${uuidv7()}::uuid, ${period}, ${environment}, 'pending', 0, ${now}, ${now})
    ON CONFLICT (environment, period) DO NOTHING`;
  const [claimed] = await prisma.$queryRaw<{ id: string; attempts: number }[]>`
    UPDATE fiscal_exports SET attempts = attempts + 1, locked_until = ${new Date(now.getTime() + EXPORT_LOCK_MS)}, updated_at = ${now}
    WHERE environment = ${environment} AND period = ${period}
      AND status IN ('pending', 'failed') AND attempts < ${EXPORT_MAX_ATTEMPTS}
      AND (locked_until IS NULL OR locked_until < ${now})
      AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
    RETURNING id, attempts`;
  if (!claimed) return { skipped: "not_due", period };

  const fail = async (status: "failed" | "unknown", code: string, final: boolean): Promise<ExportRunResult> => {
    await prisma.fiscalExport.update({
      where: { id: claimed.id },
      data: {
        status,
        errorCode: code.slice(0, 64),
        lockedUntil: null,
        // A definite failure is retried with a back-off; an unknown outcome, or the last attempt, waits for staff.
        nextAttemptAt: status === "failed" && !final ? new Date(now.getTime() + claimed.attempts * 30 * 60_000) : null,
        ...(final && status === "failed" ? { attempts: EXPORT_MAX_ATTEMPTS } : {}),
        updatedAt: now,
      },
    });
    await raiseAttention(prisma, { entityKind: "fiscal_export", entityId: claimed.id, orderId: null, reason: status === "unknown" ? "export_unknown" : "export_failed", detail: { period, code: code.slice(0, 64), attempt: claimed.attempts } }, now);
    emitEvent("fiscal.export_failed", { period, reason: code.slice(0, 64) }, "error");
    return { period, status };
  };

  let docs: ExportDocument[];
  try {
    docs = await exportDocuments(environment, period);
  } catch (err) {
    return fail("failed", err instanceof Error && err.message === "export_too_large" ? "too_large" : "query_failed", claimed.attempts >= EXPORT_MAX_ATTEMPTS);
  }
  const { csv, lineCount } = exportCsv(docs);
  const label = periodLabel(period);
  const summary = `${docs.length} document${docs.length === 1 ? "" : "s"}, ${lineCount} line${lineCount === 1 ? "" : "s"}`;
  const msg: EmailSend = {
    to: recipient,
    subject: `OUTLYY fiscal documents, ${label}${environment === "test" ? " (TEST)" : ""}`,
    text: `Fiscal documents issued in ${label} (Dubai time): ${summary}. The CSV is attached. All amounts in AED; credit note amounts are negative.\n`,
    html: `<p>Fiscal documents issued in ${escapeHtml(label)} (Dubai time): ${escapeHtml(summary)}.</p><p>The CSV is attached. All amounts in AED; credit note amounts are negative.</p>`,
    attachments: [{ filename: `OUTLYY-fiscal-documents-${period}${environment === "test" ? "-TEST" : ""}.csv`, content: new TextEncoder().encode(csv), contentType: "text/csv" }],
  };
  const send = opts.send ?? ((m: EmailSend, o: EmailSendOptions) => emailAdapter.send(m, o));
  let outcome: EmailOutcome;
  try {
    outcome = await send(msg, { idempotencyKey: `fiscal-export-${environment}-${period}-${claimed.attempts}` });
  } catch {
    outcome = { kind: "unknown", httpStatus: null, reason: "network" };
  }
  if (outcome.kind === "sent") {
    await prisma.fiscalExport.update({ where: { id: claimed.id }, data: { status: "sent", sentAt: now, providerId: outcome.providerId.slice(0, 200), errorCode: null, lockedUntil: null, nextAttemptAt: null, documentCount: docs.length, lineCount, updatedAt: now } });
    await resolveAttention(prisma, "fiscal_export", claimed.id, now);
    return { period, status: "sent", documents: docs.length, lines: lineCount };
  }
  if (outcome.kind === "unknown") return fail("unknown", `unknown:${outcome.reason}`, true);
  return fail("failed", `${outcome.retryable ? "retryable" : "definite"}:${outcome.reason}`, !outcome.retryable || claimed.attempts >= EXPORT_MAX_ATTEMPTS);
}
