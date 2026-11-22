import "server-only";
import { Prisma } from "@prisma/client";
import { prisma, type Tx } from "../lib/db";
import { hmacCandidates, hmacFor, KeyUnavailableError, randomToken, sha256Hex } from "../lib/crypto";
import { emitEvent } from "../lib/structured-events";

/**
 * Personal-data erasure: the data access behind `privacyService.requestErasure`
 * (PRV-3, doc 22 §23 B4; impl/database.md §5 "anonymise, do not delete").
 *
 * The workflow (permission, obligation rules, audit, events, storage cleanup)
 * lives in `services/privacy.service.ts`. This file finds a person's rows,
 * reads the facts the obligation check needs, and rewrites the rows in the
 * caller's transaction. Every rewrite is listed below with its reason.
 *
 * Financial records survive (PRV-7: the periods are the owner's adviser's):
 * orders, order items, payments, refunds, remedies, ledgers and settlements
 * keep every money column; only their personal fields are pseudonymised with
 * a `[deleted-<token>]` marker where the column is NOT NULL, or cleared where
 * it is nullable. The token is random and is recorded only in the audit row.
 *
 * Not touched, because a trigger makes them append-only (init migration and
 * 20261031090000): `audit_logs`, `inquiry_events`, `consents`,
 * `supplier_booking_events`. Their retention is the adviser's decision
 * (PRV-2, PRV-7); new audit rows carry field names only (`auditFieldChanges`).
 */

type Db = Tx | typeof prisma;

/* ---------------------------------------------------------------------------
 * Hashed suppression (PRV-3)
 * ------------------------------------------------------------------------ */

export type ContactChannel = "phone" | "email";

const E164 = /^\+[1-9]\d{6,14}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** E.164 as stored everywhere, or null. */
export function normalisePhoneE164(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  return v && E164.test(v) ? v : null;
}

/** Trimmed lower case, as orders, inquiries and customers store it; null when it is not an address. */
export function normaliseEmail(raw: string | null | undefined): string | null {
  const v = raw?.trim().toLowerCase();
  return v && v.length <= 254 && EMAIL.test(v) ? v : null;
}

/** The value a suppression hash covers: the channel and the normalised contact. */
function lookupInput(channel: ContactChannel, normalised: string): string {
  return `${channel}:${normalised}`;
}

/** `hmacFor("lookup", …)` with the active key: what a new suppression row stores. */
export function suppressionHash(channel: ContactChannel, normalised: string): string {
  return hmacFor("lookup", lookupInput(channel, normalised));
}

/** The hash under every lookup key, active first, so a key rotation still matches older rows. */
export function suppressionCandidates(channel: ContactChannel, normalised: string): string[] {
  return hmacCandidates("lookup", lookupInput(channel, normalised));
}

/**
 * The lookup hashes for the contact, or null when the `lookup` ring is missing
 * (R-B4-3). Every inquiry submission checks suppression, and the live inquiry
 * funnel must keep working on a deployment that has not set the B4 rings yet:
 * the check falls back to the legacy plaintext list and an alert is raised.
 * Erasure never takes this path; it fails closed (`suppressContact`).
 */
function suppressionHashesOrNull(phone: string | null, email: string | null): string[] | null {
  try {
    return [...(phone ? suppressionCandidates("phone", phone) : []), ...(email ? suppressionCandidates("email", email) : [])];
  } catch (e) {
    if (!(e instanceof KeyUnavailableError)) throw e;
    emitEvent("keys.unavailable", { purpose: "lookup", path: "inquiry_suppression" }, "error");
    return null;
  }
}

/**
 * True when the phone or e-mail is suppressed: a row in the hashed
 * `suppressed_contacts` table under any lookup key, or (phone only) in the
 * legacy plaintext `suppressed_phones`, which is still read until its rows
 * are migrated. Without a `lookup` ring only the legacy list is checked.
 */
export async function isContactSuppressed(contact: { phoneE164?: string | null; email?: string | null }, db: Db = prisma): Promise<boolean> {
  const phone = normalisePhoneE164(contact.phoneE164);
  const email = normaliseEmail(contact.email);
  const hashes = phone || email ? (suppressionHashesOrNull(phone, email) ?? []) : [];
  const [legacy, hashed] = await Promise.all([
    phone ? db.suppressedPhone.findUnique({ where: { phoneE164: phone }, select: { phoneE164: true } }) : null,
    hashes.length ? db.suppressedContact.findFirst({ where: { contactHash: { in: hashes } }, select: { contactHash: true } }) : null,
  ]);
  return Boolean(legacy || hashed);
}

/** Adds the contact to the hashed list unless it is there under any key. Returns true when a row was written. */
export async function suppressContact(db: Db, channel: ContactChannel, normalised: string, reason: string): Promise<boolean> {
  const existing = await db.suppressedContact.findFirst({ where: { contactHash: { in: suppressionCandidates(channel, normalised) } }, select: { contactHash: true } });
  if (existing) return false;
  const r = await db.suppressedContact.createMany({ data: [{ contactHash: suppressionHash(channel, normalised), channel, reason }], skipDuplicates: true });
  return r.count === 1;
}

/**
 * Removes the phone's legacy plaintext row (R-B4-6). Erasure calls it after
 * the hashed entry is written, in the same transaction, so the number stays
 * suppressed without being stored in clear.
 */
export async function forgetLegacySuppression(db: Db, phoneE164: string): Promise<number> {
  return (await db.suppressedPhone.deleteMany({ where: { phoneE164 } })).count;
}

/** Removes the contact from both lists (legacy plaintext and hashed, under every key). */
export async function unsuppressContact(db: Db, channel: ContactChannel, normalised: string): Promise<number> {
  const hashed = await db.suppressedContact.deleteMany({ where: { contactHash: { in: suppressionCandidates(channel, normalised) } } });
  const legacy = channel === "phone" ? await db.suppressedPhone.deleteMany({ where: { phoneE164: normalised } }) : { count: 0 };
  return hashed.count + legacy.count;
}

/* ---------------------------------------------------------------------------
 * Finding the subject's rows
 * ------------------------------------------------------------------------ */

export interface ErasureSubject {
  phoneE164: string | null;
  email: string | null;
}

export interface SubjectRecords {
  customerIds: string[];
  orderIds: string[];
  inquiryIds: string[];
}

function uniq(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Customers by phone or e-mail; orders and inquiries by lead phone, lead
 * e-mail (any case) or a linked customer found here.
 */
export async function findSubjectRecords(db: Db, s: ErasureSubject): Promise<SubjectRecords> {
  const customerOr: Prisma.CustomerWhereInput[] = [];
  if (s.phoneE164) customerOr.push({ phoneE164: s.phoneE164 });
  if (s.email) customerOr.push({ email: { equals: s.email, mode: "insensitive" } });
  const customers = customerOr.length ? await db.customer.findMany({ where: { OR: customerOr }, select: { id: true } }) : [];
  const customerIds = customers.map((c) => c.id);

  const leadOr = <W>(phoneKey: string, emailKey: string): W[] => {
    const or: Record<string, unknown>[] = [];
    if (s.phoneE164) or.push({ [phoneKey]: s.phoneE164 });
    if (s.email) or.push({ [emailKey]: { equals: s.email, mode: "insensitive" } });
    if (customerIds.length) or.push({ customerId: { in: customerIds } });
    return or as W[];
  };
  const orderOr = leadOr<Prisma.OrderWhereInput>("leadPhone", "leadEmail");
  const inquiryOr = leadOr<Prisma.InquiryWhereInput>("leadPhone", "leadEmail");
  const [orders, inquiries] = await Promise.all([
    orderOr.length ? db.order.findMany({ where: { OR: orderOr }, select: { id: true } }) : [],
    inquiryOr.length ? db.inquiry.findMany({ where: { OR: inquiryOr }, select: { id: true } }) : [],
  ]);
  return { customerIds, orderIds: uniq(orders.map((o) => o.id)), inquiryIds: uniq(inquiries.map((i) => i.id)) };
}

/* ---------------------------------------------------------------------------
 * Obligation facts
 * ------------------------------------------------------------------------ */

/** Why an order keeps its personal data for now. Codes the requester can be told (see ERASURE_EXPLANATIONS in the service). */
export type ErasureObligation = "future_service" | "refund_pending" | "dispute_window" | "payment_open" | "supplier_booking_open";

export interface ObligationRules {
  /** The Dubai calendar date of "today", `YYYY-MM-DD`: service on this date or later is still owed. */
  todayDubai: string;
  /** Captured payments at or after this instant may still be disputed. */
  disputeWindowStart: Date;
  /** Closed payment sagas created at or after this instant still watch for late money. */
  lateMoneyStart: Date;
}

/** Order item statuses that owe no service. */
const ITEM_NO_SERVICE = ["cancelled", "rejected"] as const;
/** Order statuses that owe no service. */
const ORDER_NO_SERVICE = ["cancelled", "refunded", "payment_failed"] as const;
/**
 * Refund statuses that may still owe the customer money (`refunds.status`):
 * not final, or `failed` (R-B4-7). A failed refund is resolved by a later
 * refund on the same order item that succeeded, or by its remedy being
 * closed (`completed` or `cancelled`) by staff.
 */
const REFUND_OWED = ["requested", "accepted", "unknown", "failed"];
/** Remedy statuses still owed (`customer_remedies.status`): being carried out, or `failed` until staff close it. */
const REMEDY_OPEN = ["pending", "in_progress", "failed"];
/** Remedy statuses that close a failed refund. */
const REMEDY_CLOSED = ["completed", "cancelled"];
/** Saga states that are at rest; `attention` is not (a human is resolving money). */
const SAGA_AT_REST = ["fulfilled", "refunded", "released", "failed"];
/** Closed sagas that still watch for late money (saga.ts LATE_WATCH). */
const SAGA_LATE_WATCH = ["released", "failed"];
/** Supplier attempt states that are settled; the others (and any flagged attempt) are still open. */
const BOOKING_SETTLED = ["confirmed", "cancelled", "rejected", "expired", "not_created"] as const;

/** Obligations per order, for the orders that have any. */
export async function orderObligations(db: Db, orderIds: string[], rules: ObligationRules): Promise<Map<string, ErasureObligation[]>> {
  const out = new Map<string, Set<ErasureObligation>>();
  if (!orderIds.length) return new Map();
  const add = (orderId: string | null | undefined, code: ErasureObligation) => {
    if (!orderId) return;
    if (!out.has(orderId)) out.set(orderId, new Set());
    out.get(orderId)!.add(code);
  };
  const today = new Date(`${rules.todayDubai}T00:00:00Z`);
  const [items, owedRefunds, succeededRefunds, remedies, payments, sagas, bookings] = await Promise.all([
    db.orderItem.findMany({
      where: { orderId: { in: orderIds }, serviceDate: { gte: today }, status: { notIn: [...ITEM_NO_SERVICE] }, order: { status: { notIn: [...ORDER_NO_SERVICE] } } },
      select: { orderId: true },
    }),
    db.refund.findMany({
      where: { payment: { orderId: { in: orderIds } }, status: { in: REFUND_OWED } },
      select: { status: true, orderItemId: true, createdAt: true, payment: { select: { orderId: true } }, remedy: { select: { status: true } } },
    }),
    db.refund.findMany({ where: { payment: { orderId: { in: orderIds } }, status: "succeeded" }, select: { orderItemId: true, createdAt: true } }),
    db.customerRemedy.findMany({ where: { orderId: { in: orderIds }, status: { in: REMEDY_OPEN } }, select: { orderId: true } }),
    db.payment.findMany({ where: { orderId: { in: orderIds }, capturedAt: { gte: rules.disputeWindowStart } }, select: { orderId: true } }),
    db.paymentSaga.findMany({
      where: {
        orderId: { in: orderIds },
        OR: [{ state: { notIn: SAGA_AT_REST } }, { attentionRequiredAt: { not: null } }, { state: { in: SAGA_LATE_WATCH }, createdAt: { gte: rules.lateMoneyStart } }],
      },
      select: { orderId: true },
    }),
    db.supplierBooking.findMany({
      where: { orderId: { in: orderIds }, OR: [{ state: { notIn: [...BOOKING_SETTLED] } }, { attentionRequiredAt: { not: null } }] },
      select: { orderId: true },
    }),
  ]);
  for (const i of items) add(i.orderId, "future_service");
  const failedResolved = (r: (typeof owedRefunds)[number]) =>
    (r.remedy !== null && REMEDY_CLOSED.includes(r.remedy.status)) || succeededRefunds.some((s) => s.orderItemId === r.orderItemId && s.createdAt >= r.createdAt);
  for (const r of owedRefunds) if (r.status !== "failed" || !failedResolved(r)) add(r.payment.orderId, "refund_pending");
  for (const r of remedies) add(r.orderId, "refund_pending");
  for (const p of payments) add(p.orderId, "dispute_window");
  for (const s of sagas) add(s.orderId, "payment_open");
  for (const b of bookings) add(b.orderId, "supplier_booking_open");
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
}

/* ---------------------------------------------------------------------------
 * The rewrite
 * ------------------------------------------------------------------------ */

export interface ErasureCounts {
  customers: number;
  /** Accounts kept open because one of their orders is deferred (R-B4-2). */
  customersDeferred: number;
  customerSessions: number;
  otpChallenges: number;
  inquiries: number;
  orders: number;
  ordersDeferred: number;
  attribution: number;
  guests: number;
  verifications: number;
  supplierBookings: number;
  ticketCodes: number;
  documents: number;
  grants: number;
  notifications: number;
  notificationsCancelled: number;
  webhookEvents: number;
  waConversations: number;
}

export interface ErasurePlan {
  subject: ErasureSubject;
  records: SubjectRecords;
  /** Orders with an active obligation: fulfilment and refund data stay. */
  deferredOrderIds: string[];
  /** `[deleted-<token>]`. */
  marker: string;
  now: Date;
}

export interface ErasureWrite {
  counts: ErasureCounts;
  /** Private-storage objects of the erased documents, to delete after commit. */
  storageObjects: { documentId: string; storageKey: string }[];
  /** Field names rewritten per store, for the audit row (PRV-2). */
  fields: string[];
}

/** Supplier request keys that carry the guest's contact or free text (adapters other than TravelDesk put them in `request_payload`). */
const REQUEST_PII_KEYS = new Set(["leadName", "leadPhone", "leadEmail", "guestName", "fullName", "name", "phone", "email", "hotel", "specialRequests", "dietary", "remarks", "lead"]);

function scrubRequestPayload(value: unknown, marker: string): Prisma.InputJsonValue {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 6 || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, REQUEST_PII_KEYS.has(k) ? marker : walk(x, depth + 1)]));
  };
  return (walk(value, 0) ?? {}) as Prisma.InputJsonValue;
}

/**
 * A quote's stored lines with every pickup hotel name cleared (Batch 3 keeps
 * the accepted hotel's name in `quotes.lines[].pickup.hotelName`), or null
 * when no line carries one. The hotel id stays: the quote's readers parse it
 * as required, and the order item's copy of it is cleared on its own.
 */
export function clearPickupHotelNames(lines: unknown): Prisma.InputJsonValue | null {
  if (!Array.isArray(lines)) return null;
  let changed = false;
  const next = lines.map((l: unknown) => {
    if (!l || typeof l !== "object") return l;
    const pickup = (l as { pickup?: unknown }).pickup;
    if (!pickup || typeof pickup !== "object" || (pickup as { hotelName?: unknown }).hotelName == null) return l;
    changed = true;
    return { ...(l as Record<string, unknown>), pickup: { ...(pickup as Record<string, unknown>), hotelName: null } };
  });
  return changed ? (next as Prisma.InputJsonValue) : null;
}

/** A fresh, unlinkable stand-in for a stored contact hash (the verification row keeps its shape and its other columns). */
function unlinkableHash(): string {
  return sha256Hex(randomToken(32));
}

/**
 * Erase or pseudonymise every store for the subject, except what the
 * deferred orders need for fulfilment and refunds. Runs inside the caller's
 * transaction; never deletes a financial row.
 */
export async function eraseSubjectRows(tx: Tx, plan: ErasurePlan): Promise<ErasureWrite> {
  const { subject, records, marker, now } = plan;
  const deferred = new Set(plan.deferredOrderIds);
  const erasedOrderIds = records.orderIds.filter((id) => !deferred.has(id));
  const fields = new Set<string>();
  const note = (store: string, ...cols: string[]) => cols.forEach((c) => fields.add(`${store}.${c}`));
  const contacts = [subject.phoneE164, subject.email].filter((c): c is string => Boolean(c));

  // Customers linked to a deferred order keep their account (R-B4-2): the login phone, e-mail, name, sessions and
  // the order link stay, so they can still sign in, follow the order and download its tickets. A new sign-in after
  // closing would create a new customer that `linkByPhone` never links to an order already linked here. Only the
  // profile's dietary and hotel prefill is cleared: the deferred order keeps its own snapshot of both for fulfilment.
  const deferredCustomerIds =
    deferred.size && records.customerIds.length
      ? uniq(
          (await tx.order.findMany({ where: { id: { in: [...deferred] }, customerId: { in: records.customerIds } }, select: { customerId: true } }))
            .map((o) => o.customerId)
            .filter((id): id is string => id !== null),
        )
      : [];
  if (deferredCustomerIds.length) {
    await tx.customer.updateMany({ where: { id: { in: deferredCustomerIds } }, data: { dietary: null, hotel: null } });
    note("customers", "dietary", "hotel");
  }
  const closedCustomerIds = records.customerIds.filter((id) => !deferredCustomerIds.includes(id));

  // Other customers: the account closes (sessions revoked, row kept for foreign keys). Each row gets its own marker: phone_e164 is unique.
  let customers = 0;
  for (const id of closedCustomerIds) {
    await tx.customer.update({ where: { id }, data: { phoneE164: `[deleted-${randomToken(9)}]`, email: null, fullName: null, dietary: null, hotel: null, deletedAt: now } });
    customers += 1;
  }
  if (customers) note("customers", "phoneE164", "email", "fullName", "dietary", "hotel", "deletedAt");
  const sessions = closedCustomerIds.length
    ? await tx.customerSession.updateMany({ where: { customerId: { in: closedCustomerIds }, revokedAt: null }, data: { revokedAt: now } })
    : { count: 0 };
  if (closedCustomerIds.length) await tx.customerSession.updateMany({ where: { customerId: { in: closedCustomerIds } }, data: { ipHash: null, userAgent: null } });
  if (sessions.count) note("customer_sessions", "revokedAt", "ipHash", "userAgent");

  // OTP challenges: sign-in rows hold the phone; contact-verification rows hold `ocv:v1:<quote>:<channel>:<sha256(contact)>`;
  // order-recovery rows hold `rcv:v1:<order>:<channel>:<sha256(contact)>` (R-B5-4). An unkeyed hash of a phone is the
  // phone, so both are removed by the subject's contact hashes and, for recovery, by the subject's orders too.
  const otpOr: Prisma.OtpChallengeWhereInput[] = [];
  for (const prefix of ["ocv:v1:", "rcv:v1:"]) {
    if (subject.phoneE164) otpOr.push({ phoneE164: { startsWith: prefix, endsWith: `:phone:${sha256Hex(subject.phoneE164)}` } });
    if (subject.email) otpOr.push({ phoneE164: { startsWith: prefix, endsWith: `:email:${sha256Hex(subject.email)}` } });
  }
  if (subject.phoneE164) otpOr.push({ phoneE164: subject.phoneE164 });
  for (const orderId of records.orderIds) otpOr.push({ phoneE164: { startsWith: `rcv:v1:${orderId.toLowerCase()}:` } });
  const otp = otpOr.length ? await tx.otpChallenge.deleteMany({ where: { OR: otpOr } }) : { count: 0 };
  if (otp.count) note("otp_challenges", "deleted");

  // Inquiries: not needed to fulfil an order (the order holds its own snapshot).
  const inquiries = records.inquiryIds.length
    ? await tx.inquiry.updateMany({
        where: { id: { in: records.inquiryIds } },
        data: {
          leadName: marker,
          leadPhone: marker,
          leadEmail: null,
          hotel: null,
          pickupZone: null,
          dietary: null,
          specialRequests: null,
          lostReason: null,
          nextFollowupAt: null,
          // fbclid / fbc / fbp / gclid are device identifiers: gone with the person.
          attribution: Prisma.DbNull,
          userAgent: null,
          ipHash: null,
          sessionId: null,
          anonId: null,
        },
      })
    : { count: 0 };
  if (inquiries.count) note("inquiries", "leadName", "leadPhone", "leadEmail", "hotel", "pickupZone", "dietary", "specialRequests", "lostReason", "attribution", "userAgent", "ipHash", "sessionId", "anonId");

  // Orders without an obligation: personal fields only; money, items and status stay.
  const orders = erasedOrderIds.length
    ? await tx.order.updateMany({
        where: { id: { in: erasedOrderIds } },
        data: { leadName: marker, leadPhone: marker, leadEmail: null, hotel: null, pickupZone: null, dietary: null, specialRequests: null },
      })
    : { count: 0 };
  if (orders.count) note("orders", "leadName", "leadPhone", "leadEmail", "hotel", "pickupZone", "dietary", "specialRequests");
  // The pickup hotel on an item says where the person stays, like `orders.hotel` (Batch 3); money and status stay.
  const pickupItems = erasedOrderIds.length
    ? await tx.orderItem.updateMany({
        where: { orderId: { in: erasedOrderIds }, OR: [{ pickupHotelId: { not: null } }, { pickupHotelNameSnapshot: { not: null } }] },
        data: { pickupHotelId: null, pickupHotelNameSnapshot: null },
      })
    : { count: 0 };
  if (pickupItems.count) note("order_items", "pickupHotelId", "pickupHotelNameSnapshot");
  // Click identifiers are never needed to fulfil or refund: cleared on every order of the subject. Source, medium and campaign stay (aggregate reporting).
  const attribution = records.orderIds.length
    ? await tx.orderAttribution.updateMany({ where: { orderId: { in: records.orderIds } }, data: { fbclid: null, fbc: null, fbp: null, gclid: null } })
    : { count: 0 };
  if (attribution.count) note("order_attribution", "fbclid", "fbc", "fbp", "gclid");

  // Guests: by phone, or linked to a subject order; a guest of a deferred order stays.
  const guestRows = await tx.guest.findMany({
    where: { OR: [...(subject.phoneE164 ? [{ phoneE164: subject.phoneE164 }] : []), { orders: { some: { id: { in: records.orderIds } } } }] },
    select: { id: true, orders: { select: { id: true } } },
  });
  const guestIds = guestRows.filter((g) => !g.orders.some((o) => deferred.has(o.id))).map((g) => g.id);
  const guests = guestIds.length ? await tx.guest.updateMany({ where: { id: { in: guestIds } }, data: { fullName: marker, phoneE164: marker, email: null } }) : { count: 0 };
  if (guests.count) note("guests", "fullName", "phoneE164", "email");

  // Order contact verifications: the contact's SHA-256 is replaced by an unlinkable value; the fact, method and time of verification stay.
  const ocvOr: Prisma.OrderContactVerificationWhereInput[] = [];
  if (erasedOrderIds.length) ocvOr.push({ orderId: { in: erasedOrderIds } });
  const ocvHashes = contacts.map((c) => sha256Hex(c));
  if (ocvHashes.length) ocvOr.push({ orderId: null, contactHash: { in: ocvHashes } });
  const ocvRows = ocvOr.length ? await tx.orderContactVerification.findMany({ where: { OR: ocvOr }, select: { id: true, quoteId: true, orderId: true } }) : [];
  for (const v of ocvRows) await tx.orderContactVerification.update({ where: { id: v.id }, data: { contactHash: unlinkableHash() } });
  if (ocvRows.length) note("order_contact_verifications", "contactHash");

  // Quotes keep their own copy of the accepted pickup hotel's name (Batch 3), which says where the person stays,
  // like `order_items.pickup_hotel_name_snapshot`. Cleared on the quote of every erased order, and on the subject's
  // quotes no order used (a closed customer's, or one bound to the subject's verified contact). A quote used by a
  // deferred order keeps it, like the order.
  const quoteOr: Prisma.QuoteWhereInput[] = [];
  if (erasedOrderIds.length) quoteOr.push({ usedByOrderId: { in: erasedOrderIds } });
  if (closedCustomerIds.length) quoteOr.push({ usedByOrderId: null, customerId: { in: closedCustomerIds } });
  const looseQuoteIds = uniq(ocvRows.filter((v) => v.orderId === null).map((v) => v.quoteId));
  if (looseQuoteIds.length) quoteOr.push({ usedByOrderId: null, id: { in: looseQuoteIds } });
  const quoteRows = quoteOr.length ? await tx.quote.findMany({ where: { OR: quoteOr }, select: { id: true, lines: true } }) : [];
  let quotesScrubbed = 0;
  for (const q of quoteRows) {
    const lines = clearPickupHotelNames(q.lines);
    if (!lines) continue;
    await tx.quote.update({ where: { id: q.id }, data: { lines } });
    quotesScrubbed += 1;
  }
  if (quotesScrubbed) note("quotes", "lines.pickup.hotelName");

  // Supplier attempts of erased orders: the guest name, and any contact an adapter put in the request.
  // Personal columns only, never `state` (SUP-20), and only on settled, unflagged attempts: an open one is an
  // obligation and its order is deferred, so this filter only restates that.
  const bookings = erasedOrderIds.length
    ? await tx.supplierBooking.findMany({ where: { orderId: { in: erasedOrderIds }, state: { in: [...BOOKING_SETTLED] }, attentionRequiredAt: null }, select: { id: true, requestPayload: true } })
    : [];
  // `request_hash` covers the guest name; a settled attempt is never re-sent, so it is cleared (null is its pre-B1 value).
  for (const b of bookings) await tx.supplierBooking.update({ where: { id: b.id }, data: { guestName: marker, requestPayload: scrubRequestPayload(b.requestPayload, marker), requestHash: null } });
  if (bookings.length) note("supplier_bookings", "guestName", "requestPayload", "requestHash");
  const bookingIds = bookings.map((b) => b.id);

  // Tickets of erased orders: codes deleted (the B4 trigger allows deletion for erasure), documents never served again.
  const ticketCodes = bookingIds.length ? await tx.supplierTicketCode.deleteMany({ where: { supplierBookingId: { in: bookingIds } } }) : { count: 0 };
  if (ticketCodes.count) note("supplier_ticket_codes", "deleted");
  const docWhere: Prisma.SupplierDocumentWhereInput = { OR: [{ supplierBookingId: { in: bookingIds } }, { orderId: { in: erasedOrderIds } }] };
  const docs = erasedOrderIds.length ? await tx.supplierDocument.findMany({ where: docWhere, select: { id: true, storageKey: true } }) : [];
  if (docs.length) {
    const ids = docs.map((d) => d.id);
    await tx.supplierDocument.updateMany({
      where: { id: { in: ids }, status: { in: ["pending", "valid", "incomplete", "failed"] } },
      data: { status: "superseded", invalidatedAt: now, quarantineReason: "erased" },
    });
    await tx.supplierDocument.updateMany({ where: { id: { in: ids } }, data: { customerVisible: false, nextFetchAt: null, lockedUntil: null, attentionRequiredAt: null } });
    note("supplier_documents", "status", "customerVisible", "storageKey");
  }
  const storageObjects = docs.filter((d): d is { id: string; storageKey: string } => Boolean(d.storageKey)).map((d) => ({ documentId: d.id, storageKey: d.storageKey }));

  // Guest capability grants of erased orders: revoked (reason `erasure`, allowed by the B4 check); no token material is kept.
  const grants = erasedOrderIds.length
    ? await tx.guestCapabilityGrant.updateMany({ where: { orderId: { in: erasedOrderIds }, revokedAt: null }, data: { revokedAt: now, revokeReason: "erasure", tokenCiphertext: null } })
    : { count: 0 };
  if (erasedOrderIds.length) await tx.guestCapabilityGrant.updateMany({ where: { orderId: { in: erasedOrderIds }, tokenCiphertext: { not: null } }, data: { tokenCiphertext: null } });
  if (grants.count) note("guest_capability_grants", "revokedAt", "revokeReason", "tokenCiphertext");

  // Notifications: `payload` holds the whole template context (name, phone, e-mail, hotel, dietary, requests).
  // Rows bound to a deferred order stay as they are, so its tickets and status messages can still be sent and resent.
  const notifOr: Prisma.NotificationWhereInput[] = [];
  if (contacts.length) notifOr.push({ recipient: { in: contacts, mode: "insensitive" } });
  if (records.orderIds.length) notifOr.push({ orderId: { in: records.orderIds } });
  if (records.inquiryIds.length) notifOr.push({ inquiryId: { in: records.inquiryIds } });
  for (const customerId of records.customerIds) notifOr.push({ payload: { path: ["customerId"], equals: customerId } });
  if (subject.phoneE164) notifOr.push({ payload: { path: ["leadPhone"], equals: subject.phoneE164 } });
  if (subject.email) notifOr.push({ payload: { path: ["leadEmail"], equals: subject.email } });
  const notifWhere: Prisma.NotificationWhereInput = {
    AND: [{ OR: notifOr }, ...(deferred.size ? [{ OR: [{ orderId: null }, { orderId: { notIn: [...deferred] } }] }] : [])],
  };
  const notifRows = notifOr.length ? await tx.notification.findMany({ where: notifWhere, select: { id: true, recipient: true, status: true } }) : [];
  let notificationsCancelled = 0;
  const lowered = new Set(contacts.map((c) => c.toLowerCase()));
  for (const n of notifRows) {
    const queued = n.status === "queued";
    if (queued) notificationsCancelled += 1;
    await tx.notification.update({
      where: { id: n.id },
      data: {
        payload: Prisma.DbNull,
        providerError: null,
        // Staff recipients (an ops alert about this person) stay; the person's own address does not.
        ...(lowered.has(n.recipient.toLowerCase()) ? { recipient: marker } : {}),
        ...(queued ? { status: "suppressed", suppressedReason: "deletion_request", lockedUntil: null } : {}),
      },
    });
  }
  if (notifRows.length) note("notifications", "payload", "providerError", "recipient", "status");

  // WhatsApp conversations and inbound webhook bodies for the number.
  let waConversations = 0;
  let webhookEvents = 0;
  if (subject.phoneE164) {
    const wa = await tx.waConversation.updateMany({ where: { phoneE164: subject.phoneE164 }, data: { phoneE164: marker, entryContext: Prisma.DbNull, attribution: Prisma.DbNull } });
    waConversations = wa.count;
    if (wa.count) note("wa_conversations", "phoneE164", "entryContext", "attribution");
    // Meta sends the number as digits: `from` on a message, `recipient_id` on a status, `wa_id` in an envelope's contacts.
    const digits = subject.phoneE164.replace(/\D/g, "");
    webhookEvents = await tx.$executeRaw`
      UPDATE "webhook_events"
      SET "payload" = '{"erased": true}'::jsonb, "processing_error" = NULL
      WHERE "provider" = 'whatsapp'
        AND jsonb_path_exists("payload", '$.** ? (@.from == $d || @.recipient_id == $d || @.wa_id == $d || @.from == $p || @.recipient_id == $p)', jsonb_build_object('d', ${digits}::text, 'p', ${subject.phoneE164}::text))`;
    if (webhookEvents) note("webhook_events", "payload", "processingError");
  }

  return {
    counts: {
      customers,
      customersDeferred: deferredCustomerIds.length,
      customerSessions: sessions.count,
      otpChallenges: otp.count,
      inquiries: inquiries.count,
      orders: orders.count,
      ordersDeferred: deferred.size,
      attribution: attribution.count,
      guests: guests.count,
      verifications: ocvRows.length,
      supplierBookings: bookings.length,
      ticketCodes: ticketCodes.count,
      documents: docs.length,
      grants: grants.count,
      notifications: notifRows.length,
      notificationsCancelled,
      webhookEvents,
      waConversations,
    },
    storageObjects,
    fields: [...fields].sort(),
  };
}

/** After the object is gone from private storage, the document row forgets its key. */
export async function forgetStorageKey(documentId: string, storageKey: string, db: Db = prisma): Promise<void> {
  await db.supplierDocument.updateMany({ where: { id: documentId, storageKey }, data: { storageKey: null } });
}

/* ---------------------------------------------------------------------------
 * Legacy entry point
 * ------------------------------------------------------------------------ */

export interface AnonymiseResult {
  token: string;
  inquiries: number;
  orders: number;
  guests: number;
  notificationsCancelled: number;
  suppressed: boolean;
}

/**
 * The B0 ops step, kept callable: it now runs the full erasure workflow
 * (`privacyService.eraseContact`), so obligations defer what they must, every
 * store is covered and suppression is hashed. No permission check here, as
 * before: callers are ops tooling acting for a named staff member.
 */
export async function anonymiseByPhone(phoneE164: string, actorId: string): Promise<AnonymiseResult> {
  // Imported at call time: the service imports this repository.
  const { privacyService } = await import("../services/privacy.service");
  const r = await privacyService.eraseContact(
    { type: "admin", id: actorId, roles: [], permissions: new Set() },
    { phoneE164, email: null },
    new Date(),
  );
  return {
    token: r.token,
    inquiries: r.counts.inquiries,
    orders: r.counts.orders,
    guests: r.counts.guests,
    notificationsCancelled: r.counts.notificationsCancelled,
    suppressed: r.suppressed.phone,
  };
}
