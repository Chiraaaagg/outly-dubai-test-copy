import { describe, expect, it } from "vitest";
import { BITRIX_METHODS, BitrixRestClient, classify, CrmCallError, isOwnEcho, type DealFields } from "@/server/crm/bitrix.client";
import { FakeBitrix24 } from "./_bitrix-fake";
import { FAKE_HOST, FAKE_SECRET, FAKE_USER, FakeClock, fakeConfig } from "./_memory-store";

/**
 * The Bitrix24 adapter (doc 29 §5.2, §6.5): deal methods only, the pinned
 * host over https with redirects refused, Zod-checked answers, short error
 * codes, and the webhook secret nowhere but the request URL.
 */

const fields: DealFields = {
  title: "OUTLYY INQ-1048213",
  categoryId: 7,
  stageId: "C7:NEW_INQUIRY",
  opportunity: 0,
  currencyId: "AED",
  isManualOpportunity: "Y",
  originatorId: "outlyy-staging",
  originId: "inq:00000000-0000-7000-8000-000000000001",
};

function client(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  return new BitrixRestClient(fakeConfig(), { fetchImpl });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Bitrix24 client", () => {
  it("allows the five deal methods, the timeline comment and the three C3ab fingerprint reads only: no contact, lead, duplicate, task or batch method", () => {
    expect([...BITRIX_METHODS]).toEqual(["crm.item.list", "crm.item.add", "crm.item.update", "crm.item.delete", "crm.item.productrow.set", "crm.timeline.comment.add", "profile", "crm.category.get", "crm.status.list"]);
    for (const m of BITRIX_METHODS) expect(m).not.toMatch(/contact|lead|duplicate|task|batch|user/);
    // C2b (decision C2-11): the one timeline method adds a comment; it can neither read, change nor delete one.
    expect(BITRIX_METHODS.filter((m) => m.includes("timeline"))).toEqual(["crm.timeline.comment.add"]);
  });

  it("posts JSON to the pinned host's webhook URL, refuses redirects, and checks the answer", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const c = client(async (url, init) => {
      seen.push({ url, init });
      return json(200, { result: { item: { id: 501 } } });
    });
    expect(await c.addDeal(fields)).toEqual({ id: 501 });
    const u = new URL(seen[0].url);
    expect(u.hostname).toBe(FAKE_HOST);
    expect(u.pathname).toBe(`/rest/${FAKE_USER}/${FAKE_SECRET}/crm.item.add.json`);
    expect(seen[0].init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ entityTypeId: 2, useOriginalUfNames: "Y", fields });
  });

  it("reads one deal by id in the OUTLYY funnel only, and re-checks the answer (the delete guard's read)", async () => {
    let body: Record<string, unknown> = {};
    const answer = (items: unknown[]) =>
      client(async (_url, init) => {
        body = JSON.parse(String(init.body));
        return json(200, { result: { items } });
      });
    const row = { id: 5, originatorId: null, originId: null, categoryId: 7, updatedBy: 23 };
    expect(await answer([row]).findDealById(5)).toEqual(row);
    expect(body).toMatchObject({ entityTypeId: 2, filter: { "=id": 5, "=categoryId": 7 } });
    // A provider that ignored the filter: a deal of another funnel, or another id, is not ours.
    expect(await answer([{ ...row, categoryId: 0 }]).findDealById(5)).toBeNull();
    expect(await answer([{ ...row, id: 6 }]).findDealById(5)).toBeNull();
    expect(await answer([]).findDealById(5)).toBeNull();
  });

  it("sends custom fields under their original UF_CRM_ codes: add and update pass useOriginalUfNames=Y (C2A-01)", async () => {
    const bodies: Record<string, unknown>[] = [];
    const c = client(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return json(200, { result: { item: { id: 7 } } });
    });
    const withUf = { ...fields, UF_CRM_REFERENCE: "INQ-1048213" } as DealFields;
    await c.addDeal(withUf);
    await c.updateDeal(7, withUf);
    expect(bodies.map((b) => b.useOriginalUfNames)).toEqual(["Y", "Y"]);
    expect(bodies.every((b) => (b.fields as Record<string, unknown>).UF_CRM_REFERENCE === "INQ-1048213")).toBe(true);
  });

  it("the fake portal refuses a field that would not land: no flag, an unknown name, a camelCase name, a bad date-time or Yes/No (C2A-01)", async () => {
    const fake = new FakeBitrix24({ host: FAKE_HOST, userId: FAKE_USER, secret: FAKE_SECRET, now: () => 0 });
    const post = async (method: string, body: Record<string, unknown>) => {
      const res = await fake.fetch(`https://${FAKE_HOST}/rest/${FAKE_USER}/${FAKE_SECRET}/${method}.json`, { method: "POST", body: JSON.stringify(body) });
      return res.status;
    };
    const add = (f: Record<string, unknown>, flag: string | null = "Y") => post("crm.item.add", { entityTypeId: 2, ...(flag !== null ? { useOriginalUfNames: flag } : {}), fields: { ...fields, ...f } });
    expect(await add({ UF_CRM_REFERENCE: "INQ-1048213" })).toBe(200);
    expect(await add({ UF_CRM_REFERENCE: "INQ-1048213" }, null)).toBe(400);
    expect(await add({ UF_CRM_REFERENCE: "INQ-1048213" }, "N")).toBe(400);
    expect(await add({ ufCrmReference: "INQ-1048213" })).toBe(400);
    expect(await add({ UF_CRM_NOT_ON_PORTAL: "x" })).toBe(400);
    expect(await add({ UF_CRM_AS_OF: "2026-11-24T10:00:00.000Z" })).toBe(400);
    expect(await add({ UF_CRM_AS_OF: "2026-11-24T10:00:00+00:00" })).toBe(200);
    expect(await add({ UF_CRM_CONSENT_MARKETING_EMAIL: "true" })).toBe(400);
    expect(await add({ UF_CRM_CONSENT_MARKETING_EMAIL: "N" })).toBe(200);
  });

  it("searches by originator, origin id and funnel, and re-checks the answer", async () => {
    let body: Record<string, unknown> = {};
    const c = client(async (_url, init) => {
      body = JSON.parse(String(init.body));
      return json(200, {
        result: {
          items: [
            { id: 9, originatorId: "outlyy-staging", originId: fields.originId, categoryId: 7, updatedBy: 17 },
            { id: 3, originatorId: "outlyy-staging", originId: fields.originId, categoryId: 7, updatedBy: 17 },
            { id: 4, originatorId: "someone-else", originId: fields.originId, categoryId: 7, updatedBy: 2 },
          ],
        },
      });
    });
    const found = await c.findDealsByOrigin("outlyy-staging", fields.originId);
    expect(found.map((d) => d.id)).toEqual([3, 9]);
    expect(body).toMatchObject({ entityTypeId: 2, filter: { "=originatorId": "outlyy-staging", "=originId": fields.originId, "=categoryId": 7 } });
  });

  it.each([
    [503, { error: "QUERY_LIMIT_EXCEEDED", error_description: "Too many requests" }, "throttled", "throttled:QUERY_LIMIT_EXCEEDED"],
    [429, { error: "OPERATION_TIME_LIMIT" }, "throttled", "throttled:OPERATION_TIME_LIMIT"],
    [401, { error: "INVALID_CREDENTIALS" }, "auth", "auth:INVALID_CREDENTIALS"],
    [403, { error: "insufficient_scope" }, "auth", "auth:insufficient_scope"],
    [400, { error: "NOT_FOUND" }, "not_found", "not_found:NOT_FOUND"],
    [500, { error: "INTERNAL_SERVER_ERROR" }, "unavailable", "unavailable:INTERNAL_SERVER_ERROR"],
    [400, { error: "INVALID_ARG_VALUE", error_description: "a provider message with a phone +97140000000" }, "rejected", "rejected:INVALID_ARG_VALUE"],
    [200, { result: { unexpected: true } }, "invalid_response", "invalid_response:schema"],
  ])("classifies HTTP %s %j as %s, keeping only a short code", async (status, body, kind, code) => {
    const c = client(async () => json(status, body));
    const e = await c.updateDeal(5, fields).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(CrmCallError);
    expect(e).toMatchObject({ kind, code });
    expect(String((e as Error).message)).not.toContain("+9714");
  });

  it("a network failure or timeout is unavailable; only a write may have happened", async () => {
    const c = client(async () => {
      throw new TypeError(`fetch failed for https://${FAKE_HOST}/rest/${FAKE_USER}/${FAKE_SECRET}/crm.item.add.json`);
    });
    const add = await c.addDeal(fields).then(() => null, (x: CrmCallError) => x);
    expect(add).toMatchObject({ kind: "unavailable", code: "unavailable:network", writeMayHaveHappened: true });
    expect(add!.message).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(add)).not.toContain(FAKE_SECRET);
    const list = await c.findDealsByOrigin("outlyy-staging", fields.originId).then(() => null, (x: CrmCallError) => x);
    expect(list).toMatchObject({ kind: "unavailable", writeMayHaveHappened: false });
    const t = client(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await t.addDeal(fields).then(() => null, (x: CrmCallError) => x.code)).toBe("unavailable:timeout");
  });

  it("a redirect is refused and never read", async () => {
    const c = client(async () => {
      const r = json(200, { result: { item: { id: 1 } } });
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    });
    expect(await c.addDeal(fields).then(() => null, (x: CrmCallError) => x.code)).toBe("refused:redirect");
  });

  it("refuses a portal host that would send the request elsewhere", async () => {
    const calls: string[] = [];
    const c = new BitrixRestClient({ ...fakeConfig(), portal: `${FAKE_HOST}@evil.example` }, { fetchImpl: async (u) => (calls.push(u), json(200, {})) });
    expect(await c.addDeal(fields).then(() => null, (x: CrmCallError) => x.code)).toBe("refused:host");
    expect(calls).toEqual([]);
  });

  it("delete answers not_found for a record already gone", async () => {
    const clock = new FakeClock();
    const fake = new FakeBitrix24({ host: FAKE_HOST, userId: FAKE_USER, secret: FAKE_SECRET, now: clock.ms });
    const c = new BitrixRestClient(fakeConfig(), { fetchImpl: fake.fetch });
    const d = fake.seedDeal({ originId: fields.originId });
    expect(await c.deleteDeal(d.id)).toBe("deleted");
    expect(await c.deleteDeal(d.id)).toBe("not_found");
  });

  it("reports each call with method, status, duration and outcome only", async () => {
    const events: unknown[] = [];
    const c = new BitrixRestClient(fakeConfig(), { fetchImpl: async () => json(200, { result: { productRows: [] } }), onCall: (e) => events.push(e) });
    await c.setProductRows(5, []);
    expect(events).toEqual([{ method: "crm.item.productrow.set", status: 200, durationMs: expect.any(Number), outcome: "ok" }]);
  });

  it("classify: throttle codes win over status; auth by code or status", () => {
    expect(classify(400, "QUERY_LIMIT_EXCEEDED")).toBe("throttled");
    expect(classify(401, "")).toBe("auth");
    expect(classify(404, "")).toBe("not_found");
    expect(classify(502, "")).toBe("unavailable");
  });

  it("loop marker: the integration user's own change, or an unchanged hash, is an echo", () => {
    expect(isOwnEcho({ updatedBy: 17 }, "17")).toBe(true);
    expect(isOwnEcho({ updatedBy: 3 }, "17")).toBe(false);
    expect(isOwnEcho({ updatedBy: 3 }, "17", { reReadHash: "a".repeat(64), pushedHash: "a".repeat(64) })).toBe(true);
    expect(isOwnEcho({ updatedBy: null }, "17", { reReadHash: null, pushedHash: null })).toBe(false);
  });
});

describe("Bitrix24 client: delete and not-found answers (gap G14)", () => {
  const fakeClient = () => {
    const clock = new FakeClock();
    const fake = new FakeBitrix24({ host: FAKE_HOST, userId: FAKE_USER, secret: FAKE_SECRET, now: clock.ms });
    return { fake, c: new BitrixRestClient(fakeConfig(), { fetchImpl: fake.fetch }) };
  };

  it.each(["true", "empty_array", "empty_object"] as const)("delete answered %s counts as deleted", async (shape) => {
    const { fake, c } = fakeClient();
    fake.deleteAnswer = shape;
    const d = fake.seedDeal({ originId: fields.originId });
    expect(await c.deleteDeal(d.id)).toBe("deleted");
  });

  it.each([
    ["false", "invalid_response:delete_result_false"],
    ["null", "invalid_response:delete_result_null"],
    ["object", "invalid_response:delete_result_object"],
    ["string", "invalid_response:delete_result_string"],
  ] as const)("delete answered %s is never deleted: invalid_response naming the shape, a write may have happened", async (shape, code) => {
    const { fake, c } = fakeClient();
    fake.deleteAnswer = shape;
    const d = fake.seedDeal({ originId: fields.originId });
    const e = await c.deleteDeal(d.id).then(() => null, (x: CrmCallError) => x);
    expect(e).toMatchObject({ kind: "invalid_response", code, writeMayHaveHappened: true });
  });

  it.each(["code", "empty_code_text", "core_text", "core_text_ru", "http404"] as const)("a not-found answer shaped %s is not_found", async (shape) => {
    const { fake, c } = fakeClient();
    fake.notFoundShape = shape;
    expect(await c.deleteDeal(4242)).toBe("not_found");
    await expect(c.updateDeal(4242, fields)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("classify: a missing method or a field 'not found' is never a missing record", () => {
    expect(classify(404, "ERROR_METHOD_NOT_FOUND", "Method not found!")).toBe("rejected");
    expect(classify(400, "INVALID_ARG_VALUE", "Field UF_CRM_X not found")).toBe("rejected");
    expect(classify(400, "ERROR_CORE", "Access to the entity is denied")).toBe("rejected");
    expect(classify(400, "", "Not found")).toBe("not_found");
    expect(classify(400, "ENTITY_NOT_FOUND")).toBe("not_found");
    expect(classify(400, "ACCESS_DENIED", "not found")).toBe("auth");
  });

  it("the provider's description is never kept in the error", async () => {
    const c = client(async () => json(400, { error: "ERROR_CORE", error_description: `Element 77 not found for ${["a.customer", "example.invalid"].join("@")}` }));
    const e = await c.deleteDeal(77).then(() => null, (x: unknown) => x);
    expect(e).toBeNull(); // not_found is an answer, not an error
    const e2 = await c.updateDeal(77, fields).then(() => null, (x: CrmCallError) => x);
    expect(e2).toMatchObject({ kind: "not_found", code: "not_found:ERROR_CORE" });
    expect(JSON.stringify({ m: e2!.message, c: e2!.code })).not.toMatch(/example|77|customer/);
  });
});

describe("Bitrix24 client: timeline comments (gap G7)", () => {
  it("adds one comment to a deal with exactly ENTITY_ID, ENTITY_TYPE deal and COMMENT; the answer is the comment id", async () => {
    const clock = new FakeClock();
    const fake = new FakeBitrix24({ host: FAKE_HOST, userId: FAKE_USER, secret: FAKE_SECRET, now: clock.ms });
    const c = new BitrixRestClient(fakeConfig(), { fetchImpl: fake.fetch });
    const d = fake.seedDeal({ originId: fields.originId });
    const r = await c.addTimelineComment(d.id, "OUTLYY update (Dubai time)\n22 Nov 2026 12:00 - Supplier booking confirmed");
    expect(r.id).toBeGreaterThan(0);
    expect(fake.commentsOn(d.id).map((x) => x.text)).toEqual(["OUTLYY update (Dubai time)\n22 Nov 2026 12:00 - Supplier booking confirmed"]);
    expect(fake.refusedMethods).toEqual([]);
    // A deal that is gone: not_found. A bad answer shape: invalid_response, a write may have happened.
    await expect(c.addTimelineComment(99_999, "x")).rejects.toMatchObject({ kind: "not_found" });
    const bad = client(async () => json(200, { result: { id: 1 } }));
    await expect(bad.addTimelineComment(5, "x")).rejects.toMatchObject({ kind: "invalid_response", writeMayHaveHappened: true });
  });
});
