"use client";

import { useEffect } from "react";
import { isUnmeasuredPath, track, type EventProps } from "@/lib/analytics";

/**
 * Fires `page_view` (or `landing_page_view`) once per navigation.
 *
 * Client-side only by design — this is the deduplication partner to the
 * server-side event that is the source of truth (PRD §8). Both carry the same
 * `page_type` and identifiers so the two can be reconciled within 2%
 * (AC-AN-02).
 *
 * Never on a private customer page (PRV-4, TKT-5: `isUnmeasuredPath`, the
 * B5 `PRIVATE_CUSTOMER_ROUTE_PREFIXES` plus `/tickets`): checked here
 * explicitly, and again inside `track()`.
 */
export function PageView({
  pageType,
  landing,
  props,
}: {
  pageType: string;
  landing?: boolean;
  props?: EventProps;
}) {
  useEffect(() => {
    if (isUnmeasuredPath(window.location.pathname)) return;
    track(landing ? "landing_page_view" : "page_view", { page_type: pageType, ...props });
    // Intentionally fires once per mount; route changes remount this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
