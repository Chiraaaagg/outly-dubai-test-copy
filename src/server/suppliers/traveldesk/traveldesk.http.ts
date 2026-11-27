import type { z } from "zod";
import { recordPhase } from "../../lib/request-timing";
import { assertTravelDeskMutationAllowed, expectedBaseUrl, type TravelDeskConfig } from "./traveldesk.config";

/**
 * TravelDesk HTTP client.
 *
 * GET for reads (`getJson`; `getBinary` for document downloads, B4). POST
 * (reserve, confirm, create, cancel) is Stage 2 and passes
 * `assertTravelDeskMutationAllowed` on EVERY call, which refuses unless
 * TRAVELDESK_BOOKINGS_ENABLED=true, and in production also unless the agency
 * is pinned (TRAVELDESK_AGENCY_ID).
 * POSTs use the mutation timeout (≥ 120 s, HTML §Retries) and are never
 * retried here: a timeout on a POST is an unknown outcome, not a failure.
 *
 * Rules (plan §9 R13/R17, §12):
 *  - The Authorization header is built here and nowhere else. It is never put
 *    in an error, an event or a return value.
 *  - URLs are built from the configured base URL plus a fixed operation path.
 *    A URL taken from a response body is never fetched with the key, and
 *    redirects are refused, so the key cannot be sent to another host.
 *  - Every call has an AbortSignal timeout and a response-size cap.
 *  - Error bodies come in four shapes (HTML §Errors): problem details, plain
 *    text, an empty body, or a 422 `[{fieldName, errorMessage}]` array. All are
 *    classified; none is echoed in full.
 *  - No automatic retries. Callers decide (the cache serves stale data).
 *
 * Pure: no env, no logger. Observability goes through the `onEvent` hook,
 * which carries no body, no query values and no headers, and each call's
 * duration is added to the current request's `supplier` timing
 * (src/server/lib/request-timing.ts; a no-op outside a timed request).
 */

export type TravelDeskErrorKind =
  | "auth" // 401 revoked key, 403 missing/malformed/expired/other-environment key
  | "not_found" // 404
  | "bad_request" // 400 (plain-text reason or problem details)
  | "validation" // 422 field errors
  | "unsupported_media" // 415
  | "rate_limited" // 429 (not documented by TravelDesk; handled defensively)
  | "server" // 5xx, or a 4xx whose body is a web-server 5xx error page (`serverErrorPage`)
  | "unexpected_status" // anything else
  | "timeout"
  | "network"
  | "invalid_response" // body not JSON, too large (`tooLarge` set), wrong shape, or wrong currency
  | "busy" // this instance's request queue is full; nothing was sent
  | "refused"; // the mutation gate or host check refused the call; nothing was sent

export class TravelDeskApiError extends Error {
  readonly kind: TravelDeskErrorKind;
  readonly status: number | null;
  readonly operation: string;
  /** Short, sanitised supplier reason (plain-text 400 or problem-details title). Never request data. */
  readonly reason?: string;
  /** 422 field names with messages, truncated. */
  readonly fieldErrors?: { fieldName: string; errorMessage: string }[];
  /** zod issue paths for `invalid_response`, so a contract drift is visible without the body. */
  readonly issues?: string[];
  readonly retryAfterSeconds?: number;
  /** Set on `invalid_response` when the body was over the size cap (declared or streamed). */
  readonly tooLarge?: true;
  /**
   * Set on `server` when a non-5xx answer carried a web server's own 5xx
   * error page (the 3 Nov 2026 TEST outage: HTTP 400 with a JSON-wrapped IIS
   * "HTTP Error 502.5 - Process Failure" page, doc 22 §32.22). TravelDesk's
   * application never answered such a request; `status` keeps the HTTP status.
   */
  readonly serverErrorPage?: true;
  /**
   * Set on `timeout` / `network` when the answer was a 2xx but its body could
   * not be read (review P3-4): TravelDesk processed the request, so this is
   * no outage signal, though the answer itself was lost.
   */
  readonly bodyLost?: true;

  constructor(
    kind: TravelDeskErrorKind,
    operation: string,
    opts: {
      status?: number | null;
      reason?: string;
      fieldErrors?: { fieldName: string; errorMessage: string }[];
      issues?: string[];
      retryAfterSeconds?: number;
      tooLarge?: true;
      serverErrorPage?: true;
      bodyLost?: true;
      message?: string;
    } = {},
  ) {
    super(opts.message ?? `TravelDesk ${operation} failed: ${kind}${opts.status ? ` (${opts.status})` : ""}`);
    this.name = "TravelDeskApiError";
    this.kind = kind;
    this.operation = operation;
    this.status = opts.status ?? null;
    this.reason = opts.reason;
    this.fieldErrors = opts.fieldErrors;
    this.issues = opts.issues;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    if (opts.tooLarge) this.tooLarge = true;
    if (opts.serverErrorPage) this.serverErrorPage = true;
    if (opts.bodyLost) this.bodyLost = true;
  }
}

export function isTravelDeskApiError(e: unknown): e is TravelDeskApiError {
  return e instanceof TravelDeskApiError;
}

/** One record per HTTP attempt. Safe to log as-is. */
export interface TravelDeskCallEvent {
  operation: string;
  method: "GET" | "POST";
  /** Path template, e.g. `/tours/{Id}`. Never the concrete path or query. */
  pathTemplate: string;
  environment: TravelDeskConfig["environment"];
  status: number | null;
  durationMs: number;
  outcome: "ok" | TravelDeskErrorKind;
  bytes: number | null;
  /** The response `Date` header as sent, for measuring supplier clock skew (SUP-21); null when absent or no response. */
  serverDate: string | null;
}

export type QueryValue = string | number | boolean | (string | number)[] | undefined;

export interface TravelDeskHttpOptions {
  fetch?: typeof fetch;
  now?: () => number;
  onEvent?: (event: TravelDeskCallEvent) => void;
  /** Default 16 MiB. The full tour catalogue is the largest documented response. */
  maxResponseBytes?: number;
  /** Concurrent requests from this instance. TravelDesk processes one agency's requests serially (HTML §Retries). */
  maxConcurrent?: number;
  /** Callers allowed to wait for a slot; more fail fast as `busy`. Default 20. */
  maxQueued?: number;
  /**
   * Longest wait for a slot before a POST, default 5 s (SUP-18). A POST that
   * cannot start in time fails as `busy` (nothing was sent), so the whole call
   * never outlives one mutation timeout plus this wait.
   */
  postQueueWaitMs?: number;
}

const MAX_REASON_CHARS = 200;

function truncate(s: string, n = MAX_REASON_CHARS): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > n ? `${clean.slice(0, n)}…` : clean;
}

/** Repeat keys for arrays (`?ToursIds=1&ToursIds=2`); comma lists are not supported (HTML §Conventions). */
export function buildQuery(query: Record<string, QueryValue> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v));
    else params.append(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** Base URL already ends in /public/b2b/v1; operation paths must not repeat it. */
export function joinUrl(baseUrl: string, path: string): string {
  if (!path.startsWith("/")) throw new Error("TravelDesk path must start with /");
  if (path.startsWith("/public/")) throw new Error("TravelDesk path must not repeat the /public/b2b/v1 prefix");
  return `${baseUrl}${path}`;
}

class QueueFull extends Error {}
class QueueWaitTimeout extends Error {}

class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(
    private readonly limit: number,
    private readonly maxQueued: number,
  ) {}
  /** Waiting counts against `waitMs`; a waiter that times out leaves the queue without taking a slot. */
  async run<T>(fn: () => Promise<T>, waitMs: number): Promise<T> {
    // A waiter receives the finishing caller's slot directly (`active` is not
    // lowered and raised again), so a new caller arriving in between cannot
    // slip past the limit.
    if (this.active >= this.limit) {
      if (this.queue.length >= this.maxQueued) throw new QueueFull();
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const i = this.queue.indexOf(wake);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new QueueWaitTimeout());
        }, waitMs);
        this.queue.push(wake);
      });
    } else this.active += 1;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array } | { tooLarge: true }> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return { tooLarge: true };
  }
  if (!res.body) return { bytes: new Uint8Array(await res.arrayBuffer()) };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: out };
}

function parseFieldErrors(body: unknown): { fieldName: string; errorMessage: string }[] | undefined {
  if (!Array.isArray(body)) return undefined;
  const out: { fieldName: string; errorMessage: string }[] = [];
  for (const item of body.slice(0, 20)) {
    if (item && typeof item === "object") {
      const fieldName = (item as Record<string, unknown>).fieldName;
      const errorMessage = (item as Record<string, unknown>).errorMessage;
      out.push({
        fieldName: typeof fieldName === "string" ? truncate(fieldName, 80) : "",
        errorMessage: typeof errorMessage === "string" ? truncate(errorMessage) : "",
      });
    }
  }
  return out;
}

/** An error answer is read at most this far for its reason, whatever the caller's cap. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** A fixed operation path: segments of letters, digits, `_` and `-`. No query, no dots, no scheme. */
const FIXED_PATH = /^(\/[A-Za-z0-9_-]+)+$/;

function kindForStatus(status: number): TravelDeskErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 400) return "bad_request";
  if (status === 415) return "unsupported_media";
  if (status === 422) return "validation";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "unexpected_status";
}

/**
 * A web server's own 5xx error page (IIS / ASP.NET Core Module: "HTTP Error
 * 502.5 - Process Failure", "Detailed Error - 503.0"), narrowly (review
 * P3-3): only a 400 or a 404, only when the body is an HTML document (as is,
 * or as a JSON-encoded string whose value starts with `<`), and only inside
 * its `<title>` or `<h1>`. So a 401/403/422, or a JSON answer that echoes
 * customer input such as a guest name, never matches. The whole body is
 * searched for those elements: the page's title sits past the 200-character
 * reason cap.
 */
const SERVER_ERROR_PAGE: readonly RegExp[] = [/HTTP Error 5\d\d(?:\.\d+)?\b/i, /Detailed Error\s*-\s*5\d\d(?:\.\d+)?\b/i];
const SERVER_ERROR_PAGE_STATUSES: ReadonlySet<number> = new Set([400, 404]);
const PAGE_HEADING = /<(title|h1)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;

export function isServerErrorPage(status: number, text: string): boolean {
  if (!SERVER_ERROR_PAGE_STATUSES.has(status)) return false;
  let html = text.trim();
  if (html.startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(html);
      if (typeof decoded !== "string") return false;
      html = decoded.trim();
    } catch {
      return false;
    }
  }
  if (!html.startsWith("<")) return false;
  for (const m of html.matchAll(PAGE_HEADING)) {
    if (SERVER_ERROR_PAGE.some((p) => p.test(m[2]))) return true;
  }
  return false;
}

/** A non-2xx answer as a classified error. Only a short reason is kept from the body. */
function errorForStatus(operation: string, res: Response, text: string): TravelDeskApiError {
  // A 400/404 carrying a web server's 5xx page was never answered by TravelDesk's application: a server failure, never a refusal.
  if (isServerErrorPage(res.status, text)) {
    return new TravelDeskApiError("server", operation, { status: res.status, serverErrorPage: true, message: `TravelDesk ${operation} failed: server error page (${res.status})` });
  }
  const kind = kindForStatus(res.status);
  let body: unknown = undefined;
  let isJson = false;
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
      isJson = true;
    } catch {
      isJson = false;
    }
  }
  let reason: string | undefined;
  if (isJson && body && typeof body === "object" && !Array.isArray(body)) {
    const title = (body as Record<string, unknown>).title;
    const detail = (body as Record<string, unknown>).detail;
    const pick = typeof detail === "string" && detail ? detail : typeof title === "string" ? title : undefined;
    reason = pick ? truncate(pick) : undefined;
  } else if (isJson && typeof body === "string") {
    // A JSON-encoded string: TravelDesk's cancel refusal arrives this way, as application/json (A5 drill CX-6, 3 Nov 2026).
    reason = body.trim() ? truncate(body) : undefined;
  } else if (!isJson && text.trim()) {
    reason = truncate(text);
  }
  const retryAfter = Number(res.headers.get("retry-after") ?? "");
  return new TravelDeskApiError(kind, operation, {
    status: res.status,
    reason,
    fieldErrors: kind === "validation" ? parseFieldErrors(body) : undefined,
    retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  });
}

function fetchFailureKind(e: unknown): TravelDeskErrorKind {
  const name = (e as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
}

export class TravelDeskHttp {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly onEvent?: (event: TravelDeskCallEvent) => void;
  private readonly maxBytes: number;
  private readonly semaphore: Semaphore;
  private readonly postQueueWaitMs: number;

  constructor(
    private readonly config: TravelDeskConfig,
    opts: TravelDeskHttpOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent;
    this.maxBytes = opts.maxResponseBytes ?? 16 * 1024 * 1024;
    this.semaphore = new Semaphore(Math.max(1, opts.maxConcurrent ?? 2), Math.max(0, opts.maxQueued ?? 20));
    this.postQueueWaitMs = Math.max(0, Math.min(opts.postQueueWaitMs ?? 5_000, config.mutationTimeoutMs));
  }

  get environment() {
    return this.config.environment;
  }

  /**
   * GET a JSON resource and validate it. `path` is the concrete path without
   * the prefix (e.g. `/tours/12`); `pathTemplate` is what gets logged.
   */
  async getJson<S extends z.ZodType>(
    operation: string,
    pathTemplate: string,
    path: string,
    query: Record<string, QueryValue> | undefined,
    schema: S,
  ): Promise<z.output<S>> {
    try {
      return await this.semaphore.run(() => this.doRequest("GET", operation, pathTemplate, path, query, undefined, schema), this.config.readTimeoutMs);
    } catch (e) {
      if (e instanceof QueueFull) throw new TravelDeskApiError("busy", operation, { message: `TravelDesk ${operation}: too many requests queued` });
      if (e instanceof QueueWaitTimeout) throw new TravelDeskApiError("timeout", operation, { message: `TravelDesk ${operation}: timed out waiting for a request slot` });
      throw e;
    }
  }

  /**
   * POST a JSON body (booking mutations). The mutation gate runs before
   * anything is built, so a production or disabled configuration never sends.
   */
  async postJson<S extends z.ZodType>(operation: string, pathTemplate: string, path: string, body: unknown, schema: S): Promise<z.output<S>> {
    try {
      assertTravelDeskMutationAllowed(this.config);
      // The gate keys on `environment`; the request goes to `baseUrl`. They must agree.
      if (this.config.baseUrl !== expectedBaseUrl(this.config.environment)) throw new Error("TravelDesk base URL does not match the configured environment");
    } catch (e) {
      throw new TravelDeskApiError("refused", operation, { message: e instanceof Error ? e.message : "TravelDesk mutation refused" });
    }
    try {
      return await this.semaphore.run(() => this.doRequest("POST", operation, pathTemplate, path, undefined, body, schema), this.postQueueWaitMs);
    } catch (e) {
      if (e instanceof QueueFull) throw new TravelDeskApiError("busy", operation, { message: `TravelDesk ${operation}: too many requests queued` });
      // Never sent: a POST that waited too long for a slot is `busy`, not an unknown outcome (SUP-18).
      if (e instanceof QueueWaitTimeout) throw new TravelDeskApiError("busy", operation, { message: `TravelDesk ${operation}: no request slot in time; not sent` });
      throw e;
    }
  }

  /**
   * GET a binary document (B4: the tickets PDF). Same rules as `getJson`:
   * the URL is the configured base plus `path`, which must be a fixed path
   * (no query, no dots, never a URL from a response); redirects are refused;
   * the read timeout covers the whole call. The body is never parsed. Over
   * `maxBytes` (declared `Content-Length`, or counted while streaming) it
   * fails as `invalid_response` with `tooLarge` set. The call event carries
   * the path template only.
   */
  async getBinary(
    operation: string,
    pathTemplate: string,
    path: string,
    opts: { maxBytes: number; accept: string },
  ): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    let url: string;
    try {
      if (!FIXED_PATH.test(path)) throw new Error("not a fixed operation path");
      url = joinUrl(this.config.baseUrl, path);
    } catch (e) {
      throw new TravelDeskApiError("refused", operation, { message: `TravelDesk ${operation}: ${e instanceof Error ? e.message : "path refused"}` });
    }
    if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes <= 0) throw new TravelDeskApiError("refused", operation, { message: `TravelDesk ${operation}: maxBytes must be a positive integer` });
    try {
      return await this.semaphore.run(() => this.doBinary(operation, pathTemplate, url, opts), this.config.readTimeoutMs);
    } catch (e) {
      if (e instanceof QueueFull) throw new TravelDeskApiError("busy", operation, { message: `TravelDesk ${operation}: too many requests queued` });
      if (e instanceof QueueWaitTimeout) throw new TravelDeskApiError("timeout", operation, { message: `TravelDesk ${operation}: timed out waiting for a request slot` });
      throw e;
    }
  }

  private async doBinary(
    operation: string,
    pathTemplate: string,
    url: string,
    opts: { maxBytes: number; accept: string },
  ): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const started = this.now();
    let status: number | null = null;
    let bytes: number | null = null;
    let serverDate: string | null = null;
    const emit = (outcome: TravelDeskCallEvent["outcome"]) => {
      const durationMs = this.now() - started;
      recordPhase("supplier", durationMs);
      this.onEvent?.({ operation, method: "GET", pathTemplate, environment: this.config.environment, status, durationMs, outcome, bytes, serverDate });
    };

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.config.apiKey}`, Accept: opts.accept },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(this.config.readTimeoutMs),
      });
    } catch (e) {
      const kind = fetchFailureKind(e);
      emit(kind);
      // `cause` is deliberately not attached: some fetch errors stringify the request.
      throw new TravelDeskApiError(kind, operation);
    }
    status = res.status;
    serverDate = res.headers.get("date");

    // A fetch that followed a redirect anyway (a non-conforming implementation) is refused, never read.
    if (res.redirected || res.type === "opaqueredirect") {
      await res.body?.cancel().catch(() => {});
      emit("unexpected_status");
      throw new TravelDeskApiError("unexpected_status", operation, { status, message: `TravelDesk ${operation}: redirect refused` });
    }

    let read: { bytes: Uint8Array } | { tooLarge: true };
    try {
      read = await readCapped(res, res.ok ? opts.maxBytes : Math.min(opts.maxBytes, MAX_ERROR_BODY_BYTES));
    } catch (e) {
      const kind = fetchFailureKind(e);
      emit(kind);
      // A 2xx whose body was lost: TravelDesk answered, so it is no outage (review P3-4); the outcome stays unknown.
      throw new TravelDeskApiError(kind, operation, { status, bodyLost: res.ok ? true : undefined });
    }

    if (!res.ok) {
      const err = errorForStatus(operation, res, "tooLarge" in read ? "" : new TextDecoder().decode(read.bytes));
      emit(err.kind);
      throw err;
    }
    if ("tooLarge" in read) {
      emit("invalid_response");
      throw new TravelDeskApiError("invalid_response", operation, { status, tooLarge: true, message: `TravelDesk ${operation}: response too large` });
    }
    bytes = read.bytes.byteLength;
    emit("ok");
    const contentType = res.headers.get("content-type");
    return { bytes: read.bytes, contentType: contentType ? contentType.slice(0, 200) : null };
  }

  private async doRequest<S extends z.ZodType>(
    method: "GET" | "POST",
    operation: string,
    pathTemplate: string,
    path: string,
    query: Record<string, QueryValue> | undefined,
    requestBody: unknown,
    schema: S,
  ): Promise<z.output<S>> {
    const url = joinUrl(this.config.baseUrl, path) + buildQuery(query);
    const started = this.now();
    let status: number | null = null;
    let bytes: number | null = null;
    let serverDate: string | null = null;
    const emit = (outcome: TravelDeskCallEvent["outcome"]) => {
      const durationMs = this.now() - started;
      recordPhase("supplier", durationMs);
      this.onEvent?.({
        operation,
        method,
        pathTemplate,
        environment: this.config.environment,
        status,
        durationMs,
        outcome,
        bytes,
        serverDate,
      });
    };

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers:
          method === "POST"
            ? { Authorization: `Bearer ${this.config.apiKey}`, Accept: "application/json", "Content-Type": "application/json" }
            : { Authorization: `Bearer ${this.config.apiKey}`, Accept: "application/json" },
        body: method === "POST" ? JSON.stringify(requestBody) : undefined,
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(method === "POST" ? this.config.mutationTimeoutMs : this.config.readTimeoutMs),
      });
    } catch (e) {
      const kind = fetchFailureKind(e);
      emit(kind);
      // `cause` is deliberately not attached: some fetch errors stringify the request.
      throw new TravelDeskApiError(kind, operation);
    }
    status = res.status;
    serverDate = res.headers.get("date");

    let read: { bytes: Uint8Array } | { tooLarge: true };
    try {
      read = await readCapped(res, this.maxBytes);
    } catch (e) {
      const kind = fetchFailureKind(e);
      emit(kind);
      // A 2xx whose body was lost: TravelDesk answered, so it is no outage (review P3-4); the outcome stays unknown.
      throw new TravelDeskApiError(kind, operation, { status, bodyLost: res.ok ? true : undefined });
    }
    if ("tooLarge" in read) {
      emit("invalid_response");
      throw new TravelDeskApiError("invalid_response", operation, { status, tooLarge: true, message: `TravelDesk ${operation}: response too large` });
    }
    bytes = read.bytes.byteLength;
    const text = new TextDecoder().decode(read.bytes);
    let body: unknown = undefined;
    let isJson = false;
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text);
        isJson = true;
      } catch {
        isJson = false;
      }
    }

    if (!res.ok) {
      const err = errorForStatus(operation, res, text);
      emit(err.kind);
      throw err;
    }

    if (!isJson) {
      emit("invalid_response");
      throw new TravelDeskApiError("invalid_response", operation, { status, message: `TravelDesk ${operation}: body is not JSON` });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      emit("invalid_response");
      const issues = parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`);
      throw new TravelDeskApiError("invalid_response", operation, { status, issues });
    }
    emit("ok");
    return parsed.data;
  }
}
