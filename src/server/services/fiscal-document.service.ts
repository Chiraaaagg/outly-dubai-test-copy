import "server-only";
import { Prisma } from "@prisma/client";
import { prisma, TX_OPTIONS, type Tx } from "../lib/db";
import { env, type Env } from "../lib/env";
import { uuidv7 } from "../lib/ids";
import { emitEvent } from "../lib/structured-events";
import { creditForRefund, resolveVatCategory, splitDiscount, splitInclusive, totalsOf, VAT_RULE, VAT_RULE_CONFIRMED, vatRateBasisPoints, vatRateLabel, type VatCategory, type VatSplit } from "../domain/vat";
import { plainFiscalLayout } from "../documents/generated/fiscal/render";
import { sellerFrom } from "../documents/generated/fiscal/seller";
import { dubaiIsoDate, isFiscalSnapshot, refundReasonLabel, type FiscalDocType, type FiscalEnvironment, type FiscalLine, type FiscalLineSource, type FiscalSeller, type FiscalSnapshot } from "../documents/generated/fiscal/snapshot";
import { cbuaeRateFrom, CBUAE_RATE_SETTING_PREFIX, inrToAedMinor, type CbuaeRate } from "../domain/fiscal-fx";
import { itemPayableMinor } from "./order.service";
import { paxLabel } from "./order-status.service";

/**
 * Fiscal documents: numbering and snapshots (doc 93 §1.4–§1.6; owner answers
 * O1 one combined "Tax invoice / Receipt", O3 business invoices by staff, O4
 * no provider reference, O5 no INR line, O15 switch).
 *
 * SWITCHED OFF by default (`FISCAL_DOCUMENTS_ENABLED`). VAT rules are the
 * owner-approved answers A1–A18 of `src/server/domain/vat.ts` (accountant
 * sign-off pending, so a production document is still refused).
 *
 * Start (A12, owner, final): payments before go-live were tests only, so
 * nothing is backfilled. `FISCAL_DOCUMENTS_START_AT` (an ISO time, required
 * while the switch is on) is the first capture that gets a number; a capture
 * booked before it, and every refund of such a capture, never gets one, and
 * the refund reconciliation ignores such payments. Unset or invalid: nothing
 * is issued (fail closed).
 *
 * Numbering (A1): two continuous, gap-free series per legal entity that never
 * restart, `INV-000001` and `CN-000001` in production (`FISCAL_SERIES_FORMAT`;
 * the production rows are inserted as a live step). TEST series keep their
 * `TEST-` prefixes. The counter only moves forward (`fiscal_series_guard`).
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
 * a currency other than AED or INR, an INR capture with no CBUAE rate entered
 * for its capture date (C-P1: every amount in AED, never at a guessed rate), a
 * product whose stored VAT category is not a known one, or a product with no
 * stored category that looks like a transport ticket (A6, held for review),
 * captured lines that do not add up to the capture, a second capture on one
 * payment, a payment whose environment is unknown, a production document
 * while the production series row or the seller details are missing, its
 * series is not in the A1 format, the VAT rule is not signed off by the
 * accountant or the layout is the pending specimen layout (review finding 5),
 * a refund with no `refunds` row (dashboard refund, `reconcileRefunds`), a
 * refund before its invoice exists (retried). A goodwill refund is credited
 * like any other refund (A10).
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
 * payment or refund ids (O4), INR values (O5, C-P1: an INR-paid line keeps its
 * INR amount and the CBUAE rate in `source` for audit; none of it is printed).
 *
 * Full tax invoice on request (C-P2): `reissueAsFullTaxInvoice`, called by
 * staff through `fiscal-staff.service.ts` (step-up, audit).
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
  | "refund_row_missing"
  | "invoice_missing"
  | "line_not_invoiced"
  | "credit_exceeds_invoice"
  | "no_lines"
  | "not_documentable"
  | "vat_rule_unconfirmed"
  | "layout_pending"
  | "before_issue_from"
  | "vat_category_review"
  | "series_format"
  | "start_at_missing"
  | "before_start_at"
  /** C-P1: an INR capture with no CBUAE rate stored for its date (staff enter it; nothing is guessed). */
  | "fx_rate_missing";

/** Refusals that open no `fiscal_attention` row: the entry is outside the series' cut-off by design (finding 6). */
const SILENT_BLOCKS: ReadonlySet<FiscalBlockReason> = new Set(["before_issue_from", "not_documentable", "start_at_missing", "before_start_at"]);

/** A1: the production series' display format. A production series with any other prefix or padding is refused. */
export const FISCAL_SERIES_FORMAT = Object.freeze({
  tax_invoice: Object.freeze({ prefix: "INV-", padTo: 6 }),
  tax_credit_note: Object.freeze({ prefix: "CN-", padTo: 6 }),
});

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

/** `fiscal_attention.entity_kind` (migration 20261202120000 adds `fiscal_export`, C-P4). */
export type AttentionEntityKind = "payment" | "ledger_entry" | "fiscal_export";

export async function raiseAttention(db: Tx | typeof prisma, input: { entityKind: AttentionEntityKind; entityId: string; orderId: string | null; reason: string; detail?: Record<string, string | number | boolean | null> }, now: Date): Promise<void> {
  // One open row per (entity, reason): a repeat refreshes `last_seen_at` only, so the alert is raised once.
  await db.$executeRaw`
    INSERT INTO fiscal_attention (id, entity_kind, entity_id, order_id, reason, detail, raised_at, last_seen_at)
    VALUES (${uuidv7()}::uuid, ${input.entityKind}, ${input.entityId}::uuid, ${input.orderId}::uuid, ${input.reason}, ${JSON.stringify(input.detail ?? {})}::jsonb, ${now}, ${now})
    ON CONFLICT (entity_kind, entity_id, reason) WHERE resolved_at IS NULL
    DO UPDATE SET last_seen_at = GREATEST(fiscal_attention.last_seen_at, EXCLUDED.last_seen_at), detail = EXCLUDED.detail`;
}

export async function resolveAttention(db: Tx | typeof prisma, entityKind: AttentionEntityKind, entityId: string, now: Date, reasons?: readonly string[]): Promise<number> {
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
  /** Review 109c N6: the order was erased before its invoice: the party row is written already erased. */
  buyerErased: boolean;
  /** C-P1: the conversion of an INR-paid order (audit only). */
  fx: FiscalSnapshot["fx"];
}

const s = (b: bigint) => b.toString();

/** The `[deleted-<token>]` marker the privacy erasure writes into `orders.lead_name` (privacy.service.ts). */
export function isErasureMarker(name: string | null | undefined): boolean {
  return /^\[deleted-[0-9a-f]{6,}\]$/.test((name ?? "").trim());
}

/** C-P1: the staff-entered CBUAE rate for a Dubai date, or null. Read without the settings cache (a fresh entry counts at once). */
export async function cbuaeRateFor(db: Tx | typeof prisma, date: string): Promise<CbuaeRate | null> {
  // FOR SHARE (review 109d R7): inside the issuing transaction the rate row cannot be changed until the document that
  // uses it is committed; a staff correction (FOR UPDATE, then the "in use" check) waits and then sees the document.
  const [row] = await db.$queryRaw<{ value: unknown }[]>`SELECT value FROM settings WHERE key = ${`${CBUAE_RATE_SETTING_PREFIX}${date}`} FOR SHARE`;
  return row ? cbuaeRateFrom(date, row.value) : null;
}

const fxOf = (r: CbuaeRate): NonNullable<FiscalSnapshot["fx"]> => ({ from: "INR", aedPerInr: r.aedPerInr, rateDate: r.date, source: r.source });

function methodLabel(p: { rail: string | null; method: string | null }): string {
  return p.rail === "aed_card" || (p.method ?? "").toLowerCase().includes("card") ? "Card" : "Payment";
}

async function draftInvoice(db: Tx | typeof prisma, entry: { id: string; paymentId: string; orderId: string; amountMinor: bigint; currency: string; occurredAt: Date }, environment: FiscalEnvironment): Promise<Draft> {
  // C-P1: AED, or INR converted to AED at the CBUAE rate of the capture date. Nothing else.
  const currency = entry.currency;
  if (currency !== "AED" && currency !== "INR") throw new Blocked("currency_not_supported");
  const captures = await db.ledgerEntry.count({ where: { book: "customer_money", kind: "capture", paymentId: entry.paymentId } });
  if (captures !== 1) throw new Blocked("second_capture");
  const payment = await db.payment.findUniqueOrThrow({ where: { id: entry.paymentId }, select: { currency: true, capturedAt: true, rail: true, method: true } });
  if (payment.currency !== currency) throw new Blocked("currency_not_supported");
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
  if (priced.some((i) => i.chargedCurrency !== currency)) throw new Blocked("currency_not_supported");
  const sum = (xs: typeof priced) => xs.reduce((t, i) => t + (itemPayableMinor(i) ?? 0n), 0n);
  // The capture covers every priced item, or (a partial capture) the ones that were not dropped before it.
  let captured = priced;
  if (sum(captured) !== entry.amountMinor) captured = priced.filter((i) => i.status !== "rejected" && i.status !== "cancelled");
  if (!captured.length || sum(captured) !== entry.amountMinor) throw new Blocked("amount_mismatch");

  const products = await db.product.findMany({ where: { id: { in: captured.map((i) => i.productId).filter((x): x is string => !!x) } }, select: { id: true, slug: true, title: true, vatCategory: true } });
  const byId = new Map(products.map((p) => [p.id, p]));
  // A4: the date of supply is the card capture date (a card hold is not a payment).
  const moneyAt = payment.capturedAt ?? entry.occurredAt;
  const supplyDate = dubaiIsoDate(moneyAt);
  // C-P1: every amount in AED. An INR capture needs the CBUAE rate of its capture date, entered by staff; without it
  // the invoice is held (`fx_rate_missing`, staff alert), never converted at a guessed rate.
  const rate = currency === "INR" ? await cbuaeRateFor(db, supplyDate) : null;
  if (currency === "INR" && !rate) throw new Blocked("fx_rate_missing");
  const toAed = (m: bigint) => (rate ? inrToAedMinor(m, rate.aedPerInr) : m);
  const sourceOf = (m: bigint): { source?: FiscalLineSource } => (rate ? { source: { currency: "INR", grossMinor: s(m), aedPerInr: rate.aedPerInr, rateDate: rate.date, rateSource: "CBUAE" } } : {});
  const lines: FiscalLine[] = [];
  for (const i of captured) {
    const product = i.productId ? byId.get(i.productId) : undefined;
    // A6: the stored category, else the exempt transport list, else standard; a transport-looking product with no
    // stored category is held for staff (`vat_category_review`), a stored value outside the list is refused.
    const resolved = product ? resolveVatCategory(product) : ({ kind: "invalid" } as const);
    if (resolved.kind === "invalid") throw new Blocked("vat_category_missing");
    if (resolved.kind === "review") throw new Blocked("vat_category_review");
    const cat = resolved.category;
    // A5: the item at its price before the discount, and the discount as its own negative line right after it.
    const discount = i.discountAllocMinor ?? 0n;
    const paid = itemPayableMinor(i) ?? 0n;
    if (discount < 0n || paid < 0n) throw new Blocked("amount_mismatch");
    const base = {
      orderItemId: i.id,
      serviceDate: i.serviceDate.toISOString().slice(0, 10),
      vatCategory: cat,
      rateLabel: vatRateLabel(cat),
      rateBasisPoints: vatRateBasisPoints(cat),
      discountMinor: "0",
    };
    // C-P1: the item and its discount are converted one by one, so the AED lines still add up line by line.
    const split = splitInclusive(toAed(paid + discount), cat);
    lines.push({ ...base, lineKind: "item", description: i.titleSnapshot, variant: i.variantNameSnapshot, guests: paxLabel(i.pax), netMinor: s(split.netMinor), vatMinor: s(split.vatMinor), grossMinor: s(split.grossMinor), ...sourceOf(paid + discount) });
    if (discount > 0n) {
      const d = splitDiscount(toAed(discount), cat);
      lines.push({ ...base, lineKind: "discount", description: "Discount", variant: i.titleSnapshot, guests: "", netMinor: s(d.netMinor), vatMinor: s(d.vatMinor), grossMinor: s(d.grossMinor), ...sourceOf(-discount) });
    }
  }
  const erased = isErasureMarker(order.leadName);
  return {
    docType: "tax_invoice",
    environment,
    orderId: entry.orderId,
    paymentId: entry.paymentId,
    refundId: null,
    refersTo: null,
    supplyDate,
    moneyAt,
    lines,
    orderReference: order.reference,
    paymentMethodLabel: methodLabel(payment),
    refundReasonLabel: null,
    // Review 109c N6: an order erased before its invoice gives no buyer, never the erasure marker.
    buyerName: erased ? null : order.leadName.trim() || null,
    buyerEmail: erased ? null : order.leadEmail?.trim() || null,
    buyerErased: erased,
    fx: rate ? fxOf(rate) : null,
  };
}

async function draftCreditNote(db: Tx | typeof prisma, entry: { id: string; paymentId: string; orderId: string; amountMinor: bigint; currency: string; occurredAt: Date; evidenceRef: string }, environment: FiscalEnvironment): Promise<Draft> {
  if (entry.currency !== "AED" && entry.currency !== "INR") throw new Blocked("currency_not_supported");
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
  // A10: a tax credit note for every refund of invoiced money, goodwill (OUTLYY-funded) refunds included; a kept fee
  // is simply not refunded, so it stays on the original invoice.
  // The invoice in force: the full tax invoice when staff reissued one (C-P2), else the simplified one.
  const invoices = await db.fiscalDocument.findMany({ where: { paymentId: entry.paymentId, docType: "tax_invoice" }, include: { party: true } });
  const invoice = invoices.find((d) => d.issueReason === "reissue_full") ?? invoices.find((d) => d.issueReason === "money");
  if (!invoice) throw new Blocked("invoice_missing");
  if (invoice.environment !== environment) throw new Blocked("environment_mismatch");
  const invLines = invoice.lines as unknown as FiscalLine[];
  // The item's line and its discount line (A5) together: what was paid for the item, which a refund credits.
  const itemLines = invLines.filter((l) => l.orderItemId === refund.orderItemId);
  const line = itemLines.find((l) => l.lineKind !== "discount");
  if (!line) throw new Blocked("line_not_invoiced");
  const paidForItem = itemLines.reduce<VatSplit>((t, l) => ({ netMinor: t.netMinor + BigInt(l.netMinor), vatMinor: t.vatMinor + BigInt(l.vatMinor), grossMinor: t.grossMinor + BigInt(l.grossMinor) }), { netMinor: 0n, vatMinor: 0n, grossMinor: 0n });
  // C-P1: the refund is in the capture's currency; an INR invoice carries its INR source and CBUAE rate per line.
  const inrSource = line.source;
  if ((entry.currency === "INR") !== !!inrSource) throw new Blocked("currency_not_supported");
  const earlier = await db.fiscalDocument.findMany({ where: { refersToId: invoice.id, docType: "tax_credit_note", issueReason: "money" }, select: { lines: true } });
  const already: VatSplit = { netMinor: 0n, vatMinor: 0n, grossMinor: 0n };
  let alreadyInr = 0n;
  for (const cn of earlier) {
    for (const l of cn.lines as unknown as FiscalLine[]) {
      if (l.orderItemId !== line.orderItemId) continue;
      already.netMinor += BigInt(l.netMinor);
      already.vatMinor += BigInt(l.vatMinor);
      already.grossMinor += BigInt(l.grossMinor);
      alreadyInr += BigInt(l.source?.grossMinor ?? "0");
    }
  }
  // The AED amount credited: the refund itself, or (INR) the refund converted at the invoice's own rate, and the
  // exact AED remainder when the refund takes what is left of the item in INR, so invoice and credits net to zero.
  let refundAed = refund.amountMinor;
  let source: { source?: FiscalLineSource } = {};
  if (inrSource) {
    const paidInr = itemLines.reduce((t, l) => t + BigInt(l.source?.grossMinor ?? "0"), 0n);
    const leftInr = paidInr - alreadyInr;
    const leftAed = paidForItem.grossMinor - already.grossMinor;
    if (refund.amountMinor > leftInr) throw new Blocked("credit_exceeds_invoice");
    const converted = inrToAedMinor(refund.amountMinor, inrSource.aedPerInr);
    // Review 109d R9: a part-refund never takes the whole AED remainder; the refund that ends the INR amount does.
    refundAed = refund.amountMinor === leftInr ? leftAed : converted < leftAed ? converted : leftAed - 1n;
    source = { source: { ...inrSource, grossMinor: s(refund.amountMinor) } };
  }
  let credit: VatSplit;
  try {
    credit = creditForRefund(paidForItem, already, refundAed, line.vatCategory);
  } catch {
    throw new Blocked("credit_exceeds_invoice");
  }
  const full = already.grossMinor === 0n && credit.grossMinor === paidForItem.grossMinor;
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
    lines: [{ ...line, lineKind: "item", discountMinor: "0", netMinor: s(credit.netMinor), vatMinor: s(credit.vatMinor), grossMinor: s(credit.grossMinor), note: full ? "Full refund" : "Partial refund", ...source }],
    orderReference: order.reference,
    paymentMethodLabel: methodLabel(payment),
    refundReasonLabel: refundReasonLabel(refund.reason),
    buyerName: invoice.party?.erasedAt ? null : invoice.party?.buyerName ?? null,
    buyerEmail: invoice.party?.erasedAt ? null : invoice.party?.buyerEmail ?? null,
    buyerErased: !!invoice.party?.erasedAt,
    fx: inrSource ? { from: "INR", aedPerInr: inrSource.aedPerInr, rateDate: inrSource.rateDate, source: "CBUAE" } : null,
  };
}

/* ------------------------------------------------------------ issue */

/** Was this payment's capture booked before `at` (A12: a refund of a pre-start capture has no invoice, so no credit note)? */
async function captureBookedBefore(db: Tx | typeof prisma, paymentId: string, at: Date): Promise<boolean> {
  const [row] = await db.$queryRaw<{ is_before: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM ledger_entries c
      WHERE c.payment_id = ${paymentId}::uuid AND c.book = 'customer_money' AND c.kind = 'capture' AND c.occurred_at < ${at}
    ) AS is_before`;
  return row?.is_before === true;
}

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
  /**
   * A12: `FISCAL_DOCUMENTS_START_AT`, the first capture time that gets a number. Null (unset or invalid) refuses
   * everything (`start_at_missing`, fail closed); a capture before it, or a refund of such a capture, is refused
   * silently (`before_start_at`).
   */
  startAt: Date | null;
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
  // A12: no number before the go-live start, ever (silent: by design, not a fault).
  if (!deps.startAt) return block("start_at_missing");
  if (entry.occurredAt < deps.startAt) return block("before_start_at");
  if (entry.kind === "refund" && (await captureBookedBefore(prisma, paymentId, deps.startAt))) return block("before_start_at");
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
      // A1: production numbers are INV-000001 / CN-000001, nothing else.
      if (environment === "production" && (series.prefix !== FISCAL_SERIES_FORMAT[docType].prefix || series.pad_to !== FISCAL_SERIES_FORMAT[docType].padTo)) throw new Blocked("series_format");
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
        ...(draft.fx ? { fx: draft.fx } : {}),
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
      await tx.fiscalDocumentParty.create({
        data: draft.buyerErased
          ? { fiscalDocumentId: id, buyerName: null, buyerEmail: null, erasedAt: deps.now }
          : { fiscalDocumentId: id, buyerName: draft.buyerName?.slice(0, 200) ?? null, buyerEmail: draft.buyerEmail?.slice(0, 320) ?? null },
      });
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

/* ------------------------------------------------------------ full tax invoice on request (C-P2) */

/** What staff enter for a VAT-registered buyer (owner decision C-P2). Validated by the caller (`fiscal-reissue.service.ts`). */
export interface FullInvoiceBuyer {
  legalName: string;
  /** 15 digits. */
  trn: string;
  address: string;
}

export type ReissueRefusal =
  | "not_found"
  | "not_simplified"
  | "already_reissued"
  | "refunds_exist"
  | "bad_snapshot"
  | "environment_mismatch"
  | "seller_unconfigured"
  | "vat_rule_unconfirmed"
  | "layout_pending"
  | "series_missing"
  | "series_format";

export type ReissueOutcome =
  | {
      kind: "reissued";
      cancelled: { id: string; displayNumber: string };
      /** `fileId`: the generated file row (pending until the documents job draws it; then served by `/api/tickets/generated/<fileId>`). */
      creditNote: { id: string; displayNumber: string; fileId: string };
      invoice: { id: string; displayNumber: string; fileId: string };
    }
  | { kind: "refused"; reason: ReissueRefusal };

class ReissueRefused extends Error {
  constructor(readonly reason: ReissueRefusal) {
    super(reason);
  }
}

export const REISSUE_CANCEL_NOTE = "Cancelled: reissued as a full tax invoice";
export const REISSUE_REASON_LABEL = "Reissued as a full tax invoice";

/**
 * C-P2: a simplified invoice is reissued as a full tax invoice for a VAT-registered buyer. In ONE transaction, both
 * series rows locked (invoice series first, then the credit note series): a credit note (`reissue_cancel`) that
 * cancels the simplified invoice line by line, and a new invoice (`reissue_full`) under the next invoice number with
 * the same lines, date of supply and amounts, the buyer's legal name, address and TRN on its party row. Gap-free as
 * any issue: a refusal or a fault rolls both counters back. No ledger entry: no money moves.
 *
 * Refused when: the invoice is not a simplified money invoice, it was already reissued, it has a credit note or the
 * payment has a refund that did not fail (staff handle those by hand: the full invoice would have to start from the
 * refunded remainder), or a production document could not be issued today (same gates as `issueForLedgerEntry`).
 * The caller checks the permission, the step-up and audits (`fiscal-reissue.service.ts`).
 */
export async function reissueAsFullTaxInvoice(displayNumber: string, buyer: FullInvoiceBuyer, deps: Omit<IssueDeps, "startAt" | "faultAfterCounter">): Promise<ReissueOutcome> {
  const original = await prisma.fiscalDocument.findUnique({ where: { displayNumber }, include: { party: true, files: { orderBy: { version: "desc" }, take: 1, select: { snapshot: true } } } });
  if (!original || original.docType !== "tax_invoice") return { kind: "refused", reason: "not_found" };
  if (original.issueReason !== "money") return { kind: "refused", reason: "not_simplified" };
  const snap = original.files[0]?.snapshot;
  if (!isFiscalSnapshot(snap) || snap.displayNumber !== original.displayNumber) return { kind: "refused", reason: "bad_snapshot" };
  if (snap.invoiceType === "full") return { kind: "refused", reason: "not_simplified" };
  // A plain object type for the copies below (the predicate narrows a Prisma JSON value to an intersection).
  const base = snap as FiscalSnapshot;
  const environment = original.environment as FiscalEnvironment;
  if (environment === "production") {
    if (!deps.productionAllowed) return { kind: "refused", reason: "environment_mismatch" };
    if (deps.seller.placeholder) return { kind: "refused", reason: "seller_unconfigured" };
    if (!(deps.vatRuleConfirmed ?? VAT_RULE_CONFIRMED)) return { kind: "refused", reason: "vat_rule_unconfirmed" };
    if (!(deps.layoutProductionReady ?? plainFiscalLayout.productionReady)) return { kind: "refused", reason: "layout_pending" };
  }
  const lock = async (tx: Tx, docType: FiscalDocType) => {
    const [row] = await tx.$queryRaw<{ id: string; prefix: string; next_number: bigint; pad_to: number }[]>`
      SELECT id, prefix, next_number, pad_to FROM fiscal_series
      WHERE legal_entity = ${deps.legalEntity} AND environment = ${environment} AND doc_type = ${docType}
      FOR UPDATE`;
    if (!row) throw new ReissueRefused("series_missing");
    if (environment === "production" && (row.prefix !== FISCAL_SERIES_FORMAT[docType].prefix || row.pad_to !== FISCAL_SERIES_FORMAT[docType].padTo)) throw new ReissueRefused("series_format");
    return row;
  };
  try {
    const out = await prisma.$transaction(async (tx) => {
      const invSeries = await lock(tx, "tax_invoice");
      const cnSeries = await lock(tx, "tax_credit_note");
      // Under the locks: a concurrent reissue has committed by now if it won (also unique indexes on both links).
      if (await tx.fiscalDocument.count({ where: { OR: [{ replacesId: original.id }, { refersToId: original.id, issueReason: "reissue_cancel" }] } })) throw new ReissueRefused("already_reissued");
      const credits = await tx.fiscalDocument.count({ where: { refersToId: original.id } });
      const refunds = await tx.refund.count({ where: { paymentId: original.paymentId, status: { not: "failed" } } });
      if (credits || refunds) throw new ReissueRefused("refunds_exist");
      const cnNumber = displayNumberOf(cnSeries.prefix, cnSeries.next_number, cnSeries.pad_to);
      const invNumber = displayNumberOf(invSeries.prefix, invSeries.next_number, invSeries.pad_to);
      await tx.$executeRaw`UPDATE fiscal_series SET next_number = next_number + 1, updated_at = ${deps.now} WHERE id IN (${invSeries.id}::uuid, ${cnSeries.id}::uuid)`;
      const vatRuleConfirmed = deps.vatRuleConfirmed ?? VAT_RULE_CONFIRMED;
      const templateVersion = plainFiscalLayout.templateVersion;

      const cnId = uuidv7();
      const cnLines: FiscalLine[] = base.lines.map((l) => ({ ...l, note: REISSUE_CANCEL_NOTE }));
      const cnSnapshot: FiscalSnapshot = {
        docType: "tax_credit_note",
        displayNumber: cnNumber,
        environment,
        issuedAt: deps.now.toISOString(),
        supplyDate: dubaiIsoDate(deps.now),
        currency: "AED",
        orderReference: base.orderReference,
        seller: deps.seller,
        lines: cnLines,
        totals: base.totals,
        moneyAt: deps.now.toISOString(),
        paymentMethodLabel: base.paymentMethodLabel,
        refersTo: { displayNumber: original.displayNumber, issuedAt: original.issuedAt.toISOString() },
        refundReasonLabel: REISSUE_REASON_LABEL,
        vatRule: original.vatRule,
        vatRuleConfirmed,
        templateVersion,
        ...(base.fx ? { fx: base.fx } : {}),
        reissue: { kind: "cancel", replacementNumber: invNumber },
      };
      await tx.fiscalDocument.create({
        data: {
          id: cnId,
          seriesId: cnSeries.id,
          number: cnSeries.next_number,
          displayNumber: cnNumber,
          docType: "tax_credit_note",
          environment,
          orderId: original.orderId,
          paymentId: original.paymentId,
          refundId: null,
          ledgerEntryId: null,
          refersToId: original.id,
          issueReason: "reissue_cancel",
          issuedAt: deps.now,
          supplyDate: new Date(`${cnSnapshot.supplyDate}T00:00:00Z`),
          currency: "AED",
          netMinor: original.netMinor,
          vatMinor: original.vatMinor,
          grossMinor: original.grossMinor,
          seller: deps.seller as unknown as Prisma.InputJsonValue,
          lines: cnLines as unknown as Prisma.InputJsonValue,
          vatRule: original.vatRule,
          templateVersion,
        },
      });
      const p = original.party;
      await tx.fiscalDocumentParty.create({
        data: p?.erasedAt ? { fiscalDocumentId: cnId, erasedAt: p.erasedAt } : { fiscalDocumentId: cnId, buyerName: p?.buyerName ?? null, buyerEmail: p?.buyerEmail ?? null },
      });

      const invId = uuidv7();
      const invSnapshot: FiscalSnapshot = {
        ...base,
        displayNumber: invNumber,
        environment,
        issuedAt: deps.now.toISOString(),
        seller: deps.seller,
        vatRuleConfirmed,
        templateVersion,
        invoiceType: "full",
        reissue: { kind: "full", replacesNumber: original.displayNumber, cancelledBy: cnNumber },
      };
      await tx.fiscalDocument.create({
        data: {
          id: invId,
          seriesId: invSeries.id,
          number: invSeries.next_number,
          displayNumber: invNumber,
          docType: "tax_invoice",
          environment,
          orderId: original.orderId,
          paymentId: original.paymentId,
          refundId: null,
          ledgerEntryId: null,
          refersToId: null,
          replacesId: original.id,
          issueReason: "reissue_full",
          issuedAt: deps.now,
          // The supply has not moved: the date of supply stays the capture date (A4).
          supplyDate: original.supplyDate,
          currency: "AED",
          netMinor: original.netMinor,
          vatMinor: original.vatMinor,
          grossMinor: original.grossMinor,
          seller: deps.seller as unknown as Prisma.InputJsonValue,
          lines: base.lines as unknown as Prisma.InputJsonValue,
          vatRule: original.vatRule,
          templateVersion,
        },
      });
      await tx.fiscalDocumentParty.create({ data: { fiscalDocumentId: invId, buyerName: buyer.legalName.slice(0, 200), buyerTrn: buyer.trn, buyerAddress: buyer.address.slice(0, 500), buyerEmail: null } });
      const cnFileId = uuidv7();
      const invFileId = uuidv7();
      await tx.generatedDocument.createMany({
        data: [
          { id: cnFileId, kind: "tax_credit_note", orderId: original.orderId, fiscalDocumentId: cnId, templateVersion, snapshot: cnSnapshot as unknown as Prisma.InputJsonValue, status: "pending" },
          { id: invFileId, kind: "tax_invoice", orderId: original.orderId, fiscalDocumentId: invId, templateVersion, snapshot: invSnapshot as unknown as Prisma.InputJsonValue, status: "pending" },
        ],
      });
      return {
        cancelled: { id: original.id, displayNumber: original.displayNumber },
        creditNote: { id: cnId, displayNumber: cnNumber, fileId: cnFileId },
        invoice: { id: invId, displayNumber: invNumber, fileId: invFileId },
      };
    }, TX_OPTIONS);
    emitEvent("fiscal.issued", { fiscalDocumentId: out.creditNote.id, docType: "tax_credit_note" });
    emitEvent("fiscal.issued", { fiscalDocumentId: out.invoice.id, docType: "tax_invoice" });
    return { kind: "reissued", ...out };
  } catch (err) {
    if (err instanceof ReissueRefused) return { kind: "refused", reason: err.reason };
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { kind: "refused", reason: "already_reissued" };
    throw err;
  }
}

export interface IssueDueSummary {
  skipped?: "switch_off" | "start_at_missing";
  scanned: number;
  issued: number;
  blocked: number;
  errors: number;
  /** Review 109c N1: production captures booked before the start that will never be invoiced (counted at most hourly). */
  beforeStartUninvoiced?: number;
}

/** How often the documents job counts the captures that fall before the start (review 109c N1). */
export const BEFORE_START_COUNT_EVERY_MS = 60 * 60_000;
let beforeStartCountedAt = 0;
/** Review 109d R10: the last count logged and when; the same count is logged again at most once a day. */
let beforeStartLogged: { count: number; at: number } | null = null;
const BEFORE_START_RELOG_MS = 24 * 3600_000;

/**
 * Review 109c N1 / owner decision C-P3: production captures booked before `FISCAL_DOCUMENTS_START_AT` (28 Nov 2026
 * 00:00 Dubai) are outside the series for good (A12: the payments before it were tests). The count is logged for
 * staff (`fiscal.before_start_uninvoiced`, warn) whenever it is not zero, so a real sale left out is seen.
 */
export async function countCapturesBeforeStart(startAt: Date): Promise<number> {
  const [row] = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM ledger_entries l JOIN payments p ON p.id = l.payment_id
    WHERE l.book = 'customer_money' AND l.kind = 'capture' AND p.environment = 'production' AND l.occurred_at < ${startAt}
      AND NOT EXISTS (SELECT 1 FROM fiscal_documents f WHERE f.ledger_entry_id = l.id)`;
  return row?.n ?? 0;
}

/** The documents-job step: issue due documents, oldest entry first. Never throws. */
export async function issueDue(opts: { now: Date; e?: Env; max?: number; scan?: number; deps?: Partial<IssueDeps>; ledgerEntryIds?: readonly string[]; deadline?: number }): Promise<IssueDueSummary> {
  const e = opts.e ?? env();
  const summary: IssueDueSummary = { scanned: 0, issued: 0, blocked: 0, errors: 0 };
  if (!e.FISCAL_DOCUMENTS_ENABLED) return { ...summary, skipped: "switch_off" };
  const deps: IssueDeps = { now: opts.now, legalEntity: e.FISCAL_LEGAL_ENTITY, seller: sellerFromEnv(e), productionAllowed: e.isProduction, startAt: e.FISCAL_DOCUMENTS_START_AT, ...opts.deps };
  // A12, fail closed: the switch on without a valid start issues nothing (the boot check reports it).
  if (!deps.startAt) {
    emitEvent("fiscal.sweep_failed", { stage: "scan", reason: "start_at_missing" }, "error");
    return { ...summary, skipped: "start_at_missing" };
  }
  const startAt = deps.startAt;
  // `ledgerEntryIds` limits the scan (tests on a shared database).
  const scope = opts.ledgerEntryIds ? Prisma.sql`AND l.id IN (${Prisma.join(opts.ledgerEntryIds.length ? opts.ledgerEntryIds.map((id) => Prisma.sql`${id}::uuid`) : [Prisma.sql`NULL::uuid`])})` : Prisma.empty;
  const recheckBefore = new Date(opts.now.getTime() - FISCAL_BLOCKED_RECHECK_MS);
  let rows: { id: string }[] = [];
  try {
    rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT l.id FROM ledger_entries l
      WHERE l.book = 'customer_money' AND l.kind IN ('capture', 'refund') AND l.payment_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM fiscal_documents f WHERE f.ledger_entry_id = l.id)
        -- A12: nothing booked before the go-live start, and no refund of a capture booked before it (no backfill).
        AND l.occurred_at >= ${startAt}
        AND NOT (l.kind = 'refund' AND EXISTS (
          SELECT 1 FROM ledger_entries c0
          WHERE c0.payment_id = l.payment_id AND c0.book = 'customer_money' AND c0.kind = 'capture' AND c0.occurred_at < ${startAt}))
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
  // N1: the job's own run (not a scoped test run), at most hourly per instance.
  if (!opts.ledgerEntryIds && Date.now() - beforeStartCountedAt >= BEFORE_START_COUNT_EVERY_MS && (opts.deadline === undefined || Date.now() + FISCAL_UNIT_MS <= opts.deadline)) {
    beforeStartCountedAt = Date.now();
    try {
      summary.beforeStartUninvoiced = await countCapturesBeforeStart(startAt);
      const n = summary.beforeStartUninvoiced;
      if (n > 0 && (!beforeStartLogged || beforeStartLogged.count !== n || Date.now() - beforeStartLogged.at >= BEFORE_START_RELOG_MS)) {
        emitEvent("fiscal.before_start_uninvoiced", { count: n }, "warn");
        beforeStartLogged = { count: n, at: Date.now() };
      }
    } catch {
      emitEvent("fiscal.sweep_failed", { stage: "before_start_count", reason: "query_failed" }, "error");
    }
  }
  return summary;
}

/* ------------------------------------------------------------ refund reconciliation */

export interface ReconcileSummary {
  skipped?: "start_at_missing";
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
 * the fiscal switch says, but only for payments captured at or after
 * `FISCAL_DOCUMENTS_START_AT` (A12: earlier payments were tests; nothing is
 * reconciled while it is unset, and an open row on an earlier payment is
 * closed). Never throws.
 *
 * In-flight refunds (review finding 8): the provider total moves as soon as
 * the provider shows a refund, while our row may still be `requested`,
 * `accepted` or `unknown`. Those rows count too, so an ordinary refund never
 * opens a row; and a row is alerted only once the gap has lasted
 * `REFUND_GAP_ALERT_AFTER_MS` (`fiscalAttentionOpen`), so a short flap never
 * reaches the ops email.
 */
export async function reconcileRefunds(now: Date, opts: { paymentIds?: readonly string[]; startAt?: Date | null } = {}): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = { checked: 0, raised: 0, resolved: 0 };
  const startAt = opts.startAt === undefined ? env().FISCAL_DOCUMENTS_START_AT : opts.startAt;
  if (!startAt) return { ...summary, skipped: "start_at_missing" };
  // `paymentIds` limits the check (tests on a shared database).
  const scope = opts.paymentIds ? Prisma.sql`AND p.id IN (${Prisma.join(opts.paymentIds.length ? opts.paymentIds.map((id) => Prisma.sql`${id}::uuid`) : [Prisma.sql`NULL::uuid`])})` : Prisma.empty;
  try {
    const rows = await prisma.$queryRaw<{ id: string; order_id: string; refunded_minor: bigint; settled: bigint; in_scope: boolean }[]>`
      SELECT p.id, p.order_id, p.refunded_minor,
        COALESCE((SELECT SUM(r.amount_minor) FROM refunds r WHERE r.payment_id = p.id AND r.status IN ('succeeded', 'requested', 'accepted', 'unknown')), 0)::bigint AS settled,
        -- A12: the capture time (the capture ledger entry, else the payment's own capture time) at or after the start.
        COALESCE(COALESCE(
          (SELECT MIN(c.occurred_at) FROM ledger_entries c WHERE c.payment_id = p.id AND c.book = 'customer_money' AND c.kind = 'capture'),
          p.captured_at) >= ${startAt}, false) AS in_scope
      FROM payments p
      WHERE p.captured_minor > 0 AND (p.refunded_minor > 0 OR EXISTS (SELECT 1 FROM fiscal_attention a WHERE a.entity_kind = 'payment' AND a.entity_id = p.id AND a.resolved_at IS NULL))
        ${scope}`;
    for (const r of rows) {
      if (!r.in_scope) {
        // A test payment from before go-live: never alerted; a row opened before this rule is closed.
        summary.resolved += await resolveAttention(prisma, "payment", r.id, now, ["refund_without_refund_row"]);
        continue;
      }
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
  // Review 109d R7: a missing CBUAE rate opens a row per INR capture (each held invoice keeps its own row), but staff
  // are alerted once per Dubai day overall: only the first such row raised that day is an incident.
  const rows = await prisma.$queryRaw<{ id: string; entity_kind: string; entity_id: string; order_id: string | null; reason: string; raised_at: Date; reference: string | null }[]>`
    SELECT * FROM (
      SELECT a.id, a.entity_kind, a.entity_id, a.order_id, a.reason, a.raised_at, o.reference
      FROM fiscal_attention a LEFT JOIN orders o ON o.id = a.order_id
      WHERE a.resolved_at IS NULL AND a.raised_at >= ${since} AND a.raised_at <= ${now} AND a.reason <> 'fx_rate_missing'
        AND (a.reason <> 'refund_without_refund_row' OR a.raised_at <= ${new Date(now.getTime() - REFUND_GAP_ALERT_AFTER_MS)})
      UNION ALL
      (SELECT DISTINCT ON ((a.raised_at AT TIME ZONE 'Asia/Dubai')::date) a.id, a.entity_kind, a.entity_id, a.order_id, a.reason, a.raised_at, o.reference
      FROM fiscal_attention a LEFT JOIN orders o ON o.id = a.order_id
      WHERE a.reason = 'fx_rate_missing' AND a.resolved_at IS NULL AND a.raised_at >= ${since} AND a.raised_at <= ${now}
        AND NOT EXISTS (
          SELECT 1 FROM fiscal_attention b
          WHERE b.reason = 'fx_rate_missing' AND b.id <> a.id
            AND (b.raised_at AT TIME ZONE 'Asia/Dubai')::date = (a.raised_at AT TIME ZONE 'Asia/Dubai')::date AND b.raised_at < ${since})
      ORDER BY (a.raised_at AT TIME ZONE 'Asia/Dubai')::date, a.raised_at ASC)
    ) x
    ORDER BY x.raised_at DESC LIMIT ${limit}`;
  return rows.map((r) => ({ id: r.id, entityKind: r.entity_kind, entityId: r.entity_id, orderId: r.order_id, reason: r.reason, raisedAt: r.raised_at, reference: r.reference }));
}
