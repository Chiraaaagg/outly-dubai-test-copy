import { describe, expect, it } from "vitest";
import { attachmentDisposition, documentDownloadName } from "../download-name";

/**
 * Voucher file names (checkout redesign batch 3, CO-22): the reference and
 * the kind, never `tickets.pdf`, and nothing a header could be broken with.
 */

describe("documentDownloadName", () => {
  it("names a voucher and a TicketOnly booking's tickets after the order reference", () => {
    expect(documentDownloadName("voucher_pdf", "OUT-7K2M9Q")).toBe("OUTLYY-voucher-OUT-7K2M9Q.pdf");
    expect(documentDownloadName("tickets_pdf", "OUT-7K2M9Q")).toBe("OUTLYY-tickets-OUT-7K2M9Q.pdf");
    // Any other kind (staff-only documents) reads as a voucher, never as tickets.
    expect(documentDownloadName("ticket_codes", "OUT-7K2M9Q")).toBe("OUTLYY-voucher-OUT-7K2M9Q.pdf");
  });

  it("upper-cases and strips everything but A-Z, 0-9 and '-', capped at 32 characters", () => {
    expect(documentDownloadName("voucher_pdf", "out-7k2m9q")).toBe("OUTLYY-voucher-OUT-7K2M9Q.pdf");
    expect(documentDownloadName("voucher_pdf", 'OUT-1"; filename="evil.exe')).toBe("OUTLYY-voucher-OUT-1FILENAMEEVILEXE.pdf");
    expect(documentDownloadName("voucher_pdf", "OUT-1\r\nSet-Cookie: x=1")).toBe("OUTLYY-voucher-OUT-1SET-COOKIEX1.pdf");
    expect(documentDownloadName("voucher_pdf", "../../etc/passwd")).toBe("OUTLYY-voucher-ETCPASSWD.pdf");
    expect(documentDownloadName("voucher_pdf", "OUT-ÄÖ✓")).toBe("OUTLYY-voucher-OUT-.pdf");
    expect(documentDownloadName("voucher_pdf", "X".repeat(100))).toBe(`OUTLYY-voucher-${"X".repeat(32)}.pdf`);
    expect(documentDownloadName("voucher_pdf", "")).toBe("OUTLYY-voucher-booking.pdf");
    expect(documentDownloadName("voucher_pdf", "\";")).toBe("OUTLYY-voucher-booking.pdf");
  });
});

describe("attachmentDisposition", () => {
  it("is an attachment with a quoted ASCII name and the same RFC 5987 name", () => {
    expect(attachmentDisposition("OUTLYY-voucher-OUT-7K2M9Q.pdf")).toBe(
      "attachment; filename=\"OUTLYY-voucher-OUT-7K2M9Q.pdf\"; filename*=UTF-8''OUTLYY-voucher-OUT-7K2M9Q.pdf",
    );
  });

  it("cannot be broken by quotes, separators, CR/LF or non-ASCII, whatever it is given", () => {
    for (const bad of ['a"b.pdf', "a;b.pdf", "a\r\nX-Evil: 1.pdf", "ä'(*)!.pdf", "a\\b.pdf"]) {
      const h = attachmentDisposition(bad);
      expect(h, bad).not.toMatch(/[\r\n]/);
      const ascii = /filename="([^"]*)"/.exec(h)?.[1] ?? "";
      expect(ascii, bad).toMatch(/^[A-Za-z0-9._-]+$/);
      const star = /filename\*=UTF-8''(.*)$/.exec(h)?.[1] ?? "";
      expect(star, bad).toMatch(/^[A-Za-z0-9%._~-]+$/);
      expect(decodeURIComponent(star)).toBe(bad);
    }
  });
});
