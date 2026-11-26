/**
 * Structured data (JSON-LD) for `<script type="application/ld+json">`.
 *
 * `JSON.stringify` alone is not safe inside a script element: JSON escaping
 * leaves `</script>` intact, so catalogue text containing it would end the
 * element and anything after it would run as HTML. Every `<` is therefore
 * written as the JSON escape `\u003c`, which an HTML parser cannot read as a
 * tag and which `JSON.parse` turns back into `<` — the data is unchanged for
 * search engines. This is the escaping the Next.js JSON-LD guide prescribes.
 *
 * Use this for every JSON-LD sink; never pass raw `JSON.stringify` output to
 * `dangerouslySetInnerHTML`.
 */
export function serializeJsonLd(value: unknown): string {
  // JSON.stringify(undefined) is undefined, not a string; emit JSON null instead.
  return (JSON.stringify(value) ?? "null").replace(/</g, "\\u003c");
}

/**
 * The `offers` block of an activity's Product structured data (PRD-20).
 *
 * Never claims stock: an inquiry product's availability is unknown until an
 * agent checks, and an instant product's would come from a cached page, not
 * a live answer. Quote-only products publish no price, so they get no offer.
 * The price is the authored "from" adult price.
 */
export function productOfferJsonLd(activity: { slug: string; quoteOnly?: boolean; price: { adult: { inr: number } } }): Record<string, unknown> | undefined {
  if (activity.quoteOnly) return undefined;
  return {
    "@type": "Offer",
    price: activity.price.adult.inr,
    priceCurrency: "INR",
    url: `https://outlyy.com/activities/${activity.slug}`,
  };
}
