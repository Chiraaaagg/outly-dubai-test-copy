import { describe, expect, it } from "vitest";
import { recoveryContact, validateRecovery, type RecoveryInput } from "../recovery";

/** Shape checks for the recovery form (F23). Synthetic references and contacts only. */

const base: RecoveryInput = { reference: "OUT-123455", channel: "phone", countryCode: "+91", phone: "9876543210", email: "" };

describe("recovery form rules", () => {
  it("accepts a valid reference and phone and builds an E.164 contact", () => {
    expect(validateRecovery(base)).toEqual({});
    expect(recoveryContact({ ...base, reference: " out-123455 " })).toEqual({ reference: "OUT-123455", channel: "phone", contact: "+919876543210" });
  });

  it("lower-cases and trims an email contact", () => {
    const input = { ...base, channel: "email" as const, email: "  Synthetic.Person@Example.test " };
    expect(validateRecovery(input)).toEqual({});
    expect(recoveryContact(input)).toEqual({ reference: "OUT-123455", channel: "email", contact: "synthetic.person@example.test" });
  });

  it("names each invalid field without saying whether a booking exists", () => {
    const errors = validateRecovery({ ...base, reference: "OUT-123456", phone: "123" });
    expect(Object.keys(errors).sort()).toEqual(["phone", "reference"]);
    expect(errors.reference).toMatch(/Check the reference/);
    expect(validateRecovery({ ...base, reference: "" }).reference).toMatch(/Enter the booking reference/);
    expect(validateRecovery({ ...base, channel: "email", email: "nope" }).email).toMatch(/email/);
    expect(recoveryContact({ ...base, phone: "" })).toBeNull();
  });
});
