import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { quoteLinesFor } from "@/lib/api";
import {
  cartHotelOptions,
  hotelForInquiry,
  initialCartHotel,
  itemHotelField,
  pickupErrors,
  pickupItemsFor,
  pickupPlan,
  pickupUpdates,
  type ListState,
} from "@/lib/pickup-selection";
import type { Activity, CartItem } from "@/lib/types";

/**
 * Hotel pickup at checkout (doc 29 §7.3 Batch 3; owner decision §8.4 row 11):
 * one hotel for the cart, a per-activity choice only where that activity's
 * list lacks it; the quote sends the TravelDesk id, never a typed name; the
 * hotel reaches the inquiry form, never a URL. Synthetic hotels only.
 */

const P1 = "0190a000-0000-7000-8000-000000000001";
const P2 = "0190a000-0000-7000-8000-000000000002";

function activity(slug: string, productId: string, pickupIncluded = true): Activity {
  return { slug, productId, pickupIncluded, variants: [{ id: "shared", name: "Shared" }] } as unknown as Activity;
}

function item(id: string, slug: string, over: Partial<CartItem> = {}): CartItem {
  return {
    id,
    kind: "activity",
    slug,
    title: `Trip ${id}`,
    image: "",
    date: "2026-12-01",
    time: "09:00",
    pax: { adult: 2, child: 0, infant: 0, senior: 0 },
    addOnIds: [],
    unit: { inr: 0, aed: 0 },
    total: { inr: 0, aed: 0 },
    confirmation: "instant",
    fulfilmentMode: "instant",
    freeCancellationHours: 24,
    durationMinutes: 60,
    ...over,
  } as CartItem;
}

const MARINA = { id: "42", name: "Example Marina Hotel", area: "Dubai Marina" };
const CREEK = { id: "43", name: "Example Creek Hotel", area: "Deira" };
const PALM = { id: "77", name: "Example Palm Resort", area: "Palm Jumeirah" };
const ready = (...hotels: (typeof MARINA)[]): ListState => ({ status: "ready", hotels });

const activities = [activity("desert", P1), activity("cruise", P2), activity("museum", "0190a000-0000-7000-8000-000000000003", false)];

describe("pickup lines in the cart", () => {
  it("only activities with pickup and a priced variant need a hotel", () => {
    const items = pickupItemsFor([item("a", "desert"), item("b", "museum"), item("c", "cruise")], activities);
    expect(items.map((i) => [i.itemId, i.listKey])).toEqual([
      ["a", `${P1}:shared`],
      ["c", `${P2}:shared`],
    ]);
  });
});

describe("one hotel for the cart; per activity only when its list lacks it", () => {
  const cart = [item("a", "desert"), item("c", "cruise")];
  const items = pickupItemsFor(cart, activities);

  it("same list: the cart hotel serves both lines, and both lines carry it", () => {
    const lists = new Map([[`${P1}:shared`, ready(MARINA, CREEK)], [`${P2}:shared`, ready(MARINA, CREEK)]]);
    const plan = pickupPlan(items, lists, { hotelId: "42", name: MARINA.name });
    expect(plan.map((r) => [r.status.kind, r.hotel?.hotelId])).toEqual([
      ["cart", "42"],
      ["cart", "42"],
    ]);
    expect(pickupErrors(plan)).toEqual({});
    expect(pickupUpdates(plan)).toEqual([
      { itemId: "a", pickupHotel: { hotelId: "42", name: MARINA.name } },
      { itemId: "c", pickupHotel: { hotelId: "42", name: MARINA.name } },
    ]);
  });

  it("different lists: the line whose list lacks the cart hotel asks for its own, and only that line", () => {
    const lists = new Map([[`${P1}:shared`, ready(MARINA)], [`${P2}:shared`, ready(PALM)]]);
    const plan = pickupPlan(items, lists, { hotelId: "42", name: MARINA.name });
    expect(plan.map((r) => r.status.kind)).toEqual(["cart", "own"]);
    expect(pickupErrors(plan)).toEqual({ [itemHotelField("c")]: "Choose a pickup hotel for Trip c." });
    // Its own choice, once made, is kept while it is on its own list.
    const chosen = pickupItemsFor([cart[0], { ...cart[1], pickupHotel: { hotelId: "77", name: PALM.name } }], activities);
    const next = pickupPlan(chosen, lists, { hotelId: "42", name: MARINA.name });
    expect(next.map((r) => r.hotel?.hotelId)).toEqual(["42", "77"]);
    expect(pickupErrors(next)).toEqual({});
  });

  it("the cart field offers every hotel any pickup line collects from, once, by name", () => {
    expect(cartHotelOptions([ready(MARINA, CREEK), ready(MARINA, PALM), { status: "loading" }]).map((h) => h.id)).toEqual(["43", "42", "77"]);
  });

  it("no hotel yet, a list still loading, or a list that cannot be read stops the details step with a reason", () => {
    const both = new Map([[`${P1}:shared`, ready(MARINA)], [`${P2}:shared`, ready(MARINA)]]);
    expect(pickupErrors(pickupPlan(items, both, null))).toEqual({ hotel: "Choose the hotel the operator collects you from." });
    expect(pickupErrors(pickupPlan(items, new Map([[`${P1}:shared`, ready(MARINA)]]), null)).hotel).toMatch(/still loading/);
    const broken = new Map<string, ListState>([[`${P1}:shared`, ready(MARINA)], [`${P2}:shared`, { status: "unavailable" }]]);
    expect(pickupErrors(pickupPlan(items, broken, { hotelId: "42", name: MARINA.name })).hotel).toMatch(/can't load/);
    // An empty list is as good as none.
    expect(pickupPlan(items, new Map([[`${P1}:shared`, ready()]]), null)[0].status.kind).toBe("unavailable");
  });

  it("a kept choice comes back as the cart hotel; lines still loading are left alone", () => {
    const kept = pickupItemsFor([item("a", "desert", { pickupHotel: { hotelId: "42", name: MARINA.name } }), item("c", "cruise")], activities);
    expect(initialCartHotel(kept)).toEqual({ hotelId: "42", name: MARINA.name });
    expect(pickupUpdates(pickupPlan(kept, new Map(), { hotelId: "42", name: MARINA.name }))).toEqual([]);
  });
});

describe("the quote sends the TravelDesk id, never a typed name (Batch 3)", () => {
  const acts = [{ ...activity("desert", P1), timeSlots: ["09:00"] } as unknown as Activity, activity("museum", P2, false)];

  it("a chosen hotel is sent as its id; a typed one, or none, sends no pickup", () => {
    const lines = quoteLinesFor(
      [
        item("a", "desert", { pickupHotel: { hotelId: "42", name: MARINA.name } }),
        item("b", "desert", { date: "2026-12-02", pickupHotel: { hotelId: null, name: "A hotel I typed" } }),
        item("c", "desert", { date: "2026-12-03" }),
        item("d", "museum", { pickupHotel: { hotelId: "42", name: MARINA.name } }),
      ],
      acts,
    );
    expect(lines?.map((l) => l.pickup)).toEqual([{ hotelRef: "42" }, null, null, null]);
  });
});

describe("the hotel goes to the inquiry form, never the URL", () => {
  it("the inquiry form starts from the first pickup line's hotel name", () => {
    expect(hotelForInquiry([item("a", "museum"), item("b", "desert", { pickupHotel: { hotelId: null, name: "A hotel I typed" } })])).toBe("A hotel I typed");
    expect(hotelForInquiry([item("a", "museum")])).toBe("");
  });

  it("the hand-off URL carries only the rule code", async () => {
    const { inquiryHref } = await import("@/lib/inquiry-handoff");
    expect(inquiryHref("pickup")).toBe("/inquiry?from=checkout&reason=pickup");
    const page = readFileSync(join(process.cwd(), "src/app/checkout/page.tsx"), "utf8");
    // The pickup hand-off pushes the fixed href; the hotel is written to the cart line first.
    expect(page).toContain('router.push(inquiryHref("pickup"))');
    expect(page).not.toMatch(/inquiryHref\([^)]*hotel/i);
    const form = readFileSync(join(process.cwd(), "src/components/commerce/inquiry-form.tsx"), "utf8");
    expect(form).toContain("useState(() => hotelForInquiry(items))");
  });
});
