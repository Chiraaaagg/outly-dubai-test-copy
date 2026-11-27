import { describe, expect, it } from "vitest";
import { formatPhone, maskPhone, normalisePhone } from "../phone";

describe("phone: India (+91)", () => {
  it("normalises a plain 10-digit mobile", () => {
    expect(normalisePhone("9876543210", "+91")).toEqual({ e164: "+919876543210", countryCode: "+91", national: "9876543210", valid: true });
  });

  it("strips spaces, dashes and a trunk zero", () => {
    expect(normalisePhone("098765 43210", "+91").e164).toBe("+919876543210");
    expect(normalisePhone("98765-43210", "+91").e164).toBe("+919876543210");
  });

  it("accepts the country code typed into the national field", () => {
    expect(normalisePhone("919876543210", "+91").e164).toBe("+919876543210");
    expect(normalisePhone("+91 98765 43210", "+91").e164).toBe("+919876543210");
    expect(normalisePhone("0091 98765 43210", "+91").e164).toBe("+919876543210");
  });

  it("defaults the country code to +91 and tolerates a missing plus", () => {
    expect(normalisePhone("9876543210").countryCode).toBe("+91");
    expect(normalisePhone("9876543210", "91").e164).toBe("+919876543210");
  });

  it("rejects wrong lengths and landline-style leading digits", () => {
    expect(normalisePhone("987654321", "+91").valid).toBe(false);
    expect(normalisePhone("98765432101", "+91").valid).toBe(false);
    expect(normalisePhone("1234567890", "+91").valid).toBe(false);
    expect(normalisePhone("5876543210", "+91").valid).toBe(false);
  });

  it("does not strip a country code prefix that is part of a 10-digit number", () => {
    // 91xxxxxxxx (10 digits starting with 91) is a valid Indian mobile, not +91 + 8 digits.
    const r = normalisePhone("9198765432", "+91");
    expect(r.e164).toBe("+919198765432");
    expect(r.valid).toBe(true);
  });
});

describe("phone: UAE (+971)", () => {
  it("normalises a 9-digit mobile with or without the trunk zero", () => {
    expect(normalisePhone("501234567", "+971")).toMatchObject({ e164: "+971501234567", valid: true });
    expect(normalisePhone("0501234567", "+971").e164).toBe("+971501234567");
    expect(normalisePhone("+971 50 123 4567").e164).toBe("+971501234567");
  });

  it("detects +971 from the number even when +91 was selected", () => {
    const r = normalisePhone("+971501234567", "+91");
    expect(r.countryCode).toBe("+971");
    expect(r.valid).toBe(true);
  });

  it("rejects non-mobile prefixes and wrong lengths", () => {
    expect(normalisePhone("41234567", "+971").valid).toBe(false);
    expect(normalisePhone("5012345678", "+971").valid).toBe(false);
  });
});

describe("phone: other countries", () => {
  it("accepts a plausible E.164 number with an unknown country code", () => {
    const r = normalisePhone("+447911123456");
    expect(r.e164).toBe("+447911123456");
    expect(r.valid).toBe(true);
  });

  it("rejects implausible international lengths", () => {
    expect(normalisePhone("+1234").valid).toBe(false);
    expect(normalisePhone("+1234567890123456").valid).toBe(false);
  });

  it("applies a loose length rule for a selected unknown country code", () => {
    expect(normalisePhone("12345", "+1").valid).toBe(false);
    expect(normalisePhone("2125551234", "+1")).toMatchObject({ e164: "+12125551234", valid: true });
  });
});

describe("phone: display helpers", () => {
  it("formats Indian and UAE numbers for agents", () => {
    expect(formatPhone("+919876543210")).toBe("+91 98765 43210");
    expect(formatPhone("+971501234567")).toBe("+971 50 123 4567");
    expect(formatPhone("+447911123456")).toBe("+447911123456");
  });

  it("masks everything but the full country code and the last four digits, in display groups", () => {
    expect(maskPhone("+919876543210")).toBe("+91 ••••• •3210");
    expect(maskPhone("+971501234567")).toBe("+971 •• ••• 4567");
    expect(maskPhone("+919876543210")).not.toContain("98765");
  });

  it("masks odd lengths and unknown codes without showing more than the last four digits", () => {
    expect(maskPhone("+97150123456")).toBe("+971 •••• 3456"); // 8-digit UAE national
    expect(maskPhone("+9198765432101")).toBe("+91 ••••••• 2101"); // 11-digit Indian national
    expect(maskPhone("+447911123456")).toBe("+•••••••• 3456");
    expect(maskPhone("+9715012")).toBe("+971 ••••"); // four or fewer national digits: none shown
    expect(maskPhone("+971")).toBe("+•••");
    expect(maskPhone("")).toBe("•••");
    for (const n of ["+919876543210", "+971501234567", "+97150123456", "+9198765432101", "+447911123456", "+12025550143"]) {
      const shownDigits = maskPhone(n).replace(/^\+(91|971) /, "").replace(/\D/g, "");
      expect(shownDigits.length).toBeLessThanOrEqual(4);
      expect(n.endsWith(shownDigits)).toBe(true);
    }
  });
});

describe("phone: customer-facing reasons (audit S10)", () => {
  it("explains an 11-digit Indian number", () => {
    const r = normalisePhone("79900000000", "+91");
    expect(r.valid).toBe(false);
    expect(r.reason).toBe("Indian mobile numbers have 10 digits. You entered 11 digits.");
  });
  it("explains a bad first digit", () => {
    const r = normalisePhone("1234567890", "+91");
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/start with 6, 7, 8 or 9/);
  });
  it("accepts a valid Indian number typed with a trunk zero", () => {
    const r = normalisePhone("07900000000", "+91");
    expect(r.valid).toBe(true);
    expect(r.e164).toBe("+917900000000");
    expect(r.reason).toBeUndefined();
  });
  it("explains a short UAE number", () => {
    const r = normalisePhone("5012345", "+971");
    expect(r.reason).toBe("UAE mobile numbers have 9 digits. You entered 7 digits.");
  });
});
