import { describe, expect, it } from "vitest";
import { bookingReason, catalogueStaleIncident, crmPortalIncident, crmSyncDeadReason, isCrmDeleteCode, incidentContext, latestPerKey, OPS_INCIDENT_TITLES, reasonCode, type OpsIncident } from "../ops-alert.service";
import { AUTH_PAUSE_MS, BREAKER_THRESHOLD, breakerPauseMs } from "@/server/crm/crm.worker";
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
    // Doc 29 Batch 6.
    ["an external booking handed to our team at its wait limit", { state: "awaiting_external", errorCode: "external_confirmation_handoff", attention: true, recoverySearches: 0 }, "external_confirmation_handoff"],
    ["an external booking still waiting inside its wait limit", { state: "awaiting_external", errorCode: null, attention: false, recoverySearches: 0 }, null],
    ["an external booking the supplier failed after the confirm", { state: "rejected", errorCode: "external_booking_failed", attention: true, recoverySearches: 0 }, "external_booking_failed"],
    ["an external booking the supplier failed at the reserve (nothing captured)", { state: "rejected", errorCode: "external_booking_failed", attention: false, recoverySearches: 0 }, null],
    ["an external hold too short to confirm, released", { state: "cancelled", errorCode: "external_hold_unusable", attention: true, recoverySearches: 0 }, "external_hold_unusable"],
    ["review 89 B6-18: a confirmed external booking the provider later failed", { state: "confirmed", errorCode: "external_failed_after_confirm", attention: true, recoverySearches: 0 }, "external_failed_after_confirm"],
    ["review 89 B6-15: an external reservation released while still in progress", { state: "cancelled", errorCode: "external_reservation_released", attention: true, recoverySearches: 0 }, "external_reservation_released"],
    ["an external booking still unconfirmed when the guest is affected", { state: "awaiting_external", errorCode: "external_unconfirmed_at_start", attention: true, recoverySearches: 0 }, "external_unconfirmed_at_start"],
    ["review 89 B6-06: a waiting external booking with a bare flag (read dead-letter)", { state: "awaiting_external", errorCode: null, attention: true, recoverySearches: 0 }, "external_confirmation_attention"],
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

  it("a CRM copy that could not be deleted alerts with ids only (doc 29 §6.5, review R13)", () => {
    const ctx = incidentContext(
      incident({ kind: "crm_delete_failed", entityKind: "crm_subject", entityId: `inquiry:${ID}`, reason: "crm_erasure_delete_dead", orderId: null, orderReference: null, bookingId: null, supplierBookingRef: null, adminPath: "/admin" }),
      "https://outlyy.com",
    );
    const r = renderTemplate("OPS_INCIDENT_ALERT", "email", ctx as never);
    expect(r.subject).toBe(`[OUTLY ALERT] ${OPS_INCIDENT_TITLES.crm_delete_failed}`);
    expect(r.text).toContain("Reason: crm_erasure_delete_dead");
    expect(r.text).toContain(`Entity: crm_subject:inquiry:${ID}`);
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

describe("stale catalogue alert (doc 29 Batch 1b, review 81 R7)", () => {
  const H = 3_600_000;
  const now = new Date("2026-11-23T10:00:00.000Z");
  const since = new Date(now.getTime() - 72 * H);
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("is raised at the moment the last complete run turned 48 hours old, inside the sweep window only", () => {
    expect(catalogueStaleIncident("production", ago(47 * H), since, now)).toBeNull();
    const i = catalogueStaleIncident("production", ago(50 * H), since, now);
    expect(i).toMatchObject({ kind: "catalogue_stale", entityKind: "supplier_account", entityId: "traveldesk.catalogue.production", reason: "catalogue_stale", orderReference: null, adminPath: "/admin/suppliers/traveldesk" });
    expect(i!.raisedAt).toEqual(ago(2 * H));
    // Stale for longer than the lookback: already alerted (or a first deploy), not again.
    expect(catalogueStaleIncident("production", ago(121 * H), since, now)).toBeNull();
    // No complete run at all: nothing to measure from.
    expect(catalogueStaleIncident("production", null, since, now)).toBeNull();
  });

  it("the email carries codes and ids only", () => {
    const r = renderTemplate("OPS_INCIDENT_ALERT", "email", incidentContext(catalogueStaleIncident("test", ago(50 * H), since, now)!, "https://outlyy.com") as never);
    expect(r.subject).toBe(`[OUTLY ALERT] ${OPS_INCIDENT_TITLES.catalogue_stale}`);
    expect(r.text).toContain("Reason: catalogue_stale");
    expect(r.text).toContain("Entity: supplier_account:traveldesk.catalogue.test");
    expect(r.text).toContain("Admin: https://outlyy.com/admin/suppliers/traveldesk");
  });
});

describe("CRM sync alerts (doc 29d G11, CRM C2b)", () => {
  const H = 3_600_000;
  const now = new Date("2026-11-25T10:00:00.000Z");
  const since = new Date(now.getTime() - 72 * H);

  it("a dead sync row: one reason per error kind, codes only", () => {
    expect(crmSyncDeadReason("unavailable:timeout")).toBe("crm_sync_dead_unavailable");
    expect(crmSyncDeadReason("refused:uf_customer_email")).toBe("crm_sync_dead_refused");
    expect(crmSyncDeadReason("rejected:INVALID_ARG_VALUE")).toBe("crm_sync_dead_rejected");
    expect(crmSyncDeadReason("something else")).toBe("crm_sync_dead_other");
    expect(crmSyncDeadReason(null)).toBe("crm_sync_dead_other");
  });

  it("a sync row that died deleting an erased subject's deal is a delete incident, never 'sync gave up' (C2B-05)", () => {
    for (const c of ["refused:linked_deal_not_visible", "rejected:delete_not_found_visible", "refused:delete_target", "invalid_response:delete_result_object"]) expect(isCrmDeleteCode(c)).toBe(true);
    for (const c of ["unavailable:timeout", "refused:uf_customer_email", "invalid_response:schema", null]) expect(isCrmDeleteCode(c)).toBe(false);
  });

  it("an open breaker is raised at the moment it opened, exactly, and again at each re-open", () => {
    const openedAt = new Date(now.getTime() - 2 * 60_000);
    const failures = BREAKER_THRESHOLD;
    const row = { environment: "production", pauseReason: "breaker", pausedUntil: new Date(openedAt.getTime() + breakerPauseMs(failures)), consecutiveFailures: failures };
    const i = crmPortalIncident(row, since, now)!;
    expect(i).toMatchObject({ kind: "crm_sync_paused", entityKind: "crm_subject", entityId: "portal:production", reason: "crm_breaker_open", orderReference: null, adminPath: "/admin" });
    expect(i.raisedAt).toEqual(openedAt);
    // A failed half-open probe re-opens it, longer: a new raise (the 6-hour dedup still limits the emails).
    const reopenedAt = new Date(now.getTime() - 30_000);
    const again = crmPortalIncident({ ...row, consecutiveFailures: failures + 1, pausedUntil: new Date(reopenedAt.getTime() + breakerPauseMs(failures + 1)) }, since, now)!;
    expect(again.raisedAt).toEqual(reopenedAt);
    // Recovered (failures reset by a success), a throttle pause, or no pause: no incident.
    expect(crmPortalIncident({ ...row, consecutiveFailures: 0 }, since, now)).toBeNull();
    expect(crmPortalIncident({ ...row, pauseReason: "throttled" }, since, now)).toBeNull();
    expect(crmPortalIncident({ ...row, pausedUntil: null }, since, now)).toBeNull();
  });

  it("a refused credential is raised at its opening, stays one raise after recovery, and ages out of the window", () => {
    const openedAt = new Date(now.getTime() - 10 * 60_000);
    const row = { environment: "production", pauseReason: "auth", pausedUntil: new Date(openedAt.getTime() + AUTH_PAUSE_MS), consecutiveFailures: 0 };
    expect(crmPortalIncident(row, since, now)).toMatchObject({ reason: "crm_auth_refused", raisedAt: openedAt });
    // Long after the pause ended the stored row still names the same opening: the ops_alerts row already handled it.
    expect(crmPortalIncident(row, since, new Date(now.getTime() + 5 * H))!.raisedAt).toEqual(openedAt);
    expect(crmPortalIncident(row, new Date(now.getTime() + 73 * H - 72 * H + H), new Date(now.getTime() + 73 * H))).toBeNull();
  });

  it("the CRM alert emails carry codes and ids only", () => {
    const dead: OpsIncident = { kind: "crm_sync_dead", entityKind: "crm_subject", entityId: `order:${ID}`, reason: "crm_sync_dead_unavailable", raisedAt: T, orderId: ID, orderReference: "OUT-100001", bookingId: null, supplierBookingRef: null, adminPath: "/admin/bookings/OUT-100001" };
    const r = renderTemplate("OPS_INCIDENT_ALERT", "email", incidentContext(dead, "https://outlyy.com") as never);
    expect(r.subject).toBe(`[OUTLY ALERT] ${OPS_INCIDENT_TITLES.crm_sync_dead} — OUT-100001`);
    expect(r.text).toContain("Reason: crm_sync_dead_unavailable");
    const paused = crmPortalIncident({ environment: "production", pauseReason: "auth", pausedUntil: new Date(T.getTime() + AUTH_PAUSE_MS), consecutiveFailures: 0 }, new Date(0), new Date(T.getTime() + 1))!;
    const p = renderTemplate("OPS_INCIDENT_ALERT", "email", incidentContext(paused, "https://outlyy.com") as never);
    expect(p.subject).toBe(`[OUTLY ALERT] ${OPS_INCIDENT_TITLES.crm_sync_paused}`);
    expect(p.text).toContain("Entity: crm_subject:portal:production");
    expect(p.text).not.toMatch(/bitrix|rest\/|secret/i);
  });
});
