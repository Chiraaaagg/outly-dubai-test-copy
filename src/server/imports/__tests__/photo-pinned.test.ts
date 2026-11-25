import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchPhoto, makePinnedHttpsGet } from "../photo-copy";

/**
 * Review 106 N1-24: the real pinned request against a loopback TLS server.
 * The certificate is generated for this run (never committed) for the name
 * `media.example.test`, which does not resolve: the request can only reach
 * the server because it connects to the pinned address. No external network.
 */

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const HOST = "media.example.test";

describe.skipIf(!hasOpenssl())("pinned https request (loopback)", () => {
  let dir = "";
  let server: Server;
  let port = 0;
  let ca = "";
  const seen: { host?: string; path?: string }[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "zz-pinned-"));
    const key = path.join(dir, "k.pem");
    const cert = path.join(dir, "c.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=DNS:${HOST}`], { stdio: "ignore" });
    ca = readFileSync(cert, "utf8");
    server = createServer({ key: readFileSync(key), cert: ca }, (req, res) => {
      seen.push({ host: req.headers.host, path: req.url });
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "/a.jpg" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(JPEG.length) });
      res.end(JPEG);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("connects to the pinned address with the URL's host for SNI, Host and the certificate check", async () => {
    const request = makePinnedHttpsGet({ port, ca });
    // fetchPhoto never pins a private address: loopback is refused before any connection.
    await expect(fetchPhoto(`https://${HOST}/a.jpg`, { allowedHosts: [HOST], request, lookup: async () => ["127.0.0.1"] })).rejects.toMatchObject({ code: "private_address" });
    const before = seen.length;
    expect(before).toBe(0);
    // The request function itself, pinned to loopback: it reaches the server by address, with SNI and Host = the URL's name.
    const res = await request(new URL(`https://${HOST}/redirect`), "127.0.0.1", AbortSignal.timeout(5_000));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/a.jpg");
    const ok = await request(new URL(`https://${HOST}/a.jpg`), "127.0.0.1", AbortSignal.timeout(5_000));
    expect(ok.status).toBe(200);
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(new Uint8Array(JPEG));
    expect(seen.at(-1)).toMatchObject({ host: `${HOST}:${port}`, path: "/a.jpg" });
  });

  it("refuses a certificate that does not name the URL's host", async () => {
    const request = makePinnedHttpsGet({ port, ca });
    await expect(request(new URL("https://other.example.test/a.jpg"), "127.0.0.1", AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });

  it("refuses an untrusted certificate (no test CA)", async () => {
    const request = makePinnedHttpsGet({ port });
    await expect(request(new URL(`https://${HOST}/a.jpg`), "127.0.0.1", AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: expect.stringMatching(/SELF_SIGNED|UNABLE_TO_VERIFY/) });
  });
});
