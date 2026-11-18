import { describe, expect, it } from "vitest";
import {
  RESEND_AFTER_SECONDS,
  codeToSubmit,
  initialVerifyState,
  resendLabelFor,
  verificationMatchesQuote,
  verifiedAnswerAction,
  verifyReducer,
  type VerifyAction,
  type VerifyState,
} from "../checkout-verify";

/**
 * Behaviour of the checkout's inline number check (batch 2 review fix 13).
 * The repository has no DOM test environment, so the card's states live in a
 * pure reducer that the component drives; these tests walk it the way the
 * component does: typing, checking, failing, resending, the countdown.
 */

function run(state: VerifyState, ...actions: VerifyAction[]): VerifyState {
  return actions.reduce(verifyReducer, state);
}

describe("CheckoutVerify: auto-submit", () => {
  it("submits six digits once, and never the same code twice", () => {
    let s = initialVerifyState;
    expect(codeToSubmit(s, "12345")).toBeNull();
    expect(codeToSubmit(s, "12 34 56")).toBe("123456");
    s = run(s, { type: "typed", raw: "123456" }, { type: "check_started", code: "123456" });
    s = run(s, { type: "check_failed", message: "That code doesn't match. Check the latest SMS and try again.", expired: false });
    // The same six digits again (a re-render, or the field re-emitting) do not retry by themselves.
    expect(codeToSubmit(s, "123456")).toBeNull();
    // A different code does.
    expect(codeToSubmit(s, "123457")).toBe("123457");
  });

  it("keeps the typed code and shows the wrong-code line", () => {
    const s = run(
      initialVerifyState,
      { type: "typed", raw: "654321" },
      { type: "check_started", code: "654321" },
      { type: "check_failed", message: "That code doesn't match. Check the latest SMS and try again.", expired: false },
    );
    expect(s.code).toBe("654321");
    expect(s.error).toMatch(/doesn't match/);
    expect(s.busy).toBe(false);
  });

  it("asks for all digits when Verify is pressed early", () => {
    expect(run(initialVerifyState, { type: "typed", raw: "12" }, { type: "incomplete" }).error).toBe("Enter all 6 digits.");
  });
});

describe("CheckoutVerify: locked while checking", () => {
  it("ignores typing and never submits while a code is being checked", () => {
    const checking = run(initialVerifyState, { type: "typed", raw: "123456" }, { type: "check_started", code: "123456" });
    expect(checking.busy).toBe(true);
    expect(run(checking, { type: "typed", raw: "999999" }).code).toBe("123456");
    expect(codeToSubmit(checking, "999999")).toBeNull();
  });

  it("is locked while a new code is sent", () => {
    expect(run(initialVerifyState, { type: "resend_started" }).busy).toBe(true);
  });
});

describe("CheckoutVerify: resend", () => {
  it("counts down from 30 seconds on the button, then offers a new code", () => {
    let s = initialVerifyState;
    expect(s.resendIn).toBe(RESEND_AFTER_SECONDS);
    expect(resendLabelFor(s.resendIn)).toBe("New code in 0:30");
    s = run(s, ...Array.from({ length: 6 }, () => ({ type: "tick" }) as const));
    expect(resendLabelFor(s.resendIn)).toBe("New code in 0:24");
    s = run(s, ...Array.from({ length: 40 }, () => ({ type: "tick" }) as const));
    expect(s.resendIn).toBe(0);
    expect(resendLabelFor(s.resendIn)).toBe("Send a new code");
  });

  it("an expired code unlocks a new code at once", () => {
    const s = run(
      initialVerifyState,
      { type: "check_started", code: "123456" },
      { type: "check_failed", message: "This code has expired. Send a new code to continue.", expired: true },
    );
    expect(s.resendIn).toBe(0);
  });

  it("a new code clears the field, restarts the countdown and records when it went", () => {
    const s = run(
      { ...initialVerifyState, resendIn: 0, code: "123456", submitted: "123456" },
      { type: "resend_started" },
      { type: "resend_done", at: "14:36" },
    );
    expect(s).toMatchObject({ code: "", submitted: null, resendIn: RESEND_AFTER_SECONDS, resentAt: "14:36", busy: false });
    // The old code can be typed and sent again after a resend.
    expect(codeToSubmit(s, "123456")).toBe("123456");
  });
});

describe("verificationMatchesQuote (review fix 2)", () => {
  it("a code card made for an earlier quote is never used for the quote on screen", () => {
    expect(verificationMatchesQuote("q-1", "q-1")).toBe(true);
    expect(verificationMatchesQuote("q-1", "q-2")).toBe(false);
    expect(verificationMatchesQuote("q-1", null)).toBe(false);
    expect(verificationMatchesQuote(undefined, undefined)).toBe(false);
  });
});

describe("verifiedAnswerAction: a late code answer (follow-up A)", () => {
  const onScreen = { answerQuoteId: "q-1", answerToken: 3, currentToken: 3, liveQuoteId: "q-1", step: 2, verificationQuoteId: "q-1" };

  it("pays only for the card, quote and step still on screen", () => {
    expect(verifiedAnswerAction(onScreen)).toBe("pay");
  });

  it("Edit during the check: the visitor is back on Your details, so the answer is discarded", () => {
    // Edit bumps the token and moves to step 1 before the answer arrives.
    expect(verifiedAnswerAction({ ...onScreen, step: 1, currentToken: 4 })).toBe("discard");
    // Even if they are already back on Review & pay with a new card.
    expect(verifiedAnswerAction({ ...onScreen, currentToken: 4 })).toBe("discard");
  });

  it("re-quoted during the check (promo, details): the old quote is never paid", () => {
    expect(verifiedAnswerAction({ ...onScreen, liveQuoteId: "q-2" })).toBe("discard");
    expect(verifiedAnswerAction({ ...onScreen, liveQuoteId: null })).toBe("discard");
  });

  it("a verification stored for another quote is not used", () => {
    expect(verifiedAnswerAction({ ...onScreen, verificationQuoteId: "q-0" })).toBe("discard");
    expect(verifiedAnswerAction({ ...onScreen, verificationQuoteId: null })).toBe("discard");
  });
});
