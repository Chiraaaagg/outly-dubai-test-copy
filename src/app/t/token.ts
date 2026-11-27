/**
 * Reads the booking-link token from a URL fragment (`#<token>`). Pure, for
 * the `/t` landing and its tests. Anything that cannot be a token (empty,
 * too long, or with characters a URL-safe token never has) is null, so a
 * mangled link shows the expired/invalid state without a request.
 */
export const MAX_TOKEN_LENGTH = 256;

export function tokenFromHash(hash: string | null | undefined): string | null {
  if (!hash) return null;
  let raw = hash.startsWith("#") ? hash.slice(1) : hash;
  // Some mail clients append parameters after the fragment value.
  raw = raw.split(/[?&]/)[0] ?? "";
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  raw = raw.trim();
  if (!raw || raw.length > MAX_TOKEN_LENGTH) return null;
  return /^[A-Za-z0-9._~-]+$/.test(raw) ? raw : null;
}
