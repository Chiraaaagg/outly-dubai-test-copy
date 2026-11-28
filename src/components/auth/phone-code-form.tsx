"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { KeyRound, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { ApiError, requestOtp, verifyOtp, verifyOtpWidget } from "@/lib/api";
import { maskPhone, normalisePhone } from "@/lib/phone";
import {
  CAPTCHA_ELEMENT_ID,
  captchaCleared,
  preloadWidget,
  sendWidgetOtp,
  verifyWidgetOtp,
  widgetConfigured,
} from "@/lib/msg91-widget";
import { serverErrorCode } from "@/lib/server-error";
import { entersPrivatePage } from "@/lib/private-navigation";
import { cn } from "@/lib/utils";

/**
 * The phone + one-time code sign-in (customer-auth contract §1, §4), moved
 * unchanged out of src/app/login/page.tsx for Group B so the page can offer
 * it beside the email code and Google. Rendered only when the server says
 * the phone path can deliver (`customerAuthService.options().phone`); hidden
 * at launch (owner Q11). Existing phone accounts keep signing in through it.
 *
 * Two steps on one card: number → code. The code field auto-submits at six
 * digits, resend unlocks after 30 s, and "wrong number?" goes back without
 * losing the country code. `onDisabled` is called when the API answers
 * NOT_CONFIGURED, so the page can drop the option honestly.
 */

const RESEND_AFTER_SECONDS = 30;
const CODE_LENGTH = 6;

/** Stand-in id for the widget flow, which has no server-side challenge row. */
const WIDGET_CHALLENGE = "widget";

const INPUT =
  "min-h-12 w-full rounded-[var(--radius-control)] border bg-paper px-3 text-base text-ink-900 outline-none focus:border-ink-900 disabled:opacity-60";

type Step = "phone" | "code";

interface Challenge {
  challengeId: string;
  expiresInSeconds: number;
  phoneMasked: string;
}

export function PhoneCodeForm({ next, onDisabled }: { next: string; onDisabled: () => void }) {
  const router = useRouter();
  // Decided at build time: the widget credentials are baked into the bundle or
  // they are not, so this never changes while the page is open.
  const widgetMode = widgetConfigured();

  const [step, setStep] = useState<Step>("phone");
  const [countryCode, setCountryCode] = useState("+91");
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendIn, setResendIn] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);
  const submittedCode = useRef<string | null>(null);

  useEffect(() => {
    // Draw hCaptcha while the number is being typed. Initialising it inside the
    // send instead would put the challenge on screen at the moment it already
    // needs to be solved, so the first press would always be refused.
    preloadWidget();
  }, []);

  // Resend countdown.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = window.setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [resendIn]);

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  const sendCode = async (): Promise<boolean> => {
    const parsed = normalisePhone(phone, countryCode);
    if (!phone.trim()) {
      setPhoneError("Enter the WhatsApp number you used for your inquiry.");
      return false;
    }
    if (!parsed.valid) {
      setPhoneError(parsed.reason ?? "That doesn't look like a valid mobile number.");
      return false;
    }
    setPhoneError(null);
    setNotice(null);
    setSending(true);
    try {
      // Widget mode: MSG91 sends the code straight from the browser, so there is
      // no challenge row to come back with. The card only needs a masked number
      // to display, and `verify()` goes to the widget endpoint instead.
      if (widgetMode && !captchaCleared()) {
        setPhoneError("Tick the box above to confirm you're not a robot, then try again.");
        setSending(false);
        return false;
      }
      const result = widgetMode
        ? await sendWidgetOtp(parsed.e164).then(() => ({
            challengeId: WIDGET_CHALLENGE,
            expiresInSeconds: 0,
            phoneMasked: maskPhone(parsed.e164),
          }))
        : await requestOtp({ phone: parsed.national, countryCode: parsed.countryCode });
      setChallenge(result);
      setCode("");
      setCodeError(null);
      submittedCode.current = null;
      setResendIn(RESEND_AFTER_SECONDS);
      setStep("code");
      return true;
    } catch (err) {
      const serverCode = serverErrorCode(err);
      if (serverCode === "NOT_CONFIGURED") {
        onDisabled();
      } else if (serverCode === "RATE_LIMITED") {
        setPhoneError(
          "Too many codes requested for this number. Wait fifteen minutes and try again, or track your inquiry with the reference instead.",
        );
      } else if (err instanceof ApiError) {
        setPhoneError(err.fields?.phone ?? err.recovery);
      } else {
        setPhoneError("We couldn't send the code. Try again in a moment.");
      }
      return false;
    } finally {
      setSending(false);
    }
  };

  const verify = async (value: string) => {
    if (!challenge || verifying) return;
    if (value.length !== CODE_LENGTH) {
      setCodeError("Enter all six digits.");
      return;
    }
    submittedCode.current = value;
    setVerifying(true);
    setCodeError(null);
    try {
      if (widgetMode) {
        // MSG91 checks the code and signs a token; the server decides which
        // account that token opens. The token is never trusted on this side.
        const accessToken = await verifyWidgetOtp(value);
        await verifyOtpWidget(accessToken);
      } else {
        await verifyOtp({ challengeId: challenge.challengeId, code: value });
      }
      // A private customer page (a booking or voucher) is entered with a full page load (PRV-4).
      if (entersPrivatePage(next)) window.location.assign(next);
      else {
        router.replace(next);
        router.refresh();
      }
    } catch (err) {
      const serverCode = serverErrorCode(err);
      if (serverCode === "NOT_FOUND" || serverCode === "UNAUTHORIZED") {
        // The challenge expired or was used up — start over rather than let them keep typing.
        setCodeError("That code has expired. Request a new one.");
        setResendIn(0);
      } else if (serverCode === "RATE_LIMITED") {
        setCodeError("Too many attempts. Wait a few minutes and request a fresh code.");
      } else if (err instanceof ApiError) {
        setCodeError(err.fields?.code ?? err.recovery);
      } else {
        setCodeError("We couldn't check that code. Try again.");
      }
      setVerifying(false);
    }
  };

  const onCodeChange = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, CODE_LENGTH);
    setCode(digits);
    if (codeError) setCodeError(null);
    // Auto-submit once, on the first time six digits appear.
    if (digits.length === CODE_LENGTH && submittedCode.current !== digits) void verify(digits);
  };

  const resend = async () => {
    if (resendIn > 0 || sending) return;
    const ok = await sendCode();
    if (ok) setNotice("A new code is on its way. The old one no longer works.");
  };

  return (
    <>
            {step === "phone" && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendCode();
                }}
                className="space-y-4"
                noValidate
              >
                <div>
                  <label htmlFor="login-phone" className="mb-1 block text-sm font-bold text-ink-900">
                    WhatsApp number
                  </label>
                  <div className="flex gap-2">
                    <select
                      aria-label="Country code"
                      value={countryCode}
                      onChange={(e) => setCountryCode(e.target.value)}
                      className="min-h-12 rounded-[var(--radius-control)] border border-ink-200 bg-paper px-2 text-sm font-semibold"
                    >
                      <option value="+91">+91</option>
                      <option value="+971">+971</option>
                    </select>
                    <input
                      id="login-phone"
                      type="tel"
                      inputMode="numeric"
                      autoComplete="tel-national"
                      value={phone}
                      onChange={(e) => {
                        setPhone(e.target.value);
                        if (phoneError) setPhoneError(null);
                      }}
                      aria-invalid={Boolean(phoneError)}
                      aria-describedby={phoneError ? "login-phone-err" : "login-phone-hint"}
                      className={cn(INPUT, phoneError ? "border-[var(--color-danger)]" : "border-ink-200")}
                    />
                  </div>
                  {phoneError ? (
                    <p id="login-phone-err" className="mt-1 text-xs font-semibold text-[var(--color-danger)]">
                      {phoneError}
                    </p>
                  ) : (
                    <p id="login-phone-hint" className="mt-1 text-xs text-ink-500">
                      The code goes to this number. We don&apos;t use it for anything else.
                    </p>
                  )}
                </div>

                {/*
                  Render target for MSG91's captcha, which is hCaptcha despite
                  what their docs call it. The widget fills this with an
                  <h-captcha> element on init, so it is never empty — it simply
                  has no height until hCaptcha decides to challenge the visitor.
                  It has to exist before init or every send is refused.
                */}
                {widgetMode && <div id={CAPTCHA_ELEMENT_ID} className="[&:not(:has(iframe))]:hidden" />}

                <Button type="submit" block size="lg" loading={sending} loadingLabel="Sending the code…">
                  <Smartphone className="h-[1.15rem] w-[1.15rem]" />
                  Send me a code
                </Button>

                {/* Creating an account is a contract; the terms are named before it happens. */}
                <p className="text-xs leading-relaxed text-ink-500">
                  Signing in creates your OUTLYY account if you don&apos;t have one. By continuing you
                  agree to our{" "}
                  <Link href="/terms" className="font-semibold underline underline-offset-2 hover:text-ink-700">
                    Terms
                  </Link>{" "}
                  and confirm you have read the{" "}
                  <Link href="/privacy" className="font-semibold underline underline-offset-2 hover:text-ink-700">
                    Privacy Policy
                  </Link>
                  . We send the code by SMS or WhatsApp to verify it is you, never for marketing.
                </p>
              </form>
            )}

            {step === "code" && challenge && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void verify(code);
                }}
                className="space-y-4"
                noValidate
              >
                <div>
                  <label htmlFor="login-code" className="mb-1 block text-sm font-bold text-ink-900">
                    Enter the 6-digit code
                  </label>
                  <p className="mb-2 text-xs text-ink-500">
                    Sent to <span className="font-semibold tnum text-ink-700">{challenge.phoneMasked}</span>.
                    It works for {Math.max(1, Math.round(challenge.expiresInSeconds / 60))} minutes.
                  </p>
                  <input
                    ref={codeRef}
                    id="login-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={CODE_LENGTH}
                    value={code}
                    disabled={verifying}
                    onChange={(e) => onCodeChange(e.target.value)}
                    aria-invalid={Boolean(codeError)}
                    aria-describedby={codeError ? "login-code-err" : undefined}
                    className={cn(
                      "min-h-14 w-full rounded-[var(--radius-control)] border bg-paper px-3 text-center font-display text-2xl font-bold tracking-[0.4em] tnum text-ink-900 outline-none focus:border-ink-900 disabled:opacity-60",
                      codeError ? "border-[var(--color-danger)]" : "border-ink-200",
                    )}
                  />
                  {codeError && (
                    <p id="login-code-err" className="mt-1 text-xs font-semibold text-[var(--color-danger)]" role="alert">
                      {codeError}
                    </p>
                  )}
                </div>

                {notice && <Alert tone="success">{notice}</Alert>}

                <Button type="submit" block size="lg" loading={verifying} loadingLabel="Checking…">
                  <KeyRound className="h-[1.15rem] w-[1.15rem]" />
                  Sign in
                </Button>

                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
                  <button
                    type="button"
                    onClick={() => void resend()}
                    disabled={resendIn > 0 || sending}
                    className="min-h-11 font-bold text-sun-700 underline underline-offset-2 disabled:no-underline disabled:opacity-60"
                  >
                    {sending ? "Sending…" : resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setStep("phone");
                      setCode("");
                      setCodeError(null);
                      setNotice(null);
                    }}
                    className="min-h-11 font-bold text-ink-700 underline underline-offset-2"
                  >
                    Wrong number?
                  </button>
                </div>
              </form>
            )}
    </>
  );
}
