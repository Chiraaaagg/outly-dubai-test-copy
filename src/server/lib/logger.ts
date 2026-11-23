import "server-only";

/**
 * Structured JSON logger with PII redaction at the logger (§13.7.2: "PII never
 * in logs"). Anything keyed like a phone, email, name, secret or token is
 * replaced before serialisation, so a careless `log.info("inquiry", inquiry)`
 * cannot leak.
 *
 * Sentry is DEFERRED; `log.error` is the single seam to add `captureException`.
 */

const REDACT_KEYS = [
  "phone",
  "leadphone",
  "phone_e164",
  "phonee164",
  "email",
  "leademail",
  "name",
  "fullname",
  "leadname",
  "lead_name",
  "hotel",
  // The pickup hotel name an order item keeps (Batch 3): `pickupHotelNameSnapshot`, `pickup_hotel_name_snapshot`.
  "hotelnamesnapshot",
  "hotel_name_snapshot",
  "specialrequests",
  "special_requests",
  "dietary",
  "password",
  "passwordhash",
  "password_hash",
  "secret",
  "token",
  "authorization",
  "cookie",
  "refreshhash",
  "totp",
  "totpsecretencrypted",
  "database_url",
  "direct_url",
  "api_key",
  "apikey",
  // Stripe env names and their camel-case forms (STRIPE_SECRET_KEY, secretKey, webhookSecret).
  "secret_key",
  "secretkey",
  "stripe_secret_key",
  "stripe_webhook_secret",
  "recipient",
  "otpauthuri",
  "temporarypassword",
  "clientip",
  "remoteaddr",
  "xforwardedfor",
  // Supplier, ticket and payment material (SEC-11): booking GUIDs, signed and
  // capability URLs, UPI ids (VPA), bank references (UTR) and guest details.
  // Bearer values and signatures are matched anywhere in the key, below.
  "guid",
  "url",
  "vpa",
  "utr",
  "capability",
  "guestname",
  "bookingcode",
  "confirmationcode",
  "redemptioncode",
  "qrcode",
  "barcode",
  // TravelDesk `downloadCodeLink` (OpenAPI, 22 Nov 2026): a public image URL that embeds the ticket code itself.
  "codelink",
];

/** Exact match only: as a suffix, `code` would also hide error and country codes. */
const REDACT_EXACT = ["code"];
/** Any key starting with these (`tickets`, `ticketPdf`, `voucherLink`, ...). */
const REDACT_PREFIXES = ["ticket", "voucher"];
/** Anywhere in the key (`x-hub-signature-256`, `bearerToken`); a boolean such as `signatureValid` stays readable. */
const REDACT_CONTAINS = ["signature", "bearer"];

function shouldRedact(key: string, value?: unknown) {
  const k = key.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return (
    REDACT_EXACT.includes(k) ||
    REDACT_KEYS.some((r) => k === r || k.endsWith(r)) ||
    REDACT_PREFIXES.some((p) => k.startsWith(p)) ||
    (typeof value !== "boolean" && REDACT_CONTAINS.some((c) => k.includes(c)))
  );
}

/** Nesting deeper than this is not walked; objects there are replaced, never passed through. */
const MAX_DEPTH = 6;

/**
 * Error texts are free-form, so key-based redaction cannot see into them:
 * Postgres constraint errors quote the offending row ("Failing row contains
 * (…, +9199…, Name, a@b.c …)") or key value, and wrapped provider errors can
 * carry addresses. Scrub those shapes from error messages, stacks and
 * error-like string fields before they are written.
 */
export function scrubText(text: string): string {
  return text
    // Query strings carry signed-URL tokens and voucher or ticket ids.
    .replace(/(\bhttps?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, "$1?[redacted]")
    // The whole row dump, to the end of its line: values may contain ")".
    .replace(/Failing row contains \(.*$/gm, "Failing row contains ([redacted])")
    .replace(/(Key \([^)]*\)=)\(.*?\)(?= already exists| is not present|\.|$)/gm, "$1([redacted])")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    // Phone-like runs: optional +, digits with spaces, dashes, dots or brackets
    // (+971 (50) 123 4567, 971.50.123.4567). Dates and ISO times are left alone.
    .replace(/(?<![\w.-])\+?\(?\d[\d\s().-]{7,18}\d(?![\w-])/g, (m) => (/^\d{4}-\d{2}-\d{2}/.test(m) || (m.replace(/\D/g, "").length < 9) ? m : "[number]"));
}

const ERROR_TEXT_KEYS = /(error|message|reason|detail|msg)s?$/i;

export function redact<T>(value: T, depth = 0): T {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return (typeof value === "object" ? "[truncated]" : value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (typeof value === "bigint") return value.toString() as unknown as T;
  if (value instanceof Date) return value.toISOString() as unknown as T;
  if (value instanceof Error) {
    return { name: value.name, message: scrubText(value.message), stack: value.stack ? scrubText(value.stack) : undefined } as unknown as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (shouldRedact(k, v)) out[k] = "[redacted]";
      else if (typeof v === "string" && ERROR_TEXT_KEYS.test(k)) out[k] = scrubText(v);
      else out[k] = redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (level === "debug" && process.env.NODE_ENV === "production") return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    msg,
    ...(fields ? redact(fields) : {}),
  });
  // eslint-disable-next-line no-console
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => {
    emit("error", msg, fields);
    // TODO(sentry): Sentry.captureException(fields?.error ?? new Error(msg)) once SENTRY_DSN is set (§18 §1.8).
  },
};
