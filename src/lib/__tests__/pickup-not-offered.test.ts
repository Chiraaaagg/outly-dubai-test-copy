import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPickupHotelCache, fetchPickupHotels } from "@/lib/api/pickup-hotels";
import { PickupHotelFields } from "@/components/checkout/pickup-hotel-fields";
import { pickupErrors, pickupItemsFor, pickupPlan, pickupUpdates, refusedPickupHotels, withoutRefusedHotels, type ListState } from "@/lib/pickup-selection";
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

describe("hotels the quote refused (L8)", () => {
  it("names each refused line's hotel by its index in the cart; other refusals and typed hotels are ignored", () => {
    const cart = [
      item("a", "desert", { pickupHotel: { hotelId: "42", name: MARINA.name } }),
      item("b", "cruise", { pickupHotel: { hotelId: "43", name: CREEK.name } }),
      item("c", "cruise", { pickupHotel: { hotelId: null, name: "Typed" } }),
    ];
    expect(
      refusedPickupHotels(
        [
          { index: 0, reason: "pickup_unavailable" },
          { index: 1, reason: "sold_out" },
          { index: 2, reason: "pickup_unavailable" },
          { index: 9, reason: "pickup_unavailable" },
        ],
        cart,
      ),
    ).toEqual({ itemIds: ["a"], hotelIds: ["42"] });
  });

  it("refused hotels leave the lists; a list left with none is not offered, and the plan clears the refused choice", () => {
    const lists = new Map<string, ListState>([[`${P1}:shared`, ready(MARINA, CREEK)], [`${P2}:shared`, ready(MARINA)], ["x:1", { status: "loading" }]]);
    const shown = withoutRefusedHotels(lists, new Set(["42"]));
    expect(shown.get(`${P1}:shared`)).toEqual(ready(CREEK));
    expect(shown.get(`${P2}:shared`)).toEqual({ status: "not_offered" });
    expect(shown.get("x:1")).toEqual({ status: "loading" });
    expect(withoutRefusedHotels(lists, new Set())).toEqual(lists);

    const items = pickupItemsFor([item("a", "desert", { pickupHotel: { hotelId: "42", name: MARINA.name } })], activities);
    const plan = pickupPlan(items, shown, null);
    expect(plan[0]).toMatchObject({ status: { kind: "cart" }, hotel: null });
    expect(pickupUpdates(plan)).toEqual([{ itemId: "a", pickupHotel: undefined }]);
  });
});
