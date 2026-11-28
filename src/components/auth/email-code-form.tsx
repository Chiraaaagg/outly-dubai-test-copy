"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, KeyRound, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import { SignInError, startEmailCode, verifyEmailCode } from "@/lib/api";
import { EMAIL_CODE_LENGTH, EMAIL_CODE_TTL_SECONDS, EMAIL_MAX_LENGTH, EMAIL_RESEND_AFTER_SECONDS, maskEmail, normaliseEmail, type SignInReason } from "@/lib/customer-auth-options";
import { entersPrivatePage } from "@/lib/private-navigation";
import { cn } from "@/lib/utils";
import { TurnstileWidget, type TurnstileHandle } from "./turnstile-widget";
import { CODE_TIMED_OUT_MESSAGE, codeStepMessage, cookieBlockedMessage, emailStepMessage, EXPIRED_IN_A_ROW_MEANS_NO_COOKIE, minutes } from "./email-code-messages";

/**
 * Email one-time code (Group B, plan 92 §6). Two steps on one card, like the
 * phone form: address → code. Supabase Auth checks the code; OUTLYY opens its
 * own session. The server answers with one closed reason; the words live here.
 *
 *  - Sending: button busy, field locked, no layout shift.
 *  - Code sent: "We sent a 6-digit code to j•••@…", focus to the code field,
 *    resend after 60 s (Supabase's per-address minimum).
 *  - Wrong code: inline error, field cleared and refocused.
 *  - Expired (the 10 minutes ran out on this page): "send a new one", resend at once.
 *  - Refused by the server as expired (also: this browser lost the start cookie): "can't be used here any more",
 *    resend at once; twice in a row, or cookies off, says to allow cookies or use Google (re-review 103b).
 *  - Too many tries: field locked until a new code is sent.
 *  - Send rate-limited, send failed, unavailable: one plain line; a long wait reads "later", a site-wide limit
 *    says so, and Google is offered when it is on (re-review 103b N6).
 *  - Closed account: a plain statement and the support route; no session.
 *  - Not configured: the page drops the option (`onDisabled`).
 *
 * Errors are announced once through the field's own `role="alert"` line.
 */

const CODE_INPUT =
  "min-h-14 w-full rounded-[var(--radius-control)] border bg-paper px-3 text-center font-display text-2xl font-bold tracking-[0.4em] tnum text-ink-900 outline-none focus:border-ink-900 disabled:opacity-60";
const EMAIL_INPUT =
  "min-h-12 w-full min-w-0 rounded-[var(--radius-control)] border bg-paper px-3 text-base text-ink-900 outline-none focus:border-ink-900 disabled:opacity-60";

type Step = "email" | "code";

export interface EmailFormPreview {
  step: Step;
  email?: string;
  emailError?: SignInReason;
  codeError?: SignInReason;
  notice?: string;
}

export function EmailCodeForm({
  next,
  turnstileSiteKey,
  googleAvailable = false,
  onDisabled,
  preview,
}: {
  next: string;
  turnstileSiteKey: string | null;
  /** Google sign-in is on this page: the cookie-trouble line offers it. */
  googleAvailable?: boolean;
  onDisabled: () => void;
  /** Development only (src/app/login/page.tsx): open a designed state directly. */
  preview?: EmailFormPreview;
}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(preview?.step ?? "email");
  const [email, setEmail] = useState(preview?.email ?? "");
  const [sentTo, setSentTo] = useState<string | null>(preview?.step === "code" ? normaliseEmail(preview.email) : null);
  const [emailError, setEmailError] = useState<string | null>(preview?.emailError ? emailStepMessage(preview.emailError) : null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(preview?.codeError ? codeStepMessage(preview.codeError) : null);
  const [locked, setLocked] = useState(preview?.codeError === "RATE_LIMITED");
  const [closed, setClosed] = useState(preview?.codeError === "ACCOUNT_CLOSED" || preview?.emailError === "ACCOUNT_CLOSED");
  const [notice, setNotice] = useState<string | null>(preview?.notice ?? null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [resendIn, setResendIn] = useState(preview?.step === "code" ? EMAIL_RESEND_AFTER_SECONDS : 0);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [captchaTrouble, setCaptchaTrouble] = useState(false);
  const turnstile = useRef<TurnstileHandle>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const submittedCode = useRef<string | null>(null);
  /** Server CODE_EXPIRED answers in a row: a browser that drops our start cookie would otherwise loop forever. */
  const expiredInARow = useRef(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = window.setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [resendIn]);

  // The code's own life: once it has run out on this page, say so instead of letting the next try fail.
  useEffect(() => {
    if (!expiresAt) return;
    const t = window.setTimeout(() => {
      setCodeError(CODE_TIMED_OUT_MESSAGE);
      setResendIn(0);
    }, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(t);
  }, [expiresAt]);

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  const send = async (): Promise<boolean> => {
    const normalised = normaliseEmail(email);
    if (!normalised) {
      setEmailError(email.trim() ? emailStepMessage("EMAIL_INVALID") : "Enter your email address.");
      emailRef.current?.focus();
      return false;
    }
    if (turnstileSiteKey && !token) {
      setEmailError(captchaTrouble ? "The robot check didn't load. Reload the page, or continue with Google." : "One moment: we're checking this browser. Try again in a second.");
      return false;
    }
    // Cookies off: the code could never be checked in this browser, so do not send one (re-review 103b).
    if (typeof navigator !== "undefined" && navigator.cookieEnabled === false) {
      const message = cookieBlockedMessage(googleAvailable);
      if (step === "code") setCodeError(message);
      else setEmailError(message);
      return false;
    }
    setEmailError(null);
    setNotice(null);
    setSending(true);
    try {
      const r = await startEmailCode({ email: normalised, turnstileToken: token ?? undefined });
      setSentTo(normalised);
      setCode("");
      setCodeError(null);
      setLocked(false);
      submittedCode.current = null;
      // A new code starts a new count (re-review 103c D7): one honest "can't be used here" before it never adds up
      // with a later one to "this browser is blocking cookies".
      expiredInARow.current = 0;
      setResendIn(r.resendAfterSeconds || EMAIL_RESEND_AFTER_SECONDS);
      setExpiresAt(Date.now() + (r.expiresInSeconds || EMAIL_CODE_TTL_SECONDS) * 1000);
      setStep("code");
      return true;
    } catch (err) {
      const reason = err instanceof SignInError ? err.reason : "UNAVAILABLE";
      if (reason === "NOT_CONFIGURED") {
        onDisabled();
        return false;
      }
      const message = err instanceof SignInError ? emailStepMessage(reason, err.retryAfterSeconds, err.hints) : emailStepMessage(reason);
      if (step === "code") setCodeError(message);
      else setEmailError(message);
      return false;
    } finally {
      setSending(false);
      // A Turnstile token works once: get a fresh one for the next attempt.
      turnstile.current?.reset();
    }
  };

  const verify = async (value: string) => {
    if (!sentTo || verifying || locked) return;
    if (value.length !== EMAIL_CODE_LENGTH) {
      setCodeError("Enter all six digits.");
      return;
    }
    submittedCode.current = value;
    setVerifying(true);
    setCodeError(null);
    try {
      await verifyEmailCode({ email: sentTo, code: value });
      // A private customer page (a booking or voucher) is entered with a full page load (PRV-4).
      if (entersPrivatePage(next)) window.location.assign(next);
      else {
        router.replace(next);
        router.refresh();
      }
    } catch (err) {
      const reason = err instanceof SignInError ? err.reason : "UNAVAILABLE";
      if (reason === "NOT_CONFIGURED") {
        onDisabled();
        return;
      }
      if (reason === "CODE_EXPIRED") {
        // Nothing more can be done with this code: let a new one be sent at once (re-review 103b). Twice in a row
        // means this browser is not keeping the start cookie, and a new code would fail the same way.
        expiredInARow.current += 1;
        setResendIn(0);
        setCodeError(expiredInARow.current >= EXPIRED_IN_A_ROW_MEANS_NO_COOKIE ? cookieBlockedMessage(googleAvailable) : codeStepMessage(reason));
      } else {
        expiredInARow.current = 0;
        setCodeError(codeStepMessage(reason));
      }
      if (reason === "ACCOUNT_CLOSED") setClosed(true);
      if (reason === "RATE_LIMITED") {
        setLocked(true);
        setResendIn(0);
      }
      if (reason === "CODE_INVALID") {
        setCode("");
        submittedCode.current = null;
        window.setTimeout(() => codeRef.current?.focus(), 0);
      }
      setVerifying(false);
    }
  };

  const onCodeChange = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, EMAIL_CODE_LENGTH);
    setCode(digits);
    if (codeError && !locked) setCodeError(null);
    if (digits.length === EMAIL_CODE_LENGTH && submittedCode.current !== digits) void verify(digits);
  };

  const resend = async () => {
    if (resendIn > 0 || sending) return;
    if (await send()) setNotice("A new code is on its way. Use the newest email.");
  };

  if (closed) {
    return (
      <Alert tone="danger" title="This account has been closed">
        You can still find a booking by its reference. If you think this is a mistake, write to us from the contact page.
      </Alert>
    );
  }

  if (step === "code" && sentTo) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void verify(code);
        }}
        className="space-y-4"
        noValidate
      >
        <div>
          <label htmlFor="login-email-code" className="mb-1 block text-sm font-bold text-ink-900">
            Enter the 6-digit code
          </label>
          <p id="login-email-code-hint" className="mb-2 text-sm text-ink-700 [overflow-wrap:anywhere]">
            We sent it to <span className="font-semibold text-ink-900">{maskEmail(sentTo)}</span>. It expires in {minutes(EMAIL_CODE_TTL_SECONDS)}.
          </p>
          <input
            ref={codeRef}
            id="login-email-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint="go"
            pattern="[0-9]*"
            maxLength={EMAIL_CODE_LENGTH}
            value={code}
            disabled={verifying || locked}
            onChange={(e) => onCodeChange(e.target.value)}
            aria-invalid={Boolean(codeError)}
            aria-describedby={codeError ? "login-email-code-err" : "login-email-code-hint"}
            className={cn(CODE_INPUT, codeError ? "border-[var(--color-danger)]" : "border-ink-200")}
          />
          {codeError && (
            <p id="login-email-code-err" className="mt-1 text-sm font-semibold text-[var(--color-danger)]" role="alert">
              {codeError}
            </p>
          )}
        </div>

        {notice && <Alert tone="success">{notice}</Alert>}

        <Button type="submit" block size="lg" loading={verifying} loadingLabel="Checking…" disabled={locked}>
          <KeyRound className="h-[1.15rem] w-[1.15rem]" aria-hidden="true" />
          Sign in
        </Button>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
          <button
            type="button"
            onClick={() => void resend()}
            disabled={resendIn > 0 || sending}
            className="min-h-11 select-none font-bold text-sun-700 underline underline-offset-2 [-webkit-tap-highlight-color:transparent] disabled:no-underline disabled:opacity-60"
          >
            {sending ? "Sending…" : resendIn > 0 ? <span className="tnum">Send a new code in {resendIn}s</span> : "Send a new code"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep("email");
              setCode("");
              setCodeError(null);
              setNotice(null);
              setLocked(false);
              setExpiresAt(null);
              window.setTimeout(() => emailRef.current?.focus(), 0);
            }}
            className="inline-flex min-h-11 select-none items-center gap-1 font-bold text-ink-700 underline underline-offset-2 [-webkit-tap-highlight-color:transparent]"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Use a different email
          </button>
        </div>
      </form>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      className="space-y-4"
      noValidate
    >
      <div>
        <label htmlFor="login-email" className="mb-1 block text-sm font-bold text-ink-900">
          Email address
        </label>
        <input
          ref={emailRef}
          id="login-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          maxLength={EMAIL_MAX_LENGTH}
          value={email}
          disabled={sending}
          onChange={(e) => {
            setEmail(e.target.value);
            if (emailError) setEmailError(null);
          }}
          aria-invalid={Boolean(emailError)}
          aria-describedby={emailError ? "login-email-err" : "login-email-hint"}
          className={cn(EMAIL_INPUT, emailError ? "border-[var(--color-danger)]" : "border-ink-200")}
        />
        {emailError ? (
          <p id="login-email-err" className="mt-1 text-sm font-semibold text-[var(--color-danger)]" role="alert">
            {emailError}
          </p>
        ) : (
          <p id="login-email-hint" className="mt-1 text-sm text-ink-600">
            We email you a 6-digit code. No password.
          </p>
        )}
      </div>

      {turnstileSiteKey && <TurnstileWidget ref={turnstile} siteKey={turnstileSiteKey} onToken={setToken} onError={() => setCaptchaTrouble(true)} />}

      <Button type="submit" block size="lg" loading={sending} loadingLabel="Sending the code…">
        <Mail className="h-[1.15rem] w-[1.15rem]" aria-hidden="true" />
        Email me a code
      </Button>
    </form>
  );
}
