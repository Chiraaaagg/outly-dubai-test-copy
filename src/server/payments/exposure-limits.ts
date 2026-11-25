import "server-only";
import { z } from "zod";
import type { Currency } from "@/lib/types";
import { prisma } from "../lib/db";
import { FX_INR_PER_AED_SETTING_KEY, fxInputSchema } from "../services/margin.service";

/**
 * Exposure limits for instant checkout (doc 22 §23 B3 gate 7, question 8)
 * and the per-order instant cap (doc 22 §32.24: "500 AED per order", the
 * maximum instant order total).
 *
 * One `settings` row, `payments.exposure_limits`. The first four fields keep
 * their conservative defaults. `maxInstantOrderAedMinor` has none: it is an
 * owner input, and a row without it (or no row at all) does not parse, so
 * every limit falls back to `CLOSED_EXPOSURE_LIMITS` and instant checkout
 * refuses (fail closed, to inquiry).
 *
 * The cap is enforced twice with the same rule (`instantOrderCapVerdict`):
 * at the quote, so the customer goes to inquiry before typing any details,
 * and at checkout start (defence in depth).
 */

export const EXPOSURE_LIMITS_SETTING_KEY = "payments.exposure_limits";

export const exposureLimitsSchema = z.object({
  maxUncapturedHolds: z.number().int().min(0).default(3),
  maxRiskyPaymentsPer15Min: z.number().int().min(0).default(5),
  outlyFundedWindowDays: z.number().int().min(1).max(365).default(30),
  outlyFundedCapMinor: z.object({ INR: z.number().int().min(0).default(0), AED: z.number().int().min(0).default(0) }).default({ INR: 0, AED: 0 }),
  /** Largest instant order total, in AED fils (500 AED = 50_000). Required: no code default. */
  maxInstantOrderAedMinor: z.number().int().positive().max(1_000_000_000),
});
export type ExposureLimits = z.infer<typeof exposureLimitsSchema>;

/**
 * What a missing or malformed row means: no new instant sale. Zero holds and
 * zero risky payments close gate 7; a zero cap is "not configured" for the
 * order cap (`instantOrderCapVerdict`), never a usable limit.
 */
export const CLOSED_EXPOSURE_LIMITS: ExposureLimits = Object.freeze({
  maxUncapturedHolds: 0,
  maxRiskyPaymentsPer15Min: 0,
  outlyFundedWindowDays: 30,
  outlyFundedCapMinor: Object.freeze({ INR: 0, AED: 0 }),
  maxInstantOrderAedMinor: 0,
}) as ExposureLimits;

/** The row as checkout and the quote read it: fresh from the database, fail closed. */
export async function readExposureLimits(): Promise<ExposureLimits> {
  const row = await prisma.setting.findUnique({ where: { key: EXPOSURE_LIMITS_SETTING_KEY } });
  const parsed = exposureLimitsSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : CLOSED_EXPOSURE_LIMITS;
}

/**
 * The current `pricing.fx_inr_per_aed` rate (decimal string), read fresh;
 * null when the row is missing, malformed, not yet recorded or expired, the
 * same rule as the margin check (margin.service.ts). There is no fallback rate.
 */
export async function readCurrentInrPerAed(now: Date): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: FX_INR_PER_AED_SETTING_KEY } });
  const parsed = fxInputSchema.safeParse(row?.value ?? null);
  if (!parsed.success) return null;
  const t = now.getTime();
  if (Date.parse(parsed.data.recordedAt) > t || Date.parse(parsed.data.expiresAt) <= t) return null;
  return parsed.data.inrPerAed;
}

/** What the cap check needs. `capAedMinor` 0 (or less) means not configured. */
export interface InstantOrderCapInputs {
  capAedMinor: number;
  /** null: no usable FX row. Only INR orders need it. */
  inrPerAed: string | null;
}

export async function readInstantOrderCapInputs(now: Date): Promise<InstantOrderCapInputs> {
  const [limits, inrPerAed] = await Promise.all([readExposureLimits(), readCurrentInrPerAed(now)]);
  return { capAedMinor: limits.maxInstantOrderAedMinor, inrPerAed };
}

export type InstantOrderCapRefusal = "order_over_limit" | "fx_input_missing" | "limit_not_configured";
export type InstantOrderCapVerdict = { ok: true; orderAedMinor: bigint } | { ok: false; reason: InstantOrderCapRefusal; orderAedMinor: bigint | null };

/** "24.10" → 2410n; null when it is not a positive decimal with at most two places. */
function rateHundredths(inrPerAed: string): bigint | null {
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(inrPerAed);
  if (!m) return null;
  const v = BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
  return v > 0n ? v : null;
}

/**
 * The per-order instant cap, one rule for quote and checkout. Pure.
 *
 *  - The order total is the whole order (every line, after discount), in its
 *    own minor units.
 *  - AED: compared directly; a total equal to the cap passes, one fil over
 *    is refused.
 *  - INR: converted to AED fils with the current `pricing.fx_inr_per_aed`
 *    rate, rounded UP (the strict direction): an INR total worth any
 *    fraction of a fil over the cap is refused, even though rounding down
 *    would have put it exactly at the cap. No usable rate refuses
 *    (`fx_input_missing`).
 *  - A cap that is not a positive integer is `limit_not_configured`.
 */
export function instantOrderCapVerdict(input: { totalMinor: bigint; currency: Currency; capAedMinor: number; inrPerAed: string | null }): InstantOrderCapVerdict {
  if (!Number.isSafeInteger(input.capAedMinor) || input.capAedMinor <= 0) return { ok: false, reason: "limit_not_configured", orderAedMinor: null };
  if (input.totalMinor < 0n) return { ok: false, reason: "order_over_limit", orderAedMinor: null };
  let aed: bigint;
  if (input.currency === "AED") aed = input.totalMinor;
  else if (input.currency === "INR") {
    const rate = input.inrPerAed === null ? null : rateHundredths(input.inrPerAed);
    if (rate === null) return { ok: false, reason: "fx_input_missing", orderAedMinor: null };
    // paise × 100 / (INR per AED × 100) = fils; ceiling.
    aed = (input.totalMinor * 100n + rate - 1n) / rate;
  } else return { ok: false, reason: "fx_input_missing", orderAedMinor: null };
  return aed > BigInt(input.capAedMinor) ? { ok: false, reason: "order_over_limit", orderAedMinor: aed } : { ok: true, orderAedMinor: aed };
}
