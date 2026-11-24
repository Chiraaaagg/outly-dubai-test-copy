import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BitrixRestClient } from "@/server/crm/bitrix.client";
import type { CrmScope } from "@/server/crm/crm.config";
import { originIdFor, type CrmSubjectState } from "@/server/crm/crm.mapping";
import {
  aedAmount,
  assertSafeTimelineText,
  dubaiTime,
  momentsFor,
  renderTimelineComment,
  TIMELINE_HEADER,
  TIMELINE_MAX_ATTEMPTS,
  TIMELINE_MAX_WAIT_MS,
  TIMELINE_QUIET_MS,
} from "@/server/crm/crm.timeline";
import { pacedLimiter, runCrmWorker } from "@/server/crm/crm.worker";
import { FakeBitrix24 } from "./_bitrix-fake";
import { FAKE_HOST, FAKE_SECRET, FAKE_USER, FakeClock, MemoryCrmStore, StateBook, TEST_CONTACT, directOrderState, fakeConfig, inquiryState, subjectId } from "./_memory-store";

/**
 * Deal timeline comments at key moments (decision C2-11, doc 29d gap G7;
 * CRM batch C2b): which moments, the fixed text, merging, posting at most
 * once, retries, and that comments never hold up a deal push. Against the
 * strict fake portal and the in-memory store; synthetic data only.
 */

const MIN = 60_000;

function harness(opts: { maxPerRun?: number } = {}) {
  const clock = new FakeClock();
  const config = fakeConfig();
  const scope: CrmScope = { environment: config.environment, portal: config.portal };
  const store = new MemoryCrmStore(clock);
  const fake = new FakeBitrix24({ host: FAKE_HOST, userId: FAKE_USER, secret: FAKE_SECRET, now: clock.ms });
  const book = new StateBook();
  const events: { name: string; fields: Record<string, unknown>; level?: string }[] = [];
  const port = new BitrixRestClient(config, { fetchImpl: fake.fetch, now: clock.ms });
  let runs = 0;
  const run = () =>
    runCrmWorker({
      config,
      store,
      port,
      loadState: book.load,
      limiter: pacedLimiter({ minIntervalMs: 1_000, maxPerRun: opts.maxPerRun ?? 12, now: clock.ms, sleep: clock.sleep }),
      now: clock.now,
      random: () => 0.5,
      holder: `worker-${++runs}`,
      emit: (name, fields, level) => events.push({ name, fields, level }),
    });
  const put = (state: CrmSubjectState) => {
    book.set(state);
    return store.enqueue(scope, state.subject);
  };
  /** One run a minute for `minutes` minutes. */
  const minutes = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await run();
      clock.advance(MIN);
    }
  };
  const dealOf = (s: CrmSubjectState) => fake.dealsFor(originIdFor(s.subject))[0];
  return { clock, config, scope, store, fake, book, events, run, put, minutes, dealOf };
}

type OrderOver = Parameters<typeof directOrderState>[1] & { items?: NonNullable<CrmSubjectState["order"]>["items"]; currency?: string };

/** A direct-checkout order at a given point of its life. */
function order(id: string, over: OrderOver = {}): CrmSubjectState {
  const s = directOrderState(id, over);
  if (over.items) s.order!.items = over.items;
  if (over.currency) s.order!.currency = over.currency;
  return s;
}

const line = (status: string, documentReady = false) => ({ title: "Burj Khalifa At the Top", serviceDate: "2026-12-02", totalMinor: 25_000n, status, needsDocument: true, documentReady });
const paid = (id: string) => order(id, { status: "paid", authorised: true, capturedMinor: 25_000n });
const confirmed = (id: string) => order(id, { status: "confirmed", authorised: true, capturedMinor: 25_000n, items: [line("confirmed")] });
const ticketed = (id: string) => order(id, { status: "confirmed", authorised: true, capturedMinor: 25_000n, items: [line("confirmed", true)] });

describe("timeline moments (pure)", () => {
  it("an order reaches paid, confirmed, tickets sent, each refunded total, and handed to the team; an inquiry has none", () => {
    const id = subjectId();
    expect(momentsFor(order(id, { status: "pending_payment", authorised: true }))).toEqual([]);
    expect(momentsFor(paid(id))).toEqual([{ key: "paid", kind: "paid", amountAedMinor: 25_000n }]);
    expect(momentsFor(ticketed(id)).map((m) => m.key)).toEqual(["paid", "confirmed", "tickets_sent"]);
    expect(momentsFor(order(id, { status: "refunded", authorised: true, capturedMinor: 25_000n, refundedMinor: 10_000n })).map((m) => [m.key, m.amountAedMinor])).toEqual([
      ["paid", 25_000n],
      ["refund:10000", 10_000n],
    ]);
    // C2B-03 (owner): our team took the paid order over (a booking or the saga flagged for staff).
    const handed = { ...paid(id), order: { ...paid(id).order!, handedToTeam: true } };
    expect(momentsFor(handed).map((m) => m.key)).toEqual(["paid", "handed_to_team"]);
    // A rejected line going to the automatic refund is not a hand-off; nor is a flag before payment.
    const rejected = order(id, { status: "partially_confirmed", authorised: true, capturedMinor: 50_000n, items: [line("confirmed"), line("rejected")] });
    expect(momentsFor(rejected).map((m) => m.key)).toEqual(["paid", "confirmed"]);
    const unpaid = order(id, { status: "pending_payment", authorised: true });
    expect(momentsFor({ ...unpaid, order: { ...unpaid.order!, handedToTeam: true } })).toEqual([]);
    expect(momentsFor(inquiryState(id, { status: "assigned" }))).toEqual([]);
    expect(momentsFor({ ...paid(id), erased: true })).toEqual([]);
  });

  it("amounts only in AED: an INR order's moments carry none", () => {
    const m = momentsFor(order(subjectId(), { status: "paid", authorised: true, capturedMinor: 900_000n, currency: "INR" }));
    expect(m).toEqual([{ key: "paid", kind: "paid", amountAedMinor: null }]);
  });

  it("fixed text: a header, then one line per moment with the Dubai time and, where relevant, an AED amount", () => {
    const at = new Date("2026-11-22T20:05:00.000Z"); // 00:05 next day in Dubai
    expect(dubaiTime(at)).toBe("23 Nov 2026 00:05");
    expect(aedAmount(123_456_789n)).toBe("AED 1,234,567.89");
    expect(aedAmount(5n)).toBe("AED 0.05");
    const text = renderTimelineComment([
      { kind: "refund", amountAedMinor: 10_000n, noticedAt: new Date(at.getTime() + 60_000) },
      { kind: "paid", amountAedMinor: 25_000n, noticedAt: at },
      { kind: "confirmed", amountAedMinor: null, noticedAt: at },
      { kind: "handed_to_team", amountAedMinor: null, noticedAt: at },
      { kind: "tickets_sent", amountAedMinor: null, noticedAt: at },
    ]);
    expect(text).toBe(
      [
        TIMELINE_HEADER,
        "23 Nov 2026 00:05 - Payment received: AED 250.00",
        "23 Nov 2026 00:05 - Supplier booking confirmed",
        "23 Nov 2026 00:05 - Tickets issued to the customer",
        "23 Nov 2026 00:05 - Handed to the team: a supplier could not confirm part of the order",
        "23 Nov 2026 00:06 - Refund recorded: AED 100.00 refunded in total",
      ].join("\n"),
    );
    expect(() => assertSafeTimelineText(text)).not.toThrow();
  });

  it("the text guard refuses anything that is not exactly the fixed shape", () => {
    const ok = `${TIMELINE_HEADER}\n22 Nov 2026 12:00 - Supplier booking confirmed`;
    expect(() => assertSafeTimelineText(ok)).not.toThrow();
    const refused = expect.objectContaining({ kind: "refused", code: "refused:timeline_text" });
    for (const bad of [
      `${TIMELINE_HEADER}`,
      `${ok}\n22 Nov 2026 12:00 - Supplier booking confirmed for ${TEST_CONTACT.name}`,
      `${ok} OUT-4829135`,
      `${ok}\nsee https://admin.outlyy.test/admin/bookings/OUT-4829135`,
      `${ok}\n22 Nov 2026 12:00 - Payment received: AED 250.00 by ${TEST_CONTACT.email}`,
      `${ok}\n22 Nov 2026 12:00 - Payment received: ${TEST_CONTACT.phone}`,
      `Hello\n22 Nov 2026 12:00 - Supplier booking confirmed`,
      `${TIMELINE_HEADER}\n${"22 Nov 2026 12:00 - Supplier booking confirmed\n".repeat(11).trim()}`,
    ]) {
      expect(() => assertSafeTimelineText(bad)).toThrow(refused);
    }
  });

  it("source scan: the text is built from fixed phrases, the time and an AED amount only; the module reads no other fact", () => {
    const src = readFileSync(path.join(process.cwd(), "src/server/crm/crm.timeline.ts"), "utf8");
    // The only facts read from state: status words (via crm.mapping), money totals, the currency, the hand-off flag.
    const reads = [...src.matchAll(/\bo\.(\w+)/g)].map((m) => m[1]);
    expect([...new Set(reads)].sort()).toEqual(["capturedMinor", "currency", "handedToTeam", "refundedMinor"]);
    for (const banned of ["contact", "reference", "title", "serviceDate", "note", "phone", "email", "name", "supplierBooking", "consent"]) {
      expect(src).not.toMatch(new RegExp(`\\.${banned}\\b`));
    }
  });
});

describe("timeline comments on the fake portal", () => {
  it("a paid order gets one comment after the quiet period, with fixed text and no personal data", async () => {
    const h = harness();
    const s = paid(subjectId());
    h.put(s);
    await h.run();
    const deal = h.dealOf(s);
    expect(h.store.timelineOf(h.scope, s.subject).map((t) => [t.momentKey, t.status])).toEqual([["paid", "pending"]]);
    // Not yet: the quiet period lets close moments merge.
    h.clock.advance(TIMELINE_QUIET_MS - 1_000);
    await h.run();
    expect(h.fake.commentsOn(deal.id)).toHaveLength(0);
    h.clock.advance(2_000);
    const r = await h.run();
    expect(r.comments).toBe(1);
    const [c] = h.fake.commentsOn(deal.id);
    expect(c.text).toBe(`${TIMELINE_HEADER}\n22 Nov 2026 12:00 - Payment received: AED 250.00`);
    expect(h.store.timelineOf(h.scope, s.subject)).toMatchObject([{ momentKey: "paid", status: "posted", crmCommentId: c.id }]);
    for (const secret of [TEST_CONTACT.name, TEST_CONTACT.phone, TEST_CONTACT.email!, s.order!.reference, s.subject.id, "Burj Khalifa", "2026-12-02"]) {
      expect(c.text).not.toContain(secret);
    }
    expect(h.events.find((e) => e.name === "crm.timeline_posted")?.fields).toEqual({ linkId: h.store.link(h.scope, s.subject)!.id, moments: 1 });
  });

  it("moments noticed close together merge into one comment", async () => {
    const h = harness();
    const id = subjectId();
    h.put(paid(id));
    await h.run();
    h.clock.advance(MIN);
    h.put(confirmed(id));
    await h.run();
    h.clock.advance(MIN);
    h.put(ticketed(id));
    await h.run();
    await h.minutes(5);
    const deal = h.dealOf(paid(id));
    const comments = h.fake.commentsOn(deal.id);
    expect(comments).toHaveLength(1);
    expect(comments[0].text.split("\n")).toEqual([
      TIMELINE_HEADER,
      "22 Nov 2026 12:00 - Payment received: AED 250.00",
      "22 Nov 2026 12:01 - Supplier booking confirmed",
      "22 Nov 2026 12:02 - Tickets issued to the customer",
    ]);
  });

  it("a steady stream of moments still posts once the oldest has waited the maximum", async () => {
    const h = harness();
    const id = subjectId();
    h.put(paid(id));
    await h.run();
    // A new refunded total every two minutes: never quiet for three.
    for (let i = 1; i <= 9; i++) {
      h.clock.advance(2 * MIN);
      h.put(order(id, { status: "paid", authorised: true, capturedMinor: 25_000n, refundedMinor: BigInt(i * 100) }));
      await h.run();
    }
    const deal = h.dealOf(paid(id));
    expect(h.clock.t - Date.parse("2026-11-22T08:00:00.000Z")).toBeGreaterThanOrEqual(TIMELINE_MAX_WAIT_MS);
    expect(h.fake.commentsOn(deal.id).length).toBe(1);
    expect(h.fake.commentsOn(deal.id)[0].text).toContain("Payment received: AED 250.00");
  });

  it("idempotent: a re-push, a later change or a retry never posts a moment twice", async () => {
    const h = harness();
    const id = subjectId();
    h.put(paid(id));
    await h.minutes(5);
    const deal = h.dealOf(paid(id));
    expect(h.fake.commentsOn(deal.id)).toHaveLength(1);
    // Same state again, then another change: "paid" is never posted again; only the new moment is.
    h.put(paid(id));
    await h.run();
    h.put(confirmed(id));
    await h.minutes(5);
    expect(h.fake.commentsOn(deal.id).map((c) => c.text.split("\n").slice(1))).toEqual([["22 Nov 2026 12:00 - Payment received: AED 250.00"], ["22 Nov 2026 12:05 - Supplier booking confirmed"]]);
    expect(h.store.timelineOf(h.scope, { type: "order", id }).map((t) => t.momentKey)).toEqual(["paid", "confirmed"]);
  });

  it("a lost answer is never re-posted (at most once): the moments are settled unknown", async () => {
    const h = harness();
    const s = paid(subjectId());
    h.put(s);
    await h.run();
    h.fake.methodScript.push({ method: "crm.timeline.comment.add", failure: "lose_answer" });
    await h.minutes(10);
    const deal = h.dealOf(s);
    expect(h.fake.commentsOn(deal.id)).toHaveLength(1); // the lost one landed; nothing doubled it
    expect(h.store.timelineOf(h.scope, s.subject)).toMatchObject([{ status: "unknown", lastErrorCode: "unavailable:timeout" }]);
    expect(h.events.some((e) => e.name === "crm.timeline_failed" && e.fields.settled === "unknown")).toBe(true);
    expect(h.fake.callsOf("crm.timeline.comment.add")).toHaveLength(1);
  });

  it("a claim whose worker vanished mid-post is settled unknown, never posted again", async () => {
    const h = harness();
    const s = paid(subjectId());
    h.put(s);
    await h.run();
    h.clock.advance(TIMELINE_QUIET_MS);
    // A worker claimed the moment and died before it recorded the answer.
    const groups = await h.store.claimTimeline(h.scope, "ghost", h.clock.now(), { quietBefore: h.clock.now(), maxWaitBefore: h.clock.now(), staleBefore: new Date(0), limit: 3, perLink: 10 });
    expect(groups).toHaveLength(1);
    await h.minutes(10);
    expect(h.store.timelineOf(h.scope, s.subject)).toMatchObject([{ status: "unknown", lastErrorCode: "posting_lapsed" }]);
    expect(h.fake.callsOf("crm.timeline.comment.add")).toHaveLength(0);
  });

  it("a refused comment (nothing written) retries with backoff, then gives up after its attempts", async () => {
    const h = harness();
    const s = paid(subjectId());
    h.put(s);
    await h.run();
    h.fake.methodScript.push({ method: "crm.timeline.comment.add", failure: "reject" });
    await h.minutes(8);
    const deal = h.dealOf(s);
    expect(h.fake.commentsOn(deal.id)).toHaveLength(1);
    expect(h.store.timelineOf(h.scope, s.subject)).toMatchObject([{ status: "posted", attempts: 1 }]);

    const t = paid(subjectId());
    h.put({ ...t, order: { ...t.order!, reference: "OUT-4829136" } });
    await h.run();
    for (let i = 0; i < TIMELINE_MAX_ATTEMPTS; i++) h.fake.methodScript.push({ method: "crm.timeline.comment.add", failure: "reject" });
    for (let i = 0; i < 40; i++) {
      await h.run();
      h.clock.advance(30 * MIN);
    }
    expect(h.store.timelineOf(h.scope, t.subject)).toMatchObject([{ status: "failed", attempts: TIMELINE_MAX_ATTEMPTS, lastErrorCode: "rejected:INVALID_ARG_VALUE" }]);
    expect(h.fake.callsOf("crm.timeline.comment.add")).toHaveLength(1 + 1 + TIMELINE_MAX_ATTEMPTS);
  });

  it("a throttled comment goes back without an attempt and posts later", async () => {
    const h = harness();
    const s = paid(subjectId());
    h.put(s);
    await h.run();
    h.fake.methodScript.push({ method: "crm.timeline.comment.add", failure: "throttle503" });
    await h.minutes(8);
    expect(h.store.timelineOf(h.scope, s.subject)).toMatchObject([{ status: "posted", attempts: 0 }]);
    expect(h.fake.commentsOn(h.dealOf(s).id)).toHaveLength(1);
  });

  it("comments never hold up deal pushes: rows go first, and comments use only what the rows left", async () => {
    const h = harness({ maxPerRun: 4 });
    const s = paid(subjectId());
    h.put(s);
    await h.run();
    h.clock.advance(TIMELINE_QUIET_MS + 1_000);
    // A backlog of deal pushes takes the whole run.
    for (let i = 0; i < 3; i++) h.put(inquiryState(subjectId(), { reference: `INQ-20000${i}1` }));
    const r = await h.run();
    expect(r.comments).toBe(0);
    expect(h.fake.callsOf("crm.timeline.comment.add")).toHaveLength(0);
    await h.minutes(4);
    expect(h.store.rows.every((row) => row.status === "done")).toBe(true);
    expect(h.fake.commentsOn(h.dealOf(s).id)).toHaveLength(1);
  });

  it("no comment in a run that met an outage; the moment waits and posts once the portal answers", async () => {
    const h = harness();
    const s = paid(subjectId());
    h.put(s);
    await h.run();
    h.clock.advance(TIMELINE_QUIET_MS + 1_000);
    h.put(inquiryState(subjectId()));
    h.fake.script.push("server_error");
    const r = await h.run();
    expect(r).toMatchObject({ failed: 1, comments: 0 });
    expect(h.fake.callsOf("crm.timeline.comment.add")).toHaveLength(0);
    await h.minutes(3);
    expect(h.fake.commentsOn(h.dealOf(s).id)).toHaveLength(1);
  });

  it("a failed moment record is a warning only: the deal push stands", async () => {
    const h = harness();
    const s = paid(subjectId());
    h.store.failTimelineRecord = true;
    h.put(s);
    const r = await h.run();
    expect(r).toMatchObject({ pushed: 1, failed: 0 });
    expect(h.store.rows[0].outcome).toBe("pushed");
    expect(h.events.find((e) => e.name === "crm.timeline_failed")).toMatchObject({ fields: { reason: "record_failed" }, level: "warn" });
  });

  it("an erased or deleted deal drops its pending moments; a deal gone on the portal drops the comment", async () => {
    const h = harness();
    const s = paid(subjectId());
    h.put(s);
    await h.run();
    h.store.enqueue(h.scope, s.subject, "delete", "erasure");
    h.clock.advance(1_000);
    await h.run();
    await h.minutes(5);
    expect(h.store.timelineOf(h.scope, s.subject)).toMatchObject([{ status: "dropped", lastErrorCode: "link_deleted" }]);
    expect(h.fake.callsOf("crm.timeline.comment.add")).toHaveLength(0);

    const t = paid(subjectId());
    h.put({ ...t, order: { ...t.order!, reference: "OUT-4829137" } });
    await h.run();
    h.fake.deals.clear(); // deleted on the portal; OUTLYY has not noticed yet
    await h.minutes(5);
    expect(h.store.timelineOf(h.scope, t.subject)).toMatchObject([{ status: "dropped" }]);
  });

  it("handed to the team: a staff flag on a paid order is one comment line (C2B-03)", async () => {
    const h = harness();
    const id = subjectId();
    h.put(paid(id));
    await h.minutes(5);
    const p = paid(id);
    h.put({ ...p, order: { ...p.order!, handedToTeam: true } });
    await h.minutes(5);
    const texts = h.fake.commentsOn(h.dealOf(p).id).map((c) => c.text.split("\n").slice(1));
    expect(texts[1]).toEqual(["22 Nov 2026 12:05 - Handed to the team: a supplier could not confirm part of the order"]);
  });
});

describe("timeline comments meet a failing portal like a row does (C2B-01, C2B-02)", () => {
  const twoDueDeals = async (h: ReturnType<typeof harness>) => {
    const [a, b] = [subjectId(), subjectId()];
    h.put(paid(a));
    const pb = paid(b);
    h.put({ ...pb, order: { ...pb.order!, reference: "OUT-4829138" } });
    await h.run();
    h.clock.advance(TIMELINE_QUIET_MS + 1_000);
    return [a, b];
  };

  it("a half-open breaker is never probed by a comment; 1-4 carried failures are proven by a read first", async () => {
    const h = harness();
    await twoDueDeals(h);
    await h.store.setPortalHealth(h.scope, { consecutiveFailures: 5 });
    expect((await h.run()).comments).toBe(0);
    expect(h.fake.callsOf("crm.timeline.comment.add")).toHaveLength(0);
    // Two failures carried, the portal still down: the read fails, no comment is tried, the failure counts.
    await h.store.setPortalHealth(h.scope, { consecutiveFailures: 2 });
    h.fake.down = true;
    expect((await h.run()).comments).toBe(0);
    expect(h.fake.calls.filter((c) => c.method === "crm.timeline.comment.add")).toHaveLength(0);
    expect([...h.store.portals.values()][0].consecutiveFailures).toBe(3);
    expect(h.store.timeline.every((t) => t.status === "pending" && t.attempts === 0)).toBe(true);
    // Back up: the read succeeds, the count resets, both comments go.
    h.fake.down = false;
    expect((await h.run()).comments).toBe(2);
    expect([...h.store.portals.values()][0].consecutiveFailures).toBe(0);
  });

  it("an outage met by a comment: that group is unknown (at most once), the rest wait without an attempt, and the failure counts", async () => {
    const h = harness();
    const [a, b] = await twoDueDeals(h);
    h.fake.methodScript.push({ method: "crm.timeline.comment.add", failure: "server_error" });
    const r = await h.run();
    expect(r.comments).toBe(0);
    expect(h.fake.callsOf("crm.timeline.comment.add")).toHaveLength(1);
    const states = [a, b].map((id) => h.store.timelineOf(h.scope, { type: "order", id })[0]);
    expect(states.map((t) => [t.status, t.attempts]).sort()).toEqual([
      ["pending", 0],
      ["unknown", 0],
    ]);
    expect([...h.store.portals.values()][0].consecutiveFailures).toBe(1);
    expect(h.events.some((e) => e.name === "crm.timeline_failed" && e.fields.settled === "unknown")).toBe(true);
    // Next run: a read proves the portal, the waiting group posts; the unknown one never does.
    h.clock.advance(MIN);
    await h.run();
    expect(h.fake.callsOf("crm.timeline.comment.add")).toHaveLength(2);
    expect([a, b].map((id) => h.store.timelineOf(h.scope, { type: "order", id })[0].status).sort()).toEqual(["posted", "unknown"]);
  });

  it("a throttled comment pauses the portal like a row's throttle", async () => {
    const h = harness();
    await twoDueDeals(h);
    h.fake.methodScript.push({ method: "crm.timeline.comment.add", failure: "throttle503" });
    const r = await h.run();
    expect(r).toMatchObject({ throttled: true, comments: 0 });
    const portal = [...h.store.portals.values()][0];
    expect(portal).toMatchObject({ pauseReason: "throttled" });
    expect(portal.pausedUntil!.getTime()).toBeGreaterThan(h.clock.t);
    expect(h.fake.callsOf("crm.timeline.comment.add")).toHaveLength(1);
    expect(h.store.timeline.every((t) => t.status === "pending" && t.attempts === 0)).toBe(true);
  });

  it("a refused credential met by a comment opens the auth circuit (the crm_auth_refused alert reads it) and burns no attempt", async () => {
    const h = harness();
    await twoDueDeals(h);
    h.fake.revoked = true;
    const r = await h.run();
    expect(r).toMatchObject({ breakerOpen: true, comments: 0 });
    expect([...h.store.portals.values()][0]).toMatchObject({ pauseReason: "auth" });
    expect(h.events.find((e) => e.name === "crm.circuit_open")?.fields).toMatchObject({ reason: "auth" });
    expect(h.store.timeline.every((t) => t.status === "pending" && t.attempts === 0)).toBe(true);
  });

  it("an access refusal on one deal while the portal answered rows counts attempts, so it ends", async () => {
    const h = harness();
    const s = paid(subjectId());
    h.put(s);
    await h.run();
    for (let i = 0; i < TIMELINE_MAX_ATTEMPTS; i++) {
      h.clock.advance(2 * 3_600_000);
      h.put(inquiryState(subjectId(), { reference: `INQ-3000${i}01` })); // a row the portal answers
      h.fake.methodScript.push({ method: "crm.timeline.comment.add", failure: "access_denied" });
      await h.run();
      // The circuit opens each time (the refusal could be the portal's), so wait it out before the next try.
      await h.store.setPortalHealth(h.scope, { pausedUntil: null, pauseReason: null });
    }
    expect(h.store.timelineOf(h.scope, s.subject)[0]).toMatchObject({ status: "failed", attempts: TIMELINE_MAX_ATTEMPTS, lastErrorCode: "auth:ACCESS_DENIED" });
  });
});

describe("timeline settle details (C2B-04, C2B-07, C2B-08)", () => {
  it("more than ten moments: ten in the first comment, the rest in the next; none marked posted unseen", async () => {
    const h = harness();
    const id = subjectId();
    h.put(paid(id));
    await h.run();
    for (let i = 1; i <= 11; i++) {
      h.clock.advance(1_000);
      h.put(order(id, { status: "paid", authorised: true, capturedMinor: 25_000n, refundedMinor: BigInt(i * 100) }));
      await h.run();
    }
    await h.minutes(10);
    const texts = h.fake.commentsOn(h.dealOf(paid(id)).id).map((c) => c.text.split("\n").length - 1);
    expect(texts).toEqual([10, 2]);
    expect(h.store.timelineOf(h.scope, { type: "order", id }).every((t) => t.status === "posted")).toBe(true);
    expect(h.fake.commentsOn(h.dealOf(paid(id)).id)[1].text).toContain("AED 11.00 refunded in total");
  });

  it("a failed record is made good by the next unchanged re-push, without a CRM write", async () => {
    const h = harness();
    const s = paid(subjectId());
    h.store.failTimelineRecord = true;
    h.put(s);
    await h.run();
    h.store.failTimelineRecord = false;
    h.put(s); // nothing changed for the deal
    h.clock.advance(1_000);
    await h.run();
    expect(h.store.rows[1].outcome).toBe("unchanged");
    expect(h.fake.callsOf("crm.item.update")).toHaveLength(0);
    await h.minutes(5);
    expect(h.fake.commentsOn(h.dealOf(s).id)).toHaveLength(1);
  });

  it("a comment dropped because the deal is gone leaves an event", async () => {
    const h = harness();
    const s = paid(subjectId());
    h.put(s);
    await h.run();
    h.fake.deals.clear();
    await h.minutes(5);
    expect(h.events.find((e) => e.name === "crm.timeline_failed" && e.fields.settled === "dropped")).toBeTruthy();
  });
});
