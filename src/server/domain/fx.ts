import { z } from "zod";
import { minorToDecimalString } from "./decimal";

/**
 * Live INR-per-AED rate for INR-charged lines (doc 22 §32.16: the owner asked
 * on 3 November 2026 for live rates through an API with a 2% safety buffer).
 *
 * Source: the ECB reference rate for USD/INR, through Frankfurter. The AED is
 * pegged to the USD, so INR per AED = INR per USD ÷ the peg, times the buffer,
 * rounded UP to two places. More INR per AED is the safe direction: it
 * overstates the INR cost of an AED supplier net, so a margin check errs safe.
 *
 * All arithmetic is exact (BigInt over decimal digits); no floating point
 * touches a rate. The guards here decide whether a computed rate may replace
 * the stored one; the service applies them under a row lock.
 *
 * Pure: no I/O, no env, no clock (the caller passes `now`).
 */

/** The only endpoint the refresh may call: https, exactly this host. */
export const FRANKFURTER_LATEST_URL = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR";
export const FRANKFURTER_HOST = "api.frankfurter.dev";

/**
 * AED per USD. The UAE dirham has been pegged to the US dollar at 3.6725
 * since 1997 (Central Bank of the UAE). If the peg ever moves, this constant
 * and every stored rate need review; the band guard below would also trip.
 */
export const AED_PER_USD_PEG = "3.6725";

/** The owner's 2% safety buffer on top of the converted rate (3 November 2026). */
export const FX_SAFETY_BUFFER = "1.02";

/** A refresh that moves the rate by more than this (basis points of the stored rate) needs an admin to accept it. */
export const FX_MAX_JUMP_BPS = 500n;

/** ECB publishes on TARGET working days only: a weekend plus a holiday can leave the latest date 4 days behind. */
export const FX_MAX_SOURCE_AGE_DAYS = 4;

/** How long a written rate stays usable. Two missed runs in a row still leave a valid rate; more lets it lapse to inquiry. */
export const FX_ROW_TTL_MS = 48 * 3600_000;

/** Plausible INR per AED, in hundredths (15.00–40.00). Overridable by env; see `parseFxBand`. */
export const DEFAULT_FX_BAND = { minHundredths: 1500n, maxHundredths: 4000n } as const;

export interface FxBand {
  minHundredths: bigint;
  maxHundredths: bigint;
}

/* ---------------------------------------------------------------------------
 * Exact decimals
 * ------------------------------------------------------------------------ */

interface Decimal {
  /** The digits as an integer: "94.75" → 9475n. */
  units: bigint;
  /** Digits after the point: "94.75" → 2. */
  scale: number;
}

const PLAIN_DECIMAL = /^(\d{1,6})(?:\.(\d{1,8}))?$/;

function parseDecimal(s: string): Decimal | null {
  const m = PLAIN_DECIMAL.exec(s);
  if (!m) return null;
  const frac = m[2] ?? "";
  return { units: BigInt(m[1] + frac), scale: frac.length };
}

const pow10 = (n: number) => 10n ** BigInt(n);

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * The JSON number Frankfurter sent, as its shortest round-trip decimal string
 * (what `String(n)` gives), or null when it is not a plain positive decimal
 * of at most 6 integer and 8 fractional digits (exponent forms included).
 */
export function plainDecimalOf(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const s = String(n);
  const d = parseDecimal(s);
  return d && d.units > 0n ? s : null;
}

/**
 * INR per AED in hundredths from INR per USD (a plain decimal string):
 * `inrPerUsd ÷ 3.6725 × 1.02`, computed exactly and rounded UP once at the
 * end. Example: 94.75 → 25.7998… → × 1.02 = 26.3158… → 2632n ("26.32").
 */
export function inrPerAedHundredths(inrPerUsd: string): bigint {
  const usd = parseDecimal(inrPerUsd);
  const peg = parseDecimal(AED_PER_USD_PEG);
  const buffer = parseDecimal(FX_SAFETY_BUFFER);
  if (!usd || usd.units <= 0n) throw new Error("inrPerUsd must be a positive plain decimal");
  if (!peg || !buffer) throw new Error("FX constants are malformed");
  // (usd.units / 10^usd.scale) / (peg.units / 10^peg.scale) × (buffer.units / 10^buffer.scale) × 100
  const numerator = usd.units * pow10(peg.scale) * buffer.units * 100n;
  const denominator = pow10(usd.scale) * peg.units * pow10(buffer.scale);
  return ceilDiv(numerator, denominator);
}

/** 2632n → "26.32": the `inrPerAed` string the settings row stores. */
export function hundredthsToRate(hundredths: bigint): string {
  return minorToDecimalString(hundredths);
}

/** "26.32" → 2632n; null unless a plain decimal with at most two places (the `fxInputSchema` shape). */
export function rateToHundredths(rate: string): bigint | null {
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(rate);
  if (!m) return null;
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
}

/**
 * The plausible band from two optional env strings. Unset ⇒ the default
 * (15–40); a value that is set must be a two-place decimal and min < max,
 * otherwise null (the refresh then refuses to write).
 */
export function parseFxBand(min: string | undefined, max: string | undefined): FxBand | null {
  const lo = min === undefined ? DEFAULT_FX_BAND.minHundredths : rateToHundredths(min);
  const hi = max === undefined ? DEFAULT_FX_BAND.maxHundredths : rateToHundredths(max);
  if (lo === null || hi === null || lo <= 0n || lo >= hi) return null;
  return { minHundredths: lo, maxHundredths: hi };
}

/* ---------------------------------------------------------------------------
 * The source answer
 * ------------------------------------------------------------------------ */

function isCalendarDate(s: string): boolean {
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/**
 * `GET /v1/latest?base=USD&symbols=INR`, for example
 * `{"amount":1.0,"base":"USD","date":"2026-11-03","rates":{"INR":94.75}}`.
 * `rates` must hold INR and nothing else; unknown top-level keys are
 * dropped (an additive API change must not stop the refresh).
 */
export const frankfurterLatestSchema = z.object({
  amount: z.literal(1),
  base: z.literal("USD"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate, "must be a calendar date"),
  rates: z.strictObject({ INR: z.number().positive().refine((n) => plainDecimalOf(n) !== null, "must be a plain positive decimal") }),
});

export interface UsdInrQuote {
  /** The ECB reference date, YYYY-MM-DD. */
  date: string;
  /** INR per USD as a plain decimal string, exactly as sent. */
  inrPerUsd: string;
}

/** The parsed source answer, or null when it does not match the schema. */
export function parseFrankfurterLatest(body: unknown): UsdInrQuote | null {
  const parsed = frankfurterLatestSchema.safeParse(body);
  if (!parsed.success) return null;
  const inrPerUsd = plainDecimalOf(parsed.data.rates.INR);
  return inrPerUsd ? { date: parsed.data.date, inrPerUsd } : null;
}

/** The `source` text stored with the rate. */
export function fxSourceText(q: UsdInrQuote): string {
  return `ECB via Frankfurter ${q.date}, USD/INR ${q.inrPerUsd} ÷ ${AED_PER_USD_PEG} × ${FX_SAFETY_BUFFER}`;
}

/* ---------------------------------------------------------------------------
 * Guards
 * ------------------------------------------------------------------------ */

export type FxGuardRefusal =
  /** The ECB date is more than `FX_MAX_SOURCE_AGE_DAYS` before today (UTC). */
  | "source_stale"
  /** The ECB date is after today (UTC): not a published reference rate. */
  | "source_date_in_future"
  /** The computed rate is outside the plausible band. Never overridable. */
  | "out_of_band"
  /** The computed rate moved more than `FX_MAX_JUMP_BPS` from the stored one. An admin may accept it. */
  | "jump_too_large";

/** Whole days from the ECB date to today, both as UTC calendar dates. */
export function sourceAgeDays(date: string, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - Date.parse(`${date}T00:00:00.000Z`)) / 86_400_000);
}

/** |next − previous| in basis points of `previous`, rounded up. */
export function moveBps(previous: bigint, next: bigint): bigint {
  const diff = next > previous ? next - previous : previous - next;
  return ceilDiv(diff * 10_000n, previous);
}

export interface FxGuardInput {
  quote: UsdInrQuote;
  hundredths: bigint;
  /** The stored rate in hundredths, or null when there is no parseable row (first write). */
  previousHundredths: bigint | null;
  band: FxBand;
  now: Date;
}

/** Every guard the computed rate fails, in a fixed order; empty means it may be written. */
export function fxGuardRefusals(input: FxGuardInput): FxGuardRefusal[] {
  const out: FxGuardRefusal[] = [];
  const age = sourceAgeDays(input.quote.date, input.now);
  if (age > FX_MAX_SOURCE_AGE_DAYS) out.push("source_stale");
  if (age < 0) out.push("source_date_in_future");
  if (input.hundredths < input.band.minHundredths || input.hundredths > input.band.maxHundredths) out.push("out_of_band");
  const prev = input.previousHundredths;
  // Exactly 5.00% passes; anything more needs an admin.
  if (prev !== null && prev > 0n && (input.hundredths > prev ? input.hundredths - prev : prev - input.hundredths) * 10_000n > prev * FX_MAX_JUMP_BPS) {
    out.push("jump_too_large");
  }
  return out;
}
