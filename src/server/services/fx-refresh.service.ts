import "server-only";
import { Prisma } from "@prisma/client";
import { prisma, TX_OPTIONS } from "../lib/db";
import { env } from "../lib/env";
import { log } from "../lib/logger";
import { audit } from "../lib/audit";
import { requirePermission, type Actor } from "../lib/actor";
import { Errors } from "../lib/errors";
import { settingsRepo } from "../repositories/settings.repo";
import {
  FRANKFURTER_HOST,
  FRANKFURTER_LATEST_URL,
  FX_ROW_TTL_MS,
  fxGuardRefusals,
  fxSourceText,
  hundredthsToRate,
  inrPerAedHundredths,
  moveBps,
  parseFrankfurterLatest,
  parseFxBand,
  rateToHundredths,
  type FxBand,
  type FxGuardRefusal,
  type UsdInrQuote,
} from "../domain/fx";
import { FX_INR_PER_AED_SETTING_KEY, fxInputSchema, type FxInput } from "./margin.service";
import { readinessService } from "./readiness.service";
import { verifyStepUp } from "./approval.service";

/**
 * Live refresh of `pricing.fx_inr_per_aed` (doc 22 §32.16; owner request of
 * 3 November 2026). Run by `/api/jobs/fx-refresh` (Vercel Cron, CRON_SECRET)
 * and by the admin "Refresh now" action (`pricing.edit`).
 *
 * 1. Fetch the ECB USD/INR reference rate from Frankfurter: one https GET to
 *    exactly `api.frankfurter.dev`, no redirects, a 10 s timeout, a small
 *    body cap, strict zod parsing. Any failure writes nothing.
 * 2. Compute INR per AED = USD/INR ÷ 3.6725 × 1.02, exactly, rounded up.
 * 3. Under a row lock, check the guards against the stored row: ECB date at
 *    most 4 days old, rate inside the plausible band, and at most a 5% move
 *    from the stored rate (any parseable stored row, expired or not). A
 *    refusal keeps the old row, logs an error and writes an audit row.
 * 4. Write a new version: `version` + 1, `recordedAt` now, `expiresAt` now +
 *    48 h, audited as `settings.update` like any settings write (actor: the
 *    system for the job, the admin for a manual run).
 *
 * Idempotency: a run whose computed rate equals the stored one still writes
 * a new version. That is the "still confirmed" signal: it moves `recordedAt`
 * and extends `expiresAt`, so a stable rate never lapses while the source is
 * reachable. Readiness is re-run only when the rate changed or the stored
 * row was not usable, since nothing else changes a margin verdict.
 *
 * Fail-safe: there is no fallback rate. If refreshes keep failing, the row
 * expires on its own and INR lines are refused with `fx_input_missing`, so
 * instant INR quotes fall back to inquiry. Readiness does not notice an
 * expiry by itself, so every run that writes nothing (a source failure, a
 * guard refusal, a bad band config, a conflict) reads the stored row again
 * and, when it is expired or missing, re-runs readiness: the instant badge
 * comes off at the next scheduled run, at most 12 h after the expiry. That
 * re-run only reads the row and re-evaluates products; it never writes or
 * extends a rate.
 *
 * An admin may accept a jump larger than 5% (and only that guard), by
 * passing the exact rate they were shown; a fresh fetch must compute that same
 * rate. The caller is responsible for the step-up (see the admin action).
 */

export const FX_FETCH_TIMEOUT_MS = 10_000;
/** The answer is about 70 bytes; anything much larger is not the answer we asked for. */
const MAX_BODY_BYTES = 4_096;

export type FxFetchFailure = "timeout" | "network" | "redirected" | "http_status" | "too_large" | "bad_json" | "bad_payload";

export type FxRefreshOutcome =
  | {
      status: "written";
      version: number;
      inrPerAed: string;
      previous: string | null;
      changed: boolean;
      source: string;
      recordedAt: string;
      expiresAt: string;
      jumpAccepted: boolean;
    }
  | {
      status: "refused";
      reasons: FxGuardRefusal[];
      computed: string;
      previous: string | null;
      /** |computed − previous| in basis points of previous; null on a first write. */
      moveBps: number | null;
      sourceDate: string;
    }
  | { status: "failed"; reason: FxFetchFailure | "band_config_invalid" | "accepted_rate_mismatch" | "write_conflict" };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** One GET to Frankfurter; never throws. */
export async function fetchUsdInr(fetchImpl: FetchLike, timeoutMs = FX_FETCH_TIMEOUT_MS): Promise<{ ok: true; quote: UsdInrQuote } | { ok: false; reason: FxFetchFailure }> {
  const url = new URL(FRANKFURTER_LATEST_URL);
  // The constant is the only target; this refuses an edit that points it elsewhere.
  if (url.protocol !== "https:" || url.host !== FRANKFURTER_HOST) return { ok: false, reason: "network" };
  const signal = AbortSignal.timeout(timeoutMs);
  let text: string;
  try {
    const res = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      signal,
    });
    if (res.redirected || (res.url && new URL(res.url).host !== FRANKFURTER_HOST)) return { ok: false, reason: "redirected" };
    if (!res.ok) return { ok: false, reason: "http_status" };
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) return { ok: false, reason: "too_large" };
    text = await res.text();
  } catch (error) {
    const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
    return { ok: false, reason: signal.aborted || name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
  }
  if (text.length > MAX_BODY_BYTES) return { ok: false, reason: "too_large" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: "bad_json" };
  }
  const quote = parseFrankfurterLatest(body);
  return quote ? { ok: true, quote } : { ok: false, reason: "bad_payload" };
}

/**
 * The locked read-then-write of the settings row. `run` gets the stored raw
 * value (null when absent) and a `write` that stores the next value and its
 * audit row in the same transaction.
 */
export interface FxStore {
  withLockedRow<T>(run: (current: unknown, write: (next: FxInput, actor: Actor, reason: string) => Promise<void>) => Promise<T>): Promise<T>;
  /** The stored raw value, read fresh (no cache, no lock); null when absent. Never writes. */
  read(): Promise<unknown>;
  /** Drops the per-process settings cache so readiness and quotes read the row as stored. */
  dropCache(): void;
}

export interface FxRefreshDeps {
  fetch: FetchLike;
  timeoutMs?: number;
  now(): Date;
  /** The plausible band, or null when its configuration is invalid. */
  band(): FxBand | null;
  store: FxStore;
  /** Audits a guard refusal (nothing else is written). */
  auditRefusal(actor: Actor, detail: Record<string, unknown>): Promise<void>;
  /** Re-runs readiness after a pricing setting changed; must not throw. */
  reevaluate(key: string): Promise<void>;
  /** Verifies and burns a fresh TOTP code for a staff actor; null when accepted, otherwise the failure code. */
  stepUp(actor: Actor, code: string): Promise<string | null>;
}

export interface FxRefreshOptions {
  trigger: "cron" | "manual";
  /** Manual only: the exact computed rate the admin was shown and accepts despite a jump. */
  acceptJumpTo?: string;
}

/** The stored row if it parses, regardless of its expiry. */
function storedRow(raw: unknown): FxInput | null {
  const parsed = fxInputSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function usableAt(row: FxInput | null, now: Date): boolean {
  if (!row) return false;
  const t = now.getTime();
  return Date.parse(row.recordedAt) <= t && Date.parse(row.expiresAt) > t;
}

export function createFxRefreshService(deps: FxRefreshDeps) {
  const service = {
    /**
     * The admin "Refresh now" (`pricing.edit`). Accepting a jump also needs a
     * fresh authenticator code; a refused code is audited and nothing is fetched.
     */
    async refreshManually(actor: Actor, input: { acceptJumpTo?: string; totpCode?: string }): Promise<FxRefreshOutcome> {
      requirePermission(actor, "pricing.edit");
      if (input.acceptJumpTo !== undefined) {
        if (rateToHundredths(input.acceptJumpTo) === null) throw Errors.validation({ acceptJumpTo: "Not a rate" });
        const failed = await deps.stepUp(actor, input.totpCode ?? "");
        if (failed) {
          await deps.auditRefusal(actor, { reasons: ["step_up_required"], stepUp: failed, trigger: "manual" });
          throw Errors.validation({ totpCode: "The code was not accepted; wait for a new one" });
        }
      }
      return service.refresh(actor, { trigger: "manual", acceptJumpTo: input.acceptJumpTo });
    },

    async refresh(actor: Actor, opts: FxRefreshOptions): Promise<FxRefreshOutcome> {
      let outcome: FxRefreshOutcome;
      try {
        outcome = await attempt(actor, opts);
      } catch (error) {
        await rerunIfLapsed(opts.trigger);
        throw error;
      }
      if (outcome.status !== "written") await rerunIfLapsed(opts.trigger);
      return outcome;
    },
  };

  /**
   * After a run that wrote nothing: when the stored row is expired, missing
   * or malformed, re-run readiness so products leave instant. Read-only on
   * the rate; never throws (a failure is logged and the next run tries again).
   */
  async function rerunIfLapsed(trigger: FxRefreshOptions["trigger"]): Promise<void> {
    try {
      const raw = await deps.store.read();
      const row = storedRow(raw);
      if (usableAt(row, deps.now())) return;
      log.warn("fx.rate_lapsed_readiness_rerun", { version: row?.version ?? null, expiresAt: row?.expiresAt ?? null, trigger });
      deps.store.dropCache();
      await deps.reevaluate(FX_INR_PER_AED_SETTING_KEY);
    } catch (error) {
      log.error("fx.lapsed_rerun_failed", { trigger, error });
    }
  }

  async function attempt(actor: Actor, opts: FxRefreshOptions): Promise<FxRefreshOutcome> {
    const band = deps.band();
    if (!band) {
      log.error("fx.refresh_failed", { reason: "band_config_invalid", trigger: opts.trigger });
      return { status: "failed", reason: "band_config_invalid" };
    }

    const fetched = await fetchUsdInr(deps.fetch, deps.timeoutMs ?? FX_FETCH_TIMEOUT_MS);
    if (!fetched.ok) {
      log.error("fx.refresh_failed", { reason: fetched.reason, trigger: opts.trigger });
      return { status: "failed", reason: fetched.reason };
    }
    const { quote } = fetched;
    const hundredths = inrPerAedHundredths(quote.inrPerUsd);
    const computed = hundredthsToRate(hundredths);

    const acceptJump = opts.trigger === "manual" && opts.acceptJumpTo !== undefined;
    if (acceptJump && rateToHundredths(opts.acceptJumpTo ?? "") !== hundredths) {
      // The rate moved again between what the admin saw and now: they must look again.
      return { status: "failed", reason: "accepted_rate_mismatch" };
    }

    let outcome: FxRefreshOutcome;
    let reevaluate = false;
    try {
      outcome = await deps.store.withLockedRow(async (raw, write) => {
        const now = deps.now();
        const previous = storedRow(raw);
        const previousHundredths = previous ? rateToHundredths(previous.inrPerAed) : null;
        const refusals = fxGuardRefusals({ quote, hundredths, previousHundredths, band, now });
        const blocking = acceptJump ? refusals.filter((r) => r !== "jump_too_large") : refusals;
        const move = previousHundredths && previousHundredths > 0n ? Number(moveBps(previousHundredths, hundredths)) : null;

        if (blocking.length) {
          return { status: "refused", reasons: refusals, computed, previous: previous?.inrPerAed ?? null, moveBps: move, sourceDate: quote.date } as const;
        }

        const jumpAccepted = acceptJump && refusals.includes("jump_too_large");
        const next: FxInput = {
          version: settingVersionOf(raw) + 1,
          inrPerAed: computed,
          source: fxSourceText(quote) + (jumpAccepted ? " (jump accepted by admin)" : ""),
          recordedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + FX_ROW_TTL_MS).toISOString(),
        };
        const reason = jumpAccepted ? "fx_refresh:jump_accepted" : `fx_refresh:${opts.trigger}`;
        await write(next, actor, reason);
        const changed = previous?.inrPerAed !== computed;
        reevaluate = changed || !usableAt(previous, now);
        return {
          status: "written",
          version: next.version,
          inrPerAed: computed,
          previous: previous?.inrPerAed ?? null,
          changed,
          source: next.source,
          recordedAt: next.recordedAt,
          expiresAt: next.expiresAt,
          jumpAccepted,
        } as const;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034")) {
        log.error("fx.refresh_failed", { reason: "write_conflict", trigger: opts.trigger });
        return { status: "failed", reason: "write_conflict" };
      }
      throw error;
    }

    if (outcome.status === "refused") {
      log.error("fx.refresh_refused", { reasons: outcome.reasons, computed, previous: outcome.previous, moveBps: outcome.moveBps, sourceDate: quote.date, trigger: opts.trigger });
      await deps.auditRefusal(actor, { reasons: outcome.reasons, computed, previous: outcome.previous, moveBps: outcome.moveBps, sourceDate: quote.date, trigger: opts.trigger });
      return outcome;
    }

    deps.store.dropCache();
    log.info("fx.refresh_written", { version: outcome.version, inrPerAed: outcome.inrPerAed, previous: outcome.previous, changed: outcome.changed, trigger: opts.trigger });
    if (reevaluate) await deps.reevaluate(FX_INR_PER_AED_SETTING_KEY);
    return outcome;
  }

  return service;
}

/** A stored row that no longer parses still carries its version number; the next write continues from it. */
function settingVersionOf(raw: unknown): number {
  const v = raw !== null && typeof raw === "object" ? (raw as { version?: unknown }).version : undefined;
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0;
}

/* ---------------------------------------------------------------------------
 * Production wiring
 * ------------------------------------------------------------------------ */

/** The settings row behind `SELECT … FOR UPDATE`; an absent row is created (a concurrent creator fails with P2002). */
export const prismaFxStore: FxStore = {
  async withLockedRow(run) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      const rows = await tx.$queryRaw<{ value: unknown }[]>`SELECT "value" FROM "settings" WHERE "key" = ${FX_INR_PER_AED_SETTING_KEY} FOR UPDATE`;
      const exists = rows.length > 0;
      const current = rows[0]?.value ?? null;
      return run(current, async (next, actor, reason) => {
        const staffId = (actor.type === "admin" || actor.type === "agent") && actor.id ? actor.id : null;
        const value = next as unknown as Prisma.InputJsonValue;
        if (exists) await tx.setting.update({ where: { key: FX_INR_PER_AED_SETTING_KEY }, data: { value, updatedBy: staffId } });
        else await tx.setting.create({ data: { key: FX_INR_PER_AED_SETTING_KEY, value, updatedBy: staffId } });
        await audit(actor, "settings.update", { type: "setting", id: FX_INR_PER_AED_SETTING_KEY }, { before: current, after: next, reason }, tx);
      });
    }, TX_OPTIONS);
  },
  async read() {
    return (await prisma.setting.findUnique({ where: { key: FX_INR_PER_AED_SETTING_KEY }, select: { value: true } }))?.value ?? null;
  },
  dropCache() {
    settingsRepo.invalidate(FX_INR_PER_AED_SETTING_KEY);
  },
};

export const fxRefreshService = createFxRefreshService({
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  band: () => parseFxBand(env().FX_BAND_MIN_INR_PER_AED, env().FX_BAND_MAX_INR_PER_AED),
  store: prismaFxStore,
  async auditRefusal(actor, detail) {
    await audit(actor, "pricing.fx_refresh_refused", { type: "setting", id: FX_INR_PER_AED_SETTING_KEY }, { after: detail });
  },
  reevaluate: (key) => readinessService.reevaluateAfterSetting(key),
  stepUp: (actor, code) => verifyStepUp(actor, code),
});

/** The stored row for the admin view: parsed, plus whether it is usable now. Null when absent or malformed. */
export async function currentFxRow(now = new Date()): Promise<(FxInput & { usable: boolean }) | null> {
  const row = storedRow(await settingsRepo.get<unknown>(FX_INR_PER_AED_SETTING_KEY, null));
  return row ? { ...row, usable: usableAt(row, now) } : null;
}
