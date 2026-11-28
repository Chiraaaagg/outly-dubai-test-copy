import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Group C C3 (doc 93 §7.1 note; owner answer O13): the storefront no longer
 * promises what is not delivered: a QR voucher on WhatsApp within a minute,
 * one QR per combo ticket, the driver's details on WhatsApp the evening before.
 */
const ROOT = path.resolve(import.meta.dirname, "../../../..");
const FILES = [
  "src/lib/data/landing-pages.ts",
  "src/lib/data/categories.ts",
  "src/lib/data/combos.ts",
  "src/lib/data/activities.ts",
  "src/app/combos/[slug]/page.tsx",
  "src/app/activities/page.tsx",
  "src/app/maintenance/page.tsx",
];
const UNTRUE = [
  /under a minute/i,
  /inside a minute/i,
  /within (about )?a minute of payment/i,
  /voucher on WhatsApp/i,
  /WhatsApp voucher/i,
  /QR (voucher|code)? ?(reaches|on) WhatsApp/i,
  /(its|their) own (timed slot and )?QR/i,
  /has its own QR/i,
  /driver's name[^."]*evening before/i,
  /driver details the night before/i,
  /10-minutes-away message|ten minutes away/i,
];

describe("C3 copy: no undelivered voucher, QR or driver promises", () => {
  for (const f of FILES) {
    it(f, () => {
      const src = readFileSync(path.join(ROOT, f), "utf8");
      for (const re of UNTRUE) expect(src, `${f} still says ${re}`).not.toMatch(re);
    });
  }

  it("says what is delivered instead", () => {
    const landing = readFileSync(path.join(ROOT, "src/lib/data/landing-pages.ts"), "utf8");
    expect(landing).toContain("by email and on your booking page");
    expect(landing).toContain("pickup details come from the operator before the tour");
  });
});
