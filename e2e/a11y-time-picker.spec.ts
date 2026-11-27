import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalScroll, expectNoRunningAnimations, expectTabReaches, NARROW_320, ZOOM_200 } from "./support/a11y";
import { LISTED_START_SLUG } from "./support/a11y-shop";
import {
  cartLine,
  dubaiDate,
  expectControlsInside,
  expectInstantTransitions,
  expectVisibleFocusOn,
  fakeStartTimes,
  instantActivity,
  preparePage,
  layoutShot,
  listedStarts,
  plantCart,
  readCart,
  expectAxeClean,
  type StartTimesFake,
} from "./support/controls";
import type { Activity } from "../src/lib/types";

/**
 * Product page Time Slot Picker (doc 29 Batch 2; §3.5 accessibility
 * requirements; src/components/commerce/time-slot-picker.tsx).
 *
 * The product is the synthetic shop's listed-start product, instant in the
 * disposable database (scripts/shop/a11y-fixture.ts). Its start times are
 * answered in the browser (`listedStarts`): five times on every date, of
 * which two cannot be booked, and every time sold out on SOLD_OUT_DATE.
 *
 * Checked: the radio group and its states, keyboard-only use (Tab, arrows
 * that skip unusable times and wrap, Home, End, Enter, roving focus kept when
 * Tab leaves and comes back), the refusals ("Choose a start time first", a
 * sold-out date, a time refused at quote), axe (WCAG 2.0 A/AA and 2.1 AA, no
 * serious or critical), 320 px and 200% zoom, reduced motion, and full-page
 * screenshots for the owner's layout review.
 */

/** The listed starts on an ordinary date: 16:00, 17:30 and 20:30 can be chosen. */
const TIMES = [
  { time: "16:00", status: "available" },
  { time: "17:30", status: "limited" },
  { time: "19:00", status: "sold_out" },
  { time: "20:30", status: "available" },
  { time: "22:00", status: "unavailable" },
] as const;

/** Every time sold out on this date. */
const SOLD_OUT_DATE = dubaiDate(3);
const ORDINARY_DATE = dubaiDate(2);

let activity: Activity;

test.beforeAll(async ({ request }) => {
  activity = await instantActivity(request, LISTED_START_SLUG);
  expect(activity.pickupIncluded, `${LISTED_START_SLUG} has no pickup (its times are start times)`).toBe(false);
});

let fake: StartTimesFake;

test.beforeEach(async ({ page }) => {
  await preparePage(page);
  fake = await fakeStartTimes(page, (date) =>
    date === SOLD_OUT_DATE ? listedStarts(TIMES.map((t) => ({ time: t.time, status: "sold_out" as const }))) : listedStarts(TIMES.map((t) => ({ ...t }))),
  );
});

const group = (page: Page) => page.getByRole("radiogroup", { name: "Start time" });
const radio = (page: Page, time: string) => group(page).getByRole("radio", { name: new RegExp(`^${time}\\b`) });
const bookNow = (page: Page) => page.locator("#book").getByRole("button", { name: /^Book now/ });

async function open(page: Page, query = ""): Promise<void> {
  await page.goto(`/activities/${LISTED_START_SLUG}${query}`);
  await expect(bookNow(page), "the product renders as instant (Book now)").toBeVisible();
  if (!query.includes(SOLD_OUT_DATE)) await expect(group(page)).toBeVisible();
}

async function checkedTimes(page: Page): Promise<string[]> {
  return group(page)
    .getByRole("radio", { checked: true })
    .evaluateAll((els) => els.map((el) => el.textContent?.trim().slice(0, 5) ?? ""));
}

test.describe("product page start-time picker", () => {
  test("ARIA: one radio group named by its heading, every listed start a radio, states said in words", async ({ page }) => {
    await open(page);
    expect(fake.dates.length, "the page asked for the start times").toBeGreaterThan(0);
    const radios = group(page).getByRole("radio");
    await expect(radios).toHaveCount(TIMES.length);
    await expect(radio(page, "16:00")).toHaveAccessibleName(/^16:00$/);
    await expect(radio(page, "17:30")).toHaveAccessibleName(/^17:30\s*Few left$/);
    await expect(radio(page, "19:00")).toHaveAccessibleName(/^19:00\s*Sold out$/);
    await expect(radio(page, "22:00")).toHaveAccessibleName(/^22:00\s*Unavailable$/);
    // Unusable times stay visible, cannot be chosen and are out of the tab order.
    for (const t of ["19:00", "22:00"]) {
      await expect(radio(page, t)).toBeVisible();
      await expect(radio(page, t)).toBeDisabled();
      await expect(radio(page, t)).toHaveAttribute("tabindex", "-1");
    }
    // Nothing is chosen for the visitor; the roving tab stop is the first usable time.
    await expect(group(page).getByRole("radio", { checked: true })).toHaveCount(0);
    await expect(radio(page, "16:00")).toHaveAttribute("tabindex", "0");
    // The zone line describes the group; the live line counts the times that can be booked.
    await expect(group(page)).toHaveAccessibleDescription(/Times are Dubai time \(Asia\/Dubai, GMT\+4\)/);
    await expect(page.locator("#book").getByRole("status").filter({ hasText: /start times? available/ })).toHaveText("3 start times available");
    await expect(page.locator("#book")).toContainText("Checked with the operator at");
  });

  test("keyboard: Tab reaches the first usable time with visible focus; arrows skip unusable times and wrap; Home, End, Enter", async ({ page }) => {
    await open(page);
    await expectTabReaches(page, radio(page, "16:00"), 300);

    await page.keyboard.press("ArrowRight");
    await expectVisibleFocusOn(radio(page, "17:30"));
    expect(await checkedTimes(page)).toEqual(["17:30"]);

    await page.keyboard.press("ArrowRight"); // 19:00 is sold out
    await expectVisibleFocusOn(radio(page, "20:30"));
    await page.keyboard.press("ArrowRight"); // 22:00 is unavailable: wraps to the first
    await expectVisibleFocusOn(radio(page, "16:00"));
    await page.keyboard.press("ArrowLeft"); // wraps back, skipping 22:00
    await expectVisibleFocusOn(radio(page, "20:30"));
    await page.keyboard.press("Home");
    await expectVisibleFocusOn(radio(page, "16:00"));
    await page.keyboard.press("End"); // the last usable time, not 22:00
    await expectVisibleFocusOn(radio(page, "20:30"));
    expect(await checkedTimes(page)).toEqual(["20:30"]);

    // Down moves by one laid-out row and still lands on a usable time.
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    const afterDown = await checkedTimes(page);
    expect(afterDown).toHaveLength(1);
    expect(["17:30", "20:30"]).toContain(afterDown[0]);
    await expectVisibleFocusOn(radio(page, afterDown[0]));

    // Enter on the focused time keeps it chosen; only the checked radio is in the tab order.
    await page.keyboard.press("Enter");
    expect(await checkedTimes(page)).toEqual(afterDown);
    await expect(group(page).locator('[role="radio"][tabindex="0"]')).toHaveCount(1);

    // Tab leaves the group and Shift+Tab comes back to the chosen time (focus returned).
    await page.keyboard.press("Tab");
    await expect(radio(page, afterDown[0])).not.toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expectVisibleFocusOn(radio(page, afterDown[0]));
  });

  test("Book now without a time: the notice says why and focus moves to the first usable time", async ({ page }) => {
    await open(page);
    await bookNow(page).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#book").getByText("Choose a start time first.")).toBeVisible();
    await expect(group(page)).toHaveAccessibleDescription(/Choose a start time first\./);
    await expectVisibleFocusOn(radio(page, "16:00"));
    await expect(page).toHaveURL(new RegExp(`/activities/${LISTED_START_SLUG}`));
    expect(await readCart(page)).toEqual([]);
  });

  test("a sold-out date: no time can be chosen, said in words with the way out, and Book now does not add the trip", async ({ page }) => {
    await open(page, `?date=${SOLD_OUT_DATE}`);
    await expect(page.locator("#book").getByText(/No start times can be booked on this date\. Pick another date, or ask our team on WhatsApp\./)).toBeVisible();
    await expect(page.getByRole("radiogroup")).toHaveCount(0);
    await expect(page.locator("#book").getByRole("status").filter({ hasText: /start times/ })).toHaveText("No start times can be booked on this date");
    await expect(page.locator("#book").getByRole("link", { name: /WhatsApp/ }).or(page.locator("#book").getByRole("button", { name: /WhatsApp/ })).first()).toBeVisible();
    await bookNow(page).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#book").getByText("Choose a start time first.")).toBeVisible();
    expect(await readCart(page)).toEqual([]);
    await expectAxeClean(page);
  });

  test("a time refused at quote (?retime): the line is restored, the notice names the time, focus is on the times; the new time replaces the line", async ({ page }) => {
    const variantId = activity.variants[0].id;
    const refused = cartLine(activity, { date: ORDINARY_DATE, time: "19:00", variantId });
    await plantCart(page, [refused]);
    await page.goto(`/activities/${LISTED_START_SLUG}?${new URLSearchParams({ date: ORDINARY_DATE, retime: refused.id })}#book`);
    const notice = page.locator("#book").getByText(/^The 19:00 start can't be booked for your group on .+\. Choose another time\.$/);
    await expect(notice).toBeVisible();
    await expect(group(page)).toHaveAccessibleDescription(/The 19:00 start can't be booked/);
    await expectVisibleFocusOn(radio(page, "16:00"));
    expect(fake.dates).toContain(ORDINARY_DATE);

    await page.keyboard.press("End");
    await expectVisibleFocusOn(radio(page, "20:30"));
    await expect(notice).toHaveCount(0);
    await bookNow(page).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/checkout$/);
    const cart = await readCart(page);
    expect(cart.map((i) => ({ slug: i.slug, date: i.date, time: i.time }))).toEqual([{ slug: LISTED_START_SLUG, date: ORDINARY_DATE, time: "20:30" }]);
  });

  test("axe on the page with the picker and a chosen time: no serious or critical violations", async ({ page }) => {
    await open(page);
    await radio(page, "17:30").click();
    await expectAxeClean(page);
  });

  test("full-page screenshot at desktop size (layout review)", async ({ page }) => {
    await open(page);
    await radio(page, "17:30").click();
    await layoutShot(page, "time-picker-desktop", page.locator("#book"));
  });

  for (const [label, size, shot] of [
    ["320 px wide", NARROW_320, "time-picker-320px"],
    ["200% zoom (640 x 360 CSS px at deviceScaleFactor 2)", ZOOM_200, "time-picker-zoom-200"],
  ] as const) {
    test.describe(label, () => {
      test.use(size);
      test("no horizontal scroll; every time and Book now inside the viewport, unclipped, 44 px targets; keyboard still works; axe clean", async ({ page }) => {
        await open(page);
        await group(page).scrollIntoViewIfNeeded();
        await expectNoHorizontalScroll(page);
        await expectControlsInside(page, group(page).getByRole("radio"), { minTarget: true });
        await expectControlsInside(page, bookNow(page), { minTarget: true });
        await radio(page, "16:00").focus();
        await page.keyboard.press("ArrowRight");
        await expectVisibleFocusOn(radio(page, "17:30"));
        await expectAxeClean(page);
        await layoutShot(page, shot, page.locator("#book"));
      });
    });
  }

  test.describe("prefers-reduced-motion: reduce", () => {
    test.use({ reducedMotion: "reduce" });
    test("choosing a time runs no animation and its colour change is instant", async ({ page }) => {
      await open(page);
      await radio(page, "16:00").focus();
      await page.keyboard.press("ArrowRight");
      await expectInstantTransitions(radio(page, "17:30"));
      await expectNoRunningAnimations(page);
    });
  });
});
