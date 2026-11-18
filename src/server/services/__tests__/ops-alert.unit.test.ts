import { describe, expect, it } from "vitest";
import { bookingReason, incidentContext, latestPerKey, OPS_INCIDENT_TITLES, reasonCode, type OpsIncident } from "../ops-alert.service";
import { renderTemplate } from "@/server/notifications/templates";

/** Ops alert emails (doc 22 §32.24): the pure parts. Synthetic ids only. */

const T = new Date("2026-11-04T08:00:00.000Z");
const ID = "01a1a638-5840-75c9-97d4-1543fbf8df19";

function incident(over: Partial<OpsIncident> = {}): OpsIncident {
  return {
    kind: "booking_attention",
    entityKind: "supplier_booking",
    entityId: ID,
    reason: "manual_review",
    raisedAt: T,
    orderId: "01a1a638-0000-7000-8000-000000000001",
    orderReference: "OUT-100001",
    bookingId: ID,
    supplierBookingRef: "912345",
    adminPath: "/admin/bookings/OUT-100001",
    ...over,
  };
}

describe("which bookings need staff", () => {
  it.each<[string, Parameters<typeof bookingReason>[0], string | null]>([
    ["outcome_unknown before its first recovery search", { state: "outcome_unknown", errorCode: null, attention: true, recoverySearches: 0 }, null],
    ["outcome_unknown past its first recovery search", { state: "outcome_unknown", errorCode: null, attention: true, recoverySearches: 1 }, "outcome_unknown"],
    ["not found after recovery", { state: "not_found_unresolved", errorCode: "not_found_after_recovery", attention: true, recoverySearches: 3 }, "outcome_unknown"],
    ["manual_review", { state: "manual_review", errorCode: "ambiguous_recovery", attention: true, recoverySearches: 0 }, "manual_review"],
    ["charged amount mismatch on a hold", { state: "awaiting_payment", errorCode: "charged_amount_mismatch", attention: true, recoverySearches: 0 }, "charged_amount_mismatch"],
    ["a mismatch staff already cleared", { state: "awaiting_payment", errorCode: "charged_amount_mismatch", attention: false, recoverySearches: 0 }, null],
    ["cancel_refused", { state: "cancel_refused", errorCode: "cancel_refused", attention: false, recoverySearches: 0 }, "cancel_refused"],
    ["late acceptance", { state: "outcome_unknown", errorCode: "late_acceptance", attention: true, recoverySearches: 0 }, "late_acceptance"],
    ["late acceptance on a duplicate", { state: "cancelled", errorCode: "late_acceptance_duplicate", attention: true, recoverySearches: 0 }, "late_acceptance"],
    ["a confirmed booking", { state: "confirmed", errorCode: null, attention: false, recoverySearches: 0 }, null],
  ])("%s", (_n, b, expected) => {
    expect(bookingReason(b)).toBe(expected);
  });
});

describe("incidents per (entity, reason)", () => {
  it("keeps the latest raise of each, oldest first", () => {
    const later = new Date(T.getTime() + 60_000);
    const out = latestPerKey([incident({ raisedAt: later }), incident(), incident({ reason: "cancel_refused" })]);
    expect(out.map((i) => [i.reason, i.raisedAt.toISOString()])).toEqual([
      ["cancel_refused", T.toISOString()],
      ["manual_review", later.toISOString()],
    ]);
  });

  it("reason codes are short lower-case codes", () => {
    expect(reasonCode("item_refund_refused_Refund Cap!")).toBe("item_refund_refused_refund_cap_");
    expect(reasonCode("")).toBe("unknown");
    expect(reasonCode("x".repeat(200))).toHaveLength(80);
  });
});

describe("the alert email", () => {
  it("subject [OUTLY ALERT] <incident>, the order reference, booking id, reason code and admin link; nothing else", () => {
    const ctx = incidentContext(incident(), "https://outlyy.com/");
    expect(Object.keys(ctx).sort()).toEqual(["adminUrl", "bookingId", "entity", "incident", "orderReference", "raisedAt", "reasonCode", "supplierBookingRef", "title"]);
    const r = renderTemplate("OPS_INCIDENT_ALERT", "email", ctx as never);
    expect(r.subject).toBe(`[OUTLY ALERT] ${OPS_INCIDENT_TITLES.booking_attention} — OUT-100001`);
    expect(r.text).toBe(
      [
        "Incident: Booking needs staff",
        "Kind: booking_attention",
        "Reason: manual_review",
        "Order: OUT-100001",
        `Booking: ${ID}`,
        "Supplier booking: 912345",
        `Entity: supplier_booking:${ID}`,
        `Raised: ${T.toISOString()}`,
        "",
        "Admin: https://outlyy.com/admin/bookings/OUT-100001",
      ].join("\n"),
    );
    expect(r.html).toContain('href="https://outlyy.com/admin/bookings/OUT-100001"');
  });

  it("renders the same bytes from the same stored context (a resend is identical)", () => {
    const ctx = JSON.parse(JSON.stringify(incidentContext(incident(), "https://outlyy.com")));
    expect(renderTemplate("OPS_INCIDENT_ALERT", "email", ctx)).toEqual(renderTemplate("OPS_INCIDENT_ALERT", "email", JSON.parse(JSON.stringify(ctx))));
  });

  it("a hostile stored value is escaped and a non-http link is never a link", () => {
    const r = renderTemplate("OPS_INCIDENT_ALERT", "email", { ...incidentContext(incident(), "https://outlyy.com"), title: "<script>x</script>", adminUrl: "javascript:alert(1)" } as never);
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain('href="javascript');
  });

  it("the digest says how many were suppressed", () => {
    const r = renderTemplate("OPS_ALERT_DIGEST", "email", { suppressedCount: 7, sinceIso: T.toISOString(), untilIso: T.toISOString(), adminUrl: "https://outlyy.com/admin/bookings" } as never);
    expect(r.subject).toBe("[OUTLY ALERT] 7 more alerts suppressed");
    expect(r.text).toContain("7 more ops alerts were suppressed");
  });
});
