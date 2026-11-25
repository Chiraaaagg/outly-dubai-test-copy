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
  capabilityKeyNote,
  DATE_ONLY_CLASS_KEYS,
  environmentRefusal,
  externalFlagsEnabled,
  isTimeShapeNeighbour,
  neverEnabledReason,
  offerProvider,
  parseClassKey,
  PROOF_SCOPE_KINDS,
  SEEDED_CLASS_KEYS,
  type CapabilityDimensions,
  type ProofScopeKind,
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
 *  - Class proofs (doc 30 §3.12, N2; D14, D20, D21, D24): one row per offer
 *    type with a scope (every offer of the key, one external provider, or
 *    named tours), recorded under the same approval operation as evidence.
 *    Fixed once recorded (database guard); revoked, never edited. Widening
 *    is a new row with its own approval and code; recording a scope that an
 *    active proof of the key already covers (narrowing) needs none; revoking
 *    is free. External keys are never proven for "all offers" (D21: the
 *    booked provider only); a ticket key's first proof names tours (D24: the
 *    booked attraction first). A provider scope needs a payload that names
 *    the provider (`offerProvider`); TravelDesk's does not today, so the
 *    fallback is the named tours scope.
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
  date_only_inquiry: "Only the two internal, per-person date-only classes of Batch 7 are built (and kept off until TravelDesk answers Q5); other date-only classes stay inquiry",
  ticket_booking_refused: "Only the open-dated, self-arrival, internal, per-person ticket class is built; other ticket classes stay inquiry",
  date_only_q5_pending: "Date-only classes cannot be switched on in production until TravelDesk answers Q5 and the code lock is lifted; the test environment stays switchable for a sandbox drill",
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

export const PROOF_EVIDENCE_KINDS = ["production_booking", "sandbox_drill"] as const;
export type ProofEvidenceKind = (typeof PROOF_EVIDENCE_KINDS)[number];
/** At most this many tours in one named-tours scope (database check). */
export const MAX_PROOF_TOURS = 200;

export interface ClassProofInput {
  environment: SupplierEnvironment;
  classKey: string;
  /** The key the supervised booking was made on: `classKey`, or a time-shape neighbour (decision 22, D20). */
  basisClassKey: string;
  scopeKind: ProofScopeKind;
  scopeProvider?: string | null;
  scopeTourIds?: readonly string[];
  evidenceKind: ProofEvidenceKind;
  reference: string;
  /** The active proof this one widens, when it is a widening. */
  widensProofId?: string | null;
}

/** The approval payload of recording a class proof: every fact of the row, normalised. */
export function classProofApprovalPayload(supplierCode: string, input: ClassProofInput) {
  return {
    kind: "class_proof",
    supplierCode,
    environment: input.environment,
    classKey: input.classKey,
    basisClassKey: input.basisClassKey,
    scopeKind: input.scopeKind,
    scopeProvider: input.scopeKind === "provider" ? (input.scopeProvider ?? "").trim() : null,
    scopeTourIds: input.scopeKind === "tours" ? normaliseTours(input.scopeTourIds ?? []) : [],
    evidenceKind: input.evidenceKind,
    reference: input.reference.trim(),
    widensProofId: input.widensProofId ?? null,
  };
}

function normaliseTours(ids: readonly string[]): string[] {
  return [...new Set(ids.map((t) => t.trim()).filter(Boolean))].sort((a, b) => Number(a) - Number(b) || (a < b ? -1 : 1));
}

/** Whether an active proof's scope already covers every offer a new scope would (so the new row loosens nothing). */
export function scopeCovers(
  have: { scopeKind: string; scopeProvider: string | null; scopeTourIds: readonly string[] },
  want: { scopeKind: string; scopeProvider: string | null; scopeTourIds: readonly string[] },
): boolean {
  if (have.scopeKind === "all") return true;
  if (have.scopeKind === "provider") return want.scopeKind === "provider" && want.scopeProvider === have.scopeProvider;
  if (have.scopeKind === "tours") return want.scopeKind === "tours" && want.scopeTourIds.every((t) => have.scopeTourIds.includes(t));
  return false;
}

export interface ClassProofRow {
  id: string;
  classKey: string;
  basisClassKey: string;
  scopeKind: string;
  scopeProvider: string | null;
  scopeTourIds: string[];
  evidenceKind: string;
  reference: string;
  widensProofId: string | null;
  recordedAt: string;
  recordedBy: string | null;
  approvalId: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
}

export interface CapabilityClassRow {
  classKey: string;
  dimensions: CapabilityDimensions | null;
  flag: { id: string; enabled: boolean; requiresOfferEvidence: boolean; reason: string; changedAt: string; changedBy: string | null; approvalId: string | null } | null;
  seeded: boolean;
  /** Why this key can never be switched on in this release, or null. */
  neverEnabled: string | null;
  /** A standing note to read before switching this key on (`capabilityKeyNote`; Batch 7: TravelDesk Q5 unconfirmed), or null. */
  note: string | null;
  /** Live catalogue offers derived into this class. */
  offers: number;
  /** Of those, offers with something for a person to review first. */
  offersNeedingReview: number;
  /** Of those, offers with an active approved mapping. */
  mappedOffers: number;
  /** Active evidence rows recorded for this key. */
  evidence: number;
  /** Doc 30 N2: active class proofs for this key. */
  proofs: number;
  /** Doc 30 N2: a proof has been recorded for this key (revoked included), so the seeded exception no longer applies. */
  proofRecorded: boolean;
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
  /** Doc 30 N2: class proofs, newest first. */
  proofs: ClassProofRow[];
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
    const proofs = supplier ? await prisma.supplierClassProof.findMany({ where: { supplierId: supplier.id, environment }, orderBy: { recordedAt: "desc" }, take: 200 }) : [];
    const termsByOffer = new Map(caps.map((c) => [c.offerExternalId, c.offerTermsHash]));

    // Doc 29 Batch 7: the date-only keys are always listed, so their Q5 note and production lock are visible even with no offer or flag row.
    const keys = new Set<string>([...SEEDED_CLASS_KEYS, ...DATE_ONLY_CLASS_KEYS, ...flags.map((f) => f.classKey), ...caps.map((c) => c.classKey)]);
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
        neverEnabled: neverEnabledReason(classKey) ?? environmentRefusal(classKey, environment),
        note: capabilityKeyNote(classKey),
        offers: inClass.length,
        offersNeedingReview: inClass.filter((c) => c.reviewReasons.length > 0).length,
        mappedOffers: inClass.filter((c) => mapped.has(c.offerExternalId)).length,
        evidence: evidence.filter((e) => e.classKey === classKey && !e.revokedAt).length,
        proofs: proofs.filter((p) => p.classKey === classKey && !p.revokedAt).length,
        proofRecorded: proofs.some((p) => p.classKey === classKey),
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
      proofs: proofs.map((p) => ({
        id: p.id,
        classKey: p.classKey,
        basisClassKey: p.basisClassKey,
        scopeKind: p.scopeKind,
        scopeProvider: p.scopeProvider,
        scopeTourIds: p.scopeTourIds,
        evidenceKind: p.evidenceKind,
        reference: p.reference,
        widensProofId: p.widensProofId,
        recordedAt: p.recordedAt.toISOString(),
        recordedBy: p.recordedBy,
        approvalId: p.approvalId,
        revokedAt: p.revokedAt?.toISOString() ?? null,
        revokeReason: p.revokeReason,
      })),
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
      const never = neverEnabledReason(input.classKey) ?? environmentRefusal(input.classKey, input.environment);
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

  /**
   * Check a class proof before it is asked for or recorded (doc 30 §3.12).
   * Returns the approval payload it would be recorded under, and `needs`:
   * the approval operation, or null when an active proof of the key already
   * covers the scope (narrowing loosens nothing).
   */
  async classProofRequest(input: ClassProofInput, opts: { supplierCode?: string } = {}) {
    const code = opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE;
    const d = checkKey(input.classKey);
    checkKey(input.basisClassKey);
    if (!isTimeShapeNeighbour(input.classKey, input.basisClassKey)) {
      throw Errors.validation({ basisClassKey: "The booked key must be this key or differ from it in time shape alone (decision 22)" });
    }
    const never = neverEnabledReason(input.classKey);
    if (never) throw Errors.conflict(NEVER_MESSAGE[never], { classKey: input.classKey, reason: never });
    if (!(PROOF_EVIDENCE_KINDS as readonly string[]).includes(input.evidenceKind)) throw Errors.validation({ evidenceKind: "A proof is a supervised production booking or a sandbox drill" });
    if (!(PROOF_SCOPE_KINDS as readonly string[]).includes(input.scopeKind)) throw Errors.validation({ scopeKind: "Unknown scope" });
    checkReference(input.reference);
    const payload = classProofApprovalPayload(code, input);
    const supplier = await supplierFor(code);
    const active = await prisma.supplierClassProof.findMany({ where: { supplierId: supplier.id, environment: input.environment, classKey: input.classKey, revokedAt: null } });

    if (payload.scopeKind === "all") {
      // D21: one external booking proves its own provider only.
      if (d.route === "external") throw Errors.conflict("External keys are proven per provider, never for all offers (owner decision D21). Use the provider or named tours scope.");
      // D24: tickets start with the booked attraction; "all" is a later widening of an existing proof.
      if (d.fulfilment === "ticket" && active.length === 0) throw Errors.conflict("A ticket key's first proof names the booked attraction's tours (owner decision D24); widen it after a clean week.");
    }
    if (payload.scopeKind === "provider") {
      if (!payload.scopeProvider || payload.scopeProvider.length > 120) throw Errors.validation({ scopeProvider: "Name the provider (1 to 120 characters)" });
      // Condition 3: provider scope only where the stored payload names the provider; otherwise named tours.
      const offers = await prisma.supplierOfferCapability.findMany({
        where: { supplierId: supplier.id, environment: input.environment, classKey: input.classKey, catalogueItem: { removedAt: null } },
        select: { catalogueItem: { select: { payload: true } } },
      });
      if (!offers.some((o) => offerProvider(o.catalogueItem.payload) === payload.scopeProvider)) {
        throw Errors.conflict("TravelDesk's offer data does not name this provider, so a provider scope would cover nothing. Scope the proof to the booked tours instead (doc 30 §3.12).");
      }
    }
    if (payload.scopeKind === "tours") {
      if (payload.scopeTourIds.length === 0 || payload.scopeTourIds.length > MAX_PROOF_TOURS) throw Errors.validation({ scopeTourIds: `Name 1 to ${MAX_PROOF_TOURS} TravelDesk tour ids` });
      if (payload.scopeTourIds.some((t) => !/^[1-9][0-9]{0,9}$/.test(t))) throw Errors.validation({ scopeTourIds: "Tour ids are TravelDesk numbers" });
      const found = await prisma.supplierCatalogueItem.findMany({
        where: { supplierId: supplier.id, environment: input.environment, kind: "tour", externalId: { in: payload.scopeTourIds }, removedAt: null },
        select: { externalId: true },
      });
      const missing = payload.scopeTourIds.filter((t) => !found.some((f) => f.externalId === t));
      if (missing.length) throw Errors.validation({ scopeTourIds: `Not in the stored catalogue: ${missing.slice(0, 10).join(", ")}` });
    }
    if (payload.widensProofId) {
      const w = active.find((p) => p.id === payload.widensProofId);
      if (!w) throw Errors.validation({ widensProofId: "The proof to widen must be an active proof of the same key" });
    }
    const covered = active.some((p) => scopeCovers(p, payload));
    return { supplierId: supplier.id, payload, needs: covered ? null : CAPABILITY_OPERATION };
  },

  /**
   * Record one class proof. Loosening (unless an active proof of the key
   * already covers the scope): needs an applied approval for exactly this
   * proof, used once. The row is fixed once written (database guard).
   */
  async recordClassProof(actor: Actor, input: ClassProofInput & { note: string }, opts: { approvalId?: string; now?: Date; supplierCode?: string } = {}) {
    requirePermission(actor, "suppliers.manage");
    const note = checkReason(input.note);
    const now = opts.now ?? new Date();
    const req = await supplierCapabilityService.classProofRequest(input, opts);
    if (req.needs && !opts.approvalId) throw Errors.forbidden(OPERATION_PERMISSION[CAPABILITY_OPERATION]);
    const id = uuidv7();
    const p = req.payload;
    await prisma.$transaction(async (tx) => {
      if (req.needs) await useApproval(tx, actor, opts.approvalId!, CAPABILITY_OPERATION, p, input.environment, now);
      await tx.supplierClassProof.create({
        data: {
          id,
          supplierId: req.supplierId,
          environment: input.environment,
          classKey: p.classKey,
          basisClassKey: p.basisClassKey,
          scopeKind: p.scopeKind,
          scopeProvider: p.scopeProvider,
          scopeTourIds: p.scopeTourIds,
          evidenceKind: p.evidenceKind,
          reference: p.reference,
          widensProofId: p.widensProofId,
          approvalId: req.needs ? opts.approvalId! : null,
          recordedBy: actor.id ?? null,
          recordedAt: now,
        },
      });
      await audit(
        actor,
        "supplier_capability.class_proof_recorded",
        { type: "supplier_class_proof", id },
        {
          after: {
            environment: input.environment,
            classKey: p.classKey,
            basisClassKey: p.basisClassKey,
            scopeKind: p.scopeKind,
            scopeTours: p.scopeTourIds.length,
            evidenceKind: p.evidenceKind,
            widensProofId: p.widensProofId,
            approvalId: req.needs ? opts.approvalId : null,
            narrowing: req.needs === null,
          },
          reason: note,
        },
        tx,
      );
    }, TX_OPTIONS);
    await reevaluateMapped(opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE, input.environment, "offer_evidence");
    return { id, approvalUsed: req.needs !== null };
  },

  /** Withdraw a class proof. Tightening: no approval. A revoked proof stays revoked, and the seeded exception does not come back. */
  async revokeClassProof(actor: Actor, proofId: string, reason: string, opts: { now?: Date; supplierCode?: string } = {}) {
    requirePermission(actor, "suppliers.manage");
    const r = checkReason(reason);
    const now = opts.now ?? new Date();
    const row = await prisma.supplierClassProof.findUnique({ where: { id: proofId } });
    if (!row) throw Errors.notFound("Class proof");
    if (row.revokedAt) return { revoked: false };
    await prisma.$transaction(async (tx) => {
      const done = await tx.supplierClassProof.updateMany({ where: { id: proofId, revokedAt: null }, data: { revokedAt: now, revokedBy: actor.id ?? null, revokeReason: r } });
      if (done.count === 1) {
        await audit(actor, "supplier_capability.class_proof_revoked", { type: "supplier_class_proof", id: proofId }, { before: { revokedAt: null }, after: { revokedAt: now.toISOString(), classKey: row.classKey }, reason: r }, tx);
      }
    }, TX_OPTIONS);
    await reevaluateMapped(opts.supplierCode ?? TRAVELDESK_SUPPLIER_CODE, row.environment, "offer_evidence");
    return { revoked: true };
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
