import { BitrixRestClient } from "@/server/crm/bitrix.client";
import type { CrmScope } from "@/server/crm/crm.config";
import { mapDeal, originIdFor, type CrmSubject, type CrmSubjectState } from "@/server/crm/crm.mapping";
import { crmReturnHooks, storeCrmFingerprint, type CrmCommandResult, type CrmReturnCommands, type CrmStaffActor, type CrmVia } from "@/server/crm/crm.reconcile";
import { crmReturnConfigFrom, type CrmReturnMode } from "@/server/crm/crm.return.config";
import { pacedLimiter, runCrmWorker } from "@/server/crm/crm.worker";
import { canTransition, LOST_REASONS, TERMINAL } from "@/server/domain/inquiry-state";
import { ROLE_PERMISSIONS, type RoleCode } from "@/server/lib/permissions";
import type { InquiryStatus } from "@/lib/types";
import { FakeBitrix24, type FakeDeal } from "./_bitrix-fake";
import { MemoryReturnStore } from "./_memory-return-store";
import { FAKE_HOST, FAKE_SECRET, FAKE_USER, FakeClock, StateBook, fakeConfig, inquiryState, subjectId } from "./_memory-store";

/**
 * Test harness for the return path (C3ab): the worker with the reconciler's
 * hooks, the fake portal, the in-memory stores and fake inquiry commands
 * that apply OUTLYY's own rules (the transition table of inquiry-state.ts,
 * the permissions of lib/permissions.ts, the "own inquiries only" rule, the
 * loss reason, active staff with two-factor). Synthetic data only.
 */

/** Synthetic staff: Bitrix24 user id ↔ OUTLYY staff id. 23 is the default deal owner (the sales lead). */
export const STAFF = {
  lead: { bitrix: 23, id: "0a000000-0000-4000-8000-000000000023", roles: ["agent_lead"] as RoleCode[] },
  a: { bitrix: 31, id: "0a000000-0000-4000-8000-000000000031", roles: ["agent"] as RoleCode[] },
  b: { bitrix: 32, id: "0a000000-0000-4000-8000-000000000032", roles: ["agent"] as RoleCode[] },
  off: { bitrix: 33, id: "0a000000-0000-4000-8000-000000000033", roles: ["agent_lead"] as RoleCode[], inactive: true },
};
export const STAFF_MAP = Object.values(STAFF)
  .map((s) => `${s.bitrix}=${s.id}`)
  .join(",");
export const UNMAPPED_USER = 99;

interface StaffRec {
  roles: RoleCode[];
  active: boolean;
  totp: boolean;
}

type Wrapped = CrmStaffActor & { __actor: { id: string; perms: Set<string> } };

export class FakeCommands implements CrmReturnCommands {
  readonly calls: { op: string; actor?: string; id?: string; to?: string; agentId?: string; via?: CrmVia; reason?: string; info?: unknown }[] = [];
  readonly agents = new Map<string, string | null>();
  readonly staffRecords = new Map<string, StaffRec>();

  constructor(
    private readonly book: StateBook,
    private readonly store: MemoryReturnStore,
    private readonly scope: CrmScope,
  ) {
    for (const s of Object.values(STAFF)) this.staffRecords.set(s.id, { roles: s.roles, active: !("inactive" in s), totp: true });
  }

  private perms(a: CrmStaffActor | "system"): Set<string> {
    return a === "system" ? new Set(["*", "inquiries.update", "inquiries.assign"]) : (a as Wrapped).__actor.perms;
  }

  private status(id: string): InquiryStatus {
    return this.book.get({ type: "inquiry", id })!.inquiry!.status as InquiryStatus;
  }

  /** As the service does: the status, then the CRM push in the same transaction. */
  setStatus(id: string, to: string) {
    const st = this.book.get({ type: "inquiry", id })!;
    st.inquiry!.status = to;
    this.book.set(st);
    this.store.enqueue(this.scope, { type: "inquiry", id });
  }

  async inquiry(id: string) {
    const st = this.book.get({ type: "inquiry", id });
    return st?.inquiry ? { status: st.inquiry.status, assignedAgentId: this.agents.get(id) ?? null, hasOrder: st.order !== null } : null;
  }

  async staff(staffId: string) {
    const r = this.staffRecords.get(staffId);
    if (!r || !r.active || !r.totp) return null;
    return { staffId, __actor: { id: staffId, perms: new Set<string>(r.roles.flatMap((x) => ROLE_PERMISSIONS[x])) } } as Wrapped;
  }

  async existingStaff(ids: string[]) {
    return new Set(ids.filter((i) => this.staffRecords.has(i)));
  }

  async transition(actor: CrmStaffActor, id: string, to: string, via: CrmVia, opts: { reason?: string }): Promise<CrmCommandResult> {
    this.calls.push({ op: "transition", actor: actor.staffId, id, to, via, reason: opts.reason });
    const p = this.perms(actor);
    const from = this.status(id);
    if (!p.has("inquiries.update")) return { ok: false, code: "forbidden" };
    if (!p.has("inquiries.assign") && this.agents.get(id) !== actor.staffId) return { ok: false, code: "forbidden" };
    if (from === to && to !== "assigned") return { ok: true };
    if (!canTransition(from, to as InquiryStatus)) return { ok: false, code: "invalid_transition" };
    if (to === "won") return { ok: false, code: "conflict" };
    if (to === "lost" && !(LOST_REASONS as readonly string[]).includes(opts.reason ?? "")) return { ok: false, code: "validation_failed" };
    if ((from === "lost" || from === "spam") && !p.has("inquiries.assign")) return { ok: false, code: "forbidden" };
    this.setStatus(id, to);
    return { ok: true };
  }

  async assign(actor: CrmStaffActor | "system", id: string, agentId: string, via: CrmVia, note: string): Promise<CrmCommandResult> {
    this.calls.push({ op: "assign", actor: actor === "system" ? "system" : actor.staffId, id, agentId, via, reason: note });
    const p = this.perms(actor);
    const self = actor !== "system" && agentId === actor.staffId && !this.agents.get(id);
    if (!self && !p.has("inquiries.assign")) return { ok: false, code: "forbidden" };
    const from = this.status(id);
    if (TERMINAL.has(from)) return { ok: false, code: "invalid_transition" };
    const target = this.staffRecords.get(agentId);
    if (!target || !target.active || !target.totp) return { ok: false, code: "validation_failed" };
    this.agents.set(id, agentId);
    this.setStatus(id, from === "new" ? "assigned" : from);
    return { ok: true };
  }

  async recordPutBack(subject: CrmSubject, info: unknown) {
    this.calls.push({ op: "put_back", id: subject.id, info });
  }

  mutations() {
    return this.calls.filter((c) => c.op !== "put_back");
  }
}

export interface ReturnHarnessOpts {
  mode?: CrmReturnMode;
  accept?: boolean;
  staffMap?: string | undefined;
}

export function returnHarness(opts: ReturnHarnessOpts = {}) {
  const clock = new FakeClock();
  const config = fakeConfig();
  const scope: CrmScope = { environment: config.environment, portal: config.portal };
  const store = new MemoryReturnStore(clock);
  const fake = new FakeBitrix24({ host: FAKE_HOST, userId: FAKE_USER, secret: FAKE_SECRET, now: clock.ms });
  const book = new StateBook();
  const commands = new FakeCommands(book, store, scope);
  const events: { name: string; fields: Record<string, unknown>; level?: string }[] = [];
  const port = new BitrixRestClient(config, { fetchImpl: fake.fetch, now: clock.ms });
  const settings = { mode: opts.mode ?? "enforce", accept: opts.accept ?? false, staffMap: "staffMap" in opts ? opts.staffMap : STAFF_MAP };
  let runs = 0;
  const run = async (budgetMs?: number) => {
    const ret = crmReturnConfigFrom({ CRM_RETURN_PATH: settings.mode, CRM_RETURN_ACCEPT: settings.accept, CRM_BITRIX_STAFF_MAP: settings.staffMap }, config);
    const limiter = pacedLimiter({ minIntervalMs: 1_000, maxPerRun: 12, now: clock.ms, sleep: clock.sleep });
    const emit = (name: string, fields: Record<string, unknown>, level?: string) => events.push({ name, fields, level });
    const hooks = ret.mode === "off" ? undefined : crmReturnHooks({ config, ret, store, port, commands, loadState: book.load, limiter, now: clock.now, emit });
    return runCrmWorker({ config, store, port, loadState: book.load, limiter, now: clock.now, random: () => 0.5, holder: `w-${++runs}`, hooks, emit }, budgetMs === undefined ? {} : { budgetMs });
  };
  const put = (state: CrmSubjectState) => {
    book.set(state);
    return store.enqueue(scope, state.subject);
  };
  const deal = (s: CrmSubject): FakeDeal => fake.dealsFor(originIdFor(s))[0];
  const storeFingerprint = () => storeCrmFingerprint({ config, store, port, now: clock.now });
  /** A new inquiry pushed to the portal (enforce harnesses store the fingerprint first). */
  const newDeal = async (over: Parameters<typeof inquiryState>[1] = {}) => {
    const s: CrmSubject = { type: "inquiry", id: subjectId() };
    put(inquiryState(s.id, over));
    await run();
    clock.advance(60_000);
    return { s, deal: deal(s) };
  };
  /**
   * A deal already pushed and linked, written straight into the fake and the store (no calls), for volume tests.
   */
  const linked = (state: CrmSubjectState): FakeDeal => {
    book.set(state);
    store.enqueue(scope, state.subject);
    const mapped = mapDeal(state, config, { now: clock.now() });
    if (!mapped.visible) throw new Error("not visible");
    const d = fake.seedDeal({ ...mapped.createFields, originId: mapped.fields.originId });
    const l = store.link(scope, state.subject)!;
    Object.assign(l, { crmId: BigInt(d.id), state: "active", pushedVersion: l.localVersion, pushedHash: mapped.hash, pushedAt: clock.now() });
    store.rows.filter((r) => r.entityId === state.subject.id).forEach((r) => Object.assign(r, { status: "done" }));
    return d;
  };
  const writesTo = (since: number) => fake.calls.slice(since).filter((c) => c.method !== "crm.item.list" && c.method !== "profile" && !c.method.startsWith("crm.category") && !c.method.startsWith("crm.status"));
  const ev = (name: string) => events.filter((e) => e.name === name);
  return { clock, config, scope, store, fake, book, commands, events, port, settings, run, put, deal, storeFingerprint, newDeal, linked, writesTo, ev };
}
