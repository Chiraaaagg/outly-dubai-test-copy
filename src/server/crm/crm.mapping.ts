import { createHash } from "node:crypto";
import { CrmCallError, type DealFields, type ProductRow } from "./bitrix.client";
import type { CrmConfig, CrmFieldKey, CrmStageKey } from "./crm.config";
import { evaluateMargin, type FixedCost } from "../domain/margin";

/**
 * Local state → Bitrix24 deal (doc 29 §5.4, §5.5, §8.8; doc 29d; CRM batches
 * C1 and C2a). Pure.
 *
 *  - A deal only, in the OUTLYY funnel; no Contact record (decision C2-4).
 *    One deal per inquiry, reused when the inquiry converts to an order; a
 *    new deal only for a direct-checkout order, and only once a card
 *    authorisation (or capture) was verified with the provider. Spam,
 *    abandoned carts, erased subjects and unpaid payment sessions never
 *    create a deal.
 *  - Stages: the 12 of decision C2-7. The inquiry status `negotiating` maps
 *    to "Quoted" (there is no "Negotiating" stage).
 *  - opportunity = revenue: provider-verified captured amounts plus payments
 *    a staff member recorded in OUTLYY admin (owner answer Q4), minus each
 *    payment's verified refunds; zero until paid; `isManualOpportunity` so
 *    the CRM never recomputes it from rows. Inquiry rows carry price 0, so an
 *    indicative amount is never shown as revenue (it has its own field).
 *  - The OUTLYY custom fields (C2a, codes from `CRM_BITRIX_FIELD_CODES`):
 *    reference, environment, admin link (a plain URL, no token), customer
 *    name, phone and email (only for a submitted inquiry or a paid or
 *    authorised order, never on a spam deal), status words for payment,
 *    supplier booking, tickets and refund, refund amount, travel date, item
 *    summary, "as of" time, indicative amount, margin (one AED amount, empty
 *    when a cost is unknown, decision C2-9 / Q8), and the two marketing
 *    consent flags with their times (Q6).
 *  - The responsible person (the default owner, decision C2-8) is sent on
 *    create only, so a reassignment by the sales lead is kept.
 *
 * Never sent (§5.5 as changed by §8.8): recovery or access tokens, one-time
 * codes, ticket or QR codes, Stripe identifiers, card data, supplier
 * credentials, net cost or supplier rates, participant names or ages,
 * hotels, dietary or other notes, IP hashes, spam signals, audit text.
 * The snapshot never reads them; `assertSafeCrmPayload` is the last check
 * before any write and refuses anything outside the field allowlist or not
 * of its field's exact shape.
 */

export type CrmEntityType = "inquiry" | "order";
export interface CrmSubject {
  type: CrmEntityType;
  id: string;
}

/** Snapshot contract version; bump when the pushed shape changes so every link re-pushes. */
export const CRM_PAYLOAD_VERSION = 2;

export interface CrmItemFacts {
  /** The catalogue's name for the line (product title or combo name), never the item's editable title snapshot; null without a catalogue record. */
  title: string | null;
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
  /** A provider-verified authorisation or capture exists, or a staff-recorded payment (the deal becomes visible). */
  authorised: boolean;
  /** Revenue evidence in `currency`, minor units: provider-verified captures plus staff-recorded payments (Q4). */
  capturedMinor: bigint;
  /** Verified refunds of those payments, at most `capturedMinor`. */
  refundedMinor: bigint;
  items: CrmItemFacts[];
  /** The order's charged total in `currency`, minor units (the indicative amount of a sale). */
  totalMinor?: bigint;
  /** A refund is requested or still waiting for the provider. */
  refundPending?: boolean;
  /** Margin in AED minor units; null when a live line's cost is not known or the order is not charged in AED. */
  marginAedMinor?: bigint | null;
  /** A counted payment exists in another currency than the order's (never converted; review C2A-05). */
  otherCurrencyPaid?: boolean;
  /**
   * Our team took the order over: a supplier booking or the payment saga is flagged for staff (the Batch 6
   * external-confirmation hand-off, a booking needing staff, a saga needing attention). Drives the timeline's
   * "handed to the team" moment only (C2B-03); never a deal field.
   */
  handedToTeam?: boolean;
}

export interface CrmInquiryFacts {
  reference: string;
  status: string;
  source: string;
  currency: string;
  items: CrmItemFacts[];
  /** Indicative total in `currency`, minor units (never revenue). */
  indicativeMinor?: bigint;
}

/** The customer's own details as given on the inquiry or order (decision C2-4: on the deal only). */
export interface CrmContactFacts {
  name: string;
  /** E.164. */
  phone: string;
  email: string | null;
}

/** The latest row of OUTLYY's append-only consent record for one channel and purpose. */
export interface CrmConsentFlag {
  granted: boolean;
  /** ISO instant of that row. */
  at: string;
}

export interface CrmConsentFacts {
  marketingEmail: CrmConsentFlag | null;
  marketingWhatsapp: CrmConsentFlag | null;
}

/** Everything the mapping may read about one subject. Built by crm.snapshot.ts from current rows. */
export interface CrmSubjectState {
  subject: CrmSubject;
  exists: boolean;
  /** The subject was pseudonymised by the erasure workflow. */
  erased: boolean;
  inquiry: CrmInquiryFacts | null;
  order: CrmOrderFacts | null;
  /** When the subject was created (inquiry submitted, order placed); no deal for one created before switch-on. */
  createdAt?: Date;
  /** Null when not read (an erased subject) or not allowed. */
  contact?: CrmContactFacts | null;
  consent?: CrmConsentFacts;
}

/** What the mapping and the guard need from the configuration. */
export type CrmMappingConfig = Pick<CrmConfig, "environment" | "categoryId" | "stageIds" | "originatorId" | "fieldCodes" | "defaultOwnerId" | "adminBaseUrl">;

export type CrmMapped =
  | { visible: false; reason: "missing" | "erased" | "abandoned_cart" | "not_authorised" }
  | {
      visible: true;
      createAllowed: boolean;
      stage: CrmStageKey;
      /** For an update: never the responsible person. */
      fields: DealFields;
      /** For a create: `fields` plus the default owner. */
      createFields: DealFields;
      rows: ProductRow[];
      /** Over `fields` without the "as of" time, and the rows. */
      hash: string;
    };

const INQUIRY_STAGE: Record<string, CrmStageKey> = {
  new: "new_inquiry",
  assigned: "assigned",
  contacted: "contacted",
  quoted: "quoted",
  // Decision C2-7: there is no "Negotiating" stage.
  negotiating: "quoted",
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

/** The name of a line without a catalogue record. */
export const GENERIC_LINE = "Activity";

function rowsFor(items: CrmItemFacts[], priced: boolean): ProductRow[] {
  return items
    .filter((i) => i.status !== "rejected" && i.status !== "cancelled")
    .map((i) => ({
      productName: clean(i.serviceDate ? `${i.title ?? GENERIC_LINE} (${i.serviceDate})` : (i.title ?? GENERIC_LINE), 255) || GENERIC_LINE,
      price: priced && i.totalMinor !== null && i.totalMinor > 0n ? majorUnits(i.totalMinor) : 0,
      quantity: 1,
    }));
}

/** A payment row as the snapshot reads it (no provider or link identifier). */
export interface CrmPaymentFacts {
  /** `gateway_verified` (PAY-9) or `manual` (recorded by staff in OUTLYY admin). */
  source: string;
  status: string;
  currency: string;
  amountMinor: bigint;
  capturedMinor: bigint;
  refundedMinor: bigint;
  authorizedAt: Date | null;
  refunds: { status: string; amountMinor: bigint }[];
}

/** Refund rows still waiting for the provider. */
const OPEN_REFUND = new Set(["requested", "accepted", "unknown"]);
/** A staff-recorded payment that was taken (a refund moves it to refunded or partially_refunded). */
const STAFF_COUNTED = new Set(["captured", "partially_refunded", "refunded"]);

/**
 * Revenue evidence of an order (owner answer Q4): provider-verified captures
 * and staff-recorded payments count the same, each in the order's currency
 * only, less its verified refunds (the payment's refunded total, which for
 * gateway payments is max-merged with the provider's read in refunds.ts;
 * for staff-recorded ones also the settled refund rows), never below zero
 * per payment. An unverified gateway row (`source` anything else) never
 * counts.
 */
export function revenueFromPayments(
  payments: CrmPaymentFacts[],
  currency: string,
): { capturedMinor: bigint; refundedMinor: bigint; authorised: boolean; refundPending: boolean; otherCurrencyPaid: boolean } {
  let captured = 0n;
  let refunded = 0n;
  let authorised = false;
  let refundPending = false;
  let otherCurrencyPaid = false;
  for (const p of payments) {
    let counted: bigint;
    let back: bigint;
    if (p.source === "gateway_verified") {
      if (p.authorizedAt || p.capturedMinor > 0n) authorised = true;
      counted = p.capturedMinor;
      back = p.refundedMinor;
    } else if (p.source === "manual") {
      if (!STAFF_COUNTED.has(p.status)) continue;
      authorised = true;
      counted = p.amountMinor;
      const settled = p.refunds.filter((r) => r.status === "succeeded").reduce((n, r) => n + r.amountMinor, 0n);
      back = p.refundedMinor > settled ? p.refundedMinor : settled;
    } else continue;
    if (p.refunds.some((r) => OPEN_REFUND.has(r.status))) refundPending = true;
    if (counted <= 0n) continue;
    if (p.currency !== currency) {
      otherCurrencyPaid = true;
      continue;
    }
    captured += counted;
    refunded += back > counted ? counted : back < 0n ? 0n : back;
  }
  return { capturedMinor: captured, refundedMinor: refunded > captured ? captured : refunded, authorised, refundPending, otherCurrencyPaid };
}

/** An order line as the snapshot reads it for money (customer price and net cost; the net cost never leaves the margin). */
export interface CrmLineMoney {
  status: string;
  totalAed: bigint;
  totalInr: bigint;
  chargedCurrency: string | null;
  chargedAmountMinor: bigint | null;
  netCostAed: bigint;
  /** The quote's MarginSnapshot (instant lines): its `costLines` are the variable costs in the charged currency. */
  marginSnapshot?: unknown;
}

/** The line's customer price in `currency`, minor units. */
export function lineTotalMinor(i: Omit<CrmLineMoney, "status" | "netCostAed">, currency: string): bigint {
  return i.chargedCurrency === currency && i.chargedAmountMinor !== null ? i.chargedAmountMinor : currency === "AED" ? i.totalAed : i.totalInr;
}

/** The variable costs a line's MarginSnapshot recorded, or null when the snapshot is there but unreadable. No snapshot: none recorded. */
function variableCosts(snapshot: unknown): FixedCost[] | null {
  if (snapshot === null || snapshot === undefined) return [];
  const lines = (snapshot as { costLines?: unknown }).costLines;
  if (!Array.isArray(lines)) return null;
  const out: FixedCost[] = [];
  for (const c of lines) {
    const minor = (c as { minor?: unknown })?.minor;
    if ((typeof minor !== "string" || !/^\d{1,15}$/.test(minor)) && !(typeof minor === "number" && Number.isSafeInteger(minor) && minor >= 0)) return null;
    out.push({ label: "cost", amountMinor: BigInt(minor) });
  }
  return out;
}

/**
 * Margin in AED (decision C2-9, Q8; review C2A-10): the gross profit of
 * `domain/margin.ts` summed over the order's live lines, i.e. customer price
 * (the charged amount) − supplier net − the variable costs the quote's
 * MarginSnapshot recorded (gateway fee and the like). Assisted lines have no
 * snapshot, so no variable cost is recorded for them; they count once their
 * net cost is known. Null (an empty field) when any live line's net cost is
 * not known (0 = not recorded) or a snapshot cannot be read. AED orders only.
 */
export function marginAedMinor(lines: CrmLineMoney[]): bigint | null {
  const l = lines.filter((i) => i.status !== "rejected" && i.status !== "cancelled");
  if (!l.length || l.some((i) => i.netCostAed <= 0n)) return null;
  let total = 0n;
  for (const i of l) {
    const costs = variableCosts(i.marginSnapshot);
    const sell = lineTotalMinor(i, "AED");
    if (costs === null || sell < 0n) return null;
    total += evaluateMargin({ sellMinor: sell, supplierNetMinor: i.netCostAed, fixedCosts: costs }).grossProfitMinor;
  }
  return total;
}

/** A Bitrix24 Date/Time value: ISO 8601 in UTC with an explicit `+00:00` offset and whole seconds. */
export function bitrixInstant(d: Date): string {
  return `${d.toISOString().slice(0, 19)}+00:00`;
}

/** The hash of a pushed shape. `asOfCode`: the "as of" field, left out so an unchanged subject is not re-pushed. */
export function snapshotHash(fields: DealFields, rows: ProductRow[], asOfCode?: string): string {
  const hashed: Record<string, unknown> = { ...fields };
  if (asOfCode) delete hashed[asOfCode];
  delete hashed.assignedById;
  return createHash("sha256").update(JSON.stringify({ v: CRM_PAYLOAD_VERSION, fields: hashed, rows })).digest("hex");
}

const live = (i: CrmItemFacts) => i.status !== "rejected" && i.status !== "cancelled";

export const PAYMENT_WORDS = ["", "not_paid", "authorised", "paid", "paid_other_currency", "partially_refunded", "refunded"] as const;
export const SUPPLIER_WORDS = ["", "pending", "confirmed", "partially_confirmed", "not_booked"] as const;
export const TICKET_WORDS = ["", "not_needed", "pending", "partially_issued", "issued"] as const;
export const REFUND_WORDS = ["", "none", "pending", "partially_refunded", "refunded"] as const;

export function paymentStatus(o: CrmOrderFacts | null): (typeof PAYMENT_WORDS)[number] {
  if (!o) return "";
  if (o.refundedMinor > 0n) return o.capturedMinor - o.refundedMinor > 0n ? "partially_refunded" : "refunded";
  if (o.capturedMinor > 0n) return "paid";
  // Paid, but only in another currency: revenue stays 0 (no conversion is invented) and the word says why.
  if (o.otherCurrencyPaid) return "paid_other_currency";
  return o.authorised ? "authorised" : "not_paid";
}

export function supplierStatus(o: CrmOrderFacts | null): (typeof SUPPLIER_WORDS)[number] {
  if (!o || !o.items.length) return "";
  const l = o.items.filter(live);
  if (!l.length) return "not_booked";
  if (l.some((i) => i.status !== "confirmed" && i.status !== "completed")) return "pending";
  return l.length < o.items.length ? "partially_confirmed" : "confirmed";
}

export function ticketStatus(o: CrmOrderFacts | null): (typeof TICKET_WORDS)[number] {
  if (!o) return "";
  const l = o.items.filter(live);
  if (!l.length) return "";
  const need = l.filter((i) => i.needsDocument);
  if (!need.length) return "not_needed";
  const ready = need.filter((i) => i.documentReady === true).length;
  return ready === need.length ? "issued" : ready > 0 ? "partially_issued" : "pending";
}

export function refundStatus(o: CrmOrderFacts | null): (typeof REFUND_WORDS)[number] {
  if (!o) return "";
  if (o.refundPending) return "pending";
  if (o.refundedMinor > 0n) return o.refundedMinor >= o.capturedMinor ? "refunded" : "partially_refunded";
  return "none";
}

const ITEM_WORDS: ReadonlyArray<[string, string]> = [
  ["pending", "pending"],
  ["confirmed", "confirmed"],
  ["completed", "completed"],
  ["rejected", "not supplied"],
  ["cancelled", "cancelled"],
];

/** "2 confirmed, 1 cancelled" for an order; "3 requested" for an inquiry. Counts and fixed words only. */
export function itemSummary(state: Pick<CrmSubjectState, "inquiry" | "order">): string {
  if (state.order) {
    const parts: string[] = [];
    for (const [status, word] of ITEM_WORDS) {
      const n = state.order.items.filter((i) => (i.status ?? "pending") === status).length;
      if (n) parts.push(`${n} ${word}`);
    }
    return parts.join(", ");
  }
  const n = state.inquiry?.items.length ?? 0;
  return n ? `${n} requested` : "";
}

function travelDate(items: CrmItemFacts[]): string {
  const dates = items.filter(live).map((i) => i.serviceDate).filter((d): d is string => Boolean(d)).sort();
  return dates[0] ?? "";
}

function adminLink(state: CrmSubjectState, base: string): string {
  if (state.subject.type === "inquiry") return `${base}/admin/inquiries/${state.subject.id}`;
  return `${base}/admin/bookings/${encodeURIComponent(state.order!.reference)}`;
}

/** The name as given, or "" when it would not pass the guard (a phone or email typed into the name): left out, never a dead letter. */
function contactName(raw: string): string {
  const name = clean(raw, 120);
  try {
    checkText(name, "uf_customer_name");
    return name;
  } catch {
    return "";
  }
}

function consentValue(f: CrmConsentFlag | null | undefined): "Y" | "N" {
  return f?.granted ? "Y" : "N";
}

export function mapDeal(state: CrmSubjectState, cfg: CrmMappingConfig, opts: { now?: Date } = {}): CrmMapped {
  if (!state.exists) return { visible: false, reason: "missing" };
  if (state.erased) return { visible: false, reason: "erased" };
  const { inquiry, order } = state;
  if (state.subject.type === "inquiry" && !inquiry) return { visible: false, reason: "missing" };
  if (state.subject.type === "order" && !order) return { visible: false, reason: "missing" };
  // Abandoned carts become CRM records only with recovery consent (doc 29 §5.3 phase 3), not in phase 1.
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
  const codes = cfg.fieldCodes;
  // Submitted inquiries and paid or authorised orders only (the invisible cases returned above); never on a spam deal.
  const contact = stage === "spam" ? null : (state.contact ?? null);
  const consent = contact ? state.consent : undefined;
  const indicative = order ? (order.totalMinor ?? null) : (inquiry?.indicativeMinor ?? null);
  const margin = order?.marginAedMinor ?? null;
  const custom: Record<CrmFieldKey, string | number> = {
    reference: references.join(" / "),
    environment: cfg.environment,
    admin_link: adminLink(state, cfg.adminBaseUrl),
    customer_name: contact ? contactName(contact.name) : "",
    customer_phone: contact && PHONE_E164.test(contact.phone.trim()) ? contact.phone.trim() : "",
    customer_email: contact?.email && EMAIL_STRICT.test(contact.email.trim().toLowerCase()) ? contact.email.trim().toLowerCase() : "",
    payment_status: paymentStatus(order),
    supplier_booking_status: supplierStatus(order),
    ticket_status: ticketStatus(order),
    refund_status: refundStatus(order),
    refund_amount: order ? majorUnits(order.refundedMinor) : "",
    travel_date: travelDate(order ? order.items : inquiry!.items),
    item_summary: itemSummary(state),
    as_of: bitrixInstant(opts.now ?? new Date()),
    indicative_amount: indicative !== null && indicative > 0n ? majorUnits(indicative) : "",
    margin: margin === null ? "" : majorUnits(margin),
    consent_marketing_email: consentValue(consent?.marketingEmail),
    consent_marketing_email_at: consent?.marketingEmail?.at ?? "",
    consent_marketing_whatsapp: consentValue(consent?.marketingWhatsapp),
    consent_marketing_whatsapp_at: consent?.marketingWhatsapp?.at ?? "",
  };
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
  for (const k of Object.keys(custom) as CrmFieldKey[]) fields[codes[k] as `UF_CRM_${string}`] = custom[k];
  const rows = order ? rowsFor(order.items, true) : rowsFor(inquiry!.items, false);
  // Spam never creates a deal; an existing one moves to the Spam stage.
  return {
    visible: true,
    createAllowed: stage !== "spam",
    stage,
    fields,
    createFields: { ...fields, assignedById: cfg.defaultOwnerId },
    rows,
    hash: snapshotHash(fields, rows, codes.as_of),
  };
}

const BASE_DEAL_KEYS = ["title", "categoryId", "stageId", "opportunity", "currencyId", "isManualOpportunity", "originatorId", "originId"];
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

/** What the guard needs from the configuration. */
export type CrmGuardConfig = Pick<CrmConfig, "environment" | "categoryId" | "originatorId" | "fieldCodes" | "defaultOwnerId" | "adminBaseUrl">;

const PHONE_E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL_STRICT = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*\.[a-z]{2,24}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Bitrix24 Date/Time in ISO 8601 with an explicit offset and no fraction (`bitrixInstant`). */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/;
const REFERENCES = /^(?:INQ|OUT)-\d{5,11}(?: \/ (?:INQ|OUT)-\d{5,11})?$/;
const SUMMARY = /^\d{1,2} (?:requested|pending|confirmed|completed|not supplied|cancelled)(?:, \d{1,2} (?:pending|confirmed|completed|not supplied|cancelled))*$/;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function oneOf(v: unknown, words: readonly string[], code: string): void {
  if (typeof v !== "string" || !words.includes(v)) refuse(code);
}

function amount(v: unknown, code: string, opts: { negative?: boolean } = {}): void {
  if (v === "") return;
  if (typeof v !== "number" || !Number.isFinite(v) || (!opts.negative && v < 0) || Math.abs(v) > 1e9) refuse(code);
}

function shaped(v: unknown, re: RegExp, code: string, opts: { empty?: boolean } = { empty: true }): void {
  if (v === "" && opts.empty) return;
  if (typeof v !== "string" || !re.test(v)) refuse(code);
}

/** One OUTLYY custom field against its own exact shape. */
function checkCustom(key: CrmFieldKey, v: unknown, cfg: CrmGuardConfig): void {
  switch (key) {
    case "reference":
      return shaped(v, REFERENCES, "uf_reference", { empty: false });
    case "environment":
      if (v !== cfg.environment) refuse("uf_environment");
      return;
    case "admin_link": {
      const re = new RegExp(`^/admin/(?:inquiries/${UUID}|bookings/(?:INQ|OUT)-\\d{5,11})$`);
      if (typeof v !== "string" || !v.startsWith(`${cfg.adminBaseUrl}/`) || !re.test(v.slice(cfg.adminBaseUrl.length))) refuse("uf_admin_link");
      return;
    }
    case "customer_name":
      if (typeof v !== "string" || v.length > 120 || /[\u0000-\u001f\u007f]/.test(v)) refuse("uf_customer_name");
      if (v) checkText(v, "uf_customer_name");
      return;
    case "customer_phone":
      return shaped(v, PHONE_E164, "uf_customer_phone");
    case "customer_email":
      if (typeof v === "string" && v.length > 254) refuse("uf_customer_email");
      return shaped(v, EMAIL_STRICT, "uf_customer_email");
    case "payment_status":
      return oneOf(v, PAYMENT_WORDS, "uf_payment_status");
    case "supplier_booking_status":
      return oneOf(v, SUPPLIER_WORDS, "uf_supplier_booking_status");
    case "ticket_status":
      return oneOf(v, TICKET_WORDS, "uf_ticket_status");
    case "refund_status":
      return oneOf(v, REFUND_WORDS, "uf_refund_status");
    case "refund_amount":
      return amount(v, "uf_refund_amount");
    case "indicative_amount":
      return amount(v, "uf_indicative_amount");
    case "margin":
      return amount(v, "uf_margin", { negative: true });
    case "travel_date":
      return shaped(v, DAY, "uf_travel_date");
    case "item_summary":
      return shaped(v, SUMMARY, "uf_item_summary");
    case "as_of":
      return shaped(v, INSTANT, "uf_as_of", { empty: false });
    case "consent_marketing_email":
    case "consent_marketing_whatsapp":
      return oneOf(v, ["Y", "N"], `uf_${key}`);
    case "consent_marketing_email_at":
    case "consent_marketing_whatsapp_at":
      return shaped(v, INSTANT, `uf_${key}`);
  }
}

/**
 * The last check before any write (doc 29 §5.5 "never sent"): exactly the
 * allowlisted keys (the eight standard fields, every configured OUTLYY
 * field, and the responsible person on a create only), each of its exact
 * shape. Customer name, phone and email are accepted only in their own
 * fields and only in their strict shapes; free text anywhere else that
 * looks like contact data, a token, a provider id, a URL or an erasure
 * marker is refused. Throws `CrmCallError("refused")`: the row is
 * dead-lettered, never retried.
 */
export function assertSafeCrmPayload(fields: DealFields, rows: ProductRow[], cfg: CrmGuardConfig, opts: { create?: boolean } = {}): void {
  const codes = cfg.fieldCodes;
  const expected = [...BASE_DEAL_KEYS, ...Object.values(codes), ...(opts.create ? ["assignedById"] : [])].sort().join(",");
  if (Object.keys(fields).sort().join(",") !== expected) refuse("deal_keys");
  if (opts.create && fields.assignedById !== cfg.defaultOwnerId) refuse("owner");
  if (!/^outlyy-(development|staging|production)$/.test(fields.originatorId) || fields.originatorId !== cfg.originatorId) refuse("originator");
  if (!/^(inq|ord):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fields.originId)) refuse("origin");
  if (!Number.isInteger(fields.categoryId) || fields.categoryId <= 0 || fields.categoryId !== cfg.categoryId) refuse("category");
  if (!/^C\d{1,9}:[A-Z0-9_]{1,40}$/.test(fields.stageId) || !fields.stageId.startsWith(`C${fields.categoryId}:`)) refuse("stage");
  if (fields.currencyId !== "AED" && fields.currencyId !== "INR") refuse("currency");
  if (!Number.isFinite(fields.opportunity) || fields.opportunity < 0) refuse("opportunity");
  if (fields.isManualOpportunity !== "Y") refuse("manual_opportunity");
  if (fields.title.length > 255) refuse("title_length");
  checkText(fields.title, "title");
  for (const key of Object.keys(codes) as CrmFieldKey[]) checkCustom(key, fields[codes[key] as `UF_CRM_${string}`], cfg);
  if (rows.length > 50) refuse("rows_count");
  for (const r of rows) {
    if (Object.keys(r).sort().join(",") !== ROW_KEYS) refuse("row_keys");
    if (!Number.isFinite(r.price) || r.price < 0 || !Number.isInteger(r.quantity) || r.quantity < 1) refuse("row_amount");
    if (r.productName.length > 255) refuse("row_length");
    checkText(r.productName, "row");
  }
}
