import "server-only";
import { BitrixRestClient } from "../crm/bitrix.client";
import { crmConfigFrom, crmConfigProblems } from "../crm/crm.config";
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
 * (crm.config.ts). No cron entry exists in C1; C2 adds the schedule after the
 * portal setup is approved.
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
  const summary = await runCrmWorker(
    { config, store: prismaCrmStore, port, loadState: loadSubjectState, limiter, now, emit: (name, fields, level) => emitEvent(name, fields, level) },
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
    failed: summary.failed,
    dead: summary.dead,
    throttled: summary.throttled,
    breakerOpen: summary.breakerOpen,
    foreignDue: summary.foreignDue,
    durationMs: summary.durationMs,
  });
  return { ...summary, retention, ranAt };
}
