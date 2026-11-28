import type { PaymentRail } from "../contracts";

/**
 * Stripe configuration: env slice → validated config, or the reasons it is
 * refused (doc 22 §32.11). Pure: env is a parameter (the supplier registry
 * convention); nothing in `src/server/payments/**` reads `process.env`.
 *
 * Guard rails:
 *  - `PAYMENTS_STRIPE` is `off` (default), `test` or `live`. Any other value
 *    is a problem, and a problem means no Stripe gateway at all: the provider
 *    is never half-configured.
 *  - `test` needs a test-mode key (`sk_test_` or `rk_test_`) and is refused
 *    with `APP_ENV=production`: test-mode money must never let a production
 *    order spend at the supplier.
 *  - `live` needs a live key (`sk_live_` or `rk_live_`) AND
 *    `APP_ENV=production`. A local or staging app can never hold live money.
 *  - The webhook secret (`whsec_`), the account id (`acct_`) and the rails
 *    are required. One Stripe account and one webhook endpoint serve every
 *    configured rail (owner decision, 3 November 2026).
 *  - No `NEXT_PUBLIC_*STRIPE*SECRET*` variable may exist. Hosted Checkout
 *    needs no publishable key, so none is declared.
 *
 * Problem messages never contain a key or secret value.
 */

export const STRIPE_RAILS_ALLOWED: readonly PaymentRail[] = ["aed_card", "inr_pacb"];
export const STRIPE_DEFAULT_RAILS: readonly PaymentRail[] = ["aed_card"];

/** Client request timeout. The saga owns retries; one slow call must not hold a job run. */
export const STRIPE_TIMEOUT_MS = 20_000;

export type StripeMode = "off" | "test" | "live";

/** The env slice Stripe needs. `Env` from `src/server/lib/env.ts` satisfies it. */
export interface StripeEnvSlice {
  APP_ENV?: "development" | "staging" | "production";
  PAYMENTS_STRIPE?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_ACCOUNT_ID?: string;
  /** Comma list of rails (`aed_card`, `inr_pacb`); default `aed_card`. */
  STRIPE_RAILS?: string;
  /** Names (never values) of browser-exposed variables that look like a Stripe secret. */
  stripePublicSecretNames?: readonly string[];
}

export interface StripeConfig {
  mode: "test" | "live";
  /** Derived from the key prefix, and checked against `mode` and `APP_ENV`. */
  environment: "test" | "production";
  secretKey: string;
  webhookSecret: string;
  accountId: string;
  rails: readonly PaymentRail[];
  timeoutMs: number;
}

function modeOf(env: StripeEnvSlice): StripeMode | null {
  const raw = env.PAYMENTS_STRIPE?.trim();
  if (raw === undefined || raw === "") return "off";
  return raw === "off" || raw === "test" || raw === "live" ? raw : null;
}

/** The configured rails, or null when the list is malformed. */
export function stripeRails(env: Pick<StripeEnvSlice, "STRIPE_RAILS">): PaymentRail[] | null {
  const raw = env.STRIPE_RAILS?.trim();
  if (raw === undefined || raw === "") return [...STRIPE_DEFAULT_RAILS];
  const parts = raw.split(",").map((s) => s.trim());
  if (parts.some((p) => !(STRIPE_RAILS_ALLOWED as readonly string[]).includes(p))) return null;
  if (new Set(parts).size !== parts.length) return null;
  return parts as PaymentRail[];
}

function keyEnvironment(key: string): "test" | "production" | null {
  if (/^(sk|rk)_test_[A-Za-z0-9_]+$/.test(key)) return "test";
  if (/^(sk|rk)_live_[A-Za-z0-9_]+$/.test(key)) return "production";
  return null;
}

/**
 * Every reason the Stripe configuration is refused. Empty ⇒ usable, or Stripe
 * is off. A browser-exposed Stripe secret is a problem even while off.
 */
export function stripeConfigProblems(env: StripeEnvSlice): string[] {
  const problems: string[] = [];
  for (const name of env.stripePublicSecretNames ?? []) {
    problems.push(`${name} exists: a Stripe secret must never reach the browser`);
  }
  const mode = modeOf(env);
  if (mode === null) {
    problems.push("PAYMENTS_STRIPE must be off, test or live");
    return problems;
  }
  if (mode === "off") return problems;

  const appEnv = env.APP_ENV ?? "development";
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) problems.push("STRIPE_SECRET_KEY is missing");
  else {
    const kind = keyEnvironment(key);
    if (kind === null) problems.push("STRIPE_SECRET_KEY must be a secret (sk_) or restricted (rk_) Stripe key");
    else if (mode === "test" && kind !== "test") problems.push("PAYMENTS_STRIPE=test requires an sk_test_ or rk_test_ key");
    else if (mode === "live" && kind !== "production") problems.push("PAYMENTS_STRIPE=live requires an sk_live_ or rk_live_ key");
  }
  if (mode === "live" && appEnv !== "production") problems.push("PAYMENTS_STRIPE=live is only allowed when APP_ENV=production");
  if (mode === "test" && appEnv === "production") problems.push("APP_ENV=production must not use Stripe test mode");

  const secret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) problems.push("STRIPE_WEBHOOK_SECRET is missing");
  else if (!/^whsec_[A-Za-z0-9_+/=]+$/.test(secret)) problems.push("STRIPE_WEBHOOK_SECRET must be a whsec_ signing secret");

  const account = env.STRIPE_ACCOUNT_ID?.trim();
  if (!account) problems.push("STRIPE_ACCOUNT_ID is missing");
  else if (!/^acct_[A-Za-z0-9]{1,64}$/.test(account)) problems.push("STRIPE_ACCOUNT_ID must be an acct_ id");

  if (stripeRails(env) === null) problems.push(`STRIPE_RAILS must be a comma list of distinct values from: ${STRIPE_RAILS_ALLOWED.join(", ")}`);
  return problems;
}

/** Null unless Stripe is on and every check passes. Never partially configured. */
export function stripeConfigFrom(env: StripeEnvSlice): StripeConfig | null {
  const mode = modeOf(env);
  if (mode === null || mode === "off") return null;
  if (stripeConfigProblems(env).length > 0) return null;
  const secretKey = env.STRIPE_SECRET_KEY!.trim();
  return {
    mode,
    environment: keyEnvironment(secretKey)!,
    secretKey,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET!.trim(),
    accountId: env.STRIPE_ACCOUNT_ID!.trim(),
    rails: stripeRails(env)!,
    timeoutMs: STRIPE_TIMEOUT_MS,
  };
}

/** For /api/health-style diagnostics. Never returns secrets. */
export function stripeMode(env: StripeEnvSlice): "off" | "test" | "live" | "unconfigured" {
  const mode = modeOf(env);
  if (mode === "off") return "off";
  if (mode === null) return "unconfigured";
  return stripeConfigFrom(env) ? mode : "unconfigured";
}
