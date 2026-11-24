"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import type { CancellationIneligibleReason, CancellationView } from "@/lib/customer-status";
import { OrderRequestError, requestCancellation } from "@/lib/api/order-status";
import { DubaiTime } from "./status-timeline";
import { cancellationProgressText, formatMinor, ineligibleReasonText } from "./presenters";

/**
 * One item's cancellation panel (doc 22 §23 B5, F51). What it offers is
 * exactly the server's `CancellationView`; it never computes eligibility.
 *
 *   eligible      the refund amount and deadline, then an explicit confirm
 *                 step before `POST …/cancellation { kind: "cancel" }`;
 *   not_eligible  the honest reason and, only when the server allows it, a
 *                 request to our team (`kind: "exception"`) that promises
 *                 nothing;
 *   requested     the request's progress in words.
 *
 * Built from the old booking-management sheet's confirm pattern and the
 * shared `Alert`/`Button`. Focus moves to the confirm question when it
 * opens and back to the trigger when it closes; a refused request is
 * announced with `role="alert"`.
 */
export function CancellationPanel({
  reference,
  orderItemId,
  view,
  itemTitle,
  onChanged,
}: {
  reference: string;
  orderItemId: string;
  view: CancellationView;
  itemTitle: string;
  /** Called after the server accepted or refused a request, so the page refreshes its status. */
  onChanged: () => void;
}) {
  const [step, setStep] = useState<"idle" | "confirm" | "sending">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  const [refusedReason, setRefusedReason] = useState<CancellationIneligibleReason | null>(null);
  const confirmRef = useRef<HTMLParagraphElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const progressRef = useRef<HTMLParagraphElement>(null);
  const justSent = useRef(false);
  const id = useId();

  // After a request is accepted the buttons disappear; focus follows to the progress line.
  useEffect(() => {
    if (justSent.current && view.kind === "requested") {
      justSent.current = false;
      progressRef.current?.focus();
    }
  }, [view.kind]);

  useEffect(() => {
    if (step === "confirm") confirmRef.current?.focus();
    if (step === "idle" && restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus();
    }
  }, [step]);

  const send = async (kind: "cancel" | "exception") => {
    setStep("sending");
    setProblem(null);
    try {
      const reply = await requestCancellation(reference, orderItemId, kind);
      if (reply.kind === "not_eligible") {
        setRefusedReason(reply.reason);
        setStep("idle");
        onChanged();
        return;
      }
      if (reply.kind === "not_found") {
        setProblem("We can't change this booking from this page any more. Find your booking again to carry on.");
        setStep("idle");
        return;
      }
      justSent.current = true;
      setStep("idle");
      onChanged();
    } catch (e) {
      const rateLimited = e instanceof OrderRequestError && e.kind === "rate_limited";
      setProblem(
        rateLimited
          ? "Too many attempts in a short time. Wait a few minutes, then try again. Nothing has changed on your booking."
          : "We couldn't send that just now. Nothing has changed on your booking. Check your connection and try again.",
      );
      setStep(kind === "cancel" ? "confirm" : "idle");
    }
  };

  if (view.kind === "none") return null;

  return (
    <div className="space-y-3" data-testid="cancellation-panel" data-cancellation={view.kind}>
      {refusedReason && (
        <div role="alert" className="text-sm font-semibold text-[var(--color-danger)]">
          {ineligibleReasonText(refusedReason)}
        </div>
      )}
      {problem && (
        <Alert tone="danger" title="That didn't go through">
          {problem}
        </Alert>
      )}

      {view.kind === "eligible" && (
        <>
          <p className="text-sm leading-relaxed text-ink-700">
            You can cancel this booking for a refund of{" "}
            <strong className="font-bold text-ink-900">{formatMinor(view.refundMinor, view.currency)}</strong> until{" "}
            <DubaiTime iso={view.untilUtc} className="font-semibold text-ink-900" />. The operator is asked to cancel first, and the
            refund starts once they confirm it.
          </p>
          {step === "idle" ? (
            <Button
              ref={triggerRef}
              variant="danger"
              size="md"
              onClick={() => setStep("confirm")}
              aria-describedby={`${id}-item`}
            >
              Cancel this booking
            </Button>
          ) : (
            <div className="rounded-[var(--radius-control)] border border-ink-200 bg-shell p-4" role="group" aria-labelledby={`${id}-confirm`}>
              <p id={`${id}-confirm`} ref={confirmRef} tabIndex={-1} className="text-sm font-bold text-ink-900 outline-none">
                Cancel {itemTitle}? You will get {formatMinor(view.refundMinor, view.currency)} back once the operator confirms the
                cancellation.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="danger" size="md" loading={step === "sending"} loadingLabel="Sending your cancellation…" onClick={() => void send("cancel")}>
                  Yes, cancel this booking
                </Button>
                <Button
                  variant="outline"
                  size="md"
                  disabled={step === "sending"}
                  onClick={() => {
                    restoreFocus.current = true;
                    setStep("idle");
                  }}
                >
                  Keep my booking
                </Button>
              </div>
            </div>
          )}
          <span id={`${id}-item`} className="sr-only">
            {itemTitle}
          </span>
        </>
      )}

      {view.kind === "not_eligible" && (
        <>
          <p className="text-sm leading-relaxed text-ink-700">{ineligibleReasonText(view.reason)}</p>
          {view.exceptionAllowed && (
            <div className="space-y-2">
              <p className="text-sm leading-relaxed text-ink-600">
                You can ask our team to look at it. This is a request, not a cancellation: the operator&apos;s terms still apply, and
                your booking stays as it is unless we tell you otherwise.
              </p>
              <Button variant="outline" size="md" loading={step === "sending"} loadingLabel="Sending your request…" onClick={() => void send("exception")}>
                Ask our team
              </Button>
            </div>
          )}
        </>
      )}

      {view.kind === "requested" && (
        <div>
          <p ref={progressRef} tabIndex={-1} className="text-sm font-semibold leading-relaxed text-ink-900 outline-none">
            {cancellationProgressText(view.status, view.requestKind)}
          </p>
          <p className="mt-1 text-xs text-ink-500">
            {view.requestKind === "exception" ? "Request sent on" : "Cancellation requested on"} <DubaiTime iso={view.requestedAt} />. Last update{" "}
            <DubaiTime iso={view.updatedAt} />.
          </p>
          {/* F51: the operator refused the cancellation under its policy. The customer may still ask our team; that promises nothing. */}
          {view.requestKind === "supported" && view.status === "refused" && (
            <div className="mt-3 space-y-2">
              <p className="text-sm leading-relaxed text-ink-600">
                You can ask our team to look at it. This is a request, not a cancellation: the operator&apos;s terms still apply, and your
                booking stays as it is unless we tell you otherwise.
              </p>
              <Button variant="outline" size="md" loading={step === "sending"} loadingLabel="Sending your request…" onClick={() => void send("exception")}>
                Ask our team
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
