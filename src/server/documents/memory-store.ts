import type { DocumentStore } from "./contracts";

/**
 * In-memory document store for unit tests and local development
 * (`SUPPLIER_DOCS_STORE=memory`). Refused in production by `getDocumentStore`.
 * Keeps copies, so a caller mutating its buffer cannot change a stored object.
 */
export class MemoryDocumentStore implements DocumentStore {
  readonly kind = "memory" as const;
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes: new Uint8Array(bytes), contentType });
  }

  async get(key: string, opts: { maxBytes: number }): Promise<Uint8Array | null> {
    const o = this.objects.get(key);
    if (!o) return null;
    if (o.bytes.byteLength > opts.maxBytes) throw new Error("Stored object is larger than the read limit");
    return new Uint8Array(o.bytes);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  /** Test helpers. */
  has(key: string): boolean {
    return this.objects.has(key);
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }

  /** Simulates a lost or corrupted object (F36). */
  corrupt(key: string, bytes: Uint8Array | null) {
    if (bytes === null) this.objects.delete(key);
    else {
      const o = this.objects.get(key);
      this.objects.set(key, { bytes: new Uint8Array(bytes), contentType: o?.contentType ?? "application/octet-stream" });
    }
  }
}
