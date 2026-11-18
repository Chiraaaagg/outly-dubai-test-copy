"use client";

import { useEffect, useReducer } from "react";
import { OtpVerificationCard } from "@/components/checkout/otp-verification-card";
import { ApiError } from "@/lib/api";
import { track } from "@/lib/analytics";
import type { OtpAttempt } from "@/lib/otp-flow";
import { serverErrorCode } from "@/lib/server-error";
import { codeCopy } from "@/lib/checkout-code-channel";

export const CODE_LENGTH = 6;
export const RESEND_AFTER_SECONDS = 30;
const INPUT_ID = "checkout-code";

/** The message for a refused code, from the existing verification route's answers. */
export function verifyErrorMessage(err: unknown): { message: string; expired: boolean } {
  const code = serverErrorCode(err);
  // `/api/checkout/verify` answers an expired code or quote with 404 (NOT_FOUND).
  if (code === "NOT_FOUND" || code === "UNAUTHORIZED") {
    return { message: "This code has expired. Send a new code to continue.", expired: true };
  }
  if (code === "RATE_LIMITED") return { message: "Too many attempts. Wait a few minutes, then send a new code.", expired: false };
  // A wrong code is a validation error on the `code` field.
  if (err instanceof ApiError && err.fields?.code) {
    return { message: "That code doesn't match. Check the latest SMS and try again.", expired: false };
  }
  if (err instanceof ApiError) return { message: err.recovery, expired: false };
  return { message: "We couldn't check that code. Try again.", expired: false };
}

/**
 * A verification belongs to one quote. When the details were edited and the
 * page re-quoted, a code card (or a verification) made for the old quote must
 * be discarded, never used to pay for the new one (review fix 2).
 */
export function verificationMatchesQuote(otpQuoteId: string | null | undefined, liveQuoteId: string | null | undefined): boolean {
  return Boolean(otpQuoteId) && otpQuoteId === liveQuoteId;
}

/**
 * What to do with an accepted code when its answer arrives (follow-up A).
 * The answer may come back after the visitor edited the details, went back a
 * step or changed the promo: the page then shows another quote, another step
 * or another code card. Only an answer for the card still on screen, for the
 * quote still on screen, on Review & pay, with the verification made for
 * that quote, may open the payment page; anything else is discarded.
 */
export function verifiedAnswerAction(input: {
  /** The quote the answered code card was made for. */
  answerQuoteId: string;
  /** The token of that card, taken when it was opened. */
  answerToken: number;
  /** The token of the card on screen now (bumped on every new card and on Edit). */
  currentToken: number;
  /** The quote on screen now, or null while re-quoting. */
  liveQuoteId: string | null;
  /** The page step now (2 = Review & pay). */
  step: number;
  /** The quote the stored verification belongs to, or null. */
  verificationQuoteId: string | null;
}): "pay" | "discard" {
  const { answerQuoteId, answerToken, currentToken, liveQuoteId, step, verificationQuoteId } = input;
  if (step !== 2) return "discard";
  if (answerToken !== currentToken) return "discard";
  if (!verificationMatchesQuote(answerQuoteId, liveQuoteId)) return "discard";
  if (verificationQuoteId !== answerQuoteId) return "discard";
  return "pay";
}

/* ------------------------------------------------------------------ state */

export interface VerifyState {
  code: string;
  error: string | null;
  /** A check or a resend is running: the card is locked. */
  busy: boolean;
  /** Seconds until "Send a new code" is allowed. */
  resendIn: number;
  /** Dubai time of the last new code, for the "previous code no longer works" line. */
  resentAt: string | null;
  /** The last code sent for checking: auto-submit runs once per distinct code. */
  submitted: string | null;
}

export type VerifyAction =
  | { type: "typed"; raw: string }
  | { type: "check_started"; code: string }
  | { type: "incomplete" }
  | { type: "check_failed"; message: string; expired: boolean }
  | { type: "check_done" }
  | { type: "tick" }
  | { type: "resend_started" }
  | { type: "resend_done"; at: string }
  | { type: "resend_failed" };

export const initialVerifyState: VerifyState = {
  code: "",
  error: null,
  busy: false,
  resendIn: RESEND_AFTER_SECONDS,
  resentAt: null,
  submitted: null,
};

/** Digits only, at most six. */
export function cleanCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, CODE_LENGTH);
}

/** The code to check after typing `raw`, if any: six digits, not the one already sent, and not while locked. */
export function codeToSubmit(state: VerifyState, raw: string): string | null {
  if (state.busy) return null;
  const digits = cleanCode(raw);
  return digits.length === CODE_LENGTH && digits !== state.submitted ? digits : null;
}

/** "Send a new code", or the countdown on the button. */
export function resendLabelFor(seconds: number): string {
  return seconds > 0 ? `New code in 0:${String(seconds).padStart(2, "0")}` : "Send a new code";
}

export function verifyReducer(state: VerifyState, action: VerifyAction): VerifyState {
  switch (action.type) {
    case "typed":
      // Locked while a code is checked: typing changes nothing.
      if (state.busy) return state;
      return { ...state, code: cleanCode(action.raw), error: null };
    case "check_started":
      return { ...state, busy: true, error: null, submitted: action.code };
    case "incomplete":
      return { ...state, error: `Enter all ${CODE_LENGTH} digits.` };
    case "check_failed":
      // A wrong code keeps the field; an expired one unlocks "Send a new code" at once.
      return { ...state, busy: false, error: action.message, resendIn: action.expired ? 0 : state.resendIn };
    case "check_done":
      return { ...state, busy: false };
    case "tick":
      return state.resendIn > 0 ? { ...state, resendIn: state.resendIn - 1 } : state;
    case "resend_started":
      return { ...state, busy: true, error: null };
    case "resend_done":
      return { ...state, busy: false, code: "", submitted: null, resendIn: RESEND_AFTER_SECONDS, resentAt: action.at };
    case "resend_failed":
      return { ...state, busy: false, error: "We couldn't send another code just now. Try again in a moment." };
  }
}

/** "14:36" in Dubai time. */
function dubaiNow(): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

/**
 * The instant checkout's inline number check (checkout redesign batch 2,
 * CO-30, CO-31): the approved OTP Verification Card in place of the pay
 * button, replacing the "One last thing" panel. The calls are the existing
 * ones, through the `OtpAttempt` the page made (`/api/checkout/verify/start`
 * and `/api/checkout/verify`); this only renders the states (`verifyReducer`):
 *
 *  - six digits submit themselves, once per distinct code;
 *  - the card is locked while a code is checked or a new one is sent;
 *  - a wrong code says so and keeps the field; an expired code offers a new
 *    one at once; a new code says when and where it went, and that the
 *    previous one no longer works (announced, CO-31);
 *  - "Send a new code" waits 30 seconds, with the countdown on the button;
 *  - "Wrong number? Change it" goes back to the details.
 */
export function CheckoutVerify({
  attempt,
  onAttemptChange,
  onVerified,
  onChangeNumber,
  sending,
  onBusyChange,
}: {
  attempt: OtpAttempt;
  onAttemptChange: (next: OtpAttempt) => void;
  /** Runs once the code is accepted. */
  onVerified: () => void | Promise<void>;
  onChangeNumber: () => void;
  /** True while the caller is opening the payment page. */
  sending: boolean;
  /** Told when a check or a resend starts and ends, so the page can lock its own controls. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [state, dispatch] = useReducer(verifyReducer, initialVerifyState);
  const locked = state.busy || sending;

  useEffect(() => {
    onBusyChange?.(state.busy);
  }, [state.busy, onBusyChange]);
  // Removed mid-check (Edit, Change it): the page is no longer waiting on this card.
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  useEffect(() => {
    if (state.resendIn <= 0) return;
    const t = window.setTimeout(() => dispatch({ type: "tick" }), 1000);
    return () => window.clearTimeout(t);
  }, [state.resendIn]);

  // The input is disabled while locked, which drops focus: give it back once unlocked.
  useEffect(() => {
    if (!locked) document.getElementById(INPUT_ID)?.focus();
  }, [locked]);

  const verify = async (value: string) => {
    if (locked) return;
    if (value.length !== CODE_LENGTH) {
      dispatch({ type: "incomplete" });
      return;
    }
    dispatch({ type: "check_started", code: value });
    try {
      await attempt.verify(value);
      track("otp_verified", { context: "checkout" });
      await onVerified();
      dispatch({ type: "check_done" });
    } catch (err) {
      dispatch({ type: "check_failed", ...verifyErrorMessage(err) });
    }
  };

  const resend = async () => {
    if (locked || state.resendIn > 0) return;
    dispatch({ type: "resend_started" });
    try {
      const next = await attempt.resend();
      onAttemptChange(next);
      track("otp_sent", { context: "checkout", resend: true });
      dispatch({ type: "resend_done", at: dubaiNow() });
    } catch {
      dispatch({ type: "resend_failed" });
    }
  };

  const copy = codeCopy(attempt.channel, attempt.phoneMasked, CODE_LENGTH, state.resentAt);
  const description = copy.description;

  return (
    <div className="space-y-2" data-testid="checkout-verify">
      <OtpVerificationCard
        id={INPUT_ID}
        autoFocus
        disabled={locked}
        title={copy.title}
        description={description}
        label={`${CODE_LENGTH}-digit code`}
        value={state.code}
        onChange={(next) => {
          const submit = codeToSubmit(state, next);
          dispatch({ type: "typed", raw: next });
          if (submit) void verify(submit);
        }}
        invalid={Boolean(state.error)}
        message={state.error ?? undefined}
        resendDisabled={state.resendIn > 0}
        resendLabel={resendLabelFor(state.resendIn)}
        onResend={() => void resend()}
        verifyLabel="Verify and continue"
        onVerify={(v) => void verify(cleanCode(v))}
        helpText={copy.helpText}
        helpLinkLabel="Change it"
        onHelp={() => {
          if (!locked) onChangeNumber();
        }}
      />
      {/* The new-code line is announced once, politely (CO-31). */}
      <p className="sr-only" role="status" aria-live="polite">
        {state.resentAt ? description : ""}
      </p>
      {locked ? (
        <p className="text-center text-sm text-ink-600" role="status">
          {sending ? "Opening the secure payment page…" : "Checking the code…"}
        </p>
      ) : null}
    </div>
  );
}
