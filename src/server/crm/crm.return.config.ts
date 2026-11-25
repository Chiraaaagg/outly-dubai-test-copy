import type { CrmConfig } from "./crm.config";

/**
 * Bitrix24 return path settings (doc 29e §3.8, §4.1, §10; CRM batch C3ab;
 * owner answers of 25 November 2026). Pure: env is a parameter.
 *
 *  - `CRM_RETURN_PATH`: `off` (default), `observe` or `enforce`. Any other
 *    value is a problem and the return path stays off (fail closed).
 *    `observe` polls, classifies, logs and alerts, and changes nothing in
 *    Bitrix24 or in OUTLYY state. `enforce` puts back what staff may not
 *    change.
 *  - `CRM_RETURN_ACCEPT`: exactly `true` lets `enforce` accept staff
 *    sales-stage moves and Bitrix24 owner changes as the mapped staff
 *    member's own OUTLYY action (owner answer 3). Default off; then every
 *    staff stage move is put back and an owner change is only recorded.
 *  - `CRM_BITRIX_STAFF_MAP`: `bitrixUserId=outlyyStaffId` pairs,
 *    comma-separated (owner answer 4: a production setting). Numbers on the
 *    left, OUTLYY staff ids (UUIDs) on the right, no id twice on either side,
 *    never the service account, and the default deal owner must be in it.
 *    Ids only: never a name or an email address. Whether each staff id
 *    exists is checked by the run (crm.reconcile.ts), which fails closed.
 *
 * All three are ignored while `CRM_SYNC_ENABLED` is not `true` (the job
 * never runs then). Never a `NEXT_PUBLIC_` value (env.ts refuses those).
 */

export const CRM_RETURN_MODES = ["off", "observe", "enforce"] as const;
export type CrmReturnMode = (typeof CRM_RETURN_MODES)[number];

export interface CrmReturnEnvSlice {
  CRM_RETURN_PATH?: string;
  CRM_RETURN_ACCEPT?: boolean;
  CRM_BITRIX_STAFF_MAP?: string;
}

export interface CrmReturnConfig {
  mode: CrmReturnMode;
  /** Staff moves and owner changes may be accepted (enforce only, with a valid staff map). */
  accept: boolean;
  /** Bitrix24 user id → OUTLYY staff id. */
  staffMap: ReadonlyMap<number, string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const USER_ID = /^[1-9]\d{0,8}$/;

/** The staff map as id pairs, and every reason it is refused (never a value in a reason). */
export function parseStaffMap(raw: string | undefined, cfg: Pick<CrmConfig, "webhookUserId" | "defaultOwnerId">): { map: Map<number, string>; problems: string[] } {
  const map = new Map<number, string>();
  const problems: string[] = [];
  if (!raw || !raw.trim()) return { map, problems: ["CRM_BITRIX_STAFF_MAP is missing"] };
  const staff = new Set<string>();
  let n = 0;
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    n += 1;
    const eq = pair.indexOf("=");
    const left = eq > 0 ? pair.slice(0, eq).trim() : "";
    const right = eq > 0 ? pair.slice(eq + 1).trim().toLowerCase() : "";
    if (!USER_ID.test(left)) {
      problems.push(`CRM_BITRIX_STAFF_MAP: pair ${n} must start with a Bitrix24 user id (digits)`);
      continue;
    }
    if (!UUID.test(right)) {
      problems.push(`CRM_BITRIX_STAFF_MAP: pair ${n} must end with an OUTLYY staff id (a UUID)`);
      continue;
    }
    const user = Number(left);
    if (String(user) === cfg.webhookUserId) problems.push(`CRM_BITRIX_STAFF_MAP: pair ${n} names the service account`);
    if (map.has(user)) problems.push(`CRM_BITRIX_STAFF_MAP: pair ${n} repeats a Bitrix24 user id`);
    if (staff.has(right)) problems.push(`CRM_BITRIX_STAFF_MAP: pair ${n} repeats an OUTLYY staff id`);
    map.set(user, right);
    staff.add(right);
  }
  if (n === 0) problems.push("CRM_BITRIX_STAFF_MAP is missing");
  if (n > 200) problems.push("CRM_BITRIX_STAFF_MAP has more than 200 pairs");
  if (n > 0 && !map.has(cfg.defaultOwnerId)) problems.push("CRM_BITRIX_STAFF_MAP must include the default deal owner (CRM_BITRIX_DEFAULT_OWNER_ID)");
  return { map, problems };
}

/** Every reason the return path settings are refused. Empty ⇒ usable. */
export function crmReturnProblems(env: CrmReturnEnvSlice, cfg: Pick<CrmConfig, "webhookUserId" | "defaultOwnerId">): string[] {
  const problems: string[] = [];
  const raw = env.CRM_RETURN_PATH?.trim();
  const mode = raw === undefined || raw === "" ? "off" : raw;
  if (!(CRM_RETURN_MODES as readonly string[]).includes(mode)) problems.push("CRM_RETURN_PATH must be off, observe or enforce");
  // The map is checked whenever it is set, and must be valid before acceptance is switched on.
  if (env.CRM_RETURN_ACCEPT === true || env.CRM_BITRIX_STAFF_MAP) problems.push(...parseStaffMap(env.CRM_BITRIX_STAFF_MAP, cfg).problems);
  return problems;
}

/**
 * The return path configuration. Refused settings (any problem) give `off`:
 * the push keeps working as before and nothing is read back.
 */
export function crmReturnConfigFrom(env: CrmReturnEnvSlice, cfg: Pick<CrmConfig, "webhookUserId" | "defaultOwnerId">): CrmReturnConfig {
  if (crmReturnProblems(env, cfg).length) return { mode: "off", accept: false, staffMap: new Map() };
  const raw = env.CRM_RETURN_PATH?.trim();
  const mode = (raw ? raw : "off") as CrmReturnMode;
  const staffMap = env.CRM_BITRIX_STAFF_MAP ? parseStaffMap(env.CRM_BITRIX_STAFF_MAP, cfg).map : new Map<number, string>();
  return { mode, accept: mode === "enforce" && env.CRM_RETURN_ACCEPT === true && staffMap.size > 0, staffMap };
}
