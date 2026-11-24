import { describe, expect, it, vi } from "vitest";
import type { CustomerOrderState } from "@/lib/customer-status";
import type { CancellationFacts } from "../cancellation.service";

/**
 * The customer status projection, driven with synthetic snapshots (doc 22
 * §23 B5; PRD-17, TKT-8). Pure: the database module throws if touched. The
 * loaders and the route run against the disposable database in
 * src/server/__tests__/b5/customer-status.test.ts.
 */

vi.mock("../../lib/db", () => ({
  prisma: new Proxy({}, { get: () => { throw new Error("no database in this suite"); } }),
  TX_OPTIONS: {},
}));

const { projectCustomerStatus, paxLabel } = await import("../order-status.service");
type Snapshot = import("../order-status.service").StatusSnapshot;
type Item = import("../order-status.service").StatusItemSnapshot;

const NOW = new Date("2030-01-10T08:00:00.000Z");
const ITEM = "01890000-0000-7000-8000-0000000000a1";
const DOC = "01890000-0000-7000-8000-0000000000d1";
const T0 = new Date("2030-01-10T07:00:00.000Z");
const DEADLINE = new Date("2030-01-10T08:20:00.000Z");

function facts(over: Partial<CancellationFacts> = {}): CancellationFacts {
  return {
    orderItemId: ITEM,
    rail: "self_serve",
    fulfilmentOrigin: "instant_checkout",
    serviceDate: "2030-01-15",
    startMinutes: 600,
    booking: { id: "01890000-0000-7000-8000-0000000000b1", state: "confirmed" },
    policy: { freeCancellationUntilUtc: "2030-01-14T06:00:00.000Z", nonRefundableAfterConfirm: false },
    issuesTicketsAtConfirm: "no",
    ticketsStored: false,
    currency: "AED",
    payableMinor: 45_000n,
    payment: { id: "01890000-0000-7000-8000-0000000000c1", captured: true, verified: true, refundableMinor: 45_000n, frozen: false },
    orderPaid: true,
    ...over,
  };
}

function item(over: Partial<Item> = {}): Item {
  return {
    id: ITEM,
    title: "Desert safari (synthetic)",
    serviceDate: "2030-01-15",
    timeslot: null,
    pax: { adult: 2, child: 1 },
    status: "pending",
    booking: null,
    tickets: { fulfilment: "not_applicable", documents: [] },
    refunds: [],
    remedies: [],
    request: null,
    cancellation: facts(),
    ...over,
  };
}

function snap(sagaState: string, over: { item?: Partial<Item>; snapshot?: Partial<Snapshot>; captured?: boolean; attention?: boolean } = {}): Snapshot {
  return {
    order: { reference: "OUT-10000017", status: "pending_payment", rail: "self_serve", currency: "AED", totalMinor: 45_000n, placedAt: T0, updatedAt: T0, paidAt: null },
    saga: { orderItemId: ITEM, state: sagaState, deadlineAt: DEADLINE, attentionRequiredAt: over.attention ? T0 : null, updatedAt: T0 },
    payment: { status: over.captured ? "captured" : "authorized", capturedMinor: over.captured ? 45_000n : 0n, refundedMinor: 0n, authorizedAt: T0, capturedAt: over.captured ? T0 : null },
    items: [item(over.item)],
    canDownload: true,
    ...over.snapshot,
  };
}

const confirmedBooking = { state: "confirmed", startMinutes: 600, confirmedAt: T0, cancelledAt: null, updatedAt: T0 };
const validDoc = { id: DOC, kind: "tickets_pdf" as const, version: 1, status: "valid" as const, contentType: "application/pdf", byteSize: 2048, createdAt: T0.toISOString() };

/** Keys that must never appear anywhere in a customer projection. */
const FORBIDDEN = /^(net.*|.*NetMinor|margin.*|supplierBookingId|supplierId|supplierName|storageKey|sha256|code|ticketCode.*|gateway.*|providerPaymentId|providerRefundId|orderId|errorCode|reasonCode|leadPhone|leadEmail)$/i;

function forbiddenKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [...(FORBIDDEN.test(k) ? [`${path}.${k}`] : []), ...forbiddenKeys(v, `${path}.${k}`)]);
  }
  return [];
}

describe("projectCustomerStatus: one honest state per saga state", () => {
  const cases: Array<[string, Parameters<typeof snap>[1], CustomerOrderState]> = [
    ["session_created", {}, "awaiting_payment"],
    ["authorized", {}, "payment_processing"],
    ["captured", { captured: true }, "payment_processing"],
    ["capture_unknown", {}, "payment_processing"],
    ["reserve_pending", {}, "booking_processing"],
    ["reserved", {}, "booking_processing"],
    ["confirm_pending", { captured: true }, "booking_processing"],
    ["fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "issued", documents: [validDoc] } } }, "confirmed"],
    ["fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "ticket_pending", documents: [] } } }, "confirmed_ticket_pending"],
    ["fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "attention", documents: [] } } }, "needs_attention"],
    ["release_pending", {}, "payment_released"],
    ["release_pending", { captured: true }, "refund_processing"],
    ["released", {}, "payment_released"],
    ["refund_pending", { captured: true }, "refund_processing"],
    ["refunded", { captured: true }, "refunded"],
    ["failed", {}, "payment_failed"],
    ["attention", { captured: true }, "needs_attention"],
  ];

  for (const [state, over, expected] of cases) {
    it(`${state}${over?.captured ? " (captured)" : ""}${over?.item?.tickets ? ` with tickets ${over.item.tickets.fulfilment}` : ""} → ${expected}`, () => {
      const out = projectCustomerStatus(snap(state, over), NOW);
      expect(out.state).toBe(expected);
      expect(out.items[0].state).toBe(expected);
      expect(out.headline.length).toBeGreaterThan(10);
      expect(out.nextStep.length).toBeGreaterThan(10);
      expect(forbiddenKeys(out)).toEqual([]);
    });
  }

  it("an unknown capture is processing, with the remedy time and kind in the data (TKT-8), never a success", () => {
    const out = projectCustomerStatus(snap("capture_unknown"), NOW);
    expect(out.tone).toBe("progress");
    expect(out.deadlines).toMatchObject({ remedyAtUtc: DEADLINE.toISOString(), remedyKind: "refund" });
    expect(out.steps.payment).toMatchObject({ status: "in_progress" });
    expect(out.nextStep).toContain("Dubai time");
    // Batch 1: "don't pay again" (CO-04), and one remedy sentence true for a release and a refund (CO-05).
    expect(out.nextStep).toMatch(/Don't pay again/);
    expect(out.nextStep).toMatch(/full amount back automatically/);
    expect(out.pollAfterMs).toBeGreaterThan(0);
  });

  it("an uncaptured hold's remedy is a release; once captured it is a refund", () => {
    expect(projectCustomerStatus(snap("reserved"), NOW).deadlines).toMatchObject({ remedyKind: "release", remedyAtUtc: DEADLINE.toISOString() });
    expect(projectCustomerStatus(snap("confirm_pending", { captured: true }), NOW).deadlines).toMatchObject({ remedyKind: "refund" });
    // No remedy before payment, after fulfilment, or once a remedy is already running.
    for (const s of ["session_created", "fulfilled", "release_pending", "refunded", "attention"]) {
      expect(projectCustomerStatus(snap(s, { captured: true, item: { booking: confirmedBooking } }), NOW).deadlines).toMatchObject({ remedyAtUtc: null, remedyKind: null });
    }
  });

  it("attention is needs_attention with a plain next step and no refresh", () => {
    const out = projectCustomerStatus(snap("attention", { captured: true }), NOW);
    expect(out).toMatchObject({ state: "needs_attention", tone: "warning", pollAfterMs: null });
    expect(out.nextStep).toMatch(/Nothing is lost/);
  });

  it("a live saga a human was told about stays processing, and says the team is checking", () => {
    const out = projectCustomerStatus(snap("confirm_pending", { captured: true, attention: true }), NOW);
    expect(out.state).toBe("booking_processing");
    expect(out.nextStep).toContain("Our team is also checking it.");
  });

  it("refund delay: an open refund is processing; a failed one is shown as delayed, never refunded", () => {
    const open = projectCustomerStatus(snap("refund_pending", { captured: true, item: { refunds: [{ status: "unknown", createdAt: T0, updatedAt: T0 }] } }), NOW);
    expect(open.steps.refund).toMatchObject({ status: "in_progress", label: "Refund in progress" });
    expect(open.pollAfterMs).toBe(60_000);
    const failed = projectCustomerStatus(snap("attention", { captured: true, item: { refunds: [{ status: "failed", createdAt: T0, updatedAt: T0 }] } }), NOW);
    expect(failed.state).toBe("needs_attention");
    expect(failed.steps.refund).toMatchObject({ status: "failed" });
    const done = projectCustomerStatus(snap("refunded", { captured: true, item: { refunds: [{ status: "succeeded", createdAt: T0, updatedAt: T0 }] } }), NOW);
    expect(done.steps.refund).toMatchObject({ status: "done", label: "Refunded" });
    expect(done.pollAfterMs).toBeNull();
  });

  it("a released hold says nothing was charged; while releasing it keeps polling", () => {
    const releasing = projectCustomerStatus(snap("release_pending", { item: { remedies: [{ kind: "release_authorization", status: "in_progress", refunded: false, updatedAt: T0 }] } }), NOW);
    expect(releasing).toMatchObject({ state: "payment_released", tone: "progress", pollAfterMs: 30_000 });
    expect(releasing.steps.refund).toMatchObject({ status: "in_progress" });
    const released = projectCustomerStatus(snap("released", { item: { remedies: [{ kind: "release_authorization", status: "completed", refunded: false, updatedAt: T0 }] } }), NOW);
    expect(released).toMatchObject({ state: "payment_released", pollAfterMs: null });
    expect(released.headline).toContain("Nothing was charged");
    expect(released.steps.refund).toMatchObject({ status: "done" });
  });

  it("missing ticket: confirmed with tickets pending polls; documents appear only once valid and downloadable", () => {
    const pending = projectCustomerStatus(snap("fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "ticket_pending", documents: [{ ...validDoc, status: "pending" }] } } }), NOW);
    expect(pending.items[0].tickets).toEqual({ fulfilment: "ticket_pending", documents: [] });
    // Batch 4 (CO-40): the voucher usually lands seconds after the confirm, so 5 s, not 15 s.
    expect(pending.pollAfterMs).toBe(5_000);
    const ready = projectCustomerStatus(snap("fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "issued", documents: [validDoc] } } }), NOW);
    expect(ready.items[0].tickets.documents).toEqual([{ id: DOC, kind: "tickets_pdf", version: 1, contentType: "application/pdf", byteSize: 2048, href: `/api/tickets/documents/${DOC}` }]);
    expect(ready.steps.tickets).toMatchObject({ status: "done", label: "Voucher ready" });
    expect(ready.pollAfterMs).toBeNull();
    // A caller who may only view (a guest session, a view_status grant) sees the state but no links.
    const viewOnly = projectCustomerStatus({ ...snap("fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "issued", documents: [validDoc] } } }), canDownload: false }, NOW);
    expect(viewOnly.items[0].tickets).toEqual({ fulfilment: "issued", documents: [] });
    // R-B5-10: "emailed" only once the ticket email for the item is recorded as sent.
    expect(viewOnly.nextStep).not.toMatch(/emailed/);
    const emailed = projectCustomerStatus({ ...snap("fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "issued", documents: [validDoc] }, ticketsEmailed: true } }), canDownload: false }, NOW);
    expect(emailed.nextStep).toMatch(/We've also emailed you a link to it/);
    // No tickets apply: never a sentence about tickets below or in an email.
    const none = projectCustomerStatus(snap("fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "not_applicable", documents: [] } } }), NOW);
    expect(none.nextStep).not.toMatch(/tickets/i);
  });

  it("after the service day the order is completed", () => {
    const after = new Date("2030-01-16T00:00:00.000Z");
    expect(projectCustomerStatus(snap("fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "issued", documents: [validDoc] } } }), after).state).toBe("completed");
  });

  it("the refund deadline comes from the stored policy; the eligible offer carries the payable amount", () => {
    const out = projectCustomerStatus(snap("fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "issued", documents: [validDoc] } } }), NOW);
    expect(out.items[0].refundUntilUtc).toBe("2030-01-14T06:00:00.000Z");
    expect(out.deadlines.refundUntilUtc).toBe("2030-01-14T06:00:00.000Z");
    expect(out.items[0].cancellation).toEqual({ kind: "eligible", refundMinor: "45000", currency: "AED", untilUtc: "2030-01-14T06:00:00.000Z" });
    // Past the deadline it is no longer offered and the order-level deadline is gone.
    const late = new Date("2030-01-14T07:00:00.000Z");
    const lateOut = projectCustomerStatus(snap("fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "issued", documents: [validDoc] } } }), late);
    expect(lateOut.items[0].cancellation).toEqual({ kind: "not_eligible", reason: "past_deadline", exceptionAllowed: true });
    expect(lateOut.deadlines.refundUntilUtc).toBeNull();
  });

  it("cancellation requests: processing while the operator works, refund after, cancelled at the end", () => {
    const at = { createdAt: T0, updatedAt: T0 };
    const base = { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "issued" as const, documents: [validDoc] } } };
    const withReq = (status: Item["request"] extends infer R ? (R extends { status: infer S } ? S : never) : never, kind: "supported" | "exception" = "supported") =>
      projectCustomerStatus(snap("fulfilled", { ...base, item: { ...base.item, request: { kind, status, ...at } } }), NOW);
    expect(withReq("cancelling").state).toBe("cancellation_processing");
    expect(withReq("cancel_unverified").state).toBe("cancellation_processing");
    expect(withReq("refund_pending").state).toBe("refund_processing");
    expect(withReq("refunded").state).toBe("cancelled");
    expect(withReq("refund_failed").state).toBe("needs_attention");
    // A refusal (F51) leaves the booking confirmed; the request shows it.
    const refused = withReq("refused");
    expect(refused.state).toBe("confirmed");
    expect(refused.items[0].cancellation).toMatchObject({ kind: "requested", status: "refused", requestKind: "supported" });
    // An exception request promises nothing: the booking keeps its state.
    const exception = withReq("exception_open", "exception");
    expect(exception.state).toBe("confirmed");
    expect(exception.items[0].cancellation).toMatchObject({ kind: "requested", status: "exception_open", requestKind: "exception" });
  });

  it("a historic assisted order recorded as paid is paid_confirmed_by_team, with no saga and no self-serve cancel", () => {
    const s: Snapshot = {
      order: { reference: "OUT-10000017", status: "paid", rail: "assisted", currency: "INR", totalMinor: 777_700n, placedAt: T0, updatedAt: T0, paidAt: T0 },
      saga: null,
      payment: { status: "captured", capturedMinor: 777_700n, refundedMinor: 0n, authorizedAt: null, capturedAt: T0 },
      items: [item({ cancellation: facts({ rail: "assisted", fulfilmentOrigin: "assisted_conversion", booking: null, payment: null }) })],
      canDownload: true,
    };
    const out = projectCustomerStatus(s, NOW);
    expect(out).toMatchObject({ state: "paid_confirmed_by_team", rail: "assisted", tone: "success", pollAfterMs: null, totalMinor: "777700" });
    expect(out.steps.payment).toMatchObject({ status: "done" });
    expect(out.items[0].cancellation).toEqual({ kind: "not_eligible", reason: "not_supported", exceptionAllowed: true });
    expect(projectCustomerStatus({ ...s, order: { ...s.order, status: "cancelled" } }, NOW).state).toBe("cancelled");
    expect(projectCustomerStatus({ ...s, order: { ...s.order, status: "pending_payment" } }, NOW).state).toBe("awaiting_payment");
  });

  it("several items with mixed outcomes are partially_fulfilled", () => {
    const s: Snapshot = {
      order: { reference: "OUT-10000017", status: "partially_confirmed", rail: "assisted", currency: "INR", totalMinor: 1n, placedAt: T0, updatedAt: T0, paidAt: T0 },
      saga: null,
      payment: null,
      items: [item(), item({ id: "01890000-0000-7000-8000-0000000000a2", request: { kind: "supported", status: "refunded", createdAt: T0, updatedAt: T0 } })],
      canDownload: true,
    };
    expect(projectCustomerStatus(s, NOW).state).toBe("partially_fulfilled");
  });

  it("the projection names no forbidden key, carries no order id and is plain JSON", () => {
    const s = snap("fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "issued", documents: [{ ...validDoc, ...({ storageKey: "prod/0123", sha256: "ab" } as object) }] } } });
    const out = projectCustomerStatus(s, NOW);
    expect(forbiddenKeys(out)).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/storageKey|sha256|prod\/0123/);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});

describe("projectCustomerStatus: multi-item instant orders (lead design, 3 November 2026)", () => {
  const ITEM2 = "01890000-0000-7000-8000-0000000000a2";
  const ITEM3 = "01890000-0000-7000-8000-0000000000a3";
  const pendingBooking = { ...confirmedBooking, state: "awaiting_payment", confirmedAt: null };
  const rejected = { ...confirmedBooking, state: "rejected", confirmedAt: null };

  function multi(sagaState: string, items: Array<Partial<Item>>, captured = true): Snapshot {
    const ids = [ITEM, ITEM2, ITEM3];
    return {
      ...snap(sagaState, { captured }),
      // As the loader sets it: a multi-item order is settling until its saga is fulfilled.
      items: items.map((over, i) => item({ id: ids[i], instant: true, cancellation: facts({ orderItemId: ids[i], orderSettling: sagaState !== "fulfilled" }), ...over })),
    };
  }

  it("before the capture every item shows the order's one state", () => {
    const out = projectCustomerStatus(multi("reserve_pending", [{ booking: pendingBooking }, {}, {}], false), NOW);
    expect(out.state).toBe("booking_processing");
    expect(out.items.map((i) => i.state)).toEqual(["booking_processing", "booking_processing", "booking_processing"]);
    // Released before the capture: nothing was charged for any item.
    const released = projectCustomerStatus(multi("released", [{}, {}, {}], false), NOW);
    expect(released.items.map((i) => i.state)).toEqual(["payment_released", "payment_released", "payment_released"]);
  });

  it("after the capture each item has its own state, and the failed one says it is refunded", () => {
    const refunding = projectCustomerStatus(
      multi("confirm_pending", [
        { booking: confirmedBooking },
        { booking: rejected, status: "rejected", refunds: [{ status: "accepted", createdAt: T0, updatedAt: T0 }] },
        { booking: pendingBooking },
      ]),
      NOW,
    );
    // Until the order is settled, an item the operator already confirmed still shows as processing, with no cancel offer.
    expect(refunding.items.map((i) => i.state)).toEqual(["booking_processing", "refund_processing", "booking_processing"]);
    expect(refunding.items[0].cancellation).toEqual({ kind: "none" });
    // Per item, not "refunded in full": only an item not confirmed is refunded.
    expect(refunding.nextStep).not.toMatch(/in full/);

    const done = projectCustomerStatus(
      multi("fulfilled", [{ booking: confirmedBooking }, { booking: rejected, status: "rejected", refunds: [{ status: "succeeded", createdAt: T0, updatedAt: T0 }] }, { booking: confirmedBooking }]),
      NOW,
    );
    expect(done.state).toBe("partially_fulfilled");
    expect(done.items.map((i) => i.state)).toEqual(["confirmed", "refunded", "confirmed"]);
    expect(done.steps.booking.status).toBe("done");
  });

  it("an item-scoped problem the saga recorded shows on that item only", () => {
    const out = projectCustomerStatus(
      multi("confirm_pending", [{ booking: pendingBooking }, { booking: rejected, remedies: [{ kind: "refund", status: "failed", refunded: false, updatedAt: T0 }] }]),
      NOW,
    );
    expect(out.items.map((i) => i.state)).toEqual(["booking_processing", "needs_attention"]);
  });

  it("an item whose own refund failed needs attention; the confirmed ones stay confirmed", () => {
    const out = projectCustomerStatus(multi("fulfilled", [{ booking: confirmedBooking }, { booking: rejected, status: "rejected", refunds: [{ status: "failed", createdAt: T0, updatedAt: T0 }] }]), NOW);
    expect(out.items.map((i) => i.state)).toEqual(["confirmed", "needs_attention"]);
  });
});

describe("evaluateCancellation: a multi-item order is settled first (lead decision, 3 November 2026)", () => {
  it("an otherwise eligible item is not offered while its multi-item order settles, is offered once settled, and one item is unchanged", async () => {
    const { evaluateCancellation } = await import("../cancellation.service");
    // facts() is eligible: confirmed, free cancellation ahead, tickets not issued at confirm, money refundable.
    expect(evaluateCancellation(facts(), NOW)).toMatchObject({ kind: "eligible", refundMinor: "45000" });
    expect(evaluateCancellation(facts({ orderSettling: true }), NOW)).toEqual({ kind: "none" });
    expect(evaluateCancellation(facts({ orderSettling: false }), NOW)).toMatchObject({ kind: "eligible" });
  });
});

describe("doc 29 §8.7: the pickup time the supplier returned", () => {
  it("shows on a confirmed item with the checkout hotel; never on a hold, and never an unreadable time", () => {
    const pickupOf = (booking: Item["booking"], hotel: string | null = "Example Marina Hotel") =>
      projectCustomerStatus(snap("fulfilled", { captured: true, item: { booking, pickupHotelName: hotel } }), NOW).items[0].pickup ?? null;
    expect(pickupOf({ ...confirmedBooking, pickupTimeMinutes: 8 * 60 + 15 })).toEqual({ time: "08:15", hotel: "Example Marina Hotel" });
    expect(pickupOf({ ...confirmedBooking, pickupTimeMinutes: 0 }, null)).toEqual({ time: "00:00", hotel: null });
    expect(pickupOf({ ...confirmedBooking, pickupTimeMinutes: null })).toBeNull();
    expect(pickupOf({ ...confirmedBooking, pickupTimeMinutes: 24 * 60 })).toBeNull();
    expect(pickupOf({ ...confirmedBooking, state: "awaiting_payment", pickupTimeMinutes: 8 * 60 })).toBeNull();
    expect(pickupOf(null)).toBeNull();
  });
});

describe("paxLabel", () => {
  it("names counts in plain words and skips zeros", () => {
    expect(paxLabel({ adult: 2, child: 1, infant: 0 })).toBe("2 adults, 1 child");
    expect(paxLabel({ child: 2, adult: 1 })).toBe("1 adult, 2 children");
    expect(paxLabel({ adults: 3 })).toBe("3 adults");
    expect(paxLabel(null)).toBe("");
  });
});

describe("customerTimeslot (doc 22 §32.34)", () => {
  it("shows only the time of a supplier slot reference, and any other text as it is", async () => {
    const { customerTimeslot } = await import("../order-status.service");
    expect(customerTimeslot("18@21:00")).toBe("21:00");
    expect(customerTimeslot("21:00 sailing")).toBe("21:00 sailing");
    expect(customerTimeslot("21:00")).toBe("21:00");
    expect(customerTimeslot(null)).toBeNull();
    expect(customerTimeslot("")).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * Checkout redesign batch 1: the words for every state (CO-01, CO-02, CO-04,
 * CO-05, CO-11, CO-14, CO-15; design contract §7)
 * ------------------------------------------------------------------------ */

describe("batch 1: truthful status copy, state by state", () => {
  const issued = { booking: confirmedBooking, tickets: { fulfilment: "issued" as const, documents: [validDoc] } };
  const all: Array<[string, Snapshot]> = [
    ["session_created", snap("session_created")],
    ["authorized", snap("authorized")],
    ["capture_unknown", snap("capture_unknown")],
    ["reserve_pending", snap("reserve_pending")],
    ["reserved", snap("reserved")],
    ["captured", snap("captured", { captured: true })],
    ["confirm_pending", snap("confirm_pending", { captured: true })],
    ["fulfilled/ticket_pending", snap("fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "ticket_pending", documents: [] } } })],
    ["fulfilled/issued", snap("fulfilled", { captured: true, item: issued })],
    ["fulfilled/issued, view only", { ...snap("fulfilled", { captured: true, item: issued }), canDownload: false }],
    ["fulfilled/not_applicable", snap("fulfilled", { captured: true, item: { booking: confirmedBooking } })],
    ["fulfilled/attention", snap("fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "attention", documents: [] } } })],
    ["release_pending", snap("release_pending")],
    ["released", snap("released")],
    ["refund_pending", snap("refund_pending", { captured: true })],
    ["refunded", snap("refunded", { captured: true })],
    ["failed", snap("failed")],
    ["attention", snap("attention", { captured: true })],
  ];

  it("no state promises a channel that does not exist (CO-11); only a live remedy names a time (TKT-8)", () => {
    for (const [name, sn] of all) {
      const out = projectCustomerStatus(sn, NOW);
      const text = `${out.headline} ${out.nextStep}`;
      expect(text, name).not.toMatch(/confirmation email|GST|invoice|under a minute|inside a minute|in your account/i);
      expect(text, name).not.toMatch(/sign in/i);
      if (/Dubai time/.test(text)) expect(out.deadlines.remedyAtUtc, name).not.toBeNull();
    }
  });

  it("awaiting payment never says nothing was taken: the customer may have just paid (CO-04)", () => {
    const out = projectCustomerStatus(snap("session_created"), NOW);
    expect(out.state).toBe("awaiting_payment");
    expect(out.headline).toBe("Waiting for Stripe to confirm your payment.");
    expect(out.nextStep).toBe(
      "If you've just paid, don't pay again: this page updates by itself once Stripe confirms it. If you left the payment page without paying, nothing was charged.",
    );
    expect(`${out.headline} ${out.nextStep}`).not.toMatch(/Nothing has been taken|Nothing was taken|Finish paying/);
    expect(out.pollAfterMs).toBe(5_000);
  });

  it("from the payment to the operator's answer the words do not change without news (CO-05, CO-14)", () => {
    const steps = ["authorized", "reserve_pending", "reserved", "captured", "confirm_pending"];
    const outs = steps.map((st) => projectCustomerStatus(snap(st, { captured: st === "captured" || st === "confirm_pending" }), NOW));
    for (const out of outs) {
      expect(out.headline).toBe("Payment received. We're booking your Desert safari (synthetic) with the operator.");
      expect(out.nextStep).toMatch(
        /^This page updates by itself\. If the operator hasn't confirmed your booking by .+ Dubai time .+, you get the full amount back automatically, as a released hold or a refund\.$/,
      );
    }
    // The same sentence before and after the capture: release and refund are both "the full amount back".
    // (Its time is the saga's deadline; the saga can move it, which is reported as needing a server change.)
    expect(new Set(outs.map((o) => o.nextStep)).size).toBe(1);
  });

  it("the next step's remedy is the shared sentence the Deadline box uses (follow-up 3)", async () => {
    const { formatDubaiAndUtc, remedySentence } = await import("@/lib/customer-status");
    const out = projectCustomerStatus(snap("reserved"), NOW);
    expect(out.nextStep).toBe(`This page updates by itself. ${remedySentence(formatDubaiAndUtc(DEADLINE.toISOString()), false)}`);
  });

  it("an unknown capture says don't pay again, with the same remedy", () => {
    const out = projectCustomerStatus(snap("capture_unknown"), NOW);
    expect(out.headline).toBe("We're still confirming your payment with the bank.");
    expect(out.nextStep).toContain("you won't be charged twice for this booking");
  });

  it("booked, voucher not ready: says so, with no download (CO-14, CO-15)", () => {
    const out = projectCustomerStatus(snap("fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "ticket_pending", documents: [] } } }), NOW);
    expect(out.headline).toBe("Booked. Your voucher is being prepared.");
    expect(out.nextStep).toBe("This page updates by itself when it's ready, and we email it to you too.");
    expect(out.items[0].tickets.documents).toEqual([]);
  });

  it("voucher ready: authorised viewers are told to download; others to confirm it's you (CO-02)", () => {
    const ok = projectCustomerStatus(snap("fulfilled", { captured: true, item: issued }), NOW);
    expect(ok.headline).toBe("Your Desert safari (synthetic) is booked.");
    expect(ok.nextStep).toBe("Your voucher is ready to download. Show it on your phone or print it for the day.");
    expect(ok.canDownload).toBe(true);
    const locked = projectCustomerStatus({ ...snap("fulfilled", { captured: true, item: issued }), canDownload: false }, NOW);
    expect(locked.nextStep).toBe("Your voucher is ready. To keep it private, confirm it's you.");
    expect(locked.nextStep).not.toMatch(/will appear here|sign in/i);
    expect(locked.canDownload).toBe(false);
    expect(locked.items[0].tickets.documents).toEqual([]);
  });

  it("several activities share one plural sentence and an item-level remedy", () => {
    const second = "01890000-0000-7000-8000-0000000000a2";
    const base = snap("reserved");
    const multi = { ...base, items: [item({ instant: true }), item({ id: second, title: "Dhow cruise (synthetic)", instant: true })] };
    const out = projectCustomerStatus(multi, NOW);
    expect(out.headline).toBe("Payment received. We're booking your 2 activities with the operator.");
    expect(out.nextStep).toMatch(/If the operator hasn't confirmed an activity by .+, you get its amount back automatically\./);
  });

  it("an order our team arranged, awaiting its payment link, does not name Stripe", () => {
    const assisted = projectCustomerStatus(
      { ...snap("session_created"), saga: null, payment: null, order: { ...snap("session_created").order, rail: "assisted", status: "pending_payment" } },
      NOW,
    );
    expect(assisted.state).toBe("awaiting_payment");
    expect(assisted.headline).toBe("We are waiting for your payment.");
    expect(`${assisted.headline} ${assisted.nextStep}`).not.toMatch(/Stripe/);
    // The instant checkout's own wording stays for an order with a payment saga.
    expect(projectCustomerStatus(snap("session_created"), NOW).headline).toContain("Stripe");
  });

  it("needs attention points to WhatsApp, not a confirmation email that does not exist (CO-11)", () => {
    const out = projectCustomerStatus(snap("attention", { captured: true }), NOW);
    expect(out.nextStep).toBe("Nothing is lost while they do. We will contact you, or you can message us on WhatsApp with your reference.");
  });

  it("one cancellation statement per item, in the quote's own words (CO-01)", () => {
    const refundable = projectCustomerStatus(snap("reserved"), NOW);
    // 06:00 UTC is 10:00 in Dubai.
    expect(refundable.items[0].cancellationTerms).toBe("Free cancellation until Mon 14 Jan 2030, 10:00 Dubai time. After that, the booking is non-refundable.");
    const nonRefundable = projectCustomerStatus(
      snap("reserved", { item: { cancellation: facts({ policy: { freeCancellationUntilUtc: "2030-01-14T06:00:00.000Z", nonRefundableAfterConfirm: true } }) } }),
      NOW,
    );
    expect(nonRefundable.items[0].cancellationTerms).toBe("This booking is non-refundable once confirmed.");
    expect(nonRefundable.items[0].refundUntilUtc).toBeNull();
    // Unpaid orders show the quote's terms too (the same as at review); nothing once the money went back.
    expect(projectCustomerStatus(snap("session_created"), NOW).items[0].cancellationTerms).toBe(refundable.items[0].cancellationTerms);
    expect(projectCustomerStatus(snap("released"), NOW).items[0].cancellationTerms).toBeNull();
    expect(projectCustomerStatus(snap("reserved", { item: { cancellation: null } }), NOW).items[0].cancellationTerms).toBeNull();
  });

  it("timeline labels follow the three customer steps: payment received, booked, voucher ready", () => {
    const paid = projectCustomerStatus(snap("reserved"), NOW);
    expect(paid.steps.payment).toMatchObject({ status: "done", label: "Payment received: held on your card, charged once the operator has reserved your place" });
    const booked = projectCustomerStatus(snap("fulfilled", { captured: true, item: issued }), NOW);
    expect(booked.steps.payment).toMatchObject({ status: "done", label: "Payment received" });
    expect(booked.steps.booking).toMatchObject({ status: "done", label: "Booked with the operator" });
    expect(booked.steps.tickets).toMatchObject({ status: "done", label: "Voucher ready" });
    expect(projectCustomerStatus(snap("session_created", { snapshot: { payment: null } }), NOW).steps.payment).toMatchObject({
      status: "in_progress",
      label: "Waiting for Stripe to confirm",
    });
  });
});

describe("pollAfterMs: the poll-hint schedule per state (checkout redesign batch 4, CO-09, CO-40)", () => {
  const ITEM2 = "01890000-0000-7000-8000-0000000000a2";
  const rejected = { ...confirmedBooking, state: "rejected", confirmedAt: null };
  const pendingBooking = { ...confirmedBooking, state: "awaiting_payment", confirmedAt: null };
  const pendingVoucher = { ...validDoc, kind: "voucher_pdf" as const, status: "pending" as const };
  const issued = { tickets: { fulfilment: "issued" as const, documents: [validDoc] } };

  function multi(sagaState: string, items: Array<Partial<Item>>): Snapshot {
    const ids = [ITEM, ITEM2];
    return { ...snap(sagaState, { captured: true }), items: items.map((over, i) => item({ id: ids[i], instant: true, cancellation: facts({ orderItemId: ids[i] }), ...over })) };
  }

  const inFlight: Array<[string, Parameters<typeof snap>[1], number]> = [
    ["session_created", {}, 5_000],
    ["authorized", {}, 5_000],
    ["capture_unknown", {}, 5_000],
    ["reserve_pending", {}, 5_000],
    ["confirm_pending", { captured: true }, 5_000],
    ["fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "ticket_pending", documents: [] } } }, 5_000],
    ["release_pending", {}, 30_000],
    ["refund_pending", { captured: true, item: { refunds: [{ status: "accepted", createdAt: T0, updatedAt: T0 }] } }, 60_000],
  ];
  for (const [saga, over, ms] of inFlight) {
    it(`${saga}${over?.item?.tickets ? " (voucher pending)" : ""} polls every ${ms / 1000} s`, () => {
      expect(projectCustomerStatus(snap(saga, over), NOW).pollAfterMs).toBe(ms);
    });
  }

  it("a supported cancellation in progress polls every 15 s", () => {
    const out = projectCustomerStatus(snap("fulfilled", { captured: true, item: { booking: confirmedBooking, ...issued, request: { kind: "supported", status: "cancelling", createdAt: T0, updatedAt: T0 } } }), NOW);
    expect(out).toMatchObject({ state: "cancellation_processing", pollAfterMs: 15_000 });
  });

  it("terminal states stop polling", () => {
    const terminal: Snapshot[] = [
      snap("fulfilled", { captured: true, item: { booking: confirmedBooking, ...issued } }),
      snap("released", {}),
      snap("refunded", { captured: true, item: { refunds: [{ status: "succeeded", createdAt: T0, updatedAt: T0 }] } }),
      snap("failed", {}),
      snap("fulfilled", { captured: true, item: { booking: confirmedBooking, ...issued, request: { kind: "supported", status: "refunded", createdAt: T0, updatedAt: T0 } } }),
    ];
    for (const s of terminal) {
      const out = projectCustomerStatus(s, NOW);
      expect(out.pollAfterMs, out.state).toBeNull();
    }
  });

  it("attention for a late voucher still being retried keeps polling (60 s); once the retries are over it stops", () => {
    const late = projectCustomerStatus(snap("fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "attention", documents: [pendingVoucher] } } }), NOW);
    expect(late).toMatchObject({ state: "needs_attention", pollAfterMs: 60_000 });
    const given = projectCustomerStatus(snap("fulfilled", { captured: true, item: { booking: confirmedBooking, tickets: { fulfilment: "attention", documents: [] } } }), NOW);
    expect(given).toMatchObject({ state: "needs_attention", pollAfterMs: null });
  });

  it("attention a human must resolve (the saga stopped) does not poll", () => {
    expect(projectCustomerStatus(snap("attention", { captured: true, item: { booking: { ...confirmedBooking, state: "outcome_unknown", confirmedAt: null } } }), NOW).pollAfterMs).toBeNull();
  });

  it("an order needing attention keeps polling at the pace of another item still in flight", () => {
    const out = projectCustomerStatus(multi("confirm_pending", [{ booking: pendingBooking }, { booking: rejected, remedies: [{ kind: "refund", status: "failed", refunded: false, updatedAt: T0 }] }]), NOW);
    expect(out.state).toBe("needs_attention");
    expect(out.items.map((i) => i.state)).toEqual(["booking_processing", "needs_attention"]);
    expect(out.pollAfterMs).toBe(5_000);
  });

  it("a partly booked order keeps polling while an item's voucher is still being prepared, and stops once every item has settled", () => {
    const refundedItem = { booking: rejected, status: "rejected", refunds: [{ status: "succeeded", createdAt: T0, updatedAt: T0 }] };
    const preparing = projectCustomerStatus(multi("fulfilled", [{ booking: confirmedBooking, tickets: { fulfilment: "ticket_pending", documents: [pendingVoucher] } }, refundedItem]), NOW);
    expect(preparing).toMatchObject({ state: "partially_fulfilled", pollAfterMs: 5_000 });
    expect(preparing.items.map((i) => i.state)).toEqual(["confirmed_ticket_pending", "refunded"]);
    const settled = projectCustomerStatus(multi("fulfilled", [{ booking: confirmedBooking, ...issued }, refundedItem]), NOW);
    expect(settled).toMatchObject({ state: "partially_fulfilled", pollAfterMs: null });
  });
});

/* ---------------------------------------------------------------------------
 * Doc 29 Batch 6: external-supplier bookings
 * ------------------------------------------------------------------------ */

describe("an item booked through an external supplier", () => {
  const STATEMENT = "This operator confirms bookings through their own system, so confirmation can take a few minutes after you pay. If they cannot confirm it, you get the full amount back, as a released hold or a refund.";
  const ext = (state: string, over: Record<string, unknown> = {}) => ({ state, startMinutes: 600, confirmedAt: T0, cancelledAt: null, updatedAt: T0, externalRoute: true, ...over });

  it("waiting: says confirmation can take a few minutes, promises no clock, and keeps polling", () => {
    const s = projectCustomerStatus(snap("confirm_pending", { captured: true, item: { booking: ext("awaiting_external") } }), NOW);
    expect(s.state).toBe("booking_processing");
    expect(s.headline).toContain("We're booking");
    expect(s.nextStep).toContain("can take a few minutes");
    expect(s.nextStep).toContain("full amount back");
    // The saga's confirm send-by is not a refund promise for an external confirmation: no deadline is shown.
    expect(s.deadlines.remedyAtUtc).toBeNull();
    expect(s.nextStep).not.toMatch(/by \d/);
    expect(s.items[0].externalConfirmation).toBe(STATEMENT);
    expect(s.pollAfterMs).not.toBeNull();
    expect(forbiddenKeys(s)).toEqual([]);
  });

  it("handed to our team at the wait limit: says so plainly, and still promises no refund before the operator answers", () => {
    const s = projectCustomerStatus(snap("confirm_pending", { captured: true, item: { booking: ext("awaiting_external", { externalHandedOff: true }) } }), NOW);
    expect(s.state).toBe("booking_processing");
    expect(s.headline).toContain("taking longer than usual");
    expect(s.nextStep).toContain("Our team is following it up");
    expect(s.nextStep).toContain("If the operator cannot confirm it");
    expect(s.items[0].externalConfirmation).toBe(STATEMENT);
    expect(JSON.stringify(s)).not.toContain("external_confirmation_handoff");
  });

  it("confirmed: the statement stays true and is still shown", () => {
    const s = projectCustomerStatus(snap("fulfilled", { captured: true, item: { status: "confirmed", booking: ext("confirmed") } }), NOW);
    expect(s.state).toBe("confirmed");
    expect(s.items[0].externalConfirmation).toBe(STATEMENT);
  });

  it("failed by the operator after the capture: the refund is shown plainly, with the same statement", () => {
    const processing = projectCustomerStatus(
      snap("refund_pending", { captured: true, item: { booking: ext("rejected"), refunds: [{ status: "requested", createdAt: T0, updatedAt: T0 }] } }),
      NOW,
    );
    expect(processing.state).toBe("refund_processing");
    expect(processing.headline).toBe("Your refund is on its way.");
    expect(processing.steps.booking).toMatchObject({ status: "failed", label: "The operator could not confirm this booking" });
    expect(processing.items[0].externalConfirmation).toBe(STATEMENT);
    const done = projectCustomerStatus(snap("refunded", { captured: true, item: { booking: ext("rejected"), refunds: [{ status: "succeeded", createdAt: T0, updatedAt: T0 }] } }), NOW);
    expect(done.state).toBe("refunded");
    expect(done.items[0].externalConfirmation).toBe(STATEMENT);
  });

  it("an internal item shows no such statement and keeps its remedy deadline", () => {
    const s = projectCustomerStatus(snap("confirm_pending", { captured: true, item: { booking: { ...ext("confirming"), externalRoute: null } } }), NOW);
    expect(s.items[0].externalConfirmation).toBeNull();
    expect(s.deadlines.remedyAtUtc).toBe(DEADLINE.toISOString());
    expect(s.nextStep).not.toContain("can take a few minutes");
  });
});

describe("external-supplier items: fix round (review 89, owner decisions of 24 Nov 2026)", () => {
  const ext = (state: string, over: Record<string, unknown> = {}) => ({ state, startMinutes: 600, confirmedAt: T0, cancelledAt: null, updatedAt: T0, externalRoute: true, ...over });
  const SECOND = "01890000-0000-7000-8000-0000000000a2";
  const two = (bookings: [Record<string, unknown>, Record<string, unknown>]) => {
    const base = snap("confirm_pending", { captured: true });
    return {
      ...base,
      items: [
        item({ instant: true, booking: bookings[0] as Item["booking"] }),
        item({ id: SECOND, title: "Dhow cruise (synthetic)", instant: true, cancellation: facts({ orderItemId: SECOND }), booking: bookings[1] as Item["booking"] }),
      ],
    };
  };

  it("B6-02: a two-item order with an external item still waiting promises no refund time, at order level or in the deadline", () => {
    const s = projectCustomerStatus(two([{ ...confirmedBooking }, ext("awaiting_external")]), NOW);
    expect(s.state).toBe("booking_processing");
    expect(s.nextStep).toContain("If the operator can't confirm an activity, you get its amount back automatically.");
    expect(s.nextStep).not.toMatch(/by \d/);
    expect(s.deadlines.remedyAtUtc).toBeNull();
    expect(s.items[1].externalConfirmation).toContain("can take a few minutes");
  });

  it("B6-02: once the external item is settled, the multi-item deadline wording returns", () => {
    const s = projectCustomerStatus(two([ext("confirming", { externalRoute: null }), ext("confirmed")]), NOW);
    expect(s.deadlines.remedyAtUtc).toBe(DEADLINE.toISOString());
  });

  it("B6-06: any flag on a booking still waiting says our team is following it up", () => {
    const s = projectCustomerStatus(snap("confirm_pending", { captured: true, item: { booking: ext("awaiting_external", { externalHandedOff: true }) } }), NOW);
    expect(s.headline).toContain("taking longer than usual");
  });

  it("owner decision d: a released external hold too short to book online offers the existing 'Send it to our team' route", () => {
    const released = projectCustomerStatus(snap("released", { item: { booking: ext("cancelled", { externalHoldUnusable: true, confirmedAt: null }) } }), NOW);
    expect(released.state).toBe("payment_released");
    expect(released.headline).toContain("Nothing was charged");
    expect(released.nextStep).toContain("Send it to our team");
    expect(released.inquiryHref).toBe("/inquiry?from=booking&reason=external_hold");
    // Capture-first gateway: refunded instead, same offer.
    const refunded = projectCustomerStatus(snap("refunded", { captured: true, item: { booking: ext("cancelled", { externalHoldUnusable: true, confirmedAt: null }), refunds: [{ status: "succeeded", createdAt: T0, updatedAt: T0 }] } }), NOW);
    expect(refunded.inquiryHref).toBe("/inquiry?from=booking&reason=external_hold");
    // Any other release offers nothing new.
    expect(projectCustomerStatus(snap("released", { item: { booking: ext("cancelled", { confirmedAt: null }) } }), NOW).inquiryHref).toBeNull();
    expect(forbiddenKeys(released)).toEqual([]);
  });
});
