"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { fetchPickupHotels, type PickupHotelOption } from "@/lib/api/pickup-hotels";
import { CART_HOTEL_FIELD, cartHotelOptions, itemHotelField, listsForItems, type ListState, type PickupItem, type PickupPlanRow } from "@/lib/pickup-selection";
import type { PickupHotelChoice } from "@/lib/types";

/**
 * Hotel pickup on the checkout details step (doc 29 §7.3 Batch 3; owner
 * decision §8.4 row 11). One field for the whole cart, searched over every
 * hotel the cart's pickup activities collect from; under it, a field for one
 * activity only when its own list lacks the chosen hotel. When a list cannot
 * be read, or the hotel is not listed, the trip can go to our team with the
 * hotel carried in the inquiry form (never in the URL).
 *
 * The lists come from `GET /api/catalog/pickup-hotels`, one per product
 * variant; the server re-checks the chosen hotel at quote.
 */

/** The hotel lists of these pickup lines, keyed by `listKey`, loaded once per key. `retry` asks again for the failed ones. */
export function usePickupHotelLists(items: readonly PickupItem[]): { lists: Map<string, ListState>; retry: () => void } {
  const keys = useMemo(() => [...new Set(items.map((i) => i.listKey))].sort(), [items]);
  const keyString = keys.join(",");
  const [lists, setLists] = useState<Map<string, ListState>>(() => new Map());
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    for (const key of keyString ? keyString.split(",") : []) {
      const [productId, variantId] = key.split(":");
      void fetchPickupHotels(productId, variantId).then((list) => {
        if (live) setLists((prev) => new Map(prev).set(key, list));
      });
    }
    return () => {
      live = false;
    };
  }, [keyString, attempt]);

  const retry = useCallback(() => {
    setLists((prev) => {
      const next = new Map(prev);
      for (const [k, v] of next) if (v.status === "unavailable") next.delete(k);
      return next;
    });
    setAttempt((n) => n + 1);
  }, []);

  return { lists, retry };
}

const toOptions = (hotels: readonly PickupHotelOption[]): ComboboxOption[] => hotels.map((h) => ({ value: h.id, label: h.name, detail: h.area }));

export function PickupHotelFields({
  label,
  plan,
  lists,
  cartHotel,
  onCartHotel,
  onItemHotel,
  errors,
  onAskTeam,
  onRetry,
}: {
  label: string;
  plan: readonly PickupPlanRow[];
  lists: ReadonlyMap<string, ListState>;
  cartHotel: PickupHotelChoice | null;
  onCartHotel: (hotel: PickupHotelChoice) => void;
  onItemHotel: (itemId: string, hotel: PickupHotelChoice) => void;
  errors: Record<string, string | undefined>;
  /** Send the trip to our team, carrying `typed` as the hotel when one was typed. */
  onAskTeam: (typed: string) => void;
  onRetry: () => void;
}) {
  // Only the lists of the lines in the cart now (a removed line's list never offers its hotels).
  const hotels = useMemo(() => cartHotelOptions(listsForItems(plan.map((r) => r.item), lists)), [plan, lists]);
  const options = useMemo(() => toOptions(hotels), [hotels]);
  const loading = plan.some((r) => r.status.kind === "loading");
  const unavailable = plan.filter((r) => r.status.kind === "unavailable");
  const own = plan.filter((r): r is PickupPlanRow & { status: { kind: "own"; hotels: PickupHotelOption[] } } => r.status.kind === "own");
  const several = plan.length > 1;

  const ask = (typed: string) => (
    <Button size="sm" variant="outline" onClick={() => onAskTeam(typed)}>
      {typed ? `Ask our team about “${typed.slice(0, 60)}”` : "Ask our team about my hotel"}
    </Button>
  );

  return (
    <div className="space-y-5">
      <div>
        <Combobox
          id={CART_HOTEL_FIELD}
          label={label}
          required
          hint={
            own.length > 0
              ? "The operators collect you from this hotel where they can. An activity that can't has its own hotel field below. Search by hotel name or area."
              : several
                ? "The operators collect you from this hotel for every activity with pickup. Search by hotel name or area."
                : "The operator collects you from this hotel. Search by hotel name or area."
          }
          error={errors[CART_HOTEL_FIELD]}
          options={options}
          value={cartHotel?.hotelId ?? null}
          onChange={(id) => {
            const h = hotels.find((x) => x.id === id);
            if (h) onCartHotel({ hotelId: h.id, name: h.name });
          }}
          placeholder={loading && !options.length ? "Loading pickup hotels…" : "Choose your hotel"}
          disabled={!options.length}
          searchLabel="Search hotels"
          searchPlaceholder="Hotel name or area"
          noun={{ one: "hotel", many: "hotels" }}
          emptyAction={ask}
        />
        {options.length > 0 && (
          <button
            type="button"
            onClick={() => onAskTeam("")}
            className="mt-2 inline-flex min-h-11 items-center text-sm font-bold text-sun-700 underline underline-offset-4"
          >
            My hotel isn&apos;t listed
          </button>
        )}
      </div>

      {own.map((r) => (
        <Combobox
          key={r.item.itemId}
          id={itemHotelField(r.item.itemId)}
          label={`Pickup hotel for ${r.item.title}`}
          required
          hint={`This activity doesn't collect from ${cartHotel?.name ?? "that hotel"}. Choose the nearest hotel it does collect from.`}
          error={errors[itemHotelField(r.item.itemId)]}
          options={toOptions(r.status.hotels)}
          value={r.hotel?.hotelId ?? null}
          onChange={(id) => {
            const h = r.status.hotels.find((x) => x.id === id);
            if (h) onItemHotel(r.item.itemId, { hotelId: h.id, name: h.name });
          }}
          placeholder="Choose a hotel for this activity"
          searchLabel={`Search hotels for ${r.item.title}`}
          searchPlaceholder="Hotel name or area"
          noun={{ one: "hotel", many: "hotels" }}
          emptyAction={ask}
        />
      ))}

      {unavailable.length > 0 && (
        <div
          role="status"
          className="rounded-[var(--radius-control)] border border-[color-mix(in_oklab,var(--color-warning)_30%,white)] bg-[var(--color-warning-bg)] p-3.5 text-sm text-[color-mix(in_oklab,var(--color-warning)_85%,black)]"
        >
          <p className="flex gap-2.5">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4.5 shrink-0" />
            <span>
              We can&apos;t load the pickup hotels for {unavailable.length === 1 ? unavailable[0].item.title : "some activities"} right now. Try again, or send
              your trip to our team and they confirm the pickup with you before you pay.
            </span>
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RefreshCw aria-hidden="true" className="h-4 w-4" /> Try again
            </Button>
            {ask(cartHotel?.name ?? "")}
          </div>
        </div>
      )}
    </div>
  );
}
