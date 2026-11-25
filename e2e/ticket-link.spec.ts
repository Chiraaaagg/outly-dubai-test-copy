import { expect, test } from "@playwright/test";
import { expectPrivateHeaders, recordRequests, standardChecks } from "./support/a11y";

/**
 * `/t#<token>`: the emailed booking link (TKT-5, F39).
 *
 *  - Opening the page sends nothing: no request to /api/tickets/exchange
 *    until the visitor presses the button, so a mail scanner or link
 *    preview consumes nothing, even one that runs script.
 *  - The token is removed from the address bar on load and is never stored.
 *  - The button posts the token once (same-origin JSON). A synthetic token
 *    is refused with the uniform 404 and the page says the link is not
 *    valid, moving focus to that heading (criterion 1).
 */

/** Plausible shape (43 base64url characters), matches no grant. */
const TOKEN = "zzE2eSyntheticTokenNotIssued0000000000000AB";
const EXCHANGE = "/api/tickets/exchange";

test.describe("/t booking link", () => {
  test("loading the page sends nothing and removes the token from the URL", async ({ page }) => {
    const requests = recordRequests(page);
    const res = await page.goto(`/t#${TOKEN}`);
    expectPrivateHeaders(res);
    await expect(page.getByTestId("open-booking")).toBeVisible();
    await page.waitForLoadState("networkidle");
    // Give any deferred effect a moment to (wrongly) fire.
    await page.waitForTimeout(500);
    expect(requests.to(EXCHANGE), "exchange requests before the click").toEqual([]);
    expect(requests.urls.some((u) => u.href.includes(TOKEN)), "a request URL carried the token").toBe(false);
    expect(page.url()).not.toContain(TOKEN);
    expect(new URL(page.url()).hash).toBe("");
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
    expect(stored).not.toContain(TOKEN);
    expect(await page.title()).not.toContain(TOKEN);
  });

  test("a link preview without script consumes nothing", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      const requests = recordRequests(page);
      const res = await page.goto(`/t#${TOKEN}`);
      expect(res?.status()).toBe(200);
      await page.waitForLoadState("networkidle");
      expect(requests.to(EXCHANGE)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("the button posts the token once; a refused link says so and moves focus", async ({ page }) => {
    const requests = recordRequests(page);
    await page.goto(`/t#${TOKEN}`);
    const button = page.getByTestId("open-booking");
    await expect(button).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(requests.to(EXCHANGE)).toEqual([]);

    const exchange = page.waitForRequest((r) => new URL(r.url()).pathname === EXCHANGE);
    await button.click();
    const req = await exchange;
    expect(req.method()).toBe("POST");
    expect(req.headers()["content-type"] ?? "").toMatch(/^application\/json/);
    expect(req.postDataJSON()).toEqual({ token: TOKEN });
    const res = await req.response();
    expect(res?.status()).toBe(404);
    expectPrivateHeaders(res);

    const heading = page.getByRole("heading", { level: 1, name: /expired|isn.t valid/i });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
    await expect(page.locator("#main").getByRole("link", { name: "Find my booking" })).toBeVisible();
    expect(requests.to(EXCHANGE)).toHaveLength(1);
  });

  test("without a token the page offers recovery and sends nothing", async ({ page }) => {
    const requests = recordRequests(page);
    await page.goto("/t");
    await expect(page.getByRole("heading", { level: 1, name: /expired|isn.t valid/i })).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(requests.to(EXCHANGE)).toEqual([]);
  });
});

test.describe("ticket documents without access (checkout redesign batch 3)", () => {
  /** Well-formed, matches no document. */
  const DOC = "/api/tickets/documents/0190e2e0-0000-7000-8000-00000000d0c1";
  /** Shaped like a signed access entry (v1.<grant id>.<exp>.<hmac>), signed by nobody. */
  const FORGED = `outlyy_ticket_access=v1.0190e2e0-0000-7000-8000-00000000d0c2.${Math.floor(Date.now() / 1000) + 3600}.${"0".repeat(64)}`;

  test("a document URL is the uniform private 404 that names no file, with or without a forged access cookie", async ({ request }) => {
    const bodies: string[] = [];
    const variants: Record<string, string>[] = [{}, { cookie: FORGED }];
    for (const headers of variants) {
      const res = await request.get(DOC, { headers });
      expect(res.status()).toBe(404);
      const h = res.headers();
      expect(h["cache-control"]).toBe("private, no-store");
      expect(h["referrer-policy"]).toBe("no-referrer");
      expect(h["content-disposition"]).toBeUndefined();
      expect(h["set-cookie"]).toBeUndefined();
      bodies.push(await res.text());
    }
    expect(bodies[0]).toBe(bodies[1]);
  });
});

standardChecks({
  name: "/t with a token (ready to open)",
  path: `/t#${TOKEN}`,
  ready: async (page) => {
    await expect(page.getByTestId("open-booking")).toBeVisible();
  },
  primary: (page) => page.getByTestId("open-booking"),
});

standardChecks({
  name: "/t without a token",
  path: "/t",
  ready: async (page) => {
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  },
  primary: (page) => page.locator("#main").getByRole("link", { name: "Find my booking" }),
});
