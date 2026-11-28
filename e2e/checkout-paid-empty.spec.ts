import { expect, test, type Page, type Route } from "@playwright/test";
import { recordRequests } from "./support/a11y";

/**
 * The empty `/checkout` and `/cart` after a paid booking (production fix,
 * 28 Nov 2026; review 116 D3, D9, D11). The real pages, mounted in the
 * browser: the "recently paid" marker (`outlyy.recentlyPaid`, reference and
 * time only) is planted in sessionStorage, and the order's status request is
 * answered by the test (`page.route`), so no order needs to exist. Synthetic
 * reference; nothing is quoted or paid.
 */

const REF = "OUT-123455";
const STATUS_PATH = `/api/orders/${REF}/status`;
const MARKER_KEY = "outlyy.recentlyPaid";

function projection(state: string, payment: "done" | "in_progress" = "done") {
  return {
    reference: REF,
    state,
    tone: "success",
    headline: "Your synthetic activity is booked.",
    nextStep: "Your voucher is ready.",
    rail: "self_serve",
    currency: "AED",
    totalMinor: "22900",
    placedAt: "2030-01-01T10:00:00.000Z",
    updatedAt: "2030-01-01T10:43:00.000Z",
    steps: {
      payment: { status: payment, label: "Payment", at: null },
      booking: { status: "done", label: "Booking with the operator", at: null },
      tickets: { status: "done", label: "Voucher", at: null },
      refund: null,
    },
    items: [],
  };
}

async function plantMarker(page: Page): Promise<void> {
  await page.addInitScript(([key, ref]) => {
    try {
      sessionStorage.setItem(key, JSON.stringify({ reference: ref, paidAt: Date.now() }));
    } catch {
      /* storage blocked */
    }
  }, [MARKER_KEY, REF] as const);
}

async function answerStatus(page: Page, answer: (route: Route) => Promise<void>): Promise<void> {
  await page.route(`**${STATUS_PATH}`, answer);
}

const confirmed = (route: Route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(projection("confirmed")) });
const notFound = (route: Route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { code: "NOT_FOUND" } }) });

test.describe("empty /checkout and /cart after a paid booking", () => {
  test("a visible paid order: the booking on both pages, as the page heading on /checkout", async ({ page }) => {
    await plantMarker(page);
    await answerStatus(page, confirmed);

    await page.goto("/checkout");
    const title = `Your booking ${REF} is confirmed`;
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByText("You've already paid for this trip, so your cart is empty.")).toBeVisible();
    await expect(page.getByRole("link", { name: "View booking" })).toHaveAttribute("href", `/booking/${REF}`);
    await expect(page.getByRole("link", { name: "Browse experiences" })).toBeVisible();
    await expect(page.getByText("Nothing to check out yet")).toHaveCount(0);
    await expect(page.getByTestId("paid-booking-status")).toHaveText(title);

    await page.goto("/cart");
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    await expect(page.getByText("Your trip is empty")).toHaveCount(0);
  });

  test("an order this browser may not see: the usual empty state, and the marker goes", async ({ page }) => {
    await plantMarker(page);
    await answerStatus(page, notFound);
    await page.goto("/checkout");
    await expect(page.getByRole("heading", { level: 1, name: "Nothing to check out yet" })).toBeVisible();
    await expect(page.getByTestId("paid-booking-status")).toHaveText("Nothing to check out yet");
    await expect(page.locator("#main")).not.toContainText(REF);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), MARKER_KEY)).toBeNull();
  });

  test("no answer within 8 seconds: the usual empty state, then a late good answer replaces it", async ({ page }) => {
    await plantMarker(page);
    await answerStatus(page, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 11_000));
      await confirmed(route);
    });
    await page.goto("/checkout");
    await expect(page.getByRole("heading", { level: 1, name: "Nothing to check out yet" })).toBeVisible({ timeout: 10_500 });
    await expect(page.getByRole("heading", { level: 1, name: `Your booking ${REF} is confirmed` })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Nothing to check out yet")).toHaveCount(0);
  });

  test("no marker: the usual empty state, and no status request", async ({ page }) => {
    const requests = recordRequests(page);
    await page.goto("/checkout");
    await expect(page.getByRole("heading", { level: 1, name: "Nothing to check out yet" })).toBeVisible();
    await page.goto("/cart");
    await expect(page.getByRole("heading", { level: 2, name: "Your trip is empty" })).toBeVisible();
    await expect(page.getByTestId("paid-booking-status")).toHaveCount(0);
    expect(requests.urls.filter((u) => /^\/api\/orders\//.test(u.pathname))).toHaveLength(0);
  });

  test("a page restored from the back-forward cache reads the cart again and checks the marker", async ({ page }) => {
    await answerStatus(page, confirmed);
    // A cart with one line, as before the payment.
    await page.addInitScript(() => {
      try {
        if (!sessionStorage.getItem("zz-e2e-planted")) {
          sessionStorage.setItem("zz-e2e-planted", "1");
          localStorage.setItem(
            "outlyy.cart.v1",
            JSON.stringify([
              {
                id: "zz-e2e-instant-1",
                kind: "activity",
                slug: "zz-e2e-instant-1",
                title: "Synthetic instant experience 1",
                image: "/icon.svg",
                date: "2030-01-15",
                time: "10:00",
                pax: { adult: 2, child: 0, infant: 0, senior: 0 },
                addOnIds: [],
                unit: { inr: 5000, aed: 220 },
                total: { inr: 10000, aed: 440 },
                confirmation: "instant",
                fulfilmentMode: "instant",
                freeCancellationHours: 24,
                durationMinutes: 120,
              },
            ]),
          );
        }
      } catch {
        /* storage blocked */
      }
    });
    await page.goto("/cart");
    await expect(page.getByText("Synthetic instant experience 1").first()).toBeVisible();

    // Meanwhile the status page emptied the paid cart and left the marker; then Back restores this page as it was.
    await page.evaluate(([key, ref]) => {
      localStorage.setItem("outlyy.cart.v1", "[]");
      sessionStorage.setItem(key, JSON.stringify({ reference: ref, paidAt: Date.now() }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    }, [MARKER_KEY, REF] as const);
    await expect(page.getByRole("heading", { level: 2, name: `Your booking ${REF} is confirmed` })).toBeVisible();
    await expect(page.getByText("Synthetic instant experience 1")).toHaveCount(0);
  });

  test("an empty /checkout restored from the back-forward cache checks the marker again", async ({ page }) => {
    await answerStatus(page, confirmed);
    await page.goto("/checkout");
    await expect(page.getByRole("heading", { level: 1, name: "Nothing to check out yet" })).toBeVisible();
    await page.evaluate(([key, ref]) => {
      sessionStorage.setItem(key, JSON.stringify({ reference: ref, paidAt: Date.now() }));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    }, [MARKER_KEY, REF] as const);
    await expect(page.getByRole("heading", { level: 1, name: `Your booking ${REF} is confirmed` })).toBeVisible();
  });
});
