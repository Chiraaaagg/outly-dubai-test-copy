import { describe, expect, it } from "vitest";
import { decimalToMinor, minorToDecimalString } from "../decimal";

describe("decimalToMinor", () => {
  it("converts integers and exact two-decimal amounts without rounding", () => {
    expect(decimalToMinor(0)).toEqual({ minor: 0n, rounded: false });
    expect(decimalToMinor(170)).toEqual({ minor: 17000n, rounded: false });
    expect(decimalToMinor(170.5)).toEqual({ minor: 17050n, rounded: false });
    expect(decimalToMinor(0.1)).toEqual({ minor: 10n, rounded: false });
    expect(decimalToMinor(0.29)).toEqual({ minor: 29n, rounded: false }); // 0.29 * 100 = 28.999999999999996 in floats
    expect(decimalToMinor(1.15)).toEqual({ minor: 115n, rounded: false }); // Math.round(1.15 * 100) = 114 or 115 depending on luck
    expect(decimalToMinor("45.00")).toEqual({ minor: 4500n, rounded: false });
    expect(decimalToMinor("45.000")).toEqual({ minor: 4500n, rounded: false }); // trailing zeros are not precision loss
  });

  it("rounds half-up beyond two decimals and flags it", () => {
    expect(decimalToMinor(99.995)).toEqual({ minor: 10000n, rounded: true });
    expect(decimalToMinor(99.999)).toEqual({ minor: 10000n, rounded: true });
    expect(decimalToMinor(0.005)).toEqual({ minor: 1n, rounded: true });
    expect(decimalToMinor(0.0049)).toEqual({ minor: 0n, rounded: true });
    expect(decimalToMinor(1.004)).toEqual({ minor: 100n, rounded: true });
    expect(decimalToMinor(123.456)).toEqual({ minor: 12346n, rounded: true });
    expect(decimalToMinor("2.675")).toEqual({ minor: 268n, rounded: true }); // (2.675).toFixed(2) === "2.67"
  });

  it("rounds negatives half-up on the magnitude and never yields a signed zero", () => {
    expect(decimalToMinor(-12.5)).toEqual({ minor: -1250n, rounded: false });
    expect(decimalToMinor(-1.005)).toEqual({ minor: -101n, rounded: true });
    expect(decimalToMinor(-1.004)).toEqual({ minor: -100n, rounded: true });
    expect(decimalToMinor(-0.004)).toEqual({ minor: 0n, rounded: true });
    expect(decimalToMinor("-0")).toEqual({ minor: 0n, rounded: false });
  });

  it("expands exponent forms from numbers and strings", () => {
    expect(String(1e-7)).toBe("1e-7");
    expect(decimalToMinor(1e-7)).toEqual({ minor: 0n, rounded: true });
    expect(decimalToMinor("1e-7")).toEqual({ minor: 0n, rounded: true });
    expect(decimalToMinor("5e-3")).toEqual({ minor: 1n, rounded: true });
    expect(String(2e21)).toBe("2e+21");
    expect(decimalToMinor(2e21)).toEqual({ minor: 2n * 10n ** 23n, rounded: false });
    expect(decimalToMinor("2e21")).toEqual({ minor: 2n * 10n ** 23n, rounded: false });
    expect(decimalToMinor("1.5E3")).toEqual({ minor: 150000n, rounded: false });
    expect(decimalToMinor("-1.5e2")).toEqual({ minor: -15000n, rounded: false });
    expect(decimalToMinor("12.34e-1")).toEqual({ minor: 123n, rounded: true });
  });

  it("trims surrounding whitespace on strings", () => {
    expect(decimalToMinor("  12.50 ")).toEqual({ minor: 1250n, rounded: false });
    expect(decimalToMinor("\t7\n")).toEqual({ minor: 700n, rounded: false });
  });

  it("throws on NaN, Infinity and garbage", () => {
    expect(() => decimalToMinor(Number.NaN)).toThrow(/non-finite/);
    expect(() => decimalToMinor(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => decimalToMinor(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/);
    for (const bad of ["", " ", "NaN", "Infinity", "abc", "1,000", "12.3.4", "0x10", "1e", "12 50", "AED 10", ".5", "5."]) {
      expect(() => decimalToMinor(bad), bad).toThrow(/unparseable/);
    }
  });
});

describe("minorToDecimalString", () => {
  it("formats with exactly two decimals", () => {
    expect(minorToDecimalString(17050n)).toBe("170.50");
    expect(minorToDecimalString(0n)).toBe("0.00");
    expect(minorToDecimalString(5n)).toBe("0.05");
    expect(minorToDecimalString(-5n)).toBe("-0.05");
    expect(minorToDecimalString(-123456n)).toBe("-1234.56");
  });

  it("round-trips through decimalToMinor", () => {
    for (const minor of [0n, 1n, 99n, 100n, 10001n, 17050n, -1n, -250n, 2n * 10n ** 23n]) {
      expect(decimalToMinor(minorToDecimalString(minor))).toEqual({ minor, rounded: false });
    }
  });
});
