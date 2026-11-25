import Link from "next/link";
import { Alert } from "@/components/ui/primitives";
import { hasPermission } from "@/server/lib/actor";
import { supplierCapabilityService, type CapabilityClassRow, type EvidenceRow } from "@/server/services/supplier-capability.service";
import { requirePage } from "../../../../_lib/guard";
import { DataTable, PageHeader, Panel, StatCard, StatusPill, fmtDateTime, type DataColumn } from "../../../../_components/ui";
import { EvidenceForm, FlagForm, RevokeEvidenceForm } from "./capability-forms";

/**
 * /admin/suppliers/traveldesk/capabilities — capability-class flags and
 * per-offer evidence (doc 29 §3.3, Batch 1a).
 *
 * One row per composed class key: whether it is switched on in this
 * environment, how many stored offers fall in it, how many are mapped, and
 * the evidence recorded. An offer sells instantly only when its exact key is
 * on and, where the flag asks for it, it has evidence for its current terms;
 * every other readiness check still applies.
 */
export const dynamic = "force-dynamic";

type Params = { env?: string };
const ENVS = ["production", "test"] as const;

const NEVER_LABEL: Record<string, string> = {
  not_a_class: "not a sale class",
  private_units_inquiry: "private units stay inquiry",
  date_only_inquiry: "date-only class not built",
  date_only_q5_pending: "locked in production until Q5",
  ticket_booking_refused: "ticket class not built",
  external_route_unproven: "external class not built",
};

function flagPill(r: CapabilityClassRow) {
  if (r.flag?.enabled) return <StatusPill tone="success">On</StatusPill>;
  if (r.neverEnabled) return <StatusPill tone="neutral">{NEVER_LABEL[r.neverEnabled] ?? "never"}</StatusPill>;
  return <StatusPill tone="warning">Off</StatusPill>;
}

export default async function CapabilityFlagsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { actor } = await requirePage("suppliers.manage");
  const sp = await searchParams;
  const env = (ENVS as readonly string[]).includes(sp.env ?? "") ? (sp.env as (typeof ENVS)[number]) : "production";
  const view = await supplierCapabilityService.overview(actor, env);
  // Switching a class on is an instant activation: administrators only (the approval's permission).
  const canEnable = hasPermission(actor, "products.activate_instant");
  const on = view.classes.filter((c) => c.flag?.enabled);
  const offersOn = on.reduce((n, c) => n + c.offers, 0);
  const offers = view.classes.reduce((n, c) => n + c.offers, 0);
  // Only seeded keys may sell without per-offer evidence; for any other key a flag row saying so is not believed (capabilityVerdict).
  const evidenceKeys = view.classes.filter((c) => !c.neverEnabled && (!c.seeded || c.flag?.requiresOfferEvidence !== false)).map((c) => c.classKey);

  const columns: DataColumn<CapabilityClassRow>[] = [
    {
      key: "key",
      header: "Class key",
      cell: (r) => (
        <div className="min-w-0">
          <p className="break-all font-mono text-xs text-ink-900">{r.classKey}</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {r.seeded && <StatusPill tone="info" title="Seeded on by migration (doc 29 §3.3 exception)">seeded</StatusPill>}
            {r.seeded && r.flag && !r.flag.requiresOfferEvidence && <StatusPill title="Offers in this class need no per-offer evidence">no evidence needed</StatusPill>}
            {r.note && <StatusPill tone="warning">keep off: TravelDesk Q5 unanswered</StatusPill>}
          </div>
          {r.note && <p className="mt-1 max-w-md text-xs text-ink-600">{r.note}</p>}
        </div>
      ),
    },
    { key: "flag", header: "Flag", cell: flagPill },
    { key: "offers", header: "Offers", align: "right", cell: (r) => String(r.offers) },
    { key: "review", header: "Need review", align: "right", cell: (r) => String(r.offersNeedingReview) },
    { key: "mapped", header: "Mapped", align: "right", cell: (r) => String(r.mappedOffers) },
    { key: "evidence", header: "Evidence", align: "right", cell: (r) => String(r.evidence) },
    {
      key: "changed",
      header: "Last change",
      cell: (r) =>
        r.flag ? (
          <div className="max-w-xs text-xs text-ink-600">
            <p>{fmtDateTime(r.flag.changedAt)}</p>
            <p className="break-words">{r.flag.reason}</p>
            {r.flag.approvalId && <p className="font-mono text-2xs text-ink-500">approval {r.flag.approvalId.slice(-8)}</p>}
          </div>
        ) : (
          <span className="text-xs text-ink-500">never changed</span>
        ),
    },
    {
      key: "action",
      header: <span className="sr-only">Change</span>,
      className: "w-72",
      cell: (r) =>
        r.dimensions && (r.flag?.enabled || !r.neverEnabled) ? <FlagForm environment={env} classKey={r.classKey} enabled={Boolean(r.flag?.enabled)} canEnable={canEnable} /> : null,
    },
  ];

  const evidenceColumns: DataColumn<EvidenceRow>[] = [
    { key: "offer", header: "Offer", cell: (e) => <span className="font-mono text-xs">#{e.offerExternalId}</span> },
    { key: "key", header: "Class key", cell: (e) => <span className="break-all font-mono text-2xs">{e.classKey}</span> },
    { key: "kind", header: "Evidence", cell: (e) => <span className="text-xs">{e.evidenceKind.replace(/_/g, " ")}</span> },
    { key: "ref", header: "Reference", cell: (e) => <span className="break-words text-xs">{e.reference}</span> },
    { key: "when", header: "Recorded", cell: (e) => <span className="text-xs">{fmtDateTime(e.recordedAt)}</span> },
    {
      key: "state",
      header: "State",
      cell: (e) =>
        e.revokedAt ? (
          <StatusPill tone="neutral" title={e.revokeReason ?? undefined}>
            revoked
          </StatusPill>
        ) : e.current ? (
          <StatusPill tone="success">current terms</StatusPill>
        ) : (
          <StatusPill tone="warning" title="The offer's terms changed since; this evidence no longer counts">
            terms changed
          </StatusPill>
        ),
    },
    { key: "action", header: <span className="sr-only">Revoke</span>, cell: (e) => (e.revokedAt ? null : <RevokeEvidenceForm evidenceId={e.id} />) },
  ];

  return (
    <>
      <PageHeader
        title="Capability classes"
        sub="Which kinds of TravelDesk offer may sell instantly. A class is the exact combination of time shape, arrival, route and pricing; each is switched on separately, per environment."
      />

      <Alert tone="info" className="mb-4">
        Switching a class off stops new instant quotes for its offers at once; they sell as inquiry. Orders already paid keep going through confirmation and refunds.
        Switching a class on needs your authenticator code and, in production, a second administrator. Mapping approval, margin and content checks still apply to
        every offer.
      </Alert>

      <nav aria-label="Environment" className="mb-4 flex flex-wrap gap-2 text-sm">
        {ENVS.map((e) => (
          <Link
            key={e}
            href={`/admin/suppliers/traveldesk/capabilities?env=${e}`}
            aria-current={e === env ? "page" : undefined}
            className={`rounded-full border px-3 py-1 ${e === env ? "border-ink-900 bg-ink-900 text-paper" : "border-ink-200"}`}
          >
            {e}
          </Link>
        ))}
        <Link href={`/admin/suppliers/traveldesk?env=${env}`} className="ml-auto self-center text-sm underline underline-offset-2">
          Back to mapping review
        </Link>
      </nav>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Classes on" value={String(on.length)} hint={env} tone="good" />
        <StatCard label="Offers in classes on" value={String(offersOn)} hint={`of ${offers} stored`} />
        <StatCard label="Derivation" value={`v${view.derivationVersion}`} hint={view.lastDerivedAt ? `derived ${fmtDateTime(view.lastDerivedAt)}` : "no sync since Batch 1a"} />
        <StatCard label="Older derivations" value={String(view.staleDerivations)} hint="rewritten by the next sync" tone={view.staleDerivations ? "warn" : "neutral"} />
      </div>

      {/* Review 89 B6-09 (doc 29 §9.4): an external flag switched on outside Batch 6's own switch-on. */}
      {view.externalFlagsEnabled.length > 0 && (
        <Alert tone="warning" className="mb-4">
          External-route flags are on in {env}: {view.externalFlagsEnabled.join(", ")}. Re-run readiness after deploying Batch 6, and check each
          against its evidence (doc 29 §9.4).
        </Alert>
      )}

      {!view.lastDerivedAt && (
        <Alert tone="warning" className="mb-4">
          No offer has a stored capability yet. Run the catalogue sync on the mapping review page; counts below are zero until then. The gate itself reads the stored
          offers directly and does not wait for it.
        </Alert>
      )}

      <Panel className="mb-5" title="Class flags" sub={`${env}. Keys never seen in the catalogue appear once a flag exists for them.`}>
        <DataTable columns={columns} rows={view.classes} rowKey={(r) => r.classKey} caption={`Capability class flags, ${env}`} />
      </Panel>

      <Panel className="mb-5" title="Per-offer evidence" sub="Needed for every class except the seeded ones. Evidence lapses when the offer's terms change.">
        <DataTable columns={evidenceColumns} rows={view.evidence} rowKey={(e) => e.id} caption={`Per-offer evidence, ${env}`} empty="No evidence recorded in this environment." />
        {canEnable && (
          <div className="mt-5 border-t border-ink-100 pt-4">
            <h3 className="mb-3 text-sm font-semibold text-ink-900">Record evidence</h3>
            <EvidenceForm environment={env} classKeys={evidenceKeys} />
          </div>
        )}
      </Panel>
    </>
  );
}
