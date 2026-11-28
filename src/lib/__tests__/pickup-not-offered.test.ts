import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPickupHotelCache, fetchPickupHotels } from "@/lib/api/pickup-hotels";
import { PickupHotelFields } from "@/components/checkout/pickup-hotel-fields";
import {
  cartHotelOptions,
  itemHotelField,
  listsForItems,
  mergeRefusedHotels,
  pickupErrors,
  pickupItemsFor,
  pickupPlan,
  pickupUpdates,
  refusedPickupHotels,
  withoutRefusedHotels,
  type ListState,
} from "@/lib/pickup-selection";
import type { Activity, CartItem } from "@/lib/types";

/**
 * Pickup not offered online (review 83 L7) and refused hotels (L8). The
 * server's `not_offered` is its own state: kept like a list, inquiry-only copy,
 * no "Try again". A hotel the quote refused is no longer offered on the page,
 * so "Choose another hotel" cannot loop. Synthetic hotels only.
 */

const P1 = "0190a000-0000-7000-8000-000000000001";
const P2 = "0190a000-0000-7000-8000-000000000002";
const MARINA = { id: "42", name: "Example Marina Hotel", area: "Dubai Marina" };
const CREEK = { id: "43", name: "Example Creek Hotel", area: "Deira" };
const ready = (...hotels: (typeof MARINA)[]): ListState => ({ status: "ready", hotels });

const activity = (slug: string, productId: string) => ({ slug, productId, pickupIncluded: true, variants: [{ id: "shared", name: "Shared" }] }) as unknown as Activity;
const item = (id: string, slug: string, over: Partial<CartItem> = {}) => ({ id, kind: "activity", slug, title: `Trip ${id}`, ...over }) as CartItem;
const activities = [activity("desert", P1), activity("cruise", P2)];

afterEach(() => {
  vi.unstubAllGlobals();
  clearPickupHotelCache();
});

describe("the client keeps not_offered apart from a failed read", () => {
  it("`not_offered` is its own state and is kept; `unavailable` is asked again", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, reason: "not_offered" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchPickupHotels(P1, "shared", 1_000)).toEqual({ status: "not_offered" });
    expect(await fetchPickupHotels(P1, "shared", 2_000)).toEqual({ status: "not_offered" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: false, reason: "unavailable" }), { status: 200 }));
    expect(await fetchPickupHotels(P2, "shared", 1_000)).toEqual({ status: "unavailable" });
    expect(await fetchPickupHotels(P2, "shared", 2_000)).toEqual({ status: "unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("the plan and the details step", () => {
  const items = pickupItemsFor([item("a", "desert"), item("c", "cruise")], activities);

  it("a not-offered line stops the details step with inquiry-only wording, and its line is left alone", () => {
    const lists = new Map<string, ListState>([[`${P1}:shared`, ready(MARINA)], [`${P2}:shared`, { status: "not_offered" }]]);
    const plan = pickupPlan(items, lists, { hotelId: "42", name: MARINA.name });
    expect(plan.map((r) => r.status.kind)).toEqual(["cart", "not_offered"]);
    expect(pickupErrors(plan).hotel).toBe("Pickup can't be booked online for this trip. Send it to our team to arrange the pickup.");
    expect(pickupUpdates(plan).map((u) => u.itemId)).toEqual(["a"]);
  });

  it("the notice offers our team only, never Try again", () => {
    const lists = new Map<string, ListState>([[`${P1}:shared`, { status: "not_offered" }]]);
    const plan = pickupPlan(items.slice(0, 1), lists, null);
    const html = renderToStaticMarkup(
      h(PickupHotelFields, { label: "Pickup hotel", plan, lists, cartHotel: null, onCartHotel: () => {}, onItemHotel: () => {}, errors: {}, onAskTeam: () => {}, onRetry: () => {} }),
    );
    expect(html).toContain("Pickup for Trip a can&#x27;t be booked online.");
    expect(html).toContain("Ask our team about my hotel");
    expect(html).not.toContain("Try again");
    expect(html).not.toContain("right now");
  });
});

describe("hotels the quote refused (L8; per list, review 85 A5)", () => {
  const D = `${P1}:shared`;
  const C = `${P2}:shared`;

  it("names each refused line's hotel under its own activity's list, by its index in the cart; other refusals and typed hotels are ignored", () => {
    const cart = [
      item("a", "desert", { pickupHotel: { hotelId: "42", name: MARINA.name } }),
      item("b", "cruise", { pickupHotel: { hotelId: "43", name: CREEK.name } }),
      item("c", "cruise", { pickupHotel: { hotelId: null, name: "Typed" } }),
    ];
    const items = pickupItemsFor(cart, activities);
    expect(
      refusedPickupHotels(
        [
          { index: 0, reason: "pickup_unavailable" },
          { index: 1, reason: "sold_out" },
          { index: 2, reason: "pickup_unavailable" },
          { index: 9, reason: "pickup_unavailable" },
        ],
        cart,
        items,
      ),
    ).toEqual({ itemIds: ["a"], byList: new Map([[D, new Set(["42"])]]) });
    expect(mergeRefusedHotels(new Map([[D, new Set(["42"])]]), new Map([[D, new Set(["43"])], [C, new Set(["42"])]]))).toEqual(
      new Map([
        [D, new Set(["42", "43"])],
        [C, new Set(["42"])],
      ]),
    );
  });

  it("a hotel refused for one activity leaves only that activity's list; a list left with none is not offered", () => {
    const lists = new Map<string, ListState>([[D, ready(MARINA, CREEK)], [C, ready(MARINA)], ["x:1", { status: "loading" }]]);
    const shown = withoutRefusedHotels(lists, new Map([[D, new Set(["42"])]]));
    expect(shown.get(D)).toEqual(ready(CREEK));
    // The cruise still collects from the Marina hotel.
    expect(shown.get(C)).toEqual(ready(MARINA));
    expect(shown.get("x:1")).toEqual({ status: "loading" });
    expect(withoutRefusedHotels(lists, new Map())).toEqual(lists);
    expect(withoutRefusedHotels(lists, new Map([[C, new Set(["42"])]])).get(C)).toEqual({ status: "not_offered" });
  });

  it("the refused line needs another hotel while the other activity keeps the cart hotel", () => {
    const cart = [item("a", "desert", { pickupHotel: { hotelId: "42", name: MARINA.name } }), item("c", "cruise", { pickupHotel: { hotelId: "42", name: MARINA.name } })];
    const items = pickupItemsFor(cart, activities);
    const lists = new Map<string, ListState>([[D, ready(MARINA, CREEK)], [C, ready(MARINA)]]);
    const shown = withoutRefusedHotels(lists, refusedPickupHotels([{ index: 0, reason: "pickup_unavailable" }], cart, items).byList);
    // The cart hotel is still offered (the cruise collects from it), so the page keeps it.
    expect(cartHotelOptions(listsForItems(items, shown)).some((h) => h.id === "42")).toBe(true);
    const plan = pickupPlan(items, shown, { hotelId: "42", name: MARINA.name });
    expect(plan.map((r) => [r.status.kind, r.hotel?.hotelId ?? null])).toEqual([
      ["own", null],
      ["cart", "42"],
    ]);
    expect(pickupUpdates(plan)).toEqual([{ itemId: "a", pickupHotel: undefined }]);
    expect(pickupErrors(plan)).toEqual({ [itemHotelField("a")]: "Choose a pickup hotel for Trip a." });
  });

  it("a hotel refused on every list it was on leaves the cart field too; the plan clears the refused choice", () => {
    const items = pickupItemsFor([item("a", "desert", { pickupHotel: { hotelId: "42", name: MARINA.name } })], activities);
    const shown = withoutRefusedHotels(new Map<string, ListState>([[D, ready(MARINA, CREEK)]]), new Map([[D, new Set(["42"])]]));
    expect(cartHotelOptions(listsForItems(items, shown)).some((h) => h.id === "42")).toBe(false);
    const plan = pickupPlan(items, shown, null);
    expect(plan[0]).toMatchObject({ status: { kind: "cart" }, hotel: null });
    expect(pickupUpdates(plan)).toEqual([{ itemId: "a", pickupHotel: undefined }]);
  });
});
