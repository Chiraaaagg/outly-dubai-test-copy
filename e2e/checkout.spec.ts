import { expect, test, type Page } from "@playwright/test";
import { expectInvalidFieldsDescribed, standardChecks } from "./support/a11y";

/**
 * `/checkout` (PRD-9, PRD-10; criteria 1 and 2).
 *
 *  - A cart with any inquiry product goes to `/inquiry` (the mixed-cart
 *    rule); the inquiry page has one page heading.
 *  - An all-instant cart: the enclosed checkout shows one `h1` (the step
 *    heading) and the Stepper, and a failed step moves focus to the first problem and links
 *    each error to its field. (The server still decides whether it can be
 *    paid; a refused quote says why and offers `/inquiry` with the details.)
 *
 * The cart is planted in localStorage (`outlyy.cart.v1`, the app provider's
 * key) with synthetic items; nothing is quoted or paid.
 */

const CART_KEY = "outlyy.cart.v1";

function item(fulfilmentMode: "inquiry" | "instant", n: number) {
  return {
    id: `zz-e2e-${fulfilmentMode}-${n}`,
    kind: "activity",
    slug: `zz-e2e-${fulfilmentMode}-${n}`,
    title: `Synthetic ${fulfilmentMode} experience ${n}`,
    image: "/icon.svg",
    date: "2030-01-15",
    time: "10:00",
    pax: { adult: 2, child: 0, infant: 0, senior: 0 },
    addOnIds: [],
    unit: { inr: 5000, aed: 220 },
    total: { inr: 10000, aed: 440 },
    confirmation: fulfilmentMode === "instant" ? "instant" : "manual",
    fulfilmentMode,
    freeCancellationHours: 24,
    durationMinutes: 120,
  };
}

async function plantCart(page: Page, items: unknown[]): Promise<void> {
  await page.addInitScript(([key, value]) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage blocked */
    }
  }, [CART_KEY, JSON.stringify(items)] as const);
}

async function settled(page: Page): Promise<"inquiry" | "checkout"> {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // The redirect runs after hydration; wait until the page stops moving.
  await page.waitForLoadState("networkidle");
  return new URL(page.url()).pathname === "/inquiry" ? "inquiry" : "checkout";
}

test.describe("/checkout", () => {
  test("a cart with an inquiry product goes to /inquiry, which has one page heading", async ({ page }) => {
    await plantCart(page, [item("instant", 1), item("inquiry", 2)]);
    await page.goto("/checkout");
    await expect(page).toHaveURL(/\/inquiry\?from=checkout&reason=mixed$/);
    // CO-07: never moved without a reason.
    await expect(page.getByTestId("inquiry-reason")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  });

  test("an all-instant cart: one h1, real step headings, and a failed step points at its errors", async ({ page }) => {
    await plantCart(page, [item("instant", 1)]);
    await page.goto("/checkout");
    if ((await settled(page)) === "inquiry") {
      test.info().annotations.push({ type: "note", description: "The server refused the synthetic cart, so it went to /inquiry." });
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      return;
    }
    // Batch 2: the step heading is the page's one h1, and the Stepper is a named landmark with every step.
    await expect(page.getByRole("heading", { level: 1, name: "Your details" })).toHaveCount(1);
    const progress = page.getByRole("navigation", { name: "Booking progress" });
    await expect(progress).toBeVisible();
    await expect(progress.getByRole("listitem")).toHaveCount(4);
    // Enclosed checkout (CO-23): no storefront search or footer sitemap, but the legal links stay.
    await expect(page.getByTestId("checkout-header")).toBeVisible();
    await expect(page.locator("footer")).toHaveCount(1);
    const legal = page.getByTestId("checkout-footer");
    await expect(legal.getByRole("link", { name: "Privacy" })).toBeVisible();
    await expect(legal.getByRole("button", { name: "Cookie settings" })).toBeVisible();

    await page.getByRole("button", { name: "Continue to review" }).click();
    // Focus moves to the step heading, an error summary, or the first invalid field (criterion 1).
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return "body";
      if (/^H[1-6]$/.test(el.tagName)) return "heading";
      if (el.getAttribute("role") === "alert" || el.closest('[role="alert"]')) return "alert";
      if (el.getAttribute("aria-invalid") === "true") return "invalid-field";
      return `other:${el.tagName.toLowerCase()}#${el.id}`;
    });
    expect(["heading", "alert", "invalid-field"]).toContain(focused);
    expect(await expectInvalidFieldsDescribed(page)).toBeGreaterThan(0);
  });
});

standardChecks({
  name: "/checkout with an inquiry cart (lands on /inquiry)",
  path: "/checkout",
  before: (page) => plantCart(page, [item("inquiry", 1)]),
  ready: async (page) => {
    await expect(page).toHaveURL(/\/inquiry\?from=checkout&reason=mixed$/);
    await settled(page);
  },
  primary: (page) => page.locator("#main").getByRole("button", { name: /^Send inquiry/ }).filter({ visible: true }).first(),
});

standardChecks({
  name: "/checkout with an all-instant cart",
  path: "/checkout",
  before: (page) => plantCart(page, [item("instant", 1)]),
  ready: async (page) => {
    await settled(page);
  },
  primary: (page) => page.locator("#main").getByRole("button", { name: /^(Continue to review|Send inquiry)/ }).filter({ visible: true }).first(),
});
