import { expect, test, type Page } from "@playwright/test";
import {
  expectInvalidFieldsDescribed,
  expectPrivateHeaders,
  OTHER_UNKNOWN_REFERENCE,
  recordRequests,
  standardChecks,
  UNKNOWN_REFERENCE,
} from "./support/a11y";

/**
 * `/manage-booking`: booking recovery (F23). Reference plus the booking
 * phone or email, then a one-time code.
 *
 *  - Every field has a visible label (criterion 2).
 *  - Invalid input marks the field `aria-invalid` and links the error with
 *    `aria-describedby`; focus moves to the first invalid field (1, 2).
 *  - The code step shows the same generic message whatever was typed, and
 *    never repeats the reference (no enumeration).
 *  - A refused code is announced with `role="alert"` and linked to the
 *    field (3); "Change the details" keeps what was typed (8).
 *
 * The UI flow routes the two recovery calls to the frozen contract
 * responses (src/lib/customer-status.ts) so it does not depend on rate-limit
 * state; the API tests at the end call the real server.
 *
 * Post-payment batch A1: the form offers only the channels the server can
 * deliver a code on right now (email in production while SMS codes are off).
 * The flow uses email, which is always offered; a phone choice is checked
 * only when the page offers one.
 */

const START = "/api/recovery/start";
const VERIFY = "/api/recovery/verify";
const PHONE = "9000000017";
const EMAIL = "zz-e2e@outlyy.test";

/** Picks email when the page offers a choice (it opens on the server's first channel). */
async function chooseEmail(page: Page): Promise<void> {
  const choice = page.getByLabel("My email", { exact: true });
  if (await choice.count()) await choice.check();
}

async function routeRecovery(page: Page): Promise<void> {
  await page.route(`**${START}`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify({ challengeId: "0190a0a0-0000-7000-8000-00000000e2e0" }) }),
  );
  await page.route(`**${VERIFY}`, (route) =>
    route.fulfill({ status: 400, contentType: "application/json", headers: { "cache-control": "private, no-store" }, body: JSON.stringify({ error: { code: "CODE_INVALID" } }) }),
  );
}

async function submitDetails(page: Page, reference = UNKNOWN_REFERENCE): Promise<void> {
  await page.getByLabel("Booking reference").fill(reference);
  await chooseEmail(page);
  await page.getByLabel("Email you booked with").fill(EMAIL);
  await page.getByRole("button", { name: "Send me a code" }).click();
  await expect(page.getByTestId("recovery-code-step")).toBeVisible();
}

test.describe("/manage-booking recovery", () => {
  test("headers are private and every field has a visible label", async ({ page }) => {
    const res = await page.goto("/manage-booking");
    expectPrivateHeaders(res);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByLabel("Booking reference", { exact: true })).toBeVisible();
    // A1: never a phone code while texts cannot be sent; when phone is offered, its fields are labelled too.
    if (await page.getByLabel("My phone number", { exact: true }).count()) {
      await page.getByLabel("My phone number", { exact: true }).check();
      for (const name of ["Phone number you booked with", "Country code"]) {
        await expect(page.getByLabel(name, { exact: true }), name).toBeVisible();
      }
    } else {
      await expect(page.getByTestId("code-destination")).toContainText("We'll email a 6-digit code");
      await expect(page.getByLabel("Phone number you booked with")).toHaveCount(0);
    }
    await chooseEmail(page);
    await expect(page.getByLabel("Email you booked with")).toBeVisible();
  });

  test("an empty submit sends nothing, focuses the first invalid field and links its error", async ({ page }) => {
    const requests = recordRequests(page);
    await page.goto("/manage-booking");
    await page.getByRole("button", { name: "Send me a code" }).click();
    const ref = page.getByLabel("Booking reference");
    await expect(ref).toBeFocused();
    await expect(ref).toHaveAttribute("aria-invalid", "true");
    expect(await expectInvalidFieldsDescribed(page)).toBeGreaterThan(0);
    expect(requests.to(START)).toEqual([]);

    // A malformed reference is refused the same way, without a request.
    await ref.fill("OUT-12345");
    await chooseEmail(page);
    await page.getByLabel("Email you booked with").fill(EMAIL);
    await page.getByRole("button", { name: "Send me a code" }).click();
    await expect(ref).toBeFocused();
    await expect(ref).toHaveAttribute("aria-invalid", "true");
    await expectInvalidFieldsDescribed(page);
    expect(requests.to(START)).toEqual([]);
  });

  test("the code step shows the same generic message for any details and never repeats the reference", async ({ page }) => {
    await routeRecovery(page);
    await page.goto("/manage-booking");
    const startBody = page.waitForRequest((r) => new URL(r.url()).pathname === START);
    await submitDetails(page);
    expect((await startBody).postDataJSON()).toEqual({ reference: UNKNOWN_REFERENCE, channel: "email", contact: EMAIL });

    const message = page.getByTestId("recovery-generic-message");
    await expect(message).toHaveAttribute("role", "status");
    await expect(message).toContainText("If these details match a booking");
    const first = (await message.innerText()).trim();
    await expect(page.locator("#main")).not.toContainText(UNKNOWN_REFERENCE);
    await expect(page.getByLabel("6-digit code")).toBeFocused();

    // Another reference gets exactly the same words.
    await page.getByRole("button", { name: "Change the details" }).click();
    await expect(page.getByLabel("Booking reference")).toHaveValue(UNKNOWN_REFERENCE);
    await expect(page.getByLabel("Booking reference")).toBeFocused();
    await page.getByLabel("Booking reference").fill(OTHER_UNKNOWN_REFERENCE);
    await page.getByRole("button", { name: "Send me a code" }).click();
    await expect(page.getByTestId("recovery-generic-message")).toBeVisible();
    expect((await page.getByTestId("recovery-generic-message").innerText()).trim()).toBe(first);
  });

  test("a refused code is an alert linked to the field, and focus returns to it", async ({ page }) => {
    await routeRecovery(page);
    await page.goto("/manage-booking");
    await submitDetails(page);
    const code = page.getByLabel("6-digit code");
    const verify = page.waitForRequest((r) => new URL(r.url()).pathname === VERIFY);
    await code.fill("123456");
    expect((await verify).postDataJSON()).toMatchObject({ code: "123456" });
    const alert = page.getByRole("alert").filter({ hasText: /didn.t work/ });
    await expect(alert).toBeVisible();
    await expect(code).toHaveAttribute("aria-invalid", "true");
    const alertId = await alert.getAttribute("id");
    expect(alertId).toBeTruthy();
    expect((await code.getAttribute("aria-describedby"))?.split(/\s+/)).toContain(alertId);
    await expect(code).toBeFocused();
    await expectInvalidFieldsDescribed(page);
  });

  test("the code time limit is restartable without losing the reference (criterion 8)", async ({ page }) => {
    await routeRecovery(page);
    await page.clock.install();
    await page.goto("/manage-booking");
    await submitDetails(page);
    const resend = page.getByRole("button", { name: /Send a new code/ });
    await expect(resend).toBeDisabled();
    // Past the resend wait and the usual code lifetime.
    await page.clock.runFor(5 * 60_000 + 1_000);
    await expect(page.getByText(/may have expired/)).toBeVisible();
    await expect(resend).toBeEnabled();
    const again = page.waitForRequest((r) => new URL(r.url()).pathname === START);
    await resend.click();
    expect((await again).postDataJSON()).toMatchObject({ reference: UNKNOWN_REFERENCE });
    await page.getByRole("button", { name: "Change the details" }).click();
    await expect(page.getByLabel("Booking reference")).toHaveValue(UNKNOWN_REFERENCE);
  });
});

test.describe("recovery API (real server)", () => {
  const origin = () => new URL(test.info().project.use.baseURL ?? "http://localhost:3000").origin;

  test("start answers the same shape for unknown details, with private headers", async ({ request }) => {
    const shapes: string[] = [];
    for (const [reference, contact] of [
      [UNKNOWN_REFERENCE, `+91${PHONE}`],
      [OTHER_UNKNOWN_REFERENCE, "zz-e2e@outlyy.test"],
    ] as const) {
      const res = await request.post(START, {
        headers: { origin: origin(), "content-type": "application/json" },
        data: { reference, channel: contact.startsWith("+") ? "phone" : "email", contact },
      });
      expect(res.status()).toBe(200);
      const h = res.headers();
      expect(h["cache-control"]).toBe("private, no-store");
      expect(h["referrer-policy"]).toBe("no-referrer");
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body.challengeId).toBe("string");
      shapes.push(Object.keys(body).sort().join(","));
    }
    expect(shapes[0]).toBe(shapes[1]);
  });

  test("verify refuses an unknown challenge with the one CODE_INVALID answer", async ({ request }) => {
    const res = await request.post(VERIFY, {
      headers: { origin: origin(), "content-type": "application/json" },
      data: { challengeId: "0190a0a0-0000-7000-8000-00000000e2e1", code: "123456" },
    });
    expect(res.status()).toBe(400);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe("CODE_INVALID");
    expect(res.headers()["cache-control"]).toBe("private, no-store");
    expect(res.headers()["referrer-policy"]).toBe("no-referrer");
    // A refused code grants nothing: no access cookie (batch 3 adds the checkout grant beside it, never through it).
    expect(res.headers()["set-cookie"] ?? "").not.toContain("outlyy_ticket_access=");
  });
});

standardChecks({
  name: "/manage-booking details step",
  path: "/manage-booking",
  ready: async (page) => {
    await expect(page.getByLabel("Booking reference")).toBeVisible();
  },
  primary: (page) => page.getByRole("button", { name: "Send me a code" }),
});

standardChecks({
  name: "/manage-booking code step",
  path: "/manage-booking",
  before: routeRecovery,
  ready: (page) => submitDetails(page),
  primary: (page) => page.getByRole("button", { name: "Open my booking" }),
});
