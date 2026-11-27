import "server-only";
import { prisma, type Tx } from "../lib/db";
import { env } from "../lib/env";
import type { OpsIncident } from "./ops-alert.service";

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
 *  - `email_volume_high` (owner Q-B6, Resend free tier): emails sent today
 *    (UTC) or this calendar month reached EMAIL_VOLUME_ALERT_PERCENT of the
 *    plan's cap. Counts the notification outbox plus the codes sent outside
 *    it (`email_send_counters`). Entity `email_volume:day:<date>` or
 *    `email_volume:month:<yyyy-mm>`, raised at the start of the day on which
 *    the threshold was crossed, so it alerts once per window.
 */

type Db = Tx | typeof prisma;

export async function accountIncidents(since: Date, now: Date, limit = 100, db: Db = prisma): Promise<OpsIncident[]> {
  const out: OpsIncident[] = [];
  const disputed = await db.orderAccountLink.findMany({
    where: { detachReason: "not_me", detachedAt: { gt: since, lte: now } },
    select: { id: true, orderId: true, detachedAt: true, order: { select: { reference: true } } },
    orderBy: { detachedAt: "asc" },
    take: limit,
  });
  for (const d of disputed) {
    out.push({
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
    });
  }
  const rows = await db.auditLog.findMany({
    where: { entityType: { in: ["customer_attach_cap", "customer_supabase_user"] }, createdAt: { gt: since, lte: now } },
    select: { entityType: true, entityId: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  for (const r of rows) {
    const capped = r.entityType === "customer_attach_cap";
    out.push({
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
    });
  }
  return out;
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
