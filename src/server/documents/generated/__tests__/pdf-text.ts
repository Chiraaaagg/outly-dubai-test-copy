import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "@cantoo/pdf-lib";

/**
 * Test helper: the text a plain-layout PDF draws, page by page. The layout
 * draws every string with a standard font as a hex string (`<…> Tj`), so the
 * text is read back from the content streams without a renderer.
 */
export async function pdfText(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return doc.getPages().map((page) => {
    const { Contents } = page.node.normalizedEntries();
    const parts: string[] = [];
    const streams = Contents instanceof PDFArray ? Array.from({ length: Contents.size() }, (_, i) => Contents.lookup(i)) : [];
    for (const s of streams) {
      if (!(s instanceof PDFRawStream)) continue;
      const text = Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
      for (const m of text.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) parts.push(Buffer.from(m[1], "hex").toString("latin1"));
    }
    return parts.join("\n");
  });
}
