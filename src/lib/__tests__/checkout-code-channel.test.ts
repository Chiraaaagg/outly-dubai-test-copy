import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { codeCopy, maskEmail, startCheckoutCode } from "../checkout-code-channel";

/**
 * The checkout's code goes to the phone, or to the email on the same form
 * when the deployment cannot send phone codes (NOT_CONFIGURED). Any other
 * failure is the caller's to show, unchanged.
 */

const PHONE = "+97140000000";
const EMAIL = "traveller@example.test";
const notConfigured = () => new ApiError("Phone verification is not configured in this environment", "error", "This isn't available yet.", false, undefined, "NOT_CONFIGURED", 503);

describe("startCheckoutCode", () => {
  it("sends to the phone when the phone works", async () => {
    const start = vi.fn().mockResolvedValue({ challengeId: "c1" });
    await expect(startCheckoutCode(start, { quoteId: "q", channel: "phone", phoneE164: PHONE, email: EMAIL })).resolves.toEqual({ challengeId: "c1", channel: "phone" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ quoteId: "q", channel: "phone", contact: PHONE });
  });

  it("falls back to the email on the form when phone codes are not configured", async () => {
    const start = vi.fn().mockRejectedValueOnce(notConfigured()).mockResolvedValueOnce({ challengeId: "c2" });
    await expect(startCheckoutCode(start, { quoteId: "q", channel: "phone", phoneE164: PHONE, email: `  ${EMAIL} ` })).resolves.toEqual({ challengeId: "c2", channel: "email" });
    expect(start).toHaveBeenLastCalledWith({ quoteId: "q", channel: "email", contact: EMAIL });
  });

  it("goes straight to email when asked (a resend after the fallback)", async () => {
    const start = vi.fn().mockResolvedValue({ challengeId: "c3" });
    await expect(startCheckoutCode(start, { quoteId: "q", channel: "email", phoneE164: PHONE, email: EMAIL })).resolves.toEqual({ challengeId: "c3", channel: "email" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ quoteId: "q", channel: "email", contact: EMAIL });
  });

  it("does not fall back for other failures", async () => {
    const limited = new ApiError("Too many", "error", "Wait", true, undefined, "RATE_LIMITED", 429);
    const start = vi.fn().mockRejectedValue(limited);
    await expect(startCheckoutCode(start, { quoteId: "q", channel: "phone", phoneE164: PHONE, email: EMAIL })).rejects.toBe(limited);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("does not fall back without an email", async () => {
    const err = notConfigured();
    const start = vi.fn().mockRejectedValue(err);
    await expect(startCheckoutCode(start, { quoteId: "q", channel: "phone", phoneE164: PHONE, email: "  " })).rejects.toBe(err);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("shows the email failure when email codes are not configured either", async () => {
    const emailErr = new ApiError("Email verification is not configured", "error", "This isn't available yet.", false, undefined, "NOT_CONFIGURED", 503);
    const start = vi.fn().mockRejectedValueOnce(notConfigured()).mockRejectedValueOnce(emailErr);
    await expect(startCheckoutCode(start, { quoteId: "q", channel: "phone", phoneE164: PHONE, email: EMAIL })).rejects.toBe(emailErr);
    expect(start).toHaveBeenCalledTimes(2);
  });
});

describe("maskEmail", () => {
  it("shows two characters of the local part and the domain", () => {
    expect(maskEmail("traveller@example.test")).toBe("tr•••@example.test");
    expect(maskEmail("ab@example.test")).toBe("a•••@example.test");
    expect(maskEmail("a@example.test")).toBe("a•••@example.test");
  });
  it("never echoes something that is not an address", () => {
    expect(maskEmail("not-an-email")).toBe("•••");
    expect(maskEmail("@example.test")).toBe("•••");
  });
});

describe("codeCopy", () => {
  it("names the channel the code went to", () => {
    expect(codeCopy("email", "tr•••@example.test", 6, null)).toMatchObject({
      title: "Confirm your email",
      helpText: "Wrong email?",
      description: expect.stringContaining("we sent by email to tr•••@example.test"),
    });
    expect(codeCopy(undefined, "+971 •••• 0000", 6, null)).toMatchObject({
      title: "Confirm your mobile number",
      helpText: "Wrong number?",
      description: "Enter the 6-digit code we sent by SMS to +971 •••• 0000.",
    });
    expect(codeCopy("email", "tr•••@example.test", 6, "14:05").description).toBe("We sent a new code at 14:05 to tr•••@example.test. The previous code no longer works.");
  });
});
