import { expect, test, type Page, type Request, type Route } from "@playwright/test";
import { expectNoHorizontalScroll, NARROW_320, recordRequests, standardChecks, UNKNOWN_REFERENCE } from "./support/a11y";
import { cleanupPlantedOrder, closeTestDb, plantMultiItemOrder, settleWithOneItemRefunded, type PlantedOrder } from "./support/db";

/**
 * Multi-item instant checkout (doc 22 §32.20): an all-instant cart of up to
 * `MAX_INSTANT_ITEMS_PER_ORDER` (5) activities is one quote, one order and
 * one card payment; a mixed cart, or more than five items, goes to inquiry.
 *
 * Two halves, because no gateway is reachable from the app here:
 *
 *  - The checkout walk. Payments stay on the fakes: with no PAYMENTS_STRIPE
 *    the app has no gateway at all (every rail NOT_CONFIGURED, and fakes can
 *    only be passed in by a test or drill, never configured), so the payment
 *    side of the walk is routed in the browser to contract-shaped responses
 *    (`QuoteResponse`, the verification pair and `POST /api/checkout`,
 *    src/lib/api/index.ts) and the fake AED gateway's hosted page. What is
 *    checked is what the browser sends and shows: one quote request carrying
 *    every line in cart order, every item listed with its charged amount, the
 *    exact total on the summary and the pay button, card as the only method,
 *    one checkout request for that quote, then the hosted page. The catalogue
 *    response is the live one plus synthetic instant products (database ids
 *    the routed quote prices). The server side of one quote → one order is
 *    the payments DB suite's (saga-multi.db-suite.ts).
 *  - The status page. A three-item order is planted in the disposable test
 *    database exactly as checkout and the saga leave it after the capture
 *    (e2e/support/db.ts), for the guest session that made its quote, and the
 *    real page renders the server's own projection: every item "processing"
 *    until the saga settles, then each item its own outcome.
 *
 * A production build walks the same checkout, but only ever opens Stripe's
 * hosted page: the fake gateway's page is refused and the visitor lands on
 * /inquiry (checkout-gate.ts, doc 22 §32.34). All data is synthetic.
 */

const CART_KEY = "outlyy.cart.v1";
const DEV = Boolean(process.env.E2E_NEXT_DEV);
const HOSTED = "https://fake-aed-card.invalid";
const GUEST_COOKIE = "outlyy_guest_session";

/** Synthetic AED prices: per adult, two adults per item. */
const AED_PER_ADULT = [220, 260, 305, 180, 150, 140];

function productId(n: number): string {
  return `0190e2e0-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

function cartItem(n: number, fulfilmentMode: "instant" | "inquiry" = "instant") {
  const aed = AED_PER_ADULT[(n - 1) % AED_PER_ADULT.length];
  return {
    id: `zz-e2e-multi-${fulfilmentMode}-${n}`,
    kind: "activity",
    slug: `zz-e2e-multi-${n}`,
    title: `Synthetic instant experience ${n}`,
    image: "/icon.svg",
    date: `2030-02-${String(10 + n).padStart(2, "0")}`,
    time: "10:00",
    variantId: "zz-std",
    pax: { adult: 2, child: 0, infant: 0, senior: 0 },
    addOnIds: [],
    unit: { inr: aed * 25, aed },
    total: { inr: aed * 50, aed: aed * 2 },
    confirmation: fulfilmentMode === "instant" ? "instant" : "manual",
    fulfilmentMode,
    freeCancellationHours: 24,
    durationMinutes: 120,
  };
}

const instantCart = (n: number) => Array.from({ length: n }, (_, i) => cartItem(i + 1));

async function plantCart(page: Page, items: unknown[]): Promise<void> {
  await page.addInitScript(([key, value]) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage blocked */
    }
  }, [CART_KEY, JSON.stringify(items)] as const);
}

/** The live catalogue plus one synthetic instant product per cart slug, each with one variant and a database id. */
async function routeCatalog(page: Page, count: number): Promise<void> {
  await page.route("**/api/catalog", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { activities: Array<Record<string, unknown>>; categories?: unknown[] };
    const template = body.activities[0];
    const variants = template.variants as Array<Record<string, unknown>>;
    const synthetic = Array.from({ length: count }, (_, i) => ({
      ...template,
      id: `act-zz-e2e-multi-${i + 1}`,
      slug: `zz-e2e-multi-${i + 1}`,
      title: `Synthetic instant experience ${i + 1}`,
      productId: productId(i + 1),
      fulfilmentMode: "instant",
      confirmation: "instant",
      pickupIncluded: false,
      addOns: [],
      variants: [{ ...variants[0], id: "zz-std", delta: { inr: 0, aed: 0 } }],
    }));
    await route.fulfill({ response: res, json: { ...body, activities: [...body.activities, ...synthetic] } });
  });
}

interface PaymentSide {
  quotes: Array<Record<string, unknown>>;
  verifyStarts: Array<Record<string, unknown>>;
  verifies: Array<Record<string, unknown>>;
  checkouts: Array<Record<string, unknown>>;
  quoteId: string;
  verificationId: string;
  hostedUrl: string;
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify(body) });

/**
 * The payment side as its contract answers: a quote pricing each requested
 * line at the cart's own figure (so no price change), a challenge and a
 * verification for that quote, then the fake AED gateway's hosted page.
 */
async function routePaymentSide(page: Page): Promise<PaymentSide> {
  const side: PaymentSide = {
    quotes: [],
    verifyStarts: [],
    verifies: [],
    checkouts: [],
    quoteId: "0190e2e0-0000-7000-8000-0000000a0001",
    verificationId: "0190e2e0-0000-7000-8000-0000000b0001",
    hostedUrl: `${HOSTED}/pay/order_fakeaedcard_zze2e_1`,
  };
  const body = (r: Request) => r.postDataJSON() as Record<string, unknown>;
  await page.route("**/api/quotes", async (route) => {
    const req = body(route.request());
    side.quotes.push(req);
    const lines = (req.lines as Array<Record<string, unknown>>).map((l, index) => {
      const n = Number(String(l.productId).slice(-12));
      const chargedMinor = String(AED_PER_ADULT[(n - 1) % AED_PER_ADULT.length] * 2 * 100);
      return {
        index,
        productId: l.productId,
        variantId: l.variantId,
        serviceDate: l.serviceDate,
        slotRef: l.slotRef,
        units: l.units,
        addonIds: [],
        chargedMinor,
        discountAllocMinor: "0",
        taxAllocMinor: "0",
        freeCancellationUntilUtc: null,
        freeCancellationCopy: "Non-refundable once the operator confirms.",
        nonRefundableAfterConfirm: true,
      };
    });
    const totalMinor = lines.reduce((s, l) => s + BigInt(l.chargedMinor), 0n).toString();
    await json(route, 201, { ok: true, quoteId: side.quoteId, currency: req.currency, totalMinor, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), lines });
  });
  await page.route("**/api/checkout/verify/start", async (route) => {
    side.verifyStarts.push(body(route.request()));
    await json(route, 200, { challengeId: "0190e2e0-0000-7000-8000-0000000c0001" });
  });
  await page.route("**/api/checkout/verify", async (route) => {
    side.verifies.push(body(route.request()));
    await json(route, 200, { verificationId: side.verificationId, channel: "phone", verifiedAt: new Date().toISOString() });
  });
  await page.route("**/api/checkout", async (route) => {
    side.checkouts.push(body(route.request()));
    await json(route, 201, { orderReference: UNKNOWN_REFERENCE, redirectUrl: side.hostedUrl });
  });
  await page.route(`${HOSTED}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Fake gateway</title><h1>Fake AED card gateway</h1>" }),
  );
  return side;
}

async function fillDetails(page: Page): Promise<void> {
  await page.getByLabel("Full name").fill("Zz E2e Traveller");
  await page.getByLabel("Email").fill("zz-e2e-multi@outlyy.test");
  // The Phone Input starts on the UAE (CO-24); this traveller has an Indian number.
  const country = page.getByRole("button", { name: /^Country code:/ });
  if (!(await country.getAttribute("aria-label"))?.includes("+91")) {
    await country.click();
    await page.getByRole("option", { name: /India/ }).click();
  }
  await page.locator("#phone").fill("9000000017");
  await page.getByRole("button", { name: "Continue to review" }).click();
}

/** The one pay action on Review & pay (batch 2; label per doc 29 §8.4 row 9): "Confirm and pay AED …". */
function payButton(page: Page) {
  return page.getByRole("button", { name: /^Confirm and pay / });
}

/** Walks a planted all-instant cart to Review & pay with the quote in, or reports /inquiry when the cart went there. */
async function toPaymentStep(page: Page): Promise<"payment" | "inquiry"> {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.waitForLoadState("networkidle");
  if (new URL(page.url()).pathname === "/inquiry") return "inquiry";
  await fillDetails(page);
  await expect(page.getByRole("heading", { level: 1, name: "Review & pay" })).toBeVisible();
  await expect(payButton(page)).toBeEnabled();
  return "payment";
}

const aed = (major: number) => `AED ${major.toLocaleString("en-AE")}`;
/** The amount as the summary and the pay button print it: "AED 1,320.00". */
const aed2 = (major: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "AED", minimumFractionDigits: 2 }).format(major);

test.describe("/checkout with several instant items", () => {
  test("a mixed cart (two instant, one inquiry) goes to /inquiry without asking for a quote", async ({ page }) => {
    const requests = recordRequests(page);
    await plantCart(page, [cartItem(1), cartItem(2), cartItem(3, "inquiry")]);
    await page.goto("/checkout");
    // The rule is unchanged; the inquiry page now says why the trip is there (CO-07).
    await expect(page).toHaveURL(/\/inquiry\?from=checkout&reason=mixed$/);
    await expect(page.getByTestId("inquiry-reason")).toContainText("confirmed by our team before you pay");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await page.waitForLoadState("networkidle");
    expect(requests.to("/api/quotes")).toEqual([]);
    expect(requests.to("/api/checkout")).toEqual([]);
  });

  test("six instant items, above the cap of five, go to /inquiry before any detail is asked", async ({ page }) => {
    const requests = recordRequests(page);
    await routeCatalog(page, 6);
    await plantCart(page, instantCart(6));
    await page.goto("/checkout");
    await expect(page).toHaveURL(/\/inquiry\?from=checkout&reason=over_limit$/);
    await expect(page.getByTestId("inquiry-reason")).toContainText("up to 5 activities");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await page.waitForLoadState("networkidle");
    expect(requests.to("/api/quotes")).toEqual([]);
    expect(requests.to("/api/checkout")).toEqual([]);
  });

  test("five instant items, the cap, stay on the checkout", async ({ page }) => {
    await routeCatalog(page, 5);
    await plantCart(page, instantCart(5));
    await page.goto("/checkout");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(/\/checkout$/);
    await expect(page.getByRole("heading", { level: 1, name: "Your details" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue to review" })).toBeVisible();
  });

  test("three instant items: one quote with every line, each item listed, the exact total, card only, one checkout request", async ({ page }) => {
    const requests = recordRequests(page);
    await routeCatalog(page, 3);
    const side = await routePaymentSide(page);
    const cart = instantCart(3);
    await plantCart(page, cart);
    await page.goto("/checkout");

    await expect(page.getByRole("heading", { level: 1, name: "Your details" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await fillDetails(page);

    // Review & pay: one quote request, every cart line in cart order, in the currency charged.
    const pay = payButton(page);
    await expect(pay).toBeEnabled();
    expect(side.quotes).toHaveLength(1);
    const q = side.quotes[0];
    expect(q.currency).toBe("AED");
    expect(q.couponCode).toBeNull();
    expect(q.lines).toEqual(
      cart.map((c, i) => ({
        productId: productId(i + 1),
        variantId: "zz-std",
        serviceDate: c.date,
        slotRef: "10:00",
        units: { adult: 2 },
        addonIds: [],
        pickup: null,
      })),
    );

    const totalMajor = cart.reduce((s, c) => s + c.total.aed, 0);
    const reviewItems = page.getByTestId("checkout-review-item");
    await expect(reviewItems).toHaveCount(3);
    for (const [i, c] of cart.entries()) {
      const row = reviewItems.nth(i);
      await expect(row).toContainText(c.title);
      await expect(row).toContainText("2 adults");
      // The quote line's own charged amount; the three add up to the subtotal.
      await expect(row).toContainText(aed(c.total.aed));
      // CO-01: once quoted, each line states the quote's own cancellation terms, not the catalogue figure.
      await expect(row.getByTestId("checkout-cancellation-line")).toHaveText("Non-refundable once the operator confirms.");
    }
    const summary = page.locator("aside").filter({ hasText: "Order summary" });
    await expect(summary).toContainText("Subtotal (3 activities)");
    await expect(summary.getByText("Total to pay").locator("..")).toContainText(aed2(totalMajor));
    await expect(summary).toContainText("This is the exact amount your card will be charged.");
    await expect(summary).not.toContainText(/UPI/);
    for (const c of cart) await expect(summary.getByTestId("summary-trip-item").filter({ hasText: c.title })).toHaveCount(1);

    // Card is the only method, so there is no chooser, and nothing on the step promises another.
    const main = page.locator("#main");
    await expect(main.getByRole("radio")).toHaveCount(0);
    await expect(main).toContainText("pay by card on Stripe");
    await expect(main).not.toContainText(/UPI|Netbanking|EMI|PhonePe|Paytm|RuPay/);
    // CO-12, CO-13: no card brand or wallet marks before Stripe's own page.
    await expect(main).not.toContainText(/Apple Pay|Google Pay|Amex/);

    await page.getByRole("checkbox", { name: /cancellation policy/ }).check();
    await expect(pay).toHaveAccessibleName(`Confirm and pay ${aed2(totalMajor)}`);
    await pay.click();

    // The number on the order is verified for this quote (inline OTP card), then one checkout request opens the hosted page.
    await expect(page.getByRole("heading", { name: "Confirm your mobile number" })).toBeVisible();
    expect(side.verifyStarts).toEqual([{ quoteId: side.quoteId, channel: "phone", contact: "+919000000017" }]);
    await page.getByLabel("6-digit code").fill("123456");
    if (DEV) {
      await page.waitForURL(`${side.hostedUrl}`);
      await expect(page.getByRole("heading", { name: "Fake AED card gateway" })).toBeVisible();
    } else {
      // A production build opens only Stripe's hosted Checkout: the fake gateway's page is refused (doc 22 §32.34),
      // and the page says so instead of moving the cart silently (CO-07).
      await expect(page).toHaveURL(/\/checkout$/);
      await expect(page.getByTestId("checkout-needs-inquiry")).toContainText("Nothing has been charged");
      await expect(page.getByRole("link", { name: "Send it to our team" })).toHaveAttribute("href", "/inquiry?from=checkout&reason=unavailable");
    }

    expect(side.verifies).toEqual([{ challengeId: "0190e2e0-0000-7000-8000-0000000c0001", code: "123456" }]);
    expect(side.checkouts).toEqual([
      {
        quoteId: side.quoteId,
        verificationId: side.verificationId,
        method: "card",
        traveller: { fullName: "Zz E2e Traveller", phoneE164: "+919000000017", email: "zz-e2e-multi@outlyy.test" },
      },
    ]);
    // Still one quote: nothing re-quoted on the way to payment.
    expect(side.quotes).toHaveLength(1);
    expect(requests.to("/api/quotes")).toHaveLength(1);
    expect(requests.to("/api/checkout")).toHaveLength(1);
  });

  test("back from the payment page: worded for a customer who may have paid, details kept, the same payment page again (CO-06)", async ({ page }) => {
    test.skip(!DEV, "Needs the fake gateway's hosted page, which only development builds open.");
    await routeCatalog(page, 1);
    const side = await routePaymentSide(page);
    // The order the hand-off names still awaits payment (the status API's own shape; synthetic).
    await page.route("**/api/orders/*/status", (route) =>
      json(route, 200, {
        reference: UNKNOWN_REFERENCE,
        state: "awaiting_payment",
        tone: "progress",
        headline: "Waiting for Stripe to confirm your payment.",
        nextStep: "If you've just paid, don't pay again.",
        rail: "self_serve",
        currency: "AED",
        totalMinor: "0",
        placedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        steps: { payment: { status: "in_progress", label: "Waiting for Stripe to confirm", at: null }, booking: { status: "not_started", label: "", at: null }, tickets: { status: "not_started", label: "", at: null }, refund: null },
        deadlines: { refundUntilUtc: null, remedyAtUtc: null, remedyKind: null },
        items: [],
        pollAfterMs: 5000,
      }),
    );
    await plantCart(page, instantCart(1));
    await page.goto("/checkout");
    expect(await toPaymentStep(page)).toBe("payment");
    await page.getByRole("checkbox", { name: /cancellation policy/ }).check();
    await payButton(page).click();
    await page.getByLabel("6-digit code").fill("123456");
    await page.waitForURL(`${side.hostedUrl}`);

    await page.goBack();
    const left = page.getByTestId("checkout-left-payment");
    // Stripe's confirmation may not be in yet, so the page cannot know nothing was paid.
    await expect(left).toContainText("You left the payment page.");
    await expect(left).toContainText("If you've just paid, don't pay again");
    await expect(left).toContainText("Your details are kept.");
    await expect(left).not.toContainText("Nothing was charged");
    // No way to start a second payment while the first page may still be paid.
    await expect(left.getByRole("button", { name: /Change something|Start again/ })).toHaveCount(0);
    await expect(left.getByRole("link", { name: "View booking status" })).toHaveAttribute("href", `/booking/${UNKNOWN_REFERENCE}`);

    await left.getByRole("button", { name: "Return to payment" }).click();
    await page.waitForURL(`${side.hostedUrl}`);
    // The same checkout call for the same quote: the server hands back the same page, never a second payment.
    expect(side.checkouts).toHaveLength(2);
    expect(side.checkouts[1]).toEqual(side.checkouts[0]);
    expect(side.quotes).toHaveLength(1);

    // Every detail typed is kept in this tab.
    await page.goBack();
    await expect(page.getByTestId("checkout-left-payment")).toBeVisible();
    await expect(page.getByLabel("Full name")).toHaveValue("Zz E2e Traveller");
    await expect(page.getByLabel("Email")).toHaveValue("zz-e2e-multi@outlyy.test");
    await expect(page.locator("#phone")).toHaveValue("9000000017");
  });

  test.describe("320 px wide", () => {
    test.use(NARROW_320);
    test("three items on the payment step: no horizontal scroll", async ({ page }) => {
      await routeCatalog(page, 3);
      await routePaymentSide(page);
      await plantCart(page, instantCart(3));
      await page.goto("/checkout");
      const where = await toPaymentStep(page);
      expect(where).toBe("payment");
      await expect(page.getByTestId("checkout-review-item")).toHaveCount(3);
      await expectNoHorizontalScroll(page);
    });
  });
});

standardChecks({
  name: "/checkout with three instant items, at Review & pay",
  path: "/checkout",
  before: async (page) => {
    await routeCatalog(page, 3);
    await routePaymentSide(page);
    await plantCart(page, instantCart(3));
  },
  ready: async (page) => {
    await toPaymentStep(page);
  },
  primary: (page) => page.locator("#main").getByRole("button", { name: /^(Confirm and pay|Send inquiry)/ }).filter({ visible: true }).first(),
});

/* ---------------------------------------------------------------- status */

async function asQuoteBrowser(page: Page, order: PlantedOrder): Promise<void> {
  const base = test.info().project.use.baseURL ?? "http://localhost:3000";
  await page.context().addCookies([{ name: GUEST_COOKIE, value: order.guestToken, url: base, httpOnly: true, sameSite: "Lax" }]);
}

test.describe("/booking/<reference> for a three-item order", () => {
  let order: PlantedOrder | null = null;

  test.afterEach(async () => {
    await cleanupPlantedOrder(order);
    order = null;
  });
  test.afterAll(async () => {
    await closeTestDb();
  });

  test("every item shows processing until the order settles, then each item its own outcome", async ({ page }) => {
    order = await plantMultiItemOrder();
    await asQuoteBrowser(page, order);
    await page.goto(`/booking/${order.reference}`);

    const status = page.getByTestId("order-status");
    await expect(status).toHaveAttribute("data-state", "booking_processing");
    await expect(status).toContainText("Payment received. We're booking your 3 activities with the operator.");
    // CO-05 / TKT-8 (batch 1 review fix 5, F3): one per-activity remedy sentence with the remedy time,
    // and the Deadline box saying the same with "by then".
    await expect(status).toContainText(/If the operator hasn't confirmed an activity by .+, you get its amount back automatically\./);
    const deadline = page.getByTestId("remedy-deadline");
    await expect(deadline).toHaveCount(1);
    await expect(deadline).toContainText("Confirmation deadline:");
    await expect(deadline).toContainText("If the operator hasn't confirmed an activity by then, you get its amount back automatically.");
    const items = page.getByTestId("order-item");
    await expect(items).toHaveCount(3);
    for (const [i, item] of order.items.entries()) {
      const row = items.filter({ hasText: item.title });
      await expect(row, `item ${i + 1}`).toHaveCount(1);
      // Item 1's operator booking is already confirmed; it still reads as processing until the whole order settles.
      await expect(row).toHaveAttribute("data-item-state", "booking_processing");
      await expect(row).toContainText("Booking with the operator");
      // CO-15: before the operator confirms, the voucher is still to come, never "no ticket files".
      await expect(row).toContainText("Your voucher will appear here once the operator confirms.");
      await expect(row).not.toContainText("There are no ticket files");
    }
    await expect(page.locator('section[aria-labelledby="items-heading"] > p')).toContainText(`Total ${aed(Number(order.totalMinor) / 100)}`);

    await settleWithOneItemRefunded(order);
    await page.reload();
    await expect(status).toHaveAttribute("data-state", "partially_fulfilled");
    await expect(status).toContainText("Part of your order is booked.");
    const expected = [
      ["confirmed_ticket_pending", "Booked, voucher being prepared"],
      ["confirmed_ticket_pending", "Booked, voucher being prepared"],
      ["refunded", "Refunded"],
    ] as const;
    for (const [i, item] of order.items.entries()) {
      const row = items.filter({ hasText: item.title });
      await expect(row, `item ${i + 1}`).toHaveAttribute("data-item-state", expected[i][0]);
      await expect(row).toContainText(expected[i][1]);
    }
  });

  test("a browser that did not make the quote sees the neutral state", async ({ page }) => {
    order = await plantMultiItemOrder();
    await page.goto(`/booking/${order.reference}`);
    await expect(page.getByTestId("find-your-booking")).toBeVisible();
    await expect(page.locator("#main")).not.toContainText(order.reference);
    for (const item of order.items) await expect(page.locator("#main")).not.toContainText(item.title);
  });

  test.describe("320 px wide", () => {
    test.use(NARROW_320);
    test("before fulfilment: three items, no horizontal scroll", async ({ page }) => {
      order = await plantMultiItemOrder();
      await asQuoteBrowser(page, order);
      await page.goto(`/booking/${order.reference}`);
      await expect(page.getByTestId("order-item")).toHaveCount(3);
      await expectNoHorizontalScroll(page);
    });
  });
});

test.describe("/booking/<reference> for a three-item order before fulfilment", () => {
  let order: PlantedOrder | null = null;
  test.beforeAll(async () => {
    order = await plantMultiItemOrder();
  });
  test.afterAll(async () => {
    await cleanupPlantedOrder(order);
    order = null;
    await closeTestDb();
  });

  standardChecks({
    name: "/booking/<reference> three-item order, processing",
    path: () => `/booking/${order!.reference}`,
    privateRoute: true,
    before: async (page) => asQuoteBrowser(page, order!),
    ready: async (page) => {
      await expect(page.getByTestId("order-item")).toHaveCount(3);
    },
    primary: (page) => page.getByRole("link", { name: "Find another booking" }),
  });
});
