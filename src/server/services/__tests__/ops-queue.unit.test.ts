import { describe, expect, it } from "vitest";
import {
  clearAttentionRefusal,
  detailHref,
  maskedContact,
  maskRecipient,
  mergeRows,
  pageWindow,
  QUEUE_MAX_PAGE,
  QUEUE_MAX_PAGE_SIZE,
  QUEUE_PAGE_SIZE,
  resolutionInputSchema,
  stateLabel,
  type QueueRow,
} from "../ops-queue.service";

/** Pure parts of ops-queue.service.ts; the queries and staff actions run in src/server/__tests__/b5/console-*.test.ts (db project). */

function row(key: string, since: string): QueueRow {
  return {
    key,
    source: "supplier_booking",
    id: key,
    orderId: null,
    orderReference: null,
    orderItemId: null,
    itemTitle: null,
    serviceDate: null,
    since,
    state: "outcome_unknown",
    stateLabel: "Outcome unknown",
    tone: "danger",
    detail: null,
    attention: false,
    contact: null,
    href: null,
  };
}

describe("ops queue helpers", () => {
  it("labels every state as text with a tone, and falls back to the code for an unknown one", () => {
    expect(stateLabel("supplier_booking", "outcome_unknown")).toEqual({ label: "Outcome unknown", tone: "danger" });
    expect(stateLabel("payment_saga", "capture_unknown").label).toBe("Capture outcome unknown");
    expect(stateLabel("cancellation_request", "exception_open").tone).toBe("accent");
    expect(stateLabel("refund", "something_new")).toEqual({ label: "something new", tone: "neutral" });
  });

  it("keeps page and size inside the limits", () => {
    expect(pageWindow(undefined, undefined)).toEqual({ page: 1, pageSize: QUEUE_PAGE_SIZE });
    expect(pageWindow("0", "-3")).toEqual({ page: 1, pageSize: QUEUE_PAGE_SIZE });
    expect(pageWindow("9999", "500")).toEqual({ page: QUEUE_MAX_PAGE, pageSize: QUEUE_MAX_PAGE_SIZE });
    expect(pageWindow("abc", 5)).toEqual({ page: 1, pageSize: 5 });
  });

  it("merges sources oldest first and slices the requested page", () => {
    const a = [row("a1", "2026-11-01T00:00:00.000Z"), row("a2", "2026-11-01T00:03:00.000Z")];
    const b = [row("b1", "2026-11-01T00:01:00.000Z"), row("b2", "2026-11-01T00:02:00.000Z")];
    expect(mergeRows([a, b], 1, 3).map((r) => r.key)).toEqual(["a1", "b1", "b2"]);
    expect(mergeRows([a, b], 2, 3).map((r) => r.key)).toEqual(["a2"]);
  });

  it("masks contact and recipients for staff without customer PII access", () => {
    expect(maskedContact("+919876543210")).toEqual({ name: null, phone: "+91 ••••• •3210", email: null, masked: true });
    expect(maskedContact(null).phone).toBe("—");
    expect(maskRecipient("someone@example.test")).toBe("s•••@example.test");
    expect(maskRecipient("+971501234567")).toBe("+971 •• ••• 4567");
    expect(maskRecipient("opaque")).toBe("•••");
  });

  it("links to the order's item section", () => {
    expect(detailHref("OUT-123456", "0190-item")).toBe("/admin/bookings/OUT-123456#item-0190-item");
    expect(detailHref("OUT-123456", null)).toBe("/admin/bookings/OUT-123456");
    expect(detailHref(null, "x")).toBeNull();
  });

  it("refuses to clear a flag that holds an automatic money step or resend", () => {
    const at = new Date();
    const order = "0190";
    expect(clearAttentionRefusal("supplier_booking", { state: "confirmed", attentionAt: null, orderId: order })).toBe("not_flagged");
    expect(clearAttentionRefusal("supplier_booking", { state: "confirmed", attentionAt: at, orderId: null })).toBe("no_order");
    for (const state of ["queued", "reserved", "awaiting_payment", "confirming", "awaiting_external"]) {
      expect(clearAttentionRefusal("supplier_booking", { state, attentionAt: at, orderId: order })).toBe("holds_money_step");
    }
    expect(clearAttentionRefusal("supplier_booking", { state: "confirmed", attentionAt: at, orderId: order })).toBeNull();
    // R-B5-6: the recovering states can carry the late-acceptance hold; a late-accepted booking is refused in any state.
    for (const state of ["outcome_unknown", "not_found_unresolved", "cancel_unverified"]) {
      expect(clearAttentionRefusal("supplier_booking", { state, attentionAt: at, orderId: order })).toBe("holds_money_step");
    }
    expect(clearAttentionRefusal("supplier_booking", { state: "confirmed", attentionAt: at, orderId: order, lateAccepted: true })).toBe("late_acceptance_hold");
    expect(clearAttentionRefusal("supplier_booking", { state: "manual_review", attentionAt: at, orderId: order, lateAccepted: true })).toBe("late_acceptance_hold");
    expect(clearAttentionRefusal("payment_saga", { state: "reserve_pending", attentionAt: at, orderId: order })).toBe("holds_money_step");
    expect(clearAttentionRefusal("payment_saga", { state: "fulfilled", attentionAt: at, orderId: order })).toBeNull();
    expect(clearAttentionRefusal("notification", { state: "unknown", attentionAt: at, orderId: order })).toBe("holds_resend");
    expect(clearAttentionRefusal("notification", { state: "failed", attentionAt: at, orderId: order })).toBeNull();
    expect(clearAttentionRefusal("cancellation_request", { state: "refunded", attentionAt: at, orderId: order, closed: true })).toBe("closed");
    expect(clearAttentionRefusal("supplier_document", { state: "pending", attentionAt: at, orderId: order })).toBeNull();
  });

  it("accepts only the fixed reason and outcome codes and a short evidence reference", () => {
    const id = "01900000-0000-7000-8000-000000000001";
    expect(resolutionInputSchema.safeParse({ action: "clear_attention", target: "supplier_booking", targetId: id, reasonCode: "handled_offline", evidence: "CALL-42" }).success).toBe(true);
    expect(resolutionInputSchema.safeParse({ action: "clear_attention", target: "supplier_booking", targetId: id, reasonCode: "because", evidence: "CALL-42" }).success).toBe(false);
    expect(resolutionInputSchema.safeParse({ action: "clear_attention", target: "orders", targetId: id, reasonCode: "handled_offline", evidence: "CALL-42" }).success).toBe(false);
    expect(resolutionInputSchema.safeParse({ action: "clear_attention", target: "supplier_booking", targetId: id, reasonCode: "handled_offline", evidence: "x".repeat(121) }).success).toBe(false);
    expect(resolutionInputSchema.safeParse({ action: "close_exception", targetId: id, outcome: "declined", evidence: "CALL-42" }).success).toBe(true);
    expect(resolutionInputSchema.safeParse({ action: "close_exception", targetId: id, outcome: "refunded", evidence: "CALL-42" }).success).toBe(false);
    expect(resolutionInputSchema.safeParse({ action: "close_exception", targetId: id, outcome: "declined", evidence: "CALL-42", amount: 1 }).success).toBe(false);
  });
});
