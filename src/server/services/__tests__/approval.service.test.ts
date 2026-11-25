import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { Actor } from "../../lib/actor";
import { SYSTEM_ACTOR } from "../../lib/actor";
import { ROLE_PERMISSIONS, type RoleCode } from "../../lib/permissions";
import { assertDisposableDb, cleanupPeople, createStaff, dbEnabled, runId, type StaffFixture } from "../../__tests__/helpers/fixtures";

/**
 * Step-up and dual approval (SEC-10, PRD-12) on the disposable database.
 *
 * Staff are synthetic (`zz-sec-<run>-`), each with a random TOTP secret that
 * exists only for this run. Codes are generated for distinct 30-second steps
 * through the service's clock seam, so every step-up uses a fresh code and
 * the replay guard is exercised for real. Approval rows and staff are removed
 * in afterAll; audit rows are append-only and stay. Step-ups share the login
 * TOTP rate limit (8 per user per 10 minutes), so the work is spread over
 * three admins.
 */

const RUN = runId();
const MARKER = `zz-marker-${RUN}`;

/** RFC 6238 code for `at`, as an authenticator app would show it. */
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

describe.skipIf(!dbEnabled)("approval.service: step-up and dual approval", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let svc: typeof import("../approval.service").approvalService;
  const secrets = new Map<string, string>();
  const staff: Record<string, StaffFixture> = {};
  // Each test gets its own block of time steps, far apart, so no code repeats.
  let clock = Date.UTC(2026, 10, 1, 9, 0, 0);
  const tick = () => new Date((clock += 90_000));

  function actor(label: string, role: RoleCode): Actor {
    return { type: "admin", id: staff[label].id, roles: [role], permissions: new Set(ROLE_PERMISSIONS[role]) };
  }
  const code = (label: string, at: Date) => totpAt(secrets.get(label)!, at);

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    ({ approvalService: svc } = await import("../approval.service"));
    const { encryptSecret, generateTotpSecret } = await import("../../lib/crypto");
    const roles: Record<string, RoleCode> = { a: "admin", b: "admin", c: "admin", ops: "ops", noTotp: "admin" };
    for (const [label, role] of Object.entries(roles)) {
      staff[label] = await createStaff(RUN, label, [role], { totpEnabled: label !== "noTotp" });
      if (label === "noTotp") continue;
      const secret = generateTotpSecret();
      secrets.set(label, secret);
      await prisma.adminUser.update({ where: { id: staff[label].id }, data: { totpSecretEncrypted: encryptSecret(secret) } });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    const ids = Object.values(staff).map((s) => s.id);
    await prisma.privilegedApproval.deleteMany({ where: { OR: [{ requestedBy: { in: ids } }, { approvedBy: { in: ids } }] } });
    await prisma.rateLimitBucket.deleteMany({ where: { key: { in: ids.map((id) => `admin_totp:${id}`) } } }).catch(() => {});
    await prisma.idempotencyKey.deleteMany({ where: { scope: "admin_totp", OR: ids.map((id) => ({ key: { startsWith: `totp:${id}:` } })) } });
    await cleanupPeople(RUN);
  });

  const payload = (n: number) => ({ supplier: `zz-${RUN}`, account: "default", step: n, note: MARKER });

  it("test environment: applied right after step-up, with no approver", async () => {
    const at = tick();
    const r = await svc.requestPrivileged(actor("a", "admin"), "supplier.resume", "suppliers.resume", payload(1), { environment: "test", totpCode: code("a", at), now: at });
    expect(r.status).toBe("applied");
    const row = await prisma.privilegedApproval.findUniqueOrThrow({ where: { id: (r as { approvalId: string }).approvalId } });
    expect(row).toMatchObject({ status: "applied", environment: "test", requestedBy: staff.a.id, approvedBy: null });
    expect(row.appliedAt).not.toBeNull();
  });

  it("refuses a wrong code, a replayed code and a user without TOTP", async () => {
    const at = tick();
    const wrong = code("a", at) === "000000" ? "111111" : "000000";
    expect(await svc.requestPrivileged(actor("a", "admin"), "supplier.resume", "suppliers.resume", payload(2), { environment: "test", totpCode: wrong, now: at })).toEqual({ status: "refused", reason: "step_up_required" });

    const fresh = code("a", at);
    expect((await svc.requestPrivileged(actor("a", "admin"), "supplier.resume", "suppliers.resume", payload(3), { environment: "test", totpCode: fresh, now: at })).status).toBe("applied");
    expect(await svc.requestPrivileged(actor("a", "admin"), "supplier.resume", "suppliers.resume", payload(4), { environment: "test", totpCode: fresh, now: at })).toEqual({ status: "refused", reason: "step_up_required" });

    expect(await svc.requestPrivileged(actor("noTotp", "admin"), "supplier.resume", "suppliers.resume", payload(5), { environment: "test", totpCode: "123456", now: at })).toEqual({ status: "refused", reason: "step_up_required" });
    expect(await prisma.privilegedApproval.count({ where: { payload: { path: ["step"], equals: 2 }, requestedBy: staff.a.id } })).toBe(0);
  });

  it("refuses a role without the permission, a mismatched permission and the system actor", async () => {
    const at = tick();
    expect(await svc.requestPrivileged(actor("ops", "ops"), "supplier.resume", "suppliers.resume", payload(6), { environment: "test", totpCode: code("ops", at), now: at })).toEqual({ status: "refused", reason: "forbidden" });
    expect(await svc.requestPrivileged(actor("a", "admin"), "supplier.resume", "suppliers.pause", payload(7), { environment: "test", totpCode: code("a", at), now: at })).toEqual({ status: "refused", reason: "forbidden" });
    expect(await svc.requestPrivileged(SYSTEM_ACTOR, "supplier.resume", "suppliers.resume", payload(8), { environment: "test", totpCode: "123456", now: at })).toEqual({ status: "refused", reason: "forbidden" });
  });

  it("production: one user cannot satisfy dual approval", async () => {
    const t1 = tick();
    const first = await svc.requestPrivileged(actor("a", "admin"), "supplier.limits.raise", "suppliers.limits.raise", { ...payload(9), maxMinor: 500_00n }, { environment: "production", totpCode: code("a", t1), now: t1 });
    expect(first).toMatchObject({ status: "pending", needs: "second_approver" });
    const id = (first as { approvalId: string }).approvalId;

    // Same person approving: refused before any code is consumed.
    const t2 = tick();
    expect(await svc.approvePrivileged(actor("a", "admin"), id, code("a", t2), { now: t2 })).toEqual({ status: "refused", reason: "same_person" });

    // Same person asking again with a fresh code: still pending, same request.
    const t3 = tick();
    expect(await svc.requestPrivileged(actor("a", "admin"), "supplier.limits.raise", "suppliers.limits.raise", { ...payload(9), maxMinor: 500_00n }, { environment: "production", totpCode: code("a", t3), now: t3 })).toEqual({ status: "pending", approvalId: id, needs: "second_approver" });
    expect((await prisma.privilegedApproval.findUniqueOrThrow({ where: { id } })).status).toBe("pending");

    // The database refuses it too, whatever the code does.
    await expect(prisma.privilegedApproval.update({ where: { id }, data: { approvedBy: staff.a.id, approvedAt: t3 } })).rejects.toThrow(/pa_distinct_approver_check/);
    await expect(prisma.privilegedApproval.update({ where: { id }, data: { status: "applied", appliedAt: t3 } })).rejects.toThrow(/pa_production_dual_check/);
    expect((await prisma.privilegedApproval.findUniqueOrThrow({ where: { id } })).status).toBe("pending");
  });

  it("production: a second admin approves; a role without the permission cannot", async () => {
    const t1 = tick();
    const pending = await svc.requestPrivileged(actor("a", "admin"), "instant.activate", "products.activate_instant", payload(10), { environment: "production", totpCode: code("a", t1), now: t1 });
    const id = (pending as { approvalId: string }).approvalId;

    const t2 = tick();
    expect(await svc.approvePrivileged(actor("ops", "ops"), id, code("ops", t2), { now: t2 })).toEqual({ status: "refused", reason: "forbidden" });
    const wrong = code("b", t2) === "000000" ? "111111" : "000000";
    expect(await svc.approvePrivileged(actor("b", "admin"), id, wrong, { now: t2 })).toEqual({ status: "refused", reason: "step_up_required" });

    const t3 = tick();
    expect(await svc.approvePrivileged(actor("b", "admin"), id, code("b", t3), { now: t3 })).toEqual({ status: "applied", approvalId: id });
    const row = await prisma.privilegedApproval.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "applied", requestedBy: staff.a.id, approvedBy: staff.b.id });

    // A third admin cannot re-decide it.
    const t4 = tick();
    await expect(svc.approvePrivileged(actor("c", "admin"), id, code("c", t4), { now: t4 })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("production: a different admin requesting the identical payload applies the pending request", async () => {
    const t1 = tick();
    const p = { ...payload(11), bookingId: `zz-${RUN}-b1` };
    const pending = await svc.requestPrivileged(actor("c", "admin"), "booking.privileged_resolution", "bookings.privileged_resolution", p, { environment: "production", totpCode: code("c", t1), now: t1 });
    const t2 = tick();
    // A different payload does not match.
    expect((await svc.requestPrivileged(actor("b", "admin"), "booking.privileged_resolution", "bookings.privileged_resolution", { ...p, step: 12 }, { environment: "production", totpCode: code("b", t2), now: t2 })).status).toBe("pending");
    const t3 = tick();
    const second = await svc.requestPrivileged(actor("b", "admin"), "booking.privileged_resolution", "bookings.privileged_resolution", p, { environment: "production", totpCode: code("b", t3), now: t3 });
    expect(second).toEqual({ status: "applied", approvalId: (pending as { approvalId: string }).approvalId });
  });

  it("production: an approval after 30 minutes is refused as expired", async () => {
    const t1 = tick();
    const pending = await svc.requestPrivileged(actor("c", "admin"), "supplier.resume", "suppliers.resume", payload(13), { environment: "production", totpCode: code("c", t1), now: t1 });
    const id = (pending as { approvalId: string }).approvalId;
    clock += 31 * 60_000;
    const late = tick();
    expect(await svc.approvePrivileged(actor("b", "admin"), id, code("b", late), { now: late })).toEqual({ status: "refused", reason: "expired" });
    expect((await prisma.privilegedApproval.findUniqueOrThrow({ where: { id } })).status).toBe("expired");
  });

  it("audits every step with the payload hash and field names, never the values", async () => {
    const ids = Object.values(staff).map((s) => s.id);
    const rows = await prisma.auditLog.findMany({ where: { actorId: { in: ids }, action: { startsWith: "privileged." } } });
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["privileged.requested", "privileged.approved", "privileged.applied", "privileged.refused"]) expect(actions.has(a), a).toBe(true);
    const text = JSON.stringify(rows.map((r) => r.after));
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(`zz-${RUN}-b1`);
    const requested = rows.find((r) => r.action === "privileged.requested")!.after as { payloadHash: string; payloadFields: string[] };
    expect(requested.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(requested.payloadFields).toContain("note");
    const reasons = rows.filter((r) => r.action === "privileged.refused").map((r) => (r.after as { reason: string }).reason);
    for (const reason of ["forbidden", "step_up_required", "same_person", "expired"]) expect(reasons, reason).toContain(reason);
  });

  it("random secrets only: no fixture secret is stored in plain text", async () => {
    const row = await prisma.adminUser.findUniqueOrThrow({ where: { id: staff.a.id }, select: { totpSecretEncrypted: true } });
    expect(row.totpSecretEncrypted).not.toContain(secrets.get("a")!);
  });
});
