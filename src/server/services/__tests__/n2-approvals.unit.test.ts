import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Actor } from "../../lib/actor";
import { PERMISSIONS, ROLE_PERMISSIONS } from "../../lib/permissions";
import { renderTemplate, type TemplateContext } from "../../notifications/templates";
import { hasFullRights, MAX_ITEMS_PER_HOUR, MAX_ITEMS_PER_RUN, OPERATION_PERMISSION, SINGLE_STEP_OPERATIONS } from "../approval.service";
import { bulkApprovalPayload, bulkItemsHash, freeCancellationText, freezeItems } from "../bulk-listing.service";
import { alertFacts, ownerAlertContext, ownerAlertProblem, ownerAlertRecipient, OWNER_ALERT_LATE_MS } from "../owner-alert";
import { policyTextAgrees } from "../readiness.service";

/**
 * Doc 30 N2, pure parts: the one-person path's scope (exactly three
 * operations, in code and in migration M4), "full rights", the owner alert's
 * recipient, content and failure detection, and the bulk run's frozen list
 * and cancellation text. The database half is n2-approvals.db.test.ts and
 * n2-proofs-bulk.db.test.ts.
 */

const admin = (perms: readonly string[] = ROLE_PERMISSIONS.admin): Actor => ({
  type: "admin",
  id: "01a2b3c4-0000-7000-8000-000000000001",
  displayName: "Fixture admin",
  roles: ["admin"],
  permissions: new Set(perms),
});

describe("one-person approval scope (D15, D16, D25; RR-02)", () => {
  it("names exactly three operations, all under the instant-activation permission", () => {
    expect([...SINGLE_STEP_OPERATIONS].sort()).toEqual(["instant.activate", "instant.activate.bulk", "supplier.capability.enable"]);
    for (const op of SINGLE_STEP_OPERATIONS) expect(OPERATION_PERMISSION[op]).toBe("products.activate_instant");
    expect(OPERATION_PERMISSION["supplier.resume"]).toBe("suppliers.resume");
    expect([MAX_ITEMS_PER_RUN, MAX_ITEMS_PER_HOUR]).toEqual([50, 100]);
  });

  it("migration M4's checks name the same three operations and widen the operation check with the bulk one", () => {
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations/20261127140000_n2_single_step_approvals/migration.sql"), "utf8");
    const three = "('instant.activate', 'instant.activate.bulk', 'supplier.capability.enable')";
    const dual = sql.slice(sql.indexOf('ADD CONSTRAINT "pa_production_dual_check"'));
    expect(dual.slice(0, dual.indexOf("NOT VALID"))).toContain(`"approval_mode" = 'single_step_up' AND "operation" IN ${three}`);
    const single = sql.slice(sql.indexOf('ADD CONSTRAINT "pa_single_step_check"'));
    expect(single.slice(0, single.indexOf("NOT VALID"))).toContain(three);
    for (const other of ["supplier.resume", "supplier.limits.raise", "booking.privileged_resolution"]) {
      expect(dual.slice(0, dual.indexOf("NOT VALID"))).not.toContain(other);
    }
    expect(sql).toMatch(/pa_operation_check"\s+CHECK \("operation" IN \([^)]*'instant\.activate\.bulk'/);
    // Unchanged: the distinct-approver check is not touched.
    expect(sql).not.toMatch(/DROP CONSTRAINT "pa_distinct_approver_check"/);
  });

  it("full rights: a staff administrator holding every permission; one missing, an agent or the system actor is not", () => {
    expect(hasFullRights(admin())).toBe(true);
    expect(hasFullRights(admin(PERMISSIONS.filter((p) => p !== "tickets.resend")))).toBe(false);
    expect(hasFullRights({ ...admin(), type: "agent" })).toBe(false);
    expect(hasFullRights({ ...admin(), id: undefined })).toBe(false);
    expect(hasFullRights({ type: "system", roles: ["system"], permissions: new Set(["*"]) })).toBe(false);
    expect(hasFullRights(admin(ROLE_PERMISSIONS.ops))).toBe(false);
  });
});

describe("owner alert (owner-alert.ts)", () => {
  const owner = ["zz-owner", "example.test"].join("@");

  it("recipient: an email address from the environment, or null (one-person path off)", () => {
    expect(ownerAlertRecipient(owner)).toBe(owner);
    expect(ownerAlertRecipient(` ${owner} `)).toBe(owner);
    expect(ownerAlertRecipient(undefined)).toBeNull();
    expect(ownerAlertRecipient("")).toBeNull();
    expect(ownerAlertRecipient("not an address")).toBeNull();
    expect(ownerAlertRecipient(`${owner},second`)).toBeNull();
  });

  it("facts: whitelisted short codes only; never a reference, reason or free text", () => {
    const facts = alertFacts({ kind: "class_proof", classKey: "live.fixed_slot_single.self.internal.per_person", reference: "booking 12345 note", note: "secret-looking text", itemCount: 7, enabled: true, productId: "not-a-uuid" });
    expect(facts).toEqual(["kind: class_proof", "classKey: live.fixed_slot_single.self.internal.per_person", "enabled: true", "itemCount: 7"]);
  });

  it("context and email: ids, codes and a link; rendered as an email only", () => {
    const at = new Date("2026-11-27T10:00:00.000Z");
    const ctx = ownerAlertContext(
      { approvalId: "01a2b3c4-0000-7000-8000-0000000000aa", operation: "instant.activate.bulk", environment: "production", actor: admin(), itemCount: 12, payload: { kind: "bulk_listings", action: "arm", itemCount: 12 }, at },
      "https://outly.example.test/",
    );
    expect(ctx).toMatchObject({ operation: "instant.activate.bulk", itemCount: 12, actorName: "Fixture admin", adminUrl: "https://outly.example.test/admin/audit", appliedAt: at.toISOString() });
    const r = renderTemplate("OWNER_ACTION_ALERT", "email", ctx as unknown as TemplateContext);
    expect(r.subject).toMatch(/^\[OUTLY OWNER ALERT\] /);
    expect(r.text).toContain("Listings: 12");
    expect(r.text).toContain("action: arm");
    expect(r.text).toContain("01a2b3c4-0000-7000-8000-0000000000aa");
    expect(r.html).toContain("Open in admin");
  });

  it("failure detection: failed, attention, suppressed or late rows need ops; sent and fresh rows do not", () => {
    const created = new Date("2026-11-27T10:00:00.000Z");
    const base = { id: "n1", status: "queued", attempt: 1, providerError: null, failedAt: null, attentionRequiredAt: null, createdAt: created, payload: {} };
    const soon = new Date(created.getTime() + 60_000);
    const late = new Date(created.getTime() + OWNER_ALERT_LATE_MS);
    expect(ownerAlertProblem(base, soon)).toBeNull();
    expect(ownerAlertProblem({ ...base, status: "sent" }, late)).toBeNull();
    expect(ownerAlertProblem(base, late)).toEqual({ reason: "owner_alert_late", raisedAt: late });
    expect(ownerAlertProblem({ ...base, status: "failed", providerError: "definite:http_422", failedAt: soon }, soon)).toEqual({ reason: "owner_alert_failed", raisedAt: soon });
    expect(ownerAlertProblem({ ...base, status: "failed", providerError: "retryable:http_500", failedAt: soon }, soon)).toBeNull();
    expect(ownerAlertProblem({ ...base, status: "unknown", attentionRequiredAt: soon }, soon)).toEqual({ reason: "owner_alert_attention", raisedAt: soon });
    expect(ownerAlertProblem({ ...base, status: "suppressed" }, soon)).toEqual({ reason: "owner_alert_suppressed", raisedAt: created });
  });
});

describe("bulk runs: frozen list and cancellation text (§3.12, D6)", () => {
  const a = "01a2b3c4-0000-7000-8000-00000000000a";
  const b = "01a2b3c4-0000-7000-8000-00000000000b";

  it("the frozen list is unique and sorted, so its hash does not depend on order", () => {
    expect(freezeItems([b, a, b])).toEqual([a, b]);
    expect(bulkItemsHash([b, a])).toBe(bulkItemsHash([a, b]));
    expect(bulkItemsHash([a])).not.toBe(bulkItemsHash([a, b]));
    expect(bulkApprovalPayload("arm", "production", [b, a])).toEqual({ kind: "bulk_listings", action: "arm", environment: "production", itemsHash: bulkItemsHash([a, b]), itemCount: 2 });
    expect(bulkApprovalPayload("arm", "production", [a])).not.toEqual(bulkApprovalPayload("free_cancellation", "production", [a]));
  });

  it("the confirmed cancellation text states exactly the supplier window, so readiness accepts it", () => {
    for (const hours of [24, 48, 72]) {
      for (const dateOnly of [false, true]) {
        const text = freeCancellationText(hours, dateOnly);
        expect(policyTextAgrees(text, hours), text).toBe(true);
        expect(policyTextAgrees(text, hours + 1)).toBe(false);
      }
    }
    expect(freeCancellationText(24, true)).toBe("Free cancellation up to 24 hours before 00:00 Dubai time on the day");
  });
});
