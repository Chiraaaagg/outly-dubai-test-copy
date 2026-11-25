import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { productOfferJsonLd } from "../json-ld";
import { dubaiDayStartUtc, dubaiToday } from "../utils";
import { combos } from "../data/combos";
import { activities } from "../data/activities";

/** B2 storefront rules that need no browser (PRD-6, PRD-13, PRD-18, PRD-20, PRD-21). */

const ROOT = process.cwd();

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== "__tests__") sources(full, out);
    } else if (/\.(ts|tsx)$/.test(name)) out.push(path.relative(ROOT, full).split(path.sep).join("/"));
  }
  return out;
}

describe("PRD-6: the deterministic availability mock feeds no storefront module", () => {
  it("nothing under src/app, src/components or src/lib imports it (the supplier mock adapter may)", () => {
    const offenders = ["src/app", "src/components", "src/lib"]
      .flatMap((d) => sources(path.join(ROOT, d)))
      .filter((f) => f !== "src/lib/availability.ts")
      .filter((f) => /from ["'](?:@\/lib\/availability|\.\.?\/availability|\.\.\/\.\.\/availability)["']/.test(readFileSync(path.join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("PRD-18: one Dubai 'today'", () => {
  it("is the Dubai calendar date whatever the machine's zone", () => {
    expect(dubaiToday(new Date("2026-11-01T19:59:59Z"))).toBe("2026-11-01");
    expect(dubaiToday(new Date("2026-11-01T20:00:00Z"))).toBe("2026-11-02");
    expect(dubaiToday(new Date("2026-12-31T21:00:00Z"))).toBe("2027-01-01");
  });

  it("a service day starts at 20:00 UTC the evening before", () => {
    expect(dubaiDayStartUtc("2026-11-02").toISOString()).toBe("2026-11-01T20:00:00.000Z");
  });
});

describe("PRD-20: product structured data never claims stock", () => {
  it("an inquiry product has a price offer without availability", () => {
    const offer = productOfferJsonLd(activities[0]);
    expect(offer).toEqual({ "@type": "Offer", price: activities[0].price.adult.inr, priceCurrency: "INR", url: `https://outlyy.com/activities/${activities[0].slug}` });
    expect(JSON.stringify(offer)).not.toContain("InStock");
  });

  it("a quote-only product has no offer at all", () => {
    expect(productOfferJsonLd({ ...activities[0], quoteOnly: true })).toBeUndefined();
  });

  it("an instant product does not claim stock from a cached page either", () => {
    expect(productOfferJsonLd({ ...activities[0], fulfilmentMode: "instant" } as typeof activities[0])).not.toHaveProperty("availability");
  });
});

describe("PRD-21 / PRD-13: combo records and fixtures", () => {
  it("every combo carries its own free-cancellation hours, matching its policy text", () => {
    for (const c of combos) {
      expect(c.cancellationPolicy).toContain(`${c.freeCancellationHours} hours`);
    }
  });

  it("every fixture sells as inquiry", () => {
    expect(activities.every((a) => a.fulfilmentMode === "inquiry")).toBe(true);
    expect(combos.every((c) => c.fulfilmentMode === "inquiry")).toBe(true);
  });
});
