import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableDb, cleanupPeople, createStaff, dbEnabled, runId, syntheticPhone, type StaffFixture } from "@/server/__tests__/helpers/fixtures";
import { cleanupBusinessRows, db, forbidNetwork, makeInquiry, publishedProduct, type SeedProduct } from "@/server/__tests__/security/_mercury-fixtures";
import type { CrmStaffActor, CrmVia } from "@/server/crm/crm.reconcile";

/**
 * The real `crmReturnCommands` (CRM batch C3ab; review C3-08) against the
 * inquiry service on the disposable database, with synthetic staff of
 * several roles: the actor is built only for an active staff member with
 * two-factor; a move or an assignment is decided by OUTLYY's own rules and
 * that person's own permissions (a claim needs `inquiries.claim`, any other
 * assignment `inquiries.assign`, review C3-01); the event and the audit row
 * say "via Bitrix24"; a refusal comes back as a short code; a put-back
 * writes a system audit row and a system inquiry event. No CRM portal is
 * involved (no portal is configured: nothing is enqueued).
 */

type Prisma = Awaited<ReturnType<typeof db>>;
const run = runId();
let prisma: Prisma;
let product: SeedProduct;
const staff: Record<"agent" | "lead" | "content" | "suspended" | "noTotp", StaffFixture> = {} as never;

const via = (dealId: number): CrmVia => ({ channel: "bitrix24", bitrixUserId: 31, dealId });

describe.skipIf(!dbEnabled)("CRM return path commands on the real inquiry service (C3ab)", () => {
  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    prisma = await db();
    product = await publishedProduct();
    staff.agent = await createStaff(run, "ret-agent", ["agent"]);
    staff.lead = await createStaff(run, "ret-lead", ["agent_lead"]);
    staff.content = await createStaff(run, "ret-content", ["content"]);
    staff.suspended = await createStaff(run, "ret-suspended", ["agent_lead"], { status: "suspended" });
    staff.noTotp = await createStaff(run, "ret-nototp", ["agent_lead"], { totpEnabled: false });
  });

  afterAll(async () => {
    if (!dbEnabled) return;
    await cleanupBusinessRows(run);
    await cleanupPeople(run);
  });

  async function cmds() {
    return (await import("@/server/crm/crm.return.commands")).crmReturnCommands;
  }

  it("builds an actor only for an active staff member with two-factor; knows which ids are staff", async () => {
    const c = await cmds();
    expect(await c.staff(staff.agent.id)).not.toBeNull();
    expect(await c.staff(staff.suspended.id)).toBeNull();
    expect(await c.staff(staff.noTotp.id)).toBeNull();
    expect(await c.staff("00000000-0000-4000-8000-00000000dead")).toBeNull();
    const known = await c.existingStaff([staff.agent.id, staff.suspended.id, "00000000-0000-4000-8000-00000000dead"]);
    expect([...known].sort()).toEqual([staff.agent.id, staff.suspended.id].sort());
  });

  it("a legal move by the inquiry's own agent is applied, with via Bitrix24 on the event and the audit row", async () => {
    const c = await cmds();
    const q = await makeInquiry(run, { leadPhone: syntheticPhone(run, 41), product, assignedAgentId: staff.agent.id, status: "contacted" });
    const actor = (await c.staff(staff.agent.id)) as CrmStaffActor;
    expect(await c.transition(actor, q.id, "quoted", via(5001), {})).toEqual({ ok: true });
    expect((await prisma.inquiry.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("quoted");
    const ev = await prisma.inquiryEvent.findFirstOrThrow({ where: { inquiryId: q.id, kind: "status", toStatus: "quoted" } });
    expect(ev).toMatchObject({ actorId: staff.agent.id, meta: { via: "bitrix24", bitrixUserId: 31, dealId: 5001 } });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: q.id, action: "inquiry.transition" }, orderBy: { createdAt: "desc" } });
    expect(audit.after).toMatchObject({ status: "quoted", via: "bitrix24", bitrixUserId: 31, dealId: 5001 });
    // Lost with the reason "other" (owner answer 5).
    expect(await c.transition(actor, q.id, "lost", via(5001), { reason: "other" })).toEqual({ ok: true });
    expect((await prisma.inquiry.findUniqueOrThrow({ where: { id: q.id } })).lostReason).toBe("other");
  });

  it("refusals come back as codes: another agent's inquiry, a forbidden transition, won", async () => {
    const c = await cmds();
    const q = await makeInquiry(run, { leadPhone: syntheticPhone(run, 42), product, assignedAgentId: staff.lead.id, status: "contacted" });
    const agent = (await c.staff(staff.agent.id)) as CrmStaffActor;
    const lead = (await c.staff(staff.lead.id)) as CrmStaffActor;
    expect(await c.transition(agent, q.id, "quoted", via(5002), {})).toEqual({ ok: false, code: "forbidden" });
    expect(await c.transition(lead, q.id, "payment_pending", via(5002), {})).toEqual({ ok: false, code: "invalid_transition" });
    expect(await c.transition(lead, q.id, "won", via(5002), {})).toMatchObject({ ok: false });
    expect((await prisma.inquiry.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("contacted");
  });

  it("a claim needs inquiries.claim; any other assignment needs inquiries.assign; the system actor may assign", async () => {
    const c = await cmds();
    const q = await makeInquiry(run, { leadPhone: syntheticPhone(run, 43), product, status: "new" });
    const content = (await c.staff(staff.content.id)) as CrmStaffActor;
    const agent = (await c.staff(staff.agent.id)) as CrmStaffActor;
    expect(await c.assign(content, q.id, staff.content.id, via(5003), "Reassigned in Bitrix24")).toEqual({ ok: false, code: "forbidden" });
    expect(await c.assign(agent, q.id, staff.lead.id, via(5003), "Reassigned in Bitrix24")).toEqual({ ok: false, code: "forbidden" });
    expect(await c.assign(agent, q.id, staff.agent.id, via(5003), "Reassigned in Bitrix24")).toEqual({ ok: true });
    expect((await prisma.inquiry.findUniqueOrThrow({ where: { id: q.id } })).assignedAgentId).toBe(staff.agent.id);
    const ev = await prisma.inquiryEvent.findFirstOrThrow({ where: { inquiryId: q.id, kind: "assignment" }, orderBy: { createdAt: "desc" } });
    expect(ev.meta).toMatchObject({ via: "bitrix24", dealId: 5003 });
    expect(await c.assign("system", q.id, staff.lead.id, via(5003), "The Bitrix24 owner is not an OUTLYY staff member")).toEqual({ ok: true });
    expect((await prisma.inquiry.findUniqueOrThrow({ where: { id: q.id } })).assignedAgentId).toBe(staff.lead.id);
    // A target who cannot receive inquiries is refused by the service.
    expect(await c.assign("system", q.id, staff.suspended.id, via(5003), "x")).toEqual({ ok: false, code: "validation_failed" });
  });

  it("a put-back writes a system audit row and a system inquiry event, ids and keys only", async () => {
    const c = await cmds();
    const q = await makeInquiry(run, { leadPhone: syntheticPhone(run, 44), product, status: "contacted" });
    await c.recordPutBack({ type: "inquiry", id: q.id }, { what: "stage", dealId: 5004, bitrixUserId: 31, from: "contacted", to: "paid_awaiting_supplier" });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: q.id, action: "crm.stage_reverted" } });
    expect(audit).toMatchObject({ actorType: "system", after: { via: "bitrix24", dealId: 5004, bitrixUserId: 31, from: "contacted", to: "paid_awaiting_supplier" } });
    const ev = await prisma.inquiryEvent.findFirstOrThrow({ where: { inquiryId: q.id, kind: "system" } });
    expect(ev).toMatchObject({ actorType: "system", meta: { dealId: 5004, from: "contacted" } });
    await c.recordPutBack({ type: "inquiry", id: q.id }, { what: "drift", dealId: 5004, bitrixUserId: null, fields: ["title"] });
    expect(await prisma.auditLog.count({ where: { entityId: q.id, action: "crm.drift_pushed" } })).toBe(1);
    const facts = await c.inquiry(q.id);
    expect(facts).toEqual({ status: "contacted", assignedAgentId: null, hasOrder: false });
  });
});
