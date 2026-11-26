import { describe, expect, it } from "vitest";
import { evaluatePair, idfWeights, parseSlotTimes, suggestCandidates, tokens, type MatchOffer, type MatchProduct } from "../supplier-matching";

const burj: MatchProduct = {
  productId: "p-burj",
  slug: "burj-khalifa-at-the-top-tickets",
  title: "Burj Khalifa At the Top Tickets (Level 124 - 125)",
  durationMinutes: 60,
  isPrivate: false,
  pickupIncluded: false,
  timeSlots: ["As per selected time slot"],
  variants: [{ code: "std", name: "At the Top (Levels 124 + 125)", sellAdultMinor: 18900n, sellChildMinor: 14900n, isPrivate: false }],
};

function offer(over: Partial<MatchOffer> = {}): MatchOffer {
  return {
    tourId: "136",
    tourName: "Burj Khalifa - At The Top",
    offerId: "1829",
    offerName: "Silver - 124/125 Floors - Non Prime",
    bookingKind: "live_book",
    isExternal: false,
    durationHours: 1,
    privateType: "sharing",
    isDirectReporting: true,
    childAge: 8,
    startMinutes: [600, 630],
    // Synthetic supplier nets (round numbers, not real TravelDesk rates).
    netAdultMinor: 15000n,
    netChildMinor: 12500n,
    netTripMinor: 0n,
    ...over,
  };
}

describe("tokens / parseSlotTimes", () => {
  it("drops stopwords, digits and punctuation", () => {
    expect(tokens("Burj Khalifa At the Top Tickets (Level 124 - 125)")).toEqual(["burj", "khalifa", "top"]);
    expect(tokens("Dhow Cruise Dinner - Marina")).toEqual(["dhow", "cruise", "dinner", "marina"]);
  });

  it("reads 24 h and am/pm times, ignores durations and bare numbers", () => {
    expect(parseSlotTimes(["09:30", "Approx 9.00 pm to 10:30 pm"])).toEqual([570, 1260, 1350]);
    expect(parseSlotTimes(["Start time 09.00 am", "12 pm"])).toEqual([540, 720]);
    expect(parseSlotTimes(["24 hours", "12 min flight", "Tours available at Multiple Slots", "Level 148"])).toEqual([]);
    expect(parseSlotTimes(["12 am"])).toEqual([0]);
  });
});

describe("evaluatePair", () => {
  it("a good match lists evidence and the margin before fees", () => {
    const c = evaluatePair(burj, burj.variants[0], offer());
    expect(c.evidence).toEqual(expect.arrayContaining(["Name overlap: burj, khalifa, top", "Both shared", "Both direct reporting", "Live booking"]));
    expect(c.marginBps).toBe(2063); // (189 − 150) / 189 = 20.6% floored
    expect(c.conflicts).toEqual([]);
    expect(c.score).toBeGreaterThanOrEqual(50);
  });

  it("flags margin below the floor, child loss, external and on-request", () => {
    const c = evaluatePair(burj, { ...burj.variants[0], sellAdultMinor: 15900n, sellChildMinor: 12000n }, offer({ isExternal: true }));
    expect(c.conflicts).toEqual(
      expect.arrayContaining([
        "Margin 5.7% before fees is below 15.0% (sell 159 vs net 150 AED)",
        "Child price 120 does not cover child net 125 AED",
        "External operator confirms (not first wave)",
      ]),
    );
    expect(evaluatePair(burj, burj.variants[0], offer({ bookingKind: "on_request" })).conflicts).toContain("On-request offer: inquiry only, never instant");
  });

  it("flags per-trip pricing against a per-person variant, private mismatch, pickup and duration", () => {
    const c = evaluatePair(
      { ...burj, pickupIncluded: true, durationMinutes: 360 },
      burj.variants[0],
      offer({ netAdultMinor: 0n, netTripMinor: 60000n, privateType: "private", durationHours: 1 }),
    );
    expect(c.pricedPerTrip).toBe(true);
    expect(c.netAdultMinor).toBe(60000n);
    expect(c.conflicts).toEqual(
      expect.arrayContaining([
        "TravelDesk offer is private; OUTLY variant is shared",
        "OUTLY includes hotel pickup; offer is direct reporting",
        "Duration differs: OUTLY 360 min vs TravelDesk 1 h",
        "TravelDesk prices per trip/vehicle; OUTLY prices per person",
      ]),
    );
  });

  it("slot times are compared within ±45 minutes", () => {
    const dhow: MatchProduct = { ...burj, title: "Dhow Cruise Dinner - Marina", timeSlots: ["Approx 9.00 pm to 10:30 pm"], durationMinutes: 90 };
    const v = { ...burj.variants[0], name: "Traditional Wooden Dhow - direct boarding" };
    const o = offer({ tourName: "Alexandra Dhow Cruise in Dubai Marina", offerName: "Dinner Cruise, Lower Deck", startMinutes: [1260], durationHours: 2 });
    expect(evaluatePair(dhow, v, o).evidence).toContain("Slot times align (±45 min)");
    expect(evaluatePair(dhow, v, { ...o, startMinutes: [1140] }).conflicts).toContain("Slot times differ by more than 45 minutes");
  });

  it("warns when TravelDesk's child band is infants-only", () => {
    expect(evaluatePair(burj, burj.variants[0], offer({ childAge: 2 })).conflicts).toContain("TravelDesk child rate only under 2; older children pay the adult net");
  });
});

describe("suggestCandidates", () => {
  const offers = [
    offer(),
    offer({ offerId: "1830", offerName: "Silver - 124/125 - Prime Time", netAdultMinor: 16000n }),
    offer({ tourId: "144", tourName: "Aquarium and Underwater Zoo at the Dubai Mall", offerId: "1173", offerName: "Regular Pass" }),
    offer({ tourId: "5", tourName: "Alexandra Dhow Cruise in Dubai Marina", offerId: "1221", offerName: "Upper deck" }),
  ];

  it("needs a shared identity word in the tour name; structure alone never suggests", () => {
    const s = suggestCandidates(burj, offers);
    expect(s.map((c) => c.offerId).sort()).toEqual(["1829", "1830"]);
  });

  it("returns at most maxPerVariant per variant, best score first", () => {
    const two = suggestCandidates({ ...burj, variants: [...burj.variants, { ...burj.variants[0], code: "fast", name: "At the Top + Fast Track" }] }, offers, { maxPerVariant: 1 });
    expect(two).toHaveLength(2);
    expect(new Set(two.map((c) => c.variantCode))).toEqual(new Set(["std", "fast"]));
  });

  it("returns nothing for a product without variants", () => {
    expect(suggestCandidates({ ...burj, variants: [] }, offers)).toEqual([]);
  });
});

describe("idf weighting", () => {
  it("rare identity words outrank shared place names", () => {
    const heli: MatchProduct = {
      ...burj,
      title: "12-Minute Helicopter Tour over Palm & Burj Al Arab",
      durationMinutes: 90,
      variants: [{ code: "std", name: "12-minute shared flight", sellAdultMinor: 81500n, sellChildMinor: null, isPrivate: false }],
    };
    const tourNames = [
      "Jet Ski Burj Al Arab",
      "Donut Ride Burj Al Arab",
      "Fly Board Burj Al Arab",
      "Helicopter flight from the Palm Island, Dubai",
      "Helicopter Flight Abu Dhabi",
      "The View Palm Jumeirah",
    ];
    const offers = tourNames.map((t, i) => offer({ tourId: String(i), tourName: t, offerId: String(100 + i), offerName: "30 mins", netAdultMinor: 50000n }));
    const top = suggestCandidates(heli, offers, { maxPerVariant: 1 })[0];
    expect(top.tourId).toBe("3");
    const w = idfWeights(tourNames);
    expect(w("helicopter")).toBeGreaterThan(w("burj"));
    expect(w("never-seen")).toBeGreaterThan(w("helicopter"));
  });
});

describe("activity type", () => {
  it("a shared place name with a different activity is a conflict and scores lower", () => {
    const heli: MatchProduct = { ...burj, title: "12-Minute Helicopter Tour over Palm & Burj Al Arab", variants: [{ ...burj.variants[0], name: "22-minute extended route" }] };
    const jet = evaluatePair(heli, heli.variants[0], offer({ tourName: "Jet Ski Burj Al Arab", offerName: "1800cc x 30 mins" }));
    const hel = evaluatePair(heli, heli.variants[0], offer({ tourName: "Helicopter Flight from Dubai Police Academy by HeliDubai", offerName: "22 minute Vision Tour sharing flight" }));
    expect(jet.conflicts).toContain("Different activity: OUTLY helicopter vs TravelDesk jet ski");
    expect(hel.evidence).toContain("Same activity type: helicopter");
    expect(hel.score).toBeGreaterThan(jet.score);
  });
});

describe("review fixes", () => {
  it("'15:00 hrs' is a time; '9 amazing' is not 9 am", () => {
    expect(parseSlotTimes(["Approx 15:00 hrs to 18:00 hrs"])).toEqual([900, 1080]);
    expect(parseSlotTimes(["9 amazing views"])).toEqual([]);
  });

  it("a yacht cruise and a dhow cruise are different activities", () => {
    const yacht: MatchProduct = { ...burj, title: "Lotus Mega Yacht Dinner Cruise", variants: [{ ...burj.variants[0], name: "Standard" }] };
    const c = evaluatePair(yacht, yacht.variants[0], offer({ tourName: "Alexandra Dhow Cruise in Dubai Marina", offerName: "Dinner Cruise, Upper Deck" }));
    expect(c.conflicts).toContain("Different activity: OUTLY yacht / boat vs TravelDesk dhow");
  });
});
