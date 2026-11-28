/**
 * AED amounts for an INR-paid order's fiscal documents (owner decision C-P1,
 * 28 Nov 2026): every amount and the VAT are in AED only, converted at the UAE
 * Central Bank (CBUAE) rate for the capture date. No INR figure and no rate
 * note is printed; the rate, its date and its source are kept on the document
 * lines and the snapshot for audit.
 *
 * Where the rate comes from. The repository's only FX feed is the margin
 * rate (`pricing.fx_inr_per_aed`, `fx-refresh.service.ts`): the ECB USD/INR
 * reference rate through Frankfurter, divided by the 3.6725 peg, plus a 2 %
 * safety buffer, latest value only. It is NOT a CBUAE rate (different
 * publisher, a buffer on top, no history by date), so it is never used here.
 * There is no automated CBUAE source in the code. The rate is therefore
 * entered by staff from the CBUAE published rate for the date
 * (`fiscal-fx.service.ts`, step-up and audit) and stored as a setting per
 * date; an INR capture with no rate for its date is held for staff
 * (`fx_rate_missing`), never converted at a guessed rate.
 *
 * Pure: exact bigint arithmetic over decimal digits, no floats, no I/O.
 */

/** Settings key prefix: one row per Dubai calendar date, e.g. `fiscal.cbuae_aed_per_inr.2026-11-28`. */
export const CBUAE_RATE_SETTING_PREFIX = "fiscal.cbuae_aed_per_inr.";

/** The only source name a stored rate may carry. */
export const CBUAE_RATE_SOURCE = "CBUAE";

/** Plausible AED per INR (INR per AED between 12.5 and 50): a typo by a factor of ten is refused. */
const RATE_MIN_UNITS_PER_1E8 = 2_000_000n; // 0.02
const RATE_MAX_UNITS_PER_1E8 = 8_000_000n; // 0.08

const RATE_TEXT = /^0\.(\d{2,8})$/;

/** A staff-entered "AED per 1 INR" rate, normalised to 8 places ("0.04350000"), or null when malformed or implausible. */
export function parseAedPerInr(value: string | null | undefined): string | null {
  const m = RATE_TEXT.exec((value ?? "").trim());
  if (!m) return null;
  const units = BigInt(m[1].padEnd(8, "0"));
  if (units < RATE_MIN_UNITS_PER_1E8 || units > RATE_MAX_UNITS_PER_1E8) return null;
  return `0.${m[1].padEnd(8, "0")}`;
}

/** INR minor units (paise) to AED minor units (fils) at `aedPerInr` (8 places), half up on the size (sign kept). */
export function inrToAedMinor(inrMinor: bigint, aedPerInr: string): bigint {
  const rate = parseAedPerInr(aedPerInr);
  if (!rate) throw new RangeError("inrToAedMinor: not a rate");
  const units = BigInt(rate.slice(2));
  const neg = inrMinor < 0n;
  const abs = neg ? -inrMinor : inrMinor;
  const den = 100_000_000n;
  const out = (abs * units * 2n + den) / (den * 2n);
  return neg ? -out : out;
}

export interface CbuaeRate {
  /** YYYY-MM-DD, the Dubai date the rate applies to (the capture date). */
  date: string;
  /** AED per 1 INR, 8 places. */
  aedPerInr: string;
  source: typeof CBUAE_RATE_SOURCE;
}

/** A stored setting value as a rate, or null when it is not one. */
export function cbuaeRateFrom(date: string, value: unknown): CbuaeRate | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { aedPerInr?: unknown; source?: unknown };
  const rate = typeof v.aedPerInr === "string" ? parseAedPerInr(v.aedPerInr) : null;
  if (!rate || v.source !== CBUAE_RATE_SOURCE || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { date, aedPerInr: rate, source: CBUAE_RATE_SOURCE };
}
