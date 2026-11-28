/**
 * VAT helpers for the fiscal documents (doc 93 §1.2, §1.7, §8B).
 *
 * OWNER-APPROVED, ACCOUNTANT SIGN-OFF PENDING. Every rule here follows the
 * owner's answers to the accountant questions (`91-owner-answers.md`,
 * "Accountant questions … answered by the owner 28 Nov 2026", A1–A18). The
 * accountant has not signed them off yet, so `VAT_RULE_CONFIRMED` stays
 * false and a production document is refused until it is flipped as its own
 * live step. Nothing in this file is tax advice, and nothing built on it is
 * issued to a customer while FISCAL_DOCUMENTS_ENABLED is off. When a rule
 * changes, give it a new `VAT_RULE` name and keep the old one readable
 * (`PREVIOUS_VAT_RULES`): every fiscal document stores the rule name it was
 * derived with (`fiscal_documents.vat_rule`), so an issued document is never
 * re-derived under a different rule.
 *
 * The rules (owner answer in brackets):
 *  - prices are VAT-inclusive; a standard-rated line carries VAT of
 *    gross × 5/105 (A5, A7 principal: VAT on the full customer price, A8 UAE
 *    supply, no zero-rating for non-residents);
 *  - rounded per line, half up to the fil, and totals are the sum of the
 *    lines (A5);
 *  - a discount is its own negative line, split by the same rule (half up on
 *    its size, then negated) (A5);
 *  - a refund is credited with VAT in proportion, by the same rule on the
 *    refunded amount, against the item's line and its discount line together,
 *    so an invoice and its credit notes net to zero to the fil (A10);
 *  - every product is standard 5 % by default (A6). Pure point-to-point
 *    transport tickets (monorail, metro, bus, abra) are exempt: set
 *    `products.vat_category = 'exempt'`, or list the slug in
 *    `EXEMPT_TRANSPORT_SLUGS`. A product with no stored category whose slug or
 *    title names any means of transport (bus, ferry, train, transfer, tram,
 *    abra, metro, monorail, …) is held for staff (`resolveVatCategory`,
 *    `vat_category_review`), whatever else the name says: staff then store
 *    `standard` or `exempt` (review 109c N4).
 *
 * Pure: no env, no I/O. Amounts are bigint minor units, never floats.
 */

/** Name of the rule below, stored on every fiscal document. Change it whenever the rule changes. */
export const VAT_RULE = "uae_5_of_105_line_half_up_discount_line_owner_approved";

/** Rule names used before, kept readable: no production document was ever issued under them (switch off). */
export const PREVIOUS_VAT_RULES: readonly string[] = ["uae_5_of_105_line_half_up_unconfirmed"];

/**
 * True only once the accountant has signed the owner-approved rules off in writing (doc 93 §8B, answers A1–A18).
 * Never flip this without that: it is a live step of its own. While false, a production document is refused.
 */
export const VAT_RULE_CONFIRMED = false;

/**
 * VAT categories a product may carry (A6, owner-approved, accountant sign-off pending). `standard` is 5 %.
 * `zero_rated` is 0 % and still on a tax invoice; `exempt` and `out_of_scope` carry no VAT and print as such.
 */
export const VAT_CATEGORIES = ["standard", "zero_rated", "exempt", "out_of_scope"] as const;
export type VatCategory = (typeof VAT_CATEGORIES)[number];

export function isVatCategory(v: unknown): v is VatCategory {
  return typeof v === "string" && (VAT_CATEGORIES as readonly string[]).includes(v);
}

/** A6: every product is standard-rated unless its row says otherwise. */
export const DEFAULT_VAT_CATEGORY: VatCategory = "standard";

/**
 * A6, code-side list: slugs of pure point-to-point transport tickets that are exempt when the product row stores no
 * category. A code change, not a data write; `products.vat_category` (when set) always wins. Empty until the live
 * catalogue is reviewed (no such product exists in the seed catalogue).
 */
export const EXEMPT_TRANSPORT_SLUGS: readonly string[] = [];

/**
 * Any means of transport (review 109c N4). No leisure word cancels a match: "hop-on hop-off bus tour" or "Aquaventure
 * with monorail" are held too, and staff decide (sightseeing trips stay at 5 %, Executive Regulation Art. 45).
 */
const TRANSPORT_WORDS = /\b(monorail|metro|tram|trams|abra|abras|bus|buses|coach|ferry|ferries|train|trains|transfer|transfers|shuttle|water ?bus|water ?taxi|nol)\b/;

/** Does this product's slug or title name a means of transport (A6)? Then a missing category is held for staff. */
export function looksLikePointToPointTransport(p: { slug: string; title?: string | null }): boolean {
  const text = `${p.slug.replace(/[-_]+/g, " ")} ${p.title ?? ""}`.toLowerCase();
  return TRANSPORT_WORDS.test(text);
}

export type VatCategoryResolution =
  | { kind: "ok"; category: VatCategory; source: "stored" | "exempt_transport_list" | "default" }
  /** A stored value that is not a known category: the line is refused (`vat_category_missing`). */
  | { kind: "invalid" }
  /** No stored category and the product looks like a transport ticket: held until staff set it (`vat_category_review`). */
  | { kind: "review" };

/** The VAT category of an invoice line's product (A6): stored value, then the exempt transport list, then standard. */
export function resolveVatCategory(p: { vatCategory: string | null; slug: string; title?: string | null }): VatCategoryResolution {
  if (p.vatCategory !== null) return isVatCategory(p.vatCategory) ? { kind: "ok", category: p.vatCategory, source: "stored" } : { kind: "invalid" };
  if (EXEMPT_TRANSPORT_SLUGS.includes(p.slug)) return { kind: "ok", category: "exempt", source: "exempt_transport_list" };
  if (looksLikePointToPointTransport(p)) return { kind: "review" };
  return { kind: "ok", category: DEFAULT_VAT_CATEGORY, source: "default" };
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

/**
 * A5: the discount line of an item, a negative line split by the same rule: VAT = discount × 5/105, half up on the
 * discount's size, then negated. Item line + discount line = what the customer paid for the item.
 */
export function splitDiscount(discountMinor: bigint, category: VatCategory): VatSplit {
  if (discountMinor < 0n) throw new RangeError("splitDiscount: negative discount");
  const s = splitInclusive(discountMinor, category);
  return { netMinor: -s.netMinor, vatMinor: -s.vatMinor, grossMinor: -s.grossMinor };
}

export interface VatLineInput {
  grossMinor: bigint;
  category: VatCategory;
}

export interface VatTotals extends VatSplit {
  /** VAT and net per rate label, in first-seen order (for the "VAT 5%" summary line). */
  byRate: { label: string; basisPoints: number; netMinor: bigint; vatMinor: bigint }[];
}

/** Totals are the sum of the per-line splits, discount lines included (A5), never a split of the total. */
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
 * The credit for a refund of part (or all) of one invoiced item (A10): the
 * same split rule applied to the refunded amount. `line` is the item's line
 * and its discount line together (what was paid for the item). The refund
 * that brings the line's credits up to its full gross credits exactly what is
 * left of the line's net and VAT, so the invoice and its credit notes net to
 * zero to the fil. Refuses a refund beyond what is left of the line.
 */
export function creditForRefund(line: VatSplit, alreadyCredited: VatSplit, refundMinor: bigint, category: VatCategory): VatSplit {
  if (refundMinor <= 0n) throw new RangeError("creditForRefund: refund must be positive");
  const leftGross = line.grossMinor - alreadyCredited.grossMinor;
  if (refundMinor > leftGross) throw new RangeError("creditForRefund: refund exceeds what is left of the invoiced line");
  if (refundMinor === leftGross) {
    return nonNegative({ netMinor: line.netMinor - alreadyCredited.netMinor, vatMinor: line.vatMinor - alreadyCredited.vatMinor, grossMinor: leftGross });
  }
  const s = splitInclusive(refundMinor, category);
  // Never credit more VAT than is left on the line (possible only through rounding on many small refunds).
  const leftVat = line.vatMinor - alreadyCredited.vatMinor;
  const out = s.vatMinor > leftVat ? { netMinor: refundMinor - leftVat, vatMinor: leftVat, grossMinor: refundMinor } : s;
  return nonNegative(out);
}

/**
 * Review 109c N8: with a discount line the item's VAT can sit a fil above what its paid amount would carry, so a
 * last tiny remainder could come out with a negative net. Refused (the issuer turns it into `credit_exceeds_invoice`
 * for staff) rather than written as a credit note the database check would refuse on every tick.
 */
function nonNegative(c: VatSplit): VatSplit {
  if (c.netMinor < 0n || c.vatMinor < 0n || c.grossMinor <= 0n) throw new RangeError("creditForRefund: the credit would carry a negative amount");
  return c;
}

/** "1,234.50" for minor units of a two-decimal currency. Pure, locale-independent. */
export function formatMinor(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
