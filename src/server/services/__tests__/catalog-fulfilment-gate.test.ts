import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../lib/actor";
import { isAppError } from "../../lib/errors";
import { ROLE_CODES, ROLE_PERMISSIONS, type RoleCode } from "../../lib/permissions";

/**
 * The instant-mode release switch on `catalogService.setFulfilmentMode`
 * (doc 22 PRD-2, B0 gate 5a), and how the flip uses the privileged approval
 * service (PRD-12). Pure: Prisma, audit, cache revalidation, the environment,
 * the supplier registry and the approval service are all replaced, so nothing
 * here opens a database connection. The approval flows themselves run in
 * approval.service.test.ts (db project).
 */

const state = vi.hoisted(() => ({
  instantReleased: false,
  confirms: true,
  approval: { status: "applied", approvalId: "approval-1" } as Record<string, unknown>,
  approvalCalls: [] as unknown[][],
  product: null as Record<string, unknown> | null,
  updates: [] as unknown[],
  audits: [] as unknown[],
  reevaluations: [] as unknown[][],
}));

vi.mock("../../lib/db", () => ({
  prisma: {
    product: {
      findUnique: vi.fn(async () => state.product),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        state.updates.push(args);
        return { ...state.product, ...args.data };
      }),
    },
    combo: {
      findUnique: vi.fn(async () => ({ id: "combo-1", fulfilmentMode: "inquiry" })),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "combo-1", ...args.data })),
    },
  },
}));
vi.mock("../../lib/audit", () => ({ audit: vi.fn(async (...args: unknown[]) => void state.audits.push(args)) }));
vi.mock("../../lib/catalog-cache", () => ({ revalidateCatalog: vi.fn() }));
vi.mock("../../lib/env", () => ({ env: () => ({ INSTANT_RELEASE_ENABLED: state.instantReleased }) }));
vi.mock("../approval.service", () => ({
  approvalService: {
    requestPrivileged: vi.fn(async (...args: unknown[]) => {
      state.approvalCalls.push(args);
      return state.approval;
    }),
  },
}));
vi.mock("../readiness.service", () => ({
  readinessService: {
    reevaluate: vi.fn(async (productId: string, trigger: string) => {
      state.reevaluations.push([productId, trigger]);
      return { productId, requested: "instant", effective: "inquiry", reasons: ["release_switch_off"], readinessVersion: 1, evaluatedAt: "2026-11-01T00:00:00.000Z" };
    }),
  },
}));
vi.mock("../../suppliers/registry", () => ({
  // The manual adapter never confirms (as in the real registry); every other adapter follows `state.confirms`.
  supplierFor: (s: { adapter: string }) => ({ capabilities: () => ({ instantConfirmation: s.adapter === "manual" ? false : state.confirms }) }),
}));

const { catalogService, approvalEnvironmentFor } = await import("../catalog.service");

const admin: Actor = { type: "admin", id: "admin-1", roles: ["admin"], permissions: new Set(["*"]) };
const asRole = (role: RoleCode): Actor => ({ type: "admin", id: `${role}-1`, roles: [role], permissions: new Set(ROLE_PERMISSIONS[role]) });
const code = { totpCode: "123456" };

function productWithApiMapping(mode: "inquiry" | "instant" = "inquiry") {
  return {
    id: "product-1",
    fulfilmentMode: mode,
    mappings: [
      { isActive: true, supplier: { source: "api", adapter: "rathin", status: "active", deletedAt: null } },
    ],
  };
}

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to be refused");
}

beforeEach(() => {
  state.instantReleased = false;
  // The approval environment reads the raw variables; default to a positively identified dev deployment.
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("VERCEL_ENV", undefined);
  state.confirms = true;
  state.approval = { status: "applied", approvalId: "approval-1" };
  state.approvalCalls = [];
  state.product = productWithApiMapping();
  state.updates = [];
  state.audits = [];
  state.reevaluations = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("setFulfilmentMode: instant release switch", () => {
  it("refuses instant with a typed validation error while the switch is off, even when every other check passes", async () => {
    const e = await refusal(catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "instant", "go live"));
    expect(isAppError(e)).toBe(true);
    if (!isAppError(e)) return;
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(e.status).toBe(422);
    expect(e.message).toBe("Instant mode is not released in this environment");
    expect((e.details as { fields: Record<string, string> }).fields.mode).toMatch(/switched off for this environment/);
    expect(state.updates).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it("refuses instant for a combo too while the switch is off", async () => {
    const e = await refusal(catalogService.setFulfilmentMode(admin, { kind: "combo", id: "combo-1" }, "instant", "go live"));
    expect(isAppError(e) && e.code).toBe("VALIDATION_FAILED");
  });

  it("always allows switching back to inquiry, switch off", async () => {
    state.product = productWithApiMapping("instant");
    const after = await catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "inquiry", "rollback");
    expect(after.fulfilmentMode).toBe("inquiry");
    expect(state.updates).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it("with the switch on, instant goes through when the supplier can confirm", async () => {
    state.instantReleased = true;
    const after = await catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "instant", "go live", code);
    expect(after).toMatchObject({ status: "applied", fulfilmentMode: "instant", approvalId: "approval-1" });
    expect(state.audits).toHaveLength(1);
  });

  it("with the switch on, the supplier capability check still refuses", async () => {
    state.instantReleased = true;
    state.confirms = false;
    const e = await refusal(catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "instant", "go live", code));
    expect(isAppError(e) && e.code).toBe("CONFLICT");
    expect(state.updates).toHaveLength(0);
    // Checks run before the step-up, so a product that cannot qualify burns no code.
    expect(state.approvalCalls).toHaveLength(0);
  });

  it("an editorial supplier record (adapter manual) beside a confirming mapping does not block instant", async () => {
    state.instantReleased = true;
    state.product = {
      id: "product-1",
      fulfilmentMode: "inquiry",
      mappings: [
        { isActive: true, supplier: { source: "api", adapter: "traveldesk", status: "active", deletedAt: null } },
        // Made by the editor from the content's supplier block ("API aggregator"); it never books.
        { isActive: true, supplier: { source: "api", adapter: "manual", status: "active", deletedAt: null } },
      ],
    };
    const after = await catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "instant", "go live", code);
    expect(after).toMatchObject({ status: "applied", fulfilmentMode: "instant" });
  });

  it("an editorial supplier record alone is still refused: it is not an API mapping that can book", async () => {
    state.instantReleased = true;
    state.product = { id: "product-1", fulfilmentMode: "inquiry", mappings: [{ isActive: true, supplier: { source: "api", adapter: "manual", status: "active", deletedAt: null } }] };
    const e = await refusal(catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "instant", "go live", code));
    expect(isAppError(e) && e.code).toBe("CONFLICT");
    expect(state.updates).toHaveLength(0);
  });

  it("with the switch on, a product without an API mapping is still refused", async () => {
    state.instantReleased = true;
    state.product = { id: "product-1", fulfilmentMode: "inquiry", mappings: [] };
    const e = await refusal(catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "instant", "go live", code));
    expect(isAppError(e) && e.code).toBe("CONFLICT");
  });
});

describe("setFulfilmentMode: instant activation permission and approval (PRD-12)", () => {
  beforeEach(() => {
    state.instantReleased = true;
  });

  it("role matrix: only roles holding products.activate_instant can activate; products.publish is not enough", async () => {
    for (const role of ROLE_CODES) {
      state.updates = [];
      state.approvalCalls = [];
      const actor = asRole(role);
      const holds = ROLE_PERMISSIONS[role].includes("products.activate_instant");
      const result = await catalogService.setFulfilmentMode(actor, { kind: "product", id: "product-1" }, "instant", "go live", code).catch((e) => e);
      if (holds) {
        expect(result, role).toMatchObject({ status: "applied", fulfilmentMode: "instant" });
      } else {
        expect(isAppError(result) && result.code, role).toBe("FORBIDDEN");
        expect(state.updates, role).toHaveLength(0);
        expect(state.approvalCalls, role).toHaveLength(0);
      }
    }
    expect(ROLE_PERMISSIONS.admin).toContain("products.activate_instant");
    expect(ROLE_PERMISSIONS.ops).toContain("products.publish");
    expect(ROLE_PERMISSIONS.ops).not.toContain("products.activate_instant");
  });

  it("ops cannot activate, but can still switch an instant product back to inquiry at once", async () => {
    const ops = asRole("ops");
    const e = await refusal(catalogService.setFulfilmentMode(ops, { kind: "product", id: "product-1" }, "instant", "go live", code));
    expect(isAppError(e) && e.code).toBe("FORBIDDEN");

    state.product = productWithApiMapping("instant");
    const back = await catalogService.setFulfilmentMode(ops, { kind: "product", id: "product-1" }, "inquiry", "supplier failing");
    expect(back).toMatchObject({ status: "applied", fulfilmentMode: "inquiry", approvalId: null });
    expect(state.approvalCalls).toHaveLength(0);
  });

  it("a role with activate_instant but without products.publish cannot switch back to inquiry", async () => {
    const activateOnly: Actor = { type: "admin", id: "x-1", roles: [], permissions: new Set(["products.activate_instant"]) };
    state.product = productWithApiMapping("instant");
    const e = await refusal(catalogService.setFulfilmentMode(activateOnly, { kind: "product", id: "product-1" }, "inquiry", "rollback"));
    expect(isAppError(e) && e.code).toBe("FORBIDDEN");
  });

  it("admin in a test environment: step-up through requestPrivileged, then applied", async () => {
    const after = await catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "instant", "go live", code);
    expect(after).toMatchObject({ status: "applied", fulfilmentMode: "instant", approvalId: "approval-1" });
    expect(state.approvalCalls).toEqual([
      [admin, "instant.activate", "products.activate_instant", { kind: "product", productId: "product-1", mode: "instant" }, { environment: "test", totpCode: "123456" }],
    ]);
    const auditArgs = state.audits[0] as unknown[];
    expect(auditArgs[1]).toBe("product.fulfilment_mode");
    expect((auditArgs[3] as { after: Record<string, unknown> }).after).toEqual({ fulfilmentMode: "instant", approvalId: "approval-1" });
  });

  it("refuses activation without a code, before asking for approval", async () => {
    const e = await refusal(catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "instant", "go live"));
    expect(isAppError(e) && e.code).toBe("VALIDATION_FAILED");
    expect(isAppError(e) && (e.details as { fields: Record<string, string> }).fields.totpCode).toBeTruthy();
    expect(state.approvalCalls).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("a refused step-up writes nothing", async () => {
    state.approval = { status: "refused", reason: "step_up_required" };
    const e = await refusal(catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "instant", "go live", code));
    expect(isAppError(e) && e.code).toBe("VALIDATION_FAILED");
    expect(state.updates).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it("production: pending until a second approver, and nothing is written meanwhile", async () => {
    vi.stubEnv("APP_ENV", "production");
    state.approval = { status: "pending", approvalId: "approval-2", needs: "second_approver" };
    const first = await catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "instant", "go live", code);
    expect(first).toEqual({ status: "pending", id: "product-1", fulfilmentMode: "inquiry", approvalId: "approval-2" });
    expect((state.approvalCalls[0][4] as { environment: string }).environment).toBe("production");
    expect(state.updates).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it("an unknown deployment environment counts as production", async () => {
    vi.stubEnv("APP_ENV", undefined);
    state.approval = { status: "pending", approvalId: "approval-3", needs: "second_approver" };
    const r = await catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "instant", "go live", code);
    expect(r.status).toBe("pending");
    expect((state.approvalCalls[0][4] as { environment: string }).environment).toBe("production");
  });

  it("the same activation from two people with different reasons sends the same payload", async () => {
    await catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "instant", "first reason here", code);
    await catalogService.setFulfilmentMode({ ...admin, id: "admin-2" }, { kind: "product", id: "product-1" }, "instant", "a different reason", code);
    expect(state.approvalCalls[0][3]).toEqual(state.approvalCalls[1][3]);
  });
});

describe("approvalEnvironmentFor: fails closed to production (CR-B1-3)", () => {
  it("unset APP_ENV is production, even though env() would default it to development", () => {
    expect(approvalEnvironmentFor({})).toBe("production");
    expect(approvalEnvironmentFor({ APP_ENV: undefined, VERCEL_ENV: "preview" })).toBe("production");
  });

  it("an unknown or non-allowlisted APP_ENV is production", () => {
    for (const v of ["staging", "Development", " development", "dev", "", "prod"]) {
      expect(approvalEnvironmentFor({ APP_ENV: v }), v).toBe("production");
    }
  });

  it("APP_ENV=production is production", () => {
    expect(approvalEnvironmentFor({ APP_ENV: "production" })).toBe("production");
    expect(approvalEnvironmentFor({ APP_ENV: "production", VERCEL_ENV: "preview" })).toBe("production");
  });

  it("APP_ENV=development counts as test, unless Vercel reports a production deployment", () => {
    expect(approvalEnvironmentFor({ APP_ENV: "development" })).toBe("test");
    expect(approvalEnvironmentFor({ APP_ENV: "development", VERCEL_ENV: "preview" })).toBe("test");
    expect(approvalEnvironmentFor({ APP_ENV: "test" })).toBe("test");
    expect(approvalEnvironmentFor({ APP_ENV: "development", VERCEL_ENV: "production" })).toBe("production");
  });

  it("the flip itself sends production when the variables are unset or staging", async () => {
    state.instantReleased = true;
    state.approval = { status: "pending", approvalId: "approval-4", needs: "second_approver" };
    vi.stubEnv("APP_ENV", "staging");
    await catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "instant", "go live", code);
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("VERCEL_ENV", "production");
    await catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "instant", "go live", code);
    expect(state.approvalCalls.map((c) => (c[4] as { environment: string }).environment)).toEqual(["production", "production"]);
  });
});

describe("setFulfilmentMode: requested mode vs effective eligibility (PRD-11)", () => {
  it("an applied flip records the requested mode and re-evaluates readiness, whose verdict it returns", async () => {
    state.instantReleased = true;
    const r = await catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "instant", "pilot", code);
    expect(r).toMatchObject({ status: "applied", fulfilmentMode: "instant", readiness: { effective: "inquiry" } });
    expect(state.reevaluations).toEqual([["product-1", "flip"]]);
  });

  it("switching back to inquiry re-evaluates too, so a stored instant verdict is cleared", async () => {
    state.product = productWithApiMapping("instant");
    await catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "inquiry", "pause");
    expect(state.reevaluations).toEqual([["product-1", "flip"]]);
  });

  it("a pending production activation does not re-evaluate (nothing was written)", async () => {
    state.instantReleased = true;
    state.approval = { status: "pending", approvalId: "approval-2" };
    await catalogService.setFulfilmentMode(admin, { kind: "product", id: "product-1" }, "instant", "pilot", code);
    expect(state.reevaluations).toEqual([]);
  });
});
