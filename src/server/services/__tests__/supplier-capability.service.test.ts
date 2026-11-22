import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaff } from "../../__tests__/helpers/fixtures";
import { assertDisposableDb, assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import type { Actor } from "../../lib/actor";
import { isAppError } from "../../lib/errors";
import { uuidv7 } from "../../lib/ids";
import { storedOffer, storedSlot, storedTour } from "../../suppliers/__tests__/fixtures/traveldesk-terms";
import { offerTermsHash } from "../../suppliers/traveldesk/traveldesk.offer-terms";

/**
 * Capability-class flags and per-offer evidence (doc 29 §3.3, Batch 1a)
 * against the LOCAL disposable database. The target guard refuses anything
 * else. Rows live under a run-scoped supplier code and `zz-test-` product
 * slug and are removed in afterAll; the pickup flag this suite switches is
 * deleted again (a missing row reads as off, its default). Audit rows and
 * the staff fixtures stay (approvals keep their people). Synthetic ids and
 * amounts only.
 *
 * Approvals are inserted as applied rows, as the engine suite does for its
 * controls: the step-up and second-person flow is approval.service's own
 * suite. What is checked here is that the flag service uses them exactly.
 */

const enabled = Boolean(process.env.DATABASE_URL);
const RUN = uuidv7().slice(-8);
const CODE = `zz-cap-${RUN}`;
const BASE = 950_000_000 + Math.floor(Math.random() * 40_000_000);
const PICKUP = "live.fixed_slot_single.pickup_required.internal.per_person";
const SEEDED = ["live.fixed_slot_single.self.internal.per_person", "live.fixed_slot_choice.self.internal.per_person"];
const PER_UNIT = "live.fixed_slot_single.self.internal.per_unit";

describe.skipIf(!enabled)("supplier capability flags and evidence (local DB)", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let svc: typeof import("../supplier-capability.service").supplierCapabilityService;
  let cap: typeof import("../supplier-capability.service");
  let catalog: typeof import("../supplier-catalog.service").supplierCatalogService;
  let privilegedPayloadHash: typeof import("../approval.service").privilegedPayloadHash;
  let a: Actor;
  let b: Actor;
  let viewer: Actor;
  let supplierId: string;
  let productId: string;
  const TOUR = BASE;
  const OFFER = BASE + 1;
  const offerPayload = storedOffer({ offerId: OFFER, tourId: TOUR, isDirectReporting: false, timeSlots: [storedSlot()] });
  const tourPayload = storedTour({ tourId: TOUR });
  const terms = offerTermsHash(offerPayload, tourPayload)!;

  async function approval(payload: Record<string, unknown>, environment: "test" | "production", opts: { requestedBy?: string; approvedBy?: string | null; status?: string } = {}) {
    const op = "supplier.capability.enable";
    const permission = "products.activate_instant";
    const at = new Date();
    const approvedBy = opts.approvedBy === undefined ? (environment === "production" ? b.id : null) : opts.approvedBy;
    const status = opts.status ?? "applied";
    const row = await prisma.privilegedApproval.create({
      data: {
        id: uuidv7(),
        operation: op,
        permission,
        payload: payload as never,
        payloadHash: privilegedPayloadHash(op, permission, environment, payload),
        environment,
        status,
        requestedBy: opts.requestedBy ?? a.id!,
        approvedBy: status === "applied" ? approvedBy : null,
        approvedAt: status === "applied" && approvedBy ? at : null,
        requestedAt: at,
        appliedAt: status === "applied" ? at : null,
        expiresAt: new Date(at.getTime() + 30 * 60_000),
      },
    });
    return row.id;
  }

  async function flagApproval(environment: "test" | "production", classKey: string) {
    const { before } = await svc.flagRequest(environment, classKey, true);
    return approval(cap.flagApprovalPayload("traveldesk", environment, classKey, true, before), environment);
  }

  const code = (e: unknown) => (isAppError(e) ? e.code : String(e));
  const readiness = async () => (await catalog.mappingReadinessFor(productId, "test", { supplierCode: CODE })).variants[0];

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    cap = await import("../supplier-capability.service");
    svc = cap.supplierCapabilityService;
    ({ supplierCatalogService: catalog } = await import("../supplier-catalog.service"));
    ({ privilegedPayloadHash } = await import("../approval.service"));
    const sa = await createStaff(RUN, "cap-a", ["admin"]);
    const sb = await createStaff(RUN, "cap-b", ["admin"]);
    a = { type: "admin", id: sa.id, roles: ["admin"], permissions: new Set(["*"]) };
    b = { type: "admin", id: sb.id, roles: ["admin"], permissions: new Set(["*"]) };
    viewer = { type: "admin", id: uuidv7(), roles: ["content"], permissions: new Set(["products.edit"]) };

    // Nothing left over from an earlier failed run of this suite.
    await prisma.supplierCapabilityFlag.deleteMany({ where: { adapter: "traveldesk", classKey: PICKUP } });
    supplierId = uuidv7();
    await prisma.supplier.create({ data: { id: supplierId, code: CODE, name: "zz capability test", source: "api", adapter: "traveldesk" } });
    for (const [kind, externalId, parent, payload] of [
      ["tour", String(TOUR), null, tourPayload],
      ["offer", String(OFFER), String(TOUR), offerPayload],
    ] as const) {
      await prisma.supplierCatalogueItem.create({
        data: { id: uuidv7(), supplierId, environment: "test", kind, externalId, parentExternalId: parent, name: `zz cap ${kind}`, bookingKind: kind === "offer" ? "live_book" : null, payload: payload as never, payloadHash: "x" },
      });
    }
    const any = await prisma.product.findFirstOrThrow({ select: { categorySlug: true } });
    productId = uuidv7();
    await prisma.product.create({
      data: { id: productId, slug: `zz-test-${RUN}-cap`, title: "zz capability product", tier: "C", status: "draft", categorySlug: any.categorySlug, confirmation: "instant", content: {} },
    });
    await prisma.productSupplierMapping.create({
      data: {
        id: uuidv7(),
        productId,
        supplierId,
        variantCode: null,
        externalRef: { tourId: TOUR, offerId: OFFER, bookingKind: "live_book", isExternal: false },
        supplierProductId: String(TOUR),
        supplierOfferId: String(OFFER),
        bookingKind: "live_book",
        environment: "test",
        syncStatus: "ok",
        approvedOfferHash: terms,
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.supplierCapabilityFlag.deleteMany({ where: { adapter: "traveldesk", classKey: PICKUP } });
    await prisma.productSupplierMapping.deleteMany({ where: { supplierId } });
    await prisma.supplierCatalogueItem.deleteMany({ where: { supplierId } });
    // Evidence and capability rows cascade with the supplier.
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    await prisma.product.deleteMany({ where: { slug: { startsWith: `zz-test-${RUN}` } } });
    await prisma.$disconnect();
  });

  it("the migration seeds exactly the two proven keys on, in both environments, without per-offer evidence", async () => {
    const rows = await prisma.supplierCapabilityFlag.findMany({ where: { adapter: "traveldesk", classKey: { in: SEEDED } } });
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r).toMatchObject({ enabled: true, requiresOfferEvidence: false, changedBy: null, approvalId: null });
    expect(await prisma.supplierCapabilityFlag.count({ where: { adapter: "traveldesk", classKey: PICKUP } })).toBe(0);
  });

  it("the database refuses an enabled per-unit key, a malformed key, and edits to recorded evidence", async () => {
    const insert = (classKey: string, on: boolean) =>
      prisma.supplierCapabilityFlag.create({ data: { id: uuidv7(), adapter: "zz-cap-db", environment: "test", classKey, enabled: on, reason: "database check in a test" } });
    await expect(insert(PER_UNIT, true)).rejects.toThrow();
    await expect(insert("unknown", false)).rejects.toThrow();
    const off = await insert(PER_UNIT, false);
    await expect(prisma.supplierCapabilityFlag.update({ where: { id: off.id }, data: { enabled: true } })).rejects.toThrow();
    await prisma.supplierCapabilityFlag.delete({ where: { id: off.id } });

    const ev = await prisma.supplierOfferEnablement.create({
      data: { id: uuidv7(), supplierId, environment: "test", offerExternalId: "1", classKey: PICKUP, evidenceKind: "contract_test", reference: "zz db guard", offerTermsHash: terms },
    });
    await expect(prisma.supplierOfferEnablement.update({ where: { id: ev.id }, data: { reference: "rewritten" } })).rejects.toThrow();
    await prisma.supplierOfferEnablement.update({ where: { id: ev.id }, data: { revokedAt: new Date(), revokeReason: "database guard test" } });
    await expect(prisma.supplierOfferEnablement.update({ where: { id: ev.id }, data: { revokedAt: null, revokeReason: null } })).rejects.toThrow();
  });

  it("readiness refuses a pickup offer while its key is off, and names why", async () => {
    const v = await readiness();
    expect(v.blockers).toContain("capability_not_ready");
    expect(v.mapping).toMatchObject({ capabilityClassKey: PICKUP, capabilityRefusal: "flag_off" });
  });

  it("switching on needs suppliers.manage and an applied approval for exactly that change, used once; off needs neither approval nor code", async () => {
    // Permission first.
    expect(code(await svc.setFlag(viewer, { environment: "test", classKey: PICKUP, enabled: true, reason: "no permission here" }).catch((e) => e))).toBe("FORBIDDEN");
    // Loosening without an approval: refused, even for an administrator.
    expect(code(await svc.setFlag(a, { environment: "test", classKey: PICKUP, enabled: true, reason: "turn on without approval" }).catch((e) => e))).toBe("FORBIDDEN");
    expect(await svc.flagRequest("test", PICKUP, true)).toMatchObject({ needs: "supplier.capability.enable" });
    expect(await svc.flagRequest("test", PICKUP, false)).toMatchObject({ needs: null });

    // An approval for another key or environment does not apply.
    const other = await flagApproval("test", "live.fixed_slot_choice.pickup_required.internal.per_person");
    expect(code(await svc.setFlag(a, { environment: "test", classKey: PICKUP, enabled: true, reason: "wrong approval" }, { approvalId: other }).catch((e) => e))).toBe("CONFLICT");

    const ok = await flagApproval("test", PICKUP);
    expect(await svc.setFlag(a, { environment: "test", classKey: PICKUP, enabled: true, reason: "sandbox pickup drill passed" }, { approvalId: ok })).toEqual({ changed: true, enabled: true });
    const row = await prisma.supplierCapabilityFlag.findUniqueOrThrow({ where: { adapter_environment_classKey: { adapter: "traveldesk", environment: "test", classKey: PICKUP } } });
    expect(row).toMatchObject({ enabled: true, approvalId: ok, changedBy: a.id, reason: "sandbox pickup drill passed", requiresOfferEvidence: true });
    const on = await prisma.auditLog.findFirstOrThrow({ where: { entityType: "supplier_capability_flag", entityId: row.id, action: "supplier_capability.enable" } });
    expect(on).toMatchObject({ actorId: a.id, reason: "sandbox pickup drill passed" });
    expect(on.after).toMatchObject({ classKey: PICKUP, environment: "test", enabled: true, approvalId: ok });

    // The same state again changes and writes nothing.
    expect(await svc.setFlag(a, { environment: "test", classKey: PICKUP, enabled: true, reason: "again with no approval" })).toEqual({ changed: false, enabled: true });

    // Off: tightening, no approval, audited.
    expect(await svc.setFlag(b, { environment: "test", classKey: PICKUP, enabled: false, reason: "pause pickup after an incident" })).toEqual({ changed: true, enabled: false });
    expect(await prisma.auditLog.count({ where: { entityType: "supplier_capability_flag", entityId: row.id, action: "supplier_capability.disable", actorId: b.id } })).toBe(1);

    // The used approval cannot switch it on again: it is bound to the flag as it was, and it was burned.
    expect(code(await svc.setFlag(a, { environment: "test", classKey: PICKUP, enabled: true, reason: "reuse the old approval" }, { approvalId: ok }).catch((e) => e))).toBe("CONFLICT");

    // An approval asked before the flag last changed no longer matches it.
    const stale = await flagApproval("test", PICKUP);
    const fresh = await flagApproval("test", PICKUP);
    expect(await svc.setFlag(a, { environment: "test", classKey: PICKUP, enabled: true, reason: "on with the fresh approval" }, { approvalId: fresh })).toMatchObject({ changed: true });
    await svc.setFlag(a, { environment: "test", classKey: PICKUP, enabled: false, reason: "off again for the next check" });
    expect(code(await svc.setFlag(a, { environment: "test", classKey: PICKUP, enabled: true, reason: "on with the stale approval" }, { approvalId: stale }).catch((e) => e))).toBe("CONFLICT");
  });

  it("production: a pending approval does not apply; one approved by a second person does", async () => {
    const { before } = await svc.flagRequest("production", PICKUP, true);
    const payload = cap.flagApprovalPayload("traveldesk", "production", PICKUP, true, before);
    const pending = await approval(payload, "production", { status: "pending" });
    expect(code(await svc.setFlag(a, { environment: "production", classKey: PICKUP, enabled: true, reason: "on before the second person" }, { approvalId: pending }).catch((e) => e))).toBe("CONFLICT");
    const approved = await approval(payload, "production", { approvedBy: b.id });
    // Someone who neither asked nor approved cannot use it.
    const third: Actor = { type: "admin", id: uuidv7(), roles: ["admin"], permissions: new Set(["*"]) };
    expect(code(await svc.setFlag(third, { environment: "production", classKey: PICKUP, enabled: true, reason: "use another person's approval" }, { approvalId: approved }).catch((e) => e))).toBe("FORBIDDEN");
    expect(await svc.setFlag(b, { environment: "production", classKey: PICKUP, enabled: true, reason: "second administrator approved" }, { approvalId: approved })).toMatchObject({ changed: true });
    expect(await svc.setFlag(a, { environment: "production", classKey: PICKUP, enabled: false, reason: "back off after the check" })).toMatchObject({ changed: true });
  });

  it("per-unit, date-only, ticket, unknown and inquiry keys can never be switched on", async () => {
    for (const key of [PER_UNIT, "live.date_only_no_slot_metadata.self.internal.per_person", "ticket.open_dated.self.internal.per_person"]) {
      const appr = await flagApproval("test", key);
      expect(code(await svc.setFlag(a, { environment: "test", classKey: key, enabled: true, reason: "try a never-on key" }, { approvalId: appr }).catch((e) => e)), key).toBe("CONFLICT");
    }
    for (const key of ["unknown", "inquiry_only", "live.fixed_slot_single.self.internal"]) {
      expect(code(await svc.setFlag(a, { environment: "test", classKey: key, enabled: true, reason: "try a malformed key" }).catch((e) => e)), key).toBe("VALIDATION_FAILED");
    }
  });

  it("an evidence-requiring key sells only with evidence for the offer's current terms; revoking it stops the sale again", async () => {
    const on = await flagApproval("test", PICKUP);
    await svc.setFlag(a, { environment: "test", classKey: PICKUP, enabled: true, reason: "evidence flow check on" }, { approvalId: on, supplierCode: CODE });
    expect((await readiness()).mapping).toMatchObject({ capabilityRefusal: "offer_evidence_missing" });

    const input = { environment: "test" as const, offerExternalId: String(OFFER), classKey: PICKUP, evidenceKind: "sandbox_drill" as const, reference: "zz drill reference" };
    // Evidence is for the offer's own class only.
    const own = { supplierCode: CODE };
    expect(code(await svc.evidenceRequest({ ...input, classKey: "live.fixed_slot_choice.pickup_required.internal.per_person" }, own).catch((e) => e))).toBe("CONFLICT");
    // A reference that looks like contact data is refused.
    expect(code(await svc.evidenceRequest({ ...input, reference: "someone@example.test" }, own).catch((e) => e))).toBe("VALIDATION_FAILED");
    // Recording is loosening: no approval, no evidence.
    expect(code(await svc.recordEvidence(a, { ...input, note: "record without approval" }, own).catch((e) => e))).toBe("FORBIDDEN");
    const req = await svc.evidenceRequest(input, own);
    expect(req.termsHash).toBe(terms);
    const appr = await approval(req.payload, "test");
    const { id } = await svc.recordEvidence(a, { ...input, note: "sandbox drill passed for pickup" }, { approvalId: appr, supplierCode: CODE });
    const v = await readiness();
    expect(v.mapping).toMatchObject({ capabilityRefusal: null });
    expect(v.blockers).not.toContain("capability_not_ready");
    expect(await prisma.auditLog.count({ where: { entityType: "supplier_offer_enablement", entityId: id, action: "supplier_capability.evidence_recorded" } })).toBe(1);

    const view = await svc.overview(a, "test", { supplierCode: CODE });
    expect(view.classes.find((c) => c.classKey === PICKUP)).toMatchObject({ flag: { enabled: true }, evidence: 1 });
    expect(view.evidence.find((e) => e.id === id)).toMatchObject({ classKey: PICKUP, revokedAt: null });
    expect(code(await svc.overview(viewer, "test", { supplierCode: CODE }).catch((e) => e))).toBe("FORBIDDEN");

    // Tightening: revoke needs a reason only, and the offer drops back.
    expect(await svc.revokeEvidence(b, id, "drill found a problem", own)).toEqual({ revoked: true });
    expect(await svc.revokeEvidence(b, id, "drill found a problem", own)).toEqual({ revoked: false });
    expect((await readiness()).mapping).toMatchObject({ capabilityRefusal: "offer_evidence_missing" });

    // Switching the key off wins over any evidence.
    await svc.setFlag(a, { environment: "test", classKey: PICKUP, enabled: false, reason: "evidence flow check off" });
    expect((await readiness()).mapping).toMatchObject({ capabilityRefusal: "flag_off" });
  });
});
