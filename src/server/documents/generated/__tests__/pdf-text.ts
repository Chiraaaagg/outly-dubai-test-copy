import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "@cantoo/pdf-lib";

/**
 * Test helper: the text a plain-layout PDF draws, page by page. The layout
 * draws every string with a standard font as a hex string (`<…> Tj`), so the
 * text is read back from the content streams without a renderer.
 *
 * The standard fonts use WinAnsiEncoding (Windows-1252): bytes 0x80–0x9F are
 * typographic characters there (0x97 is the em dash "—", 0x95 the bullet),
 * not the C1 controls Latin-1 gives. Decoding with windows-1252 reads back
 * exactly what was drawn.
 */
const WIN_ANSI = new TextDecoder("windows-1252");
export async function pdfText(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((page) => {
    const { Contents } = page.node.normalizedEntries();
    const parts: string[] = [];
    const streams = Contents instanceof PDFArray ? Array.from({ length: Contents.size() }, (_, i) => Contents.lookup(i)) : [];
    for (const s of streams) {
      if (!(s instanceof PDFRawStream)) continue;
      const text = Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
      for (const m of text.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) parts.push(WIN_ANSI.decode(Buffer.from(m[1], "hex")));
    }
    return parts.join("\n");
  });
}
