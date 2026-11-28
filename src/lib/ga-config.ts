/**
 * The Google Analytics 4 measurement id, under one name (doc 29 Batch 1c, D4
 * in docs/backend/29b-investigation-notes/50-security-reliability.md).
 *
 * Two names were in use for the same id: the head tag (src/app/layout.tsx)
 * and the CSP (src/proxy.ts) read `NEXT_PUBLIC_GA_MEASUREMENT_ID`, while env
 * validation and the server forwarder read `NEXT_PUBLIC_GA4_MEASUREMENT_ID`.
 * A deploy that set only one of them got a tag without its CSP origins, or
 * the reverse.
 *
 * Canonical: `NEXT_PUBLIC_GA_MEASUREMENT_ID`. `NEXT_PUBLIC_GA4_MEASUREMENT_ID`
 * is still read as a fallback, with one warning per server process, so a
 * deploy that set only the old name keeps working until it is renamed. Every
 * reader goes through `gaMeasurementId()`, so the tag, the CSP and the
 * forwarder can no longer disagree.
 *
 * A value that is not a GA4 id (`G-` and letters or digits) counts as unset,
 * so the `G-` placeholder once shipped in `.env.example` cannot turn on a
 * broken tag. The id is public (it ships in the page); it is never logged.
 *
 * The two env names are written out literally below so Next.js can inline
 * them wherever this runs.
 */

const GA4_ID = /^G-[A-Z0-9]{4,20}$/i;

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t && GA4_ID.test(t) ? t : undefined;
}

let warnedLegacy = false;

function warnLegacyOnce(): void {
  if (warnedLegacy || typeof window !== "undefined") return;
  warnedLegacy = true;
  console.warn(
    JSON.stringify({ level: "warn", msg: "analytics.legacy_env_name", detail: "NEXT_PUBLIC_GA4_MEASUREMENT_ID is deprecated; set NEXT_PUBLIC_GA_MEASUREMENT_ID instead" }),
  );
}

/** The id from the canonical name, else from the legacy one (warning once); undefined when neither holds a GA4 id. Exported for tests. */
export function resolveGaMeasurementId(canonical: string | undefined, legacy: string | undefined, onLegacy: () => void = warnLegacyOnce): string | undefined {
  const id = clean(canonical);
  if (id) return id;
  const old = clean(legacy);
  if (old) onLegacy();
  return old;
}

export function gaMeasurementId(): string | undefined {
  return resolveGaMeasurementId(process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID, process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID);
}

/** For tests: forget that the legacy warning was written. */
export function resetGaConfigWarning(): void {
  warnedLegacy = false;
}
