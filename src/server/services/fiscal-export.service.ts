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
 * On (and from) the 1st of each month, Dubai calendar, every closed month
 * since the start that has not been sent yet, oldest first, one per run (so a
 * month missed while the job or the address was missing still goes), goes
 * once to `FISCAL_ACCOUNTANT_EMAIL` with the CSV attached
 * (`fiscal-export-csv.ts`), through the same email adapter as every other
 * email. Off while that variable is empty or while `FISCAL_DOCUMENTS_START_AT`
 * is unset; a month that ended before the start is not exported. A month with
 * no document still sends an empty CSV, so the accountant knows it is empty.
 *
 * Once per month (review 109d R2): a `fiscal_exports` row per (environment,
 * period) is claimed and marked in flight (`unknown` / `in_flight`) BEFORE the
 * send, and the provider idempotency key is fixed per period and generation.
 * A row left in flight (the function died after the provider may have
 * accepted it) becomes an unknown outcome for staff, never a second email. A
 * definite failure is retried with a back-off up to `EXPORT_MAX_ATTEMPTS`;
 * staff can send a month again (`requeueExport`, step-up and audit). Every failure and every unknown outcome raises a
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
  skipped?: "off" | "switch_off" | "start_at_missing" | "before_start" | "allowlist" | "not_due" | "no_time";
  /** Set when a period was attempted. */
  period?: string;
  status?: "sent" | "failed" | "unknown";
  documents?: number;
  lines?: number;
}

/** The month's documents of one environment, in number order (invoices, then credit notes). */
export async function exportDocuments(environment: "production" | "test", period: string): Promise<ExportDocument[]> {
  const { from, to } = periodBounds(period);
  const rows = await prisma.$queryRaw<
    { display_number: string; doc_type: string; issue_reason: string; issued_at: Date; supply_date: Date; reference: string; refers_to: string | null; buyer_name: string | null; buyer_trn: string | null; erased_at: Date | null; lines: unknown }[]
  >`
    SELECT f.display_number, f.doc_type, f.issue_reason, f.issued_at, f.supply_date, o.reference, r.display_number AS refers_to,
      pa.buyer_name, pa.buyer_trn, pa.erased_at, f.lines
    FROM fiscal_documents f
    JOIN orders o ON o.id = f.order_id
    LEFT JOIN fiscal_documents r ON r.id = f.refers_to_id
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
    refersTo: r.refers_to,
    // R4: only a full tax invoice's buyer (a company) is exported; never a consumer's name.
    buyerLegalName: r.issue_reason === "reissue_full" && !r.erased_at ? r.buyer_name : null,
    buyerTrn: r.issue_reason === "reissue_full" && !r.erased_at ? r.buyer_trn : null,
    lines: (Array.isArray(r.lines) ? (r.lines as FiscalLine[]) : []).map((l) => ({ description: l.description, variant: l.variant, vatCategory: l.vatCategory, netMinor: l.netMinor, vatMinor: l.vatMinor, grossMinor: l.grossMinor })),
  }));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Every closed month from the start's month to the month before `now`, oldest first (review 109d R3). */
export function closedPeriods(startAt: Date, now: Date): string[] {
  const first = dubaiPeriodOf(startAt);
  const last = previousPeriod(dubaiPeriodOf(now));
  const out: string[] = [];
  for (let p = last; p >= first && out.length < 120; p = previousPeriod(p)) out.unshift(p);
  return out;
}

/** The claim marks the row "in flight" before the send (R2): a row left so was killed mid-send and is never re-sent automatically. */
const IN_FLIGHT = "in_flight";

export async function runMonthlyExport(now: Date, opts: { e?: Env; send?: ExportSend; deadline?: number } = {}): Promise<ExportRunResult> {
  const e = opts.e ?? readEnv();
  const recipient = e.FISCAL_ACCOUNTANT_EMAIL;
  if (!recipient) return { skipped: "off" };
  // Review 109e S6: no export row is created and nothing is sent while the fiscal documents are switched off.
  if (!e.FISCAL_DOCUMENTS_ENABLED) return { skipped: "switch_off" };
  const startAt = e.FISCAL_DOCUMENTS_START_AT;
  if (!startAt) return { skipped: "start_at_missing" };
  const periods = closedPeriods(startAt, now);
  if (!periods.length) return { skipped: "before_start" };
  if (e.isNonProduction && !isRecipientAllowed(recipient, e.recipientAllowlist)) return { skipped: "allowlist" };
  if (opts.deadline !== undefined && Date.now() + EXPORT_UNIT_MS > opts.deadline) return { skipped: "no_time" };
  const environment = e.isProduction ? "production" : "test";

  // R2: a send that was claimed and never recorded (the function was killed after the provider may have accepted
  // it) is an unknown outcome for staff, never a reason to send again.
  const stale = await prisma.$queryRaw<{ id: string; period: string; attempts: number }[]>`
    UPDATE fiscal_exports SET error_code = 'unknown:killed', locked_until = NULL, updated_at = ${now}
    WHERE environment = ${environment} AND status = 'unknown' AND error_code = ${IN_FLIGHT} AND locked_until < ${now}
    RETURNING id, period, attempts`;
  for (const r of stale) {
    await raiseAttention(prisma, { entityKind: "fiscal_export", entityId: r.id, orderId: null, reason: "export_unknown", detail: { period: r.period, code: "unknown:killed", attempt: r.attempts } }, now);
    emitEvent("fiscal.export_failed", { period: r.period, reason: "unknown:killed" }, "error");
  }

  // R3: every closed month since the start that has not been sent: the oldest one that is due, one per run.
  // A row only for a closed month that has none yet (S6 housekeeping: no write per month on every run).
  const missing = (await prisma.fiscalExport.findMany({ where: { environment, period: { in: periods } }, select: { period: true } })).map((r) => r.period);
  for (const period of periods.filter((p) => !missing.includes(p))) {
    await prisma.$executeRaw`
      INSERT INTO fiscal_exports (id, period, environment, status, attempts, generation, created_at, updated_at)
      VALUES (${uuidv7()}::uuid, ${period}, ${environment}, 'pending', 0, 1, ${now}, ${now})
      ON CONFLICT (environment, period) DO NOTHING`;
  }
  const [claimed] = await prisma.$queryRaw<{ id: string; period: string; attempts: number; generation: number }[]>`
    UPDATE fiscal_exports SET status = 'unknown', error_code = ${IN_FLIGHT}, attempts = attempts + 1,
      locked_until = ${new Date(now.getTime() + EXPORT_LOCK_MS)}, updated_at = ${now}
    WHERE id = (
      SELECT id FROM fiscal_exports
      WHERE environment = ${environment} AND period = ANY(${periods}::text[])
        AND status IN ('pending', 'failed') AND attempts < ${EXPORT_MAX_ATTEMPTS}
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
      ORDER BY period ASC LIMIT 1
      FOR UPDATE SKIP LOCKED)
    RETURNING id, period, attempts, generation`;
  if (!claimed) return { skipped: "not_due" };
  const period = claimed.period;

  const finish = async (status: "failed" | "unknown", code: string, final: boolean): Promise<ExportRunResult> => {
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
    // Nothing was sent: a definite failure.
    return finish("failed", err instanceof Error && err.message === "export_too_large" ? "too_large" : "query_failed", claimed.attempts >= EXPORT_MAX_ATTEMPTS);
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
    // R2: one key per period and generation, so a retry after a definite refusal is the same request to the provider.
    outcome = await send(msg, { idempotencyKey: `fiscal-export-${environment}-${period}-g${claimed.generation}` });
  } catch {
    outcome = { kind: "unknown", httpStatus: null, reason: "network" };
  }
  if (outcome.kind === "sent") {
    await prisma.fiscalExport.update({ where: { id: claimed.id }, data: { status: "sent", sentAt: now, providerId: outcome.providerId.slice(0, 200), errorCode: null, lockedUntil: null, nextAttemptAt: null, documentCount: docs.length, lineCount, updatedAt: now } });
    await resolveAttention(prisma, "fiscal_export", claimed.id, now);
    return { period, status: "sent", documents: docs.length, lines: lineCount };
  }
  if (outcome.kind === "unknown") return finish("unknown", `unknown:${outcome.reason}`, true);
  return finish("failed", `${outcome.retryable ? "retryable" : "definite"}:${outcome.reason}`, !outcome.retryable || claimed.attempts >= EXPORT_MAX_ATTEMPTS);
}

/**
 * Staff "send again" for one month (review 109d R3): after a failure, an unknown outcome or a lost email. Moves the
 * period to the next generation (a new provider idempotency key) and makes it due now; the documents job sends it on
 * its next run. The caller checks the permission and the step-up and audits (`fiscal-staff.service.ts`).
 */
export async function requeueExport(period: string, now: Date, e: Env = readEnv()): Promise<{ period: string; generation: number } | null> {
  const environment = e.isProduction ? "production" : "test";
  const [row] = await prisma.$queryRaw<{ period: string; generation: number }[]>`
    UPDATE fiscal_exports SET status = 'pending', attempts = 0, generation = generation + 1, error_code = NULL,
      locked_until = NULL, next_attempt_at = NULL, sent_at = NULL, provider_id = NULL, updated_at = ${now}
    WHERE environment = ${environment} AND period = ${period} AND (locked_until IS NULL OR locked_until < ${now})
    RETURNING period, generation`;
  if (!row) return null;
  const ex = await prisma.fiscalExport.findFirst({ where: { environment, period }, select: { id: true } });
  if (ex) await resolveAttention(prisma, "fiscal_export", ex.id, now);
  return row;
}
