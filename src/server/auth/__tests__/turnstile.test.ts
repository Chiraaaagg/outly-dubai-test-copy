import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { resetEnvCache } from "../../lib/env";
import { setTurnstileUrlForTests, TURNSTILE_ACTION, turnstileHostnames, verifyTurnstile } from "../turnstile";

/**
 * Turnstile server check (Group B; review 103 finding 10): the action must be
 * present and exactly ours; in production the hostname must be exactly the
 * site host or its `www.` twin (owner decision). A fake siteverify endpoint on loopback answers
 * with whatever the test sets; Cloudflare is never called.
 */

let server: Server;
let answer: Record<string, unknown> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  setTurnstileUrlForTests(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/siteverify`);
  vi.stubEnv("TURNSTILE_SECRET_KEY", "unit-test-only");
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "unit-test-site");
  resetEnvCache();
});

afterAll(async () => {
  setTurnstileUrlForTests(null);
  vi.unstubAllEnvs();
  resetEnvCache();
  await new Promise<void>((r) => server.close(() => r()));
});

const token = "t".repeat(40);

describe("verifyTurnstile", () => {
  it("accepts success with exactly our action", async () => {
    answer = { success: true, action: TURNSTILE_ACTION, hostname: "localhost" };
    expect(await verifyTurnstile(token, undefined)).toBe("ok");
  });

  it("refuses a token without an action, with another action, or without success", async () => {
    answer = { success: true, hostname: "localhost" };
    expect(await verifyTurnstile(token, undefined)).toBe("refused");
    answer = { success: true, action: "other_widget", hostname: "localhost" };
    expect(await verifyTurnstile(token, undefined)).toBe("refused");
    answer = { success: false, action: TURNSTILE_ACTION };
    expect(await verifyTurnstile(token, undefined)).toBe("refused");
  });

  it("a missing or malformed token never reaches Cloudflare", async () => {
    answer = { success: true, action: TURNSTILE_ACTION };
    expect(await verifyTurnstile(undefined, undefined)).toBe("missing");
    expect(await verifyTurnstile("short", undefined)).toBe("missing");
  });
});

describe("Turnstile hostname in production (owner decision: the site host and its www. twin, exactly)", () => {
  it("the twin list: apex site → apex and www.; www. site → www. and apex", () => {
    expect(turnstileHostnames("https://outlyy.com")).toEqual(["outlyy.com", "www.outlyy.com"]);
    expect(turnstileHostnames("https://www.outlyy.com/")).toEqual(["www.outlyy.com", "outlyy.com"]);
  });

  const inProduction = async (siteUrl: string, fn: () => Promise<void>) => {
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", siteUrl);
    resetEnvCache();
    try {
      await fn();
    } finally {
      vi.stubEnv("APP_ENV", "development");
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
      resetEnvCache();
    }
  };
  const withHost = async (hostname: unknown) => {
    answer = { success: true, action: TURNSTILE_ACTION, hostname };
    return verifyTurnstile(token, undefined);
  };

  it("apex site: accepts the apex and www., refuses every other host", async () => {
    await inProduction("https://outlyy.com", async () => {
      expect(await withHost("outlyy.com")).toBe("ok");
      expect(await withHost("www.outlyy.com")).toBe("ok");
      for (const other of ["staging.outlyy.com", "www.www.outlyy.com", "outlyy.com.example.com", "example.com", "localhost", "OUTLYY.COM", "", undefined]) {
        expect(await withHost(other)).toBe("refused");
      }
    });
  });

  it("www. site: accepts www. and the apex, nothing else", async () => {
    await inProduction("https://www.outlyy.com", async () => {
      expect(await withHost("www.outlyy.com")).toBe("ok");
      expect(await withHost("outlyy.com")).toBe("ok");
      expect(await withHost("www.www.outlyy.com")).toBe("refused");
      expect(await withHost("app.outlyy.com")).toBe("refused");
    });
  });
});
