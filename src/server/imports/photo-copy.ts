import "server-only";
import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import sharp from "sharp";
import type { TourContentPhoto } from "../suppliers/traveldesk/traveldesk.content";
import { isPrivateAddress, type LookupFn } from "./fetch";

/**
 * Safe copy of TravelDesk tour photos into OUTLYY's own public storage (doc 30
 * §3.8, build N1). Supplier photo addresses are untrusted:
 *
 *  - https only, default port, no user:password, a hostname (never an IP
 *    literal) on the configured TravelDesk media host list, every DNS answer
 *    a public address, and the connection goes to the address that was
 *    checked (pinned; TLS still verifies the hostname), so a second DNS
 *    answer cannot redirect it (review 106 N1-12a); redirects are followed by
 *    hand, each hop checked before it is connected to, at most 3, no loops;
 *  - one deadline per photo; the body is streamed under a byte cap whatever
 *    Content-Length says;
 *  - the type is read from the bytes, not the headers: JPEG, PNG or WebP only
 *    (no SVG, no GIF, nothing else); the image is then re-encoded to WebP,
 *    which drops its metadata, by an injected encoder;
 *  - throttled (one photo at a time, a pause between), at most 12 per listing.
 *
 * Every network seam is injected (`PhotoCopyDeps`): tests use fakes and never
 * reach the network. Nothing here touches the database.
 */

export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const PHOTO_TIMEOUT_MS = 15_000;
export const PHOTO_MAX_REDIRECTS = 3;
export const PHOTOS_PER_LISTING = 12;
export const PHOTO_THROTTLE_MS = 300;

const REDIRECT = new Set([301, 302, 303, 307, 308]);

export type SniffedType = "image/jpeg" | "image/png" | "image/webp";

/** Raster type from the first bytes, or null. */
export function sniffImageType(b: Uint8Array): SniffedType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** A host list entry: a hostname of at least two labels, or "*." and at least two labels ("*.com" is refused; review 106 N1-21). */
export function validHostEntry(entry: string): boolean {
  return /^(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(entry.trim().toLowerCase());
}

/** "media.example.com" exact, "*.example.com" any subdomain (not the apex). Lower-case hostnames only; invalid entries match nothing. */
export function hostAllowed(hostname: string, allowed: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return allowed.some((a) => {
    const e = a.trim().toLowerCase();
    if (!validHostEntry(e)) return false;
    if (e.startsWith("*.")) return h.endsWith(e.slice(1)) && h.length > e.length - 1;
    return h === e;
  });
}

export class PhotoRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PhotoRefused";
  }
}

function checkHop(url: URL, allowed: readonly string[]) {
  if (url.protocol !== "https:") throw new PhotoRefused("not_https");
  if (url.port !== "" && url.port !== "443") throw new PhotoRefused("port");
  if (url.username || url.password) throw new PhotoRefused("credentials");
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) throw new PhotoRefused("ip_literal");
  if (!hostAllowed(url.hostname, allowed)) throw new PhotoRefused("host_not_allowed");
}

/** One GET to `url`, connected to `address` (already checked), never following redirects. */
export type PinnedRequest = (url: URL, address: string, signal: AbortSignal) => Promise<Response>;

export interface PhotoFetchDeps {
  allowedHosts: readonly string[];
  /** Defaults to `pinnedHttpsGet`. Tests pass a fake. */
  request?: PinnedRequest;
  /** DNS answers; every address must be public. */
  lookup?: LookupFn;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

const systemLookup: LookupFn = async (hostname) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/**
 * GET over TLS to the pinned address, with SNI and certificate checks against
 * the URL's hostname. `port` and `ca` exist for the loopback test only;
 * production uses `pinnedHttpsGet` (443, the system trust store).
 */
export function makePinnedHttpsGet(opts: { port?: number; ca?: string } = {}): PinnedRequest {
  return (url, address, signal) => pinnedGet(url, address, signal, opts.port ?? 443, opts.ca);
}

const pinnedGet = (url: URL, address: string, signal: AbortSignal, port: number, ca: string | undefined) =>
  new Promise<Response>((resolve, reject) => {
    // The socket goes to the checked address itself (no second resolution); SNI, the certificate check and the
    // Host header use the URL's hostname.
    const req = httpsRequest(
      {
        protocol: "https:",
        host: address,
        family: isIP(address) === 6 ? 6 : 4,
        servername: url.hostname,
        port,
        ...(ca ? { ca } : {}),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { host: port === 443 ? url.hostname : `${url.hostname}:${port}`, accept: "image/webp,image/jpeg,image/png", "user-agent": "outlyy-photo-copy" },
        signal,
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
        const status = res.statusCode ?? 502;
        const body = status === 204 || status === 304 ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status, headers }));
      },
    );
    req.on("error", reject);
    req.end();
  });

export const pinnedHttpsGet: PinnedRequest = makePinnedHttpsGet();

/** Reject as soon as `signal` aborts, whatever `promise` is doing (N1-12b). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new PhotoRefused("timeout"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new PhotoRefused("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = res.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new PhotoRefused("too_large");
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new PhotoRefused("too_large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** GET one photo through the checks above; the bytes and their sniffed type. */
export async function fetchPhoto(startUrl: string, deps: PhotoFetchDeps): Promise<{ bytes: Uint8Array; type: SniffedType }> {
  const doRequest = deps.request ?? pinnedHttpsGet;
  const lookup = deps.lookup ?? systemLookup;
  const maxBytes = deps.maxBytes ?? PHOTO_MAX_BYTES;
  const maxRedirects = deps.maxRedirects ?? PHOTO_MAX_REDIRECTS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? PHOTO_TIMEOUT_MS);
  const seen = new Set<string>();
  try {
    let url: URL;
    try {
      url = new URL(startUrl);
    } catch {
      throw new PhotoRefused("bad_url");
    }
    for (let hop = 0; ; hop++) {
      checkHop(url, deps.allowedHosts);
      if (seen.has(url.href)) throw new PhotoRefused("redirect_loop");
      seen.add(url.href);
      const addresses = await abortable(
        lookup(url.hostname).catch(() => {
          throw new PhotoRefused("dns");
        }),
        controller.signal,
      );
      if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new PhotoRefused("private_address");
      const res = await abortable(doRequest(url, addresses[0], controller.signal), controller.signal);
      if (REDIRECT.has(res.status)) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get("location");
        if (!location || hop >= maxRedirects) throw new PhotoRefused("redirect");
        try {
          url = new URL(location, url);
        } catch {
          throw new PhotoRefused("redirect");
        }
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new PhotoRefused(`http_${res.status}`);
      }
      const bytes = await readCapped(res, maxBytes);
      const type = sniffImageType(bytes);
      if (!type) throw new PhotoRefused("not_a_raster_image");
      return { bytes, type };
    }
  } catch (e) {
    if (e instanceof PhotoRefused) throw e;
    throw new PhotoRefused(controller.signal.aborted ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
}

/** Public storage for copied photos. `put` keys are `<environment>/<32 hex>` (the document store's key rule). */
export interface PhotoStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  publicUrl(key: string): string;
  /** Remove an object no listing took (N1-12d). */
  delete(key: string): Promise<void>;
}

/** Re-encode to WebP without metadata. Must refuse anything it cannot decode. */
export type ImageReencoder = (bytes: Uint8Array, type: SniffedType) => Promise<{ bytes: Uint8Array; type: "image/webp" }>;

export interface PhotoCopyDeps {
  fetchPhoto: (url: string) => Promise<{ bytes: Uint8Array; type: SniffedType }>;
  store: PhotoStore;
  reencode: ImageReencoder;
  environment: "test" | "production" | "development";
  sleep?: (ms: number) => Promise<void>;
  throttleMs?: number;
  maxPhotos?: number;
}

/** The variant to copy: the widest at or under 2000 px, else the narrowest; declared SVG/GIF never. */
export function pickVariant(photo: TourContentPhoto): string | null {
  const ok = photo.variants.filter((v) => !v.type || /^image\/(jpe?g|png|webp)$/i.test(v.type));
  if (ok.length === 0) return null;
  const w = (v: (typeof ok)[number]) => v.width ?? 0;
  const under = ok.filter((v) => w(v) <= 2000).sort((a, b) => w(b) - w(a));
  return (under[0] ?? [...ok].sort((a, b) => w(a) - w(b))[0]).url;
}

export interface PhotoCopyResult {
  urls: string[];
  /** Storage keys of `urls`, for cleanup when nothing takes them. */
  keys: string[];
  failures: { index: number; reason: string }[];
}

/** Copy up to 12 photos, one at a time. A failed photo is skipped and named; it never fails the rest. */
export async function copyTourPhotos(photos: readonly TourContentPhoto[], deps: PhotoCopyDeps): Promise<PhotoCopyResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const max = Math.min(deps.maxPhotos ?? PHOTOS_PER_LISTING, PHOTOS_PER_LISTING);
  const urls: string[] = [];
  const keys: string[] = [];
  const failures: PhotoCopyResult["failures"] = [];
  let tried = 0;
  for (const [index, photo] of photos.entries()) {
    if (urls.length >= max) break;
    const src = pickVariant(photo);
    if (!src) {
      failures.push({ index, reason: "no_usable_variant" });
      continue;
    }
    if (tried++ > 0) await sleep(deps.throttleMs ?? PHOTO_THROTTLE_MS);
    try {
      const got = await deps.fetchPhoto(src);
      let out: { bytes: Uint8Array; type: "image/webp" };
      try {
        out = await deps.reencode(got.bytes, got.type);
      } catch {
        throw new PhotoRefused("reencode_failed");
      }
      if (sniffImageType(out.bytes) !== "image/webp") throw new PhotoRefused("reencode_failed");
      const key = `${deps.environment}/${randomBytes(16).toString("hex")}`;
      try {
        await deps.store.put(key, out.bytes, "image/webp");
      } catch {
        throw new PhotoRefused("store_failed");
      }
      keys.push(key);
      urls.push(deps.store.publicUrl(key));
    } catch (e) {
      failures.push({ index, reason: e instanceof PhotoRefused ? e.code : "fetch_failed" });
    }
  }
  return { urls, keys, failures };
}

/**
 * The production encoder: `sharp` (a direct dependency, static import so the
 * standalone build traces it; review 106 N1-12c). Re-encoding drops EXIF and
 * other metadata; decoding is pixel-capped.
 */
export const sharpReencoder: ImageReencoder = async (bytes) => {
  const out = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  return { bytes: new Uint8Array(out), type: "image/webp" };
};

/** Memory store for tests and local development. */
export class MemoryPhotoStore implements PhotoStore {
  readonly objects = new Map<string, { bytes: Uint8Array; type: string }>();
  constructor(private readonly base = "https://photos.example.test") {}
  async put(key: string, bytes: Uint8Array, contentType: string) {
    if (!/^(test|production|development)\/[0-9a-f]{32}$/.test(key)) throw new Error("object key refused");
    this.objects.set(key, { bytes, type: contentType });
  }
  publicUrl(key: string) {
    return `${this.base}/${key}`;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}
