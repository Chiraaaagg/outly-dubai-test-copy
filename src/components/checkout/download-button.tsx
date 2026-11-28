/*
 * Download Button, imported from 21st.dev.
 * Author: bidyut10. Source: https://21st.dev/@bidyut10/components/download-button
 * (demo id 34553), retrieved 12 Nov 2026.
 * Licence: the owner holds a licence for this component (owner decision,
 * 12 Nov 2026). 21st.dev states: MIT.
 * Ported from docs/checkout-redesign-review/components/download-button/component.tsx
 * (no outly/ copy: the prototype passed labels and a className).
 *
 * Edits (docs/checkout-redesign-review/notes/batch2-components.md): the
 * prototype's className is folded into the component's own classes so pages
 * need not repeat it:
 *   - brand colours: idle = marigold sun-500 with ink-900 text (owner decision
 *     b), sun-600 on hover/press; downloading = sun-100 with ink-900 text;
 *     done = success #047857 with white text (emerald-600 was 3.8:1); focus
 *     outline ink-800 (was neutral-900);
 *   - spacing/type: 48px tall (h-12), px-5, centred, text-base bold, radius
 *     --radius-control (was h-10, rounded-lg, text-sm medium);
 *   - `cn` from @/lib/utils (21st.dev's download-button-utils/cn was not
 *     shipped; same contract).
 * Phases, timers (1.4 s / 1.8 s), icons, live region and structure unchanged.
 * Review fix (part B): `DownloadLink`, the same key as a real <a href> without
 * the timer phases, for downloads the browser should handle (the voucher).
 */
"use client";

import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react";

import { cn } from "@/lib/utils";
import { ArrowDownToLine, Check, Loader2 } from "lucide-react";

type Phase = "idle" | "downloading" | "done";

export type DownloadButtonProps = Readonly<
  {
    label?: string;
    downloadingLabel?: string;
    doneLabel?: string;
    downloadMs?: number;
    resetMs?: number;
    onDownload?: () => void;
  } & Omit<ComponentPropsWithoutRef<"button">, "onDownload">
>;

// Icons stack in one fixed slot and crossfade, so nothing shifts.
const ICON_LAYER =
  "absolute inset-0 grid place-items-center transition-opacity duration-300 ease-out motion-reduce:transition-none";

// Labels stack in one grid cell; outgoing fades out, incoming fades in after.
const LABEL_LAYER =
  "col-start-1 row-start-1 text-left transition-opacity ease-out motion-reduce:transition-none";

// The key's resting look, shared by the button and the link below.
const KEY_BASE = [
  "inline-flex h-12 items-center justify-center gap-2 rounded-[var(--radius-control)] px-5 font-sans text-base font-bold outline-none select-none",
  "transition-[background-color,box-shadow,color] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-800",
  // Soft 3D key; sinks in while pressed or downloading.
  "shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_1px_rgba(0,0,0,0.1),0_2px_4px_rgba(0,0,0,0.08),inset_0_1px_2px_rgba(255,255,255,0.4),inset_0_-2px_4px_rgba(0,0,0,0.08)]",
].join(" ");

const KEY_IDLE =
  "cursor-pointer bg-sun-500 text-ink-900 hover:bg-sun-600 hover:text-ink-900 active:bg-sun-600 active:shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_1px_rgba(0,0,0,0.06),inset_0_1px_2px_rgba(0,0,0,0.08),inset_0_2px_4px_rgba(0,0,0,0.04),inset_0_-1px_2px_rgba(0,0,0,0.05)]";

// Download — raised key sinks while downloading, then settles into a green
// done state; icon morphs arrow → spinner → check in place.
export const DownloadButton = forwardRef<
  HTMLButtonElement,
  DownloadButtonProps
>(
  (
    {
      className,
      label = "Download File",
      downloadingLabel = "Downloading...",
      doneLabel = "Downloaded",
      downloadMs = 1400,
      resetMs = 1800,
      onDownload,
      onClick,
      ...props
    },
    ref,
  ) => {
    const [phase, setPhase] = useState<Phase>("idle");
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
      return () => {
        if (timerRef.current !== null)
          globalThis.clearTimeout(timerRef.current);
      };
    }, []);

    const schedule = (fn: () => void, ms: number) => {
      if (timerRef.current !== null) globalThis.clearTimeout(timerRef.current);
      timerRef.current = globalThis.setTimeout(fn, ms);
    };

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (phase !== "idle") return;

      setPhase("downloading");
      onDownload?.();

      schedule(() => {
        setPhase("done");
        schedule(() => setPhase("idle"), resetMs);
      }, downloadMs);
    };

    const idle = phase === "idle";
    const downloading = phase === "downloading";
    const done = phase === "done";

    return (
      <button
        ref={ref}
        type="button"
        data-slot="download-button"
        data-phase={phase}
        aria-busy={downloading || undefined}
        onClick={handleClick}
        className={cn(
          KEY_BASE,
          downloading &&
            "shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_1px_rgba(0,0,0,0.06),inset_0_1px_2px_rgba(0,0,0,0.08),inset_0_2px_4px_rgba(0,0,0,0.04),inset_0_-1px_2px_rgba(0,0,0,0.05)]",
          idle && KEY_IDLE,
          downloading && "cursor-default bg-sun-100 text-ink-900",
          // Done: emerald 3D key — soft sheen + deep lift (no hard white rim).
          done &&
            "cursor-default bg-success text-white shadow-[0_1px_1px_rgba(0,0,0,0.25),0_3px_6px_rgba(0,0,0,0.2),0_6px_12px_rgba(0,0,0,0.15),inset_0_1px_2px_rgba(255,255,255,0.22),inset_0_-3px_6px_rgba(0,0,0,0.35)]",
          className,
        )}
        {...props}
      >
        <span className="sr-only" aria-live="polite">
          {downloading ? downloadingLabel : done ? doneLabel : ""}
        </span>

        {/* Fixed icon slot keeps the icon and label aligned in every phase. */}
        <span className="relative size-4 shrink-0">
          <span
            aria-hidden
            className={cn(ICON_LAYER, idle ? "opacity-100" : "opacity-0")}
          >
            <ArrowDownToLine size={15} strokeWidth={2} />
          </span>
          <span
            aria-hidden
            className={cn(
              ICON_LAYER,
              downloading ? "opacity-100" : "opacity-0",
            )}
          >
            <Loader2
              size={15}
              strokeWidth={2}
              className="animate-spin motion-reduce:animate-none"
            />
          </span>
          <span
            aria-hidden
            className={cn(ICON_LAYER, done ? "opacity-100" : "opacity-0")}
          >
            <Check size={15} strokeWidth={2.5} />
          </span>
        </span>

        <span className="grid">
          <span
            aria-hidden={!idle}
            className={cn(
              LABEL_LAYER,
              idle
                ? "opacity-100 delay-200 duration-300"
                : "opacity-0 duration-200",
            )}
          >
            {label}
          </span>
          <span
            aria-hidden={!downloading}
            className={cn(
              LABEL_LAYER,
              downloading
                ? "opacity-100 delay-200 duration-300"
                : "opacity-0 duration-200",
            )}
          >
            {downloadingLabel}
          </span>
          <span
            aria-hidden={!done}
            className={cn(
              LABEL_LAYER,
              done
                ? "opacity-100 delay-200 duration-300"
                : "opacity-0 duration-200",
            )}
          >
            {doneLabel}
          </span>
        </span>
      </button>
    );
  },
);

DownloadButton.displayName = "DownloadButton";

/**
 * The same key as a real link (review fix, part B): the browser downloads the
 * file itself, so a refused or missing file shows the browser's own answer
 * instead of a silent saved error body, it works without JavaScript, and it can
 * be opened in a new tab. No phases: a link cannot know how the download went,
 * so it never claims "Downloaded". Same classes, icon slot and label cell as
 * the idle button.
 */
export type DownloadLinkProps = Readonly<{ label?: string } & ComponentPropsWithoutRef<"a">>;

export const DownloadLink = forwardRef<HTMLAnchorElement, DownloadLinkProps>(
  ({ className, label = "Download File", children, ...props }, ref) => (
    <a ref={ref} data-slot="download-button" data-phase="idle" className={cn(KEY_BASE, KEY_IDLE, className)} {...props}>
      <span className="relative size-4 shrink-0">
        <span aria-hidden className={cn(ICON_LAYER, "opacity-100")}>
          <ArrowDownToLine size={15} strokeWidth={2} />
        </span>
      </span>
      <span className="grid">
        <span className={cn(LABEL_LAYER, "opacity-100")}>{children ?? label}</span>
      </span>
    </a>
  ),
);

DownloadLink.displayName = "DownloadLink";

export default DownloadButton;
