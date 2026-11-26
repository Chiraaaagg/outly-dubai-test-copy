import { describe, expect, it } from "vitest";
import { CrmCallError } from "@/server/crm/bitrix.client";
import { CRM_STAGE_KEYS, type CrmStageKey } from "@/server/crm/crm.config";
import { assertSafeCrmPayload, mapDeal, type CrmSubject } from "@/server/crm/crm.mapping";
import { TRANSITIONS, canTransition } from "@/server/domain/inquiry-state";
import type { InquiryStatus } from "@/lib/types";
import { FAKE_OWNER, directOrderState, fakeConfig, inquiryState, subjectId } from "./_memory-store";
import { STAFF, UNMAPPED_USER, returnHarness } from "./_return-harness";

/**
 * The Bitrix24 return path, proposals and assignment half (CRM batch C3ab,
 * doc 29e §13.2 cases 17–23, as changed by the owner answers of 25 November
 * 2026): a sales-stage move by a mapped staff member is applied through
 * OUTLYY's own transition rules and that person's own permissions, with
 * "via Bitrix24"; everything else is put back. Owner changes flow Bitrix24 →
 * OUTLYY only; OUTLYY never writes the deal owner after create.
 */

const stageId = (k: CrmStageKey) => `C7:${k.toUpperCase()}`;

async function accepting(status = "contacted", agent: string | null = STAFF.a.id) {
  const h = returnHarness({ accept: true });
  await h.storeFingerprint();
  const r = await h.newDeal({ status });
  if (agent) h.commands.agents.set(r.s.id, agent);
  await h.run();
  h.clock.advance(60_000);
  return { h, ...r };
}

async function drag(h: ReturnType<typeof returnHarness>, dealId: number, by: number, to: string) {
  h.fake.actAs(by).moveStage(dealId, to);
  h.clock.advance(1_000);
  await h.run();
}

describe("accepted staff sales-stage moves", () => {
  it.each([
    ["contacted", "quoted"],
    ["quoted", "payment_pending"],
    ["contacted", "lost"],
    ["new", "contacted"],
  ] as const)("%s → %s by the inquiry's own agent is applied in OUTLYY via Bitrix24; no put-back", async (from, to) => {
    const { h, s, deal } = await accepting(from);
    await drag(h, deal.id, STAFF.a.bitrix, stageId(to as CrmStageKey));
    expect(h.book.get(s)!.inquiry!.status).toBe(to);
    const call = h.commands.calls.find((c) => c.op === "transition")!;
    expect(call).toMatchObject({ actor: STAFF.a.id, to, via: { channel: "bitrix24", bitrixUserId: STAFF.a.bitrix, dealId: deal.id } });
    // Owner answer 5: Lost without a reason is accepted as "other".
    if (to === "lost") expect(call.reason).toBe("other");
    expect(h.store.returnLinkOf(h.scope, s)!.revertCount).toBe(0);
    expect(h.commands.calls.filter((c) => c.op === "put_back")).toEqual([]);
    expect(h.deal(s).stageId).toBe(stageId(to as CrmStageKey));
  });

  it.each([
    ["an unmapped user", UNMAPPED_USER],
    ["a mapped agent on someone else's inquiry, without inquiries.assign", STAFF.b.bitrix],
    ["an inactive staff member", STAFF.off.bitrix],
  ] as const)("the same move by %s is put back; OUTLYY is unchanged", async (_label, by) => {
    const { h, s, deal } = await accepting("contacted");
    await drag(h, deal.id, by, stageId("quoted"));
    expect(h.book.get(s)!.inquiry!.status).toBe("contacted");
    expect(h.deal(s).stageId).toBe(stageId("contacted"));
    expect(h.commands.calls.filter((c) => c.op === "put_back")).toHaveLength(1);
    expect(h.store.timelineOf(h.scope, s).map((t) => t.kind)).toEqual(["move_refused"]);
  });

  it("a move on an inquiry with an order, or on a direct-checkout order, is put back", async () => {
    const { h, s, deal } = await accepting("quoted");
    const st = h.book.get(s)!;
    st.order = directOrderState(subjectId(), { status: "paid", authorised: true, capturedMinor: 25_000n }).order;
    h.commands.setStatus(s.id, "won");
    await h.run();
    h.clock.advance(60_000);
    await drag(h, deal.id, STAFF.lead.bitrix, stageId("lost"));
    expect(h.deal(s).stageId).toBe(stageId("paid_awaiting_supplier"));
    expect(h.commands.calls.filter((c) => c.op === "transition")).toEqual([]);

    const o: CrmSubject = { type: "order", id: subjectId() };
    h.put(directOrderState(o.id, { status: "paid", authorised: true, capturedMinor: 25_000n }));
    await h.run();
    h.clock.advance(60_000);
    await h.run();
    await drag(h, h.deal(o).id, STAFF.lead.bitrix, stageId("payment_pending"));
    expect(h.deal(o).stageId).toBe(stageId("paid_awaiting_supplier"));
    expect(h.commands.calls.filter((c) => c.op === "transition")).toEqual([]);
  });

  it("status negotiating with the deal on Quoted: no action either way", async () => {
    const { h, s, deal } = await accepting("negotiating");
    await drag(h, deal.id, STAFF.a.bitrix, stageId("quoted"));
    expect(h.commands.calls).toEqual([]);
    expect(h.book.get(s)!.inquiry!.status).toBe("negotiating");
  });

  it("the transition table drives every sales move: a move it forbids is put back, one it allows is applied (lead as mover)", async () => {
    const targets: Partial<Record<CrmStageKey, InquiryStatus>> = { contacted: "contacted", quoted: "quoted", payment_pending: "payment_pending", lost: "lost" };
    const froms = (Object.keys(TRANSITIONS) as InquiryStatus[]).filter((f) => f !== "won" && f !== "spam"); // won has an order; spam never creates a deal
    let checked = 0;
    for (const from of froms) {
      for (const [P, to] of Object.entries(targets) as [CrmStageKey, InquiryStatus][]) {
        const m = mapDeal(inquiryState(subjectId(), { status: from }), fakeConfig());
        if (!m.visible || m.stage === P) continue;
        const { h, s, deal } = await accepting(from, STAFF.lead.id);
        await drag(h, deal.id, STAFF.lead.bitrix, stageId(P));
        const allowed = canTransition(from, to);
        expect(h.book.get(s)!.inquiry!.status, `${from} → ${to}`).toBe(allowed ? to : from);
        expect(h.commands.calls.some((c) => c.op === "put_back"), `${from} → ${to}`).toBe(!allowed);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("Spam, Fulfilled and the integration stages are never accepted, whoever moves them", async () => {
    for (const P of ["spam", "fulfilled", "paid_awaiting_supplier", "cancelled", "refunded", "new_inquiry"] as CrmStageKey[]) {
      const { h, s, deal } = await accepting("contacted", STAFF.lead.id);
      await drag(h, deal.id, STAFF.lead.bitrix, stageId(P));
      expect(h.commands.calls.filter((c) => c.op === "transition" || c.op === "assign")).toEqual([]);
      expect(h.book.get(s)!.inquiry!.status).toBe("contacted");
    }
    expect(CRM_STAGE_KEYS).toHaveLength(12);
  });

  it("with CRM_RETURN_ACCEPT off every staff move is put back", async () => {
    const h = returnHarness({ accept: false });
    await h.storeFingerprint();
    const { s, deal } = await h.newDeal({ status: "contacted" });
    h.commands.agents.set(s.id, STAFF.a.id);
    await h.run();
    await drag(h, deal.id, STAFF.a.bitrix, stageId("quoted"));
    expect(h.book.get(s)!.inquiry!.status).toBe("contacted");
    expect(h.deal(s).stageId).toBe(stageId("contacted"));
  });

  it("a staff map naming an unknown staff id fails closed: no acceptance, put-backs continue, alert", async () => {
    const { h, s, deal } = await accepting("contacted");
    h.commands.staffRecords.delete(STAFF.b.id);
    await drag(h, deal.id, STAFF.a.bitrix, stageId("quoted"));
    expect(h.book.get(s)!.inquiry!.status).toBe("contacted");
    expect(h.store.findingsOf("crm_staff_map_invalid")).toHaveLength(1);
  });
});

describe("assignment, Bitrix24 → OUTLYY only", () => {
  it("a Bitrix24 owner change by the lead re-assigns the inquiry to the mapped staff member, via Bitrix24", async () => {
    const { h, s, deal } = await accepting("contacted", null);
    h.fake.actAs(STAFF.lead.bitrix).reassign(deal.id, STAFF.a.bitrix);
    h.clock.advance(1_000);
    await h.run();
    expect(h.commands.agents.get(s.id)).toBe(STAFF.a.id);
    expect(h.commands.calls.find((c) => c.op === "assign")).toMatchObject({ actor: STAFF.lead.id, agentId: STAFF.a.id, via: { bitrixUserId: STAFF.lead.bitrix, dealId: deal.id } });
    // OUTLYY never writes the owner back, and the next push leaves it alone.
    expect(h.deal(s).assignedById).toBe(STAFF.a.bitrix);
  });

  it("an agent taking an unassigned inquiry for themselves is a self-claim", async () => {
    const { h, s, deal } = await accepting("new", null);
    h.fake.actAs(STAFF.a.bitrix).reassign(deal.id, STAFF.a.bitrix);
    h.clock.advance(1_000);
    await h.run();
    expect(h.commands.agents.get(s.id)).toBe(STAFF.a.id);
    expect(h.book.get(s)!.inquiry!.status).toBe("assigned");
  });

  it("an owner change by a staff member without inquiries.assign changes nothing in OUTLYY and alerts; the deal owner is not written back", async () => {
    const { h, s, deal } = await accepting("contacted", STAFF.a.id);
    // Agent B takes agent A's inquiry for themselves: not a self-claim (it has an agent), and B lacks inquiries.assign.
    h.fake.actAs(STAFF.b.bitrix).reassign(deal.id, STAFF.b.bitrix);
    h.clock.advance(1_000);
    await h.run();
    expect(h.commands.agents.get(s.id)).toBe(STAFF.a.id);
    expect(h.store.findingsOf("crm_owner_change_refused")).toHaveLength(1);
    expect(h.deal(s).assignedById).toBe(STAFF.b.bitrix);
  });

  it("an owner outside the staff map: OUTLYY assigns its default owner and writes a fixed note; the Bitrix24 owner stays as set", async () => {
    const { h, s, deal } = await accepting("contacted", STAFF.a.id);
    h.fake.actAs(STAFF.lead.bitrix).reassign(deal.id, UNMAPPED_USER);
    h.clock.advance(1_000);
    await h.run();
    expect(h.commands.agents.get(s.id)).toBe(STAFF.lead.id);
    expect(h.commands.calls.find((c) => c.op === "assign")).toMatchObject({ actor: "system", agentId: STAFF.lead.id });
    expect(h.store.timelineOf(h.scope, s).map((t) => t.kind)).toEqual(["owner_unmapped"]);
    expect(h.deal(s).assignedById).toBe(UNMAPPED_USER);
    // Alert only on a repeat.
    const [f] = h.store.findingsOf("crm_owner_unmapped");
    expect(f.raisedAt.getTime()).toBe(0);
  });

  it("a closed inquiry keeps its agent; the owner is only recorded", async () => {
    const { h, s, deal } = await accepting("lost", STAFF.a.id);
    h.fake.actAs(STAFF.lead.bitrix).reassign(deal.id, STAFF.b.bitrix);
    h.clock.advance(1_000);
    await h.run();
    expect(h.commands.calls.filter((c) => c.op === "assign")).toEqual([]);
    expect(h.store.returnLinkOf(h.scope, s)!.crmSeenOwnerId).toBe(STAFF.b.bitrix);
  });

  it("a deal dragged to Assigned with a mapped owner on a new inquiry is an assignment to that owner", async () => {
    const { h, s, deal } = await accepting("new", null);
    h.fake.actAs(STAFF.lead.bitrix).reassign(deal.id, STAFF.a.bitrix);
    await drag(h, deal.id, STAFF.lead.bitrix, stageId("assigned"));
    expect(h.commands.agents.get(s.id)).toBe(STAFF.a.id);
    expect(h.book.get(s)!.inquiry!.status).toBe("assigned");
    expect(h.commands.calls.filter((c) => c.op === "put_back")).toEqual([]);
  });

  it("new deals still go to the default sales lead, whoever OUTLYY routed the inquiry to; a push never carries the owner", async () => {
    const h = returnHarness({ accept: true });
    await h.storeFingerprint();
    const s: CrmSubject = { type: "inquiry", id: subjectId() };
    h.commands.agents.set(s.id, STAFF.a.id);
    h.put(inquiryState(s.id, { status: "assigned" }));
    await h.run();
    expect(h.deal(s).assignedById).toBe(Number(FAKE_OWNER));
    const mapped = mapDeal(inquiryState(s.id), fakeConfig());
    if (!mapped.visible) throw new Error("not visible");
    expect(mapped.fields).not.toHaveProperty("assignedById");
    // The payload guard refuses an owner on update.
    expect(() => assertSafeCrmPayload({ ...mapped.fields, assignedById: Number(FAKE_OWNER) }, mapped.rows, fakeConfig())).toThrow(CrmCallError);
  });
});
