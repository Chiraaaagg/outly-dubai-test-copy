/*
 * Style tokens from the astralyx-ui repository (author astralyxdev), used by
 * the imported Checkout Summary component. MIT (see
 * docs/checkout-redesign-review/components/checkout-summary/author-source/LICENSE).
 * Source: https://github.com/astralyxdev/astralyx-ui/blob/main/src/lib/styles.ts
 * at commit 64a2e43c3edaa84b9ab97c787828c8f6f90064f7 (21st.dev did not ship it).
 * Licence: the owner holds a licence for the Checkout Summary component
 * (owner decision, 12 Nov 2026).
 *
 * Edits: only `radius` and `surface` are kept (the two Checkout Summary uses).
 * Their values are mapped onto OUTLYY tokens: control = --radius-control,
 * surface = --radius-card, panel = --radius-tile; the surface is paper with an
 * ink-200 border and ink-900 text.
 */

/**
 * Corner scale. Generously rounded by design, but every step stays under half
 * its control height so nothing collapses into a pill.
 */
export const radius = {
  /** Chips, gutters, inline code. */
  xs: "rounded-lg",
  /** Buttons, inputs, tabs — anything control-sized. */
  control: "rounded-[var(--radius-control)]",
  /** Cards, code blocks, popovers. */
  surface: "rounded-[var(--radius-card)]",
  /** Dialogs, sheets, page-level panels. */
  panel: "rounded-[var(--radius-tile)]",
} as const;

/** Bordered container on the card surface. */
export const surface = "border-ink-200 bg-paper text-ink-900 border";
