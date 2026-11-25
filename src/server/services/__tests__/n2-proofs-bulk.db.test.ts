import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { Actor } from "../../lib/actor";
import { ROLE_PERMISSIONS } from "../../lib/permissions";
import { assertDisposableDb, cleanupPeople, createStaff, dbEnabled, runId, type StaffFixture } from "../../__tests__/helpers/fixtures";
import { assertDisposableDbLive } from "../../__tests__/helpers/target-guard";
import { uuidv7 } from "../../lib/ids";
import { storedOffer, storedSlot, storedTour } from "../../suppliers/__tests__/fixtures/traveldesk-terms";
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
 * removed in afterAll; proof rows by the table owner disabling the delete
 * guard inside the cleanup transaction (DDL, owner only; migration
 * 20261127170000). Audit rows stay (append-only).
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
  let catalogService: typeof import("../catalog.service").catalogService;
  let supplierId: string;
  let productId: string;
  let ticketMappingId: string;
  const staff: Record<string, StaffFixture> = {};
  const secrets = new Map<string, string>();
  let clock = Date.UTC(2026, 10, 27, 12, 0, 0);
  const tick = () => new Date((clock += 90_000));
  const TOUR = BASE;
  const OFFER = BASE + 1;
  const OTHER_TOUR = BASE + 2;
  const OTHER_OFFER = BASE + 3;
  const EXT_TOUR = BASE + 4;
  const EXT_OFFER = BASE + 5;
  const TICKET_TOUR = BASE + 6;
  const TICKET_OFFER = BASE + 7;
  const EXT = "live.fixed_slot_single.self.external.per_person";
  const TICKET = "ticket.open_dated.self.internal.per_person";
  const offerPayload = storedOffer({ offerId: OFFER, tourId: TOUR });
  const tourPayload = storedTour({ tourId: TOUR });
  const terms = offerTermsHash(offerPayload, tourPayload)!;
  const refusal = async () => {
    const m = (await catalog.mappingReadinessFor(productId, "test", { supplierCode: CODE })).variants[0].mapping;
    return m ? (m.capabilityRefusal ?? null) : "no_mapping";
  };
  const admin = (label: string): Actor => ({ type: "admin", id: staff[label].id, displayName: `Fixture ${label}`, roles: ["admin"], permissions: new Set(ROLE_PERMISSIONS.admin) });
  const ops = (label: string): Actor => ({ type: "admin", id: staff[label].id, roles: ["ops"], permissions: new Set(ROLE_PERMISSIONS.ops) });
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
  const base = { environment: "test" as const, evidenceKind: "sandbox_drill" as const, reference: "zz n2 drill reference" };
  const products: string[] = [];

  beforeAll(async () => {
    assertDisposableDb();
    ({ prisma } = await import("../../lib/db"));
    await assertDisposableDbLive(prisma);
    ({ supplierCatalogService: catalog } = await import("../supplier-catalog.service"));
    ({ supplierCapabilityService: caps } = await import("../supplier-capability.service"));
    ({ approvalService: approvals } = await import("../approval.service"));
    ({ bulkListingService: bulk, bulkApprovalPayload } = await import("../bulk-listing.service"));
    ({ catalogService } = await import("../catalog.service"));
    const seeded = await prisma.supplierCapabilityFlag.findUnique({ where: { adapter_environment_classKey: { adapter: "traveldesk", environment: "test", classKey: SEEDED } } });
    if (!seeded?.enabled || seeded.requiresOfferEvidence) throw new Error("the seeded test-environment flag for the fixed-start key is not as migration 20261122120000 wrote it");

    supplierId = uuidv7();
    await prisma.supplier.create({ data: { id: supplierId, code: CODE, name: "zz n2 test", source: "api", adapter: "traveldesk" } });
    const extSlot = storedSlot({ isExternal: true });
    for (const [kind, externalId, parent, payload, bookingKind] of [
      ["tour", String(TOUR), null, tourPayload, null],
      ["tour", String(OTHER_TOUR), null, storedTour({ tourId: OTHER_TOUR }), null],
      ["tour", String(EXT_TOUR), null, storedTour({ tourId: EXT_TOUR, isExternal: true }), null],
      ["tour", String(TICKET_TOUR), null, storedTour({ tourId: TICKET_TOUR }), null],
      ["offer", String(OFFER), String(TOUR), offerPayload, "live_book"],
      ["offer", String(OTHER_OFFER), String(OTHER_TOUR), storedOffer({ offerId: OTHER_OFFER, tourId: OTHER_TOUR }), "live_book"],
      ["offer", String(EXT_OFFER), String(EXT_TOUR), storedOffer({ offerId: EXT_OFFER, tourId: EXT_TOUR, isExternal: true, timeSlots: [extSlot] }), "live_book"],
      ["offer", String(TICKET_OFFER), String(TICKET_TOUR), storedOffer({ offerId: TICKET_OFFER, tourId: TICKET_TOUR, bookingKind: "ticket_only", bookingTypeRaw: 2, timeSlots: [] }), "ticket_only"],
    ] as const) {
      await prisma.supplierCatalogueItem.create({
        data: { id: uuidv7(), supplierId, environment: "test", kind, externalId, parentExternalId: parent, name: `zz n2 ${kind}`, bookingKind, payload: payload as never, payloadHash: "x" },
      });
    }
    const any = await prisma.product.findFirstOrThrow({ select: { categorySlug: true } });
    for (let i = 0; i < 5; i++) {
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
    ticketMappingId = uuidv7();
    await prisma.productSupplierMapping.create({
      data: {
        id: ticketMappingId,
        productId: products[4],
        supplierId,
        variantCode: null,
        externalRef: { tourId: TICKET_TOUR, offerId: TICKET_OFFER, bookingKind: "ticket_only", isExternal: false },
        supplierProductId: String(TICKET_TOUR),
        supplierOfferId: String(TICKET_OFFER),
        bookingKind: "ticket_only",
        environment: "test",
        syncStatus: "ok",
      },
    });
    const { encryptSecret, generateTotpSecret } = await import("../../lib/crypto");
    for (const [label, role] of [
      ["p", "admin"],
      ["q", "admin"],
      ["o", "ops"],
    ] as const) {
      staff[label] = await createStaff(RUN, label, [role]);
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
    await prisma.supplierOfferEnablement.deleteMany({ where: { supplierId } });
    // Proofs are never deleted. Only the table owner can, by disabling the guard inside this cleanup transaction (re-review N2-16).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE "supplier_class_proofs" DISABLE TRIGGER "supplier_class_proofs_no_delete"`);
      await tx.supplierClassProof.deleteMany({ where: { supplierId } });
      await tx.$executeRawUnsafe(`ALTER TABLE "supplier_class_proofs" ENABLE TRIGGER "supplier_class_proofs_no_delete"`);
    });
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    await prisma.productEligibility.deleteMany({ where: { productId: { in: products } } });
    await prisma.product.deleteMany({ where: { slug: { startsWith: `zz-test-${RUN}` } } });
    await cleanupPeople(RUN);
  });

  /* ------------------------------------------------------------ proofs in the gate */

  it("no proof: the seeded key sells without per-offer evidence, exactly as before N2 (instant count unchanged)", async () => {
    expect(await refusal()).toBeNull();
  });

  it("the Dhow case (N2-05): a first narrow proof on the seeded key that leaves a live listing out needs that count confirmed", async () => {
    await prisma.productEligibility.upsert({
      where: { productId },
      create: { productId, effectiveMode: "instant", reasons: [], readinessVersion: 1, evaluatedAt: new Date() },
      update: { effectiveMode: "instant" },
    });
    const input = { ...base, classKey: SEEDED, basisClassKey: SEEDED, scopeKind: "tours" as const, scopeTourIds: [String(OTHER_TOUR)], bookedTourId: String(OTHER_TOUR), note: "zz n2 first proof" };
    const req = await caps.classProofRequest(input, { supplierCode: CODE });
    expect(req.demotions).toEqual({ count: 1, productIds: [productId] });
    const at = tick();
    const ap = await approvals.requestPrivileged(admin("p"), "supplier.capability.enable", "products.activate_instant", req.payload, { environment: "test", totpCode: code("p", at), now: at });
    const approvalId = (ap as { approvalId: string }).approvalId;
    await expect(caps.recordClassProof(admin("p"), input, { supplierCode: CODE, approvalId, now: at })).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "demotions_unconfirmed", demotions: 1 } });
    expect(await refusal()).toBeNull();
    await expect(caps.recordClassProof(admin("p"), { ...input, confirmDemotions: 1 }, { supplierCode: CODE, approvalId, now: at })).resolves.toMatchObject({ demotions: 1 });
    // The exception is over and the listing's tour is outside the proof: it needs evidence now.
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

  it("database: a proof is fixed once recorded, never deleted, a revoked proof stays revoked, and its shape is checked", async () => {
    const p = await prisma.supplierClassProof.create({ data: proofRow() });
    await expect(prisma.supplierClassProof.update({ where: { id: p.id }, data: { scopeKind: "all", scopeTourIds: [] } })).rejects.toThrow(/fixed once recorded/);
    await expect(prisma.supplierClassProof.delete({ where: { id: p.id } })).rejects.toThrow(/never deleted/);
    await expect(prisma.supplier.delete({ where: { id: supplierId } })).rejects.toThrow();
    await prisma.supplierClassProof.update({ where: { id: p.id }, data: { revokedAt: new Date(), revokeReason: "zz n2 guard test" } });
    await expect(prisma.supplierClassProof.update({ where: { id: p.id }, data: { revokedAt: null, revokeReason: null } })).rejects.toThrow(/stays revoked/);
    await expect(prisma.supplierClassProof.create({ data: proofRow({ scopeKind: "all" }) })).rejects.toThrow(/scp_scope_shape_check/);
    await expect(prisma.supplierClassProof.create({ data: proofRow({ scopeTourIds: ["12ab"] }) })).rejects.toThrow(/scp_scope_shape_check/);
    await expect(prisma.supplierClassProof.create({ data: proofRow({ basisClassKey: "live.fixed_slot_single.pickup_required.internal.per_person" }) })).rejects.toThrow(/scp_basis_neighbour_check/);
    await expect(prisma.supplierClassProof.create({ data: proofRow({ classKey: "live.fixed_slot_single.self.internal.per_unit", basisClassKey: "live.fixed_slot_single.self.internal.per_unit" }) })).rejects.toThrow(
      /scp_per_unit_never_check/,
    );
    await expect(prisma.supplierClassProof.create({ data: proofRow({ classKey: EXT, basisClassKey: EXT, scopeKind: "all", scopeTourIds: [] }) })).rejects.toThrow(/scp_external_never_all_check/);
    await expect(prisma.supplierClassProof.create({ data: proofRow({ bookedTourId: String(TOUR) }) })).rejects.toThrow(/scp_booked_tour_check/);
    // A neighbour differing in time shape alone is accepted (decision 22).
    await prisma.supplierClassProof.create({ data: proofRow({ classKey: "live.listed_start_single.self.internal.per_person", revokedAt: new Date(), revokeReason: "zz n2 neighbour" }) });
  });

  it("database: a non-owner role holding DELETE cannot delete a proof, set its way past the guard, or disable it (N2-16)", async () => {
    const role = `zz_np_${RUN}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const p = await prisma.supplierClassProof.create({ data: proofRow({ revokedAt: new Date(), revokeReason: "zz n2 delete guard" }) });
    await prisma.$executeRawUnsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    try {
      await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await prisma.$executeRawUnsafe(`GRANT SELECT, DELETE ON "supplier_class_proofs" TO ${role}`);
      await prisma.$executeRawUnsafe(`CREATE POLICY ${role}_all ON "supplier_class_proofs" FOR ALL TO ${role} USING (true)`);
      const asRole = (...sql: string[]) =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
          for (const q of sql) await tx.$executeRawUnsafe(q);
        });
      await expect(asRole(`DELETE FROM "supplier_class_proofs" WHERE id = '${p.id}'`)).rejects.toThrow(/never deleted/);
      await expect(asRole(`SELECT set_config('outly.purge_class_proofs', 'on', true)`, `DELETE FROM "supplier_class_proofs" WHERE id = '${p.id}'`)).rejects.toThrow(/never deleted/);
      await expect(asRole(`ALTER TABLE "supplier_class_proofs" DISABLE TRIGGER "supplier_class_proofs_no_delete"`)).rejects.toThrow(/owner/);
      expect(await prisma.supplierClassProof.count({ where: { id: p.id } })).toBe(1);
    } finally {
      await prisma.$executeRawUnsafe(`DROP POLICY IF EXISTS ${role}_all ON "supplier_class_proofs"`).catch(() => {});
      await prisma.$executeRawUnsafe(`REVOKE ALL ON "supplier_class_proofs" FROM ${role}`).catch(() => {});
      await prisma.$executeRawUnsafe(`REVOKE ALL ON SCHEMA public FROM ${role}`).catch(() => {});
      await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    }
  });

  it("service: scope rules tied to the booked tour (D21 external, D24 tickets, provider fallback, catalogue, neighbours)", async () => {
    const ext = { ...base, classKey: EXT, basisClassKey: EXT };
    await expect(caps.classProofRequest({ ...ext, scopeKind: "all", bookedTourId: String(EXT_TOUR) }, { supplierCode: CODE })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caps.classProofRequest({ ...ext, scopeKind: "tours", scopeTourIds: [String(EXT_TOUR), String(TOUR)], bookedTourId: String(EXT_TOUR) }, { supplierCode: CODE })).rejects.toThrow(/booked tour only/);
    await expect(caps.classProofRequest({ ...ext, scopeKind: "tours", scopeTourIds: [String(EXT_TOUR)], bookedTourId: String(EXT_TOUR) }, { supplierCode: CODE })).resolves.toMatchObject({ needs: "supplier.capability.enable" });
    const ticket = { ...base, classKey: TICKET, basisClassKey: TICKET };
    await expect(caps.classProofRequest({ ...ticket, scopeKind: "all", bookedTourId: String(TICKET_TOUR) }, { supplierCode: CODE })).rejects.toThrow(/booked attraction only/);
    await expect(caps.classProofRequest({ ...ticket, scopeKind: "tours", scopeTourIds: [String(TICKET_TOUR), String(TOUR)], bookedTourId: String(TICKET_TOUR) }, { supplierCode: CODE })).rejects.toThrow(/booked attraction only/);
    await expect(caps.classProofRequest({ ...ticket, scopeKind: "tours", scopeTourIds: [String(TICKET_TOUR)], bookedTourId: String(TICKET_TOUR) }, { supplierCode: CODE })).resolves.toMatchObject({ needs: "supplier.capability.enable" });
    const seeded = { ...base, classKey: SEEDED, basisClassKey: SEEDED };
    await expect(caps.classProofRequest({ ...seeded, scopeKind: "provider", scopeProvider: "Synthetic provider", bookedTourId: String(TOUR) }, { supplierCode: CODE })).rejects.toThrow(/does not name this provider/);
    await expect(caps.classProofRequest({ ...seeded, scopeKind: "tours", scopeTourIds: [String(BASE + 99), String(TOUR)], bookedTourId: String(TOUR) }, { supplierCode: CODE })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(caps.classProofRequest({ ...seeded, scopeKind: "tours", scopeTourIds: [String(OTHER_TOUR)], bookedTourId: String(TOUR) }, { supplierCode: CODE })).rejects.toMatchObject({ details: { fields: { scopeTourIds: expect.stringMatching(/include the booked tour/) } } });
    await expect(caps.classProofRequest({ ...seeded, scopeKind: "tours", scopeTourIds: [String(TICKET_TOUR)], bookedTourId: String(TICKET_TOUR) }, { supplierCode: CODE })).rejects.toMatchObject({ details: { fields: { bookedTourId: expect.stringMatching(/no stored offer of the booked key/) } } });
    await expect(
      caps.classProofRequest({ ...seeded, basisClassKey: "live.fixed_slot_single.pickup_required.internal.per_person", scopeKind: "tours", scopeTourIds: [String(TOUR)], bookedTourId: String(TOUR) }, { supplierCode: CODE }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const ok = await caps.classProofRequest({ ...seeded, scopeKind: "tours", scopeTourIds: [String(TOUR), String(TOUR)], bookedTourId: String(TOUR) }, { supplierCode: CODE });
    expect(ok.needs).toBe("supplier.capability.enable");
    expect(ok.payload.scopeTourIds).toEqual([String(TOUR)]);
  });

  it("recording always needs its own approval and instant rights; narrowing is an atomic replace; revoke needs the demotion count", async () => {
    const at = tick();
    const input = { ...base, classKey: SEEDED, basisClassKey: SEEDED, scopeKind: "tours" as const, scopeTourIds: [String(TOUR), String(OTHER_TOUR)], bookedTourId: String(TOUR), note: "zz n2 record proof" };
    const req = await caps.classProofRequest(input, { supplierCode: CODE });
    const ap = await approvals.requestPrivileged(admin("p"), "supplier.capability.enable", "products.activate_instant", req.payload, { environment: "test", totpCode: code("p", at), now: at });
    const approvalId = (ap as { approvalId: string }).approvalId;
    await expect(caps.recordClassProof(admin("p"), input, { supplierCode: CODE })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caps.recordClassProof(ops("o"), input, { supplierCode: CODE, approvalId, now: at })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { id } = await caps.recordClassProof(admin("p"), input, { supplierCode: CODE, approvalId, now: at });
    // The same scope again is no longer free: it needs a new approval (N2-01).
    await expect(caps.recordClassProof(admin("p"), input, { supplierCode: CODE, approvalId, now: at })).rejects.toThrow(/used already/);

    // Narrowing: ops cannot; the booked tour stays; one replace, the old row revoked in the same transaction.
    await expect(caps.narrowClassProof(ops("o"), { proofId: id, scopeTourIds: [String(TOUR)], note: "zz n2 narrow" }, { supplierCode: CODE })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caps.narrowClassProof(admin("p"), { proofId: id, scopeTourIds: [String(OTHER_TOUR)], note: "zz n2 narrow" }, { supplierCode: CODE })).rejects.toMatchObject({ details: { fields: { scopeTourIds: expect.stringMatching(/booked tour stays/) } } });
    const narrowed = await caps.narrowClassProof(admin("p"), { proofId: id, scopeTourIds: [String(TOUR)], note: "zz n2 narrow" }, { supplierCode: CODE });
    const [oldRow, newRow] = await Promise.all([prisma.supplierClassProof.findUniqueOrThrow({ where: { id } }), prisma.supplierClassProof.findUniqueOrThrow({ where: { id: narrowed.id } })]);
    expect(oldRow.revokedAt).not.toBeNull();
    expect(newRow).toMatchObject({ narrowsProofId: id, scopeTourIds: [String(TOUR)], reference: oldRow.reference, evidenceKind: oldRow.evidenceKind, bookedTourId: String(TOUR), approvalId: null, revokedAt: null });
    await expect(caps.narrowClassProof(admin("p"), { proofId: id, scopeTourIds: [String(TOUR)], note: "zz n2 narrow" }, { supplierCode: CODE })).rejects.toThrow(/revoked/);
    expect(await refusal()).toBeNull();

    // Revoking the narrower row is the off switch. The listing sells instantly now (written straight in: the draft fixture never passes readiness).
    await prisma.productEligibility.update({ where: { productId }, data: { effectiveMode: "instant" } });
    await prisma.supplierOfferEnablement.updateMany({ where: { supplierId, revokedAt: null }, data: { revokedAt: new Date(), revokeReason: "zz n2 evidence off" } });
    expect(await refusal()).toBeNull();
    await expect(caps.revokeClassProof(admin("p"), narrowed.id, "zz n2 revoke", { supplierCode: CODE })).rejects.toMatchObject({ details: { reason: "demotions_unconfirmed", demotions: 1 } });
    await expect(caps.revokeClassProof(admin("p"), narrowed.id, "zz n2 revoke", { supplierCode: CODE, confirmDemotions: 1 })).resolves.toMatchObject({ revoked: true, demotions: 1 });
    expect(await refusal()).toBe("offer_evidence_missing");
  });

  it("tickets: \"no ticket at confirmation\" is refused for a ticket mapping, even with its key off (N2-02)", async () => {
    const at = tick();
    await expect(
      catalog.setTicketEvidence(admin("p"), ticketMappingId, { issuesTicketsAtConfirm: "no", source: "zz n2 written answer reference", note: "zz n2 ticket test", totpCode: code("p", at) }, at),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "ticket_offer" } });
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
    const items = await prisma.bulkOperationItem.findMany({ where: { bulkId } });
    expect(items.find((i) => i.productId === products[1])?.wasInstant).toBe(true);
    expect(items.find((i) => i.productId === products[3])?.wasInstant).toBe(false);

    // Replay of a finished run: nothing runs again.
    const before = await prisma.auditLog.count({ where: { action: "bulk_operation.item", entityId: { in: products } } });
    const again = await bulk.run(admin("p"), bulkId);
    expect(again.applied.length + again.skipped.length).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: "bulk_operation.item", entityId: { in: products } } })).toBe(before);

    // Another person cannot run it.
    await expect(bulk.run(admin("q"), bulkId)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("an item another run holds is not executed twice; a lapsed claim is taken again", async () => {
    const at = tick();
    await prisma.product.update({ where: { id: products[3] }, data: { fulfilmentMode: "instant" } });
    const { bulkId } = await bulk.start(admin("p"), { action: "inquiry", productIds: [products[3]], reason: "zz n2 claim test" }, { environment: "test", now: at });
    await prisma.bulkOperationItem.updateMany({ where: { bulkId }, data: { state: "running", claimedUntil: new Date(at.getTime() + 60_000) } });
    const held = await bulk.run(admin("p"), bulkId, { now: at });
    expect(held).toMatchObject({ applied: [], remaining: [products[3]] });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: products[3] } })).fulfilmentMode).toBe("instant");
    const later = new Date(at.getTime() + 2 * 60_000);
    const taken = await bulk.run(admin("p"), bulkId, { now: later });
    expect(taken.applied.map((i) => i.productId)).toEqual([products[3]]);
  });

  it("the item writers check the run themselves (N2-06): wrong person, not a running item, no approval", async () => {
    const at = tick();
    const { bulkId } = await bulk.start(admin("p"), { action: "inquiry", productIds: [products[2]], reason: "zz n2 guard run" }, { environment: "test", now: at });
    // Pending, not claimed: refused.
    await expect(catalogService.setProductModeForBulk(admin("p"), products[2], "inquiry", "zz n2 guard", { bulkId, now: at })).rejects.toThrow(/not a running item/);
    await prisma.bulkOperationItem.updateMany({ where: { bulkId }, data: { state: "running", claimedUntil: new Date(at.getTime() + 60_000) } });
    await expect(catalogService.setProductModeForBulk(admin("q"), products[2], "inquiry", "zz n2 guard", { bulkId, now: at })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // An inquiry run carries no approval: it can never write instant.
    await expect(catalogService.setProductModeForBulk(admin("p"), products[2], "instant", "zz n2 guard", { bulkId, now: at })).rejects.toThrow();
    await expect(catalogService.setProductModeForBulk(admin("p"), products[2], "inquiry", "zz n2 guard", { bulkId: uuidv7(), now: at })).rejects.toThrow(/does not exist/);
    await expect(catalogService.setProductModeForBulk(admin("p"), products[2], "inquiry", "zz n2 guard", { bulkId, now: new Date(at.getTime() + 31 * 60_000) })).rejects.toThrow(/window/);
  });

  it("arm burns one approval for the frozen list: a changed list, another person or a second use is refused; failures are per item", async () => {
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
    await expect(bulk.start(admin("q"), { action: "arm", productIds: items, reason: "zz n2 arm run" }, { environment: "test", approvalId, now: at })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await bulk.isRequester(admin("p"), approvalId)).toBe(true);
    expect(await bulk.isRequester(admin("q"), approvalId)).toBe(false);
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

  it("an item left running after its window, armed when first claimed and not armed now, raises the disarm alert (N2-17)", async () => {
    const { bulkDisarmIncidents } = await import("../bulk-guard");
    const at = tick();
    const { bulkId } = await bulk.start(admin("p"), { action: "inquiry", productIds: [products[2]], reason: "zz n2 stranded run" }, { environment: "test", now: at });
    await prisma.bulkOperationItem.updateMany({ where: { bulkId }, data: { state: "running", claimedUntil: at, wasInstant: true } });
    await prisma.product.update({ where: { id: products[2] }, data: { fulfilmentMode: "inquiry" } });
    const item = await prisma.bulkOperationItem.findFirstOrThrow({ where: { bulkId } });
    const inside = await bulkDisarmIncidents(new Date(at.getTime() - 60_000), new Date(at.getTime() + 60_000));
    expect(inside.map((i) => i.entityId)).not.toContain(item.id);
    const after = await bulkDisarmIncidents(new Date(at.getTime() - 60_000), new Date(at.getTime() + 31 * 60_000));
    expect(after.find((i) => i.entityId === item.id)).toMatchObject({ kind: "bulk_item_disarmed", entityKind: "bulk_operation_item", reason: "disarmed_run_expired" });
  });

  it("an approval waiting for a second administrator is listed; once approved it starts later over its own list, never a new request (N2-21)", async () => {
    const t1 = tick();
    const items = [products[1], products[3]];
    // Production approval environment: the first request waits for a second administrator.
    const first = await approvals.requestPrivileged(admin("p"), "instant.activate.bulk", "products.activate_instant", bulkApprovalPayload("arm", "production", items), {
      environment: "production",
      totpCode: code("p", t1),
      now: t1,
      itemCount: items.length,
    });
    expect(first.status).toBe("pending");
    const approvalId = (first as { approvalId: string }).approvalId;
    const pending = await bulk.openApprovals(admin("p"), t1);
    expect(pending.find((o) => o.approvalId === approvalId)).toMatchObject({ state: "pending", action: "arm", itemCount: 2, items: [...items].sort() });
    expect(await bulk.readyApproval(admin("p"), "arm", "production", items, t1)).toBeNull();
    const t2 = tick();
    const second = await approvals.requestPrivileged(admin("q"), "instant.activate.bulk", "products.activate_instant", bulkApprovalPayload("arm", "production", items), {
      environment: "production",
      totpCode: code("q", t2),
      now: t2,
      itemCount: items.length,
    });
    expect(second).toMatchObject({ status: "applied", approvalId });
    // The second administrator only approved it; the requester's listing shows it ready, for exactly that run.
    expect(await bulk.isRequester(admin("q"), approvalId)).toBe(false);
    expect((await bulk.openApprovals(admin("p"), t2)).find((o) => o.approvalId === approvalId)?.state).toBe("approved");
    expect(await bulk.readyApproval(admin("p"), "arm", "production", [...items].reverse(), t2)).toBe(approvalId);
    expect(await bulk.readyApproval(admin("p"), "arm", "production", [products[1]], t2)).toBeNull();
    await expect(bulk.approvalItems(admin("q"), approvalId)).rejects.toMatchObject({ details: { reason: "requester_starts" } });
    expect(await bulk.approvalItems(admin("p"), approvalId)).toEqual({ action: "arm", items: [...items].sort() });
    await bulk.start(admin("p"), { action: "arm", productIds: items, reason: "zz n2 approved later" }, { environment: "production", approvalId, now: t2 });
    expect((await bulk.openApprovals(admin("p"), t2)).find((o) => o.approvalId === approvalId)).toBeUndefined();
  });

  it("caps a run at 50 listings and refuses unknown listings", async () => {
    const many = Array.from({ length: 51 }, () => uuidv7());
    await expect(bulk.resolveSelection(admin("p"), { ids: many })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(bulk.resolveSelection(admin("p"), { ids: [uuidv7()] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(bulk.start(admin("p"), { action: "inquiry", productIds: many, reason: "zz n2 too many" }, { environment: "test" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
