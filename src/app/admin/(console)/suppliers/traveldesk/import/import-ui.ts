/**
 * Pure helpers of the TravelDesk import screens (doc 30 §3.14, decision 23):
 * the publish table's search and pages, its 50-listing cap, and the result
 * list the confirm dialog shows. No React, so they are unit-tested directly.
 * The server stays authoritative: `publishListingsAction` re-checks the cap
 * and every item's review gate and retire rules.
 */

/** The service's cap per publish run (`publishListingsAction`: at most 50). */
export const PUBLISH_MAX = 50;
export const PUBLISH_PAGE_SIZE = 10;

export interface PublishRow {
  linkId: string;
  title: string;
  slug: string;
  replaces: string | null;
}

export type PublishOutcome = { linkId: string; outcome: "published"; slug: string; retired: string | null; notRetired?: string } | { linkId: string; outcome: "stopped"; reason: string; references?: string[] };

/** Case-insensitive search over title, slug and the page it replaces. */
export function filterPublishRows(rows: readonly PublishRow[], query: string): PublishRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((r) => r.title.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q) || (r.replaces ?? "").toLowerCase().includes(q));
}

/** One page of rows (1-based), with the page count; an out-of-range page is clamped. */
export function pageOf<T>(rows: readonly T[], page: number, size = PUBLISH_PAGE_SIZE): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pages };
}

/** Adds ids to a selection without passing the cap; returns the new selection and how many did not fit. */
export function addWithinCap(selected: ReadonlySet<string>, ids: readonly string[], cap = PUBLISH_MAX): { next: Set<string>; dropped: number } {
  const next = new Set(selected);
  let dropped = 0;
  for (const id of ids) {
    if (next.has(id)) continue;
    if (next.size >= cap) dropped++;
    else next.add(id);
  }
  return { next, dropped };
}

/** The dialog's result list: applied (published) and failed (stopped), each with its reason line. */
export function publishResultRows(results: readonly PublishOutcome[], titles: ReadonlyMap<string, string>): { state: "applied" | "failed"; linkId: string; title: string; detail: string }[] {
  return results.map((r) => {
    const title = titles.get(r.linkId) ?? r.linkId.slice(-8);
    if (r.outcome === "published") {
      const parts = [`published as ${r.slug}`];
      if (r.retired) parts.push(`retired ${r.retired} with a permanent redirect`);
      if (r.notRetired) parts.push(`old page kept: ${r.notRetired}`);
      return { state: "applied" as const, linkId: r.linkId, title, detail: parts.join("; ") };
    }
    return { state: "failed" as const, linkId: r.linkId, title, detail: `${r.reason}${r.references?.length ? ` (${r.references.join(", ")})` : ""}` };
  });
}

/** The batches table's heading (page.tsx): focus lands here when an import or rollback dialog closes after its batch changed, since the dialog's own trigger is gone (review 109 INT-04). */
export const BATCHES_HEADING_ID = "td-import-batches-heading";
