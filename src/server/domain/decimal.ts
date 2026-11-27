/**
 * Supplier money → BigInt minor units, without float arithmetic.
 *
 * Supplier APIs send money as JSON numbers (IEEE doubles). `Math.round(x * 100)`
 * can be off by one minor unit and hides precision the supplier really sent.
 * Here the number's shortest round-trip decimal string (what `String(n)` gives)
 * is parsed digit by digit, rounded half-up to two places, and any dropped
 * precision is reported so the caller can log it instead of losing it silently.
 *
 * Pure: no env, no logger. Lives in domain/ so margin checks and supplier codecs share one rule.
 */

export interface DecimalToMinorResult {
  minor: bigint;
  /** True when the input carried non-zero digits beyond two decimal places and was rounded. */
  rounded: boolean;
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
const EXPONENT = /^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i;

/** Expand `1.5e-7` / `2e21` into a plain decimal string. */
function expandExponent(s: string): string {
  const m = EXPONENT.exec(s);
  if (!m) return s;
  const [, sign, whole, frac = "", expRaw] = m;
  const exp = Number.parseInt(expRaw, 10);
  const digits = whole + frac;
  const point = whole.length + exp;
  if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * 170 → 17000n, 170.5 → 17050n, 99.999 → 10000n (rounded: true), "45.00" → 4500n.
 * Throws on NaN, Infinity and anything that is not a plain decimal.
 */
export function decimalToMinor(value: number | string): DecimalToMinorResult {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("decimalToMinor: non-finite amount");
  const s = expandExponent(typeof value === "number" ? String(value) : value.trim());
  const m = DECIMAL.exec(s);
  if (!m) throw new Error("decimalToMinor: unparseable amount");
  const negative = m[1] === "-";
  const whole = BigInt(m[2]);
  const frac = m[3] ?? "";
  const kept = frac.padEnd(2, "0").slice(0, 2);
  const rest = frac.slice(2);
  let minor = whole * 100n + BigInt(kept);
  // Half-up on the magnitude: the third decimal decides, later digits only mark the input as rounded.
  if (rest.length > 0 && rest.charCodeAt(0) >= "5".charCodeAt(0)) minor += 1n;
  const rounded = /[1-9]/.test(rest);
  return { minor: negative && minor !== 0n ? -minor : minor, rounded };
}

/** 17050n → "170.50". For logs and supplier request bodies only, never for arithmetic. */
export function minorToDecimalString(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}
