import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { resetEnvCache } from "../../lib/env";
import { setTurnstileUrlForTests, TURNSTILE_ACTION, verifyTurnstile } from "../turnstile";

/**
 * Turnstile server check (Group B; review 103 finding 10): the action must be
 * present and exactly ours. A fake siteverify endpoint on loopback answers
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
