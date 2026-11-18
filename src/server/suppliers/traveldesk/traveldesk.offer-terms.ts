import { createHash } from "node:crypto";
import { z } from "zod";
import type { TravelDeskBookingKind, TravelDeskCancellationRule, TravelDeskPrivateType } from "./traveldesk.codec";

/**
 * The offer terms an editor approves with a mapping (SUP-15, doc 22 §23 B2),
 * read back from the stored catalogue payloads.
 *
 * `supplier_catalogue_items.payload` holds a `TravelDeskOffer` (offer rows) or
 * a `TravelDeskTourDetail` without its offers (tour rows), written by the
 * catalogue sync with bigints as decimal strings. The schemas below read only
 * the fields the booking rules depend on and accept both bigint and string
 * money, so a payload written by an older sync still parses or, when it does
 * not, yields null (unknown) instead of a guess.
 *
 * `approved_offer_hash` is a sha256 over a semantic subset of those terms:
 * pax rules, slots, pickup, cancellation policy, booking kind and price basis.
 * Prices themselves are left out (they move daily and every booking re-checks
 * them live); a change from per-person to per-trip pricing is in.
 *
 * Pure: no env, db or logger.
 */

/** Bump when the subset changes; every approved mapping then reads as changed and needs a fresh review. */
export const OFFER_TERMS_VERSION = 1;

const minor = z.union([z.bigint(), z.string().regex(/^-?\d+$/), z.number().int()]).transform((v) => BigInt(v));
const nint = z.number().int().nullable();

const storedSlotSchema = z.object({
  timeSlotId: z.number().int(),
  startMinutes: z.number().int(),
  endMinutes: nint,
  daysOffered: z.number().int(),
  isAnyTime: z.boolean(),
  isOnRequest: z.boolean(),
  minimumAdvancedBookingHours: nint,
  isExternal: z.boolean(),
});

const storedPeriodSchema = z.object({
  dateStart: z.string().nullable(),
  dateEnd: z.string().nullable(),
  price: z.object({ perAdultMinor: minor, perChildMinor: minor, perTripMinor: minor }).passthrough().nullable(),
});

const pair = z.tuple([nint, nint]);

export const storedOfferSchema = z.object({
  offerId: z.number().int(),
  tourId: z.number().int(),
  bookingKind: z.enum(["on_request", "live_book", "ticket_only", "unknown"]),
  bookingTypeRaw: z.number().int(),
  daysOffered: z.number().int(),
  minPax: z.number().int(),
  maxPax: z.number().int(),
  paxLimits: z.object({ adults: pair, children: pair, infants: pair }),
  privateType: z.enum(["sharing", "private", "unknown"]),
  childrenAllowed: z.boolean(),
  childAge: z.number().int(),
  infantsAllowed: z.boolean(),
  infantAge: z.number().int(),
  isDirectReporting: z.boolean(),
  isDirectCollection: z.boolean(),
  isExternal: z.boolean(),
  tripUnit: z.string().nullable(),
  timeSlots: z.array(storedSlotSchema),
  pricingPeriods: z.array(storedPeriodSchema),
});

export type StoredSlot = z.infer<typeof storedSlotSchema>;
export type StoredOffer = z.infer<typeof storedOfferSchema>;

const storedTourSchema = z.object({
  tourId: z.number().int(),
  cancellationPolicy: z.array(z.object({ moreThanHours: z.number().int(), refundPercent: z.number().int() })),
});

/** The stored offer payload, or null when it lacks a field the booking rules need. */
export function parseStoredOffer(payload: unknown): StoredOffer | null {
  const r = storedOfferSchema.safeParse(payload);
  return r.success ? r.data : null;
}

/** The tour-level cancellation policy (TravelDesk has no offer-level policy), or null when unreadable. */
export function parseStoredPolicy(payload: unknown): TravelDeskCancellationRule[] | null {
  const r = storedTourSchema.safeParse(payload);
  return r.success ? r.data.cancellationPolicy : null;
}

export interface OfferTerms {
  v: number;
  offerId: number;
  tourId: number;
  booking: { kind: TravelDeskBookingKind; typeRaw: number; isExternal: boolean };
  pax: {
    min: number;
    max: number;
    limits: StoredOffer["paxLimits"];
    childrenAllowed: boolean;
    childAge: number;
    infantsAllowed: boolean;
    infantAge: number;
  };
  daysOffered: number;
  slots: StoredSlot[];
  pickup: { directReporting: boolean; directCollection: boolean };
  policy: TravelDeskCancellationRule[];
  priceBasis: { privateType: TravelDeskPrivateType; tripUnit: string | null; perPerson: boolean; perTrip: boolean };
}

/** The semantic subset, in a canonical order. Null when either payload is unreadable. */
export function offerTermsOf(offerPayload: unknown, tourPayload: unknown): OfferTerms | null {
  const o = parseStoredOffer(offerPayload);
  const policy = parseStoredPolicy(tourPayload);
  if (!o || !policy) return null;
  const priced = o.pricingPeriods.flatMap((p) => (p.price ? [p.price] : []));
  return {
    v: OFFER_TERMS_VERSION,
    offerId: o.offerId,
    tourId: o.tourId,
    booking: { kind: o.bookingKind, typeRaw: o.bookingTypeRaw, isExternal: o.isExternal },
    pax: {
      min: o.minPax,
      max: o.maxPax,
      limits: o.paxLimits,
      childrenAllowed: o.childrenAllowed,
      childAge: o.childAge,
      infantsAllowed: o.infantsAllowed,
      infantAge: o.infantAge,
    },
    daysOffered: o.daysOffered,
    slots: [...o.timeSlots].sort((a, b) => a.timeSlotId - b.timeSlotId || a.startMinutes - b.startMinutes),
    pickup: { directReporting: o.isDirectReporting, directCollection: o.isDirectCollection },
    policy: [...policy].sort((a, b) => a.moreThanHours - b.moreThanHours || a.refundPercent - b.refundPercent),
    priceBasis: {
      privateType: o.privateType,
      tripUnit: o.tripUnit,
      perPerson: priced.some((p) => p.perAdultMinor > 0n || p.perChildMinor > 0n),
      perTrip: priced.some((p) => p.perTripMinor > 0n),
    },
  };
}

/** JSON with sorted object keys, so the hash does not depend on property order. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

/** sha256 hex of the offer terms, or null when the stored payloads cannot be read. A null hash never passes readiness. */
export function offerTermsHash(offerPayload: unknown, tourPayload: unknown): string | null {
  const terms = offerTermsOf(offerPayload, tourPayload);
  return terms ? createHash("sha256").update(canonicalJson(terms)).digest("hex") : null;
}
