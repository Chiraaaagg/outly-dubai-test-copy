/**
 * Doc 30 §3.8 (N1): imported TravelDesk photos are served from our own public
 * storage bucket. Its host comes from LISTING_PHOTOS_PUBLIC_BASE_URL at build
 * time; unset (or not https) adds nothing.
 */
function listingPhotoPattern() {
  try {
    const raw = process.env.LISTING_PHOTOS_PUBLIC_BASE_URL;
    if (!raw) return [];
    const u = new URL(raw);
    if (u.protocol !== "https:") return [];
    return [{ protocol: "https", hostname: u.hostname, pathname: `${u.pathname.replace(/\/+$/, "")}/**` }];
  } catch {
    return [];
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Do not emit AGENTS.md / CLAUDE.md into the repo on dev start.
  agentRules: false,
  // No framework fingerprint in responses (§13.8).
  poweredByHeader: false,
  // Doc 30 §3.8: the photo re-encoder's native module stays a runtime require, traced into the output.
  // Group C (doc 93 §2.2): the code decoder's WebAssembly reader is read from the installed package at run time (never
  // fetched from a CDN), so the package stays a runtime require and its .wasm file is traced into the documents job.
  serverExternalPackages: ["sharp", "zxing-wasm"],
  outputFileTracingIncludes: {
    "/api/jobs/documents-tick": ["./node_modules/zxing-wasm/dist/reader/zxing_reader.wasm"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "plus.unsplash.com" },
      { protocol: "https", hostname: "images.pexels.com" },
      ...listingPhotoPattern(),
    ],
    formats: ["image/avif", "image/webp"],
  },
  async redirects() {
    return [
      // PRD short taxonomy (§4.1) kept alive as canonical-preserving redirects.
      { source: "/d/:slug", destination: "/activities/:slug", permanent: true },
      { source: "/c/:slug", destination: "/categories/:slug", permanent: true },
      { source: "/account/trips", destination: "/account/bookings", permanent: true },
      { source: "/account/wishlist", destination: "/account/saved", permanent: true },
      { source: "/packages/:slug", destination: "/combos/:slug", permanent: true },
      { source: "/experiences/:slug", destination: "/collections/:slug", permanent: true },
    ];
  },
};
export default nextConfig;
