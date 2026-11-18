import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PRIVATE_CUSTOMER_ROUTE_PREFIXES } from "@/lib/customer-status";

/**
 * Private customer routes at the edge (doc 22 §23 B5, PRV-4, TKT-5): the
 * proxy headers and CSP, the proxy matcher, robots.txt and the sitemap.
 * No database: the sitemap's catalogue reads are mocked.
 */

vi.mock("@/lib/catalog/server", () => ({
  getActivities: async () => [
    { slug: "desert-safari", tier: "A" },
    { slug: "burj-khalifa-at-the-top", tier: "C" },
  ],
  getCategories: async () => [{ slug: "tours" }, { slug: "booking" }],
}));

const { config, edgePolicy, proxy } = await import("@/proxy");
const { default: robots } = await import("@/app/robots");

/** Sample paths for every private prefix: the prefix itself and below it. */
const PRIVATE_SAMPLES = [
  "/t",
  "/booking/confirmation",
  "/booking/OUT-10000017",
  "/booking",
  "/manage-booking",
  "/voucher/OUT-10000017",
  "/api/orders/OUT-10000017/status",
  "/api/orders/OUT-10000017/cancellation",
  "/api/recovery/start",
  "/api/recovery/verify",
  "/api/tickets/exchange",
  "/api/tickets/remove-access",
  "/api/tickets/orders/OUT-10000017",
  "/api/tickets/documents/0190a0a0-0000-7000-8000-000000000000",
];
/** Look-alikes that are public and must keep the storefront policy. */
const PUBLIC_SAMPLES = ["/", "/terms", "/tours", "/activities/desert-safari", "/bookings", "/vouchers-explained", "/checkout", "/api/quotes", "/categories/booking"];

const base = { isProd: true, nonce: "bm9uY2U=", analyticsConfigured: true, otpWidgetConfigured: false };

describe("proxy headers on private customer routes", () => {
  it.each(PRIVATE_SAMPLES)("%s: private, no-store, no-referrer, noindex and no analytics origins", (pathname) => {
    const { isPrivateCustomer, headers, csp } = edgePolicy({ ...base, pathname });
    expect(isPrivateCustomer).toBe(true);
    expect(headers["Cache-Control"]).toBe("private, no-store");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["X-Robots-Tag"]).toBe("noindex, nofollow");
    expect(csp).not.toMatch(/googletagmanager|google-analytics/);
    // The rest of the security headers are still there.
    expect(headers["Content-Security-Policy"]).toBe(csp);
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(headers["Strict-Transport-Security"]).toMatch(/max-age=/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/object-src 'none'/);
  });

  it.each(PUBLIC_SAMPLES)("%s: the storefront policy is unchanged", (pathname) => {
    const { isPrivateCustomer, headers, csp } = edgePolicy({ ...base, pathname });
    expect(isPrivateCustomer).toBe(false);
    expect(headers["Cache-Control"]).toBeUndefined();
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["X-Robots-Tag"]).toBeUndefined();
    // GA is allowed on the storefront when a measurement id is configured.
    expect(csp).toMatch(/script-src [^;]*https:\/\/www\.googletagmanager\.com/);
    expect(csp).toMatch(/connect-src [^;]*google-analytics\.com/);
  });

  it("no analytics origins anywhere when no measurement id is configured", () => {
    for (const pathname of [...PRIVATE_SAMPLES, ...PUBLIC_SAMPLES]) {
      expect(edgePolicy({ ...base, analyticsConfigured: false, pathname }).csp).not.toMatch(/googletagmanager|google-analytics/);
    }
  });

  it("the admin console keeps its nonce policy and no-store", () => {
    const { isAdmin, headers, csp } = edgePolicy({ ...base, pathname: "/admin/orders" });
    expect(isAdmin).toBe(true);
    expect(csp).toMatch(/'nonce-bm9uY2U=' 'strict-dynamic'/);
    expect(csp).not.toMatch(/googletagmanager/);
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["X-Robots-Tag"]).toBe("noindex, nofollow");
  });

  it("development keeps eval for the toolchain on private pages too", () => {
    const { csp, headers } = edgePolicy({ ...base, isProd: false, pathname: "/t" });
    expect(csp).toMatch(/'unsafe-eval'/);
    expect(headers["Strict-Transport-Security"]).toBeUndefined();
    expect(headers["Cache-Control"]).toBe("private, no-store");
  });

  it("the proxy sets them on the real response, so a route handler's own headers cannot be replaced by weaker ones", async () => {
    const saved = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
    process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = "G-TEST000000";
    try {
      for (const pathname of ["/t", "/manage-booking", "/api/tickets/exchange", "/api/orders/OUT-10000017/status"]) {
        const res = await proxy(new NextRequest(`http://localhost:3000${pathname}`));
        expect(res.headers.get("cache-control"), pathname).toBe("private, no-store");
        expect(res.headers.get("referrer-policy"), pathname).toBe("no-referrer");
        expect(res.headers.get("x-robots-tag"), pathname).toBe("noindex, nofollow");
        expect(res.headers.get("content-security-policy"), pathname).not.toMatch(/googletagmanager|google-analytics/);
      }
      const home = await proxy(new NextRequest("http://localhost:3000/terms"));
      expect(home.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(home.headers.get("cache-control")).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
      else process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID = saved;
    }
  });

  it("the maintenance rewrite of a private page still carries the private headers", async () => {
    const saved = process.env.FEATURE_MAINTENANCE_MODE;
    process.env.FEATURE_MAINTENANCE_MODE = "true";
    try {
      const res = await proxy(new NextRequest("http://localhost:3000/booking/OUT-10000017"));
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    } finally {
      if (saved === undefined) delete process.env.FEATURE_MAINTENANCE_MODE;
      else process.env.FEATURE_MAINTENANCE_MODE = saved;
    }
  });

  it("the proxy matcher covers every private page and API route", () => {
    // Next compiles each matcher source as a path pattern anchored at both ends;
    // this one is a single regex group, so the plain RegExp reading is the same.
    const matchers = config.matcher.map((m) => new RegExp(`^${m}$`));
    for (const pathname of PRIVATE_SAMPLES) expect(matchers.some((r) => r.test(pathname)), pathname).toBe(true);
    // Static assets stay excluded.
    expect(matchers.some((r) => r.test("/_next/static/chunks/main.js"))).toBe(false);
    expect(matchers.some((r) => r.test("/robots.txt"))).toBe(false);
  });
});

/**
 * Google's robots.txt matching: `*` is any run of characters, `$` anchors the
 * end, everything else (including `?`) is literal; the longest matching rule
 * wins and Allow wins a tie.
 */
function robotsAllows(rules: { allow: string[]; disallow: string[] }, url: string): boolean {
  const toRe = (rule: string) => {
    const anchored = rule.endsWith("$");
    const body = (anchored ? rule.slice(0, -1) : rule).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${body}${anchored ? "$" : ""}`);
  };
  const longest = (list: string[]) => Math.max(-1, ...list.filter((r) => toRe(r).test(url)).map((r) => r.length));
  return longest(rules.allow) >= longest(rules.disallow);
}

describe("robots.txt", () => {
  const rule = [robots().rules].flat()[0];
  const rules = { allow: [rule.allow ?? []].flat(), disallow: [rule.disallow ?? []].flat() };

  it("lists every rule once", () => {
    expect(new Set(rules.disallow).size).toBe(rules.disallow.length);
  });

  it.each([...PRIVATE_SAMPLES, ...PRIVATE_CUSTOMER_ROUTE_PREFIXES, "/t?from=email", "/manage-booking?ref=OUT-1", "/booking?x=1", "/voucher"])("disallows %s", (url) => {
    expect(robotsAllows(rules, url)).toBe(false);
  });

  it.each(["/", "/terms", "/tours", "/tickets-and-passes", "/activities/desert-safari", "/categories/booking", "/attractions/burj-khalifa"])("still allows %s", (url) => {
    expect(robotsAllows(rules, url)).toBe(true);
  });
});

describe("sitemap", () => {
  it("no URL in the sitemap is a private customer route, and every URL is on the site", async () => {
    const { default: sitemap } = await import("@/app/sitemap");
    const entries = await sitemap();
    expect(entries.length).toBeGreaterThan(10);
    for (const e of entries) {
      const u = new URL(e.url);
      expect(u.origin).toBe("https://outlyy.com");
      expect(PRIVATE_CUSTOMER_ROUTE_PREFIXES.some((p) => u.pathname === p || u.pathname.startsWith(`${p}/`)), e.url).toBe(false);
    }
  });

  it("drops a private path even when a landing page slug would produce one", async () => {
    vi.resetModules();
    vi.doMock("@/lib/data/landing-pages", () => ({
      landingPages: [
        { slug: "t", topLevel: true },
        { slug: "manage-booking", topLevel: true },
        { slug: "dubai-activities-for-indians", topLevel: true },
      ],
    }));
    try {
      const { default: sitemap } = await import("@/app/sitemap");
      const paths = (await sitemap()).map((e) => new URL(e.url).pathname);
      expect(paths).toContain("/dubai-activities-for-indians");
      expect(paths).not.toContain("/t");
      expect(paths).not.toContain("/manage-booking");
    } finally {
      vi.doUnmock("@/lib/data/landing-pages");
      vi.resetModules();
    }
  });
});
