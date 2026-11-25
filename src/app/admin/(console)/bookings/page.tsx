import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { requirePage } from "@/app/admin/_lib/guard";
import { DataTable, PageHeader, Pagination, StatusPill, type DataColumn } from "@/app/admin/_components/ui";
import { RelativeTime } from "@/app/admin/_components/inquiry/sla-countdown";
import { fmtDate, truncate } from "@/app/admin/_components/inquiry/format";
import { Alert, EmptyState } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { AppError } from "@/server/lib/errors";
import { hasPermission } from "@/server/lib/actor";
import {
  CONFIRMING_LONG_MS,
  OPS_QUEUE_PERMISSION,
  PAID_UNCONFIRMED_AFTER_MS,
  QUEUE_PAGE_SIZE,
  QUEUES,
  opsQueueService,
  type QueueKey,
  type QueuePage,
  type QueueRow,
} from "@/server/services/ops-queue.service";

/**
 * /admin/bookings — operations queues for instant bookings (doc 22 §23 B5).
 *
 * Built from the console's own pieces only: `PageHeader`, the status tabs of
 * the inquiry queue (`inquiries/page.tsx`), `DataTable`, the generic
 * `StatusPill` (tone plus text, never colour alone), `Pagination`,
 * `RelativeTime` and the inquiry `format.ts` helpers, with `Alert` and
 * `EmptyState` from the shared primitives. No new visual design.
 *
 * Guard: `orders.view_all` (OPS_QUEUE_PERMISSION). The service enforces the
 * same permission, masks customer contact without `customers.view_pii` and
 * never selects net costs for a queue row. Server-rendered and driven by URL
 * parameters, like the inquiry queue.
 */
export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;

const TAB_LABELS: Record<QueueKey, string> = {
  paid_unconfirmed: "Paid, not confirmed",
  unknown_outcome: "Unknown outcome",
  missing_ticket: "Missing ticket",
  refunds: "Refunds and exceptions",
  attention: "Needs attention",
};

const TAB_HELP: Record<QueueKey, string> = {
  paid_unconfirmed: `Payment taken more than ${PAID_UNCONFIRMED_AFTER_MS / 60_000} minutes ago and the booking is still not confirmed with the operator.`,
  unknown_outcome: `A supplier call or capture whose result we did not see, a cancel not yet verified, or a confirm running longer than ${CONFIRMING_LONG_MS / 60_000} minutes. Recovery keeps looking; nothing is resent.`,
  missing_ticket: "Confirmed bookings whose tickets are still pending, incomplete, or whose latest copy failed or was quarantined.",
  refunds: "Failed refunds and remedies, cancellations whose refund failed, and exception requests waiting for our team.",
  attention: "Every row flagged for a human, across bookings, payments, tickets, messages and cancellations.",
};

const SOURCE_LABELS: Record<QueueRow["source"], string> = {
  supplier_booking: "Operator booking",
  payment_saga: "Payment",
  supplier_document: "Ticket",
  notification: "Message",
  cancellation_request: "Cancellation",
  refund: "Refund",
  remedy: "Remedy",
};

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function BookingQueuesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { actor } = await requirePage(OPS_QUEUE_PERMISSION);
  const sp = await searchParams;
  const queueParam = one(sp.queue);
  const queue: QueueKey = (QUEUES as readonly string[]).includes(queueParam ?? "") ? (queueParam as QueueKey) : "paid_unconfirmed";
  const page = Math.max(1, Number.parseInt(one(sp.page) ?? "1", 10) || 1);
  const now = new Date();
  const pii = hasPermission(actor, "customers.view_pii");

  let error: AppError | null = null;
  let list: QueuePage = { queue, rows: [], total: 0, page, pageSize: QUEUE_PAGE_SIZE };
  let counts: Record<QueueKey, number> = { paid_unconfirmed: 0, unknown_outcome: 0, missing_ticket: 0, refunds: 0, attention: 0 };
  try {
    [list, counts] = await Promise.all([opsQueueService.list(actor, queue, { page, now }), opsQueueService.counts(actor, { now })]);
  } catch (e) {
    if (e instanceof AppError) error = e;
    else throw e;
  }

  const href = (q: QueueKey, p?: number) => {
    const s = new URLSearchParams({ queue: q, ...(p && p > 1 ? { page: String(p) } : {}) }).toString();
    return `/admin/bookings?${s}`;
  };
  const serverNow = now.getTime();

  const columns: DataColumn<QueueRow>[] = [
    {
      key: "reference",
      header: "Order",
      cell: (r) =>
        r.href ? (
          <Link href={r.href} className="font-bold tnum text-ink-900 underline-offset-2 hover:underline focus-visible:underline">
            {r.orderReference}
          </Link>
        ) : (
          <span className="text-ink-500">No order</span>
        ),
    },
    {
      key: "item",
      header: "Item",
      className: "max-w-[260px]",
      cell: (r) => (
        <>
          <span className="block truncate text-ink-800" title={r.itemTitle ?? undefined}>
            {r.itemTitle ? truncate(r.itemTitle, 40) : "—"}
          </span>
          <span className="text-xs text-ink-500">{SOURCE_LABELS[r.source]}</span>
        </>
      ),
    },
    { key: "date", header: "Service date", cell: (r) => <span className="text-xs text-ink-700">{r.serviceDate ? fmtDate(r.serviceDate) : "—"}</span> },
    {
      key: "state",
      header: "State",
      cell: (r) => (
        <span className="flex flex-col items-start gap-1">
          <StatusPill tone={r.tone}>{r.stateLabel}</StatusPill>
          {r.attention && <StatusPill tone="danger">Needs attention</StatusPill>}
          {r.detail && <span className="font-mono text-2xs text-ink-500">{r.detail}</span>}
        </span>
      ),
    },
    { key: "age", header: "Age", cell: (r) => <RelativeTime iso={r.since} serverNow={serverNow} className="text-xs text-ink-600" /> },
    {
      key: "contact",
      header: "Customer",
      cell: (r) =>
        r.contact ? (
          <span className="text-xs">
            {r.contact.name && <span className="block font-semibold text-ink-900">{truncate(r.contact.name, 28)}</span>}
            <span className="block tnum text-ink-600">{r.contact.phone}</span>
            {r.contact.email && <span className="block text-ink-600">{r.contact.email}</span>}
          </span>
        ) : (
          <span className="text-xs text-ink-500">—</span>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Bookings"
        className="mb-0"
        sub={
          <>
            Instant bookings that need a person. Oldest first.
            {!pii && <span className="ml-2 text-ink-500">· Customer contact is masked for your role.</span>}
          </>
        }
      />

      <nav aria-label="Queue" className="no-scrollbar -mx-1 flex gap-1 overflow-x-auto border-b border-ink-200 px-1">
        {QUEUES.map((q) => {
          const active = q === queue;
          const n = counts[q];
          return (
            <Link
              key={q}
              href={href(q)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "-mb-px flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-bold transition-colors",
                active ? "border-sun-500 text-ink-900" : "border-transparent text-ink-500 hover:text-ink-800",
              )}
            >
              {TAB_LABELS[q]}
              {n > 0 && <span className={cn("rounded-full px-1.5 py-0.5 text-2xs tnum", q === "attention" ? "bg-sun-100 text-sun-800" : "bg-ink-100 text-ink-600")}>{n}</span>}
            </Link>
          );
        })}
      </nav>

      <p className="text-sm text-ink-600">{TAB_HELP[queue]}</p>

      {error ? (
        <Alert tone="danger" title={error.message}>
          {error.recovery}
        </Alert>
      ) : list.rows.length === 0 && list.page === 1 ? (
        <EmptyState icon={<ClipboardCheck className="h-6 w-6" />} title="Nothing waiting here" body="When a booking reaches this state it will show up here, oldest first." />
      ) : (
        <div>
          <DataTable columns={columns} rows={list.rows} rowKey={(r) => r.key} caption={TAB_LABELS[queue]} empty="No rows on this page." />
          <Pagination page={list.page} pageSize={list.pageSize} total={list.total} hrefFor={(p) => href(queue, p)} />
        </div>
      )}
    </div>
  );
}
