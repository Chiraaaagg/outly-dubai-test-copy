/*
 * Alert Dialog, adapted from shadcn/ui "Alert Dialog" as listed on 21st.dev
 * (https://21st.dev/@shadcn/components/alert-dialog). MIT, shadcn/ui; used
 * under the owner's 21st.dev Pro licence. See THIRD-PARTY-NOTICES.md.
 *
 * Adaptations (doc 30 decision 23, owner pick "Alert Dialog only"):
 *  - built on Base UI's AlertDialog primitive (`@base-ui/react/alert-dialog`,
 *    already a dependency): focus is trapped inside the popup, moves to it on
 *    open and returns to the trigger on close; Escape closes; the backdrop does
 *    not dismiss (an alert dialog asks for an explicit choice);
 *  - project tokens (ink, paper, radius, shadow) instead of shadcn's theme
 *    variables; no Radix, no new package;
 *  - mobile: full width minus a 1rem gutter, scrolls inside when taller than
 *    the viewport (200% zoom); reduced motion turns the transition off;
 *  - `AlertDialogAction` is a plain styled button slot: the forms inside the
 *    console's dialogs submit with the project's own `Button`.
 */
"use client";

import type { ComponentProps, ReactNode } from "react";
import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { cn } from "@/lib/utils";

function AlertDialog(props: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger(props: AlertDialogPrimitive.Trigger.Props) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogContent({ className, children, ...props }: AlertDialogPrimitive.Popup.Props & { children?: ReactNode }) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop
        data-slot="alert-dialog-overlay"
        className="fixed inset-0 z-50 bg-ink-900/50 transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none"
      />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto",
          "rounded-[var(--radius-card)] border border-ink-200 bg-paper p-5 text-ink-900 shadow-[var(--shadow-soft)] outline-none",
          "transition-[opacity,transform] duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 motion-reduce:transition-none",
          className,
        )}
        {...props}
      >
        {children}
      </AlertDialogPrimitive.Popup>
    </AlertDialogPrimitive.Portal>
  );
}

function AlertDialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-dialog-header" className={cn("grid gap-1.5 text-left", className)} {...props} />;
}

function AlertDialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="alert-dialog-footer" className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}

function AlertDialogTitle({ className, ...props }: AlertDialogPrimitive.Title.Props) {
  return <AlertDialogPrimitive.Title data-slot="alert-dialog-title" className={cn("text-base font-semibold text-ink-900", className)} {...props} />;
}

function AlertDialogDescription({ className, ...props }: AlertDialogPrimitive.Description.Props) {
  return <AlertDialogPrimitive.Description data-slot="alert-dialog-description" className={cn("text-sm text-ink-600", className)} {...props} />;
}

/** Closes the dialog without acting. */
function AlertDialogCancel({ className, ...props }: AlertDialogPrimitive.Close.Props) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      className={cn(
        "inline-flex min-h-10 items-center justify-center rounded-[var(--radius-control)] border border-ink-300 bg-paper px-4 text-sm font-semibold text-ink-800 hover:border-ink-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900",
        className,
      )}
      {...props}
    />
  );
}

export { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogFooter, AlertDialogTitle, AlertDialogDescription, AlertDialogCancel };
