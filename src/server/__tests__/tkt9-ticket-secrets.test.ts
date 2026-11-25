import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IssuedTicketSet } from "../documents/contracts";
import { redact } from "../lib/logger";
import { emitEvent, STRUCTURED_EVENTS, structuredFields } from "../lib/structured-events";
import { renderTicketsReady, ticketLink } from "../notifications/templates";
import { TravelDeskBookingAdapter, type TravelDeskBookingTransport } from "../suppliers/traveldesk/traveldesk.booking-adapter";
import { bookingFrom, bookingWithTicketsWire, sanitiseBooking, ticketEvidenceFrom } from "../suppliers/traveldesk/traveldesk.booking";

/**
 * TKT-9 (money-tickets-privacy.md): no customer-facing DTO, notification
 * payload or log line carries TravelDesk's `downloadCodeLink`, a voucher
 * `Guid=` or a ticket code. Two halves:
 *
 *  1. Static: the files that build customer-facing responses, messages and
 *     logs never name those fields, never read the code ciphertext, and
 *     nothing outside the document service touches ticket ciphertext at all
 *     (no code path decrypts ticket codes in B4: customers get the supplier
 *     PDF until the symbology is confirmed, Q-T3).
 *  2. Dynamic: a synthetic confirm answer full of codes, links and a Guid is
 *     pushed through the codec, the booking adapter, the stored snapshot,
 *     the structured events, the logger and the ticket email; none of the
 *     serialised results contains any of them.
 */

const ROOT = process.cwd();
const CODES = ["SYNTH-TKT9-CODE-A1", "SYNTH-TKT9-CODE-B2", "SYNTH-TKT9-CODE-C3"];
const GUID = "6b1c3a7e-8f0d-4c2e-9a51-0d1e2f3a4b5c";
const link = (c: string) => `https://testapi.traveldesk.me/public/b2b/v1/bookings/downloadcode?Code=${Buffer.from(c).toString("base64")}`;
const FORBIDDEN = [...CODES, ...CODES.map((c) => Buffer.from(c).toString("base64")), GUID, "downloadCodeLink", "Guid=", "downloadcode", "downloadVoucherUrl"];

/** The secrets themselves: codes (plain and as the Base64 a code link carries), the Guid and its query parameter. */
const SECRETS = [...CODES, ...CODES.map((c) => Buffer.from(c).toString("base64")), GUID, "Guid="];

function assertClean(label: string, value: unknown, forbidden: readonly string[] = FORBIDDEN) {
  const text = typeof value === "string" ? value : `${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n${inspect(value, { depth: 10 })}`;
  for (const f of forbidden) expect(text.includes(f), `${label} contains ${f}`).toBe(false);
}

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__" && name !== "node_modules") files(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

describe("TKT-9 static: customer-facing code never names ticket secrets", () => {
  /** Routes, pages, services and templates that answer customers or send them messages. */
  const CUSTOMER_FACING = [
    ...files(path.join(ROOT, "src/app/api/tickets")),
    ...files(path.join(ROOT, "src/app/api/me")),
    ...files(path.join(ROOT, "src/app/voucher")),
    ...files(path.join(ROOT, "src/app/account")),
    ...files(path.join(ROOT, "src/server/notifications")),
    path.join(ROOT, "src/server/services/notification.service.ts"),
    path.join(ROOT, "src/server/services/customer.service.ts"),
    path.join(ROOT, "src/server/services/capability.service.ts"),
  ].filter((f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  });

  it("covers the ticket routes and the notification code", () => {
    const names = CUSTOMER_FACING.map(rel);
    expect(names.some((n) => n.startsWith("src/app/api/tickets/documents/"))).toBe(true);
    expect(names).toContain("src/server/services/notification.service.ts");
  });

  it.each(["downloadCodeLink", "Guid=", "downloadcode", "downloadVoucherUrl", "downloadTicketsUrl", "codeCiphertext", "code_ciphertext", "storageKey", "storage_key"])(
    "no customer-facing file names %s",
    (needle) => {
      const hits = CUSTOMER_FACING.filter((f) => readFileSync(f, "utf8").includes(needle)).map(rel);
      expect(hits).toEqual([]);
    },
  );

  it("ticket code ciphertext is touched only by the document service, the privacy erasure and the key re-wrap", () => {
    // key-rewrap.service.ts (R-B4-10) opens a code only to re-encrypt it under the active key; it never returns plaintext.
    const allowed = new Set(["src/server/services/document.service.ts", "src/server/repositories/privacy.repo.ts", "src/server/services/key-rewrap.service.ts"]);
    const hits = files(path.join(ROOT, "src"))
      .map(rel)
      .filter((f) => !allowed.has(f))
      .filter((f) => /codeCiphertext|code_ciphertext|decryptFor\(\s*"ticket_codes"/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("nothing in B4 decrypts ticket codes (the supplier PDF is delivered until Q-T3 is answered)", () => {
    const hits = files(path.join(ROOT, "src"))
      .map(rel)
      .filter((f) => /decryptFor\(\s*"ticket_codes"/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(hits).toEqual([]);
  });
});

describe("TKT-9 dynamic: a confirm answer full of secrets leaves none behind", () => {
  const answer = {
    id: 9001,
    date: "2027-03-10T00:00:00",
    offerId: 501,
    bookingType: 2,
    bookingReference: "OUTTD-TKT9",
    tourId: 12,
    adults: 2,
    children: 1,
    infants: 0,
    totalCost: 300,
    totalCostUsd: 82,
    totalPaidFromBalance: 300,
    status: 1,
    isExternalConfirmationInProgress: false,
    isExternalBookingFailed: false,
    hasTickets: true,
    downloadVoucherUrl: `https://testapi.traveldesk.me/public/b2b/v1/bookings/9001/downloadvoucher?Guid=${GUID}`,
    guid: GUID,
    ticketsDetails: {
      code: CODES[0],
      title: "Booking code",
      tickets: CODES.map((c, i) => ({
        code: c,
        ticketFor: i < 2 ? "Adult" : "Child",
        ticketTypeId: 1 + i,
        ticketTypeName: i < 2 ? "Adult" : "Child",
        ticketCodeDisplayType: 1,
        downloadCodeLink: link(c),
        isSent: false,
        validUntil: "2027-03-10T23:59:00",
      })),
    },
  };

  afterEach(() => vi.restoreAllMocks());

  it("codec, adapter outcome and stored snapshot", async () => {
    const wire = bookingWithTicketsWire.parse(answer);
    const booking = bookingFrom(wire);
    const evidence = ticketEvidenceFrom(wire.ticketsDetails, "confirm_response");
    expect(evidence.kind).toBe("issued");
    if (evidence.kind === "issued") expect(evidence.set.tickets().map((t) => t.code)).toEqual(CODES);
    assertClean("booking", booking);
    assertClean("sanitiseBooking (lastResponse)", sanitiseBooking(booking));
    assertClean("evidence", evidence);

    const transport = { confirm: async () => ({ booking, tickets: evidence }) } as unknown as TravelDeskBookingTransport;
    const adapter = new TravelDeskBookingAdapter(transport, { environment: "test" });
    const outcome = await adapter.confirm({ supplierBookingId: "9001", serviceDate: "2027-03-10", offerExternalId: "501" });
    expect(outcome.kind).toBe("accepted");
    assertClean("adapter outcome", outcome);
    if (outcome.kind === "accepted") assertClean("snapshot", outcome.snapshot);
  });

  it("structured events and the logger drop codes, links and Guids whatever a caller passes", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
    vi.spyOn(console, "warn").mockImplementation((l: unknown) => void lines.push(String(l)));
    vi.spyOn(console, "error").mockImplementation((l: unknown) => void lines.push(String(l)));
    const set = new IssuedTicketSet(
      CODES.map((c, i) => ({ unitIndex: i, ticketFor: "adult" as const, ticketTypeId: null, ticketTypeName: null, displayType: 1, code: c, validUntil: null })),
      "confirm_response",
    );
    const hostile = { supplierBookingId: CODES[0], reason: link(CODES[1]), documentId: `Guid=${GUID}`, count: set, status: set, source: String(set) };
    for (const name of Object.keys(STRUCTURED_EVENTS) as (keyof typeof STRUCTURED_EVENTS)[]) {
      assertClean(`structuredFields ${name}`, structuredFields(name, { ...hostile, tickets: set, code: CODES[2] }));
      emitEvent(name, { ...hostile });
    }
    // The free-form logger still redacts ticket and voucher keys and URL query
    // strings; a bare endpoint path left in an error text is not a secret.
    assertClean("redact", redact({ tickets: set, ticketCode: CODES[0], voucherUrl: answer.downloadVoucherUrl, guid: GUID, code: CODES[1], error: `failed at ${link(CODES[2])}` }), SECRETS);
    assertClean("console", lines.join("\n"));
  });

  it("the ticket email carries Outly's capability link only", () => {
    const token = "A".repeat(43);
    const rendered = renderTicketsReady({ firstName: "Synth", orderReference: "OUT-000009", items: [{ title: "Synthetic tour", dateLabel: "10 Mar 2027" }], link: ticketLink("https://outlyy.test", token) });
    assertClean("email", rendered);
    expect(rendered.text).toContain(`https://outlyy.test/t#${token}`);
    expect(rendered.html).not.toMatch(/traveldesk|supabase/i);
  });
});
