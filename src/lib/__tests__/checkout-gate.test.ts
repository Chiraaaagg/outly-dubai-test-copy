import { describe, expect, it } from "vitest";
import { payPageUrl, STRIPE_CHECKOUT_ORIGIN } from "../checkout-gate";

describe("payPageUrl (doc 22 §32.34)", () => {
  const stripe = `${STRIPE_CHECKOUT_ORIGIN}/c/pay/cs_test_a1B2c3#fidkdWxOYHwnPyd1blpxYHZxWjA0`;

  it("a production build opens Stripe's hosted Checkout only", () => {
    expect(payPageUrl(stripe, { production: true })).toBe(stripe);
    for (const url of [
      "https://stripe_aed.invalid/pay/fake-1", // a fake gateway's page
      "https://checkout.stripe.com.evil.example/c/pay/x", // lookalike host
      "https://evil.example/?next=https://checkout.stripe.com",
      "http://checkout.stripe.com/c/pay/x", // not https
      "https://user:pass@checkout.stripe.com/c/pay/x", // credentials in the URL
      "https://checkout.stripe.com:8443/c/pay/x", // another port is another origin
      "javascript:alert(1)",
      "/relative/path",
      "",
    ]) {
      expect(payPageUrl(url, { production: true }), url).toBeNull();
    }
  });

  it("development and preview builds also open the fake gateways' https pages, never anything but https", () => {
    expect(payPageUrl("https://stripe_aed.invalid/pay/fake-1", { production: false })).toBe("https://stripe_aed.invalid/pay/fake-1");
    expect(payPageUrl(stripe, { production: false })).toBe(stripe);
    expect(payPageUrl("http://localhost:3002/pay", { production: false })).toBeNull();
    expect(payPageUrl("javascript:alert(1)", { production: false })).toBeNull();
  });
});
