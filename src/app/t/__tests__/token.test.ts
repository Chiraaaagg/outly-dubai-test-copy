import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_TOKEN_LENGTH, tokenFromHash } from "../token";

/**
 * The `/t` landing reads its token from the fragment only, and exchanges it
 * only from the button (TKT-5, F39). Synthetic tokens only.
 */

describe("tokenFromHash", () => {
  it("reads a base64url token from the fragment", () => {
    expect(tokenFromHash("#AbC-123_xyz")).toBe("AbC-123_xyz");
    expect(tokenFromHash("AbC-123_xyz")).toBe("AbC-123_xyz");
  });

  it("drops anything a mail client appended", () => {
    expect(tokenFromHash("#AbC123&utm_source=mail")).toBe("AbC123");
  });

  it("refuses empty, oversized or odd fragments", () => {
    expect(tokenFromHash("")).toBeNull();
    expect(tokenFromHash("#")).toBeNull();
    expect(tokenFromHash(null)).toBeNull();
    expect(tokenFromHash(`#${"a".repeat(MAX_TOKEN_LENGTH + 1)}`)).toBeNull();
    expect(tokenFromHash("#<script>")).toBeNull();
    expect(tokenFromHash("#%E0%A4%A")).toBeNull();
  });
});

describe("/t landing source", () => {
  const dir = path.resolve(import.meta.dirname, "..");
  const landing = readFileSync(path.join(dir, "ticket-link.tsx"), "utf8");
  const page = readFileSync(path.join(dir, "page.tsx"), "utf8");

  it("imports no analytics", () => {
    for (const src of [landing, page]) {
      expect(src).not.toMatch(/from\s+["'][^"']*analytics[^"']*["']/);
      expect(src).not.toMatch(/\btrack\(/);
      expect(src).not.toMatch(/<PageView|components\/analytics/);
    }
  });

  it("calls the exchange from the button handler only", () => {
    const calls = landing.match(/exchangeTicketToken\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const handler = landing.slice(landing.indexOf("const open = async"));
    expect(handler.indexOf("exchangeTicketToken(")).toBeGreaterThan(0);
    expect(handler.indexOf("exchangeTicketToken(")).toBeLessThan(handler.indexOf("if (phase ==="));
  });

  it("removes the fragment from the address bar", () => {
    expect(landing).toMatch(/history\.replaceState\(/);
  });
});
