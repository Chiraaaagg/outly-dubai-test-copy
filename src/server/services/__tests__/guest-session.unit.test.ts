import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { GUEST_SESSION_TTL_MS, guestSessionService } from "../guest-session.service";
import { GUEST_COOKIE, clearGuestCookie, setGuestCookie } from "../../lib/customer-session";

/**
 * Guest checkout sessions (B2, TKT-4). Pure: the database module is replaced
 * and every call gets an in-memory table, so nothing here opens a connection.
 */

vi.mock("../../lib/db", () => ({
  prisma: { guestSession: new Proxy({}, { get: () => () => { throw new Error("tests pass their own table"); } }) },
  TX_OPTIONS: {},
}));

interface Row {
  id: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** The `db` argument type, without naming the database module (which would mark this a db suite). */
type Db = NonNullable<Parameters<typeof guestSessionService.create>[1]>;

function fakeTable() {
  const rows: Row[] = [];
  const match = (r: Row, where: Partial<Row>) => Object.entries(where).every(([k, v]) => r[k as keyof Row] === v);
  const guestSession = {
    create: async ({ data }: { data: Omit<Row, "revokedAt"> }) => {
      rows.push({ ...data, revokedAt: null });
      return rows[rows.length - 1];
    },
    findUnique: async ({ where }: { where: Partial<Row> }) => rows.find((r) => match(r, where)) ?? null,
    updateMany: async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
      const hit = rows.filter((r) => match(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
  };
  return { rows, db: { guestSession } as unknown as Db };
}

const NOW = new Date("2030-01-10T12:00:00.000Z");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("guestSessionService", () => {
  it("stores only the token's SHA-256 and a fixed expiry", async () => {
    const { rows, db } = fakeTable();
    const s = await guestSessionService.create(NOW, db);
    expect(s.token.length).toBeGreaterThanOrEqual(43); // 32 random bytes, base64url
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(sha(s.token));
    expect(JSON.stringify(rows)).not.toContain(s.token);
    expect(rows[0].expiresAt.getTime() - NOW.getTime()).toBe(GUEST_SESSION_TTL_MS);
    expect(s.guestSessionId).toBe(rows[0].id);
    const again = await guestSessionService.create(NOW, db);
    expect(again.token).not.toBe(s.token);
  });

  it("resolves a live token and nothing else", async () => {
    const { db } = fakeTable();
    const s = await guestSessionService.create(NOW, db);
    await expect(guestSessionService.resolveToken(s.token, NOW, db)).resolves.toEqual({ guestSessionId: s.guestSessionId, expiresAt: s.expiresAt });
    await expect(guestSessionService.resolveToken(`${s.token}x`, NOW, db)).resolves.toBeNull();
    await expect(guestSessionService.resolveToken(undefined, NOW, db)).resolves.toBeNull();
    await expect(guestSessionService.resolveToken("short", NOW, db)).resolves.toBeNull();
    await expect(guestSessionService.resolveToken("x".repeat(257), NOW, db)).resolves.toBeNull();
    // Expired at exactly the expiry instant.
    await expect(guestSessionService.resolveToken(s.token, s.expiresAt, db)).resolves.toBeNull();
    await expect(guestSessionService.isLive(s.guestSessionId, NOW, db)).resolves.toBe(true);
    await expect(guestSessionService.isLive(s.guestSessionId, s.expiresAt, db)).resolves.toBe(false);
  });

  it("revocation is final and idempotent", async () => {
    const { db } = fakeTable();
    const a = await guestSessionService.create(NOW, db);
    const b = await guestSessionService.create(NOW, db);
    await expect(guestSessionService.revoke(a.token, NOW, db)).resolves.toBe(true);
    await expect(guestSessionService.revoke(a.token, NOW, db)).resolves.toBe(false);
    await expect(guestSessionService.resolveToken(a.token, NOW, db)).resolves.toBeNull();
    await expect(guestSessionService.isLive(a.guestSessionId, NOW, db)).resolves.toBe(false);
    await expect(guestSessionService.revokeById(b.guestSessionId, NOW, db)).resolves.toBe(true);
    await expect(guestSessionService.resolveToken(b.token, NOW, db)).resolves.toBeNull();
  });

  it("owner() is a guest owner, never a customer", () => {
    expect(guestSessionService.owner({ guestSessionId: "g-1", expiresAt: NOW })).toEqual({ kind: "guest", guestSessionId: "g-1" });
  });
});

describe("guest session cookie", () => {
  it("is httpOnly, SameSite=Lax, path=/ and carries the session expiry; clearing expires it", () => {
    const res = NextResponse.json({});
    const expiresAt = new Date(NOW.getTime() + GUEST_SESSION_TTL_MS);
    setGuestCookie(res, "opaque-token-value", expiresAt);
    const c = res.cookies.get(GUEST_COOKIE);
    expect(c).toMatchObject({ value: "opaque-token-value", httpOnly: true, sameSite: "lax", path: "/" });
    expect(new Date(c!.expires as Date).getTime()).toBe(expiresAt.getTime());
    clearGuestCookie(res);
    expect(res.cookies.get(GUEST_COOKIE)).toMatchObject({ value: "", maxAge: 0, httpOnly: true });
  });
});
