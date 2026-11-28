import { describe, expect, it } from "vitest";
import type { IssuedTicket } from "../contracts";
import { isCompleteTicketSet, ticketTypeKey } from "../ticket-completeness";

/** Labels only: completeness never reads a code. */
type Labels = Pick<IssuedTicket, "ticketFor" | "ticketTypeId" | "ticketTypeName">;
const code = (ticketFor: IssuedTicket["ticketFor"], ticketTypeId: string | null, ticketTypeName: string | null = null): Labels => ({ ticketFor, ticketTypeId, ticketTypeName });
const many = (n: number, l: Labels) => Array.from({ length: n }, () => l);
const guests = (adult: number, child = 0, infant = 0) => ({ adult, child, infant });

describe("ticket set completeness per ticket type (TKT-2, doc 29 §8.6)", () => {
  it("a single type is complete with exactly one code per booked guest, as before", () => {
    const a = code("adult", "11", "Admission");
    const c = code("child", "11", "Admission");
    expect(isCompleteTicketSet(guests(2, 1), [a, a, c])).toBe(true);
    expect(isCompleteTicketSet(guests(2, 1), [a, a])).toBe(false);
    expect(isCompleteTicketSet(guests(2, 1), [a, a, a, c])).toBe(false);
    expect(isCompleteTicketSet(guests(2), [a, a, c])).toBe(false);
    // No type labels at all: one untyped group, the same rule.
    expect(isCompleteTicketSet(guests(2), many(2, code("adult", null)))).toBe(true);
  });

  it("a two-type combo is complete with one code per guest for each type", () => {
    const set = [...many(2, code("adult", "21", "Garden A")), code("child", "21", "Garden A"), ...many(2, code("adult", "22", "Garden B")), code("child", "22", "Garden B")];
    expect(isCompleteTicketSet(guests(2, 1), set)).toBe(true);
    // The total alone (6 codes for 3 guests) is not the rule: each type is checked on its own.
    expect(isCompleteTicketSet(guests(4, 2), set)).toBe(false);
  });

  it("a combo with one type short, or one type over, is incomplete", () => {
    const gardenA = [...many(2, code("adult", "21")), code("child", "21")];
    expect(isCompleteTicketSet(guests(2, 1), [...gardenA, ...many(2, code("adult", "22"))])).toBe(false);
    expect(isCompleteTicketSet(guests(2, 1), [...gardenA, ...many(3, code("adult", "22")), code("child", "22")])).toBe(false);
    // A second type's codes cannot make up for the first type's missing child.
    expect(isCompleteTicketSet(guests(2, 1), [...many(2, code("adult", "21")), ...many(2, code("adult", "22")), code("child", "22"), code("child", "22")])).toBe(false);
  });

  it("external codes with no type id are grouped by the supplier's product name", () => {
    expect(ticketTypeKey(code("adult", null, "Park X"))).toBe("name:Park X");
    expect(ticketTypeKey(code("adult", "7", "Park X"))).toBe("id:7");
    const external = [...many(2, code("adult", null, "Park X")), ...many(2, code("adult", null, "Park Y"))];
    expect(isCompleteTicketSet(guests(2), external)).toBe(true);
    expect(isCompleteTicketSet(guests(2), [...many(2, code("adult", null, "Park X")), code("adult", null, "Park Y")])).toBe(false);
  });

  it("shared adult and child stock (isSameTicketForAdultAndChild) still needs one code per guest in its category", () => {
    // One shared pool on the stock side; the issued codes are still labelled adult or child per guest.
    const shared = [code("adult", "31", "Entry"), code("adult", "31", "Entry"), code("child", "31", "Entry")];
    expect(isCompleteTicketSet(guests(2, 1), shared)).toBe(true);
    // Three adult codes for two adults and a child do not match the categories: held (fail closed).
    expect(isCompleteTicketSet(guests(2, 1), many(3, code("adult", "31", "Entry")))).toBe(false);
  });

  it("infants are checked only for a type that tickets them; unknown categories never count", () => {
    const adults = many(2, code("adult", "41"));
    expect(isCompleteTicketSet(guests(2, 0, 1), adults)).toBe(true);
    expect(isCompleteTicketSet(guests(2, 0, 1), [...adults, code("infant", "41")])).toBe(true);
    expect(isCompleteTicketSet(guests(2, 0, 2), [...adults, code("infant", "41")])).toBe(false);
    expect(isCompleteTicketSet(guests(2, 0, 0), [...adults, code("infant", "41")])).toBe(false);
    expect(isCompleteTicketSet(guests(2), [...adults, code("unknown", "41"), code("unknown", "99")])).toBe(true);
    expect(isCompleteTicketSet(guests(2), [code("adult", "41"), code("unknown", "41")])).toBe(false);
    expect(isCompleteTicketSet(guests(1), [code("unknown", "41")])).toBe(false);
  });
});
