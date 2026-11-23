import { expect, test, type Page } from "@playwright/test";
import {
  expectInvalidFieldsDescribed,
  expectNoHorizontalScroll,
  expectNoRunningAnimations,
  expectTabReaches,
  NARROW_320,
  ZOOM_200,
} from "./support/a11y";
import { PICKUP_SLUG } from "./support/a11y-shop";
import {
  cartLine,
  dubaiDate,
  expectControlsInside,
  expectInstantTransitions,
  expectVisibleFocusOn,
  fakePickupHotels,
  focusedId,
  instantActivity,
  preparePage,
  layoutShot,
  plantCart,
  readCart,
  expectAxeClean,
  type PickupHotelsFake,
} from "./support/controls";
import type { PickupHotel } from "../src/server/services/pickup-hotels.service";
import type { Activity } from "../src/lib/types";

/**
 * Checkout hotel Combobox (doc 29 Batch 3; §3.5: WAI-ARIA 1.2 combobox
 * pattern; src/components/ui/combobox.tsx, src/components/checkout/
 * pickup-hotel-fields.tsx).
 *
 * The cart holds the synthetic shop's pickup product, instant in the
 * disposable database (scripts/shop/a11y-fixture.ts). Its pickup hotel list
 * is answered in the browser with synthetic hotels (sorted by name, as the
 * server sends them). Nothing is quoted or paid: the specs stay on the
 * details step, or leave for the inquiry form.
 *
 * Checked: the trigger, panel, filter (role combobox), listbox and options
 * with their states; keyboard-only use (Tab, ArrowDown to open, arrows, Home,
 * End, PageDown, Enter to choose, Escape to close, focus returned to the
 * trigger, Tab to "Ask our team about '…'"); the polite count; the refusals
 * (no hotel chosen, an unlisted hotel, a list that cannot be read); axe
 * (WCAG 2.0 A/AA and 2.1 AA), 320 px, 200% zoom, reduced motion, and
 * full-page screenshots for the owner's layout review.
 */

/** Synthetic hotels and areas (no real property), already in the server's order (by name). */
const HOTELS: PickupHotel[] = [
  { id: "910001", name: "Ámbar Synthetic Suites", area: "Test Marina" },
  { id: "910002", name: "Cedar Test Inn", area: "Test Creek" },
  { id: "910003", name: "Dunes Fixture Resort", area: "Test Desert Road" },
  { id: "910004", name: "Harbour Sample Hotel", area: "Test Marina" },
  { id: "910005", name: "Juniper Placeholder Hotel", area: "Test Downtown" },
  { id: "910006", name: "Lagoon Dummy Residences", area: "Test Palm" },
  { id: "910007", name: "Meadow Example Hotel", area: "Test Downtown" },
  { id: "910008", name: "Oasis Test Apartments", area: "Test Creek" },
  { id: "910009", name: "Palm Synthetic Hotel", area: "Test Palm" },
  { id: "910010", name: "Quay Fixture Inn", area: "Test Marina" },
  { id: "910011", name: "Sandstone Sample Suites", area: "Test Desert Road" },
  { id: "910012", name: "The Very Long Synthetic Grand Hotel and Residences by the Test Waterfront", area: "Test Waterfront" },
];
const UNLISTED = "Nowhere Palace";

let activity: Activity;
let variantId: string;

test.beforeAll(async ({ request }) => {
  activity = await instantActivity(request, PICKUP_SLUG);
  expect(activity.pickupIncluded, `${PICKUP_SLUG} includes hotel pickup`).toBe(true);
  variantId = activity.variants[0].id;
});

let hotels: PickupHotelsFake;

async function open(page: Page, list: "ready" | "unavailable" = "ready"): Promise<void> {
  await preparePage(page);
  hotels = await fakePickupHotels(page, list === "ready" ? { ok: true, hotels: HOTELS, asOf: new Date().toISOString() } : { ok: false, reason: "unavailable" });
  await plantCart(page, [cartLine(activity, { date: dubaiDate(5), time: "15:00", variantId })]);
  await page.goto("/checkout");
  await expect(page.getByRole("heading", { level: 1, name: "Your details" })).toBeVisible();
  await expect(trigger(page)).toBeVisible();
  if (list === "ready") await expect(trigger(page)).not.toHaveAttribute("aria-disabled", "true");
}

const trigger = (page: Page) => page.locator("#hotel");
const panel = (page: Page) => page.getByRole("dialog", { name: "Hotel for pickup" });
const filter = (page: Page) => page.getByRole("combobox", { name: "Search hotels" });
const listbox = (page: Page) => page.getByRole("listbox", { name: "Hotel for pickup" });
const count = (page: Page) => page.getByRole("status").filter({ hasText: /hotels? match/ });

async function activeOption(page: Page): Promise<string> {
  const id = await filter(page).getAttribute("aria-activedescendant");
  expect(id, "aria-activedescendant").toBeTruthy();
  return (await page.locator(`[id="${id}"]`).textContent())?.trim() ?? "";
}

async function fillDetails(page: Page): Promise<void> {
  await page.locator("#fullName").fill("Zz Synthetic Traveller");
  await page.locator("#email").fill("zz-a11y@outlyy.test");
  await page.locator("#phone").fill("501234567");
}

test.describe("checkout hotel combobox", () => {
  test("ARIA while closed: a labelled, described button that opens a dialog", async ({ page }) => {
    await open(page);
    expect(hotels.calls, "the page asked for the hotel list").toBeGreaterThan(0);
    await expect(page.getByText("Hotel for pickup", { exact: true })).toBeVisible();
    await expect(trigger(page)).toHaveRole("button");
    await expect(trigger(page)).toHaveAccessibleName(/^Hotel for pickup\s+Choose your hotel$/);
    await expect(trigger(page)).toHaveAccessibleDescription(/The operator collects you from this hotel\. Search by hotel name or area\./);
    await expect(trigger(page)).toHaveAttribute("aria-haspopup", "dialog");
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
    await expect(trigger(page)).not.toHaveAttribute("aria-controls", /.+/);
    await expect(panel(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "My hotel isn't listed" })).toBeVisible();
  });

  test("keyboard: Tab to the field, ArrowDown opens, arrows/Home/End/PageDown move, Enter chooses and focus returns; Escape closes", async ({ page }) => {
    await open(page);
    await expectTabReaches(page, trigger(page), 120);

    await page.keyboard.press("ArrowDown");
    await expect(panel(page)).toBeVisible();
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
    const panelId = await panel(page).getAttribute("id");
    await expect(trigger(page)).toHaveAttribute("aria-controls", panelId!);
    // Focus moves into the filter field (it draws no ring of its own: the open panel and the caret mark it).
    await expect(filter(page)).toBeFocused();
    await expect(filter(page)).toHaveAttribute("aria-autocomplete", "list");
    await expect(filter(page)).toHaveAttribute("aria-expanded", "true");
    const listId = await filter(page).getAttribute("aria-controls");
    await expect(page.locator(`[id="${listId}"]`)).toHaveRole("listbox");
    await expect(listbox(page).getByRole("option")).toHaveCount(HOTELS.length);
    await expect(count(page)).toHaveText(`${HOTELS.length} hotels match`);
    expect(await activeOption(page)).toContain(HOTELS[0].name);

    await page.keyboard.press("ArrowDown");
    expect(await activeOption(page)).toContain(HOTELS[1].name);
    await page.keyboard.press("End");
    expect(await activeOption(page)).toContain(HOTELS[HOTELS.length - 1].name);
    await page.keyboard.press("Home");
    expect(await activeOption(page)).toContain(HOTELS[0].name);
    await page.keyboard.press("PageDown");
    expect(await activeOption(page)).toContain(HOTELS[10].name);
    await page.keyboard.press("ArrowUp");
    expect(await activeOption(page)).toContain(HOTELS[9].name);

    await page.keyboard.press("Enter");
    await expect(panel(page)).toHaveCount(0);
    await expectVisibleFocusOn(trigger(page));
    await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
    await expect(trigger(page)).toHaveAccessibleName(new RegExp(`${HOTELS[9].name}, ${HOTELS[9].area}`));
    await expect.poll(async () => (await readCart(page))[0]?.pickupHotel).toEqual({ hotelId: HOTELS[9].id, name: HOTELS[9].name });

    // Reopening starts on the chosen hotel, marked selected; Escape closes without changing it and returns focus.
    await page.keyboard.press("Enter");
    await expect(panel(page)).toBeVisible();
    expect(await activeOption(page)).toContain(HOTELS[9].name);
    await expect(listbox(page).getByRole("option", { selected: true })).toHaveCount(1);
    await expect(listbox(page).getByRole("option", { selected: true })).toContainText(HOTELS[9].name);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    expect(await focusedId(page)).toBe("hotel");
    await expect(trigger(page)).toHaveAccessibleName(new RegExp(HOTELS[9].name));
  });

  test("typing filters by word start, accent- and case-insensitively, and the count is announced politely", async ({ page }) => {
    await open(page);
    await trigger(page).focus();
    await page.keyboard.press("Enter");
    await expect(filter(page)).toBeFocused();
    await page.keyboard.type("ambar");
    await expect(listbox(page).getByRole("option")).toHaveCount(1);
    await expect(count(page)).toHaveText("1 hotel matches");
    await expect(count(page)).toHaveAttribute("aria-live", "polite");
    await filter(page).fill("");
    await page.keyboard.type("test marina");
    await expect(listbox(page).getByRole("option")).toHaveCount(3);
    await expect(count(page)).toHaveText("3 hotels match");
    await page.keyboard.press("Enter");
    await expect(panel(page)).toHaveCount(0);
    await expect(trigger(page)).toHaveAccessibleName(new RegExp(HOTELS[0].name));
  });

  test("an unlisted hotel: no match is said, Tab reaches \"Ask our team about '…'\", Escape returns focus, Enter goes to the inquiry with the hotel in the form (not the URL)", async ({ page }) => {
    await open(page);
    await trigger(page).focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.type(UNLISTED);
    await expect(listbox(page).getByRole("option")).toHaveCount(0);
    // The listbox stays in the page, empty, so the filter's aria-controls still resolves.
    await expect(page.locator(`[id="${await filter(page).getAttribute("aria-controls")}"]`)).toHaveCount(1);
    await expect(filter(page)).toHaveAttribute("aria-expanded", "false");
    await expect(panel(page).getByText(`No hotels match “${UNLISTED}”`)).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /No hotels match/ })).toHaveText("No hotels match");

    const ask = panel(page).getByRole("button", { name: `Ask our team about “${UNLISTED}”` });
    await page.keyboard.press("Tab");
    await expectVisibleFocusOn(ask);
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expectVisibleFocusOn(trigger(page));

    await page.keyboard.press("ArrowDown");
    await page.keyboard.type(UNLISTED);
    await page.keyboard.press("Tab");
    await expect(ask).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/inquiry\?from=checkout&reason=pickup$/);
    expect(page.url()).not.toContain("Nowhere");
    await expect(page.getByTestId("inquiry-reason")).toBeVisible();
    await expect(page.locator("#iq-hotel")).toHaveValue(UNLISTED);
  });

  test("Continue without a hotel: the error summary takes focus, links to the field, and the field names its error", async ({ page }) => {
    await open(page);
    await fillDetails(page);
    await page.getByRole("button", { name: "Continue to review" }).click();
    const summary = page.getByTestId("checkout-error-summary");
    await expect(summary).toBeFocused();
    const link = summary.getByRole("link", { name: /^Pickup hotel: Choose the hotel the operator collects you from\.$/ });
    await expect(link).toBeVisible();
    await expect(summary.getByRole("link")).toHaveCount(1);
    await expect(trigger(page)).toHaveAccessibleDescription(/Choose the hotel the operator collects you from\./);

    await link.focus();
    await page.keyboard.press("Enter");
    await expectVisibleFocusOn(trigger(page));
    await page.keyboard.press("ArrowDown");
    // Open, the filter is the combobox: it carries aria-invalid and aria-required, described by the hint and the error.
    await expect(filter(page)).toHaveAttribute("aria-invalid", "true");
    await expect(filter(page)).toHaveAttribute("aria-required", "true");
    expect(await expectInvalidFieldsDescribed(page)).toBeGreaterThan(0);
    await page.keyboard.press("Enter");
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator("#hotel-error")).toHaveCount(0);
    await expect(trigger(page)).toHaveAccessibleName(new RegExp(HOTELS[0].name));
  });

  test("a list that cannot be read: said in words with Try again and the way to our team; the field stays focusable; Try again loads it", async ({ page }) => {
    await open(page, "unavailable");
    const notice = page.getByRole("status").filter({ hasText: /We can't load the pickup hotels/ });
    await expect(notice).toBeVisible();
    await expect(trigger(page)).toHaveAttribute("aria-disabled", "true");
    await trigger(page).focus();
    await expect(trigger(page)).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(panel(page)).toHaveCount(0);
    await expect(notice.getByRole("button", { name: "Ask our team about my hotel" })).toBeVisible();
    await expectAxeClean(page);

    hotels.set({ ok: true, hotels: HOTELS, asOf: new Date().toISOString() });
    await notice.getByRole("button", { name: "Try again" }).click();
    await expect(trigger(page)).not.toHaveAttribute("aria-disabled", "true");
    await expect(notice).toHaveCount(0);
  });

  test("axe with the panel closed, open, and with no match: no serious or critical violations", async ({ page }) => {
    await open(page);
    await expectAxeClean(page);
    await trigger(page).focus();
    await page.keyboard.press("ArrowDown");
    await expect(panel(page)).toBeVisible();
    await expectAxeClean(page);
    await page.keyboard.type(UNLISTED);
    await expect(panel(page).getByText(/No hotels match/)).toBeVisible();
    await expectAxeClean(page);
  });

  test("full-page screenshot at desktop size with the list open (layout review)", async ({ page }) => {
    await open(page);
    await trigger(page).focus();
    await page.keyboard.press("ArrowDown");
    await expect(panel(page)).toBeVisible();
    await layoutShot(page, "hotel-combobox-desktop", trigger(page).locator(".."), panel(page));
  });

  for (const [label, size, shot] of [
    ["320 px wide", NARROW_320, "hotel-combobox-320px"],
    ["200% zoom (640 x 360 CSS px at deviceScaleFactor 2)", ZOOM_200, "hotel-combobox-zoom-200"],
  ] as const) {
    test.describe(label, () => {
      test.use(size);
      test("no horizontal scroll; field, panel and rows inside the viewport, unclipped, 44 px targets; keyboard still works; axe clean", async ({ page }) => {
        await open(page);
        await trigger(page).scrollIntoViewIfNeeded();
        await expectNoHorizontalScroll(page);
        await expectControlsInside(page, trigger(page), { minTarget: true });
        await trigger(page).focus();
        await page.keyboard.press("ArrowDown");
        await expect(panel(page)).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectControlsInside(page, panel(page));
        await expectControlsInside(page, listbox(page).getByRole("option"), { minTarget: true });
        // The long name wraps inside its row instead of being cut off.
        await page.keyboard.press("End");
        expect(await activeOption(page)).toContain(HOTELS[HOTELS.length - 1].name);
        await expect(listbox(page).getByRole("option").last()).toBeInViewport();
        await expectAxeClean(page);
        await layoutShot(page, shot, trigger(page).locator(".."), panel(page));
        await page.keyboard.press("Escape");
        expect(await focusedId(page)).toBe("hotel");
      });
    });
  }

  test.describe("prefers-reduced-motion: reduce", () => {
    test.use({ reducedMotion: "reduce" });
    test("opening the list runs no animation and its transition is instant", async ({ page }) => {
      await open(page);
      await trigger(page).focus();
      await page.keyboard.press("ArrowDown");
      await expect(panel(page)).toBeVisible();
      await expectInstantTransitions(panel(page));
      await expectNoRunningAnimations(page);
    });
  });
});
