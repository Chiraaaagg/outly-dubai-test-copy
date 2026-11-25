import Link from "next/link";
import { hasPermission } from "@/server/lib/actor";
import { traveldeskUpkeepService } from "@/server/services/traveldesk-upkeep.service";
import { digestLine } from "@/server/suppliers/traveldesk/traveldesk.upkeep";
import { requirePage } from "../../../../_lib/guard";
import { DataTable, PageHeader, Panel, StatusPill, fmtDateTime, type DataColumn } from "../../../../_components/ui";
import { ReviewActions } from "./review-forms";

/**
 * /admin/suppliers/traveldesk/changes — the "supplier changes" log of doc 30
 * §3.10 (build N3, D17): what the daily upkeep changed on imported listings,
 * what waits for a person (a price move above 20%, a diverging or
 * never-instant option sold out, a new offer, a returned tour), and the
 * locked fields whose supplier text changed. Filterable by listing. Values
 * are listing facts and sell prices, never supplier nets.
 */
export const dynamic = "force-dynamic";

type Params = { env?: string; product?: string; status?: string };
const ENVS = ["production", "test"] as const;
const STATUSES = ["review", "applied", "info", "resolved"] as const;

type Row = Awaited<ReturnType<typeof traveldeskUpkeepService.changes>>[number];

const short = (v: unknown) => {
  if (v === null || v === undefined) return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 240 ? `${s.slice(0, 239)}…` : s;
};

function columns(canApprovePrice: boolean, env: string): DataColumn<Row>[] {
  return [
    { key: "when", header: "When", cell: (r) => fmtDateTime(r.createdAt) },
    {
      key: "listing",
      header: "Listing",
      cell: (r) => (
        <div className="min-w-0 max-w-xs">
          <Link href={`/admin/suppliers/traveldesk/changes?env=${env}&product=${r.product.id}`} className="text-sm text-ink-900 underline underline-offset-2">
            {r.product.title}
          </Link>
          <p className="font-mono text-2xs text-ink-500">{r.product.slug}</p>
        </div>
      ),
    },
    { key: "what", header: "Change", cell: (r) => <span className="text-2xs text-ink-700">{digestLine({ slug: r.product.slug, title: r.product.title, kind: r.kind, field: r.field, status: r.status, offerExternalId: r.offerExternalId })}</span> },
    {
      key: "values",
      header: "Before → after",
      cell: (r) => (
        <p className="max-w-md break-words font-mono text-2xs text-ink-600">
          {short(r.before)} → {short(r.after)}
        </p>
      ),
    },
    { key: "status", header: "Status", cell: (r) => <StatusPill tone={r.status === "review" ? "warning" : r.status === "applied" ? "success" : "neutral"}>{r.status === "resolved" ? `resolved (${r.resolution})` : r.status}</StatusPill> },
    { key: "act", header: "Action", cell: (r) => (r.status === "review" ? <ReviewActions changeId={r.id} kind={r.kind} canApprovePrice={canApprovePrice} /> : "—") },
  ];
}

export default async function SupplierChangesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { actor } = await requirePage("products.edit");
  const params = await searchParams;
  const env = ENVS.includes(params.env as (typeof ENVS)[number]) ? (params.env as (typeof ENVS)[number]) : "production";
  const status = STATUSES.includes(params.status as (typeof STATUSES)[number]) ? (params.status as (typeof STATUSES)[number]) : undefined;
  const productId = params.product && /^[0-9a-f-]{36}$/i.test(params.product) ? params.product : undefined;
  const canApprovePrice = hasPermission(actor, "products.publish");
  const rows = await traveldeskUpkeepService.changes(actor, { environment: env, status, productId });
  const filter = (over: Partial<Params>) => {
    const q = new URLSearchParams({ env, ...(status ? { status } : {}), ...(productId ? { product: productId } : {}), ...over } as Record<string, string>);
    for (const [k, v] of [...q]) if (!v) q.delete(k);
    return `/admin/suppliers/traveldesk/changes?${q.toString()}`;
  };

  return (
    <>
      <PageHeader
        title="TravelDesk supplier changes"
        sub="After each complete catalogue sync, imported listings follow TravelDesk: text where your team has not edited it, facts and prices always. Price moves above 20%, options that no longer fit their listing and new offers wait here for a person."
      />
      <nav aria-label="Filters" className="mb-4 flex flex-wrap gap-2 text-sm">
        {ENVS.map((e) => (
          <Link key={e} href={filter({ env: e })} aria-current={e === env ? "page" : undefined} className={`rounded-full border px-3 py-1 ${e === env ? "border-ink-900 bg-ink-900 text-paper" : "border-ink-200"}`}>
            {e}
          </Link>
        ))}
        <span className="mx-2 self-center text-ink-400" aria-hidden="true">
          |
        </span>
        <Link href={filter({ status: "" })} aria-current={!status ? "page" : undefined} className={`rounded-full border px-3 py-1 ${!status ? "border-ink-900 bg-ink-900 text-paper" : "border-ink-200"}`}>
          all
        </Link>
        {STATUSES.map((s) => (
          <Link key={s} href={filter({ status: s })} aria-current={s === status ? "page" : undefined} className={`rounded-full border px-3 py-1 ${s === status ? "border-ink-900 bg-ink-900 text-paper" : "border-ink-200"}`}>
            {s === "review" ? "waits for a person" : s}
          </Link>
        ))}
        {productId && (
          <Link href={filter({ product: "" })} className="self-center underline underline-offset-2">
            All listings
          </Link>
        )}
      </nav>
      <Panel title="Changes" sub="Newest first, at most 200. The owner gets one digest email a day.">
        <DataTable caption={`Supplier changes, ${env}`} rows={rows} rowKey={(r) => r.id} columns={columns(canApprovePrice, env)} empty="No supplier change recorded." />
      </Panel>
    </>
  );
}
