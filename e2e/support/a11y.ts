import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type Response } from "@playwright/test";
import { isPrivateCustomerPath } from "../../src/lib/customer-status";

/**
 * Shared checks for the B5 customer pages, one per accessibility criterion
 * of docs/backend/reviews/2026-10-31-independent/product-preservation.md §6
 * that a browser can check automatically:
 *
 *   criterion 6 (keyboard)      expectTabReaches: Tab from the top reaches the
 *                               primary action, which shows a visible focus.
 *   criterion 7 (reflow, zoom,  expectNoHorizontalScroll at 320 px; 200% zoom
 *   reduced motion)             is a 640 x 360 CSS-pixel viewport at
 *                               deviceScaleFactor 2 (a 1280 x 720 screen at
 *                               200%: the layout viewport halves, the pixel
 *                               ratio doubles); expectNoRunningAnimations
 *                               under `prefers-reduced-motion: reduce`.
 *   criterion 9 (automated)     expectNoSeriousAxeViolations: axe-core with
 *                               wcag2a + wcag2aa, zero serious or critical.
 *   criterion 2 (errors)        expectInvalidFieldsDescribed.
 *
 * Criteria 4, 5 and 8 are content checks in the page specs; contrast
 * (criterion 7) is covered by axe's color-contrast rule; the manual
 * screen-reader pass of criterion 9 is not automatable.
 *
 * Private pages (PRIVATE_CUSTOMER_ROUTE_PREFIXES) also get the header check
 * and the "no third-party request" check.
 */

export const ZOOM_200 = { viewport: { width: 640, height: 360 }, deviceScaleFactor: 2 } as const;
export const NARROW_320 = { viewport: { width: 320, height: 640 }, deviceScaleFactor: 1 } as const;

/** Synthetic references with a valid check digit that no fixture uses. */
export const UNKNOWN_REFERENCE = "OUT-99999914";
export const OTHER_UNKNOWN_REFERENCE = "OUT-99999922";

export async function expectNoSeriousAxeViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.impact} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).slice(0, 5).join(", ")})`);
  expect(serious, "axe serious/critical violations (wcag2a, wcag2aa)").toEqual([]);
}

/**
 * Cache-Control `private, no-store` (dev servers send plain `no-store`, so
 * `private` is checked only when E2E_NEXT_DEV is unset), Referrer-Policy
 * `no-referrer`, X-Robots-Tag `noindex`, and a CSP without analytics origins.
 */
export function expectPrivateHeaders(response: Response | null): void {
  expect(response, "the page response").not.toBeNull();
  const h = response!.headers();
  const cache = h["cache-control"] ?? "";
  expect(cache).toContain("no-store");
  if (!process.env.E2E_NEXT_DEV) expect(cache).toContain("private");
  expect(h["referrer-policy"]).toBe("no-referrer");
  expect(h["x-robots-tag"] ?? "").toMatch(/noindex/);
  expect(h["x-robots-tag"] ?? "").toMatch(/nofollow/);
  expect(h["content-security-policy"] ?? "").not.toMatch(/googletagmanager|google-analytics/);
}

/** Records every request the page makes from now on. */
export function recordRequests(page: Page): { urls: URL[]; to: (pathname: string) => URL[]; offSite: () => string[] } {
  const urls: URL[] = [];
  page.on("request", (r) => urls.push(new URL(r.url())));
  const base = new URL(test.info().project.use.baseURL ?? "http://localhost:3000");
  return {
    urls,
    to: (pathname) => urls.filter((u) => u.origin === base.origin && u.pathname === pathname),
    offSite: () => urls.filter((u) => u.origin !== base.origin && u.protocol.startsWith("http")).map((u) => u.href),
  };
}

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(m.scroll, `scrollWidth ${m.scroll} > innerWidth ${m.inner}`).toBeLessThanOrEqual(m.inner);
}

/**
 * Presses Tab from the top of the page until `target` has focus, then checks
 * the focus is visible (`:focus-visible` with an outline or a ring).
 */
export async function expectTabReaches(page: Page, target: Locator, maxTabs = 80): Promise<void> {
  await expect(target).toBeVisible();
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.scrollTo(0, 0);
  });
  // Start from the document, as a keyboard user arriving on the page does.
  await page.locator("body").focus();
  let reached = false;
  for (let i = 0; i < maxTabs && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await target.evaluate((el) => el === document.activeElement);
  }
  expect(reached, `Tab did not reach the primary action within ${maxTabs} presses`).toBe(true);
  const focus = await target.evaluate((el) => {
    const s = getComputedStyle(el);
    const outline = s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) > 0;
    const ring = s.boxShadow !== "none" && s.boxShadow !== "";
    return { visible: el.matches(":focus-visible"), outline, ring };
  });
  expect(focus.visible, "the primary action matches :focus-visible").toBe(true);
  expect(focus.outline || focus.ring, "the focused primary action shows an outline or ring").toBe(true);
}

/** Under `prefers-reduced-motion: reduce`, nothing keeps animating. */
export async function expectNoRunningAnimations(page: Page): Promise<void> {
  // Let anything shortened to ~0 ms by the reduced-motion rule finish.
  await page.waitForTimeout(250);
  const running = await page.evaluate(() =>
    document
      .getAnimations()
      .filter((a) => a.playState === "running")
      .map((a) => {
        const t = a.effect?.getComputedTiming();
        const target = (a.effect as KeyframeEffect | null)?.target;
        return {
          name: (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? a.id,
          duration: Number(t?.duration ?? 0),
          iterations: t?.iterations ?? 1,
          target: target ? `${target.tagName.toLowerCase()}.${String((target as Element).className).slice(0, 60)}` : "",
        };
      })
      .filter((a) => a.iterations === Infinity || a.duration > 1),
  );
  expect(running, "animations still running with reduced motion").toEqual([]);
}

/**
 * Every field marked invalid names its error: `aria-describedby` points at
 * elements that exist, are visible and have text (criterion 2).
 */
export async function expectInvalidFieldsDescribed(page: Page): Promise<number> {
  const fields = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-invalid="true"]')].map((el) => {
      const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      const described = ids.map((id) => document.getElementById(id)).filter((d): d is HTMLElement => Boolean(d));
      return {
        field: el.id || el.getAttribute("name") || el.tagName,
        ids,
        texts: described.filter((d) => d.offsetParent !== null || d.getClientRects().length > 0).map((d) => d.textContent?.trim() ?? ""),
      };
    }),
  );
  for (const f of fields) {
    expect(f.ids.length, `${f.field} has aria-invalid but no aria-describedby`).toBeGreaterThan(0);
    expect(f.texts.some((t) => t.length > 0), `${f.field}: aria-describedby points at no visible text`).toBe(true);
  }
  return fields.length;
}

export interface PageCase {
  /** Title of the describe block. */
  name: string;
  /**
   * Path to open (may carry a fragment). A function is read when each test
   * opens the page, for a path known only once a fixture exists (a planted
   * order's reference); such a case states `privateRoute` itself.
   */
  path: string | (() => string);
  /** Whether the route is private (header and third-party checks); required when `path` is a function. */
  privateRoute?: boolean;
  /** Runs before navigation (storage seeding, request routing). */
  before?: (page: Page) => Promise<void>;
  /** Resolves once the page shows the state under test. */
  ready: (page: Page) => Promise<void>;
  /** The primary action of that state. */
  primary: (page: Page) => Locator;
}

/**
 * Registers the standard checks for one page state: headers (private pages),
 * axe, keyboard, 320 px, 200% zoom and reduced motion.
 */
export function standardChecks(c: PageCase): void {
  if (typeof c.path === "function" && c.privateRoute === undefined) throw new Error(`${c.name}: a path function needs privateRoute`);
  const isPrivate = typeof c.path === "function" ? c.privateRoute === true : isPrivateCustomerPath(new URL(c.path, "http://x").pathname);
  if (typeof c.path === "string" && c.privateRoute !== undefined && c.privateRoute !== isPrivate) throw new Error(`${c.name}: privateRoute contradicts the path`);

  async function open(page: Page): Promise<Response | null> {
    await c.before?.(page);
    const res = await page.goto(typeof c.path === "function" ? c.path() : c.path);
    await c.ready(page);
    return res;
  }

  test.describe(`${c.name}: standard checks`, () => {
    if (isPrivate) {
      test("private headers on the page response, and no request leaves the site", async ({ page }) => {
        const requests = recordRequests(page);
        const res = await open(page);
        expectPrivateHeaders(res);
        await page.waitForLoadState("networkidle");
        expect(requests.offSite(), "requests to other origins").toEqual([]);
      });
    }

    test("axe: no serious or critical violations (wcag2a, wcag2aa)", async ({ page }) => {
      await open(page);
      await expectNoSeriousAxeViolations(page);
    });

    test("keyboard: Tab reaches the primary action, with visible focus", async ({ page }) => {
      await open(page);
      await expectTabReaches(page, c.primary(page));
    });

    test.describe("320 px wide", () => {
      test.use(NARROW_320);
      test("no horizontal scroll; the primary action is visible", async ({ page }) => {
        await open(page);
        await expectNoHorizontalScroll(page);
        const primary = c.primary(page);
        await primary.scrollIntoViewIfNeeded();
        await expect(primary).toBeInViewport();
      });
    });

    test.describe("200% zoom (640 x 360 CSS px at deviceScaleFactor 2)", () => {
      test.use(ZOOM_200);
      test("no horizontal scroll; the primary action is visible and axe stays clean", async ({ page }) => {
        await open(page);
        await expectNoHorizontalScroll(page);
        const primary = c.primary(page);
        await primary.scrollIntoViewIfNeeded();
        await expect(primary).toBeInViewport();
        await expectNoSeriousAxeViolations(page);
      });
    });

    test.describe("prefers-reduced-motion: reduce", () => {
      test.use({ reducedMotion: "reduce" });
      test("no running animations", async ({ page }) => {
        await open(page);
        await expectNoRunningAnimations(page);
      });
    });
  });
}
