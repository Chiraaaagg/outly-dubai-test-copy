import { describe, expect, it } from "vitest";
import { twinCommentText } from "@/server/crm/crm.reconcile";
import { STAFF, UNMAPPED_USER, returnHarness } from "./_return-harness";

/**
 * Owner answers of 25 November 2026 to the C3ab open points: the fixed twin
 * text; reopening a Lost inquiry from Bitrix24 exactly per OUTLYY's own
 * transition rules and permissions, "via Bitrix24"; the unmapped-owner rule
 * only for a change made by a mapped staff member.
 */

async function accepting(status: string, agent: string | null) {
  const h = returnHarness({ accept: true });
  await h.storeFingerprint();
  const r = await h.newDeal({ status });
  if (agent) h.commands.agents.set(r.s.id, agent);
  await h.run();
  h.clock.advance(60_000);
  return { h, ...r };
}

describe("owner answers, 25 November 2026", () => {
  it("the twin comment is exactly the owner's text, naming the linked deal", () => {
    expect(twinCommentText(812)).toBe("Duplicate of deal 812. Move any notes to deal 812, then delete this copy.");
  });

  it("a lead reopens a Lost inquiry by dragging it to Contacted: applied via Bitrix24", async () => {
    const { h, s, deal } = await accepting("lost", STAFF.lead.id);
    h.fake.actAs(STAFF.lead.bitrix).moveStage(deal.id, "C7:CONTACTED");
    h.clock.advance(1_000);
    await h.run();
    expect(h.book.get(s)!.inquiry!.status).toBe("contacted");
    expect(h.commands.calls.find((c) => c.op === "transition")).toMatchObject({ actor: STAFF.lead.id, to: "contacted", via: { channel: "bitrix24", bitrixUserId: STAFF.lead.bitrix, dealId: deal.id } });
    expect(h.deal(s).stageId).toBe("C7:CONTACTED");
  });

  it("an agent without inquiries.assign cannot reopen a Lost inquiry, even their own: put back", async () => {
    const { h, s, deal } = await accepting("lost", STAFF.a.id);
    h.fake.actAs(STAFF.a.bitrix).moveStage(deal.id, "C7:CONTACTED");
    h.clock.advance(1_000);
    await h.run();
    expect(h.book.get(s)!.inquiry!.status).toBe("lost");
    expect(h.deal(s).stageId).toBe("C7:LOST");
  });

  it("an owner set to an unmapped user by a mapped staff member: the default owner gets the inquiry", async () => {
    const { h, s, deal } = await accepting("contacted", STAFF.a.id);
    h.fake.actAs(STAFF.b.bitrix).reassign(deal.id, UNMAPPED_USER);
    h.clock.advance(1_000);
    await h.run();
    expect(h.commands.agents.get(s.id)).toBe(STAFF.lead.id);
  });

  it.each([
    ["an unmapped Bitrix24 user", UNMAPPED_USER],
    ["a mapped but inactive staff member", STAFF.off.bitrix],
  ])("the same change by %s alerts and changes nothing", async (_label, by) => {
    const { h, s, deal } = await accepting("contacted", STAFF.a.id);
    h.fake.actAs(by).reassign(deal.id, 77);
    h.clock.advance(1_000);
    await h.run();
    expect(h.commands.agents.get(s.id)).toBe(STAFF.a.id);
    expect(h.commands.calls.filter((c) => c.op === "assign")).toEqual([]);
    expect(h.store.findingsOf("crm_owner_change_refused")).toHaveLength(1);
    expect(h.store.timelineOf(h.scope, s)).toEqual([]);
    expect(h.deal(s).assignedById).toBe(77);
  });
});
