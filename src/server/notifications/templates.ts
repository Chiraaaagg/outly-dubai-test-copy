import type { PaxCount } from "@/lib/types";
import { ACK_AVAILABILITY, FOLLOWUP_SENTENCES, WHATSAPP_TEMPLATES, renderWhatsAppBody } from "./whatsapp-templates";
import { siteConfig } from "@/lib/site-config";
import { TICKET_NON_REFUNDABLE_STATEMENT } from "@/lib/utils";

/**
 * Notification templates — version-controlled in the repo (AC-WA-04), never
 * edited in a dashboard. One render function per (event, channel).
 *
 * WhatsApp: `templateName` must match the approved BSP template; `variables`
 * are the positional body parameters ("1".."n"). `text` is rendered from the
 * registry body in `whatsapp-templates.ts`, so the log adapter and the
 * `notifications.payload` show exactly what the customer receives.
 *
 * Email: `subject` (<= 78 chars, RFC 2822 friendly), `html` and a `text` part
 * that is always present. Every customer-supplied string (lead name, notes,
 * hotel, dietary, item titles) passes through `escapeHtml` before it touches
 * markup — customer text is untrusted (§17 §9 #6).
 *
 * Tone: plain, specific, no urgency theatre (§17 §3.7). The deadline is the
 * concrete timestamp the confirmation page already showed (§3.9).
 *
 * This module is pure (no env, no I/O, no "server-only") so it is unit-tested
 * directly. Template names are read from process.env here because env.ts is
 * server-only; the defaults match the registry.
 */

export type NotificationEvent =
  | "INQUIRY_ACK"
  | "INQUIRY_OPS_ALERT"
  | "INQUIRY_ASSIGNED"
  | "INQUIRY_SLA_BREACH"
  | "INQUIRY_STILL_CHECKING"
  | "INQUIRY_FOLLOWUP"
  | "INQUIRY_WON"
  /** Owner only (doc 30 N3, D17): the daily digest of supplier changes the upkeep applied to imported listings. Codes and field names only. */
  | "TRAVELDESK_UPKEEP_DIGEST"
  | "ACCOUNT_DELETION_REQUEST"
  /** Ops only (doc 22 §32.24): one instant-path incident; codes and ids, never customer contact data. */
  | "OPS_INCIDENT_ALERT"
  /** Ops only: "N more alerts suppressed" by the hourly throttle. */
  | "OPS_ALERT_DIGEST"
  /** Owner only (doc 30 N2, D15/D16): one administrator alone activated instant selling or switched a class on. Ids and codes only. */
  | "OWNER_ACTION_ALERT";

export type NotificationChannel = "whatsapp" | "email";

export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = [
  "INQUIRY_ACK",
  "INQUIRY_OPS_ALERT",
  "INQUIRY_ASSIGNED",
  "INQUIRY_SLA_BREACH",
  "INQUIRY_STILL_CHECKING",
  "INQUIRY_FOLLOWUP",
  "INQUIRY_WON",
  "TRAVELDESK_UPKEEP_DIGEST",
  "ACCOUNT_DELETION_REQUEST",
  "OPS_INCIDENT_ALERT",
  "OPS_ALERT_DIGEST",
  "OWNER_ACTION_ALERT",
];

/** Which channels each event has a template for. Dispatching elsewhere is a programming error. */
export const EVENT_CHANNELS: Record<NotificationEvent, readonly NotificationChannel[]> = {
  INQUIRY_ACK: ["whatsapp", "email"],
  INQUIRY_OPS_ALERT: ["whatsapp", "email"],
  INQUIRY_ASSIGNED: ["email"],
  INQUIRY_SLA_BREACH: ["email"],
  INQUIRY_STILL_CHECKING: ["whatsapp", "email"],
  INQUIRY_FOLLOWUP: ["whatsapp", "email"],
  INQUIRY_WON: ["email"],
  TRAVELDESK_UPKEEP_DIGEST: ["email"],
  /** Ops only (impl/customer-auth-contract.md §3 `requestDeletion`): a customer asked for their data to be deleted. */
  ACCOUNT_DELETION_REQUEST: ["email"],
  OPS_INCIDENT_ALERT: ["email"],
  OPS_ALERT_DIGEST: ["email"],
  OWNER_ACTION_ALERT: ["email"],
};

export function supportsChannel(event: NotificationEvent, channel: NotificationChannel): boolean {
  return EVENT_CHANNELS[event]?.includes(channel) ?? false;
}

export interface TemplateContext {
  reference: string;
  leadName: string;
  leadFirstName: string;
  leadPhone: string;
  leadEmail?: string;
  agentName: string;
  agentFirstName: string;
  agentRole: string;
  deadlineIso: string;
  deadlineLabel: string;
  outOfHours: boolean;
  items: { title: string; date?: string; time?: string; pax: PaxCount; indicativeTotalInr: number }[];
  itemCount: number;
  travelDateFrom?: string;
  datesFlexible: boolean;
  guests: number;
  dietary?: string;
  hotel?: string;
  specialRequests?: string;
  budgetBand?: string;
  indicativeTotalInr: number;
  currency: string;
  source: string;
  siteUrl: string;
  consoleUrl: string;
  whatsappNumber?: string;
  supportEmail?: string;
  stage?: number;
  reassigned?: boolean;
  orderReference?: string;
  /** ACCOUNT_DELETION_REQUEST only. */
  customerId?: string;
  phoneMasked?: string;
  customerSince?: string;
  deletionReason?: string;
  requestedAt?: string;
  [key: string]: unknown;
}

export interface Rendered {
  /** WhatsApp only: approved BSP template name. */
  templateName?: string;
  /** Email only. Always <= MAX_SUBJECT_LENGTH. */
  subject?: string;
  /** Always present: the plain-text part (email) or the rendered body (WhatsApp). */
  text: string;
  /** Email only. */
  html?: string;
  /** WhatsApp only: positional body parameters keyed "1".."n". */
  variables?: Record<string, string>;
}

export const MAX_SUBJECT_LENGTH = 78;

/* ------------------------------------------------------------------ helpers */

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

const templateName = (key: keyof typeof WHATSAPP_TEMPLATES): string => {
  const override =
    key === "inquiry_ack_v1"
      ? process.env.WHATSAPP_TEMPLATE_INQUIRY_ACK
      : key === "inquiry_followup_v1"
        ? process.env.WHATSAPP_TEMPLATE_INQUIRY_FOLLOWUP
        : process.env.WHATSAPP_TEMPLATE_INQUIRY_OPS_ALERT;
  return override?.trim() || WHATSAPP_TEMPLATES[key].name;
};

/** Builds a WhatsApp rendering from the registry so `text` is exactly the template body with values filled in. */
function whatsapp(key: keyof typeof WHATSAPP_TEMPLATES, values: string[]): Rendered {
  const variables: Record<string, string> = {};
  values.forEach((v, i) => {
    variables[String(i + 1)] = cleanVariable(v);
  });
  return { templateName: templateName(key), text: renderWhatsAppBody(WHATSAPP_TEMPLATES[key].body, variables), variables };
}

/**
 * Meta rejects body parameters containing newlines, tabs or more than four
 * consecutive spaces; customer-supplied values are also untrusted. Collapse
 * whitespace and cap the length.
 */
export function cleanVariable(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 199)}…` : collapsed || "—";
}

/** Truncates a subject to the RFC-friendly single-line limit without cutting mid-word where possible. */
export function clampSubject(subject: string): string {
  const s = subject.replace(/\s+/g, " ").trim();
  if (s.length <= MAX_SUBJECT_LENGTH) return s;
  const cut = s.slice(0, MAX_SUBJECT_LENGTH - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function itemLines(ctx: TemplateContext): string {
  if (!ctx.items.length) return "You haven’t chosen activities yet. We’ll suggest ideas around your dates.";
  return ctx.items.map((i) => `• ${i.title}${i.date ? ` · ${i.date}` : ""}${i.time ? ` · ${i.time}` : ""}`).join("\n");
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Escapes and converts newlines — for multi-line text blocks inside a paragraph. */
function pre(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

/** Only http(s) URLs may be emitted as hrefs; anything else becomes a plain "#". */
function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : "#";
}

/**
 * Brand header for the email shell.
 *
 * The Sand-baked PNG is used rather than the transparent one: the email body
 * is #FFF8F0, and a dark-mode client that inverts the background would make
 * transparent Ink letters disappear. The image needs an absolute URL, and
 * falls back to the wordmark as text when no site URL is configured — an
 * email with a broken image is worse than one with no logo.
 */
function emailHeaderLogo(): string {
  const base = siteConfig.siteUrl?.replace(/\/$/, "");
  if (!base) return `<div style="font-weight:800;font-size:20px;letter-spacing:-0.02em;margin-bottom:16px">OUTLYY</div>`;
  return `<img src="${base}/brand/outlyy-email-header@2x.png" width="208" height="48" alt="OUTLYY" style="display:block;border:0;margin-bottom:16px">`;
}

/** Minimal, inline-styled email shell. Customer text is escaped — it is untrusted (§17 §9 #6). */
export function emailShell(title: string, bodyHtml: string, ctx: TemplateContext): string {
  return `<!doctype html><html><body style="margin:0;background:#FFF8F0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  ${emailHeaderLogo()}
  <div style="background:#fff;border:1px solid #e7e5e4;border-radius:16px;padding:24px">
    <h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>
    ${bodyHtml}
  </div>
  <p style="font-size:12px;color:#78716c;margin-top:16px">We message only about this trip. No marketing unless you ask for it.${ctx.supportEmail ? ` Reply to this email or write to ${escapeHtml(ctx.supportEmail)}.` : ""}</p>
</div></body></html>`;
}

function p(html: string) {
  return `<p style="margin:0 0 12px;line-height:1.5">${html}</p>`;
}

function email(subject: string, title: string, bodyHtml: string, text: string, ctx: TemplateContext): Rendered {
  return { subject: clampSubject(subject), text, html: emailShell(title, bodyHtml, ctx) };
}

/* ------------------------------------------------------------------ render */

export function renderTemplate(event: NotificationEvent, channel: NotificationChannel, ctx: TemplateContext): Rendered {
  switch (event) {
    case "INQUIRY_ACK": {
      const availability = ctx.outOfHours ? ACK_AVAILABILITY.outOfHours : ACK_AVAILABILITY.inHours;
      if (channel === "whatsapp") {
        return whatsapp("inquiry_ack_v1", [ctx.leadFirstName, ctx.reference, ctx.agentFirstName, ctx.deadlineLabel, availability]);
      }
      const when = ctx.outOfHours
        ? `Our team is offline right now. ${ctx.agentFirstName} will message you by ${ctx.deadlineLabel}.`
        : `${ctx.agentFirstName} is checking with the operator now and will message you by ${ctx.deadlineLabel}.`;
      const text = [
        `Hi ${ctx.leadFirstName}, we received your inquiry. Your reference is ${ctx.reference}.`,
        when,
        `What we're checking:\n${itemLines(ctx)}`,
        `Nothing is charged until you say yes. If anything changes from the price you saw, we tell you first.`,
        ctx.whatsappNumber ? `Faster on WhatsApp: https://wa.me/${ctx.whatsappNumber}?text=${encodeURIComponent(`Ref ${ctx.reference}`)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return email(
        `Inquiry ${ctx.reference} received. Reply by ${ctx.deadlineLabel}`,
        `Got it, ${ctx.leadFirstName}.`,
        p(escapeHtml(when)) +
          p(`<strong>Reference:</strong> ${escapeHtml(ctx.reference)}`) +
          p(`<strong>What we're checking</strong><br>${pre(itemLines(ctx))}`) +
          p(`Nothing is charged until you say yes. If anything changes from the price you saw, we tell you first.`) +
          (ctx.whatsappNumber
            ? p(`Faster on WhatsApp: <a href="${safeHref(`https://wa.me/${ctx.whatsappNumber}?text=${encodeURIComponent(`Ref ${ctx.reference}`)}`)}">message us</a>.`)
            : ""),
        text,
        ctx,
      );
    }

    case "INQUIRY_OPS_ALERT": {
      if (channel === "whatsapp") {
        return whatsapp("inquiry_ops_alert_v1", [ctx.reference, inr(ctx.indicativeTotalInr), String(ctx.itemCount), ctx.agentFirstName, ctx.deadlineLabel, ctx.consoleUrl]);
      }
      const text = [
        `New inquiry ${ctx.reference} · ${inr(ctx.indicativeTotalInr)} · ${ctx.itemCount} item(s)`,
        `Lead: ${ctx.leadName} · ${ctx.leadPhone}${ctx.leadEmail ? ` · ${ctx.leadEmail}` : ""}`,
        `Dates: ${ctx.datesFlexible ? "flexible" : (ctx.travelDateFrom ?? "—")} · Guests: ${ctx.guests}${ctx.dietary ? ` · ${ctx.dietary}` : ""}${ctx.hotel ? ` · Hotel: ${ctx.hotel}` : ""}`,
        `Assigned: ${ctx.agentName} · reply by ${ctx.deadlineLabel}${ctx.outOfHours ? " (out of hours)" : ""}`,
        ``,
        itemLines(ctx),
        ctx.specialRequests ? `\nNotes: ${ctx.specialRequests}` : "",
        `\nOpen: ${ctx.consoleUrl}`,
      ].join("\n");
      return email(
        `[OUTLYY] New inquiry ${ctx.reference} — ${inr(ctx.indicativeTotalInr)} — ${ctx.agentFirstName}`,
        `New inquiry ${ctx.reference}`,
        p(pre(text)) + p(`<a href="${safeHref(ctx.consoleUrl)}">Open in console</a>`),
        text,
        ctx,
      );
    }

    case "INQUIRY_ASSIGNED": {
      const verb = ctx.reassigned ? "Reassigned" : "Assigned";
      const text = `${verb} to you: ${ctx.reference} · ${ctx.leadName} · ${inr(ctx.indicativeTotalInr)}. Reply by ${ctx.deadlineLabel}.\n\n${itemLines(ctx)}\n\n${ctx.consoleUrl}`;
      return email(
        `[OUTLYY] ${verb}: ${ctx.reference} — reply by ${ctx.deadlineLabel}`,
        `${verb} to you`,
        p(pre(text)),
        text,
        ctx,
      );
    }

    case "INQUIRY_SLA_BREACH": {
      const text = `SLA breached: ${ctx.reference} · ${ctx.leadName} · ${inr(ctx.indicativeTotalInr)} was due ${ctx.deadlineLabel}. Assigned: ${ctx.agentName}. The customer has been told we're still checking.\n\n${ctx.consoleUrl}`;
      return email(
        `[OUTLYY] SLA breach ${ctx.reference} — was due ${ctx.deadlineLabel}`,
        `SLA breached — ${ctx.reference}`,
        p(pre(text)) + p(`<a href="${safeHref(ctx.consoleUrl)}">Open in console</a>`),
        text,
        ctx,
      );
    }

    case "INQUIRY_STILL_CHECKING": {
      if (channel === "whatsapp") {
        return whatsapp("inquiry_followup_v1", [ctx.leadFirstName, ctx.reference, FOLLOWUP_SENTENCES.stillChecking, ctx.agentFirstName]);
      }
      const text = `Hi ${ctx.leadFirstName}, we’re still waiting for the operator’s reply about your OUTLYY inquiry ${ctx.reference}. We’ll update you when we hear back.\n\nReply to this email to reach ${ctx.agentFirstName}.`;
      return email(`Inquiry ${ctx.reference} is still with the operator`, `Still checking inquiry ${ctx.reference}`, p(pre(text)), text, ctx);
    }

    case "INQUIRY_FOLLOWUP": {
      const stage = ctx.stage ?? 1;
      const sentence = stage <= 1 ? FOLLOWUP_SENTENCES.stage1 : stage === 2 ? FOLLOWUP_SENTENCES.stage2 : FOLLOWUP_SENTENCES.stage3;
      if (channel === "whatsapp") {
        return whatsapp("inquiry_followup_v1", [ctx.leadFirstName, ctx.reference, sentence, ctx.agentFirstName]);
      }
      const text =
        stage <= 1
          ? `Hi ${ctx.leadFirstName}, did the options for OUTLYY inquiry ${ctx.reference} work for you? Let us know if you’d like to check another date or experience.\n\nReply to this email to reach ${ctx.agentFirstName}.`
          : stage === 2
            ? `Hi ${ctx.leadFirstName}, tell us if the price or dates for OUTLYY inquiry ${ctx.reference} didn’t work. We can check other options.\n\nReply to this email to reach ${ctx.agentFirstName}.`
            : `Hi ${ctx.leadFirstName}, this is our last follow-up on OUTLYY inquiry ${ctx.reference}. Reply if you’d like us to keep looking at options.\n\nReply to this email to reach ${ctx.agentFirstName}.`;
      const subject = stage <= 1 ? `Did the options for inquiry ${ctx.reference} work for you?` : stage === 2 ? `Checking in about inquiry ${ctx.reference}` : `Last update on inquiry ${ctx.reference}`;
      return email(subject, `About ${ctx.reference}`, p(pre(text)), text, ctx);
    }

    case "TRAVELDESK_UPKEEP_DIGEST":
      return renderUpkeepDigest(ctx);

    case "INQUIRY_WON": {
      const booking = ctx.orderReference ?? ctx.reference;
      const text = `Hi ${ctx.leadFirstName}, your trip is confirmed. Booking reference ${booking} (inquiry ${ctx.reference}). Your vouchers and pickup details follow from ${ctx.agentFirstName} on WhatsApp.`;
      return email(`Booking ${booking} confirmed`, "Your trip is confirmed", p(escapeHtml(text)), text, ctx);
    }

    case "ACCOUNT_DELETION_REQUEST": {
      // Internal, ops recipients only: they need the full identity to find and anonymise the
      // records (§05.8) — the same scope the ops alert already carries. Everything is escaped in html.
      const customerId = ctx.customerId ?? ctx.reference;
      const text = [
        `A customer asked for their account and data to be deleted.`,
        `Customer: ${ctx.leadName || "(no name given)"} · ${ctx.leadPhone}${ctx.leadEmail ? ` · ${ctx.leadEmail}` : ""}`,
        `Customer id: ${customerId}${ctx.customerSince ? ` · with us since ${ctx.customerSince.slice(0, 10)}` : ""}`,
        `Requested: ${ctx.requestedAt ?? "—"}`,
        ctx.deletionReason ? `Reason given: ${ctx.deletionReason}` : "No reason given.",
        ``,
        `Nothing has been deleted yet. Review the request, then run the anonymisation from the console (privacy → anonymise by phone). The account stays usable until then.`,
        ``,
        `Audit trail: ${ctx.consoleUrl}`,
      ].join("\n");
      return email(
        `[OUTLYY] Deletion request — ${ctx.phoneMasked ?? ctx.leadPhone}`,
        "Account deletion request",
        p(pre(text)) + p(`<a href="${safeHref(ctx.consoleUrl)}">Open audit trail</a>`),
        text,
        ctx,
      );
    }

    case "OPS_INCIDENT_ALERT":
      return renderOpsIncidentAlert(ctx);

    case "OPS_ALERT_DIGEST":
      return renderOpsAlertDigest(ctx);

    case "OWNER_ACTION_ALERT":
      return renderOwnerActionAlert(ctx);
  }
}

/* ------------------------------------------------------------ ops alerts (doc 22 §32.24) */

/**
 * The stored context of an ops alert (`ops-alert.service.ts`). Codes, ids,
 * the order reference, timestamps and an admin link: never a customer name,
 * phone or email, never a supplier net price or any amount. The message is
 * rendered from this stored context on every attempt, so a resend under the
 * same idempotency key is byte-identical.
 */
export interface OpsAlertContext {
  /** Incident kind, a short code (`saga_attention`, `booking_attention`, ...). */
  incident: string;
  /** One line naming the incident, e.g. "Payment needs attention". */
  title: string;
  /** The reason code (`manual_review`, `item_refund_short`, ...). */
  reasonCode: string;
  orderReference: string | null;
  /** Our supplier booking row id (UUID), when the incident has one. */
  bookingId: string | null;
  /** The supplier's own booking number, when known. */
  supplierBookingRef: string | null;
  /** `<entity kind>:<id>`, what the dedup counts. */
  entity: string;
  raisedAt: string;
  adminUrl: string;
}

export interface OpsAlertDigestContext {
  suppressedCount: number;
  sinceIso: string;
  untilIso: string;
  adminUrl: string;
}

const OPS_SUBJECT_PREFIX = "[OUTLY ALERT]";

/** A field of a stored context, as a short single line; anything else reads "—". Never throws. */
function opsField(ctx: Record<string, unknown>, key: string): string {
  const v = ctx[key];
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string" || !v.trim()) return "—";
  const one = v.replace(/\s+/g, " ").trim();
  return one.length > 200 ? `${one.slice(0, 199)}…` : one;
}

function opsShell(title: string, text: string, adminUrl: string): string {
  return `<!doctype html><html><body style="margin:0;background:#ffffff;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(title)}</h1>
  ${p(pre(text))}
  ${p(`<a href="${safeHref(adminUrl)}">Open in admin</a>`)}
  <p style="font-size:12px;color:#78716c;margin-top:16px">Internal OUTLY operations alert. No customer details are included; open the admin page for them.</p>
</div></body></html>`;
}

function renderOpsIncidentAlert(raw: TemplateContext): Rendered {
  const ctx = raw as Record<string, unknown>;
  const title = opsField(ctx, "title");
  const order = opsField(ctx, "orderReference");
  const adminUrl = opsField(ctx, "adminUrl");
  const text = [
    `Incident: ${title}`,
    `Kind: ${opsField(ctx, "incident")}`,
    `Reason: ${opsField(ctx, "reasonCode")}`,
    `Order: ${order}`,
    `Booking: ${opsField(ctx, "bookingId")}`,
    `Supplier booking: ${opsField(ctx, "supplierBookingRef")}`,
    `Entity: ${opsField(ctx, "entity")}`,
    `Raised: ${opsField(ctx, "raisedAt")}`,
    ``,
    `Admin: ${adminUrl}`,
  ].join("\n");
  return { subject: clampSubject(`${OPS_SUBJECT_PREFIX} ${title}${order !== "—" ? ` — ${order}` : ""}`), text, html: opsShell(title, text, adminUrl) };
}

function renderOpsAlertDigest(raw: TemplateContext): Rendered {
  const ctx = raw as Record<string, unknown>;
  const count = opsField(ctx, "suppressedCount");
  const adminUrl = opsField(ctx, "adminUrl");
  const title = `${count} more alerts suppressed`;
  const text = [
    `${count} more ops alerts were suppressed by the hourly limit between ${opsField(ctx, "sinceIso")} and ${opsField(ctx, "untilIso")}.`,
    `Each one is still flagged in admin; check the bookings queue.`,
    ``,
    `Admin: ${adminUrl}`,
  ].join("\n");
  return { subject: clampSubject(`${OPS_SUBJECT_PREFIX} ${title}`), text, html: opsShell(title, text, adminUrl) };
}

/* ------------------------------------------------------------ owner alert (doc 30 N2) */

/**
 * The stored context of an owner alert (`owner-alert.ts`): what one
 * administrator did alone, with a fresh authenticator code, in production.
 * Operation code, environment, the approval id, the acting administrator's
 * display name and id, the listing count, short facts (class key, product
 * id, bulk action) and an admin link. Never a price, a net, a customer
 * detail, a code or a secret. Rendered from this stored context on every
 * attempt, so a resend under the same idempotency key is identical.
 */
export interface OwnerAlertContext {
  operation: string;
  /** One line naming the action, e.g. "Instant selling switched on for one listing". */
  title: string;
  environment: string;
  approvalId: string;
  actorName: string;
  actorId: string;
  itemCount: number;
  /** `key: value` lines of whitelisted short facts. */
  facts: string[];
  appliedAt: string;
  adminUrl: string;
}

const OWNER_SUBJECT_PREFIX = "[OUTLY OWNER ALERT]";

function renderOwnerActionAlert(raw: TemplateContext): Rendered {
  const ctx = raw as Record<string, unknown>;
  const title = opsField(ctx, "title");
  const adminUrl = opsField(ctx, "adminUrl");
  const facts = Array.isArray(ctx.facts) ? ctx.facts.filter((f): f is string => typeof f === "string").slice(0, 12).map((f) => f.replace(/\s+/g, " ").slice(0, 200)) : [];
  const text = [
    `Action: ${title}`,
    `Operation: ${opsField(ctx, "operation")}`,
    `Environment: ${opsField(ctx, "environment")}`,
    `By: ${opsField(ctx, "actorName")} (${opsField(ctx, "actorId")})`,
    `Listings: ${opsField(ctx, "itemCount")}`,
    ...facts,
    `Approval: ${opsField(ctx, "approvalId")}`,
    `Applied: ${opsField(ctx, "appliedAt")}`,
    ``,
    `Approved at once by one administrator with a fresh authenticator code (owner decisions D15, D16). The action follows the approval; its outcome is in the audit log.`,
    `To undo: switch the class off or send the listings back to inquiry in admin. Neither needs an approval.`,
    ``,
    `Admin: ${adminUrl}`,
  ].join("\n");
  return { subject: clampSubject(`${OWNER_SUBJECT_PREFIX} ${title}`), text, html: opsShell(title, text, adminUrl) };
}

/* ------------------------------------------------------------ tickets (B4) */

/**
 * Ticket-ready email (TKT-5, TKT-6, TKT-9). Rendered at send time from ids
 * only; the notification row never stores this context.
 *
 * The one link is `<site>/t#<token>`: the capability token sits in the URL
 * fragment, which browsers never send to a server, so it cannot reach access
 * logs, `Referer` headers or a link-preview fetch. The landing page posts it
 * to `/api/tickets/exchange` (doc 22 §26 F39). No ticket code, voucher Guid,
 * supplier URL or document link is ever part of the message: the customer
 * opens the tickets on Outly, behind the ownership check.
 */
export const TICKET_EVENTS = ["TICKETS_READY"] as const;
export type TicketNotificationEvent = (typeof TICKET_EVENTS)[number];

export interface TicketsReadyContext {
  /** Customer first name; omitted when unknown. */
  firstName?: string;
  orderReference: string;
  /**
   * Doc 29 Batch 5: an open-dated ticket item carries `ticket` (its validity
   * line and its ticket types, never a code); the email then also says the
   * tickets are non-refundable once issued.
   */
  items: { title: string; dateLabel?: string; pickup?: string; ticket?: { validityCopy: string | null; validityConcern?: string | null; types: string[] } }[];
  /** `${siteUrl}/t#${token}`. Built by `ticketLink`. */
  link: string;
  /** When the link stops working (e.g. "15 Feb 2030"). */
  expiresLabel?: string;
  supportEmail?: string;
}

/** The capability link. The token goes in the fragment only, never the path or query. */
export function ticketLink(siteUrl: string, token: string): string {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error("ticketLink: malformed token");
  return `${siteUrl.replace(/\/+$/, "")}/t#${token}`;
}

export function renderTicketsReady(ctx: TicketsReadyContext): Rendered {
  const greeting = ctx.firstName ? `Hi ${ctx.firstName},` : "Hi,";
  const itemLine = (i: TicketsReadyContext["items"][number]) =>
    [`• ${i.title}${i.dateLabel ? ` · ${i.dateLabel}` : ""}`, ...(i.pickup ? [`  ${i.pickup}`] : []), ...(i.ticket?.types ?? []).map((t) => `  ${t}`), ...(i.ticket?.validityCopy ? [`  ${i.ticket.validityCopy}`] : []), ...(i.ticket?.validityConcern ? [`  ${i.ticket.validityConcern}`] : [])].join("\n");
  const lines = ctx.items.length ? ctx.items.map(itemLine).join("\n") : "";
  const validity = ctx.expiresLabel ? `The link works until ${ctx.expiresLabel}.` : "";
  const openDated = ctx.items.some((i) => i.ticket);
  const text = [
    `${greeting} your tickets for booking ${ctx.orderReference} are ready.`,
    lines,
    openDated ? TICKET_NON_REFUNDABLE_STATEMENT : "",
    `Open your tickets: ${ctx.link}`,
    `This link is personal to your booking. Please do not forward it. ${validity}`.trim(),
    `If you did not make this booking, reply to this email and we will look into it.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const shellCtx = { supportEmail: ctx.supportEmail } as TemplateContext;
  const html =
    p(`${escapeHtml(greeting)} your tickets for booking <strong>${escapeHtml(ctx.orderReference)}</strong> are ready.`) +
    (lines ? p(pre(lines)) : "") +
    (openDated ? p(`<strong>${escapeHtml(TICKET_NON_REFUNDABLE_STATEMENT)}</strong>`) : "") +
    p(`<a href="${safeHref(ctx.link)}" style="display:inline-block;background:#1c1917;color:#fff;padding:10px 16px;border-radius:999px;text-decoration:none">Open your tickets</a>`) +
    p(escapeHtml(`This link is personal to your booking. Please do not forward it. ${validity}`.trim())) +
    p(`If you did not make this booking, reply to this email and we will look into it.`);
  return { subject: clampSubject(`Your tickets for ${ctx.orderReference} are ready`), text, html: emailShell("Your tickets are ready", html, shellCtx) };
}

/* ------------------------------------------------------------ TravelDesk upkeep digest (doc 30 N3) */

/**
 * The stored context of the owner's daily digest (traveldesk-upkeep.service.ts,
 * owner decision D17): every imported listing the upkeep changed or left for a
 * person since the last digest, as listing slugs, titles and short lines
 * naming the kind of change and the field. Never a price, a net, supplier
 * text or a customer detail. Rendered from this stored context on every
 * attempt, so a resend under the same idempotency key is identical.
 */
export interface UpkeepDigestContext {
  environment: string;
  /** The Dubai day the digest covers, YYYY-MM-DD. */
  day: string;
  changeCount: number;
  reviewCount: number;
  listings: { slug: string; title: string; lines: string[] }[];
  /** Listings left out of the email (cap); all are in the admin log. */
  moreListings: number;
  adminUrl: string;
}

const UPKEEP_SUBJECT_PREFIX = "[OUTLY OWNER]";

function renderUpkeepDigest(raw: TemplateContext): Rendered {
  const ctx = raw as Record<string, unknown>;
  const adminUrl = opsField(ctx, "adminUrl");
  const listings = Array.isArray(ctx.listings) ? (ctx.listings as unknown[]).slice(0, 100) : [];
  const blocks = listings.map((l) => {
    const e = (l ?? {}) as Record<string, unknown>;
    const lines = Array.isArray(e.lines) ? e.lines.filter((x): x is string => typeof x === "string").slice(0, 12).map((x) => `  - ${x.replace(/\s+/g, " ").slice(0, 200)}`) : [];
    return [`${opsField(e, "title")} (${opsField(e, "slug")})`, ...lines].join("\n");
  });
  const more = Number(ctx.moreListings) > 0 ? [`…and ${opsField(ctx, "moreListings")} more listings (see admin).`] : [];
  const title = `TravelDesk changes ${opsField(ctx, "day")}: ${opsField(ctx, "changeCount")} (${opsField(ctx, "reviewCount")} to review)`;
  const text = [
    `Environment: ${opsField(ctx, "environment")}`,
    `The daily upkeep updated imported TravelDesk listings from the supplier (owner decision D17). Nothing below waits on this email; items marked "waits for a person" are in the admin log.`,
    ``,
    ...blocks,
    ...more,
    ``,
    `Admin: ${adminUrl}`,
  ].join("\n");
  return { subject: clampSubject(`${UPKEEP_SUBJECT_PREFIX} ${title}`), text, html: opsShell(title, text, adminUrl) };
}

/* ------------------------------------------------------------ payment received (Group C, C2) */

/**
 * Payment confirmation email (doc 93 §3.1, §5.7; owner answers O7, O8, 16).
 * Rendered at send time from ids (the row stores ids only, like
 * `TICKETS_READY`). It says the money arrived, what for, and, in bold, that
 * this email is not the entry ticket. No link of any kind (O7): the booking
 * page is reached on the device that paid or through Find my booking. The
 * explicit "do not pay again" line stays (answer 16).
 *
 * `invoice` is set only when the combined "Tax invoice / Receipt" file
 * exists and FISCAL_DOCUMENTS_ENABLED is on (O8): it is then attached and
 * named here. Decided when the row is written, so a retry renders the same.
 */
export const PAYMENT_EVENTS = ["PAYMENT_RECEIVED"] as const;
export type PaymentNotificationEvent = (typeof PAYMENT_EVENTS)[number];

export interface PaymentReceivedContext {
  firstName?: string;
  orderReference: string;
  /** "AED 420.00". */
  amountLabel: string;
  /** "14 Feb 2027". */
  paidOnLabel: string;
  /** "card". */
  methodLabel: string;
  items: { title: string; dateLabel?: string; guests?: string }[];
  /** The combined invoice/receipt is attached (O8). */
  invoice?: { displayNumber: string } | null;
  supportEmail?: string;
}

export function renderPaymentReceived(ctx: PaymentReceivedContext): Rendered {
  const greeting = ctx.firstName ? `Hi ${ctx.firstName},` : "Hi,";
  const lines = ctx.items.map((i) => `• ${[i.title, i.dateLabel, i.guests].filter(Boolean).join(" · ")}`).join("\n");
  const notTicket = "This email is not your entry ticket.";
  const followUp = "Your voucher or tickets come in a separate email once the operator confirms.";
  const invoiceLine = ctx.invoice ? `Your tax invoice / receipt ${ctx.invoice.displayNumber} is attached.` : "";
  const text = [
    `${greeting} we have received your payment for booking ${ctx.orderReference}.`,
    `${ctx.amountLabel}, paid by ${ctx.methodLabel} on ${ctx.paidOnLabel}.`,
    lines,
    `${notTicket} ${followUp}`,
    "Please do not pay again.",
    invoiceLine,
    "If you did not make this booking, reply to this email and we will look into it.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const html =
    p(`${escapeHtml(greeting)} we have received your payment for booking <strong>${escapeHtml(ctx.orderReference)}</strong>.`) +
    p(`<strong>${escapeHtml(ctx.amountLabel)}</strong>, paid by ${escapeHtml(ctx.methodLabel)} on ${escapeHtml(ctx.paidOnLabel)}.`) +
    (lines ? p(pre(lines)) : "") +
    p(`<strong>${escapeHtml(notTicket)}</strong> ${escapeHtml(followUp)}`) +
    p("Please do not pay again.") +
    (invoiceLine ? p(escapeHtml(invoiceLine)) : "") +
    p("If you did not make this booking, reply to this email and we will look into it.");
  const shellCtx = { supportEmail: ctx.supportEmail } as TemplateContext;
  return { subject: clampSubject(`Payment received for booking ${ctx.orderReference}`), text, html: emailShell("Payment received", html, shellCtx) };
}

/* ------------------------------------------------------------ invoice issued (Group C, O8 follow-up) */

/**
 * The follow-up "your tax invoice / receipt" email (review 102 finding 14;
 * owner answer O8 "attach"). The invoice is numbered and drawn by the
 * documents job after the capture, so the payment email usually goes before
 * it exists; this email then carries the file. Sent once per invoice, only
 * while FISCAL_DOCUMENTS_ENABLED and PAYMENT_RECEIVED_EMAIL_ENABLED are on and
 * the file is valid, never when the payment email already carried the same
 * file, never for a cancelled or refunding order. No link (O7), not an entry
 * ticket, rendered at send time from ids.
 */
export const INVOICE_EVENTS = ["INVOICE_ISSUED"] as const;
export type InvoiceNotificationEvent = (typeof INVOICE_EVENTS)[number];

export interface InvoiceIssuedContext {
  firstName?: string;
  orderReference: string;
  displayNumber: string;
  supportEmail?: string;
}

export function renderInvoiceIssued(ctx: InvoiceIssuedContext): Rendered {
  const greeting = ctx.firstName ? `Hi ${ctx.firstName},` : "Hi,";
  const attached = `Your tax invoice / receipt ${ctx.displayNumber} for booking ${ctx.orderReference} is attached.`;
  // No "tickets come in a separate email" line (re-review N5): by the time the invoice exists they may have come already.
  const notTicket = "This email is not your entry ticket.";
  const text = [`${greeting} ${attached}`, notTicket, "There is nothing to pay.", "If you did not make this booking, reply to this email and we will look into it."].join("\n\n");
  const html =
    p(`${escapeHtml(greeting)} ${escapeHtml(attached)}`) +
    p(`<strong>${escapeHtml(notTicket)}</strong>`) +
    p("There is nothing to pay.") +
    p("If you did not make this booking, reply to this email and we will look into it.");
  const shellCtx = { supportEmail: ctx.supportEmail } as TemplateContext;
  return { subject: clampSubject(`Tax invoice / receipt ${ctx.displayNumber} for booking ${ctx.orderReference}`), text, html: emailShell("Tax invoice / receipt", html, shellCtx) };
}
