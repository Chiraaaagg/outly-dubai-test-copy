import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CartItem } from "../types";

/**
 * Checkout redesign batch 1 (docs/checkout-redesign-review/rollout-plan.md
 * §4): the copy helpers and the client-side recovery decisions, tested by
 * behaviour. Synthetic values only.
 */

const startCheckout = vi.fn();
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), startCheckout: (...a: unknown[]) => startCheckout(...a) }));

const { cancellationPolicyBeforeQuote, freeCancellationCopy, NON_REFUNDABLE_STATEMENT } = await import("../utils");
const { cartGoesToInquiry } = await import("../pricing");
const draftMod = await import("../checkout-draft");
const { inquiryHref, inquiryReasonForQuote, inquiryReasonText, parseInquiryReason } = await import("../inquiry-handoff");
const { resumePayment, resumeRequest } = await import("../resume-payment");
const { ctaFor } = await import("../cta");
const { Button } = await import("@/components/ui/button");

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}

const REF = "OUT-123455";
const CART = [
  { id: "c1", date: "2026-11-18", time: "21:00", pax: { adult: 1 } },
  { id: "c2", date: "2026-11-19", time: "15:00", pax: { adult: 2 } },
];
const HANDOFF = {
  reference: REF,
  cartKey: draftMod.cartFingerprint(CART),
  quoteId: "01890000-0000-7000-8000-000000000001",
  verificationId: "01890000-0000-7000-8000-000000000002",
  method: "card",
  traveller: { fullName: "Aisha Rahman", phoneE164: "+971501234567", email: "aisha@example.com" },
};

describe("CO-01: one cancellation statement", () => {
  it("the quote's statement is the exact deadline in Dubai time", () => {
    // 17:00 UTC is 21:00 in Dubai (UTC+4, no daylight saving).
    expect(freeCancellationCopy("2026-11-15T17:00:00.000Z")).toBe("Free cancellation until Sun 15 Nov 2026, 21:00 Dubai time. After that, the booking is non-refundable.");
    expect(freeCancellationCopy(null)).toBe(NON_REFUNDABLE_STATEMENT);
    expect(freeCancellationCopy("not a date")).toBe("This booking is non-refundable once confirmed.");
  });

  it("before a quote, the catalogue figure is worded as the operator's policy, confirmed at review", () => {
    expect(cancellationPolicyBeforeQuote(72)).toBe(
      "The operator's policy: free cancellation up to 72 hours before the start. Your exact deadline, in Dubai time, is confirmed with the price before you pay.",
    );
    expect(cancellationPolicyBeforeQuote(0)).toMatch(/^The operator's policy: non-refundable once confirmed\./);
    expect(cancellationPolicyBeforeQuote(Number.NaN)).toMatch(/non-refundable/);
  });
});

describe("CO-03: one rule for the cart and the checkout", () => {
  const item = (mode: "instant" | "inquiry", n: number): CartItem => ({ id: `i${n}`, fulfilmentMode: mode }) as unknown as CartItem;

  it("all-instant carts up to five items continue to checkout; mixed, empty and six-item carts go to inquiry", () => {
    expect(cartGoesToInquiry([item("instant", 1)])).toBe(false);
    expect(cartGoesToInquiry([1, 2, 3, 4, 5].map((n) => item("instant", n)))).toBe(false);
    expect(cartGoesToInquiry([1, 2, 3, 4, 5, 6].map((n) => item("instant", n)))).toBe(true);
    expect(cartGoesToInquiry([item("instant", 1), item("inquiry", 2)])).toBe(true);
    expect(cartGoesToInquiry([])).toBe(true);
  });
});

describe("CO-06: the checkout draft", () => {
  it("keeps name, email and mobile only, and reads back only well-formed values", () => {
    const s = memoryStorage();
    draftMod.writeCheckoutDraft({ fullName: "Aisha Rahman", email: "aisha@example.com", phone: "501234567", countryCode: "+971", card: "4242" } as never, s);
    expect(JSON.parse(s.raw.get(draftMod.CHECKOUT_DRAFT_KEY)!)).toEqual({ fullName: "Aisha Rahman", email: "aisha@example.com", phone: "501234567", countryCode: "+971" });
    expect(draftMod.readCheckoutDraft(s)).toEqual({ fullName: "Aisha Rahman", email: "aisha@example.com", phone: "501234567", countryCode: "+971" });
    s.setItem(draftMod.CHECKOUT_DRAFT_KEY, JSON.stringify({ fullName: "A", countryCode: "javascript:" }));
    expect(draftMod.readCheckoutDraft(s)).toEqual({ fullName: "A", email: "", phone: "", countryCode: "" });
    s.setItem(draftMod.CHECKOUT_DRAFT_KEY, "{not json");
    expect(draftMod.readCheckoutDraft(s)).toBeNull();
    draftMod.writeCheckoutDraft({ fullName: "", email: "", phone: "", countryCode: "+91" }, s);
    expect(s.raw.has(draftMod.CHECKOUT_DRAFT_KEY)).toBe(false);
  });

  it("storage that throws never breaks the page", () => {
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(draftMod.readCheckoutDraft(broken)).toBeNull();
    expect(() => draftMod.writeCheckoutDraft({ fullName: "A", email: "", phone: "", countryCode: "+91" }, broken)).not.toThrow();
    expect(() => draftMod.clearPaymentHandoff(broken)).not.toThrow();
  });

  it("is spent once the payment arrived or the order is over, but kept after a failed payment (review finding 8)", () => {
    expect(draftMod.PAYMENT_SETTLED_STATES).not.toContain("awaiting_payment");
    // "Try again with another card": the details stay for that try.
    expect(draftMod.PAYMENT_SETTLED_STATES).not.toContain("payment_failed");
    for (const st of ["payment_processing", "booking_processing", "confirmed", "refunded", "cancelled"]) expect(draftMod.PAYMENT_SETTLED_STATES).toContain(st);
  });
});

describe("CO-06: the payment hand-off", () => {
  it("round-trips with its cart fingerprint and the traveller as sent", () => {
    const s = memoryStorage();
    draftMod.writePaymentHandoff(HANDOFF, s);
    expect(draftMod.readPaymentHandoff(s)).toEqual(HANDOFF);
  });

  it("is refused when malformed: bad reference, no cart key, no name", () => {
    const s = memoryStorage();
    for (const bad of [{ ...HANDOFF, reference: "../evil" }, { ...HANDOFF, cartKey: "" }, { ...HANDOFF, traveller: { ...HANDOFF.traveller, fullName: " " } }]) {
      draftMod.writePaymentHandoff(bad, s);
      expect(draftMod.readPaymentHandoff(s)).toBeNull();
    }
  });

  it("the fingerprint changes with any line of the cart", () => {
    const key = draftMod.cartFingerprint(CART);
    expect(draftMod.cartFingerprint([...CART])).toBe(key);
    expect(draftMod.cartFingerprint([CART[0]])).not.toBe(key);
    expect(draftMod.cartFingerprint([{ ...CART[0], date: "2026-11-20" }, CART[1]])).not.toBe(key);
    expect(draftMod.cartFingerprint([{ ...CART[0], pax: { adult: 2 } }, CART[1]])).not.toBe(key);
  });

  it("is acted on only for the same cart; another cart's record is just cleared (review finding 2)", () => {
    const key = draftMod.cartFingerprint(CART);
    expect(draftMod.handoffAction(null, key, "awaiting_payment")).toBe("ignore");
    expect(draftMod.handoffAction(HANDOFF, draftMod.cartFingerprint([CART[0]]), "awaiting_payment")).toBe("clear");
    expect(draftMod.handoffAction(HANDOFF, key, "awaiting_payment")).toBe("offer_return");
    expect(draftMod.handoffAction(HANDOFF, key, "booking_processing")).toBe("show_booking");
    // This browser can no longer see the order: nothing to say about it.
    expect(draftMod.handoffAction(HANDOFF, key, null)).toBe("clear");
  });

  it("while a payment may still have been made, only the same page or the booking is offered (review finding 1)", () => {
    for (const st of ["open", "resuming", "failed"] as const) {
      expect(draftMod.leftPaymentActions(st)).toEqual({ returnToPayment: true, viewBooking: true, startAgain: false, checkAgain: false });
    }
    // Starting again (a new quote and order) only once the server says the old page can't be used.
    expect(draftMod.leftPaymentActions("closed")).toEqual({ returnToPayment: false, viewBooking: true, startAgain: true, checkAgain: false });
  });

  it("when the order's status can't be read, the payment page is still treated as possibly paid (follow-up 1)", () => {
    expect(draftMod.leftPaymentActions("unchecked")).toEqual({ returnToPayment: true, viewBooking: true, startAgain: false, checkAgain: true });
    expect(draftMod.paymentOutstanding("unchecked")).toBe(true);
    const ready = { quoteReady: true, hasLiveQuote: true, inquiryReason: null };
    expect(draftMod.canPay({ ...ready, paymentOutstanding: draftMod.paymentOutstanding("unchecked") })).toBe(false);
  });

  it("only a page that may still be paid is outstanding (follow-ups 1 and 2)", () => {
    for (const st of ["open", "unchecked", "resuming", "failed"] as const) expect(draftMod.paymentOutstanding(st)).toBe(true);
    for (const st of ["closed", "moved_on", null, undefined] as const) expect(draftMod.paymentOutstanding(st)).toBe(false);
  });
});

describe("CO-07 and review findings 1, 6: when the pay button works", () => {
  const ready = { quoteReady: true, hasLiveQuote: true, inquiryReason: null };
  it("needs a ready, live quote", () => {
    expect(draftMod.canPay(ready)).toBe(true);
    expect(draftMod.canPay({ ...ready, quoteReady: false })).toBe(false);
    expect(draftMod.canPay({ ...ready, hasLiveQuote: false })).toBe(false);
  });
  it("is off while the page says the trip can't be paid online", () => {
    expect(draftMod.canPay({ ...ready, inquiryReason: "unavailable" })).toBe(false);
  });
  it("is off while an earlier payment page for this cart may still be paid", () => {
    expect(draftMod.canPay({ ...ready, paymentOutstanding: true })).toBe(false);
  });
});

describe("CO-06: return to payment repeats the same checkout call", () => {
  beforeEach(() => startCheckout.mockReset());

  it("posts exactly what the pay button sent, from the hand-off, not the form (review finding 9)", async () => {
    startCheckout.mockResolvedValue({ orderReference: REF, redirectUrl: "https://checkout.stripe.com/c/pay/cs_test_1" });
    await expect(resumePayment(HANDOFF)).resolves.toEqual({ kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    expect(startCheckout).toHaveBeenCalledWith(resumeRequest(HANDOFF));
    expect(resumeRequest(HANDOFF)).toEqual({
      quoteId: HANDOFF.quoteId,
      verificationId: HANDOFF.verificationId,
      method: "card",
      traveller: { fullName: "Aisha Rahman", phoneE164: "+971501234567", email: "aisha@example.com" },
    });
  });

  it("writes the order reference hint again, so the next return from Stripe finds the order (final shop run)", async () => {
    const store = new Map<string, string>();
    const sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    vi.stubGlobal("window", { sessionStorage });
    try {
      startCheckout.mockResolvedValue({ orderReference: REF, redirectUrl: "https://checkout.stripe.com/c/pay/cs_test_1" });
      await resumePayment(HANDOFF);
      expect(store.get("outlyy.orderRef")).toBe(REF);
      store.clear();
      startCheckout.mockResolvedValue({ refused: "quote_expired" });
      await resumePayment(HANDOFF);
      expect(store.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a refused page is closed; a hiccup can be retried", async () => {
    startCheckout.mockResolvedValue({ refused: "quote_expired" });
    await expect(resumePayment(HANDOFF)).resolves.toEqual({ kind: "closed" });
    startCheckout.mockResolvedValue({ refused: "requires_inquiry" });
    await expect(resumePayment(HANDOFF)).resolves.toEqual({ kind: "closed" });
    startCheckout.mockResolvedValue({ refused: "try_again" });
    await expect(resumePayment(HANDOFF)).resolves.toEqual({ kind: "failed" });
    // A transport failure (the client throws before any answer).
    startCheckout.mockImplementation(() => {
      throw new Error("offline");
    });
    await expect(resumePayment(HANDOFF)).resolves.toEqual({ kind: "failed" });
    // The recorded error result stays on the spy until it is reset; this runner reports it otherwise.
    startCheckout.mockReset();
  });

  it("a page that is not https is never opened", async () => {
    startCheckout.mockResolvedValue({ orderReference: REF, redirectUrl: "http://checkout.stripe.com/c/pay/x" });
    await expect(resumePayment(HANDOFF)).resolves.toEqual({ kind: "closed" });
  });
});

describe("CO-07: the reason a trip goes to the inquiry form", () => {
  it("maps refusals to a plain reason", () => {
    expect(inquiryReasonForQuote(["past_cutoff"])).toBe("cutoff");
    expect(inquiryReasonForQuote(["same_day_inquiry_only"])).toBe("cutoff");
    expect(inquiryReasonForQuote(["pickup_unavailable", "sold_out"])).toBe("pickup");
    expect(inquiryReasonForQuote(["sold_out"])).toBe("sold_out");
    expect(inquiryReasonForQuote(["multi_instant_inquiry"])).toBe("over_limit");
    expect(inquiryReasonForQuote(["requires_inquiry"])).toBe("unavailable");
    expect(inquiryReasonText("over_limit")).toMatch(/up to 5 activities/);
  });

  it("only known reasons come back from the URL", () => {
    for (const r of ["mixed", "over_limit", "cutoff", "sold_out", "pickup", "unavailable"] as const) {
      expect(parseInquiryReason(new URL(inquiryHref(r), "https://outlyy.test").searchParams.get("reason"))).toBe(r);
    }
    for (const bad of ["<script>", "toString", "constructor", "", null, undefined]) expect(parseInquiryReason(bad)).toBeNull();
  });
});

describe("CO-11: the instant CTA", () => {
  it("promises the voucher email, not a time it does not meet", () => {
    expect(ctaFor("instant").microcopy).toBe("Instant confirmation · voucher by email, usually within a few minutes");
    expect(ctaFor("instant").microcopy).not.toMatch(/under a minute|WhatsApp/);
  });
});

describe("primary buttons: dark ink on marigold (owner decision)", () => {
  it("renders the primary button with ink-900 text on sun-500", () => {
    const html = renderToStaticMarkup(createElement(Button, null, "Pay"));
    expect(html).toMatch(/class="[^"]*bg-sun-500[^"]*"/);
    expect(html).toMatch(/class="[^"]*text-ink-900[^"]*"/);
    expect(html).not.toMatch(/text-white/);
  });
});
