import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OtpVerificationCard } from "../otp-verification-card";
import { verifyErrorMessage } from "../checkout-verify";
import { ApiError } from "@/lib/api";

/**
 * Imported OTP Verification Card (sean0205, 21st.dev) as the checkout's inline
 * number check (checkout redesign batch 2, CO-30, CO-31). Pins the approved
 * edits (copy props, the one error line) and the field semantics the checkout
 * relies on: a labelled one-time-code input, invalid state described by the
 * error line, and the countdown on the resend button.
 */

function render(over: Partial<Parameters<typeof OtpVerificationCard>[0]> = {}): string {
  return renderToStaticMarkup(
    h(OtpVerificationCard, {
      id: "checkout-code",
      title: "Confirm your mobile number",
      description: "Enter the 6-digit code we sent by SMS to +971 •• ••• 4567.",
      label: "6-digit code",
      value: "",
      ...over,
    }),
  );
}

describe("OtpVerificationCard", () => {
  it("its default description names no channel: codes may go by email (doc 29 §8.4 row 10)", () => {
    const html = renderToStaticMarkup(h(OtpVerificationCard, { id: "checkout-code", value: "" }));
    expect(html).toContain("Enter the 6-digit verification code.");
    expect(html).not.toMatch(/SMS/);
  });

  it("labels the code input and asks for a one-time code", () => {
    const html = render();
    expect(html).toContain("Confirm your mobile number");
    expect(html).toMatch(/<label[^>]*for="checkout-code"[^>]*>6-digit code<\/label>/);
    expect(html).toMatch(/<input[^>]*id="checkout-code"/);
    expect(html).toMatch(/<input[^>]*autoComplete="one-time-code"/i);
  });

  it("shows one error line, tied to the input, only when there is a message", () => {
    expect(render()).not.toContain('role="alert"');
    const html = render({ invalid: true, message: "That code didn’t match. Check the latest code we sent and try again." });
    expect(html).toMatch(/<div role="alert"[^>]*id="checkout-code-message"[^>]*>That code didn’t match/);
    expect(html).toMatch(/<input[^>]*aria-invalid="true"/);
    expect(html).toMatch(/<input[^>]*aria-describedby="checkout-code-message"/);
  });

  it("puts the resend countdown on the button and disables it while waiting", () => {
    const html = render({ resendLabel: "New code in 0:24", resendDisabled: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*New code in 0:24<\/button>/s);
  });

  it("uses OUTLYY tokens: ink text on the marigold verify button", () => {
    const html = render({ verifyLabel: "Verify and continue" });
    expect(html).toMatch(/class="[^"]*bg-sun-500[^"]*text-ink-900[^"]*"[^>]*>Verify and continue/);
  });
});

describe("verifyErrorMessage (the existing /api/checkout/verify answers)", () => {
  it("a wrong code keeps the field and says so", () => {
    const err = new ApiError("Check the details.", "error", "Check the code.", false, { code: "That code isn't right. Check it and try again." }, "VALIDATION_FAILED", 400);
    expect(verifyErrorMessage(err)).toEqual({ message: "That code didn’t match. Check the latest code we sent and try again.", expired: false });
  });

  it("an expired code (404) offers a new one", () => {
    const err = new ApiError("Not found.", "error", "Try again.", false, undefined, "NOT_FOUND", 404);
    expect(verifyErrorMessage(err)).toEqual({ message: "This code has expired. Send a new code to continue.", expired: true });
  });

  it("too many attempts says to wait", () => {
    const err = new ApiError("Slow down.", "error", "Try again later.", true, undefined, "RATE_LIMITED", 429);
    expect(verifyErrorMessage(err).message).toMatch(/^Too many attempts/);
  });
});
