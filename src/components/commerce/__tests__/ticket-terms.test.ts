import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TicketTerms } from "../ticket-terms";
import { TICKET_NON_REFUNDABLE_STATEMENT } from "@/lib/utils";

/** The product page's open-dated ticket terms (doc 29 Batch 5): validity is shown with the price; non-refundable once issued. */
describe("TicketTerms", () => {
  it("states the validity rule and non-refundable once issued, and offers no online cancellation", () => {
    const html = renderToStaticMarkup(h(TicketTerms));
    expect(html).toContain('data-testid="ticket-terms"');
    expect(html).toContain("Valid until the date the operator sets");
    expect(html).toContain(TICKET_NON_REFUNDABLE_STATEMENT);
    expect(html).toContain("can&#x27;t be cancelled online");
    expect(html).not.toMatch(/free cancellation/i);
    expect(html).toContain("we show it with your price before you pay");
  });

  it("an inquiry page has no quote: our team states the date (review 86 B5-04)", () => {
    const html = renderToStaticMarkup(h(TicketTerms, { inquiry: true }));
    expect(html).toContain("our team confirms it with you before you pay");
    expect(html).not.toContain("with your price");
    expect(html).toContain(TICKET_NON_REFUNDABLE_STATEMENT);
  });
});

describe("before the quote, every surface says non-refundable once issued for open-dated tickets (review 86 B5-03)", () => {
  it("the trip and checkout line", async () => {
    const { cancellationPolicyBeforeQuote } = await import("@/lib/utils");
    expect(cancellationPolicyBeforeQuote(72, { openDatedTicket: true })).toBe(TICKET_NON_REFUNDABLE_STATEMENT);
    expect(cancellationPolicyBeforeQuote(0, { openDatedTicket: true })).toBe(TICKET_NON_REFUNDABLE_STATEMENT);
    expect(cancellationPolicyBeforeQuote(72)).toMatch(/free cancellation up to 72 hours/);
  });
});
