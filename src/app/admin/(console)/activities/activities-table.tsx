"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Check, Columns3, Minus, Search, X } from "lucide-react";
import { Checkbox } from "@base-ui/react/checkbox";
import { Menu } from "@base-ui/react/menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DataTable, INPUT_CLASS, StatusPill, fmtDateTime, type DataColumn } from "../../_components/ui";
import { ActivityRowActions, type RowCapabilities } from "./row-actions";
import { BulkActionDialog, BULK_ACTION_META, type BulkActionKind } from "./bulk-action-dialog";

/**
 * Activities table with selection and one bulk action bar (doc 30 §3.12,
 * decision 23).
 *
 * Look and behaviour adapted from "Team Members Data Table" by olewandowski1
 * on 21st.dev (https://21st.dev/@olewandowski1/components/team-members-data-table),
 * used under the owner's 21st.dev Pro licence; see THIRD-PARTY-NOTICES.md.
 * Adapted onto the project's own parts instead of its dependencies: the
 * shared `DataTable`, `StatusPill` badges, `Button`, lucide icons, Base UI's
 * Checkbox and Menu (already dependencies), project tokens. No TanStack
 * table, no toast library, no Radix.
 *
 * Kept from the reference: a search box, row checkboxes with a select-all
 * (indeterminate when part of the page is selected), a bar with the selected
 * count and the bulk actions, status badges, a column visibility menu, and
 * pagination (the console's server-side `Pagination`, below the table).
 * Search, filters and "select all N matching" stay server-side: the bar sends
 * the filters, never a client list, and the services recount them.
 */

export interface ActivityTableRow {
  id: string;
  slug: string;
  title: string;
  tier: string;
  status: string;
  categorySlug: string;
  categoryPublished: boolean;
  fulfilmentMode: string;
  quoteOnly: boolean;
  priceFromInr: number | null;
  version: number;
  updatedAt: string;
  deleted: boolean;
}

export interface TableFilters {
  q?: string;
  status?: string;
  tier?: string;
  category?: string;
}

const STATUS_TONE = { draft: "warning", published: "success", archived: "neutral" } as const;
const HIDEABLE = [
  { key: "tier", label: "Tier" },
  { key: "status", label: "Status" },
  { key: "mode", label: "Mode" },
  { key: "price", label: "From ₹" },
  { key: "version", label: "Version" },
  { key: "updated", label: "Updated" },
] as const;

function SelectBox({ checked, indeterminate, onChange, label, disabled }: { checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <Checkbox.Root
      checked={checked}
      indeterminate={indeterminate}
      onCheckedChange={(v) => onChange(v)}
      disabled={disabled}
      aria-label={label}
      className="inline-flex size-5 items-center justify-center rounded-[4px] border border-ink-400 bg-paper align-middle text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900 data-[checked]:border-ink-900 data-[checked]:bg-ink-900 data-[indeterminate]:border-ink-900 data-[indeterminate]:bg-ink-900 data-[disabled]:opacity-50"
    >
      <Checkbox.Indicator className="flex data-[unchecked]:hidden">{indeterminate ? <Minus className="size-3.5" aria-hidden /> : <Check className="size-3.5" aria-hidden />}</Checkbox.Indicator>
    </Checkbox.Root>
  );
}

export function ActivitiesTable({
  rows,
  can,
  filters,
  total,
  emptyMessage,
}: {
  rows: ActivityTableRow[];
  /** `activateInstant` (doc 30 N2): bulk arm and "free cancellation confirmed"; back to inquiry needs `publish`. */
  can: RowCapabilities & { publish: boolean; activateInstant?: boolean };
  filters: TableFilters;
  /** Rows matching the filters across every page — the "select all" count. */
  total: number;
  emptyMessage: string;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set(["version"]));
  const [dialog, setDialog] = useState<BulkActionKind | null>(null);
  const [finished, setFinished] = useState(false);

  // A selection that no longer exists on the page must not survive a refresh or a filter change.
  const rowIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const visibleSelected = useMemo(() => new Set([...selected].filter((id) => rowIds.has(id))), [selected, rowIds]);

  const selectable = rows.filter((r) => !r.deleted);
  const allOnPage = selectable.length > 0 && selectable.every((r) => visibleSelected.has(r.id));
  const someOnPage = selectable.some((r) => visibleSelected.has(r.id));
  const count = allMatching ? total : visibleSelected.size;
  const titles = useMemo(() => new Map(rows.map((r) => [r.id, r.title])), [rows]);

  const toggle = (id: string, on: boolean) => {
    setAllMatching(false);
    setSelected((prev) => {
      const next = new Set([...prev].filter((x) => rowIds.has(x)));
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const clear = () => {
    setSelected(new Set());
    setAllMatching(false);
  };
  const onFinished = useCallback(() => setFinished(true), []);

  const actions: BulkActionKind[] = [
    ...(can.publish ? (["published", "draft", "archived"] as const) : []),
    ...(can.activateInstant ? (["arm"] as const) : []),
    ...(can.publish ? (["inquiry"] as const) : []),
    ...(can.activateInstant ? (["free_cancellation"] as const) : []),
  ];

  const allColumns: DataColumn<ActivityTableRow>[] = [
    {
      key: "select",
      className: "w-10",
      header: (
        <>
          <SelectBox
            checked={allOnPage || allMatching}
            indeterminate={!allOnPage && !allMatching && someOnPage}
            onChange={(on) => {
              setAllMatching(false);
              setSelected(on ? new Set(selectable.map((r) => r.id)) : new Set());
            }}
            disabled={selectable.length === 0}
            label="Select every activity on this page"
          />
          <span className="sr-only">Select</span>
        </>
      ),
      cell: (r) => (r.deleted ? null : <SelectBox checked={allMatching || visibleSelected.has(r.id)} onChange={(on) => toggle(r.id, on)} label={`Select ${r.title}`} />),
    },
    {
      key: "title",
      header: "Activity",
      cell: (r) => (
        <div className="min-w-[16rem]">
          <Link href={`/admin/activities/${r.id}`} className="font-semibold text-ink-900 hover:underline">
            {r.title}
          </Link>
          <p className="font-mono text-2xs text-ink-500">
            {r.slug} · {r.categorySlug}
            {!r.categoryPublished && (
              <span className="ml-1 font-sans font-semibold text-[var(--color-warning)]" title="This category is not published, the listing will have no category page">
                category draft
              </span>
            )}
          </p>
        </div>
      ),
    },
    { key: "tier", header: "Tier", cell: (r) => <StatusPill tone={r.tier === "A" ? "accent" : "neutral"}>Tier {r.tier}</StatusPill> },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          <StatusPill tone={r.deleted ? "danger" : (STATUS_TONE[r.status as keyof typeof STATUS_TONE] ?? "neutral")}>{r.deleted ? "deleted" : r.status}</StatusPill>
          {r.quoteOnly && <StatusPill tone="info">quote only</StatusPill>}
        </div>
      ),
    },
    {
      key: "mode",
      header: "Mode",
      cell: (r) => (
        <StatusPill tone={r.fulfilmentMode === "instant" ? "success" : "neutral"} title={r.fulfilmentMode === "instant" ? "Armed: sells instantly once every readiness check passes" : undefined}>
          {r.fulfilmentMode === "instant" ? "armed" : "inquiry"}
        </StatusPill>
      ),
    },
    { key: "price", header: "From ₹", align: "right", cell: (r) => (r.priceFromInr == null ? "—" : r.priceFromInr.toLocaleString("en-IN")) },
    { key: "version", header: "v", align: "right", cell: (r) => String(r.version) },
    { key: "updated", header: "Updated", cell: (r) => <span className="whitespace-nowrap text-ink-600">{fmtDateTime(new Date(r.updatedAt))}</span> },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      cell: (r) => <ActivityRowActions row={{ id: r.id, slug: r.slug, title: r.title, status: r.status, deleted: r.deleted }} can={can} />,
    },
  ];
  const columns = allColumns.filter((c) => !hidden.has(c.key));

  return (
    <>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <form method="get" action="/admin/activities" role="search" className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-500" aria-hidden />
          <input type="search" name="q" defaultValue={filters.q ?? ""} placeholder="Search title, slug, location" aria-label="Search activities" className={`${INPUT_CLASS} min-h-10 pl-8 text-sm`} />
          {filters.status && <input type="hidden" name="status" value={filters.status} />}
          {filters.tier && <input type="hidden" name="tier" value={filters.tier} />}
          {filters.category && <input type="hidden" name="category" value={filters.category} />}
        </form>
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button type="button" size="sm" variant="outline" aria-label="Choose visible columns">
                <Columns3 className="size-4" aria-hidden /> View
              </Button>
            }
          />
          <Menu.Portal>
            <Menu.Positioner align="end" sideOffset={6} className="z-40">
              <Menu.Popup className="min-w-44 rounded-[var(--radius-control)] border border-ink-200 bg-paper p-1 text-sm shadow-[var(--shadow-soft)] outline-none">
                <Menu.Group>
                  <Menu.GroupLabel className="px-2 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-500">Columns</Menu.GroupLabel>
                  {HIDEABLE.map((c) => (
                    <Menu.CheckboxItem
                      key={c.key}
                      checked={!hidden.has(c.key)}
                      closeOnClick={false}
                      onCheckedChange={(on) =>
                        setHidden((prev) => {
                          const next = new Set(prev);
                          if (on) next.delete(c.key);
                          else next.add(c.key);
                          return next;
                        })
                      }
                      className="flex min-h-9 cursor-default items-center gap-2 rounded-[6px] px-2 outline-none select-none data-[highlighted]:bg-ink-100"
                    >
                      <span className="inline-flex size-4 items-center justify-center">
                        <Menu.CheckboxItemIndicator>
                          <Check className="size-3.5" aria-hidden />
                        </Menu.CheckboxItemIndicator>
                      </span>
                      {c.label}
                    </Menu.CheckboxItem>
                  ))}
                </Menu.Group>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>

      {/* Bulk action bar: shown while something is selected. The count is announced. */}
      <div
        className={cn(
          "mb-3 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-ink-200 bg-shell/60 px-3 py-2.5",
          count === 0 && "sr-only",
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-ink-900 tabular-nums" aria-live="polite" aria-atomic="true">
            {count === 0 ? "No listings selected" : `${count.toLocaleString("en-IN")} selected${allMatching ? " (all matching these filters)" : ""}`}
          </span>
          {visibleSelected.size > 0 && !allMatching && total > selectable.length && (
            <button type="button" onClick={() => setAllMatching(true)} className="text-sm font-semibold text-sun-700 underline underline-offset-2">
              Select all {total.toLocaleString("en-IN")} matching these filters
            </button>
          )}
          {count > 0 && (
            <Button type="button" size="sm" variant="ghost" onClick={clear}>
              <X className="size-4" aria-hidden /> Clear
            </Button>
          )}
        </div>
        {count > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Bulk actions">
            {actions.map((a) => (
              <Button
                key={a}
                type="button"
                size="sm"
                variant={a === "published" || a === "arm" ? "primary" : a === "inquiry" ? "outline" : "ghost"}
                onClick={() => {
                  setFinished(false);
                  setDialog(a);
                }}
              >
                {BULK_ACTION_META[a].label}
              </Button>
            ))}
          </div>
        )}
      </div>

      <BulkActionDialog
        kind={dialog}
        open={dialog !== null}
        onOpenChange={(open) => {
          if (open) return;
          setDialog(null);
          if (finished) clear();
        }}
        onFinished={onFinished}
        selection={{ ids: [...visibleSelected].sort(), allMatching, filters, count, titles }}
      />

      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} caption="Activities" empty={emptyMessage} />
    </>
  );
}
