import "server-only";
import { env } from "../lib/env";
import type { DocumentStore } from "./contracts";
import { MemoryDocumentStore } from "./memory-store";
import { SupabaseS3DocumentStore } from "./supabase-s3-store";

/**
 * The configured document store (`SUPPLIER_DOCS_STORE`), or null when none is
 * configured: documents then stay pending and nothing is served. Server only;
 * the credentials never leave this process and no method returns a URL.
 */

let override: DocumentStore | null | undefined;

/**
 * The memory store (development and tests only) lives on `globalThis`, not in
 * this module: `next dev` bundles each route separately, so a module-level
 * instance gave every route its own empty store, and a voucher stored by one
 * job route was "object_missing" to the documents route and was quarantined.
 */
const MEMORY_KEY = Symbol.for("outly.documents.memoryStore");
type MemoryHolder = { [MEMORY_KEY]?: MemoryDocumentStore };

function memoryStore(): MemoryDocumentStore {
  const holder = globalThis as MemoryHolder;
  holder[MEMORY_KEY] ??= new MemoryDocumentStore();
  return holder[MEMORY_KEY];
}

export function setDocumentStoreForTests(store: DocumentStore | null | undefined) {
  override = store;
}

export function getDocumentStore(): DocumentStore | null {
  if (override !== undefined) return override;
  const e = env();
  if (e.SUPPLIER_DOCS_STORE === "memory") {
    if (e.isProduction) return null;
    return memoryStore();
  }
  if (e.SUPPLIER_DOCS_STORE === "supabase_s3") {
    const { SUPPLIER_DOCS_S3_ENDPOINT: endpoint, SUPPLIER_DOCS_S3_REGION: region, SUPPLIER_DOCS_S3_ACCESS_KEY_ID: accessKeyId, SUPPLIER_DOCS_S3_SECRET_ACCESS_KEY: secretAccessKey, SUPPLIER_DOCS_BUCKET: bucket } = e;
    if (!endpoint || !region || !accessKeyId || !secretAccessKey || !bucket) return null;
    return new SupabaseS3DocumentStore({ endpoint, region, accessKeyId, secretAccessKey, bucket });
  }
  return null;
}

/** `<environment>/<32 hex>` (OBJECT_KEY in contracts.ts). */
export function storageEnvironment(): "test" | "production" | "development" {
  const e = env();
  return e.isProduction ? "production" : e.NODE_ENV === "test" ? "test" : "development";
}
