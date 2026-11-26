/*
 * Input OTP shipped by 21st.dev with the OTP Verification Card (an older
 * shadcn/ui InputOTP around the `input-otp` package). MIT, shadcn/ui.
 * Verbatim copy: docs/checkout-redesign-review/components/otp-verification-card/deps/components/ui/input-otp.tsx
 *
 * Edits (docs/checkout-redesign-review/notes/batch2-components.md):
 *   - colour tokens mapped onto OUTLYY (input border = ink-300, ring = sun-700,
 *     ring offset = sand, caret = ink-900); radius = --radius-control;
 *   - `animate-caret-blink` (a tw-animate-css utility the app does not have) is
 *     written as `animate-[caret-blink_1.25s_ease-out_infinite]`, the same
 *     timing; the `caret-blink` keyframe must be added to globals.css (see the
 *     notes file). Without it the caret is shown steady.
 */
"use client";

import * as React from "react";
import { OTPInput, OTPInputContext } from "input-otp";
import { Dot } from "lucide-react";

import { cn } from "@/lib/utils";

const InputOTP = React.forwardRef<
  React.ElementRef<typeof OTPInput>,
  React.ComponentPropsWithoutRef<typeof OTPInput>
>(({ className, containerClassName, ...props }, ref) => (
  <OTPInput
    ref={ref}
    containerClassName={cn("flex items-center gap-2 has-[:disabled]:opacity-50", containerClassName)}
    className={cn("disabled:cursor-not-allowed", className)}
    {...props}
  />
));
InputOTP.displayName = "InputOTP";

const InputOTPGroup = React.forwardRef<React.ElementRef<"div">, React.ComponentPropsWithoutRef<"div">>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("flex items-center", className)} {...props} />,
);
InputOTPGroup.displayName = "InputOTPGroup";

const InputOTPSlot = React.forwardRef<
  React.ElementRef<"div">,
  React.ComponentPropsWithoutRef<"div"> & { index: number }
>(({ index, className, ...props }, ref) => {
  const inputOTPContext = React.useContext(OTPInputContext);
  const { char, hasFakeCaret, isActive } = inputOTPContext.slots[index];

  return (
    <div
      ref={ref}
      className={cn(
        "relative flex h-10 w-10 items-center justify-center border-y border-r border-ink-300 text-sm transition-all first:rounded-l-[var(--radius-control)] first:border-l last:rounded-r-[var(--radius-control)]",
        isActive && "z-10 ring-2 ring-sun-700 ring-offset-sand",
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="h-4 w-px animate-[caret-blink_1.25s_ease-out_infinite] bg-ink-900 duration-1000" />
        </div>
      )}
    </div>
  );
});
InputOTPSlot.displayName = "InputOTPSlot";

const InputOTPSeparator = React.forwardRef<React.ElementRef<"div">, React.ComponentPropsWithoutRef<"div">>(
  ({ ...props }, ref) => (
    <div ref={ref} role="separator" {...props}>
      <Dot />
    </div>
  ),
);
InputOTPSeparator.displayName = "InputOTPSeparator";

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator };
