import type { FiscalSeller } from "./snapshot";

/**
 * The seller block of the fiscal documents (inputs I1–I4,
 * `97-invoice-inputs-checklist.md`), from server configuration. Pure, so it is
 * unit-tested without a database.
 *
 * "Placeholder" (review finding 18) is not only "unset": a value that looks
 * like a stand-in (bracketed, too short, or a word such as TBC, TBD, TODO,
 * N/A, XXX, PLACEHOLDER, CHANGEME, DUMMY, SAMPLE, UNKNOWN), or a TRN that is
 * not 15 digits or is one digit repeated, counts as missing. Missing values
 * print as bracketed placeholders, and a production document is refused.
 */

const STAND_IN = /^(tbc|tbd|todo|n\/?a|none|null|x+|placeholder|change ?me|dummy|sample|unknown|test|legal name|address|trn|-+|\.+|\?+)$/i;

/** A seller text that is really supplied: no brackets, a minimum length, at least two letters, not a stand-in word. */
export function isRealSellerText(value: string | undefined | null, minLength: number): value is string {
  if (!value) return false;
  const v = value.trim();
  if (v.length < minLength) return false;
  if (/[[\]{}<>]/.test(v)) return false;
  if ((v.match(/\p{L}/gu) ?? []).length < 2) return false;
  return !STAND_IN.test(v.replace(/[\s._-]+$/g, ""));
}

/** A UAE TRN: 15 digits, not one digit repeated. */
export function isRealTrn(value: string | undefined | null): value is string {
  return !!value && /^\d{15}$/.test(value) && !/^(\d)\1{14}$/.test(value);
}

export interface SellerInputs {
  FISCAL_SELLER_LEGAL_NAME?: string;
  FISCAL_SELLER_TRN?: string;
  FISCAL_SELLER_ADDRESS?: string;
  FISCAL_SELLER_LICENCE?: string;
  NEXT_PUBLIC_SUPPORT_EMAIL?: string;
  EMAIL_REPLY_TO?: string;
}

export function sellerFrom(e: SellerInputs): FiscalSeller {
  const name = isRealSellerText(e.FISCAL_SELLER_LEGAL_NAME, 3) ? e.FISCAL_SELLER_LEGAL_NAME.trim() : undefined;
  const trn = isRealTrn(e.FISCAL_SELLER_TRN?.trim()) ? e.FISCAL_SELLER_TRN!.trim() : undefined;
  const address = isRealSellerText(e.FISCAL_SELLER_ADDRESS, 10) ? e.FISCAL_SELLER_ADDRESS.trim() : undefined;
  // A licence number may be digits only; it is printed only when given and not bracketed (it never decides "placeholder").
  const lic = e.FISCAL_SELLER_LICENCE?.trim();
  const licence = lic && !/[[\]{}<>]/.test(lic) ? lic : null;
  return {
    legalName: name ?? "[Legal name]",
    tradingName: "OUTLYY",
    trn: trn ?? "[TRN]",
    address: address ?? "[Registered address]",
    licence,
    supportEmail: e.NEXT_PUBLIC_SUPPORT_EMAIL ?? e.EMAIL_REPLY_TO ?? null,
    phone: null,
    placeholder: !name || !trn || !address,
  };
}
