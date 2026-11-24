import { describe, expect, it } from "vitest";
import {
  assertTravelDeskMutationAllowed,
  travelDeskMutationRefusal,
  expectedBaseUrl,
  TRAVELDESK_MIN_MUTATION_TIMEOUT_MS,
  traveldeskConfigFrom,
  traveldeskConfigProblems,
  traveldeskMode,
  traveldeskProductionReadOnlyConfigFrom,
  type TravelDeskConfig,
  type TravelDeskEnvSlice,
} from "../traveldesk/traveldesk.config";

const KEY = "test-key-not-real";
const TEST_BASE = "https://testapi.traveldesk.me/public/b2b/v1";
const PROD_BASE = "https://api.traveldesk.me/public/b2b/v1";

const liveTest: TravelDeskEnvSlice = {
  APP_ENV: "development",
  SUPPLIER_ADAPTER_TRAVELDESK: "live",
  TRAVELDESK_ENV: "test",
  TRAVELDESK_API_BASE_URL: TEST_BASE,
  TRAVELDESK_API_KEY: KEY,
};

function expectRefused(env: TravelDeskEnvSlice, pattern: RegExp) {
  const problems = traveldeskConfigProblems(env);
  expect(problems.some((p) => pattern.test(p)), `problems: ${JSON.stringify(problems)}`).toBe(true);
  expect(traveldeskConfigFrom(env)).toBeNull();
  expect(traveldeskMode(env)).toBe("live_unconfigured");
  expect(JSON.stringify(problems)).not.toContain(KEY);
}

describe("traveldeskConfigFrom / traveldeskMode", () => {
  it("mock (explicit or default) yields no config and mode mock, whatever else is set", () => {
    for (const env of [{}, { SUPPLIER_ADAPTER_TRAVELDESK: "mock" as const }, { ...liveTest, SUPPLIER_ADAPTER_TRAVELDESK: "mock" as const }]) {
      expect(traveldeskConfigFrom(env)).toBeNull();
      expect(traveldeskMode(env)).toBe("mock");
    }
  });

  it("pins the agency id when it is a positive integer, and refuses anything else (SUP-10)", () => {
    expect(traveldeskConfigFrom({ ...liveTest, TRAVELDESK_AGENCY_ID: "4242" })?.agencyId).toBe("4242");
    expect(traveldeskConfigFrom({ ...liveTest, TRAVELDESK_AGENCY_ID: 4242 })?.agencyId).toBe("4242");
    for (const bad of ["0", "-1", "12a", "1.5"]) {
      expect(traveldeskConfigProblems({ ...liveTest, TRAVELDESK_AGENCY_ID: bad })).toContain("TRAVELDESK_AGENCY_ID must be the agency's numeric id");
      expect(traveldeskConfigFrom({ ...liveTest, TRAVELDESK_AGENCY_ID: bad })).toBeNull();
    }
  });

  it("live + test happy path with defaults", () => {
    expect(traveldeskConfigProblems(liveTest)).toEqual([]);
    expect(traveldeskConfigFrom(liveTest)).toEqual<TravelDeskConfig>({
      environment: "test",
      baseUrl: TEST_BASE,
      host: "testapi.traveldesk.me",
      apiKey: KEY,
      mutationTimeoutMs: 150_000,
      readTimeoutMs: 20_000,
      bookingsEnabled: false,
      agencyId: null,
    });
    expect(traveldeskMode(liveTest)).toBe("live");
  });

  it("staging app and an unset APP_ENV may use the test API", () => {
    expect(traveldeskConfigFrom({ ...liveTest, APP_ENV: "staging" })).not.toBeNull();
    expect(traveldeskConfigFrom({ ...liveTest, APP_ENV: undefined })).not.toBeNull();
  });

  it("accepts a trailing slash and normalises it away", () => {
    for (const url of [`${TEST_BASE}/`, `${TEST_BASE}//`]) {
      const cfg = traveldeskConfigFrom({ ...liveTest, TRAVELDESK_API_BASE_URL: url });
      expect(cfg?.baseUrl).toBe(TEST_BASE);
    }
  });

  it("bookingsEnabled only when the flag is exactly true", () => {
    expect(traveldeskConfigFrom({ ...liveTest, TRAVELDESK_BOOKINGS_ENABLED: true })?.bookingsEnabled).toBe(true);
    expect(traveldeskConfigFrom({ ...liveTest, TRAVELDESK_BOOKINGS_ENABLED: false })?.bookingsEnabled).toBe(false);
  });

  it("live + production is accepted only with APP_ENV=production and the production host", () => {
    const prod: TravelDeskEnvSlice = { ...liveTest, APP_ENV: "production", TRAVELDESK_ENV: "production", TRAVELDESK_API_BASE_URL: PROD_BASE };
    expect(traveldeskConfigProblems(prod)).toEqual([]);
    expect(traveldeskConfigFrom(prod)).toMatchObject({ environment: "production", host: "api.traveldesk.me", baseUrl: PROD_BASE });
    expect(expectedBaseUrl("production")).toBe(PROD_BASE);
    expect(expectedBaseUrl("test")).toBe(TEST_BASE);
  });
});

describe("traveldeskConfigProblems — refusals", () => {
  it("host must match the environment", () => {
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: PROD_BASE }, /host must be testapi\.traveldesk\.me when TRAVELDESK_ENV=test/);
    expectRefused(
      { ...liveTest, APP_ENV: "production", TRAVELDESK_ENV: "production", TRAVELDESK_API_BASE_URL: TEST_BASE },
      /host must be api\.traveldesk\.me when TRAVELDESK_ENV=production/,
    );
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: "https://evil.example/public/b2b/v1" }, /host must be/);
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: "https://testapi.traveldesk.me.evil.example/public/b2b/v1" }, /host must be/);
  });

  it("URL shape: https only, no port, no credentials, no query or fragment, exact path", () => {
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: "http://testapi.traveldesk.me/public/b2b/v1" }, /must use https/);
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: "https://testapi.traveldesk.me:8443/public/b2b/v1" }, /must not set a port/);
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: `https://user:${KEY}@testapi.traveldesk.me/public/b2b/v1` }, /must not carry credentials/);
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: `https://${KEY}@testapi.traveldesk.me/public/b2b/v1` }, /must not carry credentials/);
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: `${TEST_BASE}?key=${KEY}` }, /must not have a query or fragment/);
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: `${TEST_BASE}#frag` }, /must not have a query or fragment/);
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: "https://testapi.traveldesk.me" }, /path must be \/public\/b2b\/v1/);
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: "https://testapi.traveldesk.me/" }, /path must be/);
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: "https://testapi.traveldesk.me/public/b2b" }, /path must be/);
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: `${TEST_BASE}/public/b2b/v1` }, /path must be/);
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: `${TEST_BASE}/tours` }, /path must be/);
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: "testapi.traveldesk.me/public/b2b/v1" }, /not a URL/);
  });

  it("missing base URL or environment", () => {
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: undefined }, /TRAVELDESK_API_BASE_URL is missing/);
    expectRefused({ ...liveTest, TRAVELDESK_API_BASE_URL: "" }, /TRAVELDESK_API_BASE_URL is missing/);
    expectRefused({ ...liveTest, TRAVELDESK_ENV: undefined }, /TRAVELDESK_ENV must be/);
  });

  it("APP_ENV and TRAVELDESK_ENV must pair up", () => {
    expectRefused({ ...liveTest, APP_ENV: "production" }, /APP_ENV=production must not use the TravelDesk test environment/);
    for (const appEnv of ["development", "staging", undefined] as const) {
      expectRefused(
        { ...liveTest, APP_ENV: appEnv, TRAVELDESK_ENV: "production", TRAVELDESK_API_BASE_URL: PROD_BASE },
        /TRAVELDESK_ENV=production is only allowed when APP_ENV=production/,
      );
    }
  });

  it("key must be present and free of whitespace", () => {
    expectRefused({ ...liveTest, TRAVELDESK_API_KEY: undefined }, /TRAVELDESK_API_KEY is missing/);
    expectRefused({ ...liveTest, TRAVELDESK_API_KEY: "" }, /TRAVELDESK_API_KEY is missing/);
    for (const key of [`${KEY} `, ` ${KEY}`, "test-key not-real", `${KEY}\n`, `Bearer ${KEY}`]) {
      const env = { ...liveTest, TRAVELDESK_API_KEY: key };
      const problems = traveldeskConfigProblems(env);
      expect(problems).toContain("TRAVELDESK_API_KEY contains whitespace");
      expect(traveldeskConfigFrom(env)).toBeNull();
      for (const p of problems) expect(p).not.toContain(KEY);
    }
  });

  it("read timeout must be within [1000, 120000]", () => {
    expectRefused({ ...liveTest, TRAVELDESK_READ_TIMEOUT_MS: 999 }, /TRAVELDESK_READ_TIMEOUT_MS must be between 1000 and 120000/);
    expectRefused({ ...liveTest, TRAVELDESK_READ_TIMEOUT_MS: 120_001 }, /TRAVELDESK_READ_TIMEOUT_MS/);
    expectRefused({ ...liveTest, TRAVELDESK_READ_TIMEOUT_MS: 0 }, /TRAVELDESK_READ_TIMEOUT_MS/);
    expect(traveldeskConfigFrom({ ...liveTest, TRAVELDESK_READ_TIMEOUT_MS: 1_000 })?.readTimeoutMs).toBe(1_000);
    expect(traveldeskConfigFrom({ ...liveTest, TRAVELDESK_READ_TIMEOUT_MS: 120_000 })?.readTimeoutMs).toBe(120_000);
  });

  it("mutation timeout must be between 120000 and 240000 (fits the worker budget)", () => {
    expect(TRAVELDESK_MIN_MUTATION_TIMEOUT_MS).toBe(120_000);
    expectRefused({ ...liveTest, TRAVELDESK_TIMEOUT_MS: 119_999 }, /TRAVELDESK_TIMEOUT_MS must be between 120000 and 240000/);
    expectRefused({ ...liveTest, TRAVELDESK_TIMEOUT_MS: 240_001 }, /TRAVELDESK_TIMEOUT_MS must be between/);
    expectRefused({ ...liveTest, TRAVELDESK_TIMEOUT_MS: 30_000 }, /TRAVELDESK_TIMEOUT_MS/);
    expect(traveldeskConfigFrom({ ...liveTest, TRAVELDESK_TIMEOUT_MS: 120_000 })?.mutationTimeoutMs).toBe(120_000);
  });

  it("reports every problem at once and never echoes the key", () => {
    const env: TravelDeskEnvSlice = {
      APP_ENV: "production",
      SUPPLIER_ADAPTER_TRAVELDESK: "live",
      TRAVELDESK_ENV: "test",
      TRAVELDESK_API_BASE_URL: `http://${KEY}@evil.example:8080/x?k=${KEY}`,
      TRAVELDESK_API_KEY: `${KEY} `,
      TRAVELDESK_READ_TIMEOUT_MS: 5,
      TRAVELDESK_TIMEOUT_MS: 5,
    };
    const problems = traveldeskConfigProblems(env);
    expect(problems.length).toBeGreaterThanOrEqual(9);
    expect(JSON.stringify(problems)).not.toContain(KEY);
    expect(JSON.stringify(problems)).not.toContain("evil.example");
  });
});

describe("assertTravelDeskMutationAllowed", () => {
  const base = traveldeskConfigFrom(liveTest) as TravelDeskConfig;

  it("refuses when not configured", () => {
    expect(() => assertTravelDeskMutationAllowed(null)).toThrow(/not configured/);
  });

  it("refuses production without the agency pinned, even with bookings enabled", () => {
    const prod: TravelDeskConfig = { ...base, environment: "production", host: "api.traveldesk.me", baseUrl: PROD_BASE, bookingsEnabled: true, agencyId: null };
    expect(() => assertTravelDeskMutationAllowed(prod)).toThrow(/TRAVELDESK_AGENCY_ID/);
    expect(travelDeskMutationRefusal(prod)).toMatch(/TRAVELDESK_AGENCY_ID/);
  });

  it("refuses production with bookings disabled, even with the agency pinned", () => {
    const prod: TravelDeskConfig = { ...base, environment: "production", host: "api.traveldesk.me", baseUrl: PROD_BASE, bookingsEnabled: false, agencyId: "7001" };
    expect(() => assertTravelDeskMutationAllowed(prod)).toThrow(/TRAVELDESK_BOOKINGS_ENABLED/);
  });

  it("refuses a production TravelDesk config on a Vercel preview deployment", () => {
    const prodSlice: TravelDeskEnvSlice = { APP_ENV: "production", SUPPLIER_ADAPTER_TRAVELDESK: "live", TRAVELDESK_ENV: "production", TRAVELDESK_API_BASE_URL: PROD_BASE, TRAVELDESK_API_KEY: KEY, TRAVELDESK_BOOKINGS_ENABLED: true, TRAVELDESK_AGENCY_ID: "7001" };
    expect(traveldeskConfigProblems({ ...prodSlice, VERCEL_ENV: "preview" })).toEqual(expect.arrayContaining([expect.stringMatching(/VERCEL_ENV=production/)]));
    expect(traveldeskConfigProblems({ ...prodSlice, VERCEL_ENV: "production" })).toEqual([]);
    expect(traveldeskConfigProblems(prodSlice)).toEqual([]);
  });

  it("allows production with bookings enabled and the agency pinned (activation approved 18 Nov 2026)", () => {
    const prod: TravelDeskConfig = { ...base, environment: "production", host: "api.traveldesk.me", baseUrl: PROD_BASE, bookingsEnabled: true, agencyId: "7001" };
    expect(() => assertTravelDeskMutationAllowed(prod)).not.toThrow();
    expect(travelDeskMutationRefusal(prod)).toBeNull();
  });

  it("refuses test with bookings disabled", () => {
    expect(base.bookingsEnabled).toBe(false);
    expect(() => assertTravelDeskMutationAllowed(base)).toThrow(/TRAVELDESK_BOOKINGS_ENABLED/);
  });

  it("allows test with bookings enabled", () => {
    const enabled = traveldeskConfigFrom({ ...liveTest, TRAVELDESK_BOOKINGS_ENABLED: true });
    expect(() => assertTravelDeskMutationAllowed(enabled)).not.toThrow();
  });
});

describe("traveldeskConfigProblems — non-numeric timeouts", () => {
  it("NaN read or mutation timeouts are refused, not passed to AbortSignal", () => {
    expectRefused({ ...liveTest, TRAVELDESK_READ_TIMEOUT_MS: Number.NaN }, /TRAVELDESK_READ_TIMEOUT_MS/);
    expectRefused({ ...liveTest, TRAVELDESK_TIMEOUT_MS: Number.NaN }, /TRAVELDESK_TIMEOUT_MS/);
  });
});

describe("traveldeskProductionReadOnlyConfigFrom (local read-only probe only)", () => {
  const prod: TravelDeskEnvSlice = {
    APP_ENV: "development",
    SUPPLIER_ADAPTER_TRAVELDESK: "live",
    TRAVELDESK_ENV: "production",
    TRAVELDESK_API_BASE_URL: PROD_BASE,
    TRAVELDESK_API_KEY: KEY,
    TRAVELDESK_BOOKINGS_ENABLED: false,
  };

  it("allows a production key locally, always with bookings off", () => {
    const r = traveldeskProductionReadOnlyConfigFrom(prod);
    expect("problems" in r).toBe(false);
    expect(r).toMatchObject({ environment: "production", host: "api.traveldesk.me", bookingsEnabled: false });
    // Bookings are always off here, so mutations stay refused whatever the agency.
    expect(() => assertTravelDeskMutationAllowed(r as TravelDeskConfig)).toThrow(/TRAVELDESK_BOOKINGS_ENABLED/);
    expect(() => assertTravelDeskMutationAllowed({ ...(r as TravelDeskConfig), agencyId: "7001" })).toThrow(/TRAVELDESK_BOOKINGS_ENABLED/);
  });

  it("refuses bookings enabled, the test environment, APP_ENV=production and a wrong host", () => {
    const problems = (env: TravelDeskEnvSlice) => {
      const r = traveldeskProductionReadOnlyConfigFrom(env);
      return "problems" in r ? r.problems.join("; ") : "";
    };
    expect(problems({ ...prod, TRAVELDESK_BOOKINGS_ENABLED: true })).toMatch(/BOOKINGS_ENABLED/);
    expect(problems({ ...prod, TRAVELDESK_ENV: "test", TRAVELDESK_API_BASE_URL: TEST_BASE })).toMatch(/must be 'production'/);
    expect(problems({ ...prod, APP_ENV: "production" })).toMatch(/locally only/);
    expect(problems({ ...prod, TRAVELDESK_API_BASE_URL: TEST_BASE })).toMatch(/host must be api\.traveldesk\.me/);
    expect(problems({ ...prod, TRAVELDESK_API_KEY: undefined })).toMatch(/KEY is missing/);
  });

  it("the app path still refuses the same production config outside APP_ENV=production", () => {
    expect(traveldeskConfigFrom(prod)).toBeNull();
  });
});
