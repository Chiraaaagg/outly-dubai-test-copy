import { describe, expect, it } from "vitest";
import { MAX_SUBJECT_LENGTH, renderInvoiceIssued, renderPaymentReceived, type PaymentReceivedContext } from "../templates";

/** Group C C2: the payment confirmation email (doc 93 §3.1, §5.7; owner answers O7, O8, 16). Synthetic values. */
const ctx: PaymentReceivedContext = {
  firstName: "Asha",
  orderReference: "OUT-000000",
  amountLabel: "AED 420.00",
  paidOnLabel: "14 Feb 2027",
  methodLabel: "card",
  items: [
    { title: "Specimen Desert Safari", dateLabel: "20 Feb 2027", guests: "2 adults" },
    { title: "Specimen Monorail Ticket", dateLabel: "21 Feb 2027" },
  ],
  supportEmail: "support@example.com",
};

describe("PAYMENT_RECEIVED email", () => {
  it("says the money arrived, for what, and that it is not the entry ticket", () => {
    const r = renderPaymentReceived(ctx);
    expect(r.subject).toBe("Payment received for booking OUT-000000");
    expect(r.subject!.length).toBeLessThanOrEqual(MAX_SUBJECT_LENGTH);
    for (const part of [r.text, r.html!]) {
      expect(part).toContain("OUT-000000");
      expect(part).toContain("AED 420.00");
      expect(part).toContain("14 Feb 2027");
      expect(part).toContain("Specimen Desert Safari");
      expect(part).toContain("This email is not your entry ticket.");
      expect(part).toContain("Please do not pay again.");
    }
    expect(r.html).toContain("<strong>This email is not your entry ticket.</strong>");
    expect(r.text).toMatch(/^Hi Asha, we have received your payment/);
  });

  it("carries no link of any kind (O7)", () => {
    const r = renderPaymentReceived(ctx);
    expect(r.html).not.toMatch(/<a\s/i);
    expect(r.text).not.toMatch(/https?:\/\//);
    expect(r.text).not.toMatch(/\/t#/);
  });

  it("names the attached invoice only when one is attached (O8)", () => {
    expect(renderPaymentReceived(ctx).text).not.toMatch(/invoice/i);
    const r = renderPaymentReceived({ ...ctx, invoice: { displayNumber: "INV-000123" } });
    expect(r.text).toContain("Your tax invoice / receipt INV-000123 is attached.");
    expect(r.html).toContain("INV-000123");
  });

  it("escapes customer text", () => {
    const r = renderPaymentReceived({ ...ctx, firstName: "<b>x</b>", items: [{ title: "Safari <script>alert(1)</script>" }] });
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<b>x</b>");
    expect(r.html).toContain("&lt;script&gt;");
  });

  it("greets without a name when none is known", () => {
    expect(renderPaymentReceived({ ...ctx, firstName: undefined }).text).toMatch(/^Hi, we have received/);
  });
});

describe("INVOICE_ISSUED email (review 102 finding 14)", () => {
  it("names the attached invoice, is not the entry ticket, asks for nothing and has no link", () => {
    const r = renderInvoiceIssued({ firstName: "Asha", orderReference: "OUT-000000", displayNumber: "TEST-INV-000123", supportEmail: "support@example.com" });
    expect(r.subject).toContain("TEST-INV-000123");
    expect(r.subject!.length).toBeLessThanOrEqual(MAX_SUBJECT_LENGTH);
    expect(r.text).toContain("Your tax invoice / receipt TEST-INV-000123 for booking OUT-000000 is attached.");
    expect(r.text).toContain("This email is not your entry ticket.");
    expect(r.text).toContain("There is nothing to pay.");
    expect(r.html).not.toMatch(/<a\s/i);
  });
});
