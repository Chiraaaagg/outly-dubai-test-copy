import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "../../lib/env";
import { pilotActive, pilotAllowsEmail, pilotEmails, pilotRequested, pilotShownOptions } from "../pilot";
import type { CustomerAuthOptions } from "@/lib/customer-auth-options";

/**
 * Owner-only pilot (CUSTOMER_AUTH_PILOT_EMAILS): the list, the address check
 * and what /login shows. Synthetic addresses only.
 */

const all: CustomerAuthOptions = { emailCode: true, google: true, phone: true, turnstileSiteKey: "site-key" };

function pilot(list: string) {
  vi.stubEnv("CUSTOMER_AUTH_PILOT_EMAILS", list);
  resetEnvCache();
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("owner-only pilot", () => {
  it("empty by default: no pilot, every address allowed, /login unchanged", () => {
    pilot("");
    expect(pilotActive()).toBe(false);
    expect(pilotAllowsEmail("anyone@example.com")).toBe(true);
    expect(pilotShownOptions(all, null)).toEqual({ options: all, pilot: false });
    expect(pilotShownOptions(all, "1")).toEqual({ options: all, pilot: false });
  });

  it("set: only listed addresses, compared trimmed and lower-cased", () => {
    pilot(" Owner@Example.com , second@example.com");
    expect(pilotActive()).toBe(true);
    expect(pilotEmails()).toEqual(["owner@example.com", "second@example.com"]);
    expect(pilotAllowsEmail("owner@example.com")).toBe(true);
    expect(pilotAllowsEmail("  OWNER@EXAMPLE.COM ")).toBe(true);
    expect(pilotAllowsEmail("owner+x@example.com")).toBe(false);
    expect(pilotAllowsEmail("stranger@example.com")).toBe(false);
    expect(pilotAllowsEmail(null)).toBe(false);
  });

  it("a list with no valid address still closes the gate", () => {
    pilot("not-an-address");
    expect(pilotActive()).toBe(true);
    expect(pilotEmails()).toEqual([]);
    expect(pilotAllowsEmail("owner@example.com")).toBe(false);
  });

  it("/login shows email and Google only with exactly ?pilot=1; the phone option is untouched", () => {
    pilot("owner@example.com");
    expect(pilotRequested("1")).toBe(true);
    for (const v of [null, "", "0", "true", "yes", "11"]) expect(pilotRequested(v)).toBe(false);
    expect(pilotShownOptions(all, "1")).toEqual({ options: all, pilot: true });
    expect(pilotShownOptions(all, null)).toEqual({ options: { emailCode: false, google: false, phone: true, turnstileSiteKey: null }, pilot: false });
    expect(pilotShownOptions(all, "true").options.google).toBe(false);
  });
});
