import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRIVATE_CUSTOMER_ROUTE_PREFIXES, isPrivateCustomerPath } from "@/lib/customer-status";
import { googleTagBootstrap, isGoogleTagExcludedPath } from "@/lib/google-tag";

/**
 * Private customer routes are never measured (PRV-4, TKT-5; doc 22 §23 B5):
 * every path in `PRIVATE_CUSTOMER_ROUTE_PREFIXES` (and B4's `/tickets`) is
 * excluded from GA4, from client `track()` page views and from attribution
 * landing capture. Lookalike public paths stay measured.
 */

vi.mock("@/lib/consent", () => ({ hasConsent: () => true }));

const analytics = await import("@/lib/analytics");

const PRIVATE = [...PRIVATE_CUSTOMER_ROUTE_PREFIXES, "/tickets"].flatMap((p) => [p, `${p}/`, `${p}/OUT-12345674`, `${p}/OUT-12345674/confirmation`]);
const PUBLIC = ["/", "/tours", "/tx", "/bookings", "/booking-info", "/vouchers", "/manage", "/api/order", "/api/orders-x", "/activities/desert-safari"];

/** Runs the head snippet with a fake `location` and records the gtag calls. */
function gtagCalls(pathname: string): unknown[][] {
  const dataLayer: unknown[] = [];
  const run = new Function("window", "dataLayer", "location", googleTagBootstrap("G-TEST123"));
  run({ dataLayer }, dataLayer, { pathname });
  return dataLayer.map((args) => Array.from(args as ArrayLike<unknown>));
}

describe("GA4", () => {
  it.each(PRIVATE)("%s: the Google tag is never configured", (p) => {
    expect(isGoogleTagExcludedPath(p)).toBe(true);
    const calls = gtagCalls(p);
    expect(calls[0][0]).toBe("consent");
    expect(calls.some((c) => c[0] === "config")).toBe(false);
  });

  it.each(PUBLIC)("%s: still configured", (p) => {
    expect(isGoogleTagExcludedPath(p)).toBe(false);
    expect(gtagCalls(p).some((c) => c[0] === "config" && c[1] === "G-TEST123")).toBe(true);
  });

  it("covers every private prefix of the frozen contract", () => {
    for (const p of PRIVATE_CUSTOMER_ROUTE_PREFIXES) expect(isGoogleTagExcludedPath(`${p}/x`), p).toBe(isPrivateCustomerPath(`${p}/x`));
  });
});

describe("attribution landing capture", () => {
  it.each(PRIVATE)("%s lands as its bare prefix only", (p) => {
    const touch = analytics.parseAttributionFromUrl(`https://outlyy.com${p}?utm_source=mail#Zk3n0bq8Xr2s9Lw5Yc1Vd7Ae4Ht6Uj0Pm2Qo8Ri5Sx3`);
    expect(analytics.UNMEASURED_PATH_PREFIXES).toContain(touch.landing);
    expect(JSON.stringify(touch)).not.toContain("OUT-12345674");
    expect(JSON.stringify(touch)).not.toContain("Zk3n0bq8");
  });

  it("public pages keep their landing path", () => {
    expect(analytics.parseAttributionFromUrl("https://outlyy.com/bookings/help").landing).toBe("/bookings/help");
  });
});

describe("track() and PageView", () => {
  let cookies: Record<string, string>;

  function at(pathname: string) {
    const location = { pathname, href: `https://outlyy.com${pathname}?utm_source=mail`, protocol: "https:" };
    vi.stubGlobal("location", location);
    vi.stubGlobal("window", { location, innerWidth: 1200, dataLayer: [] as Record<string, unknown>[], __outlyyEvents: undefined });
    vi.stubGlobal("document", {
      referrer: "",
      get cookie() {
        return Object.entries(cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join("; ");
      },
      set cookie(v: string) {
        const [pair] = v.split(";");
        const i = pair.indexOf("=");
        cookies[pair.slice(0, i)] = pair.slice(i + 1);
      },
    });
  }

  beforeEach(() => {
    cookies = {};
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(PRIVATE)("%s: no page view reaches dataLayer and no attribution is written", (p) => {
    at(p);
    analytics.track("page_view", { page_type: "booking" });
    analytics.track("landing_page_view", { page_type: "booking" });
    expect((globalThis.window as unknown as { dataLayer: unknown[] }).dataLayer).toHaveLength(0);
    analytics.ensureClientContext();
    expect(cookies[analytics.COOKIE_NAMES.attribution]).toBeUndefined();
  });

  it("a public page is still measured and captured", () => {
    at("/tours");
    analytics.track("page_view", { page_type: "listing" });
    const dl = (globalThis.window as unknown as { dataLayer: Record<string, unknown>[] }).dataLayer;
    expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({ event: "page_view", page_path: "/tours" });
    expect(decodeURIComponent(cookies[analytics.COOKIE_NAMES.attribution] ?? "")).toContain('"first_landing":"/tours"');
  });

  it("isUnmeasuredPath (used by PageView) matches the private routes and nothing public", () => {
    for (const p of PRIVATE) expect(analytics.isUnmeasuredPath(p), p).toBe(true);
    for (const p of PUBLIC) expect(analytics.isUnmeasuredPath(p), p).toBe(false);
  });
});
