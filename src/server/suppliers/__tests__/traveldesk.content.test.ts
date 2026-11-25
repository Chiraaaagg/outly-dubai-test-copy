import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { tourCataloguePayload, tourDetailFrom, tourDetailsWire } from "../traveldesk/traveldesk.codec";
import {
  CONTENT_LIMITS,
  htmlToPlainText,
  newTextBudget,
  safeTourContentFrom,
  parseFaq,
  parseItinerary,
  parsePhotos,
  safeHttpsUrl,
  sanitiseRaw,
  TOUR_CONTENT_SCHEMA_VERSION,
  tourContentFrom,
} from "../traveldesk/traveldesk.content";
import { offerTermsHash } from "../traveldesk/traveldesk.offer-terms";

/**
 * Doc 30 N0: TravelDesk tour content is read into a sanitised shape and kept
 * out of the catalogue payload, so the approved offer terms hash is unchanged.
 * Fixtures are synthetic, apart from the photo shape of the committed sandbox
 * fixture `tour-5.json` (its text is trimmed there).
 */

const FIXTURES = path.join(import.meta.dirname, "fixtures/traveldesk");
const tour5 = (): Record<string, unknown> & { photos: unknown[] } => JSON.parse(readFileSync(path.join(FIXTURES, "tour-5.json"), "utf8"));

describe("htmlToPlainText", () => {
  it("turns supplier HTML into plain text with line breaks and bullets", () => {
    const html = "<h2>Highlights</h2><p>Dinner&nbsp;on board &amp; live music.</p><ul><li>Welcome drink</li><li>Buffet</li></ul>Ends<br>late";
    expect(htmlToPlainText(html)).toBe("Highlights\n\nDinner on board & live music.\n\n• Welcome drink\n• Buffet\nEnds\nlate");
  });

  it("drops script, style, iframe, comments and event handlers from hostile HTML", () => {
    const hostile =
      '<p onclick="steal()">Hi</p><script>alert(1)</script><style>p{}</style><iframe src="https://example.test"></iframe>' +
      '<!-- secret --><img src=x onerror="alert(2)"><a href="javascript:alert(3)">link</a><svg><script>alert(4)</script></svg>';
    const out = htmlToPlainText(hostile);
    expect(out).toBe("Hi\nlink");
    expect(out).not.toMatch(/alert|script|onerror|javascript|secret|<|>/);
  });

  it("decodes entities once, so an encoded tag stays text and is never parsed again", () => {
    expect(htmlToPlainText("&lt;script&gt;x&lt;/script&gt; &#65;&#x42; &unknown;")).toBe("<script>x</script> AB &unknown;");
  });

  it("removes control and bidi characters and caps the length", () => {
    expect(htmlToPlainText("a\u0000b‮c\u0007d")).toBe("abcd");
    const long = htmlToPlainText("x".repeat(30_000));
    expect(long.length).toBe(CONTENT_LIMITS.textChars);
    expect(long.endsWith("…")).toBe(true);
  });

  it("reads non-strings as empty", () => {
    expect(htmlToPlainText(null)).toBe("");
    expect(htmlToPlainText(42)).toBe("");
    expect(htmlToPlainText({ a: 1 })).toBe("");
  });
});

describe("htmlToPlainText is linear and bounded (review 103 N0-01, N0-02, N0-09, N0-10)", () => {
  const ms = (f: () => unknown) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };

  it("strips adversarial unclosed markup in linear time", () => {
    // Each of these took over a second per field with the old regex chain.
    for (const bad of ["<a".repeat(40_000), "<!".repeat(40_000), "<p ".repeat(26_000), "<script>".repeat(10_000), "<!--".repeat(20_000)]) {
      expect(ms(() => htmlToPlainText(bad))).toBeLessThan(200);
    }
  });

  it("bounds a whole tour: 100 hostile FAQ answers and 100 itinerary texts stay fast and within the tour budget", () => {
    const bad = "<a".repeat(40_000);
    const wire = {
      salesDescription: bad,
      termsAndConditions: bad,
      faqList: Array.from({ length: 100 }, () => ({ question: "Q?", answer: bad })),
      itineraries: Array.from({ length: 100 }, () => bad),
    };
    let warnings: string[] = [];
    expect(ms(() => (warnings = tourContentFrom(wire).warnings))).toBeLessThan(1_500);
    expect(warnings).toContain(`content: input over ${CONTENT_LIMITS.tourInputChars} characters, the rest read as empty`);
  });

  it("spends a shared budget and then reads fields as empty", () => {
    const budget = newTextBudget(10);
    expect(htmlToPlainText("abcdefgh", 100, budget)).toBe("abcdefgh");
    expect(htmlToPlainText("abcdefgh", 100, budget)).toBe("ab");
    expect(budget.exhausted).toBe(true);
    expect(htmlToPlainText("more", 100, budget)).toBe("");
  });

  it("drops a tag cut off at the end instead of keeping it as text", () => {
    expect(htmlToPlainText('Before <img src="data:image/png;base64,AAAA')).toBe("Before");
    expect(htmlToPlainText("a < b and c<5")).toBe("a < b and c<5");
  });

  it("never leaves a lone surrogate, at the cap or from the supplier", () => {
    const capped = htmlToPlainText(`${"a".repeat(19_998)}😀😀😀`);
    expect(capped.isWellFormed()).toBe(true);
    expect(capped.length).toBeLessThanOrEqual(CONTENT_LIMITS.textChars);
    expect(htmlToPlainText("x\ud83dy").isWellFormed()).toBe(true);
    expect((sanitiseRaw(`${"b".repeat(19_999)}😀`) as string).isWellFormed()).toBe(true);
    expect((sanitiseRaw({ ["k\udc00"]: "v\ud800" }) as Record<string, string>)["k\ufffd"]).toBe("v\ufffd");
  });

  it("removes directional marks and turns line separators into line breaks", () => {
    expect(htmlToPlainText("a\u200eb\u200fc\u061cd\u2028e\u2029f")).toBe("abcd\ne\nf");
  });
});

describe("safeTourContentFrom (review 103 N0-01)", () => {
  it("returns undefined with a warning instead of failing the tour read", () => {
    const warnings: string[] = [];
    const hostile = {
      get salesDescription(): string {
        throw new TypeError("boom");
      },
    };
    expect(safeTourContentFrom(hostile, warnings)).toBeUndefined();
    expect(warnings).toEqual(["content: unreadable (TypeError)"]);
  });
});

describe("safeHttpsUrl", () => {
  it("refuses IP literals, local and single-label hosts and non-default ports (review 103 N0-05)", () => {
    for (const bad of [
      "https://169.254.169.254/latest",
      "https://10.0.0.1/a.jpg",
      "https://2130706433/a.jpg",
      "https://0x7f.1/a.jpg",
      "https://[::1]/a.jpg",
      "https://[fe80::1]/a.jpg",
      "https://localhost/a.jpg",
      "https://cdn.localhost/a.jpg",
      "https://printer.local/a.jpg",
      "https://metadata.google.internal/a.jpg",
      "https://intranet/a.jpg",
      "https://media.example.test:8443/a.jpg",
      "https://media.example.test:22/a.jpg",
    ]) {
      expect(safeHttpsUrl(bad), bad).toBeNull();
    }
    expect(safeHttpsUrl("https://media.example.test:443/a.jpg")).toBe("https://media.example.test/a.jpg");
  });

  it("keeps https only, without credentials", () => {
    expect(safeHttpsUrl("https://media.example.test/p/1.webp")).toBe("https://media.example.test/p/1.webp");
    expect(safeHttpsUrl("http://media.example.test/p/1.webp")).toBeNull();
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpsUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(safeHttpsUrl(["https://user:pw", "media.example.test/p.jpg"].join("@"))).toBeNull();
    expect(safeHttpsUrl(`https://media.example.test/${"a".repeat(3_000)}`)).toBeNull();
    expect(safeHttpsUrl(7)).toBeNull();
  });
});

describe("parsePhotos", () => {
  it("reads the sandbox photo shape (srcSet of sizes) as references", () => {
    const warnings: string[] = [];
    const photos = parsePhotos(tour5().photos, warnings);
    expect(warnings).toEqual([]);
    expect(photos).toHaveLength(1);
    expect(photos[0].supplierPhotoId).toBe(35);
    expect(photos[0].variants).toHaveLength(10);
    expect(photos[0].variants[0]).toMatchObject({ type: "image/webp", width: 1920, height: 1080 });
    expect(photos[0].variants.every((v) => v.url.startsWith("https://"))).toBe(true);
  });

  it("drops non-https sources and photos without a usable one, with warnings", () => {
    const warnings: string[] = [];
    const photos = parsePhotos(
      [
        { id: 1, srcSet: [{ type: "image/jpeg", sizes: [{ src: "http://media.example.test/a.jpg" }, { src: "https://media.example.test/b.jpg", width: 10, height: 5 }] }] },
        { id: 2, srcSet: [{ type: "text/html", sizes: [{ src: "javascript:alert(1)" }] }] },
        "https://media.example.test/c.jpg",
        42,
      ],
      warnings,
    );
    expect(photos.map((p) => p.variants.map((v) => v.url))).toEqual([["https://media.example.test/b.jpg"], ["https://media.example.test/c.jpg"]]);
    expect(warnings).toEqual([
      "photo 1: 1 source(s) not an allowed https address, dropped",
      "photo 2: 1 source(s) not an allowed https address, dropped",
      "photo 2: no usable source (id,srcSet)",
      "photo 4: unreadable (number)",
    ]);
  });
});

describe("parseFaq and parseItinerary (shapes undocumented)", () => {
  it("reads common question/answer field pairs as plain text", () => {
    const warnings: string[] = [];
    const faq = parseFaq(
      [
        { question: "Is dinner included?", answer: "<p>Yes, a <b>buffet</b>.</p>" },
        { title: "Dress code?", description: "Smart casual" },
        { foo: "bar" },
        "loose string",
      ],
      warnings,
    );
    expect(faq).toEqual([
      { question: "Is dinner included?", answer: "Yes, a buffet ." },
      { question: "Dress code?", answer: "Smart casual" },
    ]);
    expect(warnings).toEqual(["faq 3: unknown shape (foo)", "faq 4: unreadable (string)"]);
  });

  it("orders itinerary steps by the supplier's order when every step has one, else by position", () => {
    const w: string[] = [];
    expect(parseItinerary([{ order: 2, title: "Cruise" }, { order: 1, title: "Boarding", description: "<p>At the marina</p>" }], w)).toEqual([
      { position: 1, title: "Boarding", description: "At the marina" },
      { position: 2, title: "Cruise", description: "" },
    ]);
    expect(parseItinerary([{ title: "A" }, "Then B", { nothing: true }], w)).toEqual([
      { position: 1, title: "A", description: "" },
      { position: 2, title: "", description: "Then B" },
    ]);
    expect(w).toEqual(["itinerary 3: unknown shape (nothing)"]);
  });
});

describe("sanitiseRaw", () => {
  it("keeps JSON-safe values, caps depth and drops prototype keys and control characters", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    const raw = sanitiseRaw({ ok: "x\u0000y", n: Number.NaN, f: () => 1, ["__proto__"]: { x: 1 }, deep }) as Record<string, unknown>;
    expect(raw.ok).toBe("xy");
    expect(raw.n).toBeNull();
    expect(raw.f).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(raw, "__proto__")).toBe(false);
    expect(JSON.stringify(raw.deep)).toBe('{"a":{"b":{"c":{"d":{"e":null}}}}}');
  });
});

describe("tourContentFrom", () => {
  it("stores parsed parts, the raw lists, the schema version and a stable hash", () => {
    const wire = { ...tour5(), salesDescription: "<p>Synthetic <i>evening</i> cruise.</p>", termsAndConditions: "Bring ID." };
    const a = tourContentFrom(wire);
    expect(a.schemaVersion).toBe(TOUR_CONTENT_SCHEMA_VERSION);
    expect(a.salesDescription).toBe("Synthetic evening cruise.");
    expect(a.terms).toBe("Bring ID.");
    expect(a.videoUrl).toMatch(/^https:\/\//);
    expect(a.photos).toHaveLength(1);
    expect(a.raw.photos).toEqual(wire.photos);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tourContentFrom({ ...wire }).contentHash).toBe(a.contentHash);
    expect(tourContentFrom({ ...wire, salesDescription: "Other" }).contentHash).not.toBe(a.contentHash);
  });

  it("never throws on odd shapes: unreadable parts are empty with a warning", () => {
    const c = tourContentFrom({ name: null, salesDescription: null, faqList: [1, null], itineraries: [[]], photos: [{}], videoUrl: "ftp://x.test/v" });
    expect(c.faq).toEqual([]);
    expect(c.itinerary).toEqual([]);
    expect(c.photos).toEqual([]);
    expect(c.videoUrl).toBeNull();
    expect(c.warnings).toEqual([
      "video: not an allowed https address",
      "faq 1: unreadable (number)",
      "faq 2: unreadable (object)",
      "itinerary 1: unreadable (array)",
      "photo 1: no usable source (no keys)",
    ]);
  });
});

describe("catalogue payload and the approved terms hash (doc 30 §3.2)", () => {
  // The tour payload keys the catalogue stored before N0. Adding a key here changes every tour row's payload hash.
  const PRE_N0_TOUR_PAYLOAD_KEYS = [
    "cancellationPolicy",
    "categories",
    "faqCount",
    "hasSalesDescription",
    "hasTermsAndConditions",
    "isExternal",
    "itineraryCount",
    "name",
    "photoCount",
    "tourId",
  ];

  it("keeps content out of the tour payload", () => {
    const detail = tourDetailFrom(tourDetailsWire.parse(tour5()));
    expect(detail.content?.photos).toHaveLength(1);
    expect(Object.keys(tourCataloguePayload(detail)).sort()).toEqual(PRE_N0_TOUR_PAYLOAD_KEYS);
  });

  it("gives the same offer terms hash whatever the content says", () => {
    const wire = tour5();
    const a = tourDetailFrom(tourDetailsWire.parse(wire));
    const b = tourDetailFrom(tourDetailsWire.parse({ ...wire, salesDescription: "<p>Changed</p>", termsAndConditions: "Changed", videoUrl: null, photos: [...wire.photos, ...wire.photos] }));
    expect(b.content!.contentHash).not.toBe(a.content!.contentHash);
    const offer = JSON.parse(JSON.stringify(a.offers[0], (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const hashA = offerTermsHash(offer, JSON.parse(JSON.stringify(tourCataloguePayload(a))));
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
    expect(offerTermsHash(offer, JSON.parse(JSON.stringify(tourCataloguePayload(b))))).toBe(hashA);
  });
});
