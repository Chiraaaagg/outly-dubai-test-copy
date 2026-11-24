import { describe, expect, it } from "vitest";
import { originIdFor, type CrmSubject } from "@/server/crm/crm.mapping";
import { FINGERPRINT_ADMIN_RECHECK_MS, HOLD_MS, PORTAL_RERAISE_MS } from "@/server/crm/crm.reconcile";
import { STAFF, returnHarness } from "./_return-harness";
import { fieldCode, inquiryState, subjectId } from "./_memory-store";

/**
 * C3ab fix round (review 97): observe and the time before the fingerprint is stored never stop the push; the
 * poll never stalls after a burst; known differences are read again; no silent relink; an owner change beside a
 * pending push is kept; an echo that still differs is drift, not a staff change; a claim needs inquiries.claim.
 */

const PAID = "C7:PAID_AWAITING_SUPPLIER";
const NIGHT = Date.parse("2026-11-22T22:30:00.000Z");

describe("fingerprint never stops the push outside enforce with a stored fingerprint (C3-03, C3-04, C3-13, C3-14)", () => {
  it("observe before a store: a structural problem alerts, skips the return path, is not latched, and pushes and erasure deletes go on", async () => {
    const h = returnHarness({ mode: "observe" });
    h.fake.stages = h.fake.stages.filter((x) => x.STATUS_ID !== "C7:LOST");
    const s: CrmSubject = { type: "inquiry", id: subjectId() };
    h.put(inquiryState(s.id));
    expect((await h.run()).outcome).toBe("ran");
    expect(h.fake.dealsFor(originIdFor(s))).toHaveLength(1);
    expect((await h.store.returnPortal(h.scope)).fingerprintState).toBeNull();
    expect(h.store.findingsOf("crm_portal_fingerprint_mismatch")).toHaveLength(1);
    h.clock.advance(60_000);
    h.store.enqueue(h.scope, s, "delete", "erasure");
    expect((await h.run()).outcome).toBe("ran");
    expect(h.fake.dealsFor(originIdFor(s))).toEqual([]);
  });

  it("enforce before a store: problems never refuse the run either", async () => {
    const h = returnHarness();
    h.fake.categories.set(7, { id: 7, name: "Other", entityTypeId: 2 });
    h.fake.addStage("C7:EXTRA");
    const s: CrmSubject = { type: "inquiry", id: subjectId() };
    h.put(inquiryState(s.id));
    expect((await h.run()).outcome).toBe("ran");
    expect(h.fake.dealsFor(originIdFor(s))).toHaveLength(1);
  });

  it("observe with a stored fingerprint: a mismatch latches (enforce would refuse) but the observe run still pushes", async () => {
    const h = returnHarness({ mode: "observe" });
    await h.storeFingerprint();
    h.fake.addStage("C7:EXTRA");
    h.clock.advance(7 * 3_600_000);
    const s: CrmSubject = { type: "inquiry", id: subjectId() };
    h.put(inquiryState(s.id));
    expect((await h.run()).outcome).toBe("ran");
    expect(h.fake.dealsFor(originIdFor(s))).toHaveLength(1);
    expect((await h.store.returnPortal(h.scope)).fingerprintState).toBe("mismatch");
    h.settings.mode = "enforce";
    expect((await h.run()).reason).toBe("portal_fingerprint_mismatch");
  });

  it("an unreadable check is retried after 10 minutes, not 6 hours", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    h.clock.advance(6 * 3_600_000);
    h.fake.methodScript.push({ method: "profile", failure: "server_error" });
    await h.run();
    const reads = h.fake.callsOf("profile").length;
    h.clock.advance(FINGERPRINT_ADMIN_RECHECK_MS);
    await h.run();
    expect(h.fake.callsOf("profile").length).toBe(reads + 1);
    expect((await h.store.returnPortal(h.scope)).fingerprintState).toBe("ok");
  });

  it("a run that read an older hash never overwrites the owner's fresh store step (compare-and-set)", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const old = (await h.store.returnPortal(h.scope)).fingerprintHash;
    await h.store.setReturnPortal(h.scope, { fingerprintHash: "c".repeat(64), fingerprintState: "ok" });
    await h.store.setReturnPortal(h.scope, { fingerprintState: "mismatch" }, { fingerprintHash: old });
    expect((await h.store.returnPortal(h.scope)).fingerprintState).toBe("ok");
  });

  it("a portal-level refusal is alerted again every 6 hours while it holds", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    h.fake.addStage("C7:EXTRA");
    h.clock.advance(7 * 3_600_000);
    await h.run();
    const first = h.store.findingsOf("crm_portal_fingerprint_mismatch")[0].raisedAt.getTime();
    for (let i = 0; i < 7; i++) {
      h.clock.advance(60 * 60_000);
      await h.run();
    }
    expect(h.store.findingsOf("crm_portal_fingerprint_mismatch")[0].raisedAt.getTime()).toBeGreaterThanOrEqual(first + PORTAL_RERAISE_MS);
  });
});

describe("the poll never stalls (C3-05, C3-16)", () => {
  it("150 staff-owned changes inside 60 seconds, many in the same second, are all handled over a few runs", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    await h.run();
    const deals = Array.from({ length: 150 }, () => h.linked(inquiryState(subjectId())));
    h.clock.advance(60_000);
    for (const [i, d] of deals.entries()) {
      h.fake.actAs(STAFF.a.bitrix).editField(d.id, "comments", "bulk edit");
      if (i % 60 === 59) h.clock.advance(20_000); // 60 changes in one second, three times
    }
    let handled = 0;
    for (let i = 0; i < 20; i++) {
      await h.run();
      handled += Number(h.ev("crm.return_poll").at(-1)!.fields.staffOwned ?? 0);
      h.clock.advance(60_000);
    }
    expect(handled).toBe(150);
    const p = await h.store.returnPortal(h.scope);
    expect(p.reconcileCatchingUp).toBe(false); // back at the head
    // A staff drag after the burst is still seen.
    h.fake.actAs(STAFF.a.bitrix).moveStage(deals[0].id, PAID);
    h.clock.advance(1_000);
    await h.run();
    expect(h.fake.deals.get(deals[0].id)!.stageId).toBe("C7:NEW_INQUIRY");
  });
});

describe("known differences are read again (C3-06)", () => {
  it("a held deal is put back once the hold has ended, without a new staff change", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal({ status: "contacted" });
    await h.run();
    for (let i = 0; i < 4; i++) {
      h.clock.advance(5 * 60_000);
      h.fake.actAs(STAFF.a.bitrix).moveStage(deal.id, PAID);
      h.clock.advance(1_000);
      await h.run();
    }
    expect(h.deal(s).stageId).toBe(PAID); // held
    h.clock.advance(HOLD_MS);
    await h.run();
    expect(h.deal(s).stageId).toBe("C7:CONTACTED");
  });

  it("differences seen in observe are put back, and owner changes applied, after the switch to enforce", async () => {
    const h = returnHarness({ mode: "observe", accept: true });
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal({ status: "contacted" });
    await h.run();
    h.fake.actAs(STAFF.a.bitrix).moveStage(deal.id, PAID);
    h.fake.actAs(STAFF.lead.bitrix).reassign(deal.id, STAFF.a.bitrix);
    h.clock.advance(1_000);
    await h.run();
    expect(h.deal(s).stageId).toBe(PAID);
    h.settings.mode = "enforce";
    h.clock.advance(60_000);
    await h.run();
    expect(h.deal(s).stageId).toBe("C7:CONTACTED");
    expect(h.commands.agents.get(s.id)).toBe(STAFF.a.id);
  });

  it("a deal whose handling failed is read again next run", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal();
    await h.run();
    h.fake.actAs(STAFF.a.bitrix).moveStage(deal.id, PAID);
    h.clock.advance(1_000);
    const load = h.book.load;
    let fail = true;
    h.book.load = async (x) => {
      if (fail) {
        fail = false;
        throw new Error("db down");
      }
      return load(x);
    };
    await h.run();
    expect(h.deal(s).stageId).toBe(PAID);
    h.clock.advance(5 * 60_000);
    await h.run();
    expect(h.deal(s).stageId).toBe("C7:NEW_INQUIRY");
  });
});

describe("other fixes", () => {
  it("a missing linked deal with a twin is never relinked: both ids are alerted, the link keeps its deal id (C3-02)", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal();
    const copy = h.fake.actAs(1).copy(deal.id);
    h.fake.actAs(1).moveToFunnel(deal.id, 9);
    h.clock.t = NIGHT;
    for (let i = 0; i < 4; i++) {
      await h.run();
      h.clock.advance(60_000);
    }
    expect(h.store.link(h.scope, s)!.crmId).toBe(BigInt(deal.id));
    const [nv] = h.store.findingsOf("crm_deal_not_visible");
    expect(nv.detail).toBe(`prev=${deal.id},twin=${copy.id}`);
    expect(h.store.findingsOf("crm_twin").map((f) => f.crmId)).toEqual([copy.id]);
    expect(h.fake.commentsOn(copy.id)).toEqual([]);
  });

  it("an owner change beside a pending push is applied, not lost to the push's echo (C3-09)", async () => {
    const h = returnHarness({ accept: true });
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal({ status: "contacted" });
    await h.run();
    h.fake.actAs(STAFF.lead.bitrix).reassign(deal.id, STAFF.a.bitrix);
    h.commands.setStatus(s.id, "quoted"); // a push is pending
    h.clock.advance(1_000);
    await h.run();
    expect(h.commands.agents.get(s.id)).toBe(STAFF.a.id);
    expect(h.store.findingsOf("crm_owner_change_refused")).toEqual([]);
  });

  it("a deal that still differs after OUTLYY's own write is drift: pushed again, no staff note, no tamper alert (C3-15)", async () => {
    const h = returnHarness();
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal();
    await h.run();
    for (let i = 0; i < 2; i++) {
      h.clock.advance(5 * 60_000);
      // The service account's own (stale) write.
      Object.assign(h.fake.deals.get(deal.id)!, { [fieldCode("payment_status")]: "paid", updatedTime: h.clock.ms() });
      h.clock.advance(1_000);
      await h.run();
      expect(h.deal(s)[fieldCode("payment_status")]).toBe("");
    }
    expect(h.store.findingsOf("crm_field_tamper")).toEqual([]);
    expect(h.store.timelineOf(h.scope, s)).toEqual([]);
    expect(h.commands.calls.filter((c) => c.op === "put_back").map((c) => (c.info as { what: string; bitrixUserId: unknown }))).toEqual([
      expect.objectContaining({ what: "drift", bitrixUserId: null }),
      expect.objectContaining({ what: "drift", bitrixUserId: null }),
    ]);
  });

  it("a Bitrix24 self-claim needs inquiries.claim, like OUTLYY's claim route (C3-01)", async () => {
    const h = returnHarness({ accept: true });
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal({ status: "new" });
    await h.run();
    h.commands.staffRecords.set(STAFF.b.id, { roles: ["content"], active: true, totp: true });
    h.fake.actAs(STAFF.b.bitrix).reassign(deal.id, STAFF.b.bitrix);
    h.clock.advance(1_000);
    await h.run();
    expect(h.commands.agents.get(s.id) ?? null).toBeNull();
    expect(h.store.findingsOf("crm_owner_change_refused")).toHaveLength(1);
  });
});
