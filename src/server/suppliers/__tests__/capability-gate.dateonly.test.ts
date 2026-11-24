import { describe, expect, it } from "vitest";
import { storedOffer } from "./fixtures/traveldesk-terms";
import { gateVerdict, loadCapabilityGate, type CapabilityGateContext } from "../capability-gate";
import { RESERVATION_SLOT_MISMATCH_CODE, reservationSlotDiffers } from "../traveldesk/traveldesk.confirmation";
import { bookingReason } from "../../services/ops-alert.service";

/**
 * Doc 29 Batch 7, review 92 B7-12 and B7-14, pure:
 *  - the gate's production lock: a context for production with the
 *    date-only flag on and evidence for the key and terms still refuses
 *    (`class_not_sellable`); the same context for test sells; the
 *    environment is always copied into the context;
 *  - the reservation slot check: an answer naming another slot id than the
 *    one sent is a mismatch (held for a human before capture), one that
 *    leaves the id out says nothing, and the ops alert names it.
 * Synthetic data only.
 */

const SELF = "live.date_only_no_slot_metadata.self.internal.per_person";
const HASH = "a".repeat(64);
const payload = storedOffer({ offerId: 97011, timeSlots: [], durationHours: 3 });

function ctx(environment: "test" | "production"): CapabilityGateContext {
  return {
    adapter: "traveldesk",
    environment,
    flags: new Map([[SELF, { enabled: true, requiresOfferEvidence: true }]]),
    evidence: new Map([["97011", [{ classKey: SELF, offerTermsHash: HASH, revokedAt: null }]]]),
  };
}

describe("gateVerdict: the Q5 production lock (owner decision d)", () => {
  it("production refuses the date-only key even with its flag on and evidence; test sells it", () => {
    expect(gateVerdict(ctx("production"), "97011", payload, HASH).verdict).toEqual({ instant: false, classKey: SELF, reason: "class_not_sellable" });
    expect(gateVerdict(ctx("test"), "97011", payload, HASH).verdict).toEqual({ instant: true, classKey: SELF });
  });

  it("other keys are not affected by the lock in production", () => {
    const fixed = storedOffer({ offerId: 501 });
    const c: CapabilityGateContext = { adapter: "traveldesk", environment: "production", flags: new Map([["live.fixed_slot_single.self.internal.per_person", { enabled: true, requiresOfferEvidence: false }]]), evidence: new Map() };
    expect(gateVerdict(c, "501", fixed, HASH).verdict).toEqual({ instant: true, classKey: "live.fixed_slot_single.self.internal.per_person" });
  });

  it("loadCapabilityGate always copies the environment it read the flags for", async () => {
    const db = {
      supplierCapabilityFlag: { findMany: async () => [{ classKey: SELF, enabled: true, requiresOfferEvidence: true }] },
      supplierOfferEnablement: { findMany: async () => [{ offerExternalId: "97011", classKey: SELF, offerTermsHash: HASH, revokedAt: null }] },
    };
    const loaded = await loadCapabilityGate(db as never, { adapter: "traveldesk", supplierId: "sup-1", environment: "production", offerExternalIds: ["97011"] });
    expect(loaded.environment).toBe("production");
    expect(gateVerdict(loaded, "97011", payload, HASH).verdict).toMatchObject({ instant: false, reason: "class_not_sellable" });
  });
});

describe("reservation slot check (review 92 B7-12)", () => {
  it("another slot id is a mismatch; the same id, or none echoed, is not; a booking sent without a slot is never checked", () => {
    expect(reservationSlotDiffers("0", { timeSlotId: "0" })).toBe(false);
    expect(reservationSlotDiffers("7", { timeSlotId: "8" })).toBe(true);
    expect(reservationSlotDiffers("0", { timeSlotId: null })).toBe(false);
    expect(reservationSlotDiffers(null, { timeSlotId: "8" })).toBe(false);
  });

  it("is an ops-alert reason while it needs staff", () => {
    expect(bookingReason({ state: "awaiting_payment", errorCode: RESERVATION_SLOT_MISMATCH_CODE, attention: true, recoverySearches: 0 })).toBe("reservation_slot_mismatch");
    expect(bookingReason({ state: "awaiting_payment", errorCode: RESERVATION_SLOT_MISMATCH_CODE, attention: false, recoverySearches: 0 })).toBeNull();
  });
});
