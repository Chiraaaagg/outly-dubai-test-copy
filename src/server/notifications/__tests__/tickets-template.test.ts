import { describe, expect, it } from "vitest";
import { MAX_SUBJECT_LENGTH, renderTicketsReady, ticketLink } from "../templates";

/**
 * The tickets email (TKT-5, TKT-6, TKT-9): one link, the site's own, with
 * the token in the fragment; no codes, no supplier or storage URLs.
 */

const SITE = "https://outlyy.com";
const TOKEN = "Zk3n0bq8Xr2s9Lw5Yc1Vd7Ae4Ht6Uj0Pm2Qo8Ri5Sx3"; // synthetic, 43 base64url chars
const XSS = `<script>alert("x")</script>`;

function render() {
  return renderTicketsReady({
    firstName: `Priya${XSS}`,
    orderReference: "OUT-12345674",
    items: [{ title: `Desert Safari ${XSS}`, dateLabel: "15 Jan 2030" }],
    link: ticketLink(SITE, TOKEN),
    expiresLabel: "14 Feb 2030",
    supportEmail: "hello@outlyy.com",
  });
}

function urlsIn(s: string): string[] {
  return [...s.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
}

describe("tickets-ready email", () => {
  it("the token goes in the fragment only", () => {
    const link = ticketLink(`${SITE}/`, TOKEN);
    expect(link).toBe(`${SITE}/t#${TOKEN}`);
    const u = new URL(link);
    expect(u.pathname).toBe("/t");
    expect(u.search).toBe("");
    expect(u.hash).toBe(`#${TOKEN}`);
  });

  it("refuses a malformed token", () => {
    expect(() => ticketLink(SITE, "short")).toThrow();
    expect(() => ticketLink(SITE, `${TOKEN}/../x`)).toThrow();
    expect(() => ticketLink(SITE, `${TOKEN}?a=1`)).toThrow();
  });

  it("renders no URL other than the site link (and the site's own logo)", () => {
    const r = render();
    const all = [...urlsIn(r.text), ...urlsIn(r.html!)];
    expect(all.length).toBeGreaterThan(0);
    for (const u of all) expect(u.startsWith(`${SITE}/`), u).toBe(true);
    const links = all.filter((u) => u.includes("#"));
    expect(new Set(links)).toEqual(new Set([`${SITE}/t#${TOKEN}`]));
    expect(urlsIn(r.text)).toEqual([`${SITE}/t#${TOKEN}`]);
    // The token appears only inside that link.
    expect(r.text.split(TOKEN)).toHaveLength(2);
  });

  it("carries no code, voucher Guid, supplier or storage reference", () => {
    const r = render();
    const blob = `${r.subject}\n${r.text}\n${r.html}`;
    expect(blob).not.toMatch(/downloadcode|downloadCodeLink|Guid=|traveldesk|supabase|storage|\.s3\.|ticketCode|barcode|qr/i);
  });

  it("escapes customer text in html and keeps the subject short", () => {
    const r = render();
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.subject!.length).toBeLessThanOrEqual(MAX_SUBJECT_LENGTH);
    expect(r.subject).toContain("OUT-12345674");
    expect(r.html).toMatch(/^<!doctype html>/);
  });
});
