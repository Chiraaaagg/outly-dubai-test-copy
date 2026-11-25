/*
 * OTP Verification Card, imported from 21st.dev.
 * Author: sean0205. Source: https://21st.dev/@sean0205/components/otp-verification-card
 * (demo id 28138), retrieved 12 Nov 2026.
 * Licence: the owner holds a licence for this component (owner decision,
 * 12 Nov 2026). 21st.dev states: MIT.
 * Ported from the prototype's edited copy,
 * docs/checkout-redesign-review/components/otp-verification-card/outly/component.tsx
 * (original: ../component.tsx in the same folder).
 *
 * Edits carried over from the prototype copy (recorded in components/SOURCES.md):
 *   - copy: fixed English strings became props with OUTLYY defaults;
 *   - spacing: card padding p-4 sm:p-6, slots h-12 w-9 sm:w-11, 44px resend,
 *     48px verify; fits 320px;
 *   - colour/typography: help link underlined at rest;
 *   - wiring: value / onChange / onComplete / onResend / onVerify / onHelp are
 *     passed to the controls that already exist;
 *   - approved structural edit (owner, 12 Nov 2026): one FieldError line under
 *     the code for a wrong or expired code.
 * Edits for the app (docs/checkout-redesign-review/notes/batch2-components.md):
 *   - "use client"; imports point at src/components/ui/shadcn/ (the gap fillers
 *     the prototype resolved: new-york-v4 Button and Field, 21st-shipped Card
 *     and InputOTP);
 *   - brand colours: muted-foreground = ink-600, primary text = sun-700;
 *   - review fixes (part B): a `disabled` prop locks the input and buttons
 *     while a code is checked; the footer Verify button submits the form by
 *     `form={formId}` instead of a second onClick (it sat outside the form);
 *     "Change it" is a <button>, since it is an action, not a link.
 */
"use client";

import type { ReactNode } from "react";
import { RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/shadcn/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/shadcn/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/shadcn/field";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/shadcn/input-otp";

export interface OtpVerificationCardProps {
  id?: string;
  title?: ReactNode;
  description?: ReactNode;
  label?: ReactNode;
  resendLabel?: ReactNode;
  resendDisabled?: boolean;
  onResend?: () => void;
  verifyLabel?: ReactNode;
  onVerify?: (code: string) => void;
  value?: string;
  onChange?: (code: string) => void;
  onComplete?: (code: string) => void;
  invalid?: boolean;
  message?: ReactNode;
  helpText?: ReactNode;
  helpLinkLabel?: ReactNode;
  onHelp?: () => void;
  autoFocus?: boolean;
  /** Locks the code input and the buttons while a code is being checked (review fix, part B). */
  disabled?: boolean;
}

const SLOT = "h-12 w-9 text-xl sm:w-11";

export default function OtpVerificationCard({
  id = "otp-verification",
  title = "Confirm your mobile number",
  description = "Enter the 6-digit code we sent you.",
  label = "6-digit code",
  resendLabel = "Send a new code",
  resendDisabled = false,
  onResend,
  verifyLabel = "Verify",
  onVerify,
  value,
  onChange,
  onComplete,
  invalid = false,
  message,
  helpText = "Wrong number?",
  helpLinkLabel = "Change it",
  onHelp,
  autoFocus = false,
  disabled = false,
}: OtpVerificationCardProps) {
  const messageId = `${id}-message`;
  const formId = `${id}-form`;
  return (
    <div className="flex items-center justify-center">
      <Card className="mx-auto w-full max-w-md">
        <CardHeader className="p-4 sm:p-6">
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4 sm:px-6 sm:pb-6">
          <form
            id={formId}
            onSubmit={(event) => {
              event.preventDefault();
              onVerify?.(value ?? "");
            }}
          >
            <Field>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <FieldLabel htmlFor={id}>{label}</FieldLabel>
                <Button
                  variant="outline"
                  size="xs"
                  type="button"
                  className="h-11 px-3 text-sm"
                  disabled={resendDisabled || disabled}
                  onClick={onResend}
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  {resendLabel}
                </Button>
              </div>
              <InputOTP
                maxLength={6}
                id={id}
                required
                value={value}
                onChange={onChange}
                onComplete={onComplete}
                autoFocus={autoFocus}
                disabled={disabled}
                aria-invalid={invalid || undefined}
                aria-describedby={message ? messageId : undefined}
              >
                <InputOTPGroup>
                  <InputOTPSlot index={0} className={SLOT} />
                  <InputOTPSlot index={1} className={SLOT} />
                  <InputOTPSlot index={2} className={SLOT} />
                </InputOTPGroup>
                <InputOTPSeparator />
                <InputOTPGroup>
                  <InputOTPSlot index={3} className={SLOT} />
                  <InputOTPSlot index={4} className={SLOT} />
                  <InputOTPSlot index={5} className={SLOT} />
                </InputOTPGroup>
              </InputOTP>
              {message ? (
                <FieldError id={messageId}>{message}</FieldError>
              ) : null}
            </Field>
          </form>
        </CardContent>
        <CardFooter className="flex-col gap-2 px-4 pb-4 sm:px-6 sm:pb-6">
          {/* Submits its form by id: it sits in the footer, outside the <form> (review fix). */}
          <Button
            type="submit"
            form={formId}
            disabled={disabled}
            className="h-12 w-full text-base font-bold"
          >
            {verifyLabel}
          </Button>
          <div className="text-ink-600">
            {helpText}{" "}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onHelp?.()}
              className="text-sun-700 inline-flex min-h-11 items-center underline underline-offset-4 transition-colors hover:underline disabled:opacity-50"
            >
              {helpLinkLabel}
            </button>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}

export { OtpVerificationCard };
