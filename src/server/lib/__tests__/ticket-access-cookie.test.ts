import { afterEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

/**
 * The cookies that carry guest checkout and ticket access, including the
 * guest download grant issued at checkout (checkout redesign batch 3, CO-02,
 * and its security review):
 *
 *  - deployed (APP_ENV staging or production): `__Host-` names, Secure,
 *    Path=/, no Domain;
 *  - local development and tests over http (APP_ENV development): the plain
 *    names; Secure only in a production build;
 *  - ticket access is HttpOnly, SameSite=Strict and expires with its longest
 *    entry; the guest session is HttpOnly, SameSite=Lax.
 *
 * The old plain names are not read in deployed environments.
 */

const state = vi.hoisted(() => ({ appEnv: "production" as "development" | "staging" | "production" }));
vi.mock("../env", () => ({ env: () => ({ APP_ENV: state.appEnv }) }));

const cs = await import("../customer-session");

const VALUE = "v1.0190a000-0000-7000-8000-0000000000a1.1900000000." + "a".repeat(64);
const EXPIRES = new Date("2030-01-11T12:00:00.000Z");

function written(res: NextResponse, name: string): string {
  const set = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  if (!set) throw new Error(`no ${name} cookie`);
  return set;
}

function reqWith(jar: Record<string, string>) {
  return { cookies: { get: (n: string) => (n in jar ? { name: n, value: jar[n] } : undefined) } } as never;
}

afterEach(() => {
  state.appEnv = "production";
  vi.unstubAllEnvs();
});

describe("ticket access cookie", () => {
  it("production: __Host- name, HttpOnly, Secure, SameSite=Strict, Path=/, no Domain, the entry's expiry, nothing but the value", () => {
    expect(cs.ticketAccessCookieName()).toBe("__Host-outlyy_ticket_access");
    const res = NextResponse.json({});
    cs.setTicketAccessCookie(res, VALUE, EXPIRES);
    const c = written(res, "__Host-outlyy_ticket_access");
    expect(c.startsWith(`__Host-outlyy_ticket_access=${VALUE};`)).toBe(true);
    expect(c).toMatch(/;\s*HttpOnly/i);
    expect(c).toMatch(/;\s*Secure/i);
    expect(c).toMatch(/;\s*SameSite=Strict/i);
    expect(c).toMatch(/;\s*Path=\/(;|$)/);
    expect(c).toMatch(/;\s*Expires=Fri, 11 Jan 2030 12:00:00 GMT/i);
    expect(c).not.toMatch(/Domain=/i);
    expect(res.headers.getSetCookie().some((x) => x.startsWith("outlyy_ticket_access="))).toBe(false);
  });

  it("deployed, only the __Host- name is read; the plain name is ignored", () => {
    expect(cs.ticketAccessFromRequest(reqWith({ "__Host-outlyy_ticket_access": VALUE }))).toBe(VALUE);
    expect(cs.ticketAccessFromRequest(reqWith({ outlyy_ticket_access: VALUE }))).toBeUndefined();
    state.appEnv = "staging";
    expect(cs.ticketAccessFromRequest(reqWith({ outlyy_ticket_access: VALUE }))).toBeUndefined();
  });

  it("staging is __Host- and Secure too; local development keeps the plain name and may be plain http", () => {
    state.appEnv = "staging";
    let res = NextResponse.json({});
    cs.setTicketAccessCookie(res, VALUE, EXPIRES);
    expect(written(res, "__Host-outlyy_ticket_access")).toMatch(/;\s*Secure/i);

    state.appEnv = "development";
    vi.stubEnv("NODE_ENV", "development");
    expect(cs.ticketAccessCookieName()).toBe("outlyy_ticket_access");
    res = NextResponse.json({});
    cs.setTicketAccessCookie(res, VALUE, EXPIRES);
    const local = written(res, "outlyy_ticket_access");
    expect(local).not.toMatch(/;\s*Secure/i);
    expect(local).toMatch(/;\s*HttpOnly/i);
    expect(local).toMatch(/;\s*SameSite=Strict/i);
    expect(cs.ticketAccessFromRequest(reqWith({ outlyy_ticket_access: VALUE }))).toBe(VALUE);

    // A production build run locally is Secure, still with the plain name (APP_ENV development).
    vi.stubEnv("NODE_ENV", "production");
    res = NextResponse.json({});
    cs.setTicketAccessCookie(res, VALUE, EXPIRES);
    expect(written(res, "outlyy_ticket_access")).toMatch(/;\s*Secure/i);
  });

  it("clearing expires it under the same name with the same attributes", () => {
    const res = NextResponse.json({});
    cs.clearTicketAccessCookie(res);
    const c = written(res, "__Host-outlyy_ticket_access");
    expect(c).toMatch(/Max-Age=0/i);
    expect(c).toMatch(/;\s*HttpOnly/i);
    expect(c).toMatch(/;\s*Secure/i);
    expect(c).toMatch(/;\s*SameSite=Strict/i);
    expect(c).toMatch(/;\s*Path=\//);
    expect(cs.ticketAccessFromRequest(reqWith({ "__Host-outlyy_ticket_access": "" }))).toBeUndefined();
  });
});

describe("guest session cookie", () => {
  it("production: __Host- name, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain; read and cleared under that name only", () => {
    expect(cs.guestCookieName()).toBe("__Host-outlyy_guest_session");
    const res = NextResponse.json({});
    cs.setGuestCookie(res, "t".repeat(43), EXPIRES);
    const c = written(res, "__Host-outlyy_guest_session");
    expect(c).toMatch(/;\s*HttpOnly/i);
    expect(c).toMatch(/;\s*Secure/i);
    expect(c).toMatch(/;\s*SameSite=Lax/i);
    expect(c).toMatch(/;\s*Path=\/(;|$)/);
    expect(c).not.toMatch(/Domain=/i);
    expect(cs.guestTokenFromRequest(reqWith({ "__Host-outlyy_guest_session": "tok" }))).toBe("tok");
    expect(cs.guestTokenFromRequest(reqWith({ outlyy_guest_session: "tok" }))).toBeUndefined();
    const cleared = NextResponse.json({});
    cs.clearGuestCookie(cleared);
    expect(written(cleared, "__Host-outlyy_guest_session")).toMatch(/Max-Age=0/i);
  });

  it("local development keeps the plain name", () => {
    state.appEnv = "development";
    expect(cs.guestCookieName()).toBe("outlyy_guest_session");
    expect(cs.guestTokenFromRequest(reqWith({ outlyy_guest_session: "tok" }))).toBe("tok");
  });
});
