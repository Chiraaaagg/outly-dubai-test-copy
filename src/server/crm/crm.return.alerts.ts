import "server-only";
import { prisma } from "../lib/db";
import type { OpsIncident } from "../services/ops-alert.service";

/**
 * Ops alerts for the Bitrix24 return path (CRM batch C3ab, doc 29e §3.4, §7,
 * §8): one incident per finding row of crm_return_findings raised inside the
 * sweep window (`raised_at`). Kind `crm_return_path`, reason = the finding
 * kind (`crm_twin`, `crm_stage_tamper`, ...), entity `crm_subject` with
 * `deal:<id>`, `inquiry:<id>`, `order:<id>` or `portal:<environment>`. The
 * existing ops-alert rules deduplicate (one email per entity and reason per
 * 6 hours). Ids and codes only: a finding never holds a value or a name.
 * Guarded like the other CRM reads: before the C3ab migration the table is
 * absent and this yields nothing.
 */

type Row = { kind: string; subject_key: string; environment: string; raised_at: Date | string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The incident of one finding row. Pure, for tests. */
export function crmReturnIncident(r: Row): OpsIncident {
  const entityId = r.subject_key === "portal" ? `portal:${r.environment}` : r.subject_key;
  const [type, id] = r.subject_key.split(":");
  return {
    kind: "crm_return_path",
    entityKind: "crm_subject",
    entityId,
    reason: r.kind,
    raisedAt: r.raised_at instanceof Date ? r.raised_at : new Date(String(r.raised_at)),
    orderId: null,
    orderReference: null,
    bookingId: null,
    supplierBookingRef: null,
    adminPath: type === "inquiry" && id && UUID.test(id) ? `/admin/inquiries/${id}` : "/admin",
  };
}

export async function crmReturnIncidents(since: Date, now: Date, limit = 100): Promise<OpsIncident[]> {
  const rows = await prisma
    .$queryRaw<Row[]>`
    SELECT kind, subject_key, environment, raised_at FROM crm_return_findings
    WHERE raised_at >= ${since} AND raised_at <= ${now}
    ORDER BY raised_at DESC LIMIT ${limit}`
    .catch((e: unknown) => {
      if (/42P01|crm_return_findings.*does not exist/.test(String((e as { message?: unknown })?.message ?? "")) || (e as { meta?: { code?: unknown } })?.meta?.code === "42P01") return [] as Row[];
      throw e;
    });
  return rows.map(crmReturnIncident);
}
