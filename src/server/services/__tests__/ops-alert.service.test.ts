import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assertDisposableDb, cleanupPeople, createCustomer, dbEnabled, runId, syntheticPhone, type CustomerFixture } from "@/server/__tests__/helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, publishedProduct } from "@/server/__tests__/security/_mercury-fixtures";
import { cleanupCustomerRows, instantOrder, setupCustomerFixtures, type CustomerFixtures, type InstantOrder } from "@/server/__tests__/b5/customer-fixtures";
import { uuidv7 } from "@/server/lib/ids";
import { resetEnvCache } from "@/server/lib/env";
import type { EmailOutcome, EmailSend, EmailSendOptions } from "@/server/notifications/email.adapter";
import type { OpsIncident } from "../ops-alert.service";

/**
 * Ops alert emails for instant-path incidents (doc 22 §32.24), on the
 * disposable database: one email per incident kind through the notification
 * outbox, the 6-hour dedup, the hourly throttle and its digest, no customer
 * contact data or supplier figures in anything sent or stored, a failing
 * provider that leaves the saga and the booking as they were, and an empty
 * recipient list.
 *
 * The sweep's clock is far in the future (`T0`), and every incident here is
 * raised just before it, so the 72-hour lookback sees this file's rows only
 * (suites run one file at a time). The provider is a fake with Resend's
 * idempotency semantics, as in notification.outbox.test.ts. Every row is
 * synthetic (`zz-sec-<run>` orders, the `zz-b5c-<run>` supplier).
 */

const run = runId();
const T0 = new Date("2033-03-01T10:00:00.000Z");
const T1 = new Date("2034-03-01T10:00:00.000Z");
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const RECIPIENT = `zz-sec-${run}-ops@outlyy.test`;
const SITE = "https://outlyy.test";

type Prisma = Awaited<ReturnType<typeof db>>;

interface Call {
  key: string;
  msg: EmailSend;
}
const provider = {
  calls: [] as Call[],
  accepted: new Map<string, string>(),
  script: [] as EmailOutcome[],
  reset() {
    this.calls = [];
    this.accepted.clear();
    this.script = [];
  },
};

async function fakeSend(msg: EmailSend, opts?: EmailSendOptions): Promise<EmailOutcome> {
  const key = opts?.idempotencyKey ?? "missing";
  provider.calls.push({ key, msg });
  const scripted = provider.script.shift();
  if (scripted) return scripted;
  const body = JSON.stringify(msg);
  const prior = provider.accepted.get(key);
  if (prior !== undefined && prior !== body) return { kind: "unknown", httpStatus: 409, reason: "conflict" };
  provider.accepted.set(key, body);
  return { kind: "sent", providerId: `fake-${key}` };
}

/** The `Entity:` line of an alert email. */
const entityOf = (c: Call) => /^Entity: (.+)$/m.exec(c.msg.text)?.[1] ?? null;

describe.skipIf(!dbEnabled)("ops alert emails (doc 22 §32.24)", () => {
  let prisma: Prisma;
  let fx: CustomerFixtures;
  let A: CustomerFixture;
  let mod: typeof import("../ops-alert.service");
  let notifications: typeof import("../notification.service");
  const savedEnv = { ...process.env };
  const outageKey = `supplier_bookings.zz-ops-${run}.test.acct${run}`;
  let clock = T0;
  let recipients = [RECIPIENT];
  const o: Record<string, InstantOrder> = {};
  const extraEntities: string[] = [];

  function service(over: Partial<import("../ops-alert.service").OpsAlertDeps> = {}) {
    return mod.createOpsAlertService({
      collect: (since, now) => mod.collectOpsIncidents(since, now),
      recipients: () => recipients,
      siteUrl: () => SITE,
      dispatch: (input) =>
        notifications.notificationService.dispatch({
          event: input.event,
          channel: "email",
          recipient: input.recipient,
          orderId: input.orderId ?? undefined,
          context: input.context as never,
          once: input.once,
        }),
      now: () => clock,
      ...over,
    });
  }

  const order = (label: string, extra: Partial<Parameters<typeof instantOrder>[3]> = {}) =>
    instantOrder(prisma, run, fx, { label, owner: { kind: "customer", customerId: A.id }, sagaState: "fulfilled", capturedMinor: 45_000n, ...extra });

  async function resetDigest() {
    await prisma.opsAlert.deleteMany({ where: { entityKind: "digest" } });
  }

  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    process.env.NOTIFICATION_RECIPIENT_ALLOWLIST = "@outlyy.test";
    delete process.env.RESEND_API_KEY;
    resetEnvCache();
    prisma = await db();
    mod = await import("../ops-alert.service");
    notifications = await import("../notification.service");
    const { emailAdapter } = await import("@/server/notifications/email.adapter");
    vi.spyOn(emailAdapter, "send").mockImplementation(fakeSend as never);
    fx = await setupCustomerFixtures(prisma, run, await publishedProduct());
    A = await createCustomer(run, syntheticPhone(run, 71));
    await resetDigest();

    // 1. The outage breaker's automatic pause.
    await prisma.$executeRaw`INSERT INTO settings (key, value, updated_at) VALUES (${outageKey}, ${JSON.stringify({ paused: true, scope: "new_sales", reason: "supplier_outage_auto", maxBookingNetMinor: 500_000, minFundsAfterMinor: 0 })}::jsonb, ${at(T0, -1 * MIN)})`;
    // 2. A saga flagged for a human.
    o.saga = await order("saga", { sagaState: "attention", bookingState: "awaiting_payment" });
    await prisma.paymentSaga.update({ where: { id: o.saga.sagaId }, data: { attentionRequiredAt: at(T0, -2 * MIN) } });
    // 3. An item refund short (multi-item).
    o.item = await order("item");
    await prisma.customerRemedy.create({
      data: { id: uuidv7(), orderId: o.item.id, orderItemId: o.item.itemId, kind: "refund", reason: "item_refund_short", amountMinor: 100n, currency: "AED", status: "failed", createdAt: at(T0, -3 * MIN) },
    });
    // 4. A failed refund, and the same item's cancellation left refund_failed: one entity, one reason.
    o.refund = await order("refund", { bookingState: "cancelled" });
    const refundId = uuidv7();
    await prisma.refund.create({
      data: { id: refundId, paymentId: o.refund.paymentId, orderItemId: o.refund.itemId, provider: "fake_aed_card", idempotencyKey: `zz-ops-${run}-${refundId}`, amountMinor: 45_000n, currency: "AED", status: "failed", reason: "customer_cancellation" },
    });
    await prisma.$executeRaw`UPDATE refunds SET updated_at = ${at(T0, -4 * MIN)} WHERE id = ${refundId}::uuid`;
    await prisma.cancellationRequest.create({
      data: { id: uuidv7(), orderId: o.refund.id, orderItemId: o.refund.itemId, supplierBookingId: o.refund.bookingId, kind: "supported", status: "refund_failed", requestedVia: "customer", refundId, reasonCode: "refund_failed", attentionRequiredAt: at(T0, -4 * MIN) },
    });
    // 5. Bookings needing staff, and one that does not yet.
    const booking = async (label: string, state: string, data: Record<string, unknown>) => {
      o[label] = await order(label, { bookingState: state, sagaState: "reserved", capturedMinor: 0n });
      await prisma.supplierBooking.update({ where: { id: o[label].bookingId! }, data });
    };
    await booking("manual", "manual_review", { attentionRequiredAt: at(T0, -5 * MIN), errorCode: "ambiguous_recovery" });
    await booking("mismatch", "awaiting_payment", { attentionRequiredAt: at(T0, -5 * MIN), errorCode: "charged_amount_mismatch" });
    await booking("unknown0", "outcome_unknown", { attentionRequiredAt: at(T0, -5 * MIN), recoverySearches: 0 });
    await booking("unknown1", "outcome_unknown", { attentionRequiredAt: at(T0, -5 * MIN), recoverySearches: 1 });
    await booking("late", "outcome_unknown", { attentionRequiredAt: at(T0, -5 * MIN), errorCode: "late_acceptance" });
    await booking("refused", "cancel_refused", {});
    await prisma.$executeRaw`UPDATE supplier_bookings SET updated_at = ${at(T0, -5 * MIN)} WHERE id = ${o.refused.bookingId}::uuid`;
    // 6. A ticket still missing past the F12 threshold.
    o.doc = await order("doc", { bookingState: "confirmed" });
    await prisma.supplierDocument.create({
      data: { id: uuidv7(), supplierBookingId: o.doc.bookingId!, orderId: o.doc.id, orderItemId: o.doc.itemId, kind: "ticket_codes", version: 1, status: "pending", source: "document_read", attentionRequiredAt: at(T0, -6 * MIN) },
    });
  });

  afterEach(() => {
    provider.reset();
    recipients = [RECIPIENT];
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    resetEnvCache();
    if (!prisma) return;
    const ids = Object.values(o).flatMap((x) => [x.sagaId, x.itemId, ...(x.bookingId ? [x.bookingId] : [])]);
    const docs = await prisma.supplierDocument.findMany({ where: { orderId: { in: Object.values(o).map((x) => x.id) } }, select: { id: true } });
    await prisma.opsAlert.deleteMany({ where: { OR: [{ entityId: { in: [...ids, ...docs.map((d) => d.id), outageKey, ...extraEntities] } }, { entityKind: "digest" }] } });
    await prisma.notification.deleteMany({ where: { recipient: RECIPIENT } });
    await prisma.setting.deleteMany({ where: { key: outageKey } });
    await cleanupCustomerRows(prisma, fx);
    await cleanupBusinessRows(run);
    await cleanupPeople(run);
  });

  it("each incident kind sends one email, through the outbox, with the order reference, booking id, reason and an admin link", async () => {
    clock = T0;
    const summary = await service().sweep();
    expect(summary.skipped).toBeUndefined();

    const mine = new Map<string, Call[]>();
    for (const c of provider.calls) {
      const e = entityOf(c);
      if (e) mine.set(e, [...(mine.get(e) ?? []), c]);
    }
    const docId = (await prisma.supplierDocument.findFirstOrThrow({ where: { orderId: o.doc.id } })).id;
    const expected: Array<[string, string, string | null]> = [
      [`supplier_account:${outageKey}`, "supplier_outage_paused", null],
      [`payment_saga:${o.saga.sagaId}`, "saga_attention", o.saga.reference],
      [`order_item:${o.item.itemId}`, "item_refund_short", o.item.reference],
      [`order_item:${o.refund.itemId}`, "refund_failed", o.refund.reference],
      [`supplier_booking:${o.manual.bookingId}`, "manual_review", o.manual.reference],
      [`supplier_booking:${o.mismatch.bookingId}`, "charged_amount_mismatch", o.mismatch.reference],
      [`supplier_booking:${o.unknown1.bookingId}`, "outcome_unknown", o.unknown1.reference],
      [`supplier_booking:${o.late.bookingId}`, "late_acceptance", o.late.reference],
      [`supplier_booking:${o.refused.bookingId}`, "cancel_refused", o.refused.reference],
      [`supplier_document:${docId}`, "tickets_missing_urgent", o.doc.reference],
    ];
    for (const [entity, reason, reference] of expected) {
      const calls = mine.get(entity) ?? [];
      expect(calls, entity).toHaveLength(1);
      const { msg, key } = calls[0];
      expect(msg.to).toBe(RECIPIENT);
      expect(msg.subject).toMatch(/^\[OUTLY ALERT\] /);
      expect(msg.text).toContain(`Reason: ${reason}`);
      if (reference) {
        expect(msg.subject).toContain(reference);
        expect(msg.text).toContain(`Order: ${reference}`);
        expect(msg.text).toContain(`Admin: ${SITE}/admin/bookings/${reference}`);
        expect(msg.html).toContain(`href="${SITE}/admin/bookings/${reference}"`);
      } else expect(msg.text).toContain(`Admin: ${SITE}/admin/suppliers/zz-ops-${run}`);
      // One outbox row per incident and recipient; its id is the provider's idempotency key.
      const row = await prisma.notification.findUniqueOrThrow({ where: { id: key } });
      expect(row).toMatchObject({ status: "sent", recipient: RECIPIENT, event: "OPS_INCIDENT_ALERT" });
    }
    // The booking alerts carry our booking id; the saga's names its item's booking.
    expect(mine.get(`supplier_booking:${o.manual.bookingId}`)![0].msg.text).toContain(`Booking: ${o.manual.bookingId}`);
    expect(mine.get(`payment_saga:${o.saga.sagaId}`)![0].msg.text).toContain(`Booking: ${o.saga.bookingId}`);
    // Not yet past its first recovery search: no email.
    expect(mine.has(`supplier_booking:${o.unknown0.bookingId}`)).toBe(false);
    expect(await prisma.opsAlert.count({ where: { entityId: { in: expected.map(([e]) => e.split(":").slice(1).join(":")) }, dispatchPending: false, sends: 1 } })).toBe(expected.length);
  });

  it("no customer contact data and no supplier figures in anything sent or stored", async () => {
    const alertRows = await prisma.opsAlert.findMany({ where: { entityKind: { not: "digest" }, incidentAt: { gte: at(T0, -HOUR), lte: T0 } } });
    const notes = await prisma.notification.findMany({ where: { recipient: RECIPIENT } });
    expect(alertRows.length).toBeGreaterThanOrEqual(10);
    const orders = await prisma.order.findMany({ where: { id: { in: Object.values(o).map((x) => x.id) } }, select: { leadName: true, leadEmail: true, leadPhone: true } });
    const bookings = await prisma.supplierBooking.findMany({ where: { orderId: { in: Object.values(o).map((x) => x.id) } }, select: { guestName: true } });
    const pii = [...orders.flatMap((r) => [r.leadName, r.leadEmail ?? "", r.leadPhone]), ...bookings.map((b) => b.guestName), A.phoneE164].filter((s) => s.length > 3);
    const stored = JSON.stringify({ alertRows: alertRows.map((r) => r.payload), notes: notes.map((n) => n.payload) });
    // Re-render every stored row exactly as a retry would.
    const { renderTemplate } = await import("@/server/notifications/templates");
    const rendered = notes.map((n) => renderTemplate(n.event as never, "email", n.payload as never));
    const everything = [stored, ...rendered.flatMap((r) => [r.subject ?? "", r.text, r.html ?? ""])].join("\n");
    for (const p of pii) expect(everything, "customer contact data").not.toContain(p);
    // The fixtures' supplier net (30_000 fils), expected nets and the charged amounts appear nowhere.
    expect(everything).not.toMatch(/(^|[^0-9a-f])(30000|300\.00|45000|450\.00|8000)([^0-9a-f]|$)/);
    // No money field of any kind (the reason code `charged_amount_mismatch` names the problem, not a figure).
    expect(everything).not.toMatch(/supplierNet|netMinor|netAed|netUsd|expectedNet|chargedNet|price|amountMinor|totalAed|totalInr|AED \d|₹/i);
  });

  it("a repeat within 6 hours is deduped; the same entity and reason raised again after 6 hours sends once more", async () => {
    clock = at(T0, 2 * MIN);
    expect((await service().sweep()).claimed).toBe(0);
    expect(provider.calls).toEqual([]);

    // Raised again (staff cleared it, the engine flagged it anew) 10 minutes later.
    await prisma.supplierBooking.update({ where: { id: o.manual.bookingId! }, data: { attentionRequiredAt: at(T0, 10 * MIN) } });
    clock = at(T0, 11 * MIN);
    const s = await service().sweep();
    expect(s.deduped).toBeGreaterThanOrEqual(1);
    expect(provider.calls.filter((c) => entityOf(c) === `supplier_booking:${o.manual.bookingId}`)).toEqual([]);

    clock = at(T0, 6 * HOUR + 1 * MIN);
    await service().sweep();
    const again = provider.calls.filter((c) => entityOf(c) === `supplier_booking:${o.manual.bookingId}`);
    expect(again).toHaveLength(1);
    expect(again[0].msg.text).toContain(`Raised: ${at(T0, 10 * MIN).toISOString()}`);
    const row = await prisma.opsAlert.findUniqueOrThrow({ where: { entityKind_entityId_reason: { entityKind: "supplier_booking", entityId: o.manual.bookingId!, reason: "manual_review" } } });
    expect(row.sends).toBe(2);
    // Nothing else was sent again: every other incident's raise was handled.
    expect(provider.calls).toHaveLength(1);
  });

  it("throttle: at most 20 alert emails an hour; the rest are suppressed and one digest per hour says how many", async () => {
    await resetDigest();
    let batch: OpsIncident[] = [];
    const make = (n: number, now: Date) =>
      Array.from({ length: n }, (_, i) => {
        const id = uuidv7();
        extraEntities.push(id);
        return { kind: "booking_attention", entityKind: "supplier_booking", entityId: id, reason: "manual_review", raisedAt: at(now, -(i + 1) * 1000), orderId: null, orderReference: null, bookingId: id, supplierBookingRef: null, adminPath: "/admin/bookings" } satisfies OpsIncident;
      });
    const svc = service({ collect: async () => batch });

    clock = T1;
    batch = make(25, T1);
    const first = await svc.sweep();
    expect(first).toMatchObject({ claimed: 20, suppressed: 5, digests: 1 });
    const alerts = provider.calls.filter((c) => c.msg.subject.startsWith("[OUTLY ALERT] Booking needs staff"));
    expect(alerts).toHaveLength(20);
    const digests = provider.calls.filter((c) => /more alerts suppressed/.test(c.msg.subject));
    expect(digests.map((d) => d.msg.subject)).toEqual(["[OUTLY ALERT] 5 more alerts suppressed"]);
    // The 20 sent are the oldest raises; the 5 newest were held back.
    expect(new Set(alerts.map(entityOf))).toEqual(new Set(batch.slice(5).map((i) => `supplier_booking:${i.entityId}`)));

    // Later in the same hour: still capped, and no second digest yet.
    provider.reset();
    clock = at(T1, 20 * MIN);
    batch = make(3, clock);
    expect(await svc.sweep()).toMatchObject({ claimed: 0, suppressed: 3, digests: 0 });
    expect(provider.calls).toEqual([]);

    // An hour after the first digest: the window has room again, and the next digest counts only what was held since.
    provider.reset();
    clock = at(T1, 61 * MIN);
    batch = make(2, clock);
    expect(await svc.sweep()).toMatchObject({ claimed: 2, suppressed: 0, digests: 1 });
    expect(provider.calls.filter((c) => /more alerts suppressed/.test(c.msg.subject)).map((d) => d.msg.subject)).toEqual(["[OUTLY ALERT] 3 more alerts suppressed"]);
    // The suppressed ones are handled: they are not sent later as individual emails.
    provider.reset();
    clock = at(T1, 62 * MIN);
    batch = [];
    expect(await svc.sweep()).toMatchObject({ claimed: 0, digests: 0 });
    expect(provider.calls).toEqual([]);
  });

  it("a failing provider never touches the booking or the saga; the outbox keeps the row for its retry, with an identical body", async () => {
    const sx = await order("fail", { sagaState: "attention", bookingState: "manual_review", capturedMinor: 0n });
    const raised = at(T1, 3 * HOUR);
    await prisma.paymentSaga.update({ where: { id: sx.sagaId }, data: { attentionRequiredAt: raised } });
    await prisma.supplierBooking.update({ where: { id: sx.bookingId! }, data: { attentionRequiredAt: raised } });
    const before = JSON.stringify(
      [await prisma.paymentSaga.findUniqueOrThrow({ where: { id: sx.sagaId } }), await prisma.supplierBooking.findUniqueOrThrow({ where: { id: sx.bookingId! } })],
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    );

    clock = at(raised, MIN);
    provider.script = [
      { kind: "failed", retryable: true, reason: "rate_limited", httpStatus: 429 },
      { kind: "unknown", httpStatus: null, reason: "timeout" },
    ];
    const s = await service().sweep();
    expect(s.dispatchFailed).toBe(2);
    expect(s.dispatched).toBe(2);
    const after = JSON.stringify(
      [await prisma.paymentSaga.findUniqueOrThrow({ where: { id: sx.sagaId } }), await prisma.supplierBooking.findUniqueOrThrow({ where: { id: sx.bookingId! } })],
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    );
    expect(after).toBe(before);
    const rows = await prisma.notification.findMany({ where: { orderId: sx.id, event: "OPS_INCIDENT_ALERT" } });
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "unknown"]);

    // The outbox sweep re-sends under the same key with the same body (the fake answers 409 to a changed body).
    const firstBodies = new Map(provider.calls.map((c) => [c.key, JSON.stringify(c.msg)]));
    provider.calls = [];
    const retry = await notifications.notificationService.retryFailed(50, new Date(Date.now() + 5 * MIN), { ids: rows.map((r) => r.id) });
    expect(retry.retried).toBe(2);
    for (const c of provider.calls) expect(JSON.stringify(c.msg)).toBe(firstBodies.get(c.key));

    // A dispatch that throws (the outbox could not even write its row) leaves the alert pending for the next sweep, and no
    // second email when it is handed again.
    const sy = await order("throw", { sagaState: "attention", capturedMinor: 0n });
    await prisma.paymentSaga.update({ where: { id: sy.sagaId }, data: { attentionRequiredAt: at(raised, 2 * MIN) } });
    clock = at(raised, 3 * MIN);
    provider.reset();
    let throwOnce = true;
    const flaky = service({
      dispatch: async (input) => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("connect ECONNREFUSED");
        }
        return notifications.notificationService.dispatch({ event: input.event, channel: "email", recipient: input.recipient, orderId: input.orderId ?? undefined, context: input.context as never, once: input.once });
      },
    });
    const t = await flaky.sweep();
    expect(t).toMatchObject({ claimed: 1, dispatched: 0, dispatchFailed: 1 });
    expect((await prisma.opsAlert.findFirstOrThrow({ where: { entityId: sy.sagaId } })).dispatchPending).toBe(true);
    clock = at(raised, 8 * MIN);
    expect(await flaky.sweep()).toMatchObject({ claimed: 0, dispatched: 1 });
    expect(provider.calls.filter((c) => entityOf(c) === `payment_saga:${sy.sagaId}`)).toHaveLength(1);
    await flaky.sweep();
    expect(provider.calls.filter((c) => entityOf(c) === `payment_saga:${sy.sagaId}`)).toHaveLength(1);
  });

  it("an empty recipient list: logged once, nothing claimed, the incident still alerts once recipients exist", async () => {
    const { log } = await import("@/server/lib/logger");
    const warn = vi.spyOn(log, "warn");
    const sz = await order("norecipients", { sagaState: "attention", capturedMinor: 0n });
    const raised = at(T1, 5 * HOUR);
    await prisma.paymentSaga.update({ where: { id: sz.sagaId }, data: { attentionRequiredAt: raised } });
    recipients = [];
    clock = at(raised, MIN);
    const svc = service();
    expect(await svc.sweep()).toMatchObject({ skipped: "no_recipients", claimed: 0 });
    expect(await svc.sweep()).toMatchObject({ skipped: "no_recipients" });
    expect(warn.mock.calls.filter(([msg]) => msg === "alerts.no_recipients")).toHaveLength(1);
    expect(await prisma.opsAlert.count({ where: { entityId: sz.sagaId } })).toBe(0);
    expect(provider.calls).toEqual([]);

    recipients = [RECIPIENT];
    clock = at(raised, 2 * MIN);
    await svc.sweep();
    expect(provider.calls.filter((c) => entityOf(c) === `payment_saga:${sz.sagaId}`)).toHaveLength(1);
    warn.mockRestore();
  });
});

/**
 * Quote budget alert (review 82; quote-budget-alert.ts) on the disposable
 * database: budget refusals group into episodes in one `settings` row per
 * account, and the sweep's collector raises one incident per episode at its
 * first refusal. Uses the database clock, so it reads a window around now
 * (the sweeps above use 2033 and 2034 and never see these rows).
 */
describe.skipIf(!dbEnabled)("quote budget alert on the database (review 82)", () => {
  let prisma: Prisma;
  let alert: typeof import("../quote-budget-alert");
  let mod: typeof import("../ops-alert.service");
  const CODE = `zz-qb-${run}`;

  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    prisma = await db();
    alert = await import("../quote-budget-alert");
    mod = await import("../ops-alert.service");
  });

  afterAll(async () => {
    await prisma.setting.deleteMany({ where: { key: { startsWith: `supplier_quote_refusals.${CODE}.` } } });
  });

  it("refusals within ten minutes are one episode and one incident; a later refusal starts a new one; codes only", async () => {
    const key = alert.quoteBudgetRefusalKey(CODE, "test", "default");
    for (let i = 0; i < 3; i++) await alert.recordQuoteBudgetRefusal(CODE, "test", "default");
    const first = (await prisma.setting.findUniqueOrThrow({ where: { key } })).value as Record<string, unknown>;
    expect(first).toMatchObject({ supplier: CODE, environment: "test", account: "default", count: 3 });
    expect(Object.keys(first).sort()).toEqual(["account", "count", "environment", "episodeStart", "lastAt", "supplier"]);

    const window = () => ({ since: new Date(Date.now() - HOUR), now: new Date(Date.now() + MIN) });
    let { since, now } = window();
    const mine = (list: OpsIncident[]) => list.filter((i) => i.entityId.startsWith(`${CODE}.`));
    const collected = mine(await mod.collectOpsIncidents(since, now));
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({ kind: "quote_budget_refused", entityKind: "supplier_account", entityId: `${CODE}.quote_budget.test.default`, reason: "quote_budget_spent", orderId: null });
    expect(collected[0].raisedAt.getTime()).toBe(new Date(String(first.episodeStart)).getTime());

    // The last refusal was 11 minutes ago: the next one starts a new episode (a new incident).
    const old = new Date(Date.now() - 20 * MIN).toISOString();
    await prisma.setting.update({ where: { key }, data: { value: { ...first, episodeStart: old, lastAt: new Date(Date.now() - 11 * MIN).toISOString() } } });
    await alert.recordQuoteBudgetRefusal(CODE, "test", "default");
    const second = (await prisma.setting.findUniqueOrThrow({ where: { key } })).value as Record<string, unknown>;
    expect(second.count).toBe(1);
    expect(new Date(String(second.episodeStart)).getTime()).toBeGreaterThan(new Date(old).getTime());

    // Within the gap the episode continues and keeps its start.
    await prisma.setting.update({ where: { key }, data: { value: { ...second, episodeStart: old, lastAt: new Date(Date.now() - 9 * MIN).toISOString() } } });
    await alert.recordQuoteBudgetRefusal(CODE, "test", "default");
    const third = (await prisma.setting.findUniqueOrThrow({ where: { key } })).value as Record<string, unknown>;
    expect(third.count).toBe(2);
    expect(new Date(String(third.episodeStart)).getTime()).toBe(new Date(old).getTime());

    // An episode that began before the window is not raised again.
    ({ since, now } = window());
    expect(mine(await alert.quoteBudgetIncidents(new Date(Date.now() - 15 * MIN), now, 100))).toHaveLength(0);
    expect(mine(await alert.quoteBudgetIncidents(since, now, 100))).toHaveLength(1);
  });
});
