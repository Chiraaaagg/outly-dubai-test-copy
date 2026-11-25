/**
 * The synthetic shop behind the browser and accessibility checks of the new
 * controls (doc 29 §7.4 "Browser"; scripts/shop/a11y.sh). Shared by the
 * fixture script (scripts/shop/a11y-fixture.ts) and the specs, so both name
 * the same products. Constants only: importing this file has no side effect.
 *
 * Two seeded catalogue products are made instant in the disposable database:
 *
 *  - LISTED_START_SLUG: no pickup; its product page shows the Time Slot
 *    Picker once `/api/catalog/start-times` answers with listed starts;
 *  - PICKUP_SLUG: hotel pickup; at checkout it shows the hotel Combobox once
 *    `/api/catalog/pickup-hotels` answers with a list.
 *
 * Both public reads are answered in the browser with synthetic,
 * contract-typed bodies (e2e/support/controls.ts), so no supplier is asked.
 */
export const LISTED_START_SLUG = "dhow-cruise-marina-dinner";
export const PICKUP_SLUG = "evening-desert-safari-veg-jain";
export const A11Y_SHOP_SLUGS = [LISTED_START_SLUG, PICKUP_SLUG] as const;
