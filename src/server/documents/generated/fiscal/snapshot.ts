/**
 * The snapshot a fiscal document is drawn from (doc 93 §1.2), and its view.
 *
 * The snapshot is what `fiscal_documents` stores (seller, lines, totals) plus
 * the few order facts the page prints. It is fixed when the number is
 * assigned; drawing the PDF later reads only this, so a re-draw after a lost
 * object prints the same document. The buyer name comes from the mutable
 * `fiscal_document_parties` row at draw time, so an erasure removes it from
 * any later copy (doc 93 §1.8).
 *
 * Never part of a snapshot: net cost, margin, supplier amounts, supplier
 * references, payment provider ids (owner answer O4), any INR value (O5).
 *
 * Pure: no env, no I/O.
 */

import { formatMinor, isVatCategory, type VatCategory } from "../../../domain/vat";

export type FiscalDocType = "tax_invoice" | "tax_credit_note";
export type FiscalEnvironment = "production" | "test";

export interface FiscalSeller {
  legalName: string;
  tradingName: string;
  trn: string;
  address: string;
  licence: string | null;
  supportEmail: string | null;
  phone: string | null;
  /** True while any of name, TRN or address is a bracketed placeholder (inputs I1–I3 not supplied). */
  placeholder: boolean;
}

/** One printed line. Amounts are decimal strings of minor units (bigint in JSON). */
export interface FiscalLine {
  orderItemId: string;
  description: string;
  variant: string | null;
  /** YYYY-MM-DD, the activity date. */
  serviceDate: string;
  guests: string;
  vatCategory: VatCategory;
  rateLabel: string;
  rateBasisPoints: number;
  discountMinor: string;
  netMinor: string;
  vatMinor: string;
  grossMinor: string;
  /** Credit notes: "Full refund" or "Partial refund". */
  note?: string | null;
}

export interface FiscalTotals {
  netMinor: string;
  vatMinor: string;
  grossMinor: string;
  byRate: { label: string; basisPoints: number; netMinor: string; vatMinor: string }[];
}

export interface FiscalSnapshot {
  docType: FiscalDocType;
  displayNumber: string;
  environment: FiscalEnvironment;
  issuedAt: string;
  /** YYYY-MM-DD (Dubai calendar date of the capture, A4 working assumption). */
  supplyDate: string;
  currency: "AED";
  orderReference: string;
  seller: FiscalSeller;
  lines: FiscalLine[];
  totals: FiscalTotals;
  /** Invoice: when the money was captured. Credit note: when the refund settled. */
  moneyAt: string;
  /** Plain words only, never a provider id (O4). */
  paymentMethodLabel: string;
  /** Credit notes only. */
  refersTo: { displayNumber: string; issuedAt: string } | null;
  /** Credit notes only: one of the fixed plain phrases (doc 93 §5.3). */
  refundReasonLabel: string | null;
  vatRule: string;
  vatRuleConfirmed: boolean;
  templateVersion: number;
}

/** Plain phrases for `refunds.reason`; raw reason codes and supplier text are never printed (doc 93 §5.3). */
export function refundReasonLabel(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("customer") || r.includes("cancel_request") || r.includes("guest")) return "Cancelled by the guest";
  if (r.includes("supplier") || r.includes("operator") || r.includes("rejected") || r.includes("confirm") || r.includes("reserve")) return "Not confirmed by the operator";
  if (r.includes("goodwill")) return "Goodwill refund";
  return "Refund";
}

/** "14 Feb 2027" for a YYYY-MM-DD date or an ISO instant, as a Dubai calendar date. */
export function dubaiDateLabel(value: string): string {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(value);
  const tz = /^\d{4}-\d{2}-\d{2}$/.test(value) ? "UTC" : "Asia/Dubai";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: tz });
}

export function dubaiDateTimeLabel(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Dubai" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Dubai" });
  return `${date}, ${time} Dubai time`;
}

/** The YYYY-MM-DD Dubai calendar date of an instant. */
export function dubaiIsoDate(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Everything the layout prints, already worded and formatted. */
export interface FiscalView {
  title: string;
  /** Red bands on every page, beyond the layout band. */
  bands: string[];
  metaTitle: string;
  numberLabel: string;
  number: string;
  issueDate: string;
  statusWord: string | null;
  seller: [string, string][];
  booking: [string, string][];
  columns: { label: string; width: number; align?: "left" | "right" }[];
  rows: string[][];
  totals: [string, string][];
  notes: string[];
  footer: string;
}

const money = (currency: string, minor: string) => `${currency} ${formatMinor(BigInt(minor))}`;

export function fiscalView(s: FiscalSnapshot, party: { buyerName: string | null } | null): FiscalView {
  const invoice = s.docType === "tax_invoice";
  const bands: string[] = [];
  if (s.environment === "test") bands.push(invoice ? "TEST — not a tax invoice, not a receipt" : "TEST — not a tax credit note");
  if (!s.vatRuleConfirmed) bands.push("VAT rule and wording UNCONFIRMED — pending the accountant");
  if (s.seller.placeholder) bands.push("Seller details are placeholders — not supplied yet");

  const seller: [string, string][] = [
    ["Seller", s.seller.legalName],
    ["Trading as", s.seller.tradingName],
    ["Address", s.seller.address],
    ["TRN", s.seller.trn],
  ];
  if (s.seller.licence) seller.push(["Licence", s.seller.licence]);

  const booking: [string, string][] = [["Booking reference", s.orderReference]];
  if (party?.buyerName) booking.push(["Customer", party.buyerName]);
  if (invoice) booking.push(["Date of supply", dubaiDateLabel(s.supplyDate)]);
  if (!invoice && s.refersTo) booking.push(["Credit against", `${s.refersTo.displayNumber} dated ${dubaiDateLabel(s.refersTo.issuedAt)}`]);
  if (!invoice && s.refundReasonLabel) booking.push(["Reason", s.refundReasonLabel]);

  const hasDiscount = s.lines.some((l) => BigInt(l.discountMinor) !== 0n);
  const columns: FiscalView["columns"] = [
    { label: "Description", width: hasDiscount ? 0.3 : 0.37 },
    { label: "Service date", width: 0.13 },
    { label: "Guests", width: 0.12 },
    { label: "VAT", width: 0.08 },
    ...(hasDiscount ? [{ label: "Discount", width: 0.07, align: "right" as const }] : []),
    { label: "Net", width: 0.1, align: "right" },
    { label: "VAT amt", width: 0.09, align: "right" },
    { label: "Gross", width: 0.11, align: "right" },
  ];
  const rows = s.lines.map((l) => [
    [l.description, l.variant, l.note].filter(Boolean).join(" · "),
    dubaiDateLabel(l.serviceDate),
    l.guests,
    l.rateLabel,
    ...(hasDiscount ? [formatMinor(BigInt(l.discountMinor))] : []),
    formatMinor(BigInt(l.netMinor)),
    formatMinor(BigInt(l.vatMinor)),
    formatMinor(BigInt(l.grossMinor)),
  ]);

  const totals: [string, string][] = [["Total excluding VAT", money(s.currency, s.totals.netMinor)]];
  for (const r of s.totals.byRate) if (r.basisPoints > 0) totals.push([`VAT ${r.label}`, money(s.currency, r.vatMinor)]);
  totals.push([invoice ? "Total" : "Total credited", money(s.currency, s.totals.grossMinor)]);
  if (!invoice) totals.push(["Of which VAT", money(s.currency, s.totals.vatMinor)]);

  const notes = invoice
    ? [
        `PAID ${dubaiDateTimeLabel(s.moneyAt)}, ${s.paymentMethodLabel.toLowerCase()}.`,
        "All amounts in UAE dirhams (AED). Prices include VAT.",
        "This document confirms payment. It is not your entry ticket.",
      ]
    : [`Refunded to the original ${s.paymentMethodLabel.toLowerCase()} on ${dubaiDateLabel(s.moneyAt)}.`, "Banks usually show a refund within 5 to 10 working days.", "All amounts in UAE dirhams (AED)."];
  if (s.seller.supportEmail || s.seller.phone) notes.push(`Questions: ${[s.seller.supportEmail, s.seller.phone].filter(Boolean).join(" · ")}`);

  const title = invoice ? "Tax invoice / Receipt" : "Tax credit note";
  return {
    title,
    bands,
    metaTitle: `${s.environment === "test" ? "TEST " : ""}${title} ${s.displayNumber}`,
    numberLabel: "No.",
    number: s.displayNumber,
    issueDate: dubaiDateLabel(s.issuedAt),
    statusWord: invoice ? "PAID" : "CREDITED",
    seller,
    booking,
    columns,
    rows,
    totals,
    notes,
    footer: `${s.seller.legalName} · TRN ${s.seller.trn}`,
  };
}

/** Structural check of a stored snapshot before drawing; a bad one is never drawn. */
export function isFiscalSnapshot(v: unknown): v is FiscalSnapshot {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<FiscalSnapshot>;
  return (
    (s.docType === "tax_invoice" || s.docType === "tax_credit_note") &&
    typeof s.displayNumber === "string" &&
    (s.environment === "production" || s.environment === "test") &&
    s.currency === "AED" &&
    Array.isArray(s.lines) &&
    s.lines.length > 0 &&
    s.lines.every((l) => l && isVatCategory(l.vatCategory) && /^\d+$/.test(l.grossMinor)) &&
    !!s.seller &&
    !!s.totals
  );
}
