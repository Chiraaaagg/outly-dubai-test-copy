import { describe, expect, it } from "vitest";
import { BitrixRestClient, CrmCallError, stageKind } from "@/server/crm/bitrix.client";
import { FakeBitrix24 } from "./_bitrix-fake";
import { FAKE_HOST, FAKE_SECRET, FAKE_USER, FakeClock, fakeConfig, fieldCode } from "./_memory-store";

/**
 * The return path reads of the Bitrix24 client (C3ab, doc 29e §3.2, §7,
 * §8): the changed-since poll with the OUTLYY fields, the sweep's funnel
 * list, and the three fingerprint reads, each checked again in code.
 */

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fixture() {
  const clock = new FakeClock();
  const fake = new FakeBitrix24({ host: FAKE_HOST, userId: FAKE_USER, secret: FAKE_SECRET, now: clock.ms });
  const client = new BitrixRestClient(fakeConfig(), { fetchImpl: fake.fetch, now: clock.ms });
  return { clock, fake, client };
}

describe("return path reads", () => {
  it("the poll returns the funnel's deals changed at or after a time, oldest change first, with stamps and OUTLYY fields", async () => {
    const { clock, fake, client } = fixture();
    const a = fake.seedDeal({ originId: "inq:a", [fieldCode("payment_status")]: "paid" });
    clock.advance(5_000);
    const b = fake.seedDeal({ originId: "inq:b" });
    fake.seedDeal({ originId: "inq:c", categoryId: 0 });
    clock.advance(5_000);
    fake.actAs(31).moveStage(a.id, "C7:QUOTED");
    const r = await client.listChangedDeals({ since: new Date(clock.ms() - 6_000) });
    expect(r.more).toBe(false);
    expect(r.items.map((i) => i.id)).toEqual([b.id, a.id]);
    expect(r.items[1]).toMatchObject({ stageId: "C7:QUOTED", updatedBy: 31, movedBy: 31, categoryId: 7 });
    expect(Date.parse(r.items[1].updatedTime!)).toBe(Math.floor(clock.ms() / 1000) * 1000);
    expect(r.items[1].uf[fieldCode("payment_status")]).toBe("paid");
  });

  it("pages at 50 and says when there is more; one second is drained by id; a missing movedBy is null; numbers sent as strings are read", async () => {
    const { clock, fake, client } = fixture();
    for (let i = 0; i < 60; i++) fake.seedDeal({ originId: `inq:${i}` });
    fake.omitMovedBy = true;
    fake.stringNumbers = true;
    const first = await client.listChangedDeals({ since: new Date(clock.ms() - 60_000) });
    expect(first.items).toHaveLength(50);
    expect(first.more).toBe(true);
    expect(first.items[0]).toMatchObject({ movedBy: null, updatedBy: Number(FAKE_USER) });
    const second = await client.listChangedDeals({ at: new Date(clock.ms()), afterId: first.items[49].id });
    expect(second.items).toHaveLength(10);
    expect(second.more).toBe(false);
    const some = await client.readDeals([first.items[0].id, second.items[9].id, 99_999]);
    expect(some.map((d) => d.id)).toEqual([first.items[0].id, second.items[9].id]);
  });

  it("a deal of another funnel in the answer is dropped (the filter is the provider's)", async () => {
    const c = new BitrixRestClient(fakeConfig(), {
      fetchImpl: async () => json(200, { result: { items: [{ id: 5, categoryId: 0, updatedTime: "2026-11-22T08:00:00+00:00" }, { id: 6, categoryId: 7, updatedTime: "2026-11-22T08:00:00+00:00" }] } }),
    });
    expect((await c.listChangedDeals({ since: new Date(0) })).items.map((i) => i.id)).toEqual([6]);
    expect((await c.listFunnelDeals(0)).items.map((i) => i.id)).toEqual([6]);
  });

  it("profile keeps the id and the administrator flag only", async () => {
    const { fake, client } = fixture();
    const p = await client.readProfile();
    expect(p).toEqual({ userId: Number(FAKE_USER), admin: false });
    expect(JSON.stringify(p)).not.toContain("Sync");
    fake.admin = true;
    expect((await client.readProfile()).admin).toBe(true);
    const bad = new BitrixRestClient(fakeConfig(), { fetchImpl: async () => json(200, { result: { ID: "17" } }) });
    await expect(bad.readProfile()).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("the category read: the funnel, or null when the portal has none", async () => {
    const { fake, client } = fixture();
    expect(await client.readCategory()).toEqual({ id: 7, name: "OUTLYY", entityTypeId: 2 });
    fake.categories.delete(7);
    expect(await client.readCategory()).toBeNull();
  });

  it("the stage list with each stage's kind, in either encoding; more than one page is refused", async () => {
    const { client } = fixture();
    const stages = await client.listStages();
    expect(stages).toHaveLength(12);
    expect(stages.find((s) => s.statusId === "C7:FULFILLED")!.kind).toBe("success");
    expect(stages.find((s) => s.statusId === "C7:LOST")!.kind).toBe("failure");
    expect(stageKind({ EXTRA: { SEMANTICS: "process" } })).toBe("process");
    expect(stageKind({ EXTRA: { SEMANTICS: "apology" } })).toBe("failure");
    expect(stageKind({})).toBe("unknown");
    const paged = new BitrixRestClient(fakeConfig(), { fetchImpl: async () => json(200, { result: [], next: 50 }) });
    await expect(paged.listStages()).rejects.toBeInstanceOf(CrmCallError);
  });
});
