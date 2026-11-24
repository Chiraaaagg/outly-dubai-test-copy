import { describe, expect, it, vi } from "vitest";

/**
 * The multi-grant access cookie (R-B4-11): entries are added, never
 * replaced; expired, forged and duplicate entries are dropped; at most
 * ACCESS_COOKIE_MAX_ENTRIES are kept and the value stays far below 4 KB. No
 * entry carries an order id, a purpose or a token. Pure: the database module
 * throws if touched. Resolution against live grants is tested in
 * capability.service.test.ts and the B5 suites.
 */

vi.mock("../../lib/db", () => ({
  prisma: new Proxy({}, { get: () => { throw new Error("no database in this suite"); } }),
  TX_OPTIONS: {},
}));

const { addAccessEntry, ACCESS_COOKIE_MAX_ENTRIES } = await import("../capability.service");
const { hmacFor } = await import("../../lib/crypto");

const NOW = new Date("2030-01-10T08:00:00.000Z");

/** An entry exactly as the exchange signs it. */
function entry(grantId: string, expiresAt: Date): string {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  return ["v1", grantId, String(exp), hmacFor("access_cookie", `ticket_access:v1:${grantId}:${exp}`)].join(".");
}

const grant = (n: number) => `01890000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const inHours = (h: number) => new Date(NOW.getTime() + h * 3600_000);

describe("addAccessEntry", () => {
  it("adds a second order's grant beside the first, and the cookie lives as long as its longest entry", () => {
    const first = addAccessEntry(undefined, entry(grant(1), inHours(2)), NOW)!;
    expect(first.value).toBe(entry(grant(1), inHours(2)));
    const both = addAccessEntry(first.value, entry(grant(2), inHours(12)), NOW)!;
    expect(both.value.split("~")).toEqual([entry(grant(1), inHours(2)), entry(grant(2), inHours(12))]);
    expect(both.expiresAt.getTime()).toBe(Math.floor(inHours(12).getTime() / 1000) * 1000);
  });

  it("drops expired, forged and malformed entries, and keeps one entry per grant (the newest)", () => {
    const expired = entry(grant(3), new Date(NOW.getTime() - 1000));
    const forged = ["v1", grant(4), String(Math.floor(inHours(5).getTime() / 1000)), "0".repeat(64)].join(".");
    const existing = [expired, forged, "garbage", entry(grant(5), inHours(1))].join("~");
    const out = addAccessEntry(existing, entry(grant(5), inHours(6)), NOW)!;
    expect(out.value).toBe(entry(grant(5), inHours(6)));
  });

  it(`keeps the ${ACCESS_COOKIE_MAX_ENTRIES} newest entries, well below 4 KB, with no order id, purpose or token`, () => {
    let value: string | undefined;
    for (let i = 1; i <= ACCESS_COOKIE_MAX_ENTRIES + 4; i++) value = addAccessEntry(value, entry(grant(i), inHours(12)), NOW)!.value;
    const parts = value!.split("~");
    expect(parts).toHaveLength(ACCESS_COOKIE_MAX_ENTRIES);
    expect(parts[0]).toContain(grant(5));
    expect(parts.at(-1)).toContain(grant(ACCESS_COOKIE_MAX_ENTRIES + 4));
    expect(value!.length).toBeLessThan(1200);
    expect(value).not.toMatch(/view_status|download_tickets|order/);
  });

  it("refuses to add an entry that does not verify", () => {
    expect(addAccessEntry(undefined, "v1.not-a-grant.1.abc", NOW)).toBeNull();
    expect(addAccessEntry(undefined, entry(grant(9), new Date(NOW.getTime() - 1)), NOW)).toBeNull();
  });

  it("a value too long to be ours is ignored whole", () => {
    const out = addAccessEntry("x".repeat(5000), entry(grant(1), inHours(1)), NOW)!;
    expect(out.value).toBe(entry(grant(1), inHours(1)));
  });
});
