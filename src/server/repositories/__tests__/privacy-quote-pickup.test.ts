import { describe, expect, it } from "vitest";
import { clearPickupHotelNames } from "../privacy.repo";

/**
 * Erasure clears the pickup hotel name a quote keeps in its lines (Batch 3,
 * review B3-M1). The database run of the whole erasure is in
 * services/__tests__/privacy.erasure.test.ts.
 */
describe("clearPickupHotelNames", () => {
  it("clears every line's pickup hotel name and keeps the rest of the line, the hotel id included", () => {
    const lines = [
      { index: 0, chargedMinor: "1000", pickup: { hotelRef: "42", hotelName: "zz Example Marina Hotel" } },
      { index: 1, chargedMinor: "500", pickup: null },
      { index: 2, pickup: { hotelRef: "43", hotelName: "zz Example Creek Hotel" } },
    ];
    expect(clearPickupHotelNames(lines)).toEqual([
      { index: 0, chargedMinor: "1000", pickup: { hotelRef: "42", hotelName: null } },
      { index: 1, chargedMinor: "500", pickup: null },
      { index: 2, pickup: { hotelRef: "43", hotelName: null } },
    ]);
    // The input is not changed in place.
    expect(lines[0].pickup).toEqual({ hotelRef: "42", hotelName: "zz Example Marina Hotel" });
  });

  it("is null when there is nothing to clear, so the quote is not rewritten", () => {
    expect(clearPickupHotelNames([])).toBeNull();
    expect(clearPickupHotelNames([{ index: 0, pickup: null }, { index: 1 }])).toBeNull();
    expect(clearPickupHotelNames([{ index: 0, pickup: { hotelRef: "42", hotelName: null } }, { index: 1, pickup: { hotelRef: "43" } }])).toBeNull();
    expect(clearPickupHotelNames(null)).toBeNull();
    expect(clearPickupHotelNames({ lines: [] })).toBeNull();
  });
});
