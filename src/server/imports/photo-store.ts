import "server-only";
import { env } from "../lib/env";
import { SupabaseS3DocumentStore } from "../documents/supabase-s3-store";
import { storageEnvironment } from "../documents/store";
import { fetchPhoto, sharpReencoder, validHostEntry, type PhotoCopyDeps, type PhotoStore } from "./photo-copy";

/**
 * The configured photo copier for the TravelDesk importer (doc 30 §3.8), or
 * null when the public bucket, its public base URL or the TravelDesk media
 * host list is not configured: imported drafts then keep a placeholder image
 * and review refuses them until a person adds photos.
 *
 * The bucket is public-read and written with the supplier-documents S3 keys
 * (service write only). Its host must be in next.config.mjs `remotePatterns`.
 */
export function configuredPhotoCopier(): PhotoCopyDeps | null {
  const e = env();
  const bucket = e.LISTING_PHOTOS_BUCKET;
  const base = e.LISTING_PHOTOS_PUBLIC_BASE_URL?.replace(/\/+$/, "");
  const hosts = (e.TRAVELDESK_MEDIA_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(validHostEntry);
  const { SUPPLIER_DOCS_S3_ENDPOINT: endpoint, SUPPLIER_DOCS_S3_REGION: region, SUPPLIER_DOCS_S3_ACCESS_KEY_ID: accessKeyId, SUPPLIER_DOCS_S3_SECRET_ACCESS_KEY: secretAccessKey } = e;
  if (!bucket || !base || !/^https:\/\//.test(base) || hosts.length === 0 || !endpoint || !region || !accessKeyId || !secretAccessKey) return null;
  const s3 = new SupabaseS3DocumentStore({ endpoint, region, accessKeyId, secretAccessKey, bucket });
  const store: PhotoStore = {
    put: (key, bytes, type) => s3.put(key, bytes, type),
    publicUrl: (key) => `${base}/${key}`,
    delete: (key) => s3.delete(key),
  };
  return { fetchPhoto: (url) => fetchPhoto(url, { allowedHosts: hosts }), store, reencode: sharpReencoder, environment: storageEnvironment() };
}
