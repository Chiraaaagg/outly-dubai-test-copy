import { describe, expect, it } from "vitest";
import { googleTagBootstrap, isGoogleTagExcludedPath } from "@/lib/google-tag";
import { parseAttributionFromUrl, ticketPagePrefix } from "@/lib/analytics";

/**
 * Ticket pages are not measured (TKT-5, PRV-4; doc 22 §23 B4/B5): GA4 is
 * never configured on `/t` or `/tickets`, and they never become an
 * attribution landing path beyond their bare prefix.
 */

const EXCLUDED = ["/t", "/t/", "/t/landing", "/tickets", "/tickets/", "/tickets/OUT-12345674", "/admin", "/admin/inquiries"];
const MEASURED = ["/", "/tours", "/tx", "/ticket", "/tickets-info", "/activities/desert-safari", "/search"];

/** Runs the head snippet with a fake `location` and records the gtag calls. */
function gtagCalls(pathname: string): unknown[][] {
  const dataLayer: unknown[] = [];
  const window = { dataLayer } as { dataLayer: unknown[] };
  const run = new Function("window", "dataLayer", "location", googleTagBootstrap("G-TEST123"));
  run(window, dataLayer, { pathname });
  return dataLayer.map((args) => Array.from(args as ArrayLike<unknown>));
}

describe("ticket pages: Google tag", () => {
  it.each(EXCLUDED)("%s is excluded", (p) => {
    expect(isGoogleTagExcludedPath(p)).toBe(true);
    expect(gtagCalls(p).some((c) => c[0] === "config")).toBe(false);
    // Consent defaults are still queued before anything else.
    expect(gtagCalls(p)[0][0]).toBe("consent");
  });

  it.each(MEASURED)("%s is configured", (p) => {
    expect(isGoogleTagExcludedPath(p)).toBe(false);
    expect(gtagCalls(p).some((c) => c[0] === "config" && c[1] === "G-TEST123")).toBe(true);
  });
});

describe("ticket pages: attribution", () => {
  it("ticketPagePrefix matches whole segments only", () => {
    expect(ticketPagePrefix("/t")).toBe("/t");
    expect(ticketPagePrefix("/t/abc")).toBe("/t");
    expect(ticketPagePrefix("/tickets/OUT-12345674")).toBe("/tickets");
    for (const p of ["/", "/tours", "/ticket", "/tickets-info", "/admin"]) expect(ticketPagePrefix(p)).toBeNull();
  });

  it("a ticket URL lands as its bare prefix: no reference, path segment or fragment", () => {
    const touch = parseAttributionFromUrl("https://outlyy.com/tickets/OUT-12345674?utm_source=mail#Zk3n0bq8Xr2s9Lw5Yc1Vd7Ae4Ht6Uj0Pm2Qo8Ri5Sx3");
    expect(touch.landing).toBe("/tickets");
    expect(JSON.stringify(touch)).not.toContain("OUT-12345674");
    expect(JSON.stringify(touch)).not.toContain("Zk3n0bq8");
    expect(parseAttributionFromUrl("https://outlyy.com/t#Zk3n0bq8Xr2s9Lw5Yc1Vd7Ae4Ht6Uj0Pm2Qo8Ri5Sx3").landing).toBe("/t");
  });

  it("other pages keep their landing path", () => {
    expect(parseAttributionFromUrl("https://outlyy.com/tours/desert?utm_source=x").landing).toBe("/tours/desert");
  });
});
