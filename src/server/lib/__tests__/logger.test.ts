import { describe, expect, it } from "vitest";
import { redact, scrubText } from "../logger";

/** Mercury finding: key-based redaction let PII through inside error texts. */
describe("logger redaction of error texts", () => {
  const pg = 'new row for relation "inquiries" violates check constraint "x"\nFailing row contains (0192, +919912345678, Asha Rao, asha@example.test, Hotel).';

  it("scrubs Postgres row dumps, key values, emails and phone numbers", () => {
    const out = scrubText(pg + '\nKey (lead_phone)=(+919912345678) already exists.');
    expect(out).not.toMatch(/919912345678|Asha|asha@example/);
    expect(out).toContain("Failing row contains ([redacted])");
    expect(out).toContain("Key (lead_phone)=([redacted])");
  });

  it("applies to Error objects and error-like string fields, not to ordinary fields", () => {
    const fields = redact({ error: new Error(pg), message: "sent to +91 99123 45678", processingError: "user a@b.co failed", batchId: "0192f0aa-1234", count: 3 });
    const text = JSON.stringify(fields);
    expect(text).not.toMatch(/919912345678|99123 45678|Asha|a@b\.co/);
    expect(fields.batchId).toBe("0192f0aa-1234");
    expect(fields.count).toBe(3);
  });

  it("covers row values containing brackets, other phone spellings and camelCase keys", () => {
    const out = scrubText("Failing row contains (1, +919912345678, Asha (Rao), Palm Hotel (Deira), x@y.co).");
    expect(out).not.toMatch(/Asha|Rao|Palm|Deira|x@y/);
    for (const phone of ["+971 (50) 123 4567", "971.50.123.4567", "+91 99123-45678"]) expect(scrubText(`call ${phone} now`), phone).toBe("call [number] now");
    const fields = redact({ errorMessage: "user +919912345678", msg: "a@b.co" });
    expect(JSON.stringify(fields)).not.toMatch(/919912345678|a@b\.co/);
  });

  it("leaves dates, ISO timestamps and short numbers readable", () => {
    expect(scrubText("ran at 2026-10-25T10:00:00Z for 2026-10-25, 42 rows, version 17")).toBe("ran at 2026-10-25T10:00:00Z for 2026-10-25, 42 rows, version 17");
  });

  it("keeps ordinary error messages readable", () => {
    expect(scrubText("Version 3 of zz-test is missing — cannot revert")).toBe("Version 3 of zz-test is missing — cannot revert");
  });
});

/** SEC-11: supplier, ticket and payment material, at any depth. */
describe("logger redaction of supplier, ticket and payment keys", () => {
  const SECRET = "zz-secret-value";
  const leaks = (v: unknown) => JSON.stringify(v).includes(SECRET);

  it.each([
    "guid",
    "bookingGuid",
    "code",
    "ticket",
    "tickets",
    "ticketCode",
    "ticket_pdf",
    "voucher",
    "voucherUrl",
    "voucherNumber",
    "url",
    "downloadUrl",
    "image_url",
    "TRAVELDESK_API_BASE_URL",
    "bearer",
    "bearerToken",
    "vpa",
    "payerVpa",
    "utr",
    "bankUtr",
    "signature",
    "x-hub-signature-256",
    "capability",
    "ticketCapability",
    "guestName",
    "guestname",
    "phone",
    "guestPhone",
    "bookingCode",
    "confirmationCode",
  ])("redacts %s", (key) => {
    const out = redact({ [key]: SECRET });
    expect(out[key]).toBe("[redacted]");
  });

  it("keeps error, status and country codes readable (code is an exact match only)", () => {
    const out = redact({ errorCode: "TD_TIMEOUT", statusCode: 504, countryCode: "IN", supplierCode: "traveldesk", currencyCode: "AED" });
    expect(out).toEqual({ errorCode: "TD_TIMEOUT", statusCode: 504, countryCode: "IN", supplierCode: "traveldesk", currencyCode: "AED" });
  });

  it("keeps a boolean signature check readable", () => {
    expect(redact({ signatureValid: false, signature: SECRET })).toEqual({ signatureValid: false, signature: "[redacted]" });
  });

  it("redacts inside nested objects and arrays", () => {
    const payload = {
      booking: {
        id: "b-1",
        supplier: { response: { Guid: SECRET, Tickets: [{ Code: SECRET, Url: SECRET }], Voucher: { link: SECRET } } },
        guests: [{ guestName: SECRET, phone: SECRET }],
        payment: { method: { upi: { vpa: SECRET } }, utr: SECRET },
      },
      headers: { authorization: SECRET, "x-hub-signature-256": SECRET },
    };
    const out = redact(payload);
    expect(leaks(out)).toBe(false);
    expect(out.booking.id).toBe("b-1");
  });

  it("never passes an object through below the depth limit", () => {
    let deep: Record<string, unknown> = { harmless: { note: SECRET } };
    for (let i = 0; i < 12; i++) deep = { level: deep };
    const out = JSON.stringify(redact(deep));
    expect(out).not.toContain(SECRET);
    expect(out).toContain("[truncated]");
  });

  it("keeps scalars at the depth limit and the existing keys' behaviour", () => {
    const out = redact({ a: { b: { c: { d: { e: { f: 7 } } } } }, email: "a@b.co", count: 2 });
    expect(out.a.b.c.d.e.f).toBe(7);
    expect(out.email).toBe("[redacted]");
    expect(out.count).toBe(2);
  });

  it("scrubs query strings from URLs inside error texts", () => {
    const out = scrubText("GET https://api.example.test/v1/voucher/download?token=abc123&id=9 failed with 500");
    expect(out).toBe("GET https://api.example.test/v1/voucher/download?[redacted] failed with 500");
  });
});
