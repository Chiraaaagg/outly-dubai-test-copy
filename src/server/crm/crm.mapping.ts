import { createHash } from "node:crypto";
import { CrmCallError, type DealFields, type ProductRow } from "./bitrix.client";
import type { CrmConfig, CrmStageKey } from "./crm.config";

/**
 * Local state → Bitrix24 deal (doc 29 §5.4, §5.5; CRM batch C1). Pure.
 *
 * C1 mapping, narrower than §5.4 on purpose:
 *  - a deal only, in the OUTLYY funnel; no Contact record and no personal
 *    data at all (owner decision 14: contacts only after C0/C2 verify the
 *    role restriction). The deal carries the reference, stage, revenue,
 *    currency and product rows (product name and service date) only;
 *  - one deal per inquiry, reused when the inquiry converts to an order;
 *    a new deal only for a direct-checkout order, and only once a card
 *    authorisation (or capture) was verified with the provider. Spam,
 *    abandoned carts, erased subjects and unpaid payment sessions never
 *    create a deal;
 *  - opportunity = provider-verified captured amount minus the payments'
 *    refunded totals (settled refunds and the provider's read), zero until capture, `isManualOpportunity` so the CRM
 *    never recomputes it from rows; inquiry rows carry price 0, so an
 *    indicative amount is never shown as revenue;
 *  - no margin, cost or net-rate field (owner decision 17: managers only,
 *    with the C2 role), no status custom fields (C2 creates them), no admin
 *    link, no UTM, no consent flags.
 *
 * Never sent (§5.5): recovery or access tokens, one-time codes, ticket or QR
 * codes, Stripe identifiers, card data, supplier credentials, net rates,
 * margin, names, phones, emails, hotels, notes. `assertSafeCrmPayload` is the
 * last check before any write and refuses anything outside the field
 * allowlist or shaped like those values.
 */

export type CrmEntityType = "inquiry" | "order";
export interface CrmSubject {
  type: CrmEntityType;
  id: string;
}

/** Snapshot contract version; bump when the pushed shape changes so every link re-pushes. */
export const CRM_PAYLOAD_VERSION = 1;

export interface CrmItemFacts {
  title: string;
  /** YYYY-MM-DD, or null when not known (flexible inquiry dates). */
  serviceDate: string | null;
  /** Customer price of the line in the deal currency, minor units; null for inquiry lines. */
  totalMinor: bigint | null;
  /** Order items: pending | confirmed | rejected | cancelled | completed. */
  status?: string;
  /** Order items sold through instant checkout need a valid supplier document to be fulfilled. */
  needsDocument?: boolean;
  documentReady?: boolean;
}

export interface CrmOrderFacts {
  reference: string;
  status: string;
  currency: string;
  /** A provider-verified authorisation or capture exists (the direct-checkout deal becomes visible). */
  authorised: boolean;
  /** Provider-verified, in `currency`, minor units. */
  capturedMinor: bigint;
  refundedMinor: bigint;
  items: CrmItemFacts[];
}

export interface CrmInquiryFacts {
  reference: string;
  status: string;
  source: string;
  currency: string;
  items: CrmItemFacts[];
}

/** Everything the mapping may read about one subject. Built by crm.snapshot.ts from current rows. */
export interface CrmSubjectState {
  subject: CrmSubject;
  exists: boolean;
  /** The subject was pseudonymised by the erasure workflow. */
  erased: boolean;
  inquiry: CrmInquiryFacts | null;
  order: CrmOrderFacts | null;
}

export type CrmMapped =
  | { visible: false; reason: "missing" | "erased" | "abandoned_cart" | "not_authorised" }
  | { visible: true; createAllowed: boolean; stage: CrmStageKey; fields: DealFields; rows: ProductRow[]; hash: string };

const INQUIRY_STAGE: Record<string, CrmStageKey> = {
  new: "new_inquiry",
  assigned: "assigned",
  contacted: "contacted",
  quoted: "quoted",
  negotiating: "negotiating",
  payment_pending: "payment_pending",
  // `won` always has an order (check inquiry_won_has_order); the order decides the stage.
  won: "payment_pending",
  lost: "lost",
  spam: "spam",
};

export function originIdFor(subject: CrmSubject): string {
  return `${subject.type === "inquiry" ? "inq" : "ord"}:${subject.id}`;
}

function fulfilled(o: CrmOrderFacts): boolean {
  const live = o.items.filter((i) => i.status === "confirmed" || i.status === "completed");
  return live.length > 0 && live.every((i) => !i.needsDocument || i.documentReady === true);
}

/** The order's stage, or null while a direct-checkout order must stay invisible. */
export function orderStage(o: CrmOrderFacts): CrmStageKey | null {
  switch (o.status) {
    case "pending_payment":
      return o.authorised ? "payment_pending" : null;
    case "payment_failed":
      return o.authorised ? "cancelled" : null;
    case "paid":
    case "supplier_pending":
      return "paid_awaiting_supplier";
    case "confirmed":
    case "partially_confirmed":
      return fulfilled(o) ? "fulfilled" : "confirmed_tickets_pending";
    case "completed":
      return "fulfilled";
    case "cancelled":
      return "cancelled";
    case "refunded":
      return "refunded";
    default:
      return null;
  }
}

/** Minor units to the decimal amount Bitrix24 expects (two-place currencies only: AED, INR). */
export function majorUnits(minor: bigint): number {
  return Number(minor) / 100;
}

function clean(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function rowsFor(items: CrmItemFacts[], priced: boolean): ProductRow[] {
  return items
    .filter((i) => i.status !== "rejected" && i.status !== "cancelled")
    .map((i) => ({
      productName: clean(i.serviceDate ? `${i.title} (${i.serviceDate})` : i.title, 255) || "Activity",
      price: priced && i.totalMinor !== null && i.totalMinor > 0n ? majorUnits(i.totalMinor) : 0,
      quantity: 1,
    }));
}

export function snapshotHash(fields: DealFields, rows: ProductRow[]): string {
  return createHash("sha256").update(JSON.stringify({ v: CRM_PAYLOAD_VERSION, fields, rows })).digest("hex");
}

export function mapDeal(state: CrmSubjectState, cfg: Pick<CrmConfig, "categoryId" | "stageIds" | "originatorId">): CrmMapped {
  if (!state.exists) return { visible: false, reason: "missing" };
  if (state.erased) return { visible: false, reason: "erased" };
  const { inquiry, order } = state;
  if (state.subject.type === "inquiry" && !inquiry) return { visible: false, reason: "missing" };
  if (state.subject.type === "order" && !order) return { visible: false, reason: "missing" };
  // Abandoned carts become CRM records only with recovery consent (doc 29 §5.3 phase 3), not in C1.
  if (inquiry && inquiry.source === "abandoned_cart") return { visible: false, reason: "abandoned_cart" };

  let stage: CrmStageKey | null;
  if (state.subject.type === "order") {
    stage = orderStage(order!);
    if (!stage) return { visible: false, reason: "not_authorised" };
  } else {
    stage = (order ? orderStage(order) : null) ?? INQUIRY_STAGE[inquiry!.status] ?? "new_inquiry";
  }

  const references = [inquiry?.reference, order?.reference].filter((r): r is string => Boolean(r));
  const currency = order?.currency ?? inquiry?.currency ?? "AED";
  const revenue = order ? order.capturedMinor - order.refundedMinor : 0n;
  const fields: DealFields = {
    title: clean(`OUTLYY ${references.join(" / ")}`, 255),
    categoryId: cfg.categoryId,
    stageId: cfg.stageIds[stage],
    opportunity: majorUnits(revenue > 0n ? revenue : 0n),
    currencyId: currency,
    isManualOpportunity: "Y",
    originatorId: cfg.originatorId,
    originId: originIdFor(state.subject),
  };
  const rows = order ? rowsFor(order.items, true) : rowsFor(inquiry!.items, false);
  // Spam never creates a deal; an existing one moves to the Spam stage.
  return { visible: true, createAllowed: stage !== "spam", stage, fields, rows, hash: snapshotHash(fields, rows) };
}

const DEAL_KEYS = ["title", "categoryId", "stageId", "opportunity", "currencyId", "isManualOpportunity", "originatorId", "originId"].sort().join(",");
const ROW_KEYS = ["price", "productName", "quantity"].join(",");

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE = /\+\s*\d[\d\s().-]{5,}\d/;
const LONG_DIGITS = /\d{9,}/;
const TOKEN = /[A-Za-z0-9_-]{32,}/;
const STRIPE_ID = /\b(?:pi|ch|cs|re|pm|py|cus|acct|seti|src|tok|sk|pk|rk|whsec|evt|txn|po|cn|dp)_[A-Za-z0-9]{6,}/;
const URLISH = /(?:https?:)?\/\/|www\./i;
const MARKER = /\[deleted-/;
const REFERENCE = /\b(?:INQ|OUT)-\d{5,11}\b/g;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;

function refuse(code: string): never {
  throw new CrmCallError("refused", "payload", { code });
}

function checkText(text: string, field: string): void {
  // Our own references and service dates are expected digits; everything else is scanned.
  const t = text.replace(REFERENCE, "REF").replace(ISO_DATE, "DATE");
  // Most specific first, so the code names the actual finding.
  if (MARKER.test(t)) refuse(`${field}_erased_marker`);
  if (EMAIL.test(t)) refuse(`${field}_email`);
  if (URLISH.test(t)) refuse(`${field}_url`);
  if (STRIPE_ID.test(t)) refuse(`${field}_provider_id`);
  if (TOKEN.test(t)) refuse(`${field}_token`);
  if (PHONE.test(t) || LONG_DIGITS.test(t)) refuse(`${field}_digits`);
}

/**
 * The last check before any write (doc 29 §5.5 "never sent"): only the
 * allowlisted keys, each of the expected shape, and no free text that looks
 * like contact data, a token, a provider id, a URL or an erasure marker.
 * Throws `CrmCallError("refused")`: the row is dead-lettered, never retried.
 */
export function assertSafeCrmPayload(fields: DealFields, rows: ProductRow[]): void {
  if (Object.keys(fields).sort().join(",") !== DEAL_KEYS) refuse("deal_keys");
  if (!/^outlyy-(development|staging|production)$/.test(fields.originatorId)) refuse("originator");
  if (!/^(inq|ord):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fields.originId)) refuse("origin");
  if (!Number.isInteger(fields.categoryId) || fields.categoryId <= 0) refuse("category");
  if (!/^C\d{1,9}:[A-Z0-9_]{1,40}$/.test(fields.stageId) || !fields.stageId.startsWith(`C${fields.categoryId}:`)) refuse("stage");
  if (fields.currencyId !== "AED" && fields.currencyId !== "INR") refuse("currency");
  if (!Number.isFinite(fields.opportunity) || fields.opportunity < 0) refuse("opportunity");
  if (fields.isManualOpportunity !== "Y") refuse("manual_opportunity");
  if (fields.title.length > 255) refuse("title_length");
  checkText(fields.title, "title");
  if (rows.length > 50) refuse("rows_count");
  for (const r of rows) {
    if (Object.keys(r).sort().join(",") !== ROW_KEYS) refuse("row_keys");
    if (!Number.isFinite(r.price) || r.price < 0 || !Number.isInteger(r.quantity) || r.quantity < 1) refuse("row_amount");
    if (r.productName.length > 255) refuse("row_length");
    checkText(r.productName, "row");
  }
}
