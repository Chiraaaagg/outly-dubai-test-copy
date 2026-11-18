import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitEvent, STRUCTURED_EVENTS, structuredFields, type StructuredEventName } from "../structured-events";

/**
 * SEC-18 / PRV-6: allowlisted structured events. Only listed events and
 * listed keys reach the log line, and only code-shaped values survive, so
 * supplier text, contacts, URLs and codes cannot reach a log drain through
 * `emitEvent`. The console is captured: what is asserted is the line that
 * would be written.
 */

let lines: { stream: "log" | "warn" | "error"; entry: Record<string, unknown>; raw: string }[] = [];

beforeEach(() => {
  lines = [];
  for (const stream of ["log", "warn", "error"] as const) {
    vi.spyOn(console, stream).mockImplementation((line: unknown) => {
      lines.push({ stream, entry: JSON.parse(String(line)), raw: String(line) });
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const UUID = "0192f0aa-1234-7abc-8def-0123456789ab";

describe("emitEvent: event allowlist", () => {
  it("drops an unlisted event and writes only `event.unlisted` with the name", () => {
    emitEvent("tickets.leaked" as StructuredEventName, { code: "ABC-123", email: "a@b.co" });
    expect(lines).toHaveLength(1);
    expect(lines[0].stream).toBe("warn");
    expect(lines[0].entry.msg).toBe("event.unlisted");
    expect(lines[0].entry.event).toBe("tickets.leaked");
    expect(Object.keys(lines[0].entry).sort()).toEqual(["event", "level", "msg", "t"]);
    expect(lines[0].raw).not.toMatch(/ABC-123|a@b\.co/);
  });

  it("does not echo an unlisted name that is not itself a code", () => {
    emitEvent("call +971501234567 now" as StructuredEventName, {});
    expect(lines[0].entry).toMatchObject({ msg: "event.unlisted", event: "invalid" });
    expect(lines[0].raw).not.toContain("971501234567");
  });

  it("structuredFields answers null for an unlisted name", () => {
    expect(structuredFields("nope.nope", { a: 1 })).toBeNull();
  });
});

describe("emitEvent: key and value allowlist", () => {
  it("drops keys the event does not list", () => {
    emitEvent("document.served", { documentId: UUID, accessKind: "guest_capability", storageKey: "test/0123456789abcdef0123456789abcdef", leadName: "Asha" });
    expect(lines).toHaveLength(1);
    expect(lines[0].entry).toMatchObject({ msg: "document.served", level: "info", documentId: UUID, accessKind: "guest_capability" });
    expect(Object.keys(lines[0].entry).sort()).toEqual(["accessKind", "documentId", "level", "msg", "t"]);
  });

  it.each([
    ["free text", "The supplier said the guest Asha Rao is not on the list"],
    ["a URL", "https://supplier.example/tickets/abc?sig=123"],
    ["an e-mail address", "asha@example.test"],
    ["an E.164 phone number", "+971501234567"],
    ["a spaced phone number", "+91 99123 45678"],
    ["an object", { code: "ABC" }],
    ["an array", ["a", "b"]],
    ["a string longer than 80 characters", "x".repeat(81)],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an invalid date", new Date("not a date")],
    ["a function", () => "x"],
    ["undefined", undefined],
  ])("drops %s", (_label, value) => {
    emitEvent("notification.failed", { notificationId: UUID, reason: value });
    expect(lines[0].entry).not.toHaveProperty("reason");
    expect(lines[0].entry.notificationId).toBe(UUID);
    if (typeof value === "string") expect(lines[0].raw).not.toContain(value);
  });

  it("keeps codes, UUIDs, numbers, booleans, null and ISO timestamps", () => {
    emitEvent("tickets.pending", { supplierBookingId: UUID, documentId: null, reason: "codes_missing", automatic: true });
    emitEvent("document.attention", { documentId: UUID, supplierBookingId: UUID, reason: "fetch.failed:3", ageMs: 125_000 });
    emitEvent("capability.minted", { grantId: UUID, purpose: "download_tickets", issuedFor: "2026-11-02T10:00:00.123Z" });
    emitEvent("document.fetched", { documentId: UUID, kind: "tickets_pdf", version: 2, byteSize: 0 });
    expect(lines.map((l) => l.entry)).toEqual([
      expect.objectContaining({ supplierBookingId: UUID, documentId: null, reason: "codes_missing", automatic: true }),
      expect.objectContaining({ documentId: UUID, supplierBookingId: UUID, reason: "fetch.failed:3", ageMs: 125_000 }),
      expect.objectContaining({ grantId: UUID, purpose: "download_tickets", issuedFor: "2026-11-02T10:00:00.123Z" }),
      expect.objectContaining({ documentId: UUID, kind: "tickets_pdf", version: 2, byteSize: 0 }),
    ]);
  });

  it("writes a Date as its ISO timestamp and a bigint as a numeric string", () => {
    expect(structuredFields("document.attention", { ageMs: 5n, reason: new Date("2026-11-02T10:00:00Z") })).toEqual({ ageMs: "5", reason: "2026-11-02T10:00:00.000Z" });
  });

  it("joined lists survive as one code", () => {
    emitEvent("privacy.erasure_deferred", { requestId: UUID, obligations: ["future_service", "dispute_window"].join(":") });
    expect(lines[0].entry).toMatchObject({ requestId: UUID, obligations: "future_service:dispute_window" });
  });

  it("writes at the level the caller asks for", () => {
    emitEvent("payments.tick_starved", { pass: "watch", consecutive: 3 }, "error");
    emitEvent("payments.tick_out_of_time", { pass: "live", visited: 1, skipped: 2, consecutive: 1 }, "warn");
    expect(lines.map((l) => [l.stream, l.entry.level, l.entry.msg])).toEqual([
      ["error", "error", "payments.tick_starved"],
      ["warn", "warn", "payments.tick_out_of_time"],
    ]);
  });
});

describe("STRUCTURED_EVENTS", () => {
  it("every key is an identifier, never a name the logger would have to redact", () => {
    for (const [event, keys] of Object.entries(STRUCTURED_EVENTS)) {
      expect(event).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
      for (const k of keys) expect(k, `${event}.${k}`).toMatch(/^[a-z][A-Za-z]*$/);
    }
  });
});
