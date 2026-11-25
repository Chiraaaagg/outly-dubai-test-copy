import { describe, expect, it, vi } from "vitest";
import { copyTourPhotos, fetchPhoto, hostAllowed, MemoryPhotoStore, pickVariant, PhotoRefused, sniffImageType, validHostEntry, type SniffedType } from "../photo-copy";
import type { TourContentPhoto } from "../../suppliers/traveldesk/traveldesk.content";

/**
 * Doc 30 §3.8: the safe photo copy. Every fetch is a fake; nothing reaches
 * the network. Bytes are synthetic magic numbers, not real images.
 */

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 9]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const HOSTS = ["media.example.test", "*.cdn.example.test"];
const PUBLIC = async () => ["93.184.216.34"];

function res(status: number, body: Uint8Array | null, headers: Record<string, string> = {}) {
  return new Response(body ? new Blob([body.slice().buffer]) : null, { status, headers });
}

describe("photo fetch checks", () => {
  it("sniffs raster types from bytes and refuses anything else", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(SVG)).toBeNull();
  });

  it("allows listed hosts only", () => {
    expect(hostAllowed("media.example.test", HOSTS)).toBe(true);
    expect(hostAllowed("a.cdn.example.test", HOSTS)).toBe(true);
    expect(hostAllowed("cdn.example.test", HOSTS)).toBe(false);
    expect(hostAllowed("media.example.test.evil.test", HOSTS)).toBe(false);
  });

  it.each([
    ["http://media.example.test/a.jpg", "not_https"],
    ["https://media.example.test:8443/a.jpg", "port"],
    [`https://u:p${"@"}media.example.test/a.jpg`, "credentials"], // userinfo built so no address-shaped literal is committed
    ["https://127.0.0.1/a.jpg", "ip_literal"],
    ["https://other.example.test/a.jpg", "host_not_allowed"],
  ])("refuses %s before connecting", async (url, code) => {
    const f = vi.fn();
    await expect(fetchPhoto(url, { allowedHosts: HOSTS, request: f, lookup: PUBLIC })).rejects.toMatchObject({ code });
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a host that resolves to a private address", async () => {
    const f = vi.fn();
    await expect(fetchPhoto("https://media.example.test/a.jpg", { allowedHosts: HOSTS, request: f, lookup: async () => ["10.0.0.5"] })).rejects.toMatchObject({ code: "private_address" });
    expect(f).not.toHaveBeenCalled();
  });

  it("checks every redirect hop, never follows one to a private or unlisted host, and connects to the checked address", async () => {
    const f = vi.fn(async (u: URL) => (u.hostname.startsWith("media.") ? res(302, null, { location: "https://169.254.169.254/latest" }) : res(200, JPEG)));
    await expect(fetchPhoto("https://media.example.test/a.jpg", { allowedHosts: HOSTS, request: f, lookup: PUBLIC })).rejects.toMatchObject({ code: "ip_literal" });
    expect(f).toHaveBeenCalledTimes(1);
    const g = vi.fn(async (u: URL, _address: string) => (u.pathname === "/a.jpg" ? res(301, null, { location: "/b.jpg" }) : res(200, PNG)));
    await expect(fetchPhoto("https://media.example.test/a.jpg", { allowedHosts: HOSTS, request: g, lookup: PUBLIC })).resolves.toMatchObject({ type: "image/png" });
    expect(g.mock.calls[1][0].href).toBe("https://media.example.test/b.jpg");
    // Pinned: the request goes to the address the check approved.
    expect(g.mock.calls[1][1]).toBe("93.184.216.34");
  });

  it("bounds a slow DNS answer by the photo deadline", async () => {
    const never = () => new Promise<string[]>(() => {});
    await expect(fetchPhoto("https://media.example.test/a.jpg", { allowedHosts: HOSTS, request: vi.fn(), lookup: never, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("refuses broad host list entries", () => {
    expect(validHostEntry("*.com")).toBe(false);
    expect(validHostEntry("localhost")).toBe(false);
    expect(validHostEntry("*.cdn.example.test")).toBe(true);
    expect(hostAllowed("a.com", ["*.com"])).toBe(false);
  });

  it("caps the size and refuses SVG served as an image", async () => {
    await expect(fetchPhoto("https://media.example.test/a", { allowedHosts: HOSTS, request: async () => res(200, new Uint8Array(20).fill(0xff)), lookup: PUBLIC, maxBytes: 10 })).rejects.toMatchObject({ code: "too_large" });
    await expect(fetchPhoto("https://media.example.test/a", { allowedHosts: HOSTS, request: async () => res(200, SVG, { "content-type": "image/jpeg" }), lookup: PUBLIC })).rejects.toMatchObject({ code: "not_a_raster_image" });
  });
});

describe("copyTourPhotos", () => {
  const photo = (url: string, type: string | null = "image/webp", width = 1280): TourContentPhoto => ({ supplierPhotoId: 1, caption: "", description: "", variants: [{ type, url, width, height: 720 }] });

  it("picks a raster variant under 2000 px", () => {
    expect(pickVariant({ ...photo("https://m/a"), variants: [{ type: "image/webp", url: "https://m/big", width: 4000, height: 1 }, { type: "image/webp", url: "https://m/hd", width: 1600, height: 1 }] })).toBe("https://m/hd");
    expect(pickVariant(photo("https://m/a.svg", "image/svg+xml"))).toBeNull();
  });

  it("copies at most 12, throttled, re-encoded, into our own store; one failure never stops the rest", async () => {
    const store = new MemoryPhotoStore();
    const sleep = vi.fn(async () => {});
    const photos = Array.from({ length: 15 }, (_, i) => photo(`https://media.example.test/${i}.jpg`));
    const r = await copyTourPhotos(photos, {
      fetchPhoto: async (url) => {
        if (url.endsWith("/3.jpg")) throw new PhotoRefused("http_404");
        return { bytes: JPEG, type: "image/jpeg" as SniffedType };
      },
      reencode: async () => ({ bytes: WEBP, type: "image/webp" }),
      store,
      environment: "test",
      sleep,
    });
    expect(r.urls).toHaveLength(12);
    expect(r.failures).toEqual([{ index: 3, reason: "http_404" }]);
    expect(store.objects.size).toBe(12);
    for (const u of r.urls) expect(u).toMatch(/^https:\/\/photos\.example\.test\/test\/[0-9a-f]{32}$/);
    expect(sleep).toHaveBeenCalledTimes(12);
  });

  it("refuses an encoder result that is not WebP", async () => {
    const r = await copyTourPhotos([photo("https://media.example.test/a.jpg")], {
      fetchPhoto: async () => ({ bytes: JPEG, type: "image/jpeg" }),
      reencode: async () => ({ bytes: JPEG, type: "image/webp" }),
      store: new MemoryPhotoStore(),
      environment: "test",
      sleep: async () => {},
    });
    expect(r).toEqual({ urls: [], keys: [], failures: [{ index: 0, reason: "reencode_failed" }] });
  });

  it("stops before the next photo when the caller's time budget is spent (doc 30 N3, review 108 N3-06)", async () => {
    let calls = 0;
    const r = await copyTourPhotos(Array.from({ length: 5 }, (_, i) => photo(`https://media.example.test/${i}.jpg`)), {
      fetchPhoto: async () => {
        calls += 1;
        return { bytes: JPEG, type: "image/jpeg" as SniffedType };
      },
      reencode: async () => ({ bytes: WEBP, type: "image/webp" }),
      store: new MemoryPhotoStore(),
      environment: "test",
      sleep: async () => {},
      stopAt: () => calls >= 2,
    });
    expect(r.urls).toHaveLength(2);
    expect(r.failures).toEqual([{ index: 2, reason: "time_budget" }]);
  });
});
