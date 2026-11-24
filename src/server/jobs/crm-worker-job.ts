import "server-only";
import { BitrixRestClient } from "../crm/bitrix.client";
import { crmConfigFrom, crmConfigProblems } from "../crm/crm.config";
import { deleteCrmProbe, runCrmProbe, type ProbeResult } from "../crm/crm.probe";
import { crmReturnHooks, storeCrmFingerprint } from "../crm/crm.reconcile";
import { crmReturnConfigFrom, crmReturnProblems } from "../crm/crm.return.config";
import { crmReturnCommands } from "../crm/crm.return.commands";
import { prismaCrmReturnStore, prismaCrmStoreWithReturn } from "../crm/crm.return.store";
import { loadSubjectState } from "../crm/crm.snapshot";
import { prismaCrmStore, runCrmRetention, type CrmRetentionResult } from "../crm/crm.store";
import { CRM_RUN_BUDGET_MS, pacedLimiter, runCrmWorker, type CrmRunSummary } from "../crm/crm.worker";
import { env } from "../lib/env";
import { rateLimit } from "../lib/rate-limit";
import { emitEvent } from "../lib/structured-events";

/**
 * One CRM worker run (doc 29 §6.4; CRM batch C1), for `/api/jobs/crm-worker`
 * only: its own route and its own budget, never a step of the booking tick,
 * so CRM slowness can never delay payments or supplier work.
 *
 * Off by default: answers `skipped` without touching data unless
 * CRM_SYNC_ENABLED=true and the whole CRM configuration validates
 * (crm.config.ts). Vercel Cron calls it every minute (vercel.json, C2a); while
 * the switch is off every call is that no-op.
 *
 * Rate: one request a second per portal inside a run (half the documented
 * non-Enterprise 2/s, which is shared per portal and per source IP), at most
 * 60 a minute per portal across instances (a Postgres window), at most 12 a
 * run. Batch calls are not used.
 */

export const CRM_REQUESTS_PER_MINUTE = 60;
export const CRM_MAX_REQUESTS_PER_RUN = 12;

export type CrmJobResult =
  | { ok: true; skipped: string; ranAt: string }
  | ({ ranAt: string; retention: CrmRetentionResult | null } & CrmRunSummary);

export type CrmProbeJobResult = { ok: true; skipped: string; ranAt: string } | ({ ranAt: string } & ProbeResult) | { ok: true; ranAt: string; deleted: number; failed: string[] };

/**
 * The synthetic probe (doc 29d §5.2a; review C2A-01), on request only: POST
 * with CRON_SECRET and `x-crm-probe: synthetic` (or `delete`). It runs only
 * while CRM_SYNC_ENABLED is off and the whole configuration validates: it is
 * the check before switch-on. Field values never leave the probe; the answer
 * names each field `ok`, `missing` or `different`.
 */
export async function runCrmProbeJob(mode: "synthetic" | "delete"): Promise<CrmProbeJobResult> {
  const e = env();
  const ranAt = new Date().toISOString();
  if (e.CRM_SYNC_ENABLED === true) return { ok: true, skipped: "crm sync on: the probe runs only before switch-on", ranAt };
  const config = crmConfigFrom(e);
  if (!config) return { ok: true, skipped: "crm not configured", ranAt };
  const port = new BitrixRestClient(config, {
    onCall: (c) => emitEvent("crm.call", { method: c.method, status: c.status, durationMs: c.durationMs, outcome: c.outcome }, c.outcome === "ok" ? "info" : "warn"),
  });
  if (mode === "delete") {
    const r = await deleteCrmProbe({ config, port });
    emitEvent("crm.probe", { mode, deleted: r.deleted, failed: r.failed.join(",") || null }, r.failed.length ? "error" : "info");
    return { ok: true, ranAt, ...r };
  }
  const r = await runCrmProbe({ config, port, now: () => new Date() });
  const bad = Object.entries(r.fields).filter(([, s]) => s !== "ok").map(([k, s]) => `${k}:${s}`);
  emitEvent("crm.probe", { mode, ok: r.ok, dealId: r.dealId, created: r.created, notOk: bad.join(",") || null }, r.ok ? "info" : "error");
  return { ...r, ranAt };
}

export type CrmFingerprintJobResult = { ok: true; skipped: string; ranAt: string } | { ok: true; ranAt: string; stored: boolean; reason?: string; hashPrefix: string };

/**
 * The explicit owner step that stores the portal fingerprint (doc 29e §7, §15 step 6), and the reset after a
 * mismatch: POST with CRON_SECRET, `x-crm-fingerprint: store` and CRM_PROBE_SECRET. Three reads (`profile`,
 * `crm.category.get`, `crm.status.list`), no write to the portal. Refused for an administrator webhook or when
 * the configured funnel or a stage is not what the portal shows; nothing is stored then.
 */
export async function runCrmFingerprintJob(): Promise<CrmFingerprintJobResult> {
  const e = env();
  const ranAt = new Date().toISOString();
  const config = crmConfigFrom(e);
  if (!config) return { ok: true, skipped: "crm not configured", ranAt };
  const port = new BitrixRestClient(config, {
    onCall: (c) => emitEvent("crm.call", { method: c.method, status: c.status, durationMs: c.durationMs, outcome: c.outcome }, c.outcome === "ok" ? "info" : "warn"),
  });
  await prismaCrmStore.ensurePortal(config, { categoryId: config.categoryId, originatorId: config.originatorId });
  const r = await storeCrmFingerprint({ config, store: prismaCrmReturnStore, port, now: () => new Date() });
  emitEvent("crm.fingerprint_store", { stored: r.stored, reason: r.reason ? r.reason.replace(/,/g, ".").slice(0, 80) : null, hashPrefix: r.hashPrefix }, r.stored ? "info" : "error");
  return { ok: true, ranAt, ...r };
}

export async function runCrmWorkerJob(opts: { now?: () => Date; budgetMs?: number } = {}): Promise<CrmJobResult> {
  const e = env();
  const ranAt = new Date().toISOString();
  if (e.CRM_SYNC_ENABLED !== true) return { ok: true, skipped: "crm sync off", ranAt };
  const config = crmConfigFrom(e);
  if (!config) {
    emitEvent("crm.refused", { reason: crmConfigProblems(e).length ? "config_invalid" : "config_missing" }, "error");
    return { ok: true, skipped: "crm not configured", ranAt };
  }
  const now = opts.now ?? (() => new Date());
  const budgetMs = opts.budgetMs ?? CRM_RUN_BUDGET_MS;
  const startedAt = now().getTime();
  const port = new BitrixRestClient(config, {
    onCall: (c) => emitEvent("crm.call", { method: c.method, status: c.status, durationMs: c.durationMs, outcome: c.outcome }, c.outcome === "ok" ? "info" : "warn"),
  });
  const limiter = pacedLimiter({
    minIntervalMs: 1_000,
    maxPerRun: CRM_MAX_REQUESTS_PER_RUN,
    now: () => now().getTime(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    deadline: startedAt + budgetMs + 5_000,
    shared: async () => {
      const r = await rateLimit({ key: `crm:${config.environment}:${config.portal}`, limit: CRM_REQUESTS_PER_MINUTE, windowSeconds: 60 });
      return r.allowed && !r.storeUnavailable;
    },
  });
  // The return path (C3ab, doc 29e): inside this run and lease, off unless CRM_RETURN_PATH says otherwise.
  const ret = crmReturnConfigFrom(e, config);
  if (crmReturnProblems(e, config).length) {
    emitEvent("crm.refused", { reason: "return_config_invalid" }, "error");
    await prismaCrmReturnStore.raiseFinding(config, { kind: "crm_return_config_invalid", subjectKey: "portal" }, now()).catch(() => {});
  }
  const hooks =
    ret.mode === "off"
      ? undefined
      : crmReturnHooks({
          config,
          ret,
          store: prismaCrmStoreWithReturn,
          port,
          commands: crmReturnCommands,
          loadState: loadSubjectState,
          limiter,
          now,
          emit: (name, fields, level) => emitEvent(name, fields, level),
        });
  const summary = await runCrmWorker(
    { config, store: prismaCrmStore, port, loadState: loadSubjectState, limiter, now, hooks, emit: (name, fields, level) => emitEvent(name, fields, level) },
    { budgetMs },
  );
  let retention: CrmRetentionResult | null = null;
  if (summary.outcome === "ran") {
    retention = await runCrmRetention(config, now()).catch(() => null);
    if (retention && (retention.scheduled || retention.purgedOutbox || retention.purgedLinks)) emitEvent("crm.retention", { ...retention });
  }
  emitEvent("crm.run", {
    outcome: summary.outcome,
    reason: summary.reason ?? null,
    processed: summary.processed,
    pushed: summary.pushed,
    comments: summary.comments,
    failed: summary.failed,
    dead: summary.dead,
    throttled: summary.throttled,
    breakerOpen: summary.breakerOpen,
    foreignDue: summary.foreignDue,
    returnMode: ret.mode,
    durationMs: summary.durationMs,
  });
  return { ...summary, retention, ranAt };
}
