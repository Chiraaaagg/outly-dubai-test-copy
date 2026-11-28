import "server-only";
import { prisma, TX_OPTIONS } from "../lib/db";
import { env as readEnv, type Env } from "../lib/env";
import { audit } from "../lib/audit";
import { requirePermission, type Actor } from "../lib/actor";
import { Errors } from "../lib/errors";
import { settingsRepo } from "../repositories/settings.repo";
import { CBUAE_RATE_SETTING_PREFIX, CBUAE_RATE_SOURCE, cbuaeRateFrom, parseAedPerInr } from "../domain/fiscal-fx";
import { isRealSellerText, isRealTrn } from "../documents/generated/fiscal/seller";
import { dubaiIsoDate } from "../documents/generated/fiscal/snapshot";
import { reissueAsFullTaxInvoice, sellerFromEnv, type ReissueOutcome, type ReissueRefusal } from "./fiscal-document.service";
import { verifyStepUp } from "./approval.service";
import { requeueExport } from "./fiscal-export.service";

/**
 * Staff actions on the fiscal documents (Group C, owner decisions C-P1, C-P2,
 * 28 Nov 2026). Both need `payments.reconcile` (finance and administrators)
 * and a fresh authenticator code (the same step-up as accepting a large FX
 * move, `verifyStepUp`), and both are audited, refusals included.
 *
 *  - `recordCbuaeRate`: the CBUAE "AED per 1 INR" rate for a Dubai date, as
 *    published by the UAE Central Bank, typed in by staff. An INR-paid capture
 *    of that date is held (`fx_rate_missing`) until it exists (C-P1). A rate
 *    already used by a document is never changed.
 *  - `reissueFullTaxInvoice`: a simplified invoice reissued as a full tax
 *    invoice for a VAT-registered buyer: the buyer's legal name, 15-digit TRN
 *    and address (C-P2). See `reissueAsFullTaxInvoice`.
 *
 * Audit rows name fields and document numbers, never the buyer's TRN or
 * address values.
 */

export type StepUp = (actor: Actor, code: string) => Promise<string | null>;

const REFUSAL_TEXT: Record<ReissueRefusal, string> = {
  not_found: "No tax invoice has that number",
  not_simplified: "Only a simplified invoice can be reissued as a full tax invoice",
  already_reissued: "This invoice was already reissued",
  refunds_exist: "This payment has a refund or a credit note; reissue it by hand with the accountant",
  bad_snapshot: "The invoice's stored copy cannot be read",
  environment_mismatch: "Production documents cannot be issued from this deployment",
  seller_unconfigured: "The seller details are not configured",
  vat_rule_unconfirmed: "The VAT rules are not signed off by the accountant yet",
  layout_pending: "The production layout is not in place yet",
  series_missing: "The numbering series is missing",
  series_format: "The numbering series is not in the INV-/CN- format",
};

function isRealDate(d: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) return false;
  const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return t.toISOString().slice(0, 10) === d;
}

export function createFiscalStaffService(deps: { stepUp: StepUp; env?: () => Env }) {
  const env = deps.env ?? readEnv;

  async function requireStepUp(actor: Actor, code: string | undefined, action: string, entity: { type: string; id: string }): Promise<void> {
    const failed = await deps.stepUp(actor, code ?? "");
    if (failed) {
      await audit(actor, action, entity, { after: { refused: "step_up_required", stepUp: failed } });
      throw Errors.validation({ totpCode: "The code was not accepted; wait for a new one" });
    }
  }

  return {
    /**
     * Review 109d R3: staff send one month's CSV to the accountant again (a failure, an unknown outcome, a lost
     * email). The documents job sends it on its next run under a new idempotency key.
     */
    async resendExport(actor: Actor, input: { period?: string; totpCode?: string }, now: Date = new Date()): Promise<{ period: string; generation: number }> {
      requirePermission(actor, "payments.reconcile");
      const period = (input.period ?? "").trim();
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw Errors.validation({ period: "The month as YYYY-MM" });
      const entity = { type: "fiscal_export", id: period };
      await requireStepUp(actor, input.totpCode, "fiscal.export_resend_refused", entity);
      const out = await requeueExport(period, now, env());
      if (!out) {
        await audit(actor, "fiscal.export_resend_refused", entity, { after: { refused: "not_found_or_sending" } });
        throw Errors.conflict("That month has not been exported yet, or it is being sent right now", { reason: "not_found_or_sending" });
      }
      await audit(actor, "fiscal.export_resend", entity, { after: { period, generation: out.generation } });
      return out;
    },

    async recordCbuaeRate(actor: Actor, input: { date?: string; aedPerInr?: string; totpCode?: string }, now: Date = new Date()): Promise<{ date: string; aedPerInr: string; replaced: string | null }> {
      requirePermission(actor, "payments.reconcile");
      const date = (input.date ?? "").trim();
      const rate = parseAedPerInr(input.aedPerInr);
      const fields: Record<string, string> = {};
      if (!isRealDate(date)) fields.date = "Use the date as YYYY-MM-DD";
      else if (date > dubaiIsoDate(now)) fields.date = "A rate cannot be entered for a future date";
      if (!rate) fields.aedPerInr = "AED per 1 INR, for example 0.04350 (between 0.0400 and 0.0470)";
      if (Object.keys(fields).length || !rate) throw Errors.validation(fields);
      const key = `${CBUAE_RATE_SETTING_PREFIX}${date}`;
      await requireStepUp(actor, input.totpCode, "fiscal.cbuae_rate_refused", { type: "setting", id: key });
      // Review 109d R7: the "in use" check and the write are one transaction. The rate row is locked FOR UPDATE first;
      // an issuer reads it FOR SHARE inside its own transaction (`cbuaeRateFor`), so either the issuer's document is
      // committed before the check below runs (and the change is refused), or the issuer waits and reads the new rate.
      const written = await prisma.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<{ value: unknown }[]>`SELECT value FROM settings WHERE key = ${key} FOR UPDATE`;
        const prior = locked ? cbuaeRateFrom(date, locked.value) : null;
        if (prior && prior.aedPerInr !== rate) {
          // A rate a document was converted at is part of that document's record: never changed afterwards.
          const [used] = await tx.$queryRaw<{ used: boolean }[]>`
            SELECT EXISTS (SELECT 1 FROM fiscal_documents f, jsonb_array_elements(f.lines) l WHERE l->'source'->>'rateDate' = ${date}) AS used`;
          if (used?.used) return { refused: true as const, prior };
        }
        const value = { aedPerInr: rate, source: CBUAE_RATE_SOURCE, recordedBy: actor.id ?? null, recordedAt: now.toISOString() };
        // `updated_by` is left empty: the actor is in the value and the audit row (no foreign key to satisfy).
        await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
        return { refused: false as const, prior };
      }, TX_OPTIONS);
      if (written.refused) {
        await audit(actor, "fiscal.cbuae_rate_refused", { type: "setting", id: key }, { after: { refused: "rate_in_use", date } });
        throw Errors.conflict("A document was already converted at this date's rate; it cannot be changed", { reason: "rate_in_use" });
      }
      const prior = written.prior;
      settingsRepo.invalidate(key);
      await audit(actor, "fiscal.cbuae_rate_recorded", { type: "setting", id: key }, { before: prior ? { aedPerInr: prior.aedPerInr } : null, after: { aedPerInr: rate, source: CBUAE_RATE_SOURCE, date } });
      return { date, aedPerInr: rate, replaced: prior && prior.aedPerInr !== rate ? prior.aedPerInr : null };
    },

    async reissueFullTaxInvoice(
      actor: Actor,
      input: { displayNumber?: string; legalName?: string; trn?: string; address?: string; totpCode?: string },
      now: Date = new Date(),
    ): Promise<Extract<ReissueOutcome, { kind: "reissued" }>> {
      requirePermission(actor, "payments.reconcile");
      const displayNumber = (input.displayNumber ?? "").trim().toUpperCase();
      const legalName = (input.legalName ?? "").trim().replace(/\s+/g, " ");
      const trn = (input.trn ?? "").replace(/[\s-]/g, "");
      const address = (input.address ?? "").trim().replace(/\s+/g, " ");
      const fields: Record<string, string> = {};
      if (!/^[A-Z][A-Z0-9-]{0,23}[0-9]{1,18}$/.test(displayNumber)) fields.displayNumber = "The invoice number, for example INV-000123";
      if (!isRealSellerText(legalName, 3) || legalName.length > 200) fields.legalName = "The buyer's legal name as on its VAT certificate";
      if (!isRealTrn(trn)) fields.trn = "The buyer's TRN: 15 digits";
      if (!isRealSellerText(address, 10) || address.length > 500) fields.address = "The buyer's registered address";
      if (Object.keys(fields).length) throw Errors.validation(fields);
      const e = env();
      if (!e.FISCAL_DOCUMENTS_ENABLED) throw Errors.conflict("Fiscal documents are switched off", { reason: "switch_off" });
      const entity = { type: "fiscal_document", id: displayNumber };
      await requireStepUp(actor, input.totpCode, "fiscal.reissue_refused", entity);
      const outcome = await reissueAsFullTaxInvoice(displayNumber, { legalName, trn, address }, { now, legalEntity: e.FISCAL_LEGAL_ENTITY, seller: sellerFromEnv(e), productionAllowed: e.isProduction });
      if (outcome.kind === "refused") {
        await audit(actor, "fiscal.reissue_refused", entity, { after: { refused: outcome.reason } });
        throw Errors.conflict(REFUSAL_TEXT[outcome.reason], { reason: outcome.reason });
      }
      await audit(actor, "fiscal.reissued_full", entity, {
        after: { cancelled: outcome.cancelled.displayNumber, creditNote: outcome.creditNote.displayNumber, invoice: outcome.invoice.displayNumber, buyerFields: ["buyerName", "buyerTrn", "buyerAddress"] },
      });
      return outcome;
    },
  };
}

export const fiscalStaffService = createFiscalStaffService({ stepUp: (actor, code) => verifyStepUp(actor, code) });

export interface ReissueRow {
  issuedAt: string;
  /** The cancelled simplified invoice: still downloadable, shown as "Cancelled, replaced by …" (review 109d R8). */
  cancelled: { displayNumber: string; fileId: string | null };
  creditNote: { displayNumber: string; fileId: string | null };
  invoice: { displayNumber: string; fileId: string | null };
}

/** The latest valid file of each fiscal document, or null while it is still being drawn. */
async function validFileIds(ids: string[]): Promise<Map<string, string>> {
  const files = ids.length ? await prisma.generatedDocument.findMany({ where: { fiscalDocumentId: { in: ids }, status: "valid" }, select: { id: true, fiscalDocumentId: true } }) : [];
  return new Map(files.flatMap((f) => (f.fiscalDocumentId ? [[f.fiscalDocumentId, f.id] as [string, string]] : [])));
}

/** The latest reissues (C-P2) for the admin page, with links to their files (review 109d R8). */
export async function listRecentReissues(actor: Actor, limit = 20): Promise<ReissueRow[]> {
  requirePermission(actor, "payments.reconcile");
  const full = await prisma.fiscalDocument.findMany({
    where: { issueReason: "reissue_full" },
    orderBy: { issuedAt: "desc" },
    take: limit,
    select: { id: true, displayNumber: true, issuedAt: true, replaces: { select: { id: true, displayNumber: true, credits: { where: { issueReason: "reissue_cancel" }, select: { id: true, displayNumber: true } } } } },
  });
  const ids = full.flatMap((f) => [f.id, ...(f.replaces ? [f.replaces.id, ...f.replaces.credits.map((c) => c.id)] : [])]);
  const files = await validFileIds(ids);
  return full.flatMap((f) => {
    const cancelled = f.replaces;
    const cn = cancelled?.credits[0];
    if (!cancelled || !cn) return [];
    return [
      {
        issuedAt: f.issuedAt.toISOString(),
        cancelled: { displayNumber: cancelled.displayNumber, fileId: files.get(cancelled.id) ?? null },
        creditNote: { displayNumber: cn.displayNumber, fileId: files.get(cn.id) ?? null },
        invoice: { displayNumber: f.displayNumber, fileId: files.get(f.id) ?? null },
      },
    ];
  });
}

/** The export rows of this environment, newest month first, for the admin page (R3). */
export async function listExports(actor: Actor, e: Env = readEnv()): Promise<{ period: string; status: string; attempts: number; sentAt: string | null; errorCode: string | null }[]> {
  requirePermission(actor, "payments.reconcile");
  const rows = await prisma.fiscalExport.findMany({ where: { environment: e.isProduction ? "production" : "test" }, orderBy: { period: "desc" }, take: 24 });
  return rows.map((r) => ({ period: r.period, status: r.status, attempts: r.attempts, sentAt: r.sentAt?.toISOString() ?? null, errorCode: r.errorCode }));
}

/** The latest CBUAE rates entered, newest date first, for the admin page (`payments.reconcile`). */
export async function listCbuaeRates(actor: Actor, limit = 31): Promise<{ date: string; aedPerInr: string }[]> {
  requirePermission(actor, "payments.reconcile");
  const rows = await prisma.setting.findMany({ where: { key: { startsWith: CBUAE_RATE_SETTING_PREFIX } }, orderBy: { key: "desc" }, take: limit });
  return rows.flatMap((r) => {
    const date = r.key.slice(CBUAE_RATE_SETTING_PREFIX.length);
    const rate = cbuaeRateFrom(date, r.value);
    return rate ? [{ date, aedPerInr: rate.aedPerInr }] : [];
  });
}
