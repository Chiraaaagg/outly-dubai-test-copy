import { createHash } from "node:crypto";
import type { Activity } from "@/lib/types";
import { activityInputSchema, type ActivityInput } from "../../schemas/activity.schema";
import { EDITORIAL_FIELDS, NON_REFUNDABLE_POLICY, personLocksBetween, QUOTE_ONLY_LOCK, variantNameLock, variantPriceLock } from "./traveldesk.listing-build";
import { stepOfClassKey } from "./traveldesk.listing-plan";
import type { OfferTerms } from "./traveldesk.offer-terms";

/**
 * The daily upkeep of imported TravelDesk listings, build N3 (doc 30 §3.10;
 * owner decisions D17, D18, D19): the pure decisions. The service
 * (`traveldesk-upkeep.service.ts`) reads the rows, calls these, and writes
 * the result in one transaction per listing.
 *
 *  - Options (`classifyOptions`). One page holds one set of facts. An
 *    instant listing keeps the options that still share its identity
 *    (arrival, route, fulfilment, fixed at import) and one start-time set and
 *    exact class key: the set it has now when any option still has it, else
 *    the largest group (ties: the group with the lowest offer id). Every
 *    other option is marked sold out and listed for review ("diverged"). An
 *    option whose class became never-instant (per vehicle, on request,
 *    unknown) is sold out and listed too ("never_instant"). An option whose
 *    offer left the catalogue is sold out and its mapping deactivated
 *    ("removed"). An option a person marked sold out is left alone. Inquiry
 *    listings (D4) may hold options of different shapes: all present
 *    options are kept.
 *  - The document (`mergeDocument`). Editorial fields follow the supplier
 *    text unless a person changed them since the system last wrote the page
 *    (the lock rule of §3.7, `lockedFieldsBetween` against that version; a
 *    variant's name is locked the same way). A locked field whose supplier
 *    text changed is reported ("locked_text_changed"). Facts follow the
 *    supplier and cannot be locked: start times, duration, privacy, units,
 *    ages and quantities, the rule price, the cancellation hours.
 *  - Price (D18, `priceMoveBps`): a move of at most 20% on every unit
 *    applies by itself; a larger one waits for a person and the page keeps
 *    its prices ("hold"), or, when the unit set changed so no old price
 *    exists for a new unit, keeps all its price-bearing facts ("keep") and
 *    the changed terms are not re-approved. A price under the floor is never
 *    written (the draft builder refuses it).
 *  - Terms (D17, `termsDiff`): each changed offer term by name, old and new.
 *  - Removed tours (D19, `unavailabilityStep`): "currently unavailable" for
 *    14 days, then hidden.
 *
 * Nets never enter anything here: only sell prices, facts and offer terms.
 * Pure: no env, db, clock or logger.
 */

export const UPKEEP_VERSION = 1;
/** D18: a price move up to this share applies by itself. */
export const PRICE_AUTO_LIMIT_BPS = 2000;
const DAY_MS = 24 * 3_600_000;
/** D19: a vanished listing shows "currently unavailable" this long, then is hidden. */
export const UNAVAILABLE_HIDE_AFTER_MS = 14 * DAY_MS;
/**
 * Review 103 N0-13: a removed tour's content row is deleted this long after
 * the catalogue last saw the tour. Every listing keeps its own copy of the
 * text in its document; a tour that comes back is stored again by the sync.
 */
export const TOUR_CONTENT_KEEP_AFTER_REMOVAL_MS = 30 * DAY_MS;

export type OptionVerdict = "kept" | "diverged" | "never_instant" | "removed" | "inactive";

export interface OptionState {
  offerId: number;
  variantId: string;
  /** The listing's document has this variant. */
  inDoc: boolean;
  /** A person (or an earlier run) marked it sold out. */
  soldOutInDoc: boolean;
  /** The offer, or its tour, is gone from the stored catalogue, or the offer moved to another tour. */
  removed: boolean;
  /** Derived now from the stored offer; null when it cannot be read. */
  classKey: string | null;
  dimensions: { arrival: string; route: string; fulfilment: string } | null;
  startMinutes: number[] | null;
}

export interface LinkShape {
  kind: string;
  classKey: string | null;
  startMinutes: number[];
  arrival: string;
  route: string;
  fulfilment: string;
}

export interface Classified {
  verdicts: { offerId: number; variantId: string; verdict: OptionVerdict; reason: string | null }[];
  kept: number[];
  /** The class key and start set the listing holds after this run (instant listings). */
  signature: { classKey: string | null; startMinutes: number[] };
}

const sortedStarts = (s: number[] | null) => [...new Set(s ?? [])].sort((a, b) => a - b);
const sigOf = (classKey: string | null, starts: number[] | null) => `${classKey ?? ""}|${sortedStarts(starts).join(",")}`;

/** Which options a listing keeps after the supplier changed (see the module comment). */
export function classifyOptions(link: LinkShape, options: OptionState[]): Classified {
  const verdicts: Classified["verdicts"] = [];
  const candidates: OptionState[] = [];
  for (const o of options) {
    if (o.removed) verdicts.push({ offerId: o.offerId, variantId: o.variantId, verdict: "removed", reason: "offer_removed" });
    else if (!o.inDoc || o.soldOutInDoc) verdicts.push({ offerId: o.offerId, variantId: o.variantId, verdict: "inactive", reason: null });
    else if (link.kind !== "instant") verdicts.push({ offerId: o.offerId, variantId: o.variantId, verdict: "kept", reason: null });
    else if (!o.classKey || !stepOfClassKey(o.classKey)) verdicts.push({ offerId: o.offerId, variantId: o.variantId, verdict: "never_instant", reason: o.classKey ?? "unreadable" });
    else if (!o.dimensions || o.dimensions.arrival !== link.arrival || o.dimensions.route !== link.route || o.dimensions.fulfilment !== link.fulfilment) {
      verdicts.push({ offerId: o.offerId, variantId: o.variantId, verdict: "diverged", reason: "identity" });
    } else candidates.push(o);
  }
  if (link.kind !== "instant") {
    return { verdicts, kept: verdicts.filter((v) => v.verdict === "kept").map((v) => v.offerId), signature: { classKey: null, startMinutes: [] } };
  }
  const groups = new Map<string, OptionState[]>();
  for (const o of candidates) groups.set(sigOf(o.classKey, o.startMinutes), [...(groups.get(sigOf(o.classKey, o.startMinutes)) ?? []), o]);
  const current = sigOf(link.classKey, link.startMinutes);
  let chosen: OptionState[] = groups.get(current) ?? [];
  if (!chosen.length) {
    const ranked = [...groups.values()].sort((a, b) => b.length - a.length || Math.min(...a.map((o) => o.offerId)) - Math.min(...b.map((o) => o.offerId)));
    chosen = ranked[0] ?? [];
  }
  const keptIds = new Set(chosen.map((o) => o.offerId));
  for (const o of candidates) {
    if (keptIds.has(o.offerId)) verdicts.push({ offerId: o.offerId, variantId: o.variantId, verdict: "kept", reason: null });
    else verdicts.push({ offerId: o.offerId, variantId: o.variantId, verdict: "diverged", reason: o.classKey !== chosen[0]?.classKey ? "class_key" : "start_times" });
  }
  verdicts.sort((a, b) => a.offerId - b.offerId);
  const signature = chosen.length ? { classKey: chosen[0].classKey, startMinutes: sortedStarts(chosen[0].startMinutes) } : { classKey: link.classKey, startMinutes: sortedStarts(link.startMinutes) };
  return { verdicts, kept: [...keptIds].sort((a, b) => a - b), signature };
}

/* ---------------------------------------------------------------------------
 * The document
 * ------------------------------------------------------------------------ */

/** The editable input of a stored document (the derived fields dropped), as `activityService.update` takes it. */
export function inputOf(doc: Activity | Record<string, unknown>): ActivityInput {
  const { id: _id, rating: _r, reviewCount: _rc, bookedThisMonth: _b, productId: _p, noindex: _n, openDatedTicket: _o, currentlyUnavailable: _u, ...rest } = doc as Record<string, unknown>;
  return activityInputSchema.parse(rest);
}

const json = (v: unknown) => JSON.stringify(v ?? null);
const STARTS_AT = /^Starts at /;

/** Price handling for this run (D18). */
export type PriceMode = "apply" | "hold" | "keep";

export interface MergeInput {
  current: ActivityInput;
  /** The document the system last wrote (`supplier_listing_links.import_version`); null when that version is gone. */
  baseline: Record<string, unknown> | null;
  /** The fresh draft for the kept options (`buildListingDraft`), or null when none could be built this run. */
  draft: ActivityInput | null;
  lockedFields: readonly string[];
  /** The tour's supplier content changed since the listing was last refreshed. */
  textChanged: boolean;
  kept: ReadonlySet<string>;
  /** Variants this run marks sold out. */
  soldOut: ReadonlySet<string>;
  /** The tour's free-cancellation window now (hours; 0 none; null unknown). */
  supplierPolicyHours: number | null;
  priceMode: PriceMode;
  /** Newly copied photos, when the supplier's photo list changed. */
  images: string[] | null;
  /** False when the tour has no stored content row: the draft's text is then empty and must not replace anything (NR-06). */
  hasContent?: boolean;
  /** Per editorial field, the hash of the last supplier-derived value (`supplier_text_hashes`); empty before the first run. */
  prevTextHashes?: Readonly<Record<string, string>>;
}

export interface MergeResult {
  next: ActivityInput;
  locked: string[];
  /** Locked fields whose supplier text changed since the last run (shown as "supplier text changed"). */
  lockedTextChanged: string[];
  /** Per editorial field, the hash of this draft's supplier-derived value (stored for the next run); null without a draft. */
  textHashes: Record<string, string> | null;
}

const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex");

/** sha256 of a tour's supplier photo list (addresses only): the importer records it, the upkeep copies again when it moves. */
export function photosHashOf(photos: unknown): string {
  const list = Array.isArray(photos) ? photos : [];
  return sha(list.map((p) => (p && typeof p === "object" && "variants" in p ? (p as { variants: { url?: unknown }[] }).variants.map((v) => v.url) : p)));
}

/** Whether the draft's prices can be held at the page's current ones: every kept unit must have a price today. */
export function canHoldPrices(current: ActivityInput, draft: ActivityInput, kept: ReadonlySet<string>): boolean {
  for (const d of draft.variants) {
    if (!kept.has(d.id)) continue;
    const c = current.variants.find((v) => v.id === d.id);
    if (!c) return false;
    for (const u of d.units ?? []) if (!(c.units ?? []).some((x) => x.unitId === u.unitId)) return false;
  }
  if (draft.price.child && !current.price.child) return false;
  if (draft.price.infant && !current.price.infant) return false;
  return true;
}

/**
 * The largest price move, in basis points, over every kept option's units
 * in AED and INR (the page band and the deltas for options without units). A unit priced 0 today that would cost
 * something counts as unbounded. Units without a price today are not moves
 * (`canHoldPrices` handles them).
 */
export function priceMoveBps(current: ActivityInput, draft: ActivityInput, kept: ReadonlySet<string>): number {
  let worst = 0;
  const move = (before: number, after: number) => {
    if (before === after) return;
    const bps = before <= 0 ? Number.POSITIVE_INFINITY : Math.ceil((Math.abs(after - before) * 10_000) / before);
    if (bps > worst) worst = bps;
  };
  for (const d of draft.variants) {
    if (!kept.has(d.id)) continue;
    const c = current.variants.find((v) => v.id === d.id);
    if (!c) continue;
    const cUnits = c.units ?? [];
    if ((d.units ?? []).length) {
      for (const u of d.units ?? []) {
        const old = cUnits.find((x) => x.unitId === u.unitId);
        if (old) {
          move(old.price.aed, u.price.aed);
          // Review 108 N3-13: an FX setting change moves INR alone; it counts too.
          move(old.price.inr, u.price.inr);
        }
      }
    } else {
      // Inquiry listings carry no units: the option's shown "from" price is band + delta.
      move(current.price.adult.aed + c.delta.aed, draft.price.adult.aed + d.delta.aed);
      move(current.price.adult.inr + c.delta.inr, draft.price.adult.inr + d.delta.inr);
    }
  }
  return worst;
}

/** A policy text stating hours, rewritten to new hours; non-refundable when the supplier has none or the text names no hours. */
export function policyFor(text: string, hours: number, supplierHours: number | null): { text: string; hours: number } | null {
  if (hours <= 0 || supplierHours === null || supplierHours === hours) return null;
  if (supplierHours <= 0) return { text: NON_REFUNDABLE_POLICY, hours: 0 };
  // Review 108 N3-11: every stated "N hours" must be the old window and is rewritten; anything else is not ours to guess.
  // Review 108 NR-03: one pattern for the match and the rewrite, any case, "hour" or "hours".
  const HOURS = /\b(\d+)(\s*)(hours?)\b/gi;
  const stated = [...text.matchAll(HOURS)].map((m) => Number(m[1]));
  if (stated.length === 0 || stated.some((h) => h !== hours)) return { text: NON_REFUNDABLE_POLICY, hours: 0 };
  const unit = (word: string) => {
    const upper = word === word.toUpperCase();
    const stem = word.replace(/s$/i, "");
    return supplierHours === 1 ? stem : `${stem}${upper ? "S" : "s"}`;
  };
  return { text: text.replace(HOURS, (_m, _n: string, sp: string, word: string) => `${supplierHours}${sp}${unit(word)}`), hours: supplierHours };
}

/**
 * §3.7 "a price may be locked upward only" (review 108 N3-14): for every kept
 * option a person raised (`variant:<id>:price`), each unit costs the higher
 * of its current and its rule price. The band stays the draft's; the option's
 * delta is refitted so every unit still equals what the page shows. Null when
 * no delta fits (the child gap differs): the caller then holds the page's
 * prices, which lowers nothing.
 */
export function applyPriceLocks(current: ActivityInput, draft: ActivityInput, locked: ReadonlySet<string>, kept: ReadonlySet<string>): ActivityInput | null {
  const out = structuredClone(draft);
  for (const d of out.variants) {
    if (!kept.has(d.id) || !locked.has(variantPriceLock(d.id))) continue;
    const c = current.variants.find((v) => v.id === d.id);
    if (!c) continue;
    if (!(d.units ?? []).length) {
      for (const k of ["aed", "inr"] as const) {
        const target = Math.max(current.price.adult[k] + c.delta[k], draft.price.adult[k] + d.delta[k]);
        d.delta[k] = target - out.price.adult[k];
      }
      continue;
    }
    const target = (unitId: string, k: "aed" | "inr") => {
      const now = (c.units ?? []).find((u) => u.unitId === unitId)?.price[k];
      const rule = (d.units ?? []).find((u) => u.unitId === unitId)!.price[k];
      return now === undefined ? rule : Math.max(now, rule);
    };
    for (const k of ["aed", "inr"] as const) {
      const delta = target("adult", k) - out.price.adult[k];
      for (const u of d.units ?? []) {
        const want = target(u.unitId, k);
        const shown = u.unitId === "infant" ? (out.price.infant?.[k] ?? 0) : u.unitId === "child" ? (out.price.child ?? out.price.adult)[k] + delta : out.price.adult[k] + delta;
        if (want !== shown) return null;
        u.price[k] = want;
      }
      d.delta[k] = delta;
    }
  }
  // Review 108 NR-05: the "from" price is the lowest bookable option. Shift the band (adult and child alike, so every
  // unit stays band + delta) by the smallest delta of the options on sale.
  const onSale = out.variants.filter((v) => kept.has(v.id) && !v.soldOut);
  for (const k of ["aed", "inr"] as const) {
    if (!onSale.length) break;
    const shift = Math.min(...onSale.map((v) => v.delta[k]));
    if (shift === 0) continue;
    out.price.adult[k] += shift;
    if (out.price.child) out.price.child[k] += shift;
    for (const v of out.variants) v.delta[k] -= shift;
  }
  return out;
}

/** The next document: supplier text where unlocked, supplier facts always (see the module comment). */
export function mergeDocument(m: MergeInput): MergeResult {
  const locked = new Set(m.lockedFields);
  if (m.baseline) for (const f of personLocksBetween(m.baseline, m.current as unknown as Record<string, unknown>)) locked.add(f);
  const next = structuredClone(m.current) as ActivityInput;
  const nextRec = next as unknown as Record<string, unknown>;
  const cur = m.current as unknown as Record<string, unknown>;
  const lockedTextChanged: string[] = [];
  let textHashes: Record<string, string> | null = null;

  if (m.draft) {
    const d = m.draft as unknown as Record<string, unknown>;
    textHashes = {};
    for (const f of EDITORIAL_FIELDS) {
      if (f === "images") continue;
      textHashes[f] = sha(d[f]);
      // `importantInfo` carries the days line, built from the offers' days: a fact, so it follows them every run
      // (review 108 N3-17). Every other editorial field follows only a change of the supplier's content.
      if (!m.textChanged && !(f === "importantInfo" && m.hasContent !== false)) continue;
      if (locked.has(f)) {
        // Review 108 N3-10: reported only when the supplier's own value for this field moved.
        const prev = m.prevTextHashes?.[f];
        const moved = prev !== undefined ? prev !== textHashes[f] : json(d[f]) !== json(m.baseline ? m.baseline[f] : cur[f]);
        if (m.textChanged && moved) lockedTextChanged.push(f);
        continue;
      }
      if (d[f] === undefined) delete nextRec[f];
      else nextRec[f] = structuredClone(d[f]);
    }
  }
  if (m.images) {
    if (locked.has("images")) lockedTextChanged.push("images");
    else next.images = [...m.images];
  }

  if (m.draft && m.priceMode !== "keep") {
    const d = m.draft;
    next.timeSlots = [...d.timeSlots];
    next.durationMinutes = d.durationMinutes;
    next.isPrivate = d.isPrivate;
    if (m.priceMode === "apply") next.price = structuredClone(d.price);
  }
  // "Quote only" goes with the prices (review 108 N3-02): it follows the draft only when the draft's prices apply,
  // and never when a person switched it on (N3-03).
  if (m.draft && m.priceMode === "apply" && !locked.has(QUOTE_ONLY_LOCK)) {
    if (m.draft.quoteOnly) next.quoteOnly = true;
    else delete next.quoteOnly;
  }

  next.variants = m.current.variants.map((v) => {
    if (m.soldOut.has(v.id)) return { ...structuredClone(v), soldOut: true };
    const d = m.draft?.variants.find((x) => x.id === v.id);
    if (!d || !m.kept.has(v.id) || m.priceMode === "keep") return structuredClone(v);
    // Review 108 N3-01: the name lock is stored (`variant:<id>:name`), so it survives every rebase.
    const nameLocked = locked.has(variantNameLock(v.id));
    const highlights = [...d.highlights.filter((h) => STARTS_AT.test(h)), ...v.highlights.filter((h) => !STARTS_AT.test(h))].slice(0, 8);
    const out = { ...structuredClone(v), name: nameLocked ? v.name : d.name, highlights, isPrivate: d.isPrivate };
    if (m.priceMode === "apply") {
      out.delta = { ...d.delta };
      if (d.units) out.units = structuredClone(d.units);
      else delete out.units;
    } else if (d.units) {
      // Hold (D18): the draft's units (ages, quantities) at the page's current prices.
      out.units = d.units.map((u) => ({ ...structuredClone(u), price: { ...((v.units ?? []).find((x) => x.unitId === u.unitId)?.price ?? u.price) } }));
    }
    return out;
  });

  const policy = policyFor(m.current.cancellationPolicy, m.current.freeCancellationHours, m.supplierPolicyHours);
  if (policy) {
    next.cancellationPolicy = policy.text;
    next.freeCancellationHours = policy.hours;
  }
  return { next: activityInputSchema.parse(next), locked: [...locked].sort(), lockedTextChanged: [...new Set(lockedTextChanged)].sort(), textHashes };
}

/* ---------------------------------------------------------------------------
 * What changed, for the log, the digest and the audit
 * ------------------------------------------------------------------------ */

export type ChangeKind = "text" | "fact" | "price" | "photos";

const PRICE_FIELDS = new Set(["price", "quoteOnly"]);

/** Top-level document fields that differ, each with its log kind. */
export function changedFields(before: ActivityInput, after: ActivityInput): { field: string; kind: ChangeKind }[] {
  const b = before as unknown as Record<string, unknown>;
  const a = after as unknown as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
  const editorial = new Set<string>(EDITORIAL_FIELDS);
  return keys
    .filter((k) => json(b[k]) !== json(a[k]))
    .map((field) => ({ field, kind: field === "images" ? "photos" : editorial.has(field) ? "text" : PRICE_FIELDS.has(field) ? "price" : "fact" }));
}

/** Per option and unit, the AED and INR price the page shows (band + delta for options without units). Sell prices only. */
export function priceTable(doc: ActivityInput): Record<string, Record<string, { aed: number; inr: number }>> {
  const out: Record<string, Record<string, { aed: number; inr: number }>> = {};
  for (const v of doc.variants) {
    const row: Record<string, { aed: number; inr: number }> = {};
    if (v.units?.length) for (const u of v.units) row[u.unitId] = { aed: u.price.aed, inr: u.price.inr };
    else row.from = { aed: doc.price.adult.aed + v.delta.aed, inr: doc.price.adult.inr + v.delta.inr };
    out[v.id] = row;
  }
  return out;
}

/** A short form of a value for the change log (strings and lists capped). */
export function logValue(field: string, doc: ActivityInput): unknown {
  const v = (doc as unknown as Record<string, unknown>)[field];
  if (field === "variants") {
    return (doc.variants ?? []).map((x) => ({ id: x.id, name: x.name, soldOut: x.soldOut === true, isPrivate: x.isPrivate, units: (x.units ?? []).map((u) => `${u.unitId} ${u.ageMin ?? ""}-${u.ageMax ?? ""} max ${u.maxQty}`) }));
  }
  if (field === "price") return priceTable(doc);
  return capValue(v);
}

function capValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return v.length > 300 ? `${v.slice(0, 299)}…` : v;
  if (Array.isArray(v)) return v.slice(0, 12).map((x) => capValue(x, depth + 1));
  if (v && typeof v === "object") {
    if (depth > 3) return "…";
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 20).map(([k, x]) => [k, capValue(x, depth + 1)]));
  }
  return v ?? null;
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

type TermsSlot = OfferTerms["slots"][number];

/** Distinct slot lines kept in stored terms; above this the list is stored as a count and fingerprint. */
export const MAX_STORED_SLOT_LINES = 48;

/** One slot as a line: the facts a guest books by (no supplier slot id or label). */
function slotLine(s: TermsSlot): string {
  return `${hhmm(s.startMinutes)}${s.endMinutes !== null ? `-${hhmm(s.endMinutes)}` : ""}${s.isAnyTime ? " any time" : ""}${s.isOnRequest ? " on request" : ""} days ${s.daysOffered} advance ${s.minimumAdvancedBookingHours ?? "-"}h${s.isExternal ? " external" : ""}`;
}

/**
 * The slots of offer terms as sorted, distinct lines. TravelDesk repeats one
 * start under many slot ids (an offer with 209 slots has 19 distinct lines),
 * so the full objects made a listing's stored terms exceed the 64 KB row
 * check and the change log's 16 KB values. Takes stored lines or slot objects,
 * so terms stored before this change compare equal when nothing changed.
 * Above `MAX_STORED_SLOT_LINES` distinct lines, one line with the count and a
 * fingerprint stands for the list.
 */
export function slotLines(slots: readonly (TermsSlot | string)[]): string[] {
  const lines = [...new Set(slots.map((s) => (typeof s === "string" ? s : slotLine(s))))].sort();
  if (lines.length <= MAX_STORED_SLOT_LINES) return lines;
  return [`${lines.length} distinct slots, sha256 ${createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16)}`];
}

/** Offer terms as stored on a listing link (`approved_terms`): slots as `slotLines`. The terms hash is never computed from this form. */
export type StoredOfferTerms = Omit<OfferTerms, "slots"> & { slots: (TermsSlot | string)[] };

export function compactTerms(t: OfferTerms): StoredOfferTerms {
  return { ...t, slots: slotLines(t.slots) };
}

function termsFlat(t: OfferTerms | StoredOfferTerms): Record<string, unknown> {
  return {
    "booking.kind": t.booking.kind,
    "booking.typeRaw": t.booking.typeRaw,
    "booking.isExternal": t.booking.isExternal,
    "pax.min": t.pax.min,
    "pax.max": t.pax.max,
    "pax.limits": t.pax.limits,
    "pax.childrenAllowed": t.pax.childrenAllowed,
    "pax.childAge": t.pax.childAge,
    "pax.infantsAllowed": t.pax.infantsAllowed,
    "pax.infantAge": t.pax.infantAge,
    daysOffered: t.daysOffered,
    slots: slotLines(t.slots),
    "pickup.directReporting": t.pickup.directReporting,
    "pickup.directCollection": t.pickup.directCollection,
    policy: t.policy.map((p) => `${p.refundPercent}% more than ${p.moreThanHours}h`),
    "priceBasis.privateType": t.priceBasis.privateType,
    "priceBasis.tripUnit": t.priceBasis.tripUnit,
    "priceBasis.perPerson": t.priceBasis.perPerson,
    "priceBasis.perTrip": t.priceBasis.perTrip,
  };
}

/** Each changed offer term by name, old and new (D17). No earlier record: one "terms" line saying so. */
export function termsDiff(before: OfferTerms | StoredOfferTerms | null, after: OfferTerms | null): { field: string; before: unknown; after: unknown }[] {
  if (!after) return [{ field: "terms", before: before ? "recorded" : "not recorded", after: "unreadable" }];
  if (!before) return [{ field: "terms", before: "not recorded", after: "recorded now" }];
  const b = termsFlat(before);
  const a = termsFlat(after);
  return Object.keys(a)
    .filter((k) => json(a[k]) !== json(b[k]))
    .map((field) => ({ field, before: b[field] ?? null, after: a[field] }));
}

/* ---------------------------------------------------------------------------
 * Removed tours (D19)
 * ------------------------------------------------------------------------ */

export type UnavailabilityStep = "none" | "mark" | "hide" | "clear";

/**
 * What a run does about a listing whose tour (or every offer) may be gone.
 * `gone` reads `removed_at`, which only a sync run that passed the removal
 * guards writes (complete pass, at most 20% removals: `MAX_REMOVAL_SHARE`),
 * so an incomplete or implausible pull never starts the clock. A hidden
 * listing stays hidden: its return is listed for a person.
 */
export function unavailabilityStep(state: { unavailableSince: Date | null; hiddenAt: Date | null }, gone: boolean, now: Date): UnavailabilityStep {
  if (state.hiddenAt) return "none";
  if (!gone) return state.unavailableSince ? "clear" : "none";
  if (!state.unavailableSince) return "mark";
  return now.getTime() - state.unavailableSince.getTime() >= UNAVAILABLE_HIDE_AFTER_MS ? "hide" : "none";
}

/* ---------------------------------------------------------------------------
 * Digest lines
 * ------------------------------------------------------------------------ */

export interface DigestRow {
  slug: string;
  title: string;
  kind: string;
  field: string;
  status: string;
  offerExternalId: string | null;
}

const KIND_WORDS: Record<string, string> = {
  text: "text updated",
  fact: "fact updated",
  price: "price updated",
  photos: "photos updated",
  terms: "supplier terms accepted",
  offer_removed: "option removed by TravelDesk (sold out)",
  unavailable: "tour gone: shown as currently unavailable",
  available_again: "tour back: available again",
  hidden: "hidden after 14 days unavailable",
  price_jump: "price move above 20%: waits for a person",
  reprice_blocked: "could not be repriced: waits for a person",
  diverged: "option no longer matches its listing: sold out, waits for a person",
  never_instant: "option can no longer be instant: sold out, waits for a person",
  new_offer: "new TravelDesk offer on this tour: waits for a person",
  offer_revived: "removed option is back: waits for a person",
  returned_after_hidden: "hidden listing's tour is back: waits for a person",
  locked_text_changed: "supplier text changed beside a field your team edited",
};

/** One line per change for the owner's digest. Field names and codes only: no text bodies, no prices. */
export function digestLine(r: DigestRow): string {
  const words = KIND_WORDS[r.kind] ?? r.kind;
  const what = r.field ? ` (${r.field})` : r.offerExternalId ? ` (offer ${r.offerExternalId})` : "";
  return `${words}${what}`.replace(/\s+/g, " ").slice(0, 200);
}

/** Changes grouped per listing, in listing order, capped (the email says how many more). */
export function digestListings(rows: DigestRow[], maxListings = 100, maxLines = 12): { listings: { slug: string; title: string; lines: string[] }[]; more: number } {
  const by = new Map<string, { slug: string; title: string; lines: string[] }>();
  for (const r of rows) {
    const e = by.get(r.slug) ?? { slug: r.slug, title: r.title.replace(/\s+/g, " ").slice(0, 120), lines: [] };
    const line = digestLine(r);
    if (!e.lines.includes(line)) e.lines.push(line);
    by.set(r.slug, e);
  }
  const all = [...by.values()].sort((a, b) => a.slug.localeCompare(b.slug)).map((e) => ({ ...e, lines: e.lines.slice(0, maxLines) }));
  return { listings: all.slice(0, maxListings), more: Math.max(0, all.length - maxListings) };
}
