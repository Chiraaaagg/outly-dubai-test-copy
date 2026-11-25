import { afterEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { EgressBlockedError } from "../../__tests__/helpers/target-guard";
import { env, resetEnvCache } from "../../lib/env";
import { FakeAedCardGateway, FakeInrPacbGateway } from "../fake-gateways";
import { configurePaymentGateways, createGatewayRegistry, paymentGateways, railForCurrency } from "../registry";
import { createStripeClient, StripeGateway, stripeGatewayFromEnv } from "../stripe/stripe-gateway";
import { stripeConfigFrom, stripeConfigProblems, stripeMode, stripeRails, type StripeEnvSlice } from "../stripe/stripe.config";
import { ACCOUNT_ID, FakeStripe, LIVE_KEY, liveConfig, TEST_KEY, testConfig, WEBHOOK_SECRET } from "./_stripe-fake";

/**
 * Stripe configuration and the gateway registry (doc 27 §1 cases 11 and 12),
 * plus the no-network guard: a real Stripe client in this project cannot
 * reach api.stripe.com. Placeholder values only.
 */

const BASE: StripeEnvSlice = {
  APP_ENV: "development",
  PAYMENTS_STRIPE: "test",
  STRIPE_SECRET_KEY: TEST_KEY,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_ACCOUNT_ID: ACCOUNT_ID,
};
const LIVE: StripeEnvSlice = { ...BASE, APP_ENV: "production", PAYMENTS_STRIPE: "live", STRIPE_SECRET_KEY: LIVE_KEY };

const NOW = new Date("2030-01-10T08:00:00Z");
const stripe = (config = testConfig()) => new StripeGateway({ config, client: new FakeStripe(() => NOW), now: () => NOW });

afterEach(() => {
  configurePaymentGateways(null);
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("case 11: config", () => {
  it("a complete test-mode config outside production is accepted", () => {
    expect(stripeConfigProblems(BASE)).toEqual([]);
    expect(stripeConfigFrom(BASE)).toEqual({ mode: "test", environment: "test", secretKey: TEST_KEY, webhookSecret: WEBHOOK_SECRET, accountId: ACCOUNT_ID, rails: ["aed_card"], timeoutMs: 20_000 });
    expect(stripeMode(BASE)).toBe("test");
    expect(stripeConfigFrom({ ...BASE, APP_ENV: "staging", STRIPE_SECRET_KEY: `${"rk_test"}_PLACEHOLDER0000` })).toMatchObject({ mode: "test", environment: "test" });
    expect(stripeConfigFrom({ ...BASE, STRIPE_SECRET_KEY: `  ${TEST_KEY}  `, STRIPE_RAILS: " aed_card , inr_pacb " })).toMatchObject({ secretKey: TEST_KEY, rails: ["aed_card", "inr_pacb"] });
    expect(stripeConfigFrom(LIVE)).toMatchObject({ mode: "live", environment: "production", secretKey: LIVE_KEY });
  });

  it("refuses a test key with live and a live key with test", () => {
    expect(stripeConfigProblems({ ...LIVE, STRIPE_SECRET_KEY: TEST_KEY })).toContain("PAYMENTS_STRIPE=live requires an sk_live_ or rk_live_ key");
    expect(stripeConfigProblems({ ...LIVE, STRIPE_SECRET_KEY: `${"rk_test"}_PLACEHOLDER0000` })).toContain("PAYMENTS_STRIPE=live requires an sk_live_ or rk_live_ key");
    expect(stripeConfigProblems({ ...BASE, STRIPE_SECRET_KEY: LIVE_KEY })).toContain("PAYMENTS_STRIPE=test requires an sk_test_ or rk_test_ key");
    expect(stripeConfigFrom({ ...BASE, STRIPE_SECRET_KEY: LIVE_KEY })).toBeNull();
    expect(stripeConfigFrom({ ...LIVE, STRIPE_SECRET_KEY: TEST_KEY })).toBeNull();
    // A publishable or malformed key is not a secret key at all.
    for (const key of [`${"pk_test"}_PLACEHOLDER0000`, "sk_test_", "sk_PLACEHOLDER", "sk_test_PLACE HOLDER", "whsec_PLACEHOLDER"]) {
      expect(stripeConfigFrom({ ...BASE, STRIPE_SECRET_KEY: key }), key).toBeNull();
    }
    expect(stripeConfigProblems({ ...BASE, STRIPE_SECRET_KEY: undefined })).toContain("STRIPE_SECRET_KEY is missing");
  });

  it("refuses live outside production and test in production", () => {
    for (const APP_ENV of ["development", "staging", undefined] as const) {
      expect(stripeConfigProblems({ ...LIVE, APP_ENV }), String(APP_ENV)).toContain("PAYMENTS_STRIPE=live is only allowed when APP_ENV=production");
      expect(stripeConfigFrom({ ...LIVE, APP_ENV })).toBeNull();
    }
    expect(stripeConfigProblems({ ...BASE, APP_ENV: "production" })).toContain("APP_ENV=production must not use Stripe test mode");
    expect(stripeConfigFrom({ ...BASE, APP_ENV: "production" })).toBeNull();
    expect(stripeMode({ ...BASE, APP_ENV: "production" })).toBe("unconfigured");
  });

  it("refuses a missing or malformed webhook secret, account id or rails value", () => {
    const refused: Array<[Partial<StripeEnvSlice>, string]> = [
      [{ STRIPE_WEBHOOK_SECRET: undefined }, "STRIPE_WEBHOOK_SECRET is missing"],
      [{ STRIPE_WEBHOOK_SECRET: "  " }, "STRIPE_WEBHOOK_SECRET is missing"],
      [{ STRIPE_WEBHOOK_SECRET: "whsec_" }, "STRIPE_WEBHOOK_SECRET must be a whsec_ signing secret"],
      [{ STRIPE_WEBHOOK_SECRET: "PLACEHOLDER" }, "STRIPE_WEBHOOK_SECRET must be a whsec_ signing secret"],
      [{ STRIPE_WEBHOOK_SECRET: "whsec_PLACE HOLDER" }, "STRIPE_WEBHOOK_SECRET must be a whsec_ signing secret"],
      [{ STRIPE_ACCOUNT_ID: undefined }, "STRIPE_ACCOUNT_ID is missing"],
      [{ STRIPE_ACCOUNT_ID: "acct_" }, "STRIPE_ACCOUNT_ID must be an acct_ id"],
      [{ STRIPE_ACCOUNT_ID: "acct_PLACE-HOLDER" }, "STRIPE_ACCOUNT_ID must be an acct_ id"],
      [{ STRIPE_ACCOUNT_ID: "acc_PLACEHOLDER" }, "STRIPE_ACCOUNT_ID must be an acct_ id"],
      [{ STRIPE_ACCOUNT_ID: `acct_${"A".repeat(65)}` }, "STRIPE_ACCOUNT_ID must be an acct_ id"],
    ];
    for (const [over, problem] of refused) {
      expect(stripeConfigProblems({ ...BASE, ...over }), JSON.stringify(over)).toContain(problem);
      expect(stripeConfigFrom({ ...BASE, ...over })).toBeNull();
    }
    for (const rails of ["usd_card", "aed_card,aed_card", "aed_card,", ",inr_pacb", "AED_CARD", "aed_card;inr_pacb"]) {
      expect(stripeRails({ STRIPE_RAILS: rails }), rails).toBeNull();
      expect(stripeConfigProblems({ ...BASE, STRIPE_RAILS: rails })).toEqual([expect.stringContaining("STRIPE_RAILS must be")]);
      expect(stripeConfigFrom({ ...BASE, STRIPE_RAILS: rails })).toBeNull();
    }
    expect(stripeRails({})).toEqual(["aed_card"]);
    expect(stripeRails({ STRIPE_RAILS: "" })).toEqual(["aed_card"]);
    expect(stripeRails({ STRIPE_RAILS: "inr_pacb,aed_card" })).toEqual(["inr_pacb", "aed_card"]);
  });

  it("refuses a bad PAYMENTS_STRIPE value; off (or unset) is off", () => {
    for (const v of ["TEST", "Live", "on", "true", "1", "yes", "sandbox"]) {
      expect(stripeConfigProblems({ ...BASE, PAYMENTS_STRIPE: v }), v).toEqual(["PAYMENTS_STRIPE must be off, test or live"]);
      expect(stripeConfigFrom({ ...BASE, PAYMENTS_STRIPE: v })).toBeNull();
      expect(stripeMode({ ...BASE, PAYMENTS_STRIPE: v })).toBe("unconfigured");
    }
    for (const v of [undefined, "", " ", "off"]) {
      expect(stripeConfigProblems({ ...BASE, PAYMENTS_STRIPE: v }), String(v)).toEqual([]);
      expect(stripeConfigFrom({ ...BASE, PAYMENTS_STRIPE: v })).toBeNull();
      expect(stripeMode({ ...BASE, PAYMENTS_STRIPE: v })).toBe("off");
    }
    // Off needs nothing else.
    expect(stripeConfigProblems({ PAYMENTS_STRIPE: "off" })).toEqual([]);
  });

  it("refuses a NEXT_PUBLIC_*STRIPE*SECRET* variable, even while Stripe is off", () => {
    expect(stripeConfigProblems({ ...BASE, stripePublicSecretNames: ["NEXT_PUBLIC_STRIPE_SECRET_KEY"] })).toEqual(["NEXT_PUBLIC_STRIPE_SECRET_KEY exists: a Stripe secret must never reach the browser"]);
    expect(stripeConfigFrom({ ...BASE, stripePublicSecretNames: ["NEXT_PUBLIC_STRIPE_SECRET_KEY"] })).toBeNull();
    expect(stripeConfigProblems({ PAYMENTS_STRIPE: "off", stripePublicSecretNames: ["NEXT_PUBLIC_MY_STRIPE_WEBHOOK_SECRET"] })).toHaveLength(1);
  });

  it("env() finds a browser-exposed Stripe secret by name and refuses Stripe", () => {
    vi.stubEnv("PAYMENTS_STRIPE", "test");
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("STRIPE_SECRET_KEY", TEST_KEY);
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
    vi.stubEnv("STRIPE_ACCOUNT_ID", ACCOUNT_ID);
    resetEnvCache();
    expect(env().stripePublicSecretNames).toEqual([]);
    expect(stripeGatewayFromEnv(env())).toBeInstanceOf(StripeGateway);
    for (const name of ["NEXT_PUBLIC_STRIPE_SECRET_KEY", "NEXT_PUBLIC_stripe_webhook_secret", "NEXT_PUBLIC_OUTLY_STRIPE_SECRET"]) {
      vi.stubEnv(name, "PLACEHOLDER");
      resetEnvCache();
      expect(env().stripePublicSecretNames, name).toContain(name);
      expect(stripeGatewayFromEnv(env())).toBeNull();
      vi.stubEnv(name, undefined);
    }
    // A publishable key name is not a secret.
    vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "PLACEHOLDER");
    resetEnvCache();
    expect(env().stripePublicSecretNames).toEqual([]);
  });

  it("problem messages never contain a key or secret value", () => {
    const secrets = [`${"sk_live"}_PLACEHOLDERSECRETVALUE`, "whsec_PLACEHOLDERSECRETVALUE", `${"rk_live"}_PLACEHOLDERSECRETVALUE`];
    const problems = [
      ...stripeConfigProblems({ ...BASE, STRIPE_SECRET_KEY: secrets[0], STRIPE_WEBHOOK_SECRET: "whsec_PLACE HOLDERSECRETVALUE" }),
      ...stripeConfigProblems({ ...LIVE, APP_ENV: "staging", STRIPE_SECRET_KEY: secrets[2], STRIPE_WEBHOOK_SECRET: secrets[1], STRIPE_ACCOUNT_ID: "acct_bad-id" }),
    ];
    expect(problems.length).toBeGreaterThan(2);
    for (const p of problems) for (const s of [...secrets, "PLACEHOLDERSECRETVALUE", "PLACE HOLDERSECRETVALUE"]) expect(p).not.toContain(s);
  });
});

describe("case 12: registry", () => {
  it("Stripe is off by default: no gateway, every rail NOT_CONFIGURED", () => {
    expect(stripeGatewayFromEnv({})).toBeNull();
    expect(stripeGatewayFromEnv({ APP_ENV: "production" })).toBeNull();
    resetEnvCache();
    expect(env().PAYMENTS_STRIPE).toBeUndefined();
    expect(stripeGatewayFromEnv(env())).toBeNull();
    expect(() => paymentGateways.forRail("aed_card")).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
    expect(() => paymentGateways.forRail("inr_pacb")).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
    expect(paymentGateways.forProvider("stripe")).toBeNull();
  });

  it("one gateway per configuration: the account check runs once per process", () => {
    const a = stripeGatewayFromEnv(BASE)!;
    expect(a).toBeInstanceOf(StripeGateway);
    expect(stripeGatewayFromEnv({ ...BASE })).toBe(a);
    expect(stripeGatewayFromEnv({ ...BASE, STRIPE_RAILS: "aed_card,inr_pacb" })).not.toBe(a);
    expect(stripeGatewayFromEnv({ ...BASE, STRIPE_SECRET_KEY: `${"sk_test"}_PLACEHOLDER999` })).not.toBe(a);
  });

  it("both rails resolve to one instance; forProvider('stripe') answers it once", () => {
    const gw = stripe(testConfig({ rails: ["aed_card", "inr_pacb"] }));
    const r = createGatewayRegistry([gw], { production: false });
    expect(r.forRail("aed_card")).toBe(gw);
    expect(r.forRail("inr_pacb")).toBe(gw);
    expect(r.forProvider("stripe")).toBe(gw);
    expect(gw.account()).toEqual({ provider: "stripe", accountId: ACCOUNT_ID, environment: "test", rail: "aed_card" });

    const aedOnly = createGatewayRegistry([stripe()], { production: false });
    expect(() => aedOnly.forRail("inr_pacb")).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
  });

  it("serves Stripe only in its own environment; fakes are still refused in production", () => {
    const test = stripe();
    const live = stripe(liveConfig());
    expect(createGatewayRegistry([test], { production: false }).forRail("aed_card")).toBe(test);
    expect(() => createGatewayRegistry([test], { production: true }).forRail("aed_card")).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
    expect(createGatewayRegistry([test], { production: true }).forProvider("stripe")).toBeNull();
    expect(createGatewayRegistry([live], { production: true }).forRail("aed_card")).toBe(live);
    expect(() => createGatewayRegistry([live], { production: false }).forRail("aed_card")).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));

    const fake = new FakeAedCardGateway();
    const prod = createGatewayRegistry([live, fake, new FakeInrPacbGateway()], { production: true });
    expect(prod.forRail("aed_card")).toBe(live);
    expect(() => prod.forRail("inr_pacb")).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
    expect(prod.forProvider("fake-aed-card")).toBeNull();
    expect(prod.forProvider("fake-inr-pacb")).toBeNull();
  });

  it("a gateway that only looks like Stripe is refused", () => {
    const real = stripe();
    const impostor = { ...real, account: () => real.account(), capabilities: real.capabilities.bind(real), rails: () => real.rails() } as unknown as StripeGateway;
    expect(() => createGatewayRegistry([impostor], { production: false }).forRail("aed_card")).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
  });

  it("a duplicate rail or provider throws", () => {
    expect(() => createGatewayRegistry([stripe(), new FakeAedCardGateway()], { production: false })).toThrow("Two gateways for rail aed_card");
    expect(() => createGatewayRegistry([stripe(testConfig({ rails: ["aed_card", "inr_pacb"] })), new FakeInrPacbGateway()], { production: false })).toThrow("Two gateways for rail inr_pacb");
    expect(() => createGatewayRegistry([stripe(), stripe(testConfig({ rails: ["inr_pacb"] }))], { production: false })).toThrow("Two gateways for provider stripe");
    const one = stripe();
    expect(() => createGatewayRegistry([one, one], { production: false })).toThrow("Two gateways for rail aed_card");
    // Stripe for AED beside the INR fake is allowed outside production.
    const mixed = createGatewayRegistry([stripe(), new FakeInrPacbGateway()], { production: false });
    expect(mixed.forProvider("stripe")).not.toBeNull();
    expect(mixed.forProvider("fake-inr-pacb")).not.toBeNull();
  });

  it("the process registry serves what the composition root supplies, built on first use", () => {
    const gw = stripe(testConfig({ rails: ["aed_card", "inr_pacb"] }));
    let built = 0;
    configurePaymentGateways(() => (built++, { gateways: [gw], production: false }));
    expect(built).toBe(0);
    expect(paymentGateways.forRail("inr_pacb")).toBe(gw);
    expect(paymentGateways.forProvider("stripe")).toBe(gw);
    expect(built).toBe(1);
    configurePaymentGateways(() => ({ gateways: [gw], production: true }));
    expect(() => paymentGateways.forRail("aed_card")).toThrow(expect.objectContaining({ code: "NOT_CONFIGURED" }));
  });

  it("railForCurrency is unchanged", () => {
    expect(railForCurrency("INR")).toBe("inr_pacb");
    expect(railForCurrency("AED")).toBe("aed_card");
    for (const c of ["USD", "aed", "inr", "", "EUR"]) expect(railForCurrency(c), c).toBeNull();
  });
});

describe("no network", () => {
  it("a real Stripe client in the unit project fails before reaching api.stripe.com", async () => {
    // The unit setup blocks every non-loopback socket; refuse to run the call at all if it did not.
    expect((globalThis as unknown as Record<symbol, boolean>)[Symbol.for("outly.test.egressBlocked")]).toBe(true);
    const client = createStripeClient(testConfig({ timeoutMs: 5_000 }));
    const e = await client.accounts.retrieveCurrent().then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(Stripe.errors.StripeConnectionError);
    expect((e as Stripe.errors.StripeError).detail).toBeInstanceOf(EgressBlockedError);
    expect(String(((e as Stripe.errors.StripeError).detail as Error).message)).toContain("api.stripe.com");
  });
});
