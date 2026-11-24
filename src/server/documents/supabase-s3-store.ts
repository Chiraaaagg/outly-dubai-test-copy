import { createHash, createHmac } from "node:crypto";
import { OBJECT_KEY, type DocumentStore } from "./contracts";

/**
 * Supplier documents in a private Supabase Storage bucket, through its
 * S3-compatible endpoint (doc 21 §9.1, review TKT-3).
 *
 *  - Server side only. The S3 access keys (preferred over the service-role
 *    key, which bypasses RLS for the whole database) never leave this module:
 *    they are kept in private fields and do not appear in `JSON.stringify`,
 *    `util.inspect` or any error.
 *  - Streaming only. No method returns, builds or presigns a URL: signed
 *    Storage URLs cannot be revoked one by one, so a document reaches a
 *    customer only through an Outly route that checks ownership each time.
 *  - AWS Signature V4 with `node:crypto`, path-style requests
 *    (`<endpoint>/<bucket>/<key>`), `PutObject`, `GetObject`, `DeleteObject`.
 *  - Every request: `redirect: "error"`, `cache: "no-store"`, a timeout and a
 *    signed `x-amz-content-sha256`.
 *  - Errors carry the operation and the HTTP status only: never the URL,
 *    the key, a header, a signature or the response body.
 *  - Keys must match `OBJECT_KEY` (`<environment>/<32 hex>`); anything else is
 *    refused before a request is made.
 *  - The endpoint must be `https:`. Plain `http:` is accepted for a loopback
 *    host only (127.0.0.1, ::1, localhost): the disposable local stack of
 *    scripts/test-storage/up.sh.
 */

export interface SupabaseS3StoreConfig {
  /** S3 endpoint, e.g. `https://<project>.storage.supabase.co/storage/v1/s3`. No query, fragment or credentials. */
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Whole-request budget, body included. Default 20 s. */
  timeoutMs?: number;
  /** Test seam. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Test seam for the signing clock. */
  now?: () => Date;
}

export type S3Operation = "PutObject" | "GetObject" | "DeleteObject";

/** A failed storage call. The message names the operation and status only. */
export class DocumentStoreError extends Error {
  readonly operation: S3Operation | "config";
  /** HTTP status, or null when no response arrived (timeout, network, redirect). */
  readonly status: number | null;
  constructor(operation: S3Operation | "config", status: number | null, detail: string) {
    super(operation === "config" ? `Document store misconfigured: ${detail}` : `${operation} failed: ${detail}`);
    this.name = "DocumentStoreError";
    this.operation = operation;
    this.status = status;
  }
}

const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
const DEFAULT_TIMEOUT_MS = 20_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{1,40}$/;
const ACCESS_KEY_ID = /^[A-Za-z0-9._-]{1,128}$/;
const CONTENT_TYPE = /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}(?:\s*;\s*[a-z0-9_-]{1,32}=[a-z0-9_.-]{1,64})?$/i;
/** Bytes read from a 404 body to tell a missing object from a missing bucket. */
const ERROR_PEEK_BYTES = 4096;

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** RFC 3986 encoding of one path segment, as SigV4 for S3 requires (encoded once). */
function encodeSegment(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `20261102T101500Z` and `20261102`. */
export function amzDates(d: Date): { amzDate: string; dateStamp: string } {
  const amzDate = d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** SigV4 signing key: HMAC chain over date, region, service and `aws4_request`. */
export function signingKey(secret: string, dateStamp: string, region: string, service = "s3"): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, dateStamp), region), service), "aws4_request");
}

interface SignInput {
  method: string;
  /** Already-encoded canonical path. */
  path: string;
  host: string;
  headers: Record<string, string>;
  payloadHash: string;
  amzDate: string;
  dateStamp: string;
  region: string;
  accessKeyId: string;
  secret: string;
}

/** Builds the SigV4 `Authorization` header (no query string: every request here has none). Exported for the unit test. */
export function signV4(input: SignInput): { authorization: string; canonicalRequest: string; stringToSign: string; signedHeaders: string } {
  const all: Record<string, string> = { ...lowerKeys(input.headers), host: input.host, "x-amz-content-sha256": input.payloadHash, "x-amz-date": input.amzDate };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [input.method, input.path, "", canonicalHeaders, signedHeaders, input.payloadHash].join("\n");
  const scope = `${input.dateStamp}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(input.secret, input.dateStamp, input.region)).update(stringToSign, "utf8").digest("hex");
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    canonicalRequest,
    stringToSign,
    signedHeaders,
  };
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function parseEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DocumentStoreError("config", null, "endpoint is not a URL");
  }
  if (url.username || url.password) throw new DocumentStoreError("config", null, "endpoint must not carry credentials");
  if (url.search || url.hash) throw new DocumentStoreError("config", null, "endpoint must not carry a query or fragment");
  if (url.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(url.hostname)) throw new DocumentStoreError("config", null, "plain http is allowed for a loopback host only");
  } else if (url.protocol !== "https:") {
    throw new DocumentStoreError("config", null, "endpoint must be https");
  }
  return url;
}

export class SupabaseS3DocumentStore implements DocumentStore {
  readonly kind = "supabase_s3" as const;
  readonly #origin: string;
  readonly #host: string;
  /** Encoded endpoint path without a trailing slash, e.g. `/storage/v1/s3`. */
  readonly #basePath: string;
  readonly #region: string;
  readonly #accessKeyId: string;
  readonly #secret: string;
  readonly #bucket: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(config: SupabaseS3StoreConfig) {
    const url = parseEndpoint(config.endpoint);
    if (!REGION.test(config.region)) throw new DocumentStoreError("config", null, "region is malformed");
    if (!ACCESS_KEY_ID.test(config.accessKeyId)) throw new DocumentStoreError("config", null, "access key id is malformed");
    if (!config.secretAccessKey) throw new DocumentStoreError("config", null, "secret access key is empty");
    if (!BUCKET.test(config.bucket)) throw new DocumentStoreError("config", null, "bucket name is malformed");
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new DocumentStoreError("config", null, "timeoutMs out of range");

    this.#origin = url.origin;
    this.#host = url.host;
    // URL has already percent-encoded the path; split and re-encode each decoded segment canonically.
    this.#basePath = url.pathname
      .split("/")
      .filter(Boolean)
      .map((s) => encodeSegment(decodeURIComponent(s)))
      .map((s) => `/${s}`)
      .join("");
    this.#region = config.region;
    this.#accessKeyId = config.accessKeyId;
    this.#secret = config.secretAccessKey;
    this.#bucket = config.bucket;
    this.#timeoutMs = timeoutMs;
    this.#fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = config.now ?? (() => new Date());
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.#assertKey(key, "PutObject");
    if (!CONTENT_TYPE.test(contentType)) throw new DocumentStoreError("PutObject", null, "content type is malformed");
    const body = new Uint8Array(bytes);
    const res = await this.#send("PutObject", "PUT", key, { "content-type": contentType }, body);
    await discard(res);
    if (!res.ok) throw new DocumentStoreError("PutObject", res.status, `HTTP ${res.status}`);
  }

  async get(key: string, opts: { maxBytes: number }): Promise<Uint8Array | null> {
    this.#assertKey(key, "GetObject");
    const maxBytes = opts.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new DocumentStoreError("GetObject", null, "maxBytes is invalid");
    const res = await this.#send("GetObject", "GET", key, {}, null);
    if (res.status === 404) {
      if (await isObjectMiss(res)) return null;
      throw new DocumentStoreError("GetObject", 404, "HTTP 404 (not a missing object)");
    }
    if (!res.ok) {
      await discard(res);
      throw new DocumentStoreError("GetObject", res.status, `HTTP ${res.status}`);
    }
    const declared = res.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
      await discard(res);
      throw new DocumentStoreError("GetObject", res.status, "object is larger than the read limit");
    }
    return readCapped(res, maxBytes);
  }

  async delete(key: string): Promise<void> {
    this.#assertKey(key, "DeleteObject");
    const res = await this.#send("DeleteObject", "DELETE", key, {}, null);
    // S3 answers 204 whether or not the object existed; a 404 NoSuchKey is also success.
    if (res.status === 404) {
      if (await isObjectMiss(res)) return;
      throw new DocumentStoreError("DeleteObject", 404, "HTTP 404 (not a missing object)");
    }
    await discard(res);
    if (!res.ok) throw new DocumentStoreError("DeleteObject", res.status, `HTTP ${res.status}`);
  }

  #assertKey(key: string, op: S3Operation) {
    if (typeof key !== "string" || !OBJECT_KEY.test(key)) throw new DocumentStoreError(op, null, "object key refused");
  }

  async #send(op: S3Operation, method: string, key: string, headers: Record<string, string>, body: Uint8Array<ArrayBuffer> | null): Promise<Response> {
    const path = `${this.#basePath}/${encodeSegment(this.#bucket)}/${key.split("/").map(encodeSegment).join("/")}`;
    const { amzDate, dateStamp } = amzDates(this.#now());
    const payloadHash = body ? sha256Hex(body) : EMPTY_SHA256;
    const { authorization } = signV4({ method, path, host: this.#host, headers, payloadHash, amzDate, dateStamp, region: this.#region, accessKeyId: this.#accessKeyId, secret: this.#secret });
    const init: RequestInit = {
      method,
      headers: { ...headers, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, authorization },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(this.#timeoutMs),
    };
    if (body) init.body = body;
    try {
      return await this.#fetch(`${this.#origin}${path}`, init);
    } catch (e) {
      // Never forward the cause: it can name the URL.
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new DocumentStoreError(op, null, timedOut ? "timed out" : "no response (network error or redirect)");
    }
  }

  toJSON() {
    return { kind: this.kind };
  }

  toString() {
    return "[SupabaseS3DocumentStore]";
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return this.toString();
  }
}

async function discard(res: Response) {
  try {
    await res.body?.cancel();
  } catch {
    // Already closed.
  }
}

/**
 * A 404 is an object miss only when its (bounded) body says `NoSuchKey`. A
 * 404 with no body, another code (NoSuchBucket) or no recognisable code is a
 * store error: a wrong endpoint, bucket or path also answers 404, and taking
 * that for a miss would quarantine valid documents (the caller refetches
 * them). A store error is answered without quarantining anything.
 */
async function isObjectMiss(res: Response): Promise<boolean> {
  let text = "";
  try {
    text = new TextDecoder().decode(await readCapped(res, ERROR_PEEK_BYTES, true));
  } catch {
    return false;
  }
  const code = /<Code>([^<]{1,64})<\/Code>/.exec(text)?.[1] ?? /"(?:code|Code)"\s*:\s*"([^"]{1,64})"/.exec(text)?.[1];
  return code === "NoSuchKey";
}

/**
 * Reads the body, refusing more than `max` bytes. With `truncate`, stops at
 * `max` instead of failing (for peeking at error bodies).
 */
async function readCapped(res: Response, max: number, truncate = false): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch (e) {
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        throw new DocumentStoreError("GetObject", res.status, timedOut ? "timed out while reading" : "body read failed");
      }
      if (step.done) break;
      const chunk = step.value;
      if (total + chunk.byteLength > max) {
        if (truncate) {
          chunks.push(chunk.subarray(0, max - total));
          total = max;
          break;
        }
        throw new DocumentStoreError("GetObject", res.status, "object is larger than the read limit");
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
