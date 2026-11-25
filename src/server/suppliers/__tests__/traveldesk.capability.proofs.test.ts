import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { storedOffer, storedSlot } from "./fixtures/traveldesk-terms";
import {
  capabilityVerdict,
  deriveCapabilities,
  isTimeShapeNeighbour,
  offerProvider,
  proofCovers,
  SEEDED_CLASS_KEYS,
  type CapabilityFlagState,
  type ClassProofState,
  type OfferEvidenceState,
  type ProofContext,
} from "../traveldesk/traveldesk.capability";

/**
 * Doc 30 §3.12 (build N2; D14, D20, D21, D24; review RR-03): class proofs in
 * the capability gate.
 *
 *  - parity: with no proof rows the verdict equals the verdict before N2 for
 *    every combination of class, flag and evidence (never more permissive
 *    than per-offer rows for a key without proof);
 *  - the seeded keys' exception holds until a proof has been recorded for the
 *    key, revoked or not;
 *  - scopes: every offer of the key, named tours, one provider (which needs a
 *    payload naming it: none does today);
 *  - time-shape neighbours (decision 22).
 */

const HASH = "a".repeat(64);
const SINGLE = SEEDED_CLASS_KEYS[0];
const PICKUP = "live.fixed_slot_single.pickup_required.internal.per_person";
const LISTED = "live.listed_start_single.self.internal.per_person";

const seeded = deriveCapabilities(storedOffer());
const pickup = deriveCapabilities(storedOffer({ isDirectReporting: false }));
const ticket = deriveCapabilities(storedOffer({ bookingKind: "ticket_only", bookingTypeRaw: 2, timeSlots: [] }));
const perUnit = deriveCapabilities(storedOffer({ pricingPeriods: [{ periodId: 1, dateStart: "2026-01-01", dateEnd: null, price: { currency: "AED", perAdultMinor: "0", perChildMinor: "0", perTripMinor: "50000" } }] }));
const unknown = deriveCapabilities({ nonsense: true });
const listed = deriveCapabilities(storedOffer({ timeSlots: [storedSlot({ isAnyTime: true })] }));

const proof = (over: Partial<ClassProofState> = {}): ClassProofState => ({ classKey: SINGLE, scopeKind: "all", scopeProvider: null, scopeTourIds: [], revokedAt: null, ...over });
const ctx = (proofs: ClassProofState[], tour: string | null = "3001", provider: string | null = null): ProofContext => ({ proofs, tourExternalId: tour, provider });
const ev = (over: Partial<OfferEvidenceState> = {}): OfferEvidenceState => ({ classKey: PICKUP, offerTermsHash: HASH, revokedAt: null, ...over });

describe("class proofs in capabilityVerdict (doc 30 N2)", () => {
  it("fixtures derive the keys the tests name", () => {
    expect(seeded.classKey).toBe(SINGLE);
    expect(pickup.classKey).toBe(PICKUP);
    expect(listed.classKey).toBe(LISTED);
  });

  it("parity: with no proof rows, every verdict equals the pre-N2 verdict", () => {
    const caps = [seeded, pickup, ticket, perUnit, unknown, listed];
    const flags: (CapabilityFlagState | null)[] = [null, { enabled: false, requiresOfferEvidence: false }, { enabled: true, requiresOfferEvidence: false }, { enabled: true, requiresOfferEvidence: true }];
    const evidences: OfferEvidenceState[][] = [[], [ev({ classKey: SINGLE })], [ev()], [ev({ revokedAt: new Date() })], [ev({ offerTermsHash: "b".repeat(64) })]];
    const hashes = [HASH, null];
    let n = 0;
    for (const c of caps)
      for (const f of flags)
        for (const e of evidences)
          for (const h of hashes) {
            const before = capabilityVerdict(c, f, e, h);
            expect(capabilityVerdict(c, f, e, h, null)).toEqual(before);
            expect(capabilityVerdict(c, f, e, h, ctx([]))).toEqual(before);
            // A proof for another key changes nothing either.
            expect(capabilityVerdict(c, f, e, h, ctx([proof({ classKey: "live.fixed_slot_choice.pickup_required.internal.per_person" })]))).toEqual(before);
            n++;
          }
    expect(n).toBe(240);
  });

  it("the seeded exception holds until a proof is recorded for the key (RR-03), and does not come back on revoke", () => {
    const on = { enabled: true, requiresOfferEvidence: false };
    expect(capabilityVerdict(seeded, on, [], HASH, ctx([]))).toEqual({ instant: true, classKey: SINGLE });
    // A proof naming other tours: the exception is over, and this offer is not covered.
    expect(capabilityVerdict(seeded, on, [], HASH, ctx([proof({ scopeKind: "tours", scopeTourIds: ["9999"] })]))).toMatchObject({ instant: false, reason: "offer_evidence_missing" });
    // Revoked: still over.
    expect(capabilityVerdict(seeded, on, [], HASH, ctx([proof({ revokedAt: new Date() })]))).toMatchObject({ instant: false, reason: "offer_evidence_missing" });
    // Covered by an active proof, or by per-offer evidence.
    expect(capabilityVerdict(seeded, on, [], HASH, ctx([proof({ revokedAt: new Date() }), proof()]))).toEqual({ instant: true, classKey: SINGLE });
    expect(capabilityVerdict(seeded, on, [ev({ classKey: SINGLE })], HASH, ctx([proof({ revokedAt: new Date() })]))).toEqual({ instant: true, classKey: SINGLE });
  });

  it("a proof stands in for per-offer evidence and does not lapse when terms change", () => {
    const on = { enabled: true, requiresOfferEvidence: true };
    expect(capabilityVerdict(pickup, on, [], HASH, ctx([]))).toMatchObject({ reason: "offer_evidence_missing" });
    expect(capabilityVerdict(pickup, on, [], HASH, ctx([proof({ classKey: PICKUP })]))).toEqual({ instant: true, classKey: PICKUP });
    // Unknown current terms: evidence can never match, a proof still covers.
    expect(capabilityVerdict(pickup, on, [], null, ctx([proof({ classKey: PICKUP })]))).toEqual({ instant: true, classKey: PICKUP });
  });

  it("a proof never opens what the flag, the class or a review keeps closed", () => {
    const all = ctx([proof({ classKey: PICKUP }), proof({ classKey: perUnit.classKey }), proof({ classKey: ticket.classKey })]);
    expect(capabilityVerdict(pickup, null, [], HASH, all)).toMatchObject({ reason: "flag_off" });
    expect(capabilityVerdict(pickup, { enabled: false, requiresOfferEvidence: true }, [], HASH, all)).toMatchObject({ reason: "flag_off" });
    expect(capabilityVerdict(perUnit, { enabled: true, requiresOfferEvidence: true }, [], HASH, all)).toMatchObject({ reason: "class_not_sellable" });
    expect(capabilityVerdict(unknown, { enabled: true, requiresOfferEvidence: true }, [], HASH, all)).toMatchObject({ reason: "class_unknown" });
    const review = { ...pickup, reviewReasons: ["slot_units_unexplained"] };
    expect(capabilityVerdict(review, { enabled: true, requiresOfferEvidence: true }, [], HASH, all)).toMatchObject({ reason: "review_required" });
  });

  it("scopes: all, named tours, provider", () => {
    expect(proofCovers(proof(), SINGLE, null, null)).toBe(true);
    expect(proofCovers(proof({ scopeKind: "tours", scopeTourIds: ["3001", "3002"] }), SINGLE, "3002", null)).toBe(true);
    expect(proofCovers(proof({ scopeKind: "tours", scopeTourIds: ["3001"] }), SINGLE, "3002", null)).toBe(false);
    expect(proofCovers(proof({ scopeKind: "tours", scopeTourIds: ["3001"] }), SINGLE, null, null)).toBe(false);
    expect(proofCovers(proof({ scopeKind: "provider", scopeProvider: "Synthetic provider" }), SINGLE, "3001", "Synthetic provider")).toBe(true);
    expect(proofCovers(proof({ scopeKind: "provider", scopeProvider: "Synthetic provider" }), SINGLE, "3001", null)).toBe(false);
    expect(proofCovers(proof({ scopeKind: "provider", scopeProvider: "Synthetic provider" }), SINGLE, "3001", "Other provider")).toBe(false);
    expect(proofCovers(proof({ revokedAt: "2026-11-27T00:00:00.000Z" }), SINGLE, "3001", null)).toBe(false);
    expect(proofCovers(proof(), PICKUP, "3001", null)).toBe(false);
    expect(proofCovers(proof({ scopeKind: "unexpected" }), SINGLE, "3001", null)).toBe(false);
  });

  it("no TravelDesk payload names a provider today, so a provider scope covers nothing (condition 3)", () => {
    expect(offerProvider(storedOffer())).toBeNull();
    expect(offerProvider(storedOffer({ isExternal: true }))).toBeNull();
    expect(capabilityVerdict(pickup, { enabled: true, requiresOfferEvidence: true }, [], HASH, ctx([proof({ classKey: PICKUP, scopeKind: "provider", scopeProvider: "Synthetic provider" })], "3001", offerProvider(storedOffer())))).toMatchObject({
      reason: "offer_evidence_missing",
    });
  });

  it("time-shape neighbours: slotted live shapes that differ in time shape alone (decision 22)", () => {
    expect(isTimeShapeNeighbour(SINGLE, SINGLE)).toBe(true);
    expect(isTimeShapeNeighbour(SINGLE, "live.fixed_slot_choice.self.internal.per_person")).toBe(true);
    expect(isTimeShapeNeighbour(SINGLE, LISTED)).toBe(true);
    expect(isTimeShapeNeighbour(SINGLE, "live.listed_starts_customer_selected.self.internal.per_person")).toBe(true);
    expect(isTimeShapeNeighbour(SINGLE, PICKUP)).toBe(false);
    expect(isTimeShapeNeighbour(SINGLE, "live.fixed_slot_single.self.external.per_person")).toBe(false);
    expect(isTimeShapeNeighbour(SINGLE, "live.date_only_no_slot_metadata.self.internal.per_person")).toBe(false);
    expect(isTimeShapeNeighbour("ticket.open_dated.self.internal.per_person", SINGLE)).toBe(false);
    expect(isTimeShapeNeighbour("unknown", "unknown")).toBe(false);
  });

  it("migration M5's neighbour check and the code agree on which parts must match", () => {
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations/20261127150000_n2_class_proofs_bulk_operations/migration.sql"), "utf8");
    for (const part of [1, 3, 4, 5]) expect(sql).toContain(`split_part("class_key", '.', ${part}) = split_part("basis_class_key", '.', ${part})`);
    expect(sql).not.toContain(`split_part("class_key", '.', 2) = split_part("basis_class_key", '.', 2)`);
  });
});
