/**
 * TravelDesk configuration — env slice → validated config, or the reasons it is refused.
 *
 * Guard rails (docs/backend/21-traveldesk-integration-plan.md §11):
 *  - Only two hosts exist, one per environment (TravelDesk docs §Getting started).
 *    `TRAVELDESK_ENV` picks the environment; `TRAVELDESK_API_BASE_URL` must be
 *    exactly that environment's documented base URL. Two settings that must
 *    agree make it hard to pair a production key with a test URL or the
 *    reverse, and impossible to send the key to any other host.
 *  - `APP_ENV=production` ⇔ `TRAVELDESK_ENV=production`. A local or staging app
 *    can never talk to the production API, and production can never run on
 *    the test API (test bookings "are not real").
 *  - Booking mutations are a separate, default-off switch
 *    (`TRAVELDESK_BOOKINGS_ENABLED`). Production mutations also need the
 *    agency pinned (`TRAVELDESK_AGENCY_ID`), so a booking can only reach the
 *    agreed account (`travelDeskMutationRefusal`). Production activation was
 *    approved by the owner on 18 Nov 2026 (doc 22 §32.46).
 *
 * Pure: env is a parameter (registry.ts convention). Never returns the key in a
 * problem message.
 */

export type TravelDeskEnvironment = "test" | "production";

export const TRAVELDESK_HOSTS: Readonly<Record<TravelDeskEnvironment, string>> = {
  test: "testapi.traveldesk.me",
  production: "api.traveldesk.me",
};

/** Every spec path starts with this prefix; the documented base URL ends with it. */
export const TRAVELDESK_PATH_PREFIX = "/public/b2b/v1";

/** HTML §Retries and polling: at least 120 s for create, reserve and confirm. */
export const TRAVELDESK_MIN_MUTATION_TIMEOUT_MS = 120_000;
/** The worker route runs 300 s and starts a mutation only with timeout + 30 s left (budget 270 s). */
export const TRAVELDESK_MAX_MUTATION_TIMEOUT_MS = 240_000;
export const TRAVELDESK_MAX_READ_TIMEOUT_MS = 120_000;
export const TRAVELDESK_MIN_READ_TIMEOUT_MS = 1_000;

/** The env slice TravelDesk needs. `Env` from `src/server/lib/env.ts` satisfies it. */
export interface TravelDeskEnvSlice {
  APP_ENV?: "development" | "staging" | "production";
  /** Vercel's own deployment kind; a production TravelDesk config is refused on any other Vercel deployment. */
  VERCEL_ENV?: string;
  SUPPLIER_ADAPTER_TRAVELDESK?: "mock" | "live";
  TRAVELDESK_ENV?: TravelDeskEnvironment;
  TRAVELDESK_API_BASE_URL?: string;
  TRAVELDESK_API_KEY?: string;
  TRAVELDESK_TIMEOUT_MS?: number;
  TRAVELDESK_READ_TIMEOUT_MS?: number;
  TRAVELDESK_BOOKINGS_ENABLED?: boolean;
  /**
   * The agency the key must act for (`/balance` id), pinned per environment
   * (SUP-10). The booking engine refuses a send when the key answers for
   * another agency (supplier-booking.service accountMismatch), and production
   * mutations are refused while this is unset. Reads are unaffected.
   */
  TRAVELDESK_AGENCY_ID?: string | number;
}

export interface TravelDeskConfig {
  environment: TravelDeskEnvironment;
  /** Normalised documented base URL, no trailing slash: `https://<host>/public/b2b/v1`. */
  baseUrl: string;
  host: string;
  apiKey: string;
  mutationTimeoutMs: number;
  readTimeoutMs: number;
  bookingsEnabled: boolean;
  /** Pinned agency id (TRAVELDESK_AGENCY_ID), or null when not pinned. */
  agencyId?: string | null;
}

export type TravelDeskMode = "mock" | "live" | "live_unconfigured";

export function expectedBaseUrl(environment: TravelDeskEnvironment): string {
  return `https://${TRAVELDESK_HOSTS[environment]}${TRAVELDESK_PATH_PREFIX}`;
}

/**
 * Every reason the live configuration is refused. Empty ⇒ usable.
 * Only meaningful when `SUPPLIER_ADAPTER_TRAVELDESK=live`.
 */
export function traveldeskConfigProblems(env: TravelDeskEnvSlice): string[] {
  const problems: string[] = [];
  const environment = env.TRAVELDESK_ENV;
  if (!environment) problems.push("TRAVELDESK_ENV must be 'test' or 'production'");

  if (!env.TRAVELDESK_API_KEY) problems.push("TRAVELDESK_API_KEY is missing");
  else if (/\s/.test(env.TRAVELDESK_API_KEY)) problems.push("TRAVELDESK_API_KEY contains whitespace");

  const raw = env.TRAVELDESK_API_BASE_URL;
  if (!raw) problems.push("TRAVELDESK_API_BASE_URL is missing");
  else if (environment) {
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      problems.push("TRAVELDESK_API_BASE_URL is not a URL");
    }
    if (url) {
      const path = url.pathname.replace(/\/+$/, "");
      if (url.protocol !== "https:") problems.push("TRAVELDESK_API_BASE_URL must use https");
      if (url.username || url.password) problems.push("TRAVELDESK_API_BASE_URL must not carry credentials");
      if (url.port) problems.push("TRAVELDESK_API_BASE_URL must not set a port");
      if (url.search || url.hash) problems.push("TRAVELDESK_API_BASE_URL must not have a query or fragment");
      if (url.hostname !== TRAVELDESK_HOSTS[environment]) {
        problems.push(`TRAVELDESK_API_BASE_URL host must be ${TRAVELDESK_HOSTS[environment]} when TRAVELDESK_ENV=${environment}`);
      }
      if (path !== TRAVELDESK_PATH_PREFIX) problems.push(`TRAVELDESK_API_BASE_URL path must be ${TRAVELDESK_PATH_PREFIX}`);
    }
  }

  const appEnv = env.APP_ENV ?? "development";
  if (environment === "production" && appEnv !== "production") {
    problems.push("TRAVELDESK_ENV=production is only allowed when APP_ENV=production");
  }
  // A preview deployment that inherited production values must not reach production TravelDesk.
  if (environment === "production" && env.VERCEL_ENV !== undefined && env.VERCEL_ENV !== "" && env.VERCEL_ENV !== "production") {
    problems.push("TRAVELDESK_ENV=production is only allowed on Vercel's production deployment (VERCEL_ENV=production)");
  }
  if (environment === "test" && appEnv === "production") {
    problems.push("APP_ENV=production must not use the TravelDesk test environment");
  }

  if (env.TRAVELDESK_AGENCY_ID !== undefined && env.TRAVELDESK_AGENCY_ID !== "" && pinnedAgencyId(env) === null) {
    problems.push("TRAVELDESK_AGENCY_ID must be the agency's numeric id");
  }

  const read = env.TRAVELDESK_READ_TIMEOUT_MS ?? 20_000;
  if (!Number.isFinite(read) || read < TRAVELDESK_MIN_READ_TIMEOUT_MS || read > TRAVELDESK_MAX_READ_TIMEOUT_MS) {
    problems.push(`TRAVELDESK_READ_TIMEOUT_MS must be between ${TRAVELDESK_MIN_READ_TIMEOUT_MS} and ${TRAVELDESK_MAX_READ_TIMEOUT_MS}`);
  }
  const mutation = env.TRAVELDESK_TIMEOUT_MS ?? 150_000;
  if (!Number.isFinite(mutation) || mutation < TRAVELDESK_MIN_MUTATION_TIMEOUT_MS || mutation > TRAVELDESK_MAX_MUTATION_TIMEOUT_MS) {
    problems.push(`TRAVELDESK_TIMEOUT_MS must be between ${TRAVELDESK_MIN_MUTATION_TIMEOUT_MS} and ${TRAVELDESK_MAX_MUTATION_TIMEOUT_MS}`);
  }
  return problems;
}

/** Null unless mode is `live` and every check passes. Never partially configured. */
export function traveldeskConfigFrom(env: TravelDeskEnvSlice): TravelDeskConfig | null {
  if (env.SUPPLIER_ADAPTER_TRAVELDESK !== "live") return null;
  if (traveldeskConfigProblems(env).length > 0) return null;
  const environment = env.TRAVELDESK_ENV as TravelDeskEnvironment;
  return {
    environment,
    baseUrl: expectedBaseUrl(environment),
    host: TRAVELDESK_HOSTS[environment],
    apiKey: env.TRAVELDESK_API_KEY as string,
    mutationTimeoutMs: env.TRAVELDESK_TIMEOUT_MS ?? 150_000,
    readTimeoutMs: env.TRAVELDESK_READ_TIMEOUT_MS ?? 20_000,
    bookingsEnabled: env.TRAVELDESK_BOOKINGS_ENABLED === true,
    agencyId: pinnedAgencyId(env),
  };
}

/** TRAVELDESK_AGENCY_ID as a canonical decimal string; null when unset or not a positive integer. */
export function pinnedAgencyId(env: Pick<TravelDeskEnvSlice, "TRAVELDESK_AGENCY_ID">): string | null {
  const raw = env.TRAVELDESK_AGENCY_ID;
  if (raw === undefined || raw === null || raw === "") return null;
  const s = String(raw).trim();
  return /^[1-9]\d{0,15}$/.test(s) ? s : null;
}

/**
 * Config for the LOCAL read-only probe against PRODUCTION catalogue data
 * (approved 27 Oct 2026: catalogue, availability and prices only; no bookings,
 * no cancellations). It is the one place where a production TravelDesk key may
 * be used outside `APP_ENV=production`, and it can only exist with bookings
 * off: the read client has no mutation method, and
 * `assertTravelDeskMutationAllowed` refuses any config without bookings enabled.
 *
 * The app itself never calls this: the registry uses `traveldeskConfigFrom`,
 * which keeps the APP_ENV pairing, so a dev server cannot pick up a
 * production key.
 */
export function traveldeskProductionReadOnlyConfigFrom(env: TravelDeskEnvSlice): TravelDeskConfig | { problems: string[] } {
  const problems: string[] = [];
  if (env.TRAVELDESK_ENV !== "production") problems.push("TRAVELDESK_ENV must be 'production' for the production read-only probe");
  if (env.TRAVELDESK_BOOKINGS_ENABLED) problems.push("TRAVELDESK_BOOKINGS_ENABLED must be false for a read-only probe");
  if (env.APP_ENV === "production") problems.push("the production read-only probe runs locally only, never with APP_ENV=production");
  // Reuse every other check by validating as if paired with APP_ENV=production.
  for (const p of traveldeskConfigProblems({ ...env, APP_ENV: "production" })) problems.push(p);
  if (problems.length) return { problems };
  return {
    environment: "production",
    baseUrl: expectedBaseUrl("production"),
    host: TRAVELDESK_HOSTS.production,
    apiKey: env.TRAVELDESK_API_KEY as string,
    mutationTimeoutMs: env.TRAVELDESK_TIMEOUT_MS ?? 150_000,
    readTimeoutMs: env.TRAVELDESK_READ_TIMEOUT_MS ?? 20_000,
    bookingsEnabled: false,
  };
}

/** For /api/health-style diagnostics. Never returns secrets. */
export function traveldeskMode(env: TravelDeskEnvSlice): TravelDeskMode {
  if (env.SUPPLIER_ADAPTER_TRAVELDESK !== "live") return "mock";
  return traveldeskConfigFrom(env) ? "live" : "live_unconfigured";
}

/**
 * The single gate every future booking mutation (reserve, confirm, create,
 * cancel) must pass before any request is built. Stage 1 has no mutation
 * callers at all; this exists so Stage 2 cannot forget it.
 *
 * Every mutation needs `TRAVELDESK_BOOKINGS_ENABLED=true`. Production also
 * needs the agency pinned (`TRAVELDESK_AGENCY_ID`): the booking engine then
 * refuses, before each send, a key whose `/balance` agency differs (SUP-10,
 * supplier-booking.service accountMismatch), so a production booking can only
 * reach the agreed account. A production config itself can
 * only exist with `APP_ENV=production` (`traveldeskConfigProblems`), and the
 * local read-only probe config always has bookings off. Production activation
 * (decision G) was approved by the owner on 18 Nov 2026 (doc 22 §32.46).
 *
 * Returns why mutations are refused, or null when they are allowed. The same
 * answer gates the instant switch (`TravelDeskLiveAdapter.capabilities`), so a
 * product can only go instant where bookings can actually be made.
 */
export function travelDeskMutationRefusal(config: TravelDeskConfig | null): string | null {
  if (!config) return "TravelDesk is not configured";
  if (!config.bookingsEnabled) return "TravelDesk booking mutations are disabled (TRAVELDESK_BOOKINGS_ENABLED is not true)";
  if (config.environment === "production" && !config.agencyId) return "TravelDesk production booking mutations need the agency pinned (TRAVELDESK_AGENCY_ID)";
  return null;
}

export function assertTravelDeskMutationAllowed(config: TravelDeskConfig | null): void {
  const refusal = travelDeskMutationRefusal(config);
  if (refusal) throw new Error(refusal);
}
