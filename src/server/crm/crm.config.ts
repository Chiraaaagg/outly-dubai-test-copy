/**
 * Bitrix24 CRM configuration (doc 29 §5.2, §6.4, §6.5; CRM batches C1 and
 * C2a; doc 29d) — env slice → validated scope and config, or the reasons
 * they are refused.
 *
 * Two levels, both pure (env is a parameter, as in traveldesk.config.ts):
 *
 *  - `crmScopeFrom`: the (environment, portal) the outbox writes rows for.
 *    It needs only a valid pinned portal host and a valid environment
 *    pairing. No scope ⇒ the enqueue hooks write nothing at all, which is the
 *    state of every environment after C1 (no portal is configured anywhere).
 *  - `crmConfigFrom`: everything the worker needs to deliver (credential,
 *    funnel, the 12-stage map, the custom field codes, the default deal
 *    owner, the admin link base, timeout). Null unless every check passes:
 *    never half configured, so a missing field code or owner fails closed.
 *    Delivery also needs `CRM_SYNC_ENABLED=true` (default off), checked by
 *    the job, not here.
 *
 * Guard rails:
 *  - The portal host is pinned (`CRM_BITRIX_PORTAL_HOST`): a bare host name,
 *    https only, on a Bitrix24 cloud domain (C2a adds `.bitrix24.in`, where
 *    the OUTLYY portal is; doc 29 §8.9 item 1.1). A `.test` host (reserved, never
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

/**
 * OUTLYY's 12 deal stages (doc 29 §5.4 as changed by decision C2-7: no
 * "Negotiating"; doc 29d §3.5). The Bitrix24 STATUS_ID of each is configured.
 */
export const CRM_STAGE_KEYS = [
  "new_inquiry",
  "assigned",
  "contacted",
  "quoted",
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

/**
 * The OUTLYY custom deal fields (doc 29d §3.8, consent flags per Q6). Each
 * key's Bitrix24 field code (`UF_CRM_…`) is configured in
 * `CRM_BITRIX_FIELD_CODES`; every key must be present.
 */
export const CRM_FIELD_KEYS = [
  "reference",
  "environment",
  "admin_link",
  "customer_name",
  "customer_phone",
  "customer_email",
  "payment_status",
  "supplier_booking_status",
  "ticket_status",
  "refund_status",
  "refund_amount",
  "travel_date",
  "item_summary",
  "as_of",
  "indicative_amount",
  "margin",
  "consent_marketing_email",
  "consent_marketing_email_at",
  "consent_marketing_whatsapp",
  "consent_marketing_whatsapp_at",
] as const;
export type CrmFieldKey = (typeof CRM_FIELD_KEYS)[number];

/** Bitrix24 cloud domains the portal host may sit on. Self-hosted is unverified (doc 29 §5.1). `.bitrix24.in`: the OUTLYY portal (C0 item 1.1). */
export const BITRIX_CLOUD_SUFFIXES: readonly string[] = [".bitrix24.com", ".bitrix24.eu", ".bitrix24.de", ".bitrix24.in"];
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
  /** `key=UF_CRM_…` pairs, comma-separated, one per CRM_FIELD_KEYS entry. */
  CRM_BITRIX_FIELD_CODES?: string;
  /** Bitrix24 user id of the Dubai sales lead who owns every new deal (decision C2-8). */
  CRM_BITRIX_DEFAULT_OWNER_ID?: string;
  CRM_BITRIX_TIMEOUT_MS?: number;
  /** The site origin; the deal's admin link is `<origin>/admin/…`. */
  NEXT_PUBLIC_SITE_URL?: string;
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
  fieldCodes: Readonly<Record<CrmFieldKey, string>>;
  /** Responsible person on a new deal; never sent on an update, so a reassignment on the portal is kept. */
  defaultOwnerId: number;
  /** Origin of the OUTLYY admin, no trailing slash (e.g. `https://outlyy.example`). */
  adminBaseUrl: string;
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

const FIELD_CODE = /^UF_CRM_[A-Z0-9_]{1,40}$/;

function parseFieldCodes(raw: string | undefined): { codes: Record<string, string>; problems: string[] } {
  const problems: string[] = [];
  const codes: Record<string, string> = {};
  if (!raw) return { codes, problems: ["CRM_BITRIX_FIELD_CODES is missing"] };
  const known = new Set<string>(CRM_FIELD_KEYS);
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    const key = eq > 0 ? pair.slice(0, eq).trim() : "";
    const value = eq > 0 ? pair.slice(eq + 1).trim() : "";
    if (!known.has(key)) {
      problems.push(`CRM_BITRIX_FIELD_CODES: unknown field key '${/^[a-z_]{1,40}$/.test(key) ? key : "?"}'`);
      continue;
    }
    if (key in codes) problems.push(`CRM_BITRIX_FIELD_CODES: ${key} is given twice`);
    if (!FIELD_CODE.test(value)) problems.push(`CRM_BITRIX_FIELD_CODES: ${key} must be a custom deal field code (UF_CRM_…)`);
    codes[key] = value;
  }
  for (const k of CRM_FIELD_KEYS) if (!(k in codes)) problems.push(`CRM_BITRIX_FIELD_CODES: ${k} is missing`);
  const values = Object.values(codes);
  if (new Set(values).size !== values.length) problems.push("CRM_BITRIX_FIELD_CODES: two field keys share one field code");
  return { codes, problems };
}

/** The admin origin from NEXT_PUBLIC_SITE_URL: https, no path, query or credentials; http only for localhost outside production. */
function adminBase(env: CrmEnvSlice): { base: string | null; problems: string[] } {
  const raw = env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return { base: null, problems: ["NEXT_PUBLIC_SITE_URL is missing (the deal's admin link)"] };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { base: null, problems: ["NEXT_PUBLIC_SITE_URL is not a URL"] };
  }
  const problems: string[] = [];
  const production = (env.APP_ENV ?? "development") === "production" || env.CRM_BITRIX_ENV === "production";
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) problems.push("NEXT_PUBLIC_SITE_URL must be a bare origin for the admin link (no path, query or credentials)");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local && !production)) problems.push("NEXT_PUBLIC_SITE_URL must be https for the admin link");
  if (local && production) problems.push("NEXT_PUBLIC_SITE_URL must not be localhost when the CRM portal is production");
  return { base: problems.length ? null : u.origin, problems };
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
  problems.push(...parseFieldCodes(env.CRM_BITRIX_FIELD_CODES).problems);
  const owner = env.CRM_BITRIX_DEFAULT_OWNER_ID?.trim();
  if (!owner) problems.push("CRM_BITRIX_DEFAULT_OWNER_ID is missing");
  else if (!/^[1-9]\d{0,8}$/.test(owner)) problems.push("CRM_BITRIX_DEFAULT_OWNER_ID must be the sales lead's numeric user id");
  else if (user && Number(owner) === Number(user)) problems.push("CRM_BITRIX_DEFAULT_OWNER_ID must not be the service account");
  problems.push(...adminBase(env).problems);
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
  const { codes } = parseFieldCodes(env.CRM_BITRIX_FIELD_CODES);
  return {
    ...scope,
    portalKind: env.CRM_BITRIX_ENV as CrmPortalKind,
    originatorId: originatorIdFor(scope.environment),
    webhookUserId: (env.CRM_BITRIX_WEBHOOK_USER_ID as string).trim(),
    webhookSecret: env.CRM_BITRIX_WEBHOOK_SECRET as string,
    categoryId,
    stageIds: Object.freeze(ids as Record<CrmStageKey, string>),
    fieldCodes: Object.freeze(codes as Record<CrmFieldKey, string>),
    defaultOwnerId: Number((env.CRM_BITRIX_DEFAULT_OWNER_ID as string).trim()),
    adminBaseUrl: adminBase(env).base as string,
    timeoutMs: env.CRM_BITRIX_TIMEOUT_MS ?? CRM_DEFAULT_TIMEOUT_MS,
  };
}
