/**
 * The monthly CSV of the fiscal documents for the accountant (owner decision
 * C-P4, 28 Nov 2026). One row per printed line of every document issued in
 * the month (Dubai calendar).
 *
 * Columns: document number, type, issue date, date of supply, order
 * reference, refers to (a credit note's invoice), buyer legal name and buyer
 * TRN (full tax invoices only: a company; no consumer name is ever exported,
 * owner decision R4), line description, VAT category, net, VAT, gross,
 * currency (always AED, C-P1). Amounts are AED with two decimals and no
 * thousands separator; a credit note's amounts are negative, so the column
 * totals are the month's net figures. The file starts with a UTF-8 byte order
 * mark so spreadsheet programs read " · " and non-Latin text correctly.
 *
 * RFC 4180: comma separated, CRLF line ends, fields quoted when they hold a
 * comma, quote or line break. A text cell that a spreadsheet would read as a
 * formula (= + - @, tab, CR at the start) is prefixed with an apostrophe.
 *
 * Pure: no I/O, no env, no clock.
 */

/** UTF-8 byte order mark: Excel reads the file as UTF-8 only with it (review 109d R4). */
export const UTF8_BOM = "\uFEFF";

export const EXPORT_COLUMNS = [
  "Document number",
  "Type",
  "Issue date",
  "Date of supply",
  "Order reference",
  "Refers to",
  "Buyer legal name",
  "Buyer TRN",
  "Line description",
  "VAT category",
  "Net",
  "VAT",
  "Gross",
  "Currency",
] as const;

export interface ExportDocument {
  displayNumber: string;
  docType: "tax_invoice" | "tax_credit_note";
  issueReason: string;
  /** YYYY-MM-DD, Dubai. */
  issueDate: string;
  /** YYYY-MM-DD. */
  supplyDate: string;
  orderReference: string;
  /** A credit note: the invoice it credits. */
  refersTo: string | null;
  /** Full tax invoice only (C-P2): the VAT-registered buyer. Null for every consumer document (R4). */
  buyerLegalName: string | null;
  buyerTrn: string | null;
  lines: { description: string; variant: string | null; vatCategory: string; netMinor: string; vatMinor: string; grossMinor: string }[];
}

/** Two-decimal AED with a sign and no separators: "-1234.50". */
export function plainAmount(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  return `${neg ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/** A text cell: formula guard, then RFC 4180 quoting. */
export function csvText(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function typeLabel(d: ExportDocument): string {
  if (d.docType === "tax_credit_note") return d.issueReason === "reissue_cancel" ? "Tax credit note (reissue)" : "Tax credit note";
  return d.issueReason === "reissue_full" ? "Full tax invoice" : "Tax invoice (simplified)";
}

export function exportCsv(documents: readonly ExportDocument[]): { csv: string; lineCount: number } {
  const out: string[] = [EXPORT_COLUMNS.map(csvText).join(",")];
  let lineCount = 0;
  for (const d of documents) {
    const sign = d.docType === "tax_credit_note" ? -1n : 1n;
    for (const l of d.lines) {
      lineCount += 1;
      out.push(
        [
          csvText(d.displayNumber),
          csvText(typeLabel(d)),
          d.issueDate,
          d.supplyDate,
          csvText(d.orderReference),
          csvText(d.refersTo ?? ""),
          csvText(d.buyerLegalName ?? ""),
          csvText(d.buyerTrn ?? ""),
          csvText([l.description, l.variant].filter(Boolean).join(" · ")),
          csvText(l.vatCategory),
          plainAmount(sign * BigInt(l.netMinor)),
          plainAmount(sign * BigInt(l.vatMinor)),
          plainAmount(sign * BigInt(l.grossMinor)),
          "AED",
        ].join(","),
      );
    }
  }
  return { csv: `${UTF8_BOM}${out.join("\r\n")}\r\n`, lineCount };
}

/** "2026-11" for the Dubai calendar month of an instant. */
export function dubaiPeriodOf(at: Date): string {
  const d = new Date(at.getTime() + 4 * 3600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function previousPeriod(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** The month's instants: from its first day 00:00 Dubai (UTC+4, no daylight saving) to the next month's. */
export function periodBounds(period: string): { from: Date; to: Date } {
  const [y, m] = period.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1) - 4 * 3600_000);
  const to = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - 4 * 3600_000);
  return { from, to };
}

/** "November 2026". */
export function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}
