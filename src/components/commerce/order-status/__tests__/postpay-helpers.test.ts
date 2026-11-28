import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomerItemStatus } from "@/lib/customer-status";
import { BookingProgressCard } from "../booking-progress-card";
import { progressMilestones } from "../presenters";
import { codeDestinationText, offeredChannels } from "../recovery";
import { resendRetryAfterMs, resendTickets } from "../resend-tickets";
import { bookedItems, cardFootText, cardVariant } from "../ticket-cards";

/** Post-payment batch A helpers: honest unlock channels (A1), resend client (A4), card variants (A5), progress card (A6). Synthetic values. */

function item(over: Partial<CustomerItemStatus> = {}): CustomerItemStatus {
  return {
    orderItemId: "a",
    title: "Synthetic cruise",
    serviceDate: "2030-01-15",
    timeslot: "21:00",
    paxLabel: "2 adults",
    state: "confirmed",
    tickets: { fulfilment: "issued", documents: [] },
    refundUntilUtc: null,
    cancellation: { kind: "none" },
    ...over,
  };
}

describe("unlock channels (A1)", () => {
  it("offers only what the server says can deliver, in its order, without repeats", () => {
    expect(offeredChannels(["phone", "email", "phone"])).toEqual(["phone", "email"]);
    expect(offeredChannels(["email"])).toEqual(["email"]);
    expect(offeredChannels([])).toEqual([]);
  });

  it("an older projection without the field offers email only, never a phone code", () => {
    expect(offeredChannels(undefined)).toEqual(["email"]);
  });

  it("names where the code goes", () => {
    expect(codeDestinationText(["email"])).toBe("We'll email a 6-digit code to the address you booked with.");
    expect(codeDestinationText(["phone"])).toBe("We'll text a 6-digit code to the phone number you booked with.");
    expect(codeDestinationText(["email", "phone"])).toContain("phone number or email");
  });
});

describe("resend client (A4)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));

  it("posts same-origin with no body to the contract path", async () => {
    const fetchMock = reply(202, { ok: true, resendAvailableAt: "2030-01-01T10:46:00.000Z" });
    vi.stubGlobal("fetch", fetchMock);
    const r = await resendTickets("OUT-483404");
    expect(r).toEqual({ kind: "sent", availableAt: "2030-01-01T10:46:00.000Z" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/orders/OUT-483404/tickets/resend");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.credentials).toBe("same-origin");
  });

  it("429: the time from Retry-After, which may be hours (not capped at 5 minutes)", async () => {
    vi.stubGlobal("fetch", reply(429, { error: { code: "RATE_LIMITED" } }, { "retry-after": "7200" }));
    const r = await resendTickets("OUT-483404", () => Date.parse("2030-01-01T10:00:00.000Z"));
    expect(r).toEqual({ kind: "limited", availableAt: "2030-01-01T12:00:00.000Z" });
    expect(resendRetryAfterMs("abc")).toBeUndefined();
    expect(resendRetryAfterMs("999999")).toBe(86_400_000);
  });

  it("409 nothing to send, the uniform 404, and a network failure", async () => {
    vi.stubGlobal("fetch", reply(409, { error: { code: "NOTHING_TO_SEND" } }));
    expect(await resendTickets("OUT-483404")).toEqual({ kind: "nothing" });
    vi.stubGlobal("fetch", reply(404, { error: { code: "NOT_FOUND" } }));
    expect(await resendTickets("OUT-483404")).toEqual({ kind: "gone" });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    expect(await resendTickets("OUT-483404")).toEqual({ kind: "failed" });
  });

  it("makes no request for a malformed reference", async () => {
    const fetchMock = reply(202, {});
    vi.stubGlobal("fetch", fetchMock);
    expect(await resendTickets("OUT-1")).toEqual({ kind: "gone" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("card variants (A5)", () => {
  it("timed, open-dated, and the date-only fallback for a free-text time", () => {
    expect(cardVariant(item())).toBe("timed");
    expect(cardVariant(item({ timeslot: null, ticket: { validUntil: null, validityCopy: null, nonRefundableCopy: "x", types: [] } }))).toBe("open_dated");
    expect(cardVariant(item({ timeslot: "21:00 sailing" }))).toBe("date_only");
    expect(cardVariant(item({ timeslot: null }))).toBe("date_only");
  });

  it("cards for items the operator confirmed, gated on the item's own state", () => {
    const items = [item({ orderItemId: "a" }), item({ orderItemId: "b", state: "confirmed_ticket_pending" }), item({ orderItemId: "c", state: "refund_processing" }), item({ orderItemId: "d", state: "booking_processing" })];
    expect(bookedItems(items).map((i) => i.orderItemId)).toEqual(["a", "b"]);
  });

  it("the foot line: listed, locked, preparing, attention", () => {
    const listed = item({ tickets: { fulfilment: "issued", documents: [{ id: "d", kind: "voucher_pdf", version: 1, contentType: null, byteSize: null, href: "/api/tickets/documents/d" }] } });
    expect(cardFootText(listed, true)).toBe("Show the voucher PDF at the meeting point.");
    expect(cardFootText({ ...listed, pickup: { time: "16:30", hotel: null } }, true)).toBe("Have the voucher PDF ready at pickup.");
    expect(cardFootText(item(), false)).toBe("Your voucher is ready. Confirm it's you above to download it.");
    expect(cardFootText(item({ tickets: { fulfilment: "ticket_pending", documents: [] } }), true)).toBe("Your voucher is being prepared. It appears here when ready.");
    expect(cardFootText(item({ tickets: { fulfilment: "attention", documents: [] } }), true)).toContain("Our team is on it.");
    expect(cardFootText(item({ tickets: { fulfilment: "not_applicable", documents: [] } }), true)).toBe("");
  });
});

describe("BookingProgressCard (A6, adapted from 21st.dev File Transfer Card)", () => {
  const milestones = progressMilestones({
    steps: {
      payment: { status: "done", label: "Payment received", at: "2030-01-01T10:01:00.000Z" },
      booking: { status: "in_progress", label: "Confirming with the operator", at: null },
      tickets: { status: "not_started", label: "", at: null },
      refund: null,
    },
    items: [item({ state: "booking_processing" })],
  });
  const render = (active: boolean) =>
    renderToStaticMarkup(h(BookingProgressCard, { reference: "OUT-483404", activity: "Synthetic cruise", dateText: "Tue 15 Jan 2030", milestones, active }));

  it("names the booking, the activity and its day, and lists the milestones in order with times only when done", () => {
    const html = render(true);
    expect(html).toContain("OUT-483404");
    expect(html).toContain("Synthetic cruise");
    expect(html).toContain("Tue 15 Jan 2030");
    expect(html.indexOf('data-milestone="payment"')).toBeLessThan(html.indexOf('data-milestone="operator"'));
    expect(html.indexOf('data-milestone="operator"')).toBeLessThan(html.indexOf('data-milestone="tickets"'));
    expect(html).toMatch(/<time dateTime="2030-01-01T10:01:00.000Z" class="tnum">14:01(<!-- -->)? Dubai time<\/time>/);
    expect(html).toContain("Confirming with the operator");
  });

  it("the bar is decorative, hidden under reduced motion, and absent once the page stops checking", () => {
    expect(render(true)).toMatch(/motion-reduce:hidden" aria-hidden="true" data-testid="progress-bar"/);
    expect(render(false)).not.toContain('data-testid="progress-bar"');
    expect(render(false)).not.toContain("animate-pulse");
  });

  it("states every row in words; the discs are decorative", () => {
    const html = render(true);
    expect(html).toContain("In progress");
    expect(html).toContain("Waiting");
    expect(html.match(/rounded-full bg-\[var\(--color-[a-z-]+\)\][^"]*" aria-hidden="true"|aria-hidden="true"/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });
});
