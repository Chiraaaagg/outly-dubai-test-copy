import { describe, expect, it } from "vitest";
import { supplierGuestName, SUPPLIER_GUEST_NAME_MAX } from "../guest-name";

describe("supplierGuestName (TravelDesk: Latin letters and spaces only)", () => {
  it("keeps plain Latin names, collapsing spaces", () => {
    expect(supplierGuestName("  John   Smith ")).toBe("John Smith");
  });

  it("removes accents and spells out letters without a decomposition", () => {
    expect(supplierGuestName("José García")).toBe("Jose Garcia");
    expect(supplierGuestName("Zoë Ñúñez")).toBe("Zoe Nunez");
    expect(supplierGuestName("Nguyễn Văn An")).toBe("Nguyen Van An");
    expect(supplierGuestName("İlker Şahin")).toBe("Ilker Sahin");
    expect(supplierGuestName("Ø. Jørgensen")).toBe("O Jorgensen");
    expect(supplierGuestName("Łukasz Straße")).toBe("Lukasz Strasse");
    expect(supplierGuestName("Æsa Œuvre")).toBe("AEsa OEuvre");
  });

  it("drops apostrophes and turns other punctuation and digits into spaces", () => {
    expect(supplierGuestName("Anne-Marie O'Brien")).toBe("Anne Marie OBrien");
    expect(supplierGuestName("D’Souza")).toBe("DSouza");
    expect(supplierGuestName("Hawaiʼi Kealoha")).toBe("Hawaii Kealoha");
    expect(supplierGuestName("Dr. A.B. Khan Jr. 2")).toBe("Dr A B Khan Jr");
    for (const out of ["Anne-Marie O'Brien", "Dr. A.B. Khan Jr. 2"].map(supplierGuestName)) expect(out).toMatch(/^[A-Za-z ]+$/);
  });

  it("refuses names in another script instead of cutting them down", () => {
    expect(supplierGuestName("राहुल शर्मा")).toBeNull();
    expect(supplierGuestName("محمد علي")).toBeNull();
    expect(supplierGuestName("John 李")).toBeNull();
    expect(supplierGuestName("Дмитрий")).toBeNull();
  });

  it("refuses names with fewer than two Latin letters or over the length cap", () => {
    expect(supplierGuestName("X")).toBeNull();
    expect(supplierGuestName("- . 12")).toBeNull();
    expect(supplierGuestName("")).toBeNull();
    expect(supplierGuestName("a".repeat(SUPPLIER_GUEST_NAME_MAX))).toBe("a".repeat(SUPPLIER_GUEST_NAME_MAX));
    expect(supplierGuestName("a".repeat(SUPPLIER_GUEST_NAME_MAX + 1))).toBeNull();
  });
});

describe("buildBookingRequest guest name", () => {
  const base = { offerId: 501, serviceDate: "2026-11-20", adults: 2, children: 0, infants: 0, clientRef: "OUTTD-NAME1", totalCostMinor: 24_000n, totalCostUsdMinor: 6_600n };

  it("sends the supplier-safe form and refuses a name without one", async () => {
    const { buildBookingRequest } = await import("../../server/suppliers/traveldesk/traveldesk.booking");
    expect(buildBookingRequest({ ...base, guestName: " José O'Brien-Núñez " }).guestName).toBe("Jose OBrien Nunez");
    expect(() => buildBookingRequest({ ...base, guestName: "राहुल शर्मा" })).toThrow(/Latin letters/);
  });
});
