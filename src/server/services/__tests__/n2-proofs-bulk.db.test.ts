import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { Actor } from "../../lib/actor";
import { ROLE_PERMISSIONS } from "../../lib/permissions";
import { assertDisposableDb, cleanupPeople, createStaff, dbEnabled, runId, type StaffFixture } from "../../__tests__/helpers/fixtures";
import { assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import { uuidv7 } from "../../lib/ids";
import { storedOffer, storedTour } from "../../suppliers/__tests__/fixtures/traveldesk-terms";
import { offerTermsHash } from "../../suppliers/traveldesk/traveldesk.offer-terms";

/**
 * Doc 30 N2 on the disposable database: class proofs in the capability gate
 * (§3.12; D14, D21, D24; review RR-03) and bulk runs (P30-08).
 *
 * Proofs: a run-scoped TravelDesk supplier, one stored tour and offer of a
 * seeded fixed-start key, one product mapped to it. The seeded key's flag
 * rows come from migration 20261122120000 and are only read. Proof rows
 * belong to the run's supplier, so no other supplier's verdict changes.
 *
 * Bulk: `zz-test-<run>` products with an empty document (only the requested
 * mode is written), synthetic staff with random TOTP secrets. Every row is
 * removed in afterAll; audit rows stay (append-only).
 */

const RUN = runId();
const CODE = `zz-n2-${RUN}`;
const BASE = 920_000_000 + Math.floor(Math.random() * 40_000_000);
const SEEDED = "live.fixed_slot_single.self.internal.per_person";

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

describe.skipIf(!dbEnabled)("doc 30 N2: class proofs and bulk runs (local DB)", () => {
  let prisma: typeof import("../../lib/db").prisma;
  let catalog: typeof import("../supplier-catalog.service").supplierCatalogService;
  let caps: typeof import("../supplier-capability.service").supplierCapabilityService;
  let approvals: typeof import("../approval.service").approvalService;
  let bulk: typeof import("../bulk-listing.service").bulkListingService;
  let bulkApprovalPayload: typeof import("../bulk-listing.service").bulkApprovalPayload;
  let supplierId: string;
  let productId: string;
  const staff: Record<string, StaffFixture> = {};
  const secrets = new Map<string, string>();
  let clock = Date.UTC(2026, 10, 27, 12, 0, 0);
  const tick = () => new Date((clock += 90_000));
  const TOUR = BASE;
  const OFFER = BASE + 1;
  const OTHER_TOUR = BASE + 2;
  const offerPayload = storedOffer({ offerId: OFFER, tourId: TOUR });
  const tourPayload = storedTour({ tourId: TOUR });
  const terms = offerTermsHash(offerPayload, tourPayload)!;
  const refusal = async () => {
    const m = (await catalog.mappingReadinessFor(productId, "test", { supplierCode: CODE })).variants[0].mapping;
    return m ? (m.capabilityRefusal ?? null) : "no_mapping";
  };
  const admin = (label: string): Actor => ({ type: "admin", id: staff[label].id, displayName: `Fixture ${label}`, roles: ["admin"], permissions: new Set(ROLE_PERMISSIONS.admin) });
  const code = (label: string, at: Date) => totpAt(secrets.get(label)!, at);
  const proofRow = (over: Record<string, unknown> = {}) => ({
    id: uuidv7(),
    supplierId,
    environment: "test" as const,
    classKey: SEEDED,
    basisClassKey: SEEDED,
    scopeKind: "tours",
    scopeProvider: null,
    scopeTourIds: [String(OTHER_TOUR)],
    evidenceKind: "sandbox_drill",
    reference: "zz n2 drill reference",
    ...over,
  });
  const products: string[] = [];

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    ({ supplierCatalogService: catalog } = await import("../supplier-catalog.service"));
    ({ supplierCapabilityService: caps } = await import("../supplier-capability.service"));
    ({ approvalService: approvals } = await import("../approval.service"));
    ({ bulkListingService: bulk, bulkApprovalPayload } = await import("../bulk-listing.service"));
    const seeded = await prisma.supplierCapabilityFlag.findUnique({ where: { adapter_environment_classKey: { adapter: "traveldesk", environment: "test", classKey: SEEDED } } });
    if (!seeded?.enabled || seeded.requiresOfferEvidence) throw new Error("the seeded test-environment flag for the fixed-start key is not as migration 20261122120000 wrote it");

    supplierId = uuidv7();
    await prisma.supplier.create({ data: { id: supplierId, code: CODE, name: "zz n2 test", source: "api", adapter: "traveldesk" } });
    for (const [kind, externalId, parent, payload] of [
      ["tour", String(TOUR), null, tourPayload],
      ["tour", String(OTHER_TOUR), null, storedTour({ tourId: OTHER_TOUR })],
      ["offer", String(OFFER), String(TOUR), offerPayload],
    ] as const) {
      await prisma.supplierCatalogueItem.create({
        data: { id: uuidv7(), supplierId, environment: "test", kind, externalId, parentExternalId: parent, name: `zz n2 ${kind}`, bookingKind: kind === "offer" ? "live_book" : null, payload: payload as never, payloadHash: "x" },
      });
    }
    const any = await prisma.product.findFirstOrThrow({ select: { categorySlug: true } });
    for (let i = 0; i < 4; i++) {
      const id = uuidv7();
      products.push(id);
      await prisma.product.create({ data: { id, slug: `zz-test-${RUN}-n2-${i}`, title: `zz n2 product ${i}`, tier: "C", status: "draft", categorySlug: any.categorySlug, confirmation: "instant", content: {} } });
    }
    productId = products[0];
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
    const { encryptSecret, generateTotpSecret } = await import("../../lib/crypto");
    for (const label of ["p", "q"]) {
      staff[label] = await createStaff(RUN, label, ["admin"]);
      const secret = generateTotpSecret();
      secrets.set(label, secret);
      await prisma.adminUser.update({ where: { id: staff[label].id }, data: { totpSecretEncrypted: encryptSecret(secret) } });
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    const ids = Object.values(staff).map((s) => s.id);
    const runs = await prisma.bulkOperation.findMany({ where: { requestedBy: { in: ids } }, select: { id: true } });
    await prisma.bulkOperationItem.deleteMany({ where: { bulkId: { in: runs.map((r) => r.id) } } });
    await prisma.bulkOperation.deleteMany({ where: { requestedBy: { in: ids } } });
    await prisma.privilegedApproval.deleteMany({ where: { requestedBy: { in: ids } } });
    await prisma.idempotencyKey.deleteMany({ where: { OR: [{ scope: "admin_totp", OR: ids.map((id) => ({ key: { startsWith: `totp:${id}:` } })) }] } });
    await prisma.rateLimitBucket.deleteMany({ where: { key: { in: ids.map((id) => `admin_totp:${id}`) } } }).catch(() => {});
    await prisma.productSupplierMapping.deleteMany({ where: { supplierId } });
    await prisma.supplierCatalogueItem.deleteMany({ where: { supplierId } });
    // Proof rows cascade with the supplier.
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    await prisma.productEligibility.deleteMany({ where: { productId: { in: products } } });
    await prisma.product.deleteMany({ where: { slug: { startsWith: `zz-test-${RUN}` } } });
    await cleanupPeople(RUN);
  });

  /* ------------------------------------------------------------ proofs in the gate */

  it("no proof: the seeded key sells without per-offer evidence, exactly as before N2 (instant count unchanged)", async () => {
    expect(await refusal()).toBeNull();
  });

  it("the first proof for the seeded key ends its exception: an offer outside the proof's tours needs evidence", async () => {
    await prisma.supplierClassProof.create({ data: proofRow() });
    expect(await refusal()).toBe("offer_evidence_missing");
  });

  it("a proof whose named tours include the offer's tour covers it, whatever its terms", async () => {
    await prisma.supplierClassProof.create({ data: proofRow({ scopeTourIds: [String(TOUR)] }) });
    expect(await refusal()).toBeNull();
  });

  it("revoking every proof does not bring the exception back (revoking never loosens)", async () => {
    await prisma.supplierClassProof.updateMany({ where: { supplierId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: "zz n2 revoke test" } });
    expect(await refusal()).toBe("offer_evidence_missing");
    // Per-offer evidence for the current terms still works as before.
    await prisma.supplierOfferEnablement.create({ data: { id: uuidv7(), supplierId, environment: "test", offerExternalId: String(OFFER), classKey: SEEDED, evidenceKind: "contract_test", reference: "zz n2 evidence", offerTermsHash: terms } });
    expect(await refusal()).toBeNull();
  });

  it("database: a proof is fixed once recorded, a revoked proof stays revoked, and its shape is checked", async () => {
    const p = await prisma.supplierClassProof.create({ data: proofRow() });
    await expect(prisma.supplierClassProof.update({ where: { id: p.id }, data: { scopeKind: "all", scopeTourIds: [] } })).rejects.toThrow(/fixed once recorded/);
    await prisma.supplierClassProof.update({ where: { id: p.id }, data: { revokedAt: new Date(), revokeReason: "zz n2 guard test" } });
    await expect(prisma.supplierClassProof.update({ where: { id: p.id }, data: { revokedAt: null, revokeReason: null } })).rejects.toThrow(/stays revoked/);
    await expect(prisma.supplierClassProof.create({ data: proofRow({ scopeKind: "all" }) })).rejects.toThrow(/scp_scope_shape_check/);
    await expect(prisma.supplierClassProof.create({ data: proofRow({ scopeTourIds: ["12ab"] }) })).rejects.toThrow(/scp_scope_shape_check/);
    await expect(prisma.supplierClassProof.create({ data: proofRow({ basisClassKey: "live.fixed_slot_single.pickup_required.internal.per_person" }) })).rejects.toThrow(/scp_basis_neighbour_check/);
    await expect(prisma.supplierClassProof.create({ data: proofRow({ classKey: "live.fixed_slot_single.self.internal.per_unit", basisClassKey: "live.fixed_slot_single.self.internal.per_unit" }) })).rejects.toThrow(
      /scp_per_unit_never_check/,
    );
    // A neighbour differing in time shape alone is accepted (decision 22).
    await prisma.supplierClassProof.create({ data: proofRow({ classKey: "live.listed_start_single.self.internal.per_person", revokedAt: new Date(), revokeReason: "zz n2 neighbour" }) });
  });

  it("service: scope rules (D21 external, D24 tickets, provider fallback, tours in the catalogue, neighbours)", async () => {
    const base = { environment: "test" as const, evidenceKind: "sandbox_drill" as const, reference: "zz n2 drill reference" };
    const ext = "live.fixed_slot_single.self.external.per_person";
    await expect(caps.classProofRequest({ ...base, classKey: ext, basisClassKey: ext, scopeKind: "all" }, { supplierCode: CODE })).rejects.toMatchObject({ code: "CONFLICT" });
    const ticket = "ticket.open_dated.self.internal.per_person";
    await expect(caps.classProofRequest({ ...base, classKey: ticket, basisClassKey: ticket, scopeKind: "all" }, { supplierCode: CODE })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caps.classProofRequest({ ...base, classKey: SEEDED, basisClassKey: SEEDED, scopeKind: "provider", scopeProvider: "Synthetic provider" }, { supplierCode: CODE })).rejects.toThrow(/does not name this provider/);
    await expect(caps.classProofRequest({ ...base, classKey: SEEDED, basisClassKey: SEEDED, scopeKind: "tours", scopeTourIds: [String(BASE + 99)] }, { supplierCode: CODE })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      caps.classProofRequest({ ...base, classKey: SEEDED, basisClassKey: "live.fixed_slot_single.pickup_required.internal.per_person", scopeKind: "tours", scopeTourIds: [String(TOUR)] }, { supplierCode: CODE }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const ok = await caps.classProofRequest({ ...base, classKey: SEEDED, basisClassKey: "live.listed_start_single.self.internal.per_person", scopeKind: "tours", scopeTourIds: [String(TOUR), String(TOUR)] }, { supplierCode: CODE });
    expect(ok.needs).toBe("supplier.capability.enable");
    expect(ok.payload.scopeTourIds).toEqual([String(TOUR)]);
  });

  it("service: recording needs an approval for exactly that proof, used once; a narrower scope needs none", async () => {
    const at = tick();
    const input = { environment: "test" as const, classKey: SEEDED, basisClassKey: SEEDED, scopeKind: "tours" as const, scopeTourIds: [String(TOUR), String(OTHER_TOUR)], evidenceKind: "sandbox_drill" as const, reference: "zz n2 drill reference", note: "zz n2 record proof" };
    const req = await caps.classProofRequest(input, { supplierCode: CODE });
    const ap = await approvals.requestPrivileged(admin("p"), "supplier.capability.enable", "products.activate_instant", req.payload, { environment: "test", totpCode: code("p", at), now: at });
    expect(ap.status).toBe("applied");
    const approvalId = (ap as { approvalId: string }).approvalId;
    await expect(caps.recordClassProof(admin("p"), input, { supplierCode: CODE })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caps.recordClassProof(admin("p"), input, { supplierCode: CODE, approvalId, now: at })).resolves.toMatchObject({ approvalUsed: true });
    // The approval is spent: it cannot record a wider proof (or anything else) a second time.
    await expect(caps.recordClassProof(admin("p"), { ...input, scopeKind: "all", scopeTourIds: [] }, { supplierCode: CODE, approvalId, now: at })).rejects.toThrow(/different change|used already/);
    // A scope the active proof already covers loosens nothing: no approval.
    const narrower = await caps.classProofRequest({ ...input, scopeTourIds: [String(OTHER_TOUR)] }, { supplierCode: CODE });
    expect(narrower.needs).toBeNull();
    await expect(caps.recordClassProof(admin("p"), { ...input, scopeTourIds: [String(OTHER_TOUR)] }, { supplierCode: CODE, now: at })).resolves.toMatchObject({ approvalUsed: false });
    // A wider scope (every offer of the key) is a new loosening.
    expect((await caps.classProofRequest({ ...input, scopeKind: "all", scopeTourIds: [] }, { supplierCode: CODE })).needs).toBe("supplier.capability.enable");
    expect(await refusal()).toBeNull();
  });

  /* ------------------------------------------------------------ bulk runs */

  it("back to inquiry needs no approval; applied and skipped are reported per item, with an audit row naming the run", async () => {
    await prisma.product.updateMany({ where: { id: { in: [products[1], products[2]] } }, data: { fulfilmentMode: "instant" } });
    const ids = await bulk.resolveSelection(admin("p"), { ids: [products[1], products[2], products[3]] });
    const { bulkId } = await bulk.start(admin("p"), { action: "inquiry", productIds: ids, reason: "zz n2 back to inquiry" }, { environment: "test" });
    const r = await bulk.run(admin("p"), bulkId);
    expect(r.applied.map((i) => i.productId).sort()).toEqual([products[1], products[2]].sort());
    expect(r.skipped).toEqual([{ productId: products[3], state: "skipped", outcome: "already_inquiry" }]);
    expect(r.failed).toEqual([]);
    expect(await prisma.product.count({ where: { id: { in: [products[1], products[2]] }, fulfilmentMode: "inquiry" } })).toBe(2);
    const audits = await prisma.auditLog.findMany({ where: { action: "product.fulfilment_mode", entityId: { in: [products[1], products[2]] } } });
    expect(audits.every((a) => (a.after as { bulkId?: string }).bulkId === bulkId)).toBe(true);

    // Replay of a finished run: nothing runs again.
    const before = await prisma.auditLog.count({ where: { action: "bulk_operation.item", entityId: { in: products } } });
    const again = await bulk.run(admin("p"), bulkId);
    expect(again.applied.length + again.skipped.length).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: "bulk_operation.item", entityId: { in: products } } })).toBe(before);

    // Another person cannot run it.
    await expect(bulk.run(admin("q"), bulkId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("arm burns one approval for the frozen list: a changed list or a second use is refused; failures are per item", async () => {
    const at = tick();
    const items = [products[1], products[2]];
    const ap = await approvals.requestPrivileged(admin("p"), "instant.activate.bulk", "products.activate_instant", bulkApprovalPayload("arm", "test", items), {
      environment: "test",
      totpCode: code("p", at),
      now: at,
      itemCount: items.length,
    });
    expect(ap.status).toBe("applied");
    const approvalId = (ap as { approvalId: string }).approvalId;
    await expect(bulk.start(admin("p"), { action: "arm", productIds: [products[1], products[3]], reason: "zz n2 arm run" }, { environment: "test", approvalId, now: at })).rejects.toThrow(/different change/);
    await expect(bulk.start(admin("p"), { action: "arm", productIds: items, reason: "zz n2 arm run" }, { environment: "test", now: at })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { bulkId } = await bulk.start(admin("p"), { action: "arm", productIds: [...items].reverse(), reason: "zz n2 arm run" }, { environment: "test", approvalId, now: at });
    await expect(bulk.start(admin("p"), { action: "arm", productIds: items, reason: "zz n2 arm run" }, { environment: "test", approvalId, now: at })).rejects.toThrow(/used already/);
    const r = await bulk.run(admin("p"), bulkId, { now: at });
    // The disposable database runs with the instant release switch off: every item refuses on its own and is reported.
    expect(r.failed.length + r.applied.length).toBe(2);
    for (const f of r.failed) expect(f.outcome).toMatch(/^validation_failed|^conflict/);
    expect(r.remaining).toEqual([]);
  });

  it("a run after its 30-minute window runs nothing and lists the remaining items for a new approval", async () => {
    const at = tick();
    const { bulkId } = await bulk.start(admin("p"), { action: "inquiry", productIds: [products[3]], reason: "zz n2 expired run" }, { environment: "test", now: at });
    const late = new Date(at.getTime() + 31 * 60_000);
    const r = await bulk.run(admin("p"), bulkId, { now: late });
    expect(r).toMatchObject({ expired: true, remaining: [products[3]], applied: [], skipped: [], failed: [] });
    expect(await bulk.remainingItems(admin("p"), bulkId)).toEqual([products[3]]);
  });

  it("caps a run at 50 listings and refuses unknown listings", async () => {
    const many = Array.from({ length: 51 }, () => uuidv7());
    await expect(bulk.resolveSelection(admin("p"), { ids: many })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(bulk.resolveSelection(admin("p"), { ids: [uuidv7()] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(bulk.start(admin("p"), { action: "inquiry", productIds: many, reason: "zz n2 too many" }, { environment: "test" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
