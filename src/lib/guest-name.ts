/**
 * The lead traveller's name as TravelDesk accepts it: "latin letters and
 * spaces only" (TravelDesk API examples, 5 November 2026). A name it refuses
 * fails at reserve, after the customer's card is already authorised, so the
 * checkout asks for a usable name before payment.
 *
 * The customer's own spelling stays on the order; only the name sent to the
 * supplier is rewritten:
 *  - accents are removed (José → Jose) and a few letters without a
 *    decomposition are spelled out (ß → ss, Æ → AE, Ø → O, Ł → L);
 *  - apostrophes are dropped and other punctuation and digits become spaces
 *    (Anne-Marie O'Brien → Anne Marie OBrien); spaces are collapsed.
 * A name with letters from another script (Devanagari, Arabic, Chinese, …)
 * is refused rather than cut down, so the voucher never carries half a name.
 *
 * Pure; used by the checkout page, the checkout API and the booking engine.
 */

const SPELLED: Record<string, string> = {
  ß: "ss",
  ẞ: "SS",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  ø: "o",
  Ø: "O",
  đ: "d",
  Đ: "D",
  ð: "d",
  Ð: "D",
  ł: "l",
  Ł: "L",
  þ: "th",
  Þ: "Th",
  ı: "i",
  ħ: "h",
  Ħ: "H",
};

/** Longest name sent to the supplier. */
export const SUPPLIER_GUEST_NAME_MAX = 100;

/** The supplier-safe form of a name, or null when it has no usable Latin name. */
export function supplierGuestName(name: string): string | null {
  const spelled = [...name.normalize("NFKD")].map((c) => SPELLED[c] ?? c).join("");
  // Apostrophes go first: the modifier-letter apostrophe (ʼ) counts as a letter.
  const stripped = spelled.replace(/\p{M}/gu, "").replace(/['’‘`ʼ]/g, "");
  // Any letter left outside A–Z belongs to another script: refuse instead of dropping it.
  if (/[^A-Za-z\P{L}]/u.test(stripped)) return null;
  const latin = stripped.replace(/[^A-Za-z]+/g, " ").trim();
  if ((latin.match(/[A-Za-z]/g) ?? []).length < 2) return null;
  if (latin.length > SUPPLIER_GUEST_NAME_MAX) return null;
  return latin;
}

/** The message shown when `supplierGuestName` refuses a name. */
export const GUEST_NAME_LATIN_MESSAGE = "Write the name in English letters (A–Z), as on your passport.";
