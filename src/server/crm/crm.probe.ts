import { CrmCallError, type CrmFieldValue, type DealFields, type DealRef, type ProductRow } from "./bitrix.client";
import { CRM_FIELD_KEYS, type CrmConfig, type CrmFieldKey } from "./crm.config";
import { assertSafeCrmPayload, bitrixInstant, mapDeal, originIdFor, type CrmSubject, type CrmSubjectState } from "./crm.mapping";
import { assertDeleteTarget } from "./crm.worker";

/**
 * The synthetic probe (review C2A-01; doc 29d §5.2a): one made-up subject
 * pushed through the real mapping, payload guard and client to the
 * configured portal, then every OUTLYY field read back and compared, before
 * any real customer's data is pushed. It proves on the real portal that the
 * 20 field codes, the value formats and the funnel are right.
 *
 *  - Synthetic data only: reference `OUT-0000000`, the all-zero subject id,
 *    a placeholder name, a landline-shaped placeholder number and an
 *    `.invalid` address. No database row is read or written; no link exists,
 *    so the worker never sees the probe deal.
 *  - The result names each field key with `ok`, `missing` or `different`.
 *    Values are never returned or logged.
 *  - `deleteCrmProbe` removes the probe deal through the same delete guard
 *    as erasure (this environment's originator and the probe's originId, in
 *    the OUTLYY funnel only).
 */

/**
 * Order-shaped, so that every one of the 20 OUTLYY fields carries a distinct,
 * non-empty value (re-review R-01): a dropped write shows as `missing` or
 * `different`, and a swap of two field codes shows as `different` on both.
 */
export const PROBE_SUBJECT: CrmSubject = { type: "order", id: "00000000-0000-7000-8000-000000000000" };
export const PROBE_REFERENCE = "OUT-0000000";

export function probeState(now: Date): CrmSubjectState {
  const day = (n: number) => new Date(now.getTime() + n * 86_400_000).toISOString().slice(0, 10);
  return {
    subject: PROBE_SUBJECT,
    exists: true,
    erased: false,
    inquiry: null,
    order: {
      reference: PROBE_REFERENCE,
      status: "partially_confirmed",
      currency: "AED",
      authorised: true,
      // Payment "partially_refunded", refund "pending" (an open refund), refund amount 0.01.
      capturedMinor: 400n,
      refundedMinor: 1n,
      refundPending: true,
      // Indicative amount 0.03, margin 0.02: distinct from each other and from the refund amount.
      totalMinor: 3n,
      marginAedMinor: 2n,
      // Supplier "partially_confirmed" (a line not supplied), tickets "partially_issued", summary "2 confirmed, 1 not supplied".
      items: [
        { title: "OUTLYY TEST - delete me", serviceDate: day(1), totalMinor: 100n, status: "confirmed", needsDocument: true, documentReady: true },
        { title: "OUTLYY TEST - delete me", serviceDate: day(2), totalMinor: 100n, status: "confirmed", needsDocument: true, documentReady: false },
        { title: "OUTLYY TEST - delete me", serviceDate: day(3), totalMinor: 100n, status: "rejected", needsDocument: true, documentReady: false },
      ],
    },
    createdAt: now,
    // Assembled at runtime: a placeholder, never a real person's details.
    contact: { name: "OUTLYY Test Customer", phone: ["+971", "4", "0000000"].join(""), email: ["outlyy.probe", "example.invalid"].join("@") },
    // Two different times, so a swap of the two "as of" codes shows.
    consent: {
      marketingEmail: { granted: true, at: bitrixInstant(new Date(now.getTime() - 2 * 3_600_000)) },
      marketingWhatsapp: { granted: false, at: bitrixInstant(new Date(now.getTime() - 3_600_000)) },
    },
  };
}

export type ProbeFieldStatus = "ok" | "missing" | "different";

export interface ProbePort {
  findDealsByOrigin(originatorId: string, originId: string): Promise<DealRef[]>;
  addDeal(fields: DealFields): Promise<{ id: number }>;
  updateDeal(id: number, fields: DealFields): Promise<void>;
  setProductRows(dealId: number, rows: ProductRow[]): Promise<void>;
  readDealFields(dealId: number, codes: readonly string[]): Promise<Record<string, unknown> | null>;
  deleteDeal(id: number): Promise<"deleted" | "not_found">;
}

export interface ProbeResult {
  ok: boolean;
  dealId: number;
  created: boolean;
  fields: Record<CrmFieldKey, ProbeFieldStatus>;
}

/** Whether a value read back equals the value sent, allowing the portal's own encodings (numbers as strings, Y/N as booleans, an instant in another offset). */
export function sameValue(sent: CrmFieldValue, read: unknown): boolean {
  const empty = (v: unknown) => v === "" || v === null || v === undefined || v === false || (Array.isArray(v) && v.length === 0);
  if (sent === "") return empty(read);
  if (typeof sent === "number") return read !== null && read !== "" && Number(read) === sent;
  if (sent === "Y" || sent === "N") {
    const yes = read === "Y" || read === true || read === "1" || read === 1;
    const no = read === "N" || read === false || read === "0" || read === 0;
    return sent === "Y" ? yes : no;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(sent)) return typeof read === "string" && Date.parse(read) === Date.parse(sent);
  if (/^\d{4}-\d{2}-\d{2}$/.test(sent)) return typeof read === "string" && read.slice(0, 10) === sent;
  return read === sent;
}

export async function runCrmProbe(deps: { config: CrmConfig; port: ProbePort; now: () => Date }): Promise<ProbeResult> {
  const { config, port } = deps;
  const mapped = mapDeal(probeState(deps.now()), config, { now: deps.now() });
  if (!mapped.visible) throw new CrmCallError("refused", "probe", { code: "probe_not_visible" });
  assertSafeCrmPayload(mapped.fields, mapped.rows, config);
  assertSafeCrmPayload(mapped.createFields, mapped.rows, config, { create: true });
  const found = await port.findDealsByOrigin(config.originatorId, originIdFor(PROBE_SUBJECT));
  let dealId: number;
  let created = false;
  if (found.length) {
    dealId = found[0].id;
    await port.updateDeal(dealId, mapped.fields);
  } else {
    dealId = (await port.addDeal(mapped.createFields)).id;
    created = true;
  }
  await port.setProductRows(dealId, mapped.rows);
  const codes = CRM_FIELD_KEYS.map((k) => config.fieldCodes[k]);
  const read = (await port.readDealFields(dealId, codes)) ?? {};
  const fields = {} as Record<CrmFieldKey, ProbeFieldStatus>;
  for (const k of CRM_FIELD_KEYS) {
    const code = config.fieldCodes[k];
    const sent = mapped.fields[code as `UF_CRM_${string}`];
    fields[k] = !(code in read) || read[code] === undefined ? "missing" : sameValue(sent, read[code]) ? "ok" : "different";
  }
  return { ok: Object.values(fields).every((s) => s === "ok"), dealId, created, fields };
}

/** Delete the probe deal(s) of this environment, through the erasure delete guard. */
export async function deleteCrmProbe(deps: { config: CrmConfig; port: ProbePort }): Promise<{ deleted: number }> {
  const { config, port } = deps;
  const link = { crmId: null, originatorId: config.originatorId, originId: originIdFor(PROBE_SUBJECT) };
  const found = await port.findDealsByOrigin(link.originatorId, link.originId);
  for (const d of found) assertDeleteTarget(d, link, config);
  let deleted = 0;
  for (const d of found) if ((await port.deleteDeal(d.id)) === "deleted") deleted += 1;
  return { deleted };
}
