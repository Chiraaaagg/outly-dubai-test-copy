import { describe, expect, it } from "vitest";
import { BitrixRestClient, type DealFields } from "@/server/crm/bitrix.client";
import { CRM_FIELD_KEYS } from "@/server/crm/crm.config";
import { originIdFor } from "@/server/crm/crm.mapping";
import { deleteCrmProbe, PROBE_SUBJECT, runCrmProbe, sameValue } from "@/server/crm/crm.probe";
import { FakeBitrix24 } from "./_bitrix-fake";
import { FAKE_HOST, FAKE_SECRET, FAKE_USER, FakeClock, fakeConfig, fieldCode } from "./_memory-store";

/**
 * The synthetic probe (review C2A-01, doc 29d §5.2a): one made-up subject
 * through the real mapping, guard and client, every OUTLYY field read back.
 * Against the strict fake portal; synthetic data only.
 */

function harness() {
  const clock = new FakeClock();
  const config = fakeConfig();
  const fake = new FakeBitrix24({ host: FAKE_HOST, userId: FAKE_USER, secret: FAKE_SECRET, now: clock.ms });
  const port = new BitrixRestClient(config, { fetchImpl: fake.fetch, now: clock.ms });
  return { clock, config, fake, port };
}

describe("CRM synthetic probe", () => {
  it("creates one synthetic deal and reads all 20 fields back as sent", async () => {
    const h = harness();
    const r = await runCrmProbe({ config: h.config, port: h.port, now: h.clock.now });
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    expect(Object.keys(r.fields).sort()).toEqual([...CRM_FIELD_KEYS].sort());
    expect(Object.values(r.fields).every((s) => s === "ok")).toBe(true);
    const deal = h.fake.dealsFor(originIdFor(PROBE_SUBJECT));
    expect(deal).toHaveLength(1);
    expect(deal[0]).toMatchObject({ categoryId: 7, title: "OUTLYY OUT-0000000", [fieldCode("customer_name")]: "OUTLYY Test Customer" });
    // The answer carries statuses only, never a value.
    expect(JSON.stringify(r)).not.toContain("example.invalid");
  });

  it("a second run updates the same deal; no twin", async () => {
    const h = harness();
    await runCrmProbe({ config: h.config, port: h.port, now: h.clock.now });
    h.clock.advance(60_000);
    const r = await runCrmProbe({ config: h.config, port: h.port, now: h.clock.now });
    expect(r).toMatchObject({ ok: true, created: false });
    expect(h.fake.dealsFor(originIdFor(PROBE_SUBJECT))).toHaveLength(1);
  });

  it("names a field the portal did not keep", async () => {
    const h = harness();
    // A portal that silently drops one field (the failure the probe exists to catch).
    const dropping = {
      ...h.port,
      findDealsByOrigin: h.port.findDealsByOrigin.bind(h.port),
      updateDeal: h.port.updateDeal.bind(h.port),
      setProductRows: h.port.setProductRows.bind(h.port),
      readDealFields: h.port.readDealFields.bind(h.port),
      deleteDeal: h.port.deleteDeal.bind(h.port),
      addDeal: (f: DealFields) => h.port.addDeal({ ...f, [fieldCode("margin")]: "", [fieldCode("reference")]: "OUT-0000001" }),
    };
    const r = await runCrmProbe({ config: h.config, port: dropping, now: h.clock.now });
    expect(r.ok).toBe(false);
    expect(r.fields.reference).toBe("different");
    // R-01: margin is sent non-empty, so a dropped margin write shows.
    expect(r.fields.margin).toBe("different");
    expect(r.fields.customer_name).toBe("ok");
    const missing = { ...dropping, readDealFields: async () => ({}) };
    expect(Object.values((await runCrmProbe({ config: h.config, port: missing, now: h.clock.now })).fields).every((s) => s === "missing")).toBe(true);
  });

  it("every field carries a distinct non-empty value, so any swap of two field codes shows (R-01)", async () => {
    const h = harness();
    await runCrmProbe({ config: h.config, port: h.port, now: h.clock.now });
    const deal = h.fake.dealsFor(originIdFor(PROBE_SUBJECT))[0];
    const values = CRM_FIELD_KEYS.map((k) => deal[fieldCode(k)]);
    expect(values.every((v) => v !== "" && v !== null && v !== undefined)).toBe(true);
    // Y and N are the only repeat-free pair of flags; every other value is unique.
    const others = CRM_FIELD_KEYS.filter((k) => k !== "consent_marketing_email" && k !== "consent_marketing_whatsapp").map((k) => JSON.stringify(deal[fieldCode(k)]));
    expect(new Set(others).size).toBe(others.length);
    expect(deal[fieldCode("consent_marketing_email")]).not.toBe(deal[fieldCode("consent_marketing_whatsapp")]);
    // Swap every pair on the way in: both sides of each pair read back as different.
    for (let i = 0; i < CRM_FIELD_KEYS.length; i++) {
      for (let j = i + 1; j < CRM_FIELD_KEYS.length; j++) {
        const [a, b] = [fieldCode(CRM_FIELD_KEYS[i]), fieldCode(CRM_FIELD_KEYS[j])];
        const swapped = { ...h.port, findDealsByOrigin: async () => [], setProductRows: async () => {}, deleteDeal: async () => "deleted" as const, addDeal: async () => ({ id: 1 }), updateDeal: async () => {} };
        const read = { ...Object.fromEntries(CRM_FIELD_KEYS.map((k) => [fieldCode(k), deal[fieldCode(k)]])), [a]: deal[b], [b]: deal[a] };
        const r = await runCrmProbe({ config: h.config, port: { ...swapped, readDealFields: async () => read }, now: h.clock.now });
        expect([r.fields[CRM_FIELD_KEYS[i]], r.fields[CRM_FIELD_KEYS[j]]], `${a}<->${b}`).toEqual(["different", "different"]);
      }
    }
  });

    it("compares the portal's own encodings", () => {
    expect(sameValue(1, "1.00")).toBe(true);
    expect(sameValue("Y", true)).toBe(true);
    expect(sameValue("N", "N")).toBe(true);
    expect(sameValue("N", true)).toBe(false);
    expect(sameValue("", null)).toBe(true);
    expect(sameValue("", "x")).toBe(false);
    expect(sameValue("2026-11-24T10:00:00+00:00", "2026-11-24T14:00:00+04:00")).toBe(true);
    expect(sameValue("2026-12-01", "2026-12-01T00:00:00+04:00")).toBe(true);
    expect(sameValue("INQ-0000000", "INQ-0000001")).toBe(false);
  });

  it("delete removes the probe deal only, through the delete guard", async () => {
    const h = harness();
    await runCrmProbe({ config: h.config, port: h.port, now: h.clock.now });
    const other = h.fake.seedDeal({ originId: "inq:00000000-0000-7000-8000-000000000123" });
    const foreign = h.fake.seedDeal({ originId: originIdFor(PROBE_SUBJECT), originatorId: "outlyy-production" });
    expect(await deleteCrmProbe({ config: h.config, port: h.port })).toEqual({ deleted: 1 });
    expect(h.fake.dealsFor(originIdFor(PROBE_SUBJECT)).map((d) => d.id)).toEqual([foreign.id]);
    expect(h.fake.deals.has(other.id)).toBe(true);
  });
});
