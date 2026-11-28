"use client";

import { useEffect, useRef, useState } from "react";
import { Search, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Card } from "@/components/ui/primitives";
import { OrderRequestError, startRecovery, verifyRecovery } from "@/lib/api/order-status";
import { cn } from "@/lib/utils";
import { SupportLink } from "./support";
import {
  CODE_LENGTH,
  CODE_STALE_AFTER_MS,
  codeDestinationText,
  offeredChannels,
  RESEND_AFTER_SECONDS,
  recoveryContact,
  validateRecovery,
  type RecoveryChannel,
  type RecoveryErrors,
  type RecoveryInput,
} from "./recovery";

/**
 * Booking recovery (doc 22 §26 F23): reference plus the phone number or
 * email used to book → a one-time code → the order's status page.
 *
 * No enumeration: every well-formed request gets the same generic message
 * ("If these details match a booking, we've sent a code"), whether or not
 * anything was sent, and every failed code gets the same reply. Only a rate
 * limit is named, because the visitor can act on it.
 *
 * The code step reuses the inline one-time-code pattern of the inquiry and
 * checkout panel (`InquiryVerify`): one numeric field that auto-submits at
 * six digits, a resend after 30 seconds, a way back that keeps what was
 * typed. A code older than the usual lifetime is announced as possibly
 * expired and a new one can be sent without losing the reference
 * (criterion 8). No analytics events are sent from this form.
 *
 * Post-payment batch A1 (owner approval 27 Nov 2026): the form offers only
 * the channels that can deliver a code now (`channels`, from the server: on a
 * status page the order's own verified channels, `unlockChannels`; on Find my
 * booking the channels the server can send on), opens on the first, and says
 * where the code goes. With one channel there is no choice to make; with none
 * the form is replaced by the emailed link and support. Never "Text me a
 * code" while texts cannot be sent.
 */

// 16px text in every field (post-payment A1, mobile pass): iOS Safari zooms into a field under 16px and does not zoom back.
const INPUT =
  "min-h-12 w-full rounded-[var(--radius-control)] border bg-paper px-3 text-base outline-none focus:border-ink-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink-800";
const CODE_INPUT =
  "min-h-12 w-full rounded-[var(--radius-control)] border border-ink-200 bg-paper px-3 text-center text-lg font-bold tracking-[0.4em] tnum text-ink-900 outline-none focus:border-ink-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ink-800 disabled:opacity-60";

const GENERIC_FAILURE = "Check your connection and try again, or message us on WhatsApp.";
const RATE_LIMITED = "Too many attempts in a short time. Wait a few minutes, then try again.";

/**
 * `unlock` (checkout redesign batch 1, CO-02): the same recovery, started
 * from a status page whose voucher is ready but hidden from this browser.
 * The reference is that page's own (not typed, not trusted: the server still
 * matches it with the contact and sends the code only to the order's verified
 * contact); a successful code adds the same `download_tickets` access as the
 * Find-my-booking page and the page refreshes in place instead of navigating.
 */
export interface RecoveryUnlock {
  reference: string;
  /** The mobile number this tab typed at checkout, when it kept one; the visitor can change it. */
  phone?: { countryCode: string; phone: string };
  onRecovered: (reference: string) => void;
}

export function RecoveryForm({ unlock, channels: given }: { unlock?: RecoveryUnlock; channels?: readonly RecoveryChannel[] } = {}) {
  const channels = offeredChannels(given);
  const [input, setInput] = useState<RecoveryInput>({
    reference: unlock?.reference ?? "",
    channel: channels[0] ?? "email",
    countryCode: unlock?.phone?.countryCode || "+91",
    phone: channels.includes("phone") ? (unlock?.phone?.phone ?? "") : "",
    email: "",
  });
  const [errors, setErrors] = useState<RecoveryErrors>({});
  const [stage, setStage] = useState<"details" | "code">("details");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const challenge = useRef<{ id: string; reference: string; channel: RecoveryChannel; contact: string } | null>(null);
  const refInput = useRef<HTMLInputElement>(null);
  const phoneInput = useRef<HTMLInputElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const back = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  // Opened in place from a status page (the button that opened it is gone): focus moves to its heading.
  useEffect(() => {
    if (unlock) titleRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (stage === "details" && back.current) {
      back.current = false;
      refInput.current?.focus();
    }
  }, [stage]);

  const set = <K extends keyof RecoveryInput>(key: K, value: RecoveryInput[K]) => {
    setInput((prev) => ({ ...prev, [key]: value }));
    if (errors[key as keyof RecoveryErrors]) setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const send = async (): Promise<boolean> => {
    const c = recoveryContact(input);
    if (!c) return false;
    setBusy(true);
    setProblem(null);
    try {
      const { challengeId } = await startRecovery(c);
      challenge.current = { id: challengeId, ...c };
      return true;
    } catch (e) {
      setProblem(e instanceof OrderRequestError && e.kind === "rate_limited" ? RATE_LIMITED : GENERIC_FAILURE);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const found = validateRecovery(input);
    setErrors(found);
    if (found.reference) return refInput.current?.focus();
    if (found.phone) return phoneInput.current?.focus();
    if (found.email) return emailInput.current?.focus();
    if (await send()) setStage("code");
  };

  if (channels.length === 0) {
    return (
      <Card className={unlock ? "p-5" : "mt-6 p-5"} data-testid="recovery-unavailable">
        <h2 id="recovery-title" ref={titleRef} tabIndex={unlock ? -1 : undefined} className={cn(unlock ? "text-lg" : "text-xl", "outline-none")}>
          {unlock ? "Confirm it's you" : "Look up a booking"}
        </h2>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-700">
          We can&apos;t send a code for this booking right now. Open it from the link in the email we sent when you booked, or
          message us with your reference and we&apos;ll help.
        </p>
        <div className="mt-3">
          <SupportLink reference={unlock?.reference} size="sm" />
        </div>
      </Card>
    );
  }

  return (
    <Card className={unlock ? "p-5" : "mt-6 p-5"}>
      {stage === "details" ? (
        <form onSubmit={submit} noValidate className="space-y-4" aria-labelledby="recovery-title">
          <h2 id="recovery-title" ref={titleRef} tabIndex={unlock ? -1 : undefined} className={cn(unlock ? "text-lg" : "text-xl", "outline-none")}>
            {unlock ? "Confirm it's you" : "Look up a booking"}
          </h2>
          {unlock ? (
            <p className="text-sm text-ink-600" data-testid="code-destination">
              {codeDestinationText(channels)} It confirms booking <strong className="tnum text-ink-900">{unlock.reference}</strong> is
              yours. You won’t need an account or password.
            </p>
          ) : (
          <div>
            <label htmlFor="ref" className="mb-1 block text-sm font-bold text-ink-900">
              Booking reference
            </label>
            <input
              ref={refInput}
              id="ref"
              value={input.reference}
              onChange={(e) => set("reference", e.target.value.toUpperCase())}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              aria-invalid={Boolean(errors.reference)}
              aria-describedby={errors.reference ? "ref-error ref-hint" : "ref-hint"}
              className={cn(INPUT, "uppercase", errors.reference ? "border-[var(--color-danger)]" : "border-ink-200")}
            />
            <p id="ref-hint" className="mt-1 text-xs text-ink-500">
              It starts with OUT-, for example OUT-123456. It is in the WhatsApp message and email we sent when you booked.
            </p>
            {errors.reference && (
              <p id="ref-error" className="mt-1 text-xs font-semibold text-[var(--color-danger)]">
                {errors.reference}
              </p>
            )}
          </div>
          )}

          {channels.length > 1 ? (
            <fieldset>
              <legend className="mb-1.5 text-sm font-bold text-ink-900">Send the code to</legend>
              <div className="flex flex-wrap gap-2">
                {channels.map((id) => (
                  <label
                    key={id}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-semibold",
                      input.channel === id ? "border-ink-900 bg-shell text-ink-900" : "border-ink-300 bg-paper text-ink-700",
                    )}
                  >
                    <input
                      type="radio"
                      name="channel"
                      value={id}
                      checked={input.channel === id}
                      onChange={() => set("channel", id)}
                      className="h-4 w-4 accent-ink-900"
                    />
                    {id === "phone" ? "My phone number" : "My email"}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : !unlock ? (
            <p className="-mt-1 text-sm text-ink-600" data-testid="code-destination">
              {codeDestinationText(channels)}
            </p>
          ) : null}

          {input.channel === "phone" ? (
            <div>
              <label htmlFor="recovery-phone" className="mb-1 block text-sm font-bold text-ink-900">
                Phone number you booked with
              </label>
              <div className="flex gap-2">
                <select
                  aria-label="Country code"
                  value={input.countryCode}
                  onChange={(e) => set("countryCode", e.target.value)}
                  className="min-h-12 rounded-[var(--radius-control)] border border-ink-200 bg-paper px-2 text-base font-semibold"
                >
                  <option value="+91">+91</option>
                  <option value="+971">+971</option>
                </select>
                <input
                  ref={phoneInput}
                  id="recovery-phone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  enterKeyHint="send"
                  value={input.phone}
                  onChange={(e) => set("phone", e.target.value)}
                  aria-invalid={Boolean(errors.phone)}
                  aria-describedby={errors.phone ? "recovery-phone-error contact-hint" : "contact-hint"}
                  className={cn(INPUT, errors.phone ? "border-[var(--color-danger)]" : "border-ink-200")}
                />
              </div>
              {errors.phone && (
                <p id="recovery-phone-error" className="mt-1 text-xs font-semibold text-[var(--color-danger)]">
                  {errors.phone}
                </p>
              )}
            </div>
          ) : (
            <div>
              <label htmlFor="recovery-email" className="mb-1 block text-sm font-bold text-ink-900">
                Email you booked with
              </label>
              <input
                ref={emailInput}
                id="recovery-email"
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="send"
                value={input.email}
                onChange={(e) => set("email", e.target.value)}
                aria-invalid={Boolean(errors.email)}
                aria-describedby={errors.email ? "recovery-email-error contact-hint" : "contact-hint"}
                className={cn(INPUT, errors.email ? "border-[var(--color-danger)]" : "border-ink-200")}
              />
              {errors.email && (
                <p id="recovery-email-error" className="mt-1 text-xs font-semibold text-[var(--color-danger)]">
                  {errors.email}
                </p>
              )}
            </div>
          )}
          <p id="contact-hint" className="-mt-2 text-xs text-ink-500">
            Used only to send you a code that confirms the booking is yours. We don&apos;t create an account from it.
          </p>

          {problem && (
            <Alert tone="danger" title="That didn't go through">
              {problem}
            </Alert>
          )}

          <Button type="submit" block size="lg" loading={busy} loadingLabel="Sending…">
            {!unlock && <Search className="h-[1.15rem] w-[1.15rem]" aria-hidden="true" />}
            Send me a code
          </Button>
        </form>
      ) : (
        <CodeStep
          verifyLabel={unlock ? "Show my voucher" : undefined}
          channel={input.channel}
          sending={busy}
          problem={problem}
          onVerify={async (code) => {
            const c = challenge.current;
            if (!c) return "failed";
            const result = await verifyRecovery({ challengeId: c.id, code });
            if (!result.ok) return "failed";
            if (unlock) unlock.onRecovered(result.reference);
            // A full page load (PRV-4): /manage-booking is often reached by a client-side move from a measured page.
            else window.location.assign(`/booking/${encodeURIComponent(result.reference)}`);
            return "ok";
          }}
          onResend={send}
          onBack={() => {
            back.current = true;
            setProblem(null);
            setStage("details");
          }}
        />
      )}
    </Card>
  );
}

function CodeStep({
  verifyLabel,
  channel,
  sending,
  problem,
  onVerify,
  onResend,
  onBack,
}: {
  verifyLabel?: string;
  channel: RecoveryChannel;
  sending: boolean;
  problem: string | null;
  onVerify: (code: string) => Promise<"ok" | "failed">;
  onResend: () => Promise<boolean>;
  onBack: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [resendIn, setResendIn] = useState(RESEND_AFTER_SECONDS);
  const [stale, setStale] = useState(false);
  const [sentAgain, setSentAgain] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const refocusCode = useRef(false);
  const submitted = useRef<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = window.setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => window.clearTimeout(t);
  }, [resendIn]);

  // A code is short-lived; after its usual lifetime say so, once, and offer a new one.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setStale(true);
      setResendIn(0);
    }, CODE_STALE_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [sentAgain]);

  const verify = async (value: string) => {
    if (checking || sending) return;
    if (value.length !== CODE_LENGTH) {
      setError(`Enter the full ${CODE_LENGTH}-digit code.`);
      return;
    }
    submitted.current = value;
    setChecking(true);
    setError(null);
    try {
      const outcome = await onVerify(value);
      if (outcome === "failed") {
        setError("That code didn't work. Check it and try again, or send a new code. Codes stop working after a few minutes.");
        setChecking(false);
        // The input is still disabled until React re-renders; focus it once it is enabled again.
        refocusCode.current = true;
      }
      // On success the page navigates; the panel stays busy until it does.
    } catch (e) {
      setError(e instanceof OrderRequestError && e.kind === "rate_limited" ? RATE_LIMITED : GENERIC_FAILURE);
      setChecking(false);
      refocusCode.current = true;
    }
  };

  const onChange = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, CODE_LENGTH);
    setCode(digits);
    if (error) setError(null);
    if (digits.length === CODE_LENGTH && submitted.current !== digits) void verify(digits);
  };

  const resend = async () => {
    if (checking || sending || resendIn > 0) return;
    if (await onResend()) {
      setCode("");
      setError(null);
      setStale(false);
      submitted.current = null;
      setResendIn(RESEND_AFTER_SECONDS);
      setSentAgain((n) => n + 1);
      inputRef.current?.focus();
    }
  };

  const locked = checking || sending;

  useEffect(() => {
    if (!locked && refocusCode.current) {
      refocusCode.current = false;
      inputRef.current?.focus();
    }
  }, [locked]);

  return (
    <div role="group" aria-labelledby="recovery-code-title" data-testid="recovery-code-step">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-success)]" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="recovery-code-title" className="text-xl">
            Enter your code
          </h2>
          <p className="mt-1 text-sm leading-relaxed text-ink-600" role="status" data-testid="recovery-generic-message">
            {sentAgain > 0 ? "We've sent another code if these details match. " : ""}
            {channel === "email" ? (
              <>
                If these details match a booking, we’ve sent a {CODE_LENGTH}-digit code to the email address you entered. It
                may take a minute to arrive and expires after a few minutes.
              </>
            ) : (
              <>
                If the details match a booking, you’ll receive a {CODE_LENGTH}-digit code. It may take a minute to arrive and
                expires after a few minutes.
              </>
            )}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <label htmlFor="recovery-code" className="mb-1 block text-sm font-bold text-ink-900">
          {CODE_LENGTH}-digit code
        </label>
        <input
          ref={inputRef}
          id="recovery-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={CODE_LENGTH}
          value={code}
          disabled={locked}
          onChange={(e) => onChange(e.target.value)}
          className={cn(CODE_INPUT, error && "border-[var(--color-danger)]")}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "recovery-code-error" : undefined}
        />
        {error && (
          <p id="recovery-code-error" role="alert" className="mt-2 text-sm text-[var(--color-danger)]">
            {error}
          </p>
        )}
      </div>

      <p className="mt-3 text-sm text-ink-700" role="status" aria-live="polite">
        {stale ? "Your code may have expired. Send a new one. We’ve kept your booking reference." : ""}
      </p>

      {problem && (
        <Alert tone="danger" className="mt-3" title="That didn't go through">
          {problem}
        </Alert>
      )}

      <div className="mt-4 space-y-2">
        <Button type="button" block size="lg" loading={locked} loadingLabel={sending ? "Sending a new code…" : "Checking…"} onClick={() => void verify(code)}>
          {verifyLabel ?? "Open my booking"}
        </Button>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <button
            type="button"
            onClick={() => void resend()}
            disabled={locked || resendIn > 0}
            className="min-h-11 font-semibold text-ink-700 underline underline-offset-2 disabled:no-underline disabled:opacity-60"
          >
            {resendIn > 0 ? `Send a new code in ${resendIn}s` : "Send a new code"}
          </button>
          <button
            type="button"
            onClick={onBack}
            disabled={locked}
            className="min-h-11 text-ink-600 underline underline-offset-2 disabled:opacity-60"
          >
            Change the details
          </button>
        </div>
      </div>
    </div>
  );
}
