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
  });
});
