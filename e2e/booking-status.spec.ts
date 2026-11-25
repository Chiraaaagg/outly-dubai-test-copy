import { expect, test } from "@playwright/test";
import { expectPrivateHeaders, OTHER_UNKNOWN_REFERENCE, recordRequests, standardChecks, UNKNOWN_REFERENCE } from "./support/a11y";

/**
 * `/booking/<reference>` and `/booking/confirmation` for a browser that may
 * not see the order (PRD-15, F22, F23). Both show the same neutral "find
 * your booking" state: it never repeats the reference, never says whether
 * the order exists, and never claims a payment or booking succeeded, whatever
 * the URL says.
 */

const NEUTRAL = "find-your-booking";
const SUCCESS_CLAIM = /\b(confirmed|payment received|you're booked|booking is confirmed|tickets are ready)\b/i;

test.describe("/booking/<reference> without access", () => {
  test("an unknown and a malformed reference look the same, and neither is repeated", async ({ page }) => {
    const res = await page.goto(`/booking/${UNKNOWN_REFERENCE}`);
    expectPrivateHeaders(res);
    const neutral = page.getByTestId(NEUTRAL);
    await expect(neutral).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    const unknown = (await neutral.innerText()).trim();
    await expect(page.locator("#main")).not.toContainText(UNKNOWN_REFERENCE);
    await expect(page.locator("#main")).not.toContainText(SUCCESS_CLAIM);
    expect(await page.title()).not.toContain(UNKNOWN_REFERENCE);

    await page.goto("/booking/not-a-reference");
    await expect(page.getByTestId(NEUTRAL)).toBeVisible();
    expect((await page.getByTestId(NEUTRAL).innerText()).trim()).toBe(unknown);
  });

  test("the status API gives the one uniform 404 with private headers", async ({ request }) => {
    for (const ref of [UNKNOWN_REFERENCE, "not-a-reference"]) {
      const res = await request.get(`/api/orders/${ref}/status`);
      expect(res.status(), ref).toBe(404);
      expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe("NOT_FOUND");
      expect(res.headers()["cache-control"]).toBe("private, no-store");
      expect(res.headers()["referrer-policy"]).toBe("no-referrer");
      expect(res.headers()["x-robots-tag"] ?? "").toMatch(/noindex/);
    }
  });
});

test.describe("/booking/confirmation without a visible order", () => {
  test("no reference: the neutral state, no success claim", async ({ page }) => {
    const res = await page.goto("/booking/confirmation");
    expectPrivateHeaders(res);
    await expect(page.getByTestId(NEUTRAL)).toBeVisible();
    await expect(page.locator("#main")).not.toContainText(SUCCESS_CLAIM);
  });

  test("a reference and success-looking parameters in the URL change nothing", async ({ page }) => {
    const requests = recordRequests(page);
    await page.goto(`/booking/confirmation?ref=${OTHER_UNKNOWN_REFERENCE}&status=success&paid=1&payment_status=captured`);
    await expect(page.getByTestId(NEUTRAL)).toBeVisible();
    await expect(page.locator("#main")).not.toContainText(SUCCESS_CLAIM);
    await expect(page.locator("#main")).not.toContainText(OTHER_UNKNOWN_REFERENCE);
    // It asked the server, and stayed here when the server said no.
    expect(requests.to(`/api/orders/${OTHER_UNKNOWN_REFERENCE}/status`).length).toBeGreaterThan(0);
    expect(new URL(page.url()).pathname).toBe("/booking/confirmation");
  });

  test("Stripe's return hints (?result=success|cancel) add one neutral sentence and never a claim or access (CO-08)", async ({ page }) => {
    for (const hint of ["success", "cancel"] as const) {
      const res = await page.goto(`/booking/confirmation?result=${hint}`);
      expectPrivateHeaders(res);
      await expect(page.getByTestId(NEUTRAL)).toBeVisible();
      const note = page.getByTestId("return-note");
      await expect(note).toBeVisible();
      await expect(note).toContainText(hint === "cancel" ? "You left Stripe's payment page." : "If you've just paid");
      await expect(note).toContainText(/don't pay again/i);
      await expect(page.locator("#main")).not.toContainText(SUCCESS_CLAIM);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    }
    // An unknown value is no hint at all.
    await page.goto("/booking/confirmation?result=paid");
    await expect(page.getByTestId(NEUTRAL)).toBeVisible();
    await expect(page.getByTestId("return-note")).toHaveCount(0);
    // The status page with a hint and no access is the same neutral state.
    await page.goto(`/booking/${UNKNOWN_REFERENCE}?result=success`);
    await expect(page.getByTestId(NEUTRAL)).toBeVisible();
    await expect(page.locator("#main")).not.toContainText(SUCCESS_CLAIM);
    await expect(page.locator("#main")).not.toContainText(UNKNOWN_REFERENCE);
  });

  test("a stored hint for an order this browser may not see is not trusted, and old snapshots are deleted", async ({ page }) => {
    // The checkout leaves only the reference (`outlyy.orderRef`); older builds left a whole snapshot (`outlyy.lastOrder`).
    await page.addInitScript((ref) => {
      try {
        sessionStorage.setItem("outlyy.orderRef", ref);
        sessionStorage.setItem("outlyy.lastOrder", JSON.stringify({ reference: ref, status: "confirmed", paid: true, leadName: "zz-e2e" }));
      } catch {
        /* storage blocked: nothing to plant */
      }
    }, UNKNOWN_REFERENCE);
    const requests = recordRequests(page);
    await page.goto("/booking/confirmation");
    await expect(page.getByTestId(NEUTRAL)).toBeVisible();
    await expect(page.locator("#main")).not.toContainText(SUCCESS_CLAIM);
    await expect(page.locator("#main")).not.toContainText(UNKNOWN_REFERENCE);
    expect(requests.to(`/api/orders/${UNKNOWN_REFERENCE}/status`).length).toBeGreaterThan(0);
    expect(await page.evaluate(() => sessionStorage.getItem("outlyy.lastOrder"))).toBeNull();
  });
});

standardChecks({
  name: "/booking/<reference> neutral state",
  path: `/booking/${UNKNOWN_REFERENCE}`,
  ready: async (page) => {
    await expect(page.getByTestId(NEUTRAL)).toBeVisible();
  },
  primary: (page) => page.getByTestId(NEUTRAL).getByRole("link", { name: "Find my booking" }),
});

standardChecks({
  name: "/booking/confirmation neutral state",
  path: "/booking/confirmation",
  ready: async (page) => {
    await expect(page.getByTestId(NEUTRAL)).toBeVisible();
  },
  primary: (page) => page.getByTestId(NEUTRAL).getByRole("link", { name: "Find my booking" }),
});
