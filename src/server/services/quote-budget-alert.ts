import "server-only";
import type { SupplierEnvironment } from "@prisma/client";
import { prisma } from "../lib/db";
import { log } from "../lib/logger";
import { emitEvent } from "../lib/structured-events";
import type { OpsIncident } from "./ops-alert.service";

/**
 * Quote budget alert (review 82, budget split; review 83 R3).
 *
 * A customer quote that cannot take a read from its share of the per-account
 * read budget (`takeQuoteReadToken`, suppliers/read-budget.ts: 18 reads a
 * minute by default) is refused `supplier_unavailable` and the customer is
 * sent to the inquiry. Nothing is charged, but a sale is lost, so staff must
 * hear about it.
 *
 * What happens on each budget refusal (`recordQuoteBudgetRefusal`):
 *  - one `settings` row per supplier, environment and account
 *    (`quoteBudgetRefusalKey`) records the current **episode**: when it began,
 *    the last refusal and how many refusals it holds. An episode ends after
 *    `QUOTE_BUDGET_EPISODE_GAP_MS` (10 minutes) with no refusal; the next
 *    refusal starts a new one;
 *  - one `supplier.quote_budget_refused` log line (warn) with the supplier,
 *    environment and the episode's refusal count: the metric. Codes and counts
 *    only, never a product, a customer or an amount.
 *
 * The alert (`quoteBudgetIncidents`, read by the ops-alert sweep every 5
 * minutes, ops-alert.service.ts): one `quote_budget_spent` incident per
 * episode, raised at the episode's first refusal, on entity
 * `supplier_account:<supplier>.quote_budget.<environment>.<account>`.
 *
 * Thresholds (all provisional ops parameters):
 *  - trigger: the first budget refusal of an episode. At pilot volume any
 *    refusal means the quote share was spent within one minute, which is
 *    already unusual, and each one is a customer moved to the inquiry;
 *  - episode gap: 10 minutes without a refusal;
 *  - rate limits come from the existing ops-alert path: at most one email per
 *    entity and reason per 6 hours (`OPS_ALERT_DEDUP_MS`), at most 20 incident
 *    emails an hour across all kinds with one digest for the rest
 *    (`OPS_ALERT_HOURLY_CAP`), and nothing older than 72 hours
 *    (`OPS_ALERT_LOOKBACK_MS`).
 *
 * Recording never throws and never changes the refusal: a failed write is
 * logged and the quote is refused exactly as before.
 */

/** A refusal more than this long after the previous one starts a new episode (and a new incident). */
export const QUOTE_BUDGET_EPISODE_GAP_MS = 10 * 60_000;

const KEY_PREFIX = "supplier_quote_refusals.";
const CODE = /^[A-Za-z0-9_.:-]{1,60}$/;

export function quoteBudgetRefusalKey(supplierCode: string, environment: SupplierEnvironment, accountId: string): string {
  return `${KEY_PREFIX}${supplierCode}.${environment}.${accountId}`;
}

type TakeToken = (supplierCode: string, environment: SupplierEnvironment, accountId: string) => Promise<boolean>;

/** `take`, recording every refusal with `record` before it returns false. */
export function alertingQuoteToken(take: TakeToken, record: (supplierCode: string, environment: SupplierEnvironment, accountId: string) => Promise<void> = recordQuoteBudgetRefusal): TakeToken {
  return async (supplierCode, environment, accountId) => {
    const ok = await take(supplierCode, environment, accountId);
    if (!ok) await record(supplierCode, environment, accountId);
    return ok;
  };
}

/** Records one budget refusal in the account's episode row and writes the log line. Never throws. */
export async function recordQuoteBudgetRefusal(supplierCode: string, environment: SupplierEnvironment, accountId: string): Promise<void> {
  try {
    const key = quoteBudgetRefusalKey(supplierCode, environment, accountId);
    const gapSeconds = Math.round(QUOTE_BUDGET_EPISODE_GAP_MS / 1000);
    const rows = await prisma.$queryRaw<{ count: number; episode_start: Date }[]>`
      INSERT INTO settings (key, value, updated_at)
      VALUES (${key}, jsonb_build_object('supplier', ${supplierCode}::text, 'environment', ${environment}::text, 'account', ${accountId}::text,
                                         'episodeStart', now(), 'lastAt', now(), 'count', 1), now())
      ON CONFLICT (key) DO UPDATE SET
        value = CASE WHEN (settings.value->>'lastAt')::timestamptz <= now() - make_interval(secs => ${gapSeconds}::int)
                     THEN jsonb_build_object('supplier', ${supplierCode}::text, 'environment', ${environment}::text, 'account', ${accountId}::text,
                                             'episodeStart', now(), 'lastAt', now(), 'count', 1)
                     ELSE jsonb_set(jsonb_set(settings.value, '{lastAt}', to_jsonb(now())),
                                    '{count}', to_jsonb(COALESCE((settings.value->>'count')::int, 0) + 1)) END,
        updated_at = now()
      RETURNING (value->>'count')::int AS count, (value->>'episodeStart')::timestamptz AS episode_start`;
    const row = rows[0];
    emitEvent(
      "supplier.quote_budget_refused",
      { supplier: supplierCode, environment, refusals: row?.count ?? null, episodeStart: row?.episode_start ?? null },
      "warn",
    );
  } catch (error) {
    log.error("supplier.quote_budget_record_failed", { error });
  }
}

/** The stored episode row, as the sweep reads it. */
export interface QuoteBudgetEpisode {
  supplier: unknown;
  environment: unknown;
  account: unknown;
  episodeStart: Date;
}

/**
 * The incident for one episode: raised at its first refusal, only inside the
 * sweep window. Null when the row's names are not code-shaped (never put free
 * text into an alert). Pure, for tests.
 */
export function quoteBudgetIncident(e: QuoteBudgetEpisode, since: Date, now: Date): OpsIncident | null {
  const at = e.episodeStart.getTime();
  if (Number.isNaN(at) || at < since.getTime() || at > now.getTime()) return null;
  const parts = [e.supplier, e.environment, e.account];
  if (!parts.every((p): p is string => typeof p === "string" && CODE.test(p))) return null;
  const [supplier, environment, account] = parts as string[];
  return {
    kind: "quote_budget_refused",
    entityKind: "supplier_account",
    entityId: `${supplier}.quote_budget.${environment}.${account}`.slice(0, 200),
    reason: "quote_budget_spent",
    raisedAt: e.episodeStart,
    orderId: null,
    orderReference: null,
    bookingId: null,
    supplierBookingRef: null,
    adminPath: `/admin/suppliers/${encodeURIComponent(supplier)}`,
  };
}

/** Episodes that began inside the sweep window, newest first. */
export async function quoteBudgetIncidents(since: Date, now: Date, limit: number): Promise<OpsIncident[]> {
  const rows = await prisma.$queryRaw<{ supplier: unknown; environment: unknown; account: unknown; episode_start: Date }[]>`
    SELECT value->>'supplier' AS supplier, value->>'environment' AS environment, value->>'account' AS account,
           (value->>'episodeStart')::timestamptz AS episode_start
    FROM settings
    WHERE starts_with(key, ${KEY_PREFIX}) AND (value->>'episodeStart')::timestamptz BETWEEN ${since} AND ${now}
    ORDER BY episode_start DESC LIMIT ${limit}`;
  return rows.flatMap((r) => {
    const i = quoteBudgetIncident({ supplier: r.supplier, environment: r.environment, account: r.account, episodeStart: new Date(r.episode_start) }, since, now);
    return i ? [i] : [];
  });
}
