import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { requirePage } from "@/app/admin/_lib/guard";
import { DataTable, fmtDateTime, KeyValueList, PageHeader, Panel, StatusPill, type DataColumn } from "@/app/admin/_components/ui";
import { fmtDate } from "@/app/admin/_components/inquiry/format";
import { Alert } from "@/components/ui/primitives";
import { hasPermission } from "@/server/lib/actor";
import {
  CLEAR_REASON_LABELS,
  CLEAR_REASONS,
  LATE_ACCEPTANCE_RESOLVED,
  EVIDENCE_MAX,
  OPS_QUEUE_PERMISSION,
  REFETCH_REASONS,
  opsQueueService,
  stateLabel,
  type OrderOpsDetail,
  type QueueSource,
} from "@/server/services/ops-queue.service";
import { ApproveResolutionForm, ClearAttentionForm, CloseExceptionForm, CloseRefundFailedForm, DeliberateReadForm, RefetchForm } from "./booking-actions";

/**
 * /admin/bookings/[reference] — one order's instant booking, item by item
 * (doc 22 §23 B5). The queues link to `#item-<orderItemId>`.
 *
 * Built from the console's own pieces only: `PageHeader`, `Panel`,
 * `KeyValueList`, `DataTable` and the generic `StatusPill` (tone plus text),
 * with `Alert` from the shared primitives and the forms in
 * `booking-actions.tsx`. No new visual design.
 *
 * Guard: `orders.view_all`. What the service returns already depends on the
 * role: no net costs, margins, wallet ledger or supplier error text without
 * `suppliers.costs.view`; masked contact without `customers.view_pii`. The
 * actions render only for `tickets.resend` and
 * `bookings.privileged_resolution`, and the server actions check again.
 */
export const dynamic = "force-dynamic";

const REFETCH_LABELS: Record<(typeof REFETCH_REASONS)[number], string> = {
  customer_reported: "Customer reported a problem",
  content_wrong: "Content looks wrong",
  missing_pages: "Pages or tickets missing",
  staff_check: "Staff check",
};

function money(minor: string | null | undefined, currency: string | null | undefined): string {
  if (minor === null || minor === undefined || !currency) return "—";
  return `${(Number(minor) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function State({ source, state, attention }: { source: QueueSource; state: string; attention?: string | null }) {
  const { label, tone } = stateLabel(source, state);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <StatusPill tone={tone}>{label}</StatusPill>
      {attention && <StatusPill tone="danger">Needs attention</StatusPill>}
    </span>
  );
}

function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-bold uppercase tracking-wider text-ink-600">{title}</h3>
      {children}
    </div>
  );
}

type Detail = OrderOpsDetail;
type Booking = Detail["bookings"][number];
type Doc = Detail["documents"][number];

export default async function BookingDetailPage({ params }: { params: Promise<{ reference: string }> }) {
  const { actor } = await requirePage(OPS_QUEUE_PERMISSION);
  const { reference: raw } = await params;
  let reference: string;
  try {
    reference = decodeURIComponent(raw);
  } catch {
    notFound();
  }
  const detail = await opsQueueService.orderDetail(actor, reference);
  if (!detail) notFound();

  const canTickets = hasPermission(actor, "tickets.resend");
  const canResolve = hasPermission(actor, "bookings.privileged_resolution");
  const reasons = CLEAR_REASONS.map((r) => ({ value: r, label: CLEAR_REASON_LABELS[r] }));
  const refetchReasons = REFETCH_REASONS.map((r) => ({ value: r, label: REFETCH_LABELS[r] }));
  const { order, viewer } = detail;
  const contact = order.contact;

  // The late-acceptance reason applies to supplier bookings only (R-B5-16); the service refuses it elsewhere.
  const clear = (target: string, id: string) =>
    canResolve ? (
      <ClearAttentionForm
        target={target}
        targetId={id}
        reference={order.reference}
        reasons={target === "supplier_booking" ? reasons : reasons.filter((r) => r.value !== LATE_ACCEPTANCE_RESOLVED)}
        evidenceMax={EVIDENCE_MAX}
      />
    ) : null;

  const bookingColumns: DataColumn<Booking>[] = [
    { key: "attempt", header: "Try", cell: (b) => <span className="tnum">{b.attempt}</span> },
    { key: "state", header: "State", cell: (b) => <State source="supplier_booking" state={b.state} attention={b.attentionRequiredAt} /> },
    { key: "code", header: "Last code", cell: (b) => <span className="font-mono text-2xs">{b.errorCode ?? "—"}</span> },
    { key: "env", header: "Environment", cell: (b) => b.environment },
    { key: "ref", header: "References", cell: (b) => <span className="font-mono text-2xs">{b.clientRef}{b.supplierBookingId ? ` · ${b.supplierBookingId}` : ""}</span> },
    { key: "updated", header: "Updated", cell: (b) => <span className="text-xs">{fmtDateTime(b.updatedAt)}</span> },
  ];

  const documentColumns: DataColumn<Doc>[] = [
    { key: "kind", header: "Kind", cell: (d) => <span className="font-mono text-2xs">{d.kind} v{d.version}</span> },
    { key: "state", header: "State", cell: (d) => <State source="supplier_document" state={d.status} attention={d.attentionRequiredAt} /> },
    { key: "fetch", header: "Reads", cell: (d) => <span className="tnum text-xs">{d.fetchAttempts}{d.nextFetchAt ? ` · next ${fmtDateTime(d.nextFetchAt)}` : ""}</span> },
    { key: "why", header: "Code", cell: (d) => <span className="font-mono text-2xs">{d.quarantineReason ?? "—"}</span> },
    {
      key: "act",
      header: <span className="sr-only">Actions</span>,
      cell: (d) =>
        canTickets && d.status !== "superseded" ? (
          <RefetchForm documentId={d.id} reference={order.reference} reasons={refetchReasons} />
        ) : null,
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Order ${order.reference}`}
        sub={
          <Link href="/admin/bookings" className="font-semibold text-sun-700 underline underline-offset-2">
            Back to the queues
          </Link>
        }
        actions={<StatusPill tone="neutral">{order.status.replace(/_/g, " ")}</StatusPill>}
      />

      {!viewer.costs && (
        <Alert tone="info" title="Net costs are hidden for your role">
          Supplier net figures, margins and the supplier wallet need the supplier costs permission.
        </Alert>
      )}

      <Panel title="Order">
        <KeyValueList
          items={[
            { label: "Rail", value: order.rail.replace(/_/g, " ") },
            { label: "Total", value: order.currency === "AED" ? money(order.totalAed, "AED") : money(order.totalInr, "INR") },
            { label: "Placed", value: fmtDateTime(order.placedAt) },
            { label: "Paid", value: fmtDateTime(order.paidAt) },
            { label: "Confirmed", value: fmtDateTime(order.confirmedAt) },
            { label: "Customer", value: contact.masked ? `${contact.phone} (masked)` : [contact.name, contact.phone, contact.email].filter(Boolean).join(" · ") },
            ...("netCostAed" in order ? [{ label: "Net cost (AED)", value: money(order.netCostAed as string, "AED") }] : []),
          ]}
        />
      </Panel>

      {detail.pendingResolutions.length > 0 && (
        <Panel title="Waiting for a second approver" sub="Each request needs another administrator with their own authenticator code within 30 minutes.">
          <ul className="space-y-3">
            {detail.pendingResolutions.map((p) => (
              <li key={p.id} className="space-y-1 border-t border-ink-200 pt-3 first:border-t-0 first:pt-0">
                <p className="text-sm text-ink-800">
                  <strong>{p.action === "close_exception" ? "Close exception request" : "Clear attention flag"}</strong> on {p.target?.replace(/_/g, " ")} ·{" "}
                  <span className="font-mono text-2xs">{p.code}</span> · asked by {p.requesterName} at {fmtDateTime(p.requestedAt)}, expires {fmtDateTime(p.expiresAt)}
                </p>
                {canResolve && p.requestedBy !== actor.id ? <ApproveResolutionForm approvalId={p.id} reference={order.reference} /> : <p className="text-2xs text-ink-500">Another administrator must approve this.</p>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {detail.items.map((item) => {
        const bookings = detail.bookings.filter((b) => b.orderItemId === item.id);
        const sagas = detail.sagas.filter((s) => s.orderItemId === item.id);
        const docs = detail.documents.filter((d) => d.orderItemId === item.id);
        const cancellations = detail.cancellations.filter((c) => c.orderItemId === item.id);
        const refunds = detail.refunds.filter((r) => r.orderItemId === item.id);
        const remedies = detail.remedies.filter((r) => r.orderItemId === item.id);
        const confirmed = bookings.filter((b) => b.state === "confirmed");
        return (
          <section key={item.id} id={`item-${item.id}`} aria-labelledby={`item-${item.id}-title`} className="scroll-mt-20">
            <Panel>
              <h2 id={`item-${item.id}-title`} className="mb-1 text-lg leading-tight">
                {item.titleSnapshot}
              </h2>
              <p className="mb-4 text-sm text-ink-600">
                {fmtDate(item.serviceDate.slice(0, 10))}
                {item.timeslot ? ` · ${item.timeslot}` : ""} · {item.status} · {item.fulfilmentOrigin.replace(/_/g, " ")} · charged {money(item.chargedAmountMinor, item.chargedCurrency)}
                {"netCostAed" in item ? ` · net cost ${money(item.netCostAed as string, "AED")}` : ""}
              </p>

              <div className="space-y-5">
                <Sub title="Operator booking">
                  <DataTable columns={bookingColumns} rows={bookings} rowKey={(b) => b.id} empty="No operator booking for this item." caption="Operator booking attempts" />
                  {bookings.map((b) => (
                    <div key={b.id} className="space-y-2">
                      {"expectedNetMinor" in b && (
                        <p className="text-xs text-ink-700">
                          Try {b.attempt}: expected net {money(b.expectedNetMinor as string, "AED")}, charged net {money((b.chargedNetMinor as string | null) ?? null, "AED")}
                          {"errorMessage" in b && b.errorMessage ? ` · ${b.errorMessage as string}` : ""}
                        </p>
                      )}
                      {b.attentionRequiredAt && clear("supplier_booking", b.id)}
                      {b.events.length > 0 && (
                        <details className="text-xs text-ink-700">
                          <summary className="cursor-pointer font-semibold">Try {b.attempt}: last {b.events.length} events</summary>
                          <ol className="mt-2 space-y-1">
                            {b.events.map((e) => (
                              <li key={e.id} className="font-mono text-2xs">
                                {fmtDateTime(e.at)} · {e.kind}
                                {e.operation ? ` · ${e.operation}` : ""}
                                {e.fromState || e.toState ? ` · ${e.fromState ?? "?"} → ${e.toState ?? "?"}` : ""}
                                {e.httpStatus ? ` · HTTP ${e.httpStatus}` : ""}
                              </li>
                            ))}
                          </ol>
                        </details>
                      )}
                    </div>
                  ))}
                  {canTickets && confirmed.map((b) => <DeliberateReadForm key={b.id} supplierBookingId={b.id} reference={order.reference} />)}
                </Sub>

                <Sub title="Payment">
                  {sagas.length === 0 ? (
                    <p className="text-sm text-ink-500">No payment saga for this item.</p>
                  ) : (
                    sagas.map((s) => (
                      <div key={s.id} className="space-y-2">
                        <KeyValueList
                          items={[
                            { label: "Saga", value: <State source="payment_saga" state={s.state} attention={s.attentionRequiredAt} /> },
                            { label: "Rail", value: s.rail },
                            { label: "Acts by", value: fmtDateTime(s.deadlineAt) },
                            { label: "Payment", value: s.payment ? `${s.payment.status} · ${s.payment.source}` : "—" },
                            { label: "Amount", value: s.payment ? money(s.payment.amountMinor, s.payment.currency) : "—" },
                            { label: "Captured", value: s.payment ? money(s.payment.capturedMinor, s.payment.currency) : "—" },
                            { label: "Refunded", value: s.payment ? money(s.payment.refundedMinor, s.payment.currency) : "—" },
                          ]}
                        />
                        {s.attentionRequiredAt && clear("payment_saga", s.id)}
                      </div>
                    ))
                  )}
                </Sub>

                <Sub title="Tickets">
                  <DataTable columns={documentColumns} rows={docs} rowKey={(d) => d.id} empty="No ticket documents yet." caption="Ticket documents" />
                  {docs.filter((d) => d.attentionRequiredAt).map((d) => (
                    <div key={d.id}>{clear("supplier_document", d.id)}</div>
                  ))}
                </Sub>

                {(cancellations.length > 0 || refunds.length > 0 || remedies.length > 0) && (
                  <Sub title="Cancellation and refunds">
                    <ul className="space-y-3 text-sm">
                      {cancellations.map((c) => (
                        <li key={c.id} className="space-y-2">
                          <p>
                            <State source="cancellation_request" state={c.status} attention={c.attentionRequiredAt} /> · {c.kind} via {c.requestedVia} · {fmtDateTime(c.createdAt)}
                            {c.reasonCode ? <span className="font-mono text-2xs"> · {c.reasonCode}</span> : null}
                          </p>
                          {canResolve && c.kind === "exception" && c.status === "exception_open" && (
                            <CloseExceptionForm targetId={c.id} reference={order.reference} evidenceMax={EVIDENCE_MAX} />
                          )}
                          {canResolve && c.kind === "supported" && c.status === "refund_failed" && !c.closedAt && (
                            <CloseRefundFailedForm targetId={c.id} reference={order.reference} evidenceMax={EVIDENCE_MAX} />
                          )}
                          {c.attentionRequiredAt && !c.closedAt && clear("cancellation_request", c.id)}
                        </li>
                      ))}
                      {refunds.map((r) => (
                        <li key={r.id}>
                          <State source="refund" state={r.status} /> · {money(r.amountMinor, r.currency)} · <span className="font-mono text-2xs">{r.reason}</span> · {fmtDateTime(r.updatedAt)}
                        </li>
                      ))}
                      {remedies.map((r) => (
                        <li key={r.id}>
                          <State source="remedy" state={r.status} /> · {r.kind.replace(/_/g, " ")} · {money(r.amountMinor, r.currency)} · {fmtDateTime(r.updatedAt)}
                        </li>
                      ))}
                    </ul>
                  </Sub>
                )}

                {"marginSnapshot" in item && item.marginSnapshot ? (
                  <Sub title="Margin snapshot">
                    <pre className="overflow-x-auto rounded-[var(--radius-control)] bg-shell/60 p-2 font-mono text-2xs">{JSON.stringify(item.marginSnapshot, null, 2)}</pre>
                  </Sub>
                ) : null}
              </div>
            </Panel>
          </section>
        );
      })}

      <Panel title="Messages">
        {detail.notifications.length === 0 ? (
          <p className="text-sm text-ink-500">No messages for this order.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {detail.notifications.map((n) => (
              <li key={n.id} className="space-y-2">
                <p>
                  <State source="notification" state={n.status} attention={n.attentionRequiredAt} /> · <span className="font-mono text-2xs">{n.event}</span> · {n.channel} to {n.recipient} · try{" "}
                  {n.attempt} · {fmtDateTime(n.createdAt)}
                </p>
                {n.attentionRequiredAt && clear("notification", n.id)}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {detail.wallet && (
        <Panel title="Supplier wallet" sub="Supplier figures only, from the supplier wallet book.">
          {detail.wallet.length === 0 ? (
            <p className="text-sm text-ink-500">No supplier wallet entries.</p>
          ) : (
            <ul className="space-y-1 font-mono text-2xs">
              {detail.wallet.map((w) => (
                <li key={w.id}>
                  {fmtDateTime(w.createdAt)} · {w.kind} · {money(w.amountMinor, w.currency)}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </div>
  );
}
