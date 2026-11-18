"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, Clock, Lock, Pencil, RefreshCw, ShieldCheck } from "lucide-react";
import { useApp } from "@/components/providers/app-provider";
import { WhatsAppButton } from "@/components/commerce/whatsapp";
import { OrderSummary, type ServerQuote } from "@/components/commerce/order-summary";
import { CheckoutVerify, verificationMatchesQuote, verifiedAnswerAction } from "@/components/checkout/checkout-verify";
import { CollapsiblePromo } from "@/components/checkout/collapsible-promo";
import { COUNTRIES, PhoneInput, type Country } from "@/components/checkout/phone-input";
import { writeOrderHint } from "@/components/commerce/order-status/order-hint";
import { Button, ButtonLink } from "@/components/ui/button";
import { Alert, Card, EmptyState } from "@/components/ui/primitives";
import { Stepper, StepperIndicator, StepperItem, StepperSeparator, StepperTitle, StepperTrigger } from "@/components/ui/stepper";
import {
  ApiError,
  createServerQuote,
  mocksAllowed,
  quoteLinesFor,
  startCheckout,
  startCheckoutVerification,
  verifyCheckoutCode,
} from "@/lib/api";
import { track } from "@/lib/analytics";
import { useCatalog } from "@/lib/catalog/client";
import type { OtpAttempt } from "@/lib/otp-flow";
import { maskPhone, normalisePhone, SUPPORTED_COUNTRY_CODES } from "@/lib/phone";
import {
  DEPOSIT_THRESHOLD_INR,
  applyCoupon,
  cartGoesToInquiry,
  cartRequiresInquiry,
  depositSplit,
  type CouponResult,
} from "@/lib/pricing";
import type { Money, Traveller } from "@/lib/types";
import { cancellationPolicyBeforeQuote, cn, DUBAI_UTC_OFFSET_MS, parseDateKey, paxLabel, priceIn } from "@/lib/utils";
import { transactionCurrency } from "@/lib/currency";
import { GUEST_NAME_LATIN_MESSAGE, supplierGuestName } from "@/lib/guest-name";
import { payPageUrl } from "@/lib/checkout-gate";
import {
  canPay,
  cartFingerprint,
  clearPaymentHandoff,
  handoffAction,
  leftPaymentActions,
  paymentOutstanding,
  readCheckoutDraft,
  readPaymentHandoff,
  writeCheckoutDraft,
  writePaymentHandoff,
  type LeftPaymentState,
} from "@/lib/checkout-draft";
import { fetchOrderStatus } from "@/lib/api/order-status";
import { resumePayment } from "@/lib/resume-payment";
import { inquiryHref, inquiryReasonForQuote, inquiryReasonText, type InquiryReason } from "@/lib/inquiry-handoff";

/**
 * CHECKOUT (PRD §5.6)
 *
 * INQUIRY MODE GATE (pivot plan §2.1, §2.2, §8.1 item 5): this route is
 * retained in full but only serves carts whose every item is instant-mode.
 * Any inquiry-mode item redirects to /inquiry (the mixed-cart rule). Nothing
 * below is deleted — flipping a SKU's fulfilmentMode brings steps 3–4 back
 * for that SKU with no code change.
 *
 * PRODUCTION (doc 22 §32.34): whether a cart may be paid is the server's call
 * (the release switch `INSTANT_RELEASE_ENABLED`, readiness and the quote);
 * a production build only ever opens Stripe's hosted page (checkout-gate.ts).
 *
 * PAID PATH (doc 22 §23 B3):
 *   1. on reaching the review step, the server quotes the cart
 *      (`POST /api/quotes`). A refused line says why and offers the inquiry
 *      form with the details carried (CO-07); the summary then shows the
 *      quote's own totals and, per line, the one cancellation statement
 *      (`freeCancellationCopy`, CO-01) before any payment;
 *   2. on Pay, a quote with under a minute left is re-quoted, and a total that
 *      differs from the trip's needs explicit re-consent (AC-CO-04);
 *   3. the WhatsApp number on the order is verified for this quote with a
 *      code, inline (`/api/checkout/verify/start`, `/api/checkout/verify`);
 *   4. `POST /api/checkout` opens the gateway session and the browser goes to
 *      the gateway's hosted page. Whether it was paid is the gateway's verified
 *      evidence, never this page's; no client event claims a payment or a
 *      booking (PRD-16). Before leaving, the order reference is kept in
 *      `sessionStorage` (`writeOrderHint`) so the return page knows which
 *      order to ask the server about.
 *
 * RECOVERY (checkout redesign batch 1, CO-06, CO-07): this tab keeps a draft
 * of the lead traveller's name, email and mobile number in `sessionStorage`
 * (src/lib/checkout-draft.ts; nothing else, no card data), and the ids of the
 * payment it handed to Stripe. Coming back from Stripe without paying shows
 * "You left the payment page" with "Return to payment" (the same
 * `POST /api/checkout`, which hands back the same open Stripe page) and the
 * details kept. The draft is cleared once the status page shows the payment.
 *
 * EMI is not offered on this instant path (owner decision, B5): the saga
 * captures one full payment.
 *
 * Accessibility (PRD-23): step headings are headings and take focus on a
 * step change; a validation failure moves focus to an error summary that
 * links each invalid field; the terms error is tied to its checkbox; a price
 * change or an expired price hold is announced with `role="alert"` and
 * focus moves to the decision button.
 *
 * CHECKOUT REDESIGN BATCH 2 (approved prototype, docs/checkout-redesign-review):
 * an enclosed checkout (the layout's CheckoutHeader: logo, "Secure checkout",
 * Help; no search, categories or footer sitemap), the Stepper (Activity,
 * complete on arrival · Your details · Review & pay · Booked), the order
 * summary through the Checkout Summary component (a collapsed bar on phones),
 * the details step with the Phone Input (UAE first, then India), blur
 * validation, and Review & pay with read-only details, the one cancellation
 * statement from the quote, the promo behind "Have a promo code?" and one
 * action, "Verify number and pay …", which turns into the inline OTP card.
 * Dietary needs and notes are no longer asked on this instant path: they were
 * collected and then dropped (CO-10). The calls, the quote, the price
 * re-consent, the hand-off and every rule below are unchanged.
 *
 * Two steps on one page with progressive sections — not page loads.
 * Guest checkout is mandatory: forced registration is a conversion tax we will
 * not pay (AC-CO-01). Account creation is offered after payment, using details
 * already given.
 *
 * The rules this screen enforces:
 *   AC-CO-02  the review total equals the charged total, exactly
 *   AC-CO-03  a payment failure preserves the cart and explains itself plainly
 *   AC-CO-04  a price change requires explicit re-consent
 *   AC-CO-06  abandoned checkout recovery is consent-gated, not assumed
 *   AC-CO-07  no card data touches our servers — the gateway owns those fields
 *
 * Both rails again: any step can be handed to a WhatsApp agent who sees the
 * same cart and sends a payment link for the same total.
 */

/** 1: Your details · 2: Review & pay (the Stepper's indices 1 and 2; 0 is the activity, 3 is Booked). */
type Step = 1 | 2;

type PaymentState =
  | "idle"
  | "verifying"
  | "processing"
  | "failed"
  | "timeout"
  | "price_changed";

/** A quote with less than this left is re-quoted before payment starts. */
const QUOTE_MIN_REMAINING_MS = 60_000;

/**
 * The instant saga captures the full quoted amount in one payment (B3), so
 * the 30% deposit option stays hidden until a partial-capture rail exists.
 */
const DEPOSITS_OFFERED = false;

/** A quote's minor-unit amount as the cart's Money, in the quote currency only; the other figure is kept. */
function quotedMoney(minor: string, currency: "INR" | "AED", keep: Money): Money {
  const major = Number(BigInt(minor)) / 100;
  return currency === "INR" ? { ...keep, inr: major } : { ...keep, aed: major };
}

function sumMinor(values: string[]): string {
  return values.reduce((s, v) => s + BigInt(v), 0n).toString();
}

/**
 * Instant checkout takes cards only, on Stripe's hosted page (doc 22
 * §32.11). No brand marks are shown here (CO-12, CO-13): the card brands and
 * any wallet Stripe presents depend on the account, the device and the
 * browser, so this page names none of them. One method, so no chooser.
 */
const PAYMENT_METHOD = "card";

/** Step 1 fields, in page order: the order of the error summary. */
const DETAIL_FIELDS = ["fullName", "email", "phone"] as const;

const FIELD_LABELS: Record<string, string> = {
  fullName: "Full name",
  email: "Email",
  phone: "Mobile number",
  terms: "Cancellation policy and terms",
};

const STEP_TITLES = ["Activity", "Your details", "Review & pay", "Booked"] as const;

/**
 * UAE first, then India (CO-24), and only those: the countries the phone
 * rules know (`PHONE_RULES`, the same set the old select offered). Offering
 * more would send SMS codes and orders to numbers the business has not
 * agreed to serve (review fix 1).
 */
const PHONE_COUNTRIES: Country[] = ["AE", "IN"]
  .map((code) => COUNTRIES.find((c) => c.code === code))
  .filter((c): c is Country => Boolean(c) && SUPPORTED_COUNTRY_CODES.includes((c as Country).dialCode));

/** The Phone Input's country for a stored dial code ("+971" → AE). */
function countryForDialCode(dialCode: string): string {
  return PHONE_COUNTRIES.find((c) => c.dialCode === dialCode)?.code ?? "AE";
}

/**
 * Field errors for the traveller details. Pure, so a blur can check one
 * field with the same rules the submit uses.
 */
function detailErrors(t: Traveller, selfServe: boolean): Record<string, string> {
  const next: Record<string, string> = {};
  if (!t.fullName.trim()) next.fullName = "We need a name for the booking voucher.";
  else if (selfServe && supplierGuestName(t.fullName) === null) next.fullName = GUEST_NAME_LATIN_MESSAGE;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t.email)) next.email = "Enter an email we can send the voucher to.";
  if (!/^\d{7,12}$/.test(t.phone.replace(/\s/g, "")))
    next.phone = "We need a working mobile number. We text a code to it to confirm your booking.";
  else if (!normalisePhone(t.phone, t.countryCode).valid)
    next.phone = normalisePhone(t.phone, t.countryCode).reason ?? "Check the number.";
  return next;
}

/** "Wed 18 Nov" for a YYYY-MM-DD date key. */
function shortDate(key: string): string {
  return parseDateKey(key).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

/** "Wed 18 Nov 2026" for a YYYY-MM-DD date key. */
function reviewDate(key: string): string {
  return parseDateKey(key).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).replace(",", "");
}

/** The amount charged, as the summary prints it: "AED 229.00". */
function chargeText(m: Money, currency: "INR" | "AED"): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    currency === "INR" ? m.inr : m.aed,
  );
}

export default function CheckoutPage() {
  const router = useRouter();
  const { cart, cartTotalINR, cartTotalAED, currency, clearCart, hydrated, toast } = useApp();

  const [step, setStep] = useState<Step>(1);
  // The details typed in this tab come back (CO-06): after Stripe, a reload, or the inquiry form and back.
  // Read once on the client; nothing of this renders before `hydrated`, so server and client agree.
  const [traveller, setTraveller] = useState<Traveller>(() => {
    const draft = readCheckoutDraft();
    return {
      fullName: draft?.fullName ?? "",
      email: draft?.email ?? "",
      // A kept code the form cannot offer (only UAE and India) falls back to the UAE, with no number (follow-up B).
      phone: draft && PHONE_COUNTRIES.some((c) => c.dialCode === draft.countryCode) ? draft.phone ?? "" : "",
      // UAE preselected (CO-24); a kept draft brings its own code back.
      countryCode: draft && PHONE_COUNTRIES.some((c) => c.dialCode === draft.countryCode) ? draft.countryCode : "+971",
      hotel: "",
      dietary: undefined,
      specialRequests: "",
    };
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [terms, setTerms] = useState(false);
  const [coupon, setCoupon] = useState("");
  const [couponResult, setCouponResult] = useState<CouponResult | null>(null);
  const method = PAYMENT_METHOD;
  const [payDeposit, setPayDeposit] = useState(false);
  const [payment, setPayment] = useState<PaymentState>("idle");
  const [error, setError] = useState<ApiError | null>(null);
  const [priceChange, setPriceChange] = useState<{ old: Money; next: Money; reason: string; quoteId: string } | null>(
    null,
  );
  const { activities, settled: catalogSettled } = useCatalog();
  // The server quote for this cart (B3): set on the review step, required before payment.
  const [quote, setQuote] = useState<ServerQuote | null>(null);
  const [quoteState, setQuoteState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const quoteSeq = useRef(0);
  // The order-bound contact verification, valid only for the quote it was made for.
  const verification = useRef<{ quoteId: string; verificationId: string } | null>(null);
  // `token` names one code card; it changes with every new card and on Edit, so a late answer for an old card is discarded.
  const [otp, setOtp] = useState<{ attempt: OtpAttempt; quote: ServerQuote; token: number } | null>(null);
  const otpToken = useRef(0);
  // A code is being checked (or a new one sent): Edit, the Stepper and the promo wait (follow-up A).
  const [codeChecking, setCodeChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Why this cart cannot be paid online (CO-07): said on the page, with the inquiry as a choice.
  const [inquiryReason, setInquiryReason] = useState<InquiryReason | null>(null);
  // Back from Stripe (CO-06): the order this tab handed over for this cart. `moved_on`: it has a payment or has ended.
  const [leftPayment, setLeftPayment] = useState<{ reference: string; state: LeftPaymentState | "moved_on" } | null>(null);
  const leftPaymentRef = useRef<HTMLDivElement>(null);
  const inquiryNoticeRef = useRef<HTMLDivElement>(null);
  // PRD-23 focus management: step headings, the error summary and the decision buttons.
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const focusStepHeading = useRef(false);
  const [showErrorSummary, setShowErrorSummary] = useState(false);
  const [summaryFocusRequest, setSummaryFocusRequest] = useState(0);
  const errorSummaryRef = useRef<HTMLDivElement>(null);
  const acceptPriceRef = useRef<HTMLButtonElement>(null);
  const retryPaymentRef = useRef<HTMLButtonElement>(null);
  const payButtonRef = useRef<HTMLButtonElement>(null);
  const focusPayWhenReady = useRef(false);

  // PRD-8: every amount that will be charged is shown in the currency the
  // order settles in (INR or AED). A USD visitor sees AED here, because that
  // is what the card is charged; dollars stay an estimate on browse pages.
  const payCurrency = transactionCurrency(currency);
  const appliedCoupon = couponResult?.ok ? couponResult.coupon.code : null;
  const cartSubtotal = { inr: cartTotalINR, aed: cartTotalAED };
  const cartDiscount = couponResult?.ok ? couponResult.discount : { inr: 0, aed: 0 };
  const cartTotal = { inr: cartSubtotal.inr - cartDiscount.inr, aed: cartSubtotal.aed - cartDiscount.aed };
  // With a quote in the payment currency, every figure shown is the quote's own.
  const live = quote && quote.currency === payCurrency ? quote : null;
  // Read by a code answer that arrives later than the render that started it (follow-up A).
  const liveQuoteIdRef = useRef<string | null>(null);
  const stepRef = useRef<Step>(step);
  useEffect(() => {
    liveQuoteIdRef.current = live?.quoteId ?? null;
    stepRef.current = step;
  });
  const subtotal = live ? quotedMoney(sumMinor(live.lines.map((l) => l.chargedMinor)), payCurrency, cartSubtotal) : cartSubtotal;
  const discount = live ? quotedMoney(sumMinor(live.lines.map((l) => l.discountAllocMinor)), payCurrency, cartDiscount) : cartDiscount;
  const total = live ? quotedMoney(live.totalMinor, payCurrency, cartTotal) : cartTotal;
  const deposit = depositSplit(total);
  const hasManual = cart.some((i) => i.confirmation === "manual");
  const inPay = (m: Money) => (payCurrency === "INR" ? m.inr : m.aed);
  /** One cart line's amount: the quote line's charged amount when there is a live quote, else the cart's figure. */
  const lineCharged = (index: number, fallback: Money): Money => {
    const line = live?.lines.find((l) => l.index === index);
    return line ? quotedMoney(line.chargedMinor, payCurrency, fallback) : fallback;
  };
  // Fields listed in the error summary: only ones on screen (the terms box is on step 3).
  const summaryItems = Object.entries(errors).filter(([field, message]) => Boolean(message) && (field !== "terms" || step >= 2));

  // Mixed-cart rule and the per-order item cap (the server quote sends a larger cart to inquiry
  // anyway; going there now keeps the visitor from typing details first). Whether a cart may be
  // paid at all is the server's call: the release switch, readiness and the quote (doc 22 §32.34).
  const selfServe = !cartGoesToInquiry(cart);

  useEffect(() => {
    if (hydrated && cart.length && !selfServe) {
      // The rule is unchanged; the inquiry page now says why the cart is there (CO-07).
      router.replace(inquiryHref(cartRequiresInquiry(cart) ? "mixed" : "over_limit"));
    }
  }, [hydrated, cart, router, selfServe]);

  useEffect(() => {
    // Nothing typed yet: leave any kept draft for the restore above.
    if (!hydrated || !(traveller.fullName || traveller.email || traveller.phone)) return;
    writeCheckoutDraft({ fullName: traveller.fullName, email: traveller.email, phone: traveller.phone, countryCode: traveller.countryCode });
  }, [hydrated, traveller.fullName, traveller.email, traveller.phone, traveller.countryCode]);

  /**
   * Came back from Stripe in this tab (browser Back, or a reload) with a
   * payment handed over for this same cart: ask the server where that order
   * stands (`handoffAction`). A hand-off for another cart, or one this browser
   * can no longer see, is dropped quietly; the page never leaves /checkout
   * because of it.
   */
  const checkHandoff = async () => {
    const handoff = readPaymentHandoff();
    if (!handoff) return;
    if (handoff.cartKey !== cartFingerprint(cart)) {
      clearPaymentHandoff();
      return;
    }
    try {
      const status = await fetchOrderStatus(handoff.reference);
      setPayment("idle");
      const action = handoffAction(handoff, cartFingerprint(cart), status?.state ?? null);
      if (action === "offer_return") {
        setLeftPayment({ reference: handoff.reference, state: "open" });
        return;
      }
      clearPaymentHandoff();
      if (action === "show_booking") setLeftPayment({ reference: handoff.reference, state: "moved_on" });
    } catch {
      // The status could not be read (offline, a server error). That payment page may still have been
      // paid, so the page holds back a second payment and offers to check again.
      setPayment("idle");
      setLeftPayment({ reference: handoff.reference, state: "unchecked" });
    }
  };

  useEffect(() => {
    if (!hydrated) return;
    void checkHandoff();
    // A page restored from the back-forward cache keeps its old "opening the payment page" state.
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) void checkHandoff();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  const returnToPayment = async () => {
    const handoff = readPaymentHandoff();
    if (!handoff || !leftPayment) return;
    setLeftPayment({ ...leftPayment, state: "resuming" });
    const r = await resumePayment(handoff);
    if (r.kind === "redirect") {
      window.location.assign(r.url);
      return;
    }
    if (r.kind === "closed") clearPaymentHandoff();
    setLeftPayment({ ...leftPayment, state: r.kind });
  };

  /**
   * Start again from the details, with everything typed kept. Offered only
   * once the old payment page can no longer be used (`leftPaymentActions`).
   */
  const startAgain = () => {
    clearPaymentHandoff();
    setLeftPayment(null);
    verification.current = null;
    goToStep(1);
  };

  // A notice whose buttons just changed, or a new blocking notice, takes focus (PRD-23 criterion 3).
  useEffect(() => {
    if (leftPayment && leftPayment.state !== "resuming") leftPaymentRef.current?.focus();
  }, [leftPayment]);
  useEffect(() => {
    if (inquiryReason) inquiryNoticeRef.current?.focus();
  }, [inquiryReason]);

  // An earlier payment page for this cart may still be paid: no "nothing has been charged" anywhere on the page.
  const outstanding = paymentOutstanding(leftPayment?.state);
  const payAllowed = canPay({
    quoteReady: quoteState === "ready",
    hasLiveQuote: Boolean(live),
    inquiryReason,
    paymentOutstanding: outstanding,
  });

  useEffect(() => {
    if (hydrated && cart.length && selfServe) {
      track("checkout_started", {
        value: cartTotalINR,
        currency: "INR",
        result_count: cart.length,
        rail: "self_serve",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  /**
   * Quotes the cart on the server. Resolves the quote, or null after it has
   * routed the visitor: a refused line goes to /inquiry (the cart is kept), a
   * coupon the server will not apply in this currency is dropped and the
   * cart re-quoted without it. A failure leaves `quoteState` "failed".
   */
  const requestQuote = async (): Promise<ServerQuote | null> => {
    const seq = ++quoteSeq.current;
    const lines = quoteLinesFor(cart, activities, traveller.hotel);
    if (!lines) {
      setInquiryReason("unavailable");
      return null;
    }
    setQuoteState("loading");
    try {
      const r = await createServerQuote({ lines, currency: payCurrency, couponCode: appliedCoupon });
      if (seq !== quoteSeq.current) return null;
      if (!r.ok) {
        if (appliedCoupon && r.lines.every((l) => l.reason === "coupon_not_available_in_currency")) {
          setCouponResult({ ok: false, message: `${appliedCoupon} can't be used when paying in ${payCurrency}.` });
          setQuoteState("idle");
          return null;
        }
        // Nothing is charged and the cart is kept; the page says why and offers the inquiry (CO-07).
        setInquiryReason(inquiryReasonForQuote(r.lines.map((l) => l.reason)));
        setQuoteState("idle");
        return null;
      }
      setInquiryReason(null);
      setQuote(r);
      setQuoteState("ready");
      return r;
    } catch (e) {
      if (seq !== quoteSeq.current) return null;
      const apiError = e instanceof ApiError ? e : null;
      if (appliedCoupon && apiError?.fields?.couponCode) {
        setCouponResult({ ok: false, message: apiError.fields.couponCode });
        setQuoteState("idle");
        return null;
      }
      setError(apiError);
      setQuoteState("failed");
      return null;
    }
  };

  // Quote on reaching the review step, and again whenever what it covers changes.
  const quoteKey = `${payCurrency}|${appliedCoupon ?? ""}|${traveller.hotel ?? ""}|${cart
    .map((i) => `${i.id}:${i.date}:${i.time}:${JSON.stringify(i.pax)}`)
    .join(",")}`;
  useEffect(() => {
    if (!hydrated || !selfServe || step < 2 || !catalogSettled || !cart.length) return;
    setQuote(null);
    verification.current = null;
    void requestQuote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, selfServe, step >= 2, catalogSettled, quoteKey]);

  /** Field errors for the traveller details, plus the terms checkbox when `scope` is "all" (the payment step). */
  const validate = (scope: "details" | "all" = "all"): Record<string, string> => {
    const next = detailErrors(traveller, selfServe);
    if (scope === "all" && !terms) next.terms = "Please confirm you've read the cancellation policy.";
    setErrors(next);
    Object.keys(next).forEach((field) =>
      track("checkout_field_error", { field, failure_reason: next[field] }),
    );
    return next;
  };

  /**
   * Inline validation on blur (CO-29): once something is typed, or once the
   * field already shows an error, leaving it checks it with the submit's rules.
   * Typed values are never cleared.
   */
  const blurField = (field: (typeof DETAIL_FIELDS)[number]) => {
    if (!traveller[field].trim() && !errors[field]) return;
    const found = detailErrors(traveller, selfServe)[field];
    setErrors((prev) => ({ ...prev, [field]: found ?? "" }));
  };

  /** Back to the details from review: the verification covers the number as entered, so a changed number needs a new code. */
  const editDetails = () => {
    if (codeChecking) return;
    verification.current = null;
    otpToken.current += 1;
    // An open code card belongs to the current quote; editing the details re-quotes, so it goes too (review fix 2).
    setOtp(null);
    setPayment("idle");
    goToStep(1);
  };

  const goToStep = (n: Step) => {
    focusStepHeading.current = true;
    setStep(n);
  };

  /** Shows the error summary and moves focus to it (criterion 1). */
  const reportErrors = () => {
    setShowErrorSummary(true);
    setSummaryFocusRequest((n) => n + 1);
  };

  useEffect(() => {
    if (!focusStepHeading.current) return;
    focusStepHeading.current = false;
    stepHeading.current?.focus();
  }, [step]);

  useEffect(() => {
    if (summaryFocusRequest) errorSummaryRef.current?.focus();
  }, [summaryFocusRequest]);

  // A blocking price change or failed payment: focus goes to the decision (criterion 3).
  useEffect(() => {
    if (payment === "price_changed") acceptPriceRef.current?.focus();
    if (payment === "failed") retryPaymentRef.current?.focus();
  }, [payment]);

  // After an expired hold is re-quoted, focus goes to the pay button once it is usable again.
  useEffect(() => {
    if (focusPayWhenReady.current && quoteState === "ready" && live && payment === "idle") {
      focusPayWhenReady.current = false;
      payButtonRef.current?.focus();
    }
  }, [quoteState, live, payment, notice]);

  const onApplyCoupon = () => {
    // The local check gives the message; the server quote decides what the coupon is worth.
    const result = applyCoupon(coupon, cartSubtotal);
    setCouponResult(result);
    track(result.ok ? "coupon_applied" : "coupon_rejected", {
      coupon,
      value: result.ok ? result.discount.inr : undefined,
    });
  };

  /** A code to the WhatsApp number for this quote; `onVerified` keeps the verification for it. */
  const checkoutAttempt = async (q: ServerQuote, e164: string): Promise<OtpAttempt> => {
    const { challengeId } = await startCheckoutVerification({ quoteId: q.quoteId, channel: "phone", contact: e164 });
    track("otp_sent", { context: "checkout" });
    return {
      phoneMasked: maskPhone(e164),
      expiresInSeconds: 0,
      verify: async (code) => {
        const v = await verifyCheckoutCode({ challengeId, code });
        verification.current = { quoteId: q.quoteId, verificationId: v.verificationId };
      },
      resend: () => checkoutAttempt(q, e164),
    };
  };

  /** Opens the gateway session for a verified quote and leaves for its hosted page. */
  const startPayment = async (q: ServerQuote, verificationId: string) => {
    const phone = normalisePhone(traveller.phone, traveller.countryCode);
    setPayment("processing");
    track("payment_initiated", {
      payment_method: method,
      value: Number(BigInt(q.totalMinor)) / 100,
      currency: q.currency,
    });
    try {
      const sent = { fullName: traveller.fullName.trim(), phoneE164: phone.e164, email: traveller.email.trim() || null };
      const r = await startCheckout({ quoteId: q.quoteId, verificationId, method, traveller: sent });
      if ("refused" in r) {
        setOtp(null);
        if (r.refused === "quote_expired") {
          verification.current = null;
          setPayment("idle");
          setNotice("Your price check expired before payment started, so we checked it again with the operator. Nothing was charged. Review it and pay.");
          focusPayWhenReady.current = true;
          void requestQuote();
        } else if (r.refused === "verification_required") {
          verification.current = null;
          setPayment("idle");
          setNotice("We need to confirm your number again for this booking. Press pay to get a new code.");
          focusPayWhenReady.current = true;
        } else if (r.refused === "try_again") {
          setPayment("failed");
        } else {
          // Nothing was charged; the cart is kept, and the page says so before offering the inquiry (CO-07).
          setPayment("idle");
          setInquiryReason("unavailable");
        }
        return;
      }
      // A production build only ever opens Stripe's hosted Checkout; development and preview
      // builds also open the fake gateways' pages (checkout-gate.ts, doc 22 §32.34).
      const payPage = payPageUrl(r.redirectUrl, { production: !mocksAllowed() });
      if (!payPage) {
        setPayment("idle");
        setInquiryReason("unavailable");
        return;
      }
      // The reference, so the return page knows which order to ask the server about; the hand-off, so
      // "Return to payment" can repeat this same call if the customer comes back without paying (CO-06).
      writeOrderHint(r.orderReference);
      writePaymentHandoff({ reference: r.orderReference, cartKey: cartFingerprint(cart), quoteId: q.quoteId, verificationId, method, traveller: sent });
      window.location.assign(payPage);
    } catch (e) {
      const apiError = e instanceof ApiError ? e : null;
      setError(apiError);
      setPayment(apiError?.code === "timeout" ? "timeout" : "failed");
      track("payment_failed", {
        payment_method: method,
        failure_reason: apiError?.serverCode ?? apiError?.code ?? "unknown",
        value: Number(BigInt(q.totalMinor)) / 100,
      });
    }
  };

  const pay = async (opts: { acceptedQuoteId?: string } = {}) => {
    const found = validate("all");
    if (Object.keys(found).length) {
      // Details are edited on step 1; the terms box is on this step. Either way focus goes to the summary.
      if (DETAIL_FIELDS.some((f) => found[f])) setStep(1);
      reportErrors();
      return;
    }
    setShowErrorSummary(false);
    setError(null);
    setNotice(null);

    // AC-INV-01 / AC-CO-04: the server re-checks price and availability; a
    // quote about to run out is replaced before anything is charged.
    const fresh = live && Date.parse(live.expiresAt) - Date.now() > QUOTE_MIN_REMAINING_MS ? live : await requestQuote();
    if (!fresh) return;
    const quotedTotal = quotedMoney(fresh.totalMinor, payCurrency, cartTotal);
    if (inPay(quotedTotal) !== inPay(cartTotal) && opts.acceptedQuoteId !== fresh.quoteId && priceChange?.quoteId !== fresh.quoteId) {
      setPriceChange({
        old: cartTotal,
        next: quotedTotal,
        reason: "The operator's rate for this date was re-checked just now. You have not been charged.",
        quoteId: fresh.quoteId,
      });
      setPayment("price_changed");
      return;
    }

    if (verification.current?.quoteId === fresh.quoteId) {
      await startPayment(fresh, verification.current.verificationId);
      return;
    }
    const phone = normalisePhone(traveller.phone, traveller.countryCode);
    try {
      setPayment("processing");
      const attempt = await checkoutAttempt(fresh, phone.e164);
      otpToken.current += 1;
      setOtp({ attempt, quote: fresh, token: otpToken.current });
      setPayment("verifying");
    } catch (e) {
      const apiError = e instanceof ApiError ? e : null;
      setPayment("idle");
      setNotice(apiError?.recovery ?? "We couldn't send the code just now. Try again, or finish this on WhatsApp.");
    }
  };

  if (!hydrated) {
    return (
      <div className="container-page py-10">
        <div className="skeleton h-96 w-full rounded-[var(--radius-tile)]" />
      </div>
    );
  }

  if (cart.length === 0) {
    return (
      <div className="container-page py-10 pb-20">
        <EmptyState
          illustration="cart"
          title="Nothing to check out yet"
          body="Your trip is empty. Add an experience and it'll appear here, or if you started a booking on WhatsApp, we can pick it up from there."
          action={<ButtonLink href="/search">Browse experiences</ButtonLink>}
          secondary={<ButtonLink href="/manage-booking" variant="outline">Find an existing booking</ButtonLink>}
        />
      </div>
    );
  }

  const single = cart.length === 1;
  const first = cart[0];
  // Endowment wording (checklist 4): the summary and the review card are "Your <activity>".
  const tripTitle = single ? `Your ${first.title}` : "Your trip";
  const hasPickup = cart.some((i) => activities.find((a) => a.slug === i.slug)?.pickupIncluded);
  const charge = payDeposit ? chargeText(deposit.now, payCurrency) : chargeText(total, payCurrency);
  const phoneNow = normalisePhone(traveller.phone, traveller.countryCode);
  const phoneShown = phoneNow.valid ? maskPhone(phoneNow.e164) : `${traveller.countryCode} ${traveller.phone}`;

  const summaryDetails = single ? (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[0.9375rem]">
      <dt className="text-ink-600">When</dt>
      <dd className="tnum text-right font-semibold">
        {shortDate(first.date)}, {first.time}
        <span className="block text-xs font-normal text-ink-600">Dubai time</span>
      </dd>
      <dt className="text-ink-600">Guests</dt>
      <dd className="text-right font-semibold">{paxLabel(first.pax)}</dd>
      {hasPickup && traveller.hotel?.trim() ? (
        <>
          <dt className="text-ink-600">Pickup</dt>
          <dd className="text-right font-semibold">{traveller.hotel}</dd>
        </>
      ) : null}
    </dl>
  ) : (
    <ul className="space-y-2 text-[0.9375rem]">
      {cart.map((it) => (
        <li key={it.id} className="flex justify-between gap-3" data-testid="summary-trip-item">
          <span className="min-w-0 font-semibold">{it.title}</span>
          <span className="tnum shrink-0 text-right text-ink-600">
            {shortDate(it.date)}, {it.time}
          </span>
        </li>
      ))}
    </ul>
  );

  const summary = (idPrefix: string) => (
    <OrderSummary
      idPrefix={idPrefix}
      title={tripTitle}
      details={summaryDetails}
      subtotalLabel={single ? paxLabel(first.pax) : undefined}
      itemCount={cart.length}
      subtotal={subtotal}
      discount={discount}
      couponCode={couponResult?.ok ? couponResult.coupon.code : null}
      total={total}
      deposit={deposit}
      payDeposit={payDeposit}
      payCurrency={payCurrency}
      quote={live}
      lineTitle={(index) => cart[index]?.title ?? "Activity"}
    />
  );

  return (
    <div className="mx-auto max-w-[68rem] px-4 pb-24 pt-4 sm:px-6 lg:pt-6">
      {/* Progress (checklist 1): the activity is chosen already; Booked completes only on the status page. */}
      <Stepper
        value={step}
        onValueChange={(n) => {
          if (n === 1 && step === 2) editDetails();
        }}
        label="Booking progress"
        labels={{ complete: "done", current: "current step", upcoming: "" }}
        className="mb-4"
      >
        {STEP_TITLES.map((title, index) => {
          // Only "Your details" goes back, from Review & pay, and not while the payment page is opening.
          const clickable = index === 1 && step === 2 && payment !== "processing" && !codeChecking;
          return (
            <StepperItem key={title} step={index}>
              {clickable ? (
                <StepperTrigger className="min-h-11 min-w-11 justify-center sm:justify-start sm:pe-1">
                  <StepperIndicator />
                  <StepperTitle>{title}</StepperTitle>
                </StepperTrigger>
              ) : (
                <span className="inline-flex min-h-11 min-w-0 items-center gap-2 pe-1">
                  <StepperIndicator />
                  <StepperTitle>{title}</StepperTitle>
                </span>
              )}
              <StepperSeparator />
            </StepperItem>
          );
        })}
      </Stepper>

      {/* Phones: the summary is a bar that opens in place (CO-23). */}
      <div className="mb-4 lg:hidden">
        <button
          type="button"
          aria-expanded={summaryOpen}
          aria-controls="checkout-summary-mobile"
          onClick={() => setSummaryOpen((v) => !v)}
          className="flex min-h-12 w-full items-center justify-between gap-3 rounded-[var(--radius-card)] border border-ink-200 bg-paper px-4 py-3 text-left shadow-[var(--shadow-soft)]"
          data-testid="checkout-summary-bar"
        >
          <span className="font-semibold text-ink-900">Your trip</span>
          <span className="ml-auto font-display text-lg font-bold tnum text-ink-900">{charge}</span>
          <ChevronDown aria-hidden="true" className={cn("size-5 shrink-0 text-ink-700 transition-transform", summaryOpen && "rotate-180")} />
        </button>
        {summaryOpen ? <div id="checkout-summary-mobile" className="mt-2">{summary("order-summary-bar")}</div> : null}
      </div>

      <div className="grid grid-safe gap-6 lg:grid-cols-[minmax(0,1fr)_22.5rem] lg:items-start lg:gap-10">
        <div className="min-w-0 space-y-5">
          <div>
            {/* The step heading takes focus on each step change (CO-28, PRD-23). */}
            <h1 ref={stepHeading} tabIndex={-1} className="text-[1.75rem] outline-none sm:text-3xl">
              {step === 1 ? "Your details" : "Review & pay"}
            </h1>
            <p className="mt-1.5 text-[0.95rem] text-ink-600">
              {step === 1
                ? "Who is this booking for, and where do we send it? No account needed."
                : "Check what you're buying, the price and the cancellation terms, then pay once."}
            </p>
          </div>

          {/* Error summary (PRD-23 criterion 1): focus lands here on a failed submit. */}
          {showErrorSummary && summaryItems.length > 0 && (
            <div
              ref={errorSummaryRef}
              tabIndex={-1}
              role="alert"
              aria-labelledby="error-summary-title"
              data-testid="checkout-error-summary"
              className="rounded-[var(--radius-control)] border border-[color-mix(in_oklab,var(--color-danger)_30%,white)] bg-[var(--color-danger-bg)] p-4 text-sm text-[color-mix(in_oklab,var(--color-danger)_82%,black)] outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink-800"
            >
              <h2 id="error-summary-title" className="text-base font-bold">
                Check {summaryItems.length === 1 ? "this detail" : "these details"} before you continue
              </h2>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {summaryItems.map(([field, message]) => (
                  <li key={field}>
                    <a
                      href={`#${field}`}
                      className="font-semibold underline underline-offset-2"
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(field)?.focus();
                      }}
                    >
                      {FIELD_LABELS[field] ?? field}: {message}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {leftPayment && (
            <div
              ref={leftPaymentRef}
              tabIndex={-1}
              role="status"
              data-testid="checkout-left-payment"
              className="rounded-[var(--radius-control)] border border-[color-mix(in_oklab,var(--color-info)_30%,white)] bg-[var(--color-info-bg)] p-4 text-sm text-ink-900 outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink-800"
            >
              {leftPayment.state === "moved_on" ? (
                <>
                  <p className="font-bold">This trip already has a booking, {leftPayment.reference}.</p>
                  <p className="mt-1 leading-relaxed">Check where it stands before you pay again.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <ButtonLink href={`/booking/${encodeURIComponent(leftPayment.reference)}`} size="sm">
                      View my booking
                    </ButtonLink>
                  </div>
                </>
              ) : (
                <>
                  {/* `awaiting_payment` also covers "paid, Stripe's confirmation not in yet": the words allow for both. */}
                  <p className="font-bold">
                    {leftPayment.state === "closed"
                      ? "That payment page can no longer be used."
                      : leftPayment.state === "unchecked"
                        ? "We couldn't check your earlier payment just now."
                        : "You left the payment page."}
                  </p>
                  <p className="mt-1 leading-relaxed">
                    {leftPayment.state === "closed"
                      ? "If you paid on it, don't pay again: your booking page shows the payment as soon as Stripe confirms it. If you didn't, start again; your details are kept."
                      : "If you've just paid, don't pay again: we're checking with Stripe, and your booking page updates by itself. If you didn't pay, you can go back to the same payment page. Your details are kept."}
                    {leftPayment.state === "failed" ? " We couldn't open the payment page just now. Try again in a moment." : ""}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {leftPaymentActions(leftPayment.state).returnToPayment && (
                      <Button
                        size="sm"
                        loading={leftPayment.state === "resuming"}
                        loadingLabel="Opening the payment page…"
                        onClick={() => void returnToPayment()}
                      >
                        Return to payment
                      </Button>
                    )}
                    {leftPaymentActions(leftPayment.state).checkAgain && (
                      <Button size="sm" variant="outline" onClick={() => void checkHandoff()}>
                        Check again
                      </Button>
                    )}
                    {leftPaymentActions(leftPayment.state).startAgain && (
                      <Button size="sm" onClick={startAgain}>
                        Start again
                      </Button>
                    )}
                    <ButtonLink href={`/booking/${encodeURIComponent(leftPayment.reference)}`} size="sm" variant="outline">
                      View booking status
                    </ButtonLink>
                  </div>
                </>
              )}
            </div>
          )}

          {inquiryReason && (
            <BlockingNotice
              ref={inquiryNoticeRef}
              focusable
              title="This trip can't be paid for online"
              testId="checkout-needs-inquiry"
              action={
                <div className="flex flex-wrap gap-2">
                  <ButtonLink href={inquiryHref(inquiryReason)} size="sm">
                    Send it to our team
                  </ButtonLink>
                  <ButtonLink href="/cart" size="sm" variant="outline">
                    Back to my trip
                  </ButtonLink>
                </div>
              }
            >
              <p>
                {inquiryReasonText(inquiryReason)}
                {outstanding ? "" : " Nothing has been charged."} Our team confirms it with the operator and replies on
                WhatsApp; your details go with it.
              </p>
            </BlockingNotice>
          )}

          {/* ---------------------------------------------------- YOUR DETAILS */}
          {step === 1 && (
            <Card className="p-5 sm:p-6">
              <h2 className="sr-only">Who&apos;s travelling</h2>
              <div className="space-y-5">
                <Field
                  label="Full name"
                  id="fullName"
                  value={traveller.fullName}
                  onChange={(v) => setTraveller((t) => ({ ...t, fullName: v }))}
                  onBlur={() => blurField("fullName")}
                  error={errors.fullName}
                  hint="As on your passport, in English letters."
                  autoComplete="name"
                  required
                />
                <Field
                  label="Email"
                  id="email"
                  type="email"
                  inputMode="email"
                  value={traveller.email}
                  onChange={(v) => setTraveller((t) => ({ ...t, email: v }))}
                  onBlur={() => blurField("email")}
                  error={errors.email}
                  hint="Your voucher is emailed here once the operator issues it."
                  autoComplete="email"
                  required
                />
                <div>
                  <label htmlFor="phone" className="block text-sm font-bold text-ink-900">
                    Mobile number
                  </label>
                  <p id="phone-hint" className="mt-0.5 text-sm text-ink-600">
                    We text a code to this number to confirm your booking.
                  </p>
                  <PhoneInput
                    id="phone"
                    name="tel-national"
                    defaultCountry={countryForDialCode(traveller.countryCode)}
                    countries={PHONE_COUNTRIES}
                    value={traveller.phone}
                    onValueChange={(phone, country) => setTraveller((t) => ({ ...t, phone, countryCode: country.dialCode }))}
                    onBlur={() => blurField("phone")}
                    label="Mobile number"
                    placeholder={traveller.countryCode === "+91" ? "98765 43210" : "50 123 4567"}
                    required
                    aria-required="true"
                    aria-invalid={errors.phone ? true : undefined}
                    aria-describedby={errors.phone ? "phone-hint phone-error" : "phone-hint"}
                    className="mt-2 w-full"
                    classNames={{ field: "h-12 bg-paper", input: "text-base", trigger: "min-w-[5.5rem]" }}
                  />
                  {errors.phone ? <FieldMessage id="phone-error">{errors.phone}</FieldMessage> : null}
                </div>

                {/* Hotel only for products with pickup (CO-10). */}
                {hasPickup && (
                  <Field
                    label="Hotel for pickup"
                    id="hotel"
                    value={traveller.hotel ?? ""}
                    onChange={(v) => setTraveller((t) => ({ ...t, hotel: v }))}
                    hint="Not sure yet? Leave it and tell us later."
                    autoComplete="off"
                  />
                )}

                <Button
                  size="lg"
                  block
                  onClick={() => {
                    if (Object.keys(validate("details")).length) {
                      reportErrors();
                      return;
                    }
                    setErrors({});
                    setShowErrorSummary(false);
                    goToStep(2);
                  }}
                >
                  Continue to review
                </Button>
              </div>
            </Card>
          )}

          {/* ---------------------------------------------------- REVIEW & PAY */}
          {step === 2 && (
            <>
              <Card className="p-5 sm:p-6">
                <h2 className="text-xl">{tripTitle}</h2>
                <ul className={cn("mt-3", !single && "divide-y divide-ink-200")}>
                  {cart.map((item, index) => (
                    <li key={item.id} className={cn(!single && "py-3")} data-testid="checkout-review-item">
                      <div className="flex gap-3">
                        <div className="min-w-0 flex-1">
                          {!single && <p className="font-bold leading-snug text-ink-900">{item.title}</p>}
                          <p className="tnum text-[0.95rem] text-ink-900">
                            {reviewDate(item.date)} · {item.time} Dubai time · {paxLabel(item.pax)}
                          </p>
                        </div>
                        {/* In the currency charged (PRD-8); with a quote, that line's own charged amount. */}
                        {!single && <p className="shrink-0 font-bold tnum">{chargeText(lineCharged(index, item.total), payCurrency)}</p>}
                      </div>
                      {/* One statement (CO-01): the quote's own words once it exists, the operator's policy before. */}
                      <p
                        className="mt-3 flex gap-2.5 rounded-[var(--radius-control)] bg-lagoon-50 p-3.5 text-[0.95rem] text-ink-900"
                        data-testid="checkout-cancellation-line"
                      >
                        <ShieldCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-lagoon-700" />
                        <span>
                          {live?.lines.find((l) => l.index === index)?.freeCancellationCopy ??
                            cancellationPolicyBeforeQuote(item.freeCancellationHours)}
                        </span>
                      </p>
                    </li>
                  ))}
                </ul>
                {live && (
                  <p className="mt-3 flex gap-2 text-sm text-ink-600" data-testid="checkout-quote-validity">
                    <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span>
                      Price checked with the operator. It stays valid until {dubaiClock(live.expiresAt)} Dubai time. Your place is
                      confirmed only after you pay.
                    </span>
                  </p>
                )}
                {quoteState === "failed" && (
                  <Alert
                    tone="warning"
                    title="We couldn't check the price with the operator"
                    className="mt-4"
                    icon={<AlertTriangle className="h-4.5 w-4.5" />}
                    action={
                      <Button size="sm" variant="outline" onClick={() => void requestQuote()}>
                        <RefreshCw className="h-4 w-4" /> Try again
                      </Button>
                    }
                  >
                    {error?.recovery ??
                      (outstanding
                        ? "Try again in a moment, or finish this on WhatsApp."
                        : "Nothing has been charged. Try again in a moment, or finish this on WhatsApp.")}
                  </Alert>
                )}
              </Card>

              <Card className="p-5 sm:p-6">
                <div className="flex items-start justify-between gap-4">
                  <h2 className="text-xl">Who&apos;s travelling</h2>
                  <button
                    type="button"
                    onClick={editDetails}
                    disabled={payment === "processing" || codeChecking}
                    className="inline-flex min-h-11 shrink-0 items-center gap-1.5 text-sm font-bold text-sun-700 underline underline-offset-4 disabled:opacity-50"
                  >
                    <Pencil aria-hidden="true" className="size-4" />
                    Edit<span className="sr-only"> traveller details</span>
                  </button>
                </div>
                <div className="mt-2 space-y-1 text-[0.95rem] text-ink-900">
                  <p className="font-semibold">{traveller.fullName}</p>
                  <p className="break-words">{traveller.email}</p>
                  <p className="tnum">{phoneShown}</p>
                  {hasPickup && traveller.hotel?.trim() ? <p>Pickup: {traveller.hotel}</p> : null}
                </div>
              </Card>

              {/* Promo behind "Have a promo code?" (CO-25, checklist 9); the server quote decides its worth. */}
              <div>
                <CollapsiblePromo
                  triggerLabel={appliedCoupon ? `Promo ${appliedCoupon} applied` : "Have a promo code?"}
                  value={coupon}
                  onValueChange={(v) => {
                    setCoupon(v.toUpperCase());
                    if (couponResult && !couponResult.ok) setCouponResult(null);
                  }}
                  onApply={() => {
                    // A new promo re-quotes; not while a code for this quote is being checked.
                    if (coupon.trim() && !codeChecking) onApplyCoupon();
                  }}
                  applyLabel="Apply"
                  placeholder="For example FIRSTTRIP"
                  error={couponResult && !couponResult.ok ? couponResult.message : undefined}
                />
                <p className="mt-1.5 text-sm font-semibold text-[var(--color-success)]" role="status">
                  {couponResult?.ok ? couponResult.message : ""}
                </p>
              </div>

              {/* Price re-consent (AC-CO-04) */}
              {payment === "price_changed" && priceChange && (
                <BlockingNotice
                  title="The price changed while you were booking"
                  testId="checkout-price-changed"
                  action={
                    <div className="flex flex-wrap gap-2">
                      <Button
                        ref={acceptPriceRef}
                        size="sm"
                        onClick={() => {
                          setPayment("idle");
                          void pay({ acceptedQuoteId: priceChange.quoteId });
                        }}
                      >
                        Accept {priceIn(priceChange.next, payCurrency)} and pay
                      </Button>
                      <ButtonLink href="/cart" size="sm" variant="outline">
                        Back to my trip
                      </ButtonLink>
                    </div>
                  }
                >
                  <p>
                    Was {priceIn(priceChange.old, payCurrency)}, now {priceIn(priceChange.next, payCurrency)}.{" "}
                    {priceChange.reason}
                  </p>
                </BlockingNotice>
              )}

              {notice && <BlockingNotice testId="checkout-notice">{notice}</BlockingNotice>}

              {/* Payment failure (AC-CO-03) */}
              {(payment === "failed" || payment === "timeout") && (
                <Alert
                  tone={payment === "timeout" ? "warning" : "danger"}
                  title={
                    payment === "timeout"
                      ? "We haven't heard back from the payment gateway"
                      : "That payment didn't go through"
                  }
                  action={
                    <div className="flex flex-wrap gap-2">
                      {payment === "failed" && (
                        <Button ref={retryPaymentRef} size="sm" onClick={() => void pay()}>
                          <RefreshCw className="h-4 w-4" /> Try again
                        </Button>
                      )}
                      <WhatsAppButton
                        size="sm"
                        context={{
                          intent: "payment_help",
                          checkoutStep: "payment",
                          priceLabel: priceIn(total, currency),
                          placement: "checkout_payment_error",
                        }}
                      />
                    </div>
                  }
                >
                  {error?.recovery ??
                    (outstanding
                      ? "Your trip is exactly as you left it. Try again, or we'll send you a payment link on WhatsApp."
                      : "Nothing has been charged and your trip is exactly as you left it. Try again, or we'll send you a payment link on WhatsApp.")}
                </Alert>
              )}

              {/* Deposit option */}
              {DEPOSITS_OFFERED && total.inr >= DEPOSIT_THRESHOLD_INR && (
                <label className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-control)] border border-lagoon-200 bg-lagoon-50 p-3.5">
                  <input
                    type="checkbox"
                    checked={payDeposit}
                    onChange={(e) => setPayDeposit(e.target.checked)}
                    className="mt-0.5 h-4.5 w-4.5 rounded accent-lagoon-600"
                  />
                  <span className="text-sm">
                    <span className="block font-bold text-lagoon-700">
                      Pay 30% now, the rest 7 days before you travel
                    </span>
                    <span className="mt-0.5 block text-lagoon-700/80">
                      {priceIn(deposit.now, payCurrency)} today, {priceIn(deposit.later, payCurrency)} on
                      the balance date. We&apos;ll remind you on WhatsApp. Your booking is confirmed
                      either way.
                    </span>
                  </span>
                </label>
              )}

              <section aria-labelledby="pay-heading" className="space-y-3">
                <h2 id="pay-heading" className="sr-only">
                  Pay
                </h2>
                <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink-700">
                  <input
                    type="checkbox"
                    checked={terms}
                    id="terms"
                    onChange={(e) => setTerms(e.target.checked)}
                    aria-invalid={Boolean(errors.terms)}
                    aria-describedby={errors.terms ? "terms-error" : undefined}
                    className="mt-0.5 h-5 w-5 shrink-0 rounded accent-ink-900"
                  />
                  <span>
                    I&apos;ve read the{" "}
                    <Link href="/cancellation-policy" className="font-bold text-sun-700 underline">
                      cancellation policy
                    </Link>{" "}
                    and{" "}
                    <Link href="/terms" className="font-bold text-sun-700 underline">
                      terms
                    </Link>{" "}
                    for these activities.
                  </span>
                </label>
                {errors.terms && <FieldMessage id="terms-error">{errors.terms}</FieldMessage>}

                <div className="flex items-baseline justify-between gap-3 px-1">
                  <span className="font-bold text-ink-900">Total to pay</span>
                  <span className="font-display text-2xl font-bold tnum text-ink-900" data-testid="checkout-total">
                    {charge}
                  </span>
                </div>

                {payment === "verifying" && otp && verificationMatchesQuote(otp.quote.quoteId, live?.quoteId) ? (
                  <CheckoutVerify
                    attempt={otp.attempt}
                    onAttemptChange={(attempt) => setOtp({ ...otp, attempt })}
                    sending={false}
                    onBusyChange={setCodeChecking}
                    onVerified={async () => {
                      // Decided from what is on the page now, not from this render (follow-up A).
                      const v = verification.current;
                      const action = verifiedAnswerAction({
                        answerQuoteId: otp.quote.quoteId,
                        answerToken: otp.token,
                        currentToken: otpToken.current,
                        liveQuoteId: liveQuoteIdRef.current,
                        step: stepRef.current,
                        verificationQuoteId: v?.quoteId ?? null,
                      });
                      if (action === "discard" || !v) {
                        // Only the quote on screen may be paid: a code made for an earlier quote, card or step is
                        // dropped, and the visitor starts again from Pay (canPay, any re-consent, a new code).
                        if (verification.current?.quoteId === otp.quote.quoteId) verification.current = null;
                        if (otpToken.current === otp.token) {
                          setOtp(null);
                          setPayment("idle");
                          if (stepRef.current === 2) {
                            setNotice("Your booking details changed, so we need to confirm your number again. Press pay to get a new code.");
                          }
                        }
                        return;
                      }
                      setOtp(null);
                      await startPayment(otp.quote, v.verificationId);
                    }}
                    onChangeNumber={() => {
                      setOtp(null);
                      setPayment("idle");
                      editDetails();
                    }}
                  />
                ) : (
                  <Button
                    ref={payButtonRef}
                    block
                    size="lg"
                    disabled={!payAllowed}
                    loading={payment === "processing" || quoteState === "loading"}
                    loadingLabel={quoteState === "loading" ? "Checking the price with the operator…" : "Opening the secure payment page…"}
                    onClick={() => void pay()}
                  >
                    {payDeposit ? `Verify number and pay ${charge} deposit` : `Verify number and pay ${charge}`}
                  </Button>
                )}

                {payment === "processing" && (
                  <p className="text-center text-xs text-ink-600" role="status">
                    Re-checking availability with the operator before charging you. Don&apos;t close this page, it usually takes a few
                    seconds.
                  </p>
                )}

                <p className="flex gap-1.5 px-1 text-sm text-ink-600">
                  <Lock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    First we text a 6-digit code to {phoneShown}. Then you pay by card on Stripe&apos;s secure page, charged in{" "}
                    {payCurrency}, and come straight back here.
                  </span>
                </p>
              </section>
            </>
          )}

          {hasManual && (
            <Alert tone="info" title="One of these needs the operator to confirm">
              You&apos;ll get a status message within five minutes and the confirmed voucher within
              two hours. If the operator can&apos;t take it, we offer you an alternative SKU, an
              alternative date or a full refund, within two hours, without you having to chase.
            </Alert>
          )}

          <div className="rounded-[var(--radius-card)] border border-ink-200 bg-paper p-5 text-sm">
            <h2 className="mb-2 text-[0.95rem]">What happens next</h2>
            <ol className="space-y-2 text-ink-600">
              <li className="flex gap-2">
                <span className="font-bold text-ink-900">1.</span> You pay on Stripe. Your card is
                held first, and charged once the operator has reserved your place.
              </li>
              <li className="flex gap-2">
                <span className="font-bold text-ink-900">2.</span> The operator confirms the booking.
                If they can&apos;t, you get the full amount back automatically. Your booking page
                updates by itself.
              </li>
              <li className="flex gap-2">
                <span className="font-bold text-ink-900">3.</span> We email your voucher as soon as
                the operator issues it, usually within a few minutes. You can also download it from
                your booking page.
              </li>
            </ol>
          </div>
        </div>

        {/* ------------------------------------------------------ SUMMARY (desktop: sticky column) */}
        <aside className="hidden lg:sticky lg:top-6 lg:block" aria-label="Order summary">
          {summary("order-summary")}
        </aside>
      </div>
    </div>
  );
}

/** "14:42" in Dubai time for a UTC ISO instant. */
function dubaiClock(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + DUBAI_UTC_OFFSET_MS).toISOString().slice(11, 16);
}

/** A field error: text plus an icon, so it is not shown by colour alone (CO-29). */
function FieldMessage({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className="mt-1.5 flex gap-1.5 text-sm font-semibold text-[var(--color-danger)]">
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function Field({
  label,
  id,
  value,
  onChange,
  onBlur,
  error,
  hint,
  type = "text",
  inputMode,
  required,
  autoComplete,
}: {
  label: string;
  id: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  error?: string;
  hint?: string;
  type?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  required?: boolean;
  autoComplete?: string;
}) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-bold text-ink-900">
        {label}
        {!required && <span className="font-normal text-ink-600"> (optional)</span>}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="mt-0.5 text-sm text-ink-600">
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        type={type}
        inputMode={inputMode}
        value={value}
        autoComplete={autoComplete}
        required={required}
        aria-required={required || undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        className={cn(
          "mt-2 min-h-12 w-full rounded-[var(--radius-control)] border bg-paper px-3.5 text-base outline-none focus:border-sun-700 focus:ring-[3px] focus:ring-sun-300/45",
          error ? "border-[var(--color-danger)]" : "border-ink-300",
        )}
      />
      {error ? <FieldMessage id={`${id}-error`}>{error}</FieldMessage> : null}
    </div>
  );
}

const WARNING_NOTICE =
  "rounded-[var(--radius-control)] border border-[color-mix(in_oklab,var(--color-warning)_30%,white)] bg-[var(--color-warning-bg)] p-3.5 text-sm text-[color-mix(in_oklab,var(--color-warning)_85%,black)]";

/**
 * The shared warning `Alert`'s look with `role="alert"`: a change that blocks
 * payment (price changed, price hold expired) is announced assertively
 * (PRD-23 criterion 3). The shared `Alert` gives warnings `role="status"`.
 */
function BlockingNotice({
  ref,
  focusable,
  title,
  children,
  action,
  className,
  testId,
}: {
  ref?: React.Ref<HTMLDivElement>;
  /** The notice can take focus (tabIndex -1): one that appears after an action moves focus to itself. */
  focusable?: boolean;
  title?: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      ref={ref}
      tabIndex={focusable ? -1 : undefined}
      role="alert"
      className={cn(WARNING_NOTICE, focusable && "outline-none focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink-800", className)}
      data-testid={testId}
    >
      <div className="flex gap-2.5">
        <span className="mt-0.5 shrink-0" aria-hidden="true">
          <AlertTriangle className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          {title && <p className="font-bold">{title}</p>}
          {children && <div className={cn("leading-relaxed", title && "mt-0.5")}>{children}</div>}
          {action && <div className="mt-2.5">{action}</div>}
        </div>
      </div>
    </div>
  );
}
