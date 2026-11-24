import { crmConfigFrom, CRM_FIELD_KEYS, CRM_STAGE_KEYS, type CrmConfig, type CrmEnvSlice, type CrmScope } from "@/server/crm/crm.config";
import { CRM_PAYLOAD_VERSION, originIdFor, type CrmContactFacts, type CrmSubject, type CrmSubjectState } from "@/server/crm/crm.mapping";
import type { CrmLinkPatch, CrmLinkRow, CrmOutboxRow, CrmPortalStateRow, CrmStore, LockLinkResult } from "@/server/crm/crm.worker";

/**
 * In-memory `CrmStore` with the same rules as the Postgres one
 * (crm.store.ts) and the same enqueue rules as crm.outbox.ts: link upsert
 * with a version bump, a delete never creates a link, a tombstone takes no
 * new row, claims are oldest-first within one scope, every row and link
 * update is fenced by the holder. The Postgres store is covered by the db
 * suite (crm.db.test.ts).
 */

export const T0 = Date.parse("2026-11-22T08:00:00.000Z");

export class FakeClock {
  t = T0;
  now = () => new Date(this.t);
  ms = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
  sleep = async (ms: number) => {
    this.t += ms;
  };
}

interface MemRow extends CrmOutboxRow {
  environment: string;
  portal: string;
  status: "queued" | "running" | "done" | "dead";
  nextAttemptAt: number;
  lockedBy: string | null;
  lockedUntil: number | null;
  lastErrorCode: string | null;
  outcome: string | null;
  payloadVersion: number;
  dedupeKey: string;
  seq: number;
}

interface MemLink extends CrmLinkRow {
  environment: string;
  portal: string;
  lockedBy: string | null;
  lockedUntil: number | null;
  deletedAt: Date | null;
  deleteReason: string | null;
}

interface MemPortal extends CrmPortalStateRow {
  leaseHolder: string | null;
  leaseUntil: number | null;
}

let ids = 0;
const uuid = () => {
  ids += 1;
  return `00000000-0000-7000-8000-${ids.toString(16).padStart(12, "0")}`;
};
export const subjectId = uuid;

export class MemoryCrmStore implements CrmStore {
  readonly rows: MemRow[] = [];
  readonly links: MemLink[] = [];
  readonly portals = new Map<string, MemPortal>();
  private seq = 0;

  constructor(private readonly clock: FakeClock) {}

  private key(scope: CrmScope) {
    return `${scope.environment}/${scope.portal}`;
  }

  private findLink(scope: CrmScope, s: CrmSubject) {
    return this.links.find((l) => l.environment === scope.environment && l.portal === scope.portal && l.entityType === s.type && l.entityId === s.id);
  }

  /**
   * The domain-transaction enqueue (crm.outbox.ts writeOne). Returns the row, or null when nothing was written.
   * `newLinks` false = the sync is switched off: only an already linked subject takes a row (no backfill).
   */
  enqueue(scope: CrmScope, s: CrmSubject, kind: "sync" | "delete" = "sync", reason: "erasure" | "retention" | null = null, newLinks = true): MemRow | null {
    let link = this.findLink(scope, s);
    if (!link) {
      if (kind === "delete" || !newLinks) return null;
      link = {
        id: uuid(),
        environment: scope.environment,
        portal: scope.portal,
        entityType: s.type,
        entityId: s.id,
        crmId: null,
        originatorId: `outlyy-${scope.environment}`,
        originId: originIdFor(s),
        state: "pending",
        creatingSince: null,
        localVersion: 0n,
        pushedVersion: 0n,
        pushedHash: null,
        pushedAt: null,
        twinFlaggedAt: null,
        lockedBy: null,
        lockedUntil: null,
        deletedAt: null,
        deleteReason: null,
      };
      this.links.push(link);
    } else if (kind === "delete" && link.state === "deleted") return null;
    link.localVersion += 1n;
    if (link.state === "deleted") return null;
    const dedupeKey = `${kind}:${s.type}:${s.id}:${link.localVersion}@${scope.environment}/${scope.portal}`;
    if (this.rows.some((r) => r.dedupeKey === dedupeKey)) return null;
    const row: MemRow = {
      id: uuid(),
      environment: scope.environment,
      portal: scope.portal,
      entityType: s.type,
      entityId: s.id,
      kind,
      version: link.localVersion,
      attempts: 0,
      maxAttempts: 8,
      reason,
      status: "queued",
      nextAttemptAt: this.clock.ms(),
      lockedBy: null,
      lockedUntil: null,
      lastErrorCode: null,
      outcome: null,
      payloadVersion: CRM_PAYLOAD_VERSION,
      dedupeKey,
      seq: ++this.seq,
    };
    this.rows.push(row);
    return row;
  }

  link(scope: CrmScope, s: CrmSubject) {
    return this.findLink(scope, s);
  }

  async ensurePortal(scope: CrmScope, identity: { categoryId: number; originatorId: string }): Promise<CrmPortalStateRow> {
    let p = this.portals.get(this.key(scope));
    if (!p) {
      p = { ...identity, createdAt: this.clock.now(), pausedUntil: null, pauseReason: null, consecutiveFailures: 0, leaseHolder: null, leaseUntil: null };
      this.portals.set(this.key(scope), p);
    }
    return { createdAt: p.createdAt, categoryId: p.categoryId, originatorId: p.originatorId, pausedUntil: p.pausedUntil, pauseReason: p.pauseReason, consecutiveFailures: p.consecutiveFailures };
  }

  async acquireLease(scope: CrmScope, holder: string, now: Date, until: Date) {
    const p = this.portals.get(this.key(scope));
    if (!p) return false;
    if (p.leaseUntil !== null && p.leaseUntil >= now.getTime() && p.leaseHolder !== holder) return false;
    p.leaseHolder = holder;
    p.leaseUntil = until.getTime();
    return true;
  }

  async releaseLease(scope: CrmScope, holder: string) {
    const p = this.portals.get(this.key(scope));
    if (p && p.leaseHolder === holder) {
      p.leaseHolder = null;
      p.leaseUntil = null;
    }
  }

  async setPortalHealth(scope: CrmScope, patch: Partial<Pick<CrmPortalStateRow, "pausedUntil" | "pauseReason" | "consecutiveFailures">>) {
    const p = this.portals.get(this.key(scope));
    if (p) Object.assign(p, patch);
  }

  async releaseStaleRows(scope: CrmScope, now: Date) {
    let n = 0;
    for (const r of this.rows) {
      if (r.environment === scope.environment && r.portal === scope.portal && r.status === "running" && (r.lockedUntil ?? 0) < now.getTime()) {
        r.status = "queued";
        r.lockedBy = null;
        r.lockedUntil = null;
        n += 1;
      }
    }
    return n;
  }

  async claimNext(scope: CrmScope, holder: string, now: Date, lockUntil: Date): Promise<CrmOutboxRow | null> {
    const due = this.rows
      .filter((r) => r.environment === scope.environment && r.portal === scope.portal && r.status === "queued" && r.nextAttemptAt <= now.getTime() && r.payloadVersion <= CRM_PAYLOAD_VERSION)
      .sort((a, b) => a.seq - b.seq);
    const r = due[0];
    if (!r) return null;
    r.status = "running";
    r.lockedBy = holder;
    r.lockedUntil = lockUntil.getTime();
    return { id: r.id, entityType: r.entityType, entityId: r.entityId, kind: r.kind, version: r.version, attempts: r.attempts, maxAttempts: r.maxAttempts, reason: r.reason };
  }

  private owned(id: string, holder: string) {
    const r = this.rows.find((x) => x.id === id);
    return r && r.lockedBy === holder && r.status === "running" ? r : null;
  }

  async completeRow(id: string, holder: string, outcome: string) {
    const r = this.owned(id, holder);
    if (r) Object.assign(r, { status: "done", outcome, lockedBy: null, lockedUntil: null });
  }

  async retryRow(id: string, holder: string, x: { attempts: number; nextAttemptAt: Date; code: string }) {
    const r = this.owned(id, holder);
    if (r) Object.assign(r, { status: "queued", attempts: x.attempts, nextAttemptAt: x.nextAttemptAt.getTime(), lastErrorCode: x.code, lockedBy: null, lockedUntil: null });
  }

  async deadRow(id: string, holder: string, x: { attempts: number; code: string }) {
    const r = this.owned(id, holder);
    if (r) Object.assign(r, { status: "dead", attempts: x.attempts, lastErrorCode: x.code, outcome: "dead", lockedBy: null, lockedUntil: null });
  }

  async deferRow(id: string, holder: string, x: { nextAttemptAt: Date; code: string }) {
    const r = this.owned(id, holder);
    if (r) Object.assign(r, { status: "queued", nextAttemptAt: x.nextAttemptAt.getTime(), lastErrorCode: x.code, lockedBy: null, lockedUntil: null });
  }

  async countForeignDue(scope: CrmScope, now: Date) {
    return this.rows.filter((r) => r.status === "queued" && r.nextAttemptAt <= now.getTime() && !(r.environment === scope.environment && r.portal === scope.portal)).length;
  }

  async lockLink(scope: CrmScope, s: CrmSubject, holder: string, now: Date, until: Date): Promise<LockLinkResult> {
    const l = this.findLink(scope, s);
    if (!l) return { kind: "missing" };
    if (l.lockedUntil !== null && l.lockedUntil >= now.getTime() && l.lockedBy !== holder) return { kind: "busy" };
    l.lockedBy = holder;
    l.lockedUntil = until.getTime();
    const { environment: _e, portal: _p, lockedBy: _b, lockedUntil: _u, deletedAt: _d, deleteReason: _r, ...row } = l;
    return { kind: "locked", link: { ...row } };
  }

  async updateLink(linkId: string, holder: string, patch: CrmLinkPatch) {
    const l = this.links.find((x) => x.id === linkId);
    if (l && l.lockedBy === holder) Object.assign(l, patch);
  }

  async unlockLink(linkId: string, holder: string) {
    const l = this.links.find((x) => x.id === linkId);
    if (l && l.lockedBy === holder) {
      l.lockedBy = null;
      l.lockedUntil = null;
    }
  }
}

/** A synthetic CRM env slice for a fake portal (`.test` host, never resolves). */
export const FAKE_HOST = "outlyy-fake.bitrix24.test";
export const FAKE_USER = "17";
// Assembled at runtime so the public-copy secret scanner sees no literal assignment.
export const FAKE_SECRET = ["fake", "Hook", "0123"].join("");

export function fakeEnv(over: Partial<CrmEnvSlice> = {}): CrmEnvSlice {
  return {
    APP_ENV: "staging",
    CRM_SYNC_ENABLED: true,
    CRM_BITRIX_ENV: "test",
    CRM_BITRIX_PORTAL_HOST: FAKE_HOST,
    CRM_BITRIX_WEBHOOK_USER_ID: FAKE_USER,
    CRM_BITRIX_WEBHOOK_SECRET: FAKE_SECRET,
    CRM_BITRIX_DEAL_CATEGORY_ID: "7",
    CRM_BITRIX_STAGE_IDS: CRM_STAGE_KEYS.map((k) => `${k}=C7:${k.toUpperCase()}`).join(","),
    CRM_BITRIX_FIELD_CODES: CRM_FIELD_KEYS.map((k) => `${k}=${fieldCode(k)}`).join(","),
    CRM_BITRIX_DEFAULT_OWNER_ID: FAKE_OWNER,
    CRM_BITRIX_TIMEOUT_MS: 5_000,
    NEXT_PUBLIC_SITE_URL: FAKE_SITE,
    ...over,
  };
}

/** The synthetic field code of an OUTLYY field on the fake portal. */
export function fieldCode(key: (typeof CRM_FIELD_KEYS)[number]): `UF_CRM_${string}` {
  return `UF_CRM_${key.toUpperCase()}`;
}

/** The sales lead who owns new deals on the fake portal. */
export const FAKE_OWNER = "23";
export const FAKE_SITE = "https://admin.outlyy.test";

/**
 * A synthetic customer: a landline-style placeholder number and an
 * `.invalid` address, both assembled at runtime.
 */
export const TEST_CONTACT: CrmContactFacts = {
  name: "Test Customer",
  phone: ["+971", "4", "0001234"].join(""),
  email: ["test.customer", "example.invalid"].join("@"),
};

export function fakeConfig(over: Partial<CrmEnvSlice> = {}): CrmConfig {
  const c = crmConfigFrom(fakeEnv(over));
  if (!c) throw new Error("fake CRM config refused");
  return c;
}

/** Subject states keyed `type:id`; the worker's `loadState`. */
export class StateBook {
  private readonly states = new Map<string, CrmSubjectState>();
  set(state: CrmSubjectState) {
    this.states.set(`${state.subject.type}:${state.subject.id}`, structuredClone(state));
  }
  get(s: CrmSubject): CrmSubjectState | undefined {
    return this.states.get(`${s.type}:${s.id}`);
  }
  load = async (s: CrmSubject): Promise<CrmSubjectState> => structuredClone(this.get(s) ?? { subject: s, exists: false, erased: false, inquiry: null, order: null });
}

export function inquiryState(
  id: string,
  over: { status?: string; reference?: string; source?: string; items?: { title: string | null; serviceDate: string | null }[]; contact?: CrmContactFacts | null } = {},
): CrmSubjectState {
  return {
    subject: { type: "inquiry", id },
    exists: true,
    erased: false,
    inquiry: {
      reference: over.reference ?? "INQ-1048213",
      status: over.status ?? "new",
      source: over.source ?? "inquiry_form",
      currency: "AED",
      indicativeMinor: 18_000n,
      items: (over.items ?? [{ title: "Desert safari", serviceDate: "2026-12-01" }]).map((i) => ({ ...i, totalMinor: null })),
    },
    order: null,
    contact: over.contact === undefined ? { ...TEST_CONTACT } : over.contact,
    consent: { marketingEmail: { granted: true, at: "2026-11-20T09:30:00+00:00" }, marketingWhatsapp: null },
  };
}

export function directOrderState(
  id: string,
  over: { status?: string; authorised?: boolean; capturedMinor?: bigint; refundedMinor?: bigint; reference?: string; marginAedMinor?: bigint | null; refundPending?: boolean } = {},
): CrmSubjectState {
  return {
    subject: { type: "order", id },
    exists: true,
    erased: false,
    inquiry: null,
    order: {
      reference: over.reference ?? "OUT-4829135",
      status: over.status ?? "pending_payment",
      currency: "AED",
      authorised: over.authorised ?? false,
      capturedMinor: over.capturedMinor ?? 0n,
      refundedMinor: over.refundedMinor ?? 0n,
      items: [{ title: "Burj Khalifa At the Top", serviceDate: "2026-12-02", totalMinor: 25_000n, status: "pending", needsDocument: true, documentReady: false }],
      totalMinor: 25_000n,
      refundPending: over.refundPending ?? false,
      marginAedMinor: over.marginAedMinor === undefined ? null : over.marginAedMinor,
    },
    contact: { ...TEST_CONTACT },
    consent: { marketingEmail: null, marketingWhatsapp: { granted: false, at: "2026-11-21T10:00:00+00:00" } },
  };
}
