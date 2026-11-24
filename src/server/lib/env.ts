import "server-only";
import { z } from "zod";
import { stripeConfigProblems } from "../payments/stripe/stripe.config";
import { traveldeskConfigProblems } from "../suppliers/traveldesk/traveldesk.config";
import { crmConfigProblems, crmScopeProblems } from "../crm/crm.config";
import { keyRingProblems } from "./crypto";
import { log } from "./logger";

/**
 * Environment — validated once, read everywhere through `env()`.
 *
 * Rules (docs/backend/13-security.md §9, 14-deployment.md §1):
 *  - Only variables the Inquiry Mode backend genuinely reads are declared here.
 *    Deferred integrations (Rathin, Razorpay API, BSP, Meta, PostHog, Redis)
 *    are declared optional so their absence selects the log/mock adapter and
 *    never blocks boot.
 *  - Secrets are asserted present at boot in production (`assertBootEnv`) so a
 *    misconfigured deploy fails loudly, not at the first customer request.
 *  - Nothing here is ever logged. `logger.ts` redacts these keys by name.
 */

const bool = z
  .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0"), z.literal("")])
  .optional()
  .transform((v) => v === "true" || v === "1");

/** Release switches already warned about, so a bad value is logged once per process. */
const warnedSwitches = new Set<string>();

/**
 * Strict flag for release switches: only the exact string "true" turns it on.
 * Unset, empty or "false" ⇒ false. Any other value ("1", "yes", "TRUE") is
 * also false, with a one-time warning: a typo closes the switch, never the
 * whole app (review CR-12).
 */
const strictBool = (name: string) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === "true") return true;
      if (v !== undefined && v !== "" && v !== "false" && !warnedSwitches.has(name)) {
        warnedSwitches.add(name);
        log.warn("env.release_switch_invalid", { variable: name, expected: "true or false", treatedAs: false });
      }
      return false;
    });

/** Tri-state flag: unset/empty ⇒ `undefined` (no override), otherwise a boolean. */
const optionalBool = z
  .union([z.literal("true"), z.literal("false"), z.literal("1"), z.literal("0"), z.literal("")])
  .optional()
  .transform((v) => (v === undefined || v === "" ? undefined : v === "true" || v === "1"));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int().nonnegative());

const optionalStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_ENV: z.enum(["development", "staging", "production"]).default("development"),
  /** Set by Vercel on every deployment ("production", "preview", "development"); unset elsewhere. */
  VERCEL_ENV: optionalStr,
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),
  /** Extra origins allowed to send cookie-authenticated mutations (comma-separated), e.g. a staging host. */
  APP_ALLOWED_ORIGINS: csv,
  NEXT_PUBLIC_WHATSAPP_NUMBER: optionalStr,
  NEXT_PUBLIC_SUPPORT_EMAIL: optionalStr,

  // Database
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: optionalStr,

  // Auth — admin + agents (§13.2.2) and customer phone OTP (§13.2.1, impl/customer-auth-contract.md)
  AUTH_JWT_SECRET: z.string().min(32),
  AUTH_COOKIE_SECRET: z.string().min(32),
  TOTP_ENCRYPTION_KEY: optionalStr,
  // TEMPORARY (recheck P3-2): the AUTH_JWT_SECRET value the old code derived the TOTP key from.
  // Lets each admin's secret be re-wrapped under TOTP_ENCRYPTION_KEY at their next sign-in. Remove once all have signed in.
  TOTP_LEGACY_ENCRYPTION_SECRET: optionalStr,
  ADMIN_BOOTSTRAP_EMAIL: optionalStr,
  ADMIN_BOOTSTRAP_PASSWORD: optionalStr,
  AUTH_ADMIN_SESSION_HOURS: int(8),
  AUTH_CUSTOMER_SESSION_DAYS: int(30),
  OTP_TTL_SECONDS: int(300),
  OTP_MAX_ATTEMPTS: int(5),
  OTP_RATE_LIMIT_PER_PHONE_PER_15MIN: int(3),
  OTP_RATE_LIMIT_PER_IP_PER_HOUR: int(10),

  // SMS — OTP delivery port. `log` writes the code to the server log in non-production only;
  // `msg91` needs every MSG91_* value below (DLT-registered OTP template);
  // `msg91_widget` needs MSG91_AUTH_KEY plus the two NEXT_PUBLIC_MSG91_WIDGET_* values
  // and carries no DLT template of its own — MSG91 owns the template and the code.
  SMS_PROVIDER: z.enum(["log", "msg91", "msg91_widget"]).default("log"),
  MSG91_AUTH_KEY: optionalStr,
  MSG91_SENDER_ID: optionalStr,
  MSG91_TEMPLATE_ID_OTP: optionalStr,
  MSG91_DLT_ENTITY_ID: optionalStr,
  /// Widget id and client token are public by design: they ship in the page's JS.
  /// They are safe to expose ONLY while the widget's domain allowlist is set in
  /// the MSG91 dashboard — without it, anyone can replay them and spend your credits.
  NEXT_PUBLIC_MSG91_WIDGET_ID: optionalStr,
  NEXT_PUBLIC_MSG91_WIDGET_TOKEN: optionalStr,

  // Email — Resend (ACTIVE, narrow scope). Absent key → log adapter.
  RESEND_API_KEY: optionalStr,
  EMAIL_FROM_TRANSACTIONAL: optionalStr,
  EMAIL_REPLY_TO: optionalStr,
  /** Preflight audit name (§18 §1.3); `OPS_ALERT_EMAIL` accepted as alias. */
  EMAIL_OPS_ALERT_TO: csv,
  OPS_ALERT_EMAIL: csv,
  EMAIL_CATCH_ALL: optionalStr,
  /** Non-production recipient allowlist — the guard that stops staging messaging real customers. */
  NOTIFICATION_RECIPIENT_ALLOWLIST: csv,
  NOTIFY_ALLOWLIST: csv,

  // WhatsApp — click-to-chat needs nothing; the BSP adapter is DEFERRED.
  WHATSAPP_PROVIDER: z.enum(["log", "cloud_api"]).default("log"),
  WHATSAPP_API_BASE_URL: optionalStr,
  WHATSAPP_API_TOKEN: optionalStr,
  WHATSAPP_PHONE_NUMBER_ID: optionalStr,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: optionalStr,
  WHATSAPP_WEBHOOK_SECRET: optionalStr,
  WHATSAPP_TEMPLATE_INQUIRY_ACK: z.string().default("inquiry_ack_v1"),
  WHATSAPP_TEMPLATE_INQUIRY_FOLLOWUP: z.string().default("inquiry_followup_v1"),
  WHATSAPP_TEMPLATE_INQUIRY_OPS_ALERT: z.string().default("inquiry_ops_alert_v1"),
  WHATSAPP_OPS_ALERT_NUMBER: optionalStr,

  // Analytics destinations — all DEFERRED; our own collector is the source of truth.
  NEXT_PUBLIC_META_PIXEL_ID: optionalStr,
  META_DATASET_ID: optionalStr,
  META_CAPI_ACCESS_TOKEN: optionalStr,
  META_CAPI_TEST_EVENT_CODE: optionalStr,
  META_OFFLINE_EVENT_SET_ID: optionalStr,
  NEXT_PUBLIC_POSTHOG_KEY: optionalStr,
  NEXT_PUBLIC_POSTHOG_HOST: optionalStr,
  GA4_API_SECRET: optionalStr,
  /** Canonical GA4 id; read through gaMeasurementId() (src/lib/ga-config.ts). */
  NEXT_PUBLIC_GA_MEASUREMENT_ID: optionalStr,
  /** Deprecated name for the same id: read only as gaMeasurementId()'s fallback. */
  NEXT_PUBLIC_GA4_MEASUREMENT_ID: optionalStr,

  // Supplier — Rathin NOT READY (§16). Adapter selection only.
  SUPPLIER_ADAPTER_RATHIN: z.enum(["mock", "live"]).default("mock"),
  RATHIN_BASE_URL: optionalStr,
  RATHIN_CLIENT_ID: optionalStr,
  RATHIN_CLIENT_SECRET: optionalStr,
  RATHIN_AGENCY_ID: optionalStr,
  RATHIN_TIMEOUT_MS: int(8000),

  // Supplier — TravelDesk (docs/backend/21). Booking mutations need
  // TRAVELDESK_BOOKINGS_ENABLED, and in production TRAVELDESK_AGENCY_ID too
  // (travelDeskMutationRefusal). The host,
  // environment and APP_ENV pairing is validated in traveldesk.config.ts.
  SUPPLIER_ADAPTER_TRAVELDESK: z.enum(["mock", "live"]).default("mock"),
  TRAVELDESK_ENV: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["test", "production"]).optional()),
  TRAVELDESK_API_BASE_URL: optionalStr,
  TRAVELDESK_API_KEY: optionalStr,
  /** Reserve / confirm / create budget. TravelDesk requires at least 120 s. */
  TRAVELDESK_TIMEOUT_MS: int(150_000),
  /** Catalogue, availability, balance. */
  TRAVELDESK_READ_TIMEOUT_MS: int(20_000),
  /** Default off. Production mutations also need TRAVELDESK_AGENCY_ID (travelDeskMutationRefusal). Keep production TravelDesk values in Vercel's Production scope only. */
  TRAVELDESK_BOOKINGS_ENABLED: bool,
  // Pinned agency id for this environment's key (SUP-10). A different agency on /balance refuses mutations.
  TRAVELDESK_AGENCY_ID: optionalStr,
  /**
   * Environment release switch for instant activation (doc 22 B0, PRD-2).
   * While false, no product can be switched to instant fulfilment, whatever
   * its supplier mapping says. Only "true" enables it; anything else is false.
   */
  INSTANT_RELEASE_ENABLED: strictBool("INSTANT_RELEASE_ENABLED"),
  /**
   * Release switch for the guest same-browser voucher download (checkout
   * redesign batch 3, CO-02): a 24-hour `download_tickets` grant issued at
   * checkout to the guest browser that made the quote and verified the
   * order's contact. While false, no such grant is issued and none already
   * issued is honoured; documents, email links, recovery, signed-in owners
   * and staff are unaffected. Only "true" enables it; default off everywhere.
   */
  GUEST_DOWNLOAD_GRANT_ENABLED: strictBool("GUEST_DOWNLOAD_GRANT_ENABLED"),
  /**
   * Release switch for the scheduled booking jobs (checkout redesign batch 4,
   * review fix 4; pilot-day A10): the cron GETs of `/api/jobs/booking-tick`,
   * `/api/jobs/documents-tick` and `/api/jobs/supplier-reconcile`. While
   * false they answer `skipped` after the cron-secret check and touch no
   * data, so deploying the crons changes nothing until the owner turns this
   * on after the migrations (A8). Manual POSTs and the older crons are
   * unaffected. Only "true" enables it; default off everywhere.
   *
   * Not an emergency stop: once live, turning it off also stops webhook
   * processing, sagas, refunds and voucher downloads. Stop sales with the
   * supplier control row (`new_sales` / `all_writes`) and
   * INSTANT_RELEASE_ENABLED=false (doc 28 §7).
   */
  SCHEDULED_BOOKING_JOBS_ENABLED: strictBool("SCHEDULED_BOOKING_JOBS_ENABLED"),
  /**
   * How long that grant lives after the order-bound verification, in whole
   * hours. Default 24; any value is bounded to 1–24 where it is used
   * (`checkoutGrantMs`); an unreadable value reads as 24 rather than
   * failing the whole environment. Fixed per grant at issue; changing it
   * never extends a grant already issued.
   */
  GUEST_DOWNLOAD_GRANT_HOURS: z
    .string()
    .optional()
    .transform((v) => {
      const n = Number.parseInt((v ?? "").trim(), 10);
      return Number.isFinite(n) ? n : 24;
    }),

  // Security / abuse (§17 §9)
  /** Scheduled jobs only (Vercel Cron). Never unlocks health detail or manual supplier runs (SEC-8). */
  CRON_SECRET: optionalStr,
  /** Manual supplier job runs (`requireJobSecret`). Unset ⇒ manual runs refused. */
  SUPPLIER_JOB_SECRET: optionalStr,
  /** Bearer token for the health warning texts. Unset ⇒ nobody sees them. */
  HEALTH_DETAIL_TOKEN: optionalStr,
  INTERNAL_API_KEY: optionalStr,
  TURNSTILE_SECRET_KEY: optionalStr,
  INQUIRY_MIN_SUBMIT_SECONDS: int(2),
  INQUIRY_RATE_LIMIT_PER_PHONE_PER_HOUR: int(3),
  INQUIRY_RATE_LIMIT_PER_IP_PER_HOUR: int(10),
  LOOKUP_RATE_LIMIT_PER_IP: int(5),
  LOOKUP_RATE_LIMIT_WINDOW_SECONDS: int(900),
  EVENTS_RATE_LIMIT_PER_HOUR: int(1000),
  ADMIN_LOGIN_RATE_LIMIT_PER_15MIN: int(5),

  // Ops defaults — seeded into `settings` and admin-editable thereafter (§17 §6.4)
  SLA_INQUIRY_RESPONSE_MINUTES: int(30),
  SLA_BUSINESS_HOURS_START: z.string().default("10:00"),
  SLA_BUSINESS_HOURS_END: z.string().default("18:00"),
  /** Comma-separated 0–6 (0 = Sunday). The team works Mon–Sat. */
  SLA_BUSINESS_DAYS: z.string().default("1,2,3,4,5,6"),
  SLA_TIMEZONE: z.string().default("Asia/Dubai"),
  SLA_ESCALATION_MINUTES: int(30),
  ROUTING_PREMIUM_THRESHOLD_INR: int(100000),
  ROUTING_GROUP_THRESHOLD_PAX: int(5),
  AGENT_MAX_CONCURRENT_INQUIRIES: int(15),
  FOLLOWUP_LADDER_HOURS: z.string().default("2,24,72,168"),
  PRICE_TOLERANCE_PERCENT: int(5),
  /**
   * Plausible band for the live INR-per-AED refresh (src/server/domain/fx.ts),
   * two-place decimals. Unset ⇒ 15.00–40.00. A malformed pair, or min ≥ max,
   * makes the refresh refuse to write (the stored rate then lapses to inquiry).
   */
  FX_BAND_MIN_INR_PER_AED: optionalStr,
  FX_BAND_MAX_INR_PER_AED: optionalStr,
  OPS_ALERT_WEBHOOK_URL: optionalStr,

  // Feature flags (env-level; DB `feature_flags` overrides at runtime)
  FEATURE_DESIGN_SYSTEM_PAGE: bool,
  FEATURE_MAINTENANCE_MODE: bool,
  /** Optional override for customer sign-in. Unset ⇒ enabled outside production, or when a real SMS provider is configured. */
  FEATURE_CUSTOMER_AUTH: optionalBool,
  /**
   * Require a verified phone before an inquiry can be created.
   *
   * Off by default, and off in production at the time of writing, because the
   * MSG91 OTP widget cannot currently deliver an access token: its bundle
   * references an undeclared `TraceIQ` global on the verify-success path and
   * throws before our callback runs. Gating inquiries on a flow that cannot
   * complete loses every guest lead, so the gate stays shut until that is
   * fixed upstream.
   *
   * The server is the only authority here. The storefront does not read a flag
   * of its own — it submits, and opens the code step only if the API answers
   * VERIFICATION_REQUIRED. So flipping this one value changes both halves and
   * the two can never disagree.
   */
  FEATURE_VERIFIED_INQUIRIES: optionalBool,

  // Supplier documents (doc 21 §9.1, doc 22 B4): a private Supabase Storage
  // bucket reached through its S3-compatible endpoint with server-only keys.
  // Unset ⇒ no document store: documents stay pending and nothing is served.
  // `memory` is for tests and local development only and is refused in production.
  SUPPLIER_DOCS_STORE: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["memory", "supabase_s3"]).optional()),
  SUPPLIER_DOCS_S3_ENDPOINT: optionalStr,
  SUPPLIER_DOCS_S3_REGION: optionalStr,
  SUPPLIER_DOCS_S3_ACCESS_KEY_ID: optionalStr,
  SUPPLIER_DOCS_S3_SECRET_ACCESS_KEY: optionalStr,
  SUPPLIER_DOCS_BUCKET: optionalStr,

  // Payments — Stripe (doc 22 §32.11). Hosted Checkout, so no publishable
  // key is declared. Unset ⇒ off. Mode, key, mode/APP_ENV pairing, webhook
  // secret, account id and rails are validated in
  // src/server/payments/stripe/stripe.config.ts; any problem means no Stripe
  // gateway at all (never half-configured). Values are read here as plain
  // strings so a typo refuses Stripe, never the whole app.
  /** `off` (default), `test` or `live`. */
  PAYMENTS_STRIPE: optionalStr,
  STRIPE_SECRET_KEY: optionalStr,
  STRIPE_WEBHOOK_SECRET: optionalStr,
  /** The `acct_` id the key must answer for (checked against `GET /v1/account`). */
  STRIPE_ACCOUNT_ID: optionalStr,
  /** Comma list of rails served by the one Stripe account: `aed_card`, `inr_pacb`. Default `aed_card`. */
  STRIPE_RAILS: optionalStr,

  // CRM — Bitrix24 one-way push (doc 29 §5, §6.4; CRM batches C1, C2a; doc
  // 29d). Validated in src/server/crm/crm.config.ts. No portal host ⇒ nothing
  // is enqueued; a portal host without CRM_SYNC_ENABLED=true ⇒ no new subject
  // is queued (no backfill) and nothing is sent; only subjects already pushed
  // while the sync was on keep queueing. Keep production CRM values in
  // Vercel's Production scope only.
  /**
   * Release switch for CRM delivery (`/api/jobs/crm-worker`). While false the
   * worker answers `skipped` and calls nothing. Only "true" enables it;
   * default off everywhere. Not an emergency stop for anything else: checkout
   * never depends on the CRM.
   */
  CRM_SYNC_ENABLED: strictBool("CRM_SYNC_ENABLED"),
  /** `test` or `production`; production only with APP_ENV=production on Vercel's production deployment. */
  CRM_BITRIX_ENV: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["test", "production"]).optional()),
  /** Pinned portal host, e.g. `<portal>.bitrix24.in` (no scheme, path or port). */
  CRM_BITRIX_PORTAL_HOST: optionalStr,
  /** Inbound webhook of the dedicated non-admin service user (owner decision 15): its numeric user id and secret. */
  CRM_BITRIX_WEBHOOK_USER_ID: optionalStr,
  CRM_BITRIX_WEBHOOK_SECRET: optionalStr,
  /** The OUTLYY deal funnel id (never 0, the other business's funnel). */
  CRM_BITRIX_DEAL_CATEGORY_ID: optionalStr,
  /** `stage_key=C<category>:<STATUS_ID>` pairs for the 12 OUTLYY stages (crm.config.ts CRM_STAGE_KEYS). */
  CRM_BITRIX_STAGE_IDS: optionalStr,
  /** `field_key=UF_CRM_…` pairs for the 20 OUTLYY custom deal fields (crm.config.ts CRM_FIELD_KEYS). */
  CRM_BITRIX_FIELD_CODES: optionalStr,
  /** Bitrix24 user id of the Dubai sales lead who owns every new deal (decision C2-8). */
  CRM_BITRIX_DEFAULT_OWNER_ID: optionalStr,
  /** The synthetic probe's own secret (doc 29d §5.2a; SEC-8), at least 32 characters. Unset ⇒ the probe is refused. */
  CRM_PROBE_SECRET: optionalStr,
  CRM_BITRIX_TIMEOUT_MS: int(5_000),

  // Photography — Pexels search for any catalogue image without a curated id (src/lib/images/manifest.ts).
  PEXELS_API_KEY: optionalStr,

  SENTRY_DSN: optionalStr,
});

export type Env = z.infer<typeof schema> & {
  opsAlertEmails: string[];
  /** Names (never values) of browser-exposed variables that look like a Stripe secret; any one refuses Stripe. */
  stripePublicSecretNames: string[];
  recipientAllowlist: string[];
  followupLadderHours: number[];
  isProduction: boolean;
  isNonProduction: boolean;
};

let cached: Env | null = null;

/** `NEXT_PUBLIC_*STRIPE*SECRET*`: a Stripe secret on its way to the browser. */
function publicStripeSecretNames(): string[] {
  return Object.keys(process.env).filter((k) => /^NEXT_PUBLIC_.*STRIPE.*SECRET/i.test(k));
}

/** Lazily validated so `next build` never needs a full runtime environment. */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  const e = parsed.data;
  cached = {
    ...e,
    stripePublicSecretNames: publicStripeSecretNames(),
    opsAlertEmails: e.EMAIL_OPS_ALERT_TO.length ? e.EMAIL_OPS_ALERT_TO : e.OPS_ALERT_EMAIL,
    recipientAllowlist: e.NOTIFICATION_RECIPIENT_ALLOWLIST.length
      ? e.NOTIFICATION_RECIPIENT_ALLOWLIST
      : e.NOTIFY_ALLOWLIST,
    followupLadderHours: e.FOLLOWUP_LADDER_HOURS.split(",")
      .map((s) => Number.parseFloat(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    isProduction: e.APP_ENV === "production",
    isNonProduction: e.APP_ENV !== "production",
  };
  return cached;
}

/**
 * Production boot assertions — things that must never be missing where real
 * customers exist. Called from the health check and the admin layout so a bad
 * deploy is visible within one request.
 */
export function assertBootEnv(): string[] {
  const e = env();
  const problems: string[] = [];
  if (!e.NEXT_PUBLIC_WHATSAPP_NUMBER) problems.push("NEXT_PUBLIC_WHATSAPP_NUMBER missing — click-to-chat CTAs are dead");
  if (e.isProduction) {
    if (!e.CRON_SECRET) problems.push("CRON_SECRET missing — scheduled jobs disabled");
    if (!e.RESEND_API_KEY) problems.push("RESEND_API_KEY missing — email acknowledgements will only be logged");
    if (!e.EMAIL_FROM_TRANSACTIONAL) problems.push("EMAIL_FROM_TRANSACTIONAL missing");
    if (!e.opsAlertEmails.length) problems.push("EMAIL_OPS_ALERT_TO missing — nobody is alerted to new inquiries");
    if (!e.TOTP_ENCRYPTION_KEY) problems.push("TOTP_ENCRYPTION_KEY missing — admin MFA secrets cannot be encrypted or read (no derived fallback in production)");
    // PRV-5: every purpose key ring must be set explicitly in production.
    for (const p of keyRingProblems()) problems.push(p);
    if (e.SUPPLIER_DOCS_STORE === "memory") problems.push("SUPPLIER_DOCS_STORE=memory in production — documents would not survive a restart");
  } else if (!e.recipientAllowlist.length && e.RESEND_API_KEY) {
    problems.push("Non-production with a live RESEND_API_KEY and an empty recipient allowlist — nothing will send");
  }
  // SEC-8: each secret authorises one thing. A shared value would let the cron
  // secret unlock health detail or manual supplier runs.
  if (e.CRON_SECRET && e.SUPPLIER_JOB_SECRET === e.CRON_SECRET) problems.push("SUPPLIER_JOB_SECRET equals CRON_SECRET — set a distinct value");
  if (e.CRON_SECRET && e.HEALTH_DETAIL_TOKEN === e.CRON_SECRET) problems.push("HEALTH_DETAIL_TOKEN equals CRON_SECRET — set a distinct value");
  if (e.SUPPLIER_JOB_SECRET && e.HEALTH_DETAIL_TOKEN === e.SUPPLIER_JOB_SECRET) problems.push("HEALTH_DETAIL_TOKEN equals SUPPLIER_JOB_SECRET — set a distinct value");
  if (e.CRM_PROBE_SECRET && [e.CRON_SECRET, e.SUPPLIER_JOB_SECRET, e.HEALTH_DETAIL_TOKEN].includes(e.CRM_PROBE_SECRET)) problems.push("CRM_PROBE_SECRET equals another job secret — set a distinct value");
  if (e.SUPPLIER_ADAPTER_TRAVELDESK === "live") {
    for (const p of traveldeskConfigProblems(e)) problems.push(`TravelDesk live but unusable: ${p}`);
  }
  for (const p of stripeConfigProblems(e)) problems.push(`Stripe refused: ${p}`);
  if (e.CRM_SYNC_ENABLED) {
    for (const p of crmConfigProblems(e)) problems.push(`CRM sync on but unusable: ${p}`);
  } else if (e.CRM_BITRIX_PORTAL_HOST) {
    const scope = crmScopeProblems(e);
    for (const p of scope) problems.push(`CRM portal refused, nothing is enqueued: ${p}`);
    // Review C2A-04: show before switch-on what would keep the sync from running once it is on.
    for (const p of crmConfigProblems(e)) if (!scope.includes(p)) problems.push(`CRM not ready for switch-on: ${p}`);
  }
  if (Object.keys(process.env).some((k) => k.startsWith("NEXT_PUBLIC_") && (k.includes("BITRIX") || k.includes("CRM_")))) {
    problems.push("A NEXT_PUBLIC_*BITRIX* or NEXT_PUBLIC_*CRM_* variable exists — CRM settings must never reach the browser");
  }
  if (Object.keys(process.env).some((k) => k.startsWith("NEXT_PUBLIC_") && k.includes("TRAVELDESK"))) {
    problems.push("A NEXT_PUBLIC_*TRAVELDESK* variable exists — TravelDesk settings must never reach the browser");
  }
  return problems;
}

/** Test/seed helper. */
export function resetEnvCache() {
  cached = null;
  warnedSwitches.clear();
}
