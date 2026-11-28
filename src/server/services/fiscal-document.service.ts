import "server-only";
import { Prisma } from "@prisma/client";
import { prisma, TX_OPTIONS, type Tx } from "../lib/db";
import { env, type Env } from "../lib/env";
import { uuidv7 } from "../lib/ids";
import { emitEvent } from "../lib/structured-events";
import { creditForRefund, isVatCategory, splitInclusive, totalsOf, VAT_RULE, VAT_RULE_CONFIRMED, vatRateBasisPoints, vatRateLabel, type VatCategory, type VatSplit } from "../domain/vat";
import { plainFiscalLayout } from "../documents/generated/fiscal/render";
import { sellerFrom } from "../documents/generated/fiscal/seller";
import { dubaiIsoDate, refundReasonLabel, type FiscalDocType, type FiscalEnvironment, type FiscalLine, type FiscalSeller, type FiscalSnapshot } from "../documents/generated/fiscal/snapshot";
import { itemPayableMinor } from "./order.service";
import { paxLabel } from "./order-status.service";

/**
 * Fiscal documents: numbering and snapshots (doc 93 §1.4–§1.6; owner answers
 * O1 one combined "Tax invoice / Receipt", O3 business invoices by staff, O4
 * no provider reference, O5 no INR line, O15 switch).
 *
 * SWITCHED OFF by default (`FISCAL_DOCUMENTS_ENABLED`). VAT rules are the
 * UNCONFIRMED working assumptions of `src/server/domain/vat.ts`.
 *
 * When a number is assigned. Never inside the payment transaction: the
 * capture (`saga.ts` syncPayment) and refund-settled (`refunds.ts` settle)
 * transactions stay as they are, so a numbering fault can never roll back a
 * recorded payment. The documents job (`issueDue`) finds `customer_money`
 * ledger entries of kind `capture` or `refund` with no fiscal document,
 * oldest first, and issues each in its own transaction:
 *
 *   1. lock the series row (`SELECT … FOR UPDATE`): issuers of a series are
 *      serialised;
 *   2. if the entry already has a document (a concurrent issuer won), return it;
 *   3. take `next_number`, increment the row, insert the document, its party
 *      row and a pending generated-file row; commit.
 *
 * If anything fails after step 1 the whole transaction rolls back, the
 * counter included, so no number is lost or reused (gap-free). Drawing the PDF
 * is a separate, repeatable step from the stored snapshot
 * (`generated-document.service.ts`): a rendering fault never voids a number.
 *
 * What is refused (an open `fiscal_attention` row for staff; no document):
 * a currency other than AED (A9), a product with no VAT category (A6),
 * captured lines that do not add up to the capture, a second capture on one
 * payment, a payment whose environment is unknown, a production document
 * while the production series row or the seller details are missing, while
 * the VAT rule is unconfirmed or while the layout is the pending specimen
 * layout (review finding 5), a goodwill refund (A10), a refund with no
 * `refunds` row (dashboard refund, `reconcileRefunds`), a refund before its
 * invoice exists (retried).
 *
 * Cut-off (review finding 6): a series' `issue_from` excludes every capture or
 * refund before it (required on a production series). A blocked entry is
 * re-checked at most hourly (`FISCAL_BLOCKED_RECHECK_MS`).
 *
 * Concurrency (review finding 7): the draft, including what earlier credit
 * notes already credited on a line, is built INSIDE the issuing transaction,
 * after the series row lock, so two refunds of one line can never both see
 * the same remainder. One invoice per payment is also a unique index.
 *
 * Never on a fiscal document: net cost, margin, supplier amounts, provider
 * payment or refund ids (O4), INR values (O5).
 */

export const FISCAL_LIMITS = Object.freeze({ scanPerRun: 200, issuePerRun: 25 });
/** Time one issue (or one fiscal file draw) may take; the job steps stop before their deadline by this much. */
export const FISCAL_UNIT_MS = 3_000;

export type FiscalBlockReason =
  | "currency_not_supported"
  | "vat_category_missing"
  | "amount_mismatch"
  | "second_capture"
  | "environment_unknown"
  | "environment_mismatch"
  | "series_missing"
  | "seller_unconfigured"
  | "goodwill_unconfirmed"
  | "refund_row_missing"
  | "invoice_missing"
  | "line_not_invoiced"
  | "credit_exceeds_invoice"
  | "no_lines"
  | "not_documentable"
  | "vat_rule_unconfirmed"
  | "layout_pending"
  | "before_issue_from";

/** Refusals that open no `fiscal_attention` row: the entry is outside the series' cut-off by design (finding 6). */
const SILENT_BLOCKS: ReadonlySet<FiscalBlockReason> = new Set(["before_issue_from", "not_documentable"]);

/** A blocked entry is looked at again only after this long, so permanently blocked entries never hog the scan (finding 6). */
export const FISCAL_BLOCKED_RECHECK_MS = 60 * 60_000;

export type IssueOutcome =
  | { kind: "issued"; id: string; displayNumber: string; docType: FiscalDocType }
  | { kind: "exists"; id: string; displayNumber: string }
  | { kind: "blocked"; reason: FiscalBlockReason };

class Blocked extends Error {
  constructor(readonly reason: FiscalBlockReason) {
    super(reason);
  }
}

/* ------------------------------------------------------------ seller */

/** The seller block from server configuration (inputs I1–I4). Unset or stand-in values print as bracketed placeholders (finding 18). */
export function sellerFromEnv(e: Pick<Env, "FISCAL_SELLER_LEGAL_NAME" | "FISCAL_SELLER_TRN" | "FISCAL_SELLER_ADDRESS" | "FISCAL_SELLER_LICENCE" | "NEXT_PUBLIC_SUPPORT_EMAIL" | "EMAIL_REPLY_TO">): FiscalSeller {
  return sellerFrom(e);
}

/** `capture:<environment>:…` / `refund:<environment>:…` → the environment the evidence names. */
export function environmentOfEvidence(ref: string): FiscalEnvironment | null {
  const m = /^(?:capture|refund):(production|test):/.exec(ref);
  return m ? (m[1] as FiscalEnvironment) : null;
}

export function displayNumberOf(prefix: string, n: bigint, padTo: number): string {
  return `${prefix}${n.toString().padStart(padTo, "0")}`;
}

/* ------------------------------------------------------------ attention */

export async function raiseAttention(db: Tx | typeof prisma, input: { entityKind: "payment" | "ledger_entry"; entityId: string; orderId: string | null; reason: string; detail?: Record<string, string | number | boolean | null> }, now: Date): Promise<void> {
  // One open row per (entity, reason): a repeat refreshes `last_seen_at` only, so the alert is raised once.
  await db.$executeRaw`
    INSERT INTO fiscal_attention (id, entity_kind, entity_id, order_id, reason, detail, raised_at, last_seen_at)
    VALUES (${uuidv7()}::uuid, ${input.entityKind}, ${input.entityId}::uuid, ${input.orderId}::uuid, ${input.reason}, ${JSON.stringify(input.detail ?? {})}::jsonb, ${now}, ${now})
    ON CONFLICT (entity_kind, entity_id, reason) WHERE resolved_at IS NULL
    DO UPDATE SET last_seen_at = GREATEST(fiscal_attention.last_seen_at, EXCLUDED.last_seen_at), detail = EXCLUDED.detail`;
}

export async function resolveAttention(db: Tx | typeof prisma, entityKind: "payment" | "ledger_entry", entityId: string, now: Date, reasons?: readonly string[]): Promise<number> {
  const r = await db.fiscalAttention.updateMany({ where: { entityKind, entityId, resolvedAt: null, ...(reasons ? { reason: { in: [...reasons] } } : {}) }, data: { resolvedAt: now } });
  return r.count;
}

/* ------------------------------------------------------------ snapshot building */

interface Draft {
  docType: FiscalDocType;
  environment: FiscalEnvironment;
  orderId: string;
  paymentId: string;
  refundId: string | null;
  refersTo: { id: string; displayNumber: string; issuedAt: Date } | null;
  supplyDate: string;
  moneyAt: Date;
  lines: FiscalLine[];
  orderReference: string;
  paymentMethodLabel: string;
  refundReasonLabel: string | null;
  buyerName: string | null;
  buyerEmail: string | null;
}

const s = (b: bigint) => b.toString();

function methodLabel(p: { rail: string | null; method: string | null }): string {
  return p.rail === "aed_card" || (p.method ?? "").toLowerCase().includes("card") ? "Card" : "Payment";
}

async function draftInvoice(db: Tx | typeof prisma, entry: { id: string; paymentId: string; orderId: string; amountMinor: bigint; currency: string; occurredAt: Date }, environment: FiscalEnvironment): Promise<Draft> {
  if (entry.currency !== "AED") throw new Blocked("currency_not_supported");
  const captures = await db.ledgerEntry.count({ where: { book: "customer_money", kind: "capture", paymentId: entry.paymentId } });
  if (captures !== 1) throw new Blocked("second_capture");
  const payment = await db.payment.findUniqueOrThrow({ where: { id: entry.paymentId }, select: { currency: true, capturedAt: true, rail: true, method: true } });
  if (payment.currency !== "AED") throw new Blocked("currency_not_supported");
  const order = await db.order.findUniqueOrThrow({
    where: { id: entry.orderId },
    select: {
      reference: true,
      leadName: true,
      leadEmail: true,
      items: {
        select: { id: true, productId: true, titleSnapshot: true, variantNameSnapshot: true, serviceDate: true, pax: true, status: true, chargedCurrency: true, chargedAmountMinor: true, discountAllocMinor: true, taxAllocMinor: true, quoteLineIndex: true },
      },
    },
  });
  const priced = order.items.filter((i) => i.chargedAmountMinor !== null).sort((a, b) => (a.quoteLineIndex ?? 0) - (b.quoteLineIndex ?? 0) || a.id.localeCompare(b.id));
  if (!priced.length) throw new Blocked("no_lines");
  if (priced.some((i) => i.chargedCurrency !== "AED")) throw new Blocked("currency_not_supported");
  const sum = (xs: typeof priced) => xs.reduce((t, i) => t + (itemPayableMinor(i) ?? 0n), 0n);
  // The capture covers every priced item, or (a partial capture) the ones that were not dropped before it.
  let captured = priced;
  if (sum(captured) !== entry.amountMinor) captured = priced.filter((i) => i.status !== "rejected" && i.status !== "cancelled");
  if (!captured.length || sum(captured) !== entry.amountMinor) throw new Blocked("amount_mismatch");

  const products = await db.product.findMany({ where: { id: { in: captured.map((i) => i.productId).filter((x): x is string => !!x) } }, select: { id: true, vatCategory: true } });
  const category = new Map(products.map((p) => [p.id, p.vatCategory]));
  const lines: FiscalLine[] = [];
  for (const i of captured) {
    const cat = i.productId ? category.get(i.productId) : null;
    if (!isVatCategory(cat)) throw new Blocked("vat_category_missing");
    const gross = itemPayableMinor(i) ?? 0n;
    const split = splitInclusive(gross, cat);
    lines.push({
      orderItemId: i.id,
      description: i.titleSnapshot,
      variant: i.variantNameSnapshot,
      serviceDate: i.serviceDate.toISOString().slice(0, 10),
      guests: paxLabel(i.pax),
      vatCategory: cat,
      rateLabel: vatRateLabel(cat),
      rateBasisPoints: vatRateBasisPoints(cat),
      discountMinor: s(i.discountAllocMinor ?? 0n),
      netMinor: s(split.netMinor),
      vatMinor: s(split.vatMinor),
      grossMinor: s(split.grossMinor),
    });
  }
  const moneyAt = payment.capturedAt ?? entry.occurredAt;
  return {
    docType: "tax_invoice",
    environment,
    orderId: entry.orderId,
    paymentId: entry.paymentId,
    refundId: null,
    refersTo: null,
    supplyDate: dubaiIsoDate(moneyAt),
    moneyAt,
    lines,
    orderReference: order.reference,
    paymentMethodLabel: methodLabel(payment),
    refundReasonLabel: null,
    buyerName: order.leadName.trim() || null,
    buyerEmail: order.leadEmail?.trim() || null,
  };
}

const lineSplit = (l: FiscalLine): VatSplit => ({ netMinor: BigInt(l.netMinor), vatMinor: BigInt(l.vatMinor), grossMinor: BigInt(l.grossMinor) });

async function draftCreditNote(db: Tx | typeof prisma, entry: { id: string; paymentId: string; orderId: string; amountMinor: bigint; currency: string; occurredAt: Date; evidenceRef: string }, environment: FiscalEnvironment): Promise<Draft> {
  if (entry.currency !== "AED") throw new Blocked("currency_not_supported");
  // refund:<env>:<provider>:<provider refund id, or our idempotency key>
  const parts = entry.evidenceRef.split(":");
  const provider = parts[2] ?? "";
  const ref = parts.slice(3).join(":");
  const refund = await db.refund.findFirst({
    where: { paymentId: entry.paymentId, OR: [{ provider, providerRefundId: ref }, { idempotencyKey: ref }] },
    select: { id: true, orderItemId: true, amountMinor: true, reason: true, outlyFunded: true, status: true },
  });
  if (!refund || refund.status !== "succeeded") throw new Blocked("refund_row_missing");
  if (refund.amountMinor !== -entry.amountMinor) throw new Blocked("amount_mismatch");
  if (refund.outlyFunded) throw new Blocked("goodwill_unconfirmed");
  const invoice = await db.fiscalDocument.findFirst({ where: { paymentId: entry.paymentId, docType: "tax_invoice" }, include: { party: true } });
  if (!invoice) throw new Blocked("invoice_missing");
  if (invoice.environment !== environment) throw new Blocked("environment_mismatch");
  const invLines = invoice.lines as unknown as FiscalLine[];
  const line = invLines.find((l) => l.orderItemId === refund.orderItemId);
  if (!line) throw new Blocked("line_not_invoiced");
  const earlier = await db.fiscalDocument.findMany({ where: { refersToId: invoice.id, docType: "tax_credit_note" }, select: { lines: true } });
  const already: VatSplit = { netMinor: 0n, vatMinor: 0n, grossMinor: 0n };
  for (const cn of earlier) {
    for (const l of cn.lines as unknown as FiscalLine[]) {
      if (l.orderItemId !== line.orderItemId) continue;
      already.netMinor += BigInt(l.netMinor);
      already.vatMinor += BigInt(l.vatMinor);
      already.grossMinor += BigInt(l.grossMinor);
    }
  }
  let credit: VatSplit;
  try {
    credit = creditForRefund(lineSplit(line), already, refund.amountMinor, line.vatCategory);
  } catch {
    throw new Blocked("credit_exceeds_invoice");
  }
  const full = already.grossMinor === 0n && credit.grossMinor === BigInt(line.grossMinor);
  const order = await db.order.findUniqueOrThrow({ where: { id: entry.orderId }, select: { reference: true } });
  const payment = await db.payment.findUniqueOrThrow({ where: { id: entry.paymentId }, select: { rail: true, method: true } });
  return {
    docType: "tax_credit_note",
    environment,
    orderId: entry.orderId,
    paymentId: entry.paymentId,
    refundId: refund.id,
    refersTo: { id: invoice.id, displayNumber: invoice.displayNumber, issuedAt: invoice.issuedAt },
    supplyDate: dubaiIsoDate(entry.occurredAt),
    moneyAt: entry.occurredAt,
    lines: [{ ...line, discountMinor: "0", netMinor: s(credit.netMinor), vatMinor: s(credit.vatMinor), grossMinor: s(credit.grossMinor), note: full ? "Full refund" : "Partial refund" }],
    orderReference: order.reference,
    paymentMethodLabel: methodLabel(payment),
    refundReasonLabel: refundReasonLabel(refund.reason),
    buyerName: invoice.party?.buyerName ?? null,
    buyerEmail: invoice.party?.buyerEmail ?? null,
  };
}

/* ------------------------------------------------------------ issue */

/** Was this payment's capture booked before the invoice series' cut-off (re-review N9)? */
async function refundOfCaptureBeforeCutOff(db: Tx | typeof prisma, legalEntity: string, environment: FiscalEnvironment, paymentId: string): Promise<boolean> {
  const [row] = await db.$queryRaw<{ is_before: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM ledger_entries c JOIN fiscal_series fs
        ON fs.legal_entity = ${legalEntity} AND fs.environment = ${environment} AND fs.doc_type = 'tax_invoice'
      WHERE c.payment_id = ${paymentId}::uuid AND c.book = 'customer_money' AND c.kind = 'capture'
        AND fs.issue_from IS NOT NULL AND c.occurred_at < fs.issue_from
    ) AS is_before`;
  return row?.is_before === true;
}

export interface IssueDeps {
  now: Date;
  legalEntity: string;
  seller: FiscalSeller;
  /** False outside a production deployment: a production-environment payment is then refused. */
  productionAllowed: boolean;
  /** The accountant confirmed the VAT rule (default `VAT_RULE_CONFIRMED`). A production document needs it (finding 5). */
  vatRuleConfirmed?: boolean;
  /** The layout is the owner's production design (default `plainFiscalLayout.productionReady`). A production document needs it (finding 5). */
  layoutProductionReady?: boolean;
  /** Test seam: runs after the counter was taken and before the document is inserted. */
  faultAfterCounter?: () => Promise<void> | void;
}

/**
 * Issues the fiscal document of one `customer_money` ledger entry, or answers
 * why not. Idempotent: the same entry always maps to the same document.
 */
export async function issueForLedgerEntry(ledgerEntryId: string, deps: IssueDeps): Promise<IssueOutcome> {
  const existing = await prisma.fiscalDocument.findUnique({ where: { ledgerEntryId }, select: { id: true, displayNumber: true } });
  if (existing) return { kind: "exists", ...existing };
  const entry = await prisma.ledgerEntry.findUnique({ where: { id: ledgerEntryId } });
  if (!entry || entry.book !== "customer_money" || !entry.paymentId || !entry.orderId || (entry.kind !== "capture" && entry.kind !== "refund")) return { kind: "blocked", reason: "not_documentable" };
  const { paymentId, orderId } = entry;
  const environment = environmentOfEvidence(entry.evidenceRef);
  const block = async (reason: FiscalBlockReason): Promise<IssueOutcome> => {
    if (SILENT_BLOCKS.has(reason)) return { kind: "blocked", reason };
    await raiseAttention(prisma, { entityKind: "ledger_entry", entityId: entry.id, orderId, reason, detail: { kind: entry.kind } }, deps.now);
    emitEvent("fiscal.blocked", { ledgerEntryId: entry.id, reason }, "warn");
    return { kind: "blocked", reason };
  };
  if (!environment) return block("environment_unknown");
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, select: { environment: true } });
  if (payment?.environment !== environment) return block("environment_mismatch");
  if (environment === "production" && !deps.productionAllowed) return block("environment_mismatch");
  if (environment === "production" && deps.seller.placeholder) return block("seller_unconfigured");
  if (environment === "production" && !(deps.vatRuleConfirmed ?? VAT_RULE_CONFIRMED)) return block("vat_rule_unconfirmed");
  if (environment === "production" && !(deps.layoutProductionReady ?? plainFiscalLayout.productionReady)) return block("layout_pending");
  const docType: FiscalDocType = entry.kind === "capture" ? "tax_invoice" : "tax_credit_note";
  const draftInput = { id: entry.id, paymentId, orderId, amountMinor: entry.amountMinor, currency: entry.currency, occurredAt: entry.occurredAt, evidenceRef: entry.evidenceRef };

  try {
    const out = await prisma.$transaction(async (tx) => {
      const [series] = await tx.$queryRaw<{ id: string; prefix: string; next_number: bigint; pad_to: number; issue_from: Date | null }[]>`
        SELECT id, prefix, next_number, pad_to, issue_from FROM fiscal_series
        WHERE legal_entity = ${deps.legalEntity} AND environment = ${environment} AND doc_type = ${docType}
        FOR UPDATE`;
      if (!series) throw new Blocked("series_missing");
      if (series.issue_from && entry.occurredAt < series.issue_from) throw new Blocked("before_issue_from");
      // Re-review N9: a refund of a capture booked before the INVOICE series' cut-off has no invoice by design, so no
      // credit note either (silent, no alert). Whether such refunds need any document is the accountant's call (A12).
      if (docType === "tax_credit_note" && (await refundOfCaptureBeforeCutOff(tx, deps.legalEntity, environment, paymentId))) throw new Blocked("before_issue_from");
      // Under the series lock: a concurrent issuer of the same entry has committed by now if it won.
      const won = await tx.fiscalDocument.findUnique({ where: { ledgerEntryId }, select: { id: true, displayNumber: true } });
      if (won) return { kind: "exists" as const, ...won };
      // The draft is built under the lock (finding 7): earlier credit notes of this invoice are all committed and seen.
      const draft = entry.kind === "capture" ? await draftInvoice(tx, draftInput, environment) : await draftCreditNote(tx, draftInput, environment);
      const number = series.next_number;
      await tx.$executeRaw`UPDATE fiscal_series SET next_number = next_number + 1, updated_at = ${deps.now} WHERE id = ${series.id}::uuid`;
      if (deps.faultAfterCounter) await deps.faultAfterCounter();

      const displayNumber = displayNumberOf(series.prefix, number, series.pad_to);
      const totals = totalsOf(draft.lines.map((l) => ({ grossMinor: BigInt(l.grossMinor), netMinor: BigInt(l.netMinor), vatMinor: BigInt(l.vatMinor), category: l.vatCategory as VatCategory })));
      const snapshot: FiscalSnapshot = {
        docType: draft.docType,
        displayNumber,
        environment: draft.environment,
        issuedAt: deps.now.toISOString(),
        supplyDate: draft.supplyDate,
        currency: "AED",
        orderReference: draft.orderReference,
        seller: deps.seller,
        lines: draft.lines,
        totals: { netMinor: s(totals.netMinor), vatMinor: s(totals.vatMinor), grossMinor: s(totals.grossMinor), byRate: totals.byRate.map((r) => ({ label: r.label, basisPoints: r.basisPoints, netMinor: s(r.netMinor), vatMinor: s(r.vatMinor) })) },
        moneyAt: draft.moneyAt.toISOString(),
        paymentMethodLabel: draft.paymentMethodLabel,
        refersTo: draft.refersTo ? { displayNumber: draft.refersTo.displayNumber, issuedAt: draft.refersTo.issuedAt.toISOString() } : null,
        refundReasonLabel: draft.refundReasonLabel,
        vatRule: VAT_RULE,
        vatRuleConfirmed: deps.vatRuleConfirmed ?? VAT_RULE_CONFIRMED,
        templateVersion: plainFiscalLayout.templateVersion,
      };
      const id = uuidv7();
      await tx.fiscalDocument.create({
        data: {
          id,
          seriesId: series.id,
          number,
          displayNumber,
          docType: draft.docType,
          environment: draft.environment,
          orderId: draft.orderId,
          paymentId: draft.paymentId,
          refundId: draft.refundId,
          ledgerEntryId,
          refersToId: draft.refersTo?.id ?? null,
          issuedAt: deps.now,
          supplyDate: new Date(`${draft.supplyDate}T00:00:00Z`),
          currency: "AED",
          netMinor: totals.netMinor,
          vatMinor: totals.vatMinor,
          grossMinor: totals.grossMinor,
          seller: deps.seller as unknown as Prisma.InputJsonValue,
          lines: draft.lines as unknown as Prisma.InputJsonValue,
          vatRule: VAT_RULE,
          templateVersion: plainFiscalLayout.templateVersion,
        },
      });
      await tx.fiscalDocumentParty.create({ data: { fiscalDocumentId: id, buyerName: draft.buyerName?.slice(0, 200) ?? null, buyerEmail: draft.buyerEmail?.slice(0, 320) ?? null } });
      await tx.generatedDocument.create({
        data: { id: uuidv7(), kind: draft.docType, orderId: draft.orderId, fiscalDocumentId: id, templateVersion: plainFiscalLayout.templateVersion, snapshot: snapshot as unknown as Prisma.InputJsonValue, status: "pending" },
      });
      // A credit note never exceeds what was invoiced (also per line, in draftCreditNote).
      if (draft.refersTo) {
        const credited = await tx.fiscalDocument.aggregate({ where: { refersToId: draft.refersTo.id }, _sum: { grossMinor: true } });
        const inv = await tx.fiscalDocument.findUniqueOrThrow({ where: { id: draft.refersTo.id }, select: { grossMinor: true } });
        if ((credited._sum.grossMinor ?? 0n) > inv.grossMinor) throw new Blocked("credit_exceeds_invoice");
      }
      await resolveAttention(tx, "ledger_entry", ledgerEntryId, deps.now);
      return { kind: "issued" as const, id, displayNumber, docType: draft.docType };
    }, TX_OPTIONS);
    if (out.kind === "issued") emitEvent("fiscal.issued", { fiscalDocumentId: out.id, docType: out.docType });
    return out;
  } catch (err) {
    if (err instanceof Blocked) return block(err.reason);
    // A unique conflict: another issuer of the same entry committed first (the counter rolled back with us), or the
    // payment already has its one invoice (fiscal_documents_one_invoice_per_payment, finding 7).
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const won = await prisma.fiscalDocument.findUnique({ where: { ledgerEntryId }, select: { id: true, displayNumber: true } });
      if (won) return { kind: "exists", ...won };
      if (docType === "tax_invoice") return block("second_capture");
    }
    throw err;
  }
}

export interface IssueDueSummary {
  skipped?: "switch_off";
  scanned: number;
  issued: number;
  blocked: number;
  errors: number;
}

/** The documents-job step: issue due documents, oldest entry first. Never throws. */
export async function issueDue(opts: { now: Date; e?: Env; max?: number; scan?: number; deps?: Partial<IssueDeps>; ledgerEntryIds?: readonly string[]; deadline?: number }): Promise<IssueDueSummary> {
  const e = opts.e ?? env();
  const summary: IssueDueSummary = { scanned: 0, issued: 0, blocked: 0, errors: 0 };
  if (!e.FISCAL_DOCUMENTS_ENABLED) return { ...summary, skipped: "switch_off" };
  const deps: IssueDeps = { now: opts.now, legalEntity: e.FISCAL_LEGAL_ENTITY, seller: sellerFromEnv(e), productionAllowed: e.isProduction, ...opts.deps };
  // `ledgerEntryIds` limits the scan (tests on a shared database).
  const scope = opts.ledgerEntryIds ? Prisma.sql`AND l.id IN (${Prisma.join(opts.ledgerEntryIds.length ? opts.ledgerEntryIds.map((id) => Prisma.sql`${id}::uuid`) : [Prisma.sql`NULL::uuid`])})` : Prisma.empty;
  const recheckBefore = new Date(opts.now.getTime() - FISCAL_BLOCKED_RECHECK_MS);
  let rows: { id: string }[] = [];
  try {
    rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT l.id FROM ledger_entries l
      WHERE l.book = 'customer_money' AND l.kind IN ('capture', 'refund') AND l.payment_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fiscal_documents f WHERE f.ledger_entry_id = l.id)
        -- Finding 6: nothing before the series' cut-off is ever numbered (historic payments, A12).
        AND NOT EXISTS (
          SELECT 1 FROM fiscal_series fs
          WHERE fs.legal_entity = ${deps.legalEntity} AND fs.environment = split_part(l.evidence_ref, ':', 2)
            AND fs.doc_type = (CASE WHEN l.kind = 'capture' THEN 'tax_invoice' ELSE 'tax_credit_note' END)
            AND fs.issue_from IS NOT NULL AND l.occurred_at < fs.issue_from)
        -- Re-review N9: nor a refund of a capture booked before the invoice series' cut-off (it has no invoice).
        AND NOT (l.kind = 'refund' AND EXISTS (
          SELECT 1 FROM ledger_entries c JOIN fiscal_series fs
            ON fs.legal_entity = ${deps.legalEntity} AND fs.environment = split_part(c.evidence_ref, ':', 2) AND fs.doc_type = 'tax_invoice'
          WHERE c.payment_id = l.payment_id AND c.book = 'customer_money' AND c.kind = 'capture'
            AND fs.issue_from IS NOT NULL AND c.occurred_at < fs.issue_from))
        -- Finding 6: a blocked entry waits FISCAL_BLOCKED_RECHECK_MS before it is looked at again.
        AND NOT EXISTS (
          SELECT 1 FROM fiscal_attention a
          WHERE a.entity_kind = 'ledger_entry' AND a.entity_id = l.id AND a.resolved_at IS NULL AND a.last_seen_at > ${recheckBefore})
        ${scope}
      ORDER BY l.occurred_at ASC, l.id ASC
      LIMIT ${opts.scan ?? FISCAL_LIMITS.scanPerRun}`;
  } catch {
    emitEvent("fiscal.sweep_failed", { stage: "scan", reason: "query_failed" }, "error");
    return { ...summary, errors: 1 };
  }
  for (const r of rows) {
    if (summary.issued >= (opts.max ?? FISCAL_LIMITS.issuePerRun)) break;
    // The job's shared deadline (finding 10): one issue is a short transaction; stop with room to spare.
    if (opts.deadline !== undefined && Date.now() + FISCAL_UNIT_MS > opts.deadline) break;
    summary.scanned++;
    try {
      const o = await issueForLedgerEntry(r.id, deps);
      if (o.kind === "issued") summary.issued++;
      else if (o.kind === "blocked") summary.blocked++;
    } catch {
      summary.errors++;
      emitEvent("fiscal.issue_failed", { ledgerEntryId: r.id, reason: "error" }, "error");
    }
  }
  return summary;
}

/* ------------------------------------------------------------ refund reconciliation */

export interface ReconcileSummary {
  checked: number;
  raised: number;
  resolved: number;
}

/**
 * Doc 93 §1.5 last row: a refund made in the Stripe dashboard raises
 * `payments.refunded_minor` (saga.ts syncPayment) with no `refunds` row, so no
 * credit note can be issued for it automatically. Seen once in production.
 * This finds every captured payment whose refunded total is above the sum of
 * its succeeded `refunds` rows and opens a `fiscal_attention` row
 * (`refund_without_refund_row`) for staff, alerted through the ops alert
 * email. Detection only: no document is issued from here (A12). Runs whatever
 * the fiscal switch says, so the case is known before the switch goes on.
 * Never throws.
 *
 * In-flight refunds (review finding 8): the provider total moves as soon as
 * the provider shows a refund, while our row may still be `requested`,
 * `accepted` or `unknown`. Those rows count too, so an ordinary refund never
 * opens a row; and a row is alerted only once the gap has lasted
 * `REFUND_GAP_ALERT_AFTER_MS` (`fiscalAttentionOpen`), so a short flap never
 * reaches the ops email.
 */
export async function reconcileRefunds(now: Date, opts: { paymentIds?: readonly string[] } = {}): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { checked: 0, raised: 0, resolved: 0 };
  // `paymentIds` limits the check (tests on a shared database).
  const scope = opts.paymentIds ? Prisma.sql`AND p.id IN (${Prisma.join(opts.paymentIds.length ? opts.paymentIds.map((id) => Prisma.sql`${id}::uuid`) : [Prisma.sql`NULL::uuid`])})` : Prisma.empty;
  try {
    const rows = await prisma.$queryRaw<{ id: string; order_id: string; refunded_minor: bigint; settled: bigint }[]>`
      SELECT p.id, p.order_id, p.refunded_minor,
        COALESCE((SELECT SUM(r.amount_minor) FROM refunds r WHERE r.payment_id = p.id AND r.status IN ('succeeded', 'requested', 'accepted', 'unknown')), 0)::bigint AS settled
      FROM payments p
      WHERE p.captured_minor > 0 AND (p.refunded_minor > 0 OR EXISTS (SELECT 1 FROM fiscal_attention a WHERE a.entity_kind = 'payment' AND a.entity_id = p.id AND a.resolved_at IS NULL))
        ${scope}`;
    for (const r of rows) {
      summary.checked++;
      if (r.refunded_minor > r.settled) {
        await raiseAttention(prisma, { entityKind: "payment", entityId: r.id, orderId: r.order_id, reason: "refund_without_refund_row", detail: { gap: "refunded_above_refund_rows" } }, now);
        summary.raised++;
      } else {
        summary.resolved += await resolveAttention(prisma, "payment", r.id, now, ["refund_without_refund_row"]);
      }
    }
    if (summary.raised) emitEvent("fiscal.refund_reconciliation", { mismatched: summary.raised }, "warn");
  } catch {
    emitEvent("fiscal.sweep_failed", { stage: "reconcile", reason: "query_failed" }, "error");
  }
  return summary;
}

/** A refund gap is alerted only after it has lasted this long (finding 8). */
export const REFUND_GAP_ALERT_AFTER_MS = 15 * 60_000;

/** Open attention rows raised in the window, for the ops alert sweep (codes and ids only). A refund gap only once it has lasted. */
export async function fiscalAttentionOpen(since: Date, now: Date, limit: number): Promise<{ id: string; entityKind: string; entityId: string; orderId: string | null; reason: string; raisedAt: Date; reference: string | null }[]> {
  const rows = await prisma.$queryRaw<{ id: string; entity_kind: string; entity_id: string; order_id: string | null; reason: string; raised_at: Date; reference: string | null }[]>`
    SELECT a.id, a.entity_kind, a.entity_id, a.order_id, a.reason, a.raised_at, o.reference
    FROM fiscal_attention a LEFT JOIN orders o ON o.id = a.order_id
    WHERE a.resolved_at IS NULL AND a.raised_at >= ${since} AND a.raised_at <= ${now}
      AND (a.reason <> 'refund_without_refund_row' OR a.raised_at <= ${new Date(now.getTime() - REFUND_GAP_ALERT_AFTER_MS)})
    ORDER BY a.raised_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({ id: r.id, entityKind: r.entity_kind, entityId: r.entity_id, orderId: r.order_id, reason: r.reason, raisedAt: r.raised_at, reference: r.reference }));
}
