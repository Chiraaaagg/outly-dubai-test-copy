import Link from "next/link";
import { Alert } from "@/components/ui/primitives";
import { hasPermission } from "@/server/lib/actor";
import { traveldeskImportService, type TdPreviewRow } from "@/server/services/traveldesk-import.service";
import { traveldeskListingService, type ReviewQueueRow } from "@/server/services/traveldesk-listing.service";
import { requirePage } from "../../../../_lib/guard";
import { DataTable, PageHeader, Panel, StatusPill, fmtDateTime, type DataColumn } from "../../../../_components/ui";
import { ApplyBatchForm, CopyPhotosForm, PreviewForm, PublishForm, RestoreReplacedForm, ReviewForm, RollbackBatchForm } from "./import-forms";

/**
 * /admin/suppliers/traveldesk/import — the TravelDesk importer (doc 30 §2
 * steps 2–4, §3.14, build N1): preview one offer type, import it as drafts,
 * the review queue with its "replaces" picker, bulk publish with retire and
 * permanent redirect, rollback by batch. Rule prices are shown, never nets.
 */
export const dynamic = "force-dynamic";

type Params = { env?: string; batch?: string };
const ENVS = ["production", "test"] as const;

const money = (m: { aed: number; inr: number }) => `AED ${m.aed.toLocaleString("en-AE")} · ₹${m.inr.toLocaleString("en-IN")}`;

const previewColumns: DataColumn<TdPreviewRow>[] = [
  {
    key: "listing",
    header: "Listing",
    cell: (r) => (
      <div className="min-w-0 max-w-xs">
        <p className="text-sm text-ink-900">{r.title}</p>
        <p className="font-mono text-2xs text-ink-500">{r.slug || r.key}</p>
      </div>
    ),
  },
  { key: "kind", header: "Kind", cell: (r) => <StatusPill tone={r.identity.kind === "instant" ? "success" : "neutral"}>{r.identity.kind}</StatusPill> },
  {
    key: "action",
    header: "Action",
    cell: (r) => <StatusPill tone={r.action === "create" ? "success" : r.action === "blocked" ? "danger" : "neutral"}>{r.action}</StatusPill>,
  },
  {
    key: "options",
    header: "Options",
    cell: (r) =>
      r.input ? (
        <ul className="text-2xs text-ink-700">
          {r.input.variants.map((v) => (
            <li key={v.id}>
              {v.name}: {money({ aed: r.input!.price.adult.aed + v.delta.aed, inr: r.input!.price.adult.inr + v.delta.inr })}
            </li>
          ))}
        </ul>
      ) : (
        <span className="text-2xs text-ink-600">{r.options.map((o) => `td-${o.offerId}`).join(", ") || "—"}</span>
      ),
  },
  { key: "notes", header: "Notes", cell: (r) => <span className="text-2xs text-ink-600">{[...r.reasons, ...r.warnings, ...(r.skippedOffers.length ? [`already linked: ${r.skippedOffers.join(", ")}`] : [])].join("; ") || "—"}</span> },
];

function queueColumns(canPublish: boolean): DataColumn<ReviewQueueRow>[] {
  return [
    {
      key: "listing",
      header: "Listing",
      cell: (r) => (
        <div className="min-w-0 max-w-xs">
          <Link href={`/admin/activities/${r.productId}`} className="text-sm text-ink-900 underline underline-offset-2">
            {r.title}
          </Link>
          <p className="font-mono text-2xs text-ink-500">
            {r.slug} · tour {r.tourExternalId} · {r.kind}
            {r.splitNumber > 1 ? ` · split ${r.splitNumber}` : ""}
          </p>
        </div>
      ),
    },
    {
      key: "state",
      header: "State",
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          <StatusPill tone={r.status === "published" ? "success" : "neutral"}>{r.status}</StatusPill>
          {r.adopted && <StatusPill tone="neutral">adopted</StatusPill>}
          {r.noindex && <StatusPill tone="warning">noindex</StatusPill>}
          {r.reviewedAt && <StatusPill tone="success">reviewed</StatusPill>}
        </div>
      ),
    },
    {
      key: "todo",
      header: "To fill",
      cell: (r) => <span className="text-2xs text-ink-700">{r.pendingFields.length ? r.pendingFields.join(", ") : r.lockedFields.length ? `locked: ${r.lockedFields.join(", ")}` : "—"}</span>,
    },
    {
      key: "review",
      header: "Review",
      cell: (r) =>
        r.reviewedAt ? (
          <div className="space-y-1 text-2xs text-ink-700">
            <p>{r.replaces ? `Replaces ${r.replaces.slug}${r.replaces.deletedAt ? " (retired)" : ""}` : "Replaces nothing"}</p>
            {canPublish && r.replaces?.deletedAt && <RestoreReplacedForm linkId={r.linkId} />}
          </div>
        ) : (
          <ReviewForm linkId={r.linkId} title={r.title} suggestions={r.suggestions} needsConfirm={r.pendingFields.includes("tier") || r.pendingFields.includes("categorySlug")} />
        ),
    },
  ];
}

export default async function TravelDeskImportPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { actor } = await requirePage("products.edit");
  const params = await searchParams;
  const env = ENVS.includes(params.env as (typeof ENVS)[number]) ? (params.env as (typeof ENVS)[number]) : "test";
  const canImport = hasPermission(actor, "imports.run") && hasPermission(actor, "suppliers.manage") && hasPermission(actor, "suppliers.costs.view");
  const canPublish = hasPermission(actor, "products.publish") && hasPermission(actor, "products.delete");
  const [queue, batches, batch] = await Promise.all([
    traveldeskListingService.queue(actor, { environment: env }),
    hasPermission(actor, "imports.run") ? traveldeskImportService.batches(actor) : Promise.resolve([]),
    params.batch && /^[0-9a-f-]{36}$/i.test(params.batch) && hasPermission(actor, "imports.run") ? traveldeskImportService.batch(actor, params.batch).catch(() => null) : Promise.resolve(null),
  ]);
  const publishable = queue.filter((r) => r.reviewedAt && r.status !== "published" && !r.adopted);

  return (
    <>
      <PageHeader
        title="TravelDesk import"
        sub="One offer type at a time: preview, import as drafts, review each draft, then publish. Publishing retires the old page it replaces with a permanent redirect."
      />
      <nav aria-label="Environment" className="mb-4 flex flex-wrap gap-2 text-sm">
        {ENVS.map((e) => (
          <Link key={e} href={`/admin/suppliers/traveldesk/import?env=${e}`} aria-current={e === env ? "page" : undefined} className={`rounded-full border px-3 py-1 ${e === env ? "border-ink-900 bg-ink-900 text-paper" : "border-ink-200"}`}>
            {e}
          </Link>
        ))}
        <Link href={`/admin/suppliers/traveldesk/dry-run?env=${env}`} className="ml-auto self-center underline underline-offset-2">
          Dry run
        </Link>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a CSV download, not a page */}
        <a href="/api/admin/imports/export?source=traveldesk" className="self-center underline underline-offset-2">
          Export imported listings (CSV)
        </a>
      </nav>

      {canImport ? (
        <Panel className="mb-5" title="1 · Preview and import" sub="Drafts are created in inquiry mode, non-refundable and unindexed. Approving a link never changes mode or price.">
          <PreviewForm environment={env} />
          <div className="mt-4">
            <DataTable
              caption="TravelDesk import batches"
              rows={batches}
              rowKey={(b) => b.id}
              empty="No TravelDesk batch yet."
              columns={[
                { key: "ref", header: "Batch", cell: (b) => <Link href={`/admin/suppliers/traveldesk/import?env=${env}&batch=${b.id}`} className="font-mono text-2xs underline">{b.sourceRef ?? b.id.slice(0, 8)}</Link> },
                { key: "when", header: "Created", cell: (b) => fmtDateTime(b.createdAt) },
                { key: "status", header: "Status", cell: (b) => <StatusPill tone={b.status === "applied" ? "success" : b.status === "failed" ? "danger" : "neutral"}>{b.status}</StatusPill> },
                { key: "rows", header: "Rows", align: "right", cell: (b) => `${b.rowsOk} of ${b.rowsTotal}` },
                {
                  key: "act",
                  header: "Action",
                  cell: (b) =>
                    b.status === "previewed" ? (
                      <ApplyBatchForm batchId={b.id} />
                    ) : b.status === "applied" ? (
                      <div className="space-y-2">
                        <CopyPhotosForm batchId={b.id} />
                        <RollbackBatchForm batchId={b.id} />
                      </div>
                    ) : (
                      "—"
                    ),
                },
              ]}
            />
          </div>
          {batch && (
            <div className="mt-4">
              <h3 className="mb-2 text-sm font-semibold">Batch {batch.sourceRef}</h3>
              <DataTable caption={`Rows of batch ${batch.id}`} rows={batch.rows} rowKey={(r) => r.key} columns={previewColumns} />
            </div>
          )}
        </Panel>
      ) : (
        <Alert tone="info" className="mb-5">
          Importing needs imports, supplier and supplier-cost permissions. You can still review drafts below.
        </Alert>
      )}

      <Panel className="mb-5" title="2 · Review queue" sub="Fill location, meeting point, tier and category; give sibling pages their own copy; pick the old page this one replaces; then mark reviewed.">
        <DataTable caption={`Imported listings, ${env}`} rows={queue} rowKey={(r) => r.linkId} columns={queueColumns(canPublish)} empty="No imported listing yet." />
      </Panel>

      {canPublish && (
        <Panel className="mb-5" title="3 · Publish and replace" sub="Each listing commits alone. An old page that is instant or has an open order or inquiry is kept and reported; one still named elsewhere stops the item.">
          <PublishForm rows={publishable.map((r) => ({ linkId: r.linkId, title: r.title, slug: r.slug, replaces: r.replaces?.slug ?? null }))} />
        </Panel>
      )}
    </>
  );
}
