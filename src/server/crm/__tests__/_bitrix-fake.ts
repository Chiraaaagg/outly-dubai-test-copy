import type { FetchLike } from "@/server/crm/bitrix.client";
import { CRM_FIELD_KEYS } from "@/server/crm/crm.config";

/**
 * In-process fake Bitrix24 portal for the CRM tests (doc 29 §7.4 "a fake
 * Bitrix24 server"). It answers the five `crm.item.*` methods the client may
 * call (a list filters on `=id`, `=originatorId`, `=originId` and
 * `=categoryId`; custom fields are stored as sent), over the inbound-webhook
 * URL shape
 * `https://<host>/rest/<user>/<secret>/<method>.json`, with the documented
 * answer and error shapes, and refuses everything else. Synthetic data only;
 * nothing leaves the process.
 *
 * Failure controls:
 *  - `down`: every call fails at the network (an outage);
 *  - `script`: the next calls' scripted failures, in order:
 *      throttle503 (QUERY_LIMIT_EXCEEDED), throttle429 (OPERATION_TIME_LIMIT),
 *      server_error (500), reject (400 with a provider error), bad_shape
 *      (200 with an unexpected body), network (fails before the method
 *      runs), lose_answer (the method runs, then the answer is lost);
 *  - `revoked`: the webhook answers 401 INVALID_CREDENTIALS;
 *  - a leaky bucket per portal (2 requests a second, burst 50, the
 *    documented non-Enterprise limit): beyond it, 503 QUERY_LIMIT_EXCEEDED,
 *    counted in `bucketRefusals`;
 *  - `seedDeal` puts a record in place, e.g. a twin.
 *
 * Field names, stricter than the portal on purpose (review C2A-01): the real
 * `crm.item.add`/`update` expect camelCase custom field names unless the call
 * passes `useOriginalUfNames: "Y"`, and silently drop names they do not know.
 * The fake refuses instead (400 INVALID_ARG_VALUE), so a test sees it: a
 * `UF_CRM_…` key without the flag, any name that is not a standard deal field,
 * `assignedById` or one of the portal's configured custom fields (`ufCodes`,
 * default: the synthetic `UF_CRM_<KEY>` codes of `_memory-store.fieldCode`),
 * a Date/Time value that is not ISO 8601 with an offset and whole seconds,
 * and a Yes/No value other than `Y`/`N`.
 */

const STANDARD_FIELDS = new Set(["title", "categoryId", "stageId", "opportunity", "currencyId", "isManualOpportunity", "originatorId", "originId", "assignedById"]);
const DEFAULT_UF_CODES = CRM_FIELD_KEYS.map((k) => `UF_CRM_${k.toUpperCase()}`);
const BITRIX_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

export type FakeFailure = "throttle503" | "throttle429" | "server_error" | "reject" | "bad_shape" | "network" | "lose_answer";

export interface FakeDeal {
  /** OUTLYY custom fields (`UF_CRM_…`) and the responsible person land here as sent. */
  [field: string]: unknown;
  id: number;
  title: string;
  categoryId: number;
  stageId: string;
  opportunity: number;
  currencyId: string;
  isManualOpportunity: string;
  originatorId: string | null;
  originId: string | null;
  updatedBy: number;
  productRows: { productName: string; price: number; quantity: number }[];
}

export interface FakeCall {
  method: string;
  at: number;
  outcome: "ok" | FakeFailure | "down" | "unauthorized" | "bucket" | "error";
}

const ALLOWED = new Set(["crm.item.list", "crm.item.add", "crm.item.update", "crm.item.delete", "crm.item.productrow.set"]);

export class FakeBitrix24 {
  readonly deals = new Map<number, FakeDeal>();
  readonly calls: FakeCall[] = [];
  /** Methods asked for that the fake does not offer (a contact or lead call would land here). */
  readonly refusedMethods: string[] = [];
  down = false;
  revoked = false;
  script: FakeFailure[] = [];
  bucketRefusals = 0;
  private nextId = 101;
  private bucket = 0;
  private bucketAt = 0;

  private readonly ufCodes: Set<string>;

  constructor(private readonly opts: { host: string; userId: string; secret: string; now: () => number; ufCodes?: string[] }) {
    this.ufCodes = new Set(opts.ufCodes ?? DEFAULT_UF_CODES);
  }

  /** Why a write's fields would not land on the portal as sent, or null. */
  private fieldProblem(p: Record<string, unknown>): string | null {
    const fields = (p.fields ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(fields)) {
      if (STANDARD_FIELDS.has(k)) continue;
      if (!this.ufCodes.has(k)) return `unknown field ${/^[A-Za-z0-9_]{1,60}$/.test(k) ? k : "?"}`;
      if (p.useOriginalUfNames !== "Y") return `${k} needs useOriginalUfNames=Y`;
      if ((k.endsWith("_AT") || k.endsWith("_AS_OF")) && v !== "" && !(typeof v === "string" && BITRIX_DATETIME.test(v))) return `${k} is not a Bitrix24 date-time`;
      if (k.includes("_CONSENT_") && !k.endsWith("_AT") && v !== "Y" && v !== "N") return `${k} is not Y or N`;
    }
    return null;
  }

  seedDeal(d: Partial<FakeDeal> & Pick<FakeDeal, "originId">): FakeDeal {
    const deal: FakeDeal = {
      id: this.nextId++,
      title: "seeded",
      categoryId: 7,
      stageId: "C7:NEW_INQUIRY",
      opportunity: 0,
      currencyId: "AED",
      isManualOpportunity: "Y",
      originatorId: "outlyy-staging",
      updatedBy: Number(this.opts.userId),
      productRows: [],
      ...d,
    };
    this.deals.set(deal.id, deal);
    return deal;
  }

  dealsFor(originId: string): FakeDeal[] {
    return [...this.deals.values()].filter((d) => d.originId === originId).sort((a, b) => a.id - b.id);
  }

  callsOf(method: string): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    // Any other host does not resolve.
    if (u.hostname !== this.opts.host || u.protocol !== "https:") throw new TypeError("fetch failed");
    const m = /^\/rest\/([^/]+)\/([^/]+)\/([a-z.]+)\.json$/.exec(u.pathname);
    const method = m?.[3] ?? "unknown";
    const at = this.opts.now();
    if (this.down) {
      this.calls.push({ method, at, outcome: "down" });
      throw new TypeError("fetch failed");
    }
    if (!this.takeBucket(at)) {
      this.bucketRefusals += 1;
      this.calls.push({ method, at, outcome: "bucket" });
      return reply(503, { error: "QUERY_LIMIT_EXCEEDED", error_description: "Too many requests" });
    }
    if (!m || this.revoked || m[1] !== this.opts.userId || decodeURIComponent(m[2]) !== this.opts.secret) {
      this.calls.push({ method, at, outcome: "unauthorized" });
      return reply(401, { error: "INVALID_CREDENTIALS", error_description: "Invalid request credentials" });
    }
    if (!ALLOWED.has(method)) {
      this.refusedMethods.push(method);
      this.calls.push({ method, at, outcome: "error" });
      return reply(404, { error: "ERROR_METHOD_NOT_FOUND", error_description: "Method not found!" });
    }
    const failure = this.script.shift();
    if (failure) {
      this.calls.push({ method, at, outcome: failure });
      switch (failure) {
        case "throttle503":
          return reply(503, { error: "QUERY_LIMIT_EXCEEDED", error_description: "Too many requests" });
        case "throttle429":
          return reply(429, { error: "OPERATION_TIME_LIMIT", error_description: "Method is blocked due to operation time limit." });
        case "server_error":
          return reply(500, { error: "INTERNAL_SERVER_ERROR", error_description: "Internal server error" });
        case "reject":
          return reply(400, { error: "INVALID_ARG_VALUE", error_description: "Invalid value" });
        case "bad_shape":
          return reply(200, { result: { unexpected: true } });
        case "network":
          throw new TypeError("fetch failed");
        case "lose_answer":
          this.handle(method, JSON.parse(String(init.body ?? "{}")));
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
    }
    const res = this.handle(method, JSON.parse(String(init.body ?? "{}")));
    this.calls.push({ method, at, outcome: res.status < 400 ? "ok" : "error" });
    return reply(res.status, res.body);
  };

  /** Leaky bucket: drains 2 a second, holds 50. */
  private takeBucket(at: number): boolean {
    this.bucket = Math.max(0, this.bucket - ((at - this.bucketAt) / 1000) * 2);
    this.bucketAt = at;
    if (this.bucket + 1 > 50) return false;
    this.bucket += 1;
    return true;
  }

  private handle(method: string, p: Record<string, unknown>): { status: number; body: unknown } {
    const notFound = { status: 400, body: { error: "NOT_FOUND", error_description: "Element not found" } };
    if (method !== "crm.item.productrow.set" && p.entityTypeId !== 2) return { status: 400, body: { error: "INVALID_ARG_VALUE", error_description: "entityTypeId" } };
    switch (method) {
      case "crm.item.list": {
        const f = (p.filter ?? {}) as Record<string, unknown>;
        const items = [...this.deals.values()]
          .filter(
            (d) =>
              (f["=id"] === undefined || d.id === Number(f["=id"])) &&
              (f["=originatorId"] === undefined || d.originatorId === f["=originatorId"]) &&
              (f["=originId"] === undefined || d.originId === f["=originId"]) &&
              (f["=categoryId"] === undefined || d.categoryId === f["=categoryId"]),
          )
          .sort((a, b) => a.id - b.id)
          .map((d) => {
            const base = { id: d.id, originatorId: d.originatorId, originId: d.originId, categoryId: d.categoryId, updatedBy: d.updatedBy };
            // Custom fields come back only when selected, and under their original codes only with the flag.
            const uf = ((p.select ?? []) as string[]).filter((k) => this.ufCodes.has(k) && p.useOriginalUfNames === "Y");
            return { ...base, ...Object.fromEntries(uf.map((k) => [k, d[k] ?? null])) };
          });
        return { status: 200, body: { result: { items }, total: items.length, time: { start: 0, finish: 0 } } };
      }
      case "crm.item.add": {
        const problem = this.fieldProblem(p);
        if (problem) return { status: 400, body: { error: "INVALID_ARG_VALUE", error_description: problem } };
        const fields = p.fields as Record<string, unknown>;
        const deal = { ...fields, id: this.nextId++, updatedBy: Number(this.opts.userId), productRows: [] } as unknown as FakeDeal;
        this.deals.set(deal.id, deal);
        return { status: 200, body: { result: { item: { id: deal.id, title: deal.title, stageId: deal.stageId } } } };
      }
      case "crm.item.update": {
        const problem = this.fieldProblem(p);
        if (problem) return { status: 400, body: { error: "INVALID_ARG_VALUE", error_description: problem } };
        const d = this.deals.get(Number(p.id));
        if (!d) return notFound;
        Object.assign(d, p.fields, { updatedBy: Number(this.opts.userId) });
        return { status: 200, body: { result: { item: { id: d.id, title: d.title, stageId: d.stageId } } } };
      }
      case "crm.item.delete": {
        if (!this.deals.delete(Number(p.id))) return notFound;
        return { status: 200, body: { result: [] } };
      }
      case "crm.item.productrow.set": {
        if (p.ownerType !== "D") return { status: 400, body: { error: "INVALID_ARG_VALUE", error_description: "ownerType" } };
        const d = this.deals.get(Number(p.ownerId));
        if (!d) return notFound;
        d.productRows = (p.productRows as FakeDeal["productRows"]).map((r) => ({ ...r }));
        return { status: 200, body: { result: { productRows: d.productRows.map((r, i) => ({ id: i + 1, ...r })) } } };
      }
      default:
        return { status: 404, body: { error: "ERROR_METHOD_NOT_FOUND" } };
    }
  }
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
