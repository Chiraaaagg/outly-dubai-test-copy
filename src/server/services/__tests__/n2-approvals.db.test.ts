import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { Actor } from "../../lib/actor";
import { ROLE_PERMISSIONS, type RoleCode } from "../../lib/permissions";
import { assertDisposableDb, cleanupPeople, createStaff, dbEnabled, runId, type StaffFixture } from "../../__tests__/helpers/fixtures";

/**
 * Doc 30 N2 on the disposable database: the one-person approval path
 * (owner decisions D15, D16, D25; review RR-02, P30-33).
 *
 *  - The database accepts an applied production `single_step_up` row for
 *    exactly instant.activate, instant.activate.bulk and
 *    supplier.capability.enable, and refuses one for supplier.resume,
 *    supplier.limits.raise and booking.privileged_resolution.
 *  - The service applies at once for a full-rights administrator only while
 *    the owner alert recipient is set, with the alert row queued in the same
 *    transaction; every other case keeps the two-person rule.
 *  - The hourly item cap.
 *
 * Staff are synthetic (`zz-sec-<run>-`) with random TOTP secrets for this run
 * only. The owner alert recipient is a synthetic address built at run time
 * on the reserved `.test` domain. Rows are removed in afterAll; audit rows
 * stay (append-only).
 */

const RUN = runId();
const MARKER = `zz-n2-marker-${RUN}`;

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

const THREE = ["instant.activate", "instant.activate.bulk", "supplier.capability.enable"] as const;
const OTHERS = [
  ["supplier.resume", "suppliers.resume"],
  ["supplier.limits.raise", "suppliers.limits.raise"],
  ["booking.privileged_resolution", "bookings.privileged_resolution"],
] as const;

describe.skipIf(!dbEnabled)("doc 30 N2: one-person approvals and the owner alert", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let svc: typeof import("../approval.service").approvalService;
  let resetEnvCache: typeof import("../../lib/env").resetEnvCache;
  let queueOwnerAlertInTx: typeof import("../owner-alert").queueOwnerAlertInTx;
  const secrets = new Map<string, string>();
  const staff: Record<string, StaffFixture> = {};
  let clock = Date.UTC(2026, 10, 27, 9, 0, 0);
  const tick = () => new Date((clock += 90_000));
  const previousRecipient = process.env.OWNER_ALERT_EMAIL;
  const recipient = ["zz-owner", RUN].join("-") + "@" + "example.test";

  function actor(label: string, role: RoleCode, drop: string[] = []): Actor {
    return { type: "admin", id: staff[label].id, displayName: `Fixture ${label}`, roles: [role], permissions: new Set(ROLE_PERMISSIONS[role].filter((p) => !drop.includes(p))) };
  }
  const code = (label: string, at: Date) => totpAt(secrets.get(label)!, at);
  const payload = (n: number, extra: Record<string, unknown> = {}) => ({ kind: "product", productId: "00000000-0000-7000-8000-000000000000", mode: "instant", step: n, note: MARKER, ...extra });
  const setRecipient = (v: string | undefined) => {
    if (v === undefined) delete process.env.OWNER_ALERT_EMAIL;
    else process.env.OWNER_ALERT_EMAIL = v;
    resetEnvCache();
  };

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    ({ approvalService: svc } = await import("../approval.service"));
    ({ resetEnvCache } = await import("../../lib/env"));
    ({ queueOwnerAlertInTx } = await import("../owner-alert"));
    const { encryptSecret, generateTotpSecret } = await import("../../lib/crypto");
    for (const label of ["d", "e", "f", "g", "cap"]) {
      staff[label] = await createStaff(RUN, label, ["admin"]);
      const secret = generateTotpSecret();
      secrets.set(label, secret);
      await prisma.adminUser.update({ where: { id: staff[label].id }, data: { totpSecretEncrypted: encryptSecret(secret) } });
    }
  });

  afterAll(async () => {
    setRecipient(previousRecipient);
    if (!prisma) return;
    const ids = Object.values(staff).map((s) => s.id);
    const rows = await prisma.privilegedApproval.findMany({ where: { requestedBy: { in: ids } }, select: { id: true } });
    await prisma.notification.deleteMany({ where: { dedupKey: { in: rows.map((r) => `owner_alert:${r.id}`) } } });
    await prisma.privilegedApproval.deleteMany({ where: { OR: [{ requestedBy: { in: ids } }, { approvedBy: { in: ids } }] } });
    await prisma.rateLimitBucket.deleteMany({ where: { key: { in: ids.map((id) => `admin_totp:${id}`) } } }).catch(() => {});
    await prisma.idempotencyKey.deleteMany({ where: { scope: "admin_totp", OR: ids.map((id) => ({ key: { startsWith: `totp:${id}:` } })) } });
    await cleanupPeople(RUN);
  });

  const row = (operation: string, permission: string, mode: string) => ({
    operation,
    permission,
    payload: { note: MARKER, operation },
    payloadHash: "a".repeat(64),
    environment: "production" as const,
    status: "applied",
    approvalMode: mode,
    requestedBy: staff.d.id,
    appliedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });

  it("database: an applied single-step production row is accepted for each of the three operations", async () => {
    const { uuidv7 } = await import("../../lib/ids");
    for (const op of THREE) {
      const id = uuidv7();
      await prisma.privilegedApproval.create({ data: { id, ...row(op, "products.activate_instant", "single_step_up") } });
      expect((await prisma.privilegedApproval.findUniqueOrThrow({ where: { id } })).approvedBy).toBeNull();
    }
  });

  it("database: refuses a single-step row for each of the other three, and a dual production row without a second person", async () => {
    const { uuidv7 } = await import("../../lib/ids");
    for (const [op, perm] of OTHERS) {
      await expect(prisma.privilegedApproval.create({ data: { id: uuidv7(), ...row(op, perm, "single_step_up") } })).rejects.toThrow(/pa_production_dual_check|pa_single_step_check/);
      await expect(prisma.privilegedApproval.create({ data: { id: uuidv7(), ...row(op, perm, "dual") } })).rejects.toThrow(/pa_production_dual_check/);
    }
    // Even outside production a single-step row is bounded to the three operations.
    await expect(prisma.privilegedApproval.create({ data: { id: uuidv7(), ...row("supplier.resume", "suppliers.resume", "single_step_up"), environment: "test" } })).rejects.toThrow(/pa_single_step_check/);
    // A single-step row never names a second approver.
    await expect(prisma.privilegedApproval.create({ data: { id: uuidv7(), ...row("instant.activate", "products.activate_instant", "single_step_up"), approvedBy: staff.e.id, approvedAt: new Date() } })).rejects.toThrow(
      /pa_single_step_check/,
    );
    await expect(prisma.privilegedApproval.create({ data: { id: uuidv7(), ...row("instant.activate", "products.activate_instant", "nonsense") } })).rejects.toThrow(/pa_approval_mode_check/);
  });

  it("without an owner alert recipient, production keeps the two-person rule", async () => {
    setRecipient(undefined);
    const at = tick();
    const r = await svc.requestPrivileged(actor("d", "admin"), "instant.activate", "products.activate_instant", payload(1), { environment: "production", totpCode: code("d", at), now: at });
    expect(r).toMatchObject({ status: "pending", needs: "second_approver" });
  });

  it("with a recipient, a full-rights admin is applied at once, alone, with the alert queued in the same transaction", async () => {
    setRecipient(recipient);
    const at = tick();
    const r = await svc.requestPrivileged(actor("d", "admin"), "instant.activate", "products.activate_instant", payload(2), { environment: "production", totpCode: code("d", at), now: at });
    expect(r).toMatchObject({ status: "applied", mode: "single_step_up" });
    const id = (r as { approvalId: string }).approvalId;
    const stored = await prisma.privilegedApproval.findUniqueOrThrow({ where: { id } });
    expect(stored).toMatchObject({ status: "applied", approvalMode: "single_step_up", approvedBy: null, approvedAt: null, requestedBy: staff.d.id, itemCount: 1 });
    const alert = await prisma.notification.findUniqueOrThrow({ where: { dedupKey: `owner_alert:${id}` } });
    expect(alert).toMatchObject({ event: "OWNER_ACTION_ALERT", channel: "email", recipient });
    // Outside production the allowlist suppresses it; the row exists whatever the delivery outcome.
    expect(["queued", "suppressed", "sent", "failed", "unknown"]).toContain(alert.status);
    const text = JSON.stringify(alert.payload);
    expect(text).toContain(id);
    expect(text).not.toContain(MARKER);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: id, action: "privileged.applied" } });
    expect(audit.after).toMatchObject({ approval_mode: "single_step_up", alertId: alert.id });
  });

  it("class switch-on and the bulk operation take the same path", async () => {
    for (const [label, op] of [
      ["e", "supplier.capability.enable"],
      ["e", "instant.activate.bulk"],
    ] as const) {
      const at = tick();
      const r = await svc.requestPrivileged(actor(label, "admin"), op, "products.activate_instant", payload(3, { op }), { environment: "production", totpCode: code(label, at), now: at });
      expect(r, op).toMatchObject({ status: "applied", mode: "single_step_up" });
    }
  });

  it("the other three operations keep two people even for a full-rights admin with a recipient", async () => {
    for (const [op, perm] of OTHERS) {
      const at = tick();
      const r = await svc.requestPrivileged(actor("f", "admin"), op, perm, payload(4, { op }), { environment: "production", totpCode: code("f", at), now: at });
      expect(r, op).toMatchObject({ status: "pending", needs: "second_approver" });
    }
  });

  it("an administrator without every permission keeps the two-person rule", async () => {
    const at = tick();
    const r = await svc.requestPrivileged(actor("g", "admin", ["payments.reconcile"]), "instant.activate", "products.activate_instant", payload(5), { environment: "production", totpCode: code("g", at), now: at });
    expect(r).toMatchObject({ status: "pending" });
  });

  it("caps: at most 50 listings per approval and 100 per person per hour", async () => {
    let at = tick();
    await expect(svc.requestPrivileged(actor("cap", "admin"), "instant.activate.bulk", "products.activate_instant", payload(6), { environment: "production", totpCode: code("cap", at), now: at, itemCount: 51 })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    at = tick();
    expect(await svc.requestPrivileged(actor("cap", "admin"), "instant.activate.bulk", "products.activate_instant", payload(7), { environment: "production", totpCode: code("cap", at), now: at, itemCount: 50 })).toMatchObject({ status: "applied" });
    at = tick();
    expect(await svc.requestPrivileged(actor("cap", "admin"), "instant.activate.bulk", "products.activate_instant", payload(8), { environment: "production", totpCode: code("cap", at), now: at, itemCount: 50 })).toMatchObject({ status: "applied" });
    at = tick();
    expect(await svc.requestPrivileged(actor("cap", "admin"), "instant.activate", "products.activate_instant", payload(9), { environment: "production", totpCode: code("cap", at), now: at })).toEqual({ status: "refused", reason: "item_cap" });
    // Class switch-on is not a listing: not counted, not capped.
    at = tick();
    expect(await svc.requestPrivileged(actor("cap", "admin"), "supplier.capability.enable", "products.activate_instant", payload(10), { environment: "production", totpCode: code("cap", at), now: at })).toMatchObject({ status: "applied" });
    // An hour later the window has moved on.
    clock += 61 * 60_000;
    at = tick();
    expect(await svc.requestPrivileged(actor("cap", "admin"), "instant.activate", "products.activate_instant", payload(11), { environment: "production", totpCode: code("cap", at), now: at })).toMatchObject({ status: "applied" });
  });

  it("no applied single-step row without its alert: a failing queue rolls the approval back", async () => {
    const { uuidv7 } = await import("../../lib/ids");
    setRecipient(undefined);
    const id = uuidv7();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.privilegedApproval.create({ data: { id, ...row("instant.activate", "products.activate_instant", "single_step_up") } });
        await queueOwnerAlertInTx(tx, { approvalId: id, operation: "instant.activate", environment: "production", actor: actor("d", "admin"), itemCount: 1, payload: {}, at: new Date() });
      }),
    ).rejects.toThrow(/recipient/);
    expect(await prisma.privilegedApproval.count({ where: { id } })).toBe(0);
    setRecipient(recipient);
    // Every single-step row the service applied in this suite has exactly one alert.
    const applied = await prisma.privilegedApproval.findMany({ where: { requestedBy: { in: Object.values(staff).map((s) => s.id) }, approvalMode: "single_step_up", payloadHash: { not: "a".repeat(64) } } });
    expect(applied.length).toBeGreaterThan(0);
    for (const a of applied) expect(await prisma.notification.count({ where: { dedupKey: `owner_alert:${a.id}` } }), a.id).toBe(1);
  });
});
