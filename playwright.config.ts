import { defineConfig, devices } from "@playwright/test";

/**
 * Browser and accessibility checks of the B5 customer pages (doc 22 §23 B5;
 * accessibility criteria 1-9 in
 * docs/backend/reviews/2026-10-31-independent/product-preservation.md §6).
 *
 * The app is NOT started from here. Start it yourself (inside the network
 * namespace used for tests, against the disposable database) and point
 * E2E_BASE_URL at it:
 *
 *   E2E_BASE_URL=http://localhost:3000 npm run test:e2e
 *
 * The origin must be one the app accepts as same-origin (its
 * NEXT_PUBLIC_SITE_URL; `.env.test.local` has http://localhost:3000).
 * Otherwise every recovery and ticket-exchange POST is refused with 403
 * before the code under test runs. `127.0.0.1` and `localhost` are
 * different origins.
 *
 * Against `next dev`, also set E2E_NEXT_DEV=1: the dev server replaces every
 * page's Cache-Control with plain `no-store`, so the `private` part of
 * `private, no-store` can only be checked against `next start`.
 *
 * Chromium comes from PLAYWRIGHT_BROWSERS_PATH (pre-installed; never run
 * `playwright install` here). Specs only talk to E2E_BASE_URL: any request
 * to another origin is a failure on the private pages.
 *
 * Two projects:
 *  - `chromium` (`npm run test:e2e`): the B5 customer pages above;
 *  - `a11y` (`npm run test:e2e:a11y`): `e2e/a11y-*.spec.ts`, the browser and
 *    accessibility checks of the new controls (hotel Combobox, Time Slot
 *    Picker) against the synthetic shop. `sh scripts/shop/a11y.sh` prepares
 *    the database, builds, starts the app and runs it, on a workstation and
 *    in CI (job "browser and accessibility checks"); see scripts/shop/README.md.
 *
 * In CI an HTML report is written too (playwright-report/, uploaded with the
 * screenshots; synthetic data only).
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts$/,
  // One worker: the pages share the app's per-IP rate-limit buckets.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : [["list"]],
  outputDir: "test-results/e2e",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    locale: "en-GB",
    timezoneId: "Asia/Dubai",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    serviceWorkers: "block",
  },
  projects: [
    { name: "chromium", testIgnore: /a11y-[^/]*\.spec\.ts$/, use: { browserName: "chromium" } },
    { name: "a11y", testMatch: /a11y-[^/]*\.spec\.ts$/, use: { browserName: "chromium" } },
  ],
});
