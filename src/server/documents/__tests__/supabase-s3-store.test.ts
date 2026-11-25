import { createHash, createHmac } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { DocumentStoreError, SupabaseS3DocumentStore, type SupabaseS3StoreConfig } from "../supabase-s3-store";

/**
 * Unit tests for the S3 document store with a fake `fetch`: no network.
 * The local-stack checks are in supabase-s3-store.storage.test.ts.
 */

const SECRET = "unit-secret-access-key-0123456789abcdefSECRET";
const ACCESS_KEY = "unitAccessKey123";
const KEY = "test/0123456789abcdef0123456789abcdef";
const NOW = new Date("2026-11-02T10:15:30.123Z");

interface Call {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

type Responder = (call: Call) => Response | Promise<Response>;

function fakeFetch(respond: Responder) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = { url: String(input), init, headers, body: init.body ? new Uint8Array(init.body as Uint8Array) : null };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fn, calls };
}

function store(respond: Responder, over: Partial<SupabaseS3StoreConfig> = {}) {
  const f = fakeFetch(respond);
  const s = new SupabaseS3DocumentStore({
    endpoint: "https://abcdefghij.storage.supabase.co/storage/v1/s3",
    region: "eu-central-1",
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
    bucket: "supplier-documents",
    fetch: f.fn,
    now: () => NOW,
    ...over,
  });
  return { s, calls: f.calls };
}

const ok = (body: BodyInit | null = null, init: ResponseInit = {}) => () => new Response(body, { status: 200, ...init });
const xmlError = (status: number, code: string, extra = "") => () =>
  new Response(`<?xml version="1.0"?><Error><Code>${code}</Code><Message>${extra}</Message><Resource>supplier-documents/${KEY}</Resource></Error>`, {
    status,
    headers: { "content-type": "application/xml" },
  });

function streamOf(chunks: number[], chunkSize: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= chunks.length) return c.close();
      c.enqueue(new Uint8Array(chunkSize).fill(chunks[i++]));
    },
  });
}

const sha256 = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("SupabaseS3DocumentStore request shape", () => {
  it("PutObject: path-style URL, signed headers, AWS4-HMAC-SHA256 credential scope", async () => {
    const { s, calls } = store(ok());
    const bytes = new TextEncoder().encode("%PDF-1.4 synthetic test document");
    await s.put(KEY, bytes, "application/pdf");

    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.init.method).toBe("PUT");
    expect(c.url).toBe(`https://abcdefghij.storage.supabase.co/storage/v1/s3/supplier-documents/${KEY}`);
    expect(c.init.redirect).toBe("error");
    expect(c.init.cache).toBe("no-store");
    expect(c.init.signal).toBeInstanceOf(AbortSignal);
    expect(c.body).toEqual(bytes);
    expect(c.headers["content-type"]).toBe("application/pdf");
    expect(c.headers["x-amz-content-sha256"]).toBe(sha256(bytes));
    expect(c.headers["x-amz-date"]).toBe("20261102T101530Z");
    expect(c.headers.authorization).toMatch(
      new RegExp(`^AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/20261102/eu-central-1/s3/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$`),
    );
    // Nothing secret travels in clear.
    expect(JSON.stringify(c.headers)).not.toContain(SECRET);
    expect(c.url).not.toMatch(/X-Amz-|Signature|\?/);
  });

  it("GetObject and DeleteObject: empty-payload hash, no body, same signing scope", async () => {
    const { s, calls } = store((c) => (c.init.method === "GET" ? new Response(new Uint8Array([1, 2, 3])) : new Response(null, { status: 204 })));
    expect(await s.get(KEY, { maxBytes: 10 })).toEqual(new Uint8Array([1, 2, 3]));
    await s.delete(KEY);
    expect(calls.map((c) => c.init.method)).toEqual(["GET", "DELETE"]);
    for (const c of calls) {
      expect(c.url).toBe(`https://abcdefghij.storage.supabase.co/storage/v1/s3/supplier-documents/${KEY}`);
      expect(c.body).toBeNull();
      expect(c.headers["x-amz-content-sha256"]).toBe(EMPTY_HASH);
      expect(c.init.redirect).toBe("error");
      expect(c.init.cache).toBe("no-store");
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
      expect(c.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=unitAccessKey123\/20261102\/eu-central-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    }
  });

  it("signature matches an independent SigV4 computation", async () => {
    const { s, calls } = store(ok());
    const body = new TextEncoder().encode("known answer body");
    await s.put(KEY, body, "application/pdf");
    const sent = calls[0].headers.authorization.match(/Signature=([0-9a-f]{64})$/)![1];

    // Written out by hand from the AWS SigV4 specification, without the module's helpers.
    const payloadHash = createHash("sha256").update(body).digest("hex");
    const canonicalRequest =
      "PUT\n" +
      `/storage/v1/s3/supplier-documents/${KEY}\n` +
      "\n" +
      "content-type:application/pdf\n" +
      "host:abcdefghij.storage.supabase.co\n" +
      `x-amz-content-sha256:${payloadHash}\n` +
      "x-amz-date:20261102T101530Z\n" +
      "\n" +
      "content-type;host;x-amz-content-sha256;x-amz-date\n" +
      payloadHash;
    const stringToSign = "AWS4-HMAC-SHA256\n" + "20261102T101530Z\n" + "20261102/eu-central-1/s3/aws4_request\n" + createHash("sha256").update(canonicalRequest).digest("hex");
    const kDate = createHmac("sha256", `AWS4${SECRET}`).update("20261102").digest();
    const kRegion = createHmac("sha256", kDate).update("eu-central-1").digest();
    const kService = createHmac("sha256", kRegion).update("s3").digest();
    const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
    const expected = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

    expect(sent).toBe(expected);
  });

  it("a loopback http endpoint keeps its port in the signed host", async () => {
    const { s, calls } = store(ok(), { endpoint: "http://127.0.0.1:55480/s3/" });
    await s.put(KEY, new Uint8Array([7]), "application/pdf");
    expect(calls[0].url).toBe(`http://127.0.0.1:55480/s3/supplier-documents/${KEY}`);
  });
});

describe("SupabaseS3DocumentStore refusals", () => {
  const badKeys = [
    "",
    "test/0123456789abcdef0123456789ABCDEF",
    "test/0123456789abcdef0123456789abcde",
    "staging/0123456789abcdef0123456789abcdef",
    "test/../production/0123456789abcdef0123456789ab",
    "test/0123456789abcdef0123456789abcdef/x",
    "/test/0123456789abcdef0123456789abcdef",
    "test/0123456789abcdef0123456789abcdef?x-id=1",
    "test/booking-REF123.pdf",
  ];

  it.each(badKeys)("refuses key %j before any request", async (key) => {
    const { s, calls } = store(ok());
    await expect(s.put(key, new Uint8Array([1]), "application/pdf")).rejects.toThrow(DocumentStoreError);
    await expect(s.get(key, { maxBytes: 10 })).rejects.toThrow(/object key refused/);
    await expect(s.delete(key)).rejects.toThrow(/object key refused/);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["http://abcdefghij.storage.supabase.co/storage/v1/s3", /loopback host only/],
    ["http://10.0.0.5:5000/s3", /loopback host only/],
    ["http://127.0.0.1.example.com/s3", /loopback host only/],
    ["ftp://127.0.0.1/s3", /must be https/],
    ["https://user:pass@abcdefghij.storage.supabase.co/s3", /credentials/],
    ["https://abcdefghij.storage.supabase.co/s3?x=1", /query or fragment/],
    ["not a url", /not a URL/],
  ])("refuses endpoint %s", (endpoint, why) => {
    expect(() => store(ok(), { endpoint })).toThrow(why);
  });

  it.each(["http://127.0.0.1:55480/s3", "http://localhost:55480/s3", "http://[::1]:55480/s3", "https://abcdefghij.storage.supabase.co/storage/v1/s3"])("accepts endpoint %s", (endpoint) => {
    expect(() => store(ok(), { endpoint })).not.toThrow();
  });

  it("refuses malformed bucket, region, access key or empty secret", () => {
    expect(() => store(ok(), { bucket: "Supplier_Documents" })).toThrow(/bucket/);
    expect(() => store(ok(), { region: "eu central" })).toThrow(/region/);
    expect(() => store(ok(), { accessKeyId: "a/b" })).toThrow(/access key/);
    expect(() => store(ok(), { secretAccessKey: "" })).toThrow(/secret/);
  });

  it("refuses a content type that could inject a header", async () => {
    const { s, calls } = store(ok());
    await expect(s.put(KEY, new Uint8Array([1]), "application/pdf\r\nx-amz-acl: public-read")).rejects.toThrow(/content type/);
    expect(calls).toHaveLength(0);
  });

  it("exposes no URL or presign method", () => {
    const { s } = store(ok());
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(s));
    expect(methods.filter((m) => /url|sign|presign/i.test(m))).toEqual([]);
  });
});

describe("SupabaseS3DocumentStore responses", () => {
  it("404 NoSuchKey on get is null, and on delete is success", async () => {
    const { s } = store(xmlError(404, "NoSuchKey", "Object not found"));
    expect(await s.get(KEY, { maxBytes: 10 })).toBeNull();
    await expect(s.delete(KEY)).resolves.toBeUndefined();
  });

  it("404 NoSuchKey as JSON is a missing object too", async () => {
    const { s } = store(() => new Response(JSON.stringify({ code: "NoSuchKey", message: "Object not found" }), { status: 404, headers: { "content-type": "application/json" } }));
    expect(await s.get(KEY, { maxBytes: 10 })).toBeNull();
  });

  it("404 NoSuchBucket is an error, not a missing object", async () => {
    const { s } = store(xmlError(404, "NoSuchBucket"));
    await expect(s.get(KEY, { maxBytes: 10 })).rejects.toMatchObject({ operation: "GetObject", status: 404 });
    await expect(s.delete(KEY)).rejects.toMatchObject({ operation: "DeleteObject", status: 404 });
  });

  // A misconfigured endpoint or path also answers 404; taking it for a miss would quarantine valid documents (R-B4-9).
  it.each([
    ["no body", () => new Response(null, { status: 404 })],
    ["an HTML page", () => new Response("<html><body>404 Not Found</body></html>", { status: 404, headers: { "content-type": "text/html" } })],
    ["a JSON error without NoSuchKey", () => new Response(JSON.stringify({ statusCode: "404", error: "not_found", message: "Route not found" }), { status: 404 })],
    ["another S3 code", xmlError(404, "NoSuchUpload")],
  ])("404 with %s is a store error, not a missing object", async (_what, respond) => {
    const { s } = store(respond);
    await expect(s.get(KEY, { maxBytes: 10 })).rejects.toMatchObject({ operation: "GetObject", status: 404, message: "GetObject failed: HTTP 404 (not a missing object)" });
    await expect(s.delete(KEY)).rejects.toMatchObject({ operation: "DeleteObject", status: 404 });
  });

  it("refuses an object whose Content-Length exceeds maxBytes without reading it", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(1024));
      },
    });
    const { s } = store(() => new Response(body, { status: 200, headers: { "content-length": "5000000" } }));
    await expect(s.get(KEY, { maxBytes: 1000 })).rejects.toThrow(/larger than the read limit/);
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it("caps a streamed body without Content-Length", async () => {
    const { s } = store(() => new Response(streamOf([1, 2, 3, 4, 5], 400), { status: 200 }));
    await expect(s.get(KEY, { maxBytes: 1000 })).rejects.toThrow(/larger than the read limit/);
  });

  it("returns a streamed body of exactly maxBytes", async () => {
    const { s } = store(() => new Response(streamOf([1, 2], 500), { status: 200 }));
    const got = await s.get(KEY, { maxBytes: 1000 });
    expect(got?.byteLength).toBe(1000);
    expect(got?.[999]).toBe(2);
  });

  it("refuses a negative or fractional maxBytes", async () => {
    const { s, calls } = store(ok());
    await expect(s.get(KEY, { maxBytes: -1 })).rejects.toThrow(/maxBytes/);
    await expect(s.get(KEY, { maxBytes: 1.5 })).rejects.toThrow(/maxBytes/);
    expect(calls).toHaveLength(0);
  });

  it("times out", async () => {
    const { s } = store((c) => new Promise<Response>((_, reject) => c.init.signal!.addEventListener("abort", () => reject(c.init.signal!.reason))), { timeoutMs: 100 });
    await expect(s.get(KEY, { maxBytes: 10 })).rejects.toThrow(/GetObject failed: timed out/);
  });
});

describe("SupabaseS3DocumentStore errors leak nothing", () => {
  const BODY_MARKER = "BODY-MARKER-tickets-AB12CD";

  function assertClean(e: unknown) {
    expect(e).toBeInstanceOf(DocumentStoreError);
    const err = e as DocumentStoreError;
    const text = [err.message, err.stack ?? "", JSON.stringify(err), inspect(err, { depth: 5 }), String(err.cause ?? "")].join("\n");
    for (const forbidden of [SECRET, ACCESS_KEY, BODY_MARKER, KEY, "0123456789abcdef", "Signature", "AWS4-HMAC", "storage.supabase.co", "https://", "supplier-documents"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(err.cause).toBeUndefined();
  }

  it.each([403, 500, 503])("HTTP %i carries operation and status only", async (status) => {
    const { s } = store(xmlError(status, "SignatureDoesNotMatch", `${BODY_MARKER} ${SECRET} Signature=abc`));
    for (const op of [() => s.put(KEY, new Uint8Array([1]), "application/pdf"), () => s.get(KEY, { maxBytes: 10 }), () => s.delete(KEY)]) {
      const e = await op().catch((x: unknown) => x);
      assertClean(e);
      expect((e as DocumentStoreError).status).toBe(status);
      expect((e as Error).message).toMatch(new RegExp(`^(PutObject|GetObject|DeleteObject) failed: HTTP ${status}$`));
    }
  });

  it("a network error does not forward its cause (which may name the URL)", async () => {
    const { s } = store(() => {
      throw new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED https://abcdefghij.storage.supabase.co/storage/v1/s3/supplier-documents/${KEY} ${SECRET}`) });
    });
    const e = await s.get(KEY, { maxBytes: 10 }).catch((x: unknown) => x);
    assertClean(e);
    expect((e as DocumentStoreError).status).toBeNull();
  });

  it("the store itself does not serialise or inspect its credentials", () => {
    const { s } = store(ok());
    const text = [JSON.stringify(s), inspect(s, { depth: 5, showHidden: true }), String(s), Object.keys(s).join(",")].join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(ACCESS_KEY);
  });
});
