import "server-only";
import type { SupplierEnvironment } from "@prisma/client";
import type { prisma, Tx } from "../lib/db";
import {
  capabilityVerdict,
  deriveCapabilities,
  environmentRefusal,
  type CapabilityFlagState,
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
}

export interface CapabilityCheck {
  capability: DerivedCapability;
  verdict: CapabilityVerdict;
}

/** Flags of the adapter and environment, and the evidence of the given offers. One read each. */
export async function loadCapabilityGate(
  db: Db,
  input: { adapter: string; supplierId: string; environment: SupplierEnvironment; offerExternalIds: readonly string[] },
): Promise<CapabilityGateContext> {
  const ids = [...new Set(input.offerExternalIds)];
  const [flags, evidence] = await Promise.all([
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
  ]);
  const byOffer = new Map<string, OfferEvidenceState[]>();
  for (const e of evidence) byOffer.set(e.offerExternalId, [...(byOffer.get(e.offerExternalId) ?? []), e]);
  return {
    adapter: input.adapter,
    environment: input.environment,
    flags: new Map(flags.map((f) => [f.classKey, { enabled: f.enabled, requiresOfferEvidence: f.requiresOfferEvidence }])),
    evidence: byOffer,
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
  const verdict = capabilityVerdict(capability, ctx.flags.get(capability.classKey) ?? null, ctx.evidence.get(offerExternalId) ?? [], termsHash);
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
