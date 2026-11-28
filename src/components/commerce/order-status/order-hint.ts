import { isValidReference, normaliseReference } from "@/lib/reference";

/**
 * The order reference hint for the gateway's return (doc 22 §23 B5, PRV-4).
 *
 * Before the checkout hands the browser to the payment gateway it keeps the
 * order reference, and nothing else, in `sessionStorage`. The return page
 * (`/booking/confirmation`, which has no reliable reference of its own) reads
 * it only to know which order to ask the server about. The hint is never
 * evidence: what the page shows comes from the status API, and an order this
 * browser may not see renders the neutral "find your booking" state.
 *
 * No name, phone, email, item or amount is ever stored here.
 */

export const ORDER_HINT_KEY = "outlyy.orderRef";

/**
 * Keys earlier builds wrote with traveller details and item snapshots in
 * them. Removed on sight so nothing personal lingers in the tab.
 */
export const LEGACY_ORDER_KEYS: readonly string[] = ["outlyy.lastOrder"];

type HintStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): HintStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** A well-formed order reference, normalised, or null. */
export function cleanReference(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ref = normaliseReference(raw);
  return isValidReference(ref, "OUT") ? ref : null;
}

/** Stores the reference only. Storage failures are ignored: the page then shows the neutral state. */
export function writeOrderHint(reference: string, storage: HintStorage | null = browserStorage()): void {
  const ref = cleanReference(reference);
  if (!storage || !ref) return;
  try {
    storage.setItem(ORDER_HINT_KEY, ref);
  } catch {
    /* private mode or full storage: nothing to do */
  }
}

export function readOrderHint(storage: HintStorage | null = browserStorage()): string | null {
  if (!storage) return null;
  try {
    return cleanReference(storage.getItem(ORDER_HINT_KEY));
  } catch {
    return null;
  }
}

/** Clears the hint and any legacy order snapshot. */
export function clearOrderHints(storage: HintStorage | null = browserStorage()): void {
  if (!storage) return;
  for (const key of [ORDER_HINT_KEY, ...LEGACY_ORDER_KEYS]) {
    try {
      storage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

/** Removes legacy snapshots only, keeping the current hint. */
export function clearLegacyOrderData(storage: HintStorage | null = browserStorage()): void {
  if (!storage) return;
  for (const key of LEGACY_ORDER_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

/** The reference the return page should ask about: a valid `?ref=` first, then the hint. */
export function pickReference(queryRef: string | null, hint: string | null): string | null {
  return cleanReference(queryRef) ?? cleanReference(hint);
}
