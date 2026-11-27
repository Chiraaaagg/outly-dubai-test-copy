import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { Actor } from "../../lib/actor";
import { SYSTEM_ACTOR } from "../../lib/actor";
import { ROLE_PERMISSIONS } from "../../lib/permissions";
import { assertDisposableDb, cleanupPeople, createStaff, dbEnabled, runId, type StaffFixture } from "../../__tests__/helpers/fixtures";
import { forbidNetwork } from "../../__tests__/security/_mercury-fixtures";
import type { FetchLike, FxRefreshOutcome } from "../fx-refresh.service";

/**
 * The live FX refresh against the disposable database (doc 22 §32.16):
 * versioned writes to `pricing.fx_inr_per_aed` under a row lock, the audit
 * rows (system actor for the job, the admin for a manual run), refusals and
 * failures that leave the row alone, and a jump accepted with a real
 * step-up. Fetch is injected and global fetch is blocked: nothing here
 * touches the network. The setting row is snapshotted first and restored in
 * afterAll; staff rows are removed; audit rows are append-only and stay.
 */

const RUN = runId();
const KEY = "pricing.fx_inr_per_aed";

function answer(inr: number, date: string): FetchLike {
  return async () => new Response(JSON.stringify({ amount: 1.0, base: "USD", date, rates: { INR: inr } }), { headers: { "content-type": "application/json" } });
}
const hanging: FetchLike = (_u, init) => new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
const badJson: FetchLike = async () => new Response("{not json");

/** RFC 6238 code for `at`, as an authenticator app would show it (copied from approval.service.test.ts). */
function totpAt(secretB32: string, at: Date): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secretB32.replace(/=+$/, "")) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const h = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

describe.skipIf(!dbEnabled)("fx-refresh.service on the database", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let mod: typeof import("../fx-refresh.service");
  let snapshot: { value: unknown; updatedBy: string | null } | null = null;
  let admin: StaffFixture;
  let secret: string;
  const reevaluated: string[] = [];
  const startedAt = new Date();
  const today = startedAt.toISOString().slice(0, 10);

  function service(fetch: FetchLike) {
    return mod.createFxRefreshService({
      fetch,
      timeoutMs: 50,
      now: () => new Date(),
      band: () => ({ minHundredths: 1500n, maxHundredths: 4000n }),
      store: mod.prismaFxStore,
      async auditRefusal(actor, detail) {
        const { audit } = await import("../../lib/audit");
        await audit(actor, "pricing.fx_refresh_refused", { type: "setting", id: KEY }, { after: detail });
      },
      async reevaluate(key) {
        reevaluated.push(key);
      },
      stepUp: async (actor, code) => (await import("../approval.service")).verifyStepUp(actor, code),
    });
  }

  const adminActor = (): Actor => ({ type: "admin", id: admin.id, roles: ["admin"], permissions: new Set(ROLE_PERMISSIONS.admin) });
  const stored = async () => (await prisma.setting.findUnique({ where: { key: KEY } }))?.value as Record<string, unknown> | undefined;
  const auditRows = () => prisma.auditLog.findMany({ where: { entityType: "setting", entityId: KEY, createdAt: { gte: startedAt } }, orderBy: { id: "asc" } });

  beforeAll(async () => {
    assertDisposableDb();
    forbidNetwork();
    ({ prisma } = await import("../../lib/db"));
    mod = await import("../fx-refresh.service");
    const row = await prisma.setting.findUnique({ where: { key: KEY } });
    snapshot = row ? { value: row.value, updatedBy: row.updatedBy } : null;
    await prisma.setting.deleteMany({ where: { key: KEY } });
    admin = await createStaff(RUN, "fx-admin", ["admin"]);
    const { encryptSecret, generateTotpSecret } = await import("../../lib/crypto");
    secret = generateTotpSecret();
    await prisma.adminUser.update({ where: { id: admin.id }, data: { totpSecretEncrypted: encryptSecret(secret) } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.setting.deleteMany({ where: { key: KEY } });
    if (snapshot) await prisma.setting.create({ data: { key: KEY, value: snapshot.value as never, updatedBy: snapshot.updatedBy } });
    (await import("../../repositories/settings.repo")).settingsRepo.invalidate(KEY);
    await cleanupPeople(RUN);
  });

  it("first run writes version 1, audited as settings.update by the system with before = null", async () => {
    const out = await service(answer(94.75, today)).refresh(SYSTEM_ACTOR, { trigger: "cron" });
    expect(out).toMatchObject({ status: "written", version: 1, inrPerAed: "26.32", previous: null, changed: true });
    const row = await prisma.setting.findUniqueOrThrow({ where: { key: KEY } });
    expect(row.updatedBy).toBeNull();
    expect(row.value).toMatchObject({ version: 1, inrPerAed: "26.32", source: `ECB via Frankfurter ${today}, USD/INR 94.75 ÷ 3.6725 × 1.02` });
    const v = row.value as { recordedAt: string; expiresAt: string };
    expect(Date.parse(v.expiresAt) - Date.parse(v.recordedAt)).toBe(48 * 3600_000);

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "system", actorId: null, action: "settings.update", reason: "fx_refresh:cron", before: null });
    expect(audits[0].after).toEqual(row.value);
    expect(reevaluated).toEqual([KEY]);

    // The margin service reads it straight away in this process.
    const { currentFxRow } = mod;
    await expect(currentFxRow()).resolves.toMatchObject({ version: 1, inrPerAed: "26.32", usable: true });
  });

  it("an unchanged rate writes version 2 with a later expiry; readiness is not re-run", async () => {
    const before = (await stored()) as { expiresAt: string };
    await new Promise((r) => setTimeout(r, 5));
    const out = await service(answer(94.75, today)).refresh(SYSTEM_ACTOR, { trigger: "cron" });
    expect(out).toMatchObject({ status: "written", version: 2, changed: false });
    const after = (await stored()) as { version: number; expiresAt: string };
    expect(after.version).toBe(2);
    expect(Date.parse(after.expiresAt)).toBeGreaterThan(Date.parse(before.expiresAt));
    const audits = await auditRows();
    expect(audits).toHaveLength(2);
    expect(audits[1].before).toMatchObject({ version: 1 });
    expect(reevaluated).toEqual([KEY]);
  });

  it("guard refusals keep the row and write only a refusal audit row", async () => {
    const before = await stored();
    const jump = await service(answer(120, today)).refresh(SYSTEM_ACTOR, { trigger: "cron" });
    expect(jump).toMatchObject({ status: "refused", reasons: ["jump_too_large"], computed: "33.33", previous: "26.32" });
    const stale = await service(answer(94.75, "2020-01-02")).refresh(SYSTEM_ACTOR, { trigger: "cron" });
    expect(stale).toMatchObject({ status: "refused", reasons: ["source_stale"] });
    expect(await stored()).toEqual(before);
    const audits = await auditRows();
    expect(audits.slice(2).map((a) => [a.action, a.actorType, (a.after as { reasons: string[] }).reasons])).toEqual([
      ["pricing.fx_refresh_refused", "system", ["jump_too_large"]],
      ["pricing.fx_refresh_refused", "system", ["source_stale"]],
    ]);
  });

  it("a timeout or bad JSON leaves the row unchanged and writes no audit row", async () => {
    const before = await stored();
    const count = (await auditRows()).length;
    await expect(service(hanging).refresh(SYSTEM_ACTOR, { trigger: "cron" })).resolves.toEqual({ status: "failed", reason: "timeout" });
    await expect(service(badJson).refresh(SYSTEM_ACTOR, { trigger: "cron" })).resolves.toEqual({ status: "failed", reason: "bad_json" });
    expect(await stored()).toEqual(before);
    expect(await auditRows()).toHaveLength(count);
  });

  it("an admin accepts the jump with a real step-up: version 3, updated_by and the audit actor are the admin", async () => {
    const svc = service(answer(120, today));
    await expect(svc.refreshManually(adminActor(), { acceptJumpTo: "33.33", totpCode: "000000" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await stored()).toMatchObject({ version: 2 });

    const out = await svc.refreshManually(adminActor(), { acceptJumpTo: "33.33", totpCode: totpAt(secret, new Date()) });
    expect(out).toMatchObject({ status: "written", version: 3, inrPerAed: "33.33", previous: "26.32", jumpAccepted: true });
    const row = await prisma.setting.findUniqueOrThrow({ where: { key: KEY } });
    expect(row.updatedBy).toBe(admin.id);
    const last = (await auditRows()).at(-1)!;
    expect(last).toMatchObject({ actorType: "admin", actorId: admin.id, action: "settings.update", reason: "fx_refresh:jump_accepted" });
    const refusedCode = (await auditRows()).find((a) => a.action === "pricing.fx_refresh_refused" && a.actorId === admin.id);
    expect(refusedCode?.after).toMatchObject({ reasons: ["step_up_required"], stepUp: "invalid_code" });
  });

  it("an expired stored row: a failed run re-runs readiness and leaves the row and the audit log exactly as they were", async () => {
    const past = { version: 3, inrPerAed: "26.32", source: "synthetic expired rate", recordedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-03T00:00:00.000Z" };
    await prisma.setting.update({ where: { key: KEY }, data: { value: past } });
    const count = (await auditRows()).length;
    const runsBefore = reevaluated.length;
    await expect(service(hanging).refresh(SYSTEM_ACTOR, { trigger: "cron" })).resolves.toEqual({ status: "failed", reason: "timeout" });
    await expect(service(answer(94.75, "2020-01-02")).refresh(SYSTEM_ACTOR, { trigger: "cron" })).resolves.toMatchObject({ status: "refused", reasons: ["source_stale"] });
    expect(reevaluated.slice(runsBefore)).toEqual([KEY, KEY]);
    expect(await stored()).toEqual(past);
    // Only the refusal's own audit row; no settings.update.
    expect((await auditRows()).slice(count).map((a) => a.action)).toEqual(["pricing.fx_refresh_refused"]);
    await expect(mod.currentFxRow()).resolves.toMatchObject({ version: 3, usable: false });

    // A valid row again: the next failed run leaves readiness alone.
    const fresh = { ...past, version: 4, recordedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() };
    await prisma.setting.update({ where: { key: KEY }, data: { value: fresh } });
    await service(hanging).refresh(SYSTEM_ACTOR, { trigger: "cron" });
    expect(reevaluated.slice(runsBefore)).toEqual([KEY, KEY]);
  });

  it("concurrent runs serialise on the row lock: distinct consecutive versions, one audit row each", async () => {
    const svc = service(answer(94.75, today));
    const outs: FxRefreshOutcome[] = await Promise.all([svc.refresh(SYSTEM_ACTOR, { trigger: "cron" }), svc.refresh(SYSTEM_ACTOR, { trigger: "cron" })]);
    const versions = outs.map((o) => (o.status === "written" ? o.version : null)).sort();
    expect(versions).toEqual([5, 6]);
    expect(await stored()).toMatchObject({ version: 6 });
    // Versions 3 and 4 above were set directly by the test, not through the service.
    const writes = (await auditRows()).filter((a) => a.action === "settings.update");
    expect(writes.map((a) => (a.after as { version: number }).version)).toEqual([1, 2, 3, 5, 6]);
  });
});
