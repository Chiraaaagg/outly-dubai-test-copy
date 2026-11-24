import { describe, expect, it } from "vitest";
import { BitrixRestClient } from "@/server/crm/bitrix.client";
import type { CrmScope } from "@/server/crm/crm.config";
import { originIdFor, type CrmSubject, type CrmSubjectState } from "@/server/crm/crm.mapping";
import { assertDeleteTarget, BREAKER_THRESHOLD, CREATE_SETTLE_MS, pacedLimiter, runCrmWorker, SWITCH_ON_SLACK_MS } from "@/server/crm/crm.worker";
import { CRM_DEFERRED_VERSION } from "@/server/crm/crm.outbox";
import { FakeBitrix24 } from "./_bitrix-fake";
import { FAKE_HOST, FAKE_OWNER, FAKE_SECRET, FAKE_SITE, FAKE_USER, FakeClock, MemoryCrmStore, StateBook, TEST_CONTACT, directOrderState, fakeConfig, fieldCode, inquiryState, subjectId } from "./_memory-store";

/**
 * The CRM outbox worker against the fake Bitrix24 portal and the in-memory
 * store (doc 29 §7.4 "CRM failure tests", the ones C1 can run without a
 * portal or a return path): outage for hours then catch-up in order,
 * rate-limit storms, duplicate and out-of-order rows, a lost create answer,
 * a twin already present, erasure, a revoked credential, a CRM-side delete,
 * the wrong portal or environment, the payload guard and dead letters.
 * Synthetic data only; the clock is fake and nothing leaves the process.
 */

function harness(opts: { fakeHost?: string } = {}) {
  const clock = new FakeClock();
  const config = fakeConfig();
  const scope: CrmScope = { environment: config.environment, portal: config.portal };
  const store = new MemoryCrmStore(clock);
  const fake = new FakeBitrix24({ host: opts.fakeHost ?? FAKE_HOST, userId: FAKE_USER, secret: FAKE_SECRET, now: clock.ms });
  const book = new StateBook();
  const events: { name: string; fields: Record<string, unknown> }[] = [];
  const port = new BitrixRestClient(config, { fetchImpl: fake.fetch, now: clock.ms });
  let runs = 0;
  const run = (budgetMs?: number) =>
    runCrmWorker(
      {
        config,
        store,
        port,
        loadState: book.load,
        limiter: pacedLimiter({ minIntervalMs: 1_000, maxPerRun: 12, now: clock.ms, sleep: clock.sleep }),
        now: clock.now,
        random: () => 0.5,
        holder: `worker-${++runs}`,
        emit: (name, fields) => events.push({ name, fields }),
      },
      budgetMs === undefined ? {} : { budgetMs },
    );
  const open = () => store.rows.filter((r) => r.status === "queued" || r.status === "running");
  /** Run once a minute until the queue is empty (or `maxRuns`). */
  const drain = async (maxRuns = 30, everyMs = 60_000) => {
    for (let i = 0; i < maxRuns && open().length; i++) {
      await run();
      if (open().length) clock.advance(everyMs);
    }
  };
  const put = (state: CrmSubjectState) => {
    book.set(state);
    return store.enqueue(scope, state.subject);
  };
  return { clock, config, scope, store, fake, book, events, run, drain, open, put };
}

const inquiry = (): CrmSubject => ({ type: "inquiry", id: subjectId() });

describe("CRM worker: deal push on the fake portal", () => {
  it("creates one deal in the OUTLYY funnel with no Contact record; customer details only in their own deal fields", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id));
    const r = await h.run();
    expect(r).toMatchObject({ outcome: "ran", pushed: 1, failed: 0, dead: 0 });
    const deals = h.fake.dealsFor(originIdFor(s));
    expect(deals).toHaveLength(1);
    expect(deals[0]).toMatchObject({ categoryId: 7, stageId: "C7:NEW_INQUIRY", originatorId: "outlyy-staging", title: "OUTLYY INQ-1048213", opportunity: 0, isManualOpportunity: "Y" });
    // Inquiry rows never show an indicative amount as revenue.
    expect(deals[0].productRows).toEqual([{ productName: "Desert safari (2026-12-01)", price: 0, quantity: 1 }]);
    // Only the deal methods were called; a search before the create.
    expect(h.fake.calls.map((c) => c.method)).toEqual(["crm.item.list", "crm.item.add", "crm.item.productrow.set"]);
    expect(h.fake.refusedMethods).toEqual([]);
    expect(h.store.link(h.scope, s)).toMatchObject({ state: "active", pushedVersion: 1n });
    // C2a: the OUTLYY fields, the default owner on create, and the customer's details on the deal only.
    expect(deals[0]).toMatchObject({
      assignedById: Number(FAKE_OWNER),
      [fieldCode("reference")]: "INQ-1048213",
      [fieldCode("environment")]: "staging",
      [fieldCode("admin_link")]: `${FAKE_SITE}/admin/inquiries/${s.id}`,
      [fieldCode("customer_name")]: TEST_CONTACT.name,
      [fieldCode("customer_phone")]: TEST_CONTACT.phone,
      [fieldCode("customer_email")]: TEST_CONTACT.email,
      [fieldCode("as_of")]: expect.stringMatching(/^2026-11-22T08:00:0\d\+00:00$/),
    });
    const elsewhere = JSON.stringify({ title: deals[0].title, rows: deals[0].productRows });
    expect(elsewhere).not.toContain(TEST_CONTACT.name);
    expect(elsewhere).not.toContain(TEST_CONTACT.phone);
  });

  it("the default owner is set on create only: a reassignment on the portal is kept by later pushes", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id));
    await h.run();
    const deal = h.fake.dealsFor(originIdFor(s))[0];
    expect(deal.assignedById).toBe(Number(FAKE_OWNER));
    deal.assignedById = 31; // the sales lead hands it on
    h.put(inquiryState(s.id, { status: "contacted" }));
    h.clock.advance(1_000);
    await h.run();
    expect(h.fake.dealsFor(originIdFor(s))[0]).toMatchObject({ assignedById: 31, stageId: "C7:CONTACTED" });
  });

  it("paces calls at one a second per portal and never trips the portal's own limit", async () => {
    const h = harness();
    for (let i = 0; i < 3; i++) h.put(inquiryState(subjectId(), { reference: `INQ-10482${i}3` }));
    await h.run();
    const at = h.fake.calls.map((c) => c.at);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(1_000);
    expect(h.fake.bucketRefusals).toBe(0);
  });

  it("stops starting rows after the run budget; the rest wait for the next run", async () => {
    const h = harness();
    for (let i = 0; i < 20; i++) h.put(inquiryState(subjectId()));
    const first = await h.run();
    expect(first.processed).toBeLessThan(20);
    expect(h.fake.calls.length).toBeLessThanOrEqual(12);
    await h.drain();
    expect(h.open()).toHaveLength(0);
    expect(h.fake.deals.size).toBe(20);
  });

  it("an outage of hours dead-letters nothing and catches up in order, with the latest state", async () => {
    const h = harness();
    const [a, b, c] = [inquiry(), inquiry(), inquiry()];
    h.fake.down = true;
    h.put(inquiryState(a.id, { reference: "INQ-1000017" }));
    h.put(inquiryState(b.id, { reference: "INQ-1000025" }));
    h.put(inquiryState(a.id, { reference: "INQ-1000017", status: "contacted" }));
    h.put(inquiryState(c.id, { reference: "INQ-1000033" }));
    // Six hours down, the worker called every minute.
    for (let i = 0; i < 360; i++) {
      await h.run();
      h.clock.advance(60_000);
    }
    expect(h.store.rows.filter((r) => r.status === "dead")).toHaveLength(0);
    expect(h.events.some((e) => e.name === "crm.circuit_open")).toBe(true);
    // While the breaker is open most runs make no call at all.
    expect(h.fake.calls.length).toBeLessThan(40);
    h.fake.down = false;
    await h.drain(120);
    expect(h.open()).toHaveLength(0);
    const adds = h.fake.callsOf("crm.item.add").filter((x) => x.outcome === "ok");
    expect(adds).toHaveLength(3);
    const created = [...h.fake.deals.values()].sort((x, y) => x.id - y.id).map((d) => d.originId);
    expect(created).toEqual([originIdFor(a), originIdFor(b), originIdFor(c)]);
    expect(h.fake.dealsFor(originIdFor(a))[0].stageId).toBe("C7:CONTACTED");
    expect(h.store.rows.filter((r) => r.outcome === "stale")).toHaveLength(1);
  });

  it("a rate-limit storm stops each run at the first refusal, burns no attempt and never exceeds the budget", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id));
    h.fake.script = Array.from({ length: 6 }, (_, i) => (i % 2 ? "throttle429" : "throttle503"));
    const first = await h.run();
    expect(first).toMatchObject({ throttled: true, pushed: 0 });
    expect(h.fake.calls).toHaveLength(1);
    // Paused: the next run makes no call.
    expect((await h.run()).outcome).toBe("paused");
    expect(h.fake.calls).toHaveLength(1);
    let runs = 1;
    while (h.open().length && runs < 40) {
      h.clock.advance(60_000);
      await h.run();
      runs++;
    }
    expect(h.open()).toHaveLength(0);
    expect(h.fake.dealsFor(originIdFor(s))).toHaveLength(1);
    const row = h.store.rows[0];
    expect(row).toMatchObject({ status: "done", attempts: 0 });
    // One refused call per run during the storm, never a burst.
    expect(h.fake.calls.filter((c) => c.outcome === "throttle503" || c.outcome === "throttle429")).toHaveLength(6);
    expect(h.fake.bucketRefusals).toBe(0);
  });

  it("duplicate rows for one change make one write; an unchanged re-push makes none", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id));
    h.put(inquiryState(s.id));
    await h.run();
    expect(h.fake.callsOf("crm.item.add")).toHaveLength(1);
    expect(h.store.rows.map((r) => r.outcome)).toEqual(["pushed", "stale"]);
    const calls = h.fake.calls.length;
    h.put(inquiryState(s.id));
    await h.run();
    expect(h.fake.calls.length).toBe(calls);
    expect(h.store.rows[2].outcome).toBe("unchanged");
  });

  it("orders by version: a row at or below the pushed version is a no-op, and the push carries the latest state", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id, { status: "new" }));
    h.put(inquiryState(s.id, { status: "quoted" }));
    await h.run();
    expect(h.fake.dealsFor(originIdFor(s))[0].stageId).toBe("C7:QUOTED");
    expect(h.fake.callsOf("crm.item.update")).toHaveLength(0);
    // A late copy of version 1 (e.g. released after a crash) changes nothing.
    const late = h.store.rows[0];
    Object.assign(late, { status: "queued", outcome: null });
    await h.run();
    expect(late.outcome).toBe("stale");
    expect(h.fake.dealsFor(originIdFor(s))[0].stageId).toBe("C7:QUOTED");
  });

  it("a deferred row (the link lock was busy at enqueue) is never stale: it re-reads and pushes the latest state (review R12)", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id, { status: "new" }));
    await h.run();
    // The change whose enqueue could not wait for the link lock: committed state, no versioned row.
    h.book.set(inquiryState(s.id, { status: "quoted" }));
    const first = h.store.rows[0];
    h.store.rows.push({ ...first, id: subjectId(), status: "queued", outcome: null, version: CRM_DEFERRED_VERSION, dedupeKey: `deferred-${first.id}`, seq: first.seq + 100 });
    await h.run();
    expect(h.store.rows.at(-1)?.outcome).toBe("pushed");
    expect(h.fake.dealsFor(originIdFor(s))[0].stageId).toBe("C7:QUOTED");
    // The push records the link's own version, not the deferred row's: later versioned rows still count.
    expect(h.store.links[0].pushedVersion).toBe(1n);
  });

  it("a lost create answer is adopted by originId on the next attempt: no twin", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id));
    // The search answers; the add then runs at the portal and its answer is lost (a timeout).
    const first = await (async () => {
      const real = h.fake.fetch;
      let calls = 0;
      const port = new BitrixRestClient(h.config, {
        fetchImpl: async (url, init) => {
          calls += 1;
          if (calls === 2) h.fake.script = ["lose_answer"];
          return real(url, init);
        },
        now: h.clock.ms,
      });
      return runCrmWorker({
        config: h.config,
        store: h.store,
        port,
        loadState: h.book.load,
        limiter: pacedLimiter({ minIntervalMs: 1_000, maxPerRun: 12, now: h.clock.ms, sleep: h.clock.sleep }),
        now: h.clock.now,
        random: () => 0.5,
        holder: "lost-answer",
      });
    })();
    expect(first).toMatchObject({ pushed: 0, failed: 1 });
    expect(h.fake.dealsFor(originIdFor(s))).toHaveLength(1);
    expect(h.store.link(h.scope, s)).toMatchObject({ state: "creating", crmId: null });
    expect(h.store.rows[0]).toMatchObject({ attempts: 1, lastErrorCode: "unavailable:timeout" });
    await h.drain();
    expect(h.fake.dealsFor(originIdFor(s))).toHaveLength(1);
    expect(h.fake.callsOf("crm.item.add")).toHaveLength(1);
    expect(h.store.link(h.scope, s)).toMatchObject({ state: "active", pushedVersion: 1n });
  });

  it("a create that never landed, then the subject turned spam: no deal is ever created (C2A-09)", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id));
    // The search answers; the add fails at the network, so the link stays `creating` with nothing on the portal.
    h.fake.script = [];
    const real = h.fake.fetch;
    let calls = 0;
    const port = new BitrixRestClient(h.config, {
      fetchImpl: async (url, init) => {
        calls += 1;
        if (calls === 2) h.fake.script = ["network"];
        return real(url, init);
      },
      now: h.clock.ms,
    });
    const deps = {
      config: h.config,
      store: h.store,
      port,
      loadState: h.book.load,
      limiter: pacedLimiter({ minIntervalMs: 1_000, maxPerRun: 12, now: h.clock.ms, sleep: h.clock.sleep }),
      now: h.clock.now,
      random: () => 0.5,
    };
    await runCrmWorker({ ...deps, holder: "w1" });
    expect(h.store.link(h.scope, s)).toMatchObject({ state: "creating", crmId: null });
    h.put(inquiryState(s.id, { status: "spam" }));
    h.clock.advance(2 * CREATE_SETTLE_MS);
    for (let i = 0; i < 5; i++) {
      await runCrmWorker({ ...deps, holder: `w${i + 2}` });
      h.clock.advance(5 * 60_000);
    }
    expect(h.fake.dealsFor(originIdFor(s))).toHaveLength(0);
    expect(h.fake.callsOf("crm.item.add").filter((c) => c.outcome === "ok")).toHaveLength(0);
    expect(h.store.link(h.scope, s)).toMatchObject({ state: "pending", crmId: null, creatingSince: null });
    expect(h.store.rows.some((r) => r.outcome === "not_created")).toBe(true);
  });

  it("a create that may not have reached the portal waits the settle delay before creating", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id));
    const real = h.fake.fetch;
    let calls = 0;
    const port = new BitrixRestClient(h.config, {
      fetchImpl: async (url, init) => {
        calls += 1;
        if (calls === 2) throw new TypeError("fetch failed");
        return real(url, init);
      },
      now: h.clock.ms,
    });
    const deps = { config: h.config, store: h.store, port, loadState: h.book.load, now: h.clock.now, random: () => 0.5 };
    const limiter = () => pacedLimiter({ minIntervalMs: 1_000, maxPerRun: 12, now: h.clock.ms, sleep: h.clock.sleep });
    await runCrmWorker({ ...deps, limiter: limiter(), holder: "w1" });
    expect(h.store.link(h.scope, s)?.state).toBe("creating");
    // Retried after the backoff (15-30 s), inside the settle delay: search, find nothing, wait.
    h.clock.advance(30_000);
    await runCrmWorker({ ...deps, limiter: limiter(), holder: "w2" });
    expect(h.store.rows[0].lastErrorCode).toBe("create_settle");
    expect(h.fake.deals.size).toBe(0);
    h.clock.advance(CREATE_SETTLE_MS);
    await runCrmWorker({ ...deps, limiter: limiter(), holder: "w3" });
    expect(h.fake.dealsFor(originIdFor(s))).toHaveLength(1);
    expect(h.store.rows[0]).toMatchObject({ status: "done", outcome: "pushed" });
  });

  it("a twin already present: the oldest is adopted, the link flagged, nothing deleted or created", async () => {
    const h = harness();
    const s = inquiry();
    const older = h.fake.seedDeal({ originId: originIdFor(s) });
    h.fake.seedDeal({ originId: originIdFor(s) });
    h.put(inquiryState(s.id));
    await h.run();
    expect(h.fake.dealsFor(originIdFor(s))).toHaveLength(2);
    expect(h.fake.callsOf("crm.item.add")).toHaveLength(0);
    expect(h.fake.callsOf("crm.item.delete")).toHaveLength(0);
    expect(h.store.link(h.scope, s)).toMatchObject({ crmId: BigInt(older.id), state: "active" });
    expect(h.store.link(h.scope, s)?.twinFlaggedAt).toBeInstanceOf(Date);
    expect(h.events.find((e) => e.name === "crm.twin_detected")?.fields).toMatchObject({ count: 2 });
    expect(h.fake.deals.get(older.id)?.stageId).toBe("C7:NEW_INQUIRY");
  });

  it("erasure deletes every copy, tombstones the link, and a later change never re-creates the deal", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id));
    await h.run();
    h.fake.seedDeal({ originId: originIdFor(s) }); // a twin made by hand
    expect(h.store.enqueue(h.scope, s, "delete", "erasure")).not.toBeNull();
    h.clock.advance(1_000);
    await h.run();
    expect(h.fake.dealsFor(originIdFor(s))).toHaveLength(0);
    expect(h.store.link(h.scope, s)).toMatchObject({ state: "deleted", deleteReason: "erasure" });
    // The tombstone takes no new row, and a forced one is a no-op.
    expect(h.store.enqueue(h.scope, s)).toBeNull();
    expect(h.store.enqueue(h.scope, s, "delete", "erasure")).toBeNull();
    expect(h.fake.callsOf("crm.item.add")).toHaveLength(1);
  });

  it("an erased subject seen on a sync deletes its copy instead of pushing", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id));
    await h.run();
    h.put({ ...inquiryState(s.id), erased: true });
    h.clock.advance(1_000);
    await h.run();
    expect(h.fake.dealsFor(originIdFor(s))).toHaveLength(0);
    expect(h.store.link(h.scope, s)?.state).toBe("deleted");
  });

  it("a delete never touches a deal OUTLYY did not create: a hand-made deal and another environment's deal survive", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id));
    await h.run();
    const manual = h.fake.seedDeal({ originId: null, originatorId: null, title: "made by hand" });
    // Review C2A-14 (b): deals that share the subject's originId but are not OUTLYY's in this environment and funnel.
    const prod = h.fake.seedDeal({ originId: originIdFor(s), originatorId: "outlyy-production" });
    const untagged = h.fake.seedDeal({ originId: originIdFor(s), originatorId: null, title: "copied by hand" });
    const otherFunnel = h.fake.seedDeal({ originId: originIdFor(s), originatorId: "outlyy-staging", categoryId: 0, stageId: "C0:NEW" });
    const ours = h.fake.dealsFor(originIdFor(s)).find((d) => d.categoryId === 7 && d.originatorId === "outlyy-staging")!;
    h.store.enqueue(h.scope, s, "delete", "erasure");
    h.clock.advance(1_000);
    await h.run();
    expect(h.fake.deals.has(ours.id)).toBe(false);
    expect(h.fake.dealsFor(originIdFor(s)).map((d) => d.id).sort((a, b) => a - b)).toEqual([prod.id, untagged.id, otherFunnel.id].sort((a, b) => a - b));
    expect(h.fake.deals.has(manual.id)).toBe(true);
    expect(h.fake.callsOf("crm.item.delete")).toHaveLength(1);
  });

  it("erasure deletes the linked deal even after staff cleared its originId, but only while it is in the OUTLYY funnel", async () => {
    const h = harness();
    const [a, b] = [inquiry(), inquiry()];
    h.put(inquiryState(a.id));
    h.put(inquiryState(b.id));
    await h.run();
    const da = h.fake.dealsFor(originIdFor(a))[0];
    const db = h.fake.dealsFor(originIdFor(b))[0];
    da.originId = null;
    db.originId = null;
    db.categoryId = 9; // moved out of the OUTLYY funnel: not the service account's to delete
    h.store.enqueue(h.scope, a, "delete", "erasure");
    h.store.enqueue(h.scope, b, "delete", "erasure");
    h.clock.advance(1_000);
    await h.run();
    expect(h.fake.deals.has(da.id)).toBe(false);
    expect(h.fake.deals.has(db.id)).toBe(true);
    expect(h.store.link(h.scope, a)).toMatchObject({ state: "deleted", deleteReason: "erasure" });
    // C2A-08: the deal still holds personal data somewhere the sync cannot see: tombstoned, dead-lettered, error event.
    expect(h.store.rows.filter((r) => r.kind === "delete").map((r) => [r.outcome, r.lastErrorCode])).toEqual([
      ["deleted", null],
      ["dead", "refused:linked_deal_not_visible"],
    ]);
    expect(h.store.link(h.scope, b)).toMatchObject({ state: "deleted", deleteReason: "erasure" });
    expect(h.events.find((e) => e.name === "crm.erasure_unverified")?.fields).toEqual({ entityType: "inquiry", entityId: b.id, reason: "erasure" });
    expect(h.events.some((e) => e.name === "crm.dead_letter" && e.fields.reason === "refused:linked_deal_not_visible")).toBe(true);
  });

  it("the delete guard: only a deal in the OUTLYY funnel that is this link's record or carries its originator and originId", () => {
    const cfg = fakeConfig();
    const link = { crmId: 101n, originatorId: "outlyy-staging", originId: "inq:00000000-0000-7000-8000-000000000001" };
    const deal = { id: 101, originatorId: "outlyy-staging", originId: link.originId, categoryId: 7, updatedBy: 17 };
    expect(() => assertDeleteTarget(deal, link, cfg)).not.toThrow();
    expect(() => assertDeleteTarget({ ...deal, originId: null, originatorId: null }, link, cfg)).not.toThrow();
    expect(() => assertDeleteTarget({ ...deal, id: 102 }, link, cfg)).not.toThrow();
    const refused = expect.objectContaining({ kind: "refused", code: "refused:delete_target" });
    expect(() => assertDeleteTarget({ ...deal, categoryId: 0 }, link, cfg)).toThrow(refused);
    expect(() => assertDeleteTarget({ ...deal, id: 102, originId: null }, link, cfg)).toThrow(refused);
    expect(() => assertDeleteTarget({ ...deal, id: 102, originatorId: "outlyy-production" }, link, cfg)).toThrow(refused);
    expect(() => assertDeleteTarget(deal, { ...link, originatorId: "outlyy-production" }, cfg)).toThrow(refused);
  });

  it("sync off: a subject never linked takes no row and nothing reaches the portal (no backfill)", async () => {
    const h = harness();
    const s = inquiry();
    h.book.set(inquiryState(s.id));
    expect(h.store.enqueue(h.scope, s, "sync", null, false)).toBeNull();
    expect(h.store.link(h.scope, s)).toBeUndefined();
    await h.run();
    expect(h.fake.calls).toHaveLength(0);
    // A subject pushed while the sync was on keeps queueing its changes.
    h.put(inquiryState(s.id));
    await h.run();
    expect(h.store.enqueue(h.scope, s, "sync", null, false)).not.toBeNull();
  });

  it("no backfill: a subject created before switch-on (the first worker run) never gets a new deal", async () => {
    const h = harness();
    await h.run(); // switch-on: the first run records the portal
    h.clock.advance(3 * 86_400_000);
    const switchOn = h.clock.t - 3 * 86_400_000;
    const [old, edge, fresh] = [inquiry(), inquiry(), inquiry()];
    h.put({ ...inquiryState(old.id), createdAt: new Date(switchOn - 86_400_000) });
    h.put({ ...inquiryState(edge.id), createdAt: new Date(switchOn - SWITCH_ON_SLACK_MS / 2) });
    h.put({ ...inquiryState(fresh.id), createdAt: new Date(switchOn + 60_000) });
    await h.run();
    expect(h.fake.dealsFor(originIdFor(old))).toHaveLength(0);
    expect(h.fake.dealsFor(originIdFor(edge))).toHaveLength(1);
    expect(h.fake.dealsFor(originIdFor(fresh))).toHaveLength(1);
    expect(h.store.rows.find((r) => r.entityId === old.id)?.outcome).toBe("before_switch_on");
  });

  it("switch-on is the first link when the first worker run comes late: no subject of that window is lost (R-03)", async () => {
    const h = harness();
    const s = inquiry();
    // Switched on at T0: the first inquiry is linked at once, but the cron does not run for half an hour.
    h.put({ ...inquiryState(s.id), createdAt: new Date(h.clock.t + 60_000) });
    h.clock.advance(30 * 60_000);
    await h.run();
    expect(h.fake.dealsFor(originIdFor(s))).toHaveLength(1);
    expect(h.store.rows[0].outcome).toBe("pushed");
  });

  it("a delete for a subject never pushed writes no row and calls nothing", async () => {
    const h = harness();
    expect(h.store.enqueue(h.scope, inquiry(), "delete", "erasure")).toBeNull();
    await h.run();
    expect(h.fake.calls).toHaveLength(0);
  });

  it("a revoked credential opens the circuit for an hour and burns no attempt", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id));
    h.fake.revoked = true;
    const r = await h.run();
    expect(r).toMatchObject({ breakerOpen: true, pushed: 0 });
    expect(h.store.rows[0]).toMatchObject({ status: "queued", attempts: 0, lastErrorCode: "auth:INVALID_CREDENTIALS" });
    expect(h.events.find((e) => e.name === "crm.circuit_open")?.fields).toMatchObject({ reason: "auth" });
    h.clock.advance(30 * 60_000);
    expect((await h.run()).outcome).toBe("paused");
    h.fake.revoked = false;
    h.clock.advance(31 * 60_000);
    await h.run();
    expect(h.fake.dealsFor(originIdFor(s))).toHaveLength(1);
  });

  it("a deal deleted in the CRM is not re-created", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id));
    await h.run();
    h.fake.deals.clear();
    h.put(inquiryState(s.id, { status: "contacted" }));
    h.clock.advance(1_000);
    await h.run();
    expect(h.fake.deals.size).toBe(0);
    expect(h.store.link(h.scope, s)).toMatchObject({ state: "deleted", deleteReason: "crm_deleted" });
    expect(h.store.rows[1].outcome).toBe("crm_deleted");
  });

  it("refuses rows of another portal or environment: they are counted, never claimed", async () => {
    const h = harness();
    const other: CrmScope = { environment: h.scope.environment, portal: "other-portal.bitrix24.test" };
    const prod: CrmScope = { environment: "production", portal: h.scope.portal };
    const s = inquiry();
    h.book.set(inquiryState(s.id));
    h.store.enqueue(other, s);
    h.store.enqueue(prod, s);
    const r = await h.run();
    expect(r).toMatchObject({ processed: 0, foreignDue: 2 });
    expect(h.fake.calls).toHaveLength(0);
    expect(h.store.rows.every((x) => x.status === "queued")).toBe(true);
  });

  it("refuses to run when the stored portal identity differs from the configuration", async () => {
    const h = harness();
    h.put(inquiryState(subjectId()));
    await h.store.ensurePortal(h.scope, { categoryId: 9, originatorId: h.config.originatorId });
    const r = await h.run();
    expect(r).toMatchObject({ outcome: "refused", reason: "portal_identity_mismatch", processed: 0 });
    expect(h.fake.calls).toHaveLength(0);
  });

  it("a pinned host that does not answer fails the attempt; no other portal is ever reached", async () => {
    const h = harness({ fakeHost: "somewhere-else.bitrix24.test" });
    h.put(inquiryState(subjectId()));
    const r = await h.run();
    expect(r.failed).toBe(1);
    expect(h.fake.calls).toHaveLength(0);
  });

  it("dead-letters a row after eight refused attempts, with an error event and a short code", async () => {
    const h = harness();
    h.put(inquiryState(subjectId()));
    h.fake.script = Array.from({ length: 8 }, () => "reject" as const);
    await h.drain(200, 60 * 60_000);
    expect(h.store.rows[0]).toMatchObject({ status: "dead", attempts: 8, lastErrorCode: "rejected:INVALID_ARG_VALUE" });
    expect(h.events.filter((e) => e.name === "crm.dead_letter")).toHaveLength(1);
    expect(h.fake.callsOf("crm.item.add")).toHaveLength(0);
  });

  it("five consecutive unavailable answers open the breaker", async () => {
    const h = harness();
    for (let i = 0; i < 6; i++) h.put(inquiryState(subjectId()));
    h.fake.script = Array.from({ length: 6 }, () => "server_error" as const);
    const r = await h.run();
    expect(r.breakerOpen).toBe(true);
    expect(r.failed).toBe(BREAKER_THRESHOLD);
    expect((await h.run()).outcome).toBe("paused");
  });

  it("the payload guard refuses personal data before any call and dead-letters at once", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id, { items: [{ title: `Call ${["guest.one", "example.test"].join("@")}`, serviceDate: null }] }));
    const r = await h.run();
    expect(r.dead).toBe(1);
    expect(h.store.rows[0]).toMatchObject({ status: "dead", lastErrorCode: "refused:row_email" });
    expect(h.fake.callsOf("crm.item.add")).toHaveLength(0);
  });

  it("spam never creates a deal; an existing deal moves to the Spam stage", async () => {
    const h = harness();
    const fresh = inquiry();
    h.put(inquiryState(fresh.id, { status: "spam" }));
    await h.run();
    expect(h.fake.deals.size).toBe(0);
    expect(h.store.rows[0].outcome).toBe("not_created");
    const s = inquiry();
    h.put(inquiryState(s.id));
    await h.run();
    h.put(inquiryState(s.id, { status: "spam" }));
    h.clock.advance(1_000);
    await h.run();
    expect(h.fake.dealsFor(originIdFor(s))[0].stageId).toBe("C7:SPAM");
  });

  it("a direct-checkout order becomes a deal only once authorised; revenue is captured minus refunded", async () => {
    const h = harness();
    const o: CrmSubject = { type: "order", id: subjectId() };
    h.put(directOrderState(o.id));
    await h.run();
    expect(h.fake.deals.size).toBe(0);
    expect(h.store.rows[0].outcome).toBe("not_visible");
    h.put(directOrderState(o.id, { authorised: true }));
    h.clock.advance(1_000);
    await h.run();
    expect(h.fake.dealsFor(originIdFor(o))[0]).toMatchObject({ stageId: "C7:PAYMENT_PENDING", opportunity: 0, title: "OUTLYY OUT-4829135" });
    h.put(directOrderState(o.id, { authorised: true, status: "refunded", capturedMinor: 25_000n, refundedMinor: 10_000n }));
    h.clock.advance(1_000);
    await h.run();
    expect(h.fake.dealsFor(originIdFor(o))[0]).toMatchObject({ stageId: "C7:REFUNDED", opportunity: 150 });
    expect(h.fake.dealsFor(originIdFor(o))[0].productRows).toEqual([{ productName: "Burj Khalifa At the Top (2026-12-02)", price: 250, quantity: 1 }]);
  });

  it("a staff payment in another currency: deal at 0 revenue with its own word, and a warning event (C2A-05)", async () => {
    const h = harness();
    const o: CrmSubject = { type: "order", id: subjectId() };
    const s = directOrderState(o.id, { authorised: true, status: "paid" });
    s.order!.otherCurrencyPaid = true;
    h.put(s);
    await h.run();
    expect(h.fake.dealsFor(originIdFor(o))[0]).toMatchObject({ opportunity: 0, [fieldCode("payment_status")]: "paid_other_currency" });
    expect(h.events.find((e) => e.name === "crm.currency_mismatch")?.fields).toEqual({ entityType: "order", entityId: o.id });
  });

  it("a single-flight lease: a second worker for the same portal does nothing while the first holds it", async () => {
    const h = harness();
    h.put(inquiryState(subjectId()));
    await h.store.ensurePortal(h.scope, { categoryId: h.config.categoryId, originatorId: h.config.originatorId });
    await h.store.acquireLease(h.scope, "someone-else", h.clock.now(), new Date(h.clock.t + 60_000));
    expect((await h.run()).outcome).toBe("busy");
    expect(h.fake.calls).toHaveLength(0);
  });
});

describe("CRM worker: a not-found answer is believed only when the deal is gone (gap G14)", () => {
  it("an update answered not-found while the deal is still in the OUTLYY funnel retries; the link is never tombstoned", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id));
    await h.run();
    h.put(inquiryState(s.id, { status: "contacted" }));
    h.fake.methodScript.push({ method: "crm.item.update", failure: "phantom_not_found" });
    h.clock.advance(1_000);
    const r = await h.run();
    expect(r).toMatchObject({ failed: 1, pushed: 0 });
    expect(h.store.link(h.scope, s)).toMatchObject({ state: "active" });
    expect(h.store.rows[1]).toMatchObject({ status: "queued", lastErrorCode: "rejected:update_not_found_visible", attempts: 1 });
    // The next attempt pushes normally.
    h.clock.advance(10 * 60_000);
    await h.run();
    expect(h.fake.dealsFor(originIdFor(s))[0]).toMatchObject({ stageId: "C7:CONTACTED" });
  });

  it.each(["code", "empty_code_text", "core_text", "core_text_ru", "http404"] as const)("a deal really deleted on the portal (not-found shaped %s) is tombstoned, not re-created", async (shape) => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id));
    await h.run();
    h.fake.notFoundShape = shape;
    h.fake.deals.clear();
    h.put(inquiryState(s.id, { status: "contacted" }));
    h.clock.advance(1_000);
    await h.run();
    expect(h.store.link(h.scope, s)).toMatchObject({ state: "deleted", deleteReason: "crm_deleted" });
    expect(h.fake.deals.size).toBe(0);
  });

  it("an erasure delete answered not-found while the deal is still visible is never counted as deleted: it retries, then dead-letters", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id));
    await h.run();
    for (let i = 0; i < 8; i++) h.fake.methodScript.push({ method: "crm.item.delete", failure: "phantom_not_found" });
    h.store.enqueue(h.scope, s, "delete", "erasure");
    await h.drain(30, 3_600_000);
    const del = h.store.rows.find((r) => r.kind === "delete")!;
    expect(del).toMatchObject({ status: "dead", lastErrorCode: "rejected:delete_not_found_visible", attempts: 8 });
    expect(h.store.link(h.scope, s)?.state).toBe("active");
    expect(h.fake.dealsFor(originIdFor(s))).toHaveLength(1);
  });

  it("an erasure delete with an unknown answer shape is retried, never tombstoned on that answer", async () => {
    const h = harness();
    const s = inquiry();
    h.put(inquiryState(s.id));
    await h.run();
    h.fake.deleteAnswer = "object";
    h.store.enqueue(h.scope, s, "delete", "erasure");
    h.clock.advance(1_000);
    await h.run();
    const del = h.store.rows.find((r) => r.kind === "delete")!;
    expect(del).toMatchObject({ status: "queued", lastErrorCode: "invalid_response:delete_result_object", attempts: 1 });
    expect(h.store.link(h.scope, s)?.state).toBe("active");
    // The fake did delete it (only the answer was odd): the retry cannot see the deal, so the link is tombstoned and
    // the row dead-lettered for a human check (the C2A-08 alert), never silently counted as deleted.
    h.fake.deleteAnswer = "true";
    h.clock.advance(10 * 60_000);
    await h.run();
    expect(h.store.link(h.scope, s)).toMatchObject({ state: "deleted", deleteReason: "erasure" });
    expect(del).toMatchObject({ status: "dead", lastErrorCode: "refused:linked_deal_not_visible" });
  });
});

describe("CRM worker and the G11 alert read the same pause (review C2B-06)", () => {
  it("the stored portal row after a real breaker opening, re-opening and auth refusal gives the exact opening time", async () => {
    const { crmPortalIncident } = await import("@/server/services/ops-alert.service");
    const h = harness();
    for (let i = 0; i < 6; i++) h.put(inquiryState(subjectId()));
    h.fake.down = true;
    const openedAt = () => h.fake.calls[h.fake.calls.length - 1].at;
    await h.run();
    const row = () => [...h.store.portals.values()][0];
    const since = new Date(0);
    let first = openedAt();
    expect(crmPortalIncident({ environment: "staging", ...row() }, since, h.clock.now())).toMatchObject({ reason: "crm_breaker_open", raisedAt: new Date(first) });
    // The pause ends, the half-open probe fails: a new opening, again exact.
    h.clock.t = row().pausedUntil!.getTime() + 1_000;
    await h.run();
    first = openedAt();
    expect(crmPortalIncident({ environment: "staging", ...row() }, since, h.clock.now())).toMatchObject({ reason: "crm_breaker_open", raisedAt: new Date(first) });
    // Recovery resets the failures: no incident.
    h.fake.down = false;
    h.clock.t = row().pausedUntil!.getTime() + 1_000;
    await h.run();
    expect(crmPortalIncident({ environment: "staging", ...row() }, since, h.clock.now())).toBeNull();
    // A refused credential.
    h.put(inquiryState(subjectId()));
    h.fake.revoked = true;
    await h.run();
    expect(crmPortalIncident({ environment: "staging", ...row() }, since, h.clock.now())).toMatchObject({ reason: "crm_auth_refused", raisedAt: new Date(openedAt()) });
  });
});
