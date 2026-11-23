# Local test shop

A copy of the site on this Mac, for the owner's own test purchases before the pilot. It never touches production. It runs on:

- **a local database:** Docker container `outly-shop-pg17`, port 55433. The data lives in memory, so stopping Docker resets it;
- **TravelDesk TEST:** real-looking bookings on the test agency balance, nothing real;
- **Stripe test mode:** test cards only, no real money.

Open **http://localhost:3002**.

## What you can buy

| Product | TravelDesk TEST offer | Notes |
|---|---|---|
| Dubai Marina Dhow Cruise with Dinner | #62 | 21:00, make your own way, book 12 h ahead |
| Evening Desert Safari | #166 | 15:00 hotel pickup, book at least 48 h ahead |
| Abu Dhabi Day Trip | #45 | 09:00 hotel pickup, Tuesdays and Sundays only |

The prices are local test prices (AED 229, 319 and 339 per adult). Seniors are not a TravelDesk ticket type: choose adults or children.

## A test purchase

1. Pick a date and guests, then press **Book now**.
2. Enter any name in English letters, an email, and a UAE or Indian mobile number.
3. When the site asks for the phone code, run `sh scripts/shop/otp.sh` (or ask Claude). The shop prints codes instead of sending SMS.
4. On the Stripe page, pay with the test card **4242 4242 4242 4242**, any future expiry date and any CVC.
5. Back on the site, the order page follows the booking. The voucher appears once TravelDesk TEST confirms and the job runner has downloaded it, usually within a minute or two.

Other Stripe test cards (declined, 3-D Secure) are listed at https://docs.stripe.com/testing.

## Starting and stopping

Three things run together. Each one runs in its own terminal (or Claude starts them):

```bash
sh scripts/shop/dev.sh
```

```bash
stripe listen --forward-to http://localhost:3002/api/webhooks/payments/stripe
```

```bash
sh scripts/shop/jobs.sh
```

To rebuild the shop from scratch (a new database, the catalogue and the products):

```bash
OUTLY_TEST_DB_PORT=55433 OUTLY_TEST_DB_CONTAINER=outly-shop-pg17 OUTLY_TEST_ENV_FILE=.env.test.shop.local OUTLY_TEST_ALLOW_LINKED_PARENT=/Users/ASUS/Programs/OUTLYY sh scripts/test-db/up.sh --recreate
```

Then re-add the TravelDesk TEST and Stripe test values to `.env.test.shop.local`, sync the catalogue (`scripts/traveldesk-sync-local.ts`), and run `scripts/shop/setup.ts`. Claude does these steps; they need the key files that stay outside the repository.

## Notes

- `.env.test.shop.local` is git-ignored and holds the TEST and Stripe test keys. Never copy it anywhere.
- The shop runs with `next dev --webpack`. With Turbopack, a stray `package-lock.json` in the home folder makes the dev server watch the whole home directory, and the page reloads forever.
- Product page times must be plain `HH:mm` (for example `21:00`, not `21:00 sailing`) and equal the TravelDesk slot start. Otherwise the quote answers `invalid_slot` and the cart goes to inquiry.

## Browser and accessibility checks

An automated check of the two new controls, the hotel search at checkout and the start-time picker on the product page: keyboard only, focus, labels and roles, axe (WCAG 2.0 A/AA and 2.1 AA), 320 px phones, 200% zoom and reduced motion. It also takes full-page screenshots for a layout review. It runs on GitHub with every push (job "browser and accessibility checks") and can run here too.

It uses **no TravelDesk and no Stripe**: its own throwaway database with synthetic data, and the hotel lists and start times are made-up answers given inside the test browser. It does not touch the test shop above or its database.

```bash
OUTLY_TEST_ALLOW_LINKED_PARENT=/Users/ASUS/Programs/OUTLYY npm run test:e2e:a11y
```

This needs Docker running. It starts a fresh database (`outly-a11y-pg17`, port 55435), makes two seeded products instant there (`scripts/shop/a11y-fixture.ts`), builds the site, starts it on http://localhost:3100, runs the checks, and removes the database again. Add `-- --keep` to keep the database between runs, and put Playwright options after a second `--` (for example `npm run test:e2e:a11y -- -- --headed`).

Screenshots land in `test-results/a11y-screenshots/`: for each control, the whole page and a close-up, at desktop size, 320 px and 200% zoom. On GitHub they are attached to the run as `a11y-screenshots-and-report`. That attachment is public, which is why everything in it is synthetic.

With the site already running against that database (`--keep` keeps the database and env files, but the script always stops the site on exit, so start it yourself first), the checks alone are:

```bash
E2E_BASE_URL=http://localhost:3100 npx playwright test --project=a11y
```

What the checks cannot do, a real screen reader pass, is listed in `docs/accessibility-and-performance.md` §12.
