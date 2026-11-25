import "server-only";
import { z } from "zod";
import type { Currency } from "@/lib/types";
import { settingsRepo } from "../repositories/settings.repo";
import { Errors } from "../lib/errors";
import { log } from "../lib/logger";
import {
  aedMinorToInrMinorConservative,
  allocateDiscountAndTax,
  evaluateMargin,
  type FixedCost,
  type PercentCost,
} from "../domain/margin";
import { MARGIN_POLICY_SETTING_KEY, type MarginPolicy, type MarginService, type MarginSnapshot } from "../quotes/contracts";

/**
 * Margin policy, per-line margin and allocations for server quotes (doc 22
 * §23 B2, PAY-10, PAY-11).
 *
 * Every input is a versioned settings row written by the owner or accountant.
 * Nothing here has a code default:
 *
 *  - `pricing.margin_policy` (MarginPolicy). Missing, malformed or not yet
 *    effective ⇒ `currentPolicy()` throws NOT_CONFIGURED and no quote can be
 *    made. The migration seeds version 1 with the provisional 1,500 bps floor.
 *  - `pricing.fx_inr_per_aed` (FxInput). The recorded conservative composite
 *    INR-per-AED rate for INR-charged lines, with its source, record time and
 *    expiry. Missing, malformed, not yet recorded or expired ⇒ the line is
 *    refused with `fx_input_missing`. No rate is ever derived here.
 *  - `pricing.margin_cost_inputs` (CostInputs). Named variable costs (gateway
 *    fee, tax on that fee, and so on), with their source and record time.
 *    Missing, malformed or not yet recorded ⇒ the line is refused with
 *    `cost_inputs_missing`; a missing row is never read as zero fees. Only an
 *    explicit row with `lines: []` means "the owner confirmed there are no
 *    variable costs". The snapshot records which version was used.
 *
 * Direction rules are the evaluator's: costs round up, margin rounds down.
 */

export const FX_INR_PER_AED_SETTING_KEY = "pricing.fx_inr_per_aed";
export const MARGIN_COST_INPUTS_SETTING_KEY = "pricing.margin_cost_inputs";

const isoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO timestamp");

export const marginPolicySchema = z.object({
  version: z.number().int().min(1),
  floorBps: z.number().int().min(0).max(10_000),
  effectiveFrom: isoInstant,
});

export const fxInputSchema = z
  .object({
    version: z.number().int().min(1),
    /** Decimal string with at most two places, e.g. "24.10". */
    inrPerAed: z
      .string()
      .regex(/^\d{1,6}(\.\d{1,2})?$/)
      // A zero rate would price INR lines at nothing and makes the conversion throw (review 103 N0-12).
      .refine((v) => Number(v) > 0, "must be positive"),
    /** Who recorded the rate and from what (an owner or accountant input). */
    source: z.string().trim().min(1).max(200),
    recordedAt: isoInstant,
    expiresAt: isoInstant,
  })
  .refine((v) => Date.parse(v.expiresAt) > Date.parse(v.recordedAt), "expiresAt must be after recordedAt");

const costLineSchema = z.discriminatedUnion("kind", [
  /** Basis points of the charged amount (a gateway fee). */
  z.object({ name: z.string().trim().min(1).max(80), kind: z.literal("percent_of_charge"), bps: z.number().int().min(0).max(10_000) }),
  /** A per-line amount in AED minor units, as a digit string; converted like the supplier net on INR lines. */
  z.object({ name: z.string().trim().min(1).max(80), kind: z.literal("fixed_aed"), aedMinor: z.string().regex(/^\d{1,15}$/) }),
]);

export const costInputsSchema = z.object({
  version: z.number().int().min(1),
  /** Who recorded the inputs and from what (an owner or accountant input). */
  source: z.string().trim().min(1).max(200),
  recordedAt: isoInstant,
  /** Empty means the owner confirmed there are no variable costs; it is never the default. */
  lines: z.array(costLineSchema).max(20),
});

export type FxInput = z.infer<typeof fxInputSchema>;
export type CostInputs = z.infer<typeof costInputsSchema>;

/**
 * The service's own result types, wider than the frozen `MarginService`
 * contract: they add the `cost_inputs_missing` refusal and the cost-input
 * version on the snapshot. Remove the narrowing in `toContractMarginService`
 * once the contract carries both.
 */
export type MarginRefusalReason = "margin_below_floor" | "fx_input_missing" | "cost_inputs_missing";
export type LedgerMarginSnapshot = MarginSnapshot & { costInputs: { version: number; source: string } };
export type LedgerMarginService = Omit<MarginService, "evaluate"> & {
  evaluate(
    input: Parameters<MarginService["evaluate"]>[0],
  ): Promise<{ ok: true; snapshot: LedgerMarginSnapshot } | { ok: false; reason: MarginRefusalReason }>;
};

export interface MarginServiceDeps {
  /** The raw settings value, or null when the row does not exist. */
  readSetting(key: string): Promise<unknown>;
  now(): Date;
}

/** The row's `version` when it has a usable one, for log state only. */
function settingVersion(raw: unknown): string {
  if (raw === null || raw === undefined) return "absent";
  const v = typeof raw === "object" ? (raw as { version?: unknown }).version : undefined;
  return typeof v === "number" && Number.isInteger(v) ? String(v) : "unversioned";
}

export function createMarginService(deps: MarginServiceDeps): LedgerMarginService {
  /**
   * Readiness evaluates every unit of every product, so a standing settings
   * problem would warn on each call. Warn once per (event, row version or
   * absence) per setting key, then stay silent until the state changes; a
   * usable row (`event` null) clears it, so a later fault warns again.
   */
  const warned = new Map<string, string>();
  function warnOnce(key: string, event: string | null, raw: unknown) {
    if (event === null) {
      warned.delete(key);
      return;
    }
    const version = settingVersion(raw);
    const state = `${event}:${version}`;
    if (warned.get(key) === state) return;
    warned.set(key, state);
    log.warn(event, { key, version });
  }

  async function fxInput(now: Date): Promise<FxInput | null> {
    const raw = await deps.readSetting(FX_INR_PER_AED_SETTING_KEY);
    if (raw === null || raw === undefined) return null;
    const parsed = fxInputSchema.safeParse(raw);
    if (!parsed.success) {
      warnOnce(FX_INR_PER_AED_SETTING_KEY, "margin.fx_input_invalid", raw);
      return null;
    }
    warnOnce(FX_INR_PER_AED_SETTING_KEY, null, raw);
    const t = now.getTime();
    if (Date.parse(parsed.data.recordedAt) > t || Date.parse(parsed.data.expiresAt) <= t) return null;
    return parsed.data;
  }

  async function costInputs(now: Date): Promise<CostInputs | null> {
    const raw = await deps.readSetting(MARGIN_COST_INPUTS_SETTING_KEY);
    if (raw === null || raw === undefined) {
      warnOnce(MARGIN_COST_INPUTS_SETTING_KEY, "margin.cost_inputs_missing", raw);
      return null;
    }
    const parsed = costInputsSchema.safeParse(raw);
    if (!parsed.success || Date.parse(parsed.data.recordedAt) > now.getTime()) {
      warnOnce(MARGIN_COST_INPUTS_SETTING_KEY, "margin.cost_inputs_invalid", raw);
      return null;
    }
    warnOnce(MARGIN_COST_INPUTS_SETTING_KEY, null, raw);
    return parsed.data;
  }

  return {
    async currentPolicy(): Promise<MarginPolicy> {
      const raw = await deps.readSetting(MARGIN_POLICY_SETTING_KEY);
      const parsed = marginPolicySchema.safeParse(raw);
      if (!parsed.success) throw Errors.notConfigured("Margin policy");
      if (Date.parse(parsed.data.effectiveFrom) > deps.now().getTime()) throw Errors.notConfigured("Margin policy");
      return parsed.data;
    },

    async evaluate({ chargedMinor, currency, supplierNetAedMinor, policy }: { chargedMinor: bigint; currency: Currency; supplierNetAedMinor: bigint; policy: MarginPolicy }) {
      const checked = marginPolicySchema.safeParse(policy);
      if (!checked.success) throw Errors.notConfigured("Margin policy");

      const now = deps.now();
      const costs = await costInputs(now);
      if (!costs) return { ok: false as const, reason: "cost_inputs_missing" as const };
      let toCharged: (aedMinor: bigint) => bigint;
      let fxUsed: MarginSnapshot["fx"] = null;
      if (currency === "AED") {
        toCharged = (aedMinor) => aedMinor;
      } else if (currency === "INR") {
        const fx = await fxInput(now);
        if (!fx) return { ok: false as const, reason: "fx_input_missing" as const };
        toCharged = (aedMinor) => aedMinorToInrMinorConservative(aedMinor, fx.inrPerAed);
        fxUsed = { version: fx.version, inrPerAed: fx.inrPerAed, source: fx.source };
      } else {
        return { ok: false as const, reason: "fx_input_missing" as const };
      }

      const percentCosts: PercentCost[] = [];
      const fixedCosts: FixedCost[] = [];
      for (const line of costs.lines) {
        if (line.kind === "percent_of_charge") percentCosts.push({ label: line.name, bps: line.bps });
        else fixedCosts.push({ label: line.name, amountMinor: toCharged(BigInt(line.aedMinor)) });
      }

      const result = evaluateMargin(
        { sellMinor: chargedMinor, supplierNetMinor: toCharged(supplierNetAedMinor), percentCosts, fixedCosts },
        { minGrossMarginBps: policy.floorBps },
      );
      if (!result.meetsPolicy) return { ok: false as const, reason: "margin_below_floor" as const };

      const snapshot: LedgerMarginSnapshot = {
        policyVersion: policy.version,
        floorBps: policy.floorBps,
        grossMarginBps: result.grossMarginBps,
        costLines: result.costLines.map((c) => ({ name: c.label, minor: c.amountMinor })),
        fx: fxUsed,
        costInputs: { version: costs.version, source: costs.source },
      };
      return { ok: true as const, snapshot };
    },

    allocate(linesMinor: bigint[], discountMinor: bigint, taxMinor: bigint) {
      return allocateDiscountAndTax(linesMinor, discountMinor, taxMinor);
    },
  };
}

/**
 * Fits the wider service to the frozen contract until it lists
 * `cost_inputs_missing`. Readiness and quotes already refuse every non-ok
 * result as `margin_below_floor`, so the narrowing changes no outcome.
 */
export function toContractMarginService(svc: LedgerMarginService): MarginService {
  return {
    currentPolicy: () => svc.currentPolicy(),
    async evaluate(input) {
      const r = await svc.evaluate(input);
      if (r.ok) return r;
      return { ok: false, reason: r.reason === "cost_inputs_missing" ? "margin_below_floor" : r.reason };
    },
    allocate: (linesMinor, discountMinor, taxMinor) => svc.allocate(linesMinor, discountMinor, taxMinor),
  };
}

export const marginService: MarginService = toContractMarginService(
  createMarginService({
    readSetting: (key) => settingsRepo.get<unknown>(key, null),
    now: () => new Date(),
  }),
);
