import type { Activity, AddOn, CartItem, Currency, Money, PaxCount, Variant } from "./types";
import { ZERO, addMoney, scaleMoney } from "./utils";
import { MAX_INSTANT_ITEMS_PER_ORDER } from "@/server/quotes/contracts";
import { guestAgesNotice, guestRowAges, paxForAges, quoteLineAges } from "./pax-ages";

/** The fields pricing reads — a full `Activity` or the card projection both satisfy it. */
export type PricedActivity = Pick<Activity, "slug" | "title" | "images" | "price" | "variants" | "addOns" | "quoteOnly" | "confirmation" | "fulfilmentMode" | "freeCancellationHours" | "durationMinutes"> &
  Partial<Pick<Activity, "openDatedTicket">>;

/**
 * Price computation.
 *
 * The single rule this file exists to enforce: the number shown on the activity
 * page for a given date and pax equals the number charged at checkout
 * (AC-ADP-05, AC-CO-02). Taxes and booking fees are already inside the SKU
 * price, so there is no place here to add one.
 */

export interface PriceBreakdownLine {
  label: string;
  detail?: string;
  /** Per-unit price behind a base line; rendered in the visitor's currency next to `detail` (PRD-8 d). */
  unit?: Money;
  amount: Money;
  kind: "base" | "addon" | "discount" | "total";
}

export interface PriceBreakdown {
  lines: PriceBreakdownLine[];
  subtotal: Money;
  discount: Money;
  total: Money;
  perPersonFrom: Money;
  savings?: Money;
}

export function variantById(activity: Pick<PricedActivity, "variants">, id?: string): Variant | undefined {
  if (!id) return activity.variants.find((v) => v.recommended) ?? activity.variants[0];
  return activity.variants.find((v) => v.id === id);
}

/** The pax types the activity page prices; an instant product's typed units use these ids (readiness `unitPriceShown`). */
export const PAGE_PAX_TYPES = ["adult", "child", "senior", "infant"] as const satisfies readonly (keyof PaxCount)[];

/**
 * The ages the page itself gives each pax type (adults 12+, children 3–11,
 * infants under 3, seniors 60+), now defined in `./pax-ages` with the
 * per-variant bands of doc 30 N4 (`variantPaxAges`). Re-exported here for
 * existing callers.
 */
export { PAGE_PAX_AGES } from "./pax-ages";

/**
 * The guest picker's step when the selected option changes (doc 30 N4, review
 * 102 N4-02): the notice for counts already set (`guestAgesNotice`) and the
 * party with rows the new option cannot book dropped. Null when the option the
 * ages were read for is still the selected one, as after a restored cart line
 * sets both together (re-review R1): nothing to announce.
 */
export function guestOptionSwitch(
  activity: Pick<PricedActivity, "variants" | "fulfilmentMode">,
  fromVariantId: string | undefined,
  toVariantId: string | undefined,
  pax: PaxCount,
): { notice: string | null; pax: PaxCount } | null {
  if (fromVariantId === toVariantId) return null;
  const to = variantById(activity, toVariantId);
  const mode = activity.fulfilmentMode;
  return { notice: guestAgesNotice(variantById(activity, fromVariantId), to, pax, mode), pax: paxForAges(pax, guestRowAges(to, mode)) };
}

/** Why checkout sent a cart line back to its activity page: its start time (doc 29 Batch 2) or its guests (guest picker fix, D1). */
export type LineRestoreReason = "time" | "guests";

/**
 * The guest picker's step when the booking widget restores a cart line sent
 * back from checkout (guest picker fix, D1, D6). The line's guests with
 * every row its option cannot book dropped, what the guest is told about
 * the dropped ones (null when none), and where focus goes: the guests when
 * they were sent back for their guests or a notice is shown, else the start
 * times. A line restored on its own option is not an option switch, so no
 * band wording (re-review R1).
 */
export function restoreLineGuests(
  activity: Pick<PricedActivity, "variants" | "fulfilmentMode">,
  item: Pick<CartItem, "pax" | "variantId">,
  reason: LineRestoreReason,
  currentVariantId?: string,
): { pax: PaxCount; notice: string | null; focus: "guests" | "times" } {
  const variant = variantById(activity, item.variantId ?? currentVariantId);
  const mode = activity.fulfilmentMode;
  const notice = guestAgesNotice(variant, variant, item.pax, mode);
  return { pax: paxForAges(item.pax, guestRowAges(variant, mode)), notice, focus: reason === "guests" || notice ? "guests" : "times" };
}

/** The guest rows the picker can show, in display order. */
export const GUEST_ROWS = ["adult", "child", "infant", "senior"] as const satisfies readonly (keyof PaxCount)[];

/**
 * Whether the offer has a senior price of its own (owner decision 5, 22 Nov
 * 2026, doc 29 §8.4: hide the Seniors row where the offer has no senior
 * price). A variant with typed units decides by its units: a senior unit, or
 * none, which the quote would refuse. Without typed units (inquiry pricing)
 * the page's price band decides.
 */
export function offersSeniorPrice(activity: Pick<PricedActivity, "price">, variant: Variant | undefined): boolean {
  const units = variant?.units;
  if (units && units.length > 0) return units.some((u) => u.unitId === "senior");
  return activity.price.senior !== undefined;
}

/** The guest rows for this activity and variant: every row except Seniors when the offer has no senior price. */
export function guestRowsFor(activity: Pick<PricedActivity, "price" | "variants">, variantId?: string): (keyof PaxCount)[] {
  const variant = variantById(activity, variantId);
  return GUEST_ROWS.filter((row) => row !== "senior" || offersSeniorPrice(activity, variant));
}

/**
 * The per-unit price the activity page shows for one pax type. Readiness
 * requires an instant product's typed unit prices to equal it, so the page
 * and the server quote charge the same authored amount.
 */
export function pageUnitPrice(activity: Pick<PricedActivity, "price">, variant: Variant | undefined, type: keyof PaxCount): Money {
  return unitFor(activity, variant, type);
}

function unitFor(activity: Pick<PricedActivity, "price">, variant: Variant | undefined, type: keyof PaxCount): Money {
  const band = activity.price;
  const base =
    type === "adult"
      ? band.adult
      : type === "child"
        ? (band.child ?? band.adult)
        : type === "senior"
          ? (band.senior ?? band.adult)
          : (band.infant ?? ZERO);
  if (!variant || type === "infant") return base;
  return addMoney(base, variant.delta);
}

export function computeBreakdown(
  activity: PricedActivity,
  pax: PaxCount,
  variantId?: string,
  addOnIds: string[] = [],
): PriceBreakdown {
  const variant = variantById(activity, variantId);
  const lines: PriceBreakdownLine[] = [];
  let subtotal = ZERO;

  (["adult", "child", "senior", "infant"] as const).forEach((type) => {
    const count = pax[type];
    if (!count) return;
    const unit = unitFor(activity, variant, type);
    const amount = scaleMoney(unit, count);
    if (type === "infant" && unit.inr === 0) {
      lines.push({
        label: `Infants × ${count}`,
        detail: "Free on this experience",
        amount: ZERO,
        kind: "base",
      });
      return;
    }
    lines.push({
      label: `${{ adult: "Adults", child: "Children", senior: "Seniors", infant: "Infants" }[type]} × ${count}`,
      detail: "each, all-in",
      unit,
      amount,
      kind: "base",
    });
    subtotal = addMoney(subtotal, amount);
  });

  const billable = pax.adult + pax.child + pax.senior;
  activity.addOns
    .filter((a) => addOnIds.includes(a.id))
    .forEach((addOn) => {
      const amount = addOn.perPerson ? scaleMoney(addOn.price, billable) : addOn.price;
      lines.push({
        label: addOn.name,
        detail: addOn.price.inr === 0 ? "No extra charge" : addOn.perPerson ? "per person" : "per booking",
        amount,
        kind: "addon",
      });
      subtotal = addMoney(subtotal, amount);
    });

  const compare = activity.price.compareAt;
  const savings =
    compare && compare.inr > activity.price.adult.inr
      ? scaleMoney(
          { inr: compare.inr - activity.price.adult.inr, aed: compare.aed - activity.price.adult.aed },
          billable,
        )
      : undefined;

  return {
    lines,
    subtotal,
    discount: ZERO,
    total: subtotal,
    perPersonFrom: unitFor(activity, variant, "adult"),
    savings,
  };
}

export function toCartItem(
  activity: PricedActivity,
  opts: { date: string; time: string; pax: PaxCount; variantId?: string; addOnIds?: string[] },
): CartItem {
  const variant = variantById(activity, opts.variantId);
  // A row the option cannot book never reaches the cart (guest picker fix): the quote would refuse it (`unknown_unit`).
  const pax = paxForAges(opts.pax, guestRowAges(variant, activity.fulfilmentMode));
  const breakdown = computeBreakdown(activity, pax, opts.variantId, opts.addOnIds ?? []);
  return {
    id: `${activity.slug}-${opts.date}-${opts.time}-${variant?.id ?? "std"}`,
    kind: "activity",
    slug: activity.slug,
    title: activity.title,
    image: activity.images[0],
    date: opts.date,
    time: opts.time,
    variantId: variant?.id,
    variantName: variant?.name,
    pax,
    addOnIds: opts.addOnIds ?? [],
    unit: breakdown.perPersonFrom,
    total: breakdown.total,
    confirmation: activity.confirmation,
    fulfilmentMode: activity.fulfilmentMode,
    freeCancellationHours: activity.freeCancellationHours,
    ...(activity.openDatedTicket ? { openDatedTicket: true } : {}),
    durationMinutes: activity.durationMinutes,
    // Doc 30 N4: the ages the guests were chosen against, so a later change of the option's ages is caught by the quote.
    ages: quoteLineAges(variant),
  };
}

/**
 * Mixed-cart rule (pivot §8.2 step 6): a cart containing any inquiry-mode item
 * routes to the inquiry flow. Simplest correct rule; protects the margin SKUs.
 */
export function cartRequiresInquiry(items: CartItem[]): boolean {
  return items.length === 0 || items.some((i) => i.fulfilmentMode !== "instant");
}

/**
 * Whether the trip's next step is the inquiry form rather than instant
 * checkout: a mixed cart, or more instant items than one order takes. The
 * one rule the cart and /checkout both apply (CO-03); there is no build-type
 * gate here, because whether a cart can actually be paid is the server's call
 * (release switch, readiness, quote; doc 22 §32.34).
 */
export function cartGoesToInquiry(items: CartItem[]): boolean {
  return cartRequiresInquiry(items) || items.length > MAX_INSTANT_ITEMS_PER_ORDER;
}

/* ---------------------------------------------------------------------------
 * Coupons (MOCK). The margin guardrail in PRD §13 lives server-side; this is
 * only the client-visible validation surface.
 *
 * `applyCoupon` is the inquiry and indicative surface and works in INR, as it
 * always has. A paid quote (`couponDiscountMinor`, src/server/services/
 * quote.service.ts) applies a coupon only in a currency the coupon has an
 * authored value for: INR from the fields below, any other currency only from
 * `authored`. It never derives one currency's amount from another's.
 * ------------------------------------------------------------------------ */

/** A coupon's value authored in one currency, major units of that currency. */
export interface CouponValue {
  /** Smallest subtotal it applies to. */
  minOrder: number;
  /** fixed: the amount off. percent: the most it takes off. */
  off: number;
}

export interface Coupon {
  code: string;
  label: string;
  kind: "percent" | "fixed";
  value: number;
  minOrderINR: number;
  firstBookingOnly?: boolean;
  note: string;
  /**
   * Values authored for a paid quote in a currency other than INR (PRD-8 c).
   * Optional: without an entry the coupon is not available in that currency.
   */
  authored?: Partial<Record<Currency, CouponValue>>;
}

/** The cap on a percent coupon in INR (FIRSTTRIP's note). */
const PERCENT_CAP_INR = 2000;

export const coupons: Coupon[] = [
  {
    code: "FIRSTTRIP",
    label: "10% off your first booking",
    kind: "percent",
    value: 10,
    minOrderINR: 3000,
    firstBookingOnly: true,
    note: "Capped at ₹2,000 off.",
  },
  {
    code: "DESERT500",
    label: "₹500 off desert safaris",
    kind: "fixed",
    value: 500,
    minOrderINR: 4000,
    note: "Valid on desert safari bookings above ₹4,000.",
  },
  {
    code: "FAMILY7",
    label: "₹1,500 off bookings above ₹25,000",
    kind: "fixed",
    value: 1500,
    minOrderINR: 25000,
    note: "Built for family group bookings.",
  },
];

export function couponByCode(code: string): Coupon | undefined {
  return coupons.find((c) => c.code.toLowerCase() === code.trim().toLowerCase());
}

/** The coupon's authored value in `currency`, or null when it has none there. */
export function authoredCouponValue(coupon: Coupon, currency: Currency): CouponValue | null {
  const own = coupon.authored?.[currency];
  if (own) return own;
  if (currency === "INR") return { minOrder: coupon.minOrderINR, off: coupon.kind === "percent" ? PERCENT_CAP_INR : coupon.value };
  return null;
}

export type CouponMinorResult =
  | { ok: true; discountMinor: bigint }
  | { ok: false; reason: "not_available_in_currency" }
  | { ok: false; reason: "below_minimum"; shortMinor: bigint };

/**
 * Discount in minor units of `currency` for a subtotal in the same minor
 * units, from the coupon's authored value in that currency only. Integer
 * arithmetic; a percent coupon rounds to the nearest whole rupee or dirham,
 * half up, as `applyCoupon` does.
 */
export function couponDiscountMinor(coupon: Coupon, subtotalMinor: bigint, currency: Currency): CouponMinorResult {
  const v = authoredCouponValue(coupon, currency);
  if (!v) return { ok: false, reason: "not_available_in_currency" };
  const minMinor = BigInt(v.minOrder) * 100n;
  if (subtotalMinor < minMinor) return { ok: false, reason: "below_minimum", shortMinor: minMinor - subtotalMinor };
  const offMinor = BigInt(v.off) * 100n;
  let discount = coupon.kind === "percent" ? ((subtotalMinor * BigInt(coupon.value) + 5000n) / 10000n) * 100n : offMinor;
  if (discount > offMinor) discount = offMinor;
  return { ok: true, discountMinor: discount > subtotalMinor ? subtotalMinor : discount };
}

export type CouponResult =
  | { ok: true; coupon: Coupon; discount: Money; message: string }
  | { ok: false; message: string };

export function applyCoupon(code: string, subtotal: Money): CouponResult {
  const coupon = couponByCode(code);
  if (!coupon) {
    return { ok: false, message: "We couldn’t find that promo code. Check the code and try again." };
  }
  if (subtotal.inr < coupon.minOrderINR) {
    const short = coupon.minOrderINR - subtotal.inr;
    return {
      ok: false,
      message: `${coupon.code} needs a minimum order of ₹${coupon.minOrderINR.toLocaleString("en-IN")}. You're ₹${short.toLocaleString("en-IN")} short.`,
    };
  }
  const inr =
    coupon.kind === "percent"
      ? Math.min(Math.round((subtotal.inr * coupon.value) / 100), PERCENT_CAP_INR)
      : coupon.value;
  const aed = Math.round(inr / 23.2);
  return {
    ok: true,
    coupon,
    discount: { inr, aed },
    message: `${coupon.code} applied. You save ₹${inr.toLocaleString("en-IN")}.`,
  };
}

/** Deposit option: 30% now, balance at T-7 on orders above ₹25,000 (PRD §5.6). */
export const DEPOSIT_THRESHOLD_INR = 25000;
export const EMI_THRESHOLD_INR = 15000;

export function depositSplit(total: Money): { now: Money; later: Money } {
  return {
    now: { inr: Math.round(total.inr * 0.3), aed: Math.round(total.aed * 0.3) },
    later: { inr: Math.round(total.inr * 0.7), aed: Math.round(total.aed * 0.7) },
  };
}

/** Price lock — 20 minutes from cart entry (PRD §3.3, §12). */
export const PRICE_LOCK_MINUTES = 20;
