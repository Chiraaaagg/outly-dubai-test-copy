import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from "jose";
import { signHookPayload, hookSecretKey } from "../auth-hook";

/**
 * A fake Supabase Auth server on loopback, for the contract and route tests
 * (Group B). It speaks the subset of the Auth API that
 * src/server/auth/supabase-auth.client.ts uses, with the request and
 * response shapes that client expects, and it calls our Send Email hook the
 * way Supabase does (Standard Webhooks headers, signed with the hook secret).
 * It never talks to anything but loopback. Every request is recorded so the
 * tests pin the exact paths, headers and bodies.
 *
 * Shapes (Auth API, version header 2024-01-01), as assumed by the client and
 * to be confirmed against the hosted project at the staging step:
 *   POST /auth/v1/otp            { email, create_user }         → 200 {}
 *   POST /auth/v1/verify         { type: "email", email, token } → 200 { access_token, refresh_token, user }
 *                                                                 403 { code, error_code: "otp_expired", msg }
 *   POST /auth/v1/token?grant_type=id_token { provider, id_token, nonce } → 200 session
 *   GET  /auth/v1/user           Bearer                           → 200 { id, email, email_confirmed_at, phone, identities[] }
 *   POST /auth/v1/logout?scope=local Bearer                       → 204
 *   GET  /auth/v1/.well-known/jwks.json                           → { keys: [ES256] }
 */

export interface FakeUser {
  id: string;
  email: string;
  emailConfirmedAt: string | null;
  phone?: string | null;
  phoneConfirmedAt?: string | null;
  identities: { provider: string; identity_data: Record<string, unknown> }[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface FakeSupabase {
  url: string;
  requests: RecordedRequest[];
  users: Map<string, FakeUser>;
  /** Last code generated per email (what the hook was asked to send). */
  codes: Map<string, string>;
  /** Force the next answer of a path (`/otp`, `/verify`, `/token`, `/user`) to this status and body. */
  failNext: (path: string, status: number, body: unknown) => void;
  /** Mint an access token for a user (or a forged one with other claims). */
  token: (userId: string, overrides?: Record<string, unknown>, key?: KeyLike) => Promise<string>;
  /** A key that is not in the JWKS. */
  foreignKey: KeyLike;
  /** The hook the fake calls during /otp. Return the HTTP status the hook answered. */
  onSendEmail: ((body: string, headers: Record<string, string>) => Promise<number>) | null;
  sendEmailHookSecret: string;
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, body?: unknown) {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function startFakeSupabase(opts: { sendEmailHookSecret?: string } = {}): Promise<FakeSupabase> {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const foreign = await generateKeyPair("ES256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "fake-es256-1", alg: "ES256", use: "sig" };
  const users = new Map<string, FakeUser>();
  const byEmail = new Map<string, string>();
  const codes = new Map<string, string>();
  const requests: RecordedRequest[] = [];
  const forced = new Map<string, { status: number; body: unknown }>();
  const tokens = new Map<string, string>(); // token → user id
  const sendEmailHookSecret = opts.sendEmailHookSecret ?? `v1,whsec_${randomBytes(32).toString("base64")}`;
  let url = "";

  const fake: FakeSupabase = {
    url: "",
    requests,
    users,
    codes,
    failNext: (path, status, body) => forced.set(path, { status, body }),
    token: async (userId, overrides = {}, key) => {
      const t = await new SignJWT({ role: "authenticated", aud: "authenticated", ...overrides })
        .setProtectedHeader({ alg: "ES256", kid: "fake-es256-1", typ: "JWT" })
        .setIssuer(`${url}/auth/v1`)
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(key ?? privateKey);
      tokens.set(t, userId);
      return t;
    },
    foreignKey: foreign.privateKey,
    onSendEmail: null,
    sendEmailHookSecret,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };

  const session = async (user: FakeUser) => ({ access_token: await fake.token(user.id), token_type: "bearer", expires_in: 3600, refresh_token: randomBytes(16).toString("hex"), user: { id: user.id } });

  const userFor = (email: string, provider: string, identityData: Record<string, unknown>): FakeUser => {
    const known = byEmail.get(email);
    if (known) {
      const u = users.get(known)!;
      if (!u.identities.some((i) => i.provider === provider)) u.identities.push({ provider, identity_data: identityData });
      return u;
    }
    const u: FakeUser = { id: randomUUID(), email, emailConfirmedAt: null, identities: [{ provider, identity_data: identityData }] };
    users.set(u.id, u);
    byEmail.set(email, u.id);
    return u;
  };

  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const u = new URL(req.url ?? "/", "http://fake");
    const path = u.pathname.replace(/^\/auth\/v1/, "");
    requests.push({ method: req.method ?? "", path: `${path}${u.search}`, headers: req.headers, body });
    const force = forced.get(path);
    if (force) {
      forced.delete(path);
      return send(res, force.status, force.body);
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");

    if (req.method === "GET" && path === "/.well-known/jwks.json") return send(res, 200, { keys: [jwk] });

    if (req.method === "POST" && path === "/otp") {
      const email = String(b.email ?? "").toLowerCase();
      if (!email.includes("@")) return send(res, 400, { code: 400, error_code: "email_address_invalid", msg: "invalid" });
      const user = userFor(email, "email", { email, email_verified: false, sub: "" });
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      codes.set(email, code);
      if (fake.onSendEmail) {
        const hookBody = JSON.stringify({ user: { id: user.id, email, app_metadata: { provider: "email" } }, email_data: { token: code, token_hash: randomBytes(8).toString("hex"), redirect_to: "", email_action_type: user.emailConfirmedAt ? "magiclink" : "signup", site_url: "" } });
        const id = `msg_${randomBytes(8).toString("hex")}`;
        const ts = String(Math.floor(Date.now() / 1000));
        const key = hookSecretKey(sendEmailHookSecret)!;
        const status = await fake.onSendEmail(hookBody, { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${signHookPayload(key, id, ts, hookBody)}` });
        if (status < 200 || status >= 300) return send(res, 500, { code: 500, error_code: "hook_timeout_after_retry", msg: "Error running hook" });
      }
      return send(res, 200, {});
    }

    if (req.method === "POST" && path === "/verify") {
      const email = String(b.email ?? "").toLowerCase();
      const expected = codes.get(email);
      if (b.type !== "email" || !expected || expected !== b.token) return send(res, 403, { code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" });
      codes.delete(email);
      const user = users.get(byEmail.get(email)!)!;
      user.emailConfirmedAt ??= new Date().toISOString();
      for (const i of user.identities) if (i.provider === "email") i.identity_data = { ...i.identity_data, email_verified: true, sub: user.id };
      return send(res, 200, await session(user));
    }

    if (req.method === "POST" && path === "/token" && u.searchParams.get("grant_type") === "id_token") {
      const idToken = String(b.id_token ?? "");
      const parts = idToken.split(".");
      if (b.provider !== "google" || parts.length !== 3 || typeof b.nonce !== "string") return send(res, 400, { code: 400, error_code: "validation_failed", msg: "bad" });
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { email?: string; email_verified?: boolean; sub?: string };
      if (!claims.email || claims.email_verified !== true) return send(res, 400, { code: 400, error_code: "email_not_confirmed", msg: "unverified" });
      const email = claims.email.toLowerCase();
      const user = userFor(email, "google", { email, email_verified: true, sub: claims.sub });
      user.emailConfirmedAt ??= new Date().toISOString();
      return send(res, 200, await session(user));
    }

    if (req.method === "GET" && path === "/user") {
      const id = tokens.get(bearer);
      const user = id ? users.get(id) : undefined;
      if (!user) return send(res, 401, { code: 401, error_code: "bad_jwt", msg: "invalid" });
      return send(res, 200, {
        id: user.id,
        aud: "authenticated",
        role: "authenticated",
        email: user.email,
        email_confirmed_at: user.emailConfirmedAt,
        phone: user.phone ?? "",
        phone_confirmed_at: user.phoneConfirmedAt ?? null,
        user_metadata: { email_verified: true, full_name: "set by the user" },
        app_metadata: { provider: user.identities[0]?.provider, providers: user.identities.map((i) => i.provider) },
        identities: user.identities.map((i) => ({ provider: i.provider, identity_data: i.identity_data })),
      });
    }

    if (req.method === "POST" && path === "/logout") return send(res, 204);
    return send(res, 404, { code: 404, error_code: "not_found", msg: "no route" });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  fake.url = url;
  return fake;
}
