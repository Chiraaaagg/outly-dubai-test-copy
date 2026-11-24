import type { FetchLike } from "@/server/crm/bitrix.client";
import { CRM_FIELD_KEYS, CRM_STAGE_KEYS } from "@/server/crm/crm.config";

/**
 * In-process fake Bitrix24 portal for the CRM tests (doc 29 §7.4 "a fake
 * Bitrix24 server"). It answers the five `crm.item.*` methods the client may
 * call (a list filters on `=id`, `=originatorId`, `=originId` and
 * `=categoryId`; custom fields are stored as sent) and
 * `crm.timeline.comment.add` (C2b: `fields` with exactly ENTITY_ID,
 * ENTITY_TYPE "deal" and a non-empty COMMENT, on a deal that exists; the
 * comments are kept per deal in `comments`), over the inbound-webhook
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
 *      runs), lose_answer (the method runs, then the answer is lost),
 *      phantom_not_found (a not-found answer although nothing changed and
 *      the record is still there), access_denied (403 ACCESS_DENIED on that
 *      call only, as for a record the service account may not see);
 *  - delete and not-found answer shapes (gap G14; the real portal's were not
 *    seen yet): `deleteAnswer` (default `true`, the documented
 *    `{"result": true}`; `empty_array` was C1's assumption) and
 *    `notFoundShape` (default `code`: 400 NOT_FOUND; `empty_code_text`,
 *    `core_text`, `core_text_ru` and `http404` are the other variants);
 *  - `methodScript`: the same failures, each for the next call of one method;
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
 *
 * Return path (C3ab, doc 29e §13.1), strict like the rest:
 *  - every deal carries `updatedTime`, `updatedBy`, `movedTime`, `movedBy`
 *    and `assignedById`, stamped from the fake clock and the acting user;
 *    a write by the webhook stamps the service user, a staff action
 *    (`actAs(userId)`) stamps that user. Times come back as ISO 8601 with a
 *    +03:00 offset and whole seconds, as a portal in another zone would;
 *  - `crm.item.list` also filters `>=updatedTime` and `>id`, orders by
 *    `updatedTime` and `id`, pages at 50 from `start` with `next`, and
 *    returns only the standard fields that were selected (plus the tags);
 *  - `profile` (ID, ADMIN and a NAME the client must drop; `admin` switches
 *    the flag), `crm.category.get` (`categories`), `crm.status.list`
 *    (`stages`, the 12 configured stages with their SEMANTICS by default);
 *  - staff actions: move a stage, edit a field, reassign, move to another
 *    funnel, delete to the recycle bin and restore, copy a deal (a twin),
 *    add a deal by hand; `addStage` adds a thirteenth stage;
 *  - fault modes: `ignoreTimeFilter`, `omitMovedBy`, `listLagMs` (a change
 *    shows in the list only that much later), `stringNumbers` (numbers come
 *    back as strings, the portal's own format).
 */

const STANDARD_FIELDS = new Set(["title", "categoryId", "stageId", "opportunity", "currencyId", "isManualOpportunity", "originatorId", "originId", "assignedById"]);
const DEFAULT_UF_CODES = CRM_FIELD_KEYS.map((k) => `UF_CRM_${k.toUpperCase()}`);
const BITRIX_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

export type FakeFailure = "throttle503" | "throttle429" | "server_error" | "reject" | "bad_shape" | "network" | "lose_answer" | "phantom_not_found" | "access_denied";
export type FakeDeleteAnswer = "true" | "empty_array" | "empty_object" | "null" | "false" | "object" | "string";
export type FakeNotFoundShape = "code" | "empty_code_text" | "core_text" | "core_text_ru" | "http404";

export interface FakeComment {
  id: number;
  dealId: number;
  text: string;
  at: number;
}

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
  /** Return path stamps (C3ab), ms on the fake clock. */
  updatedTime?: number;
  movedBy?: number;
  movedTime?: number;
  assignedById?: number;
}

export interface FakeStage {
  STATUS_ID: string;
  ENTITY_ID: string;
  NAME: string;
  SEMANTICS?: string | null;
  EXTRA?: { SEMANTICS?: string | null; COLOR?: string };
}

const STAGE_SEMANTICS: Record<string, string | null> = { fulfilled: "S", lost: "F", spam: "F", cancelled: "F", refunded: "F" };

/** `2026-11-22T11:00:00+03:00`: the instant in +03:00 with whole seconds. */
export function portalTimeOf(ms: number): string {
  const d = new Date(Math.floor(ms / 1000) * 1000 + 3 * 3_600_000);
  return `${d.toISOString().slice(0, 19)}+03:00`;
}

export interface FakeCall {
  method: string;
  at: number;
  outcome: "ok" | FakeFailure | "down" | "unauthorized" | "bucket" | "error";
}

const ALLOWED = new Set(["crm.item.list", "crm.item.add", "crm.item.update", "crm.item.delete", "crm.item.productrow.set", "crm.timeline.comment.add", "profile", "crm.category.get", "crm.status.list"]);
const SELECTABLE = new Set(["stageId", "assignedById", "updatedTime", "movedBy", "movedTime", "title", "opportunity", "currencyId", "createdTime"]);

const DELETE_ANSWERS: Record<FakeDeleteAnswer, unknown> = {
  true: true,
  empty_array: [],
  empty_object: {},
  null: null,
  false: false,
  object: { item: { id: 1 } },
  string: "ok",
};

export class FakeBitrix24 {
  readonly deals = new Map<number, FakeDeal>();
  readonly comments: FakeComment[] = [];
  deleteAnswer: FakeDeleteAnswer = "true";
  notFoundShape: FakeNotFoundShape = "code";
  private nextCommentId = 9001;
  readonly calls: FakeCall[] = [];
  /** Methods asked for that the fake does not offer (a contact or lead call would land here). */
  readonly refusedMethods: string[] = [];
  down = false;
  revoked = false;
  script: FakeFailure[] = [];
  /** Scripted failures for one method only, taken before `script` when that method is called. */
  methodScript: { method: string; failure: FakeFailure }[] = [];
  bucketRefusals = 0;
  private nextId = 101;
  private bucket = 0;
  private bucketAt = 0;

  private readonly ufCodes: Set<string>;
  /** Return path (C3ab). */
  admin = false;
  /** `profile` answers this user id instead of the webhook's own (a different service account). */
  profileId: string | null = null;
  ignoreTimeFilter = false;
  omitMovedBy = false;
  listLagMs = 0;
  stringNumbers = false;
  readonly categories = new Map<number, { id: number; name: string; entityTypeId: number }>([[7, { id: 7, name: "OUTLYY", entityTypeId: 2 }]]);
  stages: FakeStage[] = CRM_STAGE_KEYS.map((k) => ({ STATUS_ID: `C7:${k.toUpperCase()}`, ENTITY_ID: "DEAL_STAGE_7", NAME: k, SEMANTICS: STAGE_SEMANTICS[k] ?? null }));
  /** Deleted deals, restorable (the portal's recycle bin). */
  readonly recycle = new Map<number, FakeDeal>();

  constructor(private readonly opts: { host: string; userId: string; secret: string; now: () => number; ufCodes?: string[] }) {
    this.ufCodes = new Set(opts.ufCodes ?? DEFAULT_UF_CODES);
  }

  /** What a staff member does on the portal, stamped as that user at the fake clock's time. */
  actAs(userId: number) {
    const touch = (d: FakeDeal) => Object.assign(d, { updatedBy: userId, updatedTime: this.opts.now() });
    const deal = (id: number) => {
      const d = this.deals.get(id);
      if (!d) throw new Error(`fake: no deal ${id}`);
      return d;
    };
    return {
      moveStage: (id: number, stageId: string) => touch(Object.assign(deal(id), { stageId, movedBy: userId, movedTime: this.opts.now() })),
      editField: (id: number, field: string, value: unknown) => touch(Object.assign(deal(id), { [field]: value })),
      reassign: (id: number, owner: number) => touch(Object.assign(deal(id), { assignedById: owner })),
      moveToFunnel: (id: number, categoryId: number) => touch(Object.assign(deal(id), { categoryId })),
      delete: (id: number) => {
        this.recycle.set(id, deal(id));
        this.deals.delete(id);
      },
      restore: (id: number) => {
        const d = this.recycle.get(id);
        if (!d) throw new Error(`fake: no deal ${id} in the recycle bin`);
        this.recycle.delete(id);
        this.deals.set(id, touch(d));
      },
      /** An administrator's "copy deal": the same fields and tags, a new id (a twin). */
      copy: (id: number) => {
        const copy = { ...structuredClone(deal(id)), id: this.nextId++ };
        this.deals.set(copy.id, touch(copy));
        return copy;
      },
      addByHand: (fields: Partial<FakeDeal> = {}) =>
        this.seedDeal({ originatorId: null, originId: null, title: "Hand made", ...fields, updatedBy: userId, updatedTime: this.opts.now() }),
    };
  }

  addStage(statusId: string, semantics: string | null = null) {
    this.stages.push({ STATUS_ID: statusId, ENTITY_ID: "DEAL_STAGE_7", NAME: "extra", SEMANTICS: semantics });
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
      updatedTime: this.opts.now(),
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
    const targeted = this.methodScript.findIndex((x) => x.method === method);
    const failure = targeted >= 0 ? this.methodScript.splice(targeted, 1)[0].failure : this.script.shift();
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
        case "access_denied":
          return reply(403, { error: "ACCESS_DENIED", error_description: "Access denied" });
        case "phantom_not_found": {
          const nf = this.notFound();
          return reply(nf.status, nf.body);
        }
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

  private notFound(): { status: number; body: unknown } {
    switch (this.notFoundShape) {
      case "code":
        return { status: 400, body: { error: "NOT_FOUND", error_description: "Element not found" } };
      case "empty_code_text":
        return { status: 400, body: { error: "", error_description: "Not found" } };
      case "core_text":
        return { status: 400, body: { error: "ERROR_CORE", error_description: "Element with this ID was not found" } };
      case "core_text_ru":
        return { status: 400, body: { error: "ERROR_CORE", error_description: "\u042d\u043b\u0435\u043c\u0435\u043d\u0442 \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d" } };
      case "http404":
        return { status: 404, body: { error: "NOT_FOUND", error_description: "Not found" } };
    }
  }

  commentsOn(dealId: number): FakeComment[] {
    return this.comments.filter((c) => c.dealId === dealId);
  }

  private num(v: number | undefined | null): number | string | null {
    if (v === undefined || v === null) return null;
    return this.stringNumbers ? String(v) : v;
  }

  private listItem(d: FakeDeal, p: Record<string, unknown>): Record<string, unknown> {
    const select = (p.select ?? []) as string[];
    const base: Record<string, unknown> = { id: d.id, originatorId: d.originatorId, originId: d.originId, categoryId: d.categoryId, updatedBy: d.updatedBy };
    for (const k of select.filter((x) => SELECTABLE.has(x))) {
      if (k === "updatedTime") base.updatedTime = d.updatedTime === undefined ? null : portalTimeOf(d.updatedTime);
      else if (k === "movedTime") base.movedTime = this.omitMovedBy ? undefined : d.movedTime === undefined ? null : portalTimeOf(d.movedTime);
      else if (k === "movedBy") base.movedBy = this.omitMovedBy ? undefined : this.num(d.movedBy);
      else if (k === "assignedById") base.assignedById = this.num(d.assignedById);
      else if (k === "opportunity") base.opportunity = this.num(d.opportunity);
      else if (k === "createdTime") base.createdTime = portalTimeOf(0);
      else base[k] = d[k] ?? null;
    }
    if (this.stringNumbers) base.updatedBy = String(d.updatedBy);
    for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
    // Custom fields come back only when selected, and under their original codes only with the flag.
    const uf = select.filter((k) => this.ufCodes.has(k) && p.useOriginalUfNames === "Y");
    return { ...base, ...Object.fromEntries(uf.map((k) => [k, typeof d[k] === "number" && this.stringNumbers ? String(d[k]) : (d[k] ?? null)])) };
  }

  private handle(method: string, p: Record<string, unknown>): { status: number; body: unknown } {
    const notFound = this.notFound();
    if (method === "profile") {
      if (Object.keys(p).length) return { status: 400, body: { error: "INVALID_ARG_VALUE", error_description: "profile takes no parameters" } };
      return { status: 200, body: { result: { ID: this.profileId ?? this.opts.userId, ADMIN: this.admin, NAME: "Sync", LAST_NAME: "Service", PERSONAL_GENDER: "" } } };
    }
    if (method === "crm.category.get") {
      if (p.entityTypeId !== 2) return { status: 400, body: { error: "INVALID_ARG_VALUE", error_description: "entityTypeId" } };
      const c = this.categories.get(Number(p.id));
      if (!c) return notFound;
      return { status: 200, body: { result: { category: { ...c, sort: 500, isDefault: "N" } } } };
    }
    if (method === "crm.status.list") {
      const f = (p.filter ?? {}) as Record<string, unknown>;
      if (Object.keys(f).join(",") !== "ENTITY_ID") return { status: 400, body: { error: "INVALID_ARG_VALUE", error_description: "filter" } };
      const items = this.stages.filter((s) => s.ENTITY_ID === f.ENTITY_ID).map((s) => ({ ID: 1, SORT: 10, SYSTEM: "N", ...s }));
      return { status: 200, body: { result: items, total: items.length } };
    }
    if (method === "crm.timeline.comment.add") {
      const f = (p.fields ?? {}) as Record<string, unknown>;
      if (Object.keys(p).join(",") !== "fields" || Object.keys(f).sort().join(",") !== "COMMENT,ENTITY_ID,ENTITY_TYPE") return { status: 400, body: { error: "INVALID_ARG_VALUE", error_description: "fields" } };
      if (f.ENTITY_TYPE !== "deal" || typeof f.COMMENT !== "string" || !f.COMMENT.trim()) return { status: 400, body: { error: "INVALID_ARG_VALUE", error_description: "ENTITY_TYPE or COMMENT" } };
      const deal = this.deals.get(Number(f.ENTITY_ID));
      if (!deal) return notFound;
      const c = { id: this.nextCommentId++, dealId: deal.id, text: f.COMMENT, at: this.opts.now() };
      this.comments.push(c);
      return { status: 200, body: { result: c.id } };
    }
    if (method !== "crm.item.productrow.set" && p.entityTypeId !== 2) return { status: 400, body: { error: "INVALID_ARG_VALUE", error_description: "entityTypeId" } };
    switch (method) {
      case "crm.item.list": {
        const f = (p.filter ?? {}) as Record<string, unknown>;
        const known = new Set(["=id", "=originatorId", "=originId", "=categoryId", ">=updatedTime", ">id"]);
        if (Object.keys(f).some((k) => !known.has(k))) return { status: 400, body: { error: "INVALID_ARG_VALUE", error_description: "filter" } };
        const since = f[">=updatedTime"] === undefined ? null : Date.parse(String(f[">=updatedTime"]));
        if (since !== null && !Number.isFinite(since)) return { status: 400, body: { error: "INVALID_ARG_VALUE", error_description: "updatedTime" } };
        const now = this.opts.now();
        const order = (p.order ?? { id: "ASC" }) as Record<string, string>;
        const byTime = "updatedTime" in order;
        const all = [...this.deals.values()]
          .filter(
            (d) =>
              (f["=id"] === undefined || d.id === Number(f["=id"])) &&
              (f["=originatorId"] === undefined || d.originatorId === f["=originatorId"]) &&
              (f["=originId"] === undefined || d.originId === f["=originId"]) &&
              (f["=categoryId"] === undefined || d.categoryId === f["=categoryId"]) &&
              (f[">id"] === undefined || d.id > Number(f[">id"])) &&
              (since === null || this.ignoreTimeFilter || Math.floor((d.updatedTime ?? 0) / 1000) * 1000 >= since) &&
              (!this.listLagMs || (d.updatedTime ?? 0) <= now - this.listLagMs),
          )
          .sort((a, b) => (byTime ? (a.updatedTime ?? 0) - (b.updatedTime ?? 0) : 0) || a.id - b.id);
        const start = Number(p.start ?? 0);
        const page = all.slice(start, start + 50);
        const items = page.map((d) => this.listItem(d, p));
        const more = start + 50 < all.length;
        return { status: 200, body: { result: { items }, total: all.length, ...(more ? { next: start + 50 } : {}), time: { start: 0, finish: 0 } } };
      }
      case "crm.item.add": {
        const problem = this.fieldProblem(p);
        if (problem) return { status: 400, body: { error: "INVALID_ARG_VALUE", error_description: problem } };
        const fields = p.fields as Record<string, unknown>;
        const now = this.opts.now();
        const deal = { ...fields, id: this.nextId++, updatedBy: Number(this.opts.userId), updatedTime: now, movedBy: Number(this.opts.userId), movedTime: now, productRows: [] } as unknown as FakeDeal;
        this.deals.set(deal.id, deal);
        return { status: 200, body: { result: { item: { id: deal.id, title: deal.title, stageId: deal.stageId } } } };
      }
      case "crm.item.update": {
        const problem = this.fieldProblem(p);
        if (problem) return { status: 400, body: { error: "INVALID_ARG_VALUE", error_description: problem } };
        const d = this.deals.get(Number(p.id));
        if (!d) return notFound;
        const moved = (p.fields as Record<string, unknown>).stageId !== undefined && (p.fields as Record<string, unknown>).stageId !== d.stageId;
        Object.assign(d, p.fields, { updatedBy: Number(this.opts.userId), updatedTime: this.opts.now() }, moved ? { movedBy: Number(this.opts.userId), movedTime: this.opts.now() } : {});
        return { status: 200, body: { result: { item: { id: d.id, title: d.title, stageId: d.stageId } } } };
      }
      case "crm.item.delete": {
        const gone = this.deals.get(Number(p.id));
        if (!gone || !this.deals.delete(Number(p.id))) return notFound;
        this.recycle.set(gone.id, gone);
        // Comments go with their deal.
        for (let i = this.comments.length - 1; i >= 0; i--) if (this.comments[i].dealId === Number(p.id)) this.comments.splice(i, 1);
        return { status: 200, body: { result: DELETE_ANSWERS[this.deleteAnswer] } };
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
