import { attractions, collections } from "@/lib/data/collections";
import { combos } from "@/lib/data/combos";
import { landingPages } from "@/lib/data/landing-pages";

/**
 * Every place in the bundled site data (`src/lib/data`) that names an
 * activity slug (doc 30 §3.9 "Other references"): collections, attractions,
 * combos and landing pages (lists, comparison tables and internal links).
 * Publishing a replacement stops while the old slug is still named anywhere,
 * until a person repoints it. Pure.
 */
export function staticSlugReferences(slug: string): string[] {
  const out: string[] = [];
  for (const c of collections) if (c.activitySlugs.includes(slug)) out.push(`collection:${c.slug}`);
  for (const a of attractions) if (a.activitySlugs.includes(slug)) out.push(`attraction:${a.slug}`);
  for (const c of combos) if (c.includedSlugs.includes(slug)) out.push(`combo:${c.slug}`);
  for (const p of landingPages) {
    if (p.activitySlugs.includes(slug) || p.comparison?.slugs.includes(slug) || p.internalLinks.some((l) => l.href === `/activities/${slug}`)) out.push(`landing:${p.slug}`);
  }
  return out;
}
