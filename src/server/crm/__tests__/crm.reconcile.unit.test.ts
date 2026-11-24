import { describe, expect, it } from "vitest";
import { originIdFor, type CrmSubject } from "@/server/crm/crm.mapping";
import { assertSafeTwinText, FINGERPRINT_GRACE_MS, HOLD_MS, isNight, POLL_MAX_DEALS, twinCommentText } from "@/server/crm/crm.reconcile";
import { TIMELINE_QUIET_MS } from "@/server/crm/crm.timeline";
import { STAFF, UNMAPPED_USER, returnHarness } from "./_return-harness";
import { TEST_CONTACT, directOrderState, fieldCode, inquiryState, subjectId } from "./_memory-store";

/**
 * The Bitrix24 return path, guard half (CRM batch C3ab, doc 29e §13.2 cases
 * 1–16): put-backs of OUTLYY-owned stages and fields through the single
 * writer, echo handling, the poll cursor, observe mode, the portal
 * fingerprint (G13), the nightly sweep (G15: twins, orphans, hand-made,
 * foreign and no longer visible deals, drift) and the call budget. On the
 * fake portal, the in-memory stores and a fake clock; synthetic data only.
 */

const PAID = "C7:PAID_AWAITING_SUPPLIER";
const NIGHT = Date.parse("2026-11-22T22:30:00.000Z");

/** No event, finding or detail ever carries a customer value, the title or the webhook path. */
function expectNoValues(h: ReturnType<typeof returnHarness>) {
  const text = JSON.stringify({ events: h.events, findings: h.store.findings });
  for (const v of [TEST_CONTACT.name, TEST_CONTACT.phone, TEST_CONTACT.email, "OUTLYY INQ-", "/rest/"]) expect(text).not.toContain(v);
}

describe("return path: put-backs (enforce)", () => {
  it("a staff drag to an integration-only stage is put back by one normal push, with one fixed note and a system audit row; OUTLYY is unchanged", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal({ status: "contacted" });
    await h.run(); // the echo of OUTLYY's own create
    h.clock.advance(60_000);
    for (const stage of [PAID, "C7:CONFIRMED_TICKETS_PENDING", "C7:FULFILLED", "C7:CANCELLED", "C7:REFUNDED", "C7:SPAM"]) {
      h.fake.actAs(STAFF.a.bitrix).moveStage(deal.id, stage);
      h.clock.advance(1_000);
      const before = h.fake.calls.length;
      const r = await h.run();
      expect(r.outcome).toBe("ran");
      expect(h.deal(s).stageId).toBe("C7:CONTACTED");
      // Put back through the outbox: the update and the product rows, nothing else written.
      // (A note queued by an earlier put-back may post in the same run, after its quiet period.)
      expect(h.writesTo(before).map((c) => c.method).filter((m) => m !== "crm.timeline.comment.add")).toEqual(["crm.item.update", "crm.item.productrow.set"]);
      h.clock.advance(25 * 3_600_000); // outside every repeat window
    }
    expect(h.book.get(s)!.inquiry!.status).toBe("contacted");
    expect(h.commands.mutations()).toEqual([]);
    const audits = h.commands.calls.filter((c) => c.op === "put_back");
    expect(audits).toHaveLength(6);
    expect(audits[0].info).toMatchObject({ what: "stage", dealId: deal.id, bitrixUserId: STAFF.a.bitrix, from: "contacted", to: "paid_awaiting_supplier" });
    // One fixed note per day, through the C2b comment queue: posted after its quiet period.
    h.clock.advance(TIMELINE_QUIET_MS + 60_000);
    await h.run();
    const notes = h.fake.commentsOn(deal.id).map((c) => c.text);
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes.join("\n")).toContain("The stage was changed in Bitrix24. OUTLYY put it back");
    expect(notes.join("\n")).not.toContain(TEST_CONTACT.name);
    expectNoValues(h);
  });

  it("a second drag within 24 hours is put back again with no second note and raises tamper once; a third within the hour holds the deal", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal({ status: "contacted" });
    await h.run();
    for (let i = 0; i < 3; i++) {
      h.clock.advance(5 * 60_000);
      h.fake.actAs(STAFF.a.bitrix).moveStage(deal.id, PAID);
      h.clock.advance(1_000);
      await h.run();
      expect(h.deal(s).stageId).toBe("C7:CONTACTED");
    }
    const link = h.store.returnLinkOf(h.scope, s)!;
    expect(link.revertCount).toBe(3);
    expect(link.holdUntil!.getTime()).toBeGreaterThan(h.clock.ms() + HOLD_MS - 3_600_000);
    expect(h.store.timelineOf(h.scope, s).filter((t) => t.kind === "move_refused" || t.kind === "stage_reverted")).toHaveLength(1);
    expect(h.store.findingsOf("crm_stage_tamper")).toHaveLength(1);
    expect(h.store.findingsOf("crm_putback_loop")).toHaveLength(1);
    // During the hold: no forced push; ordinary pushes still run.
    h.clock.advance(60_000);
    h.fake.actAs(STAFF.a.bitrix).moveStage(deal.id, PAID);
    h.clock.advance(1_000);
    const before = h.fake.calls.length;
    await h.run();
    expect(h.deal(s).stageId).toBe(PAID);
    expect(h.writesTo(before)).toEqual([]);
    h.commands.setStatus(s.id, "quoted");
    h.clock.advance(1_000);
    await h.run();
    expect(h.deal(s).stageId).toBe("C7:QUOTED");
  });

  it("the poll after OUTLYY's own push is an echo: nothing is queued, only the seen columns move", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const { s } = await h.newDeal();
    const before = h.fake.calls.length;
    await h.run();
    expect(h.writesTo(before)).toEqual([]);
    expect(h.store.rows.filter((r) => r.status === "queued")).toEqual([]);
    expect(h.store.returnLinkOf(h.scope, s)!.crmSeenUpdatedAt).not.toBeNull();
    expect(h.ev("crm.return_poll").at(-1)!.fields).toMatchObject({ echo: 1 });
  });

  it("a staff edit of an OUTLYY field is restored without a note; a second within 24 hours alerts by field key, never by value", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal();
    await h.run();
    for (let i = 0; i < 2; i++) {
      h.clock.advance(10 * 60_000);
      h.fake.actAs(STAFF.a.bitrix).editField(deal.id, fieldCode("payment_status"), "paid");
      h.fake.actAs(STAFF.a.bitrix).editField(deal.id, "title", "Changed by hand");
      h.clock.advance(1_000);
      await h.run();
      expect(h.deal(s)[fieldCode("payment_status")]).toBe("");
      expect(h.deal(s).title).toBe("OUTLYY INQ-1048213");
    }
    expect(h.store.timelineOf(h.scope, s)).toEqual([]);
    const [tamper] = h.store.findingsOf("crm_field_tamper");
    expect(tamper.detail).toBe("title,payment_status");
    expect(h.ev("crm.return_deal").map((e) => e.fields.fields)).toContain("title:payment_status");
    expectNoValues(h);
    expect(JSON.stringify(h.events)).not.toContain("Changed by hand");
  });

  it("a staff edit of a field staff own (a note, a follow-up date) changes nothing", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal();
    await h.run();
    h.clock.advance(60_000);
    h.fake.actAs(STAFF.a.bitrix).editField(deal.id, "comments", "call back tomorrow");
    h.clock.advance(1_000);
    const before = h.fake.calls.length;
    await h.run();
    expect(h.writesTo(before)).toEqual([]);
    expect(h.ev("crm.return_poll").at(-1)!.fields).toMatchObject({ staffOwned: 1 });
    expect(h.store.returnLinkOf(h.scope, s)!.revertCount).toBe(0);
  });

  it("a pending OUTLYY push and a staff drag: OUTLYY wins, no put-back is counted", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal();
    await h.run();
    h.clock.advance(60_000);
    h.fake.actAs(STAFF.a.bitrix).moveStage(deal.id, PAID);
    h.commands.setStatus(s.id, "contacted"); // OUTLYY's own change, queued
    h.clock.advance(1_000);
    await h.run();
    expect(h.deal(s).stageId).toBe("C7:CONTACTED");
    expect(h.store.returnLinkOf(h.scope, s)!.revertCount).toBe(0);
    expect(h.ev("crm.return_poll").at(-1)!.fields).toMatchObject({ pushPending: 1 });
  });

  it("an unknown (thirteenth) stage is put back and alerted", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal();
    await h.run();
    h.clock.advance(60_000);
    h.fake.actAs(STAFF.a.bitrix).moveStage(deal.id, "C7:EXTRA");
    h.clock.advance(1_000);
    await h.run();
    expect(h.deal(s).stageId).toBe("C7:NEW_INQUIRY");
    expect(h.store.findingsOf("crm_unknown_stage")[0]).toMatchObject({ crmId: deal.id, detail: "C7:EXTRA" });
  });
});

describe("return path: the poll cursor", () => {
  it("120 changed deals are handled over several runs in order, none twice and none lost; the cursor is a portal time", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    await h.run();
    const deals = Array.from({ length: 120 }, () => h.linked(inquiryState(subjectId())));
    h.clock.advance(60_000);
    for (const d of deals) {
      h.fake.actAs(STAFF.a.bitrix).editField(d.id, "comments", "seen by staff");
      // Spread over 10 minutes: more than 100 changes inside one 120 s overlap is the stated limit (crm_poll_stuck).
      h.clock.advance(5_000);
    }
    let handled = 0;
    for (let i = 0; i < 12; i++) {
      await h.run();
      handled += Number(h.ev("crm.return_poll").at(-1)!.fields.staffOwned ?? 0);
      h.clock.advance(60_000);
    }
    expect(handled).toBe(120);
    expect(h.ev("crm.return_poll").every((e) => Number(e.fields.handled ?? 0) <= POLL_MAX_DEALS)).toBe(true);
    const cursor = (await h.store.returnPortal(h.scope)).reconcileCursor!;
    expect(cursor.getUTCMilliseconds()).toBe(0);
  });

  it("a crash between the reads and the cursor update repeats safely: the deals are seen, never handled twice", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal();
    await h.run();
    h.clock.advance(60_000);
    h.fake.actAs(STAFF.a.bitrix).moveStage(deal.id, PAID);
    h.clock.advance(1_000);
    const set = h.store.setReturnPortal.bind(h.store);
    let fail = true;
    h.store.setReturnPortal = async (scope, patch) => {
      if (fail && "reconcileCursor" in patch) {
        fail = false;
        throw new Error("db down");
      }
      return set(scope, patch);
    };
    await h.run();
    await h.run();
    expect(h.deal(s).stageId).toBe("C7:NEW_INQUIRY");
    expect(h.store.returnLinkOf(h.scope, s)!.revertCount).toBe(1);
  });

  it("a portal that ignores the time filter is bounded by the page and deal caps; already seen deals are skipped", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    await h.run();
    for (let i = 0; i < 60; i++) h.linked(inquiryState(subjectId()));
    h.fake.ignoreTimeFilter = true;
    for (let i = 0; i < 6; i++) {
      h.clock.advance(60_000);
      const before = h.fake.callsOf("crm.item.list").length;
      await h.run();
      expect(h.fake.callsOf("crm.item.list").length - before).toBeLessThanOrEqual(2);
    }
    expect(h.store.rows.filter((r) => r.status === "queued")).toEqual([]);
  });
});

describe("return path: observe mode", () => {
  it("classifies, logs and alerts, and writes nothing to the portal and nothing in OUTLYY but the cursor and seen columns", async () => {
    const h = returnHarness({ mode: "observe", accept: true });
    const { s, deal } = await h.newDeal({ status: "contacted" });
    await h.run();
    h.clock.advance(60_000);
    h.fake.actAs(STAFF.a.bitrix).moveStage(deal.id, PAID);
    h.fake.actAs(STAFF.a.bitrix).editField(deal.id, fieldCode("payment_status"), "paid");
    h.fake.actAs(STAFF.lead.bitrix).reassign(deal.id, STAFF.a.bitrix);
    h.fake.actAs(STAFF.a.bitrix).addByHand();
    h.clock.advance(1_000);
    const before = h.fake.calls.length;
    const writes = { ...h.store.writes };
    await h.run();
    expect(h.writesTo(before)).toEqual([]);
    expect(h.deal(s).stageId).toBe(PAID);
    expect(h.commands.calls).toEqual([]);
    expect(h.store.writes.queuePush ?? 0).toBe(writes.queuePush ?? 0);
    expect(h.store.timelineOf(h.scope, s)).toEqual([]);
    expect(h.store.returnLinkOf(h.scope, s)!.revertCount).toBe(0);
    expect(h.ev("crm.return_deal").map((e) => e.fields.action)).toEqual(expect.arrayContaining(["would_assign", "would_put_back_stage"]));
    expect(h.store.findingsOf("crm_unlinked_deal")).toHaveLength(1);
    expectNoValues(h);
  });

  it("observe runs before a fingerprint is stored; enforce does nothing on the return path until it is", async () => {
    const h = returnHarness();
    const { s, deal } = await h.newDeal();
    h.fake.actAs(STAFF.a.bitrix).moveStage(deal.id, PAID);
    h.clock.advance(1_000);
    await h.run();
    expect(h.deal(s).stageId).toBe(PAID);
    expect(h.ev("crm.return_skipped").at(-1)!.fields).toMatchObject({ reason: "fingerprint_not_stored" });
    // The push itself runs as before.
    h.commands.setStatus(s.id, "contacted");
    await h.run();
    expect(h.deal(s).stageId).toBe("C7:CONTACTED");
  });

  it("off: no return path call at all", async () => {
    const h = returnHarness({ mode: "off" });
    await h.newDeal();
    await h.run();
    expect(h.fake.calls.map((c) => c.method).filter((m) => m === "profile" || m.startsWith("crm.status") || m.startsWith("crm.category"))).toEqual([]);
    expect(h.fake.callsOf("crm.item.list")).toHaveLength(1); // the search before the create only
  });
});

describe("return path: portal fingerprint (G13)", () => {
  it("is stored by the explicit step only, checked every 6 hours, and the name is never kept", async () => {
    const h = returnHarness();
    const r = await h.storeFingerprint();
    expect(r).toMatchObject({ stored: true });
    const p = await h.store.returnPortal(h.scope);
    expect(p.fingerprintHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(p)).not.toContain("Sync");
    await h.run();
    await h.run();
    expect(h.fake.callsOf("profile")).toHaveLength(1); // the store step; the runs are inside 6 hours
    h.clock.advance(6 * 3_600_000);
    await h.run();
    expect(h.fake.callsOf("profile")).toHaveLength(2);
  });

  it.each([
    ["renamed funnel", (h: ReturnType<typeof returnHarness>) => h.fake.categories.set(7, { id: 7, name: "Renamed", entityTypeId: 2 })],
    ["missing stage", (h: ReturnType<typeof returnHarness>) => (h.fake.stages = h.fake.stages.filter((x) => x.STATUS_ID !== "C7:LOST"))],
    ["changed stage kind", (h: ReturnType<typeof returnHarness>) => (h.fake.stages.find((x) => x.STATUS_ID === "C7:LOST")!.SEMANTICS = "S")],
    ["another service user", (h: ReturnType<typeof returnHarness>) => (h.fake.profileId = "18")],
    ["a thirteenth stage", (h: ReturnType<typeof returnHarness>) => h.fake.addStage("C7:EXTRA")],
  ])("%s refuses every run, the outbox too, until the owner stores it again", async (_name, change) => {
    const h = returnHarness();
    await h.storeFingerprint();
    const s: CrmSubject = { type: "inquiry", id: subjectId() };
    change(h);
    h.clock.advance(7 * 3_600_000);
    h.put(inquiryState(s.id));
    const r = await h.run();
    expect(r).toMatchObject({ outcome: "refused", reason: "portal_fingerprint_mismatch" });
    expect(h.fake.dealsFor(originIdFor(s))).toEqual([]);
    expect(h.store.findingsOf("crm_portal_fingerprint_mismatch")).toHaveLength(1);
    // Latched: still refused without another read.
    const reads = h.fake.callsOf("profile").length;
    expect((await h.run()).outcome).toBe("refused");
    expect(h.fake.callsOf("profile")).toHaveLength(reads);
  });

  it("an administrator webhook refuses every run in enforce with a stored fingerprint; in observe it alerts and skips the return path only", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    h.fake.admin = true;
    h.clock.advance(6 * 3_600_000);
    expect(await h.run()).toMatchObject({ outcome: "refused", reason: "service_account_is_admin" });
    expect(h.store.findingsOf("crm_service_account_is_admin")).toHaveLength(1);
    expect(await h.storeFingerprint()).toMatchObject({ stored: false, reason: "service_account_is_admin" });
    h.fake.admin = false;
    h.clock.advance(11 * 60_000);
    expect((await h.run()).outcome).toBe("ran");

    const o = returnHarness({ mode: "observe" });
    o.fake.admin = true;
    const s: CrmSubject = { type: "inquiry", id: subjectId() };
    o.put(inquiryState(s.id));
    expect((await o.run()).outcome).toBe("ran");
    expect(o.fake.dealsFor(originIdFor(s))).toHaveLength(1);
    expect(o.store.findingsOf("crm_service_account_is_admin")).toHaveLength(1);
    expect(o.ev("crm.return_skipped").at(-1)!.fields).toMatchObject({ reason: "service_account_is_admin" });
  });

  it("an unreadable check is tolerated for 24 hours, then the run is refused until a check succeeds", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    h.clock.advance(6 * 3_600_000);
    h.fake.methodScript.push({ method: "profile", failure: "server_error" });
    expect((await h.run()).outcome).toBe("ran");
    h.clock.advance(FINGERPRINT_GRACE_MS);
    for (let i = 0; i < 3; i++) h.fake.methodScript.push({ method: "profile", failure: "server_error" });
    expect((await h.run()).reason).toBe("fingerprint_unverified");
    h.fake.methodScript = [];
    h.clock.advance(6 * 3_600_000);
    expect((await h.run()).outcome).toBe("ran");
  });
});

describe("return path: nightly sweep (G15)", () => {
  async function atNight(h: ReturnType<typeof returnHarness>) {
    h.clock.t = Math.max(h.clock.t, NIGHT);
    expect(isNight(h.clock.now())).toBe(true);
  }

  it("twins (lost answer, copied, three copies): the linked deal is kept, nothing is deleted or changed, one fixed comment on each extra", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal();
    const lost = h.fake.seedDeal({ originId: originIdFor(s) });
    const copy = h.fake.actAs(1).copy(deal.id);
    const third = h.fake.actAs(1).copy(deal.id);
    const extras = [lost, copy, third].map((d) => ({ ...h.fake.deals.get(d.id)! }));
    await atNight(h);
    for (let i = 0; i < 4; i++) {
      await h.run();
      h.clock.advance(60_000);
    }
    expect(h.store.findingsOf("crm_twin").map((f) => f.crmId).sort()).toEqual([lost.id, copy.id, third.id].sort());
    expect(h.store.link(h.scope, s)).toMatchObject({ crmId: BigInt(deal.id) });
    expect(h.store.link(h.scope, s)!.twinFlaggedAt).not.toBeNull();
    expect(h.fake.callsOf("crm.item.delete")).toEqual([]);
    for (const e of extras) {
      const now = h.fake.deals.get(e.id)!;
      expect({ ...now, updatedTime: 0 }).toEqual({ ...e, updatedTime: 0 });
      expect(h.fake.commentsOn(e.id).map((c) => c.text)).toEqual([twinCommentText(deal.id)]);
    }
    expect(h.fake.commentsOn(deal.id).filter((c) => c.text.startsWith("OUTLYY: Duplicate"))).toEqual([]);
  });

  it("a deal moved out of the funnel, a deleted deal, a hand-made deal, an orphan and another environment's deal each alert and are never written", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const moved = await h.newDeal();
    const gone = await h.newDeal();
    h.fake.actAs(1).moveToFunnel(moved.deal.id, 9);
    h.fake.actAs(1).delete(gone.deal.id);
    const hand = h.fake.actAs(STAFF.a.bitrix).addByHand();
    const orphan = h.fake.seedDeal({ originId: `inq:${subjectId()}` });
    const foreign = h.fake.seedDeal({ originId: `inq:${subjectId()}`, originatorId: "outlyy-production" });
    await atNight(h);
    const before = h.fake.calls.length;
    for (let i = 0; i < 4; i++) {
      await h.run();
      h.clock.advance(60_000);
    }
    expect(h.writesTo(before)).toEqual([]);
    expect(h.store.findingsOf("crm_deal_not_visible").map((f) => f.crmId).sort()).toEqual([moved.deal.id, gone.deal.id].sort());
    expect(h.store.findingsOf("crm_unlinked_deal").map((f) => f.crmId)).toEqual([hand.id]);
    expect(h.store.findingsOf("crm_orphan_deal").map((f) => f.crmId)).toEqual([orphan.id]);
    expect(h.store.findingsOf("crm_foreign_environment_deal").map((f) => f.crmId)).toEqual([foreign.id]);
    expect(h.store.returnLinkOf(h.scope, moved.s)!.missingSince).not.toBeNull();
  });

  it("an erased deal restored from the recycle bin alerts only: no second delete", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal();
    h.store.enqueue(h.scope, s, "delete", "erasure");
    await h.run();
    expect(h.store.link(h.scope, s)!.state).toBe("deleted");
    h.clock.advance(60_000);
    h.fake.actAs(1).restore(deal.id);
    h.clock.advance(1_000);
    const deletes = h.fake.callsOf("crm.item.delete").length;
    await h.run();
    expect(h.store.findingsOf("crm_deleted_deal_reappeared")).toHaveLength(1);
    expect(h.fake.callsOf("crm.item.delete")).toHaveLength(deletes);
    expect(h.fake.deals.has(deal.id)).toBe(true);
  });

  it("drift: a swallowed enqueue is found by the sweep without a CRM read and pushed", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const { s } = await h.newDeal();
    const st = h.book.get(s)!;
    st.inquiry!.status = "quoted"; // committed, but the enqueue was lost
    h.book.set(st);
    await atNight(h);
    for (let i = 0; i < 4; i++) {
      await h.run();
      h.clock.advance(60_000);
    }
    expect(h.deal(s).stageId).toBe("C7:QUOTED");
    expect(h.fake.callsOf("crm.item.list").filter((c) => c.outcome !== "ok")).toEqual([]);
  });

  it("the sweep runs only at night and only when the outbox is empty", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    await h.newDeal();
    await h.run();
    expect((await h.store.returnPortal(h.scope)).sweepStartedAt).toBeNull();
    await atNight(h);
    for (let i = 0; i < 25; i++) h.put(inquiryState(subjectId()));
    await h.run();
    expect((await h.store.returnPortal(h.scope)).sweepStartedAt).toBeNull();
  });
});

describe("return path: budget", () => {
  it("with a full outbox the reconciler uses at most 2 calls and the run never exceeds 12", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    await h.run();
    for (let i = 0; i < 60; i++) h.linked(inquiryState(subjectId()));
    for (let i = 0; i < 20; i++) h.put(inquiryState(subjectId()));
    h.fake.ignoreTimeFilter = true;
    h.clock.advance(60_000);
    const before = h.fake.calls.length;
    await h.run(60_000);
    const calls = h.fake.calls.slice(before);
    expect(calls.length).toBeLessThanOrEqual(12);
    // The poll's reads are the ones with the changed-since filter; the push's searches are single reads.
    expect(h.ev("crm.return_poll").at(-1)!.fields.polled).toBeLessThanOrEqual(100);
  });
});

describe("return path: owner changes and the twin text", () => {
  it("an owner change is only recorded while acceptance is off; OUTLYY never writes the deal owner", async () => {
    const h = returnHarness({ accept: false });
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal();
    await h.run();
    h.fake.actAs(STAFF.lead.bitrix).reassign(deal.id, UNMAPPED_USER);
    h.clock.advance(1_000);
    await h.run();
    expect(h.store.returnLinkOf(h.scope, s)!.crmSeenOwnerId).toBe(UNMAPPED_USER);
    expect(h.commands.calls).toEqual([]);
    h.commands.setStatus(s.id, "contacted");
    await h.run();
    expect(h.deal(s).assignedById).toBe(UNMAPPED_USER);
  });

  it("a direct-checkout order's owner is only recorded", async () => {
    const h = returnHarness({ accept: true });
    await h.storeFingerprint();
    const o: CrmSubject = { type: "order", id: subjectId() };
    h.put(directOrderState(o.id, { status: "paid", authorised: true, capturedMinor: 25_000n }));
    await h.run();
    h.clock.advance(60_000);
    await h.run();
    h.fake.actAs(STAFF.lead.bitrix).reassign(h.deal(o).id, STAFF.a.bitrix);
    h.clock.advance(1_000);
    await h.run();
    expect(h.commands.calls).toEqual([]);
    expect(h.store.returnLinkOf(h.scope, o)!.crmSeenOwnerId).toBe(STAFF.a.bitrix);
  });

  it("the twin comment is exactly the fixed sentence", () => {
    expect(twinCommentText(1234)).toBe("OUTLYY: Duplicate of deal 1234 — safe to delete. Move any notes to deal 1234 first.");
    expect(() => assertSafeTwinText(twinCommentText(5))).not.toThrow();
    expect(() => assertSafeTwinText("OUTLYY: Duplicate of deal 5 — safe to delete. Move any notes to deal 6 first.")).toThrow();
    expect(() => assertSafeTwinText(`${twinCommentText(5)} ${TEST_CONTACT.email}`)).toThrow();
  });
});
