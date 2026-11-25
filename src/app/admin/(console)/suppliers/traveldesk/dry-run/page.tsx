import Link from "next/link";
import { Alert } from "@/components/ui/primitives";
import { hasPermission } from "@/server/lib/actor";
import { traveldeskDryRunService } from "@/server/services/traveldesk-dry-run.service";
import type { PlanMoney, PlannedListing, PlannedOption, PlanStepSummary } from "@/server/suppliers/traveldesk/traveldesk.listing-plan";
import { requirePage } from "../../../../_lib/guard";
import { DataTable, KeyValueList, PageHeader, Panel, StatCard, StatusPill, fmtDateTime, type DataColumn } from "../../../../_components/ui";

/**
 * /admin/suppliers/traveldesk/dry-run — the TravelDesk import dry run (doc 30
 * §3.2, build N0). Read-only: what the importer would create per offer type,
 * at what price under the 17% rule, with every blocker, start-time split,
 * child-price effect, seasonal offer, already-linked offer and the old pages
 * that may be replaced. Nothing is created and no supplier is called.
 *
 * It shows supplier nets, so it needs `suppliers.costs.view` (finance and
 * administrators), not `suppliers.manage`.
 */
export const dynamic = "force-dynamic";

type Params = { env?: string };
const ENVS = ["production", "test"] as const;

const aedMajor = (v: string | null | undefined) => (v === null || v === undefined ? "—" : `AED ${Number(v).toLocaleString("en-AE")}`);
const inrMajor = (v: string | null | undefined) => (v === null || v === undefined ? "—" : `₹${Number(v).toLocaleString("en-IN")}`);
const netAed = (minor: string | null | undefined) => (minor === null || minor === undefined ? "—" : `AED ${(Number(minor) / 100).toLocaleString("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const both = (m: PlanMoney | null) => (m ? `${aedMajor(m.aed)} · ${inrMajor(m.inr)}` : "—");
const pct = (bps: number | null) => (bps === null ? "not set" : `${(bps / 100).toFixed(bps % 100 ? 2 : 0)}%`);

function Blockers({ items }: { items: string[] }) {
  if (items.length === 0) return <StatusPill tone="success">none</StatusPill>;
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Blockers">
      {items.map((b) => (
        <li key={b}>
          <StatusPill tone={b.startsWith("capability:flag_off") || b === "already_linked" ? "warning" : "danger"}>{b.replace(/_/g, " ")}</StatusPill>
        </li>
      ))}
    </ul>
  );
}

function OptionRow({ o }: { o: PlannedOption }) {
  return (
    <li className="border-t border-ink-100 py-2 first:border-t-0">
      <p className="text-xs text-ink-900">
        <span className="font-mono">{o.optionId}</span> {o.offerName ?? ""}
      </p>
      <p className="text-2xs text-ink-600">
        {o.durationHours ? `${o.durationHours} h · ` : ""}
        {o.startTimes.length ? o.startTimes.join(", ") : "no start time"} · child under {o.ages.childrenAllowed ? o.ages.childUnder : "—"} · infant under{" "}
        {o.ages.infantsAllowed ? o.ages.infantUnder : "—"}
      </p>
      <p className="text-2xs text-ink-600">
        Net adult {netAed(o.netAedMinor?.adult)}, child {netAed(o.netAedMinor?.child)}
        {o.netAedMinor?.trip && o.netAedMinor.trip !== "0" ? `, trip ${netAed(o.netAedMinor.trip)}` : ""}
        {o.seasonal ? ` · seasonal: ${o.seasonal.periods} periods, ${netAed(o.seasonal.minAdultNetAedMinor)}–${netAed(o.seasonal.peakAdultNetAedMinor)}, priced at peak` : ""}
      </p>
      <p className="text-2xs text-ink-600">
        Price adult {both(o.rulePrice.adult)}; child {both(o.childUnderGap ?? o.rulePrice.child)}
        {o.childEffect && o.childEffect.aed !== "0" ? ` (+${aedMajor(o.childEffect.aed)} from the one-gap rule)` : ""}
        {o.rulePrice.trip ? `; trip ${both(o.rulePrice.trip)}` : ""}
        {o.floorOk === false ? " · below floor" : o.floorOk === true ? " · floor met" : ""}
      </p>
      {o.linkedTo.length > 0 && <p className="text-2xs text-ink-600">Already linked to {o.linkedTo.map((l) => l.slug).join(", ")}</p>}
      <div className="mt-1">
        <Blockers items={o.blockers} />
      </div>
    </li>
  );
}

function listingColumns(): DataColumn<PlannedListing>[] {
  return [
    {
      key: "listing",
      header: "Listing",
      cell: (l) => (
        <div className="min-w-0 max-w-xs">
          <p className="text-sm text-ink-900">{l.tourName ?? `Tour ${l.tourId}`}</p>
          <p className="font-mono text-2xs text-ink-500">
            tour {l.tourId}
            {l.kind === "instant" ? ` · split ${l.splitNumber}` : ""}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            <StatusPill tone={l.kind === "instant" ? "info" : "neutral"}>{l.kind}</StatusPill>
            {l.adoptProduct && <StatusPill tone="accent" title="Every option is linked to this page already">adopt {l.adoptProduct.slug}</StatusPill>}
            {l.freeCancellationDropped && <StatusPill title={`Supplier refunds in full up to ${l.freeCancellationHours} h; imported as non-refundable (D6)`}>non-refundable at import</StatusPill>}
            {!l.days.everyDay && <StatusPill title="Written into important info">{l.days.differ ? "days differ" : "some days only"}</StatusPill>}
            {l.agesDiffer && <StatusPill>ages differ</StatusPill>}
            {l.seasonalOptions > 0 && <StatusPill>{l.seasonalOptions} seasonal</StatusPill>}
            {l.externalProvider && <StatusPill tone="warning" title={l.externalProvider.note}>provider not named</StatusPill>}
          </div>
        </div>
      ),
    },
    { key: "key", header: "Class key", cell: (l) => <span className="break-all font-mono text-2xs">{l.classKey ?? `${l.arrival} · ${l.fulfilment}`}</span> },
    { key: "starts", header: "Starts", cell: (l) => <span className="text-xs">{l.startTimes.length ? l.startTimes.join(", ") : "—"}</span> },
    { key: "from", header: "From", cell: (l) => <span className="whitespace-nowrap text-xs">{both(l.fromPrice)}</span> },
    { key: "gap", header: "Child gap", cell: (l) => <span className="whitespace-nowrap text-xs">{both(l.childGap)}</span> },
    {
      key: "options",
      header: "Options",
      className: "min-w-[22rem]",
      cell: (l) => (
        <details>
          <summary className="cursor-pointer text-xs underline underline-offset-2">
            {l.options.length} option{l.options.length === 1 ? "" : "s"}, {l.options.filter((o) => o.blockers.length).length} blocked
          </summary>
          <ul className="mt-1">
            {l.options.map((o) => (
              <OptionRow key={o.optionId} o={o} />
            ))}
          </ul>
        </details>
      ),
    },
    {
      key: "old",
      header: "May replace",
      cell: (l) =>
        l.oldPages.length ? (
          <ul className="max-w-[14rem] text-2xs">
            {l.oldPages.slice(0, 5).map((p) => (
              <li key={p.productId} className="break-words">
                {p.slug} <span className="text-ink-500">({p.score})</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-xs text-ink-500">—</span>
        ),
    },
    {
      key: "blockers",
      header: "Listing blockers",
      cell: (l) => <Blockers items={l.blockers} />,
    },
  ];
}

export default async function DryRunPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { actor } = await requirePage("suppliers.costs.view");
  const sp = await searchParams;
  const env = (ENVS as readonly string[]).includes(sp.env ?? "") ? (sp.env as (typeof ENVS)[number]) : "production";
  const r = await traveldeskDryRunService.report(actor, env);
  const columns = listingColumns();

  const stepColumns: DataColumn<PlanStepSummary>[] = [
    { key: "id", header: "Step", cell: (s) => <span className="text-sm">{s.id} · {s.label}</span> },
    { key: "on", header: "Keys on", align: "right", cell: (s) => `${s.flagsOn.length} of ${s.classKeys.length}` },
    { key: "offers", header: "Instant offers", align: "right", cell: (s) => String(s.offers) },
    { key: "base", header: "Listings by tour and key", align: "right", cell: (s) => String(s.instantListingsByTourAndKey) },
    { key: "split", header: "Extra for start times", align: "right", cell: (s) => String(s.extraForStartTimes) },
    { key: "inq", header: "Inquiry listings (offers)", align: "right", cell: (s) => `${s.inquiryListings} (${s.inquiryOffers})` },
    { key: "linked", header: "Already linked", align: "right", cell: (s) => String(s.alreadyLinkedOffers) },
  ];

  return (
    <>
      <PageHeader
        title="Import dry run"
        sub="What the TravelDesk importer would create, one offer type at a time. Read-only: nothing is created, published or priced, and TravelDesk is not called."
      />

      <Alert tone="info" className="mb-4">
        This page shows supplier net prices. Prices follow the planned rule: the lowest whole dirham keeping {pct(r.rules.targetBps)} margin after payment fees, at the
        highest net of any pricing period in force, and one child gap per listing. Editors still fill location, tier, meeting point and category at review.
      </Alert>

      <nav aria-label="Environment" className="mb-4 flex flex-wrap gap-2 text-sm">
        {ENVS.map((e) => (
          <Link
            key={e}
            href={`/admin/suppliers/traveldesk/dry-run?env=${e}`}
            aria-current={e === env ? "page" : undefined}
            className={`rounded-full border px-3 py-1 ${e === env ? "border-ink-900 bg-ink-900 text-paper" : "border-ink-200"}`}
          >
            {e}
          </Link>
        ))}
        {/* Finance holds costs.view without suppliers.manage; the mapping review would refuse them (review 103 N0-13). */}
        {hasPermission(actor, "suppliers.manage") && (
          <Link href={`/admin/suppliers/traveldesk?env=${env}`} className="ml-auto self-center text-sm underline underline-offset-2">
            Back to mapping review
          </Link>
        )}
      </nav>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Tours" value={String(r.tours)} hint={`${r.toursWithContent} with content`} />
        <StatCard label="Offers" value={String(r.totals.offers)} hint={`${r.totals.stepOffers} instant-capable`} />
        <StatCard label="Instant listings" value={String(r.totals.instantListings)} tone="good" />
        <StatCard label="Inquiry listings" value={String(r.totals.inquiryListings)} hint={`${r.totals.inquiryOffers} offers`} />
        <StatCard label="Never instant" value={String(r.totals.neverInstant)} />
        <StatCard label="Not imported" value={String(r.notImported.offers)} hint={`${r.notImported.tours} tours without an instant offer`} />
      </div>

      <Panel className="mb-5" title="Inputs">
        <KeyValueList
          items={[
            { label: "Environment", value: env },
            { label: "Generated", value: fmtDateTime(r.generatedAt) },
            { label: "Last complete sync", value: r.lastCompleteSyncAt ? fmtDateTime(r.lastCompleteSyncAt) : "none recorded" },
            { label: "Target margin", value: pct(r.rules.targetBps) },
            { label: "Floor", value: r.settings.marginPolicyVersion ? `${pct(r.rules.floorBps)} (policy v${r.settings.marginPolicyVersion})` : "not configured" },
            { label: "Payment fees", value: r.settings.costInputsVersion ? `recorded (v${r.settings.costInputsVersion})` : "not recorded: no prices computed" },
            { label: "INR rate", value: r.settings.fxVersion ? `recorded (v${r.settings.fxVersion})` : "missing or expired: no INR prices" },
          ]}
        />
      </Panel>

      {r.tours === 0 && (
        <Alert tone="warning" className="mb-4">
          No stored catalogue in {env}. Run the catalogue sync on the mapping review page first.
        </Alert>
      )}

      <Panel className="mb-5" title="Steps" sub="Offer types in the order they are planned (doc 30 §2.1).">
        <DataTable columns={stepColumns} rows={r.steps} rowKey={(s) => s.id} caption={`Dry run steps, ${env}`} />
      </Panel>

      {r.steps.map((s) => {
        const rows = r.listings.filter((l) => l.step === s.id);
        return (
          <Panel key={s.id} className="mb-5" title={`${s.id} · ${s.label}`} sub={s.classKeys.join(", ")}>
            <DataTable columns={columns} rows={rows} rowKey={(l) => l.key} caption={`Planned listings, step ${s.id}, ${env}`} empty="No listing in this step." />
          </Panel>
        );
      })}

      <Panel className="mb-5" title="Duplicates" sub="Offers already linked to a listing are skipped at import; old pages suggested for more than one new listing need a choice.">
        <KeyValueList
          items={[
            { label: "Already linked offers", value: r.duplicates.linkedOffers.length ? r.duplicates.linkedOffers.map((d) => `#${d.offerId} → ${d.products.map((p) => p.slug).join(", ")}`).join("; ") : "none" },
            { label: "Old pages with several candidates", value: r.duplicates.sharedOldPages.length ? r.duplicates.sharedOldPages.map((d) => `${d.slug} (${d.listingKeys.length})`).join("; ") : "none" },
            { label: "Never instant, by reason", value: Object.entries(r.neverInstant).map(([k, n]) => `${k.replace(/_/g, " ")}: ${n}`).join("; ") || "none" },
          ]}
        />
      </Panel>
    </>
  );
}
