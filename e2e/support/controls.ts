import { mkdirSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page, type Route } from "@playwright/test";
import type { PickupHotelsResult } from "../../src/server/services/pickup-hotels.service";
import type { PublicStartTimes } from "../../src/server/services/start-times.service";
import type { Activity, CartItem } from "../../src/lib/types";

/**
 * Helpers for the browser and accessibility checks of the new controls
 * (e2e/a11y-*.spec.ts; doc 29 §3.5 accessibility requirements, §7.4 "Browser").
 *
 * The two public reads behind the controls are answered in the browser:
 * `/api/catalog/start-times` and `/api/catalog/pickup-hotels` get synthetic
 * bodies typed against the server's own result types (`PublicStartTimes`,
 * `PickupHotelsResult`), so a contract change breaks the type check here.
 * Nothing reaches a supplier: the app runs with every adapter on its mock,
 * and these routes never reach the app either.
 *
 * `preparePage` keeps the page on the app's own origin: a request to any
 * other origin is refused, and every image (the catalogue's photography, and
 * the app's own `/_next/image` optimiser, which would fetch it server side)
 * gets a small grey placeholder. Screenshots therefore hold only the
 * repository's catalogue copy, the synthetic fixtures and grey boxes. It also
 * stores the cookie choice "Reject all" (the privacy-preserving answer), so
 * the banner does not cover the controls under test.
 */

/** The axe rule sets of the gate for the new controls: WCAG 2.0 A and AA, and WCAG 2.1 AA. */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21aa"] as const;

/**
 * A serious axe finding already known when this gate was written, with the
 * reason it does not fail the run. Each one names its rule and the exact
 * element (a pattern over axe's target selector), so any other finding, of
 * the same rule elsewhere included, still fails. Remove an entry once its
 * cause is fixed. Listed in docs/accessibility-and-performance.md §12.
 */
export interface KnownAxeIssue {
  rule: string;
  /** A pattern over axe's target selector. */
  target?: RegExp;
  /** A pattern over the element's own HTML (axe's `node.html`): for a stable `data-` hook that the selector may not name. */
  html?: RegExp;
  why: string;
}

/** Whether a known issue covers one axe node: every pattern it names must match. */
export function knownAxeIssueMatches(k: KnownAxeIssue, rule: string, node: { target: readonly unknown[]; html: string }): boolean {
  if (k.rule !== rule || (!k.target && !k.html)) return false;
  return (!k.target || k.target.test(node.target.join(" "))) && (!k.html || k.html.test(node.html));
}

export const KNOWN_AXE_ISSUES: readonly KnownAxeIssue[] = [
  // The star rating in product page reviews (aria-prohibited-attr) was fixed with role="img" (review 85 B2a): no entry.
  {
    // TRACKED KNOWN DEFECT (review 85 B2b), not a false positive: WCAG 2.1.1 Keyboard. Under 640 px the photo rail
    // scrolls sideways and nothing in it can take focus, so keyboard and switch users cannot reach photos 2 and 3.
    // Owner: whoever owns src/components/commerce/gallery.tsx. Fix: tabIndex={0}, role="region", aria-label and a
    // visible focus ring on the rail (or each photo a button that opens the lightbox); then delete this entry.
    // TODO(test): once fixed, add a phone-width spec that Tabs into the rail, scrolls it with the arrow keys and runs axe.
    rule: "scrollable-region-focusable",
    target: /\.sm\\:hidden\.relative > \.-mx-4\.rail$/,
    why: "TRACKED DEFECT (WCAG 2.1.1, review 85 B2b): the product page photo rail on phones scrolls sideways but holds nothing focusable (src/components/commerce/gallery.tsx). Not part of the new controls; to be fixed by the gallery's owner.",
  },
  {
    // Matched by its data- hook, not a Tailwind class string (review 85 B2c), and only this rule on this element.
    rule: "scrollable-region-focusable",
    html: /^<div\b[^>]*\bdata-combobox-scroll\b/,
    why: "Hotel Combobox: the list's scroll box holds options that are reached with aria-activedescendant from the filter (focus never leaves the filter), which axe cannot see; the arrow keys scroll it. To be confirmed in the screen reader pass (Batch 3 follow-up).",
  },
];

/**
 * Lets finite animations and transitions finish (a panel or summary fading
 * in is otherwise measured mid-fade by the contrast rule). Infinite ones
 * (loading skeletons) are left running.
 */
export async function settleAnimations(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .every((a) => a.playState !== "running"),
    undefined,
    { timeout: 5_000 },
  );
}

/**
 * axe over the whole page with WCAG_TAGS, after the page settles: no serious
 * or critical finding outside KNOWN_AXE_ISSUES. Known findings that occur are
 * recorded as annotations on the test (shown in the HTML report).
 */
export async function expectAxeClean(page: Page): Promise<void> {
  await settleAnimations(page);
  const results = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze();
  const unexpected: string[] = [];
  for (const v of results.violations) {
    if (v.impact !== "serious" && v.impact !== "critical") continue;
    for (const node of v.nodes) {
      const target = node.target.join(" ");
      const known = KNOWN_AXE_ISSUES.find((k) => knownAxeIssueMatches(k, v.id, node));
      if (known) test.info().annotations.push({ type: "known axe issue", description: `${v.id} ${target}: ${known.why}` });
      else unexpected.push(`${v.impact} ${v.id}: ${v.help} (${target})`);
    }
  }
  expect(unexpected, `axe serious/critical violations (${WCAG_TAGS.join(", ")}) outside KNOWN_AXE_ISSUES`).toEqual([]);
}

/** 1 x 1 grey PNG. */
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mO8+x8AAuMB8DtXNJsAAAAASUVORK5CYII=",
  "base64",
);

const baseOrigin = () => new URL(test.info().project.use.baseURL ?? "http://localhost:3000").origin;

export interface OffSite {
  /** Requests refused because they named another origin. */
  refused: string[];
}

export async function preparePage(page: Page): Promise<OffSite> {
  const origin = baseOrigin();
  const seen: OffSite = { refused: [] };
  // The banner's own record for "Reject all" (src/lib/consent.ts: outlyy_consent, version 1).
  const consent = { v: 1, measurement: false, marketing: false, at: new Date().toISOString() };
  await page.context().addCookies([{ name: "outlyy_consent", value: encodeURIComponent(JSON.stringify(consent)), url: origin, sameSite: "Lax" }]);
  const image = (route: Route) => route.fulfill({ status: 200, contentType: "image/png", body: PLACEHOLDER_PNG });
  await page.route(
    (url) => url.protocol.startsWith("http") && url.origin !== origin,
    (route) => {
      if (route.request().resourceType() === "image") return image(route);
      seen.refused.push(new URL(route.request().url()).origin);
      return route.abort("blockedbyclient");
    },
  );
  await page.route((url) => url.origin === origin && url.pathname === "/_next/image", image);
  return seen;
}

/* ------------------------------------------------------------- start times */

export interface StartTimesFake {
  /** The `date` of every start-times read the page made, in order. */
  dates: string[];
}

/** Answers `GET /api/catalog/start-times` with `answer(date)`; records the dates asked. */
export async function fakeStartTimes(page: Page, answer: (date: string) => PublicStartTimes): Promise<StartTimesFake> {
  const origin = baseOrigin();
  const fake: StartTimesFake = { dates: [] };
  await page.route(
    (url) => url.origin === origin && url.pathname === "/api/catalog/start-times",
    (route) => {
      const date = new URL(route.request().url()).searchParams.get("date") ?? "";
      fake.dates.push(date);
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(answer(date)) });
    },
  );
  return fake;
}

/** A listed-start answer as the server builds it (`source: "supplier"`). */
export function listedStarts(times: Extract<PublicStartTimes, { source: "supplier" }>["times"]): PublicStartTimes {
  return { source: "supplier", checkedAt: new Date().toISOString(), stale: false, times };
}

/* ------------------------------------------------------------ pickup hotels */

export interface PickupHotelsFake {
  calls: number;
  /** Replaces the answer for the next reads (e.g. after "Try again"). */
  set(result: PickupHotelsResult): void;
}

/** Answers `GET /api/catalog/pickup-hotels` with `result` (changeable with `set`). */
export async function fakePickupHotels(page: Page, result: PickupHotelsResult): Promise<PickupHotelsFake> {
  const origin = baseOrigin();
  let current = result;
  const fake: PickupHotelsFake = {
    calls: 0,
    set: (r) => {
      current = r;
    },
  };
  await page.route(
    (url) => url.origin === origin && url.pathname === "/api/catalog/pickup-hotels",
    (route) => {
      fake.calls += 1;
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify(current) });
    },
  );
  return fake;
}

/* ---------------------------------------------------------------- the shop */

/**
 * The live catalogue's entry for `slug`, which must sell instantly: the
 * fixture (scripts/shop/a11y-fixture.ts) wrote its verdict and the app runs
 * with INSTANT_RELEASE_ENABLED=true. Throws (never skips) otherwise.
 */
export async function instantActivity(request: APIRequestContext, slug: string): Promise<Activity> {
  const res = await request.get("/api/catalog");
  expect(res.ok(), "GET /api/catalog").toBe(true);
  const body = (await res.json()) as { activities?: Activity[] };
  const activity = body.activities?.find((a) => a.slug === slug);
  if (!activity) throw new Error(`${slug} is not in the live catalogue: run the synthetic shop (scripts/shop/a11y.sh)`);
  if (activity.fulfilmentMode !== "instant" || !activity.productId) {
    throw new Error(`${slug} is not instant in the live catalogue: run scripts/shop/a11y-fixture.ts and start the app with INSTANT_RELEASE_ENABLED=true (scripts/shop/a11y.sh)`);
  }
  return activity;
}

const CART_KEY = "outlyy.cart.v1";

/** A cart line for `activity` as the booking widget builds it (`toCartItem`), with synthetic guests. */
export function cartLine(activity: Activity, opts: { date: string; time: string; variantId: string }): CartItem {
  const adult = activity.price.adult;
  return {
    id: `${activity.slug}-${opts.date}-${opts.time}-${opts.variantId}`,
    kind: "activity",
    slug: activity.slug,
    title: activity.title,
    image: "/icon.svg",
    date: opts.date,
    time: opts.time,
    variantId: opts.variantId,
    pax: { adult: 2, child: 0, infant: 0, senior: 0 },
    addOnIds: [],
    unit: adult,
    total: { inr: adult.inr * 2, aed: adult.aed * 2 },
    confirmation: activity.confirmation,
    fulfilmentMode: "instant",
    freeCancellationHours: activity.freeCancellationHours,
    durationMinutes: activity.durationMinutes,
  };
}

/** Plants the cart in localStorage before the first script runs (the app provider's key). */
export async function plantCart(page: Page, items: CartItem[]): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* storage blocked */
      }
    },
    [CART_KEY, JSON.stringify(items)] as const,
  );
}

export async function readCart(page: Page): Promise<CartItem[]> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]") as CartItem[], CART_KEY);
}

/** `yyyy-mm-dd` in Dubai, `days` from today (the storefront's service dates are Dubai days). */
export function dubaiDate(days: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + days * 86_400_000));
}

/* ------------------------------------------------------------------ checks */

/** The focused element is `target`, matches `:focus-visible` and shows an outline or a ring. */
export async function expectVisibleFocusOn(target: Locator): Promise<void> {
  await expect(target).toBeFocused();
  const focus = await target.evaluate((el) => {
    const s = getComputedStyle(el);
    const outline = s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) > 0;
    const ring = s.boxShadow !== "none" && s.boxShadow !== "";
    return { visible: el.matches(":focus-visible"), outline, ring };
  });
  expect(focus.visible, "focus is :focus-visible").toBe(true);
  expect(focus.outline || focus.ring, "the focused control shows an outline or a ring").toBe(true);
}

/** The id of the focused element (empty when it has none). */
export async function focusedId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.id ?? "");
}

/**
 * Every element `controls` matches is laid out inside the viewport's width,
 * at least 44 x 44 CSS px when `minTarget` is set, and does not cut its own
 * content (scrollWidth within clientWidth): "no clipped controls".
 */
export async function expectControlsInside(page: Page, controls: Locator, opts: { minTarget?: boolean } = {}): Promise<void> {
  const count = await controls.count();
  expect(count, "controls to check").toBeGreaterThan(0);
  const boxes = await controls.evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        name: (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim().slice(0, 40),
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height,
        overflow: el.scrollWidth - el.clientWidth,
        viewport: document.documentElement.clientWidth,
      };
    }),
  );
  for (const b of boxes) {
    expect(b.width, `${b.name}: laid out`).toBeGreaterThan(0);
    expect(b.left, `${b.name}: left edge inside the viewport`).toBeGreaterThanOrEqual(-0.5);
    expect(b.right, `${b.name}: right edge inside the viewport (${b.viewport} px)`).toBeLessThanOrEqual(b.viewport + 0.5);
    expect(b.overflow, `${b.name}: content not cut off`).toBeLessThanOrEqual(1);
    if (opts.minTarget) {
      expect(b.width, `${b.name}: at least 44 px wide`).toBeGreaterThanOrEqual(44);
      expect(b.height, `${b.name}: at least 44 px high`).toBeGreaterThanOrEqual(44);
    }
  }
}

/** Under reduced motion, transitions on `target` are (close to) instant. */
export async function expectInstantTransitions(target: Locator): Promise<void> {
  const durations = await target.evaluate((el) => getComputedStyle(el).transitionDuration.split(",").map((d) => Number.parseFloat(d) * (d.trim().endsWith("ms") ? 1 : 1000)));
  for (const ms of durations) expect(ms, "transition duration under reduced motion (ms)").toBeLessThanOrEqual(1);
}

/** Where the full-page screenshots for the owner's layout review go (uploaded by CI as an artifact). */
export const SCREENSHOT_DIR = path.resolve(__dirname, "../../test-results/a11y-screenshots");

/**
 * A full-page screenshot, `<name>.png`, and a close-up of `control`,
 * `<name>-control.png` (in a full-page capture the sticky header can sit over
 * a control half way down). Synthetic data only: call `preparePage` first.
 */
export async function layoutShot(page: Page, name: string, ...control: Locator[]): Promise<void> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await settleAnimations(page);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true, animations: "disabled", caret: "hide" });
  // The close-up covers every part given (an open popup sits outside its field's box), in page coordinates.
  await control[0].scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  const boxes = (await Promise.all(control.map((c) => c.boundingBox()))).filter((b): b is NonNullable<typeof b> => b !== null);
  expect(boxes.length, `${name}: the control is laid out`).toBeGreaterThan(0);
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 8);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 8);
  const right = Math.max(...boxes.map((b) => b.x + b.width)) + 8;
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + 8;
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `${name}-control.png`),
    fullPage: true,
    clip: { x: x + scroll.x, y: y + scroll.y, width: right - x, height: bottom - y },
    animations: "disabled",
    caret: "hide",
  });
}
