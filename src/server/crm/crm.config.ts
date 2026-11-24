/**
 * Bitrix24 CRM configuration (doc 29 §5.2, §6.4, §6.5; CRM batch C1) — env
 * slice → validated scope and config, or the reasons they are refused.
 *
 * Two levels, both pure (env is a parameter, as in traveldesk.config.ts):
 *
 *  - `crmScopeFrom`: the (environment, portal) the outbox writes rows for.
 *    It needs only a valid pinned portal host and a valid environment
 *    pairing. No scope ⇒ the enqueue hooks write nothing at all, which is the
 *    state of every environment after C1 (no portal is configured anywhere).
 *  - `crmConfigFrom`: everything the worker needs to deliver (credential,
 *    funnel, stage map, timeout). Null unless every check passes: never half
 *    configured. Delivery also needs `CRM_SYNC_ENABLED=true` (default off),
 *    checked by the job, not here.
 *
 * Guard rails:
 *  - The portal host is pinned (`CRM_BITRIX_PORTAL_HOST`): a bare host name,
 *    https only, on a Bitrix24 cloud domain. A `.test` host (reserved, never
 *    resolves) is accepted outside production only, for the fake portal.
 *    The client refuses any request to another host.
 *  - `CRM_BITRIX_ENV=production` ⇔ `APP_ENV=production`, and only on Vercel's
 *    production deployment, so a preview that inherited production values
 *    cannot write to the production portal (the TravelDesk rule, doc 22
 *    §32.46, extended to the CRM credential per doc 29 §6.5).
 *  - The deal funnel must not be 0: funnel 0 is the other business's
 *    pipeline on the shared portal (doc 29 §5.1). Every stage id must belong
 *    to the configured funnel (`C<category>:<STATUS>`).
 *  - The webhook secret only ever comes from the environment and never
 *    appears in a problem message.
 */

export type CrmEnvironment = "development" | "staging" | "production";
export type CrmPortalKind = "test" | "production";

/** OUTLYY's deal stages (doc 29 §5.4). The Bitrix24 STATUS_ID of each is configured: C2 creates the funnel. */
export const CRM_STAGE_KEYS = [
  "new_inquiry",
  "assigned",
  "contacted",
  "quoted",
  "negotiating",
  "payment_pending",
  "paid_awaiting_supplier",
  "confirmed_tickets_pending",
  "fulfilled",
  "lost",
  "spam",
  "cancelled",
  "refunded",
] as const;
export type CrmStageKey = (typeof CRM_STAGE_KEYS)[number];

/** Bitrix24 cloud domains the portal host may sit on. Self-hosted is unverified (doc 29 §5.1); extend in C2 if C0 shows it. */
export const BITRIX_CLOUD_SUFFIXES: readonly string[] = [".bitrix24.com", ".bitrix24.eu", ".bitrix24.de"];
/** Reserved TLD for the fake portal in tests and local work; refused in production. */
export const TEST_PORTAL_SUFFIX = ".test";

export const CRM_MIN_TIMEOUT_MS = 1_000;
export const CRM_MAX_TIMEOUT_MS = 20_000;
export const CRM_DEFAULT_TIMEOUT_MS = 5_000;

/** The env slice the CRM needs. `Env` from `src/server/lib/env.ts` satisfies it. */
export interface CrmEnvSlice {
  APP_ENV?: CrmEnvironment;
  VERCEL_ENV?: string;
  CRM_SYNC_ENABLED?: boolean;
  CRM_BITRIX_ENV?: CrmPortalKind;
  CRM_BITRIX_PORTAL_HOST?: string;
  CRM_BITRIX_WEBHOOK_USER_ID?: string;
  CRM_BITRIX_WEBHOOK_SECRET?: string;
  CRM_BITRIX_DEAL_CATEGORY_ID?: string;
  /** `key=STAGE_ID` pairs, comma-separated, one per CRM_STAGE_KEYS entry. */
  CRM_BITRIX_STAGE_IDS?: string;
  CRM_BITRIX_TIMEOUT_MS?: number;
}

export interface CrmScope {
  environment: CrmEnvironment;
  /** The pinned portal host. */
  portal: string;
}

export interface CrmConfig extends CrmScope {
  portalKind: CrmPortalKind;
  /** `outlyy-<environment>`: Bitrix24 originatorId. */
  originatorId: string;
  webhookUserId: string;
  webhookSecret: string;
  categoryId: number;
  stageIds: Readonly<Record<CrmStageKey, string>>;
  timeoutMs: number;
}

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export function originatorIdFor(environment: CrmEnvironment): string {
  return `outlyy-${environment}`;
}

function hostProblems(env: CrmEnvSlice): string[] {
  const raw = env.CRM_BITRIX_PORTAL_HOST;
  if (!raw) return ["CRM_BITRIX_PORTAL_HOST is missing"];
  const host = raw.trim();
  const problems: string[] = [];
  if (host !== host.toLowerCase()) problems.push("CRM_BITRIX_PORTAL_HOST must be lower case");
  if (/[/:@?#\s]/.test(host)) problems.push("CRM_BITRIX_PORTAL_HOST must be a bare host name (no scheme, port, path or credentials)");
  else if (host.length > 253 || !host.split(".").every((l) => HOST_LABEL.test(l)) || host.split(".").length < 3) {
    problems.push("CRM_BITRIX_PORTAL_HOST is not a valid portal host name");
  }
  const cloud = BITRIX_CLOUD_SUFFIXES.some((s) => host.endsWith(s));
  const fake = host.endsWith(TEST_PORTAL_SUFFIX);
  if (!cloud && !fake) problems.push(`CRM_BITRIX_PORTAL_HOST must be on ${BITRIX_CLOUD_SUFFIXES.join(", ")}`);
  if (fake && (env.APP_ENV ?? "development") === "production") problems.push("CRM_BITRIX_PORTAL_HOST: a .test portal is not allowed when APP_ENV=production");
  if (fake && env.CRM_BITRIX_ENV === "production") problems.push("CRM_BITRIX_PORTAL_HOST: a .test portal cannot be the production portal");
  return problems;
}

function pairingProblems(env: CrmEnvSlice): string[] {
  const problems: string[] = [];
  const kind = env.CRM_BITRIX_ENV;
  const appEnv = env.APP_ENV ?? "development";
  if (!kind) problems.push("CRM_BITRIX_ENV must be 'test' or 'production'");
  if (kind === "production" && appEnv !== "production") problems.push("CRM_BITRIX_ENV=production is only allowed when APP_ENV=production");
  if (kind === "production" && env.VERCEL_ENV !== undefined && env.VERCEL_ENV !== "" && env.VERCEL_ENV !== "production") {
    problems.push("CRM_BITRIX_ENV=production is only allowed on Vercel's production deployment (VERCEL_ENV=production)");
  }
  if (kind === "test" && appEnv === "production") problems.push("APP_ENV=production must not use a test CRM portal");
  return problems;
}

/** Reasons the outbox scope is refused. Empty ⇒ `crmScopeFrom` returns a scope. */
export function crmScopeProblems(env: CrmEnvSlice): string[] {
  return [...hostProblems(env), ...pairingProblems(env)];
}

/** The scope the enqueue hooks write for, or null (nothing is enqueued). */
export function crmScopeFrom(env: CrmEnvSlice): CrmScope | null {
  if (!env.CRM_BITRIX_PORTAL_HOST) return null;
  if (crmScopeProblems(env).length) return null;
  return { environment: env.APP_ENV ?? "development", portal: env.CRM_BITRIX_PORTAL_HOST.trim() };
}

function parseStageIds(raw: string | undefined, categoryId: number | null): { ids: Record<string, string>; problems: string[] } {
  const problems: string[] = [];
  const ids: Record<string, string> = {};
  if (!raw) return { ids, problems: ["CRM_BITRIX_STAGE_IDS is missing"] };
  const known = new Set<string>(CRM_STAGE_KEYS);
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    const key = eq > 0 ? pair.slice(0, eq).trim() : "";
    const value = eq > 0 ? pair.slice(eq + 1).trim() : "";
    if (!known.has(key)) {
      problems.push(`CRM_BITRIX_STAGE_IDS: unknown stage key '${/^[a-z_]{1,40}$/.test(key) ? key : "?"}'`);
      continue;
    }
    if (key in ids) problems.push(`CRM_BITRIX_STAGE_IDS: ${key} is given twice`);
    // Stage ids of a non-default funnel are `C<category>:<STATUS_ID>`.
    if (categoryId === null || !new RegExp(`^C${categoryId}:[A-Z0-9_]{1,40}$`).test(value)) {
      problems.push(`CRM_BITRIX_STAGE_IDS: ${key} must be a stage of funnel ${categoryId ?? "?"} (C<category>:<STATUS_ID>)`);
    }
    ids[key] = value;
  }
  for (const k of CRM_STAGE_KEYS) if (!(k in ids)) problems.push(`CRM_BITRIX_STAGE_IDS: ${k} is missing`);
  const values = Object.values(ids);
  if (new Set(values).size !== values.length) problems.push("CRM_BITRIX_STAGE_IDS: two stage keys share one stage id");
  return { ids, problems };
}

function categoryOf(env: CrmEnvSlice): number | null {
  const raw = env.CRM_BITRIX_DEAL_CATEGORY_ID?.trim();
  if (!raw || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

/** Every reason the delivery configuration is refused. Empty ⇒ usable. */
export function crmConfigProblems(env: CrmEnvSlice): string[] {
  const problems = crmScopeProblems(env);
  const user = env.CRM_BITRIX_WEBHOOK_USER_ID?.trim();
  if (!user) problems.push("CRM_BITRIX_WEBHOOK_USER_ID is missing");
  else if (!/^\d{1,9}$/.test(user)) problems.push("CRM_BITRIX_WEBHOOK_USER_ID must be the service user's numeric id");
  const secret = env.CRM_BITRIX_WEBHOOK_SECRET;
  if (!secret) problems.push("CRM_BITRIX_WEBHOOK_SECRET is missing");
  else if (!/^[A-Za-z0-9]{8,64}$/.test(secret)) problems.push("CRM_BITRIX_WEBHOOK_SECRET has an unexpected shape");
  const rawCategory = env.CRM_BITRIX_DEAL_CATEGORY_ID?.trim();
  const category = categoryOf(env);
  if (!rawCategory) problems.push("CRM_BITRIX_DEAL_CATEGORY_ID is missing");
  else if (rawCategory === "0") problems.push("CRM_BITRIX_DEAL_CATEGORY_ID must not be 0: funnel 0 belongs to the other business on the shared portal");
  else if (category === null) problems.push("CRM_BITRIX_DEAL_CATEGORY_ID must be a positive integer");
  problems.push(...parseStageIds(env.CRM_BITRIX_STAGE_IDS, category).problems);
  const t = env.CRM_BITRIX_TIMEOUT_MS ?? CRM_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(t) || t < CRM_MIN_TIMEOUT_MS || t > CRM_MAX_TIMEOUT_MS) {
    problems.push(`CRM_BITRIX_TIMEOUT_MS must be between ${CRM_MIN_TIMEOUT_MS} and ${CRM_MAX_TIMEOUT_MS}`);
  }
  return problems;
}

/** Null unless every check passes. Never partially configured. */
export function crmConfigFrom(env: CrmEnvSlice): CrmConfig | null {
  if (crmConfigProblems(env).length) return null;
  const scope = crmScopeFrom(env);
  if (!scope) return null;
  const categoryId = categoryOf(env) as number;
  const { ids } = parseStageIds(env.CRM_BITRIX_STAGE_IDS, categoryId);
  return {
    ...scope,
    portalKind: env.CRM_BITRIX_ENV as CrmPortalKind,
    originatorId: originatorIdFor(scope.environment),
    webhookUserId: (env.CRM_BITRIX_WEBHOOK_USER_ID as string).trim(),
    webhookSecret: env.CRM_BITRIX_WEBHOOK_SECRET as string,
    categoryId,
    stageIds: Object.freeze(ids as Record<CrmStageKey, string>),
    timeoutMs: env.CRM_BITRIX_TIMEOUT_MS ?? CRM_DEFAULT_TIMEOUT_MS,
  };
}
