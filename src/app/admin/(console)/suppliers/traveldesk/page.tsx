import Link from "next/link";
import { Alert } from "@/components/ui/primitives";
import { hasPermission } from "@/server/lib/actor";
import { env as appEnv } from "@/server/lib/env";
import { pinnedControlAccount, supplierBookingService } from "@/server/services/supplier-booking.service";
import { supplierCatalogService, type CandidateRow } from "@/server/services/supplier-catalog.service";
import { traveldeskConfigFrom } from "@/server/suppliers/traveldesk/traveldesk.config";
import { requirePage } from "../../../_lib/guard";
import { PageHeader, Panel, StatCard, StatusPill, type PillTone } from "../../../_components/ui";
import { BookingControls } from "./booking-controls";
import { CatalogueSync } from "./catalogue-sync";
import { ReadinessRerun } from "./readiness-rerun";
import { ReviewForm } from "./review-form";
import { TicketEvidenceForm } from "./ticket-evidence-form";

/**
 * /admin/suppliers/traveldesk — mapping review (docs/backend/21 §2–§3).
 *
 * The matcher only suggests; a reviewer approves or rejects each candidate
 * with a reason. Approval writes a supplier mapping and nothing else: no
 * fulfilment-mode change, no price change, no content change. Margins are
 * gross on the OUTLY sell price BEFORE fees and taxes, from the supplier's
 * reference price period — a screen, not a decision.
 */
export const dynamic = "force-dynamic";
/** The catalogue sync runs as a Server Action on this page and can take a few minutes. */
export const maxDuration = 300;

type Params = { state?: string; env?: string };

const STATES = ["suggested", "approved", "rejected"] as const;
const ENVS = ["production", "test"] as const;

const KIND_LABEL: Record<string, { label: string; tone: PillTone }> = {
  live_book: { label: "Live booking", tone: "success" },
  ticket_only: { label: "Ticket only", tone: "info" },
  on_request: { label: "On request", tone: "warning" },
  unknown: { label: "Unknown type", tone: "danger" },
};

const RUN_STATUS: Record<string, { label: string; tone: PillTone }> = {
  complete: { label: "Last sync complete", tone: "success" },
  incomplete: { label: "Last sync incomplete", tone: "warning" },
  running: { label: "Sync running", tone: "info" },
  failed: { label: "Last sync failed", tone: "danger" },
};

const utc = (d: Date | null | undefined) => (d ? `${d.toISOString().slice(0, 16).replace("T", " ")} UTC` : "—");

function aed(minor: string | null): string {
  if (minor === null) return "—";
  const n = Number(minor) / 100;
  return n.toLocaleString("en-AE", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function margin(bps: number | null): { text: string; tone: PillTone } {
  if (bps === null) return { text: "no net", tone: "neutral" };
  return { text: `${(bps / 100).toFixed(1)}%`, tone: bps >= 1500 ? "success" : bps >= 0 ? "warning" : "danger" };
}

function group(rows: CandidateRow[]) {
  const by = new Map<string, { product: CandidateRow["product"]; rows: CandidateRow[] }>();
  for (const r of rows) {
    const g = by.get(r.product.id) ?? { product: r.product, rows: [] };
    g.rows.push(r);
    by.set(r.product.id, g);
  }
  return [...by.values()];
}

export default async function TravelDeskMappingPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { actor } = await requirePage("suppliers.manage");
  const sp = await searchParams;
  const state = (STATES as readonly string[]).includes(sp.state ?? "") ? (sp.state as (typeof STATES)[number]) : "suggested";
  const env = (ENVS as readonly string[]).includes(sp.env ?? "") ? (sp.env as (typeof ENVS)[number]) : "production";
  const config = traveldeskConfigFrom(appEnv());

  const [summary, rows, bookings, syncRuns] = await Promise.all([
    supplierCatalogService.summary(actor),
    supplierCatalogService.listCandidates(actor, { state, environment: env }),
    // The rows the write action changes (D2): the pinned account per environment, not the default key.
    supplierBookingService.overview(actor, { accounts: { test: pinnedControlAccount("test", config), production: pinnedControlAccount("production", config) } }),
    supplierCatalogService.lastSyncRuns(actor, env),
  ]);
  const lastRun = syncRuns.latest;
  const runPill = lastRun ? (RUN_STATUS[lastRun.status] ?? RUN_STATUS.failed) : null;
  const bookingCounts = bookings.counts.filter((c) => c.environment === env);
  // The controls shown and posted are the selected environment's (CR-11).
  const control = bookings.controls[env];
  const reconcile = bookings.lastReconcile[env];
  const groups = group(rows);
  // Ticket answers change refundability: administrators only (Q6).
  const canSetEvidence = hasPermission(actor, "products.activate_instant");
  // The environment this deployment's key belongs to: the only one the sync can pull.
  const syncEnvironment = config?.environment ?? null;

  const count = (s: string) => (summary.configured ? summary.candidates.filter((c) => c.environment === env && c.state === s).reduce((n, c) => n + c.count, 0) : 0);
  const offers = summary.configured ? summary.items.filter((i) => i.environment === env && i.kind === "offer").reduce((n, i) => n + i.count, 0) : 0;
  const tours = summary.configured ? summary.items.filter((i) => i.environment === env && i.kind === "tour").reduce((n, i) => n + i.count, 0) : 0;
  const link = (p: Partial<Params>) => `/admin/suppliers/traveldesk?${new URLSearchParams({ state, env, ...p } as Record<string, string>).toString()}`;

  return (
    <>
      <PageHeader
        title="TravelDesk mapping review"
        sub="Suggestions from the matcher. Approving records which TravelDesk offer can fulfil an OUTLY variant. It does not make anything instant, change a price or touch product content."
      />

      <Alert tone="info" className="mb-4">
        Margins are gross on the OUTLY sell price before payment fees and taxes, using TravelDesk&apos;s reference price. Check slots, inclusions, pax bands and the
        cancellation policy before approving. Test and production ids are different: approve against the environment you will book in.
      </Alert>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard label="Tours" value={String(tours)} hint={env} />
        <StatCard label="Offers" value={String(offers)} hint={summary.configured && summary.lastSyncAt[env] ? `synced ${summary.lastSyncAt[env]!.slice(0, 16).replace("T", " ")} UTC` : "never synced"} />
        <StatCard label="Suggested" value={String(count("suggested"))} href={link({ state: "suggested" })} tone="accent" />
        <StatCard label="Approved" value={String(count("approved"))} href={link({ state: "approved" })} tone="good" />
        <StatCard label="Rejected" value={String(count("rejected"))} href={link({ state: "rejected" })} />
      </div>

      <Panel
        className="mb-5"
        title="Catalogue"
        sub="Load TravelDesk's tours and offers into this database. Read only; nothing is booked. It also runs by itself once a day at 03:00 Dubai time."
        actions={runPill && <StatusPill tone={runPill.tone}>{runPill.label}</StatusPill>}
      >
        <div className="mb-4 text-xs text-ink-600">
          {!lastRun ? (
            <p>No sync run recorded for {env} yet.</p>
          ) : (
            <>
              <p>
                Last run ({env}, {lastRun.triggeredBy === "cron" ? "scheduled" : "button"}): started {utc(lastRun.startedAt)}
                {lastRun.finishedAt && `, finished ${utc(lastRun.finishedAt)}`}. {lastRun.tours} tours and {lastRun.offers} offers read; added {lastRun.added}, changed{" "}
                {lastRun.changed}, removed {lastRun.removed}.
                {lastRun.resumedFromRunId && " It continued an earlier incomplete run."}
                {lastRun.status === "incomplete" && ` Stopped at the time limit; the next run continues after tour ${lastRun.resumeAfterTourId ?? "—"}.`}
                {lastRun.status === "failed" && ` Failed (${lastRun.errorCode ?? "error"}).`}
                {lastRun.failedTours.length > 0 && ` ${lastRun.failedTours.length} tour(s) failed to load.`}
                {lastRun.removalsSkipped && ` Removals skipped (${lastRun.removalsSkipped.replace(/_/g, " ")}).`}
              </p>
              <p className={syncRuns.stale ? "mt-1 font-semibold text-[var(--color-danger)]" : "mt-1"}>
                Last complete sync: {utc(syncRuns.lastComplete?.finishedAt)}.{" "}
                {syncRuns.stale
                  ? `Older than ${syncRuns.staleAfterHours} hours: mapped instant products show as inquiry until a sync completes.`
                  : `Mapped instant products fall back to inquiry when it is older than ${syncRuns.staleAfterHours} hours.`}
              </p>
            </>
          )}
        </div>
        <CatalogueSync environment={syncEnvironment} />
        <ReadinessRerun />
      </Panel>

      <Panel
        className="mb-5"
        title="Booking engine"
        sub={`${env} bookings. Bookings need TRAVELDESK_BOOKINGS_ENABLED, and production also TRAVELDESK_AGENCY_ID. New sales start only when this switch runs.`}
        actions={
          <StatusPill tone={control.paused ? "danger" : "success"}>{!control.paused ? "Running" : control.scope === "all_writes" ? "Emergency stop" : "New sales paused"}</StatusPill>
        }
      >
        {control.paused && control.reason && <Alert tone="warning" className="mb-3">{control.reason}</Alert>}
        <div className="mb-4 flex flex-wrap gap-1.5">
          {bookingCounts.length === 0 && <span className="text-sm text-ink-600">No bookings in {env}.</span>}
          {bookingCounts.map((c) => (
            <StatusPill key={c.state} tone={c.state === "manual_review" || c.state === "outcome_unknown" ? "danger" : c.state === "confirmed" ? "success" : "neutral"}>
              {c.state.replace(/_/g, " ")} {c.count}
            </StatusPill>
          ))}
        </div>
        <p className="mb-4 text-xs text-ink-600">
          {reconcile
            ? `Last reconciliation ${reconcile.ranAt.slice(0, 16).replace("T", " ")} UTC: ${reconcile.issues.length} difference(s); ${reconcile.supplierListed} TravelDesk bookings listed, ${reconcile.otherBookings} not made by OUTLY.`
            : `No reconciliation run for ${env} yet.`}
        </p>
        {reconcile && reconcile.issues.length > 0 && (
          <ul className="mb-4 list-disc pl-4 text-xs text-[var(--color-danger)]">
            {reconcile.issues.slice(0, 20).map((i, n) => (
              <li key={n}>
                {i.kind.replace(/_/g, " ")}: {i.reference ?? "—"} (TravelDesk #{i.supplierBookingId ?? "—"}, ours {i.ours ?? "—"}, theirs {i.theirs ?? "—"})
              </li>
            ))}
          </ul>
        )}
        <BookingControls
          key={env}
          environment={env}
          paused={control.paused}
          scope={control.scope}
          maxBookingAed={Math.floor(control.maxBookingNetMinor / 100)}
          minFundsAfterAed={Math.floor(control.minFundsAfterMinor / 100)}
        />
      </Panel>

      <nav aria-label="Filters" className="mb-4 flex flex-wrap gap-2 text-sm">
        {ENVS.map((e) => (
          <Link key={e} href={link({ env: e })} className={`rounded-full border px-3 py-1 ${e === env ? "border-ink-900 bg-ink-900 text-paper" : "border-ink-200"}`}>
            {e}
          </Link>
        ))}
        <span className="mx-1 text-ink-300" aria-hidden>
          |
        </span>
        {STATES.map((s) => (
          <Link key={s} href={link({ state: s })} className={`rounded-full border px-3 py-1 ${s === state ? "border-ink-900 bg-ink-900 text-paper" : "border-ink-200"}`}>
            {s}
          </Link>
        ))}
        <Link href={`/admin/suppliers/traveldesk/capabilities?env=${env}`} className="ml-auto self-center underline underline-offset-2">
          Capability classes
        </Link>
        {hasPermission(actor, "suppliers.costs.view") && (
          <Link href={`/admin/suppliers/traveldesk/dry-run?env=${env}`} className="self-center underline underline-offset-2">
            Import dry run
          </Link>
        )}
        <Link href={`/admin/suppliers/traveldesk/import?env=${env}`} className="self-center underline underline-offset-2">
          Import and review
        </Link>
      </nav>

      {!summary.configured && <Alert tone="warning">No TravelDesk catalogue yet. Use the catalogue sync above first.</Alert>}
      {summary.configured && groups.length === 0 && <p className="text-sm text-ink-600">No {state} candidates in {env}.</p>}

      <div className="space-y-4">
        {groups.map((g) => (
          <Panel
            key={g.product.id}
            title={g.product.title}
            sub={
              <span className="font-mono text-2xs text-ink-500">
                {g.product.slug} · {g.product.status} · {g.product.fulfilmentMode}
              </span>
            }
          >
            <ul className="divide-y divide-ink-100">
              {g.rows.map((r) => {
                const kind = KIND_LABEL[r.offer.bookingKind ?? "unknown"] ?? KIND_LABEL.unknown;
                const m = margin(r.marginBps);
                return (
                  <li key={r.id} className="grid gap-3 py-3 lg:grid-cols-[1.2fr_1fr_auto]">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wider text-ink-500">{r.variantName}</p>
                      <p className="font-semibold text-ink-900">
                        {r.offer.name ?? `Offer ${r.offer.externalId}`}{" "}
                        <span className="font-mono text-2xs text-ink-500">
                          #{r.offer.externalId} · tour {r.tour.externalId} {r.tour.name ?? ""}
                        </span>
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <StatusPill tone={kind.tone}>{kind.label}</StatusPill>
                        {r.offer.isExternal && <StatusPill tone="warning">External operator</StatusPill>}
                        {r.offer.removed && <StatusPill tone="danger">No longer listed</StatusPill>}
                        <StatusPill tone={m.tone} title="Gross margin before fees">
                          {m.text}
                        </StatusPill>
                        <StatusPill>score {r.score}</StatusPill>
                        <StatusPill>
                          sell {aed(r.sellAdultMinor)} · net {aed(r.netAdultMinor)} AED
                        </StatusPill>
                      </div>
                    </div>
                    <div className="text-xs">
                      {r.conflicts.length > 0 && (
                        <ul className="mb-1 list-disc pl-4 text-[var(--color-warning)]">
                          {r.conflicts.map((c) => (
                            <li key={c}>{c}</li>
                          ))}
                        </ul>
                      )}
                      <ul className="list-disc pl-4 text-ink-600">
                        {r.evidence.map((e) => (
                          <li key={e}>{e}</li>
                        ))}
                      </ul>
                      {r.reviewNote && <p className="mt-1 text-ink-500">Review: {r.reviewNote}</p>}
                    </div>
                    <div className="space-y-3 lg:w-72">
                      <ReviewForm id={r.id} state={r.state} label={`${g.product.title} → offer ${r.offer.externalId}`} />
                      {r.mapping && (
                        <TicketEvidenceForm
                          mappingId={r.mapping.id}
                          current={r.mapping.ticketEvidence?.issuesTicketsAtConfirm ?? "unknown"}
                          source={r.mapping.ticketEvidence?.source ?? null}
                          recordedAt={r.mapping.ticketEvidence?.recordedAt ?? null}
                          canEdit={canSetEvidence}
                          instant={g.product.fulfilmentMode === "instant"}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Panel>
        ))}
      </div>
    </>
  );
}
