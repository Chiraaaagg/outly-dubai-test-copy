import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The CSP builder and the GA4 id (doc 29 Batch 1c, D4):
 *
 *  - with a GA4 id configured, the storefront policy carries exactly the GA4
 *    hosts Google documents for gtag.js (script, img, connect), including
 *    `*.analytics.google.com`, and nothing for Signals or ads;
 *  - without an id, on private customer pages and on /admin, no Google host
 *    appears at all;
 *  - the other directives are unchanged by analytics;
 *  - one canonical env name, the old name read as a fallback with a single
 *    warning, and a placeholder or malformed id counted as unset.
 */

vi.mock("@/lib/catalog/server", () => ({ getActivities: async () => [], getCategories: async () => [] }));

const { buildCsp, edgePolicy, proxy } = await import("@/proxy");
const ga = await import("@/lib/ga-config");

const SYNTH_ID = ["G", "SYNTH0001"].join("-");
const base = { isProd: true, nonce: "bm9uY2U=", otpWidgetConfigured: false } as const;

function directive(csp: string, name: string): string[] {
  const d = csp.split("; ").find((x) => x.startsWith(`${name} `));
  return d ? d.split(" ").slice(1) : [];
}

const GOOGLE = /google|doubleclick|gstatic/;

describe("buildCsp with analytics", () => {
  const on = buildCsp("'self' 'unsafe-inline'", true, true, false);
  const off = buildCsp("'self' 'unsafe-inline'", true, false, false);

  it("adds Google's documented GA4 hosts to script-src, img-src and connect-src", () => {
    expect(directive(on, "script-src")).toEqual(["'self'", "'unsafe-inline'", "https://*.googletagmanager.com"]);
    expect(directive(on, "img-src")).toEqual(["'self'", "data:", "blob:", "https:", "https://*.google-analytics.com", "https://*.googletagmanager.com"]);
    expect(directive(on, "connect-src")).toEqual(["'self'", "https://*.google-analytics.com", "https://*.analytics.google.com", "https://*.googletagmanager.com"]);
  });

  it("adds nothing for Google Signals or ads, and no Google host anywhere else", () => {
    expect(on).not.toMatch(/doubleclick|https:\/\/\*\.google\.com|www\.google\.|gstatic/);
    for (const name of ["default-src", "style-src", "font-src", "frame-ancestors", "base-uri", "form-action", "object-src"]) {
      expect(directive(on, name).join(" "), name).not.toMatch(GOOGLE);
    }
    expect(on).not.toMatch(/frame-src/);
  });

  it("changes no other directive", () => {
    const strip = (csp: string) =>
      csp
        .split("; ")
        .filter((d) => !/^(script-src|img-src|connect-src) /.test(d))
        .join("; ");
    expect(strip(on)).toBe(strip(off));
    expect(off).not.toMatch(GOOGLE);
  });

  it("never allows a bare wildcard, http or eval for analytics in production", () => {
    for (const name of ["script-src", "img-src", "connect-src"]) {
      const added = directive(on, name).filter((v) => !directive(off, name).includes(v));
      for (const v of added) expect(v, `${name} ${v}`).toMatch(/^https:\/\/\*\.(googletagmanager|google-analytics|analytics\.google)\.com$/);
    }
    expect(on).not.toMatch(/'unsafe-eval'/);
  });
});

describe("edgePolicy analytics boundaries", () => {
  it("storefront pages allow GA4 only when an id is configured", () => {
    expect(edgePolicy({ ...base, pathname: "/activities/desert-safari", analyticsConfigured: true }).csp).toMatch(/\*\.analytics\.google\.com/);
    expect(edgePolicy({ ...base, pathname: "/activities/desert-safari", analyticsConfigured: false }).csp).not.toMatch(GOOGLE);
  });

  it.each(["/t", "/booking/confirmation", "/manage-booking", "/voucher/OUT-10000017", "/api/orders/OUT-10000017/status", "/admin", "/admin/orders"])(
    "%s never allows a Google host, even with an id configured",
    (pathname) => {
      expect(edgePolicy({ ...base, pathname, analyticsConfigured: true }).csp).not.toMatch(GOOGLE);
    },
  );
});

describe("one GA4 env name", () => {
  beforeEach(() => ga.resetGaConfigWarning());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("prefers the canonical name and never warns for it", () => {
    const warn = vi.fn();
    expect(ga.resolveGaMeasurementId(SYNTH_ID, ["G", "OTHER0002"].join("-"), warn)).toBe(SYNTH_ID);
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the deprecated name and warns", () => {
    const warn = vi.fn();
    expect(ga.resolveGaMeasurementId(undefined, SYNTH_ID, warn)).toBe(SYNTH_ID);
    expect(ga.resolveGaMeasurementId("  ", SYNTH_ID, warn)).toBe(SYNTH_ID);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it.each([["G-"], [""], ["UA-12345-1"], ["G-has space"], ["<script>"]])("treats %j as unset", (v) => {
    expect(ga.resolveGaMeasurementId(v, v, () => {})).toBeUndefined();
  });

  it("warns once per process, without the id", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", "");
    vi.stubEnv("NEXT_PUBLIC_GA4_MEASUREMENT_ID", SYNTH_ID);
    expect(ga.gaMeasurementId()).toBe(SYNTH_ID);
    expect(ga.gaMeasurementId()).toBe(SYNTH_ID);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain("NEXT_PUBLIC_GA_MEASUREMENT_ID");
    expect(String(spy.mock.calls[0][0])).not.toContain(SYNTH_ID);
  });

  it("the proxy opens the GA4 hosts for the deprecated name too, so tag and CSP cannot disagree", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NEXT_PUBLIC_GA_MEASUREMENT_ID", "");
    vi.stubEnv("NEXT_PUBLIC_GA4_MEASUREMENT_ID", SYNTH_ID);
    const res = await proxy(new NextRequest("http://localhost:3000/terms"));
    expect(res.headers.get("content-security-policy")).toMatch(/connect-src [^;]*https:\/\/\*\.analytics\.google\.com/);
    vi.stubEnv("NEXT_PUBLIC_GA4_MEASUREMENT_ID", "G-");
    const placeholder = await proxy(new NextRequest("http://localhost:3000/terms"));
    expect(placeholder.headers.get("content-security-policy")).not.toMatch(GOOGLE);
  });
});
