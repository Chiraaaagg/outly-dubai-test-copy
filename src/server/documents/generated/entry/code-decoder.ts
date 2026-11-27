import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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
 * Bundling (Group C fix round 1, CI build): the package is a server external
 * (`serverExternalPackages` in next.config.mjs), and the `.wasm` file is found
 * on disk at run time by walking up from the working directory, never through
 * a `require.resolve` / `import` of the `.wasm` specifier: Turbopack follows
 * such a specifier and tries to bundle the binary as a WebAssembly module
 * (`zxing_reader.wasm_.loader.mjs … Can't resolve 'a'`). The file itself is
 * shipped with the documents job by `outputFileTracingIncludes`. Its sha256 is
 * checked against the package's own published digest before use.
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
  /** Symbology family of `format` (e.g. `QRCode` for every QR variant): all codes of one file must share it. */
  symbology: string;
}

export interface CodeDecoder {
  /** Codes readable in this image (usually 0 or 1). Throws `DecoderUnavailableError` when the reader cannot run. */
  decode(image: Rgba): Promise<DecodedCode[]>;
}

/**
 * The reader itself could not load or run (missing or changed `.wasm`, a
 * WebAssembly fault). This is a job fault, never a property of the file being
 * read: callers must not record it as "image not decodable" (review finding 13).
 */
export class DecoderUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`decoder_unavailable:${reason}`);
    this.name = "DecoderUnavailableError";
  }
}

/**
 * The symbologies (zxing symbology families, also valid reader formats) accepted as an entry code (review finding 4). Every other
 * format the reader knows is ignored, which keeps false reads on logos and
 * patterns down. Stage S0 (doc 93 §2.8) narrows this to what TravelDesk
 * actually prints; until then the common ticketing symbologies only.
 */
export const ACCEPTED_CODE_FORMATS = ["QRCode", "Aztec", "DataMatrix", "PDF417", "Code128"] as const;

type ZxingReader = typeof import("zxing-wasm/reader");

const WASM_SEGMENTS = ["node_modules", "zxing-wasm", "dist", "reader", "zxing_reader.wasm"];

/** The reader's `.wasm` on disk: the traced copy under the working directory, or the nearest installed package above it. */
function findReaderWasm(): string | null {
  // Read through globalThis so the bundler does not try to resolve or trace a pattern from this (the exact file is
  // traced by outputFileTracingIncludes).
  let dir = globalThis.process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, ...WASM_SEGMENTS);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let reader: Promise<ZxingReader> | null = null;

async function loadReader(): Promise<ZxingReader> {
  reader ??= (async () => {
    // A runtime import of the server-external package; the bundler leaves it to Node.
    const mod = (await import("zxing-wasm/reader")) as ZxingReader;
    const wasmPath = findReaderWasm();
    if (!wasmPath) throw new DecoderUnavailableError("wasm_missing");
    const wasmBinary = readFileSync(wasmPath);
    if (createHash("sha256").update(wasmBinary).digest("hex") !== mod.ZXING_WASM_SHA256) throw new DecoderUnavailableError("wasm_checksum");
    // Local binary only: overriding `wasmBinary` means `locateFile` (the CDN URL) is never used.
    await mod.prepareZXingModule({ overrides: { wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) as ArrayBuffer }, fireImmediately: true });
    return mod;
  })();
  try {
    return await reader;
  } catch (e) {
    reader = null;
    throw e instanceof DecoderUnavailableError ? e : new DecoderUnavailableError("load_failed");
  }
}

/** Loads the reader once; throws `DecoderUnavailableError` when it cannot run. The job checks this before any file. */
export async function assertDecoderReady(): Promise<void> {
  await loadReader();
}

/** A decoder whose digests are comparable only with each other (one fresh key per instance). */
export function createZxingDecoder(): CodeDecoder {
  const key = randomBytes(32);
  return {
    async decode(image) {
      const z = await loadReader();
      let results: Awaited<ReturnType<ZxingReader["readBarcodes"]>>;
      try {
        results = await z.readBarcodes({ width: image.width, height: image.height, data: image.data, colorSpace: "srgb" } as unknown as ImageData, {
          tryHarder: true,
          maxNumberOfSymbols: 4,
          formats: [...ACCEPTED_CODE_FORMATS],
        });
      } catch {
        throw new DecoderUnavailableError("read_failed");
      }
      return results
        .filter((r) => r.isValid && (ACCEPTED_CODE_FORMATS as readonly string[]).includes(r.symbology))
        .map((r) => ({ format: r.format, symbology: r.symbology, digest: createHmac("sha256", key).update(`${r.format}\u0000`).update(r.bytes).digest("hex") }));
    },
  };
}
