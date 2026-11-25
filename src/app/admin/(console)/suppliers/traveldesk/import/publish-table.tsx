"use client";

import { useActionState, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Columns3, Search, X } from "lucide-react";
import { Menu } from "@base-ui/react/menu";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/primitives";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/shadcn/alert-dialog";
import { publishListingsAction, type PublishListingsResult } from "../../../../_actions/traveldesk-import";
import { DataTable, INPUT_CLASS, StatusPill, type DataColumn } from "../../../../_components/ui";
import { SelectBox } from "../../../../_components/select-box";
import { addWithinCap, filterPublishRows, pageOf, PUBLISH_MAX, publishResultRows, type PublishRow } from "./import-ui";

/**
 * Publish and replace (doc 30 §3.9, §3.14; build N1 with the owner's
 * decision 23 picks): the reviewed drafts in the adapted "Team Members Data
 * Table" (search, row checkboxes with an indeterminate select-all, an
 * announced selected count, a bulk bar, badges, a column toggle, pages), and
 * the shadcn Alert Dialog on Base UI to confirm, with the result list.
 *
 * The server stays authoritative: `publishListingsAction` takes at most 50
 * listings and re-checks each one's review gate, references and retire
 * rules; this table only keeps the selection within 50 as a convenience.
 */

const HIDEABLE = [
  { key: "slug", label: "Slug" },
  { key: "replaces", label: "Replaces" },
] as const;

function PublishDialogBody({ ids, titles, onFinished }: { ids: string[]; titles: Map<string, string>; onFinished: () => void }) {
  const [state, submit, pending] = useActionState<PublishListingsResult | null, FormData>(publishListingsAction, null);
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const rows = state?.ok ? publishResultRows(state.data.results, titles) : null;
  const applied = rows?.filter((r) => r.state === "applied").length ?? 0;
  const failed = rows?.filter((r) => r.state === "failed").length ?? 0;
  const message = rows ? `${applied} published, ${failed} stopped` : "";
  useEffect(() => {
    if (!rows) return;
    onFinished();
    heading.current?.focus();
    // Once per result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <div className="grid gap-3">
      {/* Mounted empty, so the result is announced when it is written (re-review N2-19). */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </div>
      {rows ? (
        <>
          <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold text-ink-900 outline-none focus-visible:outline-2 focus-visible:outline-ink-900">
            Result
          </h3>
          <Alert tone={failed ? "warning" : "success"} title={message} />
          <ul className="max-h-60 space-y-1 overflow-y-auto rounded-[var(--radius-control)] border border-ink-200 p-2 text-xs text-ink-700">
            {rows.map((r) => (
              <li key={r.linkId} className="flex flex-wrap gap-x-2">
                <span className={r.state === "applied" ? "font-semibold text-[var(--color-success)]" : "font-semibold text-[var(--color-danger)]"}>{r.state === "applied" ? "applied" : "failed"}</span>
                <span className="font-semibold text-ink-800">{r.title}</span>
                <span>{r.detail}</span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </>
      ) : (
        <form action={submit} className="grid gap-3">
          {ids.map((linkId) => (
            <input key={linkId} type="hidden" name="linkIds" value={linkId} />
          ))}
          <label htmlFor={`${id}-reason`} className="block text-xs font-semibold text-ink-800">
            Reason (owner approval reference)
            <input id={`${id}-reason`} name="reason" required minLength={8} maxLength={500} className={`${INPUT_CLASS} mt-1 min-h-10 text-sm font-normal`} />
          </label>
          {state && !state.ok && (
            <Alert tone="danger" title={state.message} role="alert">
              {state.fields ? Object.values(state.fields).join("; ") : state.recovery}
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="submit" size="sm" variant="primary" loading={pending} loadingLabel="Publishing…">
              Publish and replace {ids.length} listing{ids.length === 1 ? "" : "s"}
            </Button>
          </AlertDialogFooter>
        </form>
      )}
    </div>
  );
}

export function PublishTable({ rows }: { rows: PublishRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [capNote, setCapNote] = useState("");
  const [open, setOpen] = useState(false);
  const [finished, setFinished] = useState(false);
  const countRef = useRef<HTMLSpanElement>(null);

  const ids = useMemo(() => new Set(rows.map((r) => r.linkId)), [rows]);
  const live = useMemo(() => new Set([...selected].filter((x) => ids.has(x))), [selected, ids]);
  const titles = useMemo(() => new Map(rows.map((r) => [r.linkId, r.title])), [rows]);
  const filtered = filterPublishRows(rows, query);
  const shown = pageOf(filtered, page);
  const allShown = shown.rows.length > 0 && shown.rows.every((r) => live.has(r.linkId));
  const someShown = shown.rows.some((r) => live.has(r.linkId));

  const setMany = (list: string[], on: boolean) => {
    if (!on) {
      setSelected((prev) => new Set([...prev].filter((x) => !list.includes(x))));
      setCapNote("");
      return;
    }
    const { next, dropped } = addWithinCap(live, list);
    setSelected(next);
    setCapNote(dropped ? `${dropped} not selected: one run publishes at most ${PUBLISH_MAX}.` : "");
  };

  const columns: DataColumn<PublishRow>[] = [
    {
      key: "select",
      className: "w-10",
      header: (
        <>
          <SelectBox
            checked={allShown}
            indeterminate={!allShown && someShown}
            onChange={(on) => setMany(shown.rows.map((r) => r.linkId), on)}
            disabled={shown.rows.length === 0}
            label="Select every reviewed draft on this page"
          />
          <span className="sr-only">Select</span>
        </>
      ),
      cell: (r) => <SelectBox checked={live.has(r.linkId)} onChange={(on) => setMany([r.linkId], on)} label={`Select ${r.title}`} />,
    },
    { key: "title", header: "Listing", cell: (r) => <span className="text-sm text-ink-900">{r.title}</span> },
    { key: "slug", header: "Slug", cell: (r) => <span className="font-mono text-2xs text-ink-500">{r.slug}</span> },
    {
      key: "replaces",
      header: "Replaces",
      cell: (r) => (r.replaces ? <StatusPill tone="warning" title="Retired with a permanent redirect when this one is published">retires {r.replaces}</StatusPill> : <StatusPill tone="neutral">new page</StatusPill>),
    },
  ];

  if (rows.length === 0) return <p className="text-sm text-ink-600">No reviewed draft is waiting.</p>;

  return (
    <>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div role="search" className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-500" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            placeholder="Search title, slug or old page"
            aria-label="Search reviewed drafts"
            className={`${INPUT_CLASS} min-h-10 pl-8 text-sm`}
          />
        </div>
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button type="button" size="sm" variant="outline">
                <Columns3 className="size-4" aria-hidden /> View<span className="sr-only"> visible columns</span>
              </Button>
            }
          />
          <Menu.Portal>
            <Menu.Positioner align="end" sideOffset={6} className="z-40">
              <Menu.Popup className="min-w-40 rounded-[var(--radius-control)] border border-ink-200 bg-paper p-1 text-sm shadow-[var(--shadow-soft)] outline-none">
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

      {/* Bulk bar: always present, so focus can return to its count after a run (re-review N2-18). */}
      <div className={`mb-3 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-ink-200 px-3 py-2.5 ${live.size ? "bg-shell/60" : "bg-paper"}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span ref={countRef} tabIndex={-1} aria-live="polite" aria-atomic="true" className="text-sm font-semibold text-ink-900 tabular-nums outline-none focus-visible:outline-2 focus-visible:outline-ink-900">
            {live.size === 0 ? "Select reviewed drafts to publish" : `${live.size} selected (at most ${PUBLISH_MAX})`}
          </span>
          {live.size > 0 && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setMany([...live], false)}>
              <X className="size-4" aria-hidden /> Clear
            </Button>
          )}
          <span className="text-xs text-[var(--color-warning)]" aria-live="polite">
            {capNote}
          </span>
        </div>
        {live.size > 0 && (
          <Button
            type="button"
            size="sm"
            variant="primary"
            onClick={() => {
              setFinished(false);
              setOpen(true);
            }}
          >
            Publish and replace
          </Button>
        )}
      </div>

      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) return;
          if (finished) setSelected(new Set());
          router.refresh();
        }}
      >
        {open && (
          <AlertDialogContent finalFocus={countRef}>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Publish and replace: {live.size} listing{live.size === 1 ? "" : "s"}
              </AlertDialogTitle>
              <AlertDialogDescription render={<div />}>
                <p className="mb-1">Each listing commits alone. An old page that is instant or has an open order or inquiry is kept and reported; one still named elsewhere stops the item.</p>
                <ul className="list-disc space-y-0.5 pl-5 text-ink-700">
                  {[...live].slice(0, 6).map((x) => (
                    <li key={x} className="break-words">
                      {titles.get(x)}
                    </li>
                  ))}
                </ul>
                {live.size > 6 && <p className="mt-1 text-xs text-ink-500">and {live.size - 6} more</p>}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <PublishDialogBody ids={[...live].sort()} titles={titles} onFinished={() => setFinished(true)} />
          </AlertDialogContent>
        )}
      </AlertDialog>

      <DataTable columns={columns.filter((c) => !hidden.has(c.key))} rows={shown.rows} rowKey={(r) => r.linkId} caption="Reviewed drafts to publish" empty="No reviewed draft matches the search." />

      {shown.pages > 1 && (
        <nav aria-label="Pages of reviewed drafts" className="mt-3 flex items-center gap-2 text-sm">
          <Button type="button" size="sm" variant="outline" disabled={shown.page <= 1} onClick={() => setPage(shown.page - 1)}>
            Previous
          </Button>
          <span aria-live="polite">
            Page {shown.page} of {shown.pages}
          </span>
          <Button type="button" size="sm" variant="outline" disabled={shown.page >= shown.pages} onClick={() => setPage(shown.page + 1)}>
            Next
          </Button>
        </nav>
      )}
    </>
  );
}
