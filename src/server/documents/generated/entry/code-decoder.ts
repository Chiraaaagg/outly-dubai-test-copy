import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Rgba } from "./image-pixels";

/**
 * Barcode decoding for VERIFICATION (doc 93 §2.2): read the codes in the
 * supplier's image and in OUTLYY's copy, and compare them. The decoded text is
 * an admission code (a bearer secret, TKT-1): it is never logged, stored or
 * returned. Callers get a keyed hash only, under a key that lives for one
 * comparison and is then dropped.
 *
 * `zxing-wasm` (MIT, WebAssembly, no native code). The WebAssembly binary is
 * read from the installed package, never fetched: the library's default would
 * load it from a CDN, which a server must not do.
 *
 * Rendering a page to find codes drawn as vector paths or with a barcode font
 * would need a canvas (`@napi-rs/canvas`, native). That is NOT built: see
 * `PageRenderer` in `code-locator.ts`. Such codes are treated as "no code
 * found" and the operator's PDF stays the entry document.
 */

export interface DecodedCode {
  /** Keyed hash of format + text under the comparison key. Never the text. */
  digest: string;
  format: string;
}

export interface CodeDecoder {
  /** Codes readable in this image (usually 0 or 1). */
  decode(image: Rgba): Promise<DecodedCode[]>;
}

type ZxingReader = typeof import("zxing-wasm/reader");

let reader: Promise<ZxingReader> | null = null;

async function loadReader(): Promise<ZxingReader> {
  reader ??= (async () => {
    const mod = (await import("zxing-wasm/reader")) as ZxingReader;
    // The path next.config.mjs traces into the documents job; the package resolver as a fallback (tests, scripts).
    const traced = path.join(process.cwd(), "node_modules/zxing-wasm/dist/reader/zxing_reader.wasm");
    const wasmPath = existsSync(traced) ? traced : createRequire(import.meta.url).resolve("zxing-wasm/reader/zxing_reader.wasm");
    const wasmBinary = readFileSync(wasmPath);
    // Local binary only: overriding `wasmBinary` means `locateFile` (the CDN URL) is never used.
    await mod.prepareZXingModule({ overrides: { wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) as ArrayBuffer }, fireImmediately: true });
    return mod;
  })();
  try {
    return await reader;
  } catch (e) {
    reader = null;
    throw e;
  }
}

/** A decoder whose digests are comparable only with each other (one fresh key per instance). */
export function createZxingDecoder(): CodeDecoder {
  const key = randomBytes(32);
  return {
    async decode(image) {
      const z = await loadReader();
      const results = await z.readBarcodes({ width: image.width, height: image.height, data: image.data, colorSpace: "srgb" } as unknown as ImageData, {
        tryHarder: true,
        maxNumberOfSymbols: 4,
        formats: [],
      });
      return results
        .filter((r) => r.isValid)
        .map((r) => ({ format: r.format, digest: createHmac("sha256", key).update(`${r.format}\u0000`).update(r.bytes).digest("hex") }));
    },
  };
}
