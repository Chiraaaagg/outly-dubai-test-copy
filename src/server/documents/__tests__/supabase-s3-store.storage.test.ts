import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { installEgressBlock, isLoopbackHost } from "../../__tests__/helpers/target-guard";
import { OBJECT_KEY } from "../contracts";
import { amzDates, DocumentStoreError, signV4, SupabaseS3DocumentStore } from "../supabase-s3-store";

/**
 * The S3 document store against the disposable local Supabase Storage of
 * scripts/test-storage/up.sh (`storage` project). Never a hosted project:
 * every URL in the env file must be loopback, and all other egress is
 * blocked.
 *
 *   sh scripts/test-storage/up.sh --workdir /tmp/outly-storage-disposable
 *   OUTLY_STORAGE_ENV_FILE=/tmp/outly-storage-disposable/storage.env npm run test:storage
 *
 * With OUTLY_REQUIRE_STORAGE=1 (npm run test:storage) a missing env file
 * fails this file instead of skipping it.
 */

installEgressBlock();

type StorageEnv = Record<string, string>;

function loadStorageEnv(): StorageEnv | null {
  const file = process.env.OUTLY_STORAGE_ENV_FILE;
  const required = process.env.OUTLY_REQUIRE_STORAGE === "1";
  if (!file || !existsSync(file)) {
    if (required) throw new Error(`OUTLY_REQUIRE_STORAGE=1 but no storage env file (OUTLY_STORAGE_ENV_FILE=${file ?? "unset"}); run scripts/test-storage/up.sh --workdir <dir>`);
    return null;
  }
  const real = realpathSync(file);
  if (`${real}/`.startsWith(`${realpathSync(process.cwd())}${path.sep}`)) throw new Error("the storage env file must live outside the repository");
  const env: StorageEnv = {};
  for (const line of readFileSync(real, "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i)] = line.slice(i + 1);
  }
  const need = [
    "OUTLY_STORAGE_DISPOSABLE",
    "SUPPLIER_DOCS_S3_ENDPOINT",
    "SUPPLIER_DOCS_S3_REGION",
    "SUPPLIER_DOCS_S3_ACCESS_KEY_ID",
    "SUPPLIER_DOCS_S3_SECRET_ACCESS_KEY",
    "SUPPLIER_DOCS_BUCKET",
    "OUTLY_STORAGE_REST_URL",
    "OUTLY_STORAGE_ANON_KEY",
    "OUTLY_STORAGE_SERVICE_KEY",
    "OUTLY_STORAGE_TENANT_ID",
  ];
  for (const k of need) if (!env[k]) throw new Error(`storage env file lacks ${k}`);
  if (env.OUTLY_STORAGE_DISPOSABLE !== "1") throw new Error("storage env file is not marked disposable");
  for (const k of ["SUPPLIER_DOCS_S3_ENDPOINT", "OUTLY_STORAGE_REST_URL"]) {
    if (!isLoopbackHost(new URL(env[k]).hostname)) throw new Error(`${k} is not a loopback URL; the storage suites run against the local stack only`);
  }
  return env;
}

const E = loadStorageEnv();

if (!E) {
  describe.skip("SupabaseS3DocumentStore against local Supabase Storage (no OUTLY_STORAGE_ENV_FILE)", () => {
    it("needs scripts/test-storage/up.sh", () => undefined);
  });
} else {
  describe("SupabaseS3DocumentStore against local Supabase Storage", () => storageSuite(E));
}

function storageSuite(env: StorageEnv) {
  const bucket = env.SUPPLIER_DOCS_BUCKET;
  const rest = env.OUTLY_STORAGE_REST_URL;
  const config = {
    endpoint: env.SUPPLIER_DOCS_S3_ENDPOINT,
    region: env.SUPPLIER_DOCS_S3_REGION,
    accessKeyId: env.SUPPLIER_DOCS_S3_ACCESS_KEY_ID,
    secretAccessKey: env.SUPPLIER_DOCS_S3_SECRET_ACCESS_KEY,
    bucket,
  };
  const store = new SupabaseS3DocumentStore(config);
  const created: string[] = [];

  const newKey = () => {
    const key = `test/${randomBytes(16).toString("hex")}`;
    created.push(key);
    return key;
  };
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  /** Synthetic PDF-looking bytes: a header and random filler. */
  const syntheticPdf = (size: number) => {
    const b = new Uint8Array(randomBytes(size));
    b.set(new TextEncoder().encode("%PDF-1.4\n% synthetic test document\n"));
    return b;
  };

  const anon = { authorization: `Bearer ${env.OUTLY_STORAGE_ANON_KEY}`, apikey: env.OUTLY_STORAGE_ANON_KEY };
  const service = { authorization: `Bearer ${env.OUTLY_STORAGE_SERVICE_KEY}` };
  const restFetch = (p: string, init: RequestInit = {}) => fetch(`${rest}${p}`, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(10_000), ...init });
  const bodyOf = async (r: Response) => new Uint8Array(await r.arrayBuffer());

  /** Asserts a REST response did not serve the object. */
  async function refused(r: Response, payload: Uint8Array) {
    const body = await bodyOf(r);
    expect(r.status, `HTTP ${r.status}`).not.toBe(200);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(sha(body)).not.toBe(sha(payload));
    expect(Buffer.from(body).includes(Buffer.from(payload.subarray(0, 16)))).toBe(false);
  }

  afterAll(async () => {
    for (const key of created) await store.delete(key).catch(() => undefined);
  });

  it("round-trips an object byte for byte", async () => {
    const key = newKey();
    const payload = syntheticPdf(256 * 1024 + 17);
    await store.put(key, payload, "application/pdf");
    const got = await store.get(key, { maxBytes: payload.byteLength });
    expect(got).not.toBeNull();
    expect(got!.byteLength).toBe(payload.byteLength);
    expect(sha(got!)).toBe(sha(payload));
  });

  it("returns null for a missing object", async () => {
    expect(await store.get(newKey(), { maxBytes: 1024 })).toBeNull();
  });

  it("deletes an object, and deleting it again succeeds", async () => {
    const key = newKey();
    await store.put(key, syntheticPdf(2048), "application/pdf");
    expect(await store.get(key, { maxBytes: 4096 })).not.toBeNull();
    await store.delete(key);
    expect(await store.get(key, { maxBytes: 4096 })).toBeNull();
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it("refuses a read larger than maxBytes (and serves one of exactly maxBytes)", async () => {
    const key = newKey();
    const payload = syntheticPdf(4096);
    await store.put(key, payload, "application/pdf");
    await expect(store.get(key, { maxBytes: 4095 })).rejects.toThrow(/larger than the read limit/);
    expect(sha((await store.get(key, { maxBytes: 4096 }))!)).toBe(sha(payload));
  });

  it("the bucket is private", async () => {
    const r = await restFetch(`/bucket/${bucket}`, { headers: service });
    expect(r.status).toBe(200);
    const b = (await r.json()) as { id: string; public: boolean };
    expect(b.id).toBe(bucket);
    expect(b.public).toBe(false);
  });

  it("anonymous REST reads are refused (no auth, anon key, public URL, list, sign)", async () => {
    const key = newKey();
    const payload = syntheticPdf(1024);
    await store.put(key, payload, "application/pdf");

    // Positive control: the object exists and the service role can read it.
    const control = await restFetch(`/object/${bucket}/${key}`, { headers: service });
    expect(control.status).toBe(200);
    expect(sha(await bodyOf(control))).toBe(sha(payload));

    await refused(await restFetch(`/object/${bucket}/${key}`), payload);
    await refused(await restFetch(`/object/${bucket}/${key}`, { headers: anon }), payload);
    await refused(await restFetch(`/object/authenticated/${bucket}/${key}`, { headers: anon }), payload);
    await refused(await restFetch(`/object/public/${bucket}/${key}`), payload);
    await refused(await restFetch(`/object/public/${bucket}/${key}`, { headers: anon }), payload);
    await refused(await restFetch(`/bucket/${bucket}`, { headers: anon }), payload);

    const signed = await restFetch(`/object/sign/${bucket}/${key}`, { method: "POST", headers: { ...anon, "content-type": "application/json" }, body: JSON.stringify({ expiresIn: 60 }) });
    expect(signed.status).not.toBe(200);
    expect(await signed.text()).not.toMatch(/signedURL|token=/i);

    const list = await restFetch(`/object/list/${bucket}`, { method: "POST", headers: { ...anon, "content-type": "application/json" }, body: JSON.stringify({ prefix: "test/" }) });
    const listed = list.status === 200 ? ((await list.json()) as unknown[]) : [];
    expect(listed).toEqual([]);
  });

  it("an S3 request with the anon key as session token is refused by RLS", async () => {
    const key = newKey();
    const payload = syntheticPdf(1024);
    await store.put(key, payload, "application/pdf");

    // Storage's session-token mode: access key = tenant id, secret = anon key, token = a JWT whose role RLS applies.
    const url = new URL(`${env.SUPPLIER_DOCS_S3_ENDPOINT}/${bucket}/${key}`);
    const sessionGet = (token: string) => {
      const { amzDate, dateStamp } = amzDates(new Date());
      const payloadHash = createHash("sha256").update("").digest("hex");
      const headers = { "x-amz-security-token": token };
      const { authorization } = signV4({
        method: "GET",
        path: url.pathname,
        host: url.host,
        headers,
        payloadHash,
        amzDate,
        dateStamp,
        region: env.SUPPLIER_DOCS_S3_REGION,
        accessKeyId: env.OUTLY_STORAGE_TENANT_ID,
        secret: env.OUTLY_STORAGE_ANON_KEY,
      });
      return fetch(url, { redirect: "manual", cache: "no-store", headers: { ...headers, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, authorization }, signal: AbortSignal.timeout(10_000) });
    };

    // Positive control: the same signing with the service-role JWT as token reads the object,
    // so the refusal below is row-level security, not a bad signature.
    const control = await sessionGet(env.OUTLY_STORAGE_SERVICE_KEY);
    expect(control.status).toBe(200);
    expect(sha(await bodyOf(control))).toBe(sha(payload));

    await refused(await sessionGet(env.OUTLY_STORAGE_ANON_KEY), payload);

    // And with no signature at all.
    await refused(await fetch(url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(10_000) }), payload);
  });

  it("a wrong S3 secret or access key is refused and writes nothing", async () => {
    const key = newKey();
    for (const bad of [new SupabaseS3DocumentStore({ ...config, secretAccessKey: `${config.secretAccessKey}x` }), new SupabaseS3DocumentStore({ ...config, accessKeyId: "0123456789abcdef0123456789abcdef" })]) {
      const put = await bad.put(key, syntheticPdf(512), "application/pdf").catch((e: unknown) => e);
      expect(put).toBeInstanceOf(DocumentStoreError);
      expect((put as DocumentStoreError).status).toBe(403);
      expect((put as Error).message).toBe("PutObject failed: HTTP 403");
      await expect(bad.get(key, { maxBytes: 1024 })).rejects.toMatchObject({ operation: "GetObject", status: 403 });
      await expect(bad.delete(key)).rejects.toMatchObject({ operation: "DeleteObject", status: 403 });
    }
    expect(await store.get(key, { maxBytes: 1024 })).toBeNull();
  });

  it("a wrong region is refused (the stack enforces its region)", async () => {
    const wrong = new SupabaseS3DocumentStore({ ...config, region: "eu-west-9" });
    await expect(wrong.get(newKey(), { maxBytes: 1024 })).rejects.toMatchObject({ status: 403 });
  });

  it("object keys carry nothing but <env>/<32 hex>, and other keys never reach the bucket", async () => {
    const key = newKey();
    expect(key).toMatch(OBJECT_KEY);
    await store.put(key, syntheticPdf(512), "application/pdf");
    await expect(store.put("test/booking-OUT-12345-ticket.pdf", syntheticPdf(512), "application/pdf")).rejects.toThrow(/object key refused/);

    const r = await restFetch(`/object/list/${bucket}`, { method: "POST", headers: { ...service, "content-type": "application/json" }, body: JSON.stringify({ prefix: "test/", limit: 1000 }) });
    expect(r.status).toBe(200);
    const names = ((await r.json()) as { name: string }[]).map((o) => o.name);
    expect(names).toContain(key.slice("test/".length));
    for (const n of names) expect(`test/${n}`).toMatch(OBJECT_KEY);

    const top = await restFetch(`/object/list/${bucket}`, { method: "POST", headers: { ...service, "content-type": "application/json" }, body: JSON.stringify({ prefix: "", limit: 1000 }) });
    const prefixes = ((await top.json()) as { name: string }[]).map((o) => o.name);
    for (const p of prefixes) expect(["test", "development", "production"]).toContain(p);
  });
}
