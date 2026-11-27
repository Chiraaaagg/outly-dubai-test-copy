import { Download, FileText } from "lucide-react";
import type { CustomerItemStatus, CustomerOrderState } from "@/lib/customer-status";
import { cn } from "@/lib/utils";
import { documentLinkText, ticketStatusText, type DocumentWord } from "./presenters";

/**
 * One item's tickets: a status sentence, then the downloadable files as a
 * list (criterion 5). Built from the voucher page's dashed ticket block and
 * the outline button style. Each download is a plain `<a>` to
 * `/api/tickets/documents/<id>` (never a Next `Link`, so nothing prefetches
 * it), and its text names the file type and size so the accessible name
 * carries them. The route re-checks ownership on every download.
 *
 * Post-payment A5/A7: `word` names the files ("tickets" or "voucher"); with
 * `showFiles` false the links are left to the item's ticket card on the same
 * page, so one file is not offered twice under the same name.
 */
export function TicketList({
  tickets,
  itemState,
  canDownload,
  headingId,
  className,
  word = "voucher",
  showFiles = true,
}: {
  tickets: CustomerItemStatus["tickets"];
  /** The item's state, so the sentence fits it (no "no ticket files" before confirmation, CO-15). */
  itemState?: CustomerOrderState;
  /** Whether this viewer may download (CO-02); omitted means the documents listed are all there is. */
  canDownload?: boolean;
  /** id of the heading that labels this list. */
  headingId?: string;
  className?: string;
  /** What the files are called (A7). */
  word?: DocumentWord;
  /** False when the item's ticket card above carries the downloads (A5). */
  showFiles?: boolean;
}) {
  const docs = showFiles ? tickets.documents : [];
  return (
    <div className={className}>
      <p className="text-sm leading-relaxed text-ink-700">{ticketStatusText(tickets, itemState, canDownload ?? true, word)}</p>
      {docs.length > 0 && (
        <ul className="mt-3 space-y-2" aria-labelledby={headingId} data-testid="ticket-list">
          {docs.map((doc) => {
            const text = documentLinkText(doc, docs);
            return (
              <li key={doc.id}>
                <a
                  href={doc.href}
                  rel="noreferrer"
                  className={cn(
                    "flex min-h-11 items-center gap-3 rounded-[var(--radius-control)] border border-ink-300 bg-white px-3.5 py-2.5 text-sm font-semibold text-ink-900",
                    "hover:border-ink-500 hover:bg-shell focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ink-800",
                  )}
                >
                  <FileText className="h-5 w-5 shrink-0 text-sun-500" aria-hidden="true" />
                  <span className="min-w-0 flex-1 break-words">
                    {text.name} <span className="font-normal text-ink-600">({text.file})</span>
                  </span>
                  <Download className="h-4 w-4 shrink-0 text-ink-500" aria-hidden="true" />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
