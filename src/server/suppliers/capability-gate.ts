import "server-only";
import type { SupplierEnvironment } from "@prisma/client";
import type { prisma, Tx } from "../lib/db";
import {
  capabilityVerdict,
  deriveCapabilities,
  environmentRefusal,
  offerProvider,
  type CapabilityFlagState,
  type ClassProofState,
  type CapabilityVerdict,
  type DerivedCapability,
  type OfferEvidenceState,
} from "./traveldesk/traveldesk.capability";

/**
 * The one capability lookup (doc 29 §3.3, Batch 1a). Read by readiness
 * (`supplierCatalogService.mappingReadinessFor`), the saga intake
 * (`engine-saga.service.ts startAttempt`) and the engine intake
 * (`supplierBookingService.createIntent`), so all three refuse the same
 * offers. Each re-derives the capability from the stored offer payload it
 * already holds, then reads the flag for that exact class key and
 * environment, and the offer's evidence. Read-only; no supplier call.
 *
 * It only ever adds a refusal: every check that existed before (live-book
 * kind, TravelDesk adapter, approved terms) stays where it was.
 *
 * Doc 30 N2: it also reads the class proof rows (`supplier_class_proofs`)
 * and each offer's stored tour, so a proof scoped to all offers, a provider
 * or named tours can stand in for per-offer evidence (`capabilityVerdict`).
 */

/** Adapter whose class vocabulary `traveldesk.capability.ts` defines. Any other adapter has no sellable class. */
export const CAPABILITY_ADAPTER = "traveldesk";

type Db = Tx | typeof prisma;

export interface CapabilityGateContext {
  adapter: string;
  /** The environment the flags were read for; a key locked there (`environmentRefusal`, Batch 7) never sells. Required (review 92 B7-14). */
  environment: SupplierEnvironment;
  flags: Map<string, CapabilityFlagState>;
  /** Evidence per offer external id (active and revoked; the verdict ignores revoked rows). */
  evidence: Map<string, OfferEvidenceState[]>;
  /** Doc 30 N2: every class proof row of the supplier and environment (active and revoked). Absent: none. */
  proofs?: ClassProofState[];
  /** Doc 30 N2: the stored tour id (parent) of each offer asked about. */
  tourByOffer?: Map<string, string | null>;
}

export interface CapabilityCheck {
  capability: DerivedCapability;
  verdict: CapabilityVerdict;
}

/** Flags of the adapter and environment, the evidence and tours of the given offers, and the class proofs. One read each. */
export async function loadCapabilityGate(
  db: Db,
  input: { adapter: string; supplierId: string; environment: SupplierEnvironment; offerExternalIds: readonly string[] },
): Promise<CapabilityGateContext> {
  const ids = [...new Set(input.offerExternalIds)];
  const [flags, evidence, proofs, offers] = await Promise.all([
    db.supplierCapabilityFlag.findMany({
      where: { adapter: input.adapter, environment: input.environment },
      select: { classKey: true, enabled: true, requiresOfferEvidence: true },
    }),
    ids.length
      ? db.supplierOfferEnablement.findMany({
          where: { supplierId: input.supplierId, environment: input.environment, offerExternalId: { in: ids }, revokedAt: null },
          select: { offerExternalId: true, classKey: true, offerTermsHash: true, revokedAt: true },
        })
      : Promise.resolve([] as { offerExternalId: string; classKey: string; offerTermsHash: string; revokedAt: Date | null }[]),
    db.supplierClassProof.findMany({
      where: { supplierId: input.supplierId, environment: input.environment },
      select: { classKey: true, scopeKind: true, scopeProvider: true, scopeTourIds: true, revokedAt: true },
    }),
    ids.length
      ? db.supplierCatalogueItem.findMany({
          where: { supplierId: input.supplierId, environment: input.environment, kind: "offer", externalId: { in: ids } },
          select: { externalId: true, parentExternalId: true },
        })
      : Promise.resolve([] as { externalId: string; parentExternalId: string | null }[]),
  ]);
  const byOffer = new Map<string, OfferEvidenceState[]>();
  for (const e of evidence) byOffer.set(e.offerExternalId, [...(byOffer.get(e.offerExternalId) ?? []), e]);
  return {
    adapter: input.adapter,
    environment: input.environment,
    flags: new Map(flags.map((f) => [f.classKey, { enabled: f.enabled, requiresOfferEvidence: f.requiresOfferEvidence }])),
    evidence: byOffer,
    proofs,
    tourByOffer: new Map(offers.map((o) => [o.externalId, o.parentExternalId])),
  };
}

/**
 * The verdict for one stored offer payload. `termsHash` is the offer terms
 * hash the offer's evidence must have been recorded against (null: unknown,
 * so evidence never matches).
 */
export function gateVerdict(ctx: CapabilityGateContext, offerExternalId: string, payload: unknown, termsHash: string | null): CapabilityCheck {
  const capability = deriveCapabilities(payload);
  if (ctx.adapter !== CAPABILITY_ADAPTER) return { capability, verdict: { instant: false, classKey: capability.classKey, reason: "class_unknown" } };
  // Batch 7 (owner decision d): a key locked in this environment is refused whatever its flag row says.
  if (environmentRefusal(capability.classKey, ctx.environment)) {
    return { capability, verdict: { instant: false, classKey: capability.classKey, reason: "class_not_sellable" } };
  }
  const proof = { proofs: ctx.proofs ?? [], tourByOffer: ctx.tourByOffer };
  const verdict = capabilityVerdict(capability, ctx.flags.get(capability.classKey) ?? null, ctx.evidence.get(offerExternalId) ?? [], termsHash, {
    proofs: proof.proofs,
    tourExternalId: proof.tourByOffer?.get(offerExternalId) ?? null,
    provider: offerProvider(payload),
  });
  return { capability, verdict };
}

/** Load and check one offer. */
export async function checkOfferCapability(
  db: Db,
  input: { adapter: string; supplierId: string; environment: SupplierEnvironment; offerExternalId: string; payload: unknown; termsHash: string | null },
): Promise<CapabilityCheck> {
  const ctx = await loadCapabilityGate(db, { adapter: input.adapter, supplierId: input.supplierId, environment: input.environment, offerExternalIds: [input.offerExternalId] });
  return gateVerdict(ctx, input.offerExternalId, input.payload, input.termsHash);
}
