/**
 * VAT helpers for the fiscal documents (doc 93 §1.2, §1.7, §8B).
 *
 * UNCONFIRMED. Every rule here is the working assumption written in doc 93
 * §8B and `97-invoice-inputs-checklist.md` Part 2, pending the accountant's
 * written answers. Nothing in this file is tax advice, and nothing built on it
 * is issued to a customer while FISCAL_DOCUMENTS_ENABLED is off. When the
 * accountant answers, change the rule here, give it a new `VAT_RULE` name and
 * keep the old one readable: every fiscal document stores the rule name it
 * was derived with (`fiscal_documents.vat_rule`), so an issued document is
 * never re-derived under a different rule.
 *
 * Working assumptions (accountant question in brackets):
 *  - prices are VAT-inclusive; a standard-rated line carries VAT of
 *    gross × 5/105 (A5);
 *  - rounded per line, half up to the minor unit (fils), and totals are the
 *    sum of the lines (A5);
 *  - a discount reduces the line's gross before the split; it is not a
 *    separate line (A5);
 *  - a refund is credited with VAT reduced in proportion, by the same rule on
 *    the refunded amount (A10);
 *  - the category per product is one of `VAT_CATEGORIES`; a product with no
 *    category blocks automatic invoicing for its line (A6). The list itself is
 *    unconfirmed: the accountant gives the categories per product type.
 *
 * Pure: no env, no I/O. Amounts are bigint minor units, never floats.
 */

/** Name of the rule below, stored on every fiscal document. Change it whenever the rule changes. */
export const VAT_RULE = "uae_5_of_105_line_half_up_unconfirmed";

/** True only once the accountant has confirmed the rule in writing (doc 93 §8B). Never flip this without that. */
export const VAT_RULE_CONFIRMED = false;

/**
 * VAT categories a product may carry (UNCONFIRMED, A6). `standard` is 5%.
 * `zero_rated` is 0% and still on a tax invoice; `exempt` and `out_of_scope`
 * carry no VAT. Which product types are which is the accountant's answer.
 */
export const VAT_CATEGORIES = ["standard", "zero_rated", "exempt", "out_of_scope"] as const;
export type VatCategory = (typeof VAT_CATEGORIES)[number];

export function isVatCategory(v: unknown): v is VatCategory {
  return typeof v === "string" && (VAT_CATEGORIES as readonly string[]).includes(v);
}

/** Rate as a fraction numerator/denominator of the net amount (5% → 5/100). */
const RATE: Record<VatCategory, { num: bigint; den: bigint; label: string }> = {
  standard: { num: 5n, den: 100n, label: "5%" },
  zero_rated: { num: 0n, den: 100n, label: "0%" },
  exempt: { num: 0n, den: 100n, label: "Exempt" },
  out_of_scope: { num: 0n, den: 100n, label: "Out of scope" },
};

/** The rate label printed in the VAT column of a line. */
export function vatRateLabel(category: VatCategory): string {
  return RATE[category].label;
}

/** Basis points of the rate (500 for 5%), as stored in the line snapshot. */
export function vatRateBasisPoints(category: VatCategory): number {
  const r = RATE[category];
  return Number((r.num * 10_000n) / r.den);
}

/** Half-up integer division for non-negative bigint operands. */
function divHalfUp(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) throw new RangeError("divHalfUp: non-negative numerator and positive denominator only");
  return (n * 2n + d) / (d * 2n);
}

export interface VatSplit {
  netMinor: bigint;
  vatMinor: bigint;
  grossMinor: bigint;
}

/**
 * Splits a VAT-inclusive amount: VAT = gross × r/(1+r), half up; net = gross − VAT.
 * For 5%: gross × 5/105. Net + VAT always equals gross.
 */
export function splitInclusive(grossMinor: bigint, category: VatCategory): VatSplit {
  if (grossMinor < 0n) throw new RangeError("splitInclusive: negative amount");
  const r = RATE[category];
  const vat = r.num === 0n ? 0n : divHalfUp(grossMinor * r.num, r.den + r.num);
  return { netMinor: grossMinor - vat, vatMinor: vat, grossMinor };
}

export interface VatLineInput {
  grossMinor: bigint;
  category: VatCategory;
}

export interface VatTotals extends VatSplit {
  /** VAT and net per rate label, in first-seen order (for the "VAT 5%" summary line). */
  byRate: { label: string; basisPoints: number; netMinor: bigint; vatMinor: bigint }[];
}

/** Totals are the sum of the per-line splits (A5 working assumption), never a split of the total. */
export function totalsOf(lines: readonly (VatLineInput & Partial<VatSplit>)[]): VatTotals {
  let net = 0n;
  let vat = 0n;
  let gross = 0n;
  const byRate = new Map<string, { label: string; basisPoints: number; netMinor: bigint; vatMinor: bigint }>();
  for (const l of lines) {
    const s = l.netMinor !== undefined && l.vatMinor !== undefined ? { netMinor: l.netMinor, vatMinor: l.vatMinor, grossMinor: l.grossMinor } : splitInclusive(l.grossMinor, l.category);
    net += s.netMinor;
    vat += s.vatMinor;
    gross += s.grossMinor;
    const label = vatRateLabel(l.category);
    const row = byRate.get(label) ?? { label, basisPoints: vatRateBasisPoints(l.category), netMinor: 0n, vatMinor: 0n };
    row.netMinor += s.netMinor;
    row.vatMinor += s.vatMinor;
    byRate.set(label, row);
  }
  return { netMinor: net, vatMinor: vat, grossMinor: gross, byRate: [...byRate.values()] };
}

/**
 * The credit for a refund of part (or all) of one invoiced line (A10 working
 * assumption): the same split rule applied to the refunded amount. The refund
 * that brings the line's credits up to its full gross credits exactly what is
 * left of the line's net and VAT, so the invoice and its credit notes net to
 * zero to the fil. Refuses a refund beyond what is left of the line.
 */
export function creditForRefund(line: VatSplit, alreadyCredited: VatSplit, refundMinor: bigint, category: VatCategory): VatSplit {
  if (refundMinor <= 0n) throw new RangeError("creditForRefund: refund must be positive");
  const leftGross = line.grossMinor - alreadyCredited.grossMinor;
  if (refundMinor > leftGross) throw new RangeError("creditForRefund: refund exceeds what is left of the invoiced line");
  if (refundMinor === leftGross) {
    return { netMinor: line.netMinor - alreadyCredited.netMinor, vatMinor: line.vatMinor - alreadyCredited.vatMinor, grossMinor: leftGross };
  }
  const s = splitInclusive(refundMinor, category);
  // Never credit more VAT than is left on the line (possible only through rounding on many small refunds).
  const leftVat = line.vatMinor - alreadyCredited.vatMinor;
  if (s.vatMinor > leftVat) return { netMinor: refundMinor - leftVat, vatMinor: leftVat, grossMinor: refundMinor };
  return s;
}

/** "1,234.50" for minor units of a two-decimal currency. Pure, locale-independent. */
export function formatMinor(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
