"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/primitives";
import { AltMethodToggle, GoogleButton, Login16 } from "@/components/auth/login-16";
import { EmailCodeForm, type EmailFormPreview } from "@/components/auth/email-code-form";
import { PhoneCodeForm } from "@/components/auth/phone-code-form";
import { track } from "@/lib/analytics";
import { hasAnySignInOption, type CustomerAuthOptions, type LoginNotice } from "@/lib/customer-auth-options";

/**
 * The /login screen (Group B, plan 92 §6), from the server's options:
 * only the sign-in methods that work here are shown, never a disabled
 * button or a "coming soon" badge. Google comes first, except in an in-app
 * browser (Instagram, Facebook, WhatsApp…), where Google refuses embedded
 * web views and the email code leads. When nothing works, an honest panel
 * points at the booking and inquiry finders.
 *
 * Google first, email collapsed (owner, 28 Nov 2026; login-16.tsx): when
 * Google leads, the email-code form waits behind "Use email instead" and
 * opens in place, focus on its email field. It opens by itself when an email
 * sign-in is already under way (`emailInProgress`: this browser holds a live
 * start cookie, a designed preview state, or the Google callback failed and
 * its notice points at the email code). Once opened it stays mounted, so a
 * resend, an error or closing and reopening keeps its state. Without Google
 * (switch off, pilot hidden, in-app browser) the form shows open, as before.
 */

/** The id of the panel "Use email instead" opens (`aria-controls`). */
export const EMAIL_PANEL_ID = "login-email-panel";

/**
 * How the email form is shown (pure, exported for tests): `open` with no
 * toggle when it leads or is the only way; `collapsed` behind the toggle when
 * Google leads; `expanded` behind the toggle when Google leads but an email
 * sign-in is already under way.
 */
export function emailPanelMode(o: { email: boolean; googleFirst: boolean; emailInProgress: boolean }): "none" | "open" | "collapsed" | "expanded" {
  if (!o.email) return "none";
  if (!o.googleFirst) return "open";
  return o.emailInProgress ? "expanded" : "collapsed";
}

const NOTICES: Record<LoginNotice, { tone: "info" | "warning" | "danger"; title?: string; text: string }> = {
  google_cancelled: { tone: "info", text: "Google sign-in was cancelled. Choose another way, or try again." },
  google_failed: { tone: "warning", text: "We couldn't sign you in with Google. Try again, or use an email code." },
  account_closed: { tone: "danger", title: "This account has been closed", text: "You can still find a booking by its reference. If you think this is a mistake, write to us from the contact page." },
  not_configured: { tone: "info", text: "That sign-in option isn't available right now." },
};

/** "Google, or a code we email you", from the options actually shown. */
function howWords(o: { google: boolean; email: boolean; phone: boolean }): string {
  const parts = [o.google ? "continue with Google" : null, o.email ? "a code we email you" : null, o.phone ? "a code on WhatsApp or SMS" : null].filter((p): p is string => Boolean(p));
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")}, or ${parts[parts.length - 1]}`;
}

export function LoginClient({
  options,
  next,
  notice,
  inAppBrowser,
  preview,
  pilot = false,
  emailInProgress = false,
}: {
  options: CustomerAuthOptions;
  next: string;
  notice: LoginNotice | null;
  inAppBrowser: boolean;
  preview?: EmailFormPreview;
  /** Owner-only pilot: the page was opened with `?pilot=1` while the pilot list is set; Google keeps it on its start. */
  pilot?: boolean;
  /** An email sign-in is already under way in this browser (a live start cookie): the email form opens by itself. */
  emailInProgress?: boolean;
}) {
  const [emailOn, setEmailOn] = useState(options.emailCode);
  const [phoneOn, setPhoneOn] = useState(options.phone);
  const google = options.google;
  const any = hasAnySignInOption({ ...options, emailCode: emailOn, phone: phoneOn });
  const googleFirst = google && !inAppBrowser;
  const startsOpen = emailPanelMode({ email: options.emailCode, googleFirst, emailInProgress: emailInProgress || Boolean(preview) || notice === "google_failed" }) === "expanded";
  // The collapsed choice: once opened, the form stays mounted (hidden when closed), so its state survives.
  const [emailExpanded, setEmailExpanded] = useState(startsOpen);
  const [emailMounted, setEmailMounted] = useState(startsOpen);
  const focusEmailOnOpen = useRef(false);

  useEffect(() => {
    track("page_view", { page_type: "login" });
  }, []);

  useEffect(() => {
    if (!emailExpanded || !focusEmailOnOpen.current) return;
    focusEmailOnOpen.current = false;
    (document.getElementById("login-email") ?? document.getElementById("login-email-code"))?.focus();
  }, [emailExpanded]);

  const n = notice ? NOTICES[notice] : null;
  const noticeBlock = n ? (
    <Alert tone={n.tone} title={n.title} role={n.tone === "danger" ? "alert" : "status"}>
      {n.text}
    </Alert>
  ) : null;

  if (!any) {
    return (
      <Login16 title="Sign in" intro={<p>You never need an account to ask us about a trip or to open a booking.</p>}>
        {noticeBlock && <div className="mb-4">{noticeBlock}</div>}
        <Alert tone="info" title="Sign-in isn't available yet">
          Find a paid booking with its reference, or track an inquiry with the reference and the phone number you used. Both show the same status as an account.
        </Alert>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Link
            href="/manage-booking"
            className="inline-flex min-h-12 flex-1 items-center justify-center rounded-[var(--radius-control)] bg-sun-500 px-4 text-base font-semibold text-ink-900 shadow-[0_2px_0_var(--color-sun-700)] [-webkit-tap-highlight-color:transparent] active:translate-y-px hover:bg-sun-600"
          >
            Find my booking
          </Link>
          <Link
            href="/inquiry/track"
            className="inline-flex min-h-12 flex-1 items-center justify-center rounded-[var(--radius-control)] border border-ink-300 bg-white px-4 text-base font-semibold text-ink-900 [-webkit-tap-highlight-color:transparent] active:translate-y-px hover:bg-shell"
          >
            Track an inquiry
          </Link>
        </div>
      </Login16>
    );
  }

  const googleButton = google ? <GoogleButton next={next} pilot={pilot} /> : null;
  const mode = emailPanelMode({ email: emailOn, googleFirst, emailInProgress: emailExpanded });
  const emailForm = emailOn ? <EmailCodeForm next={next} turnstileSiteKey={options.turnstileSiteKey} googleAvailable={google} onDisabled={() => setEmailOn(false)} preview={preview} /> : null;
  const lead = (text: string) => <p className="mb-3 text-sm font-semibold text-ink-700">{text}</p>;
  const toggled = mode === "collapsed" || mode === "expanded";

  return (
    <Login16
      title="Sign in"
      intro={<p>See your bookings in one place. No password: {howWords({ google, email: emailOn, phone: phoneOn })}. You never need an account to ask us about a trip.</p>}
      notice={noticeBlock}
      providers={googleFirst ? googleButton : undefined}
      providersNote={
        googleFirst ? (
          <>
            <p className="text-sm text-ink-600">Fastest: no code to wait for.</p>
            {toggled && (
              <AltMethodToggle
                expanded={emailExpanded}
                controls={EMAIL_PANEL_ID}
                onToggle={() => {
                  if (!emailExpanded) {
                    focusEmailOnOpen.current = true;
                    setEmailMounted(true);
                  }
                  setEmailExpanded(!emailExpanded);
                }}
              >
                Use email instead
              </AltMethodToggle>
            )}
          </>
        ) : undefined
      }
      footer={
        <p className="text-sm leading-relaxed text-ink-600">
          Signing in creates your OUTLYY account if you don&apos;t have one. By continuing you agree to our{" "}
          <Link href="/terms" className="font-semibold text-ink-700 underline underline-offset-2 hover:text-ink-900">
            Terms
          </Link>{" "}
          and confirm you have read the{" "}
          <Link href="/privacy" className="font-semibold text-ink-700 underline underline-offset-2 hover:text-ink-900">
            Privacy Policy
          </Link>
          . We use your email to sign you in and about your bookings, never for marketing unless you ask.
        </p>
      }
    >
      <div className="space-y-6">
        {toggled && (
          <div id={EMAIL_PANEL_ID} hidden={!emailExpanded}>
            {emailMounted && emailForm}
          </div>
        )}
        {mode === "open" && emailForm && <div>{emailForm}</div>}
        {!googleFirst && googleButton && (
          <div>
            {emailForm && lead("Or")}
            {googleButton}
          </div>
        )}
        {phoneOn && (
          <div>
            {(emailForm || googleButton) && lead("Or get a code on WhatsApp or SMS")}
            <PhoneCodeForm next={next} onDisabled={() => setPhoneOn(false)} />
          </div>
        )}
      </div>
    </Login16>
  );
}
