import { z } from "zod";
import type { CrmConfig } from "./crm.config";

/**
 * Thin Bitrix24 REST adapter for the CRM push (doc 29 §5.2, §6.4, §6.5).
 *
 *  - One port (`CrmPort`) with the operations the push needs, all on deals in
 *    the `crm.item.*` API with entityTypeId 2 (`crm.deal.*` is frozen).
 *  - A method allowlist (`BITRIX_METHODS`): no contact, lead, duplicate,
 *    task, user or batch method can be called (decision C2-4: customer
 *    name, phone and email live on the deal only, never in a Contact
 *    record). The one timeline method is `crm.timeline.comment.add`, for
 *    the fixed-text deal comments of crm.timeline.ts (decision C2-11, C2b).
 *  - Outbound host allowlist: every request goes to
 *    `https://<pinned host>/rest/<user>/<secret>/<method>.json` and the URL
 *    is re-checked before the call; redirects are refused. The webhook
 *    secret comes only from the config (env) and is never logged, returned
 *    or put in an error.
 *  - Custom fields are sent under their original codes (`UF_CRM_…`, as the
 *    portal's field list shows them): `crm.item.add` and `crm.item.update`
 *    pass `useOriginalUfNames: "Y"`. Without it `crm.item.*` expects the
 *    camelCase names (`ufCrm…`) and ignores the others without an error
 *    (review C2A-01). The synthetic probe (crm.probe.ts) reads every field
 *    back before any personal data is pushed.
 *  - Every answer is validated with Zod; anything else is `invalid_response`.
 *  - Errors are classified into a short kind and code; a provider message
 *    (`error_description`) is never kept. It is only matched, in memory, for
 *    a "not found" wording (gap G14: the real portal's not-found answer was
 *    not seen yet), and the worker re-reads the deal before it believes a
 *    not-found (crm.worker.ts), so a misread wording never tombstones a deal.
 *  - `crm.item.delete` counts as done only for the documented success
 *    shapes (`result` true, or an empty array or object). Any other shape is
 *    `invalid_response` with a code that names the shape (never its value):
 *    retried, dead-lettered and alerted, never treated as deleted (G14).
 *  - Bitrix24 has no request signing and no idempotency key for record
 *    creation, so none is invented: a lost create answer is resolved by the
 *    worker searching `originId` before every create.
 *  - Return path reads (C3ab, doc 29e; `CrmReturnPort`): the funnel's deals
 *    changed since a time, the funnel listed by id for the nightly sweep,
 *    and the three fingerprint reads (`profile`, `crm.category.get`,
 *    `crm.status.list`). All are reads in the `crm` scope plus the basic
 *    `profile` method; every list is filtered to the OUTLYY funnel and the
 *    answer is checked again here. `profile` keeps only the user id and the
 *    administrator flag: the account's name is dropped by the schema and is
 *    never logged or stored. Deal values read back (customer fields, title)
 *    are compared in memory by the reconciler and never logged.
 */

export const BITRIX_METHODS = [
  "crm.item.list",
  "crm.item.add",
  "crm.item.update",
  "crm.item.delete",
  "crm.item.productrow.set",
  "crm.timeline.comment.add",
  // C3ab reads (doc 29e §7, the portal fingerprint): no new scope.
  "profile",
  "crm.category.get",
  "crm.status.list",
] as const;
export type BitrixMethod = (typeof BITRIX_METHODS)[number];
const WRITE_METHODS: ReadonlySet<string> = new Set(["crm.item.add", "crm.item.update", "crm.item.delete", "crm.item.productrow.set", "crm.timeline.comment.add"]);

/** Bitrix24 entityTypeId of a deal. */
export const DEAL_ENTITY_TYPE_ID = 2;

/** A value of an OUTLYY custom field: text, a number, or "" to clear it. */
export type CrmFieldValue = string | number;

/**
 * The deal fields OUTLYY writes: eight standard fields, the configured
 * OUTLYY custom fields (`UF_CRM_…`, C2a), and on create only the
 * responsible person. Nothing else is ever sent (assertSafeCrmPayload).
 */
export type DealFields = {
  title: string;
  categoryId: number;
  stageId: string;
  opportunity: number;
  currencyId: string;
  isManualOpportunity: "Y";
  originatorId: string;
  originId: string;
  /** Create only (decision C2-8). */
  assignedById?: number;
} & { [code: `UF_CRM_${string}`]: CrmFieldValue };

export interface ProductRow {
  productName: string;
  price: number;
  quantity: number;
}

export interface DealRef {
  id: number;
  originatorId: string | null;
  originId: string | null;
  categoryId: number | null;
  /** Bitrix24 user who last changed the record; the return path (C3) skips the integration user's own changes. */
  updatedBy: number | null;
}

/**
 * A deal as the return path reads it (C3ab). Customer fields come back here because they are OUTLYY fields on
 * the deal: compared in memory and dropped, never logged, stored or put in an alert (doc 29e §12).
 */
export interface DealSnapshot {
  id: number;
  categoryId: number | null;
  stageId: string | null;
  assignedById: number | null;
  updatedBy: number | null;
  /** As the portal returned it (ISO 8601 with an offset); the poll cursor is always a portal time. */
  updatedTime: string | null;
  /** Null when the portal does not return it (doc 29e §14 fact 2): the mover is then `updatedBy`. */
  movedBy: number | null;
  movedTime: string | null;
  originatorId: string | null;
  originId: string | null;
  title: string | null;
  opportunity: unknown;
  currencyId: string | null;
  /** The configured OUTLYY custom fields by code, as returned. */
  uf: Record<string, unknown>;
}

/** A deal as the nightly sweep lists it: ids and the OUTLYY tags only, no personal data. */
export interface FunnelDealRef {
  id: number;
  originatorId: string | null;
  originId: string | null;
}

export type CrmStageKind = "process" | "success" | "failure" | "unknown";

/** The return path reads (C3ab, doc 29e §3.2, §7, §8). Reads only. */
export interface CrmReturnPort {
  /**
   * Deals of the OUTLYY funnel, 50 a page: `since`: `updatedTime` at or after it, oldest change first; `at` and
   * `afterId`: `updatedTime` exactly `at` and an id above `afterId`, by id (drains one busy second).
   */
  listChangedDeals(opts: { since: Date } | { at: Date; afterId: number }): Promise<{ items: DealSnapshot[]; more: boolean }>;
  /** These deals of the OUTLYY funnel (at most 50 ids), as the poll reads them; missing ones are not visible. */
  readDeals(ids: number[]): Promise<DealSnapshot[]>;
  /** Deals of the OUTLYY funnel with an id above `afterId`, by id, 50 a page. */
  listFunnelDeals(afterId: number): Promise<{ items: FunnelDealRef[]; more: boolean }>;
  /** The webhook's own user: its id and whether it is a portal administrator. Nothing else is kept. */
  readProfile(): Promise<{ userId: number; admin: boolean }>;
  /** The configured deal funnel, or null when the portal has no such funnel. */
  readCategory(): Promise<{ id: number; name: string; entityTypeId: number } | null>;
  /** The configured funnel's stages with their kind. */
  listStages(): Promise<{ statusId: string; kind: CrmStageKind }[]>;
}

/** Page size of every list read (the portal's own page). */
export const BITRIX_PAGE = 50;

export interface CrmPort {
  /** Deals of this funnel with exactly this originator and origin id, oldest first. */
  findDealsByOrigin(originatorId: string, originId: string): Promise<DealRef[]>;
  /** The deal with this id in the OUTLYY funnel, or null (another funnel, or gone). */
  findDealById(id: number): Promise<DealRef | null>;
  addDeal(fields: DealFields): Promise<{ id: number }>;
  updateDeal(id: number, fields: DealFields): Promise<void>;
  setProductRows(dealId: number, rows: ProductRow[]): Promise<void>;
  /** `not_found` when the portal says the deal is gone (the worker re-reads before it believes it). */
  deleteDeal(id: number): Promise<"deleted" | "not_found">;
  /** One fixed-text comment on the deal's timeline (crm.timeline.ts); the new comment's id. */
  addTimelineComment(dealId: number, text: string): Promise<{ id: number }>;
}

/**
 * - throttled: QUERY_LIMIT_EXCEEDED (503) or OPERATION_TIME_LIMIT (429): stop the run, back off.
 * - unavailable: network failure, timeout or a 5xx; a write may have happened.
 * - auth: revoked or wrong credential, missing scope: open the circuit, burn no attempts.
 * - not_found: the record does not exist.
 * - rejected: any other provider error.
 * - invalid_response: an answer that does not match the schema; a write may have happened.
 * - refused: refused before sending (allowlist, host, payload guard).
 */
export type CrmErrorKind = "throttled" | "unavailable" | "auth" | "not_found" | "rejected" | "invalid_response" | "refused";

export class CrmCallError extends Error {
  readonly kind: CrmErrorKind;
  /** Short code for `last_error_code` (`kind:CODE`), at most 64 characters, never a provider message. */
  readonly code: string;
  readonly method: string;
  readonly httpStatus: number | null;
  /** True when a write may have reached the portal although no answer was read. */
  readonly writeMayHaveHappened: boolean;
  constructor(kind: CrmErrorKind, method: string, opts: { code?: string; httpStatus?: number | null; writeMayHaveHappened?: boolean } = {}) {
    const code = safeCode(`${kind}${opts.code ? `:${opts.code}` : ""}`);
    super(`Bitrix24 ${method}: ${code}`);
    this.name = "CrmCallError";
    this.kind = kind;
    this.code = code;
    this.method = method;
    this.httpStatus = opts.httpStatus ?? null;
    this.writeMayHaveHappened = opts.writeMayHaveHappened ?? false;
  }
}

/** A code safe to store and log: letters, digits and `_.:-`, at most 64 characters. */
export function safeCode(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
  return cleaned || "error";
}

export interface BitrixCallEvent {
  method: BitrixMethod;
  status: number | null;
  durationMs: number;
  outcome: "ok" | CrmErrorKind;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface BitrixClientOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Called after every call with ids-free facts only (method, status, duration, outcome). */
  onCall?: (e: BitrixCallEvent) => void;
}

const THROTTLE_CODES = new Set(["QUERY_LIMIT_EXCEEDED", "OPERATION_TIME_LIMIT"]);
const AUTH_CODES = new Set(["INVALID_CREDENTIALS", "expired_token", "invalid_token", "insufficient_scope", "WRONG_AUTH_TYPE", "NO_AUTH_FOUND", "ACCESS_DENIED", "authorization_error"]);
/** Provider codes that mean "this record does not exist" (G14: confirm on the first real deletion, doc 29d §5.2a). */
const NOT_FOUND_CODES = new Set(["NOT_FOUND", "ERROR_NOT_FOUND", "ENTITY_NOT_FOUND", "ERROR_ENTITY_NOT_FOUND", "ITEM_NOT_FOUND", "CRM_ITEM_NOT_FOUND"]);
/** Codes too generic to say anything themselves: their description decides (an empty code is one of them). */
const GENERIC_CODES = new Set(["", "ERROR_CORE", "400", "404"]);
/** "Not found" in the portal's English or Russian wording; matched in memory only, never stored or logged. */
const NOT_FOUND_TEXT = /\bnot\s+found\b|\u043d\u0435\s+\u043d\u0430\u0439\u0434\u0435\u043d/i;

const errorBody = z.object({ error: z.string().max(200), error_description: z.unknown().optional() });
const id = z.coerce.number().int().positive();
const nullableInt = z.union([z.coerce.number().int(), z.null()]).optional().transform((v) => (v === undefined ? null : v));
const nullableStr = z.union([z.string(), z.null()]).optional().transform((v) => (v === undefined ? null : v));
const listBody = z.object({
  result: z.object({
    items: z.array(
      z.object({
        id,
        originatorId: nullableStr,
        originId: nullableStr,
        categoryId: nullableInt,
        updatedBy: nullableInt,
      }),
    ),
  }),
  total: z.number().int().nonnegative().optional(),
});
const itemBody = z.object({ result: z.object({ item: z.object({ id }) }) });
/** A user id as the portal sends it (number or digit string); null, empty or missing is null (never 0). */
const optNum = z
  .union([z.null(), z.number(), z.string().max(20)])
  .optional()
  .transform((v) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v)));
const snapshotBody = z.object({
  result: z.object({
    items: z.array(
      z
        .object({
          id,
          categoryId: nullableInt,
          stageId: nullableStr,
          assignedById: optNum,
          updatedBy: optNum,
          updatedTime: nullableStr,
          movedBy: optNum,
          movedTime: nullableStr,
          originatorId: nullableStr,
          originId: nullableStr,
          title: nullableStr,
          opportunity: z.unknown().optional(),
          currencyId: nullableStr,
        })
        .passthrough(),
    ),
  }),
  next: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
});
const funnelBody = z.object({
  result: z.object({ items: z.array(z.object({ id, originatorId: nullableStr, originId: nullableStr, categoryId: nullableInt })) }),
  next: z.number().int().nonnegative().optional(),
});
const adminFlag = z.union([z.boolean(), z.enum(["Y", "N", "1", "0"])]).transform((v) => v === true || v === "Y" || v === "1");
/** `profile`: only the id and the administrator flag survive the schema (the name and the rest are stripped). */
const profileBody = z.object({ result: z.object({ ID: id, ADMIN: adminFlag }) });
const categoryBody = z.object({ result: z.object({ category: z.object({ id, name: z.string().max(255), entityTypeId: z.coerce.number().int() }) }) });
const stageBody = z.object({
  result: z.array(
    z.object({
      STATUS_ID: z.string().min(1).max(60),
      ENTITY_ID: z.string().max(60).optional(),
      SEMANTICS: z.union([z.string(), z.null()]).optional(),
      EXTRA: z.object({ SEMANTICS: z.union([z.string(), z.null()]).optional() }).passthrough().nullable().optional(),
    }),
  ),
  next: z.number().int().nonnegative().optional(),
});

/** A stage's kind from either documented encoding (`SEMANTICS` S/F, or `EXTRA.SEMANTICS` process/success/failure). */
export function stageKind(s: { SEMANTICS?: string | null; EXTRA?: { SEMANTICS?: string | null } | null }): CrmStageKind {
  const top = s.SEMANTICS?.toUpperCase();
  const extra = s.EXTRA?.SEMANTICS?.toLowerCase();
  if (top === "S" || extra === "success") return "success";
  if (top === "F" || extra === "failure" || extra === "apology") return "failure";
  if (top === "P" || extra === "process") return "process";
  // No semantics at all: Bitrix24 sends none for in-progress stages in some answers. Unknown, never guessed.
  return "unknown";
}
const fieldsListBody = z.object({ result: z.object({ items: z.array(z.object({ id }).passthrough()) }) });
const productRowsBody = z.object({ result: z.object({ productRows: z.array(z.unknown()) }) });
/** The documented success answers of crm.item.delete: `result` true, or an empty array or object (G14). */
function deletedShape(v: unknown): boolean {
  if (typeof v !== "object" || v === null || !("result" in v)) return false;
  const r = (v as { result: unknown }).result;
  if (r === true) return true;
  if (Array.isArray(r)) return r.length === 0;
  return typeof r === "object" && r !== null && Object.keys(r).length === 0;
}
const deleteBody = z.custom<{ result: unknown }>(deletedShape);
/** A code naming an unexpected delete answer's shape, never its value: `delete_result_<false|null|string|number|object|array|missing>`. */
export function deleteShapeCode(raw: unknown): string {
  if (typeof raw !== "object" || raw === null || !("result" in raw)) return "delete_result_missing";
  const r = (raw as { result: unknown }).result;
  if (r === false) return "delete_result_false";
  if (r === null) return "delete_result_null";
  if (Array.isArray(r)) return "delete_result_array";
  return `delete_result_${typeof r === "object" ? "object" : typeof r === "string" ? "string" : typeof r === "number" ? "number" : "other"}`;
}
const commentBody = z.object({ result: id });

export class BitrixRestClient implements CrmPort, CrmReturnPort {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(
    private readonly config: Pick<CrmConfig, "portal" | "webhookUserId" | "webhookSecret" | "timeoutMs" | "categoryId"> & Partial<Pick<CrmConfig, "fieldCodes">>,
    private readonly opts: BitrixClientOptions = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
  }

  async findDealsByOrigin(originatorId: string, originId: string): Promise<DealRef[]> {
    const body = await this.call(
      "crm.item.list",
      {
        entityTypeId: DEAL_ENTITY_TYPE_ID,
        select: ["id", "originatorId", "originId", "categoryId", "updatedBy"],
        filter: { "=originatorId": originatorId, "=originId": originId, "=categoryId": this.config.categoryId },
        order: { id: "ASC" },
      },
      listBody,
    );
    // The filter is the provider's; the answer is checked again here.
    return body.result.items
      .filter((i) => i.originatorId === originatorId && i.originId === originId)
      .map((i) => ({ id: i.id, originatorId: i.originatorId, originId: i.originId, categoryId: i.categoryId, updatedBy: i.updatedBy }))
      .sort((a, b) => a.id - b.id);
  }

  async findDealById(dealId: number): Promise<DealRef | null> {
    const body = await this.call(
      "crm.item.list",
      {
        entityTypeId: DEAL_ENTITY_TYPE_ID,
        select: ["id", "originatorId", "originId", "categoryId", "updatedBy"],
        filter: { "=id": dealId, "=categoryId": this.config.categoryId },
      },
      listBody,
    );
    // The filter is the provider's; the answer is checked again here.
    const i = body.result.items.find((x) => x.id === dealId && x.categoryId === this.config.categoryId);
    return i ? { id: i.id, originatorId: i.originatorId, originId: i.originId, categoryId: i.categoryId, updatedBy: i.updatedBy } : null;
  }

  /**
   * The given custom fields of one deal in the OUTLYY funnel, under their original codes, or null. For the
   * synthetic probe only (crm.probe.ts): the values are compared there and never logged or returned.
   */
  async readDealFields(dealId: number, codes: readonly string[]): Promise<Record<string, unknown> | null> {
    const body = await this.call(
      "crm.item.list",
      { entityTypeId: DEAL_ENTITY_TYPE_ID, useOriginalUfNames: "Y", select: ["id", "categoryId", ...codes], filter: { "=id": dealId, "=categoryId": this.config.categoryId } },
      fieldsListBody,
    );
    const item = body.result.items.find((i) => i.id === dealId && Number((i as Record<string, unknown>).categoryId) === this.config.categoryId);
    return item ? Object.fromEntries(codes.map((c) => [c, (item as Record<string, unknown>)[c]])) : null;
  }

  /**
   * The return path poll (doc 29e §3.2): one page of the funnel's deals, changed at or after `since` (by
   * `updatedTime` then id) or at exactly one time after an id (by id), with the OUTLYY fields under their
   * original codes. Paging is by keyset in the reconciler, never by offset. The funnel filter is the
   * provider's; the answer is checked again here. Values are never logged.
   */
  async listChangedDeals(opts: { since: Date } | { at: Date; afterId: number }): Promise<{ items: DealSnapshot[]; more: boolean }> {
    const iso = (d: Date) => `${d.toISOString().slice(0, 19)}+00:00`;
    const filter = "since" in opts ? { ">=updatedTime": iso(opts.since) } : { "=updatedTime": iso(opts.at), ">id": opts.afterId };
    const order: Record<string, string> = "since" in opts ? { updatedTime: "ASC", id: "ASC" } : { id: "ASC" };
    return this.snapshots(filter, order);
  }

  async readDeals(ids: number[]): Promise<DealSnapshot[]> {
    const want = [...new Set(ids)].slice(0, BITRIX_PAGE);
    if (!want.length) return [];
    const { items } = await this.snapshots({ "@id": want }, { id: "ASC" });
    return items.filter((i) => want.includes(i.id));
  }

  private async snapshots(filter: Record<string, unknown>, order: Record<string, string>): Promise<{ items: DealSnapshot[]; more: boolean }> {
    const codes = Object.values(this.config.fieldCodes ?? {});
    const body = await this.call(
      "crm.item.list",
      {
        entityTypeId: DEAL_ENTITY_TYPE_ID,
        useOriginalUfNames: "Y",
        select: ["id", "categoryId", "stageId", "assignedById", "updatedBy", "updatedTime", "movedBy", "movedTime", "originatorId", "originId", "title", "opportunity", "currencyId", ...codes],
        filter: { "=categoryId": this.config.categoryId, ...filter },
        order,
        start: 0,
      },
      snapshotBody,
    );
    const items = body.result.items
      .filter((i) => i.categoryId === this.config.categoryId)
      .map((i) => {
        const raw = i as Record<string, unknown>;
        return {
          id: i.id,
          categoryId: i.categoryId,
          stageId: i.stageId,
          assignedById: i.assignedById,
          updatedBy: i.updatedBy,
          updatedTime: i.updatedTime,
          movedBy: i.movedBy,
          movedTime: i.movedTime,
          originatorId: i.originatorId,
          originId: i.originId,
          title: i.title,
          opportunity: i.opportunity,
          currencyId: i.currencyId,
          uf: Object.fromEntries(codes.filter((c) => c in raw).map((c) => [c, raw[c]])),
        } satisfies DealSnapshot;
      });
    return { items, more: body.result.items.length >= BITRIX_PAGE || body.next !== undefined };
  }

  /** The nightly sweep's list (doc 29e §8): the funnel by id, ids and OUTLYY tags only. */
  async listFunnelDeals(afterId: number): Promise<{ items: FunnelDealRef[]; more: boolean }> {
    const body = await this.call(
      "crm.item.list",
      {
        entityTypeId: DEAL_ENTITY_TYPE_ID,
        select: ["id", "originatorId", "originId", "categoryId"],
        filter: { "=categoryId": this.config.categoryId, ">id": afterId },
        order: { id: "ASC" },
        start: 0,
      },
      funnelBody,
    );
    const items = body.result.items
      .filter((i) => i.categoryId === this.config.categoryId && i.id > afterId)
      .map((i) => ({ id: i.id, originatorId: i.originatorId, originId: i.originId }))
      .sort((a, b) => a.id - b.id);
    return { items, more: body.result.items.length >= BITRIX_PAGE || body.next !== undefined };
  }

  /** `profile` (doc 29e §7): the webhook user's id and administrator flag. The name is never kept. */
  async readProfile(): Promise<{ userId: number; admin: boolean }> {
    const body = await this.call("profile", {}, profileBody);
    return { userId: body.result.ID, admin: body.result.ADMIN };
  }

  /** `crm.category.get` for the configured deal funnel, or null when the portal has none with that id. */
  async readCategory(): Promise<{ id: number; name: string; entityTypeId: number } | null> {
    try {
      const body = await this.call("crm.category.get", { entityTypeId: DEAL_ENTITY_TYPE_ID, id: this.config.categoryId }, categoryBody);
      return body.result.category;
    } catch (e) {
      if (e instanceof CrmCallError && e.kind === "not_found") return null;
      throw e;
    }
  }

  /** `crm.status.list` for the configured funnel's stages (`DEAL_STAGE_<id>`). More than one page is refused. */
  async listStages(): Promise<{ statusId: string; kind: CrmStageKind }[]> {
    // The default funnel's stages are `DEAL_STAGE` (review C3-22); the configuration refuses funnel 0 anyway.
    const entityId = this.config.categoryId === 0 ? "DEAL_STAGE" : `DEAL_STAGE_${this.config.categoryId}`;
    const body = await this.call("crm.status.list", { filter: { ENTITY_ID: entityId }, order: { SORT: "ASC" } }, stageBody);
    if (body.next !== undefined) throw new CrmCallError("invalid_response", "crm.status.list", { code: "stages_paged" });
    return body.result.filter((s) => s.ENTITY_ID === undefined || s.ENTITY_ID === entityId).map((s) => ({ statusId: s.STATUS_ID, kind: stageKind(s) }));
  }

  async addDeal(fields: DealFields): Promise<{ id: number }> {
    const body = await this.call("crm.item.add", { entityTypeId: DEAL_ENTITY_TYPE_ID, useOriginalUfNames: "Y", fields }, itemBody);
    return { id: body.result.item.id };
  }

  async updateDeal(dealId: number, fields: DealFields): Promise<void> {
    await this.call("crm.item.update", { entityTypeId: DEAL_ENTITY_TYPE_ID, id: dealId, useOriginalUfNames: "Y", fields }, itemBody);
  }

  async setProductRows(dealId: number, rows: ProductRow[]): Promise<void> {
    await this.call("crm.item.productrow.set", { ownerType: "D", ownerId: dealId, productRows: rows }, productRowsBody);
  }

  async deleteDeal(dealId: number): Promise<"deleted" | "not_found"> {
    try {
      await this.call("crm.item.delete", { entityTypeId: DEAL_ENTITY_TYPE_ID, id: dealId }, deleteBody, deleteShapeCode);
      return "deleted";
    } catch (e) {
      if (e instanceof CrmCallError && e.kind === "not_found") return "not_found";
      throw e;
    }
  }

  /**
   * One comment on a deal's timeline. The text is built only by crm.timeline.ts and checked there
   * (`assertSafeTimelineText`) before this call; it is never logged.
   */
  async addTimelineComment(dealId: number, text: string): Promise<{ id: number }> {
    const body = await this.call("crm.timeline.comment.add", { fields: { ENTITY_ID: dealId, ENTITY_TYPE: "deal", COMMENT: text } }, commentBody);
    return { id: body.result };
  }

  /**
   * The request URL; refused unless it is the pinned host over https. Never logged or returned.
   * The webhook secret is part of the path (Bitrix24 inbound webhooks have no header auth). Do not add fetch
   * instrumentation (OpenTelemetry, an APM agent, a logging wrapper) that records outbound URLs or paths
   * without redacting `/rest/<user>/<secret>/` first (review C2A-13; doc 29d §6c).
   */
  private urlFor(method: BitrixMethod): string {
    const { portal, webhookUserId, webhookSecret } = this.config;
    const url = new URL(`https://${portal}/rest/${encodeURIComponent(webhookUserId)}/${encodeURIComponent(webhookSecret)}/${method}.json`);
    if (url.protocol !== "https:" || url.hostname !== portal || url.port !== "" || url.username || url.password || url.search || url.hash) {
      throw new CrmCallError("refused", method, { code: "host" });
    }
    return url.toString();
  }

  private async call<S extends z.ZodType>(method: BitrixMethod, params: Record<string, unknown>, schema: S, shapeCode?: (raw: unknown) => string): Promise<z.output<S>> {
    if (!(BITRIX_METHODS as readonly string[]).includes(method)) throw new CrmCallError("refused", "unlisted", { code: "method" });
    const isWrite = WRITE_METHODS.has(method);
    const url = this.urlFor(method);
    const started = this.now();
    let status: number | null = null;
    const done = (outcome: BitrixCallEvent["outcome"]) => this.opts.onCall?.({ method, status, durationMs: Math.max(0, this.now() - started), outcome });

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(params),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (e) {
      done("unavailable");
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      // `cause` is not attached: some fetch errors stringify the request URL, which carries the secret.
      throw new CrmCallError("unavailable", method, { code: timeout ? "timeout" : "network", writeMayHaveHappened: isWrite });
    }
    status = res.status;
    if (res.redirected || res.type === "opaqueredirect") {
      done("refused");
      throw new CrmCallError("refused", method, { code: "redirect", httpStatus: status, writeMayHaveHappened: isWrite });
    }

    let raw: unknown;
    try {
      const text = await res.text();
      if (text.length > 1_000_000) throw new Error("too large");
      raw = text ? JSON.parse(text) : null;
    } catch {
      const kind: CrmErrorKind = status >= 500 ? "unavailable" : status === 429 ? "throttled" : "invalid_response";
      done(kind);
      throw new CrmCallError(kind, method, { code: kind === "invalid_response" ? "body" : `http_${status}`, httpStatus: status, writeMayHaveHappened: isWrite && kind !== "throttled" });
    }

    const err = errorBody.safeParse(raw);
    if ((err.success && (err.data.error !== "" || status >= 400)) || status >= 400) {
      const providerCode = err.success ? err.data.error : "";
      const description = err.success && typeof err.data.error_description === "string" ? err.data.error_description : "";
      const kind = classify(status, providerCode, description);
      done(kind);
      throw new CrmCallError(kind, method, {
        code: providerCode ? safeCode(providerCode).slice(0, 40) : `http_${status}`,
        httpStatus: status,
        // A throttle or auth refusal is answered before the method runs.
        writeMayHaveHappened: isWrite && (kind === "unavailable" || kind === "invalid_response"),
      });
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      done("invalid_response");
      throw new CrmCallError("invalid_response", method, { code: shapeCode ? shapeCode(raw) : "schema", httpStatus: status, writeMayHaveHappened: isWrite });
    }
    done("ok");
    return parsed.data;
  }
}

/**
 * `description` is the provider's message, used here in memory only and never kept. A "not found" answer is
 * recognised by its code, by HTTP 404, or (G14) by a generic code with a "not found" wording on a 400 or 404.
 * A method that does not exist (`ERROR_METHOD_NOT_FOUND`) is never a record not found.
 */
export function classify(status: number, providerCode: string, description = ""): CrmErrorKind {
  if (THROTTLE_CODES.has(providerCode) || status === 429) return "throttled";
  if (AUTH_CODES.has(providerCode) || status === 401 || status === 403) return "auth";
  if (/METHOD/i.test(providerCode)) return status >= 500 ? "unavailable" : "rejected";
  if (NOT_FOUND_CODES.has(providerCode.toUpperCase()) || status === 404) return "not_found";
  if ((status === 400 || status === 404) && GENERIC_CODES.has(providerCode.toUpperCase()) && NOT_FOUND_TEXT.test(description)) return "not_found";
  if (status >= 500) return "unavailable";
  return "rejected";
}

/**
 * Loop protection marker (doc 29 §6.4 "Loops"): a re-read CRM record whose
 * last change was made by the integration's own service user, or whose
 * snapshot hash equals the last pushed one, is an echo of OUTLYY's own push.
 * C1 has no return path; the return path (C3) uses this to drop echoes.
 */
export function isOwnEcho(record: Pick<DealRef, "updatedBy">, integrationUserId: string, opts: { reReadHash?: string | null; pushedHash?: string | null } = {}): boolean {
  if (record.updatedBy !== null && String(record.updatedBy) === integrationUserId) return true;
  return Boolean(opts.reReadHash && opts.pushedHash && opts.reReadHash === opts.pushedHash);
}
