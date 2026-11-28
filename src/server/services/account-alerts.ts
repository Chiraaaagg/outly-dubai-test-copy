import "server-only";
import { Prisma } from "@prisma/client";
import { prisma, type Tx } from "../lib/db";
import { env } from "../lib/env";
import type { OpsIncident } from "./ops-alert.service";
import { MAX_ATTEMPTS, RETRY_WINDOW_MS } from "./notification.service";
import { ACCOUNT_LINK_NOTICE_EVENT } from "../notifications/auth-templates";
import { emitEvent } from "../lib/structured-events";
import { budgetWindowStart, SIGNIN_CODE_BUDGET_BUCKET, signInBudgetCrossings, signInCodeDailyBudget } from "../auth/signin-code-budget";
import { SIGNUP_CLAIM_MISSING_BUCKET, signupClaimWindowStart } from "../auth/signup-claim-alert";

/**
 * Group B staff alerts, read from committed state by the ops sweep
 * (ops-alert.service.ts `collectOpsIncidents`). Ids and codes only, never an
 * email, a name or a token.
 *
 *  - `account_attach_disputed`: someone used "This was not me" on a booking
 *    notice; the order was detached (owner Q-B4: detach and alert, no forced
 *    sign-out). Entity `order_account_link:<link id>`.
 *  - `account_attach_capped`: one sign-in matched more than 20 guest orders,
 *    so none were attached (audit `customer.order_attach_capped`). Entity
 *    `customer:<customer id>`.
 *  - `supabase_user_delete_due`: an erased account had a Supabase Auth user,
 *    which staff delete by hand in the Supabase dashboard (owner Q-B3).
 *    Entity `customer:<customer id>`; the user id is in the audit row.
 *  - `account_attach_notice_failed` (review 103 finding 5): the "booking
 *    added to an account" notice of a link that is still attached will not
 *    be sent: its outbox row failed for good (definite failure, attempts or
 *    retry window spent, or flagged for a human), or no row was written
 *    within NOTICE_MISSING_AFTER_MS of the attach. The notice is the buyer's
 *    only control on an automatic attach, so staff check it by hand. A
 *    notice that ended `suppressed` (opted out, unsupported) counts as not
 *    sent, except the non-production allowlist (re-review 103b N5).
 *    Entity `order_account_link:<link id>`.
 *  - `email_volume_high` (owner Q-B6, Resend free tier): emails sent today
 *    (UTC) or this calendar month reached EMAIL_VOLUME_ALERT_PERCENT of the
 *    plan's cap. Counts the notification outbox plus the codes sent outside
 *    it (`email_send_counters`). Entity `email_volume:day:<date>` or
 *    `email_volume:month:<yyyy-mm>`, raised at the start of the day on which
 *    the threshold was crossed, so it alerts once per window.
 *  - `signin_code_budget` (re-review 103b N1): today's sign-in code budget
 *    (40 % of EMAIL_DAILY_SEND_CAP, the limiter bucket of the email start
 *    route) reached 80 % (`signin_code_budget_80pct`) or is spent
 *    (`signin_code_budget_spent`: email codes are refused until UTC midnight;
 *    Google still works). Entity `email_volume:signin_budget:<date>`, raised
 *    at the start of that UTC day, so each alerts once a day.
 *  - `signup_claim_missing` (re-review 103c D1): today our own email start
 *    route had a first-time sign-in refused because Supabase handed our
 *    Before User Created hook no signup claim (signup-claim-alert.ts). Every
 *    new email address is refused until that is fixed, or until
 *    CUSTOMER_SIGNUP_CLAIM_RELAXED is turned on. Entity
 *    `email_volume:signup_claim:<date>`, raised at the start of that UTC day,
 *    so it alerts once a day.
 *
 * Each part reads on its own: a failing query loses only its own incidents,
 * never the others', and emits `customer.identity_alerts_failed`.
 */

type Db = Tx | typeof prisma;

/** A link whose notice row was never written (the deferred send did not run) is reported after this long. */
export const NOTICE_MISSING_AFTER_MS = 15 * 60_000;

/**
 * When the outbox will not send this notice row any more, or null while it
 * still might (pure, exported for tests). Mirrors `retryFailed`: a `failed`
 * row is retried unless its error is `definite:`, its attempts reached
 * MAX_ATTEMPTS or it is older than RETRY_WINDOW_MS; an `unknown` row is final
 * once flagged for a human. `definite:link_detached` is not a failure to
 * report: the order was detached before the notice went out.
 */
export function noticeGaveUpAt(
  row: { status: string; providerError: string | null; suppressedReason?: string | null; attempt: number; createdAt: Date; failedAt: Date | null; attentionRequiredAt: Date | null },
  now: Date,
): Date | null {
  if (row.status === "unknown") return row.attentionRequiredAt;
  // Suppressed is final and nothing was sent (re-review 103b N5). The non-production allowlist is a test setup, not a buyer left untold.
  if (row.status === "suppressed") return row.suppressedReason === "non_production_allowlist" ? null : row.createdAt;
  if (row.status !== "failed") return null;
  if (row.providerError === "definite:link_detached") return null;
  const at = row.failedAt ?? row.createdAt;
  if (row.providerError?.startsWith("definite:") || row.attempt >= MAX_ATTEMPTS) return at;
  const windowEnd = new Date(row.createdAt.getTime() + RETRY_WINDOW_MS);
  return windowEnd.getTime() <= now.getTime() ? new Date(Math.max(windowEnd.getTime(), at.getTime())) : null;
}

/** Rows read per page by the notice check, and the most pages one sweep reads (re-review 103b N7). */
const NOTICE_PAGE = 500;
const NOTICE_MAX_PAGES = 40;

interface NoticeRow {
  id: string;
  status: string;
  provider_error: string | null;
  suppressed_reason: string | null;
  attempt: number;
  created_at: Date;
  /** `created_at` as Postgres text: the keyset cursor, exact to the microsecond (re-review 103c D5). */
  created_key: string;
  failed_at: Date | null;
  attention_required_at: Date | null;
  link_id: string;
  order_id: string;
  reference: string;
}

/** `account_attach_notice_failed` incidents raised in (since, now]. */
async function noticeIncidents(since: Date, now: Date, limit: number, db: Db): Promise<OpsIncident[]> {
  const out: OpsIncident[] = [];
  const incident = (link: { id: string; orderId: string; reference: string }, raisedAt: Date, reason: string): OpsIncident => ({
    kind: "account_attach_notice_failed",
    entityKind: "order_account_link",
    entityId: link.id,
    reason,
    raisedAt,
    orderId: link.orderId,
    orderReference: link.reference,
    bookingId: null,
    supplierBookingRef: null,
    adminPath: `/admin/bookings/${encodeURIComponent(link.reference)}`,
  });
  const inWindow = (d: Date | null): d is Date => Boolean(d && d.getTime() > since.getTime() && d.getTime() <= now.getTime());

  // Only notices of links that are still attached, every page of them (re-review 103b N7): rows of detached links
  // cannot crowd out a new definite failure. A row can give up up to RETRY_WINDOW_MS after it was created.
  // Bounded on the link side too (re-review 103c D5): the notice row is written right after the attach, so a link
  // attached before the lookback has no notice row inside it. Keyset pages on (created_at, id), never OFFSET, so a
  // row that changes between two pages cannot be skipped; the cursor's time is kept as Postgres text, exact to the
  // microsecond.
  const lookback = new Date(since.getTime() - RETRY_WINDOW_MS - 3_600_000);
  let after: { createdKey: string; id: string } | null = null;
  for (let page = 0; page < NOTICE_MAX_PAGES; page++) {
    const cursor: Prisma.Sql = after ? Prisma.sql`AND (n.created_at, n.id) > (${after.createdKey}::timestamptz, ${after.id}::uuid)` : Prisma.empty;
    const rows: NoticeRow[] = await db.$queryRaw<NoticeRow[]>`
      SELECT n.id::text AS id, n.status::text AS status, n.provider_error, n.suppressed_reason, n.attempt,
             n.created_at, n.created_at::text AS created_key, n.failed_at, n.attention_required_at,
             l.id::text AS link_id, l.order_id::text AS order_id, o.reference
      FROM order_account_links l
      JOIN notifications n ON n.id = l.notification_id
      JOIN orders o ON o.id = l.order_id
      WHERE l.detached_at IS NULL AND l.attached_at > ${lookback} AND n.event = ${ACCOUNT_LINK_NOTICE_EVENT} AND n.created_at > ${lookback}
        AND (n.status = 'failed'
          OR (n.status = 'unknown' AND n.attention_required_at IS NOT NULL)
          OR (n.status = 'suppressed' AND n.suppressed_reason IS DISTINCT FROM 'non_production_allowlist'))
        ${cursor}
      ORDER BY n.created_at, n.id
      LIMIT ${NOTICE_PAGE}`;
    for (const r of rows) {
      const at = noticeGaveUpAt(
        { status: r.status, providerError: r.provider_error, suppressedReason: r.suppressed_reason, attempt: Number(r.attempt), createdAt: new Date(r.created_at), failedAt: r.failed_at ? new Date(r.failed_at) : null, attentionRequiredAt: r.attention_required_at ? new Date(r.attention_required_at) : null },
        now,
      );
      if (inWindow(at)) out.push(incident({ id: r.link_id, orderId: r.order_id, reference: r.reference }, at, "attach_notice_failed"));
    }
    if (rows.length < NOTICE_PAGE) break;
    const last = rows[rows.length - 1];
    after = { createdKey: last.created_key, id: last.id };
  }

  // No outbox row at all: it could not be written in the sign-in request (the row is queued before the response).
  const missing = await db.orderAccountLink.findMany({
    where: {
      notificationId: null,
      detachedAt: null,
      rule: { in: ["verified_email", "guest_session"] },
      attachedAt: { gt: new Date(since.getTime() - NOTICE_MISSING_AFTER_MS), lte: new Date(now.getTime() - NOTICE_MISSING_AFTER_MS) },
    },
    select: { id: true, orderId: true, attachedAt: true, order: { select: { reference: true } } },
    orderBy: { attachedAt: "desc" },
    take: limit,
  });
  for (const l of missing) out.push(incident({ id: l.id, orderId: l.orderId, reference: l.order.reference }, new Date(l.attachedAt.getTime() + NOTICE_MISSING_AFTER_MS), "attach_notice_missing"));
  return out;
}

/** One part of the account alerts, read on its own: a failure loses only that part and is logged (re-review 103b N3). */
async function part(name: "disputed" | "audit" | "notices" | "volume" | "signin_budget" | "signup_claim", read: () => Promise<OpsIncident[]>): Promise<OpsIncident[]> {
  try {
    return await read();
  } catch {
    emitEvent("customer.identity_alerts_failed", { part: name }, "error");
    return [];
  }
}

export async function accountIncidents(since: Date, now: Date, limit = 100, db: Db = prisma): Promise<OpsIncident[]> {
  const disputed = await part("disputed", async () => {
    const rows = await db.orderAccountLink.findMany({
      where: { detachReason: "not_me", detachedAt: { gt: since, lte: now } },
      select: { id: true, orderId: true, detachedAt: true, order: { select: { reference: true } } },
      orderBy: { detachedAt: "asc" },
      take: limit,
    });
    return rows.map(
      (d): OpsIncident => ({
        kind: "account_attach_disputed",
        entityKind: "order_account_link",
        entityId: d.id,
        reason: "attach_disputed",
        raisedAt: d.detachedAt!,
        orderId: d.orderId,
        orderReference: d.order.reference,
        bookingId: null,
        supplierBookingRef: null,
        adminPath: `/admin/bookings/${encodeURIComponent(d.order.reference)}`,
      }),
    );
  });
  const audited = await part("audit", async () => {
    const rows = await db.auditLog.findMany({
      where: { entityType: { in: ["customer_attach_cap", "customer_supabase_user"] }, createdAt: { gt: since, lte: now } },
      select: { entityType: true, entityId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    });
    return rows.map((r): OpsIncident => {
      const capped = r.entityType === "customer_attach_cap";
      return {
        kind: capped ? "account_attach_capped" : "supabase_user_delete_due",
        entityKind: "customer",
        entityId: r.entityId,
        reason: capped ? "attach_capped" : "supabase_user_delete_due",
        raisedAt: r.createdAt,
        orderId: null,
        orderReference: null,
        bookingId: null,
        supplierBookingRef: null,
        adminPath: "/admin",
      };
    });
  });
  const notices = await part("notices", () => noticeIncidents(since, now, limit, db));
  return [...disputed, ...notices, ...audited];
}

const dayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Emails per UTC day since `from`: outbox rows that went out, plus the counted codes. */
export async function emailsPerDay(from: Date, until: Date, db: Db = prisma): Promise<Map<string, number>> {
  const outbox = await db.$queryRaw<{ day: Date; n: bigint }[]>`
    SELECT date_trunc('day', sent_at AT TIME ZONE 'UTC') AS day, count(*)::bigint AS n
    FROM notifications
    WHERE channel = 'email' AND sent_at >= ${from} AND sent_at <= ${until} AND status IN ('sent', 'delivered', 'read')
    GROUP BY 1`;
  const codes = await db.$queryRaw<{ day: Date; n: bigint }[]>`
    SELECT day::timestamp AS day, sum(count)::bigint AS n FROM email_send_counters
    WHERE day >= ${from}::date AND day <= ${until}::date GROUP BY 1`;
  const by = new Map<string, number>();
  for (const r of [...outbox, ...codes]) {
    const k = isoDay(new Date(r.day));
    by.set(k, (by.get(k) ?? 0) + Number(r.n));
  }
  return by;
}

/** Pure: which windows crossed the threshold, and on which day. Exported for tests. */
export function volumeCrossings(perDay: Map<string, number>, now: Date, caps: { daily: number; monthly: number; percent: number }): { window: "day" | "month"; key: string; crossedOn: Date; count: number; cap: number }[] {
  const pct = Math.min(100, Math.max(1, caps.percent || 80));
  const out: { window: "day" | "month"; key: string; crossedOn: Date; count: number; cap: number }[] = [];
  const today = isoDay(dayStart(now));
  const dailyThreshold = Math.ceil((caps.daily * pct) / 100);
  const todayCount = perDay.get(today) ?? 0;
  if (caps.daily > 0 && todayCount >= dailyThreshold) out.push({ window: "day", key: today, crossedOn: dayStart(now), count: todayCount, cap: caps.daily });

  const monthlyThreshold = Math.ceil((caps.monthly * pct) / 100);
  if (caps.monthly > 0) {
    let running = 0;
    for (let d = monthStart(now); d.getTime() <= dayStart(now).getTime(); d = new Date(d.getTime() + 86_400_000)) {
      running += perDay.get(isoDay(d)) ?? 0;
      if (running >= monthlyThreshold) {
        out.push({ window: "month", key: isoDay(monthStart(now)).slice(0, 7), crossedOn: d, count: running, cap: caps.monthly });
        break;
      }
    }
  }
  return out;
}

export async function emailVolumeIncidents(now: Date, db: Db = prisma): Promise<OpsIncident[]> {
  const e = env();
  const perDay = await emailsPerDay(monthStart(now), now, db);
  return volumeCrossings(perDay, now, { daily: e.EMAIL_DAILY_SEND_CAP, monthly: e.EMAIL_MONTHLY_SEND_CAP, percent: e.EMAIL_VOLUME_ALERT_PERCENT }).map((c) => ({
    kind: "email_volume_high" as const,
    entityKind: "email_volume" as const,
    entityId: `${c.window}:${c.key}`,
    reason: `email_volume_${c.window}_${Math.min(100, Math.max(1, e.EMAIL_VOLUME_ALERT_PERCENT || 80))}pct`,
    raisedAt: c.crossedOn,
    orderId: null,
    orderReference: null,
    bookingId: null,
    supplierBookingRef: null,
    adminPath: "/admin",
  }));
}

/**
 * `signin_code_budget` incidents for today (re-review 103b N1), read from the
 * email start route's own limiter bucket for the UTC day that holds `now`.
 * Never throws: a read failure loses only this alert and is logged.
 */
export async function signInCodeBudgetIncidents(now: Date, db: Db = prisma): Promise<OpsIncident[]> {
  return part("signin_budget", async () => {
    const row = await db.rateLimitBucket.findUnique({ where: { key_windowStart: { key: SIGNIN_CODE_BUDGET_BUCKET, windowStart: budgetWindowStart(now) } }, select: { count: true } });
    const budget = signInCodeDailyBudget(env().EMAIL_DAILY_SEND_CAP);
    return signInBudgetCrossings(row?.count ?? 0, budget, now).map(
      (c): OpsIncident => ({
        kind: "signin_code_budget",
        entityKind: "email_volume",
        entityId: `signin_budget:${isoDay(c.raisedAt)}`,
        reason: c.reason,
        raisedAt: c.raisedAt,
        orderId: null,
        orderReference: null,
        bookingId: null,
        supplierBookingRef: null,
        adminPath: "/admin",
      }),
    );
  });
}

/**
 * `signup_claim_missing` for today (re-review 103c D1), read from the
 * counter our email start route adds to when its own first-time sign-in was
 * refused for a missing signup claim. Never throws: a read failure loses only
 * this alert and is logged.
 */
export async function signupClaimIncidents(now: Date, db: Db = prisma): Promise<OpsIncident[]> {
  return part("signup_claim", async () => {
    const day = signupClaimWindowStart(now);
    const row = await db.rateLimitBucket.findUnique({ where: { key_windowStart: { key: SIGNUP_CLAIM_MISSING_BUCKET, windowStart: day } }, select: { count: true } });
    if (!row || !(row.count > 0)) return [];
    return [
      {
        kind: "signup_claim_missing",
        entityKind: "email_volume",
        entityId: `signup_claim:${isoDay(day)}`,
        reason: "signup_claim_missing",
        raisedAt: day,
        orderId: null,
        orderReference: null,
        bookingId: null,
        supplierBookingRef: null,
        adminPath: "/admin",
      },
    ];
  });
}
