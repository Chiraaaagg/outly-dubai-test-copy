import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { Actor } from "../../lib/actor";
import { isAppError } from "../../lib/errors";
import { uuidv7 } from "../../lib/ids";
import { ROLE_PERMISSIONS, type RoleCode } from "../../lib/permissions";
import { assertDisposableDb, cleanupPeople, createStaff, dbEnabled, runId, type StaffFixture } from "../helpers/fixtures";

/**
 * Instant activation end to end on the disposable database (PRD-12, SEC-10):
 * `catalogService.setFulfilmentMode` through the real approval service.
 *
 *  - ops holds `products.publish` but not `products.activate_instant`;
 *  - outside production an administrator activates after a step-up;
 *  - in production the same administrator asking twice stays pending and the
 *    product stays inquiry; a second administrator's request applies it.
 *
 * The release switch is overridden on the env module and the deployment
 * environment through `vi.stubEnv` (the approval environment reads the raw
 * `APP_ENV`/`VERCEL_ENV`). The supplier registry reports that the mapped
 * adapter can confirm, so only the permission and approval rules decide. Staff, the
 * supplier, the product and approval rows are synthetic (`zz-sec-<run>`) and
 * removed in afterAll; audit rows are append-only and stay. TOTP codes are
 * real codes for the current time; `verifyTotp` accepts the neighbouring
 * step, so the previous step gives one person a second fresh code.
 */

vi.mock("../../lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/env")>();
  return { ...actual, env: () => ({ ...actual.env(), INSTANT_RELEASE_ENABLED: true }) };
});
vi.mock("../../suppliers/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../suppliers/registry")>();
  return { ...actual, supplierFor: () => ({ capabilities: () => ({ instantConfirmation: true }) }) };
});

const RUN = runId();

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

describe.skipIf(!dbEnabled)("instant activation: permission, step-up and dual approval", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let catalog: typeof import("../../services/catalog.service").catalogService;
  const secrets = new Map<string, string>();
  const staff: Record<string, StaffFixture> = {};
  const productIds: string[] = [];
  let supplierId: string;

  function actor(label: string, role: RoleCode): Actor {
    return { type: "admin", id: staff[label].id, roles: [role], permissions: new Set(ROLE_PERMISSIONS[role]) };
  }
  /** `stepsBack` 0 is the current code; 1 the previous step's, still accepted. */
  const code = (label: string, stepsBack = 0) => totpAt(secrets.get(label)!, new Date(Date.now() - stepsBack * 30_000));

  async function newProduct(): Promise<string> {
    const any = await prisma.product.findFirstOrThrow({ select: { categorySlug: true } });
    const id = uuidv7();
    await prisma.product.create({ data: { id, slug: `zz-sec-${RUN}-${productIds.length}`, title: "test-activation", tier: "C", categorySlug: any.categorySlug, confirmation: "instant" } });
    await prisma.productSupplierMapping.create({ data: { id: uuidv7(), productId: id, supplierId, isActive: true } });
    productIds.push(id);
    return id;
  }
  const modeOf = async (id: string) => (await prisma.product.findUniqueOrThrow({ where: { id } })).fulfilmentMode;

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    ({ catalogService: catalog } = await import("../../services/catalog.service"));
    const { encryptSecret, generateTotpSecret } = await import("../../lib/crypto");
    const roles: Record<string, RoleCode> = { a: "admin", b: "admin", c: "admin", ops: "ops" };
    for (const [label, role] of Object.entries(roles)) {
      staff[label] = await createStaff(RUN, label, [role]);
      const secret = generateTotpSecret();
      secrets.set(label, secret);
      await prisma.adminUser.update({ where: { id: staff[label].id }, data: { totpSecretEncrypted: encryptSecret(secret) } });
    }
    supplierId = uuidv7();
    await prisma.supplier.create({ data: { id: supplierId, code: `zz-sec-${RUN}`, name: "zz activation fixture", source: "api", adapter: "rathin", status: "active" } });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!prisma) return;
    const ids = Object.values(staff).map((s) => s.id);
    await prisma.privilegedApproval.deleteMany({ where: { OR: [{ requestedBy: { in: ids } }, { approvedBy: { in: ids } }] } });
    await prisma.rateLimitBucket.deleteMany({ where: { key: { in: ids.map((id) => `admin_totp:${id}`) } } }).catch(() => {});
    await prisma.idempotencyKey.deleteMany({ where: { scope: "admin_totp", OR: ids.map((id) => ({ key: { startsWith: `totp:${id}:` } })) } });
    await prisma.productSupplierMapping.deleteMany({ where: { supplierId } });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    await cleanupPeople(RUN);
  });

  it("ops cannot activate, even with a valid code; nothing is requested or written", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("VERCEL_ENV", undefined);
    const id = await newProduct();
    const e = await catalog.setFulfilmentMode(actor("ops", "ops"), { kind: "product", id }, "instant", "ops trying to go live", { totpCode: code("ops") }).catch((x) => x);
    expect(isAppError(e) && e.code).toBe("FORBIDDEN");
    expect(await modeOf(id)).toBe("inquiry");
    expect(await prisma.privilegedApproval.count({ where: { requestedBy: staff.ops.id } })).toBe(0);
  });

  it("test environment: an administrator activates after a step-up; a wrong code changes nothing", async () => {
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("VERCEL_ENV", undefined);
    const id = await newProduct();
    const current = code("c");
    const wrong = current === "000000" ? "111111" : "000000";
    const refused = await catalog.setFulfilmentMode(actor("c", "admin"), { kind: "product", id }, "instant", "staging go-live check", { totpCode: wrong }).catch((x) => x);
    expect(isAppError(refused) && refused.code).toBe("VALIDATION_FAILED");
    expect(await modeOf(id)).toBe("inquiry");

    const r = await catalog.setFulfilmentMode(actor("c", "admin"), { kind: "product", id }, "instant", "staging go-live check", { totpCode: current });
    expect(r.status).toBe("applied");
    expect(await modeOf(id)).toBe("instant");
    const row = await prisma.privilegedApproval.findUniqueOrThrow({ where: { id: r.approvalId! } });
    expect(row).toMatchObject({ operation: "instant.activate", permission: "products.activate_instant", environment: "test", status: "applied", approvedBy: null });
  });

  it("production: one administrator cannot satisfy dual approval; a second one applies it", async () => {
    vi.stubEnv("APP_ENV", "production");
    const id = await newProduct();

    const first = await catalog.setFulfilmentMode(actor("a", "admin"), { kind: "product", id }, "instant", "go live after review", { totpCode: code("a", 1) });
    expect(first).toMatchObject({ status: "pending", fulfilmentMode: "inquiry" });
    expect(await modeOf(id)).toBe("inquiry");

    // The same person again, with another fresh code and another reason: still pending.
    const again = await catalog.setFulfilmentMode(actor("a", "admin"), { kind: "product", id }, "instant", "asking a second time", { totpCode: code("a") });
    expect(again).toMatchObject({ status: "pending", approvalId: first.approvalId });
    expect(await modeOf(id)).toBe("inquiry");
    const pending = await prisma.privilegedApproval.findUniqueOrThrow({ where: { id: first.approvalId! } });
    expect(pending).toMatchObject({ status: "pending", environment: "production", approvedBy: null });

    // A second administrator asking for the same activation applies it.
    const second = await catalog.setFulfilmentMode(actor("b", "admin"), { kind: "product", id }, "instant", "second approver agrees", { totpCode: code("b") });
    expect(second).toMatchObject({ status: "applied", fulfilmentMode: "instant", approvalId: first.approvalId });
    expect(await modeOf(id)).toBe("instant");
    const applied = await prisma.privilegedApproval.findUniqueOrThrow({ where: { id: first.approvalId! } });
    expect(applied).toMatchObject({ status: "applied", requestedBy: staff.a.id, approvedBy: staff.b.id });
  });

  it("production: switching back to inquiry needs no code and no second person", async () => {
    vi.stubEnv("APP_ENV", "production");
    const id = await newProduct();
    await prisma.product.update({ where: { id }, data: { fulfilmentMode: "instant" } });
    const r = await catalog.setFulfilmentMode(actor("ops", "ops"), { kind: "product", id }, "inquiry", "supplier failing since noon");
    expect(r).toMatchObject({ status: "applied", fulfilmentMode: "inquiry", approvalId: null });
    expect(await modeOf(id)).toBe("inquiry");
  });
});
