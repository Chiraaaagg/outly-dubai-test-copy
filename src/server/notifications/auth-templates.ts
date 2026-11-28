import { clampSubject, emailShell, escapeHtml, type Rendered, type TemplateContext } from "./templates";

/**
 * Group B customer sign-in emails (side-session plan 92 §1.3, §2.2). Pure, so
 * they are unit-tested directly. Kept beside templates.ts rather than inside
 * it so the documents batch can change that file in parallel; the shared
 * shell, escaping and subject rules are imported from it unchanged.
 *
 *  - The sign-in code: rendered and sent by the Send Email hook at once. The
 *    code is never stored in a notification row, an event or a log.
 *  - "A booking was added to your account": the notice of every automatic
 *    attach (owner Q10), sent through the outbox and rendered at send time
 *    from the link row (`ACCOUNT_BOOKING_ATTACHED`), carrying the "This was
 *    not me" link with its token in the URL fragment.
 */

export const ACCOUNT_LINK_NOTICE_EVENT = "ACCOUNT_BOOKING_ATTACHED";

function p(html: string) {
  return `<p style="margin:0 0 12px;line-height:1.5">${html}</p>`;
}

export function renderSignInCode(input: { code: string; ttlMinutes: number; supportEmail?: string }): Rendered {
  if (!/^\d{6,10}$/.test(input.code)) throw new Error("renderSignInCode: malformed code");
  const minutes = Math.max(1, Math.round(input.ttlMinutes));
  const text = [
    `Your OUTLYY sign-in code is ${input.code}.`,
    `It expires in ${minutes} minutes and works once.`,
    `If you did not try to sign in, ignore this email. Nobody can sign in without this code.`,
  ].join("\n\n");
  const html =
    p(`Your OUTLYY sign-in code is:`) +
    `<p style="margin:0 0 16px;font-size:28px;font-weight:800;letter-spacing:0.3em;font-variant-numeric:tabular-nums">${escapeHtml(input.code)}</p>` +
    p(`It expires in ${minutes} minutes and works once.`) +
    p(`If you did not try to sign in, ignore this email. Nobody can sign in without this code.`);
  return { subject: clampSubject(`${input.code} is your OUTLYY sign-in code`), text, html: emailShell("Your sign-in code", html, { supportEmail: input.supportEmail } as TemplateContext) };
}

export type AttachRule = "verified_email" | "guest_session";

export interface AccountLinkNoticeContext {
  orderReference: string;
  rule: AttachRule;
  /** "27 Nov 2026, 14:05 Dubai time". */
  attachedLabel: string;
  /** `<site>/booking/not-me#<token>`. */
  notMeLink: string;
  expiresLabel: string;
  supportEmail?: string;
}

export function notMeLink(siteUrl: string, token: string): string {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error("notMeLink: malformed token");
  return `${siteUrl.replace(/\/+$/, "")}/booking/not-me#${token}`;
}

const HOW: Record<AttachRule, string> = {
  verified_email: "someone signed in to an OUTLYY account with this email address, confirmed by a one-time code or by Google",
  guest_session: "someone signed in to an OUTLYY account on the same browser that paid for the booking",
};

export function renderAccountLinkNotice(ctx: AccountLinkNoticeContext): Rendered {
  const how = HOW[ctx.rule];
  const text = [
    `Booking ${ctx.orderReference} was added to an OUTLYY account on ${ctx.attachedLabel}, because ${how}.`,
    `If that was you, there is nothing to do: the booking is in your account, and your booking links still work.`,
    `If it was not you, remove the booking from that account: ${ctx.notMeLink}`,
    `The link works once, until ${ctx.expiresLabel}. Our team is told when it is used.`,
  ].join("\n\n");
  const html =
    p(`Booking <strong>${escapeHtml(ctx.orderReference)}</strong> was added to an OUTLYY account on ${escapeHtml(ctx.attachedLabel)}, because ${escapeHtml(how)}.`) +
    p(`If that was you, there is nothing to do: the booking is in your account, and your booking links still work.`) +
    p(`If it was not you:`) +
    p(`<a href="${escapeHtml(ctx.notMeLink)}" style="display:inline-block;background:#1c1917;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none">This was not me</a>`) +
    p(escapeHtml(`The link works once, until ${ctx.expiresLabel}. Our team is told when it is used.`));
  return { subject: clampSubject(`Booking ${ctx.orderReference} was added to an account`), text, html: emailShell("A booking was added to an account", html, { supportEmail: ctx.supportEmail } as TemplateContext) };
}
