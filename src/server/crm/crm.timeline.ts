import { CrmCallError } from "./bitrix.client";
import { supplierStatus, ticketStatus, type CrmSubjectState } from "./crm.mapping";

/**
 * Deal timeline comments at key moments (decision C2-11, gap G7; CRM batch
 * C2b). Pure: which moments a subject has reached, and the fixed text that
 * says so.
 *
 * Moments, each reached once per deal (its key is recorded, so a retry or a
 * later push never posts it twice):
 *  - `paid`: a payment counts as revenue (provider-verified or recorded by
 *    staff, owner answer Q4), with the paid amount for an AED order;
 *  - `confirmed`: every live line is confirmed by the supplier (a line the
 *    supplier could not provide is the `handed_to_team` moment);
 *  - `tickets_sent`: every line that needs a ticket has a valid ticket the
 *    customer can open;
 *  - `refund:<total refunded>`: each new refunded total, with that total for
 *    an AED order;
 *  - `handed_to_team`: a paid or authorised order with a line the supplier
 *    could not provide, so OUTLYY staff take over (owner to confirm this
 *    reading of "handed to the team", doc 29d §7).
 * Inquiries have no moment: their stage already says where they are.
 *
 * The text is fixed English: a header and one line per moment, each with
 * the time OUTLYY noticed it (Dubai time) and, where relevant, an AED
 * amount. Nothing else can appear: no reference, code, token, link, name,
 * phone, email, note or supplier data. `assertSafeTimelineText` refuses any
 * text that is not exactly this shape, before the call.
 *
 * Merging: moments noticed close together go into one comment. A deal's
 * pending moments are posted once none was noticed for `TIMELINE_QUIET_MS`,
 * or once the oldest has waited `TIMELINE_MAX_WAIT_MS` (crm.worker.ts).
 */

export const TIMELINE_KINDS = ["paid", "confirmed", "tickets_sent", "refund", "handed_to_team"] as const;
export type CrmTimelineKind = (typeof TIMELINE_KINDS)[number];

/** A deal's pending moments are posted once none was noticed for this long... */
export const TIMELINE_QUIET_MS = 3 * 60_000;
/** ...or once the oldest pending one has waited this long. */
export const TIMELINE_MAX_WAIT_MS = 15 * 60_000;
/** A comment the portal refused (and so did not write) is tried this often, then given up. */
export const TIMELINE_MAX_ATTEMPTS = 5;
/** At most this many deals get a comment per run: comments use only what the deal pushes left of the budget. */
export const TIMELINE_GROUPS_PER_RUN = 3;
/** At most this many moments in one comment. */
export const TIMELINE_MAX_LINES = 10;

export interface CrmMoment {
  /** Stable per deal: the kind, or `refund:<total refunded in minor units>`. */
  key: string;
  kind: CrmTimelineKind;
  /** An AED amount in minor units for the text, or null (no amount shown). */
  amountAedMinor: bigint | null;
}

/** A recorded moment as it is posted. */
export interface CrmTimelineEntry {
  kind: CrmTimelineKind;
  amountAedMinor: bigint | null;
  noticedAt: Date;
}

/** The key moments a subject has reached, from the same state the deal push reads. */
export function momentsFor(state: CrmSubjectState): CrmMoment[] {
  const o = state.order;
  if (!state.exists || state.erased || !o) return [];
  const aed = (minor: bigint) => (o.currency === "AED" && minor > 0n ? minor : null);
  const out: CrmMoment[] = [];
  if (o.capturedMinor > 0n) out.push({ key: "paid", kind: "paid", amountAedMinor: aed(o.capturedMinor) });
  const supplier = supplierStatus(o);
  if (supplier === "confirmed" || supplier === "partially_confirmed") out.push({ key: "confirmed", kind: "confirmed", amountAedMinor: null });
  if (ticketStatus(o) === "issued") out.push({ key: "tickets_sent", kind: "tickets_sent", amountAedMinor: null });
  if (o.refundedMinor > 0n) out.push({ key: `refund:${o.refundedMinor}`, kind: "refund", amountAedMinor: aed(o.refundedMinor) });
  if ((o.capturedMinor > 0n || o.authorised) && o.items.some((i) => i.status === "rejected")) out.push({ key: "handed_to_team", kind: "handed_to_team", amountAedMinor: null });
  return out;
}

export const TIMELINE_HEADER = "OUTLYY update (Dubai time)";

const PHRASE: Record<CrmTimelineKind, string> = {
  paid: "Payment received",
  confirmed: "Supplier booking confirmed",
  tickets_sent: "Tickets issued to the customer",
  refund: "Refund recorded",
  handed_to_team: "Handed to the team: a supplier could not provide part of the order",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Dubai keeps UTC+4 all year (no daylight saving). */
const DUBAI_OFFSET_MS = 4 * 3_600_000;

/** `25 Nov 2026 14:05`, in Dubai time. */
export function dubaiTime(d: Date): string {
  const t = new Date(d.getTime() + DUBAI_OFFSET_MS);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(t.getUTCDate())} ${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()} ${two(t.getUTCHours())}:${two(t.getUTCMinutes())}`;
}

/** `AED 1,250.00`. */
export function aedAmount(minor: bigint): string {
  const whole = (minor / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `AED ${whole}.${(minor % 100n).toString().padStart(2, "0")}`;
}

function line(e: CrmTimelineEntry): string {
  let text = PHRASE[e.kind];
  if (e.amountAedMinor !== null && e.amountAedMinor > 0n) {
    if (e.kind === "paid") text += `: ${aedAmount(e.amountAedMinor)}`;
    if (e.kind === "refund") text += `: ${aedAmount(e.amountAedMinor)} refunded in total`;
  }
  return `${dubaiTime(e.noticedAt)} - ${text}`;
}

/** One comment for the given moments, oldest first. */
export function renderTimelineComment(entries: CrmTimelineEntry[]): string {
  const order = (k: CrmTimelineKind) => TIMELINE_KINDS.indexOf(k);
  const sorted = [...entries].sort((a, b) => a.noticedAt.getTime() - b.noticedAt.getTime() || order(a.kind) - order(b.kind));
  return [TIMELINE_HEADER, ...sorted.slice(0, TIMELINE_MAX_LINES).map(line)].join("\n");
}

const AMOUNT = "AED \\d{1,3}(?:,\\d{3})*\\.\\d{2}";
const LINE = new RegExp(
  `^\\d{2} (?:${MONTHS.join("|")}) \\d{4} \\d{2}:\\d{2} - (?:` +
    [
      `${PHRASE.paid}(?:: ${AMOUNT})?`,
      PHRASE.confirmed,
      PHRASE.tickets_sent,
      `${PHRASE.refund}(?:: ${AMOUNT} refunded in total)?`,
      PHRASE.handed_to_team.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ].join("|") +
    ")$",
);

/** The last check before `crm.timeline.comment.add`: the header and 1 to 10 fixed lines, nothing else. */
export function assertSafeTimelineText(text: string): void {
  const lines = text.split("\n");
  const ok = text.length <= 2_000 && lines[0] === TIMELINE_HEADER && lines.length >= 2 && lines.length <= TIMELINE_MAX_LINES + 1 && lines.slice(1).every((l) => LINE.test(l));
  if (!ok) throw new CrmCallError("refused", "crm.timeline.comment.add", { code: "timeline_text" });
}
