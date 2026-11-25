import type { MetadataRoute } from "next";
import { PRIVATE_CUSTOMER_ROUTE_PREFIXES } from "@/lib/customer-status";

/**
 * robots.txt
 *
 * Faceted search is disallowed rather than noindexed so it never consumes
 * crawl budget (PRD §7: index high-value facet combinations, block the long
 * tail). Personal surfaces — cart, checkout, account, vouchers, booking
 * lookups — are blocked outright; those also carry page-level noindex.
 *
 * Every private customer route (src/lib/customer-status.ts) is disallowed
 * exactly: the path itself, with a query, and everything under it. A bare
 * `Disallow: /t` would be a prefix match and also block /terms and /tours.
 */
const PRIVATE_CUSTOMER_DISALLOWS = PRIVATE_CUSTOMER_ROUTE_PREFIXES.flatMap((p) => [`${p}$`, `${p}?`, `${p}/`]);

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/search",
          "/compare",
          "/cart",
          "/checkout",
          "/booking/",
          "/voucher/",
          "/account",
          "/account/",
          "/manage-booking",
          "/reviews/",
          "/login",
          "/signup",
          "/maintenance",
          "/design-system",
          "/admin",
          "/admin/",
          "/api/",
          "/*?mock=",
          ...PRIVATE_CUSTOMER_DISALLOWS,
        ].filter((rule, i, all) => all.indexOf(rule) === i),
      },
    ],
    sitemap: "https://outlyy.com/sitemap.xml",
    host: "https://outlyy.com",
  };
}
