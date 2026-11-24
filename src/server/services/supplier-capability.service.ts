import "server-only";
import type { SupplierEnvironment } from "@prisma/client";
import { type Actor, requirePermission } from "../lib/actor";
import { audit } from "../lib/audit";
import { prisma, TX_OPTIONS } from "../lib/db";
import { Errors } from "../lib/errors";
import { uuidv7 } from "../lib/ids";
import type { PrivilegedOperation } from "../suppliers/booking-port";
import { CAPABILITY_ADAPTER } from "../suppliers/capability-gate";
import {
  CAPABILITY_DERIVATION_VERSION,
  deriveCapabilities,
  externalFlagsEnabled,
  neverEnabledReason,
  parseClassKey,
  SEEDED_CLASS_KEYS,
  type CapabilityDimensions,
} from "../suppliers/traveldesk/traveldesk.capability";
import { offerTermsHash } from "../suppliers/traveldesk/traveldesk.offer-terms";
import { OPERATION_PERMISSION } from "./approval.service";
import { readinessService } from "./readiness.service";
import { TRAVELDESK_SUPPLIER_CODE, useApproval } from "./supplier-booking.service";

/**
 * Capability-class flags and per-offer enablement evidence (doc 29 §3.3,
 * Batch 1a). The gate itself is `suppliers/capability-gate.ts`; this service
 * changes what it reads, and lists it for the admin screen.
 *
 *  - Every change needs `suppliers.manage` and a reason of at least 8
 *    characters, and writes an audit row in the same transaction.
 *  - Switching a flag **off** is tightening: no approval. The offers of that
 *    class drop to inquiry for new quotes at once (readiness re-runs; quotes
 *    and both intake points read the same flag). Paid or open orders are not
 *    touched: they drain through confirmation, recovery and refund.
 *  - Switching a flag **on**, and recording evidence for an offer, is
 *    loosening: an applied approval (`supplier.capability.enable`, permission
 *    `products.activate_instant`) for exactly that change, bound to the flag
 *    row as it was when asked; a fresh code, and in production a second
 *    person (approval.service.ts). The approval is used once.
 *  - A key that is unknown, inquiry, per unit (owner decision 7), date only
 *    (decision 6) or a ticket class other than the one Batch 5 builds
 *    (open dated, self arrival, internal, per person) can never be switched
 *    on; the database refuses an enabled per-unit key too.
 *  - Evidence is revoked, never deleted or edited (database guard).
 */

export const CAPABILITY_OPERATION: PrivilegedOperation = "supplier.capability.enable";
export const EVIDENCE_KINDS = ["contract_test", "sandbox_drill", "production_booking", "neighbour_proof"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** The flag as an approval saw it: its state and the time it last changed (null: no row yet). */
export interface FlagBefore {
  enabled: boolean;
  version: string | null;
}

/** The approval payload of a flag change. Bound to the flag's state when asked, so a stale approval never applies. */
export function flagApprovalPayload(adapter: string, environment: SupplierEnvironment, classKey: string, enabled: boolean, before: FlagBefore) {
  return { kind: "capability_flag", adapter, environment, classKey, enabled, before: { ...before } };
}

export interface EvidenceInput {
  environment: SupplierEnvironment;
  offerExternalId: string;
  classKey: string;
  evidenceKind: EvidenceKind;
  reference: string;
}

/** The approval payload of recording evidence: the offer, its class, the evidence and the terms it holds for. */
export function evidenceApprovalPayload(supplierCode: string, input: EvidenceInput, termsHash: string) {
  return {
    kind: "offer_evidence",
    supplierCode,
    environment: input.environment,
    offerExternalId: input.offerExternalId,
    classKey: input.classKey,
    evidenceKind: input.evidenceKind,
    reference: input.reference.trim(),
    offerTermsHash: termsHash,
  };
}

function checkReason(reason: string): string {
  const r = reason.trim();
  if (r.length < 8) throw Errors.validation({ note: "Give a reason of at least 8 characters — it goes in the audit log" });
  return r;
}

function checkKey(classKey: string): CapabilityDimensions {
  const d = parseClassKey(classKey);
  if (!d) throw Errors.validation({ classKey: "Not a composed capability class key" });
  return d;
}

const NEVER_MESSAGE: Record<string, string> = {
  not_a_class: "This is not a sellable class",
  private_units_inquiry: "Private-unit classes stay inquiry (owner decision, 22 November 2026)",
  date_only_inquiry: "Date-only classes stay inquiry until TravelDesk answers how to book them",
  ticket_booking_refused: "Only the open-dated, self-arrival, internal, per-person ticket class is built; other ticket classes stay inquiry",
  external_route_unproven: "Only the five per-person external classes of Batch 6 are built; other external classes stay inquiry",
};

/** References name a test, drill or booking; anything that looks like contact data is refused. */
function checkReference(reference: string): string {
  const r = reference.trim();
  if (r.length < 3 || r.length > 200) throw Errors.validation({ reference: "Give a reference of 3 to 200 characters" });
  if (/@|\+?\d[\d\s-]{8,}\d/.test(r)) throw Errors.validation({ reference: "A reference names a test, drill or booking; never an email or a phone number" });
  return r;
}

async function supplierFor(code: string) {
  const s = await prisma.supplier.findUnique({ where: { code } });
  if (!s) throw Errors.notConfigured(`supplier ${code}`);
  return s;
}

/** Re-run readiness for the products mapped in `environment` (to the given offers, when named). Failures demote, never throw. */
async function reevaluateMapped(supplierCode: string, environment: SupplierEnvironment, trigger: "capability_flag" | "offer_evidence", offerExternalIds?: string[]) {
  const supplier = await prisma.supplier.findUnique({ where: { code: supplierCode }, select: { id: true } });
  if (!supplier) return;
  const rows = await prisma.productSupplierMapping.findMany({
    where: { supplierId: supplier.id, environment, ...(offerExternalIds ? { supplierOfferId: { in: offerExternalIds } } : {}) },
    select: { productId: true },
  });
  await readinessService.reevaluateMany(
    rows.map((r) => r.productId),
    trigger,
  );
}

export interface CapabilityClassRow {
  classKey: string;
  dimensions: CapabilityDimensions | null;
  flag: { id: string; enabled: boolean; requiresOfferEvidence: boolean; reason: string; changedAt: string; changedBy: string | null; approvalId: string | null } | null;
  seeded: boolean;
  /** Why this key can never be switched on in this release, or null. */
  neverEnabled: string | null;
  /** Live catalogue offers derived into this class. */
  offers: number;
  /** Of those, offers with something for a person to review first. */
  offersNeedingReview: number;
  /** Of those, offers with an active approved mapping. */
  mappedOffers: number;
  /** Active evidence rows recorded for this key. */
  evidence: number;
}

export interface EvidenceRow {
  id: string;
  offerExternalId: string;
  classKey: string;
  evidenceKind: string;
  reference: string;
  offerTermsHash: string;
  recordedAt: string;
  recordedBy: string | null;
  approvalId: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  /** True while the offer's current terms are the ones the evidence was recorded for. */
  current: boolean;
}

export interface CapabilityOverview {
  environment: SupplierEnvironment;
  adapter: string;
  derivationVersion: number;
  lastDerivedAt: string | null;
  /** Offers stored with an older derivation version: the next sync rewrites them. */
  staleDerivations: number;
  classes: CapabilityClassRow[];
  evidence: EvidenceRow[];
  /** Review 89 B6-09: enabled flag rows on the external route (none is expected before a Batch 6 switch-on). */
  externalFlagsEnabled: string[];
}

export const supplierCapabilityService = {
  /** Class keys, their flag, offer counts and evidence, for one environment. Read-only. */
  async overview(actor: Actor, environment: SupplierEnvironment, opts: { supplierCode?: string } = {}): Promise<CapabilityOverview> {
    requirePermission(actor, "suppliers.manage");
    const code = opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
    const supplier = await prisma.supplier.findUnique({ where: { code } });
    const flags = await prisma.supplierCapabilityFlag.findMany({ where: { adapter: CAPABILITY_ADAPTER, environment }, orderBy: { classKey: "asc" } });
    const caps = supplier
      ? await prisma.supplierOfferCapability.findMany({
          where: { supplierId: supplier.id, environment, catalogueItem: { removedAt: null } },
          select: { offerExternalId: true, classKey: true, reviewReasons: true, derivationVersion: true, derivedAt: true, offerTermsHash: true },
        })
      : [];
    const mapped = supplier
      ? new Set(
          (await prisma.productSupplierMapping.findMany({ where: { supplierId: supplier.id, environment, isActive: true, supplierOfferId: { not: null } }, select: { supplierOfferId: true } })).map(
            (m) => m.supplierOfferId!,
          ),
        )
      : new Set<string>();
    const evidence = supplier
      ? await prisma.supplierOfferEnablement.findMany({ where: { supplierId: supplier.id, environment }, orderBy: { recordedAt: "desc" }, take: 200 })
      : [];
    const termsByOffer = new Map(caps.map((c) => [c.offerExternalId, c.offerTermsHash]));

    const keys = new Set<string>([...SEEDED_CLASS_KEYS, ...flags.map((f) => f.classKey), ...caps.map((c) => c.classKey)]);
    const classes: CapabilityClassRow[] = [...keys].sort().map((classKey) => {
      const f = flags.find((x) => x.classKey === classKey) ?? null;
      const inClass = caps.filter((c) => c.classKey === classKey);
      return {
        classKey,
        dimensions: parseClassKey(classKey),
        flag: f
          ? { id: f.id, enabled: f.enabled, requiresOfferEvidence: f.requiresOfferEvidence, reason: f.reason, changedAt: f.changedAt.toISOString(), changedBy: f.changedBy, approvalId: f.approvalId }
          : null,
        seeded: SEEDED_CLASS_KEYS.includes(classKey),
        neverEnabled: neverEnabledReason(classKey),
        offers: inClass.length,
        offersNeedingReview: inClass.filter((c) => c.reviewReasons.length > 0).length,
        mappedOffers: inClass.filter((c) => mapped.has(c.offerExternalId)).length,
        evidence: evidence.filter((e) => e.classKey === classKey && !e.revokedAt).length,
      };
    });
    const last = caps.reduce<Date | null>((m, c) => (!m || c.derivedAt > m ? c.derivedAt : m), null);
    return {
      environment,
      adapter: CAPABILITY_ADAPTER,
      derivationVersion: CAPABILITY_DERIVATION_VERSION,
      lastDerivedAt: last?.toISOString() ?? null,
      staleDerivations: caps.filter((c) => c.derivationVersion !== CAPABILITY_DERIVATION_VERSION).length,
      classes,
      externalFlagsEnabled: externalFlagsEnabled(flags),
      evidence: evidence.map((e) => ({
        id: e.id,
        offerExternalId: e.offerExternalId,
        classKey: e.classKey,
        evidenceKind: e.evidenceKind,
        reference: e.reference,
        offerTermsHash: e.offerTermsHash,
        recordedAt: e.recordedAt.toISOString(),
        recordedBy: e.recordedBy,
        approvalId: e.approvalId,
        revokedAt: e.revokedAt?.toISOString() ?? null,
        revokeReason: e.revokeReason,
        current: termsByOffer.get(e.offerExternalId) === e.offerTermsHash,
      })),
    };
  },

  /** What a flag change needs (loosening: the approval operation) and the flag state the approval binds to. Read without a lock. */
  async flagRequest(environment: SupplierEnvironment, classKey: string, enabled: boolean): Promise<{ needs: PrivilegedOperation | null; before: FlagBefore }> {
    checkKey(classKey);
    const row = await prisma.supplierCapabilityFlag.findUnique({ where: { adapter_environment_classKey: { adapter: CAPABILITY_ADAPTER, environment, classKey } } });
    const before: FlagBefore = { enabled: row?.enabled ?? false, version: row?.changedAt.toISOString() ?? null };
    return { needs: enabled && !before.enabled ? CAPABILITY_OPERATION : null, before };
  },

  /**
   * Switch one class key on or off in one environment. Off needs no
   * approval; on needs `approvalId`: an applied approval for exactly this
   * change against the flag as it is now, used once. Setting the state it
   * already has changes nothing and writes nothing.
   */
  async setFlag(
    actor: Actor,
    input: { environment: SupplierEnvironment; classKey: string; enabled: boolean; reason: string },
    opts: { approvalId?: string; now?: Date; supplierCode?: string } = {},
  ): Promise<{ changed: boolean; enabled: boolean }> {
    requirePermission(actor, "suppliers.manage");
    const reason = checkReason(input.reason);
    checkKey(input.classKey);
    if (input.enabled) {
      const never = neverEnabledReason(input.classKey);
      if (never) throw Errors.conflict(NEVER_MESSAGE[never], { classKey: input.classKey, reason: never });
    }
    const now = opts.now ?? new Date();
    const { environment, classKey } = input;
    const adapter = CAPABILITY_ADAPTER;

    const result = await prisma.$transaction(async (tx) => {
      // Switching off a key that has no row changes nothing: no row is created, so nothing unaudited is written (review R11).
      if (!input.enabled) {
        const existing = await tx.supplierCapabilityFlag.findUnique({ where: { adapter_environment_classKey: { adapter, environment, classKey } }, select: { id: true } });
        if (!existing) return { changed: false, enabled: false };
      }
      // A key without a row is off; the first change creates it off, then changes it under a row lock.
      const inserted = await tx.supplierCapabilityFlag.createMany({
        skipDuplicates: true,
        data: [{ id: uuidv7(), adapter, environment, classKey, enabled: false, requiresOfferEvidence: true, reason: "Created off by the first change to this key" }],
      });
      const [row] = await tx.$queryRaw<{ id: string; enabled: boolean; changed_at: Date }[]>`
        SELECT id, enabled, changed_at FROM supplier_capability_flags
        WHERE adapter = ${adapter} AND environment = ${environment}::supplier_environment AND class_key = ${classKey}
        FOR UPDATE`;
      // A row this call just created had no version when the change was asked for.
      const before: FlagBefore = { enabled: row.enabled, version: inserted.count === 1 ? null : row.changed_at.toISOString() };
      if (before.enabled === input.enabled) return { changed: false, enabled: before.enabled };
      let approvalId: string | null = null;
      if (input.enabled) {
        if (!opts.approvalId) throw Errors.forbidden(OPERATION_PERMISSION[CAPABILITY_OPERATION]);
        await useApproval(tx, actor, opts.approvalId, CAPABILITY_OPERATION, flagApprovalPayload(adapter, environment, classKey, true, before), environment, now);
        approvalId = opts.approvalId;
      }
      await tx.supplierCapabilityFlag.update({
        where: { id: row.id },
        data: { enabled: input.enabled, reason, approvalId, changedBy: actor.id ?? null, changedAt: now },
      });
      await audit(
        actor,
        input.enabled ? "supplier_capability.enable" : "supplier_capability.disable",
        { type: "supplier_capability_flag", id: row.id },
        { before: { adapter, environment, classKey, enabled: before.enabled }, after: { adapter, environment, classKey, enabled: input.enabled, approvalId }, reason },
        tx,
      );
      return { changed: true, enabled: input.enabled };
    }, TX_OPTIONS);
    if (result.changed) await reevaluateMapped(opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE, environment, "capability_flag");
    return result;
  },

  /**
   * Check evidence before it is asked for or recorded: the offer is in the
   * stored catalogue, its derived class is exactly `classKey`, and its terms
   * are readable. Returns the approval payload it would be recorded under.
   */
  async evidenceRequest(input: EvidenceInput, opts: { supplierCode?: string } = {}) {
    const code = opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
    checkKey(input.classKey);
    if (!(EVIDENCE_KINDS as readonly string[]).includes(input.evidenceKind)) throw Errors.validation({ evidenceKind: "Unknown evidence kind" });
    checkReference(input.reference);
    const never = neverEnabledReason(input.classKey);
    if (never) throw Errors.conflict(NEVER_MESSAGE[never], { classKey: input.classKey, reason: never });
    const supplier = await supplierFor(code);
    const offer = await prisma.supplierCatalogueItem.findUnique({
      where: { supplierId_environment_kind_externalId: { supplierId: supplier.id, environment: input.environment, kind: "offer", externalId: input.offerExternalId } },
    });
    if (!offer || offer.removedAt) throw Errors.notFound("Offer in the stored catalogue");
    const tour = offer.parentExternalId
      ? await prisma.supplierCatalogueItem.findUnique({
          where: { supplierId_environment_kind_externalId: { supplierId: supplier.id, environment: input.environment, kind: "tour", externalId: offer.parentExternalId } },
        })
      : null;
    const derived = deriveCapabilities(offer.payload);
    if (derived.classKey !== input.classKey) throw Errors.conflict("This offer is not in that class; evidence is recorded for the offer's own class key", { classKey: derived.classKey });
    const termsHash = tour && !tour.removedAt ? offerTermsHash(offer.payload, tour.payload) : null;
    if (!termsHash) throw Errors.conflict("The offer's terms cannot be read; sync the catalogue first");
    return { supplierId: supplier.id, termsHash, payload: evidenceApprovalPayload(code, input, termsHash) };
  },

  /** Record evidence for one offer and class key. Loosening: needs an applied approval for exactly this evidence. */
  async recordEvidence(actor: Actor, input: EvidenceInput & { note: string }, opts: { approvalId?: string; now?: Date; supplierCode?: string } = {}) {
    requirePermission(actor, "suppliers.manage");
    const note = checkReason(input.note);
    const reference = checkReference(input.reference);
    const now = opts.now ?? new Date();
    const req = await supplierCapabilityService.evidenceRequest(input, opts);
    if (!opts.approvalId) throw Errors.forbidden(OPERATION_PERMISSION[CAPABILITY_OPERATION]);
    const id = uuidv7();
    await prisma.$transaction(async (tx) => {
      await useApproval(tx, actor, opts.approvalId!, CAPABILITY_OPERATION, req.payload, input.environment, now);
      await tx.supplierOfferEnablement.create({
        data: {
          id,
          supplierId: req.supplierId,
          environment: input.environment,
          offerExternalId: input.offerExternalId,
          classKey: input.classKey,
          evidenceKind: input.evidenceKind,
          reference,
          offerTermsHash: req.termsHash,
          approvalId: opts.approvalId!,
          recordedBy: actor.id ?? null,
          recordedAt: now,
        },
      });
      await audit(
        actor,
        "supplier_capability.evidence_recorded",
        { type: "supplier_offer_enablement", id },
        { after: { environment: input.environment, offerExternalId: input.offerExternalId, classKey: input.classKey, evidenceKind: input.evidenceKind, approvalId: opts.approvalId }, reason: note },
        tx,
      );
    }, TX_OPTIONS);
    await reevaluateMapped(opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE, input.environment, "offer_evidence", [input.offerExternalId]);
    return { id };
  },

  /** Withdraw evidence. Tightening: no approval. A revoked row stays revoked. */
  async revokeEvidence(actor: Actor, evidenceId: string, reason: string, opts: { now?: Date; supplierCode?: string } = {}) {
    requirePermission(actor, "suppliers.manage");
    const r = checkReason(reason);
    const now = opts.now ?? new Date();
    const row = await prisma.supplierOfferEnablement.findUnique({ where: { id: evidenceId } });
    if (!row) throw Errors.notFound("Evidence");
    if (row.revokedAt) return { revoked: false };
    await prisma.$transaction(async (tx) => {
      const done = await tx.supplierOfferEnablement.updateMany({ where: { id: evidenceId, revokedAt: null }, data: { revokedAt: now, revokedBy: actor.id ?? null, revokeReason: r } });
      if (done.count === 1) {
        await audit(actor, "supplier_capability.evidence_revoked", { type: "supplier_offer_enablement", id: evidenceId }, { before: { revokedAt: null }, after: { revokedAt: now.toISOString() }, reason: r }, tx);
      }
    }, TX_OPTIONS);
    await reevaluateMapped(opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE, row.environment, "offer_evidence", [row.offerExternalId]);
    return { revoked: true };
  },
};
